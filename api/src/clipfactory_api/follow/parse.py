"""What the owner typed in "Follow a streamer": a link or a name (docs/CONTRACTS.md §24.1).

Parsing only: nothing here fetches the pasted text. A link is split with ``urlsplit`` and accepted only on an exact
YouTube, Twitch or Kick host, http(s), with no user info and no port; the id in it must match its pattern. Every
later request goes to a fixed platform API host with that id URL-encoded, so a pasted link can never make the server
call anywhere else (no SSRF).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from ..errors import bad_request
from . import KICK_SLUG, PLATFORMS, TWITCH_LOGIN, YOUTUBE_CHANNEL, YOUTUBE_HANDLE, YOUTUBE_VIDEO

MAX_INPUT = 300
HOSTS = {
    "youtube.com": "youtube",
    "www.youtube.com": "youtube",
    "m.youtube.com": "youtube",
    "youtu.be": "youtube",
    "twitch.tv": "twitch",
    "www.twitch.tv": "twitch",
    "m.twitch.tv": "twitch",
    "kick.com": "kick",
    "www.kick.com": "kick",
}
# First path parts that are Twitch or Kick pages, not channels.
NOT_CHANNELS = {
    "twitch": {"videos", "directory", "settings", "p", "downloads", "search", "subscriptions", "inventory", "wallet"},
    "kick": {
        "categories",
        "browse",
        "following",
        "search",
        "video",
        "videos",
        "dashboard",
        "settings",
        "terms-of-service",
    },
}

Kind = Literal["channel", "handle", "login", "slug", "video", "name"]

NOT_A_LINK = "That is not a YouTube, Twitch or Kick link. Paste the streamer's page, or type their name."
BAD_NAME = "That name has letters we cannot use. Check it and try again."


@dataclass(frozen=True)
class Wanted:
    """``platform`` is "" when only a name was typed and no platform was picked (the web then shows 3 buttons)."""

    platform: str
    kind: Kind
    value: str


def parse(text: object, platform: object = None) -> Wanted:
    if not isinstance(text, str) or not text.strip():
        raise bad_request("Paste a link or type a name.", "text")
    value = text.strip()
    if len(value) > MAX_INPUT:
        raise bad_request("That is too long. Paste just the streamer's link.", "text")
    if platform is not None and platform not in PLATFORMS:
        raise bad_request("Pick YouTube, Twitch or Kick.", "platform")
    if _looks_like_link(value):
        return _link(value)
    return _name(value, str(platform) if platform else "")


def _looks_like_link(value: str) -> bool:
    lowered = value.lower()
    return "://" in lowered or "/" in value or any(lowered.startswith(h) for h in HOSTS)


def _link(value: str) -> Wanted:
    candidate = value if "://" in value else "https://" + value
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as e:
        raise bad_request(NOT_A_LINK, "text") from e
    host = (parts.hostname or "").lower()
    if parts.scheme not in {"http", "https"} or parts.username or parts.password or port is not None:
        raise bad_request(NOT_A_LINK, "text")
    platform = HOSTS.get(host)
    if platform is None:
        raise bad_request(NOT_A_LINK, "text")
    path = [p for p in parts.path.split("/") if p]
    if platform == "youtube":
        return _youtube(host, path, parts.query)
    if not path or path[0].lower() in NOT_CHANNELS[platform]:
        raise bad_request(
            f"Paste the streamer's {platform.title()} page, like {platform}.{_tld(platform)}/name.", "text"
        )
    name = path[0]
    pattern = TWITCH_LOGIN if platform == "twitch" else KICK_SLUG
    if not pattern.match(name):
        raise bad_request(BAD_NAME, "text")
    return Wanted(platform, "login" if platform == "twitch" else "slug", name.lower())


def _tld(platform: str) -> str:
    return "tv" if platform == "twitch" else "com"


def _youtube(host: str, path: list[str], query: str) -> Wanted:
    if host == "youtu.be":
        if path and YOUTUBE_VIDEO.match(path[0]):
            return Wanted("youtube", "video", path[0])
        raise bad_request(NOT_A_LINK, "text")
    if path and path[0] == "watch":
        found = parse_qs(query).get("v") or []
        if found and YOUTUBE_VIDEO.match(found[0]):
            return Wanted("youtube", "video", found[0])
    if len(path) >= 2 and path[0] in {"live", "shorts"} and YOUTUBE_VIDEO.match(path[1]):
        return Wanted("youtube", "video", path[1])
    if len(path) >= 2 and path[0] == "channel" and YOUTUBE_CHANNEL.match(path[1]):
        return Wanted("youtube", "channel", path[1])
    if path and path[0].startswith("@"):
        if YOUTUBE_HANDLE.match(path[0]):
            return Wanted("youtube", "handle", path[0])
        raise bad_request(BAD_NAME, "text")
    raise bad_request("Paste the channel's page, the one with @ in its link, or a video of theirs.", "text")


def _name(value: str, platform: str) -> Wanted:
    bare = value[1:] if value.startswith("@") else value
    if not platform:
        # A name alone: which site is it on? The web shows big YouTube, Twitch and Kick buttons.
        if not (TWITCH_LOGIN.match(bare) or KICK_SLUG.match(bare) or YOUTUBE_HANDLE.match("@" + bare)):
            raise bad_request(BAD_NAME, "text")
        return Wanted("", "name", bare)
    if platform == "youtube":
        if YOUTUBE_CHANNEL.match(bare):
            return Wanted("youtube", "channel", bare)
        if YOUTUBE_HANDLE.match("@" + bare):
            return Wanted("youtube", "handle", "@" + bare)
        raise bad_request(BAD_NAME, "text")
    if platform == "twitch":
        if not TWITCH_LOGIN.match(bare):
            raise bad_request("A Twitch name is 4 to 25 letters, numbers or _.", "text")
        return Wanted("twitch", "login", bare.lower())
    if not KICK_SLUG.match(bare):
        raise bad_request("A Kick name is letters, numbers, - or _.", "text")
    return Wanted("kick", "slug", bare.lower())
