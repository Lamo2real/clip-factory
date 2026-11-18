"""The picture of the whole source, prepared once for the deep analysis (docs/DECISIONS.md ADR-40).

One ffmpeg decode makes two things: small 2 fps video parts of 300 seconds each (what the watchers look at) and a
picture-change score for every second (motion and scene cuts: the picture signal that needs no model). Frames are
grabbed from the parts when a watcher asks for them."""

from __future__ import annotations

import asyncio
import re
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import proc
from .util import JobCanceled, log

FPS = 2
WIDTH, HEIGHT = 768, 432
SMALL_WIDTH, SMALL_HEIGHT = 640, 360
PART_SECONDS = 300
# Nova takes 25 MB of video inside one request; boto3 sends it base64-encoded (4/3 larger), so a part is kept to
# 18 MB, which is under 25 MB either way (the one re-encode in ``shrink`` makes bigger parts smaller).
PART_MAX_BYTES = 18 * 1024 * 1024
DISK_RESERVE = 3 * 1024**3  # left free for the audio, the clips being cut and the system
GRAB_CONCURRENCY = 2
SCORE_FPS = 4
MIN_MOTION = 0.02  # below this a second's picture barely changes, whatever the median says
SPIKE_LIFT = 2.5
SPIKE_WINDOW = 150
_PTS = re.compile(r"pts_time:(-?[\d.]+)")
_SCORE = re.compile(r"lavfi\.scene_score=([\d.]+)")
SCORES_FILE = "scores.txt"
PART_PATTERN = "part-%04d.mp4"


@dataclass
class Part:
    i: int
    start: float
    end: float
    key: str
    bytes: int

    def to_json(self) -> dict[str, Any]:
        return {"i": self.i, "start": self.start, "end": self.end, "key": self.key, "bytes": self.bytes}


@dataclass
class Picture:
    """``picture.json`` (docs/CONTRACTS.md §7)."""

    seconds: float
    parts: list[Part] = field(default_factory=list)
    motion: list[float] = field(default_factory=list)
    scene: list[float] = field(default_factory=list)
    decode: str = "all"

    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "seconds": self.seconds,
            "fps": FPS,
            "width": WIDTH,
            "height": HEIGHT,
            "decode": self.decode,
            "partSeconds": PART_SECONDS,
            "parts": [p.to_json() for p in self.parts],
            "motion": self.motion,
            "scene": self.scene,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Picture:
        return cls(
            seconds=float(d.get("seconds") or 0),
            parts=[
                Part(int(p["i"]), float(p["start"]), float(p["end"]), str(p["key"]), int(p.get("bytes") or 0))
                for p in d.get("parts") or []
            ],
            motion=[float(v) for v in d.get("motion") or []],
            scene=[float(v) for v in d.get("scene") or []],
            decode=str(d.get("decode") or "all"),
        )


def time_limit(seconds: float) -> float:
    """How long the picture preparation may take, download and decode together, and so how long the watch step waits
    for it (pipeline.prep_deadline is this). It scales with the source, never a fixed cut-off for a long one."""
    return max(20 * 60.0, seconds / 3)


def keyframes_only(height: int, seconds: float) -> bool:
    """Whether a full decode is in doubt: a tall (over 720p), long (over 45 min) upload. Only then is the decode
    speed measured (``decode_speed``); the keyframes-only decode is used only when the full one would not finish."""
    return height > 720 and seconds > 45 * 60


PROBE_SECONDS = 60  # the stretch the decode speed is measured on
FULL_DECODE_SHARE = 0.7  # a full decode is used when it is expected to take at most this share of the time limit


async def decode_speed(src: str, *, sample: float = PROBE_SECONDS) -> float:
    """Seconds of video decoded (at the analysis size) per second of wall time, measured on the first ``sample``
    seconds. 0 when the probe fails or runs past its own limit (then the keyframes-only decode is used)."""
    args = [
        "ffmpeg",
        "-v",
        "error",
        "-t",
        str(int(sample)),
        "-i",
        src,
        "-an",
        "-vf",
        f"fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease",
        "-f",
        "null",
        "-",
    ]
    loop = asyncio.get_running_loop()
    began = loop.time()
    try:
        await proc.run(args, time_limit=max(30.0, sample * 2))
    except (asyncio.CancelledError, JobCanceled):
        raise
    except Exception as e:
        log("warn", "picture.probe_failed", error=type(e).__name__, detail=str(e)[:300])
        return 0.0
    return sample / max(0.001, loop.time() - began)


def full_decode_fits(seconds: float, speed: float) -> bool:
    """Whether decoding every frame of ``seconds`` at ``speed`` fits well inside the time limit."""
    return speed > 0 and seconds / speed <= FULL_DECODE_SHARE * time_limit(seconds)


def prepare_args(src: str, *, keyframes: bool, seconds: float | None = None) -> list[str]:
    """The one ffmpeg command, run with the output folder as its working directory. ``-g 2`` puts a keyframe on
    every second of the 2 fps parts, so parts cut exactly every 300 seconds and any frame is cheap to grab."""
    graph = (
        "[0:v]split=2[a][b];"
        f"[a]fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1[parts];"
        f"[b]fps={SCORE_FPS},scale=320:180,select='gte(scene,0)',"
        f"metadata=print:key=lavfi.scene_score:file={SCORES_FILE}[scores]"
    )
    args = ["ffmpeg", "-v", "error", "-y"]
    if keyframes:
        args += ["-skip_frame", "nokey"]
    if seconds:
        args += ["-t", str(int(seconds))]  # an input option: it caps both outputs, not only the first
    args += ["-i", src]
    return [
        *args,
        "-an",
        "-filter_complex",
        graph,
        "-map",
        "[parts]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-g",
        str(FPS),
        "-pix_fmt",
        "yuv420p",
        "-f",
        "segment",
        "-segment_time",
        str(PART_SECONDS),
        "-reset_timestamps",
        "1",
        PART_PATTERN,
        "-map",
        "[scores]",
        "-f",
        "null",
        "-",
    ]


def parse_scores(text: str) -> tuple[list[float], list[float]]:
    """``metadata=print`` output as ``(motion, scene)``: per second, the mean and the largest picture change."""
    sums: dict[int, list[float]] = {}
    t: float | None = None
    for line in text.splitlines():
        m = _PTS.search(line)
        if m:
            t = float(m.group(1))
            continue
        s = _SCORE.search(line)
        if s and t is not None and t >= 0:
            sums.setdefault(int(t), []).append(float(s.group(1)))
            t = None
    if not sums:
        return [], []
    n = max(sums) + 1
    motion = [0.0] * n
    scene = [0.0] * n
    for sec, values in sums.items():
        motion[sec] = round(sum(values) / len(values), 4)
        scene[sec] = round(max(values), 4)
    return motion, scene


async def prepare(
    src: str, out_dir: Path, *, seconds: float, keyframes: bool, limit_seconds: float | None = None
) -> tuple[list[Path], list[float], list[float]]:
    """Runs the decode. Returns the part files in order and the per-second scores."""
    out_dir.mkdir(parents=True, exist_ok=True)
    await proc.run(
        prepare_args(src, keyframes=keyframes, seconds=limit_seconds),
        time_limit=time_limit(seconds),
        cwd=out_dir,
    )
    scores = out_dir / SCORES_FILE
    try:
        motion, scene = parse_scores(scores.read_text("utf-8", "replace")) if scores.is_file() else ([], [])
    finally:
        scores.unlink(missing_ok=True)
    return sorted(out_dir.glob("part-*.mp4")), motion, scene


async def shrink(part: Path) -> Path:
    """A part over PART_MAX_BYTES, encoded once more, smaller. The same file name; the caller checks the size."""
    small = part.with_suffix(".small.mp4")
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(part),
            "-an",
            "-vf",
            f"scale={SMALL_WIDTH}:{SMALL_HEIGHT}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "34",
            "-g",
            str(FPS),
            "-pix_fmt",
            "yuv420p",
            str(small),
        ],
        time_limit=20 * 60,
    )
    small.replace(part)
    return part


@dataclass(frozen=True)
class MotionSpike:
    t: int
    lift: float  # how many times the usual picture change around it


def motion_spikes(
    motion: list[float], start: float = 0, end: float | None = None, limit: int = 15
) -> list[MotionSpike]:
    """Seconds whose picture changes much more than the minutes around them (a crash, a chase, a jump cut): at
    least SPIKE_LIFT times the median of the 150 seconds either side. Merged when close, the strongest ``limit`` in
    time order; the picture twin of ``loudness.spikes``."""
    stop = len(motion) if end is None else min(int(end), len(motion))
    found: list[MotionSpike] = []
    for t in range(max(0, int(start)), stop):
        v = motion[t]
        if v < MIN_MOTION:
            continue
        around = sorted(x for x in motion[max(0, t - SPIKE_WINDOW) : t + SPIKE_WINDOW + 1] if x > 0)
        if len(around) < 10:
            continue
        median = around[len(around) // 2]
        lift = v / max(median, 0.001)
        if lift >= SPIKE_LIFT:
            found.append(MotionSpike(t, round(min(lift, 99.0), 1)))
    merged: list[MotionSpike] = []
    for s in found:
        if merged and s.t - merged[-1].t <= 6:
            if s.lift > merged[-1].lift:
                merged[-1] = s
        else:
            merged.append(s)
    strongest = sorted(merged, key=lambda s: -s.lift)[:limit]
    return sorted(strongest, key=lambda s: s.t)


def grid(t: float) -> float:
    """``t`` on the parts' half-second frame grid."""
    return round(t * FPS) / FPS


async def grab_frames(part: Path, t0: float, t1: float, out_dir: Path) -> list[tuple[float, bytes]]:
    """Every 2 fps frame of ``part`` from ``t0`` up to ``t1`` (seconds in the part) as ``(time, jpeg)``."""
    a = max(0.0, int(t0 * FPS) / FPS)
    if t1 <= a:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{a:.2f}",
                "-t",
                f"{t1 - a:.2f}",
                "-i",
                str(part),
                "-q:v",
                "5",
                "-start_number",
                "0",
                str(out_dir / "f-%05d.jpg"),
            ],
            time_limit=300,
        )
        files = sorted(out_dir.glob("f-*.jpg"))
        return [(a + j / FPS, f.read_bytes()) for j, f in enumerate(files)]
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


Fetch = Callable[[str, Path], Awaitable[None]]


class Frames:
    """Frames of the source by time, read from the 300-second parts: from this container's disk when the part is
    still there, else fetched from S3 first (a retried job, or a look after the parts were deleted)."""

    def __init__(self, pic: Picture, local_dir: Path, fetch: Fetch) -> None:
        self.pic = pic
        self.local_dir = local_dir
        self._fetch = fetch
        self._sem = asyncio.Semaphore(GRAB_CONCURRENCY)
        self._locks: dict[int, asyncio.Lock] = {}
        self._n = 0

    def local(self, part: Part) -> Path:
        return self.local_dir / f"part-{part.i:04d}.mp4"

    async def file(self, part: Part) -> Path:
        path = self.local(part)
        async with self._locks.setdefault(part.i, asyncio.Lock()):
            if not path.is_file() or path.stat().st_size == 0:
                path.parent.mkdir(parents=True, exist_ok=True)
                await self._fetch(part.key, path)
        return path

    async def between(self, t0: float, t1: float) -> list[tuple[float, bytes]]:
        """Every 2 fps frame from ``t0`` up to ``t1`` (seconds in the source), in time order."""
        out: list[tuple[float, bytes]] = []
        for part in self.pic.parts:
            a, b = max(t0, part.start), min(t1, part.end)
            if b <= a:
                continue
            path = await self.file(part)
            self._n += 1
            tmp = self.local_dir / "frames" / f"{self._n:06d}"
            async with self._sem:
                got = await grab_frames(path, a - part.start, b - part.start, tmp)
            out += [(round(part.start + t, 2), jpeg) for t, jpeg in got]
        return out

    def forget_local(self) -> None:
        """Deletes the local parts and frames (render needs the disk); later looks fetch from S3 again."""
        shutil.rmtree(self.local_dir, ignore_errors=True)
        log("info", "picture.local_removed", dir=self.local_dir.name)
