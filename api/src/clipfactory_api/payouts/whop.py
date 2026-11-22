"""Whop: "Connect Whop" (docs/CONTRACTS.md §40.2, §40.4, §40.6, §40.7).

A run, only while ``PAYCONN#whop`` is ``connected`` (it can be only while ``WHOP_CONNECT`` is on):

1. ``GET /users/me`` (1): his own ``user_`` id, the ID check (``verification.individual``), owned businesses
   (``balance.businesses[]`` / ``balance.businesses_total_usd``, Whop's balances of the ``biz_`` accounts he owns).
2. ``GET /payouts/methods?user_id=`` (1): the saved methods and whether each can be paid to.
3. ``GET /payouts?user_id=&created_after=`` (at most 5 pages), from ``payoutsMark`` minus 30 days so status changes
   are seen; one ``PAYOUT#contentrewards#{created yyyy-mm-dd}#{payoutId}`` per payout, its amount Whop's own
   (``destination_amount`` in ``destination_currency`` when both are there, else ``net_amount`` in ``currency``; decimals
   become micros, a unit change, never a conversion).
4. ``PAYSTATE#contentrewards``: the ID check, the methods, the hold (the ID check didn't pass, every method is broken, or
   the newest payout in 30 days failed, was denied or came back with no newer completed one; a canceled one never is),
   the last sent payout, ``firstReadDone`` at the end of the first read.

Every call sends ``Api-Version-Date: 2026-11-20``. Clip Factory reads only his own (``user_id``) Whop money and never
moves any. Which balance Content Rewards pays (his own or a business's) is not known: owned businesses are only noted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

from .. import db
from ..clock import iso, parse
from ..log import log
from ..platforms.base import HttpRequest, NetworkError
from . import (
    CHECK_FAILED,
    CONTENT_REWARDS,
    KYC,
    OUT_OF_TIME,
    WHOP,
    WHOP_DOWN,
    WHOP_REFUSED,
    WHOP_STATES,
    PayoutDeps,
    grant_mark,
    load,
    newest_sent,
    payconn_sk,
    payout_prefix,
    paystate_sk,
    set_error,
    start_read,
    whop_payout_sk,
    write_state,
)
from .whoptokens import Access, TokenError, WhopTokens, headers

API = "https://api.whop.com/api/v1"
MAX_PAGES = 5
PAGE_SIZE = 50
WINDOW = timedelta(days=30)
MICROS = Decimal(1_000_000)
ID = re.compile(r"^[A-Za-z0-9_]{1,64}$")  # Whop's ids (``po_…``); the sort key's pattern in §40.7
USER_ID = re.compile(r"^user_[A-Za-z0-9]{1,64}$")
CURRENCY = re.compile(r"^[A-Z]{3}$")
BAD = frozenset({"failed", "denied", "reversed"})  # never "canceled": that one is often his own
BUSINESS_KEYS = ("owned_businesses", "businesses", "owned_companies", "companies")  # top level, just in case


class Failed(Exception):
    def __init__(self, text: str) -> None:
        super().__init__(text)
        self.text = text


@dataclass
class Read:
    kyc: str = "unknown"
    businesses: bool = False
    methods: dict[str, Any] = field(default_factory=dict)
    last_paid_out_at: str | None = None
    payouts: list[dict[str, Any]] = field(default_factory=list)  # parsed, with "createdAt" (never stored)
    mark: str | None = None


# --- reading --------------------------------------------------------------------------------------------------


class _Reader:
    def __init__(self, deps: PayoutDeps, tokens: WhopTokens, user_id: str) -> None:
        self.deps = deps
        self.tokens = tokens
        self.user_id = user_id
        self.access: Access | None = None

    def get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        if self.access is None:
            self.access = self.tokens.access(self.user_id)
        url = f"{API}{path}" + (f"?{urlencode(params)}" if params else "")
        resp = self._call(url, self.access.token)
        if resp is None:  # 401: Whop refused this token before it was due; refresh once and ask again
            self.access = self.tokens.access(self.user_id, stale=self.access.token)
            resp = self._call(url, self.access.token)
            if resp is None:
                raise Failed(WHOP_REFUSED)
        return resp

    def _call(self, url: str, token: str) -> dict[str, Any] | None:
        if self.deps.remaining() <= 0:
            raise Failed(OUT_OF_TIME)  # the money run's time budget is used up: never start another call
        try:
            resp = self.deps.http(HttpRequest("GET", url, headers({"Authorization": f"Bearer {token}"})))
        except NetworkError as e:
            raise Failed(WHOP_DOWN) from e
        if resp.status == 401:
            return None
        if resp.status == 200:
            found = resp.json()
            return found if isinstance(found, dict) else {}
        if resp.status in (400, 403, 404):
            raise Failed(WHOP_REFUSED)
        raise Failed(WHOP_DOWN)  # 429 and 5xx wait for the next run


def _positive(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return False
    return amount.is_finite() and amount > 0


def businesses(me: dict[str, Any]) -> bool:
    """Does he own a Whop business? Whop lists their balances under ``balance`` (``businesses[]`` and
    ``businesses_total_usd``; the balance comes only on the self view with balance reading). Only noted: Content
    Rewards may pay into a business's balance, which Clip Factory doesn't read."""
    if any(isinstance(me.get(k), list) and bool(me[k]) for k in BUSINESS_KEYS):
        return True
    balance = me.get("balance")
    if not isinstance(balance, dict):
        return False
    listed = balance.get("businesses")
    return (isinstance(listed, list) and bool(listed)) or _positive(balance.get("businesses_total_usd"))


def kyc(me: dict[str, Any]) -> str:
    verification = me.get("verification")
    found = verification.get("individual") if isinstance(verification, dict) else None
    status = found.get("status") if isinstance(found, dict) else found
    value = str(status or "").lower()
    return value if value in KYC else "unknown"


def methods(data: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """``({created, active, broken, ready, currencies}, lastPaidOutAt)``; ``ready``: ``created`` or ``active`` and its
    ``bank_verification_state`` is not ``pending`` or ``failed``."""
    counts = {"created": 0, "active": 0, "broken": 0, "ready": 0}
    currencies: set[str] = set()
    last: datetime | None = None
    for method in data.get("data") or []:
        if not isinstance(method, dict):
            continue
        status = str(method.get("status") or "").lower()
        if status in counts:
            counts[status] += 1
        check = str(method.get("bank_verification_state") or "").lower()
        if status in {"created", "active"} and check not in {"pending", "failed"}:
            counts["ready"] += 1
        currency = str(method.get("destination_currency") or "").upper()
        if CURRENCY.match(currency):
            currencies.add(currency)
        paid = parse(method.get("last_paid_out_at"))
        if paid is not None and (last is None or paid > last):
            last = paid
    return {**counts, "currencies": sorted(currencies)}, iso(last) if last else None


def micros(value: Any) -> int | None:
    """Whop's decimal amount as micros (times 1,000,000 by ``Decimal``: a unit change, never a conversion)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount < 0:
        return None
    return int((amount * MICROS).to_integral_value(rounding=ROUND_HALF_EVEN))


def payout(raw: dict[str, Any]) -> dict[str, Any] | None:
    """One Whop payout as the row's fields (plus ``createdAt``), or None when it can't be keyed."""
    payout_id = str(raw.get("id") or "")
    status = str(raw.get("status") or "").lower()
    created = parse(raw.get("created_at"))
    if not ID.match(payout_id) or created is None or status not in WHOP_STATES:
        return None
    amount, currency = raw.get("destination_amount"), raw.get("destination_currency")
    if amount is None or not currency:
        amount, currency = raw.get("net_amount"), raw.get("currency")
    code = str(currency or "").upper()
    found = micros(amount)
    readable = found is not None and CURRENCY.match(code) is not None
    arrival = parse(raw.get("estimated_arrival"))
    trace = raw.get("trace_code")
    return {
        "payoutId": payout_id,
        "status": status,
        "state": WHOP_STATES[status],
        "date": created.date().isoformat(),
        "createdAt": iso(created),
        "amountMicros": found if readable else None,
        "currency": code if readable else None,
        "estimatedArrival": iso(arrival) if arrival else None,
        "traceCode": str(trace)[:100] if isinstance(trace, str) and trace else None,
    }


def _payouts(reader: _Reader, whop_user: str, state: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    mark = parse(state.get("payoutsMark"))
    params = {"user_id": whop_user, "first": str(PAGE_SIZE)}
    if mark is not None:
        params["created_after"] = iso(mark - WINDOW)
    found: list[dict[str, Any]] = []
    newest = mark
    for _ in range(MAX_PAGES):
        page = reader.get("/payouts", params)
        for raw in page.get("data") or []:
            parsed = payout(raw) if isinstance(raw, dict) else None
            if parsed is None:
                continue
            found.append(parsed)
            created = parse(parsed["createdAt"])
            if created is not None and (newest is None or created > newest):
                newest = created
        info = page.get("page_info")
        cursor = info.get("end_cursor") if isinstance(info, dict) and info.get("has_next_page") else None
        if not isinstance(cursor, str) or not cursor:
            break
        params = {**params, "after": cursor}
    return found, iso(newest) if newest else None


def _read(deps: PayoutDeps, tokens: WhopTokens, user_id: str, conn: dict[str, Any], state: dict[str, Any]) -> Read:
    reader = _Reader(deps, tokens, user_id)
    me = reader.get("/users/me")
    whop_user = str(me.get("id") or "")
    if not USER_ID.match(whop_user):
        whop_user = str(conn.get("accountId") or "")
    if not USER_ID.match(whop_user):
        raise Failed(WHOP_REFUSED)
    read = Read(kyc=kyc(me), businesses=businesses(me))
    read.methods, read.last_paid_out_at = methods(reader.get("/payouts/methods", {"user_id": whop_user}))
    read.payouts, read.mark = _payouts(reader, whop_user, state)
    return read


# --- writing --------------------------------------------------------------------------------------------------

ROW_FIELDS = ("status", "state", "amountMicros", "currency", "estimatedArrival", "traceCode")


def _row(store: db.Store, pk: str, found: dict[str, Any], old: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    sk = whop_payout_sk(found["date"], found["payoutId"])
    values = {k: found[k] for k in ROW_FIELDS}
    if old is None:
        item = {
            "pk": pk,
            "sk": sk,
            "type": "payout",
            "place": CONTENT_REWARDS,
            "by": "whop",
            "source": "whop.payouts",
            "payoutId": found["payoutId"],
            "date": found["date"],
            **{k: v for k, v in values.items() if v is not None},
            "fetchedAt": iso(now),
            "updatedAt": iso(now),
        }
        try:
            store.put(item, if_absent=True)
            return item
        except db.ConditionFailed:
            old = store.get(pk, sk) or item
    changed = {k: v for k, v in values.items() if old.get(k) != v}
    if not changed:
        return old
    sets = {k: v for k, v in changed.items() if v is not None} | {"updatedAt": iso(now)}
    return store.update(pk, sk, sets, remove=[k for k, v in changed.items() if v is None])


def _hold(read: Read, state: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    counted = read.methods.get("created", 0) + read.methods.get("active", 0) + read.methods.get("broken", 0)
    kind = None
    if read.kyc == "rejected":
        kind = "id_rejected"
    elif counted and read.methods.get("broken") == counted:
        kind = "bank_broken"
    else:
        cutoff = iso(now - WINDOW)
        bad = [p for p in read.payouts if p["status"] in BAD and p["createdAt"] >= cutoff]
        if bad:
            worst = max(bad, key=lambda p: p["createdAt"])
            newer = any(p["status"] == "completed" and p["createdAt"] > worst["createdAt"] for p in read.payouts)
            kind = None if newer else "payout_failed"
    if kind is None:
        return None
    old = state.get("hold")
    since = old.get("since") if isinstance(old, dict) and old.get("kind") == kind else None
    return {"kind": kind, "since": since or iso(now)}


def _write(deps: PayoutDeps, user_id: str, *, now: datetime, state: dict[str, Any], read: Read, mark: str) -> None:
    pk = db.user_pk(user_id)
    rows = {str(r["sk"]): r for r in deps.store.query_all(pk, payout_prefix(CONTENT_REWARDS))}
    for found in read.payouts:
        sk = whop_payout_sk(found["date"], found["payoutId"])
        rows[sk] = _row(deps.store, pk, found, rows.get(sk), now)
    last = newest_sent(rows.values())
    fields: dict[str, Any] = {
        "type": "paystate",
        "place": CONTENT_REWARDS,
        "source": WHOP,
        "kyc": read.kyc,
        "methods": read.methods,
        "lastPaidOutAt": read.last_paid_out_at,
        "businesses": read.businesses,
        "hold": _hold(read, state, now),
        "lastSent": (
            {
                "sk": last["sk"],
                "date": last.get("date"),
                "amountMicros": last.get("amountMicros"),
                "currency": last.get("currency"),
            }
            if last
            else None
        ),
        "payoutsMark": read.mark,
        "grantMark": mark,
        "lastCheckedAt": iso(now),
        "firstReadDone": True,  # last: the first read after a grant ends here, quietly
    }
    write_state(deps.store, user_id, CONTENT_REWARDS, fields, remove=["lastError"])
    log("info", "payouts.whop_read", payouts=len(read.payouts), kyc=read.kyc)


def run(deps: PayoutDeps, user_id: str, now: datetime) -> str:
    """Reads Whop once; returns what happened (``not_connected``, ``read``, ``error``, ``token_dead``)."""
    conn = load(deps.store, user_id, payconn_sk(WHOP))
    if conn.get("status") != "connected":
        return "not_connected"
    mark = grant_mark(conn, WHOP)
    try:
        state = start_read(deps.store, user_id, WHOP, load(deps.store, user_id, paystate_sk(CONTENT_REWARDS)), mark)
        read = _read(deps, WhopTokens(deps), user_id, conn, state)
        _write(deps, user_id, now=now, state=state, read=read, mark=mark)
    except TokenError as e:
        if e.kind == "not_connected":
            return "not_connected"
        if e.kind == "dead":
            return "token_dead"  # PAYCONN#whop says so already
        set_error(deps.store, user_id, WHOP, WHOP_DOWN)
        return "error"
    except Failed as e:
        log("warning", "payouts.whop_failed", error=e.text)
        set_error(deps.store, user_id, WHOP, e.text)
        return "error"
    except Exception as e:  # a bug: say so on the state, and let the run go on
        log("error", "payouts.whop_crashed", error=type(e).__name__)
        set_error(deps.store, user_id, WHOP, CHECK_FAILED)
        return "error"
    return "read"
