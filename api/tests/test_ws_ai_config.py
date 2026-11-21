"""Lamo Stories' AI configuration (docs/CONTRACTS.md §45.5 ``…/ai``, §45.6, §45.25): defaults from
``stories/config/models.json``, the conditional first PUT and the version on every later one, the owner's sentences
for unknown models, efforts a model does not offer and unknown tasks, the precedence shown in ``TaskInfo.effective``,
model status written only by the agent, prices, and Check models as a task for Lamo Stories' own runtime."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import types as ws
from conftest import USER
from fakes import FakeTable
from test_ws_ai_support import BASE, FakeRuntime, WsCall, install, leaked, pk, seed, ws_call


@pytest.fixture
def runtime(app: App) -> FakeRuntime:
    found = install(app, FakeRuntime())
    assert found is not None
    return found


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime) -> WsCall:
    return ws_call(app)


def _put(wcall: WsCall, **ai: Any) -> tuple[int, Any]:
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "tasks": {}, "prices": {}, "version": 0, **ai}
    return wcall("PUT", f"{BASE}/ai", body)


def test_defaults_come_from_lamo_stories_own_model_list(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall("GET", f"{BASE}/ai")
    assert status == 200
    assert body["ai"] == {"defaultModel": "opus-5-5", "defaultEffort": "high", "tasks": {}, "prices": {}, "version": 0}
    assert [m["key"] for m in body["models"]] == ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"]
    opus = next(m for m in body["models"] if m["key"] == "opus-5-5")
    assert opus["status"] == "not_checked"  # nothing is shown as available because it is listed
    assert opus["statusLine"] == "Not checked yet. Tap Check models to try it."
    assert opus["provider"] == "Amazon Bedrock"
    assert opus["efforts"] == ["low", "medium", "high", "xhigh", "max"]
    assert opus["defaultEffort"] == "medium"
    assert opus["price"]["source"] == "anthropic_list"
    assert [a["agentId"] for a in body["agents"]] == list(res.AGENT_IDS)
    assert [t["kind"] for t in body["tasks"]] == list(res.TASK_KINDS)
    chat = body["tasks"][0]
    assert chat == {
        "kind": "chat",
        "label": "Chat",
        "agentId": "creative_director",
        "suggestedEffort": "medium",
        "effective": {"model": "opus-5-5", "effort": "high", "effortApplied": True, "from": "default"},
    }
    # the five built-in agents are made on first use; no configuration item until the first PUT
    assert table.raw(pk(), "AICONFIG") is None
    assert all(table.raw(pk(), f"AGENT#{a}") for a in res.AGENT_IDS)
    assert leaked([body]) == []


def test_the_first_put_makes_the_item_and_later_ones_need_the_version(wcall: WsCall, table: FakeTable) -> None:
    status, body = _put(wcall, defaultModel="fable-5-2", defaultEffort="xhigh")
    assert status == 200
    assert body["ai"]["version"] == 1
    item = table.raw(pk(), "AICONFIG")
    assert item is not None
    assert item["type"] == "ws_aiconfig"
    assert (item["userId"], item["workspaceId"]) == (USER, "stories")
    assert _put(wcall, version=0)[0] == 409  # a second "first" save loses
    status, body = _put(wcall, version=1, defaultModel="sonnet-5-5", defaultEffort="low")
    assert (status, body["ai"]["version"], body["ai"]["defaultModel"]) == (200, 2, "sonnet-5-5")
    status, body = _put(wcall, version=1)
    assert status == 409
    assert body["error"]["message"] == "Your AI settings were changed somewhere else. Load them again, then save."
    _, got = wcall("GET", f"{BASE}/ai")
    assert got["tasks"][4]["effective"] == {
        "model": "sonnet-5-5",
        "effort": "low",
        "effortApplied": True,
        "from": "default",
    }


@pytest.mark.parametrize(
    ("change", "sentence"),
    [
        ({"defaultModel": "gpt-9"}, "Lamo Stories has no model called 'gpt-9'."),
        ({"defaultEffort": "turbo"}, "'turbo' is not an effort level."),
        ({"tasks": {"dance": {"model": "opus-5-5"}}}, "There is no AI task called 'dance'."),
        ({"tasks": {"storyboard": {"model": "gpt-9"}}}, "Lamo Stories has no model called 'gpt-9'."),
        ({"tasks": {"storyboard": {"speed": "fast"}}}, "Unknown field: speed."),
        ({"prices": {"gpt-9": {"inputPer1M": 1, "outputPer1M": 2, "currency": "USD"}}}, "There is no model"),
        ({"prices": {"opus-5-5": {"inputPer1M": -1, "outputPer1M": 2, "currency": "USD"}}}, "inputPer1M must be"),
        ({"prices": {"opus-5-5": {"inputPer1M": 1, "outputPer1M": 2, "currency": "dollars"}}}, "currency must be"),
        ({"colour": "red"}, "Unknown field: colour."),
        ({"version": None}, "version is required."),
    ],
)
def test_validation_answers_with_the_owners_sentence(
    wcall: WsCall, table: FakeTable, change: dict[str, Any], sentence: str
) -> None:
    status, body = _put(wcall, **change)
    assert status == 400, body
    assert body["error"]["message"].startswith(sentence)
    assert table.raw(pk(), "AICONFIG") is None


def test_an_effort_the_model_does_not_offer_is_400_with_the_sentence(
    wcall: WsCall, monkeypatch: pytest.MonkeyPatch
) -> None:
    models = res.models()
    for m in models:
        if m["key"] == "haiku-5-5":
            m["efforts"] = ["low", "medium", "high"]
    monkeypatch.setattr(res, "models", lambda: [dict(m) for m in models])
    status, body = _put(wcall, defaultModel="haiku-5-5", defaultEffort="max")
    assert status == 400
    assert body["error"]["message"] == "Claude Haiku 5.5 does not offer Maximum. Pick another level."
    status, body = _put(wcall, tasks={"captions": {"model": "haiku-5-5", "effort": "xhigh"}})
    assert status == 400
    assert (
        body["error"]["message"]
        == "Write the post captions: Claude Haiku 5.5 does not offer Extra high. Pick another level."
    )
    _, got = wcall("GET", f"{BASE}/ai")
    haiku = next(m for m in got["models"] if m["key"] == "haiku-5-5")
    assert haiku["efforts"] == ["low", "medium", "high"]


def test_task_info_shows_the_precedence(wcall: WsCall) -> None:
    assert _put(wcall, tasks={"storyboard": {"model": "fable-5-2"}, "brainstorm": {"effort": "medium"}})[0] == 200
    _, agent = wcall("GET", f"{BASE}/agents/video_analysis")
    status, _ = wcall(
        "PATCH", f"{BASE}/agents/video_analysis", {"version": agent["agent"]["version"], "model": "sonnet-5-5"}
    )
    assert status == 200
    _, got = wcall("GET", f"{BASE}/ai")
    tasks = {t["kind"]: t["effective"] for t in got["tasks"]}
    assert tasks["storyboard"] == {"model": "fable-5-2", "effort": "high", "effortApplied": True, "from": "task"}
    assert tasks["brainstorm"] == {"model": "opus-5-5", "effort": "medium", "effortApplied": True, "from": "default"}
    assert tasks["reference_analysis"]["model"] == "sonnet-5-5"
    assert tasks["reference_analysis"]["from"] == "agent"
    assert tasks["chat"]["from"] == "default"
    assert got["ai"]["tasks"] == {"storyboard": {"model": "fable-5-2"}, "brainstorm": {"effort": "medium"}}


def test_missing_tasks_and_prices_keep_the_saved_ones(wcall: WsCall) -> None:
    price = {"inputPer1M": 3, "outputPer1M": 15, "currency": "usd"}
    assert _put(wcall, tasks={"chat": {"model": "fable-5-1"}}, prices={"opus-5-5": price})[0] == 200
    status, body = wcall("PUT", f"{BASE}/ai", {"defaultModel": "opus-5-5", "defaultEffort": "low", "version": 1})
    assert status == 200
    assert body["ai"]["tasks"] == {"chat": {"model": "fable-5-1"}}
    assert body["ai"]["prices"]["opus-5-5"]["currency"] == "USD"
    assert body["ai"]["prices"]["opus-5-5"]["source"] == "owner"


def test_model_status_comes_only_from_the_agents_items(wcall: WsCall, store: db.Store) -> None:
    seed(store, "MODELSTATUS#fable-5-2", ws.TYPE_MODELSTATUS, model="fable-5-2", status="denied",
         line="Bedrock says this account has not opted in to Fable's data retention.", checkedAt="2026-11-15T10:00:00.000Z")  # fmt: skip
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, status="ok", checkedAt="2026-11-15T10:00:00.000Z")
    seed(store, "MODELSTATUS#sonnet-5-5", ws.TYPE_MODELSTATUS, user="someone-else", status="ok")
    _, got = wcall("GET", f"{BASE}/ai")
    by = {m["key"]: m for m in got["models"]}
    assert by["fable-5-2"]["status"] == "denied"
    assert by["fable-5-2"]["statusLine"].startswith("Bedrock says")
    assert by["fable-5-2"]["checkedAt"] == "2026-11-15T10:00:00.000Z"
    assert by["opus-5-5"]["status"] == "ok"
    assert by["opus-5-5"]["statusLine"] == "It answered on its last call."
    assert by["sonnet-5-5"]["status"] == "not_checked"  # an item that is not this owner's is ignored


def test_the_owners_price_replaces_the_list_price_and_can_be_cleared(wcall: WsCall) -> None:
    status, body = wcall("PUT", f"{BASE}/ai/prices/opus-5-5", {"inputPer1M": 4.5, "outputPer1M": 22, "currency": "EUR"})
    assert status == 200
    price = body["model"]["price"]
    assert price == {
        "inputPer1M": 4.5,
        "outputPer1M": 22.0,
        "cacheReadPer1M": None,
        "cacheWritePer1M": None,
        "longContext": None,
        "currency": "EUR",
        "source": "owner",
        "note": "Your own price.",
    }
    _, got = wcall("GET", f"{BASE}/ai")
    assert got["ai"]["version"] == 1
    assert got["ai"]["prices"]["opus-5-5"]["inputPer1M"] == 4.5
    status, body = wcall("PUT", f"{BASE}/ai/prices/opus-5-5", {})
    assert status == 200
    assert body["model"]["price"]["source"] == "anthropic_list"
    _, got = wcall("GET", f"{BASE}/ai")
    assert got["ai"]["prices"] == {}
    assert got["ai"]["version"] == 2
    assert wcall("PUT", f"{BASE}/ai/prices/gpt-9", {})[0] == 404
    assert wcall("PUT", f"{BASE}/ai/prices/opus-5-5", {"inputPer1M": 1, "outputPer1M": 1})[0] == 400
    assert (
        wcall("PUT", f"{BASE}/ai/prices/opus-5-5", {"inputPer1M": 1, "outputPer1M": 1, "currency": "USD", "x": 1})[0]
        == 400
    )


def test_check_models_is_a_task_on_lamo_stories_own_runtime(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable
) -> None:
    status, body = wcall("POST", f"{BASE}/ai/check-models", {"models": ["opus-5-5", "haiku-5-5"]})
    assert status == 202
    task = body["task"]
    assert (task["kind"], task["status"], task["model"], task["result"]) == ("check_models", "queued", None, None)
    item = table.raw(pk(), f"TASK#{task['taskId']}")
    assert item is not None
    assert item["input"] == {"models": ["opus-5-5", "haiku-5-5"]}
    assert item["sessionId"].startswith(f"cfstory-{task['taskId']}-")
    assert len(item["sessionId"]) == 43
    assert item["heartbeatAt"] == item["createdAt"]
    assert isinstance(item["ttl"], int)
    (sent,) = runtime.calls
    assert sent == {
        "action": "check_models",
        "user_id": USER,
        "workspace_id": "stories",
        "task_id": task["taskId"],
        "session_id": item["sessionId"],
    }
    assert leaked([body]) == []
    status, body = wcall("POST", f"{BASE}/ai/check-models", {})
    assert status == 202
    assert table.raw(pk(), f"TASK#{body['task']['taskId']}")["input"]["models"] == [m["key"] for m in res.models()]
    assert wcall("POST", f"{BASE}/ai/check-models", {"models": ["gpt-9"]})[0] == 400
    assert wcall("POST", f"{BASE}/ai/check-models", {"models": []})[0] == 400


def test_check_models_fails_plainly_when_the_runtime_is_off_or_refuses(app: App, table: FakeTable) -> None:
    install(app, None)
    wcall = ws_call(app)
    status, body = wcall("POST", f"{BASE}/ai/check-models", {})
    assert status == 202
    assert (body["task"]["status"], body["task"]["error"]) == (
        "failed",
        "Lamo Stories' AI helper isn't switched on yet.",
    )
    runtime = FakeRuntime()
    runtime.fail = True
    install(app, runtime)
    status, body = wcall("POST", f"{BASE}/ai/check-models", {})
    assert (body["task"]["status"], body["task"]["error"]) == ("failed", "The helper did not start. Tap Try again.")
    assert table.raw(pk(), f"TASK#{body['task']['taskId']}")["status"] == "failed"


def test_a_clips_id_and_another_owners_id_are_refused(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall("GET", "/v1/workspaces/clips/ai")
    assert status == 409
    assert body["error"]["message"] == "That is a Lamo Stories page. Switch to Lamo Stories first."
    assert wcall("GET", "/v1/workspaces/01JD0000000000000000000000/ai")[0] == 404
    assert wcall("PUT", "/v1/workspaces/clips/ai", {"version": 0})[0] == 409
    assert not [i for i in table.all() if i["pk"] == f"USER#{USER}"]
