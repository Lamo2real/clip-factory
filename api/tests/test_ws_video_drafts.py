"""Saved video drafts (docs/CONTRACTS.md §45.47, ADR-97): their own ``VDRAFT#`` item, never a story.

Create, read, change and delete; at most 50 per workspace and 32 KB each; a stale version is 409; an unfinished form
is fine, an unknown key is not; the name comes from the title, else the idea's title. Another owner's workspace is
404 and Lamo Clips is 409 on every route (``test_ws_isolation.py`` runs them from ``ws_routes_core.EXPECTED``).
"""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces import video_drafts
from conftest import OTHER, USER, Call
from fakes import FakeAgentCore, FakeS3, FakeTable
from ws_support import BASE, caller, install, pk, seed_idea, seed_video_draft

URL = f"{BASE}/video-drafts"
FULL: dict[str, Any] = {
    "source": "script",
    "title": "The chase",
    "logline": "Lamo chases the van.",
    "category": "comedy",
    "script": {
        "scenes": [
            {"what": "Lamo runs.", "caption": "Go!", "who": ["Lamo"], "place": "road_day"},
            {"what": "", "place": "ai"},
        ],
        "answers": {"where": "a road"},
    },
    "characterIds": [ulid(), ulid(), ulid(), ulid()],
    "roles": {"mainId": "01J0000000000000000000000A", "villainId": "01J0000000000000000000000B"},
    "seriesId": None,
    "durationSec": 45,
    "format": {"aspect": "9:16", "width": 1080, "height": 1920},
    "art": "classic",
    "captionsOn": True,
    "musicMood": "playful",
    "referenceIds": [ulid()],
    "ai": {"model": "fable-5-2"},
}


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


def test_a_draft_is_saved_listed_read_changed_and_deleted(call: Call, store: db.Store) -> None:
    status, made = call("POST", URL, {"form": FULL})
    assert status == 201, made
    assert set(made) == {"draftId", "workspaceId", "name", "form", "version", "createdAt", "updatedAt"}
    assert (made["name"], made["version"], made["workspaceId"]) == ("The chase", 1, "stories")
    assert made["form"] == FULL
    stored = store.get(pk(), f"VDRAFT#{made['draftId']}")
    assert stored is not None
    assert (stored["type"], stored["userId"]) == (ws.TYPE_VIDEO_DRAFT, USER)
    assert call("GET", f"{URL}/{made['draftId']}") == (200, made)  # seriesId null (No series) comes back as null
    assert call("GET", URL) == (200, {"items": [made]})
    # autosave: the whole form again, with the version it was read at
    form = {**FULL, "title": "The big chase", "durationSec": 60}
    status, saved = call("PUT", f"{URL}/{made['draftId']}", {"form": form, "version": 1})
    assert status == 200, saved
    assert (saved["name"], saved["version"], saved["form"]["durationSec"]) == ("The big chase", 2, 60)
    assert call("DELETE", f"{URL}/{made['draftId']}") == (204, None)
    assert call("GET", f"{URL}/{made['draftId']}")[0] == 404
    assert call("DELETE", f"{URL}/{made['draftId']}") == (204, None)  # a second tap is harmless
    assert store.query_all(pk(), "VDRAFT#") == []
    assert store.query_all(pk(), "STORY#") == []  # a draft is never a story
    assert stored["form"]["seriesId"] == video_drafts.NO_SERIES_STORED  # the store drops nulls in a map


def test_an_unfinished_form_is_fine(call: Call) -> None:
    status, made = call("POST", URL, {"form": {}})
    assert (status, made["name"], made["form"]) == (201, "Untitled video", {})
    status, made = call("POST", URL, {"form": {"source": "own", "script": {"scenes": []}, "characterIds": []}})
    assert status == 201
    assert made["form"] == {"source": "own", "script": {"scenes": []}, "characterIds": []}


def test_the_name_is_the_title_else_the_ideas_title(call: Call, store: db.Store) -> None:
    idea = seed_idea(store, title="The kitchen dance")
    assert call("POST", URL, {"form": {"ideaId": idea["ideaId"]}})[1]["name"] == "The kitchen dance"
    assert call("POST", URL, {"form": {"ideaId": idea["ideaId"], "title": "  Mine  "}})[1]["name"] == "Mine"
    assert call("POST", URL, {"form": {"ideaId": ulid()}})[1]["name"] == "Untitled video"  # a gone idea
    theirs = seed_idea(store, user=OTHER, title="Their idea")
    assert call("POST", URL, {"form": {"ideaId": theirs["ideaId"]}})[1]["name"] == "Untitled video"
    assert call("POST", URL, {"form": {"title": "x" * 80}})[1]["name"] == "x" * 60
    assert video_drafts.name_of({"title": "   "}, None) == "Untitled video"


def test_the_list_is_newest_change_first(call: Call, store: db.Store) -> None:
    old = seed_video_draft(store, name="Old", updatedAt="2026-11-01T00:00:00.000Z")
    new = seed_video_draft(store, name="New", updatedAt="2026-11-20T00:00:00.000Z")
    seed_video_draft(store, user=OTHER, name="Theirs")
    items = call("GET", URL)[1]["items"]
    assert [i["draftId"] for i in items] == [new["draftId"], old["draftId"]]


def test_at_most_50_drafts(call: Call, store: db.Store) -> None:
    for _ in range(video_drafts.MAX_DRAFTS):
        seed_video_draft(store)
    status, body = call("POST", URL, {"form": {}})
    assert (status, body["error"]["message"]) == (409, "You have 50 drafts. Delete one first.")
    assert len(store.query_all(pk(), "VDRAFT#")) == 50


def test_at_most_32_kb(call: Call, store: db.Store) -> None:
    scenes = [{"what": "w" * 1500, "caption": "c" * 1500} for _ in range(12)]
    status, body = call("POST", URL, {"form": {"script": {"scenes": scenes}}})
    assert (status, body["error"]["message"]) == (413, video_drafts.TOO_BIG)
    made = call("POST", URL, {"form": {}})[1]
    status, _ = call("PUT", f"{URL}/{made['draftId']}", {"form": {"script": {"scenes": scenes}}, "version": 1})
    assert status == 413
    assert store.get(pk(), f"VDRAFT#{made['draftId']}")["form"] == {}  # type: ignore[index]


def test_a_stale_version_is_409(call: Call, store: db.Store) -> None:
    made = call("POST", URL, {"form": {"title": "A"}})[1]
    assert call("PUT", f"{URL}/{made['draftId']}", {"form": {"title": "B"}, "version": 1})[0] == 200
    status, body = call("PUT", f"{URL}/{made['draftId']}", {"form": {"title": "C"}, "version": 1})
    assert (status, body["error"]["message"]) == (409, video_drafts.CHANGED)
    assert store.get(pk(), f"VDRAFT#{made['draftId']}")["form"] == {"title": "B"}  # type: ignore[index]
    assert call("PUT", f"{URL}/{ulid()}", {"form": {}, "version": 1})[0] == 404


@pytest.mark.parametrize(
    "form",
    [
        {"colour": "red"},
        {"source": "dream"},
        {"title": 3},
        {"characterIds": ["x"]},
        {"characterIds": [ulid() for _ in range(5)]},
        {"roles": {"villainId": "01J0000000000000000000000B"}},
        {"roles": {"mainId": "01J0000000000000000000000A", "hero": True}},
        {"seriesId": "x"},
        {"durationSec": 91},
        {"format": {"aspect": "4:3", "width": 1, "height": 1}},
        {"art": "oil"},
        {"captionsOn": "yes"},
        {"referenceIds": [ulid() for _ in range(4)]},
        {"ai": {"effort": "huge"}},
        {"script": {"scenes": [{"what": "x", "place": "moon"}]}},
        {"script": {"scenes": [{"what": "x", "sceneId": "s1"}]}},
        {"script": {"scenes": "x"}},
        {"script": {"scenes": [], "answers": {"a": 1}}},
    ],
)
def test_a_form_is_checked_loosely_but_checked(call: Call, store: db.Store, form: dict[str, Any]) -> None:
    status, _ = call("POST", URL, {"form": form})
    assert status == 400, form
    assert store.query_all(pk(), "VDRAFT#") == []


def test_bad_bodies_and_ids(call: Call, table: FakeTable) -> None:
    assert call("POST", URL, {"form": {}, "extra": 1})[0] == 400
    assert call("POST", URL, {})[0] == 400  # a form is required (an empty one is fine)
    assert call("POST", URL, {"form": []})[0] == 400
    assert call("GET", f"{URL}/not-an-id")[0] == 404
    made = call("POST", URL, {"form": {}})[1]
    assert call("PUT", f"{URL}/{made['draftId']}", {"form": {}})[0] == 400  # no version
    assert call("PUT", f"{URL}/{made['draftId']}", {"form": {}, "version": 1, "name": "x"})[0] == 400


def test_another_owners_draft_is_never_found(call: Call, store: db.Store) -> None:
    theirs = seed_video_draft(store, user=OTHER)
    assert call("GET", f"{URL}/{theirs['draftId']}")[0] == 404
    assert call("PUT", f"{URL}/{theirs['draftId']}", {"form": {}, "version": 1})[0] == 404
    assert call("DELETE", f"{URL}/{theirs['draftId']}")[0] == 204
    assert store.get(pk(OTHER), theirs["sk"]) is not None  # untouched
    # an item whose attributes disagree with its key is not returned either
    odd = seed_video_draft(store, workspaceId="elsewhere")
    assert call("GET", f"{URL}/{odd['draftId']}")[0] == 404
    assert call("GET", URL)[1]["items"] == []


def test_vdraft_is_not_a_stream_prefix() -> None:
    assert ws.VIDEO_DRAFT_SK == "VDRAFT#"
    assert ws.VIDEO_DRAFT_SK in ws.ITEM_PREFIXES
    assert video_drafts.draft_sk("01J0000000000000000000000A") == "VDRAFT#01J0000000000000000000000A"
