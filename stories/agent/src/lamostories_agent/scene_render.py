"""Renders one scene (or one still) in a process of its own: ``cli.ts frames`` → ``raster`` → ffmpeg.

    python -m lamostories_agent.scene_render clip  --spec spec.json
    python -m lamostories_agent.scene_render still --spec spec.json

The agent starts it with ``proc.run`` (docs/CONTRACTS.md §45.11.3), so the drawing runs off the event loop and off
its GIL, two scenes at a time, and a cancel or a time limit kills the whole process group: this process, its Deno and
its ffmpeg. Deno's frames are read line by line (one JSON draw list per frame), each frame is rasterized and its raw
RGB piped straight into ffmpeg (``libx264``, ``yuv420p``, the CRF of ``video.quality``: 23, 20 or 17, 30 fps), so
memory stays at about one frame.

stdout carries one ``progress <done> <total>`` line every few frames and a last ``done <frames>`` line; anything that
goes wrong is one line on stderr and exit code 2 (the agent logs it; the owner gets a plain sentence)."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import IO, Any

import numpy as np

from .raster import HEIGHT, WIDTH, Canvas, PrimError, prim_problems

PROGRESS_EVERY = 10
CRF = 20
FPS = 30


def load_image(path: Path, w: int, h: int) -> np.ndarray | None:
    """An image asset as (h, w, 4) uint8 RGBA, scaled with ffmpeg; None when it cannot be read."""
    try:
        r = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(path),
                "-vf",
                f"scale={w}:{h}:flags=bicubic,format=rgba",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-",
            ],
            capture_output=True,
            timeout=60,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if len(r.stdout) != w * h * 4:
        return None
    return np.frombuffer(r.stdout, np.uint8).reshape(h, w, 4)


def image_loader(assets: dict[str, str]) -> Callable[[str, int, int], np.ndarray | None]:
    cache: dict[tuple[str, int, int], np.ndarray | None] = {}

    def get(name: str, w: int, h: int) -> np.ndarray | None:
        key = (name, w, h)
        if key not in cache:
            path = assets.get(name)
            cache[key] = load_image(Path(path), w, h) if path else None
        return cache[key]

    return get


def encoder_args(out: Path, *, still: bool, width: int, height: int, preset: str, crf: int = CRF) -> list[str]:
    head = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}"]
    head += ["-r", str(FPS), "-i", "pipe:0"]
    if still:
        return [*head, "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "3", str(out)]
    return [
        *head,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(FPS),
        "-g",
        str(FPS * 2),
        "-movflags",
        "+faststart",
        str(out),
    ]


def _drain(stream: IO[bytes], sink: list[bytes]) -> None:
    for line in stream:
        sink.append(line)
        del sink[:-50]


def render(spec: dict[str, Any], *, still: bool, out_progress: IO[str] = sys.stdout) -> int:
    """Draws frames [from, to) of the spec's script into ``out``; returns how many frames were written."""
    first, end = int(spec["from"]), int(spec["to"])
    if end <= first:
        raise ValueError("the scene has no frames")
    width, height = int(spec.get("width") or WIDTH), int(spec.get("height") or HEIGHT)
    deno = [*spec["deno"], "frames", str(spec["script"]), str(first), str(end)]
    enc = encoder_args(
        Path(spec["out"]),
        still=still,
        width=width,
        height=height,
        preset=str(spec.get("preset") or "fast"),
        crf=int(spec.get("crf") or CRF),
    )
    images = image_loader({str(k): str(v) for k, v in (spec.get("assets") or {}).items()})
    total = end - first
    deno_err: list[bytes] = []
    ffmpeg_err: list[bytes] = []
    src = subprocess.Popen(deno, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
    dst = subprocess.Popen(enc, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert src.stdout is not None and src.stderr is not None and dst.stdin is not None and dst.stderr is not None
    threads = [
        threading.Thread(target=_drain, args=(src.stderr, deno_err), daemon=True),
        threading.Thread(target=_drain, args=(dst.stderr, ffmpeg_err), daemon=True),
    ]
    for t in threads:
        t.start()
    done = 0
    canvas = Canvas(width, height, images)
    try:
        for raw in src.stdout:
            if not raw.strip():
                continue
            line = json.loads(raw)
            f = int(line["f"])
            if f != first + done:
                raise ValueError(f"frame {f} came out of order (expected {first + done})")
            prims = line["p"]
            canvas.reset()
            try:
                canvas.draw(prims)
            except (KeyError, TypeError, ValueError) as e:
                bad = next((p for p in prims if prim_problems(p)), None)
                raise PrimError(f"frame {f}: {prim_problems(bad)[:3] if bad else e}") from e
            dst.stdin.write(canvas.tobytes())
            done += 1
            if still:
                break
            if done % PROGRESS_EVERY == 0:
                out_progress.write(f"progress {done} {total}\n")
                out_progress.flush()
        dst.stdin.close()
        if still:
            src.kill()
        code = src.wait(timeout=60)
        if not still and code != 0:
            raise RuntimeError(f"deno frames exited {code}: {b''.join(deno_err)[-400:].decode('utf-8', 'replace')}")
        if dst.wait(timeout=600) != 0:
            raise RuntimeError(
                f"ffmpeg exited {dst.returncode}: {b''.join(ffmpeg_err)[-400:].decode('utf-8', 'replace')}"
            )
    finally:
        for p in (src, dst):
            if p.poll() is None:
                p.kill()
                p.wait()
    expected = 1 if still else total
    if done != expected:
        raise RuntimeError(f"the engine drew {done} frames, not {expected}")
    out_progress.write(f"done {done}\n")
    out_progress.flush()
    return done


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] not in ("clip", "still") or argv[1] != "--spec":
        sys.stderr.write("usage: scene_render clip|still --spec spec.json\n")
        return 2
    try:
        spec = json.loads(Path(argv[2]).read_text("utf-8"))
        render(spec, still=argv[0] == "still")
    except Exception as e:
        sys.stderr.write(f"{type(e).__name__}: {str(e)[:600]}\n")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
