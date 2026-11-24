"""The drawing style of Clips Funded's videos (docs/CONTRACTS.md §45.45): Settings › Video's ``video.art`` (Night drive
by default, filled in for a workspace saved before it), a story's own ``art`` at create (kept apart from ``format``), an
older story with none drawn Bright, and a scene's cuts between shots scaled with its new length as the engine does."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import stories
from clipfactory_api.workspaces import types as ws
from conftest import USER, Call
from fakes import FakeAgentCore, FakeS3
from ws_support import BASE, WS, caller, install, seed_character, seed_story

BRIEF = {"title": "Night", "logline": "A drive home at night.", "category": "comedy"}
PICK = "Pick a drawing style: Night drive or Bright."


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def hero(store: db.Store) -> dict[str, Any]:
    return seed_character(store, name="Lamo")


def _create(call: Call, hero: dict[str, Any], **extra: Any) -> tuple[int, Any]:
    return call("POST", f"{BASE}/stories", {"brief": BRIEF, "characterIds": [hero["characterId"]], **extra})


def _patch(call: Call, **configuration: Any) -> tuple[int, Any]:
    version = call("GET", BASE)[1]["workspace"]["version"]
    return call("PATCH", BASE, {"version": version, "configuration": configuration})


def test_new_videos_start_in_night_drive_and_bright_can_be_picked(call: Call) -> None:
    assert call("GET", BASE)[1]["workspace"]["configuration"]["video"]["art"] == "night_drive"
    status, body = _patch(call, video={"art": "classic"})
    assert status == 200, body
    assert body["workspace"]["configuration"]["video"] == {
        "resolution": "1080x1920",
        "aspect": "9:16",
        "quality": "high",
        "fps": 30,
        "art": "classic",
    }
    status, body = _patch(call, video={"art": "noir"})
    assert (status, body["error"]["message"]) == (400, PICK)


def test_a_workspace_saved_before_drawing_styles_shows_night_drive_and_takes_a_video_edit(
    call: Call, store: db.Store
) -> None:
    call("GET", BASE)  # makes the first workspace
    key = (ws.registry_pk(USER), ws.workspace_sk(WS))
    item = store.get(*key)
    assert item is not None
    video = dict(item["configuration"]["video"])
    video.pop("art")
    store.put({**item, "configuration": {**item["configuration"], "video": video}})
    assert call("GET", BASE)[1]["workspace"]["configuration"]["video"]["art"] == "night_drive"
    status, body = _patch(call, video={"aspect": "16:9", "resolution": "1920x1080"})
    assert status == 200, body
    assert body["workspace"]["configuration"]["video"]["art"] == "night_drive"
    status, body = _patch(call, video={"art": "classic"})
    assert (status, body["workspace"]["configuration"]["video"]["art"]) == (200, "classic")


def test_a_story_takes_the_workspace_style_or_its_own(call: Call, store: db.Store, hero: dict[str, Any]) -> None:
    status, body = _create(call, hero)
    assert (status, body["story"]["art"]) == (201, "night_drive")
    assert store.get(ws.workspace_pk(USER, WS), f"STORY#{body['story']['storyId']}")["art"] == "night_drive"
    status, body = _create(call, hero, art="classic")
    assert (status, body["story"]["art"]) == (201, "classic")
    assert _patch(call, video={"art": "classic"})[0] == 200
    status, body = _create(call, hero)
    assert (status, body["story"]["art"]) == (201, "classic")
    status, body = _create(call, hero, art="night_drive")
    assert (status, body["story"]["art"]) == (201, "night_drive")
    # the format stays strictly checked on its own
    status, body = _create(call, hero, art="classic", format={"aspect": "1:1", "width": 1080, "height": 1080})
    assert (status, body["story"]["art"], body["story"]["format"]["aspect"]) == (201, "classic", "1:1")


@pytest.mark.parametrize("art", ["noir", "", 3, ["night_drive"]])
def test_a_style_that_is_not_one_of_the_two_is_refused(call: Call, hero: dict[str, Any], art: Any) -> None:
    status, body = _create(call, hero, art=art)
    assert (status, body["error"]["message"]) == (400, PICK)


def test_an_older_story_without_a_style_is_bright(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    assert "art" not in story
    assert call("GET", f"{BASE}/stories/{story['storyId']}")[1]["story"]["art"] == "classic"


def test_a_new_scene_length_scales_its_cuts_and_keeps_the_rules() -> None:
    cuts = [{"at": 0, "shot": "road_behind"}, {"at": 2, "shot": "driver_view"}, {"at": 3, "shot": "face", "who": "c1"},
            {"at": 8, "shot": "road_wide"}]  # fmt: skip
    scene: dict[str, Any] = {"durationSec": 10, "beats": [], "sfx": [], "cuts": cuts}
    stories._scale_scene(scene, 5)
    # 0, 1, 1.5 (only 0.5 s after 1: dropped), 4 (before 4.4, 0.6 s before the end: kept), as fitDuration does
    assert scene["cuts"] == [{"at": 0, "shot": "road_behind"}, {"at": 1, "shot": "driver_view"},
                             {"at": 4, "shot": "road_wide"}]  # fmt: skip
    longer: dict[str, Any] = {"durationSec": 10, "beats": [], "sfx": [], "cuts": [dict(c) for c in cuts]}
    stories._scale_scene(longer, 15)
    assert [c["at"] for c in longer["cuts"]] == [0, 3, 4.5, 12]
    assert longer["cuts"][2]["who"] == "c1"
    near_end: dict[str, Any] = {"durationSec": 10, "beats": [], "sfx": [], "cuts": [{"at": 9, "shot": "face"}]}
    stories._scale_scene(near_end, 4)
    assert near_end["cuts"] == []
    plain: dict[str, Any] = {"durationSec": 10, "beats": [], "sfx": []}
    stories._scale_scene(plain, 5)
    assert "cuts" not in plain
