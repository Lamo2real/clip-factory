"""Lamo Stories' memory (docs/CONTRACTS.md §45.5 ``…/memory``, §45.6 ``MemoryItem``, §45.27): add, edit and delete,
newest first, at most 50 notes of at most 300 characters, the creative director's own notes shown with
``source: chat``, and nothing of another owner or another workspace."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER
from fakes import FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    seed,
    ws_call,
)


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def test_add_edit_delete(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall("POST", f"{BASE}/memory", {"text": "  Lamo likes   slapstick endings. "})
    assert status == 201
    item = body["item"]
    assert (item["text"], item["source"]) == ("Lamo likes slapstick endings.", "owner")
    stored = table.raw(pk(), f"MEM#{item['memId']}")
    assert stored is not None
    assert (stored["type"], stored["userId"], stored["workspaceId"]) == ("ws_mem", USER, "stories")
    status, body = wcall("PATCH", f"{BASE}/memory/{item['memId']}", {"text": "Lamo loves pratfalls."})
    assert (status, body["item"]["text"], body["item"]["source"]) == (200, "Lamo loves pratfalls.", "owner")
    status, body = wcall("GET", f"{BASE}/memory")
    assert [m["text"] for m in body["memory"]] == ["Lamo loves pratfalls."]
    assert leaked([body]) == []
    assert wcall("DELETE", f"{BASE}/memory/{item['memId']}")[0] == 204
    assert wcall("DELETE", f"{BASE}/memory/{item['memId']}")[0] == 404
    assert wcall("PATCH", f"{BASE}/memory/{item['memId']}", {"text": "x"})[0] == 404


@pytest.mark.parametrize("text", ["", "   ", "x" * 301])
def test_text_rules(wcall: WsCall, text: str) -> None:
    assert wcall("POST", f"{BASE}/memory", {"text": text})[0] == 400
    assert wcall("POST", f"{BASE}/memory", {"text": "ok", "source": "chat"})[0] == 400


def test_newest_first_and_at_most_fifty(wcall: WsCall, store: db.Store) -> None:
    for n in range(49):
        mem_id = ulid()
        seed(store, f"MEM#{mem_id}", ws.TYPE_MEM, memId=mem_id, text=f"note {n}", source="chat")
    status, body = wcall("POST", f"{BASE}/memory", {"text": "newest"})
    assert status == 201
    _, listed = wcall("GET", f"{BASE}/memory")
    assert len(listed["memory"]) == 50
    assert listed["memory"][0]["text"] == "newest"
    assert listed["memory"][1]["source"] == "chat"
    status, body = wcall("POST", f"{BASE}/memory", {"text": "one more"})
    assert (status, body["error"]["message"]) == (409, "Memory is full (50 notes). Delete one first.")


def test_another_owner_or_workspace_sees_nothing(wcall: WsCall, store: db.Store) -> None:
    _, body = wcall("POST", f"{BASE}/memory", {"text": "mine"})
    mem_id = body["item"]["memId"]
    assert wcall("GET", f"{BASE}/memory", sub=OTHER)[1]["memory"] == []
    assert wcall("PATCH", f"{BASE}/memory/{mem_id}", {"text": "theirs"}, sub=OTHER)[0] == 404
    assert wcall("DELETE", f"{BASE}/memory/{mem_id}", sub=OTHER)[0] == 404
    seed(store, f"MEM#{ulid()}", ws.TYPE_MEM, workspace_id="stories", user=USER, text="odd", memId="x")
    store.put({**store.get(pk(), f"MEM#{mem_id}"), "sk": f"MEM#{ulid()}", "workspaceId": "elsewhere"})  # type: ignore[dict-item]
    _, listed = wcall("GET", f"{BASE}/memory")
    assert sorted(m["text"] for m in listed["memory"]) == ["mine", "odd"]
