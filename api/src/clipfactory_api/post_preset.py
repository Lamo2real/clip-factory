"""My settings: the owner's preferred post choices per platform (docs/CONTRACTS.md §33.4).

One preset per owner, stored in Settings as ``postPreset`` (additive: an owner who never saved one reads the defaults
below). The defaults follow each platform's own best practice for reach: public, open to comments and remixes, and
never "made for kids" (the owner swears in some clips, and a made-for-kids video loses comments, notifications and
personalised ads on YouTube). There is no made-for-kids field at all: YouTube's ``selfDeclaredMadeForKids`` is always
``false`` (publishers.py), and a request that tries to set it is refused.

Whether a clip earns money (the YouTube Partner Program, TikTok's Creator Rewards, Facebook and X payouts) is decided
by each platform, not by these switches.

The same shapes are the confirm body's per-clip ``options`` (§33.3) for YouTube, Instagram and X. TikTok's per-clip
choices keep coming from its own sheet (``tiktok``, §17.8): TikTok's rules want them picked on that sheet each time.
"""

from __future__ import annotations

from typing import Any

from . import validate
from .errors import bad_request

YOUTUBE_PRIVACY = ("public", "unlisted", "private")
# YouTube category ids offered in My settings (Gaming first: these are game clips).
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
    "youtube": {
        "privacy": "public",
        "category": "20",
        "embeddable": True,
        "notifySubscribers": True,
        "syntheticMedia": False,
    },
    "tiktok": {
        "privacy": "PUBLIC_TO_EVERYONE",
        "comments": True,
        "duet": True,
        "stitch": True,
        "commercial": False,
        "aigc": False,
    },
    "instagram": {"shareToFeed": True},
    "facebook": {},
    "x": {"replies": "everyone"},
}

KIDS_KEYS = frozenset({"madeForKids", "selfDeclaredMadeForKids", "forKids"})
NEVER_KIDS = "Clip Factory never marks a clip as made for kids."


def defaults() -> dict[str, dict[str, Any]]:
    return {p: dict(v) for p, v in DEFAULTS.items()}


def _choice(value: Any, allowed: tuple[str, ...] | list[str], message: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise bad_request(message)
    return value


def check_platform(platform: str, raw: Any, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """One platform's choices over ``base`` (the defaults when absent), validated. Unknown keys are refused."""
    body = validate.obj(raw, platform)
    if KIDS_KEYS & set(body):
        raise bad_request(NEVER_KIDS)
    validate.only_keys(body, DEFAULTS[platform].keys())
    out = dict(base if base is not None else DEFAULTS[platform])
    for key, value in body.items():
        match platform, key:
            case "youtube", "privacy":
                out[key] = _choice(
                    value, YOUTUBE_PRIVACY, "Pick who can see it on YouTube: Public, Unlisted or Private."
                )
            case "youtube", "category":
                out[key] = _choice(value, list(YOUTUBE_CATEGORIES), "Pick one of the YouTube categories in the list.")
            case "tiktok", "privacy":
                out[key] = _choice(value, TIKTOK_PRIVACY, "Pick who can see it on TikTok.")
            case "x", "replies":
                out[key] = _choice(value, X_REPLIES, "Pick who can reply on X.")
            case _:
                out[key] = validate.boolean(value, key)
    return out


def check(raw: Any) -> dict[str, dict[str, Any]]:
    """A whole (or partial) ``postPreset``: each platform given is merged over its defaults."""
    body = validate.obj(raw, "My settings")
    validate.only_keys(body, DEFAULTS.keys())
    out = defaults()
    for platform, value in body.items():
        out[platform] = check_platform(platform, value)
    return out


CLIP_OPTION_PLATFORMS = ("youtube", "instagram", "x")


def clip_options(raw: Any) -> dict[str, dict[str, Any]]:
    """The confirm body's per-clip ``options`` (§33.3) for YouTube, Instagram and X, each merged over the defaults."""
    body = validate.obj(raw, "options")
    validate.only_keys(body, CLIP_OPTION_PLATFORMS)
    return {platform: check_platform(platform, value) for platform, value in body.items()}
