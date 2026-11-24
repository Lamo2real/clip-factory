"""The image build's check of Lamo Stories' agent (stories/agent/Dockerfile): ``python -m lamostories_agent.selfcheck``.

It fails the build, not the first story, when the engine folder, Deno, numpy, ffmpeg's encoders, libass with Inter
or the loudness pass do not work together: the engine validates and normalizes its sample script, one frame of it is
drawn by the rasterizer and encoded as a JPEG, one second of sound is synthesized and mastered as an m4a, a caption is
burned in with libass (``ass`` filter, Inter), the bundled config and built-in skills load, and (§45.40) yt-dlp's
allowed extractors for reference links resolve without ``generic``. Nothing here reaches the network."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

from . import agents, ass, audio, config, media, proc, reffetch
from .engine import Engine, find_engine_dir, write_json
from .providers import render_still


async def check(work: Path) -> None:
    engine = Engine(
        find_engine_dir(Path(os.environ.get("CF_STORIES_ENGINE_DIR") or "/app/stories-engine")), work / ".deno"
    )
    sample = engine.engine_dir / "fixtures" / "sample-script.json"
    errors = await engine.validate(sample)
    if errors:
        raise SystemExit(f"the engine's sample does not validate: {errors[:3]}")
    script = await engine.normalize(sample)
    path = write_json(work / "sample.json", script)
    scenes = await engine.scenes(path)
    jpg = work / "still.jpg"
    await render_still(engine, path, int(scenes[0]["mid"]), jpg, work)
    if not jpg.is_file() or jpg.stat().st_size < 1000:
        raise SystemExit("the still was not drawn")
    events = await engine.audio(path)
    stereo = audio.mix(events, 1.0, mood="playful", music_volume=0.4, seed=1)
    m4a = work / "sound.m4a"
    await audio.master(stereo, work / "sound.wav", m4a)
    if not m4a.is_file() or m4a.stat().st_size < 1000:
        raise SystemExit("the sound was not made")
    if not await media.has_filter("ass"):
        raise SystemExit("ffmpeg has no libass (the ass filter)")
    events = [{"kind": "caption", "text": "Clips Funded ♥", "start": 0, "end": 1, "x": 540, "y": 1300,
               "size": 64, "color": "#fff6e5"}]  # fmt: skip
    (work / "captions.ass").write_text(ass.build(events), "utf-8")
    burned = work / "burned.jpg"
    await proc.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(jpg), "-vf", "ass=captions.ass", "-frames:v", "1", str(burned)],
        time_limit=120,
        cwd=work,
    )
    if not burned.is_file() or burned.stat().st_size < 1000:
        raise SystemExit("the captions were not burned in")
    if not config.models().get("models") or not config.agents().get("agents") or not config.guidance().get("topics"):
        raise SystemExit("Clips Funded's config files are missing")
    if len(agents.builtin_ids()) < 3:
        raise SystemExit("Clips Funded's built-in skills are missing")
    try:
        reffetch.extractors_ok()
    except Exception as e:
        raise SystemExit(f"yt-dlp's extractors for reference links are not right: {e}") from e


def main() -> int:
    base = Path(os.environ.get("CF_WORK_DIR") or tempfile.gettempdir())
    base.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="stories-check-", dir=base))
    try:
        asyncio.run(check(work))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    sys.stdout.write("stories self-check ok\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
