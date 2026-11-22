"""All your money in one place (docs/CONTRACTS.md §39.2, ADR-63): ``GET /v1/money/everywhere``.

One 30-day period for the whole card, ``[to - 29, to]``, where ``to`` is the Monthly card's ``through`` (§27.2) over
every money place with no filter, so the YouTube row equals the Monthly number when YouTube is the only money place;
with no platform money stored ``to`` is today (UTC) and the card says "the last 30 days". One row per place in
STATS_ORDER, then Content Rewards while it is switched on. A platform row sums its reported ``REVENUE#`` days in the
period (a reported $0 day counts); Content Rewards sums its paid payouts by day (``CRMONEY.paidByDay``, §39.2). The
total adds only ``number`` rows, per currency, biggest first, and names the places in it. Content Rewards' ``usd`` is
written ``USD`` (a spelling, never a conversion) and its cents become micros (times 10,000, a unit change).

The §25 rule holds: only money a platform or Content Rewards reported, never calculated, guessed, converted or typed
in. Instagram, TikTok and X report none, so their rows say "Not available from …" with where to look, never $0.
``everywhere`` is pure (``api/tests/fixtures/money_everywhere_cases.json``); ``load`` reads one owner's items and
never calls a platform or Content Rewards.

Get paid (§40.4, additive): each row gains ``sent``, the money Google or Whop say they sent toward his bank
(``getpaid.sent.sent_line``), and the card gains ``sent``, the "Sent to your bank, so far" block, one line per money
type (``sent_totals``). It is never added to the 30-day total: a different thing over a different time.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from .. import db, posts
from ..clock import iso, parse
from ..getpaid import SOURCE_OF, payconn_sk, payout_prefix, paystate_sk
from ..getpaid import sent as getpaid_sent
from . import MONEY_ORDER, label, revenue_prefix, rules, sources, state_sk
from .summary import LAG_NOTES, MONEY_PLATFORMS, summarize
from .view import money_shown, tag

Item = dict[str, Any]
CR = "contentrewards"
CR_NAME = "Content Rewards"
PERIOD_DAYS = 30
MICROS_PER_CENT = 10_000
CR_TAG = "Content Rewards' numbers"
CR_ROW_TAG = "reached your balance in these 30 days · Content Rewards' numbers"
NO_MONEY_SHARED = frozenset({"instagram", "tiktok", "x"})
SAYS = {"youtube": "YouTube says", "facebook": "Meta says", CR: "Content Rewards says"}
STATE_WORDS = {
    "not_available": "not available",
    "coming_soon": "coming soon",
    "not_set_up": "not set up",
    "needs_ok": "needs your OK",
    "waiting": "waiting",
    "error": "couldn't check",
    "sign_in": "sign in again",
}
NOT_IN_PROGRAM = ("not_yet", "goal_reached")
MONEY_SETTINGS = "/settings/posting/money"


def _day(value: date) -> str:
    return f"{value:%a} {value.day} {value:%b}"


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _setup(platform: str) -> str:
    return f"/settings/posting/setup/{platform}?back=/money"


def where_line(name: str, paid_where: Mapping[str, Any]) -> Item:
    """``config/monetization.json`` ``paidWhere`` said in words: " › " is said ", then "; a place with a ``url``
    names its own product first ("Look in X, then Monetization (paid through Stripe)." and "Open X"), else "Look in
    Instagram: Professional dashboard, then Payouts.\""""
    parts = [p.strip() for p in str(paid_where.get("label") or "").split("›") if p.strip()]
    said = ", then ".join(parts)
    url = paid_where.get("url")
    if isinstance(url, str) and url and parts:
        return {"text": f"Look in {said}.", "button": {"label": f"Open {parts[0]}", "url": url}}
    return {"text": f"Look in {name}: {said}."}


def _place(place: str, name: str, state: str, headline: str, **extra: Any) -> Item:
    out: Item = {"place": place, "name": name, "state": state, "headline": headline, "amounts": []}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def _amounts(rows: Iterable[Mapping[str, Any]]) -> list[Item]:
    by: dict[str, int] = {}
    for r in rows:
        by[str(r["currency"]).upper()] = by.get(str(r["currency"]).upper(), 0) + int(r["amountMicros"])
    return [{"currency": c, "amountMicros": a} for c, a in sorted(by.items(), key=lambda kv: (-kv[1], kv[0]))]


def _platform_place(  # noqa: PLR0917 (one answer per state of the table)
    platform: str,
    cfg: rules.Monetization,
    account: Mapping[str, Any] | None,
    state: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    behind: list[str],
    start: date,
    end: date,
) -> Item:
    name = label(platform)
    paid_where = cfg.platform(platform).paid_where
    if platform in NO_MONEY_SHARED:
        return _place(
            platform,
            name,
            "not_available",
            f"Not available from {name}",
            why=f"{name} doesn't tell apps what you earn.",
            where=where_line(name, paid_where),
        )
    if not money_shown(cfg, platform):
        return _place(
            platform,
            name,
            "coming_soon",
            "Coming soon",
            why=f"Clip Factory can't show {name} money yet.",
            where=where_line(name, paid_where),
        )
    if account is None:
        return _place(
            platform,
            name,
            "not_set_up",
            "Not set up yet",
            why=f"Connect {name} to see its money.",
            button={"label": f"Set up {name}", "href": _setup(platform), "external": False},
        )
    checked = state.get("lastCheckedAt") if isinstance(state.get("lastCheckedAt"), str) else None
    if platform == "youtube" and sources.MONETARY_SCOPE not in {str(s) for s in account.get("scopes") or []}:
        return _place(
            platform,
            name,
            "needs_ok",
            "YouTube needs your OK",
            why="Tap Allow money reading so YouTube shares your money with Clip Factory.",
            button={"label": "Allow money reading", "href": f"{MONEY_SETTINGS}#money-youtube", "external": False},
        )
    if platform in behind and rows:
        newest = date.fromisoformat(max(str(r["date"]) for r in rows))
        why = f"{name} hasn't sent money since {_day(newest)}."
        return _place(platform, name, "waiting", "Waiting for the first numbers", why=why, checkedAt=checked)
    shown = [r for r in rows if start.isoformat() <= str(r["date"]) <= end.isoformat()]
    if shown:
        note = None
        if state.get("lastError"):
            newest = date.fromisoformat(max(str(r["date"]) for r in shown))
            note = f"Couldn't check today. Showing money up to {_day(newest)}."
        out = _place(platform, name, "number", SAYS[platform], tag=tag(platform), note=note, checkedAt=checked)
        out["amounts"] = _amounts(shown)
        return out
    if state.get("lastError"):
        return _place(
            platform, name, "error", "Couldn't check today", why="Clip Factory tries again tomorrow.", checkedAt=checked
        )
    if platform == "youtube" and state.get("state") in NOT_IN_PROGRAM:
        return _place(
            platform,
            name,
            "waiting",
            "Waiting for the first numbers",
            why="YouTube says you're not in its Partner Program yet.",
            button={"label": "How close am I?", "href": MONEY_SETTINGS, "external": False},
            checkedAt=checked,
        )
    why = "YouTube shows money 2–3 days after it's made." if platform == "youtube" else f"{name} can take 2 days."
    return _place(platform, name, "waiting", "Waiting for the first numbers", why=why, checkedAt=checked)


def _cents(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _cr_place(crconn: Mapping[str, Any], crmoney: Mapping[str, Any], start: date, end: date, now: datetime) -> Item:
    from ..contentrewards import connection

    status, _ = connection.effective(crconn, now)
    if status == "not_connected":
        return _place(
            CR,
            CR_NAME,
            "not_set_up",
            "Not set up yet",
            why="Connect Content Rewards to see its money.",
            button={"label": "Set up Content Rewards", "href": _setup(CR), "external": False},
        )
    read = bool(crmoney.get("firstReadDone"))
    cr: Item = {
        "stillEarningCents": _cents(crmoney.get("stillEarningCents")),
        "onItsWayCents": _cents(crmoney.get("onItsWayCents")),
        "readyToMoveCents": _cents(crmoney.get("readyToMoveCents")),
        "paidSoFarCents": _cents(crmoney.get("paidTotalCents")) if read else None,
    }
    for name in ("lastPaidAt", "asOf"):
        if isinstance(crmoney.get(name), str) and crmoney[name]:
            cr[name] = crmoney[name]
    cr["movedOut"] = "not_available"
    as_of = cr.get("asOf")
    if status == "needs_reconnect":
        return _place(
            CR,
            CR_NAME,
            "sign_in",
            "Sign in again",
            why="Sign in to Content Rewards again to see your money.",
            button={"label": "Sign in again", "href": _setup(CR), "external": False},
            cr=cr,
        )
    if crmoney.get("error") and not as_of:
        why = "Content Rewards didn't answer. Try again in a few minutes."
        return _place(CR, CR_NAME, "error", "Couldn't check today", why=why, cr=cr)
    checking = "Checking Content Rewards…"
    if not read:
        return _place(CR, CR_NAME, "waiting", "Waiting for the first numbers", why=checking, cr=cr, checkedAt=as_of)
    if not any(cr[k] for k in ("paidSoFarCents", "stillEarningCents", "readyToMoveCents", "onItsWayCents")):
        why = "No campaign money yet. It shows here when the brand approves your clips."
        return _place(CR, CR_NAME, "waiting", "Waiting for the first numbers", why=why, cr=cr, checkedAt=as_of)
    if not crmoney.get("paidByDayDone"):
        return _place(CR, CR_NAME, "waiting", "Waiting for the first numbers", why=checking, cr=cr, checkedAt=as_of)
    raw = crmoney.get("paidByDay")
    by_day: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    cents = 0
    for day, value in by_day.items():
        amount = _cents(value)
        if amount is not None and start.isoformat() <= str(day) <= end.isoformat():
            cents += amount
    note = None
    if crmoney.get("error"):
        moment = parse(as_of)
        if moment is not None:
            note = f"Couldn't check today. Showing money up to {_day(moment.date())}."
    out = _place(CR, CR_NAME, "number", SAYS[CR], tag=CR_ROW_TAG, note=note, cr=cr, checkedAt=as_of)
    out["amounts"] = [{"currency": "USD", "amountMicros": cents * MICROS_PER_CENT}]  # CR's "usd" cents, as micros
    return out


def _totals(places: list[Item]) -> list[Item]:
    by: dict[str, Item] = {}
    for p in places:
        if p["state"] != "number":
            continue
        for a in p["amounts"]:
            line = by.setdefault(a["currency"], {"currency": a["currency"], "amountMicros": 0, "places": []})
            line["amountMicros"] += int(a["amountMicros"])
            if p["place"] not in line["places"]:
                line["places"].append(p["place"])
    short = {p["place"]: (CR_TAG if p["place"] == CR else str(p.get("tag") or "")) for p in places}
    out = []
    for line in by.values():
        line["tag"] = " + ".join(short[p] for p in line["places"])
        out.append(line)
    out.sort(key=lambda t: (-int(t["amountMicros"]), str(t["currency"])))
    return out


def _not_counted_text(places: list[Item]) -> str | None:
    groups: dict[str, list[str]] = {}
    for p in places:
        if p["state"] != "number":
            groups.setdefault(str(p["state"]), []).append(str(p["name"]))
    if not groups:
        return None
    parts = [f"{_join(names)} ({STATE_WORDS.get(state, state)})" for state, names in groups.items()]
    return "Not in the total: " + " · ".join(parts) + "."


def everywhere(  # noqa: PLR0917 (the inputs of §39.2, in its order)
    cfg: rules.Monetization,
    accounts: Mapping[str, Mapping[str, Any] | None],
    states: Mapping[str, Mapping[str, Any]],
    rows: Iterable[Mapping[str, Any]],
    crconn: Mapping[str, Any] | None,
    crmoney: Mapping[str, Any] | None,
    cr_on: bool,
    today: datetime,
    *,
    payouts: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
    payconns: Mapping[str, Mapping[str, Any]] | None = None,
    paystates: Mapping[str, Mapping[str, Any]] | None = None,
    whop_on: bool = False,
) -> Item:
    """``MoneyEverywhere``. ``accounts[p]``: the connected Account (None when not connected); ``states[p]``: the
    ``MONEYSTATE#`` item; ``rows``: stored ``REVENUE#`` rows (``platform``, ``date``, ``amountMicros``,
    ``currency``); ``today``: now (UTC). §40.4: ``payouts[place]`` (``PAYOUT#`` rows), ``payconns[source]``
    (``PAYCONN#adsense`` / ``PAYCONN#whop``), ``paystates[place]`` (``PAYSTATE#``) and ``whop_on``
    (``WHOP_CONNECT``)."""
    stored: dict[str, list[Item]] = {}
    for r in rows:
        p = str(r.get("platform"))
        if accounts.get(p) is None or p not in MONEY_PLATFORMS or not money_shown(cfg, p):
            continue
        if isinstance(r.get("amountMicros"), int) and isinstance(r.get("date"), str) and r.get("currency"):
            stored.setdefault(p, []).append(dict(r))
    status = {
        p: {
            "connected": accounts.get(p) is not None,
            "moneyScope": accounts.get(p) is not None
            and (p != "youtube" or sources.MONETARY_SCOPE in {str(s) for s in (accounts[p] or {}).get("scopes") or []}),
            "lastError": (states.get(p) or {}).get("lastError"),
            "checkedAt": (states.get(p) or {}).get("lastCheckedAt"),
        }
        for p in MONEY_ORDER
        if p in MONEY_PLATFORMS and money_shown(cfg, p)
    }
    where = {p: dict(cfg.platform(p).paid_where) for p in MONEY_ORDER}
    monthly = summarize(
        today=today.date(),
        platforms=list(MONEY_ORDER),
        chart=PERIOD_DAYS,
        rows=[r for p in stored for r in stored[p]],
        status=status,
        facebook_verified=cfg.platform("facebook").money_verified,
        where=where,
    )
    through = monthly.get("through")
    end = date.fromisoformat(through) if isinstance(through, str) else today.date()
    start = end - timedelta(days=PERIOD_DAYS - 1)
    places = [
        _platform_place(
            p,
            cfg,
            accounts.get(p),
            states.get(p) or {},
            stored.get(p, []),
            [str(e["platform"]) for e in monthly.get("excluded") or [] if e.get("reason") == "behind"],
            start,
            end,
        )
        for p in MONEY_ORDER
    ]
    if cr_on:
        places.append(_cr_place(crconn or {}, crmoney or {}, start, end, today))
    lines: dict[str, Item] = {}
    for row in places:
        place = str(row["place"])
        source = SOURCE_OF.get(place)
        lines[place] = getpaid_sent.sent_line(
            place,
            list((payouts or {}).get(place) or []),
            (payconns or {}).get(source or "") or {},
            (paystates or {}).get(place) or {},
            whop_on=whop_on,
            now=today,
        )
        row["sent"] = getpaid_sent.public(lines[place])
    out: Item = {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "periodText": f"30 days up to {_day(end)}" if isinstance(through, str) else "the last 30 days",
    }
    lag = next(
        (
            LAG_NOTES[p]
            for p in ("youtube", "facebook")
            if any(x["place"] == p and x["state"] == "number" for x in places)
        ),
        None,
    )
    if lag:
        out["lagNote"] = lag
    out["places"] = places
    out["totals"] = _totals(places)
    out["notCounted"] = [{"place": p["place"], "state": p["state"]} for p in places if p["state"] != "number"]
    text = _not_counted_text(places)
    if text:
        out["notCountedText"] = text
    out["sent"] = getpaid_sent.sent_totals(lines)
    out["asOf"] = iso(today)
    return out


def load(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    cr_on: bool,
    whop_on: bool = False,
    cfg: rules.Monetization | None = None,
) -> Item:
    """One owner's ``MoneyEverywhere`` from stored items only (Accounts, ``MONEYSTATE#``, ``REVENUE#``, the config,
    the Get paid ``PAYOUT#``, ``PAYCONN#`` and ``PAYSTATE#`` items and, while Content Rewards is on, ``CRCONN`` and
    ``CRMONEY``)."""
    cfg = cfg or rules.load()
    pk = db.user_pk(user_id)
    accounts = {p: posts.connected_account(store, user_id, p) for p in MONEY_ORDER}
    states = {p: store.get(pk, state_sk(p)) or {} for p in MONEY_ORDER if p in MONEY_PLATFORMS}
    rows: list[Item] = []
    for p in MONEY_ORDER:
        if p not in MONEY_PLATFORMS or not money_shown(cfg, p) or accounts.get(p) is None:
            continue
        rows += [
            {"platform": p, "date": r.get("date"), "amountMicros": r.get("amountMicros"), "currency": r.get("currency")}
            for r in store.query_all(pk, revenue_prefix(p))
        ]
    crconn = store.get(pk, db.CRCONN_SK) if cr_on else None
    crmoney = store.get(pk, db.CRMONEY_SK) if cr_on else None
    places = ["youtube", *(["contentrewards"] if cr_on else [])]
    return everywhere(
        cfg,
        accounts,
        states,
        rows,
        crconn,
        crmoney,
        cr_on,
        now,
        payouts={p: store.query_all(pk, payout_prefix(p)) for p in places},
        payconns={SOURCE_OF[p]: store.get(pk, payconn_sk(SOURCE_OF[p])) or {} for p in places},
        paystates={p: store.get(pk, paystate_sk(p)) or {} for p in places},
        whop_on=whop_on and cr_on,
    )
