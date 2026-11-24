"""Running Deno, ffmpeg and ffprobe without blocking the event loop, killed on cancel or timeout (§45.11.1).

Every child runs in its own process group; a timeout, a cancel or any error kills the whole group (SIGTERM, then
SIGKILL), so a scene's Deno and ffmpeg never outlive the job. On Linux a child also asks the kernel to pick it first
when memory runs out (``oom_score_adj`` 1000): one render is lost instead of the agent and its heartbeat."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import redact_urls

_INTERESTING = re.compile(r"error|unable|denied|not |fail|invalid", re.IGNORECASE)
OOM_SCORE_FILE = Path("/proc/self/oom_score_adj")
KILL_GRACE = 5.0


class StalledError(TimeoutError):
    """The command printed nothing for ``stall_limit`` seconds and was killed."""


class CommandError(Exception):
    def __init__(self, cmd: str, code: int | None, tail: str) -> None:
        self.cmd = cmd
        self.code = code
        self.tail = redact_urls(tail)
        super().__init__(f"{cmd} failed (exit {code}). {self.tail}".strip())


@dataclass
class Result:
    stdout: bytes
    stderr: str


def error_tail(text: str, lines: int = 3) -> str:
    picked = [ln.strip() for ln in text.splitlines() if _INTERESTING.search(ln)]
    if not picked:
        picked = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return " ".join(picked[-lines:])[:500]


def oom_first(args: Sequence[str]) -> list[str]:
    if not OOM_SCORE_FILE.exists():
        return list(args)
    return ["sh", "-c", f'{{ echo 1000 > {OOM_SCORE_FILE}; }} 2>/dev/null; exec "$@"', "sh", *args]


async def kill_group(proc: asyncio.subprocess.Process, grace: float = KILL_GRACE) -> None:
    """SIGTERM to the child's whole process group, SIGKILL after ``grace`` seconds. Never raises."""
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(proc.pid, signal.SIGTERM)
        with contextlib.suppress(BaseException):
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
    on_out_line: Callable[[str], None] | None = None,
    cwd: Path | None = None,
    stdin: bytes | None = None,
    env: Mapping[str, str] | None = None,
) -> Result:
    """Runs a command; raises CommandError on a non-zero exit. ``time_limit`` is required: nothing runs unbounded.
    stdout lines go to ``on_out_line`` as they arrive (and are not kept) when it is given. ``env`` is added to this
    process's own environment (a reference fetch's proxy settings, §45.40)."""
    proc = await asyncio.create_subprocess_exec(
        *oom_first(args),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        cwd=str(cwd) if cwd else None,
        env={**os.environ, **env} if env is not None else None,
        start_new_session=True,
    )
    err_lines: list[str] = []
    loop = asyncio.get_running_loop()
    last_output = loop.time()

    async def feed() -> None:
        if stdin is None or proc.stdin is None:
            return
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            proc.stdin.write(stdin)
            await proc.stdin.drain()
        proc.stdin.close()

    async def read_err() -> None:
        nonlocal last_output
        assert proc.stderr is not None
        buf = b""
        while chunk := await proc.stderr.read(4096):
            last_output = loop.time()
            buf += chunk
            *done, buf = re.split(rb"[\r\n]", buf)
            err_lines.extend(ln.decode("utf-8", "replace") for ln in done if ln.strip())
            del err_lines[:-400]
        if buf.strip():
            err_lines.append(buf.decode("utf-8", "replace"))

    async def read_out() -> bytes:
        nonlocal last_output
        assert proc.stdout is not None
        parts: list[bytes] = []
        buf = b""
        while chunk := await proc.stdout.read(65536):
            last_output = loop.time()
            if on_out_line is None:
                parts.append(chunk)
                continue
            buf += chunk
            *done, buf = buf.split(b"\n")
            for raw in done:
                with contextlib.suppress(Exception):
                    on_out_line(raw.decode("utf-8", "replace"))
        if on_out_line is not None and buf.strip():
            with contextlib.suppress(Exception):
                on_out_line(buf.decode("utf-8", "replace"))
        return b"".join(parts)

    async def watch_stall() -> None:
        assert stall_limit is not None
        while True:
            await asyncio.sleep(min(5.0, stall_limit / 4))
            if loop.time() - last_output >= stall_limit:
                raise StalledError(f"{Path(args[0]).name} printed nothing for {stall_limit:.0f} s")

    async def everything() -> bytes:
        io: asyncio.Future[Any] = asyncio.gather(read_out(), read_err(), feed())
        if stall_limit is None:
            out, _, _ = await io
            return bytes(out)
        watcher: asyncio.Future[None] = asyncio.ensure_future(watch_stall())
        try:
            done, _ = await asyncio.wait([io, watcher], return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                io.cancel()
                with contextlib.suppress(BaseException):
                    await io
                watcher.result()
            out, _, _ = io.result()
            return bytes(out)
        finally:
            watcher.cancel()
            with contextlib.suppress(BaseException):
                await watcher

    try:
        out = await asyncio.wait_for(everything(), time_limit)
        code = await proc.wait()
    except BaseException:
        await kill_group(proc)
        raise
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
    try:
        a, _, b = str(text or "").partition("/")
        return round(float(a) / float(b or 1), 2)
    except (ValueError, ZeroDivisionError):
        return 0.0


def parse_probe(data: bytes) -> MediaInfo:
    j = json.loads(data or b"{}")
    streams = j.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    return MediaInfo(
        duration=float((j.get("format") or {}).get("duration") or 0),
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
