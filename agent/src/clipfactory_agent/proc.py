"""Running ffmpeg, ffprobe and yt-dlp without blocking the event loop, killed on cancel or timeout."""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

_INTERESTING = re.compile(r"error|unable|denied|not |fail|forbidden|sign in|private|unavailable", re.IGNORECASE)


class CommandError(Exception):
    def __init__(self, cmd: str, code: int | None, tail: str) -> None:
        self.cmd = cmd
        self.code = code
        self.tail = tail
        super().__init__(f"{cmd} failed (exit {code}). {tail}".strip())


@dataclass
class Result:
    stdout: bytes
    stderr: str


def error_tail(text: str, lines: int = 3) -> str:
    """The last few lines that say what went wrong, short enough for a log line or an error message."""
    picked = [ln.strip() for ln in text.splitlines() if _INTERESTING.search(ln)]
    if not picked:
        picked = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return " ".join(picked[-lines:])[:500]


async def run(
    args: Sequence[str],
    *,
    time_limit: float = 3600,
    on_line: Callable[[str], None] | None = None,
    cwd: Path | None = None,
) -> Result:
    """Runs a command; raises CommandError on a non-zero exit. stderr lines go to ``on_line`` as they arrive."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        cwd=str(cwd) if cwd else None,
    )
    err_lines: list[str] = []

    async def read_err() -> None:
        assert proc.stderr is not None
        buf = b""
        while chunk := await proc.stderr.read(4096):
            buf += chunk
            *done, buf = re.split(rb"[\r\n]", buf)
            for raw in done:
                line = raw.decode("utf-8", "replace")
                if line.strip():
                    err_lines.append(line)
                    if on_line:
                        on_line(line)
            del err_lines[:-400]  # ffmpeg can print millions of lines on a long file
        if buf.strip():
            err_lines.append(buf.decode("utf-8", "replace"))

    async def read_out() -> bytes:
        assert proc.stdout is not None
        return await proc.stdout.read()

    try:
        out, _ = await asyncio.wait_for(asyncio.gather(read_out(), read_err()), time_limit)
        code = await proc.wait()
    except BaseException:
        # Timeout or cancel: never leave a 6-hour download running behind a canceled job.
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        raise
    stderr = "\n".join(err_lines)
    if code != 0:
        raise CommandError(Path(args[0]).name, code, error_tail(stderr))
    return Result(out, stderr)


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    has_audio: bool
    has_video: bool


def parse_probe(data: bytes) -> MediaInfo:
    j = json.loads(data or b"{}")
    streams = j.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    duration = float((j.get("format") or {}).get("duration") or 0)
    return MediaInfo(
        duration=duration,
        width=int((video or {}).get("width") or 0),
        height=int((video or {}).get("height") or 0),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        has_video=video is not None,
    )


async def probe(src: str) -> MediaInfo:
    r = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
            "-of",
            "json",
            src,
        ],
        time_limit=300,
    )
    return parse_probe(r.stdout)
