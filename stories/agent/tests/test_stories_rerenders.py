"""Re-renders, old versions and what a job records (docs/CONTRACTS.md §45.9, §45.11.3, §45.12, §45.29, §45.31): a file
made again at the same key never leaves a row behind that a later prune deletes it through; ``PJOB#.meta.providers``
names the animator that made the clips in the video (the AI labels of §45.14 depend on it); a failing scene stops its
siblings before the job's last write; an engine change or an explicit ``from`` without ``sceneIds`` draws every scene
again; every job's meta has every key of §45.6. Animation and sound are fakes (tiny real files from ffmpeg); the
engine (Deno) and the assembly (ffmpeg with libass) are real."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, ClassVar

import pytest

import lamostories_agent.providers as providers_mod
from lamostories_agent import keys
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import META_KEYS, Services, StoryJob
from lamostories_agent.providers import REGISTRY, ProviderFailed, SceneClip
from ls_fakes import PK, USER, WS, FakeStore, FakeTable, needs_deno, needs_libass
from test_stories_pipeline import (
    POST,
    PREFIX,
    STORY,
    _Clips,
    _Never,
    job_item,
    run_job,
    sample,
    story_item,
    world,
)

FAKES = {**REGISTRY, "animation": {"builtin-2d": _Clips, "nova-reel": _Never}, "audio": {"builtin-synth": _Clips}}


def fake_world(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, config: dict[str, Any] | None = None, **kw: Any
) -> tuple[Services, FakeStore, FakeTable]:
    monkeypatch.setattr(providers_mod, "REGISTRY", FAKES)  # chosen() accepts only ids the registry knows
    _Clips.calls = []
    svc, store, table, _ = world(tmp_path, config=config, registry=FAKES, **kw)
    return svc, store, table


def again(table: FakeTable, job_id: str, session: str, run: list[str], **conf: Any) -> None:
    """The API's produce: a new job, the story producing with it."""
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "status": "producing", "currentJobId": job_id})
    table.seed(job_item(job_id, session, run=run, **conf))


def current_assets(table: FakeTable) -> list[dict[str, Any]]:
    return [a for a in table.prefix("ASSET#") if a["meta"]["current"] == 1]


@needs_deno
@needs_libass
def test_a_re_render_at_the_same_version_never_loses_a_current_file_when_old_versions_go(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = {"production": {"burnCaptions": True, "scenesAtOnce": 2, "keepVersions": 1}}
    svc, store, table = fake_world(tmp_path, monkeypatch, config=config)
    assert run_job(svc) == "ready"  # J1: version 1
    clip_key = PREFIX + "scenes/s1/v1.mp4"

    # J2: produce {from: "animation", sceneIds: ["s1"]} (after an engine change): s1 is made again at the same key
    again(table, "J2", "S2", list(keys.STEP_ORDER[3:]), **{"from": "animation", "sceneIds": ["s1"]})
    assert run_job(svc, "J2", "S2") == "ready"
    assert _Clips.calls.count("animation:s1") == 2 and _Clips.calls.count("animation:s2") == 1
    rows = [a for a in table.prefix("ASSET#") if a["key"] == clip_key]
    assert len(rows) == 1 and rows[0]["meta"]["current"] == 1  # the row of the overwritten file went with it
    assert len({a["key"] for a in table.prefix("ASSET#")}) == len(table.prefix("ASSET#"))  # one row per file

    # a retired row naming the current file (as an older run left it) must never let the prune delete that file
    table.seed({**rows[0], "sk": "ASSET#OLDDUP", "assetId": "OLDDUP", "meta": {**rows[0]["meta"], "current": 0}})

    # the owner edits a caption: the API's script v2; safety, captions, assemble and preview are stale
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    script = json.loads(store.objects[story["scriptKey"]][0])
    script["captions"][0]["text"] = "Slow and easy"
    store.objects[PREFIX + "script/v2.json"] = (json.dumps(script).encode(), "application/json")
    run3 = ["safety", "captions", "assemble", "preview"]
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "scriptVersion": 2, "scriptKey": PREFIX + "script/v2.json",
                "stale": run3})  # fmt: skip
    again(table, "J3", "S3", run3)
    assert run_job(svc, "J3", "S3") == "ready"
    assert [k for k in (a["key"] for a in current_assets(table)) if k not in store.objects] == []
    assert clip_key in store.objects and clip_key not in store.deleted
    assert table.item("ASSET#OLDDUP") is None  # its row went; the file it shared stays
    assert PREFIX + "final/v1.mp4" in store.deleted and PREFIX + "captions/v1.ass" in store.deleted  # older version

    # and the next job still puts the video together from the kept clips
    again(table, "J4", "S4", ["assemble", "preview"], **{"from": "assemble"})
    assert run_job(svc, "J4", "S4") == "ready"
    assert [k for k in (a["key"] for a in current_assets(table)) if k not in store.objects] == []


@needs_deno
@needs_libass
def test_the_job_names_the_animator_that_made_the_clips_in_the_video(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Nova Reel picked, but every scene has a character: the built-in animator draws them all, and the job says so
    reel = {"providers": {"images": "builtin-rig", "video": "nova-reel", "audio": "builtin-synth"}}
    svc, _store, table = fake_world(tmp_path, monkeypatch, config=reel)
    assert run_job(svc) == "ready"
    job = table.item("PJOB#J1")
    assert job is not None and job["meta"]["providers"] == {
        "writer": "bedrock-claude",
        "images": "builtin-rig",
        "animation": "builtin-2d",
        "audio": "builtin-synth",
    }
    clips = [a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip"]
    assert {a["meta"]["provider"] for a in clips} == {"builtin-2d"}

    # The other way round: a Reel cut-away an earlier job made is still in the video after the owner picked the
    # built-in animator again; a caption edit's job (captions, assemble, preview) still says nova-reel.
    s2 = next(a for a in clips if a["meta"]["sceneId"] == "s2")
    table.seed({**table.items[(PK, s2["sk"])], "meta": {**s2["meta"], "provider": "nova-reel"}})
    ws = table.items[(PK.split("#WS#")[0] + "#WSREG", f"WS#{WS}")]
    table.seed({**ws, "configuration": {**ws["configuration"], "providers": {"video": "builtin-2d"}}})
    again(table, "J2", "S2", ["captions", "assemble", "preview"])
    assert run_job(svc, "J2", "S2") == "ready"
    job2 = table.item("PJOB#J2")
    assert job2 is not None and job2["meta"]["providers"]["animation"] == "nova-reel"


class _FailFirst:
    """s1 fails at once; s2 would take a while. ``finished`` lists the scenes that got to the end."""

    finished: ClassVar[list[str]] = []

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx

    async def render_scene(self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path) -> Any:
        if scene_id == "s1":
            await asyncio.sleep(0.05)
            raise ProviderFailed("The animator stopped. Tap Try again.")
        await asyncio.sleep(0.8)
        _FailFirst.finished.append(scene_id)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"not a real clip")
        return SceneClip(out, None, 3.0)

    def check(self) -> Any:
        return None


@needs_deno
def test_a_failing_scene_stops_the_others_before_the_job_s_last_write(tmp_path: Path) -> None:
    registry = {**REGISTRY, "animation": {"builtin-2d": _FailFirst}}
    _FailFirst.finished = []
    run = list(keys.STEP_ORDER[3:])
    svc, store, table, _ = world(tmp_path, job=job_item("J1", "S1", run=run), registry=registry)
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(sample()).encode(), "application/json")
    table.seed(story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST))

    async def go() -> tuple[str, tuple[int, int]]:
        status = await StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY).run()
        after = (len(table.txns), len(table.writes))
        await asyncio.sleep(1.2)  # long enough for s2 to have finished, had it been left running
        return status, after

    status, after = asyncio.run(go())
    assert status == "failed"
    assert (len(table.txns), len(table.writes)) == after  # nothing written after the job's last write
    assert _FailFirst.finished == []  # s2 was stopped, not left to render
    assert [a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip"] == []
    job = table.item("PJOB#J1")
    assert job is not None and job["status"] == "failed" and job["error"] == "The animator stopped. Tap Try again."


@needs_deno
@needs_libass
def test_an_engine_change_or_an_explicit_from_draws_every_scene_and_the_job_says_which_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    svc, store, table = fake_world(tmp_path, monkeypatch)
    assert run_job(svc) == "ready"
    first = table.item("PJOB#J1")
    assert first is not None
    engine = int(first["meta"]["engineVersion"])
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    seed = json.loads(store.objects[story["scriptKey"]][0])["seed"]

    # produce {from: "animation"} with no sceneIds: every scene is animated again
    _Clips.calls = []
    again(table, "J2", "S2", list(keys.STEP_ORDER[3:]), **{"from": "animation"})
    assert run_job(svc, "J2", "S2") == "ready"
    assert sorted(c for c in _Clips.calls if c.startswith("animation")) == ["animation:s1", "animation:s2"]
    meta = table.item("PJOB#J2")["meta"]  # type: ignore[index]
    assert set(META_KEYS) <= set(meta)  # every key of §45.6, null when this job does not know it
    assert meta["writerModel"] is None and meta["engineVersion"] == engine and meta["seed"] == seed
    assert meta["scriptVersion"] == 1 and meta["actualSec"] == pytest.approx(6.0, abs=0.1)

    # the engine changed: "Check again" (from safety) draws and animates every scene again with the new engine
    async def newer(self: StoryJob) -> int:
        return engine + 1

    monkeypatch.setattr(StoryJob, "_engine", newer)
    _Clips.calls = []
    stills_before = len([a for a in table.prefix("ASSET#") if a["kind"] == "scene_still"])
    again(table, "J3", "S3", list(keys.STEP_ORDER[1:]), **{"from": "safety"})
    assert run_job(svc, "J3", "S3") == "ready"
    assert sorted(c for c in _Clips.calls if c.startswith("animation")) == ["animation:s1", "animation:s2"]
    stills = [a for a in table.prefix("ASSET#") if a["kind"] == "scene_still"]
    assert len(stills) == stills_before  # drawn again at the same keys: replaced, not duplicated
    steps = {s["key"]: s.get("message") for s in table.item("PJOB#J3")["steps"]}  # type: ignore[index]
    assert steps["scenes"] == "2 drawn" and steps["animation"] == "2 animated"
    assert table.item("PJOB#J3")["meta"]["engineVersion"] == engine + 1  # type: ignore[index]

    # a later job with nothing changed draws nothing
    _Clips.calls = []
    again(table, "J4", "S4", list(keys.STEP_ORDER[1:]), **{"from": "safety"})
    assert run_job(svc, "J4", "S4") == "ready"
    assert [c for c in _Clips.calls if c.startswith("animation")] == []
