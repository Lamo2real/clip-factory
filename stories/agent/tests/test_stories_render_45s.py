"""How long a 45 s story takes to draw, animate, sound and assemble (docs/CONTRACTS.md §45.11.3 asks builder E to
measure it). Off by default (it renders 1 350 frames): ``CF_STORIES_BENCH=1 uv run pytest -s
tests/test_stories_render_45s.py``. It prints each step's time and checks the finished video's length."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from lamostories_agent import keys
from ls_fakes import FIXTURES, needs_deno, needs_libass
from test_stories_pipeline import POST, PREFIX, STORY, ffprobe, job_item, run_job, story_item, world

pytestmark = pytest.mark.skipif(os.environ.get("CF_STORIES_BENCH") != "1", reason="set CF_STORIES_BENCH=1 to measure")


@needs_deno
@needs_libass
def test_render_the_45_second_fixture(tmp_path: Path) -> None:
    script = json.loads((FIXTURES / "script-45s.json").read_text("utf-8"))
    run = ["scenes", "animation", "sound", "captions", "assemble", "preview"]
    svc, store, table, _ = world(
        tmp_path,
        story=story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST, durationSec=45),
        job=job_item("J1", "S1", run=run),
    )
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(script).encode(), "application/json")
    began = time.monotonic()
    assert run_job(svc) == "ready"
    total = time.monotonic() - began
    job = table.item("PJOB#J1")
    assert job is not None
    print(f"\n45 s fixture, {os.cpu_count()} CPUs: total {total:.1f} s")
    for s in job["steps"]:
        if s["key"] in run and s.get("startedAt") and s.get("finishedAt"):
            from datetime import datetime

            a = datetime.fromisoformat(s["startedAt"].replace("Z", "+00:00"))
            b = datetime.fromisoformat(s["finishedAt"].replace("Z", "+00:00"))
            print(f"  {keys.STEP_LABELS[s['key']]:<22} {(b - a).total_seconds():6.1f} s  {s.get('message') or ''}")
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    final = tmp_path / "final.mp4"
    final.write_bytes(store.objects[story["videoKey"]][0])
    video = next(s for s in ffprobe(final)["streams"] if s["codec_type"] == "video")
    assert int(video["nb_read_frames"]) == 1350
