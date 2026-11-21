"""TikTok post links the owner pastes after posting a clip on TikTok himself (docs/CONTRACTS.md §42).

TikTok's Copy link gives a full link on the web (``https://www.tiktok.com/@name/video/<id>``) and, in the phone app,
usually a short one (``https://www.tiktok.com/t/<code>/``, ``https://vm.tiktok.com/<code>/``,
``https://vt.tiktok.com/<code>/``) that redirects to the full link. ``find`` reads the link out of whatever was
pasted (TikTok's share text may hold more words); ``resolve`` turns a short link into the full one by reading at most
three redirects, each of which must stay on TikTok's own hosts, so the server never fetches anything else.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from .platforms.base import HttpRequest, HttpResponse, NetworkError

NOT_A_LINK = "That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here."
NOT_A_VIDEO = "That link does not open a TikTok video. In TikTok, open your post, tap Share, then Copy link."
NO_ANSWER = "TikTok did not open that link. Try again in a minute, or paste the long link from tiktok.com."
# TikTok often sends a short link to its home page when a server opens it (checked 2026-11-21).
SHORT_UNREAD = "Clip Factory could not open that short link. Clear the box and tap I posted it: Clip Factory looks for the post on your TikTok."

# Where a pasted link may point: TikTok's own web hosts only.
FULL_HOSTS = frozenset({"tiktok.com", "www.tiktok.com", "m.tiktok.com"})
SHORT_HOSTS = frozenset({"vm.tiktok.com", "vt.tiktok.com"})
MAX_HOPS = 3
MAX_TEXT = 2000

_IN_TEXT = re.compile(r"(?<![A-Za-z0-9.-])(?:https?://)?(?:[a-z0-9-]+\.)*tiktok\.com/[^\s<>\"'`]*", re.IGNORECASE)
_VIDEO_PATH = re.compile(r"^/@([A-Za-z0-9_.]{1,64})/(?:video|photo)/(\d{8,25})/?$")
_M_PATH = re.compile(r"^/v/(\d{8,25})(?:\.html)?/?$")
_T_PATH = re.compile(r"^/t/([A-Za-z0-9_-]{3,40})/?$")
_CODE_PATH = re.compile(r"^/([A-Za-z0-9_-]{3,40})/?$")


class LinkError(ValueError):
    """The pasted text is not a TikTok video link (the message is a plain sentence for the owner)."""


@dataclass(frozen=True)
class TikTokVideo:
    video_id: str
    handle: str | None = None

    @property
    def url(self) -> str:
        if self.handle:
            return f"https://www.tiktok.com/@{self.handle}/video/{self.video_id}"
        return f"https://www.tiktok.com/video/{self.video_id}"


@dataclass(frozen=True)
class Found:
    """What ``find`` read: a full video link (``video``) or a short link to open first (``short``)."""

    video: TikTokVideo | None = None
    short: str | None = None


def find(text: str) -> Found:
    """The first TikTok link in ``text``. Raises ``LinkError`` when there is none, or it is not a video's link."""
    match = _IN_TEXT.search((text or "")[:MAX_TEXT])
    if match is None:
        raise LinkError(NOT_A_LINK)
    raw = match.group(0).rstrip(".,;:!?)]}")
    if not raw.lower().startswith(("http://", "https://")):
        raw = "https://" + raw
    parts = urllib.parse.urlsplit(raw)
    host = (parts.hostname or "").lower()
    video = video_of(host, parts.path)
    if video is not None:
        return Found(video=video)
    if (host in SHORT_HOSTS and _CODE_PATH.match(parts.path)) or (host in FULL_HOSTS and _T_PATH.match(parts.path)):
        return Found(short=urllib.parse.urlunsplit(("https", host, parts.path, "", "")))
    if host in FULL_HOSTS or host in SHORT_HOSTS:
        raise LinkError(NOT_A_VIDEO)
    raise LinkError(NOT_A_LINK)


def video_of(host: str, path: str) -> TikTokVideo | None:
    if host not in FULL_HOSTS:
        return None
    full = _VIDEO_PATH.match(path)
    if full:
        return TikTokVideo(video_id=full.group(2), handle=full.group(1))
    mobile = _M_PATH.match(path)
    if mobile:
        return TikTokVideo(video_id=mobile.group(1))
    return None


Opener = Callable[[HttpRequest], HttpResponse]


def resolve(text: str, open_url: Opener) -> TikTokVideo:
    """The video a pasted link points to. Short links are opened (``open_url`` must not follow redirects itself) and
    each ``Location`` read, at most ``MAX_HOPS`` times, only ever on TikTok's hosts."""
    found = find(text)
    if found.video is not None:
        return found.video
    url = str(found.short)
    for _ in range(MAX_HOPS):
        try:
            resp = open_url(HttpRequest("GET", url, {"User-Agent": "Mozilla/5.0", "Accept": "text/html"}, None))
        except NetworkError as e:
            raise LinkError(NO_ANSWER) from e
        location = resp.headers.get("location")
        if resp.status not in (301, 302, 303, 307, 308) or not location:
            raise LinkError(NOT_A_VIDEO if resp.status < 500 else NO_ANSWER)
        nxt = urllib.parse.urlsplit(urllib.parse.urljoin(url, location))
        host = (nxt.hostname or "").lower()
        if nxt.scheme != "https" or host not in FULL_HOSTS | SHORT_HOSTS:
            raise LinkError(NOT_A_VIDEO)
        video = video_of(host, nxt.path)
        if video is not None:
            return video
        if host in FULL_HOSTS and nxt.path in ("", "/"):
            raise LinkError(SHORT_UNREAD)
        url = urllib.parse.urlunsplit(("https", host, nxt.path, nxt.query, ""))
    raise LinkError(NOT_A_VIDEO)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def open_once(request: HttpRequest) -> HttpResponse:
    """The production ``Opener``: one https GET to a TikTok host, redirects returned rather than followed."""
    host = (urllib.parse.urlsplit(request.url).hostname or "").lower()
    if not request.url.startswith("https://") or host not in FULL_HOSTS | SHORT_HOSTS:
        raise NetworkError("only TikTok links are opened")
    req = urllib.request.Request(request.url, method="GET", headers=request.headers)  # noqa: S310
    try:
        with _OPENER.open(req, timeout=5) as resp:
            return HttpResponse(resp.status, {k.lower(): v for k, v in resp.headers.items()}, b"")
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
        return HttpResponse(e.code, headers, b"")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NetworkError(type(e).__name__) from e
