"""The workspace guard and the first-use creation of Lamo Stories (docs/CONTRACTS.md §45.3, §45.5)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from clipfactory_api import db
from clipfactory_api.errors import ApiError
from clipfactory_api.workspaces import deps, guard
from clipfactory_api.workspaces import types as ws
from fakes import FakeTable

USER = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-2222-3333-4444-555555555555"
NOW = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)


def store() -> db.Store:
    return db.Store(FakeTable())


def test_lamo_clips_is_built_in_and_never_written() -> None:
    s = store()
    item = guard.require_workspace(s, USER, ws.CLIPS, stories=False)
    assert item["workspaceType"] == ws.CLIPS
    assert item["builtin"] is True
    with pytest.raises(ApiError) as e:
        guard.require_workspace(s, USER, ws.CLIPS)
    assert e.value.status == 409
    assert s.get(ws.registry_pk(USER), ws.workspace_sk(ws.CLIPS)) is None


def test_first_stories_workspace_is_made_once_and_only_for_its_owner() -> None:
    s = store()
    first = guard.require_workspace(s, USER, ws.FIRST_STORIES_ID, now=NOW)
    again = guard.require_workspace(s, USER, ws.FIRST_STORIES_ID, now=NOW)
    assert first["workspaceId"] == again["workspaceId"] == "stories"
    assert again["configuration"]["providers"]["images"] == "builtin-rig"
    # Another user's request never sees it; without `now` nothing is created for them.
    with pytest.raises(ApiError) as e:
        guard.require_workspace(s, OTHER, "01JZ0000000000000000000000")
    assert e.value.status == 404
    assert guard.find_workspace(s, OTHER, "stories") is None


def test_owned_checks_both_attributes() -> None:
    item = {"userId": USER, "workspaceId": "stories"}
    assert guard.owned(item, USER, "stories")
    assert not guard.owned(item, OTHER, "stories")
    assert not guard.owned(item, USER, "01JZ0000000000000000000000")
    assert not guard.owned(None, USER, "stories")


def test_bad_ids_find_nothing() -> None:
    s = store()
    for bad in ("", "USER#x", "stories/../clips", "a" * 27):
        assert guard.find_workspace(s, USER, bad) is None


def test_deps_are_built_once_and_can_be_installed() -> None:
    class App:
        pass

    app = App()
    first = deps.of(app)
    assert deps.of(app) is first
    fake = deps.install(app, deps.WsDeps(story_flow_arn="arn:test"))
    assert deps.of(app) is fake
