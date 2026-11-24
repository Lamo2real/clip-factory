"""The links a reference video may come from (docs/CONTRACTS.md §45.40, ADR-88): one allowlist, three copies.

The API's copy: Clips Funded's agent has its own (``lamostories_agent.reflinks``, which may not import this package)
and the web its own (``web/src/stories/api/refLinks.ts``). All three give the answers in
``stories/agent/tests/fixtures/reference_links.json``, and every suite reads that file.

``clean_link(text)`` takes what the owner pasted (share text too: the first link in it) and gives ``(url, site)``: only
``https`` (``http`` or no scheme: ``https://`` is put in front), no user name or password, port 443 or none, at most 2048
characters, the host lower-cased (TikTok's ``tiktok.com`` and ``m.tiktok.com`` become ``www.tiktok.com``, the host
yt-dlp's TikTok extractor takes), the path as given, only the kept query keys, no fragment. Anything else raises
``LinkRefused(why)``: ``empty``, ``not_a_link``, ``other_site`` or ``not_one_video`` (a profile, a folder, a page).
The text is parsed by hand, the same way in every copy, so the three never differ on an odd link.

Facebook's own Share › Copy link (``facebook.com/share/r/…``, ``/share/v/…``) and ``fb.watch/…`` only point at a video:
``is_share_link`` names them, and the agent opens one through its egress guard first and checks where it leads with
``clean_link`` again (never handing the share link itself to yt-dlp)."""

from __future__ import annotations

import re
from typing import Final

MAX_LINK: Final = 2048
MAX_TEXT: Final = 4096
SITES: Final = ("youtube", "tiktok", "instagram", "facebook", "x", "drive", "dropbox")
SITE_NAMES: Final = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "x": "X",
    "drive": "Google Drive",
    "dropbox": "Dropbox",
}
PLATFORMS: Final = ("youtube", "tiktok", "instagram", "facebook", "x")  # fetched with yt-dlp; Drive and Dropbox not
WHYS: Final = ("empty", "not_a_link", "other_site", "not_one_video")
SENTENCES: Final = {
    "empty": "Paste a video link.",
    "not_a_link": "That isn't a link. Copy the video's link, then paste it here.",
    "other_site": "We can't get videos from that site. Save the video, then upload it.",
    "not_one_video": "That link isn't one video. Open the video, tap Share, then Copy link.",
}

HOSTS: Final = {
    "youtube.com": "youtube",
    "www.youtube.com": "youtube",
    "m.youtube.com": "youtube",
    "youtu.be": "youtube",
    "tiktok.com": "tiktok",
    "www.tiktok.com": "tiktok",
    "m.tiktok.com": "tiktok",
    "vm.tiktok.com": "tiktok",
    "vt.tiktok.com": "tiktok",
    "instagram.com": "instagram",
    "www.instagram.com": "instagram",
    "facebook.com": "facebook",
    "www.facebook.com": "facebook",
    "m.facebook.com": "facebook",
    "fb.watch": "facebook",
    "x.com": "x",
    "www.x.com": "x",
    "mobile.x.com": "x",
    "twitter.com": "x",
    "www.twitter.com": "x",
    "mobile.twitter.com": "x",
    "drive.google.com": "drive",
    "dropbox.com": "dropbox",
    "www.dropbox.com": "dropbox",
}
# yt-dlp's TikTok extractors take only www.tiktok.com (and vm./vt.): the other two hosts are written as that one.
HOST_AS: Final = {"tiktok.com": "www.tiktok.com", "m.tiktok.com": "www.tiktok.com"}

# Whitespace spelled out, so every copy (Python's ``str.isspace`` and JavaScript's ``\s`` differ) splits the same.
_WS_CHARS: Final = " \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_WS: Final = f"[{_WS_CHARS}]"
_EDGES: Final = re.compile(f"^{_WS}+|{_WS}+$")
_HAS_WS: Final = re.compile(_WS)
_LINK_IN_TEXT: Final = re.compile(f"https?://[^<>\"'{_WS_CHARS}]+", re.IGNORECASE)
_BARE_IN_TEXT: Final = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/")
_TRAILING: Final = re.compile(r"[).,!?]+$")
_SCHEME: Final = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://")
_CONTROL: Final = re.compile(r"[\x00-\x1f\x7f]")
_HOST: Final = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

_YT_ID: Final = r"[A-Za-z0-9_-]{11}"
_CODE: Final = r"[A-Za-z0-9_-]{1,64}"
_DIGITS: Final = r"[0-9]{1,30}"
_DRIVE_ID: Final = r"[A-Za-z0-9_-]{10,200}"
_YOUTUBE: Final = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com"})
_TIKTOK_SHORT: Final = frozenset({"vm.tiktok.com", "vt.tiktok.com"})
_FACEBOOK: Final = frozenset({"facebook.com", "www.facebook.com", "m.facebook.com"})
_SHARE_CODE: Final = r"[A-Za-z0-9_-]{1,64}"
Shape = tuple[str, frozenset[str] | None, re.Pattern[str], str | None, str | None]
# (site, its hosts this shape is for or None for all, the path, the query key the path needs and its value's pattern)
_SHAPES: Final[tuple[Shape, ...]] = (
    ("youtube", frozenset({"youtu.be"}), re.compile(f"/{_YT_ID}/?"), None, None),
    ("youtube", _YOUTUBE, re.compile(r"/watch/?"), "v", _YT_ID),
    ("youtube", _YOUTUBE, re.compile(f"/shorts/{_YT_ID}/?"), None, None),
    ("tiktok", frozenset({"www.tiktok.com"}), re.compile(rf"/@[A-Za-z0-9._-]{{1,64}}/video/{_DIGITS}/?"), None, None),
    ("tiktok", frozenset({"www.tiktok.com"}), re.compile(r"/t/[A-Za-z0-9_]{1,64}/?"), None, None),
    ("tiktok", _TIKTOK_SHORT, re.compile(r"/[A-Za-z0-9_]{1,64}/?"), None, None),
    ("instagram", None, re.compile(f"/(reel|reels|p|tv)/{_CODE}/?"), None, None),
    ("facebook", _FACEBOOK, re.compile(f"/reel/{_DIGITS}/?"), None, None),
    ("facebook", _FACEBOOK, re.compile(r"/watch/?"), "v", _DIGITS),
    ("facebook", _FACEBOOK, re.compile(rf"/[A-Za-z0-9._-]{{1,100}}/videos/{_DIGITS}/?"), None, None),
    ("facebook", _FACEBOOK, re.compile(f"/share/(r|v)/{_SHARE_CODE}/?"), None, None),
    ("facebook", frozenset({"fb.watch"}), re.compile(f"/{_SHARE_CODE}/?"), None, None),
    ("x", None, re.compile(r"/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}(/video/[0-9])?/?"), None, None),
    ("drive", None, re.compile(f"/file/d/{_DRIVE_ID}(/[^?#]*)?"), None, None),
    ("drive", None, re.compile(r"/(open|uc)/?"), "id", _DRIVE_ID),
    ("dropbox", None, re.compile(rf"/(s|scl/fi)/{_CODE}/[^/?#]{{1,255}}/?"), None, None),
)
# A query key kept beside the path's own (Dropbox's rlkey opens a shared file).
_EXTRA_KEYS: Final = {"dropbox": ("rlkey", r"[A-Za-z0-9]{1,100}")}
# Facebook's share links, as clean_link gives them: opened first (where they lead is checked again).
_SHARE: Final = re.compile(rf"https://((www\.|m\.)?facebook\.com/share/(r|v)|fb\.watch)/{_SHARE_CODE}/?")


class LinkRefused(ValueError):
    """``why``: ``empty``, ``not_a_link``, ``other_site`` or ``not_one_video``; ``sentence`` says what to do."""

    def __init__(self, why: str) -> None:
        super().__init__(why)
        self.why = why
        self.sentence = SENTENCES[why]


def share_link(text: str) -> str:
    """The link in what was pasted: the text itself when it has no space, else its first https?:// link, else its first
    word that looks like ``host/path``; trailing ``).,!?`` dropped."""
    t = _EDGES.sub("", text)
    if not _HAS_WS.search(t):
        return t
    found = _LINK_IN_TEXT.search(t)
    if found:
        return _TRAILING.sub("", found.group(0))
    for word in re.split(f"{_WS}+", t):
        if _BARE_IN_TEXT.match(word):
            return _TRAILING.sub("", word)
    return t


def _query(query: str) -> dict[str, str]:
    """The first value of each key, as written (nothing decoded)."""
    out: dict[str, str] = {}
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        if key and key not in out:
            out[key] = value
    return out


def clean_link(text: str) -> tuple[str, str]:
    """``(the cleaned https link, its site)``; ``LinkRefused`` for anything that is not one video on an allowed site."""
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise LinkRefused("not_a_link")
    link = share_link(text)
    if not link:
        raise LinkRefused("empty")
    if len(link) > MAX_LINK or _HAS_WS.search(link) or _CONTROL.search(link):
        raise LinkRefused("not_a_link")
    scheme = _SCHEME.match(link)
    if scheme:
        if scheme.group(1).lower() not in ("https", "http"):  # http is written as https: only https is ever fetched
            raise LinkRefused("not_a_link")
        rest = link[scheme.end() :]
    else:
        rest = link
    cut = min([i for i in (rest.find("/"), rest.find("?"), rest.find("#")) if i >= 0], default=len(rest))
    authority, rest = rest[:cut], rest[cut:]
    if "@" in authority:
        raise LinkRefused("not_a_link")
    host, colon, port = authority.partition(":")
    if colon and port != "443":
        raise LinkRefused("not_a_link")
    host = host.lower()
    host = host.removesuffix(".")
    if not _HOST.match(host):
        raise LinkRefused("not_a_link")
    rest = rest.split("#", 1)[0]
    path, _, query = rest.partition("?")
    path = path or "/"
    site = HOSTS.get(host)
    if site is None:
        raise LinkRefused("other_site")
    host = HOST_AS.get(host, host)
    params = _query(query)
    for shape_site, hosts, pattern, key, value in _SHAPES:
        if shape_site != site or (hosts is not None and host not in hosts) or not pattern.fullmatch(path):
            continue
        kept: list[str] = []
        if key is not None:
            if not re.fullmatch(str(value), params.get(key, "")):
                continue
            kept.append(f"{key}={params[key]}")
        extra = _EXTRA_KEYS.get(site)
        if extra is not None and re.fullmatch(extra[1], params.get(extra[0], "")):
            kept.append(f"{extra[0]}={params[extra[0]]}")
        url = f"https://{host}{path}" + (f"?{'&'.join(kept)}" if kept else "")
        if len(url) > MAX_LINK:
            raise LinkRefused("not_a_link")
        return url, site
    raise LinkRefused("not_one_video")


def is_share_link(url: str) -> bool:
    """A cleaned Facebook share link (``/share/r/…``, ``/share/v/…``, ``fb.watch/…``): it only points at the video."""
    return bool(_SHARE.fullmatch(url))


def site_of(url: str) -> str | None:
    """The site of a cleaned link (``From TikTok``), or None."""
    try:
        return clean_link(url)[1]
    except LinkRefused:
        return None
