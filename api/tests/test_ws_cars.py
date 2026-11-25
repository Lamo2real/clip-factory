"""Car characters (docs/CONTRACTS.md §45.42, §45.43, §45.47): a car's own rules, up to 2 vehicles with someone to drive,
and Design with AI from up to 8 photos (outside and inside) with several options. A vehicle is still kind "car"."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.errors import ApiError
from clipfactory_api.workspaces import catalog, characters, design
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
    # §45.47: up to 2 vehicles, at least 1 person with any vehicle, at most 3 people
    assert characters.cast_problem([car, car]) == "Add someone to drive it."
    assert characters.cast_problem([person, car, car]) is None
    assert characters.cast_problem([person, person, person, car]) is None
    assert characters.cast_problem([person, car, car, car]) == "Pick up to 2 vehicles."
    assert characters.cast_problem([car, car, car]) == "Pick up to 2 vehicles."
    assert characters.cast_problem([person, person, person, person]) == "Pick up to 3 people."
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
        ({"referenceAssetIds": ULIDS[:7]}, 400, design.TOO_MANY_OUTSIDE),
        ({"referenceAssetId": ULIDS[0], "referenceAssetIds": ULIDS[1:7]}, 400, design.TOO_MANY_OUTSIDE),
        ({"referenceAssetIds": ULIDS[:9], "referenceSides": ["outside"] * 5 + ["inside"] * 4}, 400, design.TOO_MANY),
        (
            {"referenceAssetIds": ULIDS[:7], "referenceSides": ["outside"] * 2 + ["inside"] * 5},
            400,
            design.TOO_MANY_INSIDE,
        ),
        ({"referenceAssetIds": ULIDS[:2], "referenceSides": ["outside"]}, 400, design.NOT_SIDES),
        ({"referenceAssetIds": ULIDS[:1], "referenceSides": ["front"]}, 400, design.NOT_SIDES),
        ({"referenceAssetIds": ULIDS[:1], "referenceSides": "inside"}, 400, design.NOT_SIDES),
        ({"vehicle": "rocket"}, 400, design.NO_VEHICLE),
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
    with pytest.raises(ApiError, match=re.escape("Add a photo of your vehicle, or say what it is like.")):
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
    assert body["error"]["message"] == "Add a photo of your vehicle, or say what it is like."
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


# --- §45.47: vehicles (still kind "car"), inside colours, photo sides, a vehicle family ----------------------------


@pytest.mark.parametrize("body", ["bus", "motorbike", "plane", "boat", "pickup", "sedan"])
def test_every_vehicle_body_is_a_car_look(call: Call, body: str) -> None:
    status, out = call("POST", f"{BASE}/characters", car_body(f"V {body}", car={**CAR, "body": body}))
    assert status == 201, out
    assert (out["character"]["kind"], out["character"]["car"]["body"]) == ("car", body)
    assert characters.vehicle_of(out["character"]["car"]) == catalog.VEHICLE_OF[body]


def test_the_vehicle_families_cover_every_body() -> None:
    assert set(catalog.VEHICLE_OF) == set(catalog.CAR_BODIES)
    assert set(catalog.VEHICLE_OF.values()) == set(catalog.VEHICLE_TYPES)
    assert [b for b in catalog.CAR_BODIES if catalog.VEHICLE_OF[b] == "truck"] == ["pickup", "van"]
    assert characters.vehicle_of(None) == characters.vehicle_of({"body": "limo"}) == "car"


def test_a_vehicle_keeps_its_inside_colours(call: Call, store: db.Store) -> None:
    inside = {"seat": "#2B2B2B", "dash": "#111111", "trim": "#c0c0c0"}
    status, out = call("POST", f"{BASE}/characters", car_body(car={**CAR, "interior": inside}))
    assert status == 201
    assert out["character"]["car"]["interior"] == {"seat": "#2b2b2b", "dash": "#111111", "trim": "#c0c0c0"}
    status, out = call("POST", f"{BASE}/characters", car_body("Blue", car={**CAR, "interior": {"seat": "#000000",
                                                                                                "dash": "#ffffff"}}))  # fmt: skip
    assert status == 201
    assert out["character"]["car"]["interior"] == {"seat": "#000000", "dash": "#ffffff"}
    # left out: no interior key at all (older cars stay as they are)
    status, out = call("POST", f"{BASE}/characters", car_body("Green"))
    stored = store.get(pk(), f"CHAR#{out['character']['characterId']}")
    assert stored is not None
    assert "interior" not in stored["car"]


@pytest.mark.parametrize(
    "inside",
    [{"seat": "black", "dash": "#111111"}, {"seat": "#000000"}, {"seat": "#000000", "dash": "#111111", "roof": "#fff"}],
)
def test_bad_inside_colours_are_refused(call: Call, inside: dict[str, Any]) -> None:
    assert call("POST", f"{BASE}/characters", car_body(car={**CAR, "interior": inside}))[0] == 400


def test_parse_lines_up_the_photo_sides() -> None:
    ask = design.parse(
        {"referenceAssetId": ULIDS[0], "referenceAssetIds": [ULIDS[1], ULIDS[2], ULIDS[1]],
         "referenceSides": ["inside", "outside", "outside"], "vehicle": "plane"}
    )  # fmt: skip
    assert ask.asset_ids == [ULIDS[0], ULIDS[1], ULIDS[2]]
    assert ask.sides == ["outside", "inside", "outside"]  # the old single picture is outside; a repeat keeps its first
    assert ask.vehicle == "plane"
    assert design.parse({"referenceAssetIds": ULIDS[:2]}).sides is None
    eight = design.parse({"referenceAssetIds": ULIDS[:8], "referenceSides": ["outside"] * 6 + ["inside"] * 2})
    assert len(eight.asset_ids) == 8


def test_task_input_carries_the_sides_and_the_family() -> None:
    photos = [{"assetId": ULIDS[n], "key": f"ws/u/w/design/{n}.png", "contentType": "image/png"} for n in range(2)]
    ask = design.parse({"kind": "car", "referenceAssetIds": ULIDS[:2], "referenceSides": ["outside", "inside"],
                        "vehicle": "boat"})  # fmt: skip
    out = design.task_input(ask, photos, None)
    assert [r["side"] for r in out["references"]] == ["outside", "inside"]
    assert out["vehicle"] == "boat"
    # a car family is left out, as before; a redesign takes the saved vehicle's family
    assert "vehicle" not in design.task_input(design.parse({"kind": "car", "vehicle": "car", "description": "x"}), [],
                                              None)  # fmt: skip
    saved = {"characterId": ULIDS[9], "kind": "car", "car": {**CAR, "body": "motorbike"}}
    assert design.task_input(design.parse({"description": "red"}), [], saved)["vehicle"] == "motorbike"
    with pytest.raises(ApiError, match=re.escape(design.INSIDE_CARS)):
        design.task_input(design.parse({"referenceAssetIds": ULIDS[:1], "referenceSides": ["inside"]}), photos[:1],
                          None)  # fmt: skip
    with pytest.raises(ApiError, match=re.escape(design.VEHICLE_CARS)):
        design.task_input(design.parse({"description": "a cat", "vehicle": "plane"}), [], None)


def test_a_vehicle_from_8_photos_outside_and_inside(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    photos = _photos(call, s3_client, 8)
    sides = ["outside"] * 4 + ["inside"] * 4
    body = {"kind": "car", "vehicle": "bus", "referenceAssetIds": [a for a, _ in photos], "referenceSides": sides}
    status, out = call("POST", f"{BASE}/characters/design", body)
    assert status == 202, out
    stored = _task_input(store, out)
    assert stored["vehicle"] == "bus"
    assert stored["references"] == [
        {"assetId": a, "key": k, "contentType": "image/jpeg", "side": s}
        for (a, k), s in zip(photos, sides, strict=True)
    ]
    status, out = call("POST", f"{BASE}/characters/design", {**body, "referenceSides": ["outside"] * 8})
    assert (status, out["error"]["message"]) == (400, "Pick up to 6 photos.")


def test_a_story_has_up_to_2_vehicles_and_a_driver(call: Call, store: db.Store) -> None:
    pip = seed_character(store, name="Pip")
    rosso, blue, red = (
        seed_character(store, name=n, kind="car", car={**CAR, "body": b}, look=None)
        for n, b in (("Rosso", "plane"), ("Blue", "boat"), ("Red", "bus"))
    )
    brief = {"title": "Day one", "logline": "Pip flies and sails.", "category": "comedy"}
    two = [pip["characterId"], rosso["characterId"], blue["characterId"]]
    status, out = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": two})
    assert status == 201, out
    assert out["story"]["characterIds"] == two
    three = [*two, red["characterId"]]
    status, out = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": three})
    assert (status, out["error"]["message"], out["error"]["field"]) == (400, "Pick up to 2 vehicles.", "characterIds")
    status, out = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": two[1:]})
    assert (status, out["error"]["message"]) == (400, "Add someone to drive it.")


# --- car.detail (§45.48): the detailed look ----------------------------------------------------------------------------

_WEB_TEST = Path(__file__).resolve().parents[2] / "web" / "test"
_FIXTURE = json.loads((_WEB_TEST / "fixtures" / "car-detail-looks.json").read_text(encoding="utf-8"))
_RULES_FILE = Path(characters.__file__).with_name("car_detail.json")
_RULES = json.loads(_RULES_FILE.read_text(encoding="utf-8"))
_MAKES = (  # make and model names must never appear in the rules (nothing in this code may name a real brand)
    "ferrari", "lamborghini", "porsche", "mclaren", "bmw", "audi", "mercedes", "toyota", "honda", "ford", "chevrolet",
    "tesla", "nissan", "mazda", "jaguar", "bentley", "bugatti", "maserati", "aston", "lotus", "volkswagen", "volvo",
    "badge", "logo", "emblem",
)  # fmt: skip
_SPORTS_DETAIL = _FIXTURE["valid"][0]["detail"]


def _detailed(detail: Any) -> dict[str, Any]:
    return {**copy.deepcopy(CAR), "detail": detail}


def test_the_shared_fixture_valid_looks_are_accepted_and_round_trip_exactly() -> None:
    assert len(_FIXTURE["valid"]) >= 20
    for look in _FIXTURE["valid"]:
        out = characters.car_look(copy.deepcopy(look))
        assert out == look
        assert json.dumps(out) == json.dumps(look)  # byte for byte, key order too
        assert out is not look
        assert out.get("detail") is not look.get("detail") or "detail" not in look  # a copy


@pytest.mark.parametrize(
    "case", _FIXTURE["invalid"], ids=lambda c: f"{c['path'] or 'whole'}-{json.dumps(c['look'])[-40:]}"
)
def test_the_shared_fixture_invalid_looks_are_a_one_sentence_400(case: dict[str, Any]) -> None:
    with pytest.raises(ApiError) as err:
        characters.car_look(copy.deepcopy(case["look"]))
    assert err.value.status == 400
    message = err.value.message
    assert message.endswith(".")
    assert "\n" not in message
    assert "car.detail" in message


def test_a_look_without_detail_is_unchanged_and_detail_stays_absent(call: Call, store: db.Store) -> None:
    assert "detail" not in characters.car_look(copy.deepcopy(CAR))
    assert "detail" not in characters.car_look({**copy.deepcopy(CAR), "detail": None})  # null means none
    status, body = call("POST", f"{BASE}/characters", car_body())
    assert status == 201
    assert "detail" not in body["character"]["car"]
    stored = store.get(pk(), f"CHAR#{body['character']['characterId']}")
    assert stored is not None
    assert "detail" not in stored["car"]


def test_a_detailed_car_is_saved_returned_and_put_back_byte_for_byte(call: Call, store: db.Store) -> None:
    car = _detailed(copy.deepcopy(_SPORTS_DETAIL))
    status, body = call("POST", f"{BASE}/characters", car_body("Dart", car=car))
    assert status == 201, body
    saved = body["character"]
    assert json.dumps(saved["car"]["detail"]) == json.dumps(_SPORTS_DETAIL)
    stored = store.get(pk(), f"CHAR#{saved['characterId']}")
    assert stored is not None
    assert stored["car"]["detail"] == _SPORTS_DETAIL
    status, got = call("GET", f"{BASE}/characters/{saved['characterId']}")
    assert (status, got["character"]["car"]) == (200, car)
    # the saved look goes back through PUT unchanged
    put = {**car_body("Dart", car=got["character"]["car"]), "version": got["character"]["version"]}
    status, out = call("PUT", f"{BASE}/characters/{saved['characterId']}", put)
    assert status == 200, out
    assert out["character"]["car"] == car


def test_only_v_is_a_valid_detail_and_an_empty_part_is_kept() -> None:
    assert characters.car_look(_detailed({"v": 1}))["detail"] == {"v": 1}
    assert characters.car_look(_detailed({"v": 1, "roof": {}}))["detail"] == {"v": 1, "roof": {}}
    assert characters.car_look(_detailed({"v": 1.0}))["detail"] == {"v": 1}  # a whole number is a whole number


@pytest.mark.parametrize(
    ("detail", "sentence"),
    [
        ({"v": 1, "colour": "#ffffff"}, "Unknown field: car.detail.colour."),
        ({"v": 1, "roof": {"glow": True}}, "Unknown field: car.detail.roof.glow."),
        ({"v": 1, "profile": {"body": "sports", "extra": 1}}, "Unknown field: car.detail.profile.extra."),
        ({"v": 2}, "car.detail.v must be 1."),
        ({"v": True}, "car.detail.v must be 1."),
        ({}, "car.detail.v must be 1."),
        ("open", "car.detail must be an object."),
        (["v"], "car.detail must be an object."),
        ({"v": 1, "roof": "open"}, "car.detail.roof must be an object."),
        ({"v": 1, "toon": 30.5}, "car.detail.toon must be a whole number from 0 to 100."),
        ({"v": 1, "toon": True}, "car.detail.toon must be a whole number from 0 to 100."),
        ({"v": 1, "toon": float("nan")}, "car.detail.toon must be a whole number from 0 to 100."),
        ({"v": 1, "toon": None}, "car.detail.toon must be a whole number from 0 to 100."),
        ({"v": 1, "wheels": {"spokes": 25}}, "car.detail.wheels.spokes must be a whole number from 3 to 24."),
        ({"v": 1, "trim": "#ABCDEF"}, "car.detail.trim must be a colour like #ffc94a, in lower case."),
        ({"v": 1, "trim": "#abc"}, "car.detail.trim must be a colour like #ffc94a, in lower case."),
        ({"v": 1, "front": {"fog": "yes"}}, "car.detail.front.fog must be true or false."),
        ({"v": 1, "extras": ["antenna", "antenna"]}, "car.detail.extras has a repeat."),
        ({"v": 1, "extras": ["antenna", "bull_bar", "spare_wheel", "roof_rails", "shark_fin", "snorkel", "light_bar"]},
         "car.detail.extras can hold at most 6."),
        ({"v": 1, "profile": {"body": "sports"}}, "car.detail.profile needs all of its numbers."),
    ],
)  # fmt: skip
def test_bad_details_have_their_sentence(detail: Any, sentence: str) -> None:
    with pytest.raises(ApiError) as err:
        characters.car_look(_detailed(detail))
    assert (err.value.status, err.value.message) == (400, sentence)


def test_a_detail_can_be_too_long_and_a_choice_names_its_options() -> None:
    long = {
        "v": 1,
        "profile": _SPORTS_DETAIL["profile"],
        "extras": ["antenna", "bull_bar", "spare_wheel", "roof_rails"],
    }
    assert len(json.dumps(long, separators=(",", ":"))) < 2400
    with pytest.raises(ApiError) as err:
        characters.car_look(_detailed({**_SPORTS_DETAIL, "cabin": {"seat": "#101010"}, "x" * 3: 1}))
    assert err.value.message == "Unknown field: car.detail.xxx."
    with pytest.raises(ApiError) as err:
        characters.car_look(_detailed({"v": 1, "roof": {"type": "convertible"}}))
    assert err.value.message.startswith("car.detail.roof.type must be one of: closed, open,")


def test_a_car_save_refuses_a_bad_detail_with_the_field(call: Call) -> None:
    status, out = call("POST", f"{BASE}/characters", car_body(car=_detailed({"v": 1, "roof": {"glow": True}})))
    assert status == 400
    assert (out["error"]["message"], out["error"]["field"]) == (
        "Unknown field: car.detail.roof.glow.",
        "car.detail.roof.glow",
    )


def test_a_person_with_a_detail_is_still_refused(call: Call) -> None:
    status, _ = call("POST", f"{BASE}/characters", {**character_body("Pip"), "car": _detailed({"v": 1})})
    assert status == 400


def test_make_more_takes_detailed_looks_to_avoid_and_refuses_bad_ones(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    detailed = characters.car_look(_detailed(copy.deepcopy(_SPORTS_DETAIL)))
    ask = design.parse({"description": "x", "kind": "car", "avoid": [detailed, CAR]})
    assert ask.avoid == [detailed, CAR]
    with pytest.raises(ApiError) as err:
        design.parse({"description": "x", "kind": "car", "avoid": [_detailed({"v": 1, "toon": 101})]})
    assert err.value.status == 400
    photos = _photos(call, s3_client, 2)
    body = {"kind": "car", "referenceAssetIds": [a for a, _ in photos], "count": 3, "avoid": [detailed]}
    status, out = call("POST", f"{BASE}/characters/design", body)
    assert status == 202, out
    assert _task_input(store, out)["avoid"] == [detailed]
    status, out = call("POST", f"{BASE}/characters/design", {**body, "avoid": [_detailed({"v": 3})]})
    assert (status, out["error"]["message"]) == (400, "car.detail.v must be 1.")


# --- the generated rules file (car_detail.json) ------------------------------------------------------------------------


def test_the_rules_file_matches_the_python_constants_the_walker_uses() -> None:
    """The drift test: the web test writes the file from the engine; these constants and the walker must agree."""
    assert _RULES["v"] == characters.CAR_DETAIL_V == 1
    assert _RULES["maxChars"] == characters.CAR_DETAIL_MAX_CHARS == 2400
    assert tuple(_RULES["whole"]) == ("profile",)
    assert _RULES["rules"] == characters._DETAIL_RULES
    profile = [p for p in _RULES["rules"] if p.startswith("profile.")]
    assert len(profile) == 35
    assert _RULES["rules"]["extras"]["max"] == 6
    assert sorted(_RULES["rules"]["profile.body"]["e"]) == sorted(catalog.CAR_BODIES)  # the same twelve bodies


def test_every_rule_is_checkable_at_both_ends_of_its_range() -> None:
    base = _SPORTS_DETAIL
    for path, rule in _RULES["rules"].items():
        if "n" not in rule:
            continue
        lo, hi = rule["n"]
        for good in (lo, hi):
            detail = copy.deepcopy(base)
            target = detail
            *parents, leaf = path.split(".")
            for part in parents:
                target = target.setdefault(part, {})
            target[leaf] = good
            characters.car_look(_detailed(detail))
        for bad in (lo - 1, hi + 1):
            detail = copy.deepcopy(base)
            target = detail
            for part in parents:
                target = target.setdefault(part, {})
            target[leaf] = bad
            with pytest.raises(ApiError):
                characters.car_look(_detailed(detail))


def test_every_choice_says_what_it_draws_and_no_rule_names_a_brand() -> None:
    for path, rule in _RULES["rules"].items():
        ids = rule.get("e") or rule.get("l")
        if ids and path != "profile.body":
            assert set(rule["draws"]) == set(ids), path
            assert all(isinstance(t, str) and t.strip() for t in rule["draws"].values()), path
    text = json.dumps(_RULES).lower()
    assert [word for word in _MAKES if word in text] == []


def test_the_rules_file_ships_in_the_lambda_package() -> None:
    """build_lambda.py copies the whole clipfactory_api folder (only __pycache__ and compiled files are skipped), so the
    JSON next to characters.py is in the zip like ask/knowledge.json."""
    script = (Path(__file__).resolve().parents[1] / "scripts" / "build_lambda.py").read_text(encoding="utf-8")
    assert "shutil.copytree(PACKAGE" in script
    assert 'ignore_patterns("__pycache__", "*.pyc")' in script
    assert _RULES_FILE.parent == Path(characters.__file__).parent
