"""Money sent toward his bank, per place and in total (docs/CONTRACTS.md §40.4). Pure functions only.

* ``parse_amount(text)``: Google writes ``Payment.amount`` as formatted text ("kr 1 234,56 SEK", "$1,234.57"). The
  money type is a 3-letter code in the text, else only the unambiguous symbols € (EUR), £ (GBP) and ₹ (INR); "kr",
  "$" and "¥" alone could be several and are never guessed. The number takes spaces, no-break spaces, apostrophes, "."
  and "," as separators: with both "." and ",", the last one is the decimal mark; with one kind, it is the decimal
  mark only when exactly 1 or 2 digits follow it at the end. Golden cases: ``api/tests/fixtures/getpaid_sent_cases.json``.
* ``sent_line(place, rows, conn, state)``: one place's ``SentLine``: "Sent to your bank by Google" / "by Whop" with
  the reported amounts per money type, or the place's "Not available from …" line. Never $0, never converted.
* ``sent_totals(lines)``: the "Sent to your bank, so far" block: one line per money type in the places' order, never
  added across money types and never ranked against each other.
* ``payout_rows(place, rows)``: the place page's rows, newest first.

"Sent to your bank" is what Google or Whop say they sent; it is never "reached your bank" (only a bank-booked credit
is, §40.5, not built). ``web/src/api/mock/moneyEverywhere.ts`` holds a line-for-line copy of ``sent_line`` and
``sent_totals`` (checked through ``money_everywhere_cases.json``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from ..clock import parse
from . import BANK_TEXT, CR, MAX_PAYOUT_ROWS, name

Item = dict[str, Any]
MICROS = 1_000_000
MAX_AMOUNT_CHARS = 64
CHECKING_HOURS = 26
_CODE = re.compile(r"(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])")
_SYMBOLS = {"€": "EUR", "£": "GBP", "₹": "INR"}
_NUMBER = re.compile("[0-9](?:[0-9 \u00a0\u202f'\u2019.,]*[0-9])?")
_GROUPING = " \u00a0\u202f'\u2019"  # spaces, no-break spaces and apostrophes
_MINUS = "-\u2212"

GOOGLE_ARRIVE = "Your bank gets it up to 7 workdays after Google sends it."
WHOP_ARRIVE_SOON = "Whop says it should arrive within 5 workdays."
WHOP_NOTE = "Whop counts all your Whop money, not only Content Rewards."
YT_PAGE = "/settings/posting/getpaid/youtube"
YT_READING = "/settings/posting/getpaid/youtube#yt-reading"
WHOP_CARD = "/settings/posting/getpaid/contentrewards#whop"
STRIPE = "https://connect.stripe.com/express_login"
# Whop's payout status → the row's state (§40.4); only ``sent`` counts.
WHOP_STATES = {
    "completed": "sent",
    "requested": "on_its_way",
    "in_review": "on_its_way",
    "processing": "on_its_way",
    "failed": "didnt_go_through",
    "canceled": "didnt_go_through",
    "denied": "didnt_go_through",
    "reversed": "came_back",
}
NOT_AVAILABLE: dict[str, Item] = {
    "tiktok": {
        "headline": "Not available from TikTok",
        "where": {"text": "Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal."},
    },
    "instagram": {
        "headline": "Not available from Instagram",
        "where": {"text": "Look in Instagram: Professional dashboard, then Payouts. Meta also emails you each month."},
    },
    "facebook": {
        "headline": "Not available from Meta",
        "where": {"text": "Look in Meta Business Suite: All tools, then Payouts. Meta also emails you each month."},
    },
    "x": {
        "headline": "Not available from X",
        "where": {"text": "Look in Stripe: Payouts.", "button": {"label": "Open Stripe", "url": STRIPE}},
    },
}
# The block's names per place ("$210.00 · Whop (all your Whop money, Content Rewards too)").
TOTAL_NAMES = {"youtube": "YouTube", CR: "Whop (all your Whop money, Content Rewards too)"}
BY = {"youtube": "Google", CR: "Whop"}
STATE_WORDS = {
    "not_available": "not available",
    "needs_reading": "Clip Factory can't see it",
    "checking": "checking",
    "error": "couldn't check",
    "none_yet": "nothing sent yet",
}


# --- the amount parser ------------------------------------------------------------------------------------------


def _currency(text: str) -> str | None:
    codes = set(_CODE.findall(text))
    symbols = {_SYMBOLS[c] for c in text if c in _SYMBOLS}
    if len(codes) == 1:
        code = next(iter(codes))
        return code if not symbols or symbols == {code} else None
    if not codes and len(symbols) == 1:
        return next(iter(symbols))
    return None


def _split(raw: str) -> tuple[str, str] | None:
    """``(whole, fraction)`` digits of one number, or None when its marks can't be told apart."""
    s = "".join(c for c in raw if c not in _GROUPING)
    dot, comma = s.rfind("."), s.rfind(",")
    if dot >= 0 and comma >= 0:
        mark, grouping = (".", ",") if dot > comma else (",", ".")
        at = s.rfind(mark)
        whole, fraction = s[:at], s[at + 1 :]
        if mark in whole:
            return None
        return whole.replace(grouping, ""), fraction
    for mark in (".", ","):
        if mark in s:
            at = s.rfind(mark)
            tail = s[at + 1 :]
            if len(tail) in (1, 2):
                if s.count(mark) > 1:
                    return None
                return s[:at], tail
            return s.replace(mark, ""), ""
    return s, ""


def parse_amount(text: Any) -> tuple[int | None, str | None]:
    """``(micros, currency)`` of a formatted amount; each is None when it can't be read for sure."""
    if not isinstance(text, str):
        return None, None
    value = text.strip()
    if not value or len(value) > MAX_AMOUNT_CHARS:
        return None, None
    currency = _currency(value)
    found = list(_NUMBER.finditer(value))
    if len(found) != 1:
        return None, currency
    parts = _split(found[0].group(0))
    if parts is None:
        return None, currency
    whole, fraction = parts
    if not whole.isdigit() or (fraction and not fraction.isdigit()) or len(fraction) > 6:
        return None, currency
    try:
        amount = Decimal(f"{whole}.{fraction or '0'}") * MICROS
    except InvalidOperation:
        return None, currency
    micros = int(amount)
    if any(c in _MINUS for c in value[: found[0].start()]):
        micros = -micros
    return micros, currency


def whop_amount(payout: Mapping[str, Any]) -> tuple[int | None, str | None]:
    """What Whop says it sent to the bank (§40.4): ``destination_amount`` in ``destination_currency`` when both are
    there (after Whop's fees and any conversion Whop made), else ``net_amount`` in ``currency``. Whop's decimals
    become micros (times 1,000,000 by ``Decimal``, a unit change); money codes are upper-cased. For the writer of
    ``PAYOUT#contentrewards#…`` (``cf-prod-money``)."""
    for amount_key, currency_key in (("destination_amount", "destination_currency"), ("net_amount", "currency")):
        amount, currency = payout.get(amount_key), payout.get(currency_key)
        if amount is None or isinstance(amount, bool) or not isinstance(currency, str) or not currency:
            continue
        try:
            value = Decimal(str(amount))
        except InvalidOperation:
            return None, None
        if not value.is_finite():
            return None, None
        return int((value * MICROS).to_integral_value()), currency.upper()
    return None, None


# --- words --------------------------------------------------------------------------------------------------------


def _date(value: Any) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    moment = parse(value) if "T" in value else None
    if moment is not None:
        return moment.date()
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def short_day(value: Any) -> str:
    """ "23 Oct" for a day or a moment (UTC)."""
    found = _date(value)
    return f"{found.day} {found:%b}" if found else ""


def week_day(value: Any) -> str:
    """ "Thu 27 Nov"."""
    found = _date(value)
    return f"{found:%a} {found.day} {found:%b}" if found else ""


def join(names: Sequence[str]) -> str:
    items = list(names)
    if not items:
        return ""
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


# --- the rows -----------------------------------------------------------------------------------------------------


def youtube_state(row: Mapping[str, Any]) -> str:
    """``sent`` or ``gone`` (Google no longer lists it: it stops counting)."""
    return "gone" if row.get("goneAt") or row.get("state") == "gone" else "sent"


def whop_state(row: Mapping[str, Any]) -> str:
    status = row.get("status")
    if isinstance(status, str) and status in WHOP_STATES:
        return WHOP_STATES[status]
    state = row.get("state")
    return state if isinstance(state, str) and state in set(WHOP_STATES.values()) else "on_its_way"


def _newest(rows: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(rows, key=lambda r: (str(r.get("date") or ""), str(r.get("sk") or "")), reverse=True)


def _money(row: Mapping[str, Any], place: str) -> tuple[int | None, str | None]:
    if place == "youtube":
        return parse_amount(row.get("amountText"))
    micros = row.get("amountMicros")
    currency = row.get("currency")
    amount = micros if isinstance(micros, int) and not isinstance(micros, bool) else None
    return amount, (currency.upper() if isinstance(currency, str) and currency else None)


def _sums(pairs: Iterable[tuple[int, str]]) -> list[Item]:
    by: dict[str, int] = {}
    for micros, currency in pairs:
        by[currency] = by.get(currency, 0) + micros
    return [{"currency": c, "amountMicros": by[c]} for c in sorted(by)]


def payout_rows(place: str, rows: Iterable[Mapping[str, Any]]) -> list[Item]:
    """``PayoutRow[]``, newest first (at most 36). Google's own words when its money type couldn't be read; a trace
    code, an account or a publisher id never leaves."""
    out = []
    for r in _newest(rows)[:MAX_PAYOUT_ROWS]:
        micros, currency = _money(r, place)
        row: Item = {
            "date": str(r.get("date") or ""),
            "by": BY.get(place, ""),
            "state": youtube_state(r) if place == "youtube" else whop_state(r),
            "amountMicros": micros if currency else None,
            "currency": currency if micros is not None else None,
        }
        if place == "youtube" and (micros is None or currency is None) and isinstance(r.get("amountText"), str):
            row["text"] = r["amountText"]
        if place == CR and isinstance(r.get("estimatedArrival"), str) and r["estimatedArrival"]:
            row["arriveBy"] = r["estimatedArrival"]
        out.append(row)
    return out


# --- one place's line -----------------------------------------------------------------------------------------


def _line(state: str, headline: str, **extra: Any) -> Item:
    out: Item = {"state": state, "headline": headline, "amounts": []}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def first_read_late(conn: Mapping[str, Any], state: Mapping[str, Any], now: datetime | None) -> bool:
    """A connected reading whose first read hasn't finished: late after 26 hours, or after an error."""
    if state.get("lastError"):
        return True
    started = parse(conn.get("connectedAt"))
    return started is None or now is None or now - started >= timedelta(hours=CHECKING_HOURS)


def _unread_text(by: str, count: int, *, more: bool, what: str = "payment") -> str:
    things = what if count == 1 else f"{what}s"
    extra = " more" if more else ""
    if count == 1:
        return f"{by} sent 1{extra} {things}. Clip Factory couldn't tell its money type, so it isn't added up."
    return f"{by} sent {count}{extra} {things}. Clip Factory couldn't tell their money type, so they aren't added up."


def _row_not_added(count: int, what: str = "payment") -> str:
    if count == 1:
        return f"1 {what} isn't added up: Clip Factory couldn't tell its money type."
    return f"{count} {what}s aren't added up: Clip Factory couldn't tell their money type."


def _number_line(place: str, sent: list[Mapping[str, Any]]) -> Item:
    read: list[tuple[int, str]] = []
    unread = 0
    for r in sent:
        micros, currency = _money(r, place)
        if micros is None or currency is None:
            unread += 1
        else:
            read.append((micros, currency))
    by = BY[place]
    newest = _newest(sent)[0]
    micros, currency = _money(newest, place)
    last: Item = {
        "date": str(newest.get("date") or ""),
        "amountMicros": micros if currency else None,
        "currency": currency if micros is not None else None,
    }
    if place == "youtube" and last["amountMicros"] is None and isinstance(newest.get("amountText"), str):
        last["text"] = newest["amountText"]
    out = _line(
        "number",
        f"Sent to your bank by {by}",
        tag=f"{'YouTube' if place == 'youtube' else 'Whop'} says",
    )
    out["amounts"] = _sums(read)
    what = "payment" if place == "youtube" else "payout"
    if unread and read:
        out["notAdded"] = _row_not_added(unread, what)
    elif unread:
        out["notAdded"] = _unread_text(by, unread, more=False, what=what)
        if place == "youtube":
            out["button"] = {"label": "See them", "href": YT_PAGE, "external": False}
    if place == "youtube":
        out["arrive"] = GOOGLE_ARRIVE
    else:
        arrival = week_day(newest.get("estimatedArrival"))
        out["arrive"] = f"Whop says it should arrive by {arrival}." if arrival else WHOP_ARRIVE_SOON
        out["note"] = WHOP_NOTE
    out["last"] = last
    return out


def _youtube(rows: Sequence[Mapping[str, Any]], conn: Mapping[str, Any], state: Mapping[str, Any], now: Any) -> Item:
    status = conn.get("status")
    sent = [r for r in rows if youtube_state(r) == "sent"]
    if sent:
        out = _number_line("youtube", sent)
        if status == "needs_reconnect":
            out["note"] = "Clip Factory can't see YouTube payments anymore. Tap Allow payment reading again."
        elif status != "connected" and short_day(conn.get("stoppedAt")):
            out["note"] = f"Clip Factory stopped reading on {short_day(conn.get('stoppedAt'))}."
        return out
    if status == "connected":
        if state.get("firstReadDone"):
            return _line("none_yet", "Nothing sent to your bank yet", tag="YouTube says")
        if not first_read_late(conn, state, now):
            return _line("checking", "Checking YouTube payments…", why="This can take until tomorrow.")
        return _line("error", "Clip Factory couldn't check YouTube payments yet", why="It tries again tomorrow.")
    button = {"label": "Allow payment reading", "href": YT_READING, "external": False}
    if status == "needs_reconnect":
        return _line(
            "needs_reading",
            "Clip Factory can't see YouTube payments anymore",
            why="Tap Allow payment reading again.",
            button=button,
        )
    return _line("needs_reading", "Clip Factory can't see YouTube payments yet", button=button)


def _whop(
    rows: Sequence[Mapping[str, Any]], conn: Mapping[str, Any], state: Mapping[str, Any], now: Any, whop_on: bool
) -> Item:
    status = conn.get("status") if whop_on else None
    sent = [r for r in rows if whop_state(r) == "sent"]
    if sent:
        return _number_line(CR, sent)
    button = {"label": "Connect Whop", "href": WHOP_CARD, "external": False} if whop_on else None
    if status == "connected":
        if state.get("firstReadDone"):
            return _line("none_yet", "Nothing sent to your bank yet", tag="Whop says", note=WHOP_NOTE)
        if not first_read_late(conn, state, now):
            return _line("checking", "Checking your Whop payouts…", why="This can take until tomorrow.", note=WHOP_NOTE)
        return _line(
            "error", "Clip Factory couldn't check your Whop payouts yet", why="It tries again tomorrow.", note=WHOP_NOTE
        )
    if status == "needs_reconnect":
        return _line(
            "needs_reading",
            "Clip Factory can't see your Whop payouts anymore",
            why="Sign in to Whop again to see your payouts.",
            button=button,
        )
    return _line(
        "not_available",
        "Sent to your bank: not available from Content Rewards",
        where={"text": "Look on Whop: **Balances**."},
        button=button,
    )


def sent_line(
    place: str,
    rows: Sequence[Mapping[str, Any]] | None,
    conn: Mapping[str, Any] | None,
    state: Mapping[str, Any] | None,
    *,
    whop_on: bool = False,
    now: datetime | None = None,
) -> Item:
    """One place's ``SentLine``. ``rows``: its ``PAYOUT#`` items; ``conn``: its reading connection (``PAYCONN#adsense``
    for YouTube, ``PAYCONN#whop`` for Content Rewards); ``state``: its ``PAYSTATE#``."""
    if place == "youtube":
        return _youtube(list(rows or []), conn or {}, state or {}, now)
    if place == CR:
        return _whop(list(rows or []), conn or {}, state or {}, now, whop_on)
    found = NOT_AVAILABLE[place]
    return _line("not_available", found["headline"], where={**found["where"]})


# --- the block ----------------------------------------------------------------------------------------------------


_COUNT = re.compile(r"(\d+)(?: more)? (?:payment|payout)s?\b")


def _unread_count(line: Mapping[str, Any]) -> int:
    found = _COUNT.search(str(line.get("notAdded") or ""))
    return int(found.group(1)) if found else 0


def sent_totals(lines: Mapping[str, Mapping[str, Any]]) -> Item:
    """The "Sent to your bank, so far" block from each place's ``SentLine`` (in the places' order)."""
    by: dict[str, Item] = {}
    first: dict[str, int] = {}
    who: list[str] = []
    not_added: list[str] = []
    groups: dict[str, list[str]] = {}
    for index, (place, line) in enumerate(lines.items()):
        if line.get("state") != "number":
            groups.setdefault(str(line.get("state")), []).append(name(place))
            continue
        if BY.get(place) and BY[place] not in who:
            who.append(BY[place])
        for a in line.get("amounts") or []:
            total = by.setdefault(a["currency"], {"currency": a["currency"], "amountMicros": 0, "places": []})
            first.setdefault(a["currency"], index)
            total["amountMicros"] += int(a["amountMicros"])
            if place not in total["places"]:
                total["places"].append(place)
        count = _unread_count(line)
        if count:
            not_added.append(
                _unread_text(
                    BY.get(place, name(place)),
                    count,
                    more=bool(line.get("amounts")),
                    what="payment" if place == "youtube" else "payout",
                )
            )
    totals = sorted(by.values(), key=lambda t: (first[t["currency"]], t["currency"]))
    for t in totals:
        t["names"] = join([TOTAL_NAMES.get(p, name(p)) for p in t["places"]])
    out: Item = {"totals": totals}
    out["tag"] = f"{who[0]} says it sent it." if len(who) == 1 else "Google and Whop say they sent it."
    if not_added:
        out["notAdded"] = " ".join(not_added)
    if groups:
        parts = [f"{join(names)} ({STATE_WORDS.get(state, state)})" for state, names in groups.items()]
        out["notCountedText"] = "Not in this: " + " · ".join(parts) + "."
    out["bankText"] = BANK_TEXT
    if not any(line.get("state") == "number" for line in lines.values()):
        out["empty"] = "Nothing sent to your bank yet."
    return out
