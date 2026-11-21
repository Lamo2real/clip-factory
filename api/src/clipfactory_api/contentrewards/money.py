"""CR's own money numbers: ``CRMONEY`` and ``CrMoney`` (docs/CONTRACTS.md §38.7, §38.12 step 4).

Only CR's reported balance and payouts show (§25 extended), all in USD cents as CR reports them, only formatted. A
total shows only once CR's list was read to its end; until then ``paidSoFarCents`` is null ("Checking…"). The first
complete read fills what was already paid quietly (no celebration for old money); later new paid rows (found by the
``paidMark`` watermark) celebrate once each. ``reversed`` rows are never counted.

Paid by day (§39.2, for "All your money"): each paid row's amount is also kept by its ``paid_at`` UTC day
(``paidByDay``) while the first read runs, and by the watermark read once ``paidByDayDone`` (or while a day scan
runs). An owner whose first read finished before this gets one day scan (``dayScan``): it is made before the
watermark read of its tick, so every row that read adds is newer than its ``mark``, and the scan adds only the rows
at or older than the mark. It never touches ``paidTotalCents``, ``paidByCampaign`` or ``payoutsSeen``.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from . import config, connection
from .deps import CrDeps
from .gates import money as dollars
from .mcp import CrError
from .util import Loaded, changes, obj, update_parts

Item = dict[str, Any]
TAG = "Content Rewards' numbers"
SEEN_KEEP = 50
CAN_MOVE_CENTS = 100


def key(user_id: str) -> tuple[str, str]:
    return db.user_pk(user_id), db.CRMONEY_SK


def load(store: db.Store, user_id: str) -> Item:
    return store.get(*key(user_id)) or {}


def _cents(value: Any) -> int | None:
    if isinstance(value, Mapping):
        if str(value.get("currency") or "usd").lower() != "usd":
            log("warning", "cr.money_other_currency")
            return None
        value = value.get("value")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def public(deps: CrDeps, user_id: str, now: datetime) -> Item:
    conn = connection.load(deps.store, user_id)
    item = load(deps.store, user_id)
    status, _ = connection.effective(conn, now)
    out: Item = {
        "state": "ok",
        "tag": TAG,
        "stillEarningCents": item.get("stillEarningCents") if isinstance(item.get("stillEarningCents"), int) else None,
        "onItsWayCents": item.get("onItsWayCents") if isinstance(item.get("onItsWayCents"), int) else None,
        "readyToMoveCents": item.get("readyToMoveCents") if isinstance(item.get("readyToMoveCents"), int) else None,
        "paidSoFarCents": item.get("paidTotalCents") if item.get("firstReadDone") else None,
        "waitingForBrand": int(item.get("waitingForBrand") or 0),
        "campaigns": [],
        "celebrations": [dict(c) for c in item.get("celebrations") or [] if isinstance(c, Mapping)],
    }
    if item.get("asOf"):
        out["asOf"] = item["asOf"]
    if item.get("lastPaidAt"):
        out["lastPaidAt"] = item["lastPaidAt"]
    if isinstance(item.get("lastPaidCents"), int):
        out["lastPaidCents"] = item["lastPaidCents"]
    names = {
        str(c.get("crId")): (str(c.get("campaignId")), str(c.get("name") or "A campaign"))
        for c in deps.store.query_all(db.user_pk(user_id), db.CAMPAIGN_PREFIX)
        if c.get("type") == "campaign" and c.get("crId")
    }
    paid_by = obj(item.get("paidByCampaign"))
    pending_by = obj(item.get("pendingByCampaign"))
    for cr_id in sorted(set(paid_by) | set(pending_by)):
        found = names.get(cr_id)
        row: Item = {
            "name": found[1] if found else "A campaign",
            "paidCents": int(paid_by.get(cr_id) or 0),
            "pendingCents": int(pending_by.get(cr_id) or 0),
        }
        if found:
            row["campaignId"] = found[0]
        out["campaigns"].append(row)
    if status == "not_connected":
        out["state"] = "not_connected"
    elif status == "needs_reconnect":
        out["state"] = "needs_reconnect"
    elif item.get("error") and not item.get("asOf"):
        out["state"] = "error"
        out["error"] = "Content Rewards didn't answer. Try again in a few minutes."
    elif not item.get("firstReadDone"):
        out["state"] = "checking"
    elif not any((out["paidSoFarCents"], out["stillEarningCents"], out["readyToMoveCents"], out["onItsWayCents"])):
        out["state"] = "none_yet"
    return out


def _celebrate(item: Item, key_: str, kind: str, text: str) -> None:
    rows = [c for c in item.get("celebrations") or [] if isinstance(c, Mapping) and c.get("key") != key_]
    rows.append({"key": key_, "kind": kind, "text": text})
    item["celebrations"] = rows[-10:]


def read(deps: CrDeps, user_id: str, now: datetime, *, calls_left: int = 25) -> Item:
    """One money read (balance, paid, pending). Returns the stored item. ``CrError`` stops the read where it is
    (what was read so far is kept)."""
    found = load(deps.store, user_id)
    item: Item = Loaded(found) if found else {"type": "crmoney", "userId": user_id}
    client = deps.mcp(user_id)
    start_calls = client.calls
    try:
        _balance(client, item, now)
        _start_day_scan(item, now)
        _paid(deps, client, user_id, item, now, start_calls, calls_left)
        _day_scan(client, item, now, start_calls, calls_left)
        if client.calls - start_calls < calls_left:
            _pending(deps, client, user_id, item, now)
        item.pop("error", None)
    except CrError as e:
        item["error"] = e.code
        log("info", "cr.money_failed", code=e.code)
        raise
    finally:
        item["waitingForBrand"] = sum(
            1
            for s in deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX)
            if s.get("type") == "crsub" and s.get("crStatus") == "pending" and not s.get("removed")
        )
        # A day scan goes on at the next tick (at most 8 pages a tick), then the usual cadence.
        item["nextCheckAt"] = iso(now + (config.TICK if item.get("dayScan") else _cadence(deps, user_id, now)))
        item["updatedAt"] = iso(now)
        item = _write(deps, user_id, item)
    return item


def _write(deps: CrDeps, user_id: str, item: Item) -> Item:
    """Only the fields this read changed (``lastManualAt`` and a celebration seen meanwhile are never undone); new
    celebrations are added to the ones stored now."""
    before = getattr(item, "before", {})
    sets, remove = changes(before, item)
    if "celebrations" in sets:
        old_keys = {c.get("key") for c in before.get("celebrations") or [] if isinstance(c, Mapping)}
        new_rows = [
            c for c in item.get("celebrations") or [] if isinstance(c, Mapping) and c.get("key") not in old_keys
        ]
        current = [c for c in load(deps.store, user_id).get("celebrations") or [] if isinstance(c, Mapping)]
        kept = [c for c in current if c.get("key") not in {r.get("key") for r in new_rows}]
        sets["celebrations"] = [*kept, *new_rows][-10:]
    if not sets and not remove:
        return item
    expression, names, values = update_parts(sets, remove)
    return Loaded(deps.store.update_expr(*key(user_id), expression, names=names, values=values))


def _cadence(deps: CrDeps, user_id: str, now: datetime) -> timedelta:
    """Hourly while any submission is pending or approved in the last 30 days, else daily."""
    for s in deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX):
        if s.get("crStatus") == "pending":
            return timedelta(hours=1)
        sent = parse(s.get("sentAt"))
        if s.get("crStatus") == "approved" and sent is not None and now - sent < config.STOP_AFTER:
            return timedelta(hours=1)
    return timedelta(days=1)


def _balance(client: Any, item: Item, now: datetime) -> None:
    balance = client.call("get_my_balance", {})
    available = _cents(balance.get("available"))
    moving = _cents(balance.get("withdrawal_pending"))
    before_available = item.get("readyToMoveCents")
    before_moving = item.get("onItsWayCents")
    if isinstance(available, int):
        crossed = not isinstance(before_available, int) or before_available < CAN_MOVE_CENTS
        if available >= CAN_MOVE_CENTS and crossed and (item.get("firstReadDone") or isinstance(before_available, int)):
            _celebrate(item, f"can_move:{iso(now)[:10]}", "can_move", f"You can move {dollars(available)} to Whop now.")
        item["readyToMoveCents"] = available
    if isinstance(moving, int):
        if isinstance(before_moving, int) and before_moving > 0 and moving == 0:
            item["movedAt"] = iso(now)  # auto: money_moved
        item["onItsWayCents"] = moving
    item["asOf"] = str(balance.get("as_of") or iso(now))


def _paid_row(row: Mapping[str, Any]) -> tuple[str, int, str, str | None, str] | None:
    if row.get("status") != "paid":
        return None
    amount = _cents(row.get("amount"))
    if amount is None:
        return None
    return (
        str(row.get("id")),
        amount,
        str(row.get("campaign") or ""),
        str(row["submission"]) if isinstance(row.get("submission"), str) else None,
        str(row.get("paid_at") or row.get("created_at") or ""),
    )


def paid_day(row: Mapping[str, Any]) -> str | None:
    """A paid row's day: its ``paid_at`` (``created_at`` when absent) as a UTC date."""
    moment = parse(row.get("paid_at") or row.get("created_at"))
    return moment.astimezone(UTC).date().isoformat() if moment is not None else None


def _add_day(days: dict[str, Any], row: Mapping[str, Any], amount: int) -> None:
    day = paid_day(row)
    if day is not None:
        days[day] = int(days.get(day) or 0) + amount


def _by_day(item: Mapping[str, Any]) -> bool:
    """Paid rows are kept by day: the first read, and later reads once the days are complete or being filled."""
    return not item.get("firstReadDone") or bool(item.get("paidByDayDone")) or isinstance(item.get("dayScan"), Mapping)


def _add_paid(
    deps: CrDeps, user_id: str, item: Item, rows: list[Mapping[str, Any]], subs: dict[str, Item]
) -> list[tuple[str, int, str]]:
    added = []
    seen = list(item.get("payoutsSeen") or [])
    by_campaign = dict(item.get("paidByCampaign") or {})
    by_day = _by_day(item)
    days = dict(item.get("paidByDay") or {})
    for row in rows:
        parsed = _paid_row(row)
        if parsed is None or parsed[0] in seen:
            continue
        pay_id, amount, cr_campaign, submission, paid_at = parsed
        item["paidTotalCents"] = int(item.get("paidTotalCents") or 0) + amount
        by_campaign[cr_campaign] = int(by_campaign.get(cr_campaign) or 0) + amount
        if by_day:
            _add_day(days, row, amount)
        seen.insert(0, pay_id)
        if submission and submission in subs:
            sub = subs[submission]
            earned = dict(sub.get("earned") or {"paidCents": 0, "pendingCents": 0})
            earned["paidCents"] = int(earned.get("paidCents") or 0) + amount
            sub["earned"] = earned
            deps.store.update(sub["pk"], sub["sk"], {"earned": earned})
        if paid_at and paid_at > str(item.get("lastPaidAt") or ""):
            item["lastPaidAt"] = paid_at
            item["lastPaidCents"] = amount
        added.append((pay_id, amount, paid_at))
    item["paidByCampaign"] = by_campaign
    item["payoutsSeen"] = seen[:SEEN_KEEP]
    if by_day:
        item["paidByDay"] = days
    return added


def _subs_by_submission(deps: CrDeps, user_id: str) -> dict[str, Item]:
    return {
        str(s["submissionId"]): s
        for s in deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX)
        if s.get("type") == "crsub" and s.get("submissionId")
    }


def _paid(  # noqa: PLR0915, PLR0917 (the first read and the watermark read of §38.12)
    deps: CrDeps, client: Any, user_id: str, item: Item, now: datetime, start_calls: int, calls_left: int
) -> None:
    subs = _subs_by_submission(deps, user_id)
    if not item.get("firstReadDone"):
        scan = dict(item.get("scan") or {})
        started = parse(scan.get("at"))
        if started is None or now - started > config.SCAN_KEEP:
            scan = {"status": "running", "cursor": None, "at": iso(now)}
            item["paidTotalCents"], item["paidByCampaign"], item["payoutsSeen"] = 0, {}, []
            item["paidByDay"] = {}
        elif scan.get("cursor") and "paidByDay" not in item:
            # a first read already under way before paidByDay: its earlier pages were never kept by day, so the
            # days it keeps are dropped at the end and the day scan reads them all
            scan["noDays"] = True
        cursor = scan.get("cursor")
        for _ in range(config.PAID_PAGES_PER_TICK):
            if client.calls - start_calls >= calls_left:
                break
            args: Item = {"status": ["paid"], "limit": config.PAGE_LIMIT}
            if cursor:
                args["cursor"] = cursor
            page = client.call("list_my_payouts", args)
            rows = [r for r in page.get("data") or [] if isinstance(r, Mapping)]
            if not scan.get("mark") and rows:
                first = _paid_row(rows[0])
                if first:
                    scan["mark"] = {"id": first[0], "createdAt": str(rows[0].get("created_at") or "")}
            _add_paid(deps, user_id, item, rows, subs)
            cursor = page.get("next_cursor") if isinstance(page.get("next_cursor"), str) else None
            if not page.get("has_more") or not cursor:
                item["firstReadDone"] = True
                item["paidMark"] = scan.get("mark") or {}
                item.pop("scan", None)
                if scan.get("noDays"):
                    item.pop("paidByDay", None)
                    _start_day_scan(item, now)  # the day scan reads every row up to the mark, from this tick on
                else:
                    item["paidByDayDone"] = True
                return
        scan["cursor"] = cursor
        item["scan"] = scan
        return
    mark = obj(item.get("paidMark"))
    new_rows: list[Mapping[str, Any]] = []
    cursor = None
    reached = False
    newest: Item | None = None
    for _ in range(config.PAID_PAGES_PER_TICK):
        if client.calls - start_calls >= calls_left:
            break
        args = {"status": ["paid"], "limit": config.PAGE_LIMIT}
        if cursor:
            args["cursor"] = cursor
        page = client.call("list_my_payouts", args)
        for row in page.get("data") or []:
            if not isinstance(row, Mapping):
                continue
            if row.get("id") == mark.get("id"):
                reached = True
                break
            if newest is None and row.get("status") == "paid":
                newest = {"id": str(row.get("id")), "createdAt": str(row.get("created_at") or "")}
            new_rows.append(row)
        cursor = page.get("next_cursor") if isinstance(page.get("next_cursor"), str) else None
        if reached or not page.get("has_more") or not cursor:
            break
    before = int(item.get("paidTotalCents") or 0)
    added = _add_paid(deps, user_id, item, new_rows, subs)
    if newest is not None:
        item["paidMark"] = newest
    for pay_id, amount, _at in added:
        if before == 0:
            _celebrate(item, f"money:{pay_id}", "first_money", "Your first money from Content Rewards!")
            before = amount
        else:
            _celebrate(
                item,
                f"money:{pay_id}",
                "money_arrived",
                f"Money from Content Rewards! {dollars(amount)} is in your balance.",
            )


def _start_day_scan(item: Item, now: datetime) -> None:
    """An owner whose first read finished before ``paidByDay``: nothing was paid (an empty ``paidMark``), so the
    days are complete at once; else the day scan starts now, before this tick's watermark read. A scan stuck for 7
    days starts over with the same mark (the watermark read already kept every newer row by day)."""
    if not item.get("firstReadDone") or item.get("paidByDayDone"):
        return
    mark = obj(item.get("paidMark"))
    scan = item.get("dayScan")
    if isinstance(scan, Mapping):
        started = parse(scan.get("at"))
        if started is not None and now - started <= config.SCAN_KEEP:
            return
        mark = obj(scan.get("mark")) or mark
    if not mark.get("id"):
        item["paidByDay"] = dict(item.get("paidByDay") or {})
        item["paidByDayDone"] = True
        item.pop("dayScan", None)
        return
    item["dayScan"] = {"status": "running", "cursor": None, "mark": mark, "passed": False, "days": {}, "at": iso(now)}


def _older_than_mark(row: Mapping[str, Any], mark: Mapping[str, Any], passed: bool) -> bool:
    """The list is newest first: a row is at or older than the mark once the mark's own row (or, if that row is gone
    from the list, a row made before it) was reached. A row listed before the mark with the mark's own
    ``created_at`` (paid in the same round) is newer: the watermark read already kept it by day."""
    if passed or row.get("id") == mark.get("id"):
        return True
    made, marked = parse(row.get("created_at")), parse(mark.get("createdAt"))
    return made is not None and marked is not None and made < marked


def _day_scan(client: Any, item: Item, now: datetime, start_calls: int, calls_left: int) -> None:
    """At most 8 pages of ``list_my_payouts {status: [paid]}`` a tick; at the end one write adds the days into
    ``paidByDay`` and sets ``paidByDayDone``."""
    scan = item.get("dayScan")
    if not isinstance(scan, Mapping) or item.get("paidByDayDone"):
        return
    scan = dict(scan)
    mark = obj(scan.get("mark"))
    days = dict(scan.get("days") or {})
    passed = bool(scan.get("passed"))
    cursor = scan.get("cursor") if isinstance(scan.get("cursor"), str) else None
    for _ in range(config.PAID_PAGES_PER_TICK):
        if client.calls - start_calls >= calls_left:
            break
        args: Item = {"status": ["paid"], "limit": config.PAGE_LIMIT}
        if cursor:
            args["cursor"] = cursor
        page = client.call("list_my_payouts", args)
        for row in page.get("data") or []:
            if not isinstance(row, Mapping):
                continue
            passed = _older_than_mark(row, mark, passed)
            parsed = _paid_row(row)
            if passed and parsed is not None:
                _add_day(days, row, parsed[1])
        cursor = page.get("next_cursor") if isinstance(page.get("next_cursor"), str) else None
        if not page.get("has_more") or not cursor:
            total = dict(item.get("paidByDay") or {})
            for day, cents in days.items():
                total[day] = int(total.get(day) or 0) + int(cents)
            item["paidByDay"] = total
            item["paidByDayDone"] = True
            item.pop("dayScan", None)
            log("info", "cr.day_scan_done", days=len(total))
            return
        scan.update(cursor=cursor, days=dict(days), passed=passed)
    scan.update(cursor=cursor, days=days, passed=passed)
    item["dayScan"] = scan


def _pending(deps: CrDeps, client: Any, user_id: str, item: Item, now: datetime) -> None:
    rows, complete = client.list_all("list_my_payouts", {"status": ["pending"]}, config.PENDING_PAGES)
    if not complete:
        return  # a cap hit keeps the last full value and its pendingAsOf
    total = 0
    by_campaign: dict[str, int] = {}
    by_submission: dict[str, int] = {}
    for row in rows:
        if row.get("status") != "pending":
            continue
        amount = _cents(row.get("amount")) or 0
        total += amount
        cr_campaign = str(row.get("campaign") or "")
        by_campaign[cr_campaign] = by_campaign.get(cr_campaign, 0) + amount
        if isinstance(row.get("submission"), str):
            by_submission[row["submission"]] = by_submission.get(row["submission"], 0) + amount
    item["stillEarningCents"] = total
    item["pendingByCampaign"] = by_campaign
    item["pendingAsOf"] = iso(now)
    for submission, sub in _subs_by_submission(deps, user_id).items():
        earned = dict(sub.get("earned") or {"paidCents": 0, "pendingCents": 0})
        value = by_submission.get(submission, 0)
        if earned.get("pendingCents") != value:
            earned["pendingCents"] = value
            earned.setdefault("paidCents", 0)
            deps.store.update(sub["pk"], sub["sk"], {"earned": earned})


def seen(deps: CrDeps, user_id: str, key_: str) -> bool:
    item = load(deps.store, user_id)
    rows = [c for c in item.get("celebrations") or [] if isinstance(c, Mapping)]
    kept = [c for c in rows if c.get("key") != key_]
    if len(kept) == len(rows):
        return False
    deps.store.update(*key(user_id), {"celebrations": kept})
    return True
