"""The sound synth (stories/audio.py): every effect and noise of the engine's catalog is made, with the right length,
a known peak and the same samples every time; the music loops per mood; the mix ducks the music under the effects;
mastering lands at -14 LUFS with a true peak at or under -1 dBTP."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from lamostories_agent import audio
from lamostories_agent.engine import deno_binary
from ls_fakes import ENGINE_DIR, needs_deno, needs_ffmpeg

SR = audio.SR


def engine_catalog() -> dict[str, list[str]]:
    out = subprocess.run(
        [
            deno_binary(),
            "run",
            "--allow-read",
            "--no-config",
            "--no-lock",
            "--quiet",
            str(ENGINE_DIR / "cli.ts"),
            "catalog",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stdout
    cat = json.loads(out)["catalog"]
    return {k: [e["id"] for e in v] for k, v in cat.items() if isinstance(v, list)}  # "looks" is a map (§45.33)


@needs_deno
def test_every_effect_noise_and_mood_of_the_engine_catalog_is_made() -> None:
    cat = engine_catalog()
    assert set(cat["sfx"]) <= set(audio.SFX), set(cat["sfx"]) - set(audio.SFX)
    assert set(cat["noises"]) <= set(audio.NOISES), set(cat["noises"]) - set(audio.NOISES)
    assert set(cat["musicMoods"]) <= set(audio.MOOD_IDS), set(cat["musicMoods"]) - set(audio.MOOD_IDS)


@pytest.mark.parametrize("sfx", sorted(audio.SFX))
def test_each_effect_has_its_length_and_peak(sfx: str) -> None:
    x = audio.effect_sound(sfx, audio.rng_for("t", sfx))
    assert x.dtype == np.float32 and np.isfinite(x).all()
    assert 0.03 <= len(x) / SR <= 3.0
    assert float(np.abs(x).max()) == pytest.approx(audio.PEAK, abs=1e-4)
    assert float(np.sqrt((x**2).mean())) > 0.02  # not silence
    assert abs(float(x[0])) < 0.05 and abs(float(x[-1])) < 0.05  # faded at both ends: no clicks
    if sfx in audio.LOOPING:
        held = audio.effect_sound(sfx, audio.rng_for("t", sfx), 4.25)
        assert len(held) == round(4.25 * SR)


@pytest.mark.parametrize("noise", audio.NOISES)
def test_each_noise_follows_the_voice_pitch(noise: str) -> None:
    low = audio.noise_sound(noise, 0.6, audio.rng_for("n", noise))
    high = audio.noise_sound(noise, 1.8, audio.rng_for("n", noise))
    assert 0.1 <= len(low) / SR <= 1.5
    assert float(np.abs(low).max()) == pytest.approx(audio.PEAK, abs=1e-4)

    def pitch(x: np.ndarray) -> float:
        """The strongest repeat between 60 and 900 Hz (autocorrelation of the loudest part)."""
        mid = int(np.argmax(np.abs(x)))
        part = x[max(0, mid - 2400) : mid + 2400].astype(np.float64)
        ac = np.correlate(part, part, "full")[len(part) - 1 :]
        lo, hi = SR // 900, SR // 60
        return SR / (lo + int(np.argmax(ac[lo:hi])))

    if noise not in ("gasp", "sigh"):  # breath only: no pitch to follow
        assert pitch(high) > pitch(low) * 1.2


def test_the_same_seed_makes_the_same_sound_and_another_seed_another_tune() -> None:
    events = [
        {"at": 0.2, "kind": "sfx", "id": "skid", "volume": 0.8},
        {"at": 0.4, "kind": "noise", "id": "gasp", "volume": 0.9, "pitch": 1.2},
        {"at": 3.5, "kind": "noise", "id": "phew", "volume": 0.9, "pitch": 1.2, "pan": -0.5},
        {"at": 9.9, "kind": "sfx", "id": "beep", "volume": 1.0},  # past the end: left out
        {"at": 1.0, "kind": "sfx", "id": "not_an_effect", "volume": 1.0},  # unknown: left out
    ]
    a = audio.mix(events, 6.0, mood="playful", music_volume=0.4, seed=7)
    b = audio.mix(events, 6.0, mood="playful", music_volume=0.4, seed=7)
    assert a.shape == (2, 6 * SR) and a.dtype == np.float32
    assert np.array_equal(a, b)
    assert float(np.abs(a).max()) <= 0.98
    assert not np.array_equal(audio.music_loop("playful", 7), audio.music_loop("playful", 8))
    for mood in audio.MOODS:
        m = audio.music(mood, 10.0, 3)
        assert len(m) == 10 * SR and float(np.abs(m).max()) == pytest.approx(1.0, abs=1e-4)
    assert float(np.abs(audio.music("none", 2.0, 3)).max()) == 0.0


def test_the_music_is_ducked_under_an_effect() -> None:
    quiet = audio.mix([], 6.0, mood="calm", music_volume=1.0, seed=1)
    under = audio.mix(
        [{"at": 3.0, "kind": "sfx", "id": "honk", "dur": 1.0, "volume": 1.0}],
        6.0,
        mood="calm",
        music_volume=1.0,
        seed=1,
    )
    music_only = audio.mix([], 6.0, mood="calm", music_volume=1.0, seed=1)
    assert np.array_equal(quiet, music_only)
    # just after the honk ends (4.0 s), the music is still coming back up: quieter than without the honk
    w = slice(int(4.05 * SR), int(4.15 * SR))
    assert float(np.abs(under[:, w]).mean()) < float(np.abs(quiet[:, w]).mean()) * 0.9


def test_panning_moves_a_sound_between_the_speakers() -> None:
    left = audio.mix(
        [{"at": 0.1, "kind": "sfx", "id": "beep", "volume": 1.0, "pan": -1}], 1.0, mood=None, music_volume=0, seed=1
    )
    assert float(np.abs(left[0]).max()) > 0.2 and float(np.abs(left[1]).max()) < 1e-3


@needs_ffmpeg
def test_mastering_lands_at_minus_14_lufs_under_minus_1_dbtp(tmp_path: Path) -> None:
    events = [
        {"at": 0.5, "kind": "sfx", "id": "tyre_burst", "volume": 1.0},
        {"at": 1.0, "kind": "noise", "id": "whoa", "volume": 0.9, "pitch": 1.0},
        {"at": 3.0, "kind": "sfx", "id": "engine", "volume": 0.6, "dur": 3},
    ]
    for mood in ("tense", "playful"):
        out = tmp_path / f"{mood}.m4a"
        loud = asyncio.run(
            audio.master(audio.mix(events, 12.0, mood=mood, music_volume=0.5, seed=4), tmp_path / "x.wav", out)
        )
        assert loud is not None
        assert loud["lufs"] == pytest.approx(-14.0, abs=1.0)
        assert loud["true_peak"] <= -1.0
        probe = json.loads(
            subprocess.run(
                ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(out)], capture_output=True, check=True
            ).stdout
        )
        s = probe["streams"][0]
        assert (s["codec_name"], int(s["sample_rate"]), int(s["channels"])) == ("aac", 48000, 2)
    silent = asyncio.run(
        audio.master(audio.mix([], 2.0, mood=None, music_volume=0, seed=1), tmp_path / "s.wav", tmp_path / "s.m4a")
    )
    assert silent is None and (tmp_path / "s.m4a").stat().st_size > 0


def test_a_wav_has_a_valid_header() -> None:
    data = audio.wav_bytes(np.zeros((2, 480), np.float32))
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE" and len(data) == 44 + 480 * 8


def test_repeating_effects_last_as_long_as_their_beat() -> None:
    """The engine gives a repeating effect (footsteps, heartbeat, tick, snow crunch) a ``dur`` when its beat has a
    length; the synth repeats it for that long."""
    for sid in ("footsteps", "heartbeat", "tick", "snow_crunch"):
        short = audio.effect_sound(sid, audio.rng_for("t", sid), None)
        long = audio.effect_sound(sid, audio.rng_for("t", sid), 4.0)
        assert len(long) >= audio.SR * 3.9 > len(short), sid
        assert float(np.max(np.abs(long[-audio.SR :]))) > 0.01, sid  # still sounding at the end


def _spectrum(x: np.ndarray) -> tuple[float, float]:
    """(spectral centroid in Hz, share of the energy above 1 kHz)."""
    spec = np.abs(np.fft.rfft(x.astype(np.float64)))
    f = np.fft.rfftfreq(len(x), 1 / audio.SR)
    return float((spec * f).sum() / spec.sum()), float((spec[f > 1000] ** 2).sum() / (spec**2).sum())


@pytest.mark.parametrize("noise", audio.NOISES)
def test_a_humming_character_makes_a_closed_mouth_hum_not_an_open_voice(noise: str) -> None:
    """§45.34: a noise event with ``voice: "hum"`` is hummed with the mouth closed: its sound sits in the low nasal
    murmur (no open-vowel formants above it), unlike the same noise babbled."""
    hum = audio.hum_sound(noise, 1.0, audio.rng_for("hum", noise))
    open_ = audio.noise_sound(noise, 1.0, audio.rng_for("hum", noise))
    hum_c, hum_hi = _spectrum(hum)
    open_c, _ = _spectrum(open_)
    assert hum_c < 400 and hum_hi < 0.001
    assert hum_c < 0.75 * open_c
    assert np.isfinite(hum).all() and 0.5 < float(np.max(np.abs(hum))) <= audio.PEAK + 1e-6
    assert hum.size > audio.SR * 0.2  # long enough to hear


def test_the_mix_hums_the_noises_of_a_humming_character() -> None:
    event = {"at": 0.1, "kind": "noise", "id": "yay", "volume": 0.9, "pitch": 1.0, "pan": 0.0}
    hummed = audio.mix([{**event, "voice": "hum"}], 1.0, mood=None, music_volume=0.0, seed=3)
    babbled = audio.mix([{**event, "voice": "babble"}], 1.0, mood=None, music_volume=0.0, seed=3)
    plain = audio.mix([event], 1.0, mood=None, music_volume=0.0, seed=3)
    assert np.array_equal(babbled, plain)  # babble is the open voice, as before
    assert _spectrum(hummed[0])[0] < 0.75 * _spectrum(babbled[0])[0]
