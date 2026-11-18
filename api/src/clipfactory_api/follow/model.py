"""Following, unfollowing and the live state (docs/CONTRACTS.md §24.1, §24.2, §24.3).

Writes here are small and conditional. Nothing is ever deleted except the owner's own FOLLOW and FOLLOWED items on
"Remove": the creator item, noticed streams (WATCH) and every job stay.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found
from ..log import log
from . import (
    CREATOR_PK,
    FOLLOWED_PK,
    LABELS,
    MAX_FOLLOWS,
    WATCH_PK,
    WATCH_TTL,
    all_follows,
    channel_url,
    creator_keys,
    creator_sk,
    follow_id,
    follow_sk,
    followed_sk,
    followers,
    is_platform_id,
    plain,
    public_follow,
    round_viewers,
    safe_avatar,
    ttl,
    watch_sk,
)
from . import platforms as pf
from .parse import Wanted

Item = dict[str, Any]

NOT_FOUND = "We could not find that streamer. Check the name or paste their link."
DOWN = "{label} did not answer. Try again in a minute."
KEYS_REJECTED = "The {label} keys stopped working. Ask a grown-up to check them."


# --- looking a creator up ----------------------------------------------------------------------------------------------


def lookup(env: pf.FollowEnv, wanted: Wanted) -> Item:
    """``{platform, platformId, handle, name, avatarUrl, url, live, resolved, needsKeys}`` for what was typed.

    Twitch and Kick work without keys too: the creator is found by their name alone (``resolved: false``,
    ``needsKeys: true``) and filled in once a grown-up pastes the keys."""
    label = LABELS.get(wanted.platform, "That site")
    try:
        if wanted.platform == "youtube":
            return _youtube(env, wanted)
        if wanted.platform == "twitch":
            return _twitch(env, wanted.value)
        if wanted.platform == "kick":
            return _kick(env, wanted.value)
    except pf.NotFoundError:
        raise not_found(NOT_FOUND) from None
    except pf.KeysRejectedError:
        raise conflict(KEYS_REJECTED.format(label=label)) from None
    except pf.PlatformDownError as e:
        pf.log_platform_error("follow.lookup_failed", wanted.platform, e)
        raise ApiError(503, "platform_down", DOWN.format(label=label)) from None
    raise bad_request("Pick YouTube, Twitch or Kick.", "platform")


def _found(
    platform: str,
    platform_id: str,
    handle: str,
    name: str,
    avatar: str,
    *,
    resolved: bool,
    live: Item | None = None,
    needs_keys: bool = False,
) -> Item:
    out: Item = {
        "platform": platform,
        "platformId": platform_id,
        "handle": handle,
        "name": plain(name) or handle or platform_id,
        "avatarUrl": safe_avatar(avatar),
        "url": channel_url(platform, platform_id, handle),
        "resolved": resolved,
        "needsKeys": needs_keys,
    }
    if live is not None:
        out["live"] = live
    return out


def _youtube(env: pf.FollowEnv, wanted: Wanted) -> Item:
    channel_id = ""
    handle = ""
    name = ""
    avatar = ""
    target = wanted.value
    if wanted.kind == "video":
        target = pf.youtube_channel_of_video(env, wanted.value)
    if target.startswith("@"):
        handle = target
        info = pf.youtube_channel_of_handle(env, target)
        channel_id, name, avatar = (
            str(info.get("id") or ""),
            str(info.get("title") or ""),
            str(info.get("avatar") or ""),
        )
    else:
        channel_id = target
    if not is_platform_id("youtube", channel_id):
        raise pf.NotFoundError(target)
    channel = pf.youtube_channel(env, channel_id)
    if channel:
        name = name or str(channel.get("title") or "")
        avatar = avatar or str(channel.get("avatar") or "")
        custom = str(channel.get("handle") or "")
        handle = handle or (custom if custom.startswith("@") else "")
    if not name:
        name, _entries = pf.youtube_feed(env, channel_id)
    return _found("youtube", channel_id, handle, name, avatar, resolved=True)


def _twitch(env: pf.FollowEnv, login: str) -> Item:
    if env.keys("twitch") is None:
        return _found("twitch", login, login, login, "", resolved=False, needs_keys=True)
    users = pf.twitch_users(env, [login])
    user = users.get(login)
    if not user:
        raise pf.NotFoundError(login)
    streams = pf.twitch_streams(env, [login])
    return _found(
        "twitch",
        login,
        str(user.get("login") or login).lower(),
        str(user.get("display_name") or login),
        str(user.get("profile_image_url") or ""),
        resolved=True,
        live=twitch_live(streams.get(login), env.clock()),
    )


def _kick(env: pf.FollowEnv, slug: str) -> Item:
    if env.keys("kick") is None:
        return _found("kick", slug, slug, slug, "", resolved=False, needs_keys=True)
    channel = pf.kick_channels(env, [slug]).get(slug)
    if not channel:
        raise pf.NotFoundError(slug)
    broadcaster = str(channel.get("broadcaster_user_id") or "")
    user: Item = (pf.kick_users(env, [broadcaster]).get(broadcaster) or {}) if broadcaster else {}
    return _found(
        "kick",
        slug,
        slug,
        str(user.get("name") or slug),
        str(user.get("profile_picture") or ""),
        resolved=True,
        live=kick_live(channel, env.clock()),
    )


# --- live states ---------------------------------------------------------------------------------------------------------


def twitch_live(stream: Mapping[str, Any] | None, now: datetime) -> Item:
    if not stream:
        return {"isLive": False, "checkedAt": iso(now)}
    return {
        "isLive": True,
        "title": plain(stream.get("title")),
        "viewers": round_viewers(stream.get("viewer_count")),
        "startedAt": str(stream.get("started_at") or "") or None,
        "streamId": str(stream.get("id") or "") or None,
        "checkedAt": iso(now),
    }


def kick_live(channel: Mapping[str, Any] | None, now: datetime) -> Item:
    stream = channel.get("stream") if isinstance(channel, Mapping) else None
    if not isinstance(stream, Mapping) or not stream.get("is_live"):
        return {"isLive": False, "checkedAt": iso(now)}
    return {
        "isLive": True,
        "title": plain(channel.get("stream_title") if isinstance(channel, Mapping) else ""),
        "viewers": round_viewers(stream.get("viewer_count")),
        "startedAt": str(stream.get("start_time") or "") or None,
        "checkedAt": iso(now),
    }


def same_live(a: Mapping[str, Any] | None, b: Mapping[str, Any] | None) -> bool:
    """Only a change people can see counts: live or not, the title and the rounded viewers (never checkedAt)."""
    a, b = a or {}, b or {}
    return all(a.get(k) == b.get(k) for k in ("isLive", "title", "viewers")) and bool(a) == bool(b)


def video_key(platform: str, before: Mapping[str, Any], ended_at: datetime) -> str:
    """The WATCH key of a finished stream: Twitch ``stream:{id}``, YouTube the video id, Kick
    ``{broadcaster id}:{start to the minute}`` (rounded, so the webhook and the poll agree)."""
    if platform == "twitch" and before.get("streamId"):
        return f"stream:{before['streamId']}"
    if platform == "youtube" and before.get("streamId"):
        return str(before["streamId"])  # the live video's id
    started = parse(before.get("startedAt"))
    minute = (started or ended_at).strftime("%Y%m%dT%H%M")
    owner = str(before.get("broadcasterId") or "")
    return f"{owner}:{minute}" if owner else f"ended:{minute}"


def apply_live(
    store: db.Store,
    platform: str,
    platform_id: str,
    live: Item,
    now: datetime,
    *,
    source: str,
    broadcaster_id: str = "",
) -> bool:
    """Sets a creator's live state and copies it to every follower's FOLLOW item, only when something visible changed.

    A live → offline change notices the finished stream: a WATCH item per follower (state ``waiting``, never made
    into clips in this part) and ``last`` on the follow ("Stream ended"). Returns True when anything was written."""
    key = (CREATOR_PK, creator_sk(platform, platform_id))
    creator = store.get(*key) or {}
    before = creator.get("live") or {}
    if before.get("isLive") and live.get("isLive"):
        # What one source does not know, the other already told us (the webhook has no title, Kick's poll no id).
        live = {
            **live,
            **{
                k: before[k]
                for k in ("streamId", "title", "viewers", "startedAt")
                if live.get(k) is None and before.get(k) is not None
            },
        }
    if creator and same_live(before, live):
        return False
    if creator and not live.get("isLive") and not before.get("isLive"):
        return False  # still offline: nothing to show, nothing to write
    fields: Item = {"live": live, "checkedAt": iso(now)}
    if broadcaster_id:
        fields["broadcasterId"] = broadcaster_id
    if live.get("isLive") and not before.get("isLive"):
        fields["liveSince"] = live.get("startedAt") or iso(now)
    ended = bool(before.get("isLive")) and not live.get("isLive")
    if ended:
        fields["lastOfflineAt"] = iso(now)
    _upsert_creator(store, platform, platform_id, fields)
    users = followers(store, platform, platform_id)
    for user_id in users:
        follow_fields: Item = {"live": live}
        if ended:
            started = {**before, "broadcasterId": creator.get("broadcasterId") or broadcaster_id}
            vkey = video_key(platform, started, now)
            follow_fields["last"] = {"state": "noticed", "text": "Stream ended", "at": iso(now), "videoKey": vkey}
            notice(
                store,
                user_id,
                platform,
                platform_id,
                vkey=vkey,
                now=now,
                kind="stream",
                started_at=str(before.get("startedAt") or ""),
                title=str(before.get("title") or ""),
            )
        try:
            store.update(db.user_pk(user_id), follow_sk(platform, platform_id), follow_fields)
        except db.ConditionFailed:
            continue  # unfollowed meanwhile
    log(
        "info",
        "follow.live",
        platform=platform,
        live=bool(live.get("isLive")),
        ended=ended,
        followers=len(users),
        source=source,
    )
    return True


def _upsert_creator(store: db.Store, platform: str, platform_id: str, fields: Mapping[str, Any]) -> None:
    names = {"#t": "type", "#p": "platform", "#i": "platformId"}
    values: dict[str, Any] = {":t": "creator", ":p": platform, ":i": platform_id}
    sets = ["#t = :t", "#p = :p", "#i = :i"]
    for n, (name, value) in enumerate(fields.items()):
        names[f"#f{n}"] = name
        values[f":f{n}"] = value
        sets.append(f"#f{n} = :f{n}")
    store.update_expr(
        CREATOR_PK, creator_sk(platform, platform_id), "SET " + ", ".join(sets), names=names, values=values
    )


def notice(
    store: db.Store,
    user_id: str,
    platform: str,
    platform_id: str,
    *,
    vkey: str,
    now: datetime,
    kind: str,
    started_at: str = "",
    title: str = "",
    published_at: str = "",
    duration_sec: int | None = None,
    live_content: str = "",
) -> bool:
    """Writes what part 2 needs to make clips by itself: one WATCH item per follower and video, written once.

    ``autoMaking: false`` and state ``waiting``: in this part nothing moves it on (no job is started)."""
    item: Item = {
        "pk": WATCH_PK,
        "sk": watch_sk(platform, vkey, user_id),
        "type": "watch",
        "userId": user_id,
        "platform": platform,
        "platformId": platform_id,
        "videoKey": vkey,
        "kind": kind,  # "stream" (a finished live stream) or "upload" (a new video)
        "state": "waiting",
        "autoMaking": False,
        "attempts": 0,
        "noticedAt": iso(now),
        "endedAt": iso(now) if kind == "stream" else None,
        "startedAt": started_at or None,
        "publishedAt": published_at or None,
        "title": plain(title) or None,
        "durationSec": duration_sec,
        "ttl": ttl(now, WATCH_TTL),
    }
    if live_content:
        item["liveBroadcastContent"] = live_content
    try:
        store.put(item, if_absent=True)
    except db.ConditionFailed:
        if kind != "stream":
            return False
        # A YouTube live video can show up in the feed (as an upload) before it ends. Once it has ended it is a
        # finished stream: move that one item on, once, so part 2 reads "stream" with its end time.
        try:
            store.update_expr(
                WATCH_PK,
                item["sk"],
                "SET #k = :stream, #e = :ended, #s = if_not_exists(#s, :started), #l = :none",
                condition="attribute_exists(pk) AND #k = :upload",
                names={"#k": "kind", "#e": "endedAt", "#s": "startedAt", "#l": "liveBroadcastContent"},
                values={
                    ":stream": "stream",
                    ":upload": "upload",
                    ":ended": iso(now),
                    ":started": started_at or None,
                    ":none": "none",
                },
            )
        except db.ConditionFailed:
            return False
    log("info", "follow.noticed", platform=platform, kind=kind, autoMaking=False)
    return True


# --- following ---------------------------------------------------------------------------------------------------------------


def follow(store: db.Store, env: pf.FollowEnv, user_id: str, platform: str, platform_id: str, *, now: datetime) -> Item:
    """Adds a follow (after the permission answer). Looks the creator up again: names never come from the web."""
    existing = store.get(db.user_pk(user_id), follow_sk(platform, platform_id))
    if existing:
        return public_follow(existing)
    if len(all_follows(store, user_id)) >= MAX_FOLLOWS:
        raise conflict(f"You can follow up to {MAX_FOLLOWS} streamers. Remove one first.")
    kind = {"youtube": "channel", "twitch": "login", "kick": "slug"}[platform]
    found = lookup(env, Wanted(platform, kind, platform_id))  # type: ignore[arg-type]
    item: Item = {
        "pk": db.user_pk(user_id),
        "sk": follow_sk(platform, platform_id),
        "type": "follow",
        "followId": follow_id(platform, platform_id),
        "userId": user_id,
        "platform": platform,
        "platformId": platform_id,
        "handle": found["handle"],
        "name": found["name"],
        "avatarUrl": found["avatarUrl"] or None,
        "url": found["url"],
        "creatorKeys": creator_keys(platform, platform_id, found["handle"], found["name"]),
        "autoClips": True,
        "permissionAt": iso(now),
        "followedAt": iso(now),
        "resolved": found["resolved"],
        "refreshedAt": iso(now),
        "live": found.get("live"),
    }
    try:
        store.transact(
            puts=[
                item,
                {
                    "pk": FOLLOWED_PK,
                    "sk": followed_sk(platform, platform_id, user_id),
                    "type": "followed",
                    "userId": user_id,
                    "platform": platform,
                    "platformId": platform_id,
                    "followedAt": iso(now),
                },
            ]
        )
    except db.ConditionFailed:
        again = store.get(db.user_pk(user_id), follow_sk(platform, platform_id))
        if again:
            return public_follow(again)
        raise conflict("That just changed. Try again.") from None
    # The creator item: the tick subscribes webhooks for it (once per creator, never per follower) on its next run.
    fields: Item = {"wanted": True, "name": found["name"], "handle": found["handle"]}
    if found.get("live"):
        fields["live"] = found["live"]
    _upsert_creator(store, platform, platform_id, fields)
    log("info", "follow.added", platform=platform, resolved=bool(found["resolved"]))
    return public_follow(item)


def unfollow(store: db.Store, user_id: str, platform: str, platform_id: str) -> bool:
    """Deletes only this owner's FOLLOW and FOLLOWED items. The tick removes the webhook subscriptions once nobody
    follows the creator any more. Noticed streams and jobs stay."""
    gone = store.delete_once(db.user_pk(user_id), follow_sk(platform, platform_id))
    store.delete(FOLLOWED_PK, followed_sk(platform, platform_id, user_id))
    if gone is not None:
        log("info", "follow.removed", platform=platform)
    return gone is not None


def set_auto(store: db.Store, user_id: str, platform: str, platform_id: str, on: bool) -> Item:
    try:
        item = store.update(db.user_pk(user_id), follow_sk(platform, platform_id), {"autoClips": on})
    except db.ConditionFailed:
        raise not_found("You do not follow that streamer any more. Reload the page.") from None
    return public_follow(item)
