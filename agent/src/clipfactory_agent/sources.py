"""Source videos: yt-dlp metadata, audio-only download (capped), the small picture download for the deep analysis,
and section downloads up to 1080p."""

from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from . import livestatus, proc
from .picture import DISK_RESERVE
from .util import NeedsMac, TransientError, UserFacingError, log

_HOSTS: dict[str, re.Pattern[str]] = {
    "youtube": re.compile(r"(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$"),
    "twitch": re.compile(r"(^|\.)twitch\.tv$"),
    "kick": re.compile(r"(^|\.)kick\.com$"),
}
_PROGRESS = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
_COMMON = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--socket-timeout",
    "30",
    "--no-cache-dir",
]
# YouTube from a cloud IP (docs/CONTRACTS.md §29.3): yt-dlp's default clients plus mweb, a PO token from the bgutil
# sidecar (pot.py; its HTTP provider needs no arguments, the script provider is the backup when the sidecar is down),
# and warnings ON, so "the cookies are no longer valid" reaches the error tail and explain() can say so.
_YOUTUBE_BASE = [a for a in _COMMON if a != "--no-warnings"]
YOUTUBE_CLIENTS = "youtube:player_client=default,mweb"
VIDEO_FORMAT = "bv*[height<=1080][vcodec^=avc1]+ba/bv*[height<=1080]+ba/b[height<=1080]/b"
# Audio only where the site has it (YouTube, Twitch's Audio_Only). Kick's VOD playlists have no audio-only rendition:
# then the smallest stream that has sound ("wa*": worst with audio, video allowed), never the 1080p60 one.
AUDIO_FORMAT = "ba[ext=m4a]/ba/Audio_Only/wa*/w"


def platform_of(url: str) -> str | None:
    try:
        u = urlparse(url)
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    host = u.hostname.lower()
    return next((name for name, pattern in _HOSTS.items() if pattern.search(host)), None)


def check_link(url: str) -> str:
    platform = platform_of(url)
    if not platform:
        raise UserFacingError("That link is not a YouTube, Twitch or Kick video. Paste the link of one video.")
    return platform


PLATFORM_NAMES = {
    "youtube": "YouTube",
    "twitch": "Twitch",
    "kick": "Kick",
    "tiktok": "TikTok",
    "instagram": "Instagram",
}


def platform_name(platform: str) -> str:
    """The brand's own spelling of a platform id ("youtube" -> "YouTube"), for messages the owner reads."""
    return PLATFORM_NAMES.get(platform, platform.title())


# What the owner reads when YouTube says no (docs/CONTRACTS.md §29.5). Every one names a real button: "Try again" or
# "Use a video file" (the failed job's button that opens New job with the file picker).
BLOCKED_NO_COOKIES = (
    "YouTube stopped the cloud from getting this video. Tap Use a video file, "
    "or add your YouTube cookies in Settings › YouTube help."
)
BLOCKED_WITH_COOKIES = (
    "YouTube stopped the cloud from getting this video, even with your cookies. Tap Use a video file, "
    "or get new cookies in Settings › YouTube help."
)
COOKIES_EXPIRED = "Your YouTube cookies ran out. Get new ones in Settings › YouTube help, then tap Try again."
CUT_BLOCKED = (
    "YouTube stopped the cloud while cutting the clips. Tap Try again. If it stops again, tap Use a video file."
)
CUT_TOO_BIG = "This video is too long to cut in the cloud right now. Tap Use a video file, or try a shorter video."
CUT_FAILED = "The clips could not be cut this time. Tap Try again, or tap Use a video file."
OWNER_WORDS = (BLOCKED_NO_COOKIES, BLOCKED_WITH_COOKIES, COOKIES_EXPIRED, CUT_BLOCKED, CUT_TOO_BIG, CUT_FAILED)

# How a download failed, for the Cut step's fallback (never shown): "blocked" (the bot check), "cookies" (rotated or
# expired), "gone" (private, removed, live), "retry" (a section's 403, fragment or merge failure), "transient" (a
# network blip, retried as is), "other".
KINDS = ("blocked", "cookies", "gone", "retry", "transient", "other")


def _kinded[E: Exception](e: E, kind: str) -> E:
    e.kind = kind  # type: ignore[attr-defined]
    return e


def kind_of(e: BaseException) -> str:
    return str(getattr(e, "kind", "other"))


def explain(e: proc.CommandError, platform: str, has_cookies: bool, *, section: bool = False) -> Exception:
    """yt-dlp's error, turned into something the owner can act on (or a retryable error). With ``section``, the
    failure was one clip's piece of video: a 403 (an expired signed URL), a failed fragment or an ffmpeg merge
    failure is then worth another try rather than a verdict on the whole video. The result carries a ``kind``
    (``KINDS``) the Cut step uses to pick its fallback."""
    t = e.tail.lower()
    bot = "sign in to confirm" in t or "not a bot" in t
    # yt-dlp only WARNS that the cookies are stale and goes on signed out, so the warning is the cause only when the
    # error itself is the bot check or a sign-in wall. A 403, fragment or ffmpeg error with the warning in the tail
    # stays a "retry", so the Cut step's fallback still runs.
    stale = has_cookies and "cookies are no longer valid" in t
    if stale and (bot or "sign in" in t.replace("cookies are no longer valid", "") or "login required" in t):
        log("warn", "download.cookies_expired", platform=platform, detail=e.tail[:500])
        return _kinded(UserFacingError(COOKIES_EXPIRED), "cookies")
    if bot:
        log("warn", "download.blocked", platform=platform, cookies=has_cookies, detail=e.tail[:500])
        return _kinded(UserFacingError(BLOCKED_WITH_COOKIES if has_cookies else BLOCKED_NO_COOKIES), "blocked")
    if "private video" in t or "members-only" in t or "join this channel" in t:
        return _kinded(UserFacingError("This video is private or members-only, so it can't be downloaded."), "gone")
    if "unavailable" in t or "removed" in t or "does not exist" in t or "404" in t:
        return _kinded(
            UserFacingError(f"This {platform_name(platform)} video is not available. Check the link."), "gone"
        )
    if "live event will begin" in t or "is live" in t or "premieres in" in t:
        return _kinded(
            UserFacingError("This stream is still live or has not started. Try again once it has ended."), "gone"
        )
    # A section's 429 (rate limited, common from cloud IPs) goes to the fallback, which asks YouTube far less often.
    if section and any(s in t for s in ("http error 403", "forbidden", "fragment", "ffmpeg", "http error 429")):
        return _kinded(TransientError(str(e)), "retry")
    if any(s in t for s in ("timed out", "http error 5", "connection reset", "temporarily", "429")):
        return _kinded(TransientError(str(e)), "transient")
        return _kinded(TransientError(str(e)), "retry")
    # yt-dlp's own words go to the log, never to the owner.
    log("warn", "download.failed", platform=platform, detail=e.tail[:500])
    return _kinded(
        UserFacingError(
            f"The video could not be downloaded from {platform_name(platform)}. Check the link and tap Try again, "
            "or tap Use a video file."
        ),
        "other",
    )


def mac_can_help(e: BaseException, platform: str | None, tail: str = "") -> bool:
    """Whether the owner's own computer can get this video when the cloud could not (docs/CONTRACTS.md §35.1): only
    for YouTube, and only when YouTube refused the cloud (the bot check, run-out cookies) or a download stayed
    forbidden (a 403). A private, removed or live video is the same everywhere, so it fails as before."""
    if platform != "youtube":
        return False
    if kind_of(e) in ("blocked", "cookies"):
        return True
    return "http error 403" in tail.lower()


def explain_or_mac(e: proc.CommandError, platform: str, has_cookies: bool, *, mac_ok: bool) -> Exception:
    """``explain``, except that, for a job the owner's Mac may fetch (``mac_ok``), a failure the Mac can get past
    becomes ``NeedsMac`` (§35.1)."""
    err = explain(e, platform, has_cookies)
    if mac_ok and mac_can_help(err, platform, e.tail):
        log("info", "download.needs_mac", platform=platform, kind=kind_of(err))
        return NeedsMac(kind_of(err))
    return err


def _cookie_args(cookies: Path | None) -> list[str]:
    return ["--cookies", str(cookies)] if cookies else []


@contextlib.contextmanager
def _own_cookies(cmd: list[str], cookies: Path | None) -> Iterator[list[str]]:
    """``cmd`` with its own copy of the cookies file (mode 0600, removed afterwards): yt-dlp writes the jar back when
    it exits, so parallel calls sharing one file could read it half-written."""
    if cookies is None or not cookies.is_file():
        yield cmd
        return
    fd, name = tempfile.mkstemp(prefix=".cookies-", suffix=".txt", dir=cookies.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(cookies.read_bytes())
        yield [name if a == str(cookies) else a for a in cmd]
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


async def _run(cmd: list[str], cookies: Path | None, **kw: Any) -> proc.Result:
    with _own_cookies(cmd, cookies) as own:
        return await proc.run(own, **kw)


def youtube_args(cookies: Path | None = None, proxy: str | None = None) -> list[str]:
    """The extra yt-dlp arguments every YouTube call gets (docs/CONTRACTS.md §29.3)."""
    out = ["--extractor-args", YOUTUBE_CLIENTS]
    home = os.environ.get("CF_POT_HOME")
    if home:
        out += ["--extractor-args", f"youtubepot-bgutilscript:server_home={home}"]
    out += _cookie_args(cookies)
    if proxy:
        out += ["--proxy", proxy]
    return out


def _args(platform: str | None, cookies: Path | None = None, proxy: str | None = None) -> list[str]:
    """The common yt-dlp arguments for one site: YouTube gets its clients, the PO token, cookies and the optional
    proxy; Twitch and Kick keep exactly what they had."""
    if platform == "youtube":
        return [*_YOUTUBE_BASE, *youtube_args(cookies, proxy)]
    return [*_COMMON, *_cookie_args(cookies)]


async def video_info(
    url: str, cookies: Path | None = None, *, proxy: str | None = None, info_json: Path | None = None
) -> dict[str, Any]:
    """yt-dlp's ``-J`` for the link. With ``info_json`` the same JSON is also written there, so later downloads can
    ``--load-info-json`` it instead of asking YouTube again (one extraction per Cut step, §29.4)."""
    r = await _run(["yt-dlp", "-J", *_args(platform_of(url), cookies, proxy), url], cookies, time_limit=180)
    info = json.loads(r.stdout)
    if not isinstance(info, dict):
        raise UserFacingError("The link did not lead to a video.")
    if info_json is not None:
        # A temp file then a rename: a parallel cut may be reading the old file with --load-info-json right now.
        info_json.parent.mkdir(parents=True, exist_ok=True)
        tmp = info_json.with_name(f".{info_json.name}.{os.getpid()}.{id(r)}.tmp")
        tmp.write_bytes(r.stdout)
        os.replace(tmp, info_json)
    return info


def source_fields(info: dict[str, Any], platform: str) -> dict[str, Any]:
    """The Source fields (docs/CONTRACTS.md §5) yt-dlp knows about."""
    out: dict[str, Any] = {"platform": platform}
    title = info.get("title") or info.get("fulltitle")
    if title:
        out["title"] = str(title)[:300]
    channel = info.get("channel") or info.get("uploader") or info.get("creator")
    if channel:
        out["channel"] = str(channel)[:200]
    # The channel's id when the site gives one: the creator key (creators.py) prefers it to the name (§16.12).
    channel_id = info.get("channel_id") or info.get("uploader_id")
    if channel_id:
        out["channelId"] = str(channel_id)[:200]
    if info.get("duration"):
        out["durationSec"] = float(info["duration"])
    if info.get("thumbnail"):
        out["thumbnailUrl"] = str(info["thumbnail"])
    return out


def heatmap(info: dict[str, Any]) -> list[dict[str, float]]:
    """YouTube's "most replayed" graph, when yt-dlp has it."""
    rows = info.get("heatmap") or []
    return [
        {"start": float(h["start_time"]), "end": float(h["end_time"]), "value": float(h["value"])}
        for h in rows
        if isinstance(h, dict) and {"start_time", "end_time", "value"} <= h.keys()
    ]


def progress_reader(on_progress: Callable[[float], None]) -> Callable[[str], None]:
    def read(line: str) -> None:
        m = _PROGRESS.search(line)
        if m:
            on_progress(min(1.0, float(m.group(1)) / 100))

    return read


def _live_reader(*, full: bool = False) -> Callable[[str], None]:
    """yt-dlp's progress lines to the live status line ("412 MB of 1.2 GB · 34%", §31)."""

    def read(line: str) -> None:
        seen = livestatus.parse_ytdlp(line)
        if seen is not None:
            livestatus.emit("download", full=full, **seen)

    return read


async def download_audio(
    url: str,
    dest_dir: Path,
    *,
    max_seconds: float | None,
    cookies: Path | None = None,
    proxy: str | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Audio only, as m4a: the cheapest way to listen to an 8-hour stream. Stops at ``max_seconds``."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    args = [
        "yt-dlp",
        *_args(platform_of(url), cookies, proxy),
        "-f",
        AUDIO_FORMAT,
        "-x",
        "--audio-format",
        "m4a",
        "--concurrent-fragments",
        "8",
        "--force-overwrites",
        "-o",
        str(dest_dir / "audio.%(ext)s"),
    ]
    if max_seconds:
        args += ["--download-sections", f"*0-{int(max_seconds)}"]
    bar = progress_reader(on_progress) if on_progress else None

    def read(line: str) -> None:
        if bar is not None:
            bar(line)
        seen = livestatus.parse_ytdlp(line)
        if seen is not None:
            livestatus.emit("download", **seen)  # "412 MB of 1.2 GB · 34%", "yt-dlp · 4.1 MB/s" (§31)

    await _run([*args, url], cookies, time_limit=6 * 3600, on_line=read)
    out = dest_dir / "audio.m4a"
    if not out.is_file():
        raise UserFacingError("The audio did not download. Try again, or upload the video file instead.")
    return out


async def download_section(
    url: str,
    start: float,
    end: float,
    dest: Path,
    cookies: Path | None = None,
    *,
    proxy: str | None = None,
    info_json: Path | None = None,
) -> Path:
    """Just the piece of video a clip needs, up to 1080p, as mp4. With ``info_json`` (YouTube's ``-J`` saved once
    for the Cut step) yt-dlp reads the formats from that file and does not ask YouTube's player again."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    stem = dest.with_suffix("")
    platform = "youtube" if info_json is not None else platform_of(url)
    source = ["--load-info-json", str(info_json)] if info_json is not None else [url]
    await _run(
        [
            "yt-dlp",
            *_args(platform, cookies, proxy),
            "-f",
            VIDEO_FORMAT,
            "--download-sections",
            f"*{start:.2f}-{end:.2f}",
            "--merge-output-format",
            "mp4",
            "--force-overwrites",
            "-o",
            f"{stem}.%(ext)s",
            *source,
        ],
        cookies,
        time_limit=30 * 60,
    )
    for ext in (".mp4", ".mkv", ".webm"):
        f = stem.with_suffix(ext)
        if f.is_file() and f.stat().st_size > 0:
            return f
    raise _kinded(TransientError("The video section did not download."), "retry")


# The Cut step's last resort for YouTube (§29.4): the whole video once, at the tallest height that fits the disk.
FULL_LADDER = (
    (1080, VIDEO_FORMAT),
    (720, "bv*[height<=720][vcodec^=avc1]+ba/bv*[height<=720]+ba/b[height<=720]/b"),
    (480, "bv*[height<=480][vcodec^=avc1]+ba/bv*[height<=480]+ba/b[height<=480]/b"),
)
FULL_TIME_LIMIT = 90 * 60
# A cautious download speed for the time check (bytes per second): a rung that would take longer than the time limit
# at this speed is skipped like one that does not fit the disk.
FULL_ASSUMED_RATE = 4_000_000
# When yt-dlp knows no size or bitrate for a rendition: a cautious bitrate (bits per second) per height, never 0.
FULL_DEFAULT_BITRATE = {1080: 5_000_000, 720: 2_500_000, 480: 1_200_000}


def full_format(
    info: dict[str, Any],
    seconds: float,
    free_bytes: int,
    reserve: int = DISK_RESERVE,
    *,
    time_limit: float = FULL_TIME_LIMIT,
    rate: float = FULL_ASSUMED_RATE,
) -> dict[str, Any] | None:
    """The format for the one full download, or None when not even 480p leaves ``reserve`` bytes free and finishes
    within ``time_limit`` at ``rate``. The size of a rung is its tallest H.264 video up to that height (else any video
    up to it) plus the best audio, plus 10%. A rendition with no known size counts at ``FULL_DEFAULT_BITRATE``."""
    formats = [f for f in info.get("formats") or [] if isinstance(f, dict)]
    audio = [
        f for f in formats if str(f.get("vcodec") or "none") == "none" and str(f.get("acodec") or "none") != "none"
    ]
    # Sizes are for the whole video; ``seconds`` may be a part of it (a range download), so scale them down.
    total = max(float(info.get("duration") or 0), seconds, 1.0)
    share = max(0.0, seconds) / total

    def size(f: dict[str, Any], bitrate: int) -> int:
        return int(_estimate_bytes(f, total, bitrate) * share)

    audio_bytes = max((size(f, 160_000) for f in audio), default=int(160_000 * seconds / 8))
    videos = [f for f in formats if _has_video(f)]
    for height, fmt in FULL_LADDER:
        fit = [f for f in videos if int(f["height"]) <= height]
        avc = [f for f in fit if str(f.get("vcodec") or "").startswith("avc1")]
        pool = avc or fit
        if not pool:
            continue
        top = max(int(f["height"]) for f in pool)
        fallback = FULL_DEFAULT_BITRATE.get(height, FULL_DEFAULT_BITRATE[480])
        best = max((f for f in pool if int(f["height"]) == top), key=lambda f: size(f, fallback))
        has_sound = str(best.get("acodec") or "none") != "none"
        est = int((size(best, fallback) + (0 if has_sound else audio_bytes)) * 1.1)
        if est <= free_bytes - reserve and est / rate <= time_limit:
            return {"format": fmt, "height": top, "estBytes": est}
    return None


async def download_full(
    url: str,
    fmt: str,
    dest: Path,
    *,
    est_bytes: int,
    cookies: Path | None = None,
    proxy: str | None = None,
    info_json: Path | None = None,
    section: tuple[float, float] | None = None,
) -> Path:
    """The whole video once, as mp4, for the Cut step to cut every remaining clip from (YouTube only). With
    ``section`` only that range (from, to in seconds), when the clips sit in a small part of a long video."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    stem = dest.with_suffix("")
    source = ["--load-info-json", str(info_json)] if info_json is not None else [url]
    args = [
        "yt-dlp",
        *_args("youtube", cookies, proxy),
        "-f",
        fmt,
        "--merge-output-format",
        "mp4",
        "--http-chunk-size",
        "10M",
        "--force-overwrites",
        "-o",
        f"{stem}.%(ext)s",
    ]
    if section is not None:
        # No --max-filesize here: yt-dlp would compare it with the whole video's size, not the range's.
        args += ["--download-sections", f"*{section[0]:.2f}-{section[1]:.2f}"]
    elif est_bytes > 0:
        args += ["--max-filesize", str(int(est_bytes * 1.5))]
    await _run([*args, *source], cookies, time_limit=FULL_TIME_LIMIT, on_line=_live_reader(full=True))
    for ext in (".mp4", ".mkv", ".webm"):
        f = stem.with_suffix(ext)
        if f.is_file() and f.stat().st_size > 0:
            return f
    raise _kinded(TransientError("The full video did not download."), "retry")


PICTURE_HEIGHTS = (480, 360)  # the ladder for the analysis picture: enough to see what happens, small enough to keep
PICTURE_MAX_FPS = 30
PICTURE_DEFAULT_BITRATE = 800_000  # bits per second, when yt-dlp knows neither a size nor a bitrate
PICTURE_TIME_LIMIT = 2 * 3600


def _estimate_bytes(f: dict[str, Any], seconds: float, default_bitrate: int = PICTURE_DEFAULT_BITRATE) -> int:
    """How big one rendition is: its size, its rough size, its bitrate times the length, else ``default_bitrate``
    (bits per second; 0.8 Mbit/s for the analysis picture)."""
    for k in ("filesize", "filesize_approx"):
        if f.get(k):
            return int(f[k])
    tbr = float(f.get("tbr") or f.get("vbr") or 0)  # kbit/s
    bits = tbr * 1000 if tbr > 0 else default_bitrate
    return int(bits * max(0.0, seconds) / 8)


def _has_video(f: dict[str, Any]) -> bool:
    return bool(f.get("format_id")) and str(f.get("vcodec") or "none") != "none" and int(f.get("height") or 0) > 0


def picture_format(
    info: dict[str, Any], seconds: float, free_bytes: int, reserve: int = DISK_RESERVE
) -> dict[str, Any] | None:
    """The rendition the deep analysis watches, chosen from the ``-J`` output already fetched, or None when none
    fits the disk. The ladder: every H.264 rendition up to 480p and 30 fps, tallest first, a video-only one before
    one with sound in it at the same height (Twitch and Kick only have those; the ffmpeg pass drops the sound). Last
    comes the smallest rendition with a picture. The first whose estimated size leaves ``reserve`` bytes free wins."""
    formats = [f for f in info.get("formats") or [] if isinstance(f, dict) and _has_video(f)]
    if not formats:
        return None
    fit = [
        f
        for f in formats
        if str(f.get("vcodec") or "").startswith("avc1")
        and int(f["height"]) <= max(PICTURE_HEIGHTS)
        and float(f.get("fps") or 0) <= PICTURE_MAX_FPS
    ]
    rungs = sorted(
        fit,
        key=lambda f: (int(f["height"]), str(f.get("acodec") or "none") == "none", float(f.get("tbr") or 0)),
        reverse=True,
    )
    smallest = min(formats, key=lambda f: (int(f["height"]), _estimate_bytes(f, seconds)))
    ladder: list[dict[str, Any]] = []
    for f in (*rungs, smallest):
        if f is not None and f not in ladder:
            ladder.append(f)
    for f in ladder:
        est = _estimate_bytes(f, seconds)
        if est <= free_bytes - reserve:
            return {
                "formatId": str(f["format_id"]),
                "height": int(f["height"]),
                "fps": round(float(f.get("fps") or 0), 2),
                "estBytes": est,
            }
    return None


async def download_picture(
    url: str,
    format_id: str,
    dest: Path,
    *,
    est_bytes: int,
    max_seconds: float | None,
    cookies: Path | None = None,
    proxy: str | None = None,
) -> Path:
    """The whole picture in the chosen small rendition (no sound), for the deep analysis. yt-dlp's own downloader
    with eight fragments at a time; ``--download-sections`` only when the source is capped, as the audio does."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    stem = dest.with_suffix("")
    args = [
        "yt-dlp",
        *_args(platform_of(url), cookies, proxy),
        "-f",
        format_id,
        "--concurrent-fragments",
        "8",
        "--force-overwrites",
        "-o",
        f"{stem}.%(ext)s",
    ]
    if est_bytes > 0:
        args += ["--max-filesize", str(int(est_bytes * 1.5))]
    if max_seconds:
        args += ["--download-sections", f"*0-{int(max_seconds)}"]
    await _run([*args, url], cookies, time_limit=PICTURE_TIME_LIMIT, on_line=_live_reader())
    for f in sorted(stem.parent.glob(stem.name + ".*")):
        if f.suffix not in (".part", ".ytdl") and f.is_file() and f.stat().st_size > 0:
            return f
    raise TransientError("The picture did not download.")


def url_at(url: str, platform: str, seconds: float) -> str | None:
    """A link that opens the source at ``seconds`` (YouTube and Twitch support it; Kick does not)."""
    s = max(0, int(seconds))
    u = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(u.query) if k != "t"]
    if platform == "youtube":
        query.append(("t", f"{s}s"))
    elif platform == "twitch":
        query.append(("t", f"{s // 3600}h{s // 60 % 60}m{s % 60}s"))
    else:
        return None
    return urlunparse(u._replace(query=urlencode(query)))
