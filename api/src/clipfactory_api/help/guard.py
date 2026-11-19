"""The guard: kill switch, per-owner rate limit and the 30-day model cap (docs/CONTRACTS.md §19.6).

Items in the existing table (no new table):

* ``HELP`` / ``SWITCH``: ``enabled``, ``model`` and ``pictures`` (absent = true), written by hand when needed, read at most once a
  minute per warm Lambda.
* ``USER#{userId}`` / ``HELP#RATE``: ``minuteKey``/``minuteCount``, ``hourKey``/``hourCount``, ``version``, ``ttl``.
  One conditional UpdateItem on ``version`` per question (compare-and-swap, like ``stats.budget.reserve``).
  A question with pictures also counts ``picDayKey``/``picDayCount`` (the per-owner daily picture limit, §26) in
  that same update, and keeps the item until the day is over.
* ``HELP`` / ``CAP#{window}``: ``modelAnswers``, ``ttl``; ``window = floor(epochDays / 30)``. One conditional ``ADD``
  per model call while under the cap.

``HELP#`` is not a broadcast prefix (§14.2), so none of these writes reaches the WebSocket.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .. import db
from ..log import log

SWITCH_PK = "HELP"
SWITCH_SK = "SWITCH"
RATE_SK = "HELP#RATE"
SWITCH_TTL = timedelta(seconds=60)
RATE_TTL = timedelta(hours=2)
PICTURE_DAY_TTL = timedelta(hours=26)
CAP_TTL = timedelta(days=62)
CAP_WINDOW_DAYS = 30
CAS_ATTEMPTS = 4


class GuardUnavailable(Exception):
    """The table could not be read or written; the request answers 503."""


@dataclass(frozen=True)
class Switch:
    enabled: bool
    model: bool
    pictures: bool = True


@dataclass
class SwitchCache:
    value: Switch | None = None
    read_at: datetime | None = None
    reads: int = 0


_SWITCH = SwitchCache()


def check_switch(store: db.Store, now: datetime, *, flag_enabled: bool, cache: SwitchCache | None = None) -> Switch:
    """The kill switch. The deploy flag ``HELP_ENABLED`` off wins without reading the table."""
    if not flag_enabled:
        return Switch(False, False, False)
    cache = _SWITCH if cache is None else cache
    if cache.value is not None and cache.read_at is not None and now - cache.read_at < SWITCH_TTL:
        return cache.value
    try:
        item = store.get(SWITCH_PK, SWITCH_SK) or {}
    except Exception as e:
        if cache.value is not None:
            return cache.value  # keep the last answer rather than failing every question
        raise GuardUnavailable(type(e).__name__) from e
    value = Switch(
        item.get("enabled", True) is not False,
        item.get("model", True) is not False,
        item.get("pictures", True) is not False,
    )
    cache.value, cache.read_at = value, now
    cache.reads += 1
    return value


# --- rate limit -------------------------------------------------------------------------------------------------


def minute_key(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M")


def hour_key(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H")


def _seconds_to_next_minute(now: datetime) -> int:
    utc = now.astimezone(UTC)
    nxt = utc.replace(second=0, microsecond=0) + timedelta(minutes=1)
    return max(1, math.ceil((nxt - utc).total_seconds()))


def _seconds_to_next_hour(now: datetime) -> int:
    utc = now.astimezone(UTC)
    nxt = utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return max(1, math.ceil((nxt - utc).total_seconds()))


def day_key(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class Reserved:
    wait: int | None  # None → allowed; else seconds until the owner may ask again
    picture: bool = False  # this question may look at its pictures (under the daily picture limit)


def reserve_rate(store: db.Store, user_id: str, now: datetime, *, per_minute: int, per_hour: int) -> int | None:
    """Counts one question. Returns ``None`` when allowed, else the seconds until the owner may ask again."""
    return reserve_question(store, user_id, now, per_minute=per_minute, per_hour=per_hour).wait


def reserve_question(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    per_minute: int,
    per_hour: int,
    pictures_per_day: int | None = None,
) -> Reserved:
    """Counts one question, and with ``pictures_per_day`` also one picture question for today, in the same
    compare-and-swap. Over the picture limit the question is still allowed, without
    pictures (``picture=False``)."""
    pk = db.user_pk(user_id)
    mkey, hkey, dkey = minute_key(now), hour_key(now), day_key(now)
    for _ in range(CAS_ATTEMPTS):
        try:
            item = store.get(pk, RATE_SK) or {}
        except Exception as e:
            raise GuardUnavailable(type(e).__name__) from e
        minute = int(item.get("minuteCount") or 0) if item.get("minuteKey") == mkey else 0
        hour = int(item.get("hourCount") or 0) if item.get("hourKey") == hkey else 0
        if hour >= per_hour:
            return Reserved(_seconds_to_next_hour(now))
        if minute >= per_minute:
            return Reserved(_seconds_to_next_minute(now))
        version = int(item.get("version") or 0)
        pic_today = int(item.get("picDayCount") or 0) if item.get("picDayKey") == dkey else 0
        picture = pictures_per_day is not None and pic_today < pictures_per_day
        if picture:
            pic_today += 1
        ttl = now + (PICTURE_DAY_TTL if pic_today else RATE_TTL)
        values: dict[str, object] = {
            ":mk": mkey,
            ":mc": minute + 1,
            ":hk": hkey,
            ":hc": hour + 1,
            ":v": version + 1,
            ":ttl": int(ttl.timestamp()),
            ":type": "help_rate",
        }
        names = {"#ver": "version", "#ttl": "ttl", "#type": "type"}
        update = (
            "SET minuteKey = :mk, minuteCount = :mc, hourKey = :hk, hourCount = :hc, #ver = :v, #ttl = :ttl, "
            "#type = :type"
        )
        if picture:
            update += ", picDayKey = :pk, picDayCount = :pc"
            values[":pk"], values[":pc"] = dkey, pic_today
        if item:
            condition = "#ver = :expected" if "version" in item else "attribute_not_exists(#ver)"
            if "version" in item:
                values[":expected"] = version
        else:
            condition = "attribute_not_exists(pk)"
            names.pop("#ver")
            update = update.replace("#ver = :v", "version = :v")
        try:
            store.update_expr(pk, RATE_SK, update, condition=condition, names=names, values=values)
        except db.ConditionFailed:
            continue  # another question from the same owner landed meanwhile: read again
        except Exception as e:
            raise GuardUnavailable(type(e).__name__) from e
        return Reserved(None, picture)
    log("warning", "help.rate_contended")
    return Reserved(1)


# --- the 30-day model cap ---------------------------------------------------------------------------------------


def cap_window(now: datetime) -> int:
    return int(now.astimezone(UTC).timestamp() // 86400) // CAP_WINDOW_DAYS


def cap_sk(now: datetime) -> str:
    return f"CAP#{cap_window(now)}"


def reserve_cap(store: db.Store, now: datetime, *, cap: int) -> bool:
    """Takes one model answer from this window's cap; False when it is full (or the table failed)."""
    if cap <= 0:
        return False
    try:
        store.update_expr(
            SWITCH_PK,
            cap_sk(now),
            "SET #ttl = if_not_exists(#ttl, :ttl), #type = :type ADD modelAnswers :one",
            condition="attribute_not_exists(modelAnswers) OR modelAnswers < :cap",
            names={"#ttl": "ttl", "#type": "type"},
            values={":ttl": int((now + CAP_TTL).timestamp()), ":one": 1, ":cap": cap, ":type": "help_cap"},
        )
    except db.ConditionFailed:
        return False
    except Exception as e:
        log("warning", "help.cap_failed", error=type(e).__name__)
        return False
    return True


def cap_full(store: db.Store, now: datetime, *, cap: int) -> bool:
    try:
        item = store.get(SWITCH_PK, cap_sk(now)) or {}
    except Exception:
        return False
    return cap <= 0 or int(item.get("modelAnswers") or 0) >= cap
