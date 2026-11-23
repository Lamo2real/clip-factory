"""The whole story pipeline on the engine's sample script (docs/CONTRACTS.md §45.19, stories agent bullet): a fake
model client, a fake table and bucket, and the REAL engine command line (Deno) and the REAL ffmpeg. Only contract
invariants are asserted (the engine is drawn by another builder): the script validates, the frame lines are
``frameCount``, every primitive matches §45.10, and the MP4 is 1080 × 1920, 30 fps, H.264 + AAC with the right length
and frame count; every model call goes through ``models.complete`` with the right agent and task and is recorded in
``meta.models``; every write is fenced and stays in the agent's column of §45.9.1; every file is under the story's
``ws/`` prefix and is an ``ASSET#``; a "Remake this scene" only remakes that scene."""

from __future__ import annotations

import asyncio
import copy
import json
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar

import pytest

from lamostories_agent import keys
from lamostories_agent.data import JobFence
from lamostories_agent.engine import Engine, frame_count
from lamostories_agent.models import AgentOff, ModelUnavailable
from lamostories_agent.pipeline import Services, StoryJob, scene_hash
from lamostories_agent.raster import prim_problems
from ls_fakes import (
    ENGINE_DIR,
    PK,
    REPO,
    SAMPLE,
    USER,
    WS,
    FakeModels,
    FakeStore,
    FakeTable,
    data,
    needs_deno,
    needs_ffmpeg,
    needs_libass,
)

STORY = "ST1"
PREFIX = f"ws/{USER}/{WS}/stories/{STORY}/"
STORY_COLUMN = {
    "scriptVersion", "scriptKey", "postCaptions", "scenes", "safetyTopicId", "stillKeys", "safety", "videoKey",
    "coverKey", "actualDurationSec", "stale", "status", "currentJobId", "updatedAt", "version",
}  # fmt: skip
JOB_COLUMN = {"status", "steps", "progress", "heartbeatAt", "error", "meta", "updatedAt"}
POST = {
    "youtubeTitle": "Lamo meets the ice",
    "youtubeDescription": "A slippery morning. #shorts",
    "instagram": "Slippery! #cartoon",
    "facebook": "Slippery morning for Lamo.",
    "tiktok": "Ice ice Lamo #cartoon",
    "x": "Lamo vs the ice.",
}
OK = {"ok": True, "problems": []}


def sample() -> dict[str, Any]:
    s: dict[str, Any] = json.loads(SAMPLE.read_text("utf-8"))
    return s


def writer_answer(script: dict[str, Any] | None = None) -> dict[str, Any]:
    s = script or sample()
    return {
        "title": s["title"],
        "teachesSafety": False,
        "safetyTopicId": None,
        "scenes": copy.deepcopy(s["scenes"]),
        "music": s.get("music"),
        "captions": copy.deepcopy(s.get("captions") or []),
    }


def answers(**over: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "storyboard": writer_answer(),
        "scene_rewrite": writer_answer(),
        "captions": dict(POST),
        "fact_check": OK,
        "final_review": OK,
    }
    out.update(over)
    # The writer's re-staging pass (task animation_plan, §45.37 G5) answers as the storyboard does unless a test says.
    out.setdefault("animation_plan", out["storyboard"])
    return out


def character(cid: str = "ch1") -> dict[str, Any]:
    member = next(iter(sample()["cast"].values()))
    return {
        "pk": PK,
        "sk": f"CHAR#{cid}",
        "type": "ws_character",
        "userId": USER,
        "workspaceId": WS,
        "characterId": cid,
        "name": member["name"],
        "description": "A cheerful driver who learns fast.",
        "personality": "Curious and brave.",
        "traits": ["curious"],
        "movementStyle": member["movementStyle"],
        "expressions": ["neutral", "happy", "shocked", "relieved"],
        "look": member["look"],
        "voice": member["voice"],
        "version": 1,
    }


def job_item(
    job_id: str, session: str, *, run: list[str] | None = None, job_type: str = "produce", **conf: Any
) -> dict[str, Any]:
    run = run or list(keys.STEP_ORDER)
    steps = [
        {"key": k, "label": keys.STEP_LABELS[k], "status": "pending" if k in run else "done"} for k in keys.STEP_ORDER
    ]
    return {
        "pk": PK,
        "sk": f"PJOB#{job_id}",
        "type": "ws_pjob",
        "userId": USER,
        "workspaceId": WS,
        "jobId": job_id,
        "contentType": "animation",
        "contentId": STORY,
        "jobType": job_type,
        "status": "queued",
        "steps": steps,
        "progress": 0,
        "configuration": {
            "run": run,
            "from": conf.get("from"),
            "sceneIds": conf.get("sceneIds"),
            "note": conf.get("note"),
            **({"override": conf["override"]} if conf.get("override") else {}),
        },
        "meta": {},
        "sessionId": session,
        "heartbeatAt": "2026-11-21T18:00:00.000Z",
        "createdAt": "2026-11-21T18:00:00.000Z",
    }


def story_item(job_id: str = "J1", **over: Any) -> dict[str, Any]:
    item = {
        "pk": PK,
        "sk": f"STORY#{STORY}",
        "type": "ws_story",
        "userId": USER,
        "workspaceId": WS,
        "storyId": STORY,
        "contentType": "animation",
        "title": "Ice test",
        "status": "producing",
        "category": "comedy",
        "ideaId": None,
        "characterIds": ["ch1"],
        "durationSec": 6,
        "captionsOn": True,
        "musicMood": "playful",
        "scenes": [],
        "scriptVersion": 0,
        "stale": [],
        "safetyTopicId": None,
        "safety": None,
        "currentJobId": job_id,
        "postCaptions": {},
        "ai": {"model": None, "effort": None},
        "version": 1,
    }
    item.update(over)
    return item


def workspace(config: dict[str, Any] | None = None) -> dict[str, Any]:
    defaults = json.loads((REPO / "stories" / "config" / "workspace-defaults.json").read_text("utf-8"))
    defaults.pop("$comment", None)
    return {
        "pk": f"USER#{USER}#WSREG",
        "sk": f"WS#{WS}",
        "type": "workspace",
        "userId": USER,
        "workspaceId": WS,
        "workspaceName": "Lamo Stories",
        "workspaceType": "stories",
        "configuration": {**defaults, **(config or {})},
        "version": 1,
    }


def world(
    tmp_path: Path,
    replies: dict[str, Any] | None = None,
    *,
    story: dict[str, Any] | None = None,
    job: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
    registry: dict[str, dict[str, type[Any]]] | None = None,
) -> tuple[Services, FakeStore, FakeTable, FakeModels]:
    table = FakeTable()
    table.seed(workspace(config))
    table.seed(character())
    table.seed(story or story_item())
    table.seed(job or job_item("J1", "S1"))
    d, store = data(table)
    models = FakeModels(replies or answers())
    svc = Services(
        data=d,
        work_root=tmp_path / "work",
        models=models,
        engine_dir=ENGINE_DIR,
        config_dir=REPO / "stories" / "config",
        heartbeat_seconds=0.2,
        flush_seconds=0.05,
        **({"registry": registry} if registry else {}),
    )
    return svc, store, table, models


def run_job(svc: Services, job_id: str = "J1", session: str = "S1") -> str:
    return asyncio.run(StoryJob(svc, JobFence(USER, WS, job_id, session), STORY).run())


def ffprobe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True,
        check=True,
        timeout=300,
    ).stdout
    j: dict[str, Any] = json.loads(out)
    return j


def top_atoms(path: Path) -> list[str]:
    raw = path.read_bytes()
    out, pos = [], 0
    while pos + 8 <= len(raw):
        size = int.from_bytes(raw[pos : pos + 4], "big")
        out.append(raw[pos + 4 : pos + 8].decode("latin-1"))
        if size == 1:
            size = int.from_bytes(raw[pos + 8 : pos + 16], "big")
        if size < 8:
            break
        pos += size
    return out


def assert_fenced(table: FakeTable, session: str) -> None:
    """Every PJOB# write carries the fence; every transaction starts with the job's check (or its update)."""
    for kind, w in table.writes:
        if kind == "put":  # only the model client's bookkeeping (none with the fake client)
            raise AssertionError(f"an unfenced put: {w['Item']['sk']}")
        assert w["Key"]["sk"].startswith("PJOB#"), w["Key"]
        cond, names, values = w["ConditionExpression"], w["ExpressionAttributeNames"], w["ExpressionAttributeValues"]
        assert "attribute_exists(pk)" in cond
        assert {names[t] for t in names if f"{t} = " in cond or f"{t} <> " in cond} == {"sessionId", "status"}
        assert session in values.values() and "canceled" in values.values()
        fields = {names[t.split(" = ")[0]] for t in w["UpdateExpression"].removeprefix("SET ").split(", ")}
        assert fields <= JOB_COLUMN, fields - JOB_COLUMN
    for txn in table.txns:
        ((first_kind, first),) = txn[0].items()
        assert first_kind in ("ConditionCheck", "Update") and first["Key"]["sk"].startswith("PJOB#")
        assert "sessionId" in first["ExpressionAttributeNames"].values()
        assert session in first["ExpressionAttributeValues"].values()
        for op in txn[1:]:
            ((kind, body),) = op.items()
            sk = body["Key"]["sk"] if "Key" in body else body["Item"]["sk"]
            assert sk.split("#")[0] + "#" in ("STORY#", "ASSET#", "ACT#", "PROVIDER#", "USAGE#"), sk
            pk = body["Key"]["pk"] if "Key" in body else body["Item"]["pk"]
            assert pk == PK
            if sk.startswith("STORY#"):
                names = body["ExpressionAttributeNames"]
                assert "currentJobId" in names.values()
                set_part = body["UpdateExpression"].split(" REMOVE ")[0].split(" ADD ")[0].removeprefix("SET ")
                fields = {names[c.split(" = ")[0].split(".")[0]] for c in set_part.split(", ")}
                assert fields <= STORY_COLUMN, fields - STORY_COLUMN


def frames_of(script_path: Path, work: Path) -> list[dict[str, Any]]:
    eng = Engine(ENGINE_DIR, work / ".deno")
    work.mkdir(parents=True, exist_ok=True)
    out = subprocess.run(eng.argv("frames", str(script_path)), capture_output=True, check=True, timeout=600).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


@needs_deno
@needs_libass
def test_the_whole_pipeline_on_the_sample(tmp_path: Path) -> None:
    svc, store, table, models = world(tmp_path)
    assert run_job(svc) == "ready"

    job = table.item("PJOB#J1")
    story = table.item(f"STORY#{STORY}")
    assert job is not None and story is not None
    assert job["status"] == "ready" and job["progress"] == 1.0 and "error" not in job
    assert [s["status"] for s in job["steps"]] == ["done"] * 8
    assert all(s.get("startedAt") and s.get("finishedAt") for s in job["steps"])
    meta = job["meta"]
    assert meta["providers"] == {
        "writer": "bedrock-claude",
        "images": "builtin-rig",
        "animation": "builtin-2d",
        "audio": "builtin-synth",
    }
    assert meta["scriptVersion"] == 1 and meta["seed"] == keys.seed_for("J1", "script") and meta["engineVersion"] >= 1
    assert meta["targetSec"] == 6 and 5.9 <= meta["actualSec"] <= 6.1
    # every model call is recorded with its step, agent, model and effort (§45.25 "Recorded")
    assert meta["writerModel"] == "opus-5-5"
    assert [(m["step"], m["agentId"], m["task"]) for m in meta["models"]] == [
        ("storyboard", "storyboard", "storyboard"),
        ("storyboard", "storyboard", "captions"),
        ("safety", "quality_assurance", "fact_check"),
        ("preview", "quality_assurance", "final_review"),
    ]
    assert all(m["model"] == "opus-5-5" and m["effort"] == "high" and m["effortApplied"] for m in meta["models"])

    assert story["status"] == "review" and "currentJobId" not in story and story["stale"] == []
    assert story["scriptVersion"] == 1 and story["scriptKey"] == PREFIX + "script/v1.json"
    assert story["videoKey"] == PREFIX + "final/v1.mp4" and story["coverKey"] == PREFIX + "final/cover-v1.jpg"
    assert [s["sceneId"] for s in story["scenes"]] == ["s1", "s2"]
    assert set(story["stillKeys"]) == {"s1", "s2"}
    assert story["safety"]["status"] == "ok" and story["safety"]["checkedScriptVersion"] == 1
    assert story["postCaptions"]["youtubeTitle"] == POST["youtubeTitle"]
    assert story["postCaptions"]["youtubeDescription"].endswith("#shorts")

    # every file is under the story's prefix and is an ASSET#; nothing of Lamo Clips was read or written
    written = set(store.objects)
    assert written and all(k.startswith(PREFIX) for k in written)
    assert all(k.startswith(PREFIX) for k in store.reads)
    assets = table.prefix("ASSET#")
    kinds = sorted(a["kind"] for a in assets)
    assert kinds == sorted(
        ["storyboard", "scene_still", "scene_still", "scene_clip", "scene_clip", "audio", "captions", "final_video",
         "cover"]
    )  # fmt: skip
    assert {a["key"] for a in assets} <= written
    assert all(a["userId"] == USER and a["workspaceId"] == WS and a["meta"]["current"] == 1 for a in assets)
    assert {a["meta"]["sceneId"] for a in assets if a["kind"] in ("scene_clip", "scene_still")} == {"s1", "s2"}
    assert all(a["bytes"] == len(store.objects[a["key"]][0]) for a in assets)
    assert [a["kind"] for a in table.prefix("ACT#")] == ["made"]
    # PROVIDER# only after real calls: each built-in that made something, and the writer that answered
    providers = {(p["kind"], p["providerId"]): p["state"] for p in table.prefix("PROVIDER#")}
    assert providers == {
        ("writer", "bedrock-claude"): "on",
        ("images", "builtin-rig"): "on",
        ("animation", "builtin-2d"): "on",
        ("audio", "builtin-synth"): "on",
    }
    usage = table.prefix("USAGE#")
    assert [u["providerId"] for u in usage] == ["builtin-2d"] and usage[0]["kind"] == "provider"
    assert usage[0]["videoSec"] == pytest.approx(6.0) and usage[0]["renderSec"] > 0

    # the model calls: through models.complete only, with the agent of each task and the job's own fence
    assert models.tasks() == ["storyboard", "captions", "fact_check", "final_review"]
    for call in models.calls:
        ctx = call["ctx"]
        assert (ctx.user_id, ctx.workspace_id, ctx.job_id, ctx.session_id) == (USER, WS, "J1", "S1")
        assert "model" not in call and "system" not in call  # callers never pass a model or a system prompt
    assert [c["ctx"].agent_id for c in models.calls] == ["storyboard", "storyboard", "quality_assurance"] * 1 + [
        "quality_assurance"
    ]
    first = models.calls[0]["messages"][0]["content"]
    assert "Never describe or change how a character looks" in first[0]["text"]
    request = json.loads(first[1]["text"].split("\n", 1)[1])
    assert "look" not in json.dumps(request["cast"])  # the writer never sees the looks
    review = models.calls[3]["messages"][0]["content"]
    pictures = [b for b in review if "image" in b]
    assert len(pictures) == 8 and all(b["image"]["format"] == "jpeg" for b in pictures)
    assert all(b["image"]["source"]["bytes"][:2] == b"\xff\xd8" for b in pictures)

    # the script: validates with the engine; its frames are frameCount lines of contract primitives
    script = json.loads(store.objects[story["scriptKey"]][0])
    assert script["cast"]["c1"]["look"] == sample()["cast"]["c1"]["look"]  # copied in from the character
    path = tmp_path / "check.json"
    path.write_text(json.dumps(script))
    eng = Engine(ENGINE_DIR, tmp_path / ".deno")
    assert asyncio.run(eng.validate(path)) == []
    frames = frames_of(path, tmp_path / "frames")
    assert len(frames) == frame_count(script) == 180
    assert [f["f"] for f in frames] == list(range(180))
    assert all(prim_problems(p) == [] for f in frames for p in f["p"])

    # the finished video
    final = tmp_path / "final.mp4"
    final.write_bytes(store.objects[story["videoKey"]][0])
    probe = ffprobe(final)
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    sound = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"], video["pix_fmt"]) == ("h264", 1080, 1920, "yuv420p")
    assert video["avg_frame_rate"] == "30/1" and int(video["nb_read_frames"]) == 180
    assert (sound["codec_name"], int(sound["sample_rate"]), int(sound["channels"])) == ("aac", 48000, 2)
    assert float(probe["format"]["duration"]) == pytest.approx(6.0, abs=0.1)
    assert story["actualDurationSec"] == pytest.approx(6.0, abs=0.1)
    atoms = top_atoms(final)
    assert atoms.index("moov") < atoms.index("mdat")  # +faststart
    assert store.objects[story["coverKey"]][0][:2] == b"\xff\xd8"
    assert_fenced(table, "S1")


@needs_deno
@needs_libass
def test_remake_this_scene_only_remakes_that_scene(tmp_path: Path) -> None:
    svc, store, table, models = world(tmp_path)
    assert run_job(svc) == "ready"
    first = table.item(f"STORY#{STORY}")
    assert first is not None
    old_script = json.loads(store.objects[first["scriptKey"]][0])
    clip_s2 = next(a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip" and a["meta"]["sceneId"] == "s2")

    # "Remake this scene": changes { sceneIds: ["s1"] } with no note (the API's job and story writes, seeded here)
    new_take = copy.deepcopy(old_script["scenes"][0])
    # Lamo's own faces and noises only (neutral/happy/shocked/relieved; gasp/phew): since the cast's faces and noises
    # are checked (§45.37), a take with "surprised"/"whoa" is refused and the remake keeps the old take.
    new_take["beats"] = [{"at": 0.3, "dur": 1.2, "who": "c1", "do": "jump", "face": "shocked", "noise": "gasp"}]
    new_take["durationSec"] = 9  # the writer may not change a new take's length
    models.answers["scene_rewrite"] = {"scenes": [new_take]}
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "status": "producing", "currentJobId": "J2"})
    table.seed(job_item("J2", "S2", job_type="changes", sceneIds=["s1"]))
    table.writes.clear()
    table.txns.clear()
    assert run_job(svc, "J2", "S2") == "ready"

    call = next(c for c in models.calls if c["task"] == "scene_rewrite")
    assert call["ctx"].job_id == "J2" and call["ctx"].agent_id == "storyboard"
    assert "Write a new take of only these scenes: s1" in call["messages"][0]["content"][0]["text"]
    remake_request = json.loads(call["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert remake_request["sceneIds"] == ["s1"] and "current" in remake_request
    assert '"look"' not in json.dumps(remake_request)  # the writer never sees the looks, not even in a remake
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["scriptVersion"] == 2 and story["status"] == "review"
    script = json.loads(store.objects[story["scriptKey"]][0])
    s1, s2 = script["scenes"]
    assert s1["durationSec"] == old_script["scenes"][0]["durationSec"]
    assert s1["seed"] == keys.seed_for("J2", "scene", "s1") != old_script["scenes"][0].get("seed")
    assert [b["do"] for b in s1["beats"]] == ["jump"]
    assert s2 == old_script["scenes"][1] and scene_hash(script, s2) == scene_hash(old_script, old_script["scenes"][1])
    assert script["cast"] == old_script["cast"]  # a change never picks up a later look edit silently

    clips = [a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip"]
    by_scene = {
        sid: sorted((a["meta"]["current"], a["version"]) for a in clips if a["meta"]["sceneId"] == sid)
        for sid in ("s1", "s2")
    }
    assert by_scene["s1"] == [(0, 1), (1, 2)]  # the old take kept (not current), the new one made
    assert by_scene["s2"] == [(1, 1)]  # s2 was not drawn again
    assert table.item(clip_s2["sk"]) == clip_s2
    stills = [a for a in table.prefix("ASSET#") if a["kind"] == "scene_still"]
    assert sorted(a["meta"]["sceneId"] for a in stills) == ["s1", "s1", "s2"]
    assert story["videoKey"] == PREFIX + "final/v2.mp4"
    steps = {s["key"]: s.get("message") for s in table.item("PJOB#J2")["steps"]}  # type: ignore[index]
    assert steps["animation"] == "1 animated" and steps["scenes"] == "1 drawn"
    assert_fenced(table, "S2")


@needs_deno
@needs_libass
def test_settings_quality_captions_kept_apart_and_old_versions_deleted(tmp_path: Path) -> None:
    """video.quality → CRF, production.burnCaptions off (the ASS kept as a sidecar), keepVersions 1 (the previous
    version's files deleted after the new one is made)."""
    config = {"video": {"resolution": "1080x1920", "aspect": "9:16", "quality": "best", "fps": 30},
              "production": {"burnCaptions": False, "scenesAtOnce": 1, "keepVersions": 1}}  # fmt: skip
    svc, store, table, _ = world(tmp_path, config=config)
    assert run_job(svc) == "ready"
    specs = sorted((tmp_path / "work").glob("**/spec-*.json"))  # cleaned by the runner, kept by a bare job run
    assert specs and all(json.loads(p.read_text())["crf"] == 17 for p in specs)
    steps = {s["key"]: s.get("message") for s in table.item("PJOB#J1")["steps"]}  # type: ignore[index]
    assert steps["captions"].endswith("kept as a separate file")
    cap = next(a for a in table.prefix("ASSET#") if a["kind"] == "captions")
    assert cap["meta"]["burned"] == 0 and store.objects[cap["key"]][0].startswith(b"[Script Info]")
    v1 = {a["key"] for a in table.prefix("ASSET#")}

    # "Remake the whole video": a new version; with keepVersions 1 the old one's files go
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "status": "producing", "currentJobId": "J2"})
    table.seed(job_item("J2", "S2", **{"from": "storyboard"}))
    assert run_job(svc, "J2", "S2") == "ready"
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["scriptVersion"] == 2
    left = table.prefix("ASSET#")
    assert all(a["meta"]["current"] == 1 for a in left)  # nothing older than the last version is kept
    gone = v1 - {a["key"] for a in left}
    for kind in ("script/v1.json", "final/v1.mp4", "final/cover-v1.jpg", "audio/v1.m4a", "captions/v1.ass"):
        assert PREFIX + kind in gone
    assert gone <= set(store.deleted) and not (gone & set(store.objects))
    assert PREFIX + "script/v1.writer.json" in store.deleted
    assert all(k.startswith(PREFIX) for k in store.deleted)


class _Clips:
    """Fake animation and audio providers: tiny real files made by ffmpeg, and a record of every call."""

    calls: ClassVar[list[str]] = []

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx

    async def render_scene(self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path) -> Any:
        from lamostories_agent.providers import SceneClip

        _Clips.calls.append(f"animation:{scene_id}")
        scene = next(s for s in script["scenes"] if s["sceneId"] == scene_id)
        frames = round(float(scene["durationSec"]) * 30)
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x47d6a0:s=1080x1920:r=30", "-frames:v",
             str(frames), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(out)],
            check=True, timeout=120,
        )  # fmt: skip
        return SceneClip(out, None, frames / 30)

    async def mix(self, script: dict[str, Any], out: Path) -> Path:
        _Clips.calls.append("audio")
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "6", "-c:a", "aac",
             str(out)],
            check=True, timeout=120,
        )  # fmt: skip
        return out

    def check(self) -> Any:
        return None


class _Never(_Clips):
    def __init__(self, ctx: Any) -> None:
        raise AssertionError("a provider the workspace did not pick was made")


@needs_deno
@needs_libass
def test_registered_fake_providers_are_the_only_ones_called(tmp_path: Path) -> None:
    import lamostories_agent.pipeline as pipeline_mod
    import lamostories_agent.providers as providers_mod
    from lamostories_agent.providers import REGISTRY

    registry = {
        **REGISTRY,
        "animation": {"builtin-2d": _Never, "fake-anim": _Clips},
        "audio": {"builtin-synth": _Never, "fake-audio": _Clips},
    }
    saved = providers_mod.REGISTRY
    providers_mod.REGISTRY = registry  # chosen() accepts only ids the registry knows
    try:
        _Clips.calls = []
        svc, store, table, _ = world(
            tmp_path,
            config={"providers": {"images": "builtin-rig", "video": "fake-anim", "audio": "fake-audio"}},
            registry=registry,
        )
        assert pipeline_mod.chosen is providers_mod.chosen
        assert run_job(svc) == "ready"
    finally:
        providers_mod.REGISTRY = saved
    assert sorted(_Clips.calls) == ["animation:s1", "animation:s2", "audio"]
    job = table.item("PJOB#J1")
    assert job is not None and job["meta"]["providers"]["animation"] == "fake-anim"
    final = tmp_path / "f.mp4"
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    final.write_bytes(store.objects[story["videoKey"]][0])
    assert int(next(s for s in ffprobe(final)["streams"] if s["codec_type"] == "video")["nb_read_frames"]) == 180


# --- models, fencing, cancel, heartbeat and the runaway guard (the run stops before the drawing) --------------------


def slow_writer(seconds: float, then: Callable[[], None] | None = None) -> Callable[[dict[str, Any]], Any]:
    def answer(kw: dict[str, Any]) -> Any:
        time.sleep(seconds)
        if then:
            then()
        return writer_answer()

    return answer


@needs_deno
def test_a_model_the_owner_cannot_use_stops_the_job_with_its_sentence_and_no_other_model(tmp_path: Path) -> None:
    sentence = (
        "Claude Fable 5.2 isn't available right now: Bedrock says this AWS account may not use it. Pick another model "
        "in Clip Stories › Settings › AI, or try again."
    )
    svc, _store, table, models = world(tmp_path, answers(storyboard=ModelUnavailable(sentence)))
    assert run_job(svc) == "failed"
    assert models.tasks() == ["storyboard"]  # never retried on another model
    job, story = table.item("PJOB#J1"), table.item(f"STORY#{STORY}")
    assert job is not None and story is not None
    assert job["error"] == sentence and job["steps"][0]["message"] == sentence
    assert story["status"] == "failed" and story["stale"] == list(keys.STEP_ORDER)


@needs_deno
@needs_ffmpeg
def test_the_quality_check_switched_off_is_skipped_but_never_for_driving_safety(tmp_path: Path) -> None:
    job = job_item("J1", "S1", run=["safety"])
    svc, store, table, models = world(tmp_path, answers(fact_check=AgentOff("Quality check is switched off.")), job=job)
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(sample()).encode(), "application/json")
    table.seed(story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST))
    assert run_job(svc) == "ready"
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["safety"]["status"] == "skipped" and story["status"] == "review"
    step = table.item("PJOB#J1")["steps"][1]  # type: ignore[index]
    assert step["status"] == "skipped" and step["message"] == "Quality check is off"
    assert models.calls[0].get("allow_inactive") is None  # a comedy story may be skipped

    # a driving-safety story: the fact check runs whatever the toggle says (allow_inactive)
    topic = next(iter(json.loads((REPO / "stories/config/guidance.json").read_text())["topics"]))["id"]
    svc2, store2, table2, models2 = world(tmp_path / "b", answers(), job=job_item("J1", "S1", run=["safety"]))
    store2.objects[PREFIX + "script/v1.json"] = (json.dumps(sample()).encode(), "application/json")
    table2.seed(story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST,
                           category="driving_safety", safetyTopicId=topic))  # fmt: skip
    assert run_job(svc2) in ("ready", "needs_check")
    assert models2.calls[0]["task"] == "fact_check" and models2.calls[0]["allow_inactive"] is True


@needs_deno
def test_a_superseded_session_writes_nothing(tmp_path: Path) -> None:
    svc, _store, table, models = world(tmp_path, job=job_item("J1", "S-newer"))
    before = copy.deepcopy(table.items)
    assert run_job(svc, "J1", "S1") == "superseded"
    assert table.items == before and table.writes == [] and table.txns == [] and models.calls == []


@needs_deno
def test_a_newer_run_mid_job_stops_this_one_before_its_next_write(tmp_path: Path) -> None:
    holder: dict[str, FakeTable] = {}

    def take_over() -> None:  # the API's fence gave the job a new session while the writer was busy
        holder["t"].items[(PK, "PJOB#J1")]["sessionId"] = "S2"

    svc, _store, table, _ = world(tmp_path, answers(storyboard=slow_writer(0.05, take_over)))
    holder["t"] = table
    story_before = copy.deepcopy(table.items[(PK, f"STORY#{STORY}")])
    assert run_job(svc) == "superseded"
    assert table.items[(PK, f"STORY#{STORY}")] == story_before
    assert table.prefix("ASSET#") == []
    assert table.item("PJOB#J1")["status"] == "running"  # type: ignore[index]


@needs_deno
def test_an_owner_cancel_stops_the_run(tmp_path: Path) -> None:
    from lamostories_agent.runner import JobRunner

    gate = {"go": False}

    def answer(kw: dict[str, Any]) -> Any:
        while not gate["go"]:
            time.sleep(0.01)
        return writer_answer()

    svc, _store, table, _ = world(tmp_path, answers(storyboard=answer))

    async def go() -> None:
        runner = JobRunner()
        fence = JobFence(USER, WS, "J1", "S1")
        assert runner.spawn("J1", "S1", StoryJob(svc, fence, STORY).run())  # type: ignore[arg-type]
        second = StoryJob(svc, fence, STORY).run()
        assert not runner.spawn("J1", "S1", second)  # type: ignore[arg-type]  # a duplicate start is ignored
        await asyncio.sleep(0.3)
        assert runner.busy()
        table.items[(PK, "PJOB#J1")]["status"] = "canceled"  # the API's cancel, then `cancel {id}`
        assert runner.cancel("J1")
        gate["go"] = True
        await asyncio.sleep(0.2)
        assert not runner.busy()

    asyncio.run(go())
    assert table.item("PJOB#J1")["status"] == "canceled"  # type: ignore[index]
    assert table.prefix("ASSET#") == []


@needs_deno
def test_the_heartbeat_beats_while_a_long_step_runs(tmp_path: Path) -> None:
    svc, _store, table, _ = world(
        tmp_path, answers(storyboard=slow_writer(0.9)), job=job_item("J1", "S1", run=["storyboard"])
    )
    assert run_job(svc) == "ready"
    beats = [w for _, w in table.writes if w["UpdateExpression"].count("=") == 2]  # heartbeatAt + updatedAt only
    assert len(beats) >= 3
    job = table.item("PJOB#J1")
    assert job is not None and job["status"] == "ready" and job["progress"] == 1.0  # no beat after the last write
    assert_fenced(table, "S1")


@needs_deno
def test_the_writer_is_asked_once_more_with_the_engines_errors_then_the_job_fails(tmp_path: Path) -> None:
    bad = writer_answer()
    bad["scenes"][0]["set"] = "the_moon"
    svc, _store, table, models = world(tmp_path, answers(storyboard=bad))
    assert run_job(svc) == "failed"
    # the second call is the writer's re-staging pass, on the owner's model and effort for animation planning (G5)
    assert models.tasks() == ["storyboard", "animation_plan"]
    assert models.calls[1]["ctx"].agent_id == "storyboard" and models.calls[1]["schema"] == models.calls[0]["schema"]
    retry = json.loads(models.calls[1]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert retry["problems"] and any("set" in p for p in retry["problems"])
    job, story = table.item("PJOB#J1"), table.item(f"STORY#{STORY}")
    assert job is not None and story is not None
    assert job["status"] == "failed" and job["error"] == keys.WRITER_FAILED
    assert job["steps"][0]["status"] == "failed" and job["steps"][0]["message"] == keys.WRITER_FAILED
    assert story["status"] == "failed" and story["stale"] == list(keys.STEP_ORDER) and "currentJobId" not in story
    assert [a["kind"] for a in table.prefix("ACT#")] == ["failed"]
    assert_fenced(table, "S1")


def test_a_failure_never_shows_raw_tool_output() -> None:
    for sentence in keys.FAILED.values():
        assert sentence.endswith("Tap Try again.") and "ffmpeg" not in sentence and "deno" not in sentence.lower()


@needs_deno
@needs_ffmpeg
def test_a_stopped_run_picks_up_at_its_first_unfinished_step(tmp_path: Path) -> None:
    """The same session again after a restart (status running): finished steps are not run twice."""
    job = job_item("J1", "S1", run=["storyboard", "safety"])
    job["status"] = "running"
    job["steps"][0]["status"] = "done"
    svc, store, table, models = world(tmp_path, job=job)
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(sample()).encode(), "application/json")
    table.seed(story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST))
    assert run_job(svc) == "ready"
    assert models.tasks() == ["fact_check"]
