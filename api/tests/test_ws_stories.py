"""Stories: create, read, edit, remake, review and delete (docs/CONTRACTS.md §45.5, §45.9, §45.9.1)."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import config, guidance, jobs, overrides
from conftest import USER, Call
from fakes import FakeAgentCore, FakeS3, FakeTable
from ws_support import (
    BASE,
    Monotonic,
    agent_end,
    agent_step,
    caller,
    install,
    leaked,
    pk,
    prefix,
    seed_asset,
    seed_character,
    seed_idea,
    seed_item,
    seed_job,
    seed_refvid,
    seed_story,
    story_key,
)


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


ALL = ["storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview"]


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def hero(store: db.Store) -> dict[str, Any]:
    return seed_character(store, name="Lamo")


def _story(store: db.Store, story_id: str) -> dict[str, Any]:
    found = store.get(pk(), f"STORY#{story_id}")
    assert found is not None
    return found


def _job(store: db.Store, job_id: str) -> dict[str, Any]:
    found = store.get(pk(), f"PJOB#{job_id}")
    assert found is not None
    return found


# --- create ---------------------------------------------------------------------------------------------------


def test_create_from_an_idea_starts_production(
    call: Call, store: db.Store, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    idea = seed_idea(
        store,
        concept={
            "premise": "p",
            "beats": ["a", "b", "c"],
            "lesson": None,
            "ending": "e",
            "tone": "funny",
            "durationSec": 40,
            "onScreenText": [],
        },
    )
    status, body = call("POST", f"{BASE}/stories", {"ideaId": idea["ideaId"], "characterIds": [hero["characterId"]]})
    assert status == 201
    story, job = body["story"], body["job"]
    assert story["status"] == "producing"
    assert story["title"] == "The kitchen dance"
    assert story["durationSec"] == 40  # the concept's length
    assert story["currentJobId"] == job["jobId"]
    assert story["storageLocation"] == f"s3://cf-prod-media-123/{prefix()}stories/{story['storyId']}/"
    assert story["contentType"] == "animation"
    assert story["stale"] == []
    assert story["scriptVersion"] == 0
    assert job["status"] == "queued"
    assert job["jobType"] == "produce"
    assert [s["key"] for s in job["steps"]] == ALL
    assert {s["status"] for s in job["steps"]} == {"pending"}
    assert job["configuration"] == {"run": ALL, "from": None, "sceneIds": None, "note": None}
    assert job["meta"]["targetSec"] == 40
    assert job["meta"]["providers"]["animation"] == "builtin-2d"
    stored = _job(store, job["jobId"])
    assert stored["heartbeatAt"] == stored["createdAt"]
    assert re.fullmatch(rf"cfstory-{job['jobId']}-[a-z0-9]{{8}}", stored["sessionId"])
    assert len(stored["sessionId"]) >= 33
    sent = agentcore.calls[-1]
    assert sent["payload"] == {
        "action": "process_story",
        "userId": USER,
        "workspaceId": "stories",
        "storyId": story["storyId"],
        "jobId": job["jobId"],
    }
    assert sent["runtimeSessionId"] == stored["sessionId"]
    item = _story(store, story["storyId"])
    assert item["statusBefore"] == "draft"
    assert item["lastJobId"] == job["jobId"]
    assert item["brief"]["title"] == "The kitchen dance"
    assert item["brief"]["concept"]["tone"] == "funny"
    used = call("GET", f"{BASE}/ideas")[1]["ideas"][0]
    assert used["status"] == "used"
    assert used["storyIds"] == [story["storyId"]]


def test_a_typed_concept_works_and_safety_needs_checked_advice(call: Call, hero: dict[str, Any]) -> None:
    cast = [hero["characterId"]]
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {
            "brief": {
                "title": "Black ice",
                "logline": "The car starts sliding on black ice.",
                "category": "driving_safety",
            },
            "characterIds": cast,
        },
    )
    assert status == 201
    assert body["story"]["safetyTopicId"] == "skid-recovery"
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {
            "brief": {"title": "Lava", "logline": "A volcano erupts near the road.", "category": "driving_safety"},
            "characterIds": cast,
        },
    )
    assert status == 409
    assert body["error"]["message"] == guidance.NO_GUIDANCE
    assert {"id": "skid-recovery"}.items() <= body["error"]["topics"][0].items()


@pytest.mark.parametrize(
    "body",
    [
        {"characterIds": []},
        {"ideaId": "01J0000000000000000000000Z", "brief": {"title": "x", "logline": "y", "category": "comedy"}},
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": []},
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": ["01J0000000000000000000000Z"]},
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "durationSec": 91},
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "musicMood": "metal"},
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "madeForKids": False},
    ],
)
def test_bad_story_requests_are_400(call: Call, hero: dict[str, Any], body: dict[str, Any]) -> None:
    body = {"characterIds": [hero["characterId"]], **body}
    assert call("POST", f"{BASE}/stories", body)[0] == 400


def test_without_the_agent_the_job_fails_at_once(
    app: App, call: Call, s3_client: FakeS3, hero: dict[str, Any], store: db.Store
) -> None:
    install(app, None, s3_client)
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )
    assert status == 201
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == "The video maker is not switched on yet, so making the video did not start."
    assert body["story"]["status"] == "failed"
    assert body["story"]["stale"] == ALL
    assert body["story"]["currentJobId"] is None


def test_a_refused_start_is_tried_twice_then_fails(call: Call, agentcore: FakeAgentCore, hero: dict[str, Any]) -> None:
    agentcore.fail = True  # ServiceUnavailableException: retryable
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )
    assert status == 201
    assert len(agentcore.calls) == 2
    assert body["job"]["error"] == "Making the video did not start. Tap Try again."
    assert body["story"]["status"] == "failed"


def test_a_not_accepted_start_is_not_retried(call: Call, agentcore: FakeAgentCore, hero: dict[str, Any]) -> None:
    agentcore.reply = {"accepted": False}
    body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )[1]
    assert len(agentcore.calls) == 1
    assert body["job"]["status"] == "failed"
    # The session the refused start opened is ended (the job itself already has a new sessionId).
    assert agentcore.stopped == [agentcore.calls[0]["runtimeSessionId"]]


def test_a_slow_failed_start_leaves_the_stop_to_the_fence(
    call: Call, agentcore: FakeAgentCore, hero: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    Monotonic(monkeypatch).spent = 25.0  # as if the start took most of the 29 s
    agentcore.reply = {"accepted": False}
    body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )[1]
    assert body["job"]["status"] == "failed"
    assert agentcore.stopped == []


# --- read -----------------------------------------------------------------------------------------------------


def test_get_presigns_the_files_and_reads_the_script(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    status, body = call("GET", f"{BASE}/stories/{story['storyId']}")
    assert status == 200
    out = body["story"]
    assert "final/v1.mp4" in out["videoUrl"]
    assert "cover-v1.jpg" in out["coverUrl"]
    assert all("still-v1.jpg" in s["stillUrl"] for s in out["scenes"])
    assert body["script"]["scenes"][0]["sceneId"] == "s1"
    assert body["job"] is None
    for name in ("scriptKey", "videoKey", "coverKey", "stillKeys", "statusBefore", "brief", "lastJobId"):
        assert name not in out
    assert all(op == "get_object" and secs == 3600 for op, _, secs in s3_client.presigned)


def test_the_list_filters_and_pages_newest_first(call: Call, store: db.Store) -> None:
    made = [
        seed_story(store, storyId=f"01J00000000000000000000S{n:02d}"[-26:], status="review" if n % 2 else "approved")
        for n in range(5)
    ]
    status, body = call("GET", f"{BASE}/stories", query={"limit": "2"})
    assert status == 200
    first = [s["storyId"] for s in body["stories"]]
    assert first == [made[4]["storyId"], made[3]["storyId"]]
    rest = call("GET", f"{BASE}/stories", query={"limit": "2", "cursor": body["nextCursor"]})[1]
    assert [s["storyId"] for s in rest["stories"]] == [made[2]["storyId"], made[1]["storyId"]]
    reviews = call("GET", f"{BASE}/stories", query={"status": "review"})[1]["stories"]
    assert {s["status"] for s in reviews} == {"review"}
    assert len(reviews) == 2
    assert call("GET", f"{BASE}/stories", query={"status": "done"})[0] == 400
    assert call("GET", f"{BASE}/stories", query={"limit": "51"})[0] == 400
    assert call("GET", f"{BASE}/stories", query={"cursor": "bm9wZQ"})[0] == 400


# --- PATCH and stale steps ------------------------------------------------------------------------------------


def _patch(call: Call, story: dict[str, Any], **changes: Any) -> tuple[int, Any]:
    return call("PATCH", f"{BASE}/stories/{story['storyId']}", {"version": story["version"], **changes})


def test_a_caption_edit_writes_a_new_script_and_reruns_the_fact_check(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    status, body = _patch(
        call, story, captions=[{"id": "cap1", "at": 0.5, "dur": 2, "text": "Steer where you want to go"}]
    )
    assert status == 200
    out = body["story"]
    assert out["stale"] == ["safety", "captions", "assemble", "preview"]
    assert out["scriptVersion"] == 2
    assert out["safety"]["status"] == "pending"
    assert out["version"] == story["version"] + 1
    assert out["status"] == "review"
    v2 = json.loads(s3_client.objects[story_key(story["storyId"], "script/v2.json")])
    assert v2["captions"][0]["text"] == "Steer where you want to go"
    assert body["script"] == v2
    assert _story(store, story["storyId"])["ownerEdits"]["captions"] == ["cap1"]
    # Approving now is refused: the change is not in the video yet.
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": out["version"]})
    assert status == 409
    assert body["error"]["message"] == "Your changes aren't in the video yet. Tap Remake first."


def test_an_edit_in_needs_check_then_produce_runs_only_the_checks(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    story = seed_story(
        store,
        s3_client,
        status="needs_check",
        safety={
            "topicId": None,
            "status": "problems",
            "problems": ["The car brakes hard on ice."],
            "checkedScriptVersion": 1,
            "citations": [],
        },
    )
    edited = _patch(call, story, scenes=[{"sceneId": "s1", "caption": "Ease off gently"}])[1]["story"]
    assert edited["status"] == "needs_check"
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})
    assert status == 202
    job = body["job"]
    assert job["configuration"]["run"] == ["safety", "captions", "assemble", "preview"]
    assert job["configuration"]["from"] is None
    assert [s["status"] for s in job["steps"]] == [
        "done",
        "pending",
        "done",
        "done",
        "done",
        "pending",
        "pending",
        "pending",
    ]
    assert body["story"]["status"] == "producing"
    assert _story(store, story["storyId"])["statusBefore"] == "needs_check"
    assert agentcore.calls[-1]["payload"]["action"] == "process_story"


def test_a_scene_length_edit_remakes_that_scene_and_retimes_the_captions(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    out = _patch(call, story, scenes=[{"sceneId": "s1", "durationSec": 6}])[1]
    assert out["story"]["stale"] == ["animation", "sound", "captions", "assemble", "preview"]
    assert [s["durationSec"] for s in out["story"]["scenes"]] == [6, 3]
    script = out["script"]
    assert script["durationSec"] == 9
    assert script["scenes"][0]["beats"][0]["at"] == 1.0  # the beat keeps its place in the longer scene
    assert script["captions"][0]["at"] == 1.0
    assert script["captions"][0]["dur"] == 4.0
    job = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})[1]["job"]
    assert job["configuration"]["run"] == ["animation", "sound", "captions", "assemble", "preview"]
    assert job["configuration"]["sceneIds"] == ["s1"]
    # The scenes to animate stay known while the job runs (a cancel keeps them) and stop counting once animated.
    assert jobs.valid_stale_scenes(_story(store, story["storyId"])) == ["s1"]
    agent_step(store, story["storyId"], job["jobId"], "animation", message="1 animated")
    assert jobs.valid_stale_scenes(_story(store, story["storyId"])) == []


def test_effects_music_and_post_captions_make_their_own_steps_stale(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    sfx = [{"id": "mine", "at": 1, "sfx": "honk", "volume": 0.5}]
    out = _patch(call, story, scenes=[{"sceneId": "s2", "sfx": sfx}])[1]["story"]
    assert out["stale"] == ["sound", "assemble", "preview"]
    out = _patch(call, out, musicMood="calm")[1]
    assert out["script"]["music"] == {"mood": "calm", "volume": 0.4}
    assert out["story"]["musicMood"] == "calm"
    other = seed_story(store, s3_client)
    out = _patch(call, other, postCaptions={"youtubeTitle": "Ice, explained"})[1]["story"]
    assert out["stale"] == ["safety"]
    assert out["scriptVersion"] == 1  # no video change, no new script
    assert out["postCaptions"]["youtubeTitle"] == "Ice, explained"
    same = _patch(call, seed_story(store, s3_client), musicMood="playful")[1]["story"]
    assert same["stale"] == []
    assert same["version"] == 3


def test_new_post_words_need_a_check_again_never_a_remake(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    """Round 5 E10: post words are not in the video, so changing only them leaves just the fact check out of date.
    Approve keeps its rule (refused until the check ran on them) but says Check again, never Remake; Check again
    (produce from "safety") checks them, and then the video can be approved."""
    checked = {"topicId": None, "status": "ok", "problems": [], "checkedScriptVersion": 1, "citations": []}
    story = seed_story(store, s3_client, safety=checked)
    out = _patch(call, story, postCaptions={"youtubeTitle": "Ice, explained"})[1]["story"]
    assert out["stale"] == ["safety"]
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": out["version"]})
    assert (status, body["error"]["message"]) == (409, "Your new post words need a quick check. Tap Check again.")
    assert "Remake" not in body["error"]["message"]
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {"from": "safety"})
    assert status == 202, body
    run = body["job"]["configuration"]["run"]
    assert (run[0], "storyboard" in run) == ("safety", False)  # the check first; a run from it is content-based
    job_id = body["job"]["jobId"]
    agent_step(store, story["storyId"], job_id, "safety", safety=checked)
    agent_end(store, story["storyId"], job_id)
    done = call("GET", f"{BASE}/stories/{story['storyId']}")[1]["story"]
    assert (done["status"], done["stale"]) == ("review", [])
    assert call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": done["version"]})[0] == 200


def test_a_change_in_the_video_with_new_post_words_still_says_remake(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    """Post words changed together with something in the video: the video needs remaking, so Remake it is."""
    story = seed_story(store, s3_client)
    out = _patch(call, story, postCaptions={"youtubeTitle": "Ice, explained"})[1]["story"]
    out = _patch(call, out, musicMood="calm")[1]["story"]
    assert out["stale"] == ["safety", "sound", "assemble", "preview"]
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": out["version"]})
    assert (status, body["error"]["message"]) == (409, "Your changes aren't in the video yet. Tap Remake first.")


def _remake_and_finish(call: Call, store: db.Store, story_id: str, body: dict[str, Any] | None = None) -> Any:
    status, out = call("POST", f"{BASE}/stories/{story_id}/produce", body or {})
    assert status == 202, out
    agent_end(store, story_id, out["job"]["jobId"])
    return out["job"]


@pytest.mark.parametrize(
    "changes",
    [
        {"musicMood": "calm"},
        {"scenes": [{"sceneId": "s2", "sfx": [{"id": "mine", "at": 1, "sfx": "honk", "volume": 0.5}]}]},
        {"scenes": [{"sceneId": "s1", "durationSec": 6}]},
        {"musicMood": "calm", "scenes": [{"sceneId": "s1", "durationSec": 5, "sfx": []}]},
    ],
)
def test_effects_music_or_length_edits_can_be_remade_then_approved(
    call: Call, store: db.Store, s3_client: FakeS3, changes: dict[str, Any]
) -> None:
    story = seed_story(store, s3_client)
    edited = _patch(call, story, **changes)[1]["story"]
    assert edited["scriptVersion"] == 2
    assert "safety" not in edited["stale"]
    # No text the fact check reads changed, so the check moves onto the new script version.
    assert _story(store, story["storyId"])["safety"]["checkedScriptVersion"] == 2
    url = f"{BASE}/stories/{story['storyId']}"
    assert call("POST", f"{url}/approve", {"version": edited["version"]})[0] == 409  # not in the video yet
    job = _remake_and_finish(call, store, story["storyId"])
    assert "safety" not in job["configuration"]["run"]
    after = _story(store, story["storyId"])
    assert after["stale"] == []
    status, body = call("POST", f"{url}/approve", {"version": after["version"]})
    assert status == 200, body
    assert body["story"]["status"] == "approved"


def test_a_check_that_is_due_or_on_another_version_is_not_carried(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    out = _patch(call, story, captions=[{"id": "cap1", "at": 0.5, "dur": 2, "text": "Steer gently"}])[1]["story"]
    out = _patch(call, out, musicMood="calm")[1]["story"]
    safety = _story(store, story["storyId"])["safety"]
    assert (safety["status"], safety["checkedScriptVersion"], out["scriptVersion"]) == ("pending", 1, 3)
    old = seed_story(
        store,
        s3_client,
        scriptVersion=2,
        safety={"topicId": None, "status": "ok", "problems": [], "checkedScriptVersion": 1, "citations": []},
    )
    _patch(call, old, musicMood="calm")
    assert _story(store, old["storyId"])["safety"]["checkedScriptVersion"] == 1
    # Problems found on this version stay with the new one: the text they are about did not change.
    held = seed_story(
        store,
        s3_client,
        status="needs_check",
        safety={"topicId": None, "status": "problems", "problems": ["x"], "checkedScriptVersion": 1, "citations": []},
    )
    _patch(call, held, musicMood="calm")
    safety = _story(store, held["storyId"])["safety"]
    assert (safety["status"], safety["checkedScriptVersion"]) == ("problems", 2)


@pytest.mark.parametrize(
    "changes",
    [
        {"scenes": [{"sceneId": "s9", "caption": "x"}]},
        {"scenes": [{"sceneId": "s1", "durationSec": 1}]},
        {"scenes": [{"sceneId": "s1", "durationSec": 15}, {"sceneId": "s1", "caption": "x"}]},
        {"scenes": [{"sceneId": "s1", "sfx": [{"id": "a", "at": 9, "sfx": "honk", "volume": 1}]}]},
        {"scenes": [{"sceneId": "s1", "sfx": [{"id": "a", "at": 1, "sfx": "explosion", "volume": 1}]}]},
        {"captions": [{"id": "c", "at": 0, "dur": 1, "text": "x" * 61}]},
        {"captions": [{"id": "c", "at": 50, "dur": 1, "text": "late"}]},
        {"captions": [{"id": "c", "at": 0, "dur": 1, "text": "a"}, {"id": "c", "at": 1, "dur": 1, "text": "b"}]},
        {"postCaptions": {"x": "x" * 281}},
        {"title": ""},
        {"script": {}},
    ],
)
def test_bad_edits_are_400(call: Call, store: db.Store, s3_client: FakeS3, changes: dict[str, Any]) -> None:
    story = seed_story(store, s3_client)
    assert _patch(call, story, **changes)[0] == 400


def test_a_too_long_video_is_refused(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    s3_client.objects[story["scriptKey"]] = json.dumps(
        {
            **json.loads(s3_client.objects[story["scriptKey"]]),
            "scenes": [
                {"sceneId": f"s{n}", "title": "x", "durationSec": 14, "beats": [], "sfx": [], "caption": None}
                for n in range(1, 8)
            ],
        }
    ).encode()
    status, body = _patch(call, story, scenes=[{"sceneId": "s1", "durationSec": 15}])
    assert status == 400
    assert "under 90" in body["error"]["message"]


def test_edits_need_a_made_video_the_right_version_and_no_running_job(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    assert call("PATCH", f"{BASE}/stories/{story['storyId']}", {"version": 1, "title": "New"})[0] == 409
    approved = seed_story(store, s3_client, status="approved")
    assert _patch(call, approved, title="New")[0] == 409
    running = seed_story(store, s3_client, status="producing")
    job = seed_job(store, running)
    store.update(running["pk"], running["sk"], {"currentJobId": job["jobId"]})
    status, body = _patch(call, running, title="New")
    assert status == 409
    assert body["error"]["message"] == "A video is being made for this story. Wait until it is done."
    unmade = seed_story(store, s3_client, made=False, status="failed")
    assert _patch(call, unmade, captionsOn=False)[0] == 409


# --- produce, changes, cancel ---------------------------------------------------------------------------------


def test_produce_from_a_step_and_its_rules(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    url = f"{BASE}/stories/{story['storyId']}/produce"
    assert call("POST", url, {})[0] == 409  # nothing stale: nothing to remake
    assert call("POST", url, {"from": "sound", "sceneIds": ["s1"]})[0] == 400
    assert call("POST", url, {"from": "scenes", "sceneIds": ["s9"]})[0] == 400
    assert call("POST", url, {"from": "dance"})[0] == 400
    status, body = call("POST", url, {"from": "animation", "sceneIds": ["s2"]})
    assert status == 202
    assert body["job"]["configuration"] == {"run": ALL[3:], "from": "animation", "sceneIds": ["s2"], "note": None}
    assert call("POST", url, {"from": "storyboard"})[0] == 409  # a job runs
    approved = seed_story(store, s3_client, status="approved")
    assert call("POST", f"{BASE}/stories/{approved['storyId']}/produce", {"from": "storyboard"})[0] == 409


def test_remake_the_whole_video_writes_a_new_script_from_the_storyboard(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {"from": "storyboard"})[1]
    assert body["job"]["configuration"]["run"] == ALL
    assert body["job"]["meta"]["scriptVersion"] == 1


def test_a_safety_story_without_checked_advice_cannot_be_made(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client, category="driving_safety", status="failed", stale=["safety"])
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})
    assert status == 409
    assert body["error"]["message"] == guidance.NO_GUIDANCE


def test_changes_remake_a_scene_or_the_story_with_a_note(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    url = f"{BASE}/stories/{story['storyId']}/changes"
    assert call("POST", url, {})[0] == 400
    assert call("POST", url, {"note": "x" * 501})[0] == 400
    status, body = call("POST", url, {"sceneIds": ["s2"]})
    assert status == 202
    job = body["job"]
    assert (job["jobType"], job["configuration"]) == (
        "changes",
        {"run": ALL, "from": "storyboard", "sceneIds": ["s2"], "note": None},
    )
    other = seed_story(store, s3_client)
    job = call("POST", f"{BASE}/stories/{other['storyId']}/changes", {"note": "Make the ending funnier"})[1]["job"]
    assert job["configuration"]["note"] == "Make the ending funnier"
    acts = store.query_all(pk(), "ACT#")
    assert [a["kind"] for a in acts] == ["changes", "changes"]


def test_cancel_puts_the_story_back_and_fences_the_run(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    story = seed_story(store, s3_client, stale=["sound", "assemble", "preview"])
    job = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})[1]["job"]
    old_session = _job(store, job["jobId"])["sessionId"]
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/cancel")
    assert status == 200
    assert body["job"]["status"] == "canceled"
    assert body["story"]["status"] == "review"  # the status before the job
    assert body["story"]["stale"] == ["sound", "assemble", "preview"]  # as it was
    assert body["story"]["currentJobId"] is None
    assert _job(store, job["jobId"])["sessionId"] != old_session
    assert agentcore.calls[-1]["payload"] == {"action": "cancel", "id": job["jobId"]}
    assert agentcore.calls[-1]["runtimeSessionId"] == old_session
    assert agentcore.stopped == [old_session]
    # Nothing to cancel: the same answer again.
    assert call("POST", f"{BASE}/stories/{story['storyId']}/cancel")[1]["job"]["status"] == "canceled"


def test_cancel_of_a_first_run_goes_back_to_draft_and_try_again_makes_everything(
    call: Call, store: db.Store, hero: dict[str, Any]
) -> None:
    created = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )[1]
    sid = created["story"]["storyId"]
    assert call("POST", f"{BASE}/stories/{sid}/cancel")[1]["story"]["status"] == "draft"
    job = call("POST", f"{BASE}/stories/{sid}/produce", {})[1]["job"]
    assert job["configuration"]["run"] == ALL


def test_a_cancel_after_the_storyboard_leaves_the_rest_to_make(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any]
) -> None:
    created = call(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "x", "logline": "y", "category": "comedy"}, "characterIds": [hero["characterId"]]},
    )[1]
    sid, job_id = created["story"]["storyId"], created["job"]["jobId"]
    key = story_key(sid, "script/v1.json")
    s3_client.objects[key] = json.dumps({"scenes": []}).encode()
    agent_step(
        store,
        sid,
        job_id,
        "storyboard",
        scriptVersion=1,
        scriptKey=key,
        scenes=[{"sceneId": "s1", "title": "One", "durationSec": 6}],
    )
    status, body = call("POST", f"{BASE}/stories/{sid}/cancel")
    assert status == 200
    assert body["story"]["status"] == "draft"
    assert body["story"]["stale"] == ALL[1:]  # the storyboard is made; nothing after it is
    status, body = call("POST", f"{BASE}/stories/{sid}/produce", {})
    assert status == 202
    assert body["job"]["configuration"]["run"] == ALL[1:]
    assert body["job"]["jobType"] == "produce"


def test_a_canceled_whole_remake_never_approves_the_older_video(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    job = call("POST", f"{BASE}/stories/{sid}/produce", {"from": "storyboard"})[1]["job"]
    agent_step(store, sid, job["jobId"], "storyboard", scriptVersion=2, scriptKey=story_key(sid, "script/v2.json"))
    checked = {"topicId": None, "status": "ok", "problems": [], "checkedScriptVersion": 2, "citations": []}
    agent_step(store, sid, job["jobId"], "safety", safety=checked)
    out = call("POST", f"{BASE}/stories/{sid}/cancel")[1]["story"]
    assert out["status"] == "review"
    assert out["stale"] == ALL[2:]
    status, body = call("POST", f"{BASE}/stories/{sid}/approve", {"version": out["version"]})
    assert status == 409
    assert body["error"]["message"] == "Your changes aren't in the video yet. Tap Remake first."
    status, body = call("POST", f"{BASE}/stories/{sid}/produce", {})
    assert status == 202
    assert body["job"]["configuration"]["run"] == ALL[2:]


def test_a_cancel_before_the_run_wrote_anything_keeps_stale_and_its_scenes(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    _patch(call, story, scenes=[{"sceneId": "s2", "durationSec": 4}])
    call("POST", f"{BASE}/stories/{sid}/produce", {})
    out = call("POST", f"{BASE}/stories/{sid}/cancel")[1]["story"]
    assert out["stale"] == ["animation", "sound", "captions", "assemble", "preview"]
    assert _story(store, sid)["staleScenes"] == ["s2"]
    assert call("POST", f"{BASE}/stories/{sid}/produce", {})[1]["job"]["configuration"]["sceneIds"] == ["s2"]
    # A whole remake stopped at once leaves the made video as it was: still approvable.
    other = seed_story(store, s3_client)
    call("POST", f"{BASE}/stories/{other['storyId']}/produce", {"from": "storyboard"})
    out = call("POST", f"{BASE}/stories/{other['storyId']}/cancel")[1]["story"]
    assert (out["status"], out["stale"]) == ("review", [])
    assert call("POST", f"{BASE}/stories/{other['storyId']}/approve", {"version": out["version"]})[0] == 200


def test_a_cancel_refused_by_a_write_meanwhile_is_tried_again(
    call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    job = call("POST", f"{BASE}/stories/{sid}/produce", {"from": "storyboard"})[1]["job"]
    real = jobs.cancel
    seen: list[int] = []

    def racing(st: db.Store, j: dict[str, Any], s: dict[str, Any] | None, now: Any) -> bool:
        if not seen:  # the agent writes the storyboard just before the first try lands
            agent_step(store, sid, job["jobId"], "storyboard", scriptVersion=2)
        seen.append(1)
        return real(st, j, s, now)

    monkeypatch.setattr(jobs, "cancel", racing)
    out = call("POST", f"{BASE}/stories/{sid}/cancel")[1]
    assert len(seen) == 2
    assert out["job"]["status"] == "canceled"
    assert out["story"]["stale"] == ALL[1:]


def test_try_again_after_an_unfinished_change_asks_for_the_same_change(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    asked = call("POST", f"{BASE}/stories/{sid}/changes", {"note": "Make it funnier", "sceneIds": ["s2"]})[1]["job"]
    agent_end(store, sid, asked["jobId"], failed_at="storyboard")
    status, body = call("POST", f"{BASE}/stories/{sid}/produce", {})
    assert status == 202
    job = body["job"]
    assert job["jobType"] == "changes"
    assert job["configuration"] == {"run": ALL, "from": "storyboard", "sceneIds": ["s2"], "note": "Make it funnier"}
    assert _story(store, sid)["reviewNote"] == "Make it funnier"
    # Once the new storyboard was written, Try again just makes the rest.
    agent_step(store, sid, job["jobId"], "storyboard", scriptVersion=2)
    agent_end(store, sid, job["jobId"], failed_at="scenes")
    again = call("POST", f"{BASE}/stories/{sid}/produce", {})[1]["job"]
    assert (again["jobType"], again["configuration"]["run"]) == ("produce", ALL[1:])


def test_remaking_named_scenes_also_remakes_the_ones_already_out_of_date(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    _patch(call, story, scenes=[{"sceneId": "s2", "durationSec": 4}])
    job = call("POST", f"{BASE}/stories/{sid}/produce", {"from": "animation", "sceneIds": ["s1"]})[1]["job"]
    assert job["configuration"]["sceneIds"] == ["s1", "s2"]
    # The run stops (its heartbeat goes quiet): the fence keeps both scenes to animate.
    store.update(pk(), f"PJOB#{job['jobId']}", {"status": "running", "heartbeatAt": "2026-11-15T11:00:00.000Z"})
    assert call("GET", f"{BASE}/stories/{sid}")[1]["story"]["status"] == "failed"
    assert _story(store, sid)["staleScenes"] == ["s1", "s2"]
    # Every scene's animation out of date (no list of scenes): a named remake does them all.
    whole = seed_story(store, s3_client, stale=["animation", "sound", "assemble", "preview"])
    url = f"{BASE}/stories/{whole['storyId']}/produce"
    assert call("POST", url, {"from": "animation", "sceneIds": ["s2"]})[1]["job"]["configuration"]["sceneIds"] == [
        "s1",
        "s2",
    ]
    fresh = seed_story(store, s3_client)
    url = f"{BASE}/stories/{fresh['storyId']}/produce"
    assert call("POST", url, {"from": "animation", "sceneIds": ["s2"]})[1]["job"]["configuration"]["sceneIds"] == ["s2"]


def test_a_storyboard_without_a_video_is_made_on_try_again(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client, status="draft", videoKey=None)
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})
    assert status == 202
    assert body["job"]["configuration"]["run"] == ALL[1:]


# --- review ---------------------------------------------------------------------------------------------------


def test_approve_rule(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    good = seed_story(store, s3_client)
    status, body = call("POST", f"{BASE}/stories/{good['storyId']}/approve", {"version": good["version"]})
    assert status == 200
    assert body["story"]["status"] == "approved"
    assert body["story"]["approvedAt"] == "2026-11-15T12:00:00.000Z"
    assert [a["kind"] for a in store.query_all(pk(), "ACT#")] == ["approved"]
    assert call("POST", f"{BASE}/stories/{good['storyId']}/approve", {"version": good["version"]})[0] == 409
    problems = seed_story(
        store,
        s3_client,
        safety={
            "topicId": "skid-recovery",
            "status": "problems",
            "problems": ["The caption says brake hard"],
            "checkedScriptVersion": 1,
            "citations": [],
        },
    )
    status, body = call("POST", f"{BASE}/stories/{problems['storyId']}/approve", {"version": 3})
    assert status == 409
    assert body["error"]["message"] == "Fix the facts first: The caption says brake hard."
    old_check = seed_story(
        store,
        s3_client,
        scriptVersion=2,
        safety={"topicId": None, "status": "ok", "problems": [], "checkedScriptVersion": 1, "citations": []},
    )
    assert call("POST", f"{BASE}/stories/{old_check['storyId']}/approve", {"version": 3})[0] == 409
    no_safety = seed_story(store, s3_client, safety=None)  # only the "nothing dangerous" check, not stored yet
    assert call("POST", f"{BASE}/stories/{no_safety['storyId']}/approve", {"version": 3})[0] == 200
    stale = seed_story(store, s3_client, stale=["sound"])
    assert call("POST", f"{BASE}/stories/{stale['storyId']}/approve", {"version": 3})[0] == 409
    assert call("POST", f"{BASE}/stories/{stale['storyId']}/approve", {"version": 2})[0] == 409
    assert call("POST", f"{BASE}/stories/{stale['storyId']}/approve", {})[0] == 400


def test_reject_and_its_note(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client, status="needs_check")
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/reject", {"reason": "Not funny"})
    assert status == 200
    assert body["story"]["status"] == "rejected"
    assert body["story"]["reviewNote"] == "Not funny"
    assert call("POST", f"{BASE}/stories/{story['storyId']}/reject", {})[0] == 409
    assert [a["kind"] for a in store.query_all(pk(), "ACT#")] == ["rejected"]


def test_download_only_when_approved_as_an_attachment(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    review = seed_story(store, s3_client, title="Ice: what to do!")
    assert call("GET", f"{BASE}/stories/{review['storyId']}/download")[0] == 409
    approved = seed_story(store, s3_client, status="approved", title="Ice: what to do!")
    status, body = call("GET", f"{BASE}/stories/{approved['storyId']}/download")
    assert status == 200
    assert body["filename"] == "ice-what-to-do.mp4"
    op, params, seconds = s3_client.presigned[-1]
    assert (op, params["Key"], seconds) == ("get_object", approved["videoKey"], 3600)
    assert params["ResponseContentDisposition"] == 'attachment; filename="ice-what-to-do.mp4"'
    assert unquote(body["url"]).startswith("https://")


# --- delete ---------------------------------------------------------------------------------------------------


def test_delete_stops_the_job_and_removes_only_this_storys_files(
    call: Call, store: db.Store, s3_client: FakeS3, table: FakeTable, agentcore: FakeAgentCore, hero: dict[str, Any]
) -> None:
    idea = seed_idea(store)
    created = call("POST", f"{BASE}/stories", {"ideaId": idea["ideaId"], "characterIds": [hero["characterId"]]})[1]
    sid, job_id = created["story"]["storyId"], created["job"]["jobId"]
    session = _job(store, job_id)["sessionId"]
    mine = story_key(sid, "final/v1.mp4")
    s3_client.objects[mine] = b"mp4"
    asset = seed_asset(store, s3_client, storyId=sid, key=mine)
    keep = seed_story(store, s3_client)
    char_file = f"{prefix()}characters/{hero['characterId']}/refs/x.png"
    s3_client.objects[char_file] = b"png"
    pubjob = seed_item(store, "PUBJOB#01J000000000000000000PUB1", "ws_pubjob", contentId=sid, publishingStatus="posted")
    assert call("DELETE", f"{BASE}/stories/{sid}")[0] == 204
    assert table.raw(pk(), f"STORY#{sid}") is None
    assert table.raw(pk(), f"PJOB#{job_id}") is None
    assert table.raw(pk(), asset["sk"]) is None
    assert mine not in s3_client.objects
    assert keep["videoKey"] in s3_client.objects
    assert char_file in s3_client.objects
    assert table.raw(pk(), pubjob["sk"]) is not None  # publishing jobs stay
    assert session in agentcore.stopped
    assert call("GET", f"{BASE}/ideas")[1]["ideas"][0]["storyIds"] == []
    assert call("GET", f"{BASE}/stories/{sid}")[0] == 404


def test_every_story_write_after_create_adds_one_to_version(
    call: Call, store: db.Store, s3_client: FakeS3, table: FakeTable, hero: dict[str, Any]
) -> None:
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    table.calls.clear()
    out = _patch(call, story, scenes=[{"sceneId": "s1", "caption": "Steer gently"}])[1]["story"]
    call("POST", f"{BASE}/stories/{sid}/produce", {})
    call("POST", f"{BASE}/stories/{sid}/cancel")
    out = call("GET", f"{BASE}/stories/{sid}")[1]["story"]
    call("POST", f"{BASE}/stories/{sid}/reject", {"reason": "no"})
    writes = []
    for op, kw in table.calls:
        requests = (
            [a.get("Update") or a.get("Put") for a in kw["TransactItems"]] if op == "transact_write_items" else [kw]
        )
        for r in requests:
            key = r.get("Key") or {"sk": r.get("Item", {}).get("sk")}
            if str(key.get("sk")) == f"STORY#{sid}" and op not in {"get_item", "query"}:
                writes.append(r)
    assert writes, "the story was written"
    for r in writes:
        assert "Item" not in r, "never a whole-item put after creation"
        assert re.search(r"ADD #n\d+ :v\d+", r["UpdateExpression"])
        assert "version" in r["ExpressionAttributeNames"].values()
    assert out["version"] == story["version"] + 3


def test_unknown_or_malformed_story_ids_are_404(call: Call) -> None:
    assert call("GET", f"{BASE}/stories/01J0000000000000000000000Z")[0] == 404
    assert call("GET", f"{BASE}/stories/not-an-id")[0] == 404
    assert call("POST", f"{BASE}/stories/not-an-id/approve", {"version": 1})[0] == 404


def test_a_refused_agent_stop_is_not_an_error(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    story = seed_story(store, s3_client, stale=["sound"])
    call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})
    agentcore.fail = True
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/cancel")
    assert status == 200
    assert body["job"]["status"] == "canceled"


def test_a_failed_script_write_leaves_the_story_as_it_was(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)

    def refuse(**_: Any) -> dict[str, Any]:
        raise OSError("S3 is down")

    s3_client.put_object = refuse  # type: ignore[method-assign]
    status, body = _patch(call, story, captionsOn=False)
    assert status == 503
    assert body["error"]["message"] == "We could not save the change just now. Try again."
    stored = _story(store, story["storyId"])
    assert stored["scriptVersion"] == 1
    assert stored["scriptKey"] == story["scriptKey"]
    assert stored["stale"] == []
    assert stored["captionsOn"] is True
    assert "ownerEdits" not in stored


# --- the owner's model and effort, reference videos, Write them again (§45.25, §45.28, §45.11.2) ------------------


def test_create_keeps_the_videos_own_setting_and_references_and_the_first_jobs_override(
    call: Call, store: db.Store, hero: dict[str, Any]
) -> None:
    ref = seed_refvid(store)
    body = {
        "brief": {"title": "Toast", "logline": "Toast flies.", "category": "comedy"},
        "characterIds": [hero["characterId"]],
        "referenceIds": [ref["refId"]],
        "ai": {"model": "fable-5-2", "effort": "high"},
        "override": {"effort": "max"},
    }
    status, out = call("POST", f"{BASE}/stories", body)
    assert status == 201
    story, job = out["story"], out["job"]
    assert story["ai"] == {"model": "fable-5-2", "effort": "high"}  # kept with the video (level 2)
    assert story["referenceIds"] == [ref["refId"]]
    # The override is for this job only: on its configuration, for the agent, and never on the story.
    stored = _job(store, job["jobId"])
    assert stored["configuration"]["override"] == {"effort": "max"}
    assert stored["configuration"]["referenceIds"] == [ref["refId"]]
    assert "override" not in _story(store, story["storyId"])
    assert job["configuration"] == {"run": ALL, "from": None, "sceneIds": None, "note": None}
    assert job["meta"]["models"] == []
    plain = call("POST", f"{BASE}/stories", {**body, "ai": None, "override": None, "referenceIds": None})[1]
    assert plain["story"]["ai"] == {"model": None, "effort": None}
    assert plain["story"]["referenceIds"] == []
    assert "override" not in _job(store, plain["job"]["jobId"])["configuration"]


@pytest.mark.parametrize(
    "extra",
    [
        {"referenceIds": ["01J0000000000000000000000Z"]},
        {"referenceIds": ["x"]},
        {"referenceIds": [f"01J000000000000000000000{n}0" for n in range(4)]},
        {"ai": {"model": "gpt-9", "effort": None}},
        {"ai": {"model": "opus-5-5"}, "override": {"effort": "extreme"}},
        {"ai": {"model": "opus-5-5", "effort": "high", "temperature": 0}},
        {"override": {"model": "opus-5-5", "effort": "high", "seed": 1}},
    ],
)
def test_bad_references_or_models_are_400(
    call: Call, store: db.Store, hero: dict[str, Any], agentcore: FakeAgentCore, extra: dict[str, Any]
) -> None:
    body = {"brief": {"title": "T", "logline": "L", "category": "comedy"}, "characterIds": [hero["characterId"]]}
    assert call("POST", f"{BASE}/stories", {**body, **extra})[0] == 400
    assert agentcore.calls == []


def test_another_owners_reference_video_cannot_be_used(call: Call, store: db.Store, hero: dict[str, Any]) -> None:
    theirs = seed_refvid(store, user="99999999-8888-7777-6666-555555555555")
    wrong = seed_refvid(store, workspaceId="01J0000000000000000000000Q")
    for ref in (theirs, wrong):
        body = {
            "brief": {"title": "T", "logline": "L", "category": "comedy"},
            "characterIds": [hero["characterId"]],
            "referenceIds": [ref["refId"]],
        }
        status, out = call("POST", f"{BASE}/stories", body)
        assert status == 400
        assert out["error"]["message"] == "We could not find one of those reference videos. Pick them again."


def test_produce_and_changes_carry_an_override_for_that_job_only(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client, stale=["sound"], referenceIds=[])
    sid = story["storyId"]
    job = call("POST", f"{BASE}/stories/{sid}/produce", {"override": {"model": "sonnet-5-5", "effort": "low"}})[1]
    assert _job(store, job["job"]["jobId"])["configuration"]["override"] == {"model": "sonnet-5-5", "effort": "low"}
    agent_end(store, sid, job["job"]["jobId"])
    again = call("POST", f"{BASE}/stories/{sid}/changes", {"note": "Faster", "override": {"model": "haiku-5-5"}})[1]
    stored = _job(store, again["job"]["jobId"])
    assert stored["configuration"]["override"] == {"model": "haiku-5-5"}
    assert stored["configuration"]["note"] == "Faster"
    assert _story(store, sid).get("ai") is None  # never saved as a setting
    agent_end(store, sid, again["job"]["jobId"])
    third = call("POST", f"{BASE}/stories/{sid}/produce", {"from": "assemble"})[1]
    assert "override" not in _job(store, third["job"]["jobId"])["configuration"]
    assert call("POST", f"{BASE}/stories/{sid}/produce", {"override": {"model": "nope"}})[0] == 400


def test_patch_sets_the_videos_model_and_references_and_makes_nothing_stale(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    ref = seed_refvid(store)
    status, body = _patch(call, story, ai={"model": "opus-5-5", "effort": "xhigh"}, referenceIds=[ref["refId"]])
    assert status == 200
    out = body["story"]
    assert out["ai"] == {"model": "opus-5-5", "effort": "xhigh"}
    assert out["referenceIds"] == [ref["refId"]]
    assert out["stale"] == []
    assert out["scriptVersion"] == 1  # no new script
    assert call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": out["version"]})[0] == 200
    other = seed_story(store, s3_client)
    assert _patch(call, other, referenceIds=["01J0000000000000000000000Z"])[0] == 400
    assert _patch(call, other, ai={"model": "gpt-9", "effort": None})[0] == 400
    cleared = _patch(call, other, ai=None, referenceIds=None)[1]["story"]
    assert (cleared["ai"], cleared["referenceIds"]) == ({"model": None, "effort": None}, [])


def test_an_owner_edited_storyboard_is_the_librarys_current_one(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    first = seed_asset(store, None, kind="storyboard", storyId=story["storyId"], key=story["scriptKey"], version=1)
    assert _patch(call, story, musicMood="calm")[0] == 200
    boards = [a for a in store.query_all(pk(), "ASSET#") if a["kind"] == "storyboard"]
    newest = next(a for a in boards if a["assetId"] != first["assetId"])
    assert newest["key"] == story_key(story["storyId"], "script/v2.json")
    assert newest["version"] == 2
    assert newest["meta"] == {"current": 1, "by": "owner"}
    assert next(a for a in boards if a["assetId"] == first["assetId"])["meta"]["current"] == 0
    listed = call("GET", f"{BASE}/library", query={"kind": "storyboard"})[1]["items"]
    assert [(i["version"], i["meta"]["current"]) for i in listed] == [(2, 1), (1, 0)]


def test_write_them_again_is_a_captions_task_of_the_storyboard_agent(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    story = seed_story(store, s3_client)
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/captions", {"override": {"effort": "low"}})
    assert status == 202
    task = body["task"]
    assert task["kind"] == "captions"
    stored = store.get(pk(), f"TASK#{task['taskId']}")
    assert stored is not None
    assert stored["input"] == {"storyId": story["storyId"], "scriptVersion": 1}
    assert stored["agentId"] == "storyboard"
    assert stored["override"] == {"effort": "low"}
    assert agentcore.calls[-1]["payload"]["action"] == "run_task"
    # The story is not touched: the draft is saved only through PATCH.
    assert _story(store, story["storyId"])["version"] == story["version"]
    draft = seed_story(store, s3_client, made=False, status="failed")
    assert call("POST", f"{BASE}/stories/{draft['storyId']}/captions", {})[0] == 409
    # The agent's finished draft is shown under ``postCaptions`` (StoryPatch's name for it), as the agent wrote it.
    written = {
        "youtubeTitle": "Ice: what to do",
        "youtubeDescription": "Slow down on ice. #shorts",
        "instagram": "Ice tips",
        "facebook": "Ice tips",
        "tiktok": "Ice tips",
        "x": "Ice tips",
    }
    store.update(
        pk(),
        f"TASK#{task['taskId']}",
        {"status": "done", "result": {"postCaptions": written, "storyId": story["storyId"]}},
    )
    shown = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]
    assert shown["status"] == "done"
    assert shown["result"] == {"postCaptions": written, "storyId": story["storyId"]}


def test_approve_accepts_a_skipped_quality_check_except_for_driving_safety(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    skipped = {"topicId": None, "status": "skipped", "problems": [], "checkedScriptVersion": 1, "citations": []}
    comedy = seed_story(store, s3_client, safety=skipped)
    shown = call("GET", f"{BASE}/stories/{comedy['storyId']}")[1]["story"]
    assert shown["safety"]["status"] == "skipped"
    assert call("POST", f"{BASE}/stories/{comedy['storyId']}/approve", {"version": 3})[0] == 200
    safety_story = seed_story(
        store, s3_client, category="driving_safety", safetyTopicId="skid-recovery", safety=skipped
    )
    status, body = call("POST", f"{BASE}/stories/{safety_story['storyId']}/approve", {"version": 3})
    assert status == 409
    assert body["error"]["message"] == "Your changes aren't in the video yet. Tap Remake first."


def test_each_steps_model_and_effort_show_on_the_job(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    job = seed_job(
        store,
        story,
        status="ready",
        meta={
            "writerModel": "fable-5-2",
            "models": [
                {
                    "step": "storyboard",
                    "agentId": "storyboard",
                    "model": "fable-5-2",
                    "effort": "high",
                    "effortApplied": True,
                },
                {
                    "step": "safety",
                    "agentId": "quality_assurance",
                    "model": "opus-5-5",
                    "effort": None,
                    "effortApplied": False,
                },
                "junk",
            ],
        },
    )
    (shown,) = call("GET", f"{BASE}/stories/{story['storyId']}/jobs")[1]["jobs"]
    assert shown["jobId"] == job["jobId"]
    assert shown["meta"]["writerModel"] == "fable-5-2"
    assert shown["meta"]["models"] == [
        {"step": "storyboard", "agentId": "storyboard", "model": "fable-5-2", "effort": "high", "effortApplied": True},
        {"step": "safety", "agentId": "quality_assurance", "model": "opus-5-5", "effort": None, "effortApplied": False},
    ]


def test_a_jobs_model_records_are_exact(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    """§45.35 D5 (and §45.34 "A failed model call still shows what was asked"): each ``meta.models`` entry keeps the
    model id or inference profile really called, its Region, the task, and ``failed: true`` for a step that stopped
    on its model; the API passes all of them through, so an added model edited later still shows what ran."""
    story = seed_story(store, s3_client)
    asked = {"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "custom-llama",
             "modelId": "us.meta.llama4-maverick-17b-instruct-v1:0", "region": "us-east-1", "effort": None,
             "effortApplied": False, "failed": True}  # fmt: skip
    ran = {"step": "safety", "agentId": "quality_assurance", "task": "fact_check", "model": "opus-5-5",
           "modelId": "global.anthropic.claude-opus-5-5", "region": "eu-north-1", "effort": "high",
           "effortApplied": True, "usage": {"input": 5}}  # fmt: skip
    seed_job(store, story, status="failed", meta={"models": [asked, ran, {**ran, "failed": "true"}]})
    (shown,) = call("GET", f"{BASE}/stories/{story['storyId']}/jobs")[1]["jobs"]
    first, second, third = shown["meta"]["models"]
    assert first == asked
    assert second == {k: v for k, v in ran.items() if k != "usage"}  # only the record's own fields
    assert "failed" not in third
    assert leaked([shown]) == []


def test_a_switched_off_storyboard_agent_refuses_runs_that_write_the_story(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any], agentcore: FakeAgentCore
) -> None:
    store.put(
        {
            "pk": pk(),
            "sk": "AGENT#storyboard",
            "type": "ws_agent",
            "userId": USER,
            "workspaceId": "stories",
            "agentId": "storyboard",
            "name": "Storyboard",
            "active": False,
        }
    )
    sentence = "Storyboard is switched off. Switch it on in Lamo Stories › Settings › Agents."
    body = {"brief": {"title": "T", "logline": "L", "category": "comedy"}, "characterIds": [hero["characterId"]]}
    status, out = call("POST", f"{BASE}/stories", body)
    assert (status, out["error"]["message"]) == (409, sentence)
    assert store.query_all(pk(), "STORY#") == []
    story = seed_story(store, s3_client, stale=["sound"])
    assert call("POST", f"{BASE}/stories/{story['storyId']}/produce", {"from": "storyboard"})[0] == 409
    assert call("POST", f"{BASE}/stories/{story['storyId']}/changes", {"note": "x"})[0] == 409
    assert _story(store, story["storyId"])["status"] == "review"
    # A remake that writes nothing new (only the sounds here) still runs.
    assert call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})[0] == 202
    assert [c["payload"]["action"] for c in agentcore.calls] == ["process_story"]


# --- the model that will really run (§45.25 "refused, never swapped: when saved") ----------------------------------

HAIKU_NO_MAX = "Claude Haiku 5.5 does not offer Maximum. Pick another level."


class _FakeResolve:
    """A stand-in for the API's one resolver (builder A2's ``ai_resolve.story_effective``): model and effort merged
    separately, request over project over the workspace default; Haiku 5.5 has no Maximum here."""

    @staticmethod
    def story_effective(
        story: dict[str, Any], *, ai: dict[str, Any], agents: dict[str, Any], task: str, override: Any
    ) -> tuple[dict[str, Any], str | None]:
        levels = [override or {}, story.get("ai") or {}]
        model = next((lv["model"] for lv in levels if lv.get("model")), ai["defaultModel"])
        effort = next((lv["effort"] for lv in levels if lv.get("effort")), ai["defaultEffort"])
        effective = {"model": model, "effort": effort, "effortApplied": True, "from": "project"}
        return effective, (HAIKU_NO_MAX if model == "haiku-5-5" and effort == "max" else None)


def _resolver(monkeypatch: pytest.MonkeyPatch, default_model: str, default_effort: str = "high") -> list[str]:
    """Installs the stand-in; returns the tasks it was asked about."""
    asked: list[str] = []

    class Res(_FakeResolve):
        @staticmethod
        def story_effective(story: dict[str, Any], **kw: Any) -> tuple[dict[str, Any], str | None]:
            asked.append(kw["task"])
            return _FakeResolve.story_effective(story, **kw)

    class AiConfig:
        @staticmethod
        def current(store: Any, user_id: str, workspace_id: str) -> dict[str, Any]:
            assert (user_id, workspace_id) == (USER, "stories")
            return {"defaultModel": default_model, "defaultEffort": default_effort, "tasks": {}}

    class Agents:
        @staticmethod
        def read_all(store: Any, user_id: str, workspace_id: str) -> dict[str, Any]:
            return {}

    monkeypatch.setattr(overrides, "resolver", lambda: (Res, AiConfig, Agents))
    return asked


def test_an_effort_alone_is_checked_against_the_model_that_will_run(
    call: Call, store: db.Store, s3_client: FakeS3, hero: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = _resolver(monkeypatch, "haiku-5-5")
    brief = {"title": "x", "logline": "y", "category": "comedy"}
    status, body = call(
        "POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]], "ai": {"effort": "max"}}
    )
    assert status == 400
    assert body["error"]["message"] == HAIKU_NO_MAX
    assert body["error"].get("field") == "ai"
    assert asked == ["storyboard", "storyboard"]  # with the setting (refused), then without it (usable)
    assert store.query_all(pk(), "STORY#") == []  # nothing was saved
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": brief, "characterIds": [hero["characterId"]], "override": {"effort": "max"}},
    )
    assert (status, body["error"]["message"], body["error"].get("field")) == (400, HAIKU_NO_MAX, "override")
    asked.clear()
    ok_story = call(
        "POST",
        f"{BASE}/stories",
        {"brief": brief, "characterIds": [hero["characterId"]], "ai": {"model": "opus-5-5", "effort": "max"}},
    )
    assert ok_story[0] == 201
    assert asked == list(overrides.STORY_TASKS)  # every task a story's jobs run
    # Produce, changes, Write them again and the idea helpers check their override the same way.
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    for path, extra in [
        (f"/stories/{sid}/produce", {"from": "storyboard"}),
        (f"/stories/{sid}/changes", {"note": "Funnier"}),
        (f"/stories/{sid}/captions", {}),
        ("/ideas/generate", {"count": 3}),
    ]:
        status, body = call("POST", BASE + path, {**extra, "override": {"effort": "max"}})
        assert (status, body["error"]["message"]) == (400, HAIKU_NO_MAX), path
    # The video's own Opus setting is the level the override's effort lands on: usable.
    patched = call("PATCH", f"{BASE}/stories/{sid}", {"version": story["version"], "ai": {"model": "opus-5-5"}})
    assert patched[0] == 200
    assert (
        call("POST", f"{BASE}/stories/{sid}/produce", {"from": "storyboard", "override": {"effort": "max"}})[0] == 202
    )


def test_a_patch_is_refused_only_for_a_setting_it_changes_to_unusable(
    call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    _resolver(monkeypatch, "haiku-5-5")
    story = seed_story(store, s3_client)
    status, body = call(
        "PATCH", f"{BASE}/stories/{story['storyId']}", {"version": story["version"], "ai": {"effort": "max"}}
    )
    assert (status, body["error"]["message"], body["error"].get("field")) == (400, HAIKU_NO_MAX, "ai")
    assert _story(store, story["storyId"])["version"] == story["version"]
    # A problem the levels below already have is the call's to report, never this save's.
    _resolver(monkeypatch, "haiku-5-5", default_effort="max")
    status, _ = call(
        "PATCH", f"{BASE}/stories/{story['storyId']}", {"version": story["version"], "ai": {"effort": "max"}}
    )
    assert status == 200
    # Sending the stored setting back with another edit is not checked again.
    stored = _story(store, story["storyId"])
    _resolver(monkeypatch, "haiku-5-5")
    status, _ = call(
        "PATCH",
        f"{BASE}/stories/{story['storyId']}",
        {"version": stored["version"], "title": "New title", "ai": {"model": None, "effort": "max"}},
    )
    assert status == 200


def test_without_the_resolver_in_the_build_nothing_more_is_checked(
    call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(overrides, "resolver", lambda: None)
    story = seed_story(store, s3_client)
    body = {"from": "storyboard", "override": {"effort": "max"}}
    assert call("POST", f"{BASE}/stories/{story['storyId']}/produce", body)[0] == 202


def test_the_real_resolver_refuses_an_effort_the_default_model_lacks(
    call: Call, hero: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Runs once builder A2's ``ai_resolve`` is in the build (§45.25's one resolver), on a model list where the
    default model, Opus 5.5, offers no Maximum."""
    if overrides.resolver() is None:
        pytest.skip("the API's resolver (workspaces/ai_resolve.py, builder A2) is not in this build yet")
    real = config.load

    def load(name: str) -> dict[str, Any]:
        data = real(name)
        if name != "models.json":
            return data
        limited = [
            {**m, "efforts": ["low", "medium", "high"]} if m.get("key") == "opus-5-5" else m for m in data["models"]
        ]
        return {**data, "models": limited, "defaultModel": "opus-5-5", "defaultEffort": "high"}

    monkeypatch.setattr(config, "load", load)
    brief = {"title": "x", "logline": "y", "category": "comedy"}
    status, body = call(
        "POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]], "ai": {"effort": "max"}}
    )
    assert status == 400
    assert "does not offer Maximum" in body["error"]["message"]
    status, _ = call(
        "POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]], "ai": {"effort": "high"}}
    )
    assert status == 201
