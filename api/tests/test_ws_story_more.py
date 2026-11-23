"""Stories, round-3 decisions (docs/CONTRACTS.md §45.34): ``Story.effective`` on every story the API returns, the
video's size and shape (``Story.format``: the workspace default or the create body's, changeable until the first run
finished, copied to each job for the agent), extra output formats on download, a picked maker that is not ready
(409 with its own sentence, never switched), Approve refusing a skipped check on driving content, the post captions'
"Write them again" result, and a redesign of one character."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import providers
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER, Call
from fakes import FakeAgentCore, FakeS3
from ws_support import (
    BASE,
    caller,
    install,
    leaked,
    pk,
    seed_asset,
    seed_character,
    seed_item,
    seed_story,
    story_key,
)

BRIEF = {"title": "Ice", "logline": "The car slides on ice.", "category": "comedy"}
DEFAULT = {"aspect": "9:16", "width": 1080, "height": 1920}
# §45.37 G7, word for word: Luma AI Ray2 is the video maker for cut-aways now (Amazon Nova Reel has ended).
REEL_NOT_READY = (
    "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, "
    "and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup."
)
REEL_ENDED = (
    "Amazon Nova Reel 1.1 was ended by Amazon on 30 Sep 2026. Pick another video maker in Clips Funded › Settings › "
    "Video."
)


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def hero(store: db.Store) -> dict[str, Any]:
    return seed_character(store, name="Lamo")


def _create(call: Call, hero: dict[str, Any], **extra: Any) -> tuple[int, Any]:
    return call("POST", f"{BASE}/stories", {"brief": BRIEF, "characterIds": [hero["characterId"]], **extra})


def _configure(call: Call, **configuration: Any) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    status, body = call("PATCH", BASE, {"version": version, "configuration": configuration})
    assert status == 200, body


# --- Story.effective -------------------------------------------------------------------------------------------


def test_every_story_the_api_returns_says_what_its_next_run_uses(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any]
) -> None:
    status, body = _create(call, hero)
    assert status == 201
    default = {"model": "opus-5-5", "effort": "high", "effortApplied": True, "from": "default"}
    assert body["story"]["effective"] == default
    sid = body["story"]["storyId"]
    assert call("GET", f"{BASE}/stories/{sid}")[1]["story"]["effective"] == default
    assert call("GET", f"{BASE}/stories")[1]["stories"][0]["effective"] == default
    # the task's setting, then the video's own one (the project level) win, model and effort separately
    put = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0,
           "tasks": {"storyboard": {"model": "sonnet-5-5"}}}  # fmt: skip
    assert call("PUT", f"{BASE}/ai", put)[0] == 200
    made = seed_story(store, s3_client)
    shown = call("GET", f"{BASE}/stories/{made['storyId']}")[1]["story"]
    assert shown["effective"] == {"model": "sonnet-5-5", "effort": "high", "effortApplied": True, "from": "task"}
    status, body = call(
        "PATCH", f"{BASE}/stories/{made['storyId']}", {"version": made["version"], "ai": {"model": "fable-5-2"}}
    )
    assert status == 200
    assert body["story"]["effective"] == {"model": "fable-5-2", "effort": "high", "effortApplied": True,
                                          "from": "project"}  # fmt: skip
    approved = call("POST", f"{BASE}/stories/{made['storyId']}/approve", {"version": body["story"]["version"]})
    assert approved[1]["story"]["effective"]["model"] == "fable-5-2"


# --- size and shape ---------------------------------------------------------------------------------------------


def test_a_story_takes_the_workspace_shape_and_its_jobs_carry_it(
    call: Call, store: db.Store, hero: dict[str, Any]
) -> None:
    status, body = _create(call, hero)
    assert body["story"]["format"] == DEFAULT
    stored_job = store.get(pk(), f"PJOB#{body['job']['jobId']}")
    assert stored_job is not None
    assert stored_job["configuration"]["format"] == DEFAULT  # for the agent (internal)
    assert set(body["job"]["configuration"]) == {"run", "from", "sceneIds", "note"}
    _configure(call, video={"aspect": "16:9", "resolution": "1280x720"})
    status, body = _create(call, hero)
    assert body["story"]["format"] == {"aspect": "16:9", "width": 1280, "height": 720}
    assert store.get(pk(), f"STORY#{body['story']['storyId']}")["format"] == body["story"]["format"]
    # Production › New may pick another for one video
    status, body = _create(call, hero, format={"aspect": "1:1", "width": 1080, "height": 1080})
    assert (status, body["story"]["format"]) == (201, {"aspect": "1:1", "width": 1080, "height": 1080})
    assert store.get(pk(), f"PJOB#{body['job']['jobId']}")["configuration"]["format"]["aspect"] == "1:1"


@pytest.mark.parametrize(
    "fmt",
    [
        {"aspect": "1:1", "width": 1080, "height": 1920},
        {"aspect": "4:3", "width": 1440, "height": 1080},
        {"aspect": "9:16", "width": 1080},
        {"aspect": "9:16", "width": 1080, "height": 1920, "fps": 60},
        "9:16",
    ],
)
def test_a_size_that_is_not_one_of_the_six_is_refused(call: Call, hero: dict[str, Any], fmt: Any) -> None:
    status, _ = _create(call, hero, format=fmt)
    assert status == 400


def test_an_older_story_without_a_format_is_the_default(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    assert call("GET", f"{BASE}/stories/{story['storyId']}")[1]["story"]["format"] == DEFAULT


def test_the_shape_can_change_until_the_first_run_finished(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    square = {"aspect": "1:1", "width": 720, "height": 720}
    unmade = seed_story(store, s3_client, made=False, status="failed", stale=["storyboard"])
    status, body = call(
        "PATCH", f"{BASE}/stories/{unmade['storyId']}", {"version": unmade["version"], "format": square}
    )
    assert status == 200, body
    assert body["story"]["format"] == square
    produced = call("POST", f"{BASE}/stories/{unmade['storyId']}/produce", {})[1]
    assert store.get(pk(), f"PJOB#{produced['job']['jobId']}")["configuration"]["format"] == square
    # a storyboard but no video yet: the storyboard is written again in the new size (positions are shares of the
    # frame) and every picture is redone, so the next Remake makes the video in that size
    written = seed_story(store, s3_client, status="failed", stale=["animation", "sound", "captions", "assemble",
                                                                    "preview"])  # fmt: skip
    store.update(pk(), written["sk"], {}, remove=["videoKey"])
    status, body = call(
        "PATCH", f"{BASE}/stories/{written['storyId']}", {"version": written["version"], "format": square}
    )
    assert status == 200, body
    assert body["story"]["stale"] == ["scenes", "animation", "sound", "captions", "assemble", "preview"]
    assert body["story"]["scriptVersion"] == written["scriptVersion"] + 1
    assert (body["script"]["width"], body["script"]["height"]) == (720, 720)
    saved = store.get(pk(), written["sk"])
    assert saved is not None
    assert saved["scriptKey"].endswith(f"script/v{written['scriptVersion'] + 1}.json")
    on_s3 = json.loads(s3_client.objects[saved["scriptKey"]])
    assert (on_s3["width"], on_s3["height"], on_s3["scenes"]) == (720, 720, body["script"]["scenes"])
    remake = call("POST", f"{BASE}/stories/{written['storyId']}/produce", {})
    assert remake[0] == 202, remake[1]
    job = store.get(pk(), f"PJOB#{remake[1]['job']['jobId']}")
    assert job is not None
    assert job["configuration"]["format"] == square
    assert job["configuration"]["run"][0] == "scenes"
    # once a video was made the size is set
    made = seed_story(store, s3_client)
    status, body = call("PATCH", f"{BASE}/stories/{made['storyId']}", {"version": made["version"], "format": square})
    assert (status, body["error"]["message"]) == (
        409,
        "The video's size is set once it is made. Make a new video for another size.",
    )
    # sending the same shape back with another change is fine
    status, _ = call("PATCH", f"{BASE}/stories/{made['storyId']}", {"version": made["version"], "format": DEFAULT,
                                                                     "title": "New"})  # fmt: skip
    assert status == 200


# --- output formats ---------------------------------------------------------------------------------------------


def test_download_takes_a_format_and_says_when_it_was_not_made(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client, status="approved", title="Ice: what to do!")
    sid = story["storyId"]
    status, body = call("GET", f"{BASE}/stories/{sid}/download", query={"format": "webm"})
    assert (status, body["error"]["message"]) == (404, "That format was not made for this video.")
    status, body = call("POST", f"{BASE}/stories/{sid}/download", {"format": "mov"})
    assert (status, body["error"]["message"]) == (404, "That format was not made for this video.")
    webm = story_key(sid, "final/v1.webm")
    seed_asset(store, s3_client, kind="final_video", storyId=sid, key=webm, contentType="video/webm",
               meta={"current": 1, "format": "webm"})  # fmt: skip
    status, body = call("POST", f"{BASE}/stories/{sid}/download", {"format": "webm"})
    assert status == 200, body
    assert body["filename"] == "ice-what-to-do.webm"
    op, params, _ = s3_client.presigned[-1]
    assert (op, params["Key"]) == ("get_object", webm)
    assert params["ResponseContentDisposition"] == 'attachment; filename="ice-what-to-do.webm"'
    # an older version's file of that format is not this video's
    old = story_key(sid, "final/v0.mov")
    seed_asset(store, s3_client, kind="video", storyId=sid, key=old, meta={"current": 0, "format": "mov"})
    assert call("GET", f"{BASE}/stories/{sid}/download", query={"format": "mov"})[0] == 404
    # no format: the MP4, as before
    status, body = call("POST", f"{BASE}/stories/{sid}/download", {})
    assert (status, body["filename"], s3_client.presigned[-1][1]["Key"]) == (200, "ice-what-to-do.mp4",
                                                                            story["videoKey"])  # fmt: skip
    assert call("GET", f"{BASE}/stories/{sid}/download", query={"format": "avi"})[0] == 400
    assert call("POST", f"{BASE}/stories/{sid}/download", {"format": "mp4", "x": 1})[0] == 400


def test_another_storys_file_is_never_the_download(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    mine = seed_story(store, s3_client, status="approved")
    other = seed_story(store, s3_client, status="approved")
    seed_asset(store, s3_client, kind="final_video", storyId=other["storyId"],
               key=story_key(mine["storyId"], "final/v1.webm"), meta={"current": 1, "format": "webm"})  # fmt: skip
    assert call("GET", f"{BASE}/stories/{mine['storyId']}/download", query={"format": "webm"})[0] == 404


# --- a maker that is not ready -----------------------------------------------------------------------------------


def test_a_video_maker_that_is_not_ready_stops_create_produce_and_changes(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    made = seed_story(store, s3_client)
    _configure(call, providers={"video": "luma-ray"})
    status, body = _create(call, hero)
    assert (status, body["error"]["message"]) == (409, REEL_NOT_READY)
    status, body = call("POST", f"{BASE}/stories/{made['storyId']}/produce", {"from": "animation"})
    assert (status, body["error"]["message"]) == (409, REEL_NOT_READY)
    status, body = call("POST", f"{BASE}/stories/{made['storyId']}/changes", {"note": "Funnier"})
    assert (status, body["error"]["message"]) == (409, REEL_NOT_READY)
    assert agentcore.calls == []  # nothing started, nothing switched to the built-in animation
    assert len(store.query_all(pk(), "STORY#")) == 1
    # the providers page says the same, never that something else makes the videos
    shown = {p["id"]: p for p in call("GET", f"{BASE}/providers")[1]["providers"]}
    assert shown["luma-ray"]["line"] == REEL_NOT_READY
    assert "makes your videos" not in shown["luma-ray"]["line"]
    assert "scenes with no characters" in providers.find("luma-ray").line_on  # type: ignore[union-attr]
    # the built-in animator names no fixed size: a story may be 9:16, 1:1 or 16:9 (§45.34 "Video size and shape")
    assert shown["builtin-2d"]["line"] == (
        "Built in: animates every scene at the video's size, 30 frames a second. Nothing to set up."
    )
    assert "1080" not in shown["builtin-2d"]["line"]
    # a failure the agent recorded is said in its own words
    seed_item(store, "PROVIDER#animation#luma-ray", ws.TYPE_PROVIDER, state="needs_setup",
              lastError="Bedrock says Luma AI Ray2 is not enabled for this account in US West (Oregon).",
              checkedAt="2026-11-15T11:00:00.000Z")  # fmt: skip
    status, body = _create(call, hero)
    assert (status, body["error"]["message"]) == (
        409,
        "Bedrock says Luma AI Ray2 is not enabled for this account in US West (Oregon).",
    )
    # once a real call worked it is on
    seed_item(store, "PROVIDER#animation#luma-ray", ws.TYPE_PROVIDER, state="on", checkedAt="2026-11-15T11:30:00.000Z")
    status, body = _create(call, hero)
    assert status == 201
    assert body["job"]["meta"]["providers"]["animation"] == "luma-ray"
    assert body["job"]["meta"]["providers"]["videoModel"] == "luma-ray2"  # the model it uses this run (G1)


def test_an_ended_video_maker_stops_create_produce_and_changes_and_is_never_picked_again(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    """§45.37 G7: a workspace that still has Amazon Nova Reel picked from before it ended gets its ended sentence,
    with no call and nothing switched by itself; picking it again is refused."""
    made = seed_story(store, s3_client)
    assert call("GET", BASE)[0] == 200  # the workspace exists
    store.update(f"USER#{USER}#WSREG", "WS#stories", {"configuration": {"providers": {"video": "nova-reel"}}})
    for status, body in (
        _create(call, hero),
        call("POST", f"{BASE}/stories/{made['storyId']}/produce", {"from": "animation"}),
        call("POST", f"{BASE}/stories/{made['storyId']}/changes", {"note": "Funnier"}),
    ):
        assert (status, body["error"]["message"]) == (409, REEL_ENDED)
    assert agentcore.calls == []
    workspace = call("GET", BASE)[1]["workspace"]
    assert workspace["configuration"]["providers"]["video"] == "nova-reel"
    status, body = call(
        "PATCH",
        BASE,
        {"version": workspace["version"], "configuration": {"providers": {"video": "builtin-2d"}}},
    )
    assert status == 200
    status, body = call(
        "PATCH",
        BASE,
        {"version": body["workspace"]["version"], "configuration": {"providers": {"video": "nova-reel"}}},
    )
    assert (status, body["error"]["message"]) == (400, REEL_ENDED)


def test_another_owners_provider_record_does_not_make_it_ready(
    call: Call, store: db.Store, hero: dict[str, Any]
) -> None:
    _configure(call, providers={"video": "luma-ray"})
    store.put({"pk": pk(), "sk": "PROVIDER#animation#luma-ray", "type": ws.TYPE_PROVIDER, "userId": OTHER,
               "workspaceId": "stories", "state": "on", "checkedAt": "2026-11-15T11:30:00.000Z"})  # fmt: skip
    assert _create(call, hero)[0] == 409


CANVAS_NOT_READY = (
    "Amazon Nova Canvas is not ready yet: it has not made a picture for you yet. Pick Built-in characters in "
    "Settings › Video › Picture maker, or make one AI portrait to finish its setup."
)


def test_a_picked_picture_maker_never_stops_a_video(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    """§45.35 D3 (it replaces §45.34's "video or images"): only ``configuration.providers.video`` stops a story's
    create, produce and changes. A picture maker (Stability AI, §45.37 G7) makes portraits only, so while it is not on
    yet (no portrait made) the videos are still made, with the built-in characters, and its own state gates the
    portraits alone."""
    made = seed_story(store, s3_client)
    _configure(call, providers={"images": "stability"})
    shown = {p["id"]: p for p in call("GET", f"{BASE}/providers")[1]["providers"]}
    assert shown["stability"]["state"] == "needs_setup"  # not on yet, and the page says so
    status, body = _create(call, hero)
    assert status == 201, body
    assert body["job"]["meta"]["providers"]["images"] == "builtin-rig"  # the characters in a video: always the rig
    status, body = call("POST", f"{BASE}/stories/{made['storyId']}/produce", {"from": "animation"})
    assert status == 202, body
    assert CANVAS_NOT_READY not in json.dumps(body)
    assert [c["payload"]["action"] for c in agentcore.calls] == ["process_story", "process_story"]
    # a portrait is the real call that turns the picture maker on
    assert call("POST", f"{BASE}/characters/{hero['characterId']}/portrait")[0] == 202
    # the video maker still gates videos, whatever the picture maker's state
    seed_item(store, "PROVIDER#images#stability", ws.TYPE_PROVIDER, state="on", checkedAt="2026-11-15T11:30:00.000Z")
    _configure(call, providers={"video": "luma-ray"})
    status, body = _create(call, hero)
    assert (status, body["error"]["message"]) == (409, REEL_NOT_READY)
    assert providers.not_ready({"providers": {"images": "stability", "video": "builtin-2d"}}, []) is None
    assert providers.not_ready({"providers": {"images": "nova-canvas", "video": "builtin-2d"}}, []) is None
    # the picture maker never gates a video; a sound maker only for what only the owner can give (§45.37 G3)
    assert providers.GATES_VIDEOS == ("animation", "audio")


# --- approve ---------------------------------------------------------------------------------------------------


def test_approve_refuses_a_skipped_check_whenever_the_story_has_a_safety_topic(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    skipped = {"topicId": "skid-recovery", "status": "skipped", "problems": [], "checkedScriptVersion": 1,
               "citations": []}  # fmt: skip
    comedy = seed_story(store, s3_client, category="comedy", safetyTopicId="skid-recovery", safety=skipped)
    status, body = call("POST", f"{BASE}/stories/{comedy['storyId']}/approve", {"version": comedy["version"]})
    assert status == 409
    assert body["error"]["message"] == "The facts still need a check. Tap Check again."
    plain = seed_story(store, s3_client, category="comedy", safety={**skipped, "topicId": None})
    assert call("POST", f"{BASE}/stories/{plain['storyId']}/approve", {"version": plain["version"]})[0] == 200


# --- Write the post captions again ---------------------------------------------------------------------------


def test_write_them_again_answers_with_the_draft_and_its_script_version(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    """Route 40 (§45.34): ``202 { task }`` of kind ``captions``; the finished task's ``result`` is ``{ storyId,
    scriptVersion, postCaptions }``, a draft never saved by itself."""
    story = seed_story(store, s3_client)
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/captions", {})
    assert status == 202
    task = body["task"]
    assert (task["kind"], task["status"]) == ("captions", "queued")
    draft = {"youtubeTitle": "Ice!", "youtubeDescription": "Slow down.", "instagram": "Ice", "facebook": "Ice",
             "tiktok": "Ice", "x": "Ice"}  # fmt: skip
    result = {"storyId": story["storyId"], "scriptVersion": 1, "postCaptions": draft}
    store.update(pk(), f"TASK#{task['taskId']}", {"status": "done", "result": result})
    shown = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]
    assert shown["result"] == result
    assert call("GET", f"{BASE}/stories/{story['storyId']}")[1]["story"]["postCaptions"] == story["postCaptions"]
    assert leaked([body, shown]) == []
    assert call("POST", f"{BASE}/stories/{story['storyId']}/captions", {"tone": "fun"})[0] == 400


# --- redesign one character ------------------------------------------------------------------------------------


def test_design_redesigns_one_character_of_this_workspace(
    call: Call, store: db.Store, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    status, body = call(
        "POST", f"{BASE}/characters/design", {"characterId": hero["characterId"], "description": "Give him a hat."}
    )
    assert status == 202, body
    stored = store.get(pk(), f"TASK#{body['task']['taskId']}")
    assert stored is not None
    # §45.41: the input also names the kind (the saved character's), the count (1 for a person) and the photos (none)
    assert stored["input"] == {
        "characterId": hero["characterId"],
        "description": "Give him a hat.",
        "kind": "person",
        "count": 1,
        "references": [],
    }
    assert agentcore.calls[-1]["payload"]["action"] == "run_task"
    theirs = seed_character(store, user=OTHER, name="Theirs")
    for character_id in (theirs["characterId"], "01J0000000000000000000000Z", "not-an-id", 5):
        status, body = call("POST", f"{BASE}/characters/design", {"characterId": character_id, "description": "Hat."})
        assert (status, body["error"]["message"]) == (404, "We could not find that character."), character_id
    # a redesign still says what to change (words or a picture)
    status, body = call("POST", f"{BASE}/characters/design", {"characterId": hero["characterId"]})
    assert (status, body["error"]["message"]) == (400, "Describe the character, or add a picture of it.")
