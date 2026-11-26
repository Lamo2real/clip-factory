"""A Review overlay: a logo and one line of text drawn on a finished clip (docs/CONTRACTS.md §53 C5, ADR-105).

The API asks for ``{"action": "overlay", userId, clipId, jobId, rev}`` and gets "accepted" at once. This module then
draws on the clip's **original** file (``origVideoKey`` when an earlier edit kept it, else ``videoKey``): the logo
(scaled to a fraction of the width, centred where the owner dragged it, always inside the frame) with ffmpeg's
``overlay`` and the text with libass, the same way and with the same font as the hook and the captions (render.py).
Nothing is cut: same size, same frame rate, the audio copied untouched, the video encoded with exactly the settings the
clip render uses (``render.video_encode_args``). The result is ``jobs/{jobId}/clips/{clipId}/edit-{rev}.mp4`` and ONE
conditional write puts it live (``Store.finish_overlay``): only while the clip is still in review and ``overlay.rev``
is still ``rev``. Otherwise the output is deleted. A failure never raises out of here: it deletes the partial output and
writes one plain sentence in ``overlay.error``.

An overlay is not a job. It never touches the Job item, the job fence, the heartbeat or a job's callback, and it lives in
its own runner (``OverlayRunner``) so a job's cancel or duplicate ``process_job`` can never reach it; ``busy`` counts
it, so the runtime stays alive (HealthyBusy) while one renders."""

from __future__ import annotations

import asyncio
import contextlib
import math
import re
import shutil
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from . import proc
from . import render as render_mod
from .store import clip_prefix, user_pk
from .util import log

MAX_TEXT = 80  # characters (§53 C2)
SIZE_MIN, SIZE_MAX, SIZE_DEFAULT = 0.08, 0.50, 0.22  # the logo's width as a fraction of the frame's (§53 C2)
# The text's size at the 1080-wide reference (the hook is 68): Small, Medium, Large. Outline and shadow grow with it.
TEXT_SIZES = {"s": 48, "m": 68, "l": 92}
TEXT_OUTLINE = {"s": 5, "m": 7, "l": 9}
TEXT_SHADOW = {"s": 2, "m": 3, "l": 3}
CHAR_WIDTH = 0.6  # a bold character is about this many font sizes wide (a safe over-estimate for Inter Bold)
EDGE = 0.97  # the text never wider than this much of the frame
LOGO_EXTS = ("png", "jpg", "webp", "jpeg")  # the library's convention: logos/{userId}/{logoId}.{ext} (§53 C4)
KIND_EXT = {"png": "png", "jpeg": "jpg", "webp": "webp"}
RENDER_LIMIT = 15 * 60  # seconds one ffmpeg run may take
MIN_VISIBLE = 0.05  # seconds: a "from" this close to the end shows nothing

FAILED = "The edit could not be made. Try again."
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class OverlayFailed(Exception):
    """A failure with the one plain sentence the owner sees in ``overlay.error``."""


@dataclass(frozen=True)
class LogoSpec:
    logo_id: str
    x: float
    y: float
    size: float


@dataclass(frozen=True)
class TextSpec:
    text: str
    x: float
    y: float
    size: str  # "s" | "m" | "l"


@dataclass(frozen=True)
class OverlaySpec:
    logo: LogoSpec | None
    text: TextSpec | None
    start: float | None = None  # clip seconds; None for both = the whole clip
    end: float | None = None

    @property
    def whole(self) -> bool:
        return self.start is None and self.end is None


def _num(value: Any, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    return float(value) if math.isfinite(value) else default


def _unit(value: Any, default: float = 0.5) -> float:
    return min(1.0, max(0.0, _num(value, default)))


def parse_spec(overlay: Mapping[str, Any]) -> OverlaySpec:
    """The spec from the clip's ``overlay`` map. Values are clamped (placement 0 to 1, logo size 8% to 50%, text size
    one of s, m, l, text 80 characters on one line); raises OverlayFailed when there is neither a logo nor any words."""
    logo: LogoSpec | None = None
    raw_logo = overlay.get("logo")
    if isinstance(raw_logo, Mapping) and isinstance(raw_logo.get("logoId"), str) and ID_RE.match(raw_logo["logoId"]):
        size = min(SIZE_MAX, max(SIZE_MIN, _num(raw_logo.get("size"), SIZE_DEFAULT)))
        logo = LogoSpec(raw_logo["logoId"], _unit(raw_logo.get("x")), _unit(raw_logo.get("y")), size)
    text: TextSpec | None = None
    raw_text = overlay.get("text")
    if isinstance(raw_text, Mapping) and isinstance(raw_text.get("text"), str):
        words = render_mod.ass_escape(raw_text["text"])[:MAX_TEXT].strip()
        if words:
            key = raw_text.get("size") if raw_text.get("size") in TEXT_SIZES else "m"
            text = TextSpec(words, _unit(raw_text.get("x")), _unit(raw_text.get("y")), str(key))
    if logo is None and text is None:
        raise OverlayFailed("There is no logo or text to add.")
    start = end = None
    timing = overlay.get("timing")
    if isinstance(timing, Mapping) and (timing.get("startSec") is not None or timing.get("endSec") is not None):
        start = max(0.0, _num(timing.get("startSec"), 0.0))
        end_raw = timing.get("endSec")
        end = _num(end_raw, 0.0) if end_raw is not None else None
        if end is not None and end <= start:
            end = None  # an empty or backwards window: from "start" to the end
    return OverlaySpec(logo, text, start, end)


def window(spec: OverlaySpec, duration: float) -> tuple[float, float]:
    """(from, to) in clip seconds that the logo and text show: the whole clip, or the owner's window inside it."""
    start = 0.0 if spec.start is None else spec.start
    end = duration if spec.end is None else min(spec.end, duration)
    return start, end


def text_layout(text: TextSpec, w: int, h: int) -> tuple[int, int, int]:
    """(font size, centre x, centre y) in pixels. One line: a line that would be wider than the frame gets a smaller font
    (never wrapped), and the centre is pulled in so the whole line stays inside the frame."""
    size = TEXT_SIZES[text.size] * w / render_mod.W
    chars = max(1, len(text.text))
    if chars * CHAR_WIDTH * size > w * EDGE:
        size = w * EDGE / (chars * CHAR_WIDTH)
    px = max(8, int(size))  # whole pixels, rounded down: the line is never wider than estimated
    half_w, half_h = chars * CHAR_WIDTH * px / 2, px * 0.7
    cx = min(max(text.x * w, half_w), w - half_w)
    cy = min(max(text.y * h, half_h), h - half_h)
    return px, round(cx), round(cy)


def overlay_ass(text: TextSpec, w: int, h: int, start: float, end: float) -> str:
    """The subtitle file for the text: one line, white with a dark edge, the hook's font (Inter bold), centred on the
    owner's point. PlayRes is the video's own size, so the pixels in the file are the pixels on screen."""
    size, cx, cy = text_layout(text, w, h)
    scale = w / render_mod.W
    outline = max(1, round(TEXT_OUTLINE[text.size] * scale))
    shadow = max(1, round(TEXT_SHADOW[text.size] * scale))
    return (
        f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding\n"
        f"Style: Overlay,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,{outline},"
        f"{shadow},5,0,0,0,1\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        f"Dialogue: 0,{render_mod.ass_time(start)},{render_mod.ass_time(end)},Overlay,,0,0,0,,"
        f"{{\\an5\\pos({cx},{cy})\\q2}}{render_mod.ass_escape(text.text)}\n"
    )


def overlay_graph(spec: OverlaySpec, w: int, h: int, ass_file: Path, start: float, end: float) -> str:
    """The filter graph: ``[0:v]`` is the clip, ``[1:v]`` the logo (when there is one). The logo is scaled to its
    fraction of the width (never larger than the frame), centred on its point and pulled in so it stays inside the
    frame, over the whole clip or between ``start`` and ``end``; the text comes from the ASS file (its own times)."""
    chains: list[str] = []
    cur = "[0:v]"
    if spec.logo is not None:
        lg = spec.logo
        lw = render_mod.even(w * lg.size)
        window_on = "" if spec.whole else f":enable='between(t,{start:.3f},{end:.3f})'"
        chains.append(f"[1:v]scale={lw}:{h}:force_original_aspect_ratio=decrease,format=rgba[lg]")
        chains.append(
            f"{cur}[lg]overlay=x='min(max({lg.x:.4f}*W-w/2,0),W-w)':y='min(max({lg.y:.4f}*H-h/2,0),H-h)'{window_on}[o1]"
        )
        cur = "[o1]"
    if spec.text is not None:
        if not render_mod._SAFE_PATH.match(str(ass_file)):
            raise ValueError(f"unsafe subtitle path: {ass_file}")
        chains.append(f"{cur}ass=filename={ass_file}[o2]")
        cur = "[o2]"
    chains.append(f"{cur}format=yuv420p[vout]")
    return ";".join(chains)


def ffmpeg_args(src: Path, logo: Path | None, graph: str, duration: float, out: Path) -> list[str]:
    """The whole command: video re-encoded with the clip render's settings, audio copied (``-c:a copy``), same size and
    frame rate (nothing scales the clip; ``-r`` is the render's)."""
    inputs = ["-i", str(src)]
    if logo is not None:
        inputs += ["-loop", "1", "-t", f"{duration + 1:.3f}", "-i", str(logo)]
    return [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-filter_complex_threads",
        "1",
        *inputs,
        "-filter_complex",
        graph,
        "-map",
        "[vout]",
        "-map",
        "0:a?",
        "-c:a",
        "copy",
        *render_mod.video_encode_args(),
        "-t",
        f"{duration:.3f}",
        "-movflags",
        "+faststart",
        str(out),
    ]


class OverlayStore(Protocol):
    async def get_clip(self, user_id: str, clip_id: str) -> dict[str, Any] | None: ...

    async def get_item(self, pk: str, sk: str) -> dict[str, Any] | None: ...

    async def exists(self, key: str) -> bool: ...

    async def download(self, key: str, path: Path) -> None: ...

    async def upload(self, path: Path, key: str, content_type: str) -> None: ...

    async def delete_keys(self, keys: Any) -> None: ...

    async def finish_overlay(self, user_id: str, clip_id: str, rev: int, edit_key: str, orig_key: str) -> bool: ...

    async def fail_overlay(self, user_id: str, clip_id: str, rev: int, message: str) -> bool: ...


async def fetch_logo(store: OverlayStore, user_id: str, logo_id: str, workdir: Path) -> Path:
    """The logo file from the library (``LOGO#{logoId}``'s own key, else the ``logos/{userId}/{logoId}.{ext}``
    convention), checked from its first bytes (PNG, JPEG or WebP; never anything ffmpeg could follow) and renamed to
    its real extension."""
    item = await store.get_item(user_pk(user_id), f"LOGO#{logo_id}")
    prefix = f"logos/{user_id}/{logo_id}."
    key = item.get("key") if item else None
    if not (isinstance(key, str) and key.startswith(prefix) and "/" not in key[len(prefix) :]):
        key = None
        for ext in LOGO_EXTS:
            if await store.exists(f"{prefix}{ext}"):
                key = f"{prefix}{ext}"
                break
    if key is None:
        raise OverlayFailed("The logo could not be found. Pick it again.")
    raw = workdir / "logo.download"
    await store.download(key, raw)
    if raw.stat().st_size > render_mod.LOGO_BYTES_MAX:
        raise OverlayFailed("That logo is too big. Use a smaller picture.")
    found = render_mod.image_size(raw.read_bytes())
    if found is None or found[1] <= 0 or found[2] <= 0 or found[1] * found[2] > render_mod.LOGO_PIXELS_MAX:
        raise OverlayFailed("That logo could not be read. Use a PNG, JPG or WebP picture.")
    dest = workdir / f"logo.{KIND_EXT[found[0]]}"
    raw.replace(dest)
    return dest


def _same_rev(overlay: Mapping[str, Any], rev: int) -> bool:
    got = overlay.get("rev")
    return isinstance(got, int | float) and not isinstance(got, bool) and got == rev


async def run_overlay(store: OverlayStore, work_root: Path, user_id: str, clip_id: str, job_id: str, rev: int) -> str:
    """One overlay edit. Returns ``ready``, ``failed`` or ``stale`` (the clip moved on: nothing is written). Never
    raises (a cancel, from the container shutting down, marks the edit failed and is passed on)."""
    workdir = work_root / f"overlay-{clip_id}-{rev}"
    edit_key = clip_prefix(job_id, clip_id) + f"edit-{rev}.mp4"
    uploaded = False
    try:
        clip = await store.get_clip(user_id, clip_id)
        overlay = (clip or {}).get("overlay")
        if (
            not clip
            or clip.get("status") != "review"
            or (clip.get("jobId") not in (None, job_id))
            or not isinstance(overlay, Mapping)
            or not _same_rev(overlay, rev)
            or overlay.get("status") == "ready"
        ):
            log("info", "overlay.stale", clip=clip_id, rev=rev)
            return "stale"
        spec = parse_spec(overlay)
        orig_key = clip.get("origVideoKey") or clip.get("videoKey")
        if not isinstance(orig_key, str) or not orig_key:
            raise OverlayFailed("The clip's video could not be found.")
        workdir.mkdir(parents=True, exist_ok=True)
        src = workdir / "orig.mp4"
        await store.download(orig_key, src)
        info = await proc.probe(str(src))
        if not info.has_video or info.width <= 0 or info.height <= 0 or info.duration <= 0:
            raise OverlayFailed("The clip's video could not be read.")
        start, end = window(spec, info.duration)
        if end - start < MIN_VISIBLE:
            raise OverlayFailed("Those times are outside the clip.")
        logo = await fetch_logo(store, user_id, spec.logo.logo_id, workdir) if spec.logo else None
        ass_file = workdir / "overlay.ass"
        if spec.text is not None:
            ass_file.write_text(overlay_ass(spec.text, info.width, info.height, start, end), "utf-8")
        graph = overlay_graph(spec, info.width, info.height, ass_file, start, end)
        out = workdir / "edit.mp4"
        await proc.run(ffmpeg_args(src, logo, graph, info.duration, out), time_limit=RENDER_LIMIT)
        if not out.is_file() or out.stat().st_size == 0:
            raise OverlayFailed(FAILED)
        await store.upload(out, edit_key, "video/mp4")
        uploaded = True
        if await store.finish_overlay(user_id, clip_id, rev, edit_key, str(clip.get("videoKey") or orig_key)):
            log("info", "overlay.ready", clip=clip_id, rev=rev)
            previous = clip.get("editKey")  # the earlier edit's file is not linked any more: it goes
            if isinstance(previous, str) and previous != edit_key and previous.startswith(clip_prefix(job_id, clip_id)):
                await _delete(store, previous)
            return "ready"
        await _delete(store, edit_key)  # the clip moved on (thrown away, reset, a newer edit): this output is not used
        log("info", "overlay.stale", clip=clip_id, rev=rev, at="write")
        return "stale"
    except asyncio.CancelledError:
        await asyncio.shield(
            _give_up(store, user_id, clip_id, rev, edit_key, uploaded, "The edit was interrupted. Try again.")
        )
        raise
    except Exception as e:
        message = str(e) if isinstance(e, OverlayFailed) else FAILED
        log("error", "overlay.failed", clip=clip_id, rev=rev, error=type(e).__name__, detail=str(e)[:600])
        await _give_up(store, user_id, clip_id, rev, edit_key, uploaded, message)
        return "failed"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def _delete(store: OverlayStore, key: str) -> None:
    with contextlib.suppress(Exception):
        await store.delete_keys([key])


async def _give_up(
    store: OverlayStore, user_id: str, clip_id: str, rev: int, edit_key: str, uploaded: bool, message: str
) -> None:
    """Deletes what this run uploaded and says why it failed (only while the clip still wants this ``rev``). Never raises."""
    if uploaded:
        await _delete(store, edit_key)
    try:
        await store.fail_overlay(user_id, clip_id, rev, message)
    except Exception as e:
        log("error", "overlay.fail_write_failed", clip=clip_id, rev=rev, error=type(e).__name__)


OverlayFactory = Callable[[str, str, str, int], Awaitable[str]]
"""``(user_id, clip_id, job_id, rev)`` → ``ready`` | ``failed`` | ``stale``."""


def make_overlay_run(store: OverlayStore, work_root: Path) -> OverlayFactory:
    async def run(user_id: str, clip_id: str, job_id: str, rev: int) -> str:
        return await run_overlay(store, work_root, user_id, clip_id, job_id, rev)

    return run


class OverlayRunner:
    """Overlay edits running in this container, as background tasks of their own (never a job's task: a job's cancel,
    duplicate ``process_job`` or heartbeat cannot reach them). ``busy`` keeps the runtime alive while one renders."""

    def __init__(self, run: OverlayFactory, limit: int = 2) -> None:
        self._run = run
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self._slots = asyncio.Semaphore(limit)

    @property
    def busy(self) -> bool:
        return any(not t.done() for t in self.tasks.values())

    def submit(self, user_id: str, clip_id: str, job_id: str, rev: int) -> bool:
        """Starts the edit unless this very ``rev`` of this clip is already being made here (a repeated invocation)."""
        key = f"{clip_id}:{rev}"
        running = self.tasks.get(key)
        if running and not running.done():
            return False

        async def go() -> None:
            try:
                async with self._slots:
                    await self._run(user_id, clip_id, job_id, rev)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log("error", "overlay.crashed", clip=clip_id, rev=rev, error=type(e).__name__, detail=str(e)[:600])

        task = asyncio.create_task(go(), name=f"overlay-{key}")
        self.tasks[key] = task

        def forget(t: asyncio.Task[Any]) -> None:
            if self.tasks.get(key) is t:
                self.tasks.pop(key, None)

        task.add_done_callback(forget)
        return True

    async def shutdown(self, within: float = 20.0) -> None:
        """The container is stopping: every running edit is canceled (each marks itself failed first)."""
        running = [t for t in self.tasks.values() if not t.done()]
        if not running:
            return
        for t in running:
            t.cancel()
        await asyncio.wait(running, timeout=within)
