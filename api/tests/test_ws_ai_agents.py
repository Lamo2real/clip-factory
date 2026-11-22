"""Lamo Stories' five agents (docs/CONTRACTS.md §45.5 ``…/agents/{agentId}``, §45.6 ``Agent``, §45.26): made from
``stories/config/agents.json`` on first use (once, even when two requests race), edited on their version, Reset to
the file's instructions, switched off, given a model and effort or "Workspace default" (null), and given skills in
order (only skills that exist)."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import agents as agents_mod
from clipfactory_api.workspaces import ai_resolve as res
from conftest import NOW, USER
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    pk,
    skill_md,
    upload_skill,
    ws_call,
)


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def _agent(wcall: WsCall, agent_id: str = "storyboard") -> dict[str, Any]:
    status, body = wcall("GET", f"{BASE}/agents/{agent_id}")
    assert status == 200, body
    return dict(body["agent"])


def test_built_in_agents_come_from_the_file(wcall: WsCall, table: FakeTable) -> None:
    agent = _agent(wcall, "creative_director")
    default = res.agent_default("creative_director")
    assert default is not None
    assert agent == {
        "agentId": "creative_director",
        "name": "Creative director",
        "tasks": ["chat", "brainstorm", "expand_idea", "variations", "text_edit"],
        "instructions": default["instructions"],
        "defaultInstructions": default["instructions"],
        "active": True,
        "model": None,
        "effort": None,
        "skillIds": ["nonverbal-storytelling", "vertical-short-hooks", "driving-safety-teaching"],
        "version": 1,
        "updatedAt": "2026-11-15T12:00:00.000Z",
    }
    item = table.raw(pk(), "AGENT#creative_director")
    assert item is not None
    assert (item["type"], item["userId"], item["workspaceId"]) == ("ws_agent", USER, "stories")
    assert wcall("GET", f"{BASE}/agents/clip_agent")[0] == 404


def test_first_use_makes_each_agent_once(store: db.Store, table: FakeTable) -> None:
    first = agents_mod.ensure(store, USER, "stories", NOW)
    again = agents_mod.ensure(store, USER, "stories", NOW)
    assert first == again
    puts = [c for c in table.calls if c[0] == "put_item"]
    assert len(puts) == 5
    assert all(c[1].get("ConditionExpression") == "attribute_not_exists(pk)" for c in puts)


def test_edit_on_the_version_then_reset(wcall: WsCall) -> None:
    agent = _agent(wcall)
    status, body = wcall("PATCH", f"{BASE}/agents/storyboard", {"version": 1, "instructions": "  Keep it short.  "})
    assert status == 200
    assert body["agent"]["instructions"] == "Keep it short."
    assert body["agent"]["version"] == 2
    status, body = wcall("PATCH", f"{BASE}/agents/storyboard", {"version": 1, "active": False})
    assert status == 409
    assert body["error"]["message"] == "This agent was changed somewhere else. Load it again, then save."
    status, body = wcall("PATCH", f"{BASE}/agents/storyboard", {"reset": True})
    assert status == 200
    assert body["agent"]["instructions"] == agent["defaultInstructions"]
    assert body["agent"]["version"] == 3


def test_switch_off_model_effort_and_workspace_default(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall(
        "PATCH",
        f"{BASE}/agents/quality_assurance",
        {"version": 1, "active": False, "model": "fable-5-2", "effort": "max"},
    )
    assert status == 200
    assert (body["agent"]["active"], body["agent"]["model"], body["agent"]["effort"]) == (False, "fable-5-2", "max")
    status, body = wcall("PATCH", f"{BASE}/agents/quality_assurance", {"version": 2, "model": None, "effort": None})
    assert status == 200
    assert (body["agent"]["model"], body["agent"]["effort"]) == (None, None)  # "Workspace default"
    item = table.raw(pk(), "AGENT#quality_assurance")
    assert item is not None
    assert "model" not in item
    assert "effort" not in item
    _, got = wcall("GET", f"{BASE}/ai")
    fact = next(t for t in got["tasks"] if t["kind"] == "fact_check")
    assert fact["effective"]["from"] == "default"


@pytest.mark.parametrize(
    ("change", "sentence"),
    [
        ({"model": "gpt-9"}, "Lamo Stories has no model called 'gpt-9'."),
        ({"effort": "turbo"}, "'turbo' is not an effort level."),
        ({"instructions": "   "}, "Write what this agent should do, or tap Reset."),
        ({"instructions": "x" * 10_001}, "The instructions are too long"),
        ({"active": "yes"}, "active must be true or false."),
        ({"skillIds": ["no-such-skill"]}, "We could not find one of those skills."),
        ({"skillIds": ["nonverbal-storytelling", "nonverbal-storytelling"]}, "Each skill can be picked once."),
        ({"name": "Boss"}, "Unknown field: name."),
        ({}, "Change at least one thing."),
    ],
)
def test_validation(wcall: WsCall, change: dict[str, Any], sentence: str) -> None:
    status, body = wcall("PATCH", f"{BASE}/agents/character", {"version": 1, **change})
    assert status == 400, body
    assert body["error"]["message"].startswith(sentence)
    assert _agent(wcall, "character")["version"] == 1


def test_an_effort_the_agents_model_does_not_offer_is_refused(wcall: WsCall, monkeypatch: pytest.MonkeyPatch) -> None:
    models = res.models()
    for m in models:
        if m["key"] == "haiku-5-5":
            m["efforts"] = ["low"]
    monkeypatch.setattr(res, "models", lambda: [dict(m) for m in models])
    status, body = wcall("PATCH", f"{BASE}/agents/character", {"version": 1, "model": "haiku-5-5", "effort": "high"})
    assert status == 400
    assert body["error"]["message"] == "Claude Haiku 5.5 does not offer High. Pick another level."


def test_skills_are_assigned_in_order(app: App, wcall: WsCall, s3_client: FakeS3) -> None:
    up = upload_skill(wcall, s3_client, skill_md().encode())
    status, created = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})
    assert status == 201
    mine = created["skill"]["skillId"]
    ids = [mine, "driving-safety-teaching"]
    status, body = wcall("PATCH", f"{BASE}/agents/storyboard", {"version": 1, "skillIds": ids})
    assert status == 200
    assert body["agent"]["skillIds"] == ids
    _, skills = wcall("GET", f"{BASE}/skills")
    by = {s["skillId"]: s for s in skills["skills"]}
    assert by[mine]["agentIds"] == ["storyboard"]
    assert by["vertical-short-hooks"]["agentIds"] == ["creative_director", "video_analysis"]
    assert sorted(by["driving-safety-teaching"]["agentIds"]) == ["creative_director", "quality_assurance", "storyboard"]


def test_agents_of_another_owner_are_never_read(app: App, wcall: WsCall, store: db.Store) -> None:
    store.put(
        {
            "pk": pk(),
            "sk": "AGENT#storyboard",
            "type": "ws_agent",
            "userId": "someone-else",
            "workspaceId": "stories",
            "agentId": "storyboard",
            "instructions": "Not yours.",
            "version": 7,
        }
    )
    agent = _agent(wcall)
    assert agent["instructions"] != "Not yours."
