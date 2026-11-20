"""My settings: the owner's own post choices per platform, and the per-clip options sent with Upload (CONTRACTS §36).

One preset per owner, stored in Settings as ``postPreset`` (additive: an owner who never saved one reads the defaults
below, so nothing he already saved changes). The defaults are the owner's ask: the most reach on every platform
(Everyone can see it, comments, duets and stitches on, Instagram Reels shared to the feed, everyone can reply on X)
and never made for kids. YouTube's "who can see it" is not in the preset: it stays ``settings.youtubePrivacy`` (one
place for it, Settings › Posting › My settings shows and saves that field). TikTok's Commercial content is not in the
preset either: it is about one clip, so it starts off and the owner ticks Your brand or Branded content on that clip.

The preset can never mark a clip as made for kids: the field does not exist in it, and a request that tries is
refused. A single clip's options may say ``madeForKids`` (YouTube asks every creator; the switch starts off).
"""

from __future__ import annotations

import copy
from typing import Any

from . import validate
from .errors import bad_request

YOUTUBE_PRIVACY = ("public", "unlisted", "private")
# YouTube category ids offered (Gaming first: these are game clips).
YOUTUBE_CATEGORIES: dict[str, str] = {
    "20": "Gaming",
    "24": "Entertainment",
    "23": "Comedy",
    "22": "People & Blogs",
    "17": "Sports",
}
TIKTOK_PRIVACY = ("PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY")
# X's reply_settings: "everyone" sends nothing (X's default: anyone can reply).
X_REPLIES = ("everyone", "following", "mentionedUsers", "verified")

DEFAULTS: dict[str, dict[str, Any]] = {
    "youtube": {"category": "20", "notifySubscribers": True, "embeddable": True},
    "tiktok": {"privacy": "PUBLIC_TO_EVERYONE", "comments": True, "duet": True, "stitch": True},
    "instagram": {"shareToFeed": True},
    # Reels on a Facebook Page are public: there is nothing to pick.
    "facebook": {},
    "x": {"replies": "everyone"},
}

# What one clip's options may say, per place (§36.3). TikTok's per-clip choices go in ``tiktok`` (§17.8), not here.
CLIP_KEYS: dict[str, frozenset[str]] = {
    "youtube": frozenset({"privacy", "category", "madeForKids", "notifySubscribers", "embeddable"}),
    "instagram": frozenset({"shareToFeed"}),
    "x": frozenset({"replies"}),
}

KIDS_KEYS = frozenset({"madeForKids", "selfDeclaredMadeForKids", "forKids"})
NEVER_KIDS = "My settings never mark a clip as made for kids."


def defaults() -> dict[str, dict[str, Any]]:
    return copy.deepcopy(DEFAULTS)


def _choice(value: Any, allowed: tuple[str, ...] | list[str], message: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise bad_request(message)
    return value


def _value(platform: str, key: str, value: Any) -> Any:
    match platform, key:
        case "youtube", "privacy":
            return _choice(value, YOUTUBE_PRIVACY, "Pick who can see it on YouTube: Everyone, Link only or Only me.")
        case "youtube", "category":
            return _choice(value, list(YOUTUBE_CATEGORIES), "Pick one of the YouTube categories in the list.")
        case "tiktok", "privacy":
            return _choice(value, TIKTOK_PRIVACY, "Pick who can see it on TikTok.")
        case "x", "replies":
            return _choice(value, X_REPLIES, "Pick who can reply on X.")
    return validate.boolean(value, key)


def check_platform(platform: str, raw: Any) -> dict[str, Any]:
    """One platform's preset over its defaults, validated. Unknown keys are refused; made for kids always is."""
    body = validate.obj(raw, platform)
    if KIDS_KEYS & set(body):
        raise bad_request(NEVER_KIDS)
    validate.only_keys(body, DEFAULTS[platform].keys())
    out = dict(DEFAULTS[platform])
    for key, value in body.items():
        out[key] = _value(platform, key, value)
    return out


def check(raw: Any) -> dict[str, dict[str, Any]]:
    """A whole (or partial) ``postPreset``: each platform given is merged over its defaults."""
    body = validate.obj(raw, "My settings")
    validate.only_keys(body, DEFAULTS.keys())
    out = defaults()
    for platform, value in body.items():
        out[platform] = check_platform(platform, value)
    return out


def clip_options(raw: Any) -> dict[str, dict[str, Any]]:
    """The confirm body's per-clip ``options`` (§36.3) for YouTube, Instagram and X. Only what is given is stored; the
    publisher falls back to the saved setup for anything missing."""
    body = validate.obj(raw, "options")
    validate.only_keys(body, CLIP_KEYS.keys())
    out: dict[str, dict[str, Any]] = {}
    for platform, value in body.items():
        part = validate.obj(value, platform)
        validate.only_keys(part, CLIP_KEYS[platform])
        out[platform] = {key: _value(platform, key, v) for key, v in part.items()}
    return out
