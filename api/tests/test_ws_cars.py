"""Car characters (docs/CONTRACTS.md §45.42, §45.43): a car's own rules, one car with someone to drive it, and Design
with AI from up to 6 photos with several options."""

from __future__ import annotations

import copy
import re
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.errors import ApiError
from clipfactory_api.workspaces import characters, design
from conftest import Call
from fakes import FakeAgentCore, FakeS3
from ws_support import BASE, caller, character_body, install, pk, prefix, seed_character

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


def car_body(name: str = "Rosso", **extra: Any) -> dict[str, Any]:
    body = character_body(name)
    body.pop("look")
    return {
        **body,
        "kind": "car",
        "description": "A small red hatchback, a bit old.",
        "movementStyle": "zippy",
        "expressions": ["neutral"],
        "car": copy.deepcopy(CAR),
        "voice": {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine", "honk"]},
        **extra,
    }


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


# --- a car's rules (characters.character_input) ------------------------------------------------------------------


def test_a_car_is_saved_with_its_car_look_and_no_person_look(call: Call, store: db.Store) -> None:
    status, body = call("POST", f"{BASE}/characters", {**car_body(), "look": {"ignored": True}})
    assert status == 201
    rosso = body["character"]
    assert rosso["kind"] == "car"
    assert rosso["car"] == CAR
    assert "look" not in rosso
    assert rosso["voice"] == {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine", "honk"]}
    stored = store.get(pk(), f"CHAR#{rosso['characterId']}")
    assert stored is not None
    assert (stored["kind"], stored.get("look")) == ("car", None)  # a car's look is stored as null
    # a person keeps its look, with kind person and no car
    status, body = call("POST", f"{BASE}/characters", character_body("Pip"))
    assert status == 201
    assert body["character"]["kind"] == "person"
    assert "car" not in body["character"]
    stored = store.get(pk(), f"CHAR#{body['character']['characterId']}")
    assert stored is not None
    assert (stored["kind"], stored.get("car")) == ("person", None)


def test_a_car_with_eyes_has_faces_and_put_may_change_the_kind(call: Call) -> None:
    eyes = {**CAR, "face": {"eyes": "windscreen", "color": "#1c1842", "mouth": "grille"}}
    status, _ = call("POST", f"{BASE}/characters", car_body(car=eyes, expressions=["neutral", "happy", "surprised"]))
    assert status == 201
    pip = call("POST", f"{BASE}/characters", character_body("Pip"))[1]["character"]
    status, body = call("PUT", f"{BASE}/characters/{pip['characterId']}", {**car_body("Pip"), "version": 1})
    assert status == 200
    assert body["character"]["kind"] == "car"
    assert "look" not in body["character"]


@pytest.mark.parametrize(
    ("change", "sentence"),
    [
        ({"kind": "boat"}, characters.NO_KIND),
        ({"voice": {"style": "babble", "pitch": 1, "noises": [], "sfx": []}}, characters.CAR_VOICE),
        ({"voice": {"style": "none", "pitch": 1, "noises": ["gasp"], "sfx": []}}, characters.CAR_VOICE),
        ({"expressions": ["neutral", "happy", "sad"]}, characters.CAR_FACES),
        (
            {"car": {**CAR, "face": {"eyes": "headlights", "color": "#1c1842", "mouth": "none"}}},
            characters.FACES_RULE,
        ),
    ],
)
def test_a_cars_own_rules_have_their_sentences(call: Call, change: dict[str, Any], sentence: str) -> None:
    status, body = call("POST", f"{BASE}/characters", {**car_body(), **change})
    assert status == 400
    assert body["error"]["message"] == sentence


def test_a_person_has_no_car_look(call: Call) -> None:
    status, body = call("POST", f"{BASE}/characters", {**character_body(), "car": CAR})
    assert status == 400
    assert body["error"]["message"] == characters.PERSON_CAR
    assert call("POST", f"{BASE}/characters", {**character_body(), "kind": "person", "car": None})[0] == 201


@pytest.mark.parametrize(
    "change",
    [
        {"body": "limo"},
        {"length": 1.3},
        {"height": 0.5},
        {"paint": "red"},
        {"pattern": "tartan"},
        {"windows": "mirror"},
        {"wheels": {"style": "spinners", "rim": "#c9ccd2", "size": 1}},
        {"wheels": {"style": "alloy", "rim": "#c9ccd2", "size": 1.3}},
        {"lights": {"front": "round", "rear": "oval"}},
        {"extra": "jetpack"},
        {"face": {"eyes": "none", "color": "#1c1842", "mouth": "teeth"}},
        {"badge": "VW"},
    ],
)
def test_bad_car_looks_are_refused(call: Call, change: dict[str, Any]) -> None:
    assert call("POST", f"{BASE}/characters", car_body(car={**CAR, **change}))[0] == 400


def test_a_car_keeps_at_most_8_favourite_effects_from_the_catalog(call: Call) -> None:
    nine = ["engine", "honk", "brake_squeal", "skid", "screech", "tyre_burst", "beep", "click", "pop"]
    assert call("POST", f"{BASE}/characters", car_body(voice={"style": "none", "sfx": nine}))[0] == 400
    assert call("POST", f"{BASE}/characters", car_body(voice={"style": "none", "sfx": ["vroom"]}))[0] == 400
    status, body = call("POST", f"{BASE}/characters", car_body(voice={"style": "none", "pitch": 1.6, "sfx": nine[:8]}))
    assert status == 201
    assert body["character"]["voice"] == {"style": "none", "pitch": 1, "noises": [], "sfx": nine[:8]}


def test_cast_problem() -> None:
    person, car = {"kind": "person"}, {"kind": "car"}
    assert characters.cast_problem([person]) is None
    assert characters.cast_problem([{}]) is None  # an older item is a person
    assert characters.cast_problem([person, car]) is None
    assert characters.cast_problem([car, person, {}]) is None
    assert characters.cast_problem([car]) == "Add someone to drive it."
    assert characters.cast_problem([car, car]) == "Pick one car."
    assert characters.cast_problem([person, car, car]) == "Pick one car."
    assert characters.cast_problem([]) is None


# --- design.parse -------------------------------------------------------------------------------------------------

ULIDS = [f"01J00000000000000000000{n:03d}" for n in range(10)]


def test_parse_merges_the_old_picture_first_and_keeps_the_owners_order() -> None:
    ask = design.parse({"referenceAssetId": ULIDS[3], "referenceAssetIds": [ULIDS[1], ULIDS[3], ULIDS[2]]})
    assert ask.asset_ids == [ULIDS[3], ULIDS[1], ULIDS[2]]
    assert (ask.kind, ask.count, ask.avoid, ask.description, ask.override) == (None, None, [], None, None)
    full = design.parse({"description": " my red hatchback ", "kind": "car", "count": 4, "avoid": [CAR],
                         "override": {"model": "fable-5-2"}})  # fmt: skip
    assert (full.description, full.kind, full.count, full.avoid) == ("my red hatchback", "car", 4, [CAR])
    assert full.override == {"model": "fable-5-2"}


@pytest.mark.parametrize(
    ("body", "status", "sentence"),
    [
        ({"referenceAssetIds": ULIDS[:7]}, 400, design.TOO_MANY),
        ({"referenceAssetId": ULIDS[0], "referenceAssetIds": ULIDS[1:7]}, 400, design.TOO_MANY),
        ({"referenceAssetIds": ULIDS[0]}, 400, design.NOT_IDS),
        ({"referenceAssetIds": [1, 2]}, 400, design.NOT_IDS),
        ({"count": 0}, 400, design.BAD_COUNT),
        ({"count": 5}, 400, design.BAD_COUNT),
        ({"count": True}, 400, design.BAD_COUNT),
        ({"count": 2.5}, 400, design.BAD_COUNT),
        ({"kind": "animal"}, 400, characters.NO_KIND),
        ({"characterId": "x"}, 404, design.NO_CHARACTER),
        ({"avoid": [CAR] * 9}, 400, None),
        ({"avoid": [{**CAR, "body": "limo"}]}, 400, None),
        ({"colour": "red"}, 400, "Unknown field: colour."),
        ({"description": "x" * 601}, 400, None),
    ],
)
def test_parse_limits(body: dict[str, Any], status: int, sentence: str | None) -> None:
    with pytest.raises(ApiError) as e:
        design.parse(body)
    assert e.value.status == status
    if sentence is not None:
        assert e.value.message == sentence


def test_task_input_kinds_counts_and_sentences() -> None:
    photo = {"assetId": ULIDS[0], "key": "ws/u/w/design/a.png", "contentType": "image/png"}
    person = design.task_input(design.parse({"description": "a cat"}), [], None)
    assert person == {"kind": "person", "count": 1, "description": "a cat", "references": []}
    car = design.task_input(design.parse({"kind": "car"}), [photo], None)
    assert car == {
        "kind": "car",
        "count": 3,
        "references": [photo],
        "referenceAssetId": ULIDS[0],
        "referenceKey": "ws/u/w/design/a.png",
        "referenceContentType": "image/png",
    }
    saved = {"characterId": ULIDS[9], "kind": "car"}
    assert design.task_input(design.parse({"description": "make it blue"}), [], saved)["kind"] == "car"
    with pytest.raises(ApiError, match=re.escape("Keep the same kind: this character is a car.")):
        design.task_input(design.parse({"kind": "person", "description": "x"}), [], saved)
    with pytest.raises(ApiError, match=re.escape("Keep the same kind: this character is a person.")):
        design.task_input(design.parse({"kind": "car", "description": "x"}), [], {"characterId": ULIDS[8]})
    with pytest.raises(ApiError, match=re.escape("Add a photo of your car, or say what it is like.")):
        design.task_input(design.parse({"kind": "car"}), [], None)
    with pytest.raises(ApiError, match=re.escape("Describe the character, or add a picture of it.")):
        design.task_input(design.parse({}), [], None)
    with pytest.raises(ApiError, match=re.escape(design.AVOID_CARS)):
        design.task_input(design.parse({"description": "x", "avoid": [CAR]}), [], None)


# --- the design route (POST …/characters/design) --------------------------------------------------------------------


def _photos(call: Call, s3_client: FakeS3, n: int) -> list[tuple[str, str]]:
    """``n`` sent design pictures: (assetId, key)."""
    out = []
    for i in range(n):
        status, up = call(
            "POST",
            f"{BASE}/characters/design/uploads",
            {"filename": f"car{i}.jpg", "contentType": "image/jpeg", "size": 2048},
        )
        assert status == 200
        key = f"{prefix()}design/{up['assetId']}.jpg"
        s3_client.objects[key] = b"jpeg"
        out.append((up["assetId"], key))
    return out


def _task_input(store: db.Store, out: dict[str, Any]) -> dict[str, Any]:
    stored = store.get(pk(), f"TASK#{out['task']['taskId']}")
    assert stored is not None
    return dict(stored["input"])


def test_a_car_from_4_photos(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    photos = _photos(call, s3_client, 4)
    body = {"kind": "car", "referenceAssetIds": [a for a, _ in photos], "description": "my red hatchback"}
    status, out = call("POST", f"{BASE}/characters/design", {**body, "override": {"model": "fable-5-2"}})
    assert status == 202
    assert out["task"]["kind"] == "character_design"
    assert _task_input(store, out) == {
        "kind": "car",
        "count": 3,
        "description": "my red hatchback",
        "references": [{"assetId": a, "key": k, "contentType": "image/jpeg"} for a, k in photos],
        "referenceAssetId": photos[0][0],
        "referenceKey": photos[0][1],
        "referenceContentType": "image/jpeg",
    }
    stored = store.get(pk(), f"TASK#{out['task']['taskId']}")
    assert stored is not None
    assert stored["override"] == {"model": "fable-5-2"}
    # "Make more": the same photos, with the looks already shown to avoid, and an explicit count
    status, out = call("POST", f"{BASE}/characters/design", {**body, "count": 3, "avoid": [CAR, CAR]})
    assert status == 202
    assert _task_input(store, out)["avoid"] == [CAR, CAR]


def test_the_old_single_picture_still_works(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ((asset_id, key),) = _photos(call, s3_client, 1)
    status, out = call("POST", f"{BASE}/characters/design", {"referenceAssetId": asset_id})
    assert status == 202
    assert _task_input(store, out) == {
        "kind": "person",
        "count": 1,
        "references": [{"assetId": asset_id, "key": key, "contentType": "image/jpeg"}],
        "referenceAssetId": asset_id,
        "referenceKey": key,
        "referenceContentType": "image/jpeg",
    }


def test_a_redesign_takes_the_saved_characters_kind(call: Call, store: db.Store) -> None:
    rosso = seed_character(store, name="Rosso", kind="car", car=CAR, look=None)
    pip = seed_character(store, name="Pip")
    status, out = call(
        "POST", f"{BASE}/characters/design", {"characterId": rosso["characterId"], "description": "blue"}
    )
    assert status == 202
    assert _task_input(store, out) == {
        "kind": "car",
        "count": 3,
        "description": "blue",
        "references": [],
        "characterId": rosso["characterId"],
    }
    status, out = call("POST", f"{BASE}/characters/design", {"characterId": pip["characterId"], "description": "a hat"})
    assert status == 202
    assert (_task_input(store, out)["kind"], _task_input(store, out)["count"]) == ("person", 1)
    status, body = call(
        "POST", f"{BASE}/characters/design", {"characterId": rosso["characterId"], "kind": "person", "description": "x"}
    )
    assert status == 400
    assert body["error"]["message"] == "Keep the same kind: this character is a car."


def test_design_refusals_start_no_task(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    photos = _photos(call, s3_client, 7)
    status, body = call(
        "POST", f"{BASE}/characters/design", {"kind": "car", "referenceAssetIds": [a for a, _ in photos]}
    )
    assert status == 400
    assert body["error"]["message"] == "Pick up to 6 photos."
    status, body = call("POST", f"{BASE}/characters/design", {"kind": "car"})
    assert status == 400
    assert body["error"]["message"] == "Add a photo of your car, or say what it is like."
    assert call("POST", f"{BASE}/characters/design", {"kind": "car", "description": "x", "count": 9})[0] == 400
    assert call("POST", f"{BASE}/characters/design", {"description": "x", "avoid": [CAR]})[0] == 400
    gone = "01J0000000000000000000000Q"
    status, body = call("POST", f"{BASE}/characters/design", {"characterId": gone, "description": "x"})
    assert status == 404
    assert body["error"]["message"] == "We could not find that character."
    assert store.query_all(pk(), "TASK#") == []


def test_a_photo_from_another_workspace_is_404(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    mine = _photos(call, s3_client, 2)
    other_key = "ws/99999999-8888-7777-6666-555555555555/stories/design/01J0000000000000000000000W.jpg"
    s3_client.objects[other_key] = b"jpeg"
    store.put(
        {
            "pk": pk("99999999-8888-7777-6666-555555555555"),
            "sk": "ASSET#01J0000000000000000000000W",
            "type": "ws_asset",
            "userId": "99999999-8888-7777-6666-555555555555",
            "workspaceId": "stories",
            "assetId": "01J0000000000000000000000W",
            "kind": "design_ref",
            "key": other_key,
            "contentType": "image/jpeg",
        }
    )
    ids = [mine[0][0], "01J0000000000000000000000W", mine[1][0]]
    status, body = call("POST", f"{BASE}/characters/design", {"kind": "car", "referenceAssetIds": ids})
    assert status == 404
    assert body["error"]["message"] == "We could not find that picture."
    assert store.query_all(pk(), "TASK#") == []
