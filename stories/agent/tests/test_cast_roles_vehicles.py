"""Main and villain, and up to 2 vehicles, in the writer's cast (docs/CONTRACTS.md §45.47): only the villain is marked,
each car of the cast says its vehicle and seats, the house rules for them are added only when the cast needs them,
and a story with no roles and no vehicles gets the brief and system text it always got, byte for byte."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from lamostories_agent import writer
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import Services, StoryJob
from ls_fakes import ENGINE_DIR, REPO, FakeTable, data, needs_deno
from test_series_context import CAR


def person(cid: str, name: str) -> dict[str, Any]:
    return {
        "characterId": cid,
        "name": name,
        "movementStyle": "bouncy",
        "voice": {"noises": ["gasp"], "sfx": []},
        "expressions": ["neutral", "happy"],
    }


def a_car(cid: str, name: str, body: str) -> dict[str, Any]:
    return {
        "characterId": cid,
        "name": name,
        "car": {**CAR, "body": body},
        "movementStyle": "zippy",
        "voice": {"style": "none", "noises": [], "sfx": ["engine"]},
        "expressions": ["neutral"],
    }


CAST = {"c1": person("C1", "Pip"), "c2": person("C2", "Grub")}
CHARS = {"C1": {"personality": "Curious."}, "C2": {"personality": "Grumpy.", "traits": ["sly"]}}
# The brief of two people exactly as it was before roles (§45.43), byte for byte.
BEFORE = (
    '[{"castId": "c1", "name": "Pip", "personality": "Curious.", "description": "", "traits": [], '
    '"movementStyle": "bouncy", "faces": ["neutral", "happy"], "noises": ["gasp"], "favouriteEffects": [], '
    '"kind": "person", "main": true}, {"castId": "c2", "name": "Grub", "personality": "Grumpy.", "description": "", '
    '"traits": ["sly"], "movementStyle": "bouncy", "faces": ["neutral", "happy"], "noises": ["gasp"], '
    '"favouriteEffects": [], "kind": "person", "main": false}]'
)


def test_no_roles_and_no_vehicles_is_byte_identical() -> None:
    for brief in (
        writer.cast_brief(CAST, CHARS),
        writer.cast_brief(CAST, CHARS, None, None),
        writer.cast_brief(CAST, CHARS, {}, {}),
        writer.cast_brief(CAST, CHARS, {}, {"mainId": "C1"}),  # a main that is already the first person
    ):
        assert json.dumps(brief) == BEFORE
        assert writer.cast_rules(brief) == ""
        assert writer.system_for("classic", brief) == writer.SYSTEM
        assert writer.system_for("night_drive", brief) == writer.SYSTEM + "\n\n" + writer.NIGHT_RULES
    assert writer.system_for(None) == writer.SYSTEM


def test_only_the_villain_is_marked() -> None:
    pip, grub = writer.cast_brief(CAST, CHARS, None, {"mainId": "C1", "villainId": "C2"})
    assert pip["main"] is True and "villain" not in pip
    assert grub["main"] is False and grub["villain"] is True
    assert list(grub)[-1] == "villain"  # added after every field it had, never in place of one
    # the villain is never the main one, and a villain who is not in the cast marks nobody
    for roles in ({"mainId": "C1", "villainId": "C1"}, {"mainId": "C1", "villainId": "C9"}, {"villainId": ""}):
        assert json.dumps(writer.cast_brief(CAST, CHARS, None, roles)) == BEFORE
    rules = writer.cast_rules([pip, grub])
    assert rules.startswith("House rules for this cast:\n") and writer.VILLAIN_RULE in rules
    assert writer.VEHICLE_RULE not in rules
    assert writer.system_for("classic", [pip, grub]) == writer.SYSTEM + "\n\n" + rules
    flat = " ".join(rules.split())
    assert "causes the trouble in the story and loses kindly at the end" in flat


def test_a_main_named_by_roles_is_the_main_one() -> None:
    pip, grub = writer.cast_brief(CAST, CHARS, None, {"mainId": "C2"})
    assert pip["main"] is False and grub["main"] is True


def test_two_vehicles_say_what_they_are_and_how_many_ride() -> None:
    cars = {"c3": a_car("C3", "Skye", "plane"), "c4": a_car("C4", "Rosso", "hatchback")}
    brief = writer.cast_brief(CAST, CHARS, cars, {"mainId": "C1", "villainId": "C2"})
    skye, rosso = brief[2], brief[3]
    assert (skye["kind"], skye["vehicle"], skye["seats"], skye["propOnly"]) == ("car", "plane", 2, True)
    assert (rosso["vehicle"], rosso["seats"]) == ("car", 2)
    assert skye["car"] == "a small red plane with round lights"
    assert list(skye)[-3:] == ["vehicle", "seats", "propOnly"]
    assert writer.cast_ids_of(brief) == (["c1", "c2"], ["c3", "c4"])
    rules = writer.cast_rules(brief)
    assert writer.VILLAIN_RULE in rules and writer.VEHICLE_RULE in rules and writer.TWO_VEHICLES_RULE in rules
    assert "A plane or a boat uses the sky or sea set while it moves" in " ".join(rules.split())
    one = writer.cast_rules(writer.cast_brief(CAST, CHARS, {"c3": cars["c3"]}))
    assert writer.VEHICLE_RULE in one and writer.TWO_VEHICLES_RULE not in one and writer.VILLAIN_RULE not in one
    # the night drive rules stay right after SYSTEM; the cast's come last
    night = writer.system_for("night_drive", brief)
    assert night == writer.SYSTEM + "\n\n" + writer.NIGHT_RULES + "\n\n" + rules


def job_with(story: dict[str, Any], characters: dict[str, Any], tmp_path: Path) -> StoryJob:
    d, _ = data(FakeTable())
    svc = Services(
        data=d, work_root=tmp_path, models=None, engine_dir=ENGINE_DIR, config_dir=REPO / "stories" / "config"
    )  # type: ignore[arg-type]
    job = StoryJob(svc, JobFence("u-1", "stories", "J1", "S1"), "ST1")
    job.story = story
    job.characters = characters
    return job


def test_the_cast_now_takes_two_vehicles_and_the_roles(tmp_path: Path) -> None:
    chars = {
        "P1": {"name": "Pip", "look": {"body": "bean"}, "movementStyle": "bouncy"},
        "P2": {"name": "Grub", "look": {"body": "bean"}, "movementStyle": "sneaky"},
        "V1": {"name": "Skye", "kind": "car", "car": {**CAR, "body": "plane"}, "movementStyle": "zippy"},
        "V2": {"name": "Bobby", "kind": "car", "car": {**CAR, "body": "boat"}, "movementStyle": "calm"},
    }
    roles = {"mainId": "P1", "villainId": "P2"}
    job = job_with({"characterIds": ["P1", "P2", "V1", "V2"], "roles": roles}, chars, tmp_path)
    cast, cars = job._cast_now()
    assert list(cast) == ["c1", "c2"] and list(cars) == ["c3", "c4"]
    assert [c["car"]["body"] for c in cars.values()] == ["plane", "boat"]
    assert job._roles() == roles
    brief = writer.cast_brief(cast, chars, cars, job._roles())
    assert [c.get("villain") for c in brief] == [None, True, None, None]
    assert [c.get("vehicle") for c in brief] == [None, None, "plane", "boat"]
    assert job_with({"characterIds": ["P1"]}, chars, tmp_path)._roles() is None
    assert job_with({"characterIds": ["P1"], "roles": {}}, chars, tmp_path)._roles() is None


@needs_deno
def test_the_writer_gets_the_villain_and_its_rule(tmp_path: Path) -> None:
    from ls_fakes import USER as JUSER
    from ls_fakes import WS as JWS
    from test_stories_pipeline import character, job_item, run_job, story_item, world

    roles = {"mainId": "ch1", "villainId": "ch2"}
    svc, _store, table, models = world(
        tmp_path,
        job=job_item("J1", "S1", run=["storyboard"]),
        story=story_item(characterIds=["ch1", "ch2"], roles=roles),
    )
    table.seed({**character("ch2"), "name": "Grub", "userId": JUSER, "workspaceId": JWS})
    run_job(svc)
    content = models.calls[0]["messages"][0]["content"]
    prompt = content[0]["text"]
    request = json.loads(content[1]["text"].split("\n", 1)[1])
    villain = [c for c in request["cast"] if c.get("villain")]
    assert [c["name"] for c in villain] == ["Grub"] and villain[0]["main"] is False
    assert writer.VILLAIN_RULE in prompt and prompt.startswith(writer.SYSTEM + "\n\n")
    # a story with no roles: no rule and no flag
    svc2, _s, _t, models2 = world(tmp_path / "plain", job=job_item("J1", "S1", run=["storyboard"]))
    run_job(svc2)
    content2 = models2.calls[0]["messages"][0]["content"]
    assert "House rules for this cast" not in content2[0]["text"]
    assert "villain" not in content2[1]["text"]
