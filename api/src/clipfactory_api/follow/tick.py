"""``cf-prod-follow-tick``: every 5 minutes, the source of truth for Follow creators (docs/CONTRACTS.md §24.3).

One run, in order, inside a time budget:

1. Takes the run lease (``FOLLOWTICK``/``LEASE``, a conditional write), so two runs never overlap. (No reserved
   concurrency: new accounts' limits forbid it, see infra/modules/stats.)
2. Lists every follow with one Query on ``FOLLOWED`` and every creator with one Query on ``CREATOR``.
3. Twitch and Kick (only when their keys are saved): fills in names, pictures and numeric ids (every 7 days, or
   at once for a creator followed before the keys), refreshes live badges in batches (Twitch 100, Kick 50 per call),
   subscribes webhooks for creators someone follows and unsubscribes creators nobody follows any more (once per
   creator, never per follower), and once an hour repairs revoked or failed subscriptions.
4. YouTube: reads each creator's public feed (no quota). A video published after the follow is noticed. With the
   optional read key, the newest videos are checked for a live stream (at most 1,000 units a day, counted in
   ``FOLLOWMETER``).

A live → offline change and a new upload are written as ``WATCH`` items (``autoMaking: false``). This part never
starts a job: making clips by itself is part 2. Every write is conditional or idempotent, and the EventBridge
target never retries, so a failed run is simply followed by the next one.
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from . import (
    CREATOR_PK,
    FOLLOWED_PK,
    TICK_PK,
    TICK_SK,
    creator_keys,
    creator_sk,
    follow_sk,
    plain,
    round_viewers,
    safe_avatar,
)
from . import platforms as pf
from .model import _upsert_creator, apply_live, kick_live, notice, twitch_live

Item = dict[str, Any]

LEASE = timedelta(seconds=150)
REFRESH_EVERY = timedelta(days=7)
REPAIR_EVERY = timedelta(hours=1)
YOUTUBE_DAILY_UNITS = 1000
YOUTUBE_LIVE_CANDIDATES = 5
DEFAULT_BUDGET_SECONDS = 90


@dataclass
class TickDeps:
    store: db.Store
    env: pf.FollowEnv
    clock: Clock = field(default=utcnow)
    budget_seconds: float = DEFAULT_BUDGET_SECONDS
    monotonic: Callable[[], float] = time.monotonic
    started: float | None = None

    def out_of_time(self) -> bool:
        """True once this run has used its budget: checked inside every per-creator loop, so a slow platform never
        pushes a run past the Lambda timeout (which would skip releasing the lease)."""
        return self.started is not None and self.monotonic() - self.started > self.budget_seconds


@dataclass
class Creator:
    platform: str
    platform_id: str
    users: list[str]
    item: Item

    @property
    def sk(self) -> str:
        return creator_sk(self.platform, self.platform_id)


def run(deps: TickDeps) -> dict[str, Any]:
    now = deps.clock()
    deps.started = deps.monotonic()
    lease = _take_lease(deps.store, now)
    if lease is None:
        log("info", "follow_tick.busy")
        return {"ran": False}
    out: dict[str, Any] = {"ran": True}
    try:
        creators = _creators(deps.store)
        repair = (parse(lease.get("repairAt")) or datetime.min.replace(tzinfo=now.tzinfo)) + REPAIR_EVERY <= now
        out["creators"] = len(creators)
        for platform, step in (("twitch", _twitch), ("kick", _kick), ("youtube", _youtube)):
            if deps.out_of_time():
                log("warning", "follow_tick.out_of_time", platform=platform)
                break
            mine = [c for c in creators if c.platform == platform]
            if not mine:
                continue
            try:
                out[platform] = step(deps, mine, now, repair=repair)
            except pf.KeysNeededError:
                out[platform] = "no_keys"
            except pf.KeysRejectedError as e:
                pf.log_platform_error("follow_tick.keys_rejected", platform, e)
                out[platform] = "keys_rejected"
            except pf.PlatformDownError as e:
                pf.log_platform_error("follow_tick.platform_down", platform, e)
                out[platform] = "down"
        if repair:
            deps.store.update(TICK_PK, TICK_SK, {"repairAt": iso(now)})
    finally:
        with contextlib.suppress(db.ConditionFailed):
            deps.store.update(TICK_PK, TICK_SK, {"until": iso(now)})  # the next run may start at once
    log("info", "follow_tick.done", **{k: v for k, v in out.items() if isinstance(v, str | int | bool)})
    return out


def _take_lease(store: db.Store, now: datetime) -> Item | None:
    try:
        return store.update_expr(
            TICK_PK,
            TICK_SK,
            "SET #u = :until, #t = :type",
            condition="attribute_not_exists(pk) OR #u < :now",
            names={"#u": "until", "#t": "type"},
            values={":until": iso(now + LEASE), ":now": iso(now), ":type": "lease"},
        )
    except db.ConditionFailed:
        return None


def _creators(store: db.Store) -> list[Creator]:
    """Every followed creator with its followers, plus creators nobody follows any more (to unsubscribe them)."""
    users: dict[tuple[str, str], list[str]] = {}
    for row in store.query_all(FOLLOWED_PK, ""):
        platform, platform_id = str(row.get("platform") or ""), str(row.get("platformId") or "")
        if platform and platform_id and row.get("userId"):
            users.setdefault((platform, platform_id), []).append(str(row["userId"]))
    items = {(str(i.get("platform")), str(i.get("platformId"))): i for i in store.query_all(CREATOR_PK, "")}
    keys = list(users) + [k for k in items if k not in users]
    return [Creator(p, i, users.get((p, i), []), items.get((p, i), {})) for p, i in keys]


def _due_refresh(creator: Creator, now: datetime) -> bool:
    refreshed = parse(creator.item.get("refreshedAt"))
    return not creator.item.get("broadcasterId") or refreshed is None or refreshed + REFRESH_EVERY <= now


def _set_profile(deps: TickDeps, creator: Creator, profile: Item, now: datetime) -> None:
    """Copies a fresh name, picture and handle to the creator and each follower's FOLLOW item."""
    fields = {**profile, "refreshedAt": iso(now)}
    _upsert_creator(deps.store, creator.platform, creator.platform_id, fields)
    creator.item.update(fields)
    follow_fields: Item = {
        "name": profile.get("name") or creator.platform_id,
        "avatarUrl": profile.get("avatarUrl") or None,
        "handle": profile.get("handle") or creator.platform_id,
        "resolved": True,
        "refreshedAt": iso(now),
        "creatorKeys": creator_keys(
            creator.platform, creator.platform_id, str(profile.get("handle") or ""), str(profile.get("name") or "")
        ),
    }
    for user_id in creator.users:
        try:
            deps.store.update(
                db.user_pk(user_id),
                follow_sk(creator.platform, creator.platform_id),
                {k: v for k, v in follow_fields.items() if v is not None},
            )
        except db.ConditionFailed:
            continue


# --- subscriptions (once per creator) -------------------------------------------------------------------------------------


def _sync_subs(
    deps: TickDeps,
    creator: Creator,
    now: datetime,
    subscribe: Callable[[str, dict[str, str]], Iterator[tuple[str, str]]],
    unsubscribe: Callable[[str], None],
) -> str:
    """Subscribes a followed creator, unsubscribes one nobody follows, and re-subscribes after a revocation."""
    item = creator.item
    subs: dict[str, str] = dict(item.get("subs") or {})
    broadcaster = str(item.get("broadcasterId") or "")
    if not creator.users:
        if not subs and not item.get("wanted"):
            return "none"
        for sub_id in subs.values():
            if sub_id:
                unsubscribe(sub_id)
        _upsert_creator(
            deps.store,
            creator.platform,
            creator.platform_id,
            {"subs": {}, "wanted": False, "subsStatus": "none", "subsCheckedAt": iso(now)},
        )
        log("info", "follow_tick.unsubscribed", platform=creator.platform)
        return "unsubscribed"
    if not broadcaster:
        return "waiting"
    if subs and item.get("subsStatus") == "ok":
        return "ok"
    made: dict[str, str] = {}
    for name, sub_id in subscribe(broadcaster, subs):
        # Saved as soon as each one exists: a failure on the next one never loses this id (it would leak).
        made[name] = sub_id
        _upsert_creator(
            deps.store,
            creator.platform,
            creator.platform_id,
            {"subs": {**subs, **made}, "wanted": True, "subsStatus": "partial", "subsCheckedAt": iso(now)},
        )
    item["subs"] = {**subs, **made}
    _upsert_creator(deps.store, creator.platform, creator.platform_id, {"subsStatus": "ok"})
    item["subsStatus"] = "ok"
    log("info", "follow_tick.subscribed", platform=creator.platform)
    return "subscribed"


def _repair(deps: TickDeps, creators: list[Creator], live_ids: set[str], now: datetime) -> None:
    """Marks creators whose subscription is gone or not enabled, so ``_sync_subs`` makes it again."""
    for creator in creators:
        subs = creator.item.get("subs") or {}
        if creator.users and subs and any(not v or v not in live_ids for v in subs.values()):
            _upsert_creator(
                deps.store, creator.platform, creator.platform_id, {"subsStatus": "repair", "subsCheckedAt": iso(now)}
            )
            creator.item["subsStatus"] = "repair"


def _drop_orphans(
    creators: list[Creator], subscriptions: list[tuple[str, str]], unsubscribe: Callable[[str], None]
) -> int:
    """Removes the app's subscriptions for broadcasters nobody follows (ones whose id was never saved)."""
    wanted = {str(c.item.get("broadcasterId") or "") for c in creators if c.users}
    known = {v for c in creators if c.users for v in (c.item.get("subs") or {}).values() if v}
    dropped = 0
    for sub_id, broadcaster in subscriptions:
        if sub_id and broadcaster and broadcaster not in wanted and sub_id not in known:
            unsubscribe(sub_id)
            dropped += 1
    if dropped:
        log("info", "follow_tick.orphans_removed", count=dropped)
    return dropped


# --- Twitch -------------------------------------------------------------------------------------------------------------------


def _twitch(deps: TickDeps, creators: list[Creator], now: datetime, *, repair: bool) -> str:
    env = deps.env
    env.token("twitch")  # KeysNeededError when no keys: nothing to do yet
    followed = [c for c in creators if c.users]
    stale = [c for c in followed if _due_refresh(c, now)]
    if stale:
        users = pf.twitch_users(env, [c.platform_id for c in stale])
        for c in stale:
            user = users.get(c.platform_id)
            if user:
                _set_profile(
                    deps,
                    c,
                    {
                        "broadcasterId": str(user.get("id") or ""),
                        "name": plain(user.get("display_name")) or c.platform_id,
                        "handle": str(user.get("login") or c.platform_id).lower(),
                        "avatarUrl": safe_avatar(user.get("profile_image_url")),
                    },
                    now,
                )
    streams = pf.twitch_streams(env, [c.platform_id for c in followed])
    for c in followed:
        if c.item.get("broadcasterId") or c.platform_id in streams:
            apply_live(
                deps.store, "twitch", c.platform_id, twitch_live(streams.get(c.platform_id), now), now, source="tick"
            )

    def unsubscribe(sub_id: str) -> None:
        pf.twitch_unsubscribe(env, sub_id)

    if repair:
        mine = pf.twitch_stream_subscriptions(env)
        enabled = {str(s.get("id")) for s in mine if s.get("status") == "enabled"}
        _repair(deps, creators, enabled, now)
        _drop_orphans(
            creators,
            [(str(s.get("id") or ""), pf.twitch_broadcaster(s)) for s in mine],
            unsubscribe,
        )

    def subscribe(broadcaster: str, have: dict[str, str]) -> Iterator[tuple[str, str]]:
        for name, kind in (("online", "stream.online"), ("offline", "stream.offline")):
            yield name, pf.twitch_subscribe(env, broadcaster, kind)

    for c in creators:
        if deps.out_of_time():
            return "partial"
        _sync_subs(deps, c, now, subscribe, unsubscribe)
    return "ok"


# --- Kick -----------------------------------------------------------------------------------------------------------------------


def _kick(deps: TickDeps, creators: list[Creator], now: datetime, *, repair: bool) -> str:
    env = deps.env
    env.token("kick")
    followed = [c for c in creators if c.users]
    channels = pf.kick_channels(env, [c.platform_id for c in followed])
    stale = [c for c in followed if _due_refresh(c, now) and c.platform_id in channels]
    if stale:
        ids = [str(channels[c.platform_id].get("broadcaster_user_id") or "") for c in stale]
        users = pf.kick_users(env, [i for i in ids if i])
        for c, broadcaster in zip(stale, ids, strict=True):
            user = users.get(broadcaster, {})
            _set_profile(
                deps,
                c,
                {
                    "broadcasterId": broadcaster,
                    "name": plain(user.get("name")) or c.platform_id,
                    "handle": c.platform_id,
                    "avatarUrl": safe_avatar(user.get("profile_picture")),
                },
                now,
            )
    for c in followed:
        if c.platform_id in channels:
            channel = channels[c.platform_id]
            apply_live(
                deps.store,
                "kick",
                c.platform_id,
                kick_live(channel, now),
                now,
                source="tick",
                broadcaster_id=str(channel.get("broadcaster_user_id") or ""),
            )

    def unsubscribe(sub_id: str) -> None:
        pf.kick_unsubscribe(env, sub_id)

    if repair:
        mine = pf.kick_status_subscriptions(env)
        enabled = {pf.kick_subscription_id(s) for s in mine}
        _repair(deps, creators, enabled, now)
        _drop_orphans(
            creators,
            [(pf.kick_subscription_id(s), str(s.get("broadcaster_user_id") or "")) for s in mine],
            unsubscribe,
        )

    def subscribe(broadcaster: str, have: dict[str, str]) -> Iterator[tuple[str, str]]:
        yield "status", pf.kick_subscribe(env, broadcaster)

    for c in creators:
        if deps.out_of_time():
            return "partial"
        _sync_subs(deps, c, now, subscribe, unsubscribe)
    return "ok"


# --- YouTube -------------------------------------------------------------------------------------------------------------------


def _youtube(deps: TickDeps, creators: list[Creator], now: datetime, *, repair: bool) -> str:
    env = deps.env
    followed = [c for c in creators if c.users]
    newest: dict[str, list[Item]] = {}
    feeds: dict[str, list[Item]] = {}
    for c in followed:
        if deps.out_of_time():
            log("warning", "follow_tick.out_of_time", platform="youtube")
            break
        try:
            name, entries = pf.youtube_feed(env, c.platform_id)
        except (pf.PlatformDownError, pf.NotFoundError) as e:
            pf.log_platform_error("follow_tick.feed_failed", "youtube", e)
            continue
        newest[c.platform_id] = entries[:YOUTUBE_LIVE_CANDIDATES]
        if name and (_due_refresh(c, now) or not c.item.get("name")):
            info = None
            try:
                info = pf.youtube_channel(env, c.platform_id)
            except (pf.PlatformDownError, pf.KeysRejectedError) as e:
                pf.log_platform_error("follow_tick.channel_failed", "youtube", e)
            handle = str((info or {}).get("handle") or c.item.get("handle") or "")
            _set_profile(
                deps,
                c,
                {
                    "broadcasterId": c.platform_id,
                    "name": plain((info or {}).get("title") or name),
                    "handle": handle if handle.startswith("@") else "",
                    "avatarUrl": safe_avatar((info or {}).get("avatar")),
                },
                now,
            )
        feeds[c.platform_id] = entries
    content: dict[str, str] = {}
    if env.keys("youtube-read") is not None and not deps.out_of_time():
        content = _youtube_live(deps, followed, newest, now)
    for c in followed:
        if c.platform_id in feeds:
            _notice_uploads(deps, c, feeds[c.platform_id], now, content=content)
    return "ok"


def _notice_uploads(
    deps: TickDeps, creator: Creator, entries: list[Item], now: datetime, *, content: dict[str, str] | None = None
) -> None:
    """Notices new videos. A video YouTube says is live or upcoming is skipped (it is not a finished upload): when the
    stream ends, ``apply_live`` notices it as a finished stream. Without the read key this cannot be known, and the
    stream notice later moves such an "upload" item on to "stream" (``model.notice``)."""
    content = content or {}
    seen = parse(creator.item.get("feedNewest"))
    newest = seen
    for entry in entries:
        published = parse(entry.get("published"))
        if published is None or (seen is not None and published <= seen):
            continue
        state = content.get(str(entry.get("videoId") or ""), "")
        if state in {"live", "upcoming"}:
            continue  # not finished; feedNewest stays before it unless a newer video passes it
        newest = published if newest is None or published > newest else newest
        for user_id in creator.users:
            follow = deps.store.get(db.user_pk(user_id), follow_sk("youtube", creator.platform_id)) or {}
            followed_at = parse(follow.get("followedAt"))
            if followed_at is None or published <= followed_at:
                continue  # never the backlog from before the follow
            if notice(
                deps.store,
                user_id,
                "youtube",
                creator.platform_id,
                vkey=str(entry["videoId"]),
                now=now,
                kind="upload",
                published_at=str(entry.get("published") or ""),
                title=str(entry.get("title") or ""),
                live_content=state,
            ):
                try:
                    deps.store.update(
                        db.user_pk(user_id),
                        follow_sk("youtube", creator.platform_id),
                        {
                            "last": {
                                "state": "noticed",
                                "text": "New video",
                                "at": iso(now),
                                "videoKey": str(entry["videoId"]),
                            }
                        },
                    )
                except db.ConditionFailed:
                    continue
    if newest is not None and newest != seen:
        _upsert_creator(deps.store, "youtube", creator.platform_id, {"feedNewest": iso(newest)})
        creator.item["feedNewest"] = iso(newest)


def _youtube_live(
    deps: TickDeps, creators: list[Creator], newest: dict[str, list[Item]], now: datetime
) -> dict[str, str]:
    """Sets YouTube live badges; returns video id → ``liveBroadcastContent`` (``live``, ``upcoming`` or ``none``).

    Never marks a creator offline on missing data: a creator whose feed failed, or whose videos did not come back,
    keeps the badge it had."""
    ids = [str(e["videoId"]) for c in creators for e in newest.get(c.platform_id, [])]
    if not ids:
        return {}
    needed = (len(set(ids)) + pf.YOUTUBE_BATCH - 1) // pf.YOUTUBE_BATCH
    if not _spend_units(deps.store, now, needed):
        log("info", "follow_tick.youtube_paused")
        return {}
    videos, _units = pf.youtube_videos(deps.env, ids)
    content = {
        vid: str((video.get("snippet") or {}).get("liveBroadcastContent") or "") for vid, video in videos.items()
    }
    for c in creators:
        candidates = newest.get(c.platform_id)
        if candidates is None:
            continue  # the feed failed this run
        wanted = {str(e["videoId"]) for e in candidates}
        current = str((c.item.get("live") or {}).get("streamId") or "")
        if not wanted & videos.keys() or (current in wanted and current not in videos):
            continue  # missing data: never a reason to call a stream finished
        live: Item = {"isLive": False, "checkedAt": iso(now)}
        for entry in candidates:
            video = videos.get(str(entry["videoId"])) or {}
            snippet = video.get("snippet") or {}
            details = video.get("liveStreamingDetails") or {}
            if snippet.get("liveBroadcastContent") == "live":
                live = {
                    "isLive": True,
                    "title": plain(snippet.get("title")),
                    "viewers": round_viewers(_number(details.get("concurrentViewers"))),
                    "startedAt": str(details.get("actualStartTime") or "") or None,
                    "streamId": str(video.get("id") or ""),
                    "checkedAt": iso(now),
                }
                break
        apply_live(deps.store, "youtube", c.platform_id, live, now, source="tick")
    return content


def _number(value: Any) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _spend_units(store: db.Store, now: datetime, units: int) -> bool:
    """Counts YouTube units used by follows today (UTC); False once 1,000 would be passed."""
    day = now.strftime("%Y-%m-%d")
    try:
        store.update_expr(
            "FOLLOWMETER",
            f"YT#{day}",
            "SET #t = :type, #ttl = :ttl ADD #u :n",
            condition="attribute_not_exists(#u) OR #u <= :max",
            names={"#t": "type", "#ttl": "ttl", "#u": "units"},
            values={
                ":type": "meter",
                ":ttl": int((now + timedelta(days=3)).timestamp()),
                ":n": units,
                ":max": YOUTUBE_DAILY_UNITS - units,
            },
        )
    except db.ConditionFailed:
        return False
    return True


# --- Lambda ------------------------------------------------------------------------------------------------------------------------

_deps: TickDeps | None = None


def _from_env() -> TickDeps:
    import boto3
    from botocore.config import Config

    from ..app import region, table
    from ..oauth.secrets import PREFIX, Secrets

    env = os.environ
    sm = boto3.client(
        "secretsmanager", region_name=region(), config=Config(retries={"mode": "standard"}, read_timeout=5)
    )
    return TickDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        env=pf.FollowEnv(secrets=Secrets(sm, env.get("SECRET_PREFIX") or PREFIX), hooks_url=env.get("HOOKS_URL", "")),
        budget_seconds=float(env.get("FOLLOW_TIME_BUDGET_SECONDS") or DEFAULT_BUDGET_SECONDS),
    )


def get_deps(factory: Callable[[], TickDeps] = _from_env) -> TickDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(_event: Any = None, _context: Any = None) -> dict[str, Any]:
    return run(get_deps())
