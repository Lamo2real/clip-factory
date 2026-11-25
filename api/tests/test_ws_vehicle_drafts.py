"""Vehicle drafts: a vehicle being designed with AI keeps running when the owner leaves the screen.

A draft owns one ``character_design`` task and mirrors it (designing -> ready or failed), settled on every read. Only
one task per draft, at most 3 designing and 20 drafts per workspace, another owner's draft is a 404 and an unknown key
is a 400. Offline: the repo's fakes.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER, Call, Clock
from fakes import FakeAgentCore, FakeS3
from ws_support import BASE, caller, install, pk, prefix, seed_item, seed_workspace

URL = f"{BASE}/vehicle-drafts"
CAR: dict[str, Any] = {
    "body": "hatchback",
    "length": 1,
    "height": 1,
    "paint": "#d8352a",
    "accent": "#f4f1ea",
    "pattern": "plain",
    "windows": "clear",
    "wheels": {"style": "alloy", "rim": "#c9ccd2", "size": 1},
    "lights": {"front": "round", "rear": "bar"},
    "extra": "none",
    "face": {"eyes": "none", "color": "#1c1842", "mouth": "none"},
    "outline": "#1c1842",
}


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


def _photo(call: Call, s3_client: FakeS3) -> str:
    status, up = call(
        "POST",
        f"{BASE}/characters/design/uploads",
        {"filename": "car.jpg", "contentType": "image/jpeg", "size": 2048},
    )
    assert status == 200
    s3_client.objects[f"{prefix()}design/{up['assetId']}.jpg"] = b"jpeg"
    return str(up["assetId"])


def _make(call: Call, **extra: Any) -> dict[str, Any]:
    status, draft = call("POST", URL, {"design": {"description": "a red hatchback"}, **extra})
    assert status == 201, draft
    return draft  # type: ignore[no-any-return]


def _task(store: db.Store, draft: dict[str, Any]) -> dict[str, Any]:
    task = store.get(pk(), f"TASK#{draft['taskId']}")
    assert task is not None
    return dict(task)


def _finish(store: db.Store, draft: dict[str, Any], **fields: Any) -> None:
    store.update(pk(), f"TASK#{draft['taskId']}", {"status": "done", "model": "fable-5-2", "effort": "high", **fields})


def _car(name: str = "Rosso") -> dict[str, Any]:
    return {"kind": "car", "name": name, "car": CAR}


def test_a_draft_designs_then_is_ready(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    photo = _photo(call, s3_client)
    draft = _make(call, name="My car")
    assert set(draft) == {
        "draftId", "workspaceId", "name", "vehicle", "words", "photos", "status", "taskId", "model", "effort",
        "message", "options", "startedAt", "finishedAt", "version", "createdAt", "updatedAt",
    }  # fmt: skip
    assert (draft["status"], draft["name"], draft["vehicle"], draft["words"]) == (
        "designing",
        "My car",
        "car",
        "a red hatchback",
    )
    assert (draft["options"], draft["message"], draft["finishedAt"], draft["photos"]) == ([], None, None, [])
    task = _task(store, draft)
    assert (task["kind"], task["status"], task["input"]["kind"]) == ("character_design", "queued", "car")
    assert len(agentcore.calls) == 1
    stored = store.get(pk(), f"VDESIGN#{draft['draftId']}")
    assert stored is not None
    assert (stored["type"], stored["userId"], stored["more"]) == (ws.TYPE_VEHICLE_DRAFT, USER, False)
    # still going: a read changes nothing
    assert call("GET", f"{URL}/{draft['draftId']}")[1]["status"] == "designing"
    _finish(store, draft, result={"characters": [_car("A"), _car("B"), {"kind": "person", "name": "Not a car"}]})
    status, got = call("GET", f"{URL}/{draft['draftId']}")
    assert status == 200
    assert (got["status"], [o["name"] for o in got["options"]], got["model"], got["effort"]) == (
        "ready",
        ["A", "B"],
        "fable-5-2",
        "high",
    )
    assert got["finishedAt"]
    assert (got["version"], got["name"]) == (2, "My car")
    assert call("GET", URL) == (200, {"items": [got]})
    # nothing was saved as a character by itself
    assert store.query_all(pk(), "CHAR#") == []
    # with photos
    p = _photo(call, s3_client)
    status, with_photo = call(
        "POST", URL, {"design": {"referenceAssetIds": [p], "referenceSides": ["inside"], "vehicle": "truck"}}
    )
    assert status == 201
    assert [(x["assetId"], x["side"]) for x in with_photo["photos"]] == [(p, "inside")]
    assert with_photo["photos"][0]["url"]
    assert with_photo["vehicle"] == "truck"
    assert photo != p


def test_a_single_result_and_a_nameless_draft(call: Call, store: db.Store) -> None:
    draft = _make(call)
    _finish(store, draft, result={"character": _car("Bolt")})
    got = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert (got["status"], got["name"]) == ("ready", "Bolt")


def test_a_failed_task_fails_the_draft_and_an_empty_answer_too(call: Call, store: db.Store) -> None:
    one = _make(call)
    store.update(pk(), f"TASK#{one['taskId']}", {"status": "failed", "error": "No model today."})
    got = call("GET", f"{URL}/{one['draftId']}")[1]
    assert (got["status"], got["message"]) == ("failed", "No model today.")
    two = _make(call)
    _finish(store, two, result={"characters": []})
    got = call("GET", f"{URL}/{two['draftId']}")[1]
    assert got["status"] == "failed"
    assert got["message"] == "The helper made no vehicle. Tap Try again."


def test_a_task_with_no_heartbeat_fails_the_draft(call: Call, store: db.Store, clock: Clock) -> None:
    draft = _make(call)
    clock.now += timedelta(minutes=4)
    got = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert (got["status"], got["message"]) == ("failed", "The helper stopped. Tap Try again.")
    assert _task(store, draft)["status"] == "failed"


def test_a_missing_task_and_a_too_long_run_fail_the_draft(call: Call, store: db.Store, clock: Clock) -> None:
    draft = _make(call)
    store.delete(pk(), f"TASK#{draft['taskId']}")
    assert call("GET", f"{URL}/{draft['draftId']}")[1]["status"] == "designing"  # a moment's grace
    clock.now += timedelta(minutes=2)
    got = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert (got["status"], got["message"]) == ("failed", "The helper stopped. Tap Try again.")
    # a task that keeps its heartbeat for 15 minutes is still too long
    slow = _make(call)
    for _ in range(4):
        clock.now += timedelta(minutes=4)
        store.update(pk(), f"TASK#{slow['taskId']}", {"status": "running", "heartbeatAt": clock.now.isoformat()})
    got = call("GET", f"{URL}/{slow['draftId']}")[1]
    assert (got["status"], got["message"]) == ("failed", "It took too long. Tap Try again.")


def test_the_agent_switched_off_or_refusing_to_start(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    agentcore.fail = True
    status, draft = call("POST", URL, {"design": {"description": "x"}})
    assert status == 201
    assert (draft["status"], draft["message"]) == ("failed", "The helper did not start. Tap Try again.")
    seed_item(store, "AGENT#character", "ws_agent", agentId="character", name="Character agent", active=False)
    agentcore.fail = False
    status, body = call("POST", URL, {"design": {"description": "x"}})
    assert status == 409
    assert "switched off" in body["error"]["message"]


def test_settling_twice_is_the_same(call: Call, store: db.Store) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car()]})
    first = call("GET", f"{URL}/{draft['draftId']}")[1]
    second = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert first == second
    assert first["version"] == 2


def test_a_double_press_makes_one_task(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car()]})
    ready = call("GET", f"{URL}/{draft['draftId']}")[1]
    status, again = call("POST", f"{URL}/{draft['draftId']}/design", {})
    assert status == 202
    assert (again["status"], again["taskId"] != ready["taskId"], again["message"]) == ("designing", True, None)
    status, body = call("POST", f"{URL}/{draft['draftId']}/design", {})
    assert (status, body["error"]["message"]) == (409, "It is still designing. Wait for it.")
    assert len(store.query_all(pk(), "TASK#")) == 2
    assert len(agentcore.calls) == 2


def test_a_lost_race_never_makes_a_second_task(call: Call, store: db.Store) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car()]})
    ready = call("GET", f"{URL}/{draft['draftId']}")[1]
    # another screen claimed it between this request's read and its write
    store.update(pk(), f"VDESIGN#{draft['draftId']}", {"version": ready["version"] + 1})
    store.update(pk(), f"VDESIGN#{draft['draftId']}", {"status": "designing", "taskId": "01J0000000000000000000000Z"})
    status, body = call("POST", f"{URL}/{draft['draftId']}/design", {})
    assert (status, body["error"]["message"]) == (409, "It is still designing. Wait for it.")
    assert len(store.query_all(pk(), "TASK#")) == 1


def test_make_more_appends_and_a_failed_more_keeps_the_options(call: Call, store: db.Store) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car("A"), _car("B")]})
    assert call("GET", f"{URL}/{draft['draftId']}")[1]["status"] == "ready"
    status, more = call("POST", f"{URL}/{draft['draftId']}/design", {"more": True})
    assert status == 202
    task_input = _task(store, more)["input"]
    assert task_input["count"] == 2
    assert [a["body"] for a in task_input["avoid"]] == ["hatchback", "hatchback"]
    store.update(pk(), f"TASK#{more['taskId']}", {"status": "failed", "error": "Nope."})
    failed = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert (failed["status"], len(failed["options"])) == ("failed", 2)
    status, more = call("POST", f"{URL}/{draft['draftId']}/design", {"more": True})
    assert status == 202
    _finish(store, more, result={"characters": [_car("C"), _car("D"), _car("E")]})
    got = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert [o["name"] for o in got["options"]] == ["A", "B", "C", "D"]  # at most 4
    status, body = call("POST", f"{URL}/{draft['draftId']}/design", {"more": True})
    assert (status, body["error"]["message"]) == (409, "You have 4 designs already. Pick one.")
    # design it again replaces the options
    status, again = call("POST", f"{URL}/{draft['draftId']}/design", {"override": {"model": "fable-5-2"}})
    assert status == 202
    assert _task(store, again)["override"] == {"model": "fable-5-2"}
    _finish(store, again, result={"characters": [_car("Z")]})
    assert [o["name"] for o in call("GET", f"{URL}/{draft['draftId']}")[1]["options"]] == ["Z"]


def test_at_most_three_designing_and_twenty_drafts(call: Call, store: db.Store) -> None:
    made = [_make(call) for _ in range(3)]
    status, body = call("POST", URL, {"design": {"description": "x"}})
    assert (status, body["error"]["message"]) == (409, "3 vehicles are being designed. Wait for one to finish.")
    _finish(store, made[0], result={"characters": [_car()]})
    assert call("POST", URL, {"design": {"description": "x"}})[0] == 201  # one finished, so there is room
    # fill up to 20 with finished drafts
    for n in range(20 - len(store.query_all(pk(), "VDESIGN#"))):
        seed_item(store, f"VDESIGN#01J00000000000000000{n:05d}", ws.TYPE_VEHICLE_DRAFT, draftId=f"01J00000000000000000{n:05d}", status="ready", name="", vehicle="car", design={}, photos=[], options=[], taskId="", version=1, createdAt="2026-11-01T00:00:00.000Z", updatedAt="2026-11-01T00:00:00.000Z")  # fmt: skip
    status, body = call("POST", URL, {"design": {"description": "x"}})
    assert (status, body["error"]["message"]) == (409, "You have 20 vehicle drafts. Delete one first.")


def test_delete_leaves_the_task_and_is_harmless_twice(call: Call, store: db.Store) -> None:
    draft = _make(call)
    assert call("DELETE", f"{URL}/{draft['draftId']}") == (204, None)
    assert call("DELETE", f"{URL}/{draft['draftId']}") == (204, None)
    assert call("GET", f"{URL}/{draft['draftId']}")[0] == 404
    assert store.get(pk(), f"TASK#{draft['taskId']}") is not None
    assert call("DELETE", f"{URL}/not-an-id") == (404, call("DELETE", f"{URL}/not-an-id")[1])


def test_another_owner_sees_nothing_and_cannot_touch_it(app: App, call: Call, store: db.Store) -> None:
    draft = _make(call)
    seed_workspace(store, OTHER, "stories")
    theirs = caller(app)
    assert theirs("GET", URL, sub=OTHER) == (200, {"items": []})
    assert theirs("GET", f"{URL}/{draft['draftId']}", sub=OTHER)[0] == 404
    assert theirs("POST", f"{URL}/{draft['draftId']}/design", {}, sub=OTHER)[0] == 404
    assert theirs("DELETE", f"{URL}/{draft['draftId']}", sub=OTHER) == (204, None)
    assert call("GET", f"{URL}/{draft['draftId']}")[0] == 200  # still there


@pytest.mark.parametrize(
    "body",
    [
        {"design": {"description": "x"}, "extra": 1},
        {"design": {"description": "x", "nope": 1}},
        {"design": {"description": "x", "kind": "person"}},
        {"design": {"description": "x", "characterId": "01J0000000000000000000000Q"}},
        {"design": {}},
        {"design": {"description": "x"}, "name": "n" * 61},
        {"design": {"description": "x", "count": 9}},
        {"name": "no design"},
    ],
)
def test_a_bad_body_is_400_and_starts_no_task(call: Call, store: db.Store, body: dict[str, Any]) -> None:
    assert call("POST", URL, body)[0] == 400
    assert store.query_all(pk(), "TASK#") == []
    assert store.query_all(pk(), "VDESIGN#") == []


def test_a_redesign_body_is_checked(call: Call) -> None:
    draft = _make(call)
    assert call("POST", f"{URL}/{draft['draftId']}/design", {"nope": 1})[0] == 400
    assert call("POST", f"{URL}/{draft['draftId']}/design", {"more": "yes"})[0] == 400


def _delete_while_settling(monkeypatch: pytest.MonkeyPatch, store: db.Store, draft: dict[str, Any]) -> None:
    from clipfactory_api.workspaces import jobs

    real = jobs.settle_task

    def settle_then_delete(*args: Any, **kw: Any) -> Any:
        out = real(*args, **kw)
        store.delete(pk(), f"VDESIGN#{draft['draftId']}")
        return out

    monkeypatch.setattr(jobs, "settle_task", settle_then_delete)


def test_a_draft_deleted_while_settling_is_gone(call: Call, store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car()]})
    _delete_while_settling(monkeypatch, store, draft)
    assert call("GET", f"{URL}/{draft['draftId']}")[0] == 404
    draft2 = _make(call)
    _finish(store, draft2, result={"characters": [_car()]})
    _delete_while_settling(monkeypatch, store, draft2)
    status, body = call("GET", URL)
    assert status == 200
    assert [d["draftId"] for d in body["items"] if d["draftId"] == draft2["draftId"]] == []


def test_a_redo_clears_the_old_model_and_effort(call: Call, store: db.Store) -> None:
    draft = _make(call)
    _finish(store, draft, result={"characters": [_car()]})
    ready = call("GET", f"{URL}/{draft['draftId']}")[1]
    assert (ready["model"], ready["effort"]) == ("fable-5-2", "high")
    again = call("POST", f"{URL}/{draft['draftId']}/design", {})[1]
    assert (again["status"], again["model"], again["effort"]) == ("designing", None, None)
