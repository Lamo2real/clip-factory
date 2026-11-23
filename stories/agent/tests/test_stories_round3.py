"""Round 3 of the story pipeline (docs/CONTRACTS.md §45.34, the agent items), on the engine's sample script with the
REAL engine (Deno) and, where a video is made, the REAL ffmpeg: the writer and the fact checker get the engine's rules,
a remade scene gets its seed after normalizing (and the place's sounds), each character keeps its own faces and noises,
the music follows the story's own mood, a remake must name the asked scenes, a step that failed on its model is in
``meta.models``, captions off still burns the bubbles and the end card, the extra output formats, provider usage, and
Nova Reel's second guard."""

from __future__ import annotations

import asyncio
import copy
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import keys, media, writer
from lamostories_agent.data import JobFence
from lamostories_agent.models import ModelUnavailable
from lamostories_agent.pipeline import StoryJob
from lamostories_agent.providers import LUMA_NOT_READY, LUMA_SETUP, REEL_NO_BUCKET, REEL_NOT_READY, REEL_SETUP
from ls_fakes import PK, USER, WS, ffmpeg_has, needs_deno, needs_ffmpeg, needs_libass
from test_stories_pipeline import (
    POST,
    PREFIX,
    STORY,
    answers,
    ffprobe,
    job_item,
    run_job,
    sample,
    story_item,
    world,
    writer_answer,
)

WRITE_RUN = ["storyboard"]
CHECK_RUN = ["storyboard", "safety"]


def request_of(call: dict[str, Any]) -> dict[str, Any]:
    """The JSON request a writer or checker call carries (its second text block)."""
    body: dict[str, Any] = json.loads(call["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    return body


def saved_script(table: Any, store: Any) -> dict[str, Any]:
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    got: dict[str, Any] = json.loads(store.objects[story["scriptKey"]][0])
    return got


def seed_version_one(table: Any, store: Any, script: dict[str, Any], job_id: str, **story: Any) -> None:
    """A story that already has its first storyboard (v1, normalized), being changed by ``job_id``."""
    key = keys.script_key(USER, WS, STORY, 1)
    store.objects[key] = (json.dumps(script).encode(), "application/json")
    table.seed(story_item(job_id, scriptVersion=1, scriptKey=key, status="producing", **story))
    table.seed({"pk": PK, "sk": "ASSET#SB1", "type": "ws_asset", "userId": USER, "workspaceId": WS, "assetId": "SB1",
                "kind": "storyboard", "storyId": STORY, "key": key, "version": 1, "meta": {"current": 1, "by": "writer"},
                "createdAt": "2026-11-21T18:00:00.000Z"})  # fmt: skip


def normalized_sample(tmp_path: Path) -> dict[str, Any]:
    """The sample script as the first run saved it: normalized by the engine (its scenes have seeds)."""
    from lamostories_agent.engine import Engine, write_json
    from ls_fakes import ENGINE_DIR

    eng = Engine(ENGINE_DIR, tmp_path / ".deno-n")
    path = write_json(tmp_path / "sample.json", sample())
    return asyncio.run(eng.normalize(path))


# --- (1) the engine's rules -----------------------------------------------------------------------------------------


@needs_deno
def test_the_writer_and_the_fact_checker_get_the_engines_rules_and_the_videos_shape(tmp_path: Path) -> None:
    svc, _store, _table, fake = world(tmp_path, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "ready"
    write = request_of(fake.calls[0])
    assert {r["id"] for r in write["rules"]} >= {"skid_dir", "steering", "prop_state"}
    assert write["propStates"]["car"] and write["limits"]["sfx"] == 40
    assert write["format"] == {"aspect": "9:16", "width": 1080, "height": 1920}
    assert {"actions", "expressions", "sets"} <= set(write["catalog"])  # the lists, as before
    prompt = fake.calls[0]["messages"][0]["content"][0]["text"]
    assert "skid's dir is the side the car's rear slides to" in prompt
    check = next(c for c in fake.calls if c["task"] == "fact_check")
    body = request_of(check)
    assert any(r["id"] == "skid_dir" for r in body["rules"]) and body["propStates"] and body["limits"]
    assert {"actions", "expressions", "sets"} <= set(body["catalog"])  # the catalog too (§45.34 item 1)
    assert body["catalog"]["actions"] == write["catalog"]["actions"]
    assert "steer_left or steer_right must match the skid's dir" in check["messages"][0]["content"][0]["text"]


def test_the_fact_checker_sees_each_skid_s_side_and_time_so_a_wrong_steer_can_be_reported() -> None:
    """A skid of the rear to the right answered with steer_left: the checker gets both, with their side and time,
    so the engine's skid_dir rule has something to apply to."""
    from lamostories_agent import safety

    script = {"cast": {"c1": {"name": "Ana"}}, "scenes": [{"sceneId": "s1", "title": "Ice", "set": "icy_road",
              "props": [{"propId": "car1", "kind": "car"}],
              "beats": [{"at": 1.0, "dur": 1.5, "who": "car1", "do": "skid", "dir": "right"},
                        {"at": 1.2, "dur": 1.0, "who": "c1", "do": "steer_left", "face": "scared"}]}]}  # fmt: skip
    body = safety.request(script, None, None)
    skid, steer = body["items"]
    assert skid == {"ref": "beat:s1:0", "action": "the car does skid to the right", "set": "icy_road", "who": "car1",
                    "do": "skid", "dir": "right", "at": 1.0, "dur": 1.5}  # fmt: skip
    assert steer["action"] == "Ana does steer left with a scared face"
    assert (steer["do"], steer["at"], steer["dur"]) == ("steer_left", 1.2, 1.0)
    assert "dir" not in steer  # no side of its own: left out, never null
    assert '"dir"' in safety.CHECK_SYSTEM and '"at"' in safety.CHECK_SYSTEM


# --- (3) a remade scene's seed comes after normalizing ----------------------------------------------------------


@needs_deno
def test_a_remade_scene_gets_its_new_seed_after_normalizing_so_the_places_sounds_come_with_it(tmp_path: Path) -> None:
    old = normalized_sample(tmp_path)
    assert all(s.get("seed") is not None for s in old["scenes"])
    new_take = {k: v for k, v in copy.deepcopy(old["scenes"][0]).items() if k not in ("seed", "sfx")}
    new_take["beats"] = [{"at": 0.3, "dur": 1.2, "who": "c1", "do": "jump", "face": "shocked"}]  # no effects on it
    replies = answers(scene_rewrite={"scenes": [new_take]})
    svc, store, table, _fake = world(
        tmp_path, replies, job=job_item("J2", "S2", run=WRITE_RUN, job_type="changes", sceneIds=["s1"])
    )
    seed_version_one(table, store, old, "J2")
    assert run_job(svc, "J2", "S2") == "ready"
    script = saved_script(table, store)
    s1, s2 = script["scenes"]
    assert s1["seed"] == keys.seed_for("J2", "scene", "s1") != old["scenes"][0]["seed"]
    beds = [c for c in s1["sfx"] if c["id"].startswith("s1.amb")]
    assert [c["sfx"] for c in beds] == ["wind"] and beds[0]["at"] == 0  # the icy road's own wind
    assert s2 == old["scenes"][1]  # the other scene is untouched


# --- (6) each character keeps its own faces and noises --------------------------------------------------------


def _stray_answer() -> dict[str, Any]:
    answer = writer_answer()
    answer["scenes"][0]["beats"][0].update({"face": "angry", "noise": "yay"})  # not in Lamo's lists
    return answer


@needs_deno
def test_a_stray_face_or_noise_goes_back_to_the_writer_once_then_is_mended(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    replies = answers(storyboard=_stray_answer())
    svc, store, table, fake = world(tmp_path, replies, job=job_item("J1", "S1", run=WRITE_RUN))
    assert run_job(svc) == "ready"
    writes = [c for c in fake.calls if c["task"] in ("storyboard", "animation_plan")]
    assert len(writes) == 2  # asked once more, with the problems
    assert [c["task"] for c in writes] == ["storyboard", "animation_plan"]  # the re-staging pass (§45.37 G5)
    problems = request_of(writes[1])["problems"]
    assert any("face 'angry'" in p for p in problems) and any("noise 'yay'" in p for p in problems)
    first = request_of(writes[0])
    assert first["cast"][0]["faces"] == ["neutral", "happy", "shocked", "relieved"]
    assert first["cast"][0]["noises"] == ["gasp", "phew"]
    assert "A character only makes the faces in its faces list" in writes[0]["messages"][0]["content"][0]["text"]
    script = saved_script(table, store)
    assert script["cast"]["c1"]["expressions"] == ["neutral", "happy", "shocked", "relieved"]
    beat = script["scenes"][0]["beats"][0]
    assert beat["face"] == "neutral" and "noise" not in beat  # the stray face swapped, the stray noise dropped
    assert writer.cast_problems(script) == []
    assert "stories.cast_repaired" in capsys.readouterr().out


@needs_deno
def test_a_writer_that_fixes_its_faces_on_the_second_try_is_kept_as_it_wrote(tmp_path: Path) -> None:
    replies = answers(storyboard=[_stray_answer(), writer_answer()])
    svc, store, table, fake = world(tmp_path, replies, job=job_item("J1", "S1", run=WRITE_RUN))
    assert run_job(svc) == "ready"
    assert fake.tasks().count("storyboard") == 1 and fake.tasks().count("animation_plan") == 1
    beat = saved_script(table, store)["scenes"][0]["beats"][0]
    assert (beat["face"], beat["noise"]) == ("shocked", "gasp")


def test_the_cast_check_and_its_repair() -> None:
    script = sample()
    script["cast"]["c1"]["expressions"] = ["neutral", "shocked"]
    script["scenes"][1]["beats"][0].update({"face": "relieved", "noise": "yay"})
    problems = writer.cast_problems(script)
    assert len(problems) == 2 and writer.only_cast_problems(problems)
    assert not writer.only_cast_problems([*problems, "scene s1: set 'moon' is not in the catalog."])
    fixed, changes = writer.repair_cast(script)
    assert fixed["scenes"][1]["beats"][0]["face"] == "neutral" and "noise" not in fixed["scenes"][1]["beats"][0]
    assert len(changes) == 2 and writer.cast_problems(fixed) == []
    assert script["scenes"][1]["beats"][0]["face"] == "relieved"  # the input is left as it was
    old = sample()  # a script saved before cast members carried their faces: nothing is limited there
    old["scenes"][1]["beats"][0]["face"] = "angry"
    assert writer.cast_problems(old) == []


# --- (8) music ----------------------------------------------------------------------------------------------------


@needs_deno
@pytest.mark.parametrize(("mood", "music"), [("playful", "playful"), ("none", None)])
def test_only_the_storys_own_mood_decides_the_music(tmp_path: Path, mood: str, music: str | None) -> None:
    """The workspace's musicOn is the default a story starts with (applied by the API at create), never a switch
    over the story's own pick."""
    svc, store, table, _ = world(
        tmp_path, story=story_item(musicMood=mood), job=job_item("J1", "S1", run=WRITE_RUN), config={"musicOn": False}
    )
    assert run_job(svc) == "ready"
    got = saved_script(table, store)["music"]
    assert (got or {}).get("mood") == music


# --- (10) a remake names exactly the asked scenes ------------------------------------------------------------


@needs_deno
def test_a_remake_that_leaves_out_the_asked_scene_is_asked_once_more_then_fails_never_ready_unchanged(
    tmp_path: Path,
) -> None:
    old = normalized_sample(tmp_path)
    wrong = {**copy.deepcopy(old["scenes"][1]), "sceneId": "s2"}
    wrong.pop("seed", None)
    replies = answers(scene_rewrite={"scenes": [wrong]})
    svc, store, table, fake = world(
        tmp_path, replies, job=job_item("J2", "S2", run=WRITE_RUN, job_type="changes", sceneIds=["s1"])
    )
    seed_version_one(table, store, old, "J2")
    assert run_job(svc, "J2", "S2") == "failed"
    calls = [c for c in fake.calls if c["task"] == "scene_rewrite"]
    assert len(calls) == 2
    scene = calls[0]["schema"]["properties"]["scenes"]
    assert scene["minItems"] == scene["maxItems"] == 1
    assert scene["items"]["properties"]["sceneId"]["enum"] == ["s1"]
    assert request_of(calls[1])["problems"] == [writer.missing_sentence(["s1"], ["s1"])]
    job, story = table.item("PJOB#J2"), table.item(f"STORY#{STORY}")
    assert job is not None and story is not None
    assert job["status"] == "failed" and job["error"] == keys.WRITER_FAILED
    assert story["status"] == "failed" and story["scriptVersion"] == 1  # nothing new pretended


@needs_deno
def test_a_remake_that_names_the_scene_on_the_second_try_is_made(tmp_path: Path) -> None:
    old = normalized_sample(tmp_path)
    wrong = {**copy.deepcopy(old["scenes"][1]), "sceneId": "s9"}
    right = {k: v for k, v in copy.deepcopy(old["scenes"][0]).items() if k != "seed"}
    right["beats"] = [{"at": 0.2, "dur": 1.0, "who": "c1", "do": "wave", "face": "happy"}]
    replies = answers(scene_rewrite=[{"scenes": [wrong]}, {"scenes": [right]}])
    svc, store, table, _ = world(
        tmp_path, replies, job=job_item("J2", "S2", run=WRITE_RUN, job_type="changes", sceneIds=["s1"])
    )
    seed_version_one(table, store, old, "J2")
    assert run_job(svc, "J2", "S2") == "ready"
    assert [b["do"] for b in saved_script(table, store)["scenes"][0]["beats"]] == ["wave"]


# --- (13) a step that failed on its model ------------------------------------------------------------------------


@needs_deno
def test_a_step_that_failed_on_its_model_still_shows_what_was_asked(tmp_path: Path) -> None:
    sentence = "Claude Fable 5.2 isn't available right now: no access. Pick another model in Clip Stories › Settings › AI, or try again."
    refused = ModelUnavailable(sentence, model="fable-5-2", effort="max", status="denied")
    svc, _store, table, _ = world(tmp_path, answers(storyboard=refused), job=job_item("J1", "S1", run=WRITE_RUN))
    assert run_job(svc) == "failed"
    job = table.item("PJOB#J1")
    assert job is not None and job["error"] == sentence
    assert job["meta"]["models"] == [
        {"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "fable-5-2", "effort": "max",
         "effortApplied": False, "failed": True}
    ]  # fmt: skip


@needs_deno
def test_a_step_that_failed_on_bedrock_s_own_error_still_shows_what_was_asked(tmp_path: Path) -> None:
    """Not a refusal: a model error after the retries (``models._send`` puts the model and effort on it)."""
    from lamostories_agent.models import Choice, _asked
    from ls_fakes import client_error

    raw = client_error("ModelTimeoutException", "The model took too long")
    _asked(raw, Choice(model="opus-5-5", effort="high", effort_applied=True, source="agent"))
    svc, _store, table, _ = world(tmp_path, answers(storyboard=raw), job=job_item("J1", "S1", run=WRITE_RUN))
    assert run_job(svc) == "failed"
    job = table.item("PJOB#J1")
    assert job is not None and job["meta"]["models"] == [
        {"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "opus-5-5", "effort": "high",
         "effortApplied": False, "failed": True}
    ]  # fmt: skip


# --- (9) captions off, (17) extra formats, (19) provider usage ------------------------------------------------


def _driving_story() -> tuple[dict[str, Any], dict[str, Any]]:
    answer = writer_answer()
    answer["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "Ease off the accelerator", "guidanceRef": "skid-recovery.2"}
    ]
    answer["scenes"][1]["beats"][0]["bubble"] = "exclaim"
    story = story_item(category="driving_safety", safetyTopicId="skid-recovery")
    return answer, story


@needs_deno
@needs_libass
def test_with_captions_off_the_bubbles_and_the_end_card_are_still_burned_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    answer, story = _driving_story()
    replies = answers(storyboard=answer, captions={**POST, "youtubeDescription": "Skids. #shorts"})
    svc, store, table, _ = world(tmp_path, replies, story=story, config={"production": {"burnCaptions": False,
                                                                                         "scenesAtOnce": 2}})  # fmt: skip
    burned: list[str | None] = []
    real = media.assemble

    async def watch(clips: list[Path], audio: Path | None, captions: Path | None, *a: Any, **kw: Any) -> None:
        burned.append(captions.read_text("utf-8") if captions else None)
        await real(clips, audio, captions, *a, **kw)

    monkeypatch.setattr(media, "assemble", watch)
    assert run_job(svc) == "ready"
    (text,) = burned
    assert text is not None
    styles = [line.split(",")[3] for line in text.splitlines() if line.startswith("Dialogue:")]
    assert "EndCard" in styles and "Bubble" in styles and "Caption" not in styles  # never the caption words
    assert "Check your local road rules" in text and "Ease off the" not in text
    sidecar = next(a for a in table.prefix("ASSET#") if a["kind"] == "captions")
    assert sidecar["meta"]["burned"] == 0
    assert "Ease off the" in store.objects[sidecar["key"]][0].decode()  # the sidecar keeps the words


_FORMATS = ffmpeg_has(encoders=("libvpx-vp9", "libopus", "prores_ks", "pcm_s16le"))


@needs_deno
@needs_libass
@pytest.mark.skipif(not _FORMATS, reason="ffmpeg lacks libvpx-vp9, libopus or prores_ks")
def test_extra_formats_are_made_after_the_mp4_and_the_built_in_renderer_s_seconds_are_counted(tmp_path: Path) -> None:
    svc, store, table, _ = world(
        tmp_path, config={"production": {"burnCaptions": True, "scenesAtOnce": 2, "extraFormats": ["mov", "webm"]}}
    )
    assert run_job(svc) == "ready"
    extras = {a["meta"]["format"]: a for a in table.prefix("ASSET#") if a["kind"] == "video"}
    assert set(extras) == {"webm", "mov"}
    assert extras["webm"]["key"] == PREFIX + "final/v1.webm" and extras["mov"]["key"] == PREFIX + "final/v1.mov"
    assert extras["webm"]["contentType"] == "video/webm" and extras["mov"]["contentType"] == "video/quicktime"
    codecs = {}
    for fmt, asset in extras.items():
        path = tmp_path / f"out.{fmt}"
        path.write_bytes(store.objects[asset["key"]][0])
        streams = ffprobe(path)["streams"]
        codecs[fmt] = sorted(s["codec_name"] for s in streams)
        video = next(s for s in streams if s["codec_type"] == "video")
        assert (video["width"], video["height"]) == (1080, 1920)
    assert codecs == {"webm": ["opus", "vp9"], "mov": ["pcm_s16le", "prores"]}
    assert table.item(f"STORY#{STORY}")["videoKey"] == PREFIX + "final/v1.mp4"  # type: ignore[index]
    (usage,) = table.prefix("USAGE#")
    assert (usage["provider"], usage["unit"], usage["cost"], usage["currency"]) == ("builtin-rig", "second", 0, None)
    assert usage["units"] > 0 and usage["units"] == pytest.approx(usage["renderSec"], abs=0.01)


def test_built_in_render_seconds_never_count_the_wait_for_nova_reel(tmp_path: Path) -> None:
    """builtin-rig's units are the built-in renderer's own seconds: a Nova Reel cut-away rendered in the same story
    (about 90 s a shot in real life) is never added to them (§45.34 Provider usage)."""
    from lamostories_agent.providers import SceneClip

    svc, _store, _table, _ = world(tmp_path)
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    job.story = story_item()
    job.config = {"production": {"scenesAtOnce": 1}}
    waits = {"builtin-2d": 0.02, "nova-reel": 0.5}

    class Fake:
        def __init__(self, pid: str) -> None:
            self.pid = pid

        async def render_scene(self, script: dict[str, Any], sid: str, assets: Any, out: Path) -> SceneClip:
            await asyncio.sleep(waits[self.pid])
            return SceneClip(path=out, still=None, duration_sec=3.0)

    async def nothing(*_a: Any, **_k: Any) -> int:
        return 1

    usage: list[dict[str, Any]] = []

    async def record(pid: str, model_id: str, **kw: Any) -> None:
        usage.append({"pid": pid, **kw})

    job._scene_provider = lambda scene: "nova-reel" if scene["sceneId"] == "s2" else "builtin-2d"  # type: ignore[method-assign]
    job._provider = lambda kind, ctx, pid=None: Fake(str(pid))  # type: ignore[method-assign,assignment]
    job._save = job._drawing = job.prove = nothing  # type: ignore[method-assign,assignment]
    job.provider_usage = record  # type: ignore[method-assign,assignment]
    scenes = [{"sceneId": f"s{i}", "durationSec": 3} for i in (1, 2, 3)]
    asyncio.run(job._render({"scenes": scenes}, scenes))
    rig = next(u for u in usage if u["provider"] == "builtin-rig")
    assert 0.03 <= rig["units"] < 0.4 and rig["renderSec"] == rig["units"] and rig["videoSec"] == 6.0
    assert next(u for u in usage if u["provider"] == "nova-reel")["units"] == 6  # one 6 s shot


def _asset(asset_id: str, kind: str, version: int, current: int, key: str, **meta: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": f"ASSET#{asset_id}", "type": "ws_asset", "userId": USER, "workspaceId": WS,
            "assetId": asset_id, "kind": kind, "storyId": STORY, "key": key, "version": version,
            "meta": {"current": current, **meta}, "createdAt": f"2026-11-2{version}T10:00:00.000Z"}  # fmt: skip


def test_keep_versions_prunes_the_extra_formats_like_the_mp4(tmp_path: Path) -> None:
    svc, store, table, _ = world(tmp_path, config={"production": {"keepVersions": 1}})
    rows = [
        _asset("V1", "final_video", 1, 0, PREFIX + "final/v1.mp4"),
        _asset("W1", "video", 1, 0, PREFIX + "final/v1.webm", format="webm"),
        _asset("M1", "video", 1, 0, PREFIX + "final/v1.mov", format="mov"),
        _asset("V2", "final_video", 2, 1, PREFIX + "final/v2.mp4"),
        _asset("W2", "video", 2, 1, PREFIX + "final/v2.webm", format="webm"),
    ]
    for r in rows:
        table.seed(r)
        store.objects[r["key"]] = (b"x", "video/x")
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    job.story = {**story_item(), "scriptVersion": 2, "videoKey": PREFIX + "final/v2.mp4"}
    job.config = {"production": {"keepVersions": 1}}
    job.assets = [table.item(r["sk"]) for r in rows]  # type: ignore[misc]
    asyncio.run(job._prune_versions())
    assert {a["assetId"] for a in table.prefix("ASSET#")} == {"V2", "W2"}
    assert set(store.deleted) == {PREFIX + "final/v1.mp4", PREFIX + "final/v1.webm", PREFIX + "final/v1.mov"}


# --- (20) Luma AI Ray2 not ready: the second guard (it replaced Nova Reel, §45.37 G7) ------------------------------


@needs_deno
@needs_ffmpeg
def test_luma_ray_not_ready_fails_the_job_with_its_own_sentence_and_switches_nothing(tmp_path: Path) -> None:
    answer = writer_answer()
    answer["scenes"][1]["actors"] = []  # a cut-away: Luma AI Ray2's
    answer["scenes"][1]["beats"] = [{"at": 0.2, "dur": 1.0, "who": "car1", "do": "appear"}]
    answer["scenes"][1]["props"] = [{"propId": "car1", "kind": "car", "x": 0.5, "y": 0.7, "scale": 1, "rot": 0}]
    svc, _store, table, _ = world(tmp_path, answers(storyboard=answer), config={"providers": {
        "images": "builtin-rig", "video": "luma-ray", "audio": "builtin-synth"}})  # fmt: skip
    assert run_job(svc) == "failed"
    job = table.item("PJOB#J1")
    assert job is not None and job["error"] == LUMA_NOT_READY
    assert LUMA_NOT_READY == (  # word for word the API's 409 (§45.34: "the same sentence")
        "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched "
        "off, and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its "
        "setup."
    )
    assert REEL_NO_BUCKET == (  # Nova Reel's old line stays word for word the API's (it is ended now)
        "Amazon Nova Reel is not ready yet: it needs a storage bucket in the United States (N. Virginia), which is "
        "switched off, and Amazon Nova Reel turned on for your account. Pick Built-in animation in Settings › Video, "
        "or finish its setup."
    )
    for line in (LUMA_SETUP, REEL_SETUP, REEL_NOT_READY.format(missing="x")):  # no client, or Bedrock says not on
        assert line.endswith(". Pick Built-in animation in Settings › Video, or finish its setup.")
    assert LUMA_SETUP.startswith("Luma AI Ray2 is not ready yet: ")
    assert next(s for s in job["steps"] if s["key"] == "animation")["status"] == "failed"
    assert not [a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip"]  # nothing made by another animator


@needs_deno
@needs_ffmpeg
def test_a_story_that_still_picks_nova_reel_stops_with_the_ended_line_and_calls_nothing(tmp_path: Path) -> None:
    called: list[str] = []

    class Reel:
        def __init__(self, ctx: Any) -> None:
            pass

        async def render_scene(self, *a: Any) -> Any:
            called.append("render")
            raise AssertionError("Nova Reel must never be called")

    from lamostories_agent.providers import REGISTRY

    registry = {**REGISTRY, "animation": {**REGISTRY["animation"], "nova-reel": Reel}}
    svc, _store, table, _ = world(tmp_path, answers(), config={"providers": {
        "images": "builtin-rig", "video": "nova-reel", "audio": "builtin-synth"}}, registry=registry)  # fmt: skip
    assert run_job(svc) == "failed"
    job = table.item("PJOB#J1")
    assert job is not None and job["error"] == (
        "Amazon Nova Reel 1.1 was ended by Amazon on 30 Sep 2026. Pick another video maker in Clip Stories › Settings › "
        "Video."
    )
    assert called == [] and not [a for a in table.prefix("ASSET#") if a["kind"] == "scene_clip"]
    assert next(s for s in job["steps"] if s["key"] == "animation")["status"] == "failed"


# --- (16) the video's size and shape ---------------------------------------------------------------------------


def test_the_story_s_own_size_comes_from_its_format_then_the_workspace() -> None:
    assert writer.size_of({"format": {"aspect": "1:1", "width": 1080, "height": 1080}}) == (1080, 1080)
    assert writer.size_of({}, {"video": {"resolution": "1280x720"}}) == (1280, 720)
    assert writer.size_of({"format": {"width": 999, "height": 1}}, {"video": {"resolution": "nope"}}) == (1080, 1920)
    script = writer.script_from(writer_answer(), title="t", engine_version=4, seed=1, cast={}, captions_on=True,
                                music=None, topic=None, size=(720, 720))  # fmt: skip
    assert (script["width"], script["height"]) == (720, 720)
    assert writer.format_of((1920, 1080)) == {"aspect": "16:9", "width": 1920, "height": 1080}


@needs_ffmpeg
@pytest.mark.parametrize("size", [(720, 720), (1280, 720)])
def test_the_rasterizer_and_ffmpeg_make_the_scripts_own_size(tmp_path: Path, size: tuple[int, int]) -> None:
    """scene_render reads the spec's width and height (the script's, §45.34): the frames are drawn and encoded at that
    size. A stand-in for Deno prints the draw lists (the engine's six sizes land with builder D3)."""
    import sys

    from lamostories_agent import scene_render

    w, h = size
    fake_deno = tmp_path / "frames.py"
    fake_deno.write_text(
        "import json, sys\n"
        "first, end = int(sys.argv[-2]), int(sys.argv[-1])\n"
        "for f in range(first, end):\n"
        f"    print(json.dumps({{'f': f, 'p': [{{'k': 'fill', 'color': '#336699'}}, "
        f"{{'k': 'circle', 'x': {w / 2}, 'y': {h / 2}, 'r': 40, 'color': '#ffcc00'}}]}}))\n"
    )
    out = tmp_path / "clip.mp4"
    spec = {"deno": [sys.executable, str(fake_deno)], "script": "x.json", "from": 0, "to": 6, "out": str(out),
            "width": w, "height": h, "preset": "ultrafast", "crf": 30}  # fmt: skip
    progress = tmp_path / "progress.txt"
    with progress.open("w") as sink:
        assert scene_render.render(spec, still=False, out_progress=sink) == 6
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(out)], capture_output=True, check=True
    ).stdout
    video = json.loads(probe)["streams"][0]
    assert (video["width"], video["height"]) == size


def test_the_animator_and_the_still_ask_for_the_scripts_own_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from lamostories_agent import proc, providers
    from lamostories_agent.engine import Engine
    from ls_fakes import ENGINE_DIR

    specs: list[dict[str, Any]] = []

    async def fake_run(argv: list[str], **_: Any) -> Any:
        if "--spec" in argv:
            specs.append(json.loads(Path(argv[argv.index("--spec") + 1]).read_text()))
        return None

    async def fake_scenes(self: Engine, path: Path) -> list[dict[str, Any]]:
        return [{"sceneId": "s1", "from": 0, "to": 60, "mid": 30}]

    monkeypatch.setattr(proc, "run", fake_run)
    monkeypatch.setattr(Engine, "scenes", fake_scenes)
    script = {**sample(), "width": 1920, "height": 1080}
    ctx = providers.ProviderContext(engine=Engine(ENGINE_DIR, tmp_path / ".deno"), workdir=tmp_path)
    asyncio.run(providers.Builtin2D(ctx).render_scene(script, "s1", {}, tmp_path / "s1.mp4"))
    path = tmp_path / "script.json"
    path.write_text(json.dumps(script))
    asyncio.run(providers.render_still(ctx.engine, path, 30, tmp_path / "s1.jpg", tmp_path))
    assert [(s["width"], s["height"]) for s in specs] == [(1920, 1080), (1920, 1080)]


def test_a_nova_reel_shot_is_made_at_its_own_size_and_fitted_into_the_storys_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from lamostories_agent import proc, providers

    calls: list[list[str]] = []

    async def fake_run(argv: list[str], **_: Any) -> Any:
        calls.append(argv)
        return None

    monkeypatch.setattr(proc, "run", fake_run)
    assert providers.reel_dimension(1080, 1920) == providers.reel_dimension(1920, 1080) == "1280x720"
    asyncio.run(providers.fit_shot(tmp_path / "in.mp4", tmp_path / "out.mp4", 4.0, 20, (1080, 1080)))
    vf = calls[0][calls[0].index("-vf") + 1]
    assert vf.startswith("scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080")


def test_the_ass_file_is_laid_out_for_each_shape() -> None:
    from lamostories_agent import ass

    tall, square, wide = ass.frame(1080, 1920), ass.frame(720, 720), ass.frame(1920, 1080)
    assert (tall.left, tall.right, tall.top, tall.bottom) == (
        ass.SAFE_LEFT,
        ass.SAFE_RIGHT,
        ass.SAFE_TOP,
        ass.SAFE_BOTTOM,
    )
    assert square.right < 720 and square.bottom < 720 and wide.line > tall.line
    caption = {"kind": "caption", "start": 0, "end": 2, "text": "Ease off the accelerator", "x": 1900, "y": 1070,
               "size": 64}  # fmt: skip
    out = ass.build([caption], width=1920, height=1080)
    assert "PlayResX: 1920" in out and "PlayResY: 1080" in out
    x, y = (int(v) for v in out.split("\\pos(")[1].split(")")[0].split(","))
    assert wide.left < x < wide.right and wide.top < y < wide.bottom


@needs_deno
def test_the_writer_is_told_the_storys_own_shape_and_an_older_story_keeps_its_storyboards(tmp_path: Path) -> None:
    """A story's ``format`` (set at create from the workspace default) is the shape the writer stages for; a story
    made before it had one keeps the size of its storyboard, whatever the workspace default is now."""
    square = {"video": {"resolution": "1080x1080", "aspect": "1:1", "quality": "high", "fps": 30}}
    old = normalized_sample(tmp_path)
    svc, store, table, fake = world(tmp_path, job=job_item("J2", "S2", run=WRITE_RUN), config=square)
    seed_version_one(table, store, old, "J2")
    assert run_job(svc, "J2", "S2") == "ready"
    assert request_of(fake.calls[0])["format"] == {"aspect": "9:16", "width": 1080, "height": 1920}
    script = saved_script(table, store)
    assert (script["width"], script["height"]) == (1080, 1920)

    svc, store, table, fake = world(tmp_path / "b", job=job_item("J1", "S1", run=WRITE_RUN), config=square)
    fake.answers["storyboard"] = RuntimeError("stop after the request")  # this engine draws 9:16 only (D3: six)
    table.seed(story_item(format={"aspect": "1:1", "width": 1080, "height": 1080}))
    assert run_job(svc) == "failed"
    assert request_of(fake.calls[0])["format"] == {"aspect": "1:1", "width": 1080, "height": 1080}
