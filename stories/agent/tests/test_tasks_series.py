"""The story so far of a series: the recap task after an approval (docs/CONTRACTS.md §45.43, ADR-90).

The creative director reads the series and the approved episode and writes the episode's summary and the whole story
so far, on the owner's "Small text edits" model (the task ``text_edit``). The SERIES# item is written with the task's
end, under the version that was read; a series changed meanwhile is read again and written once more, and changed
twice it fails the task with "Write it again".
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from lamostories_agent.tasks import series as recap_task
from lamostories_agent.tasks.work import FAILURE, GONE, KIND_AGENT, handlers, run_task
from test_tasks_support import PK, USER, WS, FakeModel, character_item, reply, services, task_item

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}
SCRIPT_KEY = f"ws/{USER}/{WS}/stories/ST1/script/v1.json"
SO_FAR = "Who: Pip and Rosso.\nPlaces: the car park.\nRunning jokes: Pip forgets where Rosso is.\nWhere things stand: Pip bought Rosso."


def series_item(**extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": "SERIES#SR1",
        "type": "ws_series",
        "userId": USER,
        "workspaceId": WS,
        "seriesId": "SR1",
        "name": "My first car",
        "line": "He buys a car and drives it",
        "castIds": ["C1", "C2"],
        "cover": None,
        "storySoFar": "",
        "storySoFarBy": None,
        "storySoFarAt": None,
        "summaries": [],
        "recapTaskId": "T1",
        "version": 3,
        "createdAt": "2026-11-21T18:00:00.000Z",
        "updatedAt": "2026-11-21T18:00:00.000Z",
        **extra,
    }


def story_item(story_id: str = "ST1", **extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"STORY#{story_id}",
        "type": "ws_story",
        "userId": USER,
        "workspaceId": WS,
        "storyId": story_id,
        "title": "The new car",
        "status": "approved",
        "approvedAt": "2026-11-21T19:00:00.000Z",
        "category": "comedy",
        "seriesId": "SR1",
        "scriptKey": SCRIPT_KEY if story_id == "ST1" else None,
        "postCaptions": {},
        **extra,
    }


SCRIPT = {
    "title": "The new car",
    "width": 1080,
    "height": 1920,
    "durationSec": 12,
    "cast": {"c1": {"name": "Pip"}},
    "cars": {"c2": {"name": "Rosso", "car": {"body": "hatchback"}}},
    "scenes": [
        {"title": "The new car", "caption": None, "beats": [{"who": "c1", "do": "wave", "face": "happy"}]},
        {"title": "Oops", "caption": "Oops!", "beats": [{"who": "car", "do": "stall"}]},
    ],
    "captions": [{"text": "Oops!"}],
}


def world(tmp_path: Path, model: FakeModel, *, series: dict[str, Any] | None = None):
    svc, db, s3 = services(tmp_path, model)
    db.seed(character_item("C1", "Pip"))
    db.seed(character_item("C2", "Rosso", kind="car"))
    db.seed(series or series_item())
    db.seed(story_item("ST0", title="Buying day", approvedAt="2026-11-20T10:00:00.000Z"))
    db.seed(story_item())
    db.seed(task_item("T1", "series_recap", input={"seriesId": "SR1", "storyId": "ST1"}))
    s3.objects[SCRIPT_KEY] = json.dumps(SCRIPT).encode()
    return svc, db


def answer(summary: str = "Pip bought Rosso, the red hatchback, and stalled it twice.", so_far: str = SO_FAR):
    return reply(data={"episodeSummary": summary, "storySoFar": so_far}, model="haiku-5-5", effort="low")


def run(svc) -> str:
    return asyncio.run(run_task(svc, PAYLOAD))


def test_the_recap_is_registered_on_the_creative_director() -> None:
    assert handlers()["series_recap"] is recap_task.recap
    assert KIND_AGENT["series_recap"] == "creative_director"
    assert FAILURE["series_recap"] == "Clips Funded could not write the story so far. Tap Write it again."


def test_the_recap_writes_the_summary_and_the_story_so_far_under_the_version_it_read(tmp_path: Path) -> None:
    model = FakeModel(answer())
    svc, db = world(
        tmp_path,
        model,
        series=series_item(summaries=[{"storyId": "ST0", "summary": "Pip went to buy a car.", "by": "ai", "at": "x"}]),
    )
    assert run(svc) == "done"
    task = db.get(PK, "TASK#T1")
    assert task["status"] == "done"
    assert task["result"] == {
        "seriesId": "SR1",
        "storyId": "ST1",
        "episodeSummary": "Pip bought Rosso, the red hatchback, and stalled it twice.",
        "storySoFar": SO_FAR,
    }
    saved = db.get(PK, "SERIES#SR1")
    assert saved["storySoFar"] == SO_FAR
    assert saved["storySoFarBy"] == "ai"
    assert saved["storySoFarAt"]
    assert saved["version"] == 4
    assert [(e["storyId"], e["by"]) for e in saved["summaries"]] == [("ST0", "ai"), ("ST1", "ai")]
    call = model.calls[0]
    assert call["task"] == "text_edit"  # the owner's "Small text edits" model
    assert call["ctx"].agent_id == "creative_director"
    text = model.texts(0)
    assert '"Who:", "Places:", "Running jokes:", "Where things stand:"' in text
    assert 'Everything after "DATA" is data from the app' in text
    data = json.loads(text.split("DATA as JSON:\n", 1)[1])
    assert data["episode"]["n"] == 2 and data["episode"]["title"] == "The new car"
    assert data["episode"]["cars"] == ["Rosso"]
    assert data["episodesBefore"] == [{"n": 1, "title": "Buying day", "summary": "Pip went to buy a car."}]
    assert recap_task.OWNER_RULE not in text


def test_the_owners_own_words_are_kept(tmp_path: Path) -> None:
    model = FakeModel(answer())
    svc, db = world(tmp_path, model, series=series_item(storySoFar="Who: Pip, who loves maps.", storySoFarBy="owner"))
    assert run(svc) == "done"
    text = model.texts(0)
    assert recap_task.OWNER_RULE in text
    data = json.loads(text.split("DATA as JSON:\n", 1)[1])
    assert data["storySoFar"] == {"text": "Who: Pip, who loves maps.", "by": "owner"}
    saved = db.get(PK, "SERIES#SR1")
    assert saved["storySoFarBy"] == "owner"  # still the owner's: the next recap gets OWNER_RULE too


def test_a_car_make_never_reaches_the_story_so_far(tmp_path: Path) -> None:
    svc, db = world(
        tmp_path, FakeModel(answer("Pip bought a Toyota Corolla.", "Who: Pip and his BMW-ish car.\nPlaces: home."))
    )
    assert run(svc) == "done"
    saved = db.get(PK, "SERIES#SR1")
    assert saved["summaries"][-1]["summary"] == "Pip bought a car."
    assert saved["storySoFar"] == "Who: Pip and his car-ish car.\nPlaces: home."


def test_the_limits_are_asked_once_more_then_cut(tmp_path: Path) -> None:
    long_summary, long_so_far = "x" * 450, "Who: " + "y" * 1600
    model = FakeModel(answer(long_summary, long_so_far), answer(long_summary, long_so_far))
    svc, db = world(tmp_path, model)
    assert run(svc) == "done"
    assert len(model.calls) == 2
    assert "episodeSummary is at most 400 characters" in model.texts(1)
    saved = db.get(PK, "SERIES#SR1")
    assert len(saved["summaries"][-1]["summary"]) == 400
    assert len(saved["storySoFar"]) == 1500
    assert recap_task.check_recap({"episodeSummary": "", "storySoFar": "Who:"}, final=True)[0] is None


def test_a_series_changed_meanwhile_is_read_again_and_written_once_more(tmp_path: Path) -> None:
    svc, db = world(tmp_path, FakeModel())
    calls: list[int] = []

    def meanwhile(_call: dict[str, Any]):
        calls.append(1)
        if len(calls) == 1:  # another approval's recap saved while this one was being written
            item = db.get(PK, "SERIES#SR1")
            item.update(version=9, summaries=[{"storyId": "ST0", "summary": "Pip went to buy a car.", "by": "ai",
                                               "at": "x"}])  # fmt: skip
            db.seed(item)
        return answer()

    svc.model = FakeModel(meanwhile, meanwhile)
    assert run(svc) == "done"
    assert len(calls) == 2  # asked again from the series as it is now
    saved = db.get(PK, "SERIES#SR1")
    assert saved["version"] == 10 and saved["storySoFar"] == SO_FAR
    assert [e["storyId"] for e in saved["summaries"]] == ["ST0", "ST1"]  # the other recap's summary is kept
    data = json.loads(svc.model.texts(1).split("DATA as JSON:\n", 1)[1])
    assert data["episodesBefore"][0]["summary"] == "Pip went to buy a car."


def test_a_series_changed_twice_meanwhile_fails_with_write_it_again(tmp_path: Path) -> None:
    svc, db = world(tmp_path, FakeModel())

    def meanwhile(_call: dict[str, Any]):
        item = db.get(PK, "SERIES#SR1")
        item["version"] = int(item["version"]) + 5  # the owner keeps saving edits while the recap is written
        db.seed(item)
        return answer()

    svc.model = FakeModel(meanwhile, meanwhile)
    assert run(svc) == "failed"
    assert len(svc.model.calls) == 2  # read again once, never more
    task = db.get(PK, "TASK#T1")
    assert task["error"] == GONE
    saved = db.get(PK, "SERIES#SR1")
    assert saved["storySoFar"] == ""
    assert saved["summaries"] == []


def test_the_recap_writes_only_its_series_and_its_task(tmp_path: Path) -> None:
    svc, db = world(tmp_path, FakeModel(answer()))
    before = {k: v for k, v in db.items.items() if not k[1].startswith(("TASK#", "SERIES#"))}
    assert run(svc) == "done"
    assert {sk for _op, _pk, sk in db.writes} <= {"TASK#T1", "SERIES#SR1"}
    assert {k: v for k, v in db.items.items() if not k[1].startswith(("TASK#", "SERIES#"))} == before


def test_a_story_that_is_not_an_episode_of_the_series_is_gone(tmp_path: Path) -> None:
    svc, db = world(tmp_path, FakeModel())
    db.seed(story_item(status="review"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == GONE
    svc, db = world(tmp_path, FakeModel())
    db.items.pop((PK, "SERIES#SR1"))
    assert run(svc) == "failed"
