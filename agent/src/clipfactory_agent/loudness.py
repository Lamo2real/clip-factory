"""Loudness per second (dB RMS) with ffmpeg, and the spikes that usually mean shouting or laughing."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import proc

SILENT_DB = -90.0
_RMS = re.compile(r"RMS_level=(-?[\d.]+|-?inf|nan)")


def parse_astats(text: str) -> list[float]:
    out: list[float] = []
    for m in _RMS.finditer(text):
        v = m.group(1)
        out.append(SILENT_DB if v in ("-inf", "inf", "nan") else max(SILENT_DB, round(float(v), 1)))
    return out


async def measure(audio: Path, workdir: Path) -> list[float]:
    """One RMS value per second of audio."""
    stats = workdir / "rms.txt"
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(audio),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-af",
            "asetnsamples=n=16000,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
            f"ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file={stats}",
            "-f",
            "null",
            "-",
        ],
        time_limit=3 * 3600,
    )
    try:
        return parse_astats(stats.read_text("utf-8", "replace"))
    finally:
        stats.unlink(missing_ok=True)


@dataclass(frozen=True)
class Spike:
    t: int
    jump: float
    db: float


def spikes(loud: list[float], start: float = 0, end: float | None = None, limit: int = 15) -> list[Spike]:
    """Seconds much louder than the minute around them, merged when close, the strongest ``limit`` in time order."""
    end = len(loud) if end is None else min(end, len(loud))
    found: list[Spike] = []
    for t in range(max(30, int(start)), min(len(loud) - 30, int(end))):
        around = sorted(v for v in loud[t - 30 : t + 30] if v > -80)
        if not around:
            continue
        median = around[len(around) // 2]
        jump = loud[t] - median
        if jump >= 7 and loud[t] > -32:
            found.append(Spike(t, round(jump, 1), loud[t]))
    merged: list[Spike] = []
    for s in found:
        if merged and s.t - merged[-1].t <= 6:
            if s.jump > merged[-1].jump:
                merged[-1] = s
        else:
            merged.append(s)
    strongest = sorted(merged, key=lambda s: -s.jump)[:limit]
    return sorted(strongest, key=lambda s: s.t)


def first_loud_second(loud: list[float], t: float, window: float = 3, threshold: float = -30) -> float:
    """The first clearly loud second at or after ``t`` (within ``window``), to open on sound instead of mumbling."""
    s = int(t)
    while s <= t + window and s < len(loud):
        if loud[s] > threshold:
            return max(t, s - 0.2)
        s += 1
    return t
