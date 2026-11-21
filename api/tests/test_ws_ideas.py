"""Ideas: the owner's own, and AI ideas, Expand and Variations as tasks of Lamo Stories' own agent (CONTRACTS §45.5,
§45.7, ADR-74, ADR-78). The API runs no model: it writes a ``TASK#``, invokes ``run_task`` on Lamo Stories' runtime and
serves the task; topic matching happens once, in the API."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from conftest import OTHER, USER, Call
from fakes import FakeAgentCore, FakeS3
from ws_support import ARN, BASE, caller, install, pk, seed_character, seed_idea, seed_task


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


def test_manual_ideas_are_saved_listed_patched_and_deleted(call: Call, store: db.Store) -> None:
    status, body = call(
        "POST", f"{BASE}/ideas", {"title": "Toast trouble", "logline": "Lamo burns toast.", "category": "comedy"}
    )
    assert status == 201
    idea = body["idea"]
    assert idea["status"] == "saved"
    assert idea["source"] == "manual"
    assert idea["safetyTopicId"] is None
    assert idea["needsGuidance"] is False
    assert idea["storyIds"] == []
    status, body = call("PATCH", f"{BASE}/ideas/{idea['ideaId']}", {"logline": "Lamo burns toast twice."})
    assert status == 200
    assert body["idea"]["logline"] == "Lamo burns toast twice."
    assert [i["ideaId"] for i in call("GET", f"{BASE}/ideas")[1]["ideas"]] == [idea["ideaId"]]
    assert call("GET", f"{BASE}/ideas", query={"status": "used"})[1]["ideas"] == []
    assert call("GET", f"{BASE}/ideas", query={"status": "nope"})[0] == 400
    assert call("DELETE", f"{BASE}/ideas/{idea['ideaId']}")[0] == 204
    assert call("GET", f"{BASE}/ideas")[1]["ideas"] == []
    assert call("DELETE", f"{BASE}/ideas/{idea['ideaId']}")[0] == 404


def test_driving_safety_ideas_get_their_topic_from_the_checked_list(call: Call) -> None:
    covered = call(
        "POST",
        f"{BASE}/ideas",
        {"title": "Black ice", "logline": "Lamo's car starts sliding on black ice.", "category": "driving_safety"},
    )[1]["idea"]
    assert covered["safetyTopicId"] == "skid-recovery"
    assert covered["needsGuidance"] is False
    uncovered = call(
        "POST",
        f"{BASE}/ideas",
        {"title": "Lava road", "logline": "What to do when a volcano erupts near you.", "category": "driving_safety"},
    )[1]["idea"]
    assert uncovered["safetyTopicId"] is None
    assert uncovered["needsGuidance"] is True
    # Changing the words re-runs the match (once, here in the API).
    patched = call("PATCH", f"{BASE}/ideas/{uncovered['ideaId']}", {"logline": "A tyre blowout on the motorway."})[1]
    assert patched["idea"]["safetyTopicId"] == "tyre-blowout"
    assert patched["idea"]["needsGuidance"] is False
    back = call("PATCH", f"{BASE}/ideas/{uncovered['ideaId']}", {"category": "comedy"})[1]["idea"]
    assert back["safetyTopicId"] is None
    assert back["needsGuidance"] is False


@pytest.mark.parametrize(
    "body",
    [
        {"title": "", "logline": "x", "category": "comedy"},
        {"title": "x" * 81, "logline": "x", "category": "comedy"},
        {"title": "x", "logline": "x" * 281, "category": "comedy"},
        {"title": "x", "logline": "x", "category": "horror"},
        {"title": "x", "logline": "x", "category": "comedy", "safetyTopicId": "skid-recovery"},
        {"title": "x", "logline": "x", "category": "comedy", "characterIds": ["01J0000000000000000000000Z"]},
        {"title": "x", "logline": "x", "category": "comedy", "characterIds": ["a", "b", "c", "d"]},
        {"title": "x", "logline": "x", "category": "comedy", "concept": {"premise": "p", "beats": ["a"]}},
    ],
)
def test_bad_ideas_are_refused(call: Call, body: dict[str, Any]) -> None:
    assert call("POST", f"{BASE}/ideas", body)[0] == 400


def _task(store: db.Store, task_id: str) -> dict[str, Any]:
    found = store.get(pk(), f"TASK#{task_id}")
    assert found is not None
    return found


def _finish(store: db.Store, task_id: str, result: dict[str, Any]) -> None:
    """What Lamo Stories' agent writes when the task is done (its model, effort and answer)."""
    store.update(
        pk(),
        f"TASK#{task_id}",
        {"status": "done", "model": "opus-5-5", "effort": "medium", "effortApplied": True, "result": result},
    )


def test_ai_ideas_are_a_task_of_lamo_stories_own_agent(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    status, body = call(
        "POST",
        f"{BASE}/ideas/generate",
        {"topic": "kitchen", "category": "comedy", "count": 2, "override": {"model": "fable-5-2", "effort": "low"}},
    )
    assert status == 202
    task = body["task"]
    assert task["kind"] == "brainstorm"
    assert task["status"] == "queued"
    assert task["model"] is None
    assert task["result"] is None
    assert set(task) == {
        "taskId",
        "kind",
        "status",
        "model",
        "effort",
        "effortApplied",
        "result",
        "createdAt",
        "updatedAt",
    }
    stored = _task(store, task["taskId"])
    assert stored["input"] == {"topic": "kitchen", "category": "comedy", "count": 2}
    assert stored["override"] == {"model": "fable-5-2", "effort": "low"}  # this request only, never a setting
    assert stored["agentId"] == "creative_director"
    assert stored["heartbeatAt"] == stored["createdAt"]
    assert stored["ttl"] > 0
    assert stored["sessionId"].startswith(f"cfstory-{task['taskId']}-")
    assert len(stored["sessionId"]) >= 33
    (sent,) = agentcore.calls
    assert sent["agentRuntimeArn"] == ARN
    assert sent["agentRuntimeArn"].endswith("/cf_prod_story_agent")
    assert sent["runtimeSessionId"] == stored["sessionId"]
    assert sent["payload"] == {
        "action": "run_task",
        "userId": stored["userId"],
        "workspaceId": "stories",
        "taskId": task["taskId"],
    }
    # Nothing is saved: the drafts are the task's answer.
    assert store.query_all(pk(), "IDEA#") == []


def test_finished_drafts_are_checked_like_typed_ideas(call: Call, store: db.Store) -> None:
    hero = seed_character(store, name="Lamo")
    task = call("POST", f"{BASE}/ideas/generate", {"count": 3})[1]["task"]
    assert call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]["status"] == "queued"
    _finish(
        store,
        task["taskId"],
        {
            "drafts": [
                {
                    "title": "Oops, the toast",
                    "logline": "Lamo fights a toaster.",
                    "category": "comedy",
                    "characterIds": [hero["characterId"], "01J0000000000000000000000Z"],
                },
                {"title": "", "logline": "no title", "category": "comedy"},
                {"title": "Black ice", "logline": "Lamo's car slides on black ice.", "category": "driving_safety"},
                "not a draft",
            ]
        },
    )
    status, body = call("GET", f"{BASE}/tasks/{task['taskId']}")
    assert status == 200
    done = body["task"]
    assert done["status"] == "done"
    assert (done["model"], done["effort"], done["effortApplied"]) == ("opus-5-5", "medium", True)
    assert done["result"]["drafts"] == [
        {
            "title": "Oops, the toast",
            "logline": "Lamo fights a toaster.",
            "category": "comedy",
            "characterIds": [hero["characterId"]],
            "source": "ai",
        },
        {
            "title": "Black ice",
            "logline": "Lamo's car slides on black ice.",
            "category": "driving_safety",
            "source": "ai",
        },
    ]
    # Saving a draft runs the topic match here, in the API.
    saved = call("POST", f"{BASE}/ideas", done["result"]["drafts"][1])[1]["idea"]
    assert saved["safetyTopicId"] == "skid-recovery"
    assert saved["source"] == "ai"


def test_expand_puts_the_concept_on_the_idea_once_with_the_topic_match(
    call: Call, store: db.Store, agentcore: FakeAgentCore
) -> None:
    idea = seed_idea(
        store,
        title="Slippery",
        logline="Lamo drives on a winter morning.",
        category="driving_safety",
        needsGuidance=True,
    )
    status, body = call("POST", f"{BASE}/ideas/{idea['ideaId']}/expand", {"durationSec": 40})
    assert status == 202
    task = body["task"]
    assert task["kind"] == "expand_idea"
    assert _task(store, task["taskId"])["input"] == {"ideaId": idea["ideaId"], "durationSec": 40}
    concept = {
        "premise": "Lamo's car starts sliding on black ice.",
        "beats": ["Lamo drives", "The car slides", "Lamo steers gently"],
        "lesson": "Ease off and steer where you want to go.",
        "ending": "Lamo smiles, safe.",
        "tone": "tense_then_relief",
        "durationSec": 40,
        "onScreenText": ["Ease off the accelerator"],
    }
    _finish(store, task["taskId"], {"concept": concept, "topicId": "skid-recovery"})
    done = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]
    shown = done["result"]["idea"]
    assert shown["title"] == "Slippery"  # the title is kept
    assert shown["concept"] == concept
    assert shown["safetyTopicId"] == "skid-recovery"
    assert shown["needsGuidance"] is False
    stored = store.get(pk(), idea["sk"])
    assert stored is not None
    assert stored["concept"] == concept
    # Applied once: an owner's later edit of the concept is not overwritten by reading the task again.
    edited = {**concept, "ending": "Lamo waves."}
    assert call("PATCH", f"{BASE}/ideas/{idea['ideaId']}", {"concept": edited})[0] == 200
    again = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]
    assert again["result"]["idea"]["concept"]["ending"] == "Lamo waves."


def test_expand_with_a_bad_concept_changes_nothing_but_the_topic_match(call: Call, store: db.Store) -> None:
    idea = seed_idea(store)
    task = call("POST", f"{BASE}/ideas/{idea['ideaId']}/expand", {})[1]["task"]
    assert _task(store, task["taskId"])["input"]["durationSec"] == 45  # the workspace's default length
    _finish(store, task["taskId"], {"concept": {"premise": "p", "beats": ["a"]}})
    shown = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]["result"]["idea"]
    assert "concept" not in shown


def test_variations_keep_the_category_and_the_parent(call: Call, store: db.Store) -> None:
    idea = seed_idea(store)
    task = call("POST", f"{BASE}/ideas/{idea['ideaId']}/variations", {"count": 2})[1]["task"]
    assert task["kind"] == "variations"
    assert _task(store, task["taskId"])["input"] == {"ideaId": idea["ideaId"], "count": 2}
    _finish(
        store,
        task["taskId"],
        {"drafts": [{"title": "Toast 2", "logline": "The toaster strikes back.", "category": "explainer"}]},
    )
    (draft,) = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]["result"]["drafts"]
    assert draft == {
        "title": "Toast 2",
        "logline": "The toaster strikes back.",
        "category": "comedy",
        "source": "variation",
        "parentIdeaId": idea["ideaId"],
    }


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("generate", {"count": 7}),
        ("generate", {"count": 0}),
        ("generate", {"category": "horror"}),
        ("generate", {"topic": "x" * 201}),
        ("generate", {"model": "opus-5-5"}),
        ("generate", {"override": {"model": "gpt-9"}}),
        ("generate", {"override": {"effort": "turbo"}}),
        ("generate", {"override": {"model": "opus-5-5", "temperature": 1}}),
        ("expand", {"durationSec": 91}),
        ("variations", {"count": 5}),
    ],
)
def test_task_bodies_are_checked(call: Call, store: db.Store, agentcore: FakeAgentCore, path: str, body: Any) -> None:
    idea = seed_idea(store)
    url = f"{BASE}/ideas/generate" if path == "generate" else f"{BASE}/ideas/{idea['ideaId']}/{path}"
    assert call("POST", url, body)[0] == 400
    assert agentcore.calls == []
    assert store.query_all(pk(), "TASK#") == []


def test_an_unknown_idea_is_404_and_writes_no_task(call: Call, store: db.Store) -> None:
    for path in ("expand", "variations"):
        assert call("POST", f"{BASE}/ideas/01J0000000000000000000000Z/{path}", {})[0] == 404
    assert store.query_all(pk(), "TASK#") == []


def test_the_helper_off_or_refused_is_a_failed_task_with_a_plain_sentence(
    call: Call, app: App, store: db.Store, agentcore: FakeAgentCore, s3_client: FakeS3
) -> None:
    agentcore.reply = {"accepted": False}
    task = call("POST", f"{BASE}/ideas/generate", {})[1]["task"]
    assert task["status"] == "failed"
    assert task["error"] == "The helper did not start. Tap Try again."
    assert agentcore.stopped == [agentcore.calls[0]["runtimeSessionId"]]  # the session the refusal opened is ended
    agentcore.fail = True
    assert call("POST", f"{BASE}/ideas/generate", {})[1]["task"]["status"] == "failed"
    install(app, None, s3_client)
    task = call("POST", f"{BASE}/ideas/generate", {})[1]["task"]
    assert task["status"] == "failed"
    assert task["error"] == "The AI helper is not switched on yet, so it could not start."


def test_a_switched_off_agent_refuses_its_tasks(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    store.put(
        {
            "pk": pk(),
            "sk": "AGENT#creative_director",
            "type": "ws_agent",
            "userId": USER,
            "workspaceId": "stories",
            "agentId": "creative_director",
            "name": "Creative director",
            "active": False,
        }
    )
    status, body = call("POST", f"{BASE}/ideas/generate", {})
    assert status == 409
    assert body["error"]["message"] == (
        "Creative director is switched off. Switch it on in Lamo Stories › Settings › Agents."
    )
    assert agentcore.calls == []


def test_a_task_without_a_heartbeat_is_failed_on_read(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    queued = seed_task(store, status="queued", heartbeatAt="2026-11-15T11:56:30.000Z")  # 3.5 min before NOW
    running = seed_task(store, status="running", heartbeatAt="2026-11-15T11:55:00.000Z")  # 5 min: still fine
    late = seed_task(store, status="running", heartbeatAt="2026-11-15T11:53:30.000Z")  # 6.5 min
    for found, expected in ((queued, "failed"), (running, "running"), (late, "failed")):
        task = call("GET", f"{BASE}/tasks/{found['taskId']}")[1]["task"]
        assert task["status"] == expected
        stored = _task(store, found["taskId"])
        if expected == "failed":
            assert task["error"] == "The helper stopped. Tap Try again."
            assert stored["sessionId"] != found["sessionId"]  # the agent's next write is refused
            assert found["sessionId"] in agentcore.stopped
        else:
            assert stored["sessionId"] == found["sessionId"]


def test_another_owners_task_is_404(call: Call, store: db.Store) -> None:
    theirs = seed_task(store, user=OTHER)
    assert call("GET", f"{BASE}/tasks/{theirs['taskId']}")[0] == 404
    assert call("GET", f"{BASE}/tasks/{theirs['taskId']}", sub=OTHER)[0] == 200
    wrong = seed_task(store, workspaceId="01J0000000000000000000000Q")  # the item disagrees with its key
    assert call("GET", f"{BASE}/tasks/{wrong['taskId']}")[0] == 404
    assert call("GET", f"{BASE}/tasks/not-an-id")[0] == 404


def test_saving_a_draft_keeps_its_source_and_parent(call: Call, store: db.Store) -> None:
    parent = seed_idea(store)
    status, body = call(
        "POST",
        f"{BASE}/ideas",
        {
            "title": "Toast 2",
            "logline": "The toaster strikes back.",
            "category": "comedy",
            "source": "variation",
            "parentIdeaId": parent["ideaId"],
        },
    )
    assert status == 201
    assert body["idea"]["source"] == "variation"
    assert body["idea"]["parentIdeaId"] == parent["ideaId"]
