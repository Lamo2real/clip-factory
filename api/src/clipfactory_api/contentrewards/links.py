"""Links: which campaign a pasted link is, post links for matching, and the links a brief may offer (§38.4, §38.10).

``parse_campaign_url`` is mirrored by ``web/src/lib/links.ts`` ``campaignLink`` (the same shapes and sentences).
"""

from __future__ import annotations

import re
import urllib.parse
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

INVITE = "That's an invite link. Open it, join, then copy the campaign's own link (share icon, **Copy campaign link**)."
CHECKOUT = "That's a Whop sign-up link. Open the campaign on contentrewards.com and copy its link there."
CR_PAGE = "That's a Content Rewards page, not one campaign. Open the campaign, then copy its link."
NOT_CAMPAIGN = "That's not a Content Rewards campaign link. Open the campaign, then copy its link."


@dataclass(frozen=True)
class ParsedLink:
    kind: str  # "campaign" | "group" | "refused" | "none"
    uuid: str | None = None
    text: str | None = None  # the owner sentence of a refusal

    @property
    def url(self) -> str | None:
        return campaign_url(self.uuid) if self.uuid else None


def campaign_url(uuid: str) -> str:
    return f"https://contentrewards.com/c/campaigns/{uuid.lower()}"


def _split(url: str) -> urllib.parse.SplitResult | None:
    candidate = (url or "").strip()
    if not candidate or len(candidate) > 2048:
        return None
    if "://" not in candidate:
        candidate = "https://" + candidate
    try:
        parts = urllib.parse.urlsplit(candidate)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        return None
    return parts


def _host(parts: urllib.parse.SplitResult) -> str:
    return (parts.hostname or "").lower().rstrip(".").removeprefix("www.")


def parse_campaign_url(url: str) -> ParsedLink:
    """A pasted link → a campaign (uuid lowercase), a group, a refusal with its sentence, or "none" (not CR)."""
    parts = _split(url)
    if parts is None:
        return ParsedLink("none")
    host = _host(parts)
    segments = [s for s in parts.path.split("/") if s]
    query = urllib.parse.parse_qs(parts.query)
    group = query.get("group", [""])[0] == "1"
    uuid: str | None = None
    if host == "contentrewards.com":
        if len(segments) == 3 and segments[0] == "c" and segments[1] in {"campaigns", "discover"}:
            uuid = segments[2]
        elif len(segments) == 2 and segments[0] == "discover":
            uuid = segments[1]
        elif len(segments) >= 2 and segments[0] == "c" and segments[1] == "invite":
            return ParsedLink("refused", text=INVITE)
        if uuid is None or not UUID.match(uuid):
            return ParsedLink("refused", text=CR_PAGE)
    elif host == "whop.com":
        if segments[:1] == ["checkout"]:
            return ParsedLink("refused", text=CHECKOUT)
        if len(segments) == 4 and segments[0] == "experiences" and segments[2] == "campaigns":
            uuid = segments[3]
        if uuid is None or not UUID.match(uuid):
            return ParsedLink("none")
    else:
        return ParsedLink("none")
    return ParsedLink("group" if group else "campaign", uuid.lower())


# --- post links (matching a hand-sent post by its link, §38.12) -------------------------------------------------

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")


def normalize_post_url(url: Any) -> str | None:
    """One stable key per post link, whatever the shape (``youtu.be``, ``/shorts/``, ``m.``, tracking query)."""
    if not isinstance(url, str):
        return None
    parts = _split(url)
    if parts is None:
        return None
    host = _host(parts).removeprefix("m.")
    segments = [s for s in parts.path.split("/") if s]
    query = urllib.parse.parse_qs(parts.query)
    if host in {"youtube.com", "youtu.be", "music.youtube.com"}:
        vid = None
        if host == "youtu.be" and segments:
            vid = segments[0]
        elif segments[:1] in (["shorts"], ["live"], ["embed"]) and len(segments) > 1:
            vid = segments[1]
        elif segments[:1] == ["watch"]:
            vid = query.get("v", [""])[0]
        if vid and _YT_ID.match(vid):
            return f"youtube:{vid}"
    if host == "instagram.com":
        for i, seg in enumerate(segments[:-1]):
            if seg in {"reel", "reels", "p", "tv"}:
                return f"instagram:{segments[i + 1]}"
    if host in {"tiktok.com", "vm.tiktok.com"}:
        for i, seg in enumerate(segments[:-1]):
            if seg in {"video", "photo"}:
                return f"tiktok:{segments[i + 1]}"
    if host in {"x.com", "twitter.com", "mobile.twitter.com"}:
        for i, seg in enumerate(segments[:-1]):
            if seg == "status":
                return f"x:{segments[i + 1]}"
    if host in {"facebook.com", "fb.watch"}:
        if segments[:1] == ["watch"] and query.get("v"):
            return f"facebook:{query['v'][0]}"
        for i, seg in enumerate(segments[:-1]):
            if seg in {"reel", "videos"}:
                return f"facebook:{segments[i + 1]}"
    path = "/".join(segments)
    return f"{host}/{path}".lower()


# --- links a brief may offer (§38.10 rule 7) ----------------------------------------------------------------------

SOURCE_HOSTS = {
    "drive.google.com": "google_drive",
    "docs.google.com": "google_drive",
    "drive.usercontent.google.com": "google_drive",
    "dropbox.com": "dropbox",
    "dl.dropboxusercontent.com": "dropbox",
    "youtube.com": "youtube",
    "m.youtube.com": "youtube",
    "youtu.be": "youtube",
    "twitch.tv": "twitch",
    "m.twitch.tv": "twitch",
    "clips.twitch.tv": "twitch",
    "kick.com": "kick",
}
CLIPPABLE = frozenset({"youtube", "twitch", "kick"})
VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".m4v")


def https_parts(url: Any) -> urllib.parse.SplitResult | None:
    if not isinstance(url, str) or not url.strip().lower().startswith("https://"):
        return None
    parts = _split(url)
    if parts is None or parts.scheme != "https" or parts.port not in {None, 443}:
        return None
    return parts


def source_kind(url: Any) -> str:
    """The ``SourceKind`` of a link, from its host only (Claude's own ``kind`` is never used)."""
    parts = https_parts(url)
    if parts is None:
        return "other"
    kind = SOURCE_HOSTS.get(_host(parts))
    if kind:
        return kind
    if parts.path.lower().endswith(VIDEO_EXT):
        return "video_file"
    return "other"


def offerable(url: Any) -> bool:
    """Only https Drive, Dropbox, YouTube, Twitch and Kick links are offered as "Open" or "Make clips from this"."""
    return source_kind(url) in {"google_drive", "dropbox", "youtube", "twitch", "kick"}


_HANDLE = re.compile(r"^@?([A-Za-z0-9._-]{2,60})$")


def channel_href(name: str, url: str | None, follows: Iterable[Mapping[str, Any]] = ()) -> str:
    """Where "Open FaZe's YouTube" goes (§38.10 rule 7)."""
    parts = https_parts(url)
    if parts is not None:
        kind = SOURCE_HOSTS.get(_host(parts))
        if kind in CLIPPABLE:
            clean = urllib.parse.urlunsplit(("https", parts.netloc.lower(), parts.path.rstrip("/"), "", ""))
            if kind == "youtube" and not clean.endswith("/videos"):
                clean += "/videos"
            return clean
    text = (name or "").strip()
    found = _HANDLE.match(text)
    if text.startswith("@") and found:
        return f"https://www.youtube.com/@{found.group(1)}/videos"
    folded = " ".join(text.lower().split())
    for follow in follows:
        if " ".join(str(follow.get("name") or "").lower().split()) == folded and folded:
            href = follow.get("url") or follow.get("channelUrl")
            if isinstance(href, str) and href.startswith("https://"):
                return href
    return "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(text)
