"""The character editor's sound samples are the synth's own sounds, and up to date (docs/CONTRACTS.md §45.41, ADR-90).

When this fails after a change to audio.py or samples.py, run ``uv run python -m lamostories_agent.samples`` from
stories/agent (it needs ffmpeg) and commit web/public/sounds/stories and web/src/stories/studio/samplesRoot.ts."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from lamostories_agent import audio, samples

REPO = Path(__file__).resolve().parents[3]
SOUNDS = REPO / samples.SOUNDS_DIR
STALE = "The sound samples are stale: run `uv run python -m lamostories_agent.samples` in stories/agent."


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    return json.loads((SOUNDS / "manifest.json").read_text(encoding="utf-8"))


def _root_ts() -> str:
    return (REPO / samples.ROOT_TS).read_text(encoding="utf-8")


def test_the_recipe_is_the_synths_and_names_the_folder(manifest: dict[str, Any]) -> None:
    rec = samples.recipe()
    assert manifest["recipe"] == rec, STALE
    assert manifest["root"] == f"/sounds/stories/{rec}"
    found = re.search(r'export const SAMPLE_ROOT = "/sounds/stories/([0-9a-f]{10})";', _root_ts())
    assert found and found.group(1) == rec, STALE
    assert _root_ts() == samples.root_ts(rec), STALE


def test_comments_do_not_change_the_recipe() -> None:
    code = "x = 1  # one\n\n\ndef f() -> int:\n    return x\n"
    assert samples.code_key(code) == samples.code_key("# a note\nx = 1\ndef f() -> int:\n    # why\n    return x\n")
    assert samples.code_key(code) != samples.code_key(code.replace("1", "2"))


def test_the_manifest_lists_every_sound_and_every_file_is_there(manifest: dict[str, Any]) -> None:
    assert manifest["sfx"] == list(audio.SFX)
    assert manifest["noises"] == list(audio.NOISES)
    assert manifest["voices"] == ["babble", "hum"]
    assert manifest["pitches"] == list(samples.PITCHES)
    assert len(samples.PITCHES) == 31 and samples.PITCHES[0] == 0.5 and samples.PITCHES[-1] == 2.0
    want = {f"sfx/{sid}.mp3" for sid in audio.SFX}
    want |= {
        f"{v}/p{round(p * 100):03d}/{n}.mp3" for v in ("babble", "hum") for p in samples.PITCHES for n in audio.NOISES
    }
    assert len(want) == len(audio.SFX) + 2 * 31 * len(audio.NOISES)
    assert set(manifest["files"]) == want, STALE
    folder = SOUNDS / manifest["recipe"]
    for path in want:
        f = folder / path
        assert f.is_file(), f"{path} is missing. {STALE}"
        assert f.stat().st_size > 500, f"{path} is too small"
    for m in manifest["files"].values():
        assert m["ms"] > 0 and 0 < m["rms"] < 1


def test_the_sounds_folder_holds_only_this_recipe(manifest: dict[str, Any]) -> None:
    folders = sorted(p.name for p in SOUNDS.iterdir() if p.is_dir())
    assert folders == [manifest["recipe"]], STALE
    files = sorted(p.name for p in SOUNDS.iterdir() if p.is_file() and p.name != ".DS_Store")
    assert files == ["manifest.json"]


def test_the_samples_are_the_events_the_videos_play() -> None:
    honk = samples.Sample("sfx", "honk").event()
    assert honk == {"at": 0, "kind": "sfx", "id": "honk", "volume": 0.8, "pan": 0}  # its own length, as in tracks.ts
    assert samples.Sample("sfx", "engine").event()["dur"] == 2.5
    assert samples.Sample("sfx", "tick").event()["dur"] == 2.0
    gasp = samples.Sample("noise", "gasp", "hum", 1.5).event()
    assert gasp == {"at": 0, "kind": "noise", "id": "gasp", "volume": 0.9, "pitch": 1.5, "pan": 0, "voice": "hum"}
    assert samples.Sample("noise", "gasp", "hum", 1.5).path == "hum/p150/gasp.mp3"
    assert samples.folder(0.5) == "p050" and samples.folder(2) == "p200"


SPOTS = [
    samples.Sample("sfx", "honk"),
    samples.Sample("sfx", "engine"),
    samples.Sample("noise", "gasp", "babble", 1.0),
    samples.Sample("noise", "hmm", "hum", 1.5),
]


@pytest.mark.parametrize("sample", SPOTS, ids=lambda s: s.path)
def test_a_fresh_render_matches_the_manifest(sample: samples.Sample, manifest: dict[str, Any]) -> None:
    fresh = samples.measure(samples.render(sample))
    kept = manifest["files"][sample.path]
    assert fresh["ms"] == kept["ms"], STALE
    assert fresh["rms"] == pytest.approx(kept["rms"], rel=0.03), STALE


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
@pytest.mark.parametrize("sample", SPOTS, ids=lambda s: s.path)
def test_the_file_on_disk_is_that_sound(sample: samples.Sample, manifest: dict[str, Any]) -> None:
    # PCM against PCM (the MP3's bytes differ between ffmpeg versions): the same length and the same wave.
    fresh = samples.render(sample)
    heard = samples.decode(SOUNDS / manifest["recipe"] / sample.path)
    assert samples.measure(heard)["ms"] == manifest["files"][sample.path]["ms"]
    n = min(fresh.size, heard.size)
    alike = float(np.dot(fresh[:n], heard[:n]) / (np.linalg.norm(fresh[:n]) * np.linalg.norm(heard[:n])))
    assert alike > 0.95, STALE


def test_no_sample_passes_minus_one_dbfs() -> None:
    # One GAIN for the whole library (chosen so the loudest file peaks at -1 dBFS) keeps the videos' levels.
    for sample in SPOTS:
        assert 0 < float(np.max(np.abs(samples.render(sample)))) <= 10 ** (-1 / 20) + 1e-6
