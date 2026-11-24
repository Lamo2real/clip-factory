"""Series: folders of story videos and their story so far (docs/CONTRACTS.md §45.43, ADR-90).

A series is a ``SERIES#`` item of the workspace: a name, a line, a cast and the story so far. Its episodes, their
numbers, the counts and the cover are worked out on every read. Deleting a series never deletes a video; moving a
video in or out works in any status; an approval in a series starts the recap task, best effort.
"""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import tasks
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.routes import series as series_routes
from conftest import USER, Call
from fakes import FakeAgentCore, FakeS3
from ws_support import BASE, caller, install, pk, prefix, seed_asset, seed_character, seed_idea, seed_story, seed_task

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


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


def seed_car(store: db.Store, name: str = "Rosso") -> dict[str, Any]:
    return seed_character(
        store,
        name=name,
        kind="car",
        car=CAR,
        look=None,
        voice={"style": "none", "pitch": 1, "noises": [], "sfx": ["engine", "honk"]},
        expressions=["neutral"],
    )


def make(call: Call, name: str = "My first car", **extra: Any) -> dict[str, Any]:
    status, body = call("POST", f"{BASE}/series", {"name": name, **extra})
    assert status == 201, body
    series: dict[str, Any] = body["series"]
    return series


def recap_tasks(store: db.Store) -> list[dict[str, Any]]:
    return [t for t in store.query_all(pk(), ws.TASK_SK) if t.get("kind") == "series_recap"]


# --- the folder ---------------------------------------------------------------------------------------------------


def test_a_series_is_made_listed_read_changed_and_deleted(call: Call, store: db.Store) -> None:
    pip = seed_character(store, name="Pip")
    rosso = seed_car(store)
    made = make(call, line="He buys a car and drives it", castIds=[pip["characterId"], rosso["characterId"]])
    assert made["name"] == "My first car"
    assert made["line"] == "He buys a car and drives it"
    assert made["castIds"] == [pip["characterId"], rosso["characterId"]]
    assert made["episodes"] == []
    assert made["counts"] == {"ideas": 0, "making": 0, "review": 0, "done": 0}
    assert (made["storySoFar"], made["storySoFarBy"], made["recap"], made["cover"]) == ("", None, None, None)
    assert made["version"] == 1
    stored = store.get(pk(), f"SERIES#{made['seriesId']}")
    assert stored is not None
    assert stored["type"] == "ws_series"
    assert stored["summaries"] == []
    other = make(call, "Rainy days")
    assert [s["seriesId"] for s in call("GET", f"{BASE}/series")[1]["series"]] == [other["seriesId"], made["seriesId"]]
    got = call("GET", f"{BASE}/series/{made['seriesId']}")[1]["series"]
    assert got == made
    status, body = call(
        "PATCH", f"{BASE}/series/{made['seriesId']}", {"version": 1, "name": "  First  car ", "line": None}
    )
    assert status == 200, body
    assert (body["series"]["name"], body["series"]["line"], body["series"]["version"]) == ("First car", None, 2)
    assert call("DELETE", f"{BASE}/series/{made['seriesId']}")[0] == 204
    assert call("GET", f"{BASE}/series/{made['seriesId']}")[1]["error"]["message"] == "That series is gone."
    assert call("GET", f"{BASE}/series/not-an-id")[0] == 404
    assert call("PATCH", f"{BASE}/series/{made['seriesId']}", {"version": 2, "name": "x"})[0] == 404


@pytest.mark.parametrize(
    ("body", "sentence"),
    [
        ({"name": ""}, "Give your series a name."),
        ({"name": "   "}, "Give your series a name."),
        ({}, "Give your series a name."),
        ({"name": "x" * 41}, "Keep the name to 40 letters."),
        ({"name": "Ok", "line": "x" * 121}, "Keep the line to 120 letters."),
        ({"name": "Ok", "nope": 1}, "Unknown field: nope."),
    ],
)
def test_a_series_needs_a_short_name(call: Call, body: dict[str, Any], sentence: str) -> None:
    status, out = call("POST", f"{BASE}/series", body)
    assert status == 400
    assert out["error"]["message"] == sentence


def test_names_are_unique_and_there_are_at_most_50(call: Call, store: db.Store) -> None:
    first = make(call, "My first car")
    status, body = call("POST", f"{BASE}/series", {"name": "my FIRST  car"})
    assert status == 409
    assert body["error"]["message"] == "You already have a series called My first car."
    other = make(call, "Rainy days")
    renamed = call("PATCH", f"{BASE}/series/{other['seriesId']}", {"version": 1, "name": "MY FIRST CAR"})
    assert renamed[0] == 409
    assert call("PATCH", f"{BASE}/series/{first['seriesId']}", {"version": 1, "name": "My First Car"})[0] == 200
    for n in range(48):
        store.put(
            {
                "pk": pk(),
                "sk": f"SERIES#{ulid()}",
                "type": ws.TYPE_SERIES,
                "userId": USER,
                "workspaceId": "stories",
                "seriesId": ulid(),
                "name": f"Series {n}",
                "castIds": [],
                "version": 1,
            }
        )
    status, body = call("POST", f"{BASE}/series", {"name": "One too many"})
    assert status == 409
    assert body["error"]["message"] == "You have 50 series. Delete one to make another."


def test_the_cast_is_checked_with_the_car_rules(call: Call, store: db.Store) -> None:
    pip = seed_character(store, name="Pip")
    rosso, blue = seed_car(store), seed_car(store, "Blue")
    status, body = call("POST", f"{BASE}/series", {"name": "Alone", "castIds": [rosso["characterId"]]})
    assert (status, body["error"]["message"], body["error"].get("field")) == (
        400,
        "Add someone to drive it.",
        "castIds",
    )
    two = [pip["characterId"], rosso["characterId"], blue["characterId"]]
    assert call("POST", f"{BASE}/series", {"name": "Two", "castIds": two})[1]["error"]["message"] == "Pick one car."
    status, body = call("POST", f"{BASE}/series", {"name": "Ghost", "castIds": [ulid()]})
    assert status == 400
    assert body["error"]["field"] == "castIds"
    made = make(call, castIds=[pip["characterId"]])
    patched = call("PATCH", f"{BASE}/series/{made['seriesId']}", {"version": 1, "castIds": [rosso["characterId"]]})
    assert patched[1]["error"]["message"] == "Add someone to drive it."
    assert call("POST", f"{BASE}/series", {"name": "Four", "castIds": [ulid(), ulid(), ulid(), ulid()]})[0] == 400


def test_a_change_made_meanwhile_is_a_409_and_the_owner_edits_the_story_so_far(call: Call) -> None:
    made = make(call)
    url = f"{BASE}/series/{made['seriesId']}"
    status, body = call("PATCH", url, {"version": 1, "storySoFar": "Who: Pip.\nWhere things stand: no car yet."})
    assert status == 200
    shown = body["series"]
    assert shown["storySoFar"] == "Who: Pip.\nWhere things stand: no car yet."
    assert shown["storySoFarBy"] == "owner"
    assert shown["storySoFarAt"] == "2026-11-15T12:00:00.000Z"
    status, body = call("PATCH", url, {"version": 1, "line": "late"})
    assert status == 409
    assert body["error"]["message"] == "Someone changed this meanwhile. Look again, then save."
    assert call("PATCH", url, {"version": 2})[1]["error"]["message"] == "Nothing to change."
    assert call("PATCH", url, {"version": 2, "storySoFar": "x" * 1501})[0] == 400
    assert call("PATCH", url, {"name": "no version"})[0] == 400


def test_the_cover_is_chosen_or_automatic(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    pip = seed_character(
        store, name="Pip", portrait={"assetId": "A1", "key": f"{prefix()}characters/p/portrait/A1.png"}
    )
    made = make(call, castIds=[pip["characterId"]])
    assert made["coverUrl"] is not None
    assert "portrait/A1.png" in made["coverUrl"]
    ep = seed_story(
        store, s3_client, status="approved", approvedAt="2026-11-15T10:00:00.000Z", seriesId=made["seriesId"]
    )
    shown = call("GET", f"{BASE}/series/{made['seriesId']}")[1]["series"]
    assert "final/cover-v1.jpg" in shown["coverUrl"]
    assert ep["storyId"] in shown["coverUrl"]
    url = f"{BASE}/series/{made['seriesId']}"
    picked = call("PATCH", url, {"version": 1, "cover": {"characterId": pip["characterId"]}})[1]["series"]
    assert picked["cover"] == {"characterId": pip["characterId"]}
    assert "portrait/A1.png" in picked["coverUrl"]
    foreign = seed_story(store, s3_client)
    assert call("PATCH", url, {"version": 2, "cover": {"storyId": foreign["storyId"]}})[0] == 400
    back = call("PATCH", url, {"version": 2, "cover": None})[1]["series"]
    assert back["cover"] is None
    assert ep["storyId"] in back["coverUrl"]


# --- episodes, counts and the recap -------------------------------------------------------------------------------


def test_episodes_are_numbered_in_the_order_of_approval_with_their_summaries(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    made = make(call)
    sid = made["seriesId"]
    second = seed_story(
        store, s3_client, title="Off we go", status="published", approvedAt="2026-11-15T11:00:00.000Z", seriesId=sid
    )
    first = seed_story(
        store, s3_client, title="The new car", status="approved", approvedAt="2026-11-15T09:00:00.000Z", seriesId=sid
    )
    seed_story(store, s3_client, status="review", seriesId=sid)
    seed_story(store, s3_client, status="producing", seriesId=sid, made=False)
    seed_story(store, s3_client, status="approved", approvedAt="2026-11-15T08:00:00.000Z")  # in no series
    seed_idea(store, seriesId=sid)
    seed_idea(store, seriesId=sid, status="used")
    store.update(
        pk(),
        f"SERIES#{sid}",
        {"summaries": [{"storyId": first["storyId"], "summary": "Pip bought Rosso.", "by": "ai", "at": "x"}]},
    )
    shown = call("GET", f"{BASE}/series/{sid}")[1]["series"]
    assert [(e["number"], e["title"], e["status"]) for e in shown["episodes"]] == [
        (1, "The new car", "approved"),
        (2, "Off we go", "published"),
    ]
    assert (shown["episodes"][0]["summary"], shown["episodes"][0]["by"]) == ("Pip bought Rosso.", "ai")
    assert (shown["episodes"][1]["summary"], shown["episodes"][1]["by"]) == (None, None)
    assert shown["episodes"][1]["storyId"] == second["storyId"]
    assert "coverUrl" in shown["episodes"][1]
    assert shown["counts"] == {"ideas": 1, "making": 1, "review": 1, "done": 2}


def test_approving_a_story_of_a_series_starts_its_recap(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    made = make(call)
    story = seed_story(store, s3_client, seriesId=made["seriesId"])
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": story["version"]})
    assert status == 200
    assert body["story"]["seriesId"] == made["seriesId"]
    (task,) = recap_tasks(store)
    assert task["input"] == {"seriesId": made["seriesId"], "storyId": story["storyId"]}
    assert agentcore.calls[-1]["payload"]["action"] == "run_task"
    assert agentcore.calls[-1]["payload"]["taskId"] == task["taskId"]
    shown = call("GET", f"{BASE}/series/{made['seriesId']}")[1]["series"]
    assert shown["recap"] == {"taskId": task["taskId"], "storyId": story["storyId"], "status": "queued"}
    assert shown["version"] == 1  # keeping the task's id is no change of the owner's
    store.update(pk(), task["sk"], {"status": "failed", "error": "Clips Funded could not write the story so far."})
    failed = call("GET", f"{BASE}/series/{made['seriesId']}")[1]["series"]["recap"]
    assert failed["status"] == "failed"
    assert failed["error"].startswith("Clips Funded could not")
    store.update(pk(), task["sk"], {"status": "done"})
    assert call("GET", f"{BASE}/series/{made['seriesId']}")[1]["series"]["recap"] is None
    # A story in no series, or in a series that is gone, starts nothing.
    plain = seed_story(store, s3_client)
    gone = seed_story(store, s3_client, seriesId=ulid())
    for s in (plain, gone):
        assert call("POST", f"{BASE}/stories/{s['storyId']}/approve", {"version": s["version"]})[0] == 200
    assert len(recap_tasks(store)) == 1


def test_an_approval_never_fails_because_of_the_recap(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore, monkeypatch: pytest.MonkeyPatch
) -> None:
    made = make(call)
    agentcore.fail = True
    one = seed_story(store, s3_client, seriesId=made["seriesId"])
    assert call("POST", f"{BASE}/stories/{one['storyId']}/approve", {"version": one["version"]})[0] == 200
    (task,) = recap_tasks(store)
    assert task["status"] == "failed"  # a refused start is a failed task: the series page offers Write it again

    def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(tasks, "new_task", broken)
    two = seed_story(store, s3_client, seriesId=made["seriesId"])
    status, body = call("POST", f"{BASE}/stories/{two['storyId']}/approve", {"version": two["version"]})
    assert status == 200
    assert body["story"]["status"] == "approved"


def test_write_it_again_starts_a_recap_for_an_episode_only(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    url = f"{BASE}/series/{made['seriesId']}/recap"
    ep = seed_story(
        store, s3_client, status="approved", approvedAt="2026-11-15T09:00:00.000Z", seriesId=made["seriesId"]
    )
    status, body = call("POST", url, {"storyId": ep["storyId"]})
    assert status == 202
    assert body["task"]["kind"] == "series_recap"
    assert store.get(pk(), f"SERIES#{made['seriesId']}")["recapTaskId"] == body["task"]["taskId"]  # type: ignore[index]
    waiting = seed_story(store, s3_client, seriesId=made["seriesId"])
    assert call("POST", url, {"storyId": waiting["storyId"]})[0] == 409
    elsewhere = seed_story(store, s3_client, status="approved")
    assert call("POST", url, {"storyId": elsewhere["storyId"]})[0] == 409
    assert call("POST", url, {"storyId": ulid()})[0] == 404
    assert call("POST", f"{BASE}/series/{ulid()}/recap", {"storyId": ep["storyId"]})[0] == 404


def test_the_creative_director_switched_off_writes_no_recap(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    assert call("PATCH", f"{BASE}/agents/creative_director", {"version": 1, "active": False})[0] == 200
    ep = seed_story(store, s3_client, seriesId=made["seriesId"])
    status, body = call("POST", f"{BASE}/stories/{ep['storyId']}/approve", {"version": ep["version"]})
    assert status == 200
    assert body["story"]["status"] == "approved"  # the approval still works
    assert recap_tasks(store) == []  # but no recap starts only to fail in the agent
    status, body = call("POST", f"{BASE}/series/{made['seriesId']}/recap", {"storyId": ep["storyId"]})
    assert status == 409
    assert body["error"]["message"] == (
        "Creative director is switched off. Switch it on in Clips Funded › Settings › Agents."
    )


# --- moving and deleting ------------------------------------------------------------------------------------------


def test_a_story_moves_in_any_status_and_its_version_goes_up(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    job_story = seed_story(store, s3_client, status="producing", currentJobId="J1")
    status, body = call("PUT", f"{BASE}/stories/{job_story['storyId']}/series", {"seriesId": made["seriesId"]})
    assert status == 200
    assert body["story"]["seriesId"] == made["seriesId"]
    assert body["story"]["version"] == job_story["version"] + 1
    assert body["story"]["currentJobId"] == "J1"  # a running job is not disturbed
    assert recap_tasks(store) == []  # not an episode yet
    out = call("PUT", f"{BASE}/stories/{job_story['storyId']}/series", {"seriesId": None})[1]["story"]
    assert "seriesId" not in out
    assert call("PUT", f"{BASE}/stories/{job_story['storyId']}/series", {"seriesId": ulid()})[0] == 404
    assert call("PUT", f"{BASE}/stories/{job_story['storyId']}/series", {})[0] == 400
    assert call("PUT", f"{BASE}/stories/{ulid()}/series", {"seriesId": None})[0] == 404


def test_moving_an_episode_in_starts_a_recap_and_moving_it_out_drops_its_summary(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    old, new = make(call, "Old"), make(call, "New")
    ep = seed_story(
        store, s3_client, status="approved", approvedAt="2026-11-15T09:00:00.000Z", seriesId=old["seriesId"]
    )
    store.update(
        pk(),
        f"SERIES#{old['seriesId']}",
        {"summaries": [{"storyId": ep["storyId"], "summary": "Pip bought Rosso.", "by": "ai", "at": "x"}]},
    )
    assert call("PUT", f"{BASE}/stories/{ep['storyId']}/series", {"seriesId": new["seriesId"]})[0] == 200
    assert store.get(pk(), f"SERIES#{old['seriesId']}")["summaries"] == []  # type: ignore[index]
    (task,) = recap_tasks(store)
    assert task["input"] == {"seriesId": new["seriesId"], "storyId": ep["storyId"]}
    assert call("GET", f"{BASE}/series/{new['seriesId']}")[1]["series"]["episodes"][0]["number"] == 1


def test_deleting_a_series_keeps_its_videos_and_ideas_under_no_series(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    made = make(call)
    story = seed_story(store, s3_client, seriesId=made["seriesId"])
    idea = seed_idea(store, seriesId=made["seriesId"])
    other = seed_story(store, s3_client, seriesId=ulid())
    assert call("DELETE", f"{BASE}/series/{made['seriesId']}")[0] == 204
    kept = store.get(pk(), story["sk"])
    assert kept is not None
    assert "seriesId" not in kept
    assert kept["version"] == story["version"] + 1
    kept_idea = store.get(pk(), idea["sk"])
    assert kept_idea is not None
    assert "seriesId" not in kept_idea
    assert store.get(pk(), other["sk"])["seriesId"] == other["seriesId"]  # type: ignore[index]
    assert s3_client.objects[story["videoKey"]] == b"mp4"
    assert call("DELETE", f"{BASE}/series/{made['seriesId']}")[0] == 404


def test_deleting_a_story_drops_its_summary(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    ep = seed_story(
        store, s3_client, status="approved", approvedAt="2026-11-15T09:00:00.000Z", seriesId=made["seriesId"]
    )
    store.update(
        pk(),
        f"SERIES#{made['seriesId']}",
        {"summaries": [{"storyId": ep["storyId"], "summary": "Gone soon.", "by": "ai", "at": "x"}]},
    )
    assert call("DELETE", f"{BASE}/stories/{ep['storyId']}")[0] == 204
    assert store.get(pk(), f"SERIES#{made['seriesId']}")["summaries"] == []  # type: ignore[index]


# --- the filters --------------------------------------------------------------------------------------------------


def test_stories_are_listed_by_series_none_and_orphans(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    inside = seed_story(store, s3_client, seriesId=made["seriesId"])
    plain = seed_story(store, s3_client)
    orphan = seed_story(store, s3_client, seriesId=ulid())

    def ids(q: dict[str, str]) -> set[str]:
        return {s["storyId"] for s in call("GET", f"{BASE}/stories", query=q)[1]["stories"]}

    assert ids({"seriesId": made["seriesId"]}) == {inside["storyId"]}
    assert ids({"seriesId": "none"}) == {plain["storyId"], orphan["storyId"]}
    assert ids({}) == {inside["storyId"], plain["storyId"], orphan["storyId"]}
    assert ids({"seriesId": made["seriesId"], "status": "approved"}) == set()
    assert call("GET", f"{BASE}/stories", query={"seriesId": "bad"})[0] == 400


def test_the_library_keeps_the_files_of_the_series_stories(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    made = make(call)
    inside = seed_story(store, s3_client, seriesId=made["seriesId"])
    plain = seed_story(store, s3_client)
    a = seed_asset(store, s3_client, storyId=inside["storyId"])
    b = seed_asset(store, s3_client, storyId=plain["storyId"])
    c = seed_asset(store, s3_client, kind="portrait", storyId=None, characterId="X")

    def ids(q: dict[str, str]) -> set[str]:
        return {i["assetId"] for i in call("GET", f"{BASE}/library", query=q)[1]["items"]}

    assert ids({"seriesId": made["seriesId"]}) == {a["assetId"]}
    assert ids({"seriesId": "none"}) == {b["assetId"]}
    assert c["assetId"] in ids({})  # a file with no story shows only under All


# --- ideas ----------------------------------------------------------------------------------------------------------


def test_ideas_are_filed_in_a_series_and_moved_out(call: Call, store: db.Store) -> None:
    made = make(call)
    body = {"title": "Stall", "logline": "Pip stalls Rosso.", "category": "comedy"}
    idea = call("POST", f"{BASE}/ideas", {**body, "seriesId": made["seriesId"]})[1]["idea"]
    assert idea["seriesId"] == made["seriesId"]
    lost = call("POST", f"{BASE}/ideas", {**body, "seriesId": ulid()})[1]["idea"]
    assert "seriesId" not in lost  # the series is gone: kept anyway, under No series
    plain = call("POST", f"{BASE}/ideas", body)[1]["idea"]
    assert "seriesId" not in plain
    moved = call("PATCH", f"{BASE}/ideas/{plain['ideaId']}", {"seriesId": made["seriesId"]})[1]["idea"]
    assert moved["seriesId"] == made["seriesId"]
    out = call("PATCH", f"{BASE}/ideas/{plain['ideaId']}", {"seriesId": None})[1]["idea"]
    assert "seriesId" not in out
    assert call("PATCH", f"{BASE}/ideas/{plain['ideaId']}", {"seriesId": ulid()})[0] == 400  # nothing left to change
    assert call("POST", f"{BASE}/ideas", {**body, "seriesId": "nope"})[0] == 400


def test_ideas_for_a_gone_series_are_a_404(call: Call) -> None:
    status, body = call("POST", f"{BASE}/ideas/generate", {"seriesId": ulid()})
    assert status == 404
    assert body["error"]["message"] == "That series is gone."
    made = make(call)
    status, body = call("POST", f"{BASE}/ideas/generate", {"seriesId": made["seriesId"], "count": 2})
    assert status == 202


def test_a_series_ideas_are_filed_there_with_its_cast(call: Call, store: db.Store) -> None:
    pip, rosso = seed_character(store, name="Pip"), seed_car(store)
    made = make(call, castIds=[pip["characterId"], rosso["characterId"]])
    drafts = [
        {"title": "No cast", "logline": "Nobody named.", "category": "comedy"},
        {"title": "Car only", "logline": "Rosso alone.", "category": "comedy", "characterIds": [rosso["characterId"]]},
        {"title": "Pip only", "logline": "Pip walks.", "category": "comedy", "characterIds": [pip["characterId"]]},
    ]
    task = seed_task(store, status="done", input={"count": 3, "seriesId": made["seriesId"]}, result={"drafts": drafts})
    shown = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]["result"]["drafts"]
    assert [d["seriesId"] for d in shown] == [made["seriesId"]] * 3
    assert shown[0]["characterIds"] == [pip["characterId"], rosso["characterId"]]
    assert shown[1]["characterIds"] == [pip["characterId"], rosso["characterId"]]  # the main person drives
    assert shown[2]["characterIds"] == [pip["characterId"]]
    plain = seed_task(store, status="done", input={"count": 1}, result={"drafts": drafts[:1]})
    assert "seriesId" not in call("GET", f"{BASE}/tasks/{plain['taskId']}")[1]["task"]["result"]["drafts"][0]


def test_a_story_is_filed_from_the_body_or_its_idea(call: Call, store: db.Store) -> None:
    hero = seed_character(store, name="Pip")
    made = make(call)
    brief = {"title": "Day one", "logline": "Pip gets a car.", "category": "comedy"}
    story = call(
        "POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]], "seriesId": made["seriesId"]}
    )[1]["story"]
    assert story["seriesId"] == made["seriesId"]
    idea = seed_idea(store, seriesId=made["seriesId"])
    from_idea = call("POST", f"{BASE}/stories", {"ideaId": idea["ideaId"], "characterIds": [hero["characterId"]]})[1]
    assert from_idea["story"]["seriesId"] == made["seriesId"]
    lost = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]], "seriesId": ulid()})
    assert lost[0] == 201
    assert "seriesId" not in lost[1]["story"]
    plain = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]]})[1]["story"]
    assert "seriesId" not in plain
    # "No series" picked on purpose (null): a series idea makes a one-off video
    idea_two = seed_idea(store, seriesId=made["seriesId"])
    one_off = call(
        "POST",
        f"{BASE}/stories",
        {"ideaId": idea_two["ideaId"], "characterIds": [hero["characterId"]], "seriesId": None},
    )
    assert one_off[0] == 201
    assert "seriesId" not in one_off[1]["story"]


def test_a_story_cast_follows_the_car_rules(call: Call, store: db.Store) -> None:
    rosso, blue, pip = seed_car(store), seed_car(store, "Blue"), seed_character(store, name="Pip")
    brief = {"title": "Day one", "logline": "Pip gets a car.", "category": "comedy"}
    status, body = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [rosso["characterId"]]})
    assert (status, body["error"]["message"], body["error"]["field"]) == (
        400,
        "Add someone to drive it.",
        "characterIds",
    )
    both = [pip["characterId"], rosso["characterId"], blue["characterId"]]
    assert (
        call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": both})[1]["error"]["message"]
        == "Pick one car."
    )
    ok = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [pip["characterId"], rosso["characterId"]]})
    assert ok[0] == 201


def test_public_shapes_leave_out_an_unset_series(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client)
    idea = seed_idea(store)
    assert "seriesId" not in call("GET", f"{BASE}/stories/{story['storyId']}")[1]["story"]
    assert "seriesId" not in next(i for i in call("GET", f"{BASE}/ideas")[1]["ideas"] if i["ideaId"] == idea["ideaId"])


def test_the_series_routes_are_registered_once() -> None:
    assert len(series_routes.ROUTES) == 7
