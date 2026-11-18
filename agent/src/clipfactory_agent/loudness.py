"""Loudness per second (dB RMS) with ffmpeg, and the spikes that usually mean shouting or laughing."""

from __future__ import annotations

import json
import math
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


# --- the finished clip's loudness: every platform plays clips at about -14 LUFS, so each clip is made that loud ------

TARGET_LUFS = -14.0
TARGET_TP = -1.5  # loudnorm's ceiling; the AAC encode after it adds a few tenths, so the file stays at or under -1 dBTP
TARGET_LRA = 11.0
QUIETEST_LUFS = -45.0  # quieter than this is silence or hum: nothing worth turning up
_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def parse_loudnorm(stderr: str) -> dict[str, float] | None:
    """The JSON block ``loudnorm=print_format=json`` prints, as numbers, or None when it is missing or not finite."""
    found = _JSON.findall(stderr)
    if not found:
        return None
    try:
        raw = json.loads(found[-1])
        out = {k: float(raw[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in out.values()):
        return None
    return out


def loudnorm_filter(measured: dict[str, float] | None) -> str:
    """The loudnorm filter: first pass (``measured`` None) only measures, second pass applies the measured values.
    ``linear=true`` turns the whole clip up or down by one amount; when that would push the peaks over the ceiling,
    loudnorm limits the loud moments instead of clipping them, so a quiet voice is only turned up without distortion."""
    base = f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
    if measured is None:
        return base + ":print_format=json"
    return (
        f"{base}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true:print_format=json"
    )


async def measure_loudness(media: Path) -> dict[str, float] | None:
    r = await proc.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(media),
            "-vn",
            "-af",
            loudnorm_filter(None),
            "-f",
            "null",
            "-",
        ],
        time_limit=600,
    )
    return parse_loudnorm(r.stderr)


async def normalize(video: Path, tmp: Path) -> dict[str, float] | None:
    """Two-pass loudnorm on ``video`` in place (the picture is copied untouched). Returns the clip's loudness before and
    after (``before_lufs``, ``lufs``, ``true_peak``), or None when it was left as it was (silence, or ffmpeg failed)."""
    try:
        first = await measure_loudness(video)
        if first is None or first["input_i"] < QUIETEST_LUFS:
            return None
        await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(video),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-c:v",
                "copy",
                "-af",
                loudnorm_filter(first) + ",aresample=48000",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-ar",
                "48000",
                "-movflags",
                "+faststart",
                str(tmp),
            ],
            time_limit=600,
        )
        after = await measure_loudness(tmp)
        if after is None:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(video)
    except proc.CommandError:
        tmp.unlink(missing_ok=True)
        return None
    return {"before_lufs": first["input_i"], "lufs": after["input_i"], "true_peak": after["input_tp"]}
