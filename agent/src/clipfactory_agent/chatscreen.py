"""The chat box shown in the picture (docs/CONTRACTS.md §37.5): uploads, Mac-fetched videos and streams that show
their chat on screen. Finds the box (a tall strip of text-like cells that keeps moving up) and measures how many lines
a second scroll through it. No OCR: the speed is the signal; the watcher may read the one word the chat floods with.

CPU only, on the 2 fps analysis parts the job already has, at 384×216 grey, streamed through numpy. Returns None
whenever it is not sure there is a chat box, which is always safe: the job goes on without chat."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import picture, proc
from .util import log

W, H = 384, 216
SCALE = picture.WIDTH // W  # the box is reported in picture (768×432) pixels
FRAME_BYTES = W * H
GX, GY = 24, 12  # the grid of cells the box is found on (16×18 pixels each)
CW, CH = W // GX, H // GY
SAMPLE_PARTS = 8
SAMPLE_SECONDS = 30  # from each sampled part
CHANGE = 3.0  # mean absolute difference (0-255) above which a cell changed between two frames
EDGE = 18.0  # a horizontal step this big is part of a letter
MIN_TEXTY = 0.04
MIN_ACTIVE = 0.25
MIN_UP = 0.3
MIN_CORR = 0.75
MIN_AREA, MAX_AREA = 0.05, 0.40
SCENE_DIFF = 45.0  # the whole frame changed this much: a cut, not chat
SCENE_SCORE = 0.4
REPLACED_CORR = 0.6
REPLACED_DIFF = 4 * CHANGE
BATCH = 240  # frames handed to numpy at once
TIME_LIMIT_PER_PART = 120.0


@dataclass(frozen=True)
class Box:
    """In analysis pixels (384×216)."""

    x: int
    y: int
    w: int
    h: int

    def picture_box(self) -> dict[str, int]:
        return {"x": self.x * SCALE, "y": self.y * SCALE, "w": self.w * SCALE, "h": self.h * SCALE}


def _args(path: Path, seconds: float | None) -> list[str]:
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if seconds:
        args += ["-t", str(seconds)]
    return [*args, "-i", str(path), "-an", "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"]


async def read_frames(path: Path, seconds: float | None = None) -> list[np.ndarray]:
    """Every frame of one part (or its first ``seconds``) as uint8 H×W arrays."""
    out: list[np.ndarray] = []
    async for batch in _stream(path, seconds):
        out.extend(batch)
    return out


async def _stream(path: Path, seconds: float | None = None):  # type: ignore[no-untyped-def]
    """Frames of one part in batches of BATCH; the ffmpeg is killed however the reading ends."""
    p = await asyncio.create_subprocess_exec(
        *proc.oom_first(_args(path, seconds)),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    assert p.stdout is not None
    loop = asyncio.get_running_loop()
    end = loop.time() + TIME_LIMIT_PER_PART
    try:
        batch: list[np.ndarray] = []
        while True:
            left = end - loop.time()
            if left <= 0:
                raise TimeoutError("reading the chat box took too long")
            try:
                buf = await asyncio.wait_for(p.stdout.readexactly(FRAME_BYTES), left)
            except asyncio.IncompleteReadError:
                break
            batch.append(np.frombuffer(buf, dtype=np.uint8).reshape(H, W))
            if len(batch) >= BATCH:
                yield batch
                batch = []
        if batch:
            yield batch
    finally:
        await proc.kill_group(p)
        with contextlib.suppress(Exception):
            await p.wait()


# --- finding the box -----------------------------------------------------------------------------------------------


def _edges(f: np.ndarray) -> np.ndarray:
    """|horizontal step| per pixel (the last column is 0)."""
    d = np.zeros(f.shape, dtype=np.float32)
    d[:, :-1] = np.abs(np.diff(f.astype(np.float32), axis=1))
    return d


def _cells(a: np.ndarray) -> np.ndarray:
    """The mean of ``a`` (H×W) per cell, as GY×GX."""
    return a[: GY * CH, : GX * CW].reshape(GY, CH, GX, CW).mean(axis=(1, 3))


def _shift(p0: np.ndarray, p1: np.ndarray, most: int) -> tuple[int, float]:
    """How far up (in rows) the profile moved from ``p0`` to ``p1``, 0..``most``, and how well it matches."""
    n = len(p1)
    best, best_c = 0, -1.0
    for s in range(0, min(most, n - 4) + 1):
        a, b = p1[: n - s], p0[s:]
        a = a - a.mean()
        b = b - b.mean()
        den = float(np.sqrt((a * a).sum() * (b * b).sum()))
        c = float((a * b).sum() / den) if den > 1e-6 else -1.0
        if c > best_c:
            best, best_c = s, c
    return best, best_c


def find_box(pairs: Sequence[tuple[np.ndarray, np.ndarray]]) -> Box | None:
    """The chat box from frame pairs half a second apart, or None."""
    if not pairs:
        return None
    texty = np.zeros((GY, GX))
    active = np.zeros((GY, GX))
    up = np.zeros((GY, GX))
    pad = CH
    for f0, f1 in pairs:
        e0, e1 = _edges(f0), _edges(f1)
        texty += _cells((e0 > EDGE).astype(np.float32))
        changed = _cells(np.abs(f1.astype(np.float32) - f0.astype(np.float32))) > CHANGE
        active += changed
        prof0 = e0[:, : GX * CW].reshape(H, GX, CW).mean(axis=2)  # rows × grid columns
        prof1 = e1[:, : GX * CW].reshape(H, GX, CW).mean(axis=2)
        for gy in range(GY):
            y0, y1 = gy * CH, (gy + 1) * CH
            lo, hi = max(0, y0 - pad), min(H, y1 + pad)
            for gx in range(GX):
                if not changed[gy, gx]:
                    continue
                s, c = _shift(prof0[lo:hi, gx], prof1[lo:hi, gx], pad)
                if s >= 1 and c >= MIN_CORR:
                    up[gy, gx] += 1
    n = len(pairs)
    texty /= n
    up_share = np.divide(up, active, out=np.zeros_like(up), where=active > 0)
    ok = (texty >= MIN_TEXTY) & (active / n >= MIN_ACTIVE) & (up_share >= MIN_UP)
    best = _largest(ok)
    if best is None:
        return None
    gx0, gy0, gx1, gy1 = best
    box = Box(gx0 * CW, gy0 * CH, (gx1 - gx0 + 1) * CW, (gy1 - gy0 + 1) * CH)
    area = box.w * box.h / (W * H)
    if box.h <= box.w or not MIN_AREA <= area <= MAX_AREA:
        return None
    return box


def _largest(ok: np.ndarray) -> tuple[int, int, int, int] | None:
    """The bounding cells (gx0, gy0, gx1, gy1) of the largest 4-connected group of passing cells."""
    seen = np.zeros_like(ok, dtype=bool)
    best: list[tuple[int, int]] = []
    for gy in range(GY):
        for gx in range(GX):
            if not ok[gy, gx] or seen[gy, gx]:
                continue
            stack, group = [(gy, gx)], []
            seen[gy, gx] = True
            while stack:
                y, x = stack.pop()
                group.append((y, x))
                for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= yy < GY and 0 <= xx < GX and ok[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
            if len(group) > len(best):
                best = group
    if len(best) < 4:
        return None
    ys, xs = [g[0] for g in best], [g[1] for g in best]
    return min(xs), min(ys), max(xs), max(ys)


def line_height(frames: Sequence[np.ndarray], box: Box) -> int:
    """The distance between text lines, from the autocorrelation of the box's row profile."""
    acc = np.zeros(box.h - 1)
    for f in frames[:120]:
        p = _edges(f)[box.y : box.y + box.h, box.x : box.x + box.w].mean(axis=1)
        p = p - p.mean()
        full = np.correlate(p, p, mode="full")[box.h :]
        acc[: len(full)] += full
    lo = 4
    if len(acc) <= lo + 1 or acc.max() <= 0:
        return 8
    seg = acc[lo : min(len(acc), 40)]
    peaks = [i for i in range(1, len(seg) - 1) if seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1] and seg[i] > 0]
    return int(lo + peaks[0]) if peaks else 8


# --- the speed -----------------------------------------------------------------------------------------------------


class Speed:
    """Lines per second through the box, fed frame by frame."""

    def __init__(self, box: Box, line: int, seconds: int, scene: Sequence[float] | None = None) -> None:
        self.box = box
        self.line = max(3, line)
        self.lines: list[float | None] = [None] * max(0, seconds)
        self.scene = scene
        self._prev: tuple[float, np.ndarray, np.ndarray, np.ndarray] | None = None
        self._cuts: set[int] = set()  # seconds with a cut: left out, whatever else happens in them

    def feed(self, t: float, f: np.ndarray) -> None:
        b = self.box
        full = f.astype(np.float32)
        crop = full[b.y : b.y + b.h, b.x : b.x + b.w]
        prof = _edges(crop).mean(axis=1)
        prev, self._prev = self._prev, (t, full, crop, prof)
        sec = int(t)
        if prev is None or not 0 <= sec < len(self.lines) or t - prev[0] > 1.01 or sec in self._cuts:
            return
        _, f0, c0, p0 = prev
        if self.scene is not None and sec < len(self.scene) and self.scene[sec] > SCENE_SCORE:
            self.lines[sec] = None  # a cut: a camera change is not chat
            self._cuts.add(sec)
            return
        diff = float(np.abs(crop - c0).mean())
        if diff > SCENE_DIFF and float(np.abs(full - f0).mean()) > SCENE_DIFF:
            self.lines[sec] = None
            self._cuts.add(sec)
            return
        if self.lines[sec] is None:
            self.lines[sec] = 0.0
        if diff <= CHANGE:
            return
        s, c = _shift(p0, prof, b.h // 2)
        # Nothing matches but the box changed a lot: chat moved more than half the box (or was replaced).
        replaced = b.h / self.line if diff > REPLACED_DIFF else 0.0
        moved = s / self.line if c >= REPLACED_CORR else replaced
        self.lines[sec] = (self.lines[sec] or 0.0) + moved


@dataclass
class Found:
    box: Box
    line: int


@dataclass
class Result:
    box: Box
    lines: list[float | None]
    line: int


def sample_parts(parts: Sequence[Any]) -> list[Any]:
    """The up to SAMPLE_PARTS parts, spread over the video, that ``find`` reads."""
    step = max(1, len(parts) // SAMPLE_PARTS)
    return list(parts)[::step][:SAMPLE_PARTS]


async def find(parts: Sequence[tuple[float, Path]]) -> Found | None:
    """The chat box, from the first SAMPLE_SECONDS of up to SAMPLE_PARTS parts spread over the video, or None."""
    if not parts:
        return None
    sample: list[np.ndarray] = []
    pairs: list[tuple[np.ndarray, np.ndarray]] = []
    for _, path in sample_parts(parts):
        frames = await read_frames(path, SAMPLE_SECONDS)
        sample += frames
        pairs += list(itertools.pairwise(frames))
    box = await asyncio.to_thread(find_box, pairs)
    if box is None:
        log("info", "chatscreen.no_box", pairs=len(pairs))
        return None
    return Found(box, await asyncio.to_thread(line_height, sample, box))


async def speed(
    parts: Sequence[tuple[float, Path]], found: Found, seconds: float, scene: Sequence[float] | None = None
) -> list[float | None]:
    """Lines per second through the box over the whole video (None where a cut or a gap left it unmeasured)."""
    meter = Speed(found.box, found.line, int(seconds) + 1, scene)
    for start, path in parts:
        i = 0
        async for batch in _stream(path):

            def run(batch: list[np.ndarray] = batch, first: int = i, start: float = start) -> None:
                for k, f in enumerate(batch):
                    meter.feed(start + (first + k) / picture.FPS, f)

            await asyncio.to_thread(run)
            i += len(batch)
    log("info", "chatscreen.measured", box=found.box.picture_box(), line=found.line)
    return meter.lines[: int(seconds)]


async def measure(
    parts: Sequence[tuple[float, Path]], seconds: float, scene: Sequence[float] | None = None
) -> Result | None:
    """``find`` then ``speed``: the chat box in these parts (start second, local file) and its lines per second."""
    if not parts or seconds <= 0:
        return None
    found = await find(parts)
    if found is None:
        return None
    return Result(found.box, await speed(parts, found, seconds, scene), found.line)
