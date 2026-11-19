"""Running ffmpeg, ffprobe and yt-dlp without blocking the event loop, killed on cancel or timeout.

Every child runs in its own process group, and a timeout, a cancel or any error kills the whole group (SIGTERM, then
SIGKILL after a few seconds), so yt-dlp's own ffmpeg never outlives it. On Linux each child also asks the kernel to
pick it first when memory runs out (``oom_score_adj`` 1000): one clip's ffmpeg is lost instead of the agent, its
heartbeat and the whole job (docs/CONTRACTS.md §30)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import redact_urls

_INTERESTING = re.compile(r"error|unable|denied|not |fail|forbidden|sign in|private|unavailable", re.IGNORECASE)


_STALE_COOKIES = "cookies are no longer valid"
OOM_SCORE_FILE = Path("/proc/self/oom_score_adj")
OOM_SCORE = 1000  # the most likely to be picked by the kernel's out-of-memory killer
KILL_GRACE = 5.0  # seconds between SIGTERM and SIGKILL
KILLED_CODES = (-signal.SIGKILL, 128 + signal.SIGKILL)  # what the kernel's out-of-memory kill looks like


class StalledError(TimeoutError):
    """The command printed nothing for ``stall_limit`` seconds and was killed."""


class CommandError(Exception):
    def __init__(self, cmd: str, code: int | None, tail: str) -> None:
        self.cmd = cmd
        self.code = code
        self.tail = redact_urls(tail)  # ffmpeg/ffprobe print the input URL, presigned query string and all
        tail = self.tail
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
    tail = picked[-lines:]
    # yt-dlp's "the cookies are no longer valid" warning comes early; it is what tells the owner's cookies ran out.
    stale = next((ln.strip() for ln in text.splitlines() if _STALE_COOKIES in ln), None)
    if stale and stale not in tail:
        tail.insert(0, stale[:200])
    return " ".join(tail)[:500]


def oom_first(args: Sequence[str]) -> list[str]:
    """``args`` behind a tiny ``sh`` that sets the child's ``oom_score_adj`` to 1000 and then ``exec``s it (Linux only;
    elsewhere the command is unchanged). A shell rather than ``preexec_fn``, which is unsafe with threads running."""
    if not OOM_SCORE_FILE.exists():
        return list(args)
    return ["sh", "-c", f'echo {OOM_SCORE} > {OOM_SCORE_FILE} 2>/dev/null; exec "$@"', "sh", *args]


def was_killed(e: BaseException) -> bool:
    """True when a command died of SIGKILL: on the agent that is the kernel's out-of-memory killer."""
    return isinstance(e, CommandError) and e.code in KILLED_CODES


async def kill_group(proc: asyncio.subprocess.Process, grace: float = KILL_GRACE) -> None:
    """SIGTERM to the child's whole process group, SIGKILL after ``grace`` seconds. Never raises."""
    if proc.returncode is not None:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(proc.pid, signal.SIGKILL)  # the child is gone; its own children may not be
        return
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(proc.pid, signal.SIGTERM)
    with contextlib.suppress(BaseException):  # a timeout or a second cancel: SIGKILL below either way
        await asyncio.wait_for(asyncio.shield(proc.wait()), grace)
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(ProcessLookupError):
        proc.kill()
    with contextlib.suppress(Exception):
        await asyncio.wait_for(proc.wait(), grace)


async def run(
    args: Sequence[str],
    *,
    time_limit: float,
    stall_limit: float | None = None,
    on_line: Callable[[str], None] | None = None,
    cwd: Path | None = None,
) -> Result:
    """Runs a command; raises CommandError on a non-zero exit. stderr lines go to ``on_line`` as they arrive.

    ``time_limit`` is required at every call site (tests/test_proc.py checks): nothing runs unbounded. ``stall_limit``
    also kills a command that prints nothing for that long (for commands that print progress, like yt-dlp)."""
    proc = await asyncio.create_subprocess_exec(
        *oom_first(args),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        cwd=str(cwd) if cwd else None,
        start_new_session=True,
    )
    err_lines: list[str] = []
    loop = asyncio.get_running_loop()
    last_output = loop.time()

    async def read_err() -> None:
        nonlocal last_output
        assert proc.stderr is not None
        buf = b""
        while chunk := await proc.stderr.read(4096):
            last_output = loop.time()
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
        nonlocal last_output
        assert proc.stdout is not None
        parts: list[bytes] = []
        while chunk := await proc.stdout.read(65536):
            last_output = loop.time()
            parts.append(chunk)
        return b"".join(parts)

    async def watch_stall() -> None:
        assert stall_limit is not None
        while True:
            await asyncio.sleep(min(5.0, stall_limit / 4))
            if loop.time() - last_output >= stall_limit:
                raise StalledError(f"{Path(args[0]).name} printed nothing for {stall_limit:.0f} s")

    async def everything() -> bytes:
        io: asyncio.Future[tuple[bytes, None]] = asyncio.gather(read_out(), read_err())
        if stall_limit is None:
            out, _ = await io
            return out
        watcher: asyncio.Future[None] = asyncio.ensure_future(watch_stall())
        try:
            both: list[asyncio.Future[Any]] = [io, watcher]
            done, _ = await asyncio.wait(both, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                io.cancel()
                with contextlib.suppress(BaseException):
                    await io
                watcher.result()  # raises StalledError
            out, _ = io.result()
            return out
        finally:
            watcher.cancel()
            with contextlib.suppress(BaseException):
                await watcher

    try:
        out = await asyncio.wait_for(everything(), time_limit)
        code = await proc.wait()
    except BaseException:
        # Timeout, stall, cancel or error: never leave a 6-hour download (or its ffmpeg) running behind a job.
        await kill_group(proc)
        raise
    # A command that exited may still have left children in its group (yt-dlp's ffmpeg after a crash).
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(proc.pid, signal.SIGKILL)
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
    fps: float = 0.0


def _rate(text: object) -> float:
    """ffprobe's ``30000/1001`` as frames per second; 0 when it is missing or odd."""
    try:
        a, _, b = str(text or "").partition("/")
        return round(float(a) / float(b or 1), 2)
    except (ValueError, ZeroDivisionError):
        return 0.0


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
        fps=_rate((video or {}).get("avg_frame_rate") or (video or {}).get("r_frame_rate")),
    )


async def probe(src: str) -> MediaInfo:
    r = await run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            src,
        ],
        time_limit=300,
    )
    return parse_probe(r.stdout)
