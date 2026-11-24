"""The fact checker and a car of the cast (docs/CONTRACTS.md §45.42): a castId car's speed_up and stall are driving
items the checker reads, named by the car's own name; get_in and get_out are never driving actions."""

from __future__ import annotations

from typing import Any

from lamostories_agent import safety


def script() -> dict[str, Any]:
    return {
        "title": "My first car",
        "durationSec": 6,
        "cast": {"c1": {"name": "Pip"}},
        "cars": {"c2": {"name": "Rosso"}},
        "captions": [],
        "scenes": [
            {
                "sceneId": "s1",
                "title": "Off we go",
                "set": "road_day",
                "caption": None,
                "props": [
                    {"propId": "car1", "kind": "car", "castId": "c2"},
                    {"propId": "car2", "kind": "car"},
                    {"propId": "t1", "kind": "tree"},
                ],
                "beats": [
                    {"at": 0.2, "dur": 1.2, "who": "c1", "do": "get_in"},
                    {"at": 1.6, "dur": 1.0, "who": "car1", "do": "speed_up"},
                    {"at": 2.8, "dur": 0.6, "who": "car1", "do": "stall"},
                    {"at": 3.5, "dur": 0.5, "who": "car1", "do": "honk"},
                    {"at": 3.6, "dur": 1.0, "who": "car2", "do": "speed_up"},
                    {"at": 4.0, "dur": 1.0, "who": "t1", "do": "stall"},
                    {"at": 4.8, "dur": 1.0, "who": "c1", "do": "get_out"},
                    {"at": 5.0, "dur": 0.8, "who": "c1", "do": "drive"},
                ],
            }
        ],
    }


def test_speed_up_and_stall_are_driving_moves_and_get_in_is_not() -> None:
    assert {"speed_up", "stall"} <= safety.VEHICLE_ACTIONS
    assert {"move", "skid", "spin", "stop", "bump", "tyre_burst"} <= safety.VEHICLE_ACTIONS
    assert not {"get_in", "get_out"} & safety.DRIVING_ACTIONS
    assert not {"get_in", "get_out", "honk", "blink", "bounce"} & safety.VEHICLE_ACTIONS


def test_a_cast_car_s_speed_up_and_stall_are_items_with_its_own_name() -> None:
    items = safety.items(script(), None)
    beats = {i["ref"]: i for i in items if i["ref"].startswith("beat:")}
    # get_in, honk, a tree's "stall" and get_out are not driving items; the driver's drive is
    assert sorted(beats) == ["beat:s1:1", "beat:s1:2", "beat:s1:4", "beat:s1:7"]
    assert beats["beat:s1:1"]["action"] == "Rosso does speed up"
    assert beats["beat:s1:2"]["action"] == "Rosso does stall"
    assert beats["beat:s1:1"]["who"] == "car1" and beats["beat:s1:2"]["do"] == "stall"
    # a car prop that is not one of the cast keeps its kind for a name
    assert beats["beat:s1:4"]["action"] == "the car does speed up"
    assert beats["beat:s1:7"]["action"] == "Pip does drive"


def test_the_checker_request_carries_them_and_every_rule_stays() -> None:
    body = safety.request(script(), None, None)
    refs = {i["ref"] for i in body["items"]}
    assert {"beat:s1:1", "beat:s1:2"} <= refs and "beat:s1:0" not in refs
    assert "nothing dangerous" in body["note"]
    assert "anything shows a dangerous act as fun or as something to copy" in safety.CHECK_SYSTEM


def test_an_older_script_without_cars_reads_as_before() -> None:
    s = script()
    del s["cars"]
    beats = [i for i in safety.items(s, None) if i["ref"] == "beat:s1:1"]
    assert beats[0]["action"] == "the car does speed up"


def test_a_drivers_wave_is_an_item_and_a_passengers_is_not() -> None:
    s = script()
    s["cast"]["c3"] = {"name": "Bo"}
    scene = s["scenes"][0]
    scene["actors"] = [{"castId": "c1", "inCar": "car1"}, {"castId": "c3", "inCar": "car1"}]
    scene["beats"] = [
        {"at": 2.0, "dur": 1.0, "who": "car1", "do": "speed_up"},
        {"at": 2.2, "dur": 0.8, "who": "c1", "do": "wave"},
        {"at": 2.4, "dur": 0.8, "who": "c3", "do": "wave"},
    ]
    beats = {i["ref"]: i for i in safety.items(s, None) if i["ref"].startswith("beat:")}
    assert sorted(beats) == ["beat:s1:0", "beat:s1:1"]  # the passenger's wave is no driving item
    assert beats["beat:s1:1"]["action"] == "Pip does wave from the driver's seat"
    assert beats["beat:s1:1"]["at"] == 2.2 and beats["beat:s1:0"]["do"] == "speed_up"
