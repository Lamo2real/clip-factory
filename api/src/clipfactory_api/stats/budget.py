"""The shared rate budget per platform (docs/CONTRACTS.md §16.3–§16.4): one item ``RATE#{platform}`` / ``BUDGET``.

The poller, the manual Refresh button and the clip-flow all call ``reserve`` before a platform request and
``record`` after it, so together they never go past a platform's limit.

* ``reserve`` reads the budget and writes the new counters with one conditional UpdateItem on the item's
  ``version`` (compare-and-swap). Two reservations racing for the last slot cannot both win: the loser's condition
  fails, it re-reads the budget, sees it full and gets ``Blocked``. A ``blockedUntil`` in the future blocks every
  kind.
* ``record`` stores what the answer said (Meta's ``X-Business-Use-Case-Usage``, X's reset time) and sets
  ``blockedUntil`` when the platform throttled us or is close to doing so.

Single-owner app: the budget is app-wide, not per user.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from ..platforms.base import ResponseMeta, to_int, to_number
from . import config

CAS_ATTEMPTS = 5
TIKTOK_BLOCK = timedelta(minutes=1)
META_MIN_STOP_BLOCK_MINUTES = 15
X_WINDOW_MINUTES = 15
YOUTUBE_DAY_OFFSET = timedelta(hours=8)  # the quota resets at midnight Pacific; PST = UTC - 8 h


@dataclass(frozen=True)
class Reserved:
    platform: str
    cost: int


@dataclass(frozen=True)
class Blocked:
    platform: str
    next_allowed_at: datetime
    reason: str


Reservation = Reserved | Blocked


def youtube_day_key(now: datetime) -> str:
    return (now.astimezone(UTC) - YOUTUBE_DAY_OFFSET).date().isoformat()


def youtube_next_reset(now: datetime) -> datetime:
    """The next ``dayKey`` boundary: 08:00 UTC after the current Pacific day."""
    day = datetime.fromisoformat(youtube_day_key(now)).replace(tzinfo=UTC)
    return day + timedelta(days=1) + YOUTUBE_DAY_OFFSET


def minute_key(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M")


def x_window_start(now: datetime) -> datetime:
    utc = now.astimezone(UTC).replace(second=0, microsecond=0)
    return utc.replace(minute=utc.minute - utc.minute % X_WINDOW_MINUTES)


def next_month(now: datetime) -> datetime:
    utc = now.astimezone(UTC)
    year, month = (utc.year + 1, 1) if utc.month == 12 else (utc.year, utc.month + 1)
    return datetime(year, month, 1, tzinfo=UTC)


def get_budget(store: db.Store, platform: str) -> dict[str, Any]:
    return store.get(db.rate_pk(platform), db.RATE_SK) or {}


def blocked_until(item: dict[str, Any], now: datetime) -> datetime | None:
    until = parse(item.get("blockedUntil"))
    return until if until is not None and until > now else None


def reserve(
    store: db.Store,
    platform: str,
    cost: int,
    now: datetime,
    *,
    ids: list[str] | tuple[str, ...] = (),
    cfg: config.PlatformsConfig | None = None,
) -> Reservation:
    """Claims ``cost`` (requests, or YouTube quota units) for one platform request. ``ids`` are the stats ids the
    request reads (X bills per post read, free again within the same UTC day)."""
    cfg = cfg or config.load()
    budget = cfg.platform(platform).budget
    for _ in range(CAS_ATTEMPTS):
        item = get_budget(store, platform)
        until = blocked_until(item, now)
        if until is not None:
            return Blocked(platform, until, str(item.get("blockedReason") or "blocked"))
        planned = _plan(platform=platform, budget=budget, item=item, cost=cost, now=now, ids=ids)
        if isinstance(planned, Blocked):
            if planned.reason == "monthly_cap":
                _set_block(store, platform, planned.next_allowed_at, planned.reason, now)
            return planned
        if planned is None:
            return Reserved(platform, cost)  # Meta: nothing to count, the usage header decides (record)
        try:
            _write(store, platform, item, planned, now)
        except db.ConditionFailed:
            continue  # someone else reserved meanwhile: read again
        return Reserved(platform, cost)
    log("warning", "stats.budget_contended", platform=platform)
    return Blocked(platform, now + timedelta(minutes=1), "busy")


def _plan(
    *,
    platform: str,
    budget: dict[str, Any],
    item: dict[str, Any],
    cost: int,
    now: datetime,
    ids: list[str] | tuple[str, ...],
) -> dict[str, Any] | Blocked | None:
    kind = budget["kind"]
    if kind == "daily_units":
        key = youtube_day_key(now)
        used = int(item.get("unitsUsed") or 0) if item.get("dayKey") == key else 0
        if used + cost > int(budget["dailyUnits"]) - int(budget["reserveUnits"]):
            return Blocked(platform, youtube_next_reset(now), "daily_quota")
        return {"dayKey": key, "unitsUsed": used + cost}
    if kind == "per_minute":
        key = minute_key(now)
        used = int(item.get("requestsThisMinute") or 0) if item.get("minuteKey") == key else 0
        if used + cost > int(budget["useAtMost"]):
            start = now.astimezone(UTC).replace(second=0, microsecond=0)
            return Blocked(platform, start + timedelta(minutes=1), "per_minute")
        return {"minuteKey": key, "requestsThisMinute": used + cost}
    if kind == "x":
        window = x_window_start(now)
        window_key = minute_key(window)
        used = int(item.get("requestsThisWindow") or 0) if item.get("windowKey") == window_key else 0
        if used + cost > int(budget["useAtMost"]):
            return Blocked(platform, window + timedelta(minutes=X_WINDOW_MINUTES), "window")
        day_key = now.astimezone(UTC).date().isoformat()
        month_key = now.astimezone(UTC).strftime("%Y-%m")
        seen = set(item.get("dayPostIds") or []) if item.get("dayKey") == day_key else set()
        new_ids = {str(i) for i in ids} - seen
        spent = float(item.get("monthUsd") or 0) if item.get("monthKey") == month_key else 0.0
        charge = float(budget["usdPerPostRead"]) * len(new_ids)
        if spent + charge > float(budget["monthlyUsd"]) + 1e-9:
            return Blocked(platform, next_month(now), "monthly_cap")
        plan: dict[str, Any] = {
            "windowKey": window_key,
            "requestsThisWindow": used + cost,
            "dayKey": day_key,
            "monthKey": month_key,
            "monthUsd": round(spent + charge, 6),
        }
        if seen | new_ids:
            plan["dayPostIds"] = seen | new_ids
        return plan
    return None  # meta_buc


def _write(store: db.Store, platform: str, item: dict[str, Any], fields: dict[str, Any], now: datetime) -> None:
    version = int(item.get("version") or 0)
    sets = {"type": "rate", "platform": platform, "updatedAt": iso(now), "version": version + 1, **fields}
    names = {f"#f{i}": k for i, k in enumerate(sets)}
    values = {f":f{i}": v for i, v in enumerate(sets.values())}
    update = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(sets)))
    remove = [k for k in ("dayPostIds",) if k not in fields and k in item and platform == "x"]
    if remove:
        names["#r0"] = remove[0]
        update += " REMOVE #r0"
    names["#ver"] = "version"
    if item:
        condition = "#ver = :expected" if "version" in item else "attribute_not_exists(#ver)"
        if "version" in item:
            values[":expected"] = version
    else:
        condition = "attribute_not_exists(pk)"
        names.pop("#ver")
    store.update_expr(db.rate_pk(platform), db.RATE_SK, update, condition=condition, names=names, values=values)


def _set_block(store: db.Store, platform: str, until: datetime, reason: str, now: datetime, **extra: Any) -> None:
    fields: dict[str, Any] = {
        "type": "rate",
        "platform": platform,
        "updatedAt": iso(now),
        "blockedUntil": iso(until),
        "blockedReason": reason,
        **extra,
    }
    _set(store, platform, fields)
    log("warning", "stats.blocked", platform=platform, reason=reason, until=iso(until))


def _set(store: db.Store, platform: str, fields: dict[str, Any]) -> None:
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":f{i}": v for i, v in enumerate(fields.values())}
    update = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields)))
    store.update_expr(db.rate_pk(platform), db.RATE_SK, update, names=names, values=values)


def parse_buc(headers: dict[str, str]) -> dict[str, Any] | None:
    """The highest entry of ``X-Business-Use-Case-Usage`` (or ``X-App-Usage`` for user/app tokens)."""
    raw = headers.get("x-business-use-case-usage")
    entries: list[dict[str, Any]] = []
    if raw:
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            for rows in parsed.values():
                entries.extend(r for r in (rows if isinstance(rows, list) else [rows]) if isinstance(r, dict))
    app = headers.get("x-app-usage")
    if not entries and app:
        try:
            parsed_app = json.loads(app)
        except ValueError:
            parsed_app = None
        if isinstance(parsed_app, dict):
            entries.append(parsed_app)
    if not entries:
        return None

    def level(row: dict[str, Any]) -> float:
        return max(float(to_number(row.get(k)) or 0) for k in ("call_count", "total_cputime", "total_time"))

    top = max(entries, key=level)
    return {
        "callCount": to_number(top.get("call_count")) or 0,
        "totalCputime": to_number(top.get("total_cputime")) or 0,
        "totalTime": to_number(top.get("total_time")) or 0,
        "estimatedTimeToRegainAccess": to_int(top.get("estimated_time_to_regain_access")) or 0,
    }


def record(
    store: db.Store,
    platform: str,
    meta: ResponseMeta,
    now: datetime,
    *,
    cfg: config.PlatformsConfig | None = None,
) -> datetime | None:
    """Stores what the platform's answer said about our usage; returns ``blockedUntil`` when it set one."""
    cfg = cfg or config.load()
    budget = cfg.platform(platform).budget
    kind = budget["kind"]
    if kind == "daily_units":
        if meta.status == 403 and meta.error_code in set(budget.get("blockOn") or []):
            until = youtube_next_reset(now)
            _set_block(store, platform, until, str(meta.error_code), now)
            return until
        return None
    if kind == "per_minute":
        if meta.status == 429 or (meta.error_code and meta.error_code in set(budget.get("blockOn") or [])):
            until = now + TIKTOK_BLOCK
            _set_block(store, platform, until, str(meta.error_code or "rate_limit_exceeded"), now)
            return until
        return None
    if kind == "meta_buc":
        buc = parse_buc(meta.headers)
        fields: dict[str, Any] = {}
        if buc is not None:
            fields["buc"] = {**buc, "at": iso(now)}
        eta = int((buc or {}).get("estimatedTimeToRegainAccess") or 0)
        throttle = {str(c) for c in budget.get("throttleCodes") or []}
        if meta.error_code is not None and meta.error_code in throttle:
            until = now + timedelta(minutes=max(eta, int(budget["minBlockMinutes"])))
            _set_block(store, platform, until, f"throttled_{meta.error_code}", now, **fields)
            return until
        level = max((float(buc[k]) for k in ("callCount", "totalCputime", "totalTime")), default=0) if buc else 0
        if level >= float(budget["stopAtPercent"]):
            until = now + timedelta(minutes=max(eta, META_MIN_STOP_BLOCK_MINUTES))
            _set_block(store, platform, until, "usage_high", now, **fields)
            return until
        if fields:
            _set(store, platform, {"type": "rate", "platform": platform, "updatedAt": iso(now), **fields})
        return None
    # x
    reset = datetime.fromtimestamp(meta.retry_after, UTC) if meta.retry_after else None
    remaining = to_int(meta.headers.get("x-rate-limit-remaining"))
    if meta.status == 429 or remaining == 0:
        until = reset if reset is not None and reset > now else now + timedelta(minutes=X_WINDOW_MINUTES)
        _set_block(store, platform, until, "rate_limited", now, resetAt=iso(until))
        return until
    if reset is not None:
        _set(store, platform, {"type": "rate", "platform": platform, "updatedAt": iso(now), "resetAt": iso(reset)})
    return None
