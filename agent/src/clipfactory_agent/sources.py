"""Source videos: yt-dlp metadata, audio-only download (capped), and section downloads up to 1080p."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from . import proc
from .util import TransientError, UserFacingError

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


def explain(e: proc.CommandError, platform: str, has_cookies: bool, *, section: bool = False) -> Exception:
    """yt-dlp's error, turned into something the owner can act on (or a retryable error). With ``section``, the
    failure was one clip's piece of video: a 403 (an expired signed URL), a failed fragment or an ffmpeg merge
    failure is then worth another try rather than a verdict on the whole video."""
    t = e.tail.lower()
    if "sign in to confirm" in t or "not a bot" in t:
        if has_cookies:
            return UserFacingError(
                "YouTube is blocking downloads from the cloud and your cookies did not help. "
                "Export fresh cookies in Settings, or upload the video file instead."
            )
        return UserFacingError(
            "YouTube is blocking downloads from the cloud. Add your YouTube cookies in Settings, "
            "or upload the video file instead."
        )
    if "private video" in t or "members-only" in t or "join this channel" in t:
        return UserFacingError("This video is private or members-only, so it can't be downloaded.")
    if "unavailable" in t or "removed" in t or "does not exist" in t or "404" in t:
        return UserFacingError(f"This {platform.capitalize()} video is not available. Check the link.")
    if "live event will begin" in t or "is live" in t or "premieres in" in t:
        return UserFacingError("This stream is still live or has not started. Try again once it has ended.")
    if any(s in t for s in ("timed out", "http error 5", "connection reset", "temporarily", "429")):
        return TransientError(str(e))
    if section and any(s in t for s in ("http error 403", "forbidden", "fragment", "ffmpeg")):
        return TransientError(str(e))
    return UserFacingError(f"The video could not be downloaded from {platform.capitalize()} ({e.tail[:200]}).")


def _cookie_args(cookies: Path | None) -> list[str]:
    return ["--cookies", str(cookies)] if cookies else []


async def video_info(url: str, cookies: Path | None = None) -> dict[str, Any]:
    r = await proc.run(["yt-dlp", "-J", *_COMMON, *_cookie_args(cookies), url], time_limit=180)
    info = json.loads(r.stdout)
    if not isinstance(info, dict):
        raise UserFacingError("The link did not lead to a video.")
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


async def download_audio(
    url: str,
    dest_dir: Path,
    *,
    max_seconds: float | None,
    cookies: Path | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Audio only, as m4a: the cheapest way to listen to an 8-hour stream. Stops at ``max_seconds``."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    args = [
        "yt-dlp",
        *_COMMON,
        *_cookie_args(cookies),
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
    await proc.run([*args, url], time_limit=6 * 3600, on_line=progress_reader(on_progress) if on_progress else None)
    out = dest_dir / "audio.m4a"
    if not out.is_file():
        raise UserFacingError("The audio did not download. Try again, or upload the video file instead.")
    return out


async def download_section(url: str, start: float, end: float, dest: Path, cookies: Path | None = None) -> Path:
    """Just the piece of video a clip needs, up to 1080p, as mp4."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    stem = dest.with_suffix("")
    await proc.run(
        [
            "yt-dlp",
            *_COMMON,
            *_cookie_args(cookies),
            "-f",
            VIDEO_FORMAT,
            "--download-sections",
            f"*{start:.2f}-{end:.2f}",
            "--merge-output-format",
            "mp4",
            "--force-overwrites",
            "-o",
            f"{stem}.%(ext)s",
            url,
        ],
        time_limit=30 * 60,
    )
    for ext in (".mp4", ".mkv", ".webm"):
        f = stem.with_suffix(ext)
        if f.is_file() and f.stat().st_size > 0:
            return f
    raise TransientError("The video section did not download.")


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
