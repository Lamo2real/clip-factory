"""A reference video from its link (docs/CONTRACTS.md §45.40, ADR-88): the ``fetch_reference`` action's job.

The job is a ``PJOB#`` of type ``reference_fetch`` (``contentType = "reference"``, ``contentId = refId``) with one step,
``get`` ("Get the video"). It re-reads the reference (another job is current: it stops), checks the link again with
``reflinks.clean_link`` and needs the reference's own key (``…/references/{refId}/source.mp4``). Then, with every byte
through this fetch's own egress guard (``netguard.Guard``):

* YouTube, TikTok, Instagram, Facebook and X: Clips Funded's own pinned yt-dlp, argument lists only (no shell), the
  allowed extractors only (never ``generic``), no config, no cookies, no playlist; first the facts (``-J``: a live
  video, one over 10 minutes or one bigger than the cap is refused before anything is downloaded), then the download
  (720p at most, H.264 and AAC first, merged into MP4). YouTube gets Clips Funded's own PO token sidecar (``pot.py``,
  the ADR-52 way: ``player_client=default,mweb``), never Clip Factory's.
* A Facebook share link (``/share/r/…``, ``/share/v/…``, ``fb.watch/…``) is opened first through the guard (at most 3
  redirects on Facebook's own hosts, else the page's own ``og:url``); where it leads must be a Facebook video link
  ``reflinks.clean_link`` takes, and only that one goes to yt-dlp.
* Google Drive and Dropbox: one plain HTTPS download through the guard (the direct-download address, at most 3
  redirects, each on the Drive or Dropbox hosts, a sign-in page or an HTML answer means "not shared"), streamed to disk
  with the size capped while reading; the first bytes must be an MP4 or QuickTime ``ftyp``, and after 16 MiB ffprobe
  stops one that is already longer than 10 minutes.

After either: ffprobe must find a video of 10 minutes or less and the file is at most 2 GiB; it is remuxed to MP4 with
``+faststart`` (the original is kept when that fails) and uploaded as the reference's own ``source.mp4``. One fenced
transaction then sets the reference ``ready`` (``bytes``, ``durationSec``, ``fetchedAt``, the video's own title only
while the name is still the site's, ``titleFromLink``) and the job ``ready``; when that write is refused (the reference
was deleted, the job canceled) the uploaded file is deleted again. A failure sets the reference ``fetch_failed`` and
the job ``failed`` with a sentence that names the fix (§45.40.8: every one keeps "Upload a video").

Copied from Clip Factory, never imported (ADR-76): the shape of its yt-dlp options and format string, the kinds of
yt-dlp errors and the progress line (``clipfactory_agent/sources.py``), and the Drive and Dropbox handling
(``contentrewards/fetch.py`` and ``logo.py``), and the PO token sidecar (``pot.py``). Nothing of Clip Factory's cookies,
proxy, PO tokens, Mac fetch or social tokens is used, and yt-dlp's own words reach the log without links or post ids."""

from __future__ import annotations

import asyncio
import contextlib
import html
import http.client
import json
import re
import shutil
import ssl
import time
import urllib.parse
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, Final, Protocol

from . import keys, media, netguard, pot, proc, reflinks
from .pipeline import Job
from .util import JobSuperseded, UserFacingError, log, now_iso

STEPS: Final = ("get",)
LABELS: Final = {"get": "Get the video"}
MAX_BYTES: Final = 2 * 1024 * 1024 * 1024
MAX_SECONDS: Final = 600.5
RESERVE: Final = 512 * 1024 * 1024
MIN_CAP: Final = 200 * 1024 * 1024
PROBE_AFTER: Final = 16 * 1024 * 1024
READ: Final = 1024 * 1024
READ_SECONDS: Final = 30.0
TOTAL_SECONDS: Final = 20 * 60.0
INFO_SECONDS: Final = 120.0
STALL_SECONDS: Final = 120.0
REMUX_SECONDS: Final = 5 * 60.0
MAX_REDIRECTS: Final = 3
TITLE_MAX: Final = 80
USER_AGENT: Final = "ClipsFunded/1"

# yt-dlp's own extractor names (``--use-extractors``, each a regex matched whole), for the allowed platforms only.
# ``generic`` is never here, so a redirect or an embed can never reach an arbitrary page.
EXTRACTORS: Final = ("youtube", "tiktok", r"vm\.tiktok", "instagram", "facebook", "facebook:reel", "twitter")
FORMAT: Final = "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=720]+ba/b[height<=720]/b"
MATCH_FILTER: Final = f"!is_live & duration <=? {MAX_SECONDS}"
_PROGRESS: Final = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
VIDEO_SUFFIXES: Final = (".mp4", ".mov", ".m4v", ".webm", ".mkv")

# Google Drive and Dropbox (copied from Clip Factory's contentrewards/logo.py): the hosts a hop may be on.
DIRECT_HOSTS: Final = frozenset(
    {
        "drive.google.com",
        "drive.usercontent.google.com",
        "docs.google.com",
        "dropbox.com",
        "www.dropbox.com",
        "dl.dropboxusercontent.com",
    }
)
HOP_SUFFIXES: Final = (".dl.dropboxusercontent.com", ".googleusercontent.com")

# What the owner reads (§45.40.8): each one names the fix, and "Upload a video" always stays.
PRIVATE: Final = "That video is private. Pick a public one, or save it and upload it."
BLOCKED: Final = "{site} didn't let us get it. Save the video, then upload it."
GONE: Final = "That video is gone. Check the link."
LIVE: Final = "That's a live video. Pick one that has finished."
TOO_LONG: Final = "This video is longer than 10 minutes. Pick a shorter one."
TOO_BIG: Final = "That video is bigger than 2 GB. Pick a shorter one."
NO_VIDEO: Final = "That link has no video we can get. Save the video, then upload it."
DRIVE_NOT_SHARED: Final = (
    "That file isn't shared. In Google Drive tap Share, then Anyone with the link, then Try again."
)
DROPBOX_NOT_SHARED: Final = "That file isn't shared. In Dropbox tap Share, then Copy link, then paste it again."
UNREACHABLE: Final = "We couldn't reach {site}. Tap Try again."
NO_ROOM: Final = "Clips Funded is busy right now. Tap Try again in a few minutes."
FAILED: Final = "We couldn't get that video. Tap Try again, or save it and upload it."
REF_GONE: Final = "This reference video no longer exists."


class FetchFailed(UserFacingError):
    """The fetch stopped with a sentence for the owner."""


# --- yt-dlp ----------------------------------------------------------------------------------------------------------


def ytdlp_base(proxy: str, site: str = "") -> list[str]:
    """What every yt-dlp call starts with: no config file, one video, no cache, the allowed extractors, the guard;
    for YouTube also the clients and the PO token's script mode (``pot.ytdlp_args``, ADR-52)."""
    return ["yt-dlp", "--ignore-config", "--no-playlist", "--playlist-items", "1", "--no-cache-dir",
            "--use-extractors", ",".join(EXTRACTORS), "--proxy", proxy, "--socket-timeout", "30",
            *(pot.ytdlp_args() if site == "youtube" else [])]  # fmt: skip


def info_args(url: str, proxy: str, site: str = "") -> list[str]:
    """The facts first (``-J``), with the same format choice as the download so its size can be told."""
    return [*ytdlp_base(proxy, site), "-f", FORMAT, "-J", "--", url]


def download_args(url: str, proxy: str, cap: int, out: Path, site: str = "") -> list[str]:
    template = str(out / "source.%(ext)s").replace("%", "%%").replace("%%(ext)s", "%(ext)s")
    return [*ytdlp_base(proxy, site), "--no-mtime", "--retries", "3", "--fragment-retries", "3",
            "--match-filter", MATCH_FILTER, "--max-filesize", str(cap), "-f", FORMAT,
            "--merge-output-format", "mp4", "--remux-video", "mp4", "--newline", "-o", template, "--", url]  # fmt: skip


def proxy_env(proxy: str) -> dict[str, str]:
    """The guard for anything yt-dlp starts too (its ffmpeg, its helpers): every proxy setting, no exceptions."""
    out = {name: proxy for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")}
    out |= {name.lower(): proxy for name in out}
    return out | {"NO_PROXY": "", "no_proxy": ""}


_LINK: Final = re.compile(r"(?:https?:)?//\S+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/\S*", re.IGNORECASE)
_EXTRACTOR_ID: Final = re.compile(r"(\[[\w:.-]+\])\s*[^\s:\]]*[\d_-][^\s:\]]*:")  # an id has a digit, _ or -


def quiet(text: str) -> str:
    """yt-dlp's words for the log, without the post's link or its id (``[youtube] abc123: …`` → ``[youtube] …``)."""
    return _EXTRACTOR_ID.sub(r"\1", _LINK.sub("<link>", text))


def extractors_ok() -> list[str]:
    """The extractor names ``EXTRACTORS`` gives in this yt-dlp (the image's build check): each pattern names at least
    one, and ``generic`` is never among them."""
    from yt_dlp.extractor import gen_extractor_classes

    names = [str(ie.IE_NAME).lower() for ie in gen_extractor_classes()]
    found: list[str] = []
    for pattern in EXTRACTORS:
        hit = [n for n in names if re.fullmatch(pattern, n, re.IGNORECASE)]
        if not hit:
            raise RuntimeError(f"yt-dlp has no extractor {pattern}")
        found += hit
    if "generic" in found:
        raise RuntimeError("the generic extractor must never be allowed")
    return found


def explain(text: str, site: str) -> str:
    """yt-dlp's words (or an HTTP answer's) as the owner's sentence; its own words go to the log, never to him."""
    t = text.lower()
    name = reflinks.SITE_NAMES.get(site, "That site")
    if "private" in t and "rate-limit" not in t:
        return PRIVATE
    if any(s in t for s in ("is live", "live event", "premieres in", "is_upcoming", "upcoming live")):
        return LIVE
    if any(s in t for s in ("longer than 10 minutes", "does not pass filter")):
        return TOO_LONG
    if any(s in t for s in ("max-filesize", "larger than max")):
        return TOO_BIG
    if any(s in t for s in ("sign in to confirm", "not a bot", "login required", "log in", "rate-limit", "rate limit",
                            "http error 403", "http error 429", "forbidden", "too many requests", "cookies",
                            "unable to extract", "blocked")):  # fmt: skip
        return BLOCKED.format(site=name)
    if any(s in t for s in ("unsupported url", "no video formats", "no video could be found", "no video in",
                            "requested format is not available", "there's no video", "not a video")):  # fmt: skip
        return NO_VIDEO
    if any(s in t for s in ("unavailable", "not available", "removed", "does not exist", "http error 404",
                            "not found", "deleted", "gone")):  # fmt: skip
        return GONE
    if any(s in t for s in ("timed out", "timeout", "connection reset", "temporary failure", "name or service",
                            "network is unreachable", "getaddrinfo", "connection refused", "remote end closed",
                            "http error 5", "connection aborted", "eof occurred")):  # fmt: skip
        return UNREACHABLE.format(site=name)
    return FAILED


@dataclass
class Facts:
    title: str | None
    duration: float | None
    estimate: int | None


def clean_title(value: Any) -> str | None:
    """A video's own title as data only: whitespace collapsed, at most 80 characters (never its description)."""
    text = " ".join(str(value or "").split())[:TITLE_MAX].strip()
    return text or None


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def facts(raw: bytes, cap: int) -> Facts:
    """``-J``'s answer, checked before anything is downloaded: live, over 10 minutes, bigger than the cap."""
    try:
        data = json.loads(raw or b"{}")
    except ValueError as e:
        raise FetchFailed(NO_VIDEO) from e
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        entries = [e for e in data["entries"] if isinstance(e, dict)]
        data = entries[0] if entries else None
    if not isinstance(data, dict):
        raise FetchFailed(NO_VIDEO)
    if data.get("is_live") or data.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        raise FetchFailed(LIVE)
    duration = _num(data.get("duration"))
    if duration is not None and duration > MAX_SECONDS:
        raise FetchFailed(TOO_LONG)
    chosen = [f for f in data.get("requested_formats") or [] if isinstance(f, dict)] or [data]
    sizes = [_num(f.get("filesize")) or _num(f.get("filesize_approx")) for f in chosen]
    estimate = int(sum(s for s in sizes if s)) if sizes and all(sizes) else None
    if estimate is not None and estimate > cap:
        raise FetchFailed(TOO_BIG)
    return Facts(clean_title(data.get("title")), duration, estimate)


def found_video(folder: Path) -> Path | None:
    """The file yt-dlp left (``source.mp4`` normally), never a ``.part``."""
    if not folder.is_dir():
        return None
    files = [p for p in folder.iterdir() if p.is_file() and p.name.startswith("source.")
             and p.suffix.lower() in VIDEO_SUFFIXES]  # fmt: skip
    return max(files, key=lambda p: p.stat().st_size, default=None)


# --- Google Drive and Dropbox ----------------------------------------------------------------------------------------


class Answer(Protocol):
    status: int

    def header(self, name: str) -> str: ...

    def read(self, n: int) -> bytes: ...

    def close(self) -> None: ...


Opener = Callable[[str, str, float], Answer]  # (the guard's url, the https url, seconds per read) → the answer


class _HttpAnswer:
    def __init__(self, conn: http.client.HTTPSConnection, response: http.client.HTTPResponse) -> None:
        self._conn = conn
        self._response = response
        self.status = int(response.status)
        self._headers = {k.lower(): v for k, v in response.getheaders()}

    def header(self, name: str) -> str:
        return self._headers.get(name.lower(), "")

    def read(self, n: int) -> bytes:
        return self._response.read(n)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._response.close()
        with contextlib.suppress(Exception):
            self._conn.close()


def https_open(proxy: str, url: str, timeout: float) -> Answer:
    """One GET through the guard (``CONNECT host:443``, then TLS to the host itself); redirects are not followed."""
    via = urllib.parse.urlsplit(proxy)
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    conn = http.client.HTTPSConnection(via.hostname or "127.0.0.1", via.port, timeout=timeout,
                                       context=ssl.create_default_context())  # fmt: skip
    conn.set_tunnel(host, 443)
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    try:
        conn.request("GET", target, headers={"Host": host, "User-Agent": USER_AGENT, "Accept": "*/*",
                                             "Accept-Encoding": "identity"})  # fmt: skip
        return _HttpAnswer(conn, conn.getresponse())
    except BaseException:
        conn.close()
        raise


def direct_url(url: str, site: str) -> str:
    """The address that gives the file itself: Drive's download address (``confirm=t``: no scan page for a big file),
    Dropbox's link with ``dl=1``."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    if site == "drive":
        found = re.search(r"/file/d/([A-Za-z0-9_-]+)", parts.path)
        file_id = found.group(1) if found else (query.get("id") or [""])[0]
        if not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", file_id):
            raise FetchFailed(NO_VIDEO)
        return f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
    kept = {k: v for k, v in query.items() if k == "rlkey"}
    kept["dl"] = ["1"]
    return urllib.parse.urlunsplit(("https", parts.hostname or "", parts.path, urllib.parse.urlencode(kept, doseq=True),
                                    ""))  # fmt: skip


def allowed_hop(url: str) -> bool:
    """https, port 443, no user name, and a Drive or Dropbox host (or one of their download hosts)."""
    parts = urllib.parse.urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or port not in (None, 443) or parts.username or parts.password:
        return False
    host = (parts.hostname or "").lower()
    return host in DIRECT_HOSTS or any(host.endswith(s) for s in HOP_SUFFIXES)


def signin(url: str) -> bool:
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    return host == "accounts.google.com" or (host.endswith("dropbox.com") and "/login" in parts.path)


def title_from_name(name: str) -> str | None:
    """A file's name as a title, the web's ``titleFromName`` rule: no extension, ``_`` and ``-`` as spaces."""
    base = re.sub(r"\.[^.]+$", "", name)
    base = " ".join(re.sub(r"[_-]+", " ", base).split())
    return base[:TITLE_MAX] or None


def title_from_disposition(value: str) -> str | None:
    starred = re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", value)
    if starred:
        return title_from_name(urllib.parse.unquote(starred.group(1).strip().strip('"')))
    plain = re.search(r'filename\s*=\s*"([^"]*)"', value) or re.search(r"filename\s*=\s*([^;]+)", value)
    return title_from_name(plain.group(1).strip()) if plain else None


def download_direct(
    url: str,
    site: str,
    *,
    proxy: str,
    cap: int,
    dest: Path,
    opener: Opener = https_open,
    probe: Callable[[Path], float | None] = lambda _p: None,
    clock: Callable[[], float] = time.monotonic,
) -> str | None:
    """Gets a Drive or Dropbox file into ``dest`` (in a worker thread); its title from the file name, or None.
    ``FetchFailed`` for an answer the owner can act on; network errors as they are."""
    name = reflinks.SITE_NAMES.get(site, "That site")
    private = DRIVE_NOT_SHARED if site == "drive" else DROPBOX_NOT_SHARED
    deadline = clock() + TOTAL_SECONDS
    current = direct_url(url, site)
    for _ in range(MAX_REDIRECTS + 1):
        if signin(current):
            raise FetchFailed(private)
        if not allowed_hop(current):
            log("warn", "stories.fetch_hop_refused", host=urllib.parse.urlsplit(current).hostname or "")
            raise FetchFailed(NO_VIDEO)
        if deadline - clock() <= 0:
            raise TimeoutError("the download took too long")
        answer = opener(proxy, current, READ_SECONDS)
        try:
            if answer.status in (301, 302, 303, 307, 308):
                current = urllib.parse.urljoin(current, answer.header("location"))
                continue
            if answer.status in (401, 403):
                raise FetchFailed(private)
            if answer.status in (404, 410):
                raise FetchFailed(GONE)
            if answer.status == 429 or answer.status >= 500:
                raise FetchFailed(UNREACHABLE.format(site=name))
            if answer.status != 200:
                raise FetchFailed(FAILED)
            if answer.header("content-type").split(";")[0].strip().lower().startswith("text/html"):
                raise FetchFailed(private)  # Drive's sharing or scan page, Dropbox's preview
            length = answer.header("content-length").strip()
            if length.isdigit() and int(length) > cap:
                raise FetchFailed(TOO_BIG)
            _stream(answer, dest, cap, deadline, probe, clock)
            return title_from_disposition(answer.header("content-disposition"))
        finally:
            answer.close()
    raise FetchFailed(NO_VIDEO)  # a fourth redirect


def _stream(
    answer: Answer, dest: Path, cap: int, deadline: float, probe: Callable[[Path], float | None],
    clock: Callable[[], float],
) -> None:  # fmt: skip
    size = 0
    head = b""
    probed = False
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as out:
        while True:
            if clock() > deadline:
                raise TimeoutError("the download took too long")
            chunk = answer.read(READ)
            if not chunk:
                break
            size += len(chunk)
            if size > cap:
                raise FetchFailed(TOO_BIG)
            if len(head) < 12:
                head = (head + chunk)[:12]
                if len(head) == 12 and head[4:8] != b"ftyp":
                    raise FetchFailed(NO_VIDEO)  # not an MP4 or a QuickTime file
            out.write(chunk)
            if not probed and size >= PROBE_AFTER:
                probed = True
                out.flush()
                seconds = probe(dest)
                if seconds is not None and seconds > MAX_SECONDS:
                    raise FetchFailed(TOO_LONG)
    if len(head) < 12:
        raise FetchFailed(NO_VIDEO)


# --- Facebook share links --------------------------------------------------------------------------------------------

FACEBOOK_HOSTS: Final = frozenset(
    {"facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"}
)
SHARE_PAGE_MAX: Final = 1024 * 1024
_PAGE_LINK: Final = re.compile(
    rb"""<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']"""
    rb"""|<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']""",
    re.IGNORECASE,
)


def _facebook_video(candidate: str) -> str | None:
    """A Facebook video link ``clean_link`` takes (never a share link again), cleaned; else None."""
    try:
        url, site = reflinks.clean_link(candidate)
    except reflinks.LinkRefused:
        return None
    return url if site == "facebook" and not reflinks.is_share_link(url) else None


def open_share(url: str, *, proxy: str, opener: Opener = https_open) -> str:
    """Where a Facebook share link leads (in a worker thread, every byte through the guard): at most 3 redirects, each
    on Facebook's own hosts, or the page's own ``og:url`` (or canonical) address. That one must be a Facebook video link
    ``clean_link`` takes; ``FetchFailed`` otherwise (a sign-in wall is "Facebook didn't let us get it")."""
    blocked = BLOCKED.format(site="Facebook")
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        parts = urllib.parse.urlsplit(current)
        try:
            port = parts.port
        except ValueError:
            port = -1
        if parts.scheme != "https" or port not in (None, 443) or parts.username or parts.password:
            raise FetchFailed(NO_VIDEO)
        if (parts.hostname or "").lower() not in FACEBOOK_HOSTS:
            log("warn", "stories.fetch_hop_refused", host=parts.hostname or "")
            raise FetchFailed(NO_VIDEO)
        if "login" in parts.path.lower() or parts.path.startswith("/checkpoint"):
            raise FetchFailed(blocked)
        answer = opener(proxy, current, READ_SECONDS)
        try:
            if answer.status in (301, 302, 303, 307, 308):
                current = urllib.parse.urljoin(current, answer.header("location"))
                found = _facebook_video(current)
                if found:
                    return found
                continue
            if answer.status in (404, 410):
                raise FetchFailed(GONE)
            if answer.status == 429 or answer.status >= 500:
                raise FetchFailed(UNREACHABLE.format(site="Facebook"))
            if answer.status != 200 or "html" not in answer.header("content-type").lower():
                raise FetchFailed(blocked)
            page = b""
            while len(page) < SHARE_PAGE_MAX and (chunk := answer.read(64 * 1024)):
                page += chunk
            for m in _PAGE_LINK.finditer(page[:SHARE_PAGE_MAX]):
                raw = (m.group(1) or m.group(2) or b"").decode("utf-8", "replace")
                found = _facebook_video(html.unescape(raw))
                if found:
                    return found
            raise FetchFailed(blocked)
        finally:
            answer.close()
    raise FetchFailed(NO_VIDEO)  # a fourth redirect


# --- the job ---------------------------------------------------------------------------------------------------------


def room(free: int) -> int:
    """The most bytes one fetch may bring in: 2 GiB, or half of what is free above 512 MiB (video, audio and their
    merge can double the peak); under 200 MiB there is no room."""
    cap = min(MAX_BYTES, (free - RESERVE) // 2)
    if cap < MIN_CAP:
        raise FetchFailed(NO_ROOM)
    return cap


@dataclass
class Got:
    path: Path
    seconds: float
    size: int
    title: str | None


Run = Callable[..., Awaitable[proc.Result]]


class FetchJob(Job):
    step_keys: ClassVar[tuple[str, ...]] = STEPS
    labels: ClassVar[dict[str, str]] = LABELS
    content_types: ClassVar[tuple[str, ...]] = ("reference",)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # What tests replace: the commands (yt-dlp), the guard, the Drive and Dropbox opener, the free disk space.
        self.run_cmd: Run = proc.run
        self.guard: Callable[[int], netguard.Guard] = lambda cap: netguard.Guard(cap=cap)
        self.opener: Opener = https_open
        self.free: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free

    @property
    def _sk(self) -> str:
        return keys.refvid_sk(self.content_id)

    async def _run(self) -> str:
        user_id, workspace_id = self.fence.user_id, self.fence.workspace_id
        ref = await self.data.reference(user_id, workspace_id, self.content_id)
        if ref is not None and ref.get("currentJobId") != self.fence.job_id:
            log("warn", "stories.not_current_job", job=self.fence.job_id, current=ref.get("currentJobId"))
            return "superseded"
        await self._start_running()
        if ref is None:
            return await self._fail(REF_GONE)
        try:
            url, site = reflinks.clean_link(str(ref.get("link") or ""))
        except reflinks.LinkRefused:
            return await self._fail(NO_VIDEO)
        key = str(ref.get("key") or "")
        if key != keys.reference_prefix(user_id, workspace_id, self.content_id) + "source.mp4":
            return await self._fail(REF_GONE)
        self._start("get")
        await self._flush(force=True)
        try:
            got = await self._get(url, site)
            await self.data.upload(self.fence, got.path, key, "video/mp4")
        except JobSuperseded:
            raise
        except Exception as e:
            return await self._fail(str(e) if isinstance(e, FetchFailed) else FAILED, e)
        return await self._done(ref, key, got, site)

    async def _get(self, url: str, site: str) -> Got:
        work = self.work / "get"
        work.mkdir(parents=True, exist_ok=True)
        cap = room(self.free(work))
        async with self.guard(cap) as g:
            try:
                if reflinks.is_share_link(url):  # Facebook's Copy link: where it leads, checked again
                    url = await asyncio.to_thread(open_share, url, proxy=g.url, opener=self.opener)
                if site in reflinks.PLATFORMS:
                    path, title = await self._platform(url, site, g, cap, work)
                else:
                    path, title = await self._direct(url, site, g, cap, work)
            except FetchFailed as e:
                if g.over:
                    raise FetchFailed(TOO_BIG) from e
                raise
            except TimeoutError as e:  # a command's time limit or stall, a read that waited too long
                site_name = reflinks.SITE_NAMES.get(site, "That site")
                raise FetchFailed(TOO_BIG if g.over else UNREACHABLE.format(site=site_name)) from e
            except (OSError, http.client.HTTPException) as e:
                raise FetchFailed(self._why(f"{type(e).__name__} {e}", site, g)) from e
            if g.over:
                raise FetchFailed(TOO_BIG)
        try:
            info = await media.probe(path)
        except Exception as e:
            raise FetchFailed(NO_VIDEO) from e
        if not info.has_video or info.duration <= 0:
            raise FetchFailed(NO_VIDEO)
        if info.duration > MAX_SECONDS:
            raise FetchFailed(TOO_LONG)
        if path.stat().st_size > MAX_BYTES:
            raise FetchFailed(TOO_BIG)
        final = await self._remux(path, work)
        return Got(final, round(info.duration, 2), final.stat().st_size, title)

    @staticmethod
    def _why(text: str, site: str, g: netguard.Guard) -> str:
        """The sentence for a failed fetch: past the cap is too big, a refused address has no video we can get, and
        anything else is read from the tool's own words."""
        if g.over:
            return TOO_BIG
        if g.refused:
            return NO_VIDEO
        return explain(text, site)

    async def _platform(self, url: str, site: str, g: netguard.Guard, cap: int, work: Path) -> tuple[Path, str | None]:
        env = proxy_env(g.url)
        if site == "youtube":
            await pot.ready()  # Clips Funded's own sidecar, started the first time a YouTube link asks
            env |= pot.deno_env()  # the script mode's own read-only Deno cache
        try:
            answer = await self.run_cmd(info_args(url, g.url, site), time_limit=INFO_SECONDS, env=env)
        except proc.CommandError as e:
            log("warn", "stories.fetch_info_failed", site=site, detail=quiet(e.tail)[:500])
            raise FetchFailed(self._why(e.tail, site, g)) from e
        found = facts(answer.stdout, cap)
        said: deque[str] = deque(maxlen=40)

        def line(text: str) -> None:
            said.append(text)
            m = _PROGRESS.search(text)
            if m:
                self.report(min(100, round(float(m.group(1)))), 100)

        try:
            done = await self.run_cmd(download_args(url, g.url, cap, work, site), time_limit=TOTAL_SECONDS,
                                      stall_limit=STALL_SECONDS, on_out_line=line, env=env)  # fmt: skip
        except proc.CommandError as e:
            log("warn", "stories.fetch_failed", site=site, detail=quiet(e.tail)[:500])
            raise FetchFailed(self._why(f"{e.tail} {' '.join(said)}", site, g)) from e
        path = found_video(work)
        if path is None:
            words = f"{' '.join(said)} {done.stderr}"
            log("warn", "stories.fetch_no_file", site=site, detail=quiet(words)[-500:])
            sentence = explain(words, site)
            raise FetchFailed(sentence if sentence in (TOO_BIG, TOO_LONG, LIVE) else NO_VIDEO)
        return path, found.title

    async def _direct(self, url: str, site: str, g: netguard.Guard, cap: int, work: Path) -> tuple[Path, str | None]:
        dest = work / "source.download"
        loop = asyncio.get_running_loop()

        def partial(path: Path) -> float | None:  # in the worker thread: ffprobe on the event loop, waited for here
            try:
                return asyncio.run_coroutine_threadsafe(media.probe(path), loop).result(timeout=90).duration
            except Exception:
                return None

        title = await asyncio.to_thread(
            download_direct, url, site, proxy=g.url, cap=cap, dest=dest, opener=self.opener, probe=partial
        )
        return dest, title

    async def _remux(self, path: Path, work: Path) -> Path:
        """MP4 with ``+faststart`` (it plays at once in the page); the original stays when that fails."""
        out = work / "out" / "source.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        args = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
                "-movflags", "+faststart", str(out)]  # fmt: skip
        try:
            await proc.run(args, time_limit=REMUX_SECONDS)
        except Exception as e:
            log("warn", "stories.fetch_remux_failed", job=self.fence.job_id, error=type(e).__name__)
            return path
        return out if out.is_file() and out.stat().st_size > 0 else path

    async def _done(self, ref: Mapping[str, Any], key: str, got: Got, site: str) -> str:
        step = self._step("get")
        step.update({"status": "done", "finishedAt": now_iso()})
        step.pop("i", None)
        step.pop("n", None)
        self.current = None
        at = now_iso()
        fields: dict[str, Any] = {"status": "ready", "bytes": got.size, "durationSec": got.seconds, "fetchedAt": at}
        named = bool(ref.get("titleFromLink")) and bool(got.title)
        if named:
            fields["title"] = got.title
        job_fields = {"status": "ready", "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": at}
        mine = {"currentJobId": self.fence.job_id}
        remove = ["currentJobId", "titleFromLink"]
        try:
            try:
                # The video's own title only while the name is still the site's: a rename meanwhile wins.
                conds = {**mine, "titleFromLink": True} if named else mine
                await self._last_write(other_set=(self._sk, fields, conds), other_remove=remove, job_fields=job_fields)
            except JobSuperseded:
                if not named:
                    raise
                now = await self.data.reference(self.fence.user_id, self.fence.workspace_id, self.content_id)
                if now is None or now.get("currentJobId") != self.fence.job_id or now.get("titleFromLink"):
                    raise
                fields.pop("title", None)
                await self.data.write(self.fence, other_set=(self._sk, fields, mine), other_remove=remove,
                                      job_fields=job_fields)  # fmt: skip
        except JobSuperseded:
            await self._discard(key)
            raise
        log("info", "stories.reference_fetched", job=self.fence.job_id, site=site, bytes=got.size)
        return "ready"

    async def _discard(self, key: str) -> None:
        """The final write was refused (the reference deleted, the job canceled): the file just uploaded goes again,
        best effort, unless another run now owns the reference or its file is the one it has."""
        try:
            now = await self.data.reference(self.fence.user_id, self.fence.workspace_id, self.content_id)
            if now is not None and (now.get("currentJobId") or now.get("status") in ("ready", "analyzing", "analyzed",
                                                                                     "failed")):  # fmt: skip
                return
            await self.data.delete_files(self.fence, [key])
            log("info", "stories.fetch_discarded", job=self.fence.job_id)
        except Exception as e:
            log("warn", "stories.fetch_discard_failed", job=self.fence.job_id, error=type(e).__name__)

    async def _fail(self, sentence: str, error: BaseException | None = None) -> str:
        if error is not None:
            log("warn", "stories.fetch_failed_job", job=self.fence.job_id, error=type(error).__name__,
                detail=quiet(str(error))[:600])  # fmt: skip
        if not any(s.get("key") == "get" for s in self.steps):
            self.steps.append({"key": "get", "label": LABELS["get"], "status": "pending"})
        self._step("get").update({"status": "failed", "message": sentence, "finishedAt": now_iso()})
        at = now_iso()
        ref = await self.data.reference(self.fence.user_id, self.fence.workspace_id, self.content_id)
        other = None
        if ref is not None and ref.get("currentJobId") == self.fence.job_id:
            other = (self._sk, {"status": "fetch_failed"}, {"currentJobId": self.fence.job_id})
        await self._last_write(
            other_set=other,
            other_remove=["currentJobId"] if other else (),
            job_fields={"status": "failed", "error": sentence, "steps": self.steps, "progress": self._progress(),
                        "meta": self.meta, "heartbeatAt": at},
        )  # fmt: skip
        return "failed"
