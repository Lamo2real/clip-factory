"""``BankView``: the numbers and words of Your bank (docs/CONTRACTS.md §40.5.9, §40.5.10; builder BA).

``view(items, now, *, cr_on, values)`` is pure (golden cases, ``tests/bank_cases.py``). ``load`` reads ``BANKCONN``,
``BANKLINK#``, ``DEPOSIT#`` and ``MONEYPREFS`` only (and, through the caller, the public half of the bank key while
the step cards show). Nothing here calls Enable Banking or a bank.

**Reached your bank** is, for each place, the sum of its ``matched`` rows per currency; ``totals`` is per currency
over every place. Nothing is added across currencies or converted, and a place with nothing is never shown as 0: it is
named in ``notYet`` instead. ``needs_you``, ``notSure`` and ``not_income`` rows are never counted. Amounts are
reported money only ("Your bank says"): ``amountMicros = amountMinor x 10^(6 - exponent)``, a change of unit, never a
conversion. No answer carries a private key, ``hashKey``, a session id, a uid, a hash, a ``payerKey``, the bank's
text, an IP address or a JWT.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..getpaid import CR
from ..money import PREFS_SK
from . import (
    APP_DESCRIPTION,
    APP_NAME,
    ASK_BODY,
    ASK_SUBJECT,
    ASK_TO,
    CHECK_CODES,
    CHECK_EVERY_MINUTES,
    CHECK_TEXT,
    CHECKS_PER_DAY,
    CONN_SK,
    DEPOSIT_PREFIX,
    ENDING_SOON_DAYS,
    FAILING_HOURS,
    GETPAID_PLACES,
    HINT_WORDS,
    LAST_CONNECT_HOURS,
    LINK_PREFIX,
    MAX_ASKS,
    MAX_BANKS,
    MAX_ROWS,
    META,
    NAMES,
    NUMBERED,
    PEM_DELETED,
    PLACES,
    RECONNECT_FAILING_DAYS,
    RESULTS,
    SHORT,
    STEPS,
    result_text,
)

Item = dict[str, Any]
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
WORST = ("ended", "stopped_at_bank", "look_in_bank", "cant_read", "ending_soon", "checking", "can_see")
MAX_LINKS_SHOWN = 12
TAG = "Your bank says. Clip Factory matched each one to an app."
TWO_MONIES = "Different money, like dollars and kronor, is never added together."
EMPTY = "Nothing from an app reached your bank yet."
MONEY_LINE = "What reached your bank is below."
SET_UP_BUTTON = {"label": "Set up Your bank", "href": "/settings/posting/getpaid/bank"}
NOTES = {
    CR: "Whop sends all your Whop money, Content Rewards too.",
    META: "Meta pays Instagram and Facebook in one payment, so Clip Factory can't split it.",
}
PILLS = {
    "not_started": ("Not started", "neutral"),
    "setting_up": ("Not set up yet", "warn"),
    "checking": ("Checking…", "neutral"),
    "can_see": ("Clip Factory can see it (Your bank says)", "success"),
    "ending_soon": ("Link ends in {days}", "warn"),
    "cant_read": ("Can't read {bank}", "warn"),
    "look_in_bank": ("Look in your {bank} app", "warn"),
    "ended": ("Link ended", "error"),
    "stopped_at_bank": ("Stopped outside Clip Factory", "error"),
    "stopped": ("Stopped", "neutral"),
}
AUTO_WORDS = {
    "app_known": "Enable Banking knows your app",
    "key_made": "Clip Factory made your bank key",
    "app_active": "Enable Banking says your app is active",
    "bank_connected": "Clip Factory can see {bank}",
}


# --- small helpers ------------------------------------------------------------------------------------------------


def _map(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _day(value: Any) -> date | None:
    """A ``YYYY-MM-DD`` day, an ISO time or a datetime, as a UTC day."""
    if isinstance(value, datetime):
        return value.astimezone(UTC).date()
    if isinstance(value, str) and len(value) == 10:
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    moment = parse(value)
    return moment.astimezone(UTC).date() if moment is not None else None


def day_month(value: Any) -> str:
    """ "28 Oct" (UTC)."""
    found = _day(value)
    return f"{found.day} {MONTHS[found.month - 1]}" if found else ""


def weekday_day_month(value: Any) -> str:
    """ "Fri 20 May" (UTC)."""
    found = _day(value)
    return f"{WEEKDAYS[found.weekday()]} {found.day} {MONTHS[found.month - 1]}" if found else ""


def day_month_year(value: Any) -> str:
    found = _day(value)
    return f"{found.day} {MONTHS[found.month - 1]} {found.year}" if found else ""


def names_joined(names: list[str], last: str = "and") -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + f" {last} " + names[-1]


def micros(row: Mapping[str, Any]) -> int | None:
    """``amountMinor x 10^(6 - exponent)``: a change of unit, never a conversion. None for a row that can't be read."""
    amount = row.get("amountMinor")
    exponent = row.get("exponent")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        return None
    if isinstance(exponent, bool) or not isinstance(exponent, int) or not 0 <= exponent <= 6:
        return None
    return int(amount * 10 ** (6 - exponent))


def _currency(row: Mapping[str, Any]) -> str | None:
    found = row.get("currency")
    return found if isinstance(found, str) and len(found) == 3 and found.isalpha() and found.isupper() else None


def amounts(rows: list[Mapping[str, Any]]) -> list[Item]:
    """Per currency (A to Z), each summed on its own: never added across currencies."""
    sums: dict[str, int] = {}
    for row in rows:
        value, currency = micros(row), _currency(row)
        if value is not None and currency is not None:
            sums[currency] = sums.get(currency, 0) + value
    return [{"currency": c, "amountMicros": sums[c]} for c in sorted(sums)]


# --- steps --------------------------------------------------------------------------------------------------------


def _check_code(conn: Mapping[str, Any]) -> str | None:
    code = _map(_map(conn.get("app")).get("check")).get("code")
    return code if isinstance(code, str) and code in CHECK_CODES else None


def _ticks(conn: Mapping[str, Any]) -> set[str]:
    raw = conn.get("stepsDone")
    return {str(s) for s in raw if isinstance(s, str)} if isinstance(raw, list | set | tuple | frozenset) else set()


def visible_links(links: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Every real link (a link Forget kept bare until its session closed is internal)."""
    return [link for link in links if link.get("type", "banklink") == "banklink" and link.get("connectedAt")]


def steps(conn: Mapping[str, Any], links: Sequence[Mapping[str, Any]]) -> list[Item]:
    """``BankView.steps`` from stored items only (never a secret)."""
    ticks = _ticks(conn)
    check = _check_code(conn)
    app = _map(conn.get("app"))
    any_link = bool(links)
    app_known = check in {"ok", "not_active"} or any_link
    newest = (
        sorted(links, key=lambda link: (link.get("status") != "stopped", str(link.get("connectedAt") or "")))[-1:]
        if links
        else []
    )
    bank = str(newest[0].get("bank") or "your bank") if newest else "your bank"
    autos = {
        "bank-account": app_known,
        "bank-app": app_known,
        "bank-details": app_known,
        "bank-key": app.get("status") in {"key_made", "saved"},
        "bank-appid": check in {"ok", "not_active"},
        "bank-link": check == "ok" or any_link,
        "bank-connect": any_link,
    }
    out: list[Item] = []
    for s in STEPS:
        entry: Item = {"id": s.id, "done": False, "by": None}
        if s.manual and s.id in ticks:
            entry.update(done=True, by="you")
        elif autos.get(s.id) and s.auto:
            entry.update(done=True, by="auto", auto=AUTO_WORDS[s.auto].format(bank=bank))
        out.append(entry)
    return out


def _next_step(conn: Mapping[str, Any], done: Mapping[str, bool]) -> Item | None:
    missing = next((s for s in NUMBERED if not done[s.id]), None)
    if missing is None:
        return None
    label = missing.label
    if missing.id == "bank-appid" and _map(conn.get("app")).get("status") == "saved":
        label = "Check again"
    return {
        "stepId": missing.id,
        "label": label,
        "text": f"Next: step {missing.number}, {missing.title}.",
        "vermilion": missing.vermilion,
    }


# --- links --------------------------------------------------------------------------------------------------------


def _days_left(consent: datetime | None, now: datetime) -> int | None:
    if consent is None:
        return None
    return max(0, math.ceil((consent - now).total_seconds() / 86400))


def link_state(link: Mapping[str, Any], now: datetime) -> Item:  # noqa: PLR0915 (§40.5.9's status table, in order)
    """One link's status, pill, tone, line, ring and buttons (§40.5.9)."""
    bank = str(link.get("bank") or "your bank")
    raw = link.get("status")
    consent = parse(link.get("consentUntil"))
    connected = parse(link.get("connectedAt"))
    failing = parse(link.get("failingSince"))
    days_left = _days_left(consent, now)
    total = round((consent - connected).total_seconds() / 86400) if consent and connected else None
    if raw == "stopped":
        status = "stopped"
        line = f"You stopped reading {bank} on {day_month(link.get('stoppedAt'))}. The money it found stays here."
    elif raw == "ended" or (raw == "connected" and consent is not None and consent <= now):
        status = "ended"
        if raw == "ended" and link.get("reason") != "consent_over":
            line = f"{bank} ended the link early. Banks sometimes do. Tap Reconnect {bank} and use BankID."
        else:
            when = link.get("consentUntil") or link.get("endedAt")
            line = f"Your {bank} link ended on {day_month(when)}. Clip Factory can't see new money until you reconnect."
    elif raw == "stopped_at_bank":
        status = "stopped_at_bank"
        line = f"The {bank} link was stopped at Enable Banking or at your bank. Tap Reconnect {bank} to start it again."
    elif link.get("reason") == "psu_action":
        status = "look_in_bank"
        line = f"{bank} wants you to do something in its app or website first. Then tap Check now."
    elif failing is not None and now - failing > timedelta(hours=FAILING_HOURS):
        status = "cant_read"
        line = (
            f"Clip Factory couldn't read {bank} since {day_month(failing)}. Tap Check now. If it stays, tap "
            f"Reconnect {bank}."
        )
    elif days_left is not None and days_left <= ENDING_SOON_DAYS:
        status = "ending_soon"
        line = f"Your {bank} link ends on {weekday_day_month(consent)}. Tap Reconnect {bank} and use BankID."
    elif link.get("firstReadDone") is not True:
        status = "checking"
        if connected is not None and now - connected > timedelta(hours=FAILING_HOURS):
            line = f"Clip Factory couldn't read {bank} yet. It tries again tomorrow."
        else:
            line = f"Clip Factory is reading {bank} for the first time. This can take a few minutes."
    else:
        status = "can_see"
        line = f"Clip Factory looks at {bank} once a day. The link ends in {days_left} days."
    pill, tone = PILLS[status]
    pill = pill.format(bank=bank, days=f"{days_left} day" if days_left == 1 else f"{days_left} days")
    long_failing = failing is not None and now - failing > timedelta(days=RECONNECT_FAILING_DAYS)
    soon = days_left is not None and days_left <= ENDING_SOON_DAYS
    reconnect = status in {"ended", "stopped_at_bank"} or (raw == "connected" and (soon or long_failing))
    out: Item = {
        "linkId": str(link.get("linkId") or ""),
        "bank": bank,
        "status": status,
        "pill": pill,
        "tone": tone,
        "line": line,
        "accounts": int(link["accountCount"]) if isinstance(link.get("accountCount"), int) else 0,
        "reconnect": reconnect,
        "canStop": status != "stopped",
    }
    if isinstance(link.get("lastError"), str) and link["lastError"] and status != "stopped":
        out["lastError"] = link["lastError"]
    if status != "stopped":
        if days_left is not None:
            out["daysLeft"] = 0 if status in {"ended", "stopped_at_bank"} else days_left
        if total is not None:
            out["totalDays"] = total
    for field, source in (
        ("consentUntil", "consentUntil"),
        ("checkedAt", "lastReadAt"),
        ("historyFrom", "historyFrom"),
        ("limitUntil", "limitUntil"),
        ("failingSince", "failingSince"),
    ):
        if isinstance(link.get(source), str) and link[source]:
            out[field] = link[source]
    return out


def _reconnect_rank(state: Mapping[str, Any], failing_long: bool) -> tuple[int, int]:
    order = {"ended": 0, "stopped_at_bank": 1}
    rank = order.get(str(state["status"]), 2 if failing_long else 3)
    days = state.get("daysLeft")
    return rank, days if isinstance(days, int) else 10_000


def _page_status(states: list[Item], links: list[Mapping[str, Any]]) -> tuple[str, str, str, str]:
    """``(status, pill, tone, line)`` once every step is done: the worst link wins; every link stopped → stopped."""
    live = [s for s in states if s["status"] != "stopped"]
    if not live:
        stopped = sorted(
            zip(states, links, strict=True), key=lambda pair: str(pair[1].get("stoppedAt") or ""), reverse=True
        )
        first = stopped[0][0]
        return "stopped", first["pill"], first["tone"], first["line"]
    worst = min(live, key=lambda s: WORST.index(str(s["status"])))
    if worst["status"] != "can_see":
        return str(worst["status"]), worst["pill"], worst["tone"], worst["line"]
    first_connected = {
        str(link.get("linkId") or ""): str(link.get("firstConnectedAt") or link.get("connectedAt") or "")
        for link in links
    }
    names = [str(s["bank"]) for s in sorted(live, key=lambda s: first_connected.get(str(s["linkId"]), ""))]
    first_end = min((int(s["daysLeft"]) for s in live if isinstance(s.get("daysLeft"), int)), default=0)
    if len(live) == 1:
        line = worst["line"]
    else:
        line = f"Clip Factory looks at {names_joined(names)} once a day. The first link ends in {first_end} days."
    pill, tone = PILLS["can_see"]
    return "can_see", pill, tone, line


# --- deposits -----------------------------------------------------------------------------------------------------


def _alive(row: Mapping[str, Any], now: datetime) -> bool:
    ttl = row.get("ttl")
    return not (isinstance(ttl, int) and not isinstance(ttl, bool) and ttl <= int(now.timestamp()))


def _how_text(row: Mapping[str, Any]) -> str:
    place = str(row.get("place") or "")
    how = row.get("how")
    if how == "payout":
        who = "Whop's payout" if place == CR else "Google's payment"
        return f"matches {who} of {day_month(row.get('payoutDate'))}"
    if how == "payer":
        return f"from a payer you said is {SHORT.get(place, place)}"
    return f"you said it's from {SHORT.get(place, place)}"


def _ask_words(row: Mapping[str, Any], cr_on: bool) -> Item:
    kind = "own_move" if row.get("kind") == "own_move" else "place"
    suggested = row.get("suggested")
    if suggested not in PLACES or (suggested == CR and not cr_on):
        suggested = None
    hint = row.get("hint")
    word = HINT_WORDS.get(str(hint)) if isinstance(hint, str) else None
    if kind == "own_move":
        return {
            "kind": kind,
            "suggested": None,
            "title": "Did you move this from your PayPal?",
            "line": "Clip Factory reads your PayPal too, so this money may already be counted there.",
            "yesLabel": "Yes, I moved it",
        }
    if suggested == META:
        return {
            "kind": kind,
            "suggested": META,
            "title": "Is this money from Instagram and Facebook?",
            "line": "Your bank's text looks like Meta.",
            "yesLabel": "Yes, Instagram and Facebook",
        }
    if suggested is not None:
        name = SHORT[str(suggested)]
        if hint == "stripe":
            line = f"Your bank's text says Stripe. {name} pays through Stripe, but others can too."
        else:
            line = f"Your bank's text looks like {word or name}."
        return {
            "kind": kind,
            "suggested": suggested,
            "title": f"Is this money from {name}?",
            "line": line,
            "yesLabel": f"Yes, it's {name}",
        }
    line = f"Your bank's text mentions {word}." if word else "Pick where this money is from."
    return {"kind": kind, "suggested": None, "title": "Where is this money from?", "line": line}


def _newest(rows: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(rows, key=lambda r: (str(r.get("date") or ""), str(r.get("depositId") or "")), reverse=True)


# --- the view -----------------------------------------------------------------------------------------------------


def values(app_url: str, redirect_uri: str) -> Item:
    """``BankView.values``: the words step 4 copies and the optional email (no name or detail of his)."""
    base = app_url.rstrip("/")
    return {
        "redirectUri": redirect_uri,
        "appName": APP_NAME,
        "description": APP_DESCRIPTION,
        "privacyUrl": f"{base}/legal/privacy.html",
        "termsUrl": f"{base}/legal/terms.html",
        "ask": {"to": ASK_TO, "subject": ASK_SUBJECT, "body": ASK_BODY},
    }


def next_check_allowed(conn: Mapping[str, Any], now: datetime) -> datetime | None:
    """When "Check now" may run again: 15 minutes after the last, and the next UTC day after 12 in one day."""
    found: list[datetime] = []
    last = parse(conn.get("lastManualAt"))
    if last is not None and last + timedelta(minutes=CHECK_EVERY_MINUTES) > now:
        found.append(last + timedelta(minutes=CHECK_EVERY_MINUTES))
    manual = _map(conn.get("manual"))
    n = manual.get("n")
    if manual.get("day") == now.date().isoformat() and isinstance(n, int) and n >= CHECKS_PER_DAY:
        found.append(datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC))
    return max(found) if found else None


def all_steps_done(conn: Mapping[str, Any], links: Sequence[Mapping[str, Any]]) -> bool:
    numbered = {s.id for s in NUMBERED}
    return all(s["done"] for s in steps(conn, visible_links(links)) if s["id"] in numbered)


def _status(
    conn: Mapping[str, Any], done: Mapping[str, bool], states: list[Item], links: list[Mapping[str, Any]], now: datetime
) -> tuple[str, str, str, str, Item | None]:
    """``(status, pill, tone, line, next)``: setup comes first; after it, the worst link wins."""
    ring_done = sum(1 for s in NUMBERED if done[s.id])
    check = _check_code(conn)
    nxt = _next_step(conn, done)
    if ring_done < len(NUMBERED):
        status = "not_started" if ring_done == 0 else "setting_up"
        pill, tone = PILLS[status]
        if status == "not_started":
            line = "See which app money reached your bank. Set it up once with BankID."
        elif check is not None and check not in {"ok", "not_active"}:
            line = CHECK_TEXT[check]
        else:
            line = str(nxt["text"]) if nxt else ""
        return status, pill, tone, line, nxt
    status, pill, tone, line = _page_status(states, links)
    due = [(s, link) for s, link in zip(states, links, strict=True) if s["reconnect"] and s["status"] != "stopped"]
    if not due:
        return status, pill, tone, line, None

    def rank(pair: tuple[Item, Mapping[str, Any]]) -> tuple[int, int]:
        failing = parse(pair[1].get("failingSince"))
        long_failing = failing is not None and now - failing > timedelta(days=RECONNECT_FAILING_DAYS)
        return _reconnect_rank(pair[0], long_failing)

    first = min(due, key=rank)[0]
    reconnect = {"stepId": None, "label": f"Reconnect {first['bank']}", "linkId": first["linkId"], "vermilion": True}
    return status, pill, tone, line, reconnect


def _key(conn: Mapping[str, Any], parts: Mapping[str, Any]) -> Item:
    """``BankView.key``: only the public key and the certificate, never the private key or ``hashKey``."""
    app = _map(conn.get("app"))
    made = app.get("status") in {"key_made", "saved"}
    key: Item = {"made": made}
    if not made:
        return key
    source = app.get("source") or parts.get("source")
    if source in {"clipfactory", "file"}:
        key["source"] = source
    for field in ("publicKeyPem", "certificatePem"):
        if isinstance(parts.get(field), str):
            key[field] = parts[field]
    if isinstance(app.get("appIdHint"), str):
        key["appIdHint"] = app["appIdHint"]
    check = _check_code(conn)
    stored = _map(app.get("check"))
    if check is not None and isinstance(stored.get("at"), str):
        key["check"] = {"code": check, "text": CHECK_TEXT[check], "at": stored["at"]}
    key["pemReminder"] = source == "file" and PEM_DELETED not in _ticks(conn)
    return key


def _last_connect(conn: Mapping[str, Any], now: datetime) -> Item | None:
    last = _map(conn.get("lastConnect"))
    at = parse(last.get("at"))
    if last.get("result") not in RESULTS or at is None or now - at > timedelta(hours=LAST_CONNECT_HOURS):
        return None
    bank = str(last.get("bank") or "") or None
    text = result_text(str(last["result"]), bank, last.get("reconnect") is True)
    return {"result": last["result"], "text": text, "at": last["at"]}


def _asks(asking: list[Mapping[str, Any]], bank_of: Callable[[Mapping[str, Any]], str], cr_on: bool) -> list[Item]:
    return [
        {
            "depositId": str(row.get("depositId") or ""),
            "date": str(row.get("date") or ""),
            "amountMicros": micros(row),
            "currency": _currency(row),
            "bank": bank_of(row),
            **_ask_words(row, cr_on),
            "notSure": row.get("notSure") is True,
        }
        for row in asking[:MAX_ASKS]
    ]


def _rows(matched: list[Mapping[str, Any]], bank_of: Callable[[Mapping[str, Any]], str]) -> list[Item]:
    rows = []
    for row in _newest(matched)[:MAX_ROWS]:
        place = str(row["place"])
        how = row.get("how") if row.get("how") in {"payout", "payer", "you"} else "you"
        rows.append(
            {
                "depositId": str(row.get("depositId") or ""),
                "date": str(row.get("date") or ""),
                "amountMicros": micros(row),
                "currency": _currency(row),
                "bank": bank_of(row),
                "place": place,
                "name": NAMES[place],
                "how": how,
                "howText": _how_text({**row, "how": how}),
            }
        )
    return rows


def _pairs(matched: list[Mapping[str, Any]]) -> list[Item]:
    """Each payout match, for the place page's "Reached your bank on 28 Oct (Your bank says)"."""
    return [
        {
            "place": str(row["place"]),
            "payoutDate": str(row["payoutDate"]),
            "amountMicros": micros(row),
            "currency": _currency(row),
            "reachedOn": str(row.get("date") or ""),
        }
        for row in _newest(matched)
        if row.get("how") == "payout" and row.get("place") in {"youtube", CR} and isinstance(row.get("payoutDate"), str)
    ]


def view(items: Mapping[str, Any], now: datetime, *, cr_on: bool, values: Mapping[str, Any]) -> Item:
    """``BankView`` from one owner's stored items (pure)."""
    conn = _map(items.get("conn"))
    links = visible_links([_map(link) for link in items.get("links") or []])
    links.sort(key=lambda link: str(link.get("connectedAt") or ""), reverse=True)
    deposits = [_map(d) for d in items.get("deposits") or []]
    found_steps = steps(conn, links)
    done = {s["id"]: bool(s["done"]) for s in found_steps}
    ring_done = sum(1 for s in NUMBERED if done[s.id])
    states = [link_state(link, now) for link in links]
    status, pill, tone, line, nxt = _status(conn, done, states, links, now)
    out: Item = {
        "on": True,
        "status": status,
        "pill": pill,
        "tone": tone,
        "line": line,
        "next": nxt,
        "steps": found_steps,
        "ring": {"done": ring_done, "total": len(NUMBERED)},
    }
    if ring_done == len(NUMBERED):
        out["fold"] = "Set up ✓ (Enable Banking knows your app)" if _check_code(conn) == "ok" else "Set up ✓"
    out["key"] = _key(conn, _map(items.get("key")))
    last = _last_connect(conn, now)
    if last is not None:
        out["lastConnect"] = last
    out["values"] = dict(values)
    out["links"] = states[:MAX_LINKS_SHOWN]
    banks = {str(link.get("linkId") or ""): str(link.get("bank") or "") for link in links}

    def bank_of(row: Mapping[str, Any]) -> str:
        return banks.get(str(row.get("linkId") or "")) or "your bank"

    # Questions: needs_you rows still alive (DynamoDB can return one for days after its ttl), newest first, the
    # "Not sure" ones last.
    asking = [d for d in deposits if d.get("state") == "needs_you" and _alive(d, now) and micros(d) and _currency(d)]
    asking = [d for d in _newest(asking) if not d.get("notSure")] + [d for d in _newest(asking) if d.get("notSure")]
    out["asks"] = _asks(asking, bank_of, cr_on)
    if len(asking) > MAX_ASKS:
        out["asksMore"] = len(asking) - MAX_ASKS
    matched = [
        d for d in deposits if d.get("state") == "matched" and d.get("place") in PLACES and micros(d) and _currency(d)
    ]
    out["reached"] = _reached(matched, links, sum(1 for d in asking if not d.get("notSure")), cr_on=cr_on)
    out["rows"] = _rows(matched, bank_of)
    out["pairs"] = _pairs(matched)
    out["places"] = _places(matched, links, cr_on=cr_on)
    if links:
        out["moneyLine"] = MONEY_LINE
    out["canAddBank"] = sum(1 for link in links if link.get("status") != "stopped") < MAX_BANKS
    read = [str(link["lastReadAt"]) for link in links if isinstance(link.get("lastReadAt"), str)]
    if read:
        out["checkedAt"] = max(read)
    allowed = next_check_allowed(conn, now)
    if allowed is not None:
        out["nextCheckAllowedAt"] = iso(allowed)
    country = items.get("country")
    out["country"] = country if isinstance(country, str) and country else None
    out["asOf"] = iso(now)
    return out


def _reached(matched: list[Mapping[str, Any]], links: list[Mapping[str, Any]], need_you: int, *, cr_on: bool) -> Item:
    by_place = {p: [r for r in matched if r.get("place") == p] for p in PLACES}
    places = []
    for p in PLACES:
        if not by_place[p]:
            continue
        entry: Item = {"place": p, "name": NAMES[p], "amounts": amounts(by_place[p])}
        if p in NOTES:
            entry["note"] = NOTES[p]
        places.append(entry)
    if not links:
        state = "no_link"
    elif matched:
        state = "number"
    elif not any(link.get("firstReadDone") is True for link in links):
        state = "checking"
    else:
        state = "none_yet"
    out: Item = {"state": state, "places": places, "totals": amounts(matched), "tag": TAG}
    if len(out["totals"]) > 1:
        out["twoMonies"] = TWO_MONIES
    if matched:
        has_meta = bool(by_place[META])
        missing = [
            SHORT[p]
            for p in GETPAID_PLACES
            if (p != CR or cr_on) and not by_place[p] and not (has_meta and p in {"instagram", "facebook"})
        ]
        if missing:
            out["notYet"] = f"No money from {names_joined(missing, 'or')} reached your bank yet."
    else:
        out["empty"] = EMPTY
    since = [str(link["historyFrom"]) for link in links if isinstance(link.get("historyFrom"), str)]
    if since:
        out["since"] = f"Counted from {day_month_year(min(since))}, as far back as your bank shows."
    if need_you:
        out["needYou"] = "1 bank payment needs you." if need_you == 1 else f"{need_you} bank payments need you."
    return out


def _places(matched: list[Mapping[str, Any]], links: list[Mapping[str, Any]], *, cr_on: bool) -> Item:
    out: Item = {}
    read = [str(link["lastReadAt"]) for link in links if isinstance(link.get("lastReadAt"), str)]
    meta_rows = [r for r in matched if r.get("place") == META]
    for p in GETPAID_PLACES:
        if p == CR and not cr_on:
            continue
        if not links:
            out[p] = {"headline": "Clip Factory can't see your bank yet.", "amounts": [], "button": dict(SET_UP_BUTTON)}
            continue
        own = [r for r in matched if r.get("place") == p]
        shared = meta_rows if p in {"instagram", "facebook"} else []
        if own or shared:
            last = max(str(r.get("date") or "") for r in own + shared)
            line: Item = {"headline": "Reached your bank", "amounts": amounts(own)}
            if shared:
                line["metaAmounts"] = amounts(shared)
            line["note"] = f"Your bank says. Last on {day_month(last)}."
        else:
            line = {"headline": f"Nothing from {SHORT[p]} reached your bank yet.", "amounts": []}
            if read:
                line["note"] = f"Your bank says. Clip Factory looked on {day_month(max(read))}."
        out[p] = line
    return out


def load(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    cr_on: bool,
    values: Mapping[str, Any],
    public_key: Callable[[], Mapping[str, Any] | None] | None = None,
) -> Item:
    """``BankView`` from ``BANKCONN``, ``BANKLINK#``, ``DEPOSIT#`` and ``MONEYPREFS``. ``public_key`` (the public half
    of the bank key, from its secret) is called only while the step cards show."""
    pk = db.user_pk(user_id)
    conn = store.get(pk, CONN_SK) or {}
    links = store.query_all(pk, LINK_PREFIX)
    deposits = store.query_all(pk, DEPOSIT_PREFIX)
    prefs = store.get(pk, PREFS_SK) or {}
    items: Item = {"conn": conn, "links": links, "deposits": deposits, "country": prefs.get("country")}
    made = _map(conn.get("app")).get("status") in {"key_made", "saved"}
    if made and public_key is not None and not all_steps_done(conn, links):
        items["key"] = public_key()
    return view(items, now, cr_on=cr_on, values=values)
