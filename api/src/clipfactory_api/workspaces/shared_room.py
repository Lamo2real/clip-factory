"""Sharing Clip Factory's developer app, protected (docs/CONTRACTS.md §45.37 G6; the owner: "Keep it, protect CF").

With the shared-app choice (``SOCIAL#{platform}.app.choice = "clips"``, YouTube, TikTok and X only) Lamo Stories uses
Clip Factory's OAuth client, so it shares that app's quotas. **Clip Factory's posts always come first; Lamo Stories
gets only what is left:**

* **Own counters** (a): Lamo Stories counts what it uses in its own items in its workspace partition,
  ``SHAREUSE#{platform}#{window}`` (``type = "ws_shareuse"``; ``posts``, ``units``, ``usd``, ``minuteKey`` /
  ``requestsThisMinute``, ``dayKey`` / ``dayPostIds``, ``blockedUntil``, ``version``, ``ttl``). It never writes
  Clip Factory's ``RATE#{platform}`` counters, its configuration or its X budget; it **reads** Clip Factory's
  ``RATE#{platform}`` (the story flow's read-only access to ``RATE#*``) and the ``autoPost`` attribute of Clip
  Factory's settings item (an attribute-limited GetItem, the separation test's one new allowed read) to work out the
  room left.
* **Clip Factory's share is reserved** (b): what Clip Factory needs for the window, its auto-posting schedule
  (``ceil(perRun * 24 / everyHours)`` posts a day while auto-posting is on, counted on every shared platform, TikTok
  too although auto-posting skips it) plus headroom for its manual posts (``HEADROOM_POSTS``). Lamo Stories may use
  only the rest:

  - **YouTube**, per Google quota day (midnight Pacific): ``videos.insert`` has its own bucket of 100 uploads a day
    per Google project (developers.google.com/youtube/v3/determine_quota_cost, checked 2026-11-22); Lamo Stories may
    upload ``100 - (auto + 10)`` a day. Its numbers reads use the 10,000-unit pool: Clip Factory keeps its own
    reserve (``reserveUnits``), at least ``CF_UNITS_SHARE`` units and always ``CF_UNITS_HEADROOM`` above what it has
    used today.
  - **X**, per month (UTC): the owner's one monthly X limit (Clip Factory's ``monthlyUsd``) minus what Clip Factory
    spent this month (its ``RATE#x`` ``monthUsd``) minus Clip Factory's reserve for the rest of the month (the days
    left, today included, times the larger of its average daily spend so far and its schedule's daily cost: auto +
    2 manual posts a day, each ``usdPerPost`` plus 4 reads); Lamo Stories' own posts and reads count against what
    is left. Its 15-minute request window: at most ``X_WINDOW_SHARE`` requests.
  - **TikTok**, the app's per-app limits: the app's requests per minute (``requestsPerMinute`` 600): Clip Factory
    keeps its ``useAtMost`` (300) plus ``TIKTOK_HEADROOM`` (100), so Lamo Stories makes at most 200 TikTok calls a
    minute; and the app's daily posting cap: when TikTok says the app's daily limit is reached, Lamo Stories stops
    posting there until the next UTC day.

  On every platform, while Clip Factory's own counter is blocked (``blockedUntil``: the platform throttled the app),
  Lamo Stories waits too.
* **No room: the post waits** (c): ``take`` answers ``Room(ok=False, until=…)``; the story flow writes
  ``waitUntil`` and the plain line ``waiting_line`` on the publishing job ("Waiting: Clip Factory's posts go first.
  Posts at …"), waits (no compute) until then and goes out by itself, never failing silently and never taking
  Clip Factory's share.

With Lamo Stories' own developer app nothing here applies (its own ``RATE#WS#{ws}#{platform}``, §45.30).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso, parse
from ..log import log
from ..stats import budget
from ..stats import config as stats_config
from . import types as ws

SHARED: Final = ws.SHARED_APP_PLATFORMS  # youtube, tiktok, x
SHAREUSE_SK: Final = ws.SHAREUSE_SK
TYPE: Final = ws.TYPE_SHAREUSE
CAS_ATTEMPTS: Final = 5
TTL: Final = timedelta(days=45)
# The reserve (b): headroom for Clip Factory's manual posts on top of its auto-posting schedule, per day.
HEADROOM_POSTS: Final = {"youtube": 10, "tiktok": 10, "x": 2}
YOUTUBE_UPLOADS_PER_DAY: Final = 100  # videos.insert's own daily bucket per Google project
CF_UNITS_SHARE: Final = 5000  # of the 10,000-unit pool for everything else: Clip Factory's stats reads
CF_UNITS_HEADROOM: Final = 1000
X_READS_PER_POST: Final = 4  # each post's numbers are read at 1 h, 24 h, 72 h and 7 days
X_WINDOW_SHARE: Final = 1000  # of X's 15-minute app window (3,500), next to Clip Factory's own useAtMost (1,000)
TIKTOK_HEADROOM: Final = 100  # TikTok calls a minute kept free for Clip Factory's own posting, above its useAtMost
DAILY_KINDS: Final = ("daily",)  # a platform's "daily limit reached": Lamo Stories stops for the rest of the window
RATE_KINDS: Final = ("rate",)
MONTHS: Final = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
WAITING: Final = "Waiting: Clip Factory's posts go first."


@dataclass(frozen=True)
class Room:
    """Whether Lamo Stories may use this much now; when not, ``until`` is when to look again (never in the past)."""

    platform: str
    ok: bool
    until: datetime | None = None
    reason: str = ""


@dataclass(frozen=True)
class Scope:
    store: db.Store
    user_id: str
    workspace_id: str

    @property
    def pk(self) -> str:
        return ws.workspace_pk(self.user_id, self.workspace_id)


def is_shared(choice: Any, platform: str) -> bool:
    return choice == "clips" and platform in SHARED


def at_utc(when: str) -> str:
    """``2026-11-23T08:00:00.000Z`` → "23 Nov 08:00 UTC" (the web shows ``waitUntil`` in the owner's own time)."""
    found = parse(when)
    if found is None:
        return when
    utc = found.astimezone(UTC)
    return f"{utc.day} {MONTHS[utc.month - 1]} {utc.strftime('%H:%M')} UTC"


def waiting_line(until: datetime) -> str:
    """The plain line on a waiting post and on the publish sheet (G6 c)."""
    return f"{WAITING} Posts at {at_utc(iso(until))}."


# --- windows -------------------------------------------------------------------------------------------------------


def window_key(platform: str, now: datetime) -> str:
    """YouTube: the Google quota day (Pacific); X: the UTC month; TikTok: the UTC day."""
    if platform == "youtube":
        return budget.youtube_day_key(now)
    if platform == "x":
        return now.astimezone(UTC).strftime("%Y-%m")
    return now.astimezone(UTC).date().isoformat()


def window_reset(platform: str, now: datetime) -> datetime:
    if platform == "youtube":
        return budget.youtube_next_reset(now)
    if platform == "x":
        return budget.next_month(now)
    return next_utc_day(now)


def next_utc_day(now: datetime) -> datetime:
    day = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return day + timedelta(days=1)


def share_sk(platform: str, key: str) -> str:
    return f"{SHAREUSE_SK}{platform}#{key}"


# --- Clip Factory's usage, read only ------------------------------------------------------------------------------

AUTO_POST_ATTRIBUTES: Final = ("pk", "sk", "autoPost")


def clips_usage(store: db.Store, platform: str) -> dict[str, Any]:
    """Clip Factory's ``RATE#{platform}`` counters (read only; Lamo Stories never writes them)."""
    return budget.get_budget(store, platform)


def clips_auto_per_day(store: db.Store, user_id: str) -> int:
    """Clip Factory's auto-posting schedule in posts a day per platform (§46.3), read only with an attribute-limited
    GetItem of its settings item (``pk, sk, autoPost``); 0 while auto-posting is off or unreadable."""
    names = {f"#a{i}": name for i, name in enumerate(AUTO_POST_ATTRIBUTES)}
    table: Any = store._table
    try:
        out = table.get_item(
            Key={"pk": db.user_pk(user_id), "sk": db.SETTINGS_SK},
            ConsistentRead=True,
            ProjectionExpression=", ".join(names),
            ExpressionAttributeNames=names,
        )
    except Exception as e:
        log("warning", "ws_share.clips_settings_unread", error=type(e).__name__)
        return AUTO_FALLBACK
    item = out.get("Item") if isinstance(out, Mapping) else None
    raw = db.from_dynamo(item).get("autoPost") if item else None
    if not isinstance(raw, Mapping) or raw.get("on") is not True:
        return 0
    every, per = raw.get("everyHours"), raw.get("perRun")
    if isinstance(every, bool) or isinstance(per, bool) or not isinstance(every, int) or not isinstance(per, int):
        return AUTO_FALLBACK
    if not 1 <= every <= 24 or not 1 <= per <= 5:
        return AUTO_FALLBACK
    return math.ceil(per * 24 / every)


# An unreadable setting reserves the most Clip Factory's auto-posting can ever send (5 clips every hour).
AUTO_FALLBACK: Final = 120


def clips_blocked(store: db.Store, platform: str, now: datetime) -> datetime | None:
    return budget.blocked_until(clips_usage(store, platform), now)


# --- what Lamo Stories may use ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Allowance:
    """Lamo Stories' share of one window: ``posts`` (YouTube uploads a day), ``units`` (YouTube read units a day),
    ``usd`` (X dollars this month), ``requests`` (TikTok calls a minute, X calls per 15 minutes)."""

    posts: int | None = None
    units: int | None = None
    usd: float | None = None
    requests: int | None = None


def allowance(
    store: db.Store, user_id: str, platform: str, now: datetime, cfg: stats_config.PlatformsConfig
) -> Allowance:
    auto = clips_auto_per_day(store, user_id)
    budget_cfg = cfg.platform(platform).budget
    used = clips_usage(store, platform)
    if platform == "youtube":
        day = budget.youtube_day_key(now)
        cf_units = int(used.get("unitsUsed") or 0) if used.get("dayKey") == day else 0
        cf_need = max(CF_UNITS_SHARE, cf_units + CF_UNITS_HEADROOM)
        units = int(budget_cfg["dailyUnits"]) - int(budget_cfg["reserveUnits"]) - cf_need
        posts = YOUTUBE_UPLOADS_PER_DAY - (auto + HEADROOM_POSTS["youtube"])
        return Allowance(posts=max(0, posts), units=max(0, units))
    if platform == "x":
        return Allowance(usd=max(0.0, x_allowance(used, auto, cfg, now)), requests=X_WINDOW_SHARE)
    share = int(budget_cfg["requestsPerMinute"]) - int(budget_cfg["useAtMost"]) - TIKTOK_HEADROOM
    return Allowance(requests=max(0, share))


def x_daily_need(auto: int, cfg: stats_config.PlatformsConfig) -> float:
    x = cfg.platform("x").budget
    per_post = float(x.get("usdPerPost") or 0) + X_READS_PER_POST * float(x.get("usdPerPostRead") or 0)
    return (auto + HEADROOM_POSTS["x"]) * per_post


def x_allowance(used: Mapping[str, Any], auto: int, cfg: stats_config.PlatformsConfig, now: datetime) -> float:
    """The dollars Lamo Stories may spend on X this month, all told (its own spend is counted against it)."""
    utc = now.astimezone(UTC)
    month = utc.strftime("%Y-%m")
    spent = float(used.get("monthUsd") or 0) if used.get("monthKey") == month else 0.0
    days_in_month = (budget.next_month(now) - utc.replace(day=1, hour=0, minute=0, second=0, microsecond=0)).days
    days_left = days_in_month - utc.day + 1  # today included
    average = spent / max(1, utc.day)
    reserve = days_left * max(average, x_daily_need(auto, cfg))
    return float(cfg.platform("x").budget["monthlyUsd"]) - spent - reserve


def x_next_room(
    used: Mapping[str, Any], auto: int, cfg: stats_config.PlatformsConfig, now: datetime, *, mine: float, need: float
) -> datetime:
    """The first UTC day of this month whose smaller reserve leaves room for ``need`` more dollars, else the next
    month (Clip Factory's spending so far counts as it is; its reserve shrinks as the days pass)."""
    day = next_utc_day(now)
    reset = budget.next_month(now)
    while day < reset:
        if x_allowance(used, auto, cfg, day) - mine + 1e-9 >= need:
            return day
        day += timedelta(days=1)
    return reset


# --- Lamo Stories' own counters (SHAREUSE#) -------------------------------------------------------------------


def _item(scope: Scope, platform: str, key: str) -> dict[str, Any]:
    found = scope.store.get(scope.pk, share_sk(platform, key))
    if found and (found.get("userId") != scope.user_id or found.get("workspaceId") != scope.workspace_id):
        raise ValueError("a share counter of another workspace")
    return found or {}


def _write(
    scope: Scope, platform: str, key: str, item: Mapping[str, Any], fields: Mapping[str, Any], *, now: datetime
) -> None:
    version = int(item.get("version") or 0)
    sets: dict[str, Any] = {
        "type": TYPE,
        "userId": scope.user_id,
        "workspaceId": scope.workspace_id,
        "platform": platform,
        "window": key,
        "updatedAt": iso(now),
        "ttl": int((now + TTL).timestamp()),
        "version": version + 1,
        **fields,
    }
    names = {f"#f{i}": k for i, k in enumerate(sets)}
    values: dict[str, Any] = {f":f{i}": v for i, v in enumerate(sets.values())}
    update = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(sets)))
    names["#ver"] = "version"
    if item:
        condition = "#ver = :expected"
        values[":expected"] = version
    else:
        condition = "attribute_not_exists(pk)"
        names.pop("#ver")
    scope.store.update_expr(scope.pk, share_sk(platform, key), update, condition=condition, names=names, values=values)


def used(scope: Scope, platform: str, now: datetime) -> dict[str, Any]:
    """Lamo Stories' own counters of the current window (empty when it used nothing yet)."""
    return _item(scope, platform, window_key(platform, now))


def take(
    scope: Scope,
    platform: str,
    now: datetime,
    *,
    cfg: stats_config.PlatformsConfig,
    posts: int = 0,
    units: int = 0,
    usd: float = 0.0,
    requests: int = 0,
    read_ids: Iterable[str] = (),
) -> Room:
    """Counts what Lamo Stories is about to use (compare-and-swap on its own counter's ``version``) when it fits in
    its share; ``Room(ok=False, until=…)`` otherwise, and nothing is counted. X reads (``read_ids``) cost
    ``usdPerPostRead`` once per post a UTC day, as Clip Factory's own reads do."""
    if platform not in SHARED:
        return Room(platform, True)
    key = window_key(platform, now)
    for _ in range(CAS_ATTEMPTS):
        blocked = clips_blocked(scope.store, platform, now)
        if blocked is not None:
            return Room(platform, False, blocked, "clips_blocked")
        item = _item(scope, platform, key)
        own_block = budget.blocked_until(item, now)
        if own_block is not None:
            return Room(platform, False, own_block, str(item.get("blockedReason") or "blocked"))
        share = allowance(scope.store, scope.user_id, platform, now, cfg)
        fields: dict[str, Any] = {}
        if posts:
            have = int(item.get("posts") or 0)
            if share.posts is not None and have + posts > share.posts:
                return Room(platform, False, window_reset(platform, now), "posts")
            fields["posts"] = have + posts
        if units:
            have = int(item.get("units") or 0)
            if share.units is not None and have + units > share.units:
                return Room(platform, False, window_reset(platform, now), "units")
            fields["units"] = have + units
        if platform == "x" and (usd or read_ids):
            day = now.astimezone(UTC).date().isoformat()
            seen = set(item.get("dayPostIds") or []) if item.get("dayKey") == day else set()
            fresh = {str(i) for i in read_ids} - seen
            price = float(cfg.platform("x").budget.get("usdPerPostRead") or 0) * len(fresh)
            charge = usd + price
            mine = float(item.get("usd") or 0)
            if share.usd is not None and mine + charge > share.usd + 1e-9:
                auto = clips_auto_per_day(scope.store, scope.user_id)
                until = x_next_room(clips_usage(scope.store, "x"), auto, cfg, now, mine=mine, need=charge)
                return Room(platform, False, until, "usd")
            fields["usd"] = round(mine + charge, 6)
            if seen | fresh:
                fields["dayKey"] = day
                fields["dayPostIds"] = seen | fresh
        if requests:
            if platform == "x":
                window = budget.minute_key(budget.x_window_start(now))
                ends = budget.x_window_start(now) + timedelta(minutes=budget.X_WINDOW_MINUTES)
            else:
                window = budget.minute_key(now)
                ends = now.astimezone(UTC).replace(second=0, microsecond=0) + timedelta(minutes=1)
            have = int(item.get("requestsThisMinute") or 0) if item.get("minuteKey") == window else 0
            if share.requests is not None and have + requests > share.requests:
                return Room(platform, False, ends, "requests")
            fields["minuteKey"] = window
            fields["requestsThisMinute"] = have + requests
        if not fields:
            return Room(platform, True)
        try:
            _write(scope, platform, key, item, fields, now=now)
        except db.ConditionFailed:
            continue  # another Lamo Stories step counted meanwhile: read again
        return Room(platform, True)
    log("warning", "ws_share.contended", platform=platform)
    return Room(platform, False, now + timedelta(minutes=1), "busy")


def room(scope: Scope, platform: str, now: datetime, *, cfg: stats_config.PlatformsConfig, posts: int = 1) -> Room:
    """Whether a post fits now, without counting it (the flow's early look; ``take`` counts at the platform call)."""
    if platform not in SHARED:
        return Room(platform, True)
    blocked = clips_blocked(scope.store, platform, now)
    if blocked is not None:
        return Room(platform, False, blocked, "clips_blocked")
    item = used(scope, platform, now)
    own_block = budget.blocked_until(item, now)
    if own_block is not None:
        return Room(platform, False, own_block, str(item.get("blockedReason") or "blocked"))
    share = allowance(scope.store, scope.user_id, platform, now, cfg)
    if platform == "youtube" and share.posts is not None and int(item.get("posts") or 0) + posts > share.posts:
        return Room(platform, False, window_reset(platform, now), "posts")
    if platform == "x":
        price = float(cfg.platform("x").budget.get("usdPerPost") or 0) * posts
        mine = float(item.get("usd") or 0)
        if share.usd is not None and mine + price > share.usd + 1e-9:
            auto = clips_auto_per_day(scope.store, scope.user_id)
            return Room(
                platform,
                False,
                x_next_room(clips_usage(scope.store, "x"), auto, cfg, now, mine=mine, need=price),
                "usd",
            )
    return Room(platform, True)


def block(scope: Scope, platform: str, until: datetime, reason: str, now: datetime) -> None:
    """Stops Lamo Stories (only) on this platform until ``until``: the platform said the app is throttled or its
    daily limit is reached. Clip Factory's counters are never written."""
    key = window_key(platform, now)
    for _ in range(CAS_ATTEMPTS):
        item = _item(scope, platform, key)
        try:
            _write(scope, platform, key, item, {"blockedUntil": iso(until), "blockedReason": reason}, now=now)
        except db.ConditionFailed:
            continue
        log("warning", "ws_share.blocked", platform=platform, reason=reason, until=iso(until))
        return


def block_after(platform: str, kind: str, now: datetime) -> datetime | None:
    """How long Lamo Stories stops after the platform's own refusal on the shared app: a daily limit until the
    window resets, a slow-down for a minute; None for anything else."""
    if kind in DAILY_KINDS:
        return budget.youtube_next_reset(now) if platform == "youtube" else next_utc_day(now)
    if kind in RATE_KINDS:
        return now + timedelta(minutes=1)
    return None
