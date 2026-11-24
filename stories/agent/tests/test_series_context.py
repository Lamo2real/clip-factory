"""A series' bounded memory in the idea helper's and the story writer's prompts, and the cast fields for a person and
a car in one story (docs/CONTRACTS.md §45.43, §45.44).

The series context is at most 8000 bytes of JSON whatever the series holds: the story so far, the newest 5 episode
summaries and up to 20 earlier titles. Brainstorm in a series carries it with the SERIES block; the story writer's
request carries it as ``series``. A car of the cast is never an actor: the writer's schema reaches it only as a car
prop's ``castId``, and with no car the schema is what it always was.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from lamostories_agent import writer
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import Services, StoryJob
from lamostories_agent.series_memory import EARLIER_TITLES, LAST_EPISODES, MAX_BYTES, series_context
from lamostories_agent.tasks import ideas
from lamostories_agent.tasks.work import run_task
from ls_fakes import ENGINE_DIR, REPO, FakeTable, data, needs_deno
from ls_fakes import PK as JPK
from test_tasks_support import PK, USER, WS, FakeModel, character_item, idea_item, reply, services, task_item

CAR = {
    "body": "hatchback",
    "length": 0.9,
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


def a_series(**extra: Any) -> dict[str, Any]:
    return {
        "seriesId": "SR1",
        "name": "My first car",
        "line": "He buys a car and drives it",
        "castIds": ["C1", "C2"],
        "storySoFar": "",
        "summaries": [],
        **extra,
    }


def episode(n: int, **extra: Any) -> dict[str, Any]:
    return {
        "storyId": f"ST{n:03d}",
        "title": f"Episode {n}",
        "status": "approved",
        "seriesId": "SR1",
        "approvedAt": f"2026-11-{1 + n // 24:02d}T{n % 24:02d}:00:00.000Z",
        **extra,
    }


CHARS = {
    "C1": {"characterId": "C1", "name": "Pip", "kind": "person"},
    "C2": {"characterId": "C2", "name": "Rosso", "kind": "car", "car": CAR},
}


# --- the bounded context --------------------------------------------------------------------------------------------


def test_the_context_names_the_cast_the_next_episode_and_the_newest_five() -> None:
    stories = [episode(n) for n in range(1, 9)] + [{"storyId": "X", "title": "Elsewhere", "status": "approved"}]
    summaries = [
        {"storyId": f"ST{n:03d}", "summary": f"What happened in {n}.", "by": "ai", "at": "x"} for n in range(1, 9)
    ]
    found = series_context(
        a_series(storySoFar="Who: Pip.\nWhere things stand: home.", summaries=summaries), stories, [], CHARS
    )
    assert found["name"] == "My first car"
    assert found["about"] == "He buys a car and drives it"
    assert found["cast"] == [
        {"name": "Pip", "kind": "person", "main": True},
        {"name": "Rosso", "kind": "car", "car": "a small red hatchback with alloy wheels and round lights"},
    ]
    assert found["episode"] == 9
    assert found["storySoFar"] == "Who: Pip.\nWhere things stand: home."
    assert [e["n"] for e in found["lastEpisodes"]] == [4, 5, 6, 7, 8]
    assert found["lastEpisodes"][0] == {"n": 4, "title": "Episode 4", "summary": "What happened in 4."}
    assert found["earlierTitles"] == ["Episode 1", "Episode 2", "Episode 3"]


def test_a_story_that_is_an_episode_already_keeps_its_own_number() -> None:
    stories = [episode(n) for n in range(1, 4)]
    found = series_context(a_series(), stories, [], CHARS, this_story_id="ST002")
    assert found["episode"] == 2
    assert [e["title"] for e in found["lastEpisodes"]] == ["Episode 1"]
    fresh = series_context(a_series(), [], [], CHARS, this_story_id="NEW")
    assert fresh["episode"] == 1
    assert fresh["lastEpisodes"] == []


def test_the_series_ideas_are_titles_never_to_repeat() -> None:
    saved = [idea_item(f"I{n}", title=f"Idea {n}", seriesId="SR1") for n in range(3)]
    used = idea_item("U", title="Already made", seriesId="SR1", status="used")
    other = idea_item("O", title="Another series", seriesId="SR9")
    found = series_context(a_series(), [], [*saved, used, other], CHARS)
    assert found["earlierTitles"] == ["Idea 0", "Idea 1", "Idea 2"]


def test_the_context_stays_small_whatever_the_series_holds() -> None:
    big = "ð" * 400  # two bytes a letter
    stories = [episode(n, title="Ŧ" * 80) for n in range(1, 60)]
    summaries = [{"storyId": f"ST{n:03d}", "summary": big, "by": "ai", "at": "x"} for n in range(1, 60)]
    ideas_ = [idea_item(f"I{n}", title=f"{'Ж' * 70} {n}", seriesId="SR1") for n in range(40)]
    found = series_context(
        a_series(name="Ŋ" * 40, line="Ŋ" * 120, storySoFar="Ŧ" * 1500, summaries=summaries), stories, ideas_, CHARS
    )
    assert len(json.dumps(found, ensure_ascii=False, separators=(",", ":")).encode()) <= MAX_BYTES
    assert len(found["lastEpisodes"]) <= LAST_EPISODES
    assert len(found["earlierTitles"]) <= EARLIER_TITLES
    assert found["episode"] == 60
    assert found["lastEpisodes"]  # the newest episode always stays
    assert all(len(e["summary"] or "") <= 400 for e in found["lastEpisodes"])


# --- the idea helper ------------------------------------------------------------------------------------------------


def series_record(**extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": "SERIES#SR1",
        "type": "ws_series",
        "userId": USER,
        "workspaceId": WS,
        **a_series(**extra),
        "version": 1,
    }


def test_brainstorm_in_a_series_gets_its_memory_and_the_series_block(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            data={
                "ideas": [
                    {
                        "title": "Stalled",
                        "logline": "Pip stalls Rosso.",
                        "category": "comedy",
                        "topicId": "",
                        "characters": ["Pip", "Rosso"],
                    }
                ]
            }
        )
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C0", "Bo"))
    db.seed(character_item("C1", "Pip"))
    db.seed(character_item("C2", "Rosso", kind="car", car=CAR))
    db.seed(series_record(storySoFar="Who: Pip and Rosso."))
    db.seed({"pk": PK, "sk": "STORY#ST001", "type": "ws_story", "userId": USER, "workspaceId": WS, **episode(1)})
    db.seed(task_item("T1", "brainstorm", input={"count": 1, "seriesId": "SR1"}))
    assert asyncio.run(run_task(svc, {"userId": USER, "workspaceId": WS, "taskId": "T1"})) == "done"
    text = model.texts(0)
    assert ideas.SERIES_BLOCK in text
    assert "8. A car never stars alone: name the person who drives it too." in text
    data_ = json.loads(text.split("DATA as JSON:\n", 1)[1])
    assert data_["series"]["episode"] == 2
    assert data_["series"]["storySoFar"] == "Who: Pip and Rosso."
    assert data_["series"]["lastEpisodes"] == [{"n": 1, "title": "Episode 1", "summary": None}]
    # the series cast first, the main person before the car
    assert [(c["name"], c["kind"]) for c in data_["characters"]] == [
        ("Pip", "person"),
        ("Rosso", "car"),
        ("Bo", "person"),
    ]
    assert data_["characters"][1]["car"].startswith("a small red hatchback")


def test_brainstorm_with_no_series_has_no_series_block(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            data={
                "ideas": [
                    {
                        "title": "Toast",
                        "logline": "Bo burns toast.",
                        "category": "comedy",
                        "topicId": "",
                        "characters": [],
                    }
                ]
            }
        )
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C0", "Bo"))
    db.seed(task_item("T1", "brainstorm", input={"count": 1, "seriesId": "GONE"}))
    assert asyncio.run(run_task(svc, {"userId": USER, "workspaceId": WS, "taskId": "T1"})) == "done"
    text = model.texts(0)
    assert ideas.SERIES_BLOCK not in text
    assert "series" not in json.loads(text.split("DATA as JSON:\n", 1)[1])


# --- the writer -----------------------------------------------------------------------------------------------------


def test_the_writer_is_told_about_cars_and_series_in_new_lines_only() -> None:
    flat = " ".join(writer.SYSTEM.split())
    for line in (
        'A cast member with kind "car" is a car, never an actor: put it in a scene\'s props as {kind: "car", castId}',
        "give them inCar and a get_in or get_out beat while the car is parked; the car moves only after get_in ends.",
        "The driver waves only while the car is stopped; a passenger may wave any time.",
        "a car may stall, stop or bump for fun, but no caption gives driving advice; if the story starts to teach it, "
        "set teachesSafety to true (see above). A story with a car of the cast is always fact checked for driving advice.",
        "There is no car dealer set: a story about buying a car stages the sale in the car park (parking_lot).",
        "When the request has a series, this video is its episode number `series.episode`",
    ):
        assert line in flat, line
    # never told to keep the flag false: that went against the rule that a story which starts teaching flags it
    assert "teachesSafety stays false" not in flat
    assert "If a story of another kind starts to teach driving safety, set teachesSafety to true" in flat
    # the earlier rules are all still there, word for word
    assert "Recurring characters: use only the cast you are given, by cast id." in flat
    assert "never copy their characters, logos, footage, music or catchphrases." in flat


CATALOG = {
    "actions": [{"id": "wave"}, {"id": "get_in"}],
    "propActions": [{"id": "move"}, {"id": "honk"}],
    "props": [{"id": "car"}, {"id": "truck"}],
    "sets": [{"id": "road_day"}],
    "cameras": [{"id": "wide"}],
}


def test_the_scene_schema_reaches_a_car_only_as_a_car_props_cast_id() -> None:
    plain = writer.scene_schema(CATALOG, ["c1"])
    assert json.dumps(plain, sort_keys=True) == json.dumps(
        writer.scene_schema(CATALOG, ["c1"], None, ()), sort_keys=True
    )
    prop = plain["properties"]["props"]["items"]["properties"]
    assert "castId" not in prop
    with_car = writer.scene_schema(CATALOG, ["c1"], car_ids=["c2"])
    assert with_car["properties"]["actors"]["items"]["properties"]["castId"]["enum"] == ["c1"]
    assert with_car["properties"]["props"]["items"]["properties"]["castId"] == {
        "type": ["string", "null"],
        "enum": ["c2", None],
        "description": "A car of the cast, on kind car only.",
    }
    board = writer.storyboard_schema(CATALOG, ["c1"], [], mode="full", car_ids=["c2"])
    assert board["properties"]["scenes"]["items"]["properties"]["props"]["items"]["properties"]["castId"]["enum"] == [
        "c2",
        None,
    ]


def test_the_cast_brief_says_who_is_main_and_describes_the_car_in_words() -> None:
    cast = {
        "c1": {
            "characterId": "C1",
            "name": "Pip",
            "movementStyle": "bouncy",
            "voice": {"noises": ["gasp"], "sfx": []},
            "expressions": ["neutral", "happy"],
        }
    }
    cars = {
        "c2": {
            "characterId": "C2",
            "name": "Rosso",
            "car": CAR,
            "movementStyle": "zippy",
            "voice": {"style": "none", "noises": [], "sfx": ["engine", "honk"]},
            "expressions": ["neutral"],
        }
    }
    chars = {
        "C1": {"personality": "Curious."},
        "C2": {"personality": "Brand new.", "description": "A red hatchback.", "traits": ["shiny"]},
    }
    pip, rosso = writer.cast_brief(cast, chars, cars)
    assert pip["kind"] == "person"
    assert pip["main"] is True
    assert rosso == {
        "castId": "c2",
        "name": "Rosso",
        "kind": "car",
        "main": False,
        "personality": "Brand new.",
        "description": "A red hatchback.",
        "traits": ["shiny"],
        "movementStyle": "zippy",
        "faces": ["neutral"],
        "favouriteEffects": ["engine", "honk"],
        "car": "a small red hatchback with alloy wheels and round lights",
        "vehicle": "car",
        "seats": 2,
        "propOnly": True,
    }
    assert "look" not in json.dumps([pip, rosso]) and "#d8352a" not in json.dumps([pip, rosso])
    assert writer.cast_ids_of([pip, rosso]) == (["c1"], ["c2"])
    script = writer.script_from(
        {"scenes": []},
        title="t",
        engine_version=6,
        seed=1,
        cast=cast,
        captions_on=False,
        music=None,
        topic=None,
        cars=cars,
    )
    assert script["cars"] == cars
    assert "cars" not in writer.script_from(
        {"scenes": []}, title="t", engine_version=6, seed=1, cast=cast, captions_on=False, music=None, topic=None
    )


def test_the_cast_now_puts_a_car_in_cars_never_in_the_cast(tmp_path: Path) -> None:
    d, _ = data(FakeTable())
    svc = Services(
        data=d, work_root=tmp_path, models=None, engine_dir=ENGINE_DIR, config_dir=REPO / "stories" / "config"
    )  # type: ignore[arg-type]
    job = StoryJob(svc, JobFence("u-1", "stories", "J1", "S1"), "ST1")
    job.story = {"characterIds": ["C1", "C2"]}
    job.characters = {
        "C1": {
            "name": "Pip",
            "look": {"body": "bean"},
            "movementStyle": "bouncy",
            "voice": {"style": "babble", "pitch": 1, "noises": [], "sfx": []},
            "expressions": ["neutral", "happy", "surprised"],
        },
        "C2": {
            "name": "Rosso",
            "kind": "car",
            "car": CAR,
            "look": None,
            "movementStyle": "zippy",
            "voice": {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine"]},
            "expressions": ["neutral"],
        },
    }
    cast, cars = job._cast_now()
    assert list(cast) == ["c1"]
    assert cast["c1"]["name"] == "Pip"
    assert cars == {
        "c2": {
            "characterId": "C2",
            "name": "Rosso",
            "car": CAR,
            "movementStyle": "zippy",
            "voice": {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine"]},
            "expressions": ["neutral"],
        }
    }


@needs_deno
def test_the_writer_request_has_the_series(tmp_path: Path) -> None:
    from ls_fakes import USER as JUSER
    from ls_fakes import WS as JWS
    from test_stories_pipeline import job_item, run_job, story_item, world

    svc, _store, table, models = world(
        tmp_path, job=job_item("J1", "S1", run=["storyboard"]), story=story_item(seriesId="SR1")
    )
    table.seed(
        {
            "pk": JPK,
            "sk": "SERIES#SR1",
            "type": "ws_series",
            "userId": JUSER,
            "workspaceId": JWS,
            **a_series(castIds=["ch1"], storySoFar="Who: Lamo."),
            "version": 1,
        }
    )
    table.seed(
        {
            "pk": JPK,
            "sk": "STORY#EP1",
            "type": "ws_story",
            "userId": JUSER,
            "workspaceId": JWS,
            **episode(1, storyId="EP1"),
        }
    )
    assert run_job(svc) == "ready"
    first = models.calls[0]["messages"][0]["content"]
    request = json.loads(first[1]["text"].split("\n", 1)[1])
    assert request["series"]["name"] == "My first car"
    assert request["series"]["episode"] == 2
    assert request["series"]["storySoFar"] == "Who: Lamo."
    assert request["series"]["lastEpisodes"] == [{"n": 1, "title": "Episode 1", "summary": None}]
    # a story in no series sends none
    svc2, _s, _t, models2 = world(tmp_path / "plain", job=job_item("J1", "S1", run=["storyboard"]))
    assert run_job(svc2) == "ready"
    plain = json.loads(models2.calls[0]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert "series" not in plain
