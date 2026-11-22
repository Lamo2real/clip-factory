"""The status per place: honest, and how it is known (docs/CONTRACTS.md §40.2). Pure functions only.

``card(place, inputs, now)`` turns one place's stored facts into its ``GetPaidCard``. The first status that applies
wins, in this order: on hold › not allowed yet › can get paid ✓ › not set up (a signal says so) › checking › not set
up yet (from his ticks) › can get paid (you said it's done) › Clip Factory can't check › not started. A signal always
beats a tick; a tick is step state, never money, and is always labelled "you said". "Live" is never said.

A ``PAYSTATE#`` is used only when it is **fresh**: its reading connection is ``connected``, its first read is done
and it was checked within 48 hours (and not before the connection was made). Otherwise no hold, no "no hold", no
account state and no Whop status come from it; Google's sent payments (``PAYOUT#`` rows, records of real money)
still tick the YouTube payout steps.

``inputs`` (plain JSON, as in ``api/tests/fixtures/getpaid_status_cases.json``):
``connected`` (the place's Account, or Content Rewards' ``CRCONN``, is connected), ``ticks`` (his ``GETPAID`` ticks;
Content Rewards: ``CRCONN.stepsDone``), ``moneyState`` (``MONEYSTATE#{platform}``), ``goals`` (that state's goals
measured by ``money.rules``), ``country`` / ``countryName``, ``notOpen`` (TikTok's Creator Rewards isn't open in his
country), ``payconn`` / ``paystate`` / ``payouts`` (YouTube: AdSense; Content Rewards: Whop), ``finance`` and
``crMoney`` (Content Rewards) and ``whopOn``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from ..clock import parse
from . import CR, PLACES, name
from .sent import (
    first_read_late,
    fresh,
    join,
    public,
    read_since_connect,
    sent_line,
    short_day,
    whop_state,
    youtube_state,
)

Item = dict[str, Any]
HOLD_DAYS = 30
MAX_SEEN = 6
ADSENSE_URL = "https://adsense.google.com/"
STUDIO_URL = "https://studio.youtube.com/"
WHOP_URL = "https://whop.com/"
YT_READING = "/settings/posting/getpaid/youtube#yt-reading"
WHOP_CARD = "/settings/posting/getpaid/contentrewards#whop"
FINANCE = "/settings/posting/getpaid/contentrewards#finance"
X_WARNING = (
    "X doesn't pay for posts an app made or posted, or clips copied from other sites. Your Clip Factory clips "
    "probably won't earn on X."
)
STATUSES = (
    "on_hold",
    "not_allowed",
    "can_get_paid",
    "not_set_up",
    "you_said_done",
    "checking",
    "not_connected",
    "not_started",
)
CR_MONEY_KEYS = ("paidTotalCents", "readyToMoveCents", "stillEarningCents", "onItsWayCents")
# YouTube's payment threshold per money type (YouTube's own table; nothing is converted).
THRESHOLDS = {"SEK": "kr 700", "EUR": "€70", "USD": "$100"}


@dataclass(frozen=True)
class Step:
    """One step the server knows (the same ids and roles as ``web/src/getpaid/*.ts`` and §38.7)."""

    id: str
    role: str  # earn | reading | payout | each_time
    title: str
    open_label: str | None = None
    open_url: str | None = None
    when: str | None = None
    auto: str | None = None  # in_program | payment_reading | sent | premium | whop_linked
    manual: bool = True
    paid: bool = False
    shared: str | None = None
    finance: str | None = None  # Content Rewards: shown only for that answer ("yes" / "no")


_AD = ("Open AdSense for YouTube", ADSENSE_URL)
STEPS: dict[str, tuple[Step, ...]] = {
    "youtube": (
        Step(
            "yt-join",
            "earn",
            "Join the Partner Program",
            "Open YouTube Studio",
            "https://studio.youtube.com/channel/UC/monetization",
            auto="in_program",
        ),
        Step(
            "yt-reading",
            "reading",
            "Let Clip Factory see payments",
            "Turn on AdSense reading",
            "https://console.cloud.google.com/apis/library/adsense.googleapis.com",
            when="Do this after step 1 made your AdSense for YouTube.",
            auto="payment_reading",
            manual=False,
        ),
        Step("yt-tax", "payout", "Add your US tax info", *_AD, auto="sent"),
        Step(
            "yt-bank", "payout", "Add your bank", *_AD, when="YouTube lets you once you've earned kr 70.", auto="sent"
        ),
        Step(
            "yt-test",
            "payout",
            "Confirm the tiny test payment",
            *_AD,
            when="A tiny payment from Google arrives in 1 to 5 workdays.",
            auto="sent",
        ),
        Step("yt-id", "payout", "Check your ID", *_AD, when="YouTube asks once you've earned about $10.", auto="sent"),
        Step(
            "yt-pin",
            "payout",
            "Type the PIN from the letter",
            *_AD,
            when="A letter comes by post 3 to 4 weeks after your ID check.",
            auto="sent",
        ),
    ),
    "tiktok": (
        Step("tt-gifts", "earn", "Turn on Gifts", "Open TikTok", "https://www.tiktok.com/"),
        Step("tt-payout", "payout", "Add where TikTok pays you", "Open TikTok", "https://www.tiktok.com/"),
        Step("tt-withdraw", "each_time", "Move money to your bank"),
    ),
    "instagram": (
        Step("ig-gifts", "earn", "Turn on Gifts", "Open Instagram", "https://www.instagram.com/"),
        Step(
            "meta-payout",
            "payout",
            "Tell Meta where to pay you",
            "Open Instagram",
            "https://www.instagram.com/",
            when="Meta lets you once you've earned $25.",
            shared="meta",
        ),
    ),
    "facebook": (
        Step(
            "fb-join",
            "earn",
            "Join a Facebook money tool",
            "Open Meta Business Suite",
            "https://business.facebook.com/latest/monetization",
        ),
        Step(
            "meta-payout",
            "payout",
            "Tell Meta where to pay you",
            "Open Meta Business Suite",
            "https://business.facebook.com/",
            when="Meta lets you once you've earned $25.",
            shared="meta",
        ),
    ),
    "x": (
        Step("x-premium", "earn", "Get X Premium", "Open X", "https://x.com/", auto="premium", paid=True),
        Step(
            "x-apply",
            "earn",
            "Apply for Original Content Rewards",
            "Open Creator Studio",
            "https://x.com/i/jf/creators/studio",
        ),
        Step(
            "x-stripe",
            "payout",
            "Connect Stripe for payouts",
            "Open Creator Studio",
            "https://x.com/i/jf/creators/studio",
        ),
    ),
    # §38.7's money steps (words and ticks unchanged; the ticks stay on CRCONN).
    CR: (
        Step(
            "move-whop",
            "payout",
            "Link your Whop account",
            "Open Content Rewards settings",
            "https://contentrewards.com/c/settings",
            auto="whop_linked",
            finance="no",
        ),
        Step("bank-setup", "payout", "Add your bank on Whop", "Open Whop", WHOP_URL, finance="no"),
        Step(
            "fin-setup",
            "payout",
            "Set up payouts",
            "Open Content Rewards",
            "https://contentrewards.com/c/home",
            finance="yes",
        ),
        Step("move-withdraw", "each_time", "Move money to Whop"),
        Step("bank-cashout", "each_time", "Get it to your bank", finance="no"),
        Step("fin-bank", "each_time", "Get it to your bank", finance="yes"),
    ),
}
PLATFORM_STEP_IDS = frozenset(s.id for p, steps in STEPS.items() if p != CR for s in steps)
CR_STEP_IDS = frozenset(s.id for s in STEPS[CR])


def step(place: str, step_id: str) -> Step | None:
    return next((s for s in STEPS.get(place, ()) if s.id == step_id), None)


def named_step(place: str, step_id: str) -> Step:
    """A step this module names itself (a ``KeyError`` would be a typo here, never his input)."""
    found = step(place, step_id)
    if found is None:
        raise KeyError(step_id)
    return found


def platform_step(step_id: str) -> Step | None:
    """The Get paid step with this id on any of the five platforms (``meta-payout`` is one step for both)."""
    return next((s for p in PLACES if p != CR for s in STEPS[p] if s.id == step_id), None)


def numbered(place: str, finance: bool | None = None) -> list[Step]:
    """The numbered ``earn`` and ``payout`` steps in the guide's order (the ring counts only these). Content Rewards:
    its steps for his Finance answer; none until he answers."""
    steps = [s for s in STEPS[place] if s.role in {"earn", "payout"}]
    if place == CR:
        if finance is None:
            return []
        wanted = "yes" if finance else "no"
        steps = [s for s in steps if s.finance == wanted]
    return steps


# --- small readers --------------------------------------------------------------------------------------------


def _obj(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list | tuple | set) else []


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def checking_first_read(conn: Mapping[str, Any], state: Mapping[str, Any], now: datetime) -> bool:
    """Connected, no read since this connection was made (an old read from before a Stop doesn't count), and not
    late yet."""
    return (
        conn.get("status") == "connected"
        and not read_since_connect(conn, state)
        and not first_read_late(conn, state, now)
    )


def _late(conn: Mapping[str, Any], state: Mapping[str, Any], now: datetime) -> bool:
    return (
        conn.get("status") == "connected" and not read_since_connect(conn, state) and first_read_late(conn, state, now)
    )


@dataclass
class _Facts:
    """What one place's card is worked out from."""

    place: str
    name: str
    connected: bool
    ticks: set[str]
    autos: dict[str, str]  # step id → who said so ("YouTube says you're in")
    numbered: list[Step]
    finance: bool | None
    conn: Mapping[str, Any]
    state: Mapping[str, Any]
    is_fresh: bool
    sent_rows: list[Mapping[str, Any]]
    money: Mapping[str, Any]
    goals: list[Mapping[str, Any]]
    numbers: Mapping[str, Any]
    inputs: Mapping[str, Any]
    now: datetime

    def done(self, step_id: str) -> bool:
        return step_id in self.ticks or step_id in self.autos

    def numbered_done(self) -> list[Step]:
        return [s for s in self.numbered if self.done(s.id)]

    @property
    def earn(self) -> list[Step]:
        return [s for s in self.numbered if s.role == "earn"]

    @property
    def payout(self) -> list[Step]:
        return [s for s in self.numbered if s.role == "payout"]

    def index(self, s: Step) -> int:
        return self.numbered.index(s) + 1


def _youtube_sent(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [r for r in rows if youtube_state(r) == "sent"]


def _newest_day(rows: Sequence[Mapping[str, Any]]) -> str:
    return short_day(max((str(r.get("date") or "") for r in rows), default=""))


def _autos(
    place: str, inputs: Mapping[str, Any], sent_rows: list[Mapping[str, Any]], whop: Mapping[str, Any] | None
) -> dict[str, str]:
    """The steps a signal ticks, and who said so. ``whop``: a fresh ``PAYSTATE#contentrewards`` (else None)."""
    out: dict[str, str] = {}
    state = _obj(inputs.get("moneyState"))
    if place == "youtube":
        if sent_rows:
            # Google pays AdSense for YouTube only to a channel in the Partner Program: a sent payment proves step 1
            # too (also when "Allow money reading" was never pressed, so YouTube's own answer isn't stored).
            said = f"Google sent you money on {_newest_day(sent_rows)}, so this is done"
            out["yt-join"] = said
            for s in STEPS["youtube"]:
                if s.auto == "sent":
                    out[s.id] = said
        if state.get("state") in {"in_program", "earning"}:
            out["yt-join"] = "YouTube says you're in"
        if _obj(inputs.get("payconn")).get("status") == "connected":
            out["yt-reading"] = "You let Clip Factory see payments"
    elif place == "x" and _obj(state.get("numbers")).get("premium") is True:
        out["x-premium"] = "X says you have Premium"
    elif place == CR:
        money = _obj(inputs.get("crMoney"))
        if (_int(money.get("onItsWayCents")) or 0) > 0 or money.get("movedAt"):
            out["move-whop"] = "Content Rewards says you moved money to Whop"
        methods = _obj((whop or {}).get("methods"))
        if whop is not None and (_int(methods.get("ready")) or 0) > 0:
            out["bank-setup"] = "Whop says a bank is saved"
    return out


def _facts(place: str, inputs: Mapping[str, Any], now: datetime) -> _Facts:
    finance = inputs.get("finance") if isinstance(inputs.get("finance"), bool) else None
    conn = _obj(inputs.get("payconn"))
    state = _obj(inputs.get("paystate"))
    if place == CR and not inputs.get("whopOn"):
        conn, state = {}, {}
    rows = [r for r in _list(inputs.get("payouts")) if isinstance(r, Mapping)]
    if place == "youtube":
        sent_rows = _youtube_sent(rows)
    elif place == CR:
        sent_rows = [r for r in rows if whop_state(r) == "sent"]
    else:
        sent_rows = []
    money_state = _obj(inputs.get("moneyState"))
    return _Facts(
        place=place,
        name=name(place),
        connected=bool(inputs.get("connected")),
        ticks={str(t) for t in _list(inputs.get("ticks")) if isinstance(t, str)},
        autos=_autos(place, inputs, sent_rows, state if place == CR and fresh(conn, state, now) else None),
        numbered=numbered(place, finance),
        finance=finance,
        conn=conn,
        state=state,
        is_fresh=fresh(conn, state, now) if place in {"youtube", CR} else False,
        sent_rows=sent_rows,
        money=_obj(inputs.get("crMoney")),
        goals=[g for g in _list(inputs.get("goals")) if isinstance(g, Mapping)],
        numbers=_obj(money_state.get("numbers")),
        inputs=inputs,
        now=now,
    )


# --- next -----------------------------------------------------------------------------------------------------


def _step_next(f: _Facts, s: Step, hint: str | None = None) -> Item:
    out: Item = {
        "stepId": s.id,
        "label": s.open_label or s.title,
        "href": s.open_url or "",
        "external": bool(s.open_url),
        "text": f"Next: step {f.index(s)}, {s.title}." if s in f.numbered else f"Next: {s.title}.",
        "vermilion": not s.paid,
    }
    if hint:
        out["hint"] = hint
    return out


def _open_next(label: str, href: str, hint: str) -> Item:
    return {"stepId": None, "label": label, "href": href, "external": True, "hint": hint, "vermilion": True}


def _first_not_done(f: _Facts) -> Step | None:
    return next((s for s in f.numbered if not f.done(s.id)), None)


def _bank_step(f: _Facts) -> Step:
    return named_step(CR, "fin-setup" if f.finance else "bank-setup")


def _numbered_bank(f: _Facts) -> _Facts:
    """Content Rewards before his Finance answer: the "No" steps, so a Whop signal can still name its step."""
    if f.place == CR and f.finance is None:
        f.numbered = numbered(CR, False)
    return f


def hold_fix(f: _Facts, case: str) -> Item:
    """``HOLD_FIX`` (§40.2): the one next step for a hold, or for a signal that says a payout part is missing."""
    if case in {"payment_hold", "needs_attention"}:
        missing = next((s for s in f.payout if not f.done(s.id)), None)
        if missing is not None:
            return _step_next(f, missing)
        return _open_next(*_AD, "Look for the red message on **Payments**. Do what it says.")
    if case == "closed":
        return _open_next("Open YouTube Studio", STUDIO_URL, "Make a new AdSense for YouTube from **Earn**.")
    if case == "id_rejected":
        return _open_next("Open Whop", WHOP_URL, "Tap **Balances**. Do the ID check again.")
    bank = _bank_step(_numbered_bank(f))
    if case in {"bank_broken", "payout_failed"}:
        return _open_next(bank.open_label or "", bank.open_url or "", "Check your bank on **Payout methods**.")
    return _step_next(f, bank)  # no saved method, or the ID check not started


def _reconnect(f: _Facts) -> Item | None:
    if f.conn.get("status") != "needs_reconnect":
        return None
    if f.place == "youtube":
        label, href = "Allow payment reading", YT_READING
    elif f.place == CR and f.inputs.get("whopOn"):
        label, href = "Connect Whop", WHOP_CARD
    else:
        return None
    return {"stepId": None, "label": label, "href": href, "external": False, "vermilion": True}


def _finance_next() -> Item:
    return {
        "stepId": None,
        "label": "Answer: do you see Finance?",
        "href": FINANCE,
        "external": False,
        "text": "Next: say if you see Finance.",
        "vermilion": False,
    }


def _plain_next(f: _Facts) -> Item | None:
    missing = _first_not_done(f)
    if missing is not None:
        return _step_next(f, missing)
    if f.place == CR and f.finance is None:
        return _finance_next()
    return _reconnect(f)


# --- signals --------------------------------------------------------------------------------------------------


def _yt_accounts(f: _Facts) -> list[str]:
    return [str(_obj(a).get("state") or "") for a in _list(f.state.get("accounts"))]


def _yt_holds(f: _Facts) -> list[str]:
    out = []
    for h in _list(f.state.get("holds")):
        text = str(_obj(h).get("text") or "").strip()
        out.append(text[:300] if text else "Google is holding your money.")
    return out


def _whop_methods(f: _Facts) -> Mapping[str, Any]:
    return _obj(f.state.get("methods"))


def _whop_holds(f: _Facts) -> list[tuple[str, str]]:
    """``(case, line)`` for each Whop hold (fresh only): the ID check didn't pass, every saved method is broken, or
    the newest payout didn't go through within 30 days with no newer one sent (a canceled one is never a hold)."""
    out: list[tuple[str, str]] = []
    kind = _obj(f.state.get("hold")).get("kind")
    methods = _whop_methods(f)
    if f.state.get("kyc") == "rejected" or kind == "id_rejected":
        out.append(("id_rejected", "Whop says your ID check didn't pass."))
    created, active, broken = (_int(methods.get(k)) or 0 for k in ("created", "active", "broken"))
    if (broken > 0 and created == 0 and active == 0) or kind == "bank_broken":
        out.append(("bank_broken", "Whop says your bank details don't work."))
    rows = [r for r in _list(f.inputs.get("payouts")) if isinstance(r, Mapping) and r.get("status") != "canceled"]
    rows.sort(key=lambda r: (str(r.get("date") or ""), str(r.get("sk") or "")), reverse=True)
    newest = rows[0] if rows else None
    day = parse(str(newest.get("date") or "") + "T00:00:00.000Z") if newest else None
    failed = (
        newest is not None
        and newest.get("status") in {"failed", "denied", "reversed"}
        and day is not None
        and f.now - day <= timedelta(days=HOLD_DAYS)
    )
    if failed or kind == "payout_failed":
        out.append(("payout_failed", "Whop says your last payout didn't go through."))
    return out


def _whop_linked(f: _Facts) -> bool:
    return f.done("move-whop") or "fin-setup" in f.ticks


def _cr_can_earn(f: _Facts) -> bool:
    return any((_int(f.money.get(k)) or 0) > 0 for k in CR_MONEY_KEYS)


def _can_earn(f: _Facts) -> bool:
    if f.place == "youtube" and _obj(f.inputs.get("moneyState")).get("state") in {"in_program", "earning"}:
        return True
    if f.place == CR and _cr_can_earn(f):
        return True
    return bool(f.earn) and all(f.done(s.id) for s in f.earn)


# --- not allowed (§25's goals and the published rules) ------------------------------------------------------


def _goal(f: _Facts, key: str) -> Mapping[str, Any] | None:
    return next((g for g in f.goals if g.get("key") == key), None)


def _unreached(goals: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    by_key = {str(g.get("key")): g for g in goals}
    for g in goals:
        if g.get("kind") == "number" or g.get("reached"):
            continue
        partner = by_key.get(str(g.get("or") or ""))
        if partner is not None and partner.get("reached"):
            continue
        return g
    return None


def _count(value: Any, approx: bool = False) -> str:
    return ("about " if approx else "") + f"{int(value):,}"


def _not_allowed(f: _Facts) -> Item | None:
    tell = " Clip Factory tells you when you get there."
    if f.place == "youtube" and _obj(f.inputs.get("moneyState")).get("state") == "not_yet":
        out: Item = {"knownBy": "youtube", "known": "YouTube says", "pill": "Not allowed yet (YouTube says)"}
        missing = _unreached(f.goals)
        if f.goals and missing is None:
            out["line"] = "You reached YouTube's goals. Apply in YouTube Studio. YouTube checks it."
            out["next"] = _step_next(f, named_step("youtube", "yt-join"))
            return out
        if missing is None:
            out["line"] = "YouTube says you're not in the Partner Program yet." + tell
        else:
            line = f"YouTube needs {_count(missing.get('goal'))} {missing.get('label')}."
            if _int(missing.get("current")) is not None:
                line += f" YouTube says you have {_count(missing.get('current'), bool(missing.get('approx')))}."
            out["line"] = line + tell
        out["next"] = None
        return out
    rules = {
        "instagram": (
            "followers",
            "ig-gifts",
            "Gifts needs {goal} followers. Instagram says you have {n}.",
            "Instagram's rules",
        ),
        "x": (
            "verifiedFollowers",
            "x-apply",
            "Original Content Rewards needs {goal} verified followers. X says you have {n}.",
            "X's rules",
        ),
    }
    if f.place not in rules:
        return None
    key, gates, words, known = rules[f.place]
    goal = _goal(f, key)
    have = _int(f.numbers.get(key))
    target = _int(goal.get("goal")) if goal else None
    if have is None or target is None or have >= target or gates in f.ticks:
        return None
    return {
        "knownBy": "rules",
        "known": known,
        "pill": f"Not allowed yet ({known})",
        "line": words.format(goal=_count(target), n=_count(have)) + tell,
        "next": None,
    }


# --- the status -----------------------------------------------------------------------------------------------


def _says(place: str) -> tuple[str, str]:
    return ("youtube", "YouTube says") if place == "youtube" else ("whop", "Whop says")


def _payout_titles(f: _Facts) -> list[str]:
    return [s.title for s in f.payout if not f.done(s.id)]


def _status(f: _Facts) -> Item:
    by, said = _says(f.place)
    # 1. On hold (a fresh signal). Beats every other status.
    if f.is_fresh and f.place == "youtube" and _yt_holds(f):
        return {
            "status": "on_hold",
            "pill": "Payment on hold (YouTube says)",
            "tone": "error",
            "knownBy": by,
            "known": said,
            "line": "Google is holding your money. Tap Open AdSense for YouTube to see why.",
            "holds": _yt_holds(f),
            "next": hold_fix(f, "payment_hold"),
        }
    if f.is_fresh and f.place == CR:
        holds = _whop_holds(f)
        if holds:
            return {
                "status": "on_hold",
                "pill": "Payment on hold (Whop says)",
                "tone": "error",
                "knownBy": by,
                "known": said,
                "line": holds[0][1],
                "holds": [h[1] for h in holds],
                "next": hold_fix(f, holds[0][0]),
            }
    # 2. Not allowed yet (YouTube's own answer beats his ticks; Instagram's and X's published rules).
    found = _not_allowed(f)
    if found is not None:
        return {"status": "not_allowed", "tone": "neutral", **found}
    # 3. Can get paid ✓ (a signal).
    if f.is_fresh and f.place == "youtube":
        accounts = _yt_accounts(f)
        if accounts and all(a == "READY" for a in accounts) and f.sent_rows:
            return {
                "status": "can_get_paid",
                "pill": "Can get paid ✓ (YouTube says)",
                "tone": "success",
                "knownBy": by,
                "known": said,
                "line": f"YouTube says there's no hold. Google sent you money on {_newest_day(f.sent_rows)}.",
                "next": _plain_next(f),
            }
    if f.is_fresh and f.place == CR:
        methods = _whop_methods(f)
        ready = (_int(methods.get("ready")) or 0) > 0
        if f.state.get("kyc") == "approved" and ready:
            if _whop_linked(f):
                return {
                    "status": "can_get_paid",
                    "pill": "Can get paid ✓ (Whop says)",
                    "tone": "success",
                    "knownBy": by,
                    "known": said,
                    "line": "Whop says your ID check is done and a bank is saved.",
                    "next": _plain_next(f),
                }
            link = named_step(CR, "fin-setup" if f.finance else "move-whop")
            _numbered_bank(f)
            nxt = _step_next(f, link)
            return _from_ticks(f, nxt)
    # 4. Not set up (a fresh signal says a payout part is missing).
    if f.is_fresh and f.place == "youtube":
        accounts = _yt_accounts(f)
        if "NEEDS_ATTENTION" in accounts:
            return _signal_missing(
                f, "YouTube says your AdSense for YouTube needs you. Open it and do what it asks.", "needs_attention"
            )
        if accounts and "READY" not in accounts and "CLOSED" in accounts:
            return _signal_missing(
                f, "YouTube says your AdSense for YouTube is closed. Make a new one from YouTube Studio.", "closed"
            )
    if f.is_fresh and f.place == CR:
        methods = _whop_methods(f)
        saved = sum(_int(methods.get(k)) or 0 for k in ("created", "active", "broken"))
        if saved == 0:
            nxt = hold_fix(f, "no_method")
            return _signal_missing(f, f"Whop says it has nowhere to send your money. {nxt['text']}", "no_method", nxt)
        if f.state.get("kyc") == "not_started":
            nxt = hold_fix(f, "id_not_started")
            return _signal_missing(f, f"Whop says your ID check isn't started. {nxt['text']}", "id_not_started", nxt)
    # 5. Checking (a reading's first read is running, or Whop is checking his ID).
    if checking_first_read(f.conn, f.state, f.now):
        what = "YouTube payments" if f.place == "youtube" else "your Whop payouts"
        return {
            "status": "checking",
            "pill": "Checking…",
            "tone": "neutral",
            "knownBy": "clipfactory",
            "known": "Clip Factory is checking",
            "line": f"Checking {what}… This can take until tomorrow.",
            "next": _plain_next(f),
        }
    if f.is_fresh and f.place == CR and f.state.get("kyc") == "pending":
        return {
            "status": "checking",
            "pill": "Checking… (Whop says)",
            "tone": "neutral",
            "knownBy": "whop",
            "known": "Whop says",
            "line": "Whop is checking your ID. Nothing to do. It can take a day or two.",
            "next": _plain_next(f),
        }
    # 6. Not set up yet (he can earn, and a numbered payout step isn't done).
    payout_missing = next((s for s in f.payout if not f.done(s.id)), None)
    finance_missing = f.place == CR and f.finance is None
    if _can_earn(f) and (payout_missing is not None or finance_missing):
        return _from_ticks(f, _plain_next(f))
    # 7. Can get paid (you said it's done): every numbered earn and payout step done, no fresh signal against it.
    if f.numbered and all(f.done(s.id) for s in f.numbered):
        return _said_done(f)
    # 8. Clip Factory can't check.
    has_reading = f.conn.get("status") in {"connected", "needs_reconnect"}
    has_tick = any(s.id in f.ticks for s in STEPS[f.place])
    # TikTok in a country where Creator Rewards isn't open: that comes from TikTok's rules, not the connection, so
    # its "not started" line (Gifts might be open) is said even when TikTok isn't connected (§40.2, the TikTok row).
    tiktok_rules = f.place == "tiktok" and bool(f.inputs.get("notOpen"))
    if not f.connected and not has_tick and not has_reading and not tiktok_rules:
        return {
            "status": "not_connected",
            "pill": "Clip Factory can't check",
            "tone": "neutral",
            "knownBy": "clipfactory",
            "known": "Clip Factory can't check",
            "line": f"Clip Factory can't check anything for {f.name}. You can still do the steps.",
            "next": _plain_next(f),
        }
    # 9. Not started.
    return _not_started(f)


def _signal_missing(f: _Facts, line: str, case: str, nxt: Item | None = None) -> Item:
    by, said = _says(f.place)
    return {
        "status": "not_set_up",
        "pill": f"Not set up ({said})",
        "tone": "error",
        "knownBy": by,
        "known": said,
        "line": line,
        "missing": _payout_titles(f),
        "next": nxt if nxt is not None else hold_fix(f, case),
    }


def _from_ticks(f: _Facts, nxt: Item | None) -> Item:
    line = "You can earn here. Do the payout steps so money can reach you."
    if nxt is not None and nxt.get("text"):
        line += f" {nxt['text']}"
        s = step(f.place, str(nxt.get("stepId") or ""))
        if s is not None and s.when:
            line += f" {s.when}"
    return {
        "status": "not_set_up",
        "pill": "Not set up yet",
        "tone": "warn",
        "knownBy": "you",
        "known": "Your steps",
        "line": line,
        "missing": _payout_titles(f),
        "next": nxt,
    }


def _said_done(f: _Facts) -> Item:
    out: Item = {
        "status": "you_said_done",
        "pill": "Can get paid (you said it's done)",
        "tone": "success",
        "knownBy": "you",
        "known": "You said it's done",
        "line": f"You said every step is done. {f.name} doesn't tell Clip Factory, so it can't check.",
        "next": _plain_next(f),
    }
    if f.place == "youtube" and f.sent_rows:
        day = _newest_day(f.sent_rows)
        # Only a check made since this connection (or before a Stop) is "last checked"; never one from an old sign-in.
        checked = short_day(f.state.get("lastCheckedAt")) if read_since_connect(f.conn, f.state) else ""
        tail = (
            f"Clip Factory last checked YouTube payments on {checked}."
            if checked
            else "Clip Factory can't see YouTube payments now."
        )
        out.update(
            pill=f"Can get paid (Google sent money on {day})",
            knownBy="youtube",
            known="Google sent money",
            line=f"Google sent you money on {day}. {tail}",
        )
    elif f.place == "youtube" and f.is_fresh:
        out["line"] = (
            "You said every step is done. YouTube says there's no hold. Clip Factory knows for sure after Google's "
            "first payment."
        )
    return out


def _not_started(f: _Facts) -> Item:
    out: Item = {
        "status": "not_started",
        "pill": "Not started",
        "tone": "neutral",
        "knownBy": "you",
        "known": "Your steps",
        "line": f"Do the steps so {f.name} can pay you. Already did them? Tap I did this on each step.",
        "next": _plain_next(f),
    }
    earn_done = any(f.done(s.id) for s in f.earn)
    payout_done = any(f.done(s.id) for s in f.payout)
    nxt = out["next"]
    if f.place == "tiktok" and f.inputs.get("notOpen") and "tt-gifts" not in f.ticks:
        code = f.inputs.get("country")
        where = str(f.inputs.get("countryName") or "") if code not in (None, "", "other") else ""
        place = where or "your country"
        out.update(
            knownBy="rules",
            known=f"TikTok's rules for {place}",
            line=f"Creator Rewards isn't open in {place}. Gifts might be. {nxt['text'] if nxt else ''}".strip(),
        )
    elif payout_done and not earn_done and f.earn and nxt is not None:
        who = "Meta" if f.place in {"instagram", "facebook"} else f.name
        out["line"] = f"You said {who} knows where to pay you. {nxt.get('text', '')}".strip()
    return out


# --- what Clip Factory can see --------------------------------------------------------------------------------


def _dollars(cents: int) -> str:
    return f"${cents // 100:,}.{cents % 100:02d}"


def _seen(f: _Facts) -> list[str]:
    """ "What Clip Factory can see" (at most 6 lines): stored facts only, each saying who said it."""
    if f.place == "youtube":
        return _seen_youtube(f)
    if f.place == CR:
        return _seen_cr(f)[:MAX_SEEN]
    out: list[str] = []
    followers = _int(f.numbers.get("followers"))
    if f.place == "tiktok":
        if followers is not None:
            out.append(f"TikTok says you have {followers:,} followers.")
        out.append("TikTok doesn't tell apps about Gifts or payouts.")
    elif f.place == "instagram":
        if followers is not None:
            out.append(f"Instagram says you have {followers:,} followers.")
        out.append("Meta doesn't tell apps how it pays you.")
    elif f.place == "facebook":
        if followers is not None:
            out.append(f"Facebook says your Page has {followers:,} followers.")
        out.append("Meta doesn't tell apps if you joined or how it pays you.")
    else:
        if f.numbers.get("premium") is True:
            out.append("X says you have Premium.")
        verified = _int(f.numbers.get("verifiedFollowers"))
        if verified is not None:
            out.append(f"X says you have {verified:,} verified followers.")
        out.append("X doesn't tell apps if you're in Original Content Rewards or set up Stripe.")
    return out[:MAX_SEEN]


def _seen_adsense(f: _Facts) -> list[str]:
    """The fresh AdSense lines: the account, the hold and what waits to be paid."""
    out: list[str] = []
    accounts = _yt_accounts(f)
    if "NEEDS_ATTENTION" in accounts:
        out.append("YouTube says your AdSense for YouTube needs you. Open AdSense for YouTube.")
    elif accounts and all(a == "READY" for a in accounts):
        out.append("YouTube says your AdSense for YouTube is ready.")
    elif accounts and "READY" not in accounts and "CLOSED" in accounts:
        out.append("YouTube says your AdSense for YouTube is closed.")
    if not _yt_holds(f):
        out.append("YouTube says there's no hold on your money.")
    unpaid = _unpaid(f)
    if unpaid is not None:
        out.append(unpaid["seen"])
    return out


def _seen_youtube(f: _Facts) -> list[str]:
    out: list[str] = []
    money_state = str(_obj(f.inputs.get("moneyState")).get("state") or "")
    if money_state in {"in_program", "earning"}:
        out.append("YouTube says you're in the Partner Program.")
    elif money_state == "not_yet":
        out.append("YouTube says you're not in the Partner Program yet.")
    if f.is_fresh:
        out += _seen_adsense(f)
    if f.sent_rows:
        newest = max(f.sent_rows, key=lambda r: (str(r.get("date") or ""), str(r.get("sk") or "")))
        text = str(newest.get("amountText") or "").strip()
        if text:
            out.append(f"Last money sent: {text} on {short_day(newest.get('date'))} (YouTube says).")
    status = f.conn.get("status")
    checked = short_day(f.state.get("lastCheckedAt"))
    if status == "connected" and not f.is_fresh:
        if _late(f.conn, f.state, f.now):
            out.append("Clip Factory couldn't check YouTube payments yet. It tries again tomorrow.")
        elif read_since_connect(f.conn, f.state) and checked:
            out.append(f"Clip Factory last checked YouTube payments on {checked}.")
    elif status == "needs_reconnect":
        out.append("Clip Factory can't see YouTube payments anymore. Tap Allow payment reading again.")
    elif status != "connected":
        out.append("Clip Factory can't see YouTube payments yet. Tap Allow payment reading.")
    tail = "YouTube doesn't tell apps about your bank, tax or ID. Tap I did this when they're done."
    return [*out[: MAX_SEEN - 1], tail]


def _seen_cr(f: _Facts) -> list[str]:
    out: list[str] = []
    ready = _int(f.money.get("readyToMoveCents"))
    if ready:
        out.append(f"Content Rewards says {_dollars(ready)} is ready to move to Whop.")
    if not f.inputs.get("whopOn"):
        return out
    status = f.conn.get("status")
    if f.is_fresh:
        kyc = {
            "approved": "is done",
            "pending": "is waiting",
            "rejected": "didn't pass",
            "not_started": "isn't started",
        }.get(str(f.state.get("kyc") or ""))
        if kyc:
            out.append(f"Whop says your ID check {kyc}.")
        methods = _whop_methods(f)
        created, active, broken = (_int(methods.get(k)) or 0 for k in ("created", "active", "broken"))
        if (_int(methods.get("ready")) or 0) > 0:
            out.append("Whop says a bank is saved.")
        elif broken > 0 and created == 0 and active == 0:
            out.append("Whop says your bank details don't work.")
        if f.state.get("businesses"):
            out.append("You have a business on Whop. Clip Factory reads only your own Whop money, not the business's.")
    elif status == "connected":
        if _late(f.conn, f.state, f.now):
            out.append("Clip Factory couldn't check your Whop payouts yet. It tries again tomorrow.")
        elif read_since_connect(f.conn, f.state) and short_day(f.state.get("lastCheckedAt")):
            out.append(f"Clip Factory last checked Whop on {short_day(f.state.get('lastCheckedAt'))}.")
    elif status == "needs_reconnect":
        out.append("Clip Factory can't see your Whop payouts anymore. Sign in to Whop again to see your payouts.")
    else:
        out.append("Clip Factory can't see Whop. Connect Whop to see your payouts here.")
    return out


def _unpaid(f: _Facts) -> Item | None:
    """YouTube's "Waiting to be paid" (``youtube-unpaid``, Google's own words; never in a total). Fresh only."""
    text = str(_obj(f.state.get("unpaid")).get("text") or "").strip()
    if not text or not f.is_fresh:
        return None
    from .sent import parse_amount

    _, currency = parse_amount(text)
    threshold = THRESHOLDS.get(currency or "")
    seen = f"Waiting to be paid: {text} (YouTube says)."
    if threshold:
        seen += f" Google pays when it's {threshold} or more."
        note = f"Google pays between the 21st and 26th when you have {threshold} or more."
    else:
        if f.inputs.get("country") == "SE":
            seen += " It pays between the 21st and 26th once you have kr 700."
        note = "Google pays between the 21st and 26th."
    return {"text": text, "note": note, "seen": seen}


# --- the card -------------------------------------------------------------------------------------------------


def card(place: str, inputs: Mapping[str, Any], now: datetime) -> Item:
    """``GetPaidCard`` for one place (§40.7)."""
    f = _facts(place, inputs, now)
    found = _status(f)
    f.numbered = numbered(place, f.finance)  # a Whop signal may have looked at the "No" steps
    nxt = found.get("next")
    out: Item = {
        "place": place,
        "name": f.name,
        "status": found["status"],
        "pill": found["pill"],
        "tone": found["tone"],
        "knownBy": found["knownBy"],
        "known": found["known"],
        "line": found["line"],
        "missing": list(found.get("missing") or []),
        "holds": list(found.get("holds") or []),
    }
    if place == "x":
        out["warning"] = X_WARNING
    if place == "youtube":
        on = f.conn.get("status") == "connected"
        out["readingChip"] = f"Clip Factory can see payments: {'on' if on else 'off'}"
    elif place == CR and inputs.get("whopOn"):
        on = f.conn.get("status") == "connected"
        out["readingChip"] = f"Clip Factory can see Whop payouts: {'on' if on else 'off'}"
    out["next"] = nxt
    steps = []
    for s in STEPS[place]:
        by = "auto" if s.id in f.autos else "you" if s.id in f.ticks else None
        entry: Item = {"id": s.id, "done": by is not None, "by": by}
        if by == "auto":
            entry["auto"] = f.autos[s.id]
        steps.append(entry)
    out["steps"] = steps
    out["ring"] = {"done": len(f.numbered_done()), "total": len(f.numbered) or (1 if place == CR else 0)}
    out["seen"] = _seen(f)
    out["sent"] = public(
        sent_line(
            place,
            [r for r in _list(inputs.get("payouts")) if isinstance(r, Mapping)],
            _obj(inputs.get("payconn")),
            _obj(inputs.get("paystate")),
            whop_on=bool(inputs.get("whopOn")),
            now=now,
        )
    )
    if place == "youtube":
        unpaid = _unpaid(f)
        if unpaid is not None:
            out["unpaid"] = {"text": unpaid["text"], "note": unpaid["note"]}
    # Only a check of this connection (a check from before a Stop and a new Allow is not this one's).
    shown = place == "youtube" or inputs.get("whopOn")
    if f.state.get("lastCheckedAt") and shown and read_since_connect(f.conn, f.state):
        out["checkedAt"] = f.state["lastCheckedAt"]
    if f.state.get("lastError") and shown:
        out["lastError"] = str(f.state["lastError"])
    return out


def summary(cards: Sequence[Mapping[str, Any]]) -> str:
    """``GetPaid.summary`` (§40.2): who can pay him (and who said so), what he said is done, who needs him."""
    parts = []
    for c in cards:
        if c["status"] == "can_get_paid":
            parts.append(
                "Whop says Content Rewards can pay you." if c["place"] == CR else f"{c['name']} says it can pay you."
            )
    said = [c for c in cards if c["status"] == "you_said_done"]
    google = [c for c in said if c["place"] == "youtube" and c["knownBy"] == "youtube"]
    names = [str(c["name"]) for c in said if c not in google]
    if names:
        parts.append(f"You said {join(names)} {'is' if len(names) == 1 else 'are'} done.")
    if google:
        parts.append("Google paid you before.")
    need = [str(c["name"]) for c in cards if c["status"] in {"not_set_up", "on_hold"}]
    if need:
        parts.append(f"{join(need)} {'needs' if len(need) == 1 else 'need'} you.")
    if parts:
        return " ".join(parts)
    # A place he can start on: not started, or one Clip Factory can't check (he can still do its steps there).
    first = next((c for c in cards if c["status"] in {"not_started", "not_connected"}), None)
    if first is not None:
        return f"Nothing is set up yet. Start with {first['name']}."
    return "Nothing to do here yet. Clip Factory tells you when a place opens."
