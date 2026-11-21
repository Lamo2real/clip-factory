"""GET/POST /v1/workspaces, GET/PATCH /v1/workspaces/{ws} (docs/CONTRACTS.md §45.2, §45.3, §45.5, §45.6)."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER, Call
from fakes import FakeTable
from ws_support import BASE, seed_workspace


def test_list_puts_lamo_clips_first_and_makes_lamo_stories_once(call: Call, table: FakeTable) -> None:
    status, body = call("GET", "/v1/workspaces")
    assert status == 200
    first, second = body["workspaces"]
    assert first == {
        "workspaceId": "clips",
        "workspaceName": "Lamo Clips",
        "workspaceType": "clips",
        "builtin": True,
        "configuration": {},
        "version": 1,
    }
    assert second["workspaceId"] == "stories"
    assert second["workspaceName"] == "Lamo Stories"
    assert second["workspaceType"] == "stories"
    assert second["builtin"] is False
    assert second["configuration"]["defaultDurationSec"] == 45
    assert second["configuration"]["providers"] == {
        "images": "builtin-rig",
        "animation": "builtin-2d",
        "audio": "builtin-synth",
    }
    puts = [c for c in table.calls if c[0] == "put_item"]
    assert len(puts) == 1
    assert puts[0][1]["ConditionExpression"] == "attribute_not_exists(pk)"
    call("GET", "/v1/workspaces")
    assert len([c for c in table.calls if c[0] == "put_item"]) == 1  # made once
    # Lamo Clips is never written as an item.
    assert table.raw(ws.registry_pk(USER), ws.workspace_sk("clips")) is None


def test_create_checks_type_name_and_the_cap(call: Call, store: db.Store) -> None:
    status, body = call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Cars"})
    assert status == 201
    created = body["workspace"]
    assert created["workspaceName"] == "Lamo Cars"
    assert ws.WORKSPACE_ID.match(created["workspaceId"])
    assert created["workspaceId"] not in {"clips", "stories"}
    names = [w["workspaceName"] for w in call("GET", "/v1/workspaces")[1]["workspaces"]]
    assert names == ["Lamo Clips", "Lamo Stories", "Lamo Cars"]
    assert call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "lamo cars"})[0] == 409
    assert call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Clips"})[0] == 409
    assert call("POST", "/v1/workspaces", {"workspaceType": "clips", "workspaceName": "X"})[0] == 400
    assert call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "x" * 41})[0] == 400
    assert call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Y", "extra": 1})[0] == 400
    for n in range(8):
        assert call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": f"Brand {n}"})[0] == 201
    status, body = call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "One too many"})
    assert status == 409
    assert "at most 10" in body["error"]["message"]


def test_get_answers_both_types_and_hides_other_owners(call: Call, store: db.Store) -> None:
    assert call("GET", "/v1/workspaces/clips")[1]["workspace"]["builtin"] is True
    assert call("GET", "/v1/workspaces/stories")[1]["workspace"]["workspaceName"] == "Lamo Stories"
    theirs = seed_workspace(store, OTHER, name="Their brand")
    status, body = call("GET", f"/v1/workspaces/{theirs}")
    assert status == 404
    assert body["error"]["message"] == "We could not find that workspace."
    assert call("GET", "/v1/workspaces/USER%23x")[0] == 404
    assert call("GET", "/v1/workspaces/not-a-workspace")[0] == 404


def test_patch_merges_the_configuration_with_a_version(call: Call) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    status, body = call(
        "PATCH",
        BASE,
        {
            "version": version,
            "workspaceName": "Lamo Stories Studio",
            "configuration": {
                "defaultDurationSec": 30,
                "providers": {"images": "nova-canvas"},
                "storyModel": "opus-5-5",
            },
        },
    )
    assert status == 200
    w = body["workspace"]
    assert w["version"] == version + 1
    assert w["workspaceName"] == "Lamo Stories Studio"
    assert w["configuration"]["defaultDurationSec"] == 30
    assert w["configuration"]["providers"] == {
        "images": "nova-canvas",
        "animation": "builtin-2d",
        "audio": "builtin-synth",
    }
    assert w["configuration"]["captionsOn"] is True
    stale = call("PATCH", BASE, {"version": version, "configuration": {"musicOn": False}})
    assert stale[0] == 409


@pytest.mark.parametrize(
    "configuration",
    [
        {"defaultDurationSec": 10},
        {"defaultDurationSec": 91},
        {"storyModel": "gpt-9"},
        {"providers": {"animation": "nova-reel"}},
        {"providers": {"images": "midjourney"}},
        {"youtubeCategory": "20"},
        {"youtubePrivacy": "secret"},
        {"captionsOn": "yes"},
        {"madeForKids": True},
    ],
)
def test_patch_refuses_bad_settings(call: Call, configuration: dict[str, object]) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert call("PATCH", BASE, {"version": version, "configuration": configuration})[0] == 400


def test_patch_on_lamo_clips_is_refused(call: Call) -> None:
    status, body = call("PATCH", "/v1/workspaces/clips", {"version": 1, "workspaceName": "x"})
    assert status == 409
    assert body["error"]["message"] == "That is a Lamo Stories page. Switch to Lamo Stories first."


def test_rename_cannot_take_another_workspaces_name(call: Call) -> None:
    call("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Cars"})
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert call("PATCH", BASE, {"version": version, "workspaceName": "LAMO CARS"})[0] == 409
    assert call("PATCH", BASE, {"version": version, "workspaceName": "Lamo Stories"})[0] == 200
