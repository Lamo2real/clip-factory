"""The live status line (docs/CONTRACTS.md §31): one short sentence of what the job is doing right now ("Cutting clip
3 of 10"), a small detail ("0:41 of 0:58") and a tiny "what is running" line ("ffmpeg · 1080×1920 · 30 fps"), kept on
its own small item ``JOBLIVE#<jobId>`` so the big Job item is not rewritten every second.

Every word comes from a fixed template below with number slots: no command line, path, URL, cookie or token from a
process ever reaches it, and ``scrub`` cleans the result once more. Writes are throttled (at most one per
``MIN_GAP`` seconds, only when the words changed, plus a refresh every ``REFRESH`` seconds while nothing changes) and
best effort: a failed write is logged and never fails the job.

``emit`` reaches the running job's LiveStatus through a context variable that ``Tracker.begin`` sets, so the
downloads, ffmpeg cuts and model calls deep inside a step can report without being handed the tracker. Outside a job
(tests, probes) it does nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import re
import threading
import time
from collections.abc import Awaitable, Callable, Iterator
from typing import Any

from .util import log, now_iso, redact_urls

MIN_GAP = 1.0  # seconds between two writes at most
REFRESH = 30.0  # a write at least this often while the job runs, so the line never looks stale during a long call
TTL_DAYS = 7
MAX_TEXT = 80
MAX_DETAIL = 60
MAX_TECH = 60

# What each step says while it starts, in plain words (the step labels are in jobs.STEPS).
STEP_TEXT: dict[str, str] = {
    "resolve": "Finding the video",
    "download": "Getting the video",
    "transcribe": "Writing down the words",
    "analyze": "Listening for big moments",
    "watch": "Watching the video with Claude",
    "select": "Picking the best moments with Claude",
    "render": "Cutting the clips",
    "checklist": "Checking the clips with Claude",
    "captions": "Writing the captions",
    "finalize": "Saving the clips",
}

# Where the chat came from, in words (chat.TECH; a copy here so this module stays free of the chat maths).
CHAT_TECH = {
    "twitch": "Twitch chat replay",
    "youtube": "YouTube chat replay",
    "kick": "Kick chat",
    "screen": "chat on screen",
}

KINDS = frozenset(
    {
        "step",  # a step started: its STEP_TEXT
        "note",  # Tracker.say: the step's own note, written in this package ("Checking clip 4 of 10…")
        "resume",  # a stopped job is picked up again
        "download",  # yt-dlp: bytes so far, size, speed
        "transcribe_part",  # one part of a long video's sound is being written down
        "watch_part",  # Claude watches part i of n of the video
        "bedrock",  # a model call started (sets ``since``; the web counts the seconds)
        "bedrock_done",  # every model call ended
        "cut",  # the render step started on clip i of n
        "cut_progress",  # ffmpeg: where the encode is, out of the clip's length (with the clip's own number)
        "cut_done",  # clip i is no longer being cut
        "check",  # the checklist step checks clip i of n
        "captions",  # captions for clip i of n
        "save",  # saving clip i of n
        "chat",  # the analyze step reads the stream's chat: how many messages so far, and from where (§37)
    }
)

_CURRENT: contextvars.ContextVar[LiveStatus | None] = contextvars.ContextVar("cf_live_status", default=None)

_PATH = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][\w.\-~]+){2,}[\\/]?")
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+", re.IGNORECASE)
_KEYLIKE = re.compile(r"[A-Za-z0-9_\-+/=]{24,}")
_SPACES = re.compile(r"\s+")
_X_OF_N = re.compile(r"\b(\d{1,4}) of (\d{1,4})\b")
_CLAUDE = re.compile(r"claude-([a-z]+)-(\d+)-(\d+)")


def scrub(text: str, limit: int) -> str:
    """``text`` without links, paths or anything that looks like a key, on one line, at most ``limit`` characters."""
    text = redact_urls(str(text))
    text = _URL.sub("…", text)
    text = _PATH.sub("…", text)
    text = _KEYLIKE.sub("…", text)
    text = _SPACES.sub(" ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def size(n: float) -> str:
    """Bytes as "412 MB" or "1.2 GB"."""
    n = max(0.0, float(n))
    if n >= 1e9:
        return f"{n / 1e9:.1f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.0f} MB"
    return f"{n / 1e3:.0f} KB"


def clock(seconds: float) -> str:
    """Seconds as "0:41" or "1:02:03"."""
    s = max(0, int(seconds))
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def model_name(model_id: str) -> str:
    """A model id as words: ``global.anthropic.claude-opus-5-5`` → "Claude Opus 5.5"; Nova → "Nova"."""
    m = _CLAUDE.search(model_id or "")
    if m:
        return f"Claude {m.group(1).capitalize()} {m.group(2)}.{m.group(3)}"
    return "Nova" if "nova" in (model_id or "") else "the AI"


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


class LiveStatus:
    """The running job's live line. ``emit`` may be called from any thread; ``flush`` (and the ``run`` loop) write
    from the event loop."""

    def __init__(
        self,
        write: Callable[[dict[str, Any]], Awaitable[Any]],
        job_id: str,
        session_id: str | None,
        *,
        min_gap: float = MIN_GAP,
        refresh: float = REFRESH,
        now: Callable[[], float] = time.monotonic,
        on_emit: Callable[[], None] | None = None,
    ) -> None:
        self._write = write
        self.job_id = job_id
        self.session_id = session_id
        self.min_gap = min_gap
        self.refresh = refresh
        self._now = now
        self.on_emit = on_emit
        self._lock = threading.Lock()
        self.state: dict[str, Any] = {}
        self._dirty = False
        self._last_write: float | None = None
        self._thinking = 0  # model calls in flight
        # Clips being cut right now (the render step cuts several at once): clip index → (seconds done, length) or
        # None before ffmpeg reports. The line follows the lowest index, so two clips' numbers never mix.
        self._cuts: dict[int, tuple[float, float] | None] = {}
        self._cut_n = 0
        self._changed_at = now_iso()  # when the words last really changed (the refresh does not count)
        self._write_lock: asyncio.Lock | None = None
        self.closed = False
        self._task: asyncio.Task[None] | None = None
        self.writes = 0

    # --- what the job says ------------------------------------------------------------------------------------

    def emit(self, kind: str, **v: Any) -> None:
        """Fills ``kind``'s template with the numbers in ``v`` and marks the line for writing when it changed."""
        if kind not in KINDS or self.closed:
            return
        with self._lock:
            s = dict(self.state)
            if kind == "step":
                key = str(v.get("key") or "")
                s = {"step": key, "text": STEP_TEXT.get(key, "Working")}
                self._thinking = 0
                self._cuts.clear()
            elif kind == "note":
                s["text"] = str(v.get("text") or "").rstrip("…. ")
                s.pop("detail", None)
                m = _X_OF_N.search(s["text"])
                if m:
                    s["i"], s["n"] = int(m.group(1)), int(m.group(2))
            elif kind == "resume":
                done = _int(v.get("done")) or 0
                s = {"step": s.get("step", ""), "text": "Picking up where it stopped"}
                if done:
                    s["detail"] = f"{done} {'step' if done == 1 else 'steps'} already done"
            elif kind == "download":
                got, total, speed = _num(v.get("got")), _num(v.get("total")), _num(v.get("speed"))
                pct = _int(v.get("pct"))
                if pct is None and total > 0:
                    pct = int(100 * got / total)
                s["text"] = "Getting the full video" if v.get("full") else "Getting the video"
                parts = []
                if got and total:
                    parts.append(f"{size(got)} of {size(total)}")
                if pct is not None:
                    parts.append(f"{max(0, min(100, pct))}%")
                    s["pct"] = max(0, min(100, pct))
                if parts:
                    s["detail"] = " · ".join(parts)
                s["tech"] = f"yt-dlp · {size(speed)}/s" if speed > 0 else "yt-dlp"
            elif kind == "transcribe_part":
                i, n = _int(v.get("i")), _int(v.get("n"))
                if i is not None and n and n > 1:
                    s["detail"] = f"{i} of {n} parts done"
                    s["i"], s["n"] = i, n
                s["tech"] = "Amazon Transcribe"
            elif kind == "watch_part":
                i, n = _int(v.get("i")), _int(v.get("n"))
                if i is not None and n and n > 1:
                    s["detail"] = f"{i} of {n} parts done"
                    s["i"], s["n"] = i, n
            elif kind == "bedrock":
                self._thinking += 1
                if self._thinking == 1:
                    s["since"] = now_iso()
                s["tech"] = f"{model_name(str(v.get('model') or ''))} · thinking"
            elif kind == "bedrock_done":
                self._thinking = max(0, self._thinking - 1)
                if self._thinking == 0:
                    s.pop("since", None)
                    if str(s.get("tech", "")).endswith("thinking"):
                        s.pop("tech", None)
            elif kind in ("cut", "cut_progress", "cut_done"):
                self._cut_event(s, kind, v)
            elif kind == "chat":
                n = _int(v.get("n"))
                s["text"] = "Reading the chat"
                if n is not None and n > 0:
                    s["detail"] = f"{n:,} {'message' if n == 1 else 'messages'}"
                else:
                    s.pop("detail", None)
                tech = CHAT_TECH.get(str(v.get("source") or ""))
                if tech:
                    s["tech"] = tech
                else:
                    s.pop("tech", None)
            elif kind in ("check", "captions", "save"):
                i, n = _int(v.get("i")), _int(v.get("n"))
                if i and n:
                    s["text"] = {
                        "check": f"Checking clip {i} of {n} with Claude",
                        "captions": f"Writing captions for clip {i} of {n}",
                        "save": f"Saving clip {i} of {n}",
                    }[kind]
                    s["i"], s["n"] = i, n
                s.pop("detail", None)
            s = self._clean(s)
            changed = {k: s.get(k) for k in ("step", "text", "detail", "tech", "since")} != {
                k: self.state.get(k) for k in ("step", "text", "detail", "tech", "since")
            }
            self.state = s
            if changed:
                self._dirty = True
                self._changed_at = now_iso()
        if self.on_emit is not None:
            with contextlib.suppress(Exception):
                self.on_emit()

    def _cut_event(self, s: dict[str, Any], kind: str, v: dict[str, Any]) -> None:
        """Clips are cut several at a time. Each one's numbers are kept apart, and the line shows the lowest clip
        still being cut with that clip's own progress. ``cut_progress`` without a clip number belongs to it."""
        i = _int(v.get("i"))
        if kind == "cut":
            n = _int(v.get("n"))
            if i is not None and n:
                self._cuts[i] = None
                self._cut_n = n
        elif kind == "cut_done":
            self._cuts.pop(i if i is not None else -1, None)
        else:
            at, length = _num(v.get("at")), _num(v.get("length"))
            if length > 0:
                if i is None and self._cuts:
                    i = min(self._cuts)
                if i is not None and i in self._cuts:
                    self._cuts[i] = (min(at, length), length)
                elif i is None and not self._cuts:
                    self._cuts[0] = (min(at, length), length)  # no clip number was ever given
                    self._cut_n = 0
                s["tech"] = self._ffmpeg_tech(v)
        if not self._cuts:
            return
        lead = min(self._cuts)
        if self._cut_n:
            s["text"] = f"Cutting clip {lead} of {self._cut_n}"
            s["i"], s["n"] = lead, self._cut_n
        prog = self._cuts[lead]
        if prog is None:
            s.pop("detail", None)
            s.pop("pct", None)
        else:
            at, length = prog
            s["detail"] = f"{clock(at)} of {clock(length)}"
            s["pct"] = max(0, min(100, int(100 * at / length)))

    @staticmethod
    def _ffmpeg_tech(v: dict[str, Any]) -> str:
        w, h, fps = _int(v.get("w")), _int(v.get("h")), _int(v.get("fps"))
        return f"ffmpeg · {w}×{h} · {fps} fps" if w and h and fps else "ffmpeg"

    @staticmethod
    def _clean(s: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in s.items() if v not in (None, "")}
        for key, limit in (("text", MAX_TEXT), ("detail", MAX_DETAIL), ("tech", MAX_TECH), ("step", 20)):
            if key in out:
                out[key] = scrub(out[key], limit)
                if not out[key]:
                    out.pop(key)
        return out

    @contextlib.contextmanager
    def thinking(self, model_id: str) -> Iterator[None]:
        self.emit("bedrock", model=model_id)
        try:
            yield
        finally:
            self.emit("bedrock_done")

    # --- writing ----------------------------------------------------------------------------------------------

    def item(self) -> dict[str, Any]:
        with self._lock:
            s = dict(self.state)
        return {
            "jobId": self.job_id,
            **({"sessionId": self.session_id} if self.session_id else {}),
            "step": s.get("step", ""),
            "text": s.get("text") or "Working",
            **{k: s[k] for k in ("detail", "tech", "since", "i", "n", "pct") if k in s},
            "at": now_iso(),
            "lastChange": self._changed_at,
            "ttl": int(time.time()) + TTL_DAYS * 86400,
        }

    def due(self) -> bool:
        now = self._now()
        if self._last_write is None:
            return bool(self.state)
        gap = now - self._last_write
        return (self._dirty and gap >= self.min_gap) or (bool(self.state) and gap >= self.refresh)

    async def flush(self, *, force: bool = False) -> bool:
        """Writes the line when it is due (or ``force``). True when it wrote. Never raises."""
        if self.closed or not self.state or not (force or self.due()):
            return False
        if self._write_lock is None:
            self._write_lock = asyncio.Lock()
        async with self._write_lock:  # one write at a time, newest state last: a late older write cannot win
            if self.closed:
                return False
            item = self.item()
            self._dirty = False
            self._last_write = self._now()
            try:
                await self._write(item)
            except Exception as e:
                self._dirty = True  # tried again after ``min_gap``, not left until the next refresh
                log("warn", "job.live_write_failed", job=self.job_id, error=type(e).__name__)
                return False
        self.writes += 1
        return True

    async def run(self) -> None:
        # Looks four times a second, so a change goes out about ``min_gap`` after the last write, not up to twice it.
        while not self.closed:
            await asyncio.sleep(min(0.25, self.min_gap))
            await self.flush()

    def start(self) -> contextvars.Token[LiveStatus | None]:
        """Starts the write loop and makes this the line ``emit`` reaches in the current task and the tasks it
        starts. Returns the context token for ``stop``."""
        token = _CURRENT.set(self)
        if self._task is None:
            self._task = asyncio.create_task(self.run())
        return token

    async def stop(self) -> None:
        """No more writes: the job ended (the web hides the line) or a newer run owns it."""
        self.closed = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def current() -> LiveStatus | None:
    return _CURRENT.get()


def emit(kind: str, **v: Any) -> None:
    """Reports to the running job's live line; nothing outside a job. Never raises."""
    live = _CURRENT.get()
    if live is None:
        return
    try:
        live.emit(kind, **v)
    except Exception as e:  # the line is a nicety; the job never fails over it
        log("warn", "job.live_emit_failed", kind=kind, error=type(e).__name__)


@contextlib.contextmanager
def thinking(model_id: str) -> Iterator[None]:
    """Around one model call: the line shows "<model> · thinking" and the web counts the seconds from ``since``."""
    live = _CURRENT.get()
    if live is None:
        yield
        return
    with live.thinking(model_id):
        yield


# --- readers for the tools' own progress lines ------------------------------------------------------------------

_YTDLP = re.compile(
    r"\[download\]\s+(?P<pct>\d+(?:\.\d+)?)%\s+of\s+~?\s*(?P<total>\d+(?:\.\d+)?)(?P<tu>[KMG]i?B)"
    r"(?:\s+at\s+(?P<speed>\d+(?:\.\d+)?)(?P<su>[KMG]i?B)/s)?"
)
_UNITS = {"KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "KB": 1e3, "MB": 1e6, "GB": 1e9}


def parse_ytdlp(line: str) -> dict[str, float] | None:
    """yt-dlp's ``[download]  34.2% of ~1.20GiB at 4.10MiB/s ETA 00:12`` as ``{pct, got, total, speed}`` (bytes)."""
    m = _YTDLP.search(line)
    if not m:
        return None
    pct = float(m.group("pct"))
    total = float(m.group("total")) * _UNITS.get(m.group("tu"), 1)
    speed = float(m.group("speed")) * _UNITS.get(m.group("su") or "", 1) if m.group("speed") else 0.0
    return {"pct": pct, "got": total * pct / 100, "total": total, "speed": speed}


def parse_ffmpeg_progress(line: str) -> float | None:
    """Seconds encoded so far from one ``-progress`` line (``out_time_us=41000000``; ``out_time_ms`` is microseconds
    too). None for every other line."""
    key, _, value = line.strip().partition("=")
    if key not in ("out_time_us", "out_time_ms"):
        return None
    try:
        return max(0.0, int(value) / 1_000_000)
    except ValueError:
        return None
