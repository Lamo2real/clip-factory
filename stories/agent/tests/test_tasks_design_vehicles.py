"""Vehicles from outside and inside photos (docs/CONTRACTS.md §45.47): each photo is labelled with its side, the
inside photos set only ``car.interior``, a picked kind of vehicle limits the body to its family, up to 8 photos, and a
design with neither is the request it always was."""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import vehicles
from lamostories_agent.tasks import design
from lamostories_agent.tasks.catalog import engine_catalog, ids
from lamostories_agent.tasks.characters import car_schema, car_words, check_car
from lamostories_agent.tasks.work import run_task
from test_tasks_design_cars import CAR, SizedImages, a_car, answer, car_task, data_of, seed_photos
from test_tasks_support import PK, USER, WS, FakeModel, character_item, services, task_item

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}
NEW_BODIES = ("bus", "motorbike", "plane", "boat")
INSIDE = {"seat": "#2a2a30", "dash": "#18181c", "trim": "#c9ccd2"}


def with_vehicles() -> dict[str, Any]:
    """The engine's catalog with the four new bodies (the engine adds them in the same change; added here when this
    engine has not got them yet, so these tests do not wait on it)."""
    cat = copy.deepcopy(engine_catalog())
    body = cat["catalog"]["carLooks"]["body"]
    have = {e["id"] for e in body}
    body += [{"id": b, "label": b.title()} for b in NEW_BODIES if b not in have]
    return cat


def run(svc: Any) -> str:
    return asyncio.run(run_task(svc, PAYLOAD))


def vehicle_services(tmp_path: Path, model: FakeModel, images: Any = None) -> tuple[Any, Any, Any]:
    svc, db, s3 = services(tmp_path, model, images=images)
    svc.catalog = with_vehicles
    return svc, db, s3


def sided_task(asset_ids: list[str], sides: list[str], **extra: Any) -> dict[str, Any]:
    item = car_task(asset_ids, **extra)
    for ref, side in zip(item["input"]["references"], sides, strict=True):
        ref["side"] = side
    return item


def texts(model: FakeModel, n: int = 0) -> list[str]:
    return [b["text"] for b in model.calls[n]["messages"][0]["content"] if "text" in b]


def body_enum(model: FakeModel, n: int = 0) -> list[str]:
    schema = model.calls[n]["schema"]["properties"]["variants"]["items"]
    return list(schema["properties"]["car"]["properties"]["body"]["enum"])


def car_props(model: FakeModel, n: int = 0) -> dict[str, Any]:
    props: dict[str, Any] = model.calls[n]["schema"]["properties"]["variants"]["items"]["properties"]["car"]
    return props


# --- the family table -------------------------------------------------------------------------------------------


def test_the_family_table_matches_the_engines() -> None:
    engine = (Path(__file__).resolve().parents[3] / "web/src/stories/engine/types.ts").read_text("utf-8")
    table = engine.split("export const VEHICLE_OF", 1)[1].split("};", 1)[0]
    for body, family in vehicles.VEHICLE_OF.items():
        assert f'{body}: "{family}"' in table
    assert set(vehicles.VEHICLE_OF.values()) == set(vehicles.VEHICLE_TYPES)
    assert vehicles.vehicle_of({"body": "plane"}) == "plane" and vehicles.vehicle_of({"body": "??"}) == "car"
    assert vehicles.vehicle_of(None) == "car" and vehicles.seats_of({"body": "bus"}) == 2
    assert vehicles.bodies_for(["hatchback", "pickup", "plane"], ["truck"]) == ["pickup"]
    assert vehicles.bodies_for(["hatchback"], ["boat"]) == ["hatchback"]  # an engine without boats: every body


def test_a_plane_and_a_boat_are_told_in_words_without_wheels() -> None:
    assert car_words({**CAR, "body": "plane", "length": 0.9}) == "a small red plane with round lights"
    assert car_words({**CAR, "body": "boat", "length": 1}) == "a red boat with round lights"
    assert car_words({**CAR, "body": "bus", "length": 1}) == "a red bus with alloy wheels and round lights"
    assert car_words({**CAR, "body": "motorbike"}) == "a red motorbike with alloy wheels and round lights"


# --- the schema and the check -----------------------------------------------------------------------------------


def test_the_schema_is_unchanged_without_a_family_or_an_inside() -> None:
    cat = with_vehicles()
    plain = car_schema(cat)
    assert plain == car_schema(cat, bodies=None, interior=False)
    assert "interior" not in plain["properties"]["car"]["properties"]
    planes = car_schema(cat, bodies=["plane"], interior=True)["properties"]["car"]
    assert planes["properties"]["body"]["enum"] == ["plane"]
    assert "interior" in planes["required"]
    inside = planes["properties"]["interior"]
    assert inside["type"] == ["object", "null"] and inside["required"] == ["seat", "dash", "trim"]


def test_check_car_keeps_the_inside_only_when_asked_and_limits_the_body() -> None:
    cat = with_vehicles()
    raw = a_car()
    raw["car"]["interior"] = dict(INSIDE)
    value, problems = check_car(raw, cat)
    assert problems == [] and value is not None and "interior" not in value["car"]  # no inside photo: dropped
    value, problems = check_car(raw, cat, interior=True)
    assert problems == [] and value is not None and value["car"]["interior"] == INSIDE
    raw["car"]["interior"] = {"seat": "#2A2A30", "dash": "#18181c", "trim": None}
    value, _ = check_car(raw, cat, interior=True)
    assert value is not None and value["car"]["interior"] == {"seat": "#2a2a30", "dash": "#18181c"}
    raw["car"]["interior"] = None
    value, _ = check_car(raw, cat, interior=True)
    assert value is not None and "interior" not in value["car"]
    raw["car"]["interior"] = {"seat": "grey", "dash": "#18181c", "trim": None}
    value, problems = check_car(raw, cat, interior=True)
    assert value is None and any("car.interior.seat" in p for p in problems)
    # a hatchback is not a plane
    value, problems = check_car(a_car(), cat, bodies=["plane"])
    assert value is None and any("car.body must be one of: plane" in p for p in problems)
    plane = a_car()
    plane["car"]["body"] = "plane"
    assert check_car(plane, cat, bodies=["plane"])[0] is not None


# --- the task ---------------------------------------------------------------------------------------------------


def test_outside_and_inside_photos_are_labelled_and_the_inside_sets_the_interior(tmp_path: Path) -> None:
    inside = a_car("Rosso")
    inside["car"]["interior"] = dict(INSIDE)
    model = FakeModel(answer(inside, a_car("Ruby"), a_car("Rocket")))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(sided_task(seed_photos(db, s3, 3), ["outside", "inside", "outside"], vehicle="car"))
    assert run(svc) == "done"
    said = texts(model)
    labels = [t for t in said if t.startswith("Photo ")]
    assert labels == ["Photo 1 of 3 (outside):", "Photo 2 of 3 (inside):", "Photo 3 of 3 (outside):"]
    assert design.SIDES_BRIEF in said
    assert said[0] == design.CAR_BRIEF.format(count=3)  # the old lines stay word for word, first
    assert "The owner says this vehicle is a car. Pick car.body only from:" in " ".join(said)
    assert "they mean this" not in " ".join(said)
    assert set(body_enum(model)) == {"hatchback", "sedan", "estate", "suv", "sports", "compact"}
    assert "interior" in car_props(model)["required"]
    result = db.get(PK, "TASK#T1")["result"]
    assert result["characters"][0]["car"]["interior"] == INSIDE
    assert "interior" not in result["characters"][1]["car"]


def test_the_sides_may_come_as_a_list_next_to_the_references(tmp_path: Path) -> None:
    model = FakeModel(answer(a_car("Rosso")))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 2), count=1, referenceSides=["inside", "outside"]))
    assert run(svc) == "done"
    assert [t for t in texts(model) if t.startswith("Photo ")] == ["Photo 1 of 2 (inside):", "Photo 2 of 2 (outside):"]


def test_only_outside_photos_ask_for_no_interior(tmp_path: Path) -> None:
    model = FakeModel(answer(a_car("Rosso")))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(sided_task(seed_photos(db, s3, 2), ["outside", "outside"], count=1))
    assert run(svc) == "done"
    assert "interior" not in car_props(model)["properties"]
    assert design.SIDES_BRIEF in texts(model)


def test_a_plane_may_only_be_a_plane(tmp_path: Path) -> None:
    plane = a_car("Skye")
    plane["car"]["body"] = "plane"
    model = FakeModel(answer(a_car("Rosso")), answer(plane))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 1), count=1, vehicle="plane"))
    assert run(svc) == "done"
    assert body_enum(model) == ["plane"]
    said = " ".join(texts(model))
    assert 'The owner says this vehicle is a plane (where the lines above say "car", they mean this plane).' in said
    assert "Pick car.body only from: plane." in said
    assert [e["id"] for e in json.loads(said.split("DATA as JSON:\n", 1)[1])["catalog"]["carLooks"]["body"]] == [
        "plane"
    ]
    assert len(model.calls) == 2 and "car.body must be one of: plane" in model.texts(1)
    assert db.get(PK, "TASK#T1")["result"]["character"]["car"]["body"] == "plane"


def test_no_kind_and_no_sides_is_the_request_it_always_was(tmp_path: Path) -> None:
    model = FakeModel(answer(a_car("Rosso"), a_car("Ruby"), a_car("Rocket")))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 2)))
    assert run(svc) == "done"
    said = texts(model)
    assert [t for t in said if t.startswith("Photo ")] == ["Photo 1 of 2:", "Photo 2 of 2:"]
    assert design.SIDES_BRIEF not in said and not any("The owner says this vehicle" in t for t in said)
    assert body_enum(model) == [b for b in ids(engine_catalog(), "carLooks", "body") if b not in NEW_BODIES]
    assert "interior" not in car_props(model)["properties"]


def test_a_saved_boat_is_redesigned_as_a_boat_and_keeps_its_inside(tmp_path: Path) -> None:
    boat = a_car("Bobby")
    boat["car"]["body"] = "boat"
    boat["car"]["interior"] = dict(INSIDE)
    model = FakeModel(answer(boat))
    svc, db, _ = vehicle_services(tmp_path, model)
    db.seed({**character_item("C9", "Bobby"), "kind": "car", "car": boat["car"], "look": None})
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 1, "characterId": "C9",
                                                         "description": "make it blue"}))  # fmt: skip
    assert run(svc) == "done"
    assert body_enum(model) == ["boat"]
    assert "interior" in car_props(model)["properties"]  # the saved inside is kept, not dropped
    assert db.get(PK, "TASK#T1")["result"]["character"]["car"]["interior"] == INSIDE


def test_eight_photos_are_sent_and_a_ninth_is_not(tmp_path: Path) -> None:
    model = FakeModel(answer(a_car("Rosso")))
    images = SizedImages()
    svc, db, s3 = vehicle_services(tmp_path, model, images)
    sides = ["outside"] * 6 + ["inside"] * 3
    db.seed(sided_task(seed_photos(db, s3, 9), sides, count=1))
    assert design.MAX_PHOTOS == 8
    assert run(svc) == "done"
    labels = [t for t in texts(model) if t.startswith("Photo ")]
    assert len(labels) == 8 and labels[-1] == "Photo 8 of 8 (inside):"
    assert [edge for _, edge in images.calls] == [1280] * 8  # five or more photos: 1280 px (§45.48)


@pytest.mark.parametrize("bad", ["sideways", None, 3])
def test_an_unknown_side_counts_as_outside(tmp_path: Path, bad: Any) -> None:
    model = FakeModel(answer(a_car("Rosso")))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(sided_task(seed_photos(db, s3, 2), ["inside", bad], count=1))
    assert run(svc) == "done"
    assert [t for t in texts(model) if t.startswith("Photo ")] == ["Photo 1 of 2 (inside):", "Photo 2 of 2 (outside):"]


# --- likeness by family (docs/CONTRACTS.md §45.48) ----------------------------------------------------------------


def detail_props(model: FakeModel, n: int = 0) -> dict[str, Any]:
    props: dict[str, Any] = car_props(model, n)["properties"]["detail"]["properties"]
    return props


@pytest.mark.parametrize("vehicle", ["motorbike", "plane", "boat"])
def test_a_bike_plane_or_boat_has_parts_but_no_outline_in_its_schema_brief_and_data(
    tmp_path: Path, vehicle: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(design, "character_errors", lambda value: [])
    answer_car = a_car("Rosso")
    answer_car["car"]["body"] = vehicle
    model = FakeModel(answer(answer_car))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 1), count=1, vehicle=vehicle))
    assert run(svc) == "done"
    props = detail_props(model)
    assert "profile" not in props and "toon" not in props
    assert {"wheels", "lights", "stripe", "finish", "extras"} <= set(props)
    blocks = texts(model)
    assert design.DETAIL_PARTS_BRIEF in blocks and design.DETAIL_BRIEF not in blocks
    assert "no measured outline" not in " ".join(blocks)
    detail = data_of(model)["detail"]
    assert set(detail) == {"rules"} and not any(p.split(".")[0] in ("profile", "toon") for p in detail["rules"])
    assert "study" in model.calls[0]["schema"]["properties"]


@pytest.mark.parametrize(
    ("vehicle", "bodies"),
    [
        ("truck", {"pickup", "van"}),
        ("bus", {"bus"}),
        ("car", {"hatchback", "sedan", "estate", "suv", "sports", "compact"}),
    ],
)
def test_a_car_truck_or_bus_has_an_outline_in_its_schema_brief_and_data(
    tmp_path: Path, vehicle: str, bodies: set[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(design, "character_errors", lambda value: [])
    chosen = sorted(bodies)[0]
    answer_car = a_car("Rosso")
    answer_car["car"]["body"] = chosen
    model = FakeModel(answer(answer_car))
    svc, db, s3 = vehicle_services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 1), count=1, vehicle=vehicle))
    assert run(svc) == "done"
    props = detail_props(model)
    assert len(props["profile"]["properties"]) == 35 and "toon" in props
    assert design.DETAIL_BRIEF in texts(model) and design.DETAIL_PARTS_BRIEF not in texts(model)
    detail = data_of(model)["detail"]
    assert set(detail["preset"]) == bodies and len(detail["examples"]) == 4


def test_a_plane_or_boat_loses_a_profile_the_model_gave_it_and_keeps_its_parts() -> None:
    cat = with_vehicles()
    for body in ("plane", "boat", "motorbike"):
        raw = a_car()
        raw["car"].update({"body": body, "length": 0.9})
        raw["car"]["detail"] = {"v": 1, "toon": 40, "profile": dict(design.DETAIL_EXAMPLES[0]["profile"]),
                                "stripe": {"layout": "centre", "color": "#111111"}, "finish": "satin"}  # fmt: skip
        value, problems = check_car(raw, cat, bodies=[body])
        assert problems == [] and value is not None
        assert value["car"]["detail"] == {"v": 1, "stripe": {"layout": "centre", "color": "#111111"}, "finish": "satin"}
        assert value["car"]["length"] == 0.9  # no outline: the sliders are the answer's own
