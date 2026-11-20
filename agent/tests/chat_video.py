"""A synthetic 2 fps "stream" for the chat box tests: a noisy game picture with moving blobs and, on the right, a
strip of text lines that scrolls up slowly, fast for a while, then slowly again."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

W, H = 768, 432
STRIP = (592, 40, 160, 360)  # x, y, w, h in 768×432 pixels
LINE = 16


def _tape(rng: np.random.Generator, height: int, w: int) -> np.ndarray:
    tape = np.full((height, w), 225, dtype=np.uint8)
    for top in range(0, height - LINE, LINE):
        x = 6
        while x < w - 12:
            word = int(rng.integers(8, 34))
            tape[top + 4 : top + 12, x : min(w - 6, x + word)] = int(rng.integers(20, 70))
            x += word + int(rng.integers(5, 12))
            if rng.random() < 0.15:
                break
    return tape


def make(
    path: Path,
    *,
    seconds: int = 180,
    fast: tuple[float, float] = (60, 90),
    slow_px: int = 4,
    fast_px: int = 32,
    strip: bool = True,
    cut_at: float | None = None,
    seed: int = 7,
) -> Path:
    rng = np.random.default_rng(seed)
    n = seconds * 2
    speeds = [fast_px if fast[0] <= k / 2 < fast[1] else slow_px for k in range(n)]
    x, y, w, h = STRIP
    tape = _tape(rng, sum(speeds) + h + LINE, w)
    blobs = rng.integers(0, [W - 80, H - 80], size=(6, 2)).astype(float)
    vel = rng.normal(0, 12, size=(6, 2))
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-s",
            f"{W}x{H}",
            "-r",
            "2",
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-g",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        stdin=subprocess.PIPE,
    )
    assert ff.stdin is not None
    offset = 0
    for k in range(n):
        frame = rng.integers(60, 140, size=(H // 8, W // 8), dtype=np.uint8).repeat(8, 0).repeat(8, 1)
        for bx, by in blobs.astype(int):
            frame[by : by + 80, bx : bx + 80] = 200
        blobs = np.clip(blobs + vel, 0, [W - 81, H - 81])
        if strip:
            frame[y : y + h, x : x + w] = tape[offset : offset + h]
        offset += speeds[k]
        if cut_at is not None and k / 2 == cut_at:
            frame = 255 - frame
        ff.stdin.write(np.ascontiguousarray(frame).tobytes())
    ff.stdin.close()
    assert ff.wait() == 0
    return path
