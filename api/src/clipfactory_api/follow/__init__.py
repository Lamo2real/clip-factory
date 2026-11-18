"""Follow creators (docs/CONTRACTS.md §24): the owner follows YouTube, Twitch and Kick creators, sees their names
and who is live, and Clip Factory notices when a long stream ends or a new video is uploaded.

This package is part 1 of the feature: following, names, platform marks, live badges and noticing. Making clips by
itself from what it noticed is part 2; the ``WATCH`` items written here are what part 2 reads.

Items (all in ``cf-prod-data``, additive, no new index):

* ``USER#{u}`` / ``FOLLOW#{platform}#{platformId}``: one follow (``public_follow`` is its public shape).
* ``FOLLOWED`` / ``{platform}#{platformId}#{u}``: the reverse index. Webhooks find the followers of a creator, and the
  tick lists every follow, with one Query each (never a Scan).
* ``CREATOR`` / ``{platform}#{platformId}``: one per followed creator (never per user): the platform's numeric id,
  the webhook subscription ids and their state, the last live state and the newest feed entry seen.
* ``WATCH`` / ``{platform}#{videoKey}#{u}``: a finished stream or new upload that was noticed (state ``waiting``,
  ``autoMaking: false``). 14-day ``ttl``.
* ``USER#{u}`` / ``FOLLOWKEYS#{platform}``: when the Twitch, Kick or YouTube read keys were saved, masked hints and the
  last check. The keys themselves live only in Secrets Manager.

``platformId`` is the id in the creator's own link: the YouTube channel id (``UC…``), the Twitch login or the Kick
slug, always lower case for Twitch and Kick. So a Twitch or Kick creator can be followed before the app keys are
pasted; the numeric broadcaster id is filled in by the tick once they are.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from .. import db

Item = dict[str, Any]

PLATFORMS: tuple[str, ...] = ("youtube", "twitch", "kick")
# Where the owner pastes app keys for following (never SETUP_ORDER, STATS_ORDER or settings.PLATFORMS: those drive
# posting, numbers and setup). "youtube-read" is an optional API key from a separate Google Cloud project.
KEY_PLATFORMS: tuple[str, ...] = ("twitch", "kick", "youtube-read")
LABELS = {"youtube": "YouTube", "twitch": "Twitch", "kick": "Kick", "youtube-read": "YouTube"}

MAX_FOLLOWS = 100
MAX_TEXT = 100
WATCH_TTL = timedelta(days=14)
HOOK_TTL = timedelta(days=14)

FOLLOW_PREFIX = "FOLLOW#"
FOLLOWED_PK = "FOLLOWED"
CREATOR_PK = "CREATOR"
WATCH_PK = "WATCH"
FOLLOWKEYS_PREFIX = "FOLLOWKEYS#"
TICK_PK = "FOLLOWTICK"
TICK_SK = "LEASE"

YOUTUBE_CHANNEL = re.compile(r"^UC[\w-]{22}$")
YOUTUBE_HANDLE = re.compile(r"^@[\w.\-]{3,30}$")
YOUTUBE_VIDEO = re.compile(r"^[\w-]{11}$")
TWITCH_LOGIN = re.compile(r"^[A-Za-z0-9_]{4,25}$")
KICK_SLUG = re.compile(r"^[A-Za-z0-9_-]{1,25}$")
ID_PATTERNS = {"youtube": YOUTUBE_CHANNEL, "twitch": TWITCH_LOGIN, "kick": KICK_SLUG}

# Avatars are shown only from the platforms' own picture hosts (an <img> loads from a third party): anything else
# shows the creator's initials instead.
AVATAR_HOSTS = ("static-cdn.jtvnw.net", "yt3.ggpht.com", "yt3.googleusercontent.com", "files.kick.com")
AVATAR_SUFFIXES = (".kick.com",)
_CONTROL = re.compile("[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")


# --- keys ------------------------------------------------------------------------------------------------------------


def follow_sk(platform: str, platform_id: str) -> str:
    return f"{FOLLOW_PREFIX}{platform}#{platform_id}"


def followed_sk(platform: str, platform_id: str, user_id: str) -> str:
    return f"{platform}#{platform_id}#{user_id}"


def creator_sk(platform: str, platform_id: str) -> str:
    return f"{platform}#{platform_id}"


def watch_sk(platform: str, video_key: str, user_id: str) -> str:
    return f"{platform}#{video_key}#{user_id}"


def keys_sk(platform: str) -> str:
    return f"{FOLLOWKEYS_PREFIX}{platform}"


def follow_id(platform: str, platform_id: str) -> str:
    """The id the web uses for a follow (and the live event's ``id``): ``twitch:somestreamer``."""
    return f"{platform}:{platform_id}"


def is_platform_id(platform: str, value: str) -> bool:
    pattern = ID_PATTERNS.get(platform)
    return bool(pattern and pattern.match(value))


def normal_id(platform: str, value: str) -> str:
    """Twitch logins and Kick slugs are not case-sensitive: stored lower case. YouTube ids are case-sensitive."""
    return value if platform == "youtube" else value.lower()


# --- plain text from other sites ---------------------------------------------------------------------------------------


def plain(value: Any, limit: int = MAX_TEXT) -> str:
    """A creator's name or a stream title: plain text, control and direction characters removed, at most ``limit``."""
    text = _CONTROL.sub("", " ".join(str(value or "").split()))
    return text[:limit].strip()


def safe_avatar(url: Any) -> str:
    """The avatar link when it is https on a platform picture host, else ""."""
    if not isinstance(url, str) or len(url) > 500:
        return ""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or port is not None:
        return ""
    if host in AVATAR_HOSTS or any(host.endswith(s) for s in AVATAR_SUFFIXES):
        return url
    return ""


def round_viewers(n: Any) -> int | None:
    """Viewers rounded to 2 significant figures, so small changes do not cause a write and a live push each tick."""
    if isinstance(n, bool) or not isinstance(n, int | float) or n < 0:
        return None
    value = int(n)
    if value < 100:
        return value
    digits = len(str(value)) - 2
    return round(value, -digits)


def channel_url(platform: str, platform_id: str, handle: str = "") -> str:
    if platform == "youtube":
        return (
            f"https://www.youtube.com/{handle}"
            if handle.startswith("@")
            else f"https://www.youtube.com/channel/{platform_id}"
        )
    if platform == "twitch":
        return f"https://www.twitch.tv/{platform_id}"
    return f"https://kick.com/{platform_id}"


def creator_keys(platform: str, platform_id: str, handle: str, name: str) -> list[str]:
    """The creator keys of §16.12 for this creator, so later jobs of a followed creator join the same lessons.

    YouTube: ``youtube:id:<UC id>``. Twitch and Kick: yt-dlp reports the login or slug as the channel id
    (``uploader_id``) [to be confirmed with real fixtures in part 2], so ``<platform>:id:<login>``. Then the name key.
    """
    keys = [f"{platform}:id:{platform_id}"]
    for value in (name, handle):
        text = " ".join(str(value or "").split()).casefold()
        text = text[1:].strip() if text.startswith("@") else text
        key = f"{platform}:name:{text}"
        if text and key not in keys:
            keys.append(key)
    return keys


# --- public shapes -----------------------------------------------------------------------------------------------------

PUBLIC_FIELDS = (
    "platform",
    "platformId",
    "handle",
    "name",
    "avatarUrl",
    "url",
    "autoClips",
    "permissionAt",
    "followedAt",
    "live",
    "last",
    "resolved",
)


def public_follow(item: Mapping[str, Any]) -> Item:
    out: Item = {"followId": follow_id(str(item.get("platform")), str(item.get("platformId")))}
    for name in PUBLIC_FIELDS:
        if name in item and item[name] is not None:
            out[name] = item[name]
    out.setdefault("autoClips", True)
    out.setdefault("resolved", False)
    out["avatarUrl"] = safe_avatar(out.get("avatarUrl"))
    return out


def ttl(now: datetime, after: timedelta) -> int:
    return int((now + after).timestamp())


def all_follows(store: db.Store, user_id: str) -> list[Item]:
    return [
        i for i in store.query_all(db.user_pk(user_id), FOLLOW_PREFIX, consistent=True) if i.get("type") == "follow"
    ]


def followers(store: db.Store, platform: str, platform_id: str) -> list[str]:
    """The owners following this creator (the FOLLOWED reverse index)."""
    rows = store.query_all(FOLLOWED_PK, f"{platform}#{platform_id}#")
    return [str(r.get("userId")) for r in rows if r.get("userId")]
