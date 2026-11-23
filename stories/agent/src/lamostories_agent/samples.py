"""Clips Funded's sound samples (docs/CONTRACTS.md §45.40, ADR-88): every effect and every character noise, in both
voices at every stop of the editor's pitch slider, rendered ahead of time by this agent's own synth (audio.py) into
small MP3 files the web plays. What the owner hears in the character editor is the sound the videos use.

Run ``python -m lamostories_agent.samples`` from stories/agent (it needs ffmpeg) after a change to audio.py. It writes

* ``web/public/sounds/stories/<recipe>/sfx/<id>.mp3`` (every ``audio.SFX``);
* ``web/public/sounds/stories/<recipe>/{babble,hum}/p050…p200/<id>.mp3`` (every ``audio.NOISES`` at every pitch);
* ``web/public/sounds/stories/manifest.json`` (each file's length and level);
* ``web/src/stories/studio/samplesRoot.ts`` (the folder and the pitch stops, for the web);

and deletes every other recipe folder. ``recipe`` is a hash of audio.py's and this file's code (their tokens, so a
comment does not count; ``ast.dump`` changes between Python versions) and of the settings below: a changed synth is a
new folder name, which also gets past the browsers' 1-hour cache of public files. tests/test_sound_samples.py fails
while the files are stale.

Each sample is one audio event through ``audio.mix`` (the videos' chain, without the final loudnorm), as the engine
writes it (tracks.ts): an effect at volume 0.8, a noise at 0.9, both in the middle. It is mixed down to mono, its
silence at the end trimmed (below -60 dBFS, keeping 50 ms), multiplied by one ``GAIN`` for the whole library (so the
files keep the videos' levels against each other; the loudest peaks at -1 dBFS) and encoded as a 64 kbps mono MP3."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tokenize
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import audio

PITCHES: tuple[float, ...] = tuple(round(0.5 + 0.05 * i, 2) for i in range(31))  # the slider's 31 stops
VOICES = ("babble", "hum")
SFX_VOLUME = 0.8
NOISE_VOLUME = 0.9
# The effects that hold (tracks.ts gives them a length): long enough to hear the loop. Every other effect plays at its
# own length, honk, skid, screech and brake_squeal included (audio.LOOPING lists them, but tracks.ts never gives them one).
DURS: dict[str, float] = {
    "engine": 2.5,
    "wind": 2.5,
    "rain": 2.5,
    "footsteps": 2.0,
    "heartbeat": 2.0,
    "tick": 2.0,
    "snow_crunch": 2.0,
}
WINDOW = 4.0  # seconds rendered per sample, longer than any sound
SILENCE_DBFS = -60.0
KEEP_MS = 50
GAIN = 2.28  # chosen once (23 Nov 2026): the loudest sample (sfx tick) peaks at -1 dBFS
BITRATE = "64k"
MIN_BYTES = 500

ROOT_URL = "/sounds/stories"
SOUNDS_DIR = Path("web/public/sounds/stories")
ROOT_TS = Path("web/src/stories/studio/samplesRoot.ts")


@dataclass(frozen=True)
class Sample:
    """One file: an effect (``voice`` None) or a noise in a voice at a pitch."""

    kind: str  # "sfx" | "noise"
    id: str
    voice: str | None = None
    pitch: float | None = None

    @property
    def path(self) -> str:
        """The file's path under the recipe folder ("sfx/honk.mp3", "babble/p100/gasp.mp3")."""
        if self.kind == "sfx":
            return f"sfx/{self.id}.mp3"
        return f"{self.voice}/{folder(self.pitch or 1.0)}/{self.id}.mp3"

    def event(self) -> dict[str, Any]:
        """The audio event the engine would write for it (tracks.ts)."""
        if self.kind == "sfx":
            ev: dict[str, Any] = {"at": 0, "kind": "sfx", "id": self.id, "volume": SFX_VOLUME, "pan": 0}
            if self.id in DURS:
                ev["dur"] = DURS[self.id]
            return ev
        return {
            "at": 0,
            "kind": "noise",
            "id": self.id,
            "volume": NOISE_VOLUME,
            "pitch": self.pitch,
            "pan": 0,
            "voice": self.voice,
        }


def folder(pitch: float) -> str:
    """A pitch stop's folder: 0.5 → "p050", 2 → "p200"."""
    return f"p{round(pitch * 100):03d}"


def all_samples() -> list[Sample]:
    out = [Sample("sfx", sid) for sid in audio.SFX]
    out += [Sample("noise", nid, voice, p) for voice in VOICES for p in PITCHES for nid in audio.NOISES]
    return out


def settings() -> dict[str, Any]:
    return {
        "pitches": list(PITCHES),
        "voices": list(VOICES),
        "noises": list(audio.NOISES),
        "sfx": list(audio.SFX),
        "durs": DURS,
        "volumes": {"sfx": SFX_VOLUME, "noise": NOISE_VOLUME},
        "window": WINDOW,
        "silence": SILENCE_DBFS,
        "keepMs": KEEP_MS,
        "gain": GAIN,
        "bitrate": BITRATE,
    }


def code_key(source: str) -> str:
    """The code of a Python file without its comments and blank lines: the same on every Python version."""
    skip = {tokenize.COMMENT, tokenize.NL, tokenize.ENCODING}
    bare = {tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}
    parts = []
    for t in tokenize.generate_tokens(io.StringIO(source).readline):
        if t.type in skip:
            continue
        parts.append(tokenize.tok_name[t.type] + ("" if t.type in bare else " " + t.string))
    return "\n".join(parts)


def recipe() -> str:
    """The first 10 hex characters of sha256 over the synth's code, this file's code and the settings."""
    h = hashlib.sha256()
    for path in (Path(audio.__file__), Path(__file__)):
        h.update(code_key(path.read_text(encoding="utf-8")).encode())
        h.update(b"\0")
    h.update(json.dumps(settings(), sort_keys=True, separators=(",", ":")).encode())
    return h.hexdigest()[:10]


def raw(sample: Sample) -> np.ndarray:
    """The sample as the videos' mix makes it, mono, trimmed, before the library's gain."""
    stereo = audio.mix([sample.event()], WINDOW, mood=None, music_volume=0, seed=0)
    mono = stereo.astype(np.float64).mean(axis=0)
    loud = np.nonzero(np.abs(mono) > 10 ** (SILENCE_DBFS / 20))[0]
    if not loud.size:
        raise ValueError(f"{sample.path} is silent")
    keep = round(KEEP_MS / 1000 * audio.SR)
    if loud[-1] + keep >= mono.size:
        raise ValueError(f"{sample.path} lasts longer than {WINDOW} s: make WINDOW longer")
    return mono[: loud[-1] + 1 + keep]


def render(sample: Sample) -> np.ndarray:
    """The sample's samples (mono, 48 kHz, float64) exactly as its file holds them before the MP3 encode."""
    return raw(sample) * GAIN


def measure(x: np.ndarray) -> dict[str, float]:
    """A file's ``ms`` (length) and ``rms`` (level), as the manifest keeps them."""
    return {"ms": round(x.size / audio.SR * 1000), "rms": round(float(np.sqrt(np.mean(x * x))), 6)}


def encode(x: np.ndarray, out: Path) -> None:
    """``x`` → ``out``: MP3, mono, 64 kbps, no tags (the same bytes from the same ffmpeg)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(audio.SR), "-ac", "1", "-i", "pipe:0",
            "-c:a", "libmp3lame", "-b:a", BITRATE, "-ac", "1", "-map_metadata", "-1", "-fflags", "+bitexact",
            "-flags:a", "+bitexact", "-id3v2_version", "0", "-write_id3v1", "0", str(out),
        ],
        input=np.clip(x, -1.0, 1.0).astype("<f4").tobytes(),
        check=True,
        capture_output=True,
    )  # fmt: skip


def decode(path: Path) -> np.ndarray:
    """An MP3 back to mono 48 kHz float64 (for the freshness test)."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(audio.SR), "pipe:1"],
        check=True,
        capture_output=True,
    )
    return np.frombuffer(r.stdout, dtype="<f4").astype(np.float64)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def root_ts(rec: str) -> str:
    stops = ", ".join(f"{p:g}" for p in PITCHES)
    return (
        "// Written by `python -m lamostories_agent.samples` (CONTRACTS §45.40). Do not edit.\n"
        f'export const SAMPLE_ROOT = "{ROOT_URL}/{rec}";\n'
        f"export const SAMPLE_PITCHES: readonly number[] = [{stops}];\n"
    )


def manifest_text(rec: str, files: dict[str, dict[str, float]]) -> str:
    """manifest.json: ``{recipe, root, pitches, voices, noises, sfx, files: {path: {ms, rms}}}``, one file a line."""
    head = {
        "recipe": rec,
        "root": f"{ROOT_URL}/{rec}",
        "pitches": list(PITCHES),
        "voices": list(VOICES),
        "noises": list(audio.NOISES),
        "sfx": list(audio.SFX),
    }
    lines = [f" {json.dumps(k)}: {json.dumps(v)}," for k, v in head.items()]
    rows = [f"  {json.dumps(path)}: {json.dumps(m)}" for path, m in files.items()]
    return "{\n" + "\n".join(lines) + '\n "files": {\n' + ",\n".join(rows) + "\n }\n}\n"


def _up_to_date(sounds: Path, rec: str, samples: Sequence[Sample]) -> bool:
    try:
        known = json.loads((sounds / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if known.get("recipe") != rec or set(known.get("files") or ()) != {s.path for s in samples}:
        return False
    return all(
        (sounds / rec / s.path).is_file() and (sounds / rec / s.path).stat().st_size > MIN_BYTES for s in samples
    )


def _others(sounds: Path, rec: str) -> Iterable[Path]:
    return (p for p in sounds.iterdir() if p.is_dir() and p.name != rec)


def write(repo: Path, *, force: bool = False, jobs: int | None = None) -> str:
    """Renders every sample into ``repo`` (unless the files are already there for this recipe) and returns the
    recipe."""
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is needed: brew install ffmpeg")
    sounds = repo / SOUNDS_DIR
    sounds.mkdir(parents=True, exist_ok=True)
    rec = recipe()
    samples = all_samples()
    if force or not _up_to_date(sounds, rec, samples):
        made = {s.path: raw(s) for s in samples}
        loudest = max(float(np.max(np.abs(x))) for x in made.values())
        best = 10 ** (-1 / 20) / loudest
        if loudest * GAIN > 1.0:
            raise SystemExit(f"GAIN {GAIN} makes the loudest sample clip: set GAIN = {best:.3g} in samples.py")
        if abs(20 * math.log10(best / GAIN)) > 0.5:
            print(
                f"note: the loudest sample peaks at {20 * math.log10(loudest * GAIN):.2f} dBFS; GAIN = {best:.3g} puts it at -1 dBFS"
            )
        tmp = sounds / f".{rec}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        with ThreadPoolExecutor(max_workers=jobs or os.cpu_count() or 4) as pool:
            list(pool.map(lambda item: encode(item[1] * GAIN, tmp / item[0]), made.items()))
        small = [s.path for s in samples if (tmp / s.path).stat().st_size <= MIN_BYTES]
        if small:
            raise SystemExit(f"these files came out too small: {small[:5]}")
        shutil.rmtree(sounds / rec, ignore_errors=True)
        tmp.rename(sounds / rec)
        files = {s.path: measure(made[s.path] * GAIN) for s in samples}
        (sounds / "manifest.json").write_text(manifest_text(rec, files), encoding="utf-8")
    for old in list(_others(sounds, rec)):
        shutil.rmtree(old)
    (repo / ROOT_TS).write_text(root_ts(rec), encoding="utf-8")
    return rec


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m lamostories_agent.samples", description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", type=Path, default=repo_root(), help="the repository's root (default: this checkout)")
    parser.add_argument("--force", action="store_true", help="render again even when the files are up to date")
    args = parser.parse_args(argv)
    rec = write(args.repo, force=args.force)
    print(f"sound samples: {len(all_samples())} files in {SOUNDS_DIR / rec}")


if __name__ == "__main__":
    main(sys.argv[1:])
