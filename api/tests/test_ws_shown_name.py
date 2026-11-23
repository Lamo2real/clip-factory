"""The app's new name, Clip Factory Stories (22 Nov 2026), on records stored before it (docs/CONTRACTS.md §45).

A stored workspace still named the old default, "Lamo Stories", is shown as "Clip Factory Stories" in the public
workspace shape, and a built-in agent still holding the old default instructions is shown with today's; nothing
stored is rewritten. A new first workspace is stored with the new name."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import agents as agents_mod
from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import shapes
from clipfactory_api.workspaces import types as ws
from conftest import NOW, USER, Call
from fakes import FakeTable
from test_ws_ai_support import FakeRuntime, install, ws_call
from ws_support import AT, BASE, caller, seed_workspace

OLD = "Lamo Stories"
NEW = "Clip Factory Stories"


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


def _writes(table: FakeTable) -> list[str]:
    return [c[0] for c in table.calls if c[0] in {"put_item", "update_item", "delete_item", "transact_write_items"}]


def test_only_the_old_default_name_reads_as_the_new_one() -> None:
    assert (ws.OLD_STORIES_NAME, ws.FIRST_STORIES_NAME) == (OLD, NEW)
    assert ws.WORKSPACE_TYPES[ws.STORIES].label == NEW
    assert ws.shown_workspace_name(OLD) == NEW
    for name in (NEW, "Lamo Cars", "My Lamo Stories", "Lamo Stories 2", ""):
        assert ws.shown_workspace_name(name) == name
    assert ws.shown_workspace_name(None) == ""


def test_a_stored_old_name_is_shown_new_and_never_rewritten(call: Call, store: db.Store, table: FakeTable) -> None:
    seed_workspace(store, workspace_id=ws.FIRST_STORIES_ID, name=OLD)  # made before the rename
    other = seed_workspace(store, name=OLD)
    mine = seed_workspace(store, name="Lamo Cars")
    table.calls.clear()

    status, body = call("GET", "/v1/workspaces")
    assert status == 200
    names = {w["workspaceId"]: w["workspaceName"] for w in body["workspaces"]}
    assert names == {"clips": "Lamo Clips", ws.FIRST_STORIES_ID: NEW, other: NEW, mine: "Lamo Cars"}
    assert call("GET", BASE)[1]["workspace"]["workspaceName"] == NEW
    assert call("GET", f"/v1/workspaces/{other}")[1]["workspace"]["workspaceName"] == NEW
    assert _writes(table) == []  # reading never writes the new name back

    # a settings change returns the new name and leaves the stored name as it was
    version = call("GET", BASE)[1]["workspace"]["version"]
    status, body = call("PATCH", BASE, {"version": version, "configuration": {"musicOn": False}})
    assert status == 200, body
    assert body["workspace"]["workspaceName"] == NEW
    for workspace_id in (ws.FIRST_STORIES_ID, other):
        raw = table.raw(ws.registry_pk(USER), ws.workspace_sk(workspace_id))
        assert raw is not None
        assert raw["workspaceName"] == OLD


def test_the_public_shape_maps_the_name_only() -> None:
    item: dict[str, Any] = {
        "workspaceId": ws.FIRST_STORIES_ID,
        "workspaceName": OLD,
        "workspaceType": ws.STORIES,
        "version": 3,
        "createdAt": AT,
    }
    out = shapes.public_workspace(item)
    assert (out["workspaceName"], out["workspaceId"], out["version"], out["createdAt"]) == (NEW, "stories", 3, AT)
    assert item["workspaceName"] == OLD  # the item itself is not changed


def test_a_new_first_workspace_is_stored_with_the_new_name(call: Call, table: FakeTable) -> None:
    assert call("GET", "/v1/workspaces")[0] == 200
    raw = table.raw(ws.registry_pk(USER), ws.workspace_sk(ws.FIRST_STORIES_ID))
    assert raw is not None
    assert raw["workspaceName"] == NEW


def test_no_two_workspaces_show_the_same_name(call: Call, store: db.Store) -> None:
    seed_workspace(store, workspace_id=ws.FIRST_STORIES_ID, name=OLD)
    for name in (NEW, "clip factory stories", OLD):
        status, body = call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": name})
        assert status == 409, name
        assert body["error"]["message"] == f"You already have a workspace called {name}. Pick another name."
    other = call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Cars"})[1]["workspace"]
    status, _ = call("PATCH", f"/v1/workspaces/{other['workspaceId']}", {"version": 1, "workspaceName": NEW})
    assert status == 409
    # the old-named workspace itself may take the name it shows (the owner's rename is stored as typed)
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert call("PATCH", BASE, {"version": version, "workspaceName": NEW})[0] == 200


@pytest.mark.parametrize(
    "agent_id", ["creative_director", "video_analysis", "storyboard", "character", "quality_assurance"]
)
def test_an_agent_still_holding_the_old_default_is_shown_with_today_s(
    app: App, store: db.Store, table: FakeTable, agent_id: str
) -> None:
    install(app, FakeRuntime())
    wcall = ws_call(app)
    default = res.agent_default(agent_id)
    assert default is not None
    assert OLD not in default["instructions"]
    assert NEW in default["instructions"]
    old = default["instructions"].replace(NEW, OLD)
    assert old in default["formerInstructions"]  # the default before the rename is a former one
    seed_workspace(store, workspace_id=ws.FIRST_STORIES_ID, name=OLD)
    pk, sk = ws.workspace_pk(USER, ws.FIRST_STORIES_ID), agents_mod.agent_sk(agent_id)
    raw = agents_mod.ensure(store, USER, ws.FIRST_STORIES_ID, NOW)[agent_id]
    store.put({**raw, "instructions": old})  # made before the rename, never edited
    table.calls.clear()

    status, body = wcall("GET", f"{BASE}/agents/{agent_id}")
    assert status == 200, body
    assert body["agent"]["instructions"] == body["agent"]["defaultInstructions"] == default["instructions"]
    assert _writes(table) == []
    stored = table.raw(pk, sk)
    assert stored is not None
    assert stored["instructions"] == old  # never rewritten

    edited = old + " Always add a dog."  # the owner's own words stay exactly as written
    store.put({**stored, "instructions": edited})
    assert wcall("GET", f"{BASE}/agents/{agent_id}")[1]["agent"]["instructions"] == edited
