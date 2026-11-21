"""Stories: create, read, edit, remake, review and delete (docs/CONTRACTS.md §45.5, §45.9, §45.9.1)."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import guidance
from conftest import USER, Call
from fakes import FakeAgentCore, FakeS3, FakeTable
from ws_support import (
    BASE,
    install,
    pk,
    prefix,
    seed_asset,
    seed_character,
    seed_idea,
    seed_item,
    seed_job,
    seed_story,
    story_key,
)

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
    assert "staleScenes" not in _story(store, story["storyId"])


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
    assert agentcore.calls[-1]["payload"] == {"action": "cancel_story", "jobId": job["jobId"]}
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
