"""Sound for Lamo Stories, made with numpy only: no audio files, no licences, no network (docs/CONTRACTS.md §45.11.3).

* every effect of the catalog (``SfxId``) is built from noise, sweeps and envelopes;
* every character noise (``NoiseId``) is a short formant "voice" in the character's pitch (no words: Lamo Stories has
  no voice-over);
* the music is a seeded loop per mood (chords, bass, light drums), the same loop for the same seed;
* the mix is 48 kHz stereo, the music ducked under the effects and noises, then made -14 LUFS with a true peak at or
  under -1 dBTP by ffmpeg's two-pass ``loudnorm`` (as clips are) and written as AAC in an m4a.

Everything is deterministic: the same events, mood and seed give the same samples."""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from . import proc

SR = 48_000
PEAK = 0.9  # every synthesized sound peaks here before its volume
TARGET_LUFS = -14.0
TARGET_TP = -1.5  # the AAC encode after loudnorm adds a few tenths, so the file stays at or under -1 dBTP
TARGET_LRA = 11.0
QUIETEST_LUFS = -60.0
MUSIC_LEVEL = 0.45  # music under the effects, before the mood's own volume
DUCK_DEPTH = 0.55  # the music drops to 45 % while an effect or a noise plays
_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)

Synth = Callable[[np.random.Generator, float | None], np.ndarray]


def rng_for(*parts: object) -> np.random.Generator:
    digest = hashlib.sha256("\x1f".join(str(p) for p in parts).encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "big"))


def _n(seconds: float) -> int:
    return max(1, round(seconds * SR))


def _t(seconds: float) -> np.ndarray:
    return np.arange(_n(seconds), dtype=np.float64) / SR


def _norm(x: np.ndarray, peak: float = PEAK) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m < 1e-9:
        return x.astype(np.float32)
    return (x * (peak / m)).astype(np.float32)


def _fade(x: np.ndarray, attack: float = 0.004, release: float = 0.02) -> np.ndarray:
    """Short fades at both ends, so no sound starts or stops with a click."""
    a, r = min(len(x), _n(attack)), min(len(x), _n(release))
    x = x.copy()
    x[:a] *= np.linspace(0, 1, a, endpoint=False)
    x[len(x) - r :] *= np.linspace(1, 0, r)
    return x


def _decay(seconds: float, rate: float) -> np.ndarray:
    return np.exp(-rate * _t(seconds))


def _bell(seconds: float, peak_at: float = 0.4) -> np.ndarray:
    t = _t(seconds) / max(seconds, 1e-6)
    up = np.clip(t / peak_at, 0, 1)
    down = np.clip((1 - t) / (1 - peak_at), 0, 1)
    return np.sin(np.minimum(up, down) * math.pi / 2) ** 2


def _band(x: np.ndarray, lo: float | None = None, hi: float | None = None) -> np.ndarray:
    """A soft band-pass in the frequency domain (smooth edges, no ringing worth hearing)."""
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    gain = np.ones_like(f)
    if lo:
        gain *= 1 / (1 + (lo / np.maximum(f, 1.0)) ** 4)
    if hi:
        gain *= 1 / (1 + (f / hi) ** 4)
    return np.fft.irfft(spec * gain, len(x))


def _peaks(x: np.ndarray, formants: Sequence[tuple[float, float, float]], floor: float = 0.02) -> np.ndarray:
    """Resonant peaks (frequency, bandwidth, gain) applied to ``x``: a vowel's formants."""
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    gain = np.full_like(f, floor)
    for fc, bw, g in formants:
        gain += g * np.exp(-0.5 * ((f - fc) / bw) ** 2)
    return np.fft.irfft(spec * gain, len(x))


def _phase(freq: np.ndarray | float, n: int) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, np.float64), (n,))
    return 2 * math.pi * np.cumsum(f) / SR


def _wave(kind: str, ph: np.ndarray) -> np.ndarray:
    if kind == "sine":
        return np.sin(ph)
    if kind == "tri":
        return 2 / math.pi * np.arcsin(np.sin(ph))
    # Band-limited enough for these low notes: a few harmonics, falling off like a saw or a square.
    odd = kind == "square"
    out = np.zeros_like(ph)
    for h in range(1, 14):
        if odd and h % 2 == 0:
            continue
        out += np.sin(h * ph) / h
    return out * (0.6 if odd else 0.5)


def _noise(rng: np.random.Generator, seconds: float) -> np.ndarray:
    return rng.standard_normal(_n(seconds))


# --- effects (SfxId) ------------------------------------------------------------------------------------------------


def _whoosh(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.6
    n = _noise(rng, d)
    low, high = _band(n, 250, 900), _band(n, 900, 4000)
    t = _t(d) / d
    return _bell(d, 0.55) * (low * (1 - t) + high * t)


def _skid(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 1.0
    t = _t(d)
    drift = np.cumsum(rng.standard_normal(len(t))) * 0.04  # a slow random wander of a few hertz
    squeal = np.sin(_phase(1450 + 90 * np.sin(2 * math.pi * 7 * t) + drift, len(t)))
    hiss = _band(_noise(rng, d), 1200, 5000)
    env = np.minimum(1, t / 0.03) * np.exp(-1.2 * t)
    return env * (0.7 * squeal + 0.5 * hiss / (np.max(np.abs(hiss)) + 1e-9))


def _screech(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 0.9
    t = _t(d)
    f = 2400 + 300 * np.sin(2 * math.pi * 11 * t) - 400 * t
    ph = _phase(f, len(t))
    tone = np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3.01 * ph)
    return np.minimum(1, t / 0.02) * np.exp(-1.5 * t) * (tone + 0.3 * _band(_noise(rng, d), 2000, 7000))


def _tyre_burst(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.7
    t = _t(d)
    bang = _noise(rng, d) * np.exp(-40 * t)
    thump = np.sin(_phase(110 * np.exp(-6 * t) + 40, len(t))) * np.exp(-9 * t)
    hiss = _band(_noise(rng, d), 2500, 9000) * np.exp(-4 * t) * 0.25
    return bang + 1.2 * thump + hiss


def _thud(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.4
    t = _t(d)
    body = np.sin(_phase(75 * np.exp(-3 * t) + 35, len(t))) * np.exp(-12 * t)
    knock = _band(_noise(rng, d), 80, 600) * np.exp(-45 * t) * 0.15
    return body + knock


def _bump(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.25
    t = _t(d)
    return np.sin(_phase(140 * np.exp(-5 * t) + 50, len(t))) * np.exp(-16 * t) + 0.1 * _band(
        _noise(rng, d), 200, 1500
    ) * np.exp(-60 * t)


def _honk(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 0.6
    n = _n(d)
    tone = _wave("square", _phase(415, n)) + _wave("square", _phase(523, n))
    return np.tanh(1.6 * tone) * _fade(np.ones(n), 0.01, 0.06)


def _engine(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 2.0
    t = _t(d)
    f0 = 48 + 4 * np.sin(2 * math.pi * 0.7 * t)
    ph = _phase(f0, len(t))
    body = _wave("saw", ph) * (0.75 + 0.25 * np.sin(4 * ph))  # the cylinders' pulse
    rumble = _band(_noise(rng, d), 40, 300) * 0.3
    return _band(body + rumble, 30, 1200) * _fade(np.ones(len(t)), 0.15, 0.3)


def _brake_squeal(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 0.8
    t = _t(d)
    beat = np.sin(_phase(3050, len(t))) + 0.8 * np.sin(_phase(3190 + 30 * np.sin(2 * math.pi * 5 * t), len(t)))
    return beat * np.minimum(1, t / 0.05) * np.exp(-1.8 * t)


def _pop(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.14
    t = _t(d)
    return np.sin(_phase(900 * np.exp(-18 * t) + 250, len(t))) * np.exp(-30 * t) + 0.2 * _noise(rng, d) * np.exp(
        -200 * t
    )


def _boing(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.8
    t = _t(d)
    f = 230 + 130 * np.sin(2 * math.pi * 11 * t) * np.exp(-3.5 * t) + 60 * t
    return np.sin(_phase(f, len(t))) * np.minimum(1, t / 0.005) * np.exp(-3.2 * t)


def _ding(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 1.4
    t = _t(d)
    out = np.zeros_like(t)
    for ratio, amp, rate in ((1.0, 1.0, 3.0), (2.76, 0.5, 5.0), (5.4, 0.25, 8.0), (8.93, 0.1, 12.0)):
        out += amp * np.sin(_phase(1046.5 * ratio, len(t))) * np.exp(-rate * t)
    return out * np.minimum(1, t / 0.002)


def _note(freq: float, seconds: float, kind: str = "saw", attack: float = 0.01, release: float = 0.08) -> np.ndarray:
    n = _n(seconds)
    return _wave(kind, _phase(freq, n)) * _fade(np.ones(n), attack, release)


def _tada(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    short = sum(_note(midi_hz(m), 0.14, "saw") for m in (60, 64, 67))
    long = sum(_note(midi_hz(m), 1.0, "saw", 0.02, 0.5) for m in (60, 64, 67, 72))
    gap = np.zeros(_n(0.05))
    out = np.concatenate([short, gap, long])
    return _band(out, 120, 3500)


def _sad_trombone(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    parts = []
    for m in (58, 57, 56):
        parts.append(_note(midi_hz(m), 0.4, "saw", 0.03, 0.08))
        parts.append(np.zeros(_n(0.04)))
    last = _n(1.1)
    t = np.arange(last) / SR
    f = midi_hz(55) * (1 + 0.025 * np.sin(2 * math.pi * 5.5 * t))
    parts.append(_wave("saw", _phase(f, last)) * _fade(np.ones(last), 0.03, 0.4))
    return _band(np.concatenate(parts), 100, 1800)


def _footsteps(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 1.4
    out = np.zeros(_n(d))
    step = _n(0.36)
    for start in range(0, len(out), step):
        k = min(_n(0.08), len(out) - start)
        burst = _band(rng.standard_normal(k), 120, 2500) * np.exp(-50 * np.arange(k) / SR)
        out[start : start + k] += burst * (0.8 + 0.2 * rng.random())
    return out


def _wind(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 3.0
    t = _t(d)
    gust = 0.55 + 0.45 * np.sin(2 * math.pi * 0.35 * t + rng.random() * 6) * np.sin(2 * math.pi * 0.13 * t + 1)
    return _band(_noise(rng, d), 120, 900) * gust * _fade(np.ones(len(t)), 0.4, 0.6)


def _rain(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 3.0
    n = _n(d)
    bed = _band(rng.standard_normal(n), 1500, 9000) * 0.35
    drops = np.zeros(n)
    idx = rng.integers(0, n, size=int(d * 180))
    drops[idx] = rng.uniform(0.3, 1.0, size=len(idx))
    drops = _band(drops, 2000, 8000) * 3
    return (bed + drops) * _fade(np.ones(n), 0.3, 0.5)


def _repeat(one: Callable[[], np.ndarray], dur: float | None, every: float) -> np.ndarray:
    """A short sound repeated every ``every`` seconds for ``dur`` (the engine sets ``dur`` on a repeating effect when
    its beat has a length, §45.10); one sound when there is no ``dur``."""
    if not dur or dur <= every:
        return one()
    out = np.zeros(_n(dur))
    for start in range(0, len(out), _n(every)):
        x = one()[: len(out) - start]
        out[start : start + len(x)] += x
    return out


def _snow_crunch(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    def one() -> np.ndarray:
        d = 0.5
        n = _n(d)
        grains = np.zeros(n)
        idx = rng.integers(0, n, size=500)
        grains[idx] = rng.uniform(-1, 1, size=500)
        return _band(grains, 800, 7000) * _bell(d, 0.3)

    return _repeat(one, dur, 0.55)


def _click(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.05
    t = _t(d)
    return _band(_noise(rng, d), 1500, 9000) * np.exp(-180 * t) + np.sin(_phase(2500, len(t))) * np.exp(-120 * t)


def _beep(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    n = _n(0.3)
    return np.sin(_phase(1000, n)) * _fade(np.ones(n), 0.005, 0.03)


def _swoosh_up(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = 0.6
    t = _t(d)
    sweep = np.sin(_phase(300 + 1400 * (t / d) ** 2, len(t)))
    air = _band(_noise(rng, d), 600, 6000)
    return _bell(d, 0.75) * (0.6 * sweep + 0.4 * air / (np.max(np.abs(air)) + 1e-9))


def _heartbeat(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    d = dur or 1.8
    out = np.zeros(_n(d))
    period = _n(0.9)

    def thump(level: float) -> np.ndarray:
        k = _n(0.16)
        tt = np.arange(k) / SR
        return level * np.sin(_phase(60 * np.exp(-4 * tt) + 30, k)) * np.exp(-22 * tt)

    for start in range(0, len(out), period):
        for offset, level in ((0, 1.0), (_n(0.22), 0.7)):
            s = start + offset
            if s >= len(out):
                continue
            th = thump(level)[: len(out) - s]
            out[s : s + len(th)] += th
    return out


def _tick(rng: np.random.Generator, dur: float | None) -> np.ndarray:
    def one() -> np.ndarray:
        d = 0.05
        t = _t(d)
        return np.sin(_phase(1900, len(t))) * np.exp(-110 * t) + 0.3 * np.sin(_phase(3700, len(t))) * np.exp(-160 * t)

    return _repeat(one, dur, 0.5)


SFX: dict[str, Synth] = {
    "whoosh": _whoosh,
    "skid": _skid,
    "screech": _screech,
    "tyre_burst": _tyre_burst,
    "thud": _thud,
    "bump": _bump,
    "honk": _honk,
    "engine": _engine,
    "brake_squeal": _brake_squeal,
    "pop": _pop,
    "boing": _boing,
    "ding": _ding,
    "tada": _tada,
    "sad_trombone": _sad_trombone,
    "footsteps": _footsteps,
    "wind": _wind,
    "rain": _rain,
    "snow_crunch": _snow_crunch,
    "click": _click,
    "beep": _beep,
    "swoosh_up": _swoosh_up,
    "heartbeat": _heartbeat,
    "tick": _tick,
}
# Effects that take the event's ``dur`` (they loop or hold); the others have their own length.
LOOPING = frozenset(
    {
        "engine",
        "wind",
        "rain",
        "footsteps",
        "heartbeat",
        "tick",
        "snow_crunch",
        "skid",
        "screech",
        "honk",
        "brake_squeal",
    }
)
MAX_EFFECT_SECONDS = 15.0


# --- character noises (NoiseId): formant voices, no words -------------------------------------------------------

VOWELS: dict[str, tuple[tuple[float, float, float], ...]] = {
    "a": ((800, 90, 1.0), (1200, 110, 0.55), (2600, 150, 0.25)),
    "e": ((450, 70, 1.0), (1900, 120, 0.45), (2600, 150, 0.25)),
    "i": ((300, 60, 1.0), (2300, 130, 0.35), (3100, 160, 0.2)),
    "o": ((480, 70, 1.0), (850, 90, 0.5), (2600, 150, 0.15)),
    "u": ((330, 55, 1.0), (750, 80, 0.3), (2400, 150, 0.1)),
    "m": ((260, 60, 1.0), (1100, 150, 0.08), (2300, 200, 0.04)),
}
BASE_F0 = 220.0


def _voice(
    rng: np.random.Generator,
    seconds: float,
    pitch: float,
    contour: Sequence[float],
    vowels: Sequence[str],
    breath: float = 0.08,
    voiced: bool = True,
) -> np.ndarray:
    """A short voiced sound: a glottal source at the character's pitch following ``contour`` (relative pitch at even
    points), shaped by each vowel's formants in turn (cross-faded), with a little breath."""
    n = _n(seconds)
    t = np.linspace(0, 1, n)
    rel = np.interp(t, np.linspace(0, 1, len(contour)), contour)
    f0 = BASE_F0 * pitch * rel * (1 + 0.01 * np.sin(2 * math.pi * 5.5 * np.arange(n) / SR))
    ph = _phase(f0, n)
    src = np.zeros(n)
    if voiced:
        top = max(1, int(5000 / max(f0.max(), 1)))
        for h in range(1, min(top, 40) + 1):
            src += np.sin(h * ph) / h**1.1
    src += breath * rng.standard_normal(n) * (3 if not voiced else 1)
    out = np.zeros(n)
    k = len(vowels)
    centers = np.linspace(0, 1, k) if k > 1 else np.array([0.5])
    width = 1 / max(k - 1, 1)
    weights = [np.clip(1 - np.abs(t - c) / width, 0, 1) if k > 1 else np.ones(n) for c in centers]
    total = np.sum(weights, axis=0) + 1e-9
    for v, wgt in zip(vowels, weights, strict=True):
        out += _peaks(src, VOWELS[v]) * (wgt / total)
    return out * _bell(seconds, 0.25)


def _syllables(parts: Sequence[np.ndarray], gap: float = 0.03) -> np.ndarray:
    pad = np.zeros(_n(gap))
    out: list[np.ndarray] = []
    for p in parts:
        out += [p, pad]
    return np.concatenate(out[:-1]) if out else np.zeros(1)


def noise_sound(noise_id: str, pitch: float, rng: np.random.Generator) -> np.ndarray:
    """One character noise in the character's voice pitch (0.5..2; 1 is a middle voice)."""
    p = min(2.0, max(0.5, float(pitch or 1.0)))
    v = _voice
    if noise_id == "gasp":
        x = v(rng, 0.45, p, [1.0, 1.15], ["a", "a"], breath=0.5, voiced=False)
    elif noise_id == "whoa":
        x = v(rng, 0.6, p, [1.25, 1.1, 0.8], ["u", "o", "a"])
    elif noise_id == "hmm":
        x = v(rng, 0.6, p, [0.95, 1.05, 0.95], ["m", "m"], breath=0.02)
    elif noise_id == "yay":
        x = v(rng, 0.5, p, [1.0, 1.4], ["e", "i"])
    elif noise_id == "oops":
        first = v(rng, 0.22, p, [1.2, 1.0], ["u"])
        second = v(rng, 0.28, p, [1.05, 0.8], ["u", "o"])
        s = _band(rng.standard_normal(_n(0.12)), 4000, 9000) * _bell(0.12) * 0.4
        x = _syllables([first, second, s], 0.02)
    elif noise_id == "laugh":
        x = _syllables([v(rng, 0.12, p * (1.1 - 0.04 * i), [1.1, 0.95], ["a"], breath=0.25) for i in range(5)], 0.05)
    elif noise_id == "giggle":
        x = _syllables([v(rng, 0.08, p * 1.4, [1.2, 1.05], ["i"], breath=0.2) for _ in range(5)], 0.04)
    elif noise_id == "sigh":
        x = v(rng, 0.9, p, [1.0, 0.75], ["a", "o"], breath=0.6, voiced=False)
    elif noise_id == "yelp":
        x = v(rng, 0.25, p, [1.2, 1.8, 1.3], ["a", "e"])
    elif noise_id == "phew":
        f = _band(rng.standard_normal(_n(0.18)), 1500, 7000) * _bell(0.18) * 0.5
        x = _syllables([f, v(rng, 0.45, p, [1.05, 0.8], ["u", "u"])], 0.0)
    elif noise_id == "babble":
        order = list(VOWELS)[:5]
        sy = []
        for _ in range(6):
            vowel = order[int(rng.integers(0, len(order)))]
            up = 0.9 + 0.3 * float(rng.random())
            sy.append(v(rng, 0.11 + 0.05 * float(rng.random()), p, [up, up * 0.95], [vowel], breath=0.06))
        x = _syllables(sy, 0.035)
    else:
        raise KeyError(noise_id)
    return _norm(_fade(x))


NOISES = ("gasp", "whoa", "hmm", "yay", "oops", "laugh", "giggle", "sigh", "yelp", "phew", "babble")


def effect_sound(sfx_id: str, rng: np.random.Generator, dur: float | None = None) -> np.ndarray:
    fn = SFX[sfx_id]
    hold = min(MAX_EFFECT_SECONDS, max(0.2, float(dur))) if dur and sfx_id in LOOPING else None
    return _norm(_fade(fn(rng, hold)))


# --- music: one seeded loop per mood ---------------------------------------------------------------------------


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


SCALES = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10), "lydian": (0, 2, 4, 6, 7, 9, 11)}
MOODS: dict[str, dict[str, Any]] = {
    "calm": {
        "bpm": 72,
        "scale": "major",
        "root": 60,
        "prog": (0, 5, 3, 4),
        "lead": "sine",
        "drums": "soft",
        "pad": True,
    },
    "playful": {
        "bpm": 112,
        "scale": "major",
        "root": 62,
        "prog": (0, 3, 4, 0),
        "lead": "tri",
        "drums": "light",
        "pad": False,
    },
    "tense": {
        "bpm": 92,
        "scale": "minor",
        "root": 57,
        "prog": (0, 0, 5, 4),
        "lead": None,
        "drums": "pulse",
        "pad": True,
    },
    "triumphant": {
        "bpm": 100,
        "scale": "major",
        "root": 60,
        "prog": (0, 4, 5, 3),
        "lead": "saw",
        "drums": "full",
        "pad": True,
    },
    "wonder": {
        "bpm": 80,
        "scale": "lydian",
        "root": 65,
        "prog": (0, 1, 0, 1),
        "lead": "bell",
        "drums": None,
        "pad": True,
    },
    "comedic": {
        "bpm": 124,
        "scale": "major",
        "root": 60,
        "prog": (0, 4, 0, 4),
        "lead": "square",
        "drums": "woodblock",
        "pad": False,
    },
}
MOOD_IDS = ("none", *MOODS)


def _degree(scale: Sequence[int], root: int, deg: int) -> int:
    octave, idx = divmod(deg, len(scale))
    return root + 12 * octave + scale[idx]


def _drum(kind: str, rng: np.random.Generator) -> np.ndarray:
    if kind == "kick":
        d = 0.3
        t = _t(d)
        return np.sin(_phase(120 * np.exp(-14 * t) + 42, len(t))) * np.exp(-9 * t)
    if kind == "snare":
        d = 0.18
        t = _t(d)
        return 0.6 * _band(_noise(rng, d), 1200, 6000) * np.exp(-22 * t) + 0.4 * np.sin(_phase(185, len(t))) * np.exp(
            -30 * t
        )
    if kind == "hat":
        d = 0.05
        t = _t(d)
        return _band(_noise(rng, d), 7000, None) * np.exp(-90 * t) * 0.5
    d = 0.07  # woodblock
    t = _t(d)
    return np.sin(_phase(1250, len(t))) * np.exp(-70 * t)


def _add(buf: np.ndarray, at: int, x: np.ndarray, gain: float) -> None:
    if at >= len(buf):
        return
    k = min(len(x), len(buf) - at)
    buf[at : at + k] += gain * x[:k]


def music_loop(mood: str, seed: int) -> np.ndarray:
    """Four bars of ``mood`` (one chord a bar), the same for the same seed. Mono, not normalized."""
    m = MOODS[mood]
    rng = rng_for("music", mood, seed)
    beat = 60.0 / m["bpm"]
    bar = 4 * beat
    out = np.zeros(_n(4 * bar))
    scale = SCALES[m["scale"]]
    root = int(m["root"])
    for b, chord_deg in enumerate(m["prog"]):
        start = b * bar
        chord = [_degree(scale, root, chord_deg + k) for k in (0, 2, 4)]
        if m["pad"]:
            for note in chord:
                for detune in (-0.08, 0.08):
                    x = _note(midi_hz(note + detune), bar, "tri", 0.25, 0.4)
                    _add(out, _n(start), x, 0.09)
        bass = midi_hz(chord[0] - 24)
        pattern = (0, 2) if m["drums"] != "woodblock" else (0, 1, 2, 3)
        for k in pattern:
            x = _note(bass, beat * (0.9 if m["drums"] == "woodblock" else 1.8), "saw", 0.01, 0.1)
            _add(out, _n(start + k * beat), _band(x, None, 900), 0.22)
        lead = m["lead"]
        if lead:
            steps = 8 if m["bpm"] > 100 else 4
            for k in range(steps):
                if rng.random() < 0.3:
                    continue
                deg = chord_deg + int(rng.choice([0, 2, 4, 5, 7]))
                f = midi_hz(_degree(scale, root + 12, deg))
                length = bar / steps * (0.45 if lead in ("square", "tri") else 0.9)
                if lead == "bell":
                    x = sum(
                        a * np.sin(_phase(f * r, _n(length * 2))) * _decay(length * 2, 4 + 3 * r)
                        for r, a in ((1, 1.0), (2.0, 0.3), (3.01, 0.15))
                    )
                else:
                    x = _note(f, length, lead, 0.01, 0.05)
                _add(out, _n(start + k * bar / steps), x, 0.12)
        drums = m["drums"]
        if drums:
            for k in range(8):
                at = _n(start + k * beat / 2)
                if drums in ("light", "full", "soft") and k % 4 == 0:
                    _add(out, at, _drum("kick", rng), 0.5 if drums != "soft" else 0.25)
                if drums in ("light", "full") and k % 4 == 2:
                    _add(out, at, _drum("snare", rng), 0.25 if drums == "light" else 0.35)
                if drums in ("light", "full", "pulse"):
                    _add(out, at, _drum("hat", rng), 0.18)
                if drums == "pulse" and k % 2 == 0:
                    _add(out, at, _drum("kick", rng), 0.35)
                if drums == "woodblock" and k % 2 == 1:
                    _add(out, at, _drum("wood", rng), 0.2)
    return out


def music(mood: str, seconds: float, seed: int) -> np.ndarray:
    """The mood's loop for ``seconds`` (mono), faded in and out; silence for ``none`` or an unknown mood."""
    n = _n(seconds)
    if mood not in MOODS:
        return np.zeros(n, np.float32)
    loop = music_loop(mood, seed)
    reps = n // len(loop) + 1
    out = np.tile(loop, reps)[:n]
    return _norm(_fade(out, 0.5, min(2.0, seconds / 4)), 1.0)


# --- the mix -------------------------------------------------------------------------------------------------------


def _pan(x: np.ndarray, pan: float) -> np.ndarray:
    a = (min(1.0, max(-1.0, pan)) + 1) * math.pi / 4
    return np.stack([x * math.cos(a), x * math.sin(a)])


def _envelope(x: np.ndarray, attack: float = 0.01, release: float = 0.3) -> np.ndarray:
    """A smoothed level of ``x`` (fast up, slow down) per sample, for the ducking."""
    block = 480
    n = len(x)
    blocks = max(1, math.ceil(n / block))
    padded = np.zeros(blocks * block)
    padded[:n] = np.abs(x)
    lvl = padded.reshape(blocks, block).max(axis=1)
    up = 1 - math.exp(-block / (attack * SR))
    down = 1 - math.exp(-block / (release * SR))
    out = np.zeros(blocks)
    cur = 0.0
    for i, v in enumerate(lvl):
        cur += (v - cur) * (up if v > cur else down)
        out[i] = cur
    return np.repeat(out, block)[:n]


def mix(
    events: Sequence[dict[str, Any]],
    seconds: float,
    *,
    mood: str | None,
    music_volume: float,
    seed: int,
    default_pitch: float = 1.0,
) -> np.ndarray:
    """The story's sound as (2, n) float32 at 48 kHz: every event at its time, volume and pan, over the mood's music
    ducked while effects play. Not loudness-normalized yet (``master`` does that)."""
    n = _n(seconds)
    fx = np.zeros((2, n))
    for i, e in enumerate(sorted(events, key=lambda e: float(e.get("at") or 0))):
        kind, sid = str(e.get("kind") or ""), str(e.get("id") or "")
        rng = rng_for("event", seed, i, kind, sid)
        try:
            if kind == "noise":
                x = noise_sound(sid, float(e.get("pitch") or default_pitch), rng)
            elif kind == "sfx":
                x = effect_sound(sid, rng, e.get("dur"))
            else:
                continue
        except KeyError:
            continue  # an id this synth does not know is left out (the engine's catalog test keeps them in step)
        at = max(0, round(float(e.get("at") or 0) * SR))
        if at >= n:
            continue
        vol = min(1.0, max(0.0, float(e.get("volume", 0.8))))
        stereo = _pan(x, float(e.get("pan") or 0.0)) * vol
        k = min(stereo.shape[1], n - at)
        fx[:, at : at + k] += stereo[:, :k]
    out = fx
    if mood and mood in MOODS and music_volume > 0:
        bed = music(mood, seconds, seed).astype(np.float64) * MUSIC_LEVEL * min(1.0, music_volume)
        duck = 1 - DUCK_DEPTH * np.clip(_envelope(fx.max(axis=0)) / 0.3, 0, 1)
        out = fx + _pan(bed * duck, 0.0) * math.sqrt(2)
    out = compress(out)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.98:
        out = out * (0.98 / peak)
    return out.astype(np.float32)


def compress(stereo: np.ndarray, threshold: float = 0.25, ratio: float = 4.0, release: float = 0.15) -> np.ndarray:
    """A gentle bus compressor: loud moments (a bang, a honk) come down towards the music, so the whole mix can be
    made -14 LUFS by one linear gain without its peaks passing -1 dBTP (loudnorm then never has to squash it)."""
    n = stereo.shape[1]
    if n == 0:
        return stereo
    block = 64
    blocks = math.ceil(n / block)
    level = np.zeros(blocks * block)
    level[:n] = np.abs(stereo).max(axis=0)
    peaks = level.reshape(blocks, block).max(axis=1)
    down = math.exp(-block / (release * SR))
    env = np.empty(blocks)
    cur = 0.0
    for i, v in enumerate(peaks):
        cur = v if v > cur else cur * down + v * (1 - down)
        env[i] = cur
    over = 20 * np.log10(np.maximum(env, 1e-9) / threshold)
    gain_db = -(1 - 1 / ratio) * np.maximum(over, 0.0)
    centers = (np.arange(blocks) + 0.5) * block
    gain = np.interp(np.arange(n), centers, 10 ** (gain_db / 20))
    return stereo * gain


def wav_bytes(stereo: np.ndarray) -> bytes:
    """A 32-bit float WAV of a (2, n) array at 48 kHz."""
    data = np.ascontiguousarray(stereo.T.astype("<f4")).tobytes()
    fmt = struct.pack("<HHIIHH", 3, 2, SR, SR * 8, 8, 32)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def parse_loudnorm(stderr: str) -> dict[str, float] | None:
    found = _JSON.findall(stderr)
    if not found:
        return None
    try:
        raw = json.loads(found[-1])
        out = {k: float(raw[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (KeyError, TypeError, ValueError):
        return None
    return out if all(math.isfinite(v) for v in out.values()) else None


def loudnorm_filter(measured: dict[str, float] | None, tp: float = TARGET_TP) -> str:
    base = f"loudnorm=I={TARGET_LUFS}:TP={tp}:LRA={TARGET_LRA}"
    if measured is None:
        return base + ":print_format=json"
    return (
        f"{base}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true:print_format=json"
    )


async def measure(path: Path) -> dict[str, float] | None:
    r = await proc.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", loudnorm_filter(None), "-f", "null", "-"],
        time_limit=600,
    )
    return parse_loudnorm(r.stderr)


async def _encode(wav: Path, out: Path, af: str) -> None:
    await proc.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(wav), "-af", af,
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(out),
        ],
        time_limit=600,
    )  # fmt: skip


MAX_TP = -1.0
TP_TRIES = 3


async def master(stereo: np.ndarray, wav: Path, out: Path) -> dict[str, float] | None:
    """``stereo`` → ``out`` (m4a, AAC, 48 kHz stereo) through two-pass loudnorm to -14 LUFS, ≤ -1 dBTP. The AAC
    encode can overshoot loudnorm's ceiling by a few tenths, so a file whose true peak ends above -1 dBTP is made
    again with a lower ceiling. Silence (or near silence) is encoded as it is. Returns the loudness measured on the
    file (``lufs``, ``true_peak``), or None for silence."""
    wav.parent.mkdir(parents=True, exist_ok=True)
    wav.write_bytes(wav_bytes(stereo))
    try:
        first = await measure(wav)
        if first is None or first["input_i"] < QUIETEST_LUFS:
            await _encode(wav, out, "aresample=48000")
            return None
        tp = TARGET_TP
        after: dict[str, float] | None = None
        for _ in range(TP_TRIES):
            await _encode(wav, out, loudnorm_filter(first, tp) + ",aresample=48000")
            after = await measure(out)
            if after is None or after["input_tp"] <= MAX_TP:
                break
            tp = round(tp - (after["input_tp"] - MAX_TP) - 0.2, 2)
        return {"lufs": after["input_i"], "true_peak": after["input_tp"]} if after else None
    finally:
        wav.unlink(missing_ok=True)
