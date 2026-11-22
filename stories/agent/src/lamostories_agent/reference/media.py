"""ffprobe and ffmpeg for reference videos (docs/CONTRACTS.md §45.28, §45.33 "Reference analysis steps").

* ``probe``: length, sizes, whether there is a picture and a sound track;
* ``cut_times``: one ffmpeg pass at about 360 px wide with scene detection (``select='gt(scene,0.3)'``);
* ``sample_frames``: frames at most 512 px on the long edge at a steady rate, from which the analysis picks;
* ``loudness``: momentary loudness every 0.1 s, the integrated loudness and the silences (``ebur128`` and
  ``silencedetect``): the only sound facts the analysis has, because the model cannot hear.

Nothing here reads the network; every command has a time limit.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

SCENE_THRESHOLD = 0.3
DETECT_WIDTH = 360
FRAME_EDGE = 512
_PTS = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
_EBU = re.compile(r"\bt:\s*([0-9.]+)\s+.*?\bM:\s*(-?[0-9.]+|nan|-?inf)", re.I)
_INTEGRATED = re.compile(r"^\s*I:\s*(-?[0-9.]+)\s*LUFS", re.M)
_SIL_START = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SIL_END = re.compile(r"silence_end:\s*([0-9.]+)")


class MediaError(Exception):
    """ffmpeg or ffprobe could not read the file."""


@dataclass
class Probe:
    duration: float
    has_video: bool
    has_audio: bool
    width: int
    height: int


@dataclass
class Loudness:
    integrated: float | None
    momentary: list[tuple[float, float]] = field(default_factory=list)  # (time, LUFS), silence as -70
    silences: list[tuple[float, float]] = field(default_factory=list)


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise MediaError(type(e).__name__) from e


def probe(ffprobe: str, path: Path) -> Probe:
    done = _run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
            "-of",
            "json",
            str(path),
        ],
        120,
    )
    if done.returncode != 0:
        raise MediaError("ffprobe could not read the file")
    try:
        data = json.loads(done.stdout or "{}")
        duration = float((data.get("format") or {}).get("duration") or 0)
    except (ValueError, TypeError) as e:
        raise MediaError("ffprobe gave no length") from e
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    return Probe(
        duration=duration if math.isfinite(duration) else 0.0,
        has_video=video is not None,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        width=int((video or {}).get("width") or 0),
        height=int((video or {}).get("height") or 0),
    )


def cut_times(ffmpeg: str, path: Path, duration: float) -> list[float]:
    """The times of the cuts (scene changes), in order, at least 0.2 s apart and inside the video."""
    vf = f"scale={DETECT_WIDTH}:-2,select='gt(scene,{SCENE_THRESHOLD})',showinfo"
    done = _run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf", vf, "-f", "null", "-"], 1800)
    if done.returncode != 0:
        raise MediaError("ffmpeg could not look for cuts")
    out: list[float] = []
    for m in _PTS.finditer(done.stderr):
        t = round(float(m.group(1)), 3)
        if 0.2 <= t <= duration - 0.2 and (not out or t - out[-1] >= 0.2):
            out.append(t)
    return out


def sample_frames(ffmpeg: str, path: Path, out_dir: Path, fps: float) -> list[tuple[float, Path]]:
    """Frames at ``fps`` per second, scaled so the long edge is at most 512 px: ``[(time, path)]``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    scale = f"scale='if(gt(iw,ih),min({FRAME_EDGE},iw),-2)':'if(gt(iw,ih),-2,min({FRAME_EDGE},ih))'"
    vf = f"fps={fps},{scale}"
    pattern = out_dir / "f_%05d.jpg"
    done = _run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-an",
            "-vf",
            vf,
            "-q:v",
            "4",
            str(pattern),
        ],
        3600,
    )
    if done.returncode != 0:
        raise MediaError("ffmpeg could not take frames")
    files = sorted(out_dir.glob("f_*.jpg"))
    return [(round(i / fps, 3), f) for i, f in enumerate(files)]


def loudness(ffmpeg: str, path: Path) -> Loudness:
    af = "ebur128=framelog=info,silencedetect=noise=-40dB:d=0.6"
    done = _run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", af, "-f", "null", "-"], 1800)
    if done.returncode != 0:
        raise MediaError("ffmpeg could not measure the sound")
    momentary: list[tuple[float, float]] = []
    for m in _EBU.finditer(done.stderr):
        raw = m.group(2).lower()
        value = float(raw) if raw not in ("nan", "inf", "-inf") else -70.0
        momentary.append((round(float(m.group(1)), 2), max(-70.0, value)))
    found = _INTEGRATED.findall(done.stderr)
    integrated = float(found[-1]) if found else None
    if integrated is not None and integrated <= -69.9:
        integrated = None
    silences: list[tuple[float, float]] = []
    starts = [max(0.0, float(s)) for s in _SIL_START.findall(done.stderr)]
    ends = [float(e) for e in _SIL_END.findall(done.stderr)]
    last = momentary[-1][0] if momentary else 0.0
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else last
        if e > s:
            silences.append((round(s, 2), round(e, 2)))
    return Loudness(integrated, momentary, silences)
