"""Characters: rigs, versions, reference pictures and portraits (docs/CONTRACTS.md §45.5, §45.8, §45.11.6)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import catalog
from conftest import USER, Call
from fakes import FakeAgentCore, FakeS3, FakeTable
from ws_support import BASE, caller, character_body, install, pk, prefix, seed_character, seed_job, seed_story


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "web" / "src" / "stories" / "engine"


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


def _turn_on_pictures(call: Call) -> None:
    """Picks Stability AI as the picture maker (§45.37 G7: Amazon Nova Canvas has ended)."""
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert call("PATCH", BASE, {"version": version, "configuration": {"providers": {"images": "stability"}}})[0] == 200


def test_create_list_get_and_put_with_a_version(call: Call) -> None:
    status, body = call("POST", f"{BASE}/characters", character_body("Zed"))
    assert status == 201
    zed = body["character"]
    assert zed["version"] == 1
    assert zed["references"] == []
    assert zed["portrait"] is None
    assert zed["storyCount"] == 0
    assert zed["look"]["outfit"]["top"] == "#ff6f61"
    call("POST", f"{BASE}/characters", character_body("amy"))
    assert [c["name"] for c in call("GET", f"{BASE}/characters")[1]["characters"]] == ["amy", "Zed"]  # by name
    assert call("GET", f"{BASE}/characters/{zed['characterId']}")[1]["character"]["name"] == "Zed"
    status, body = call(
        "PUT",
        f"{BASE}/characters/{zed['characterId']}",
        {**character_body("Zed"), "movementStyle": "calm", "version": 1},
    )
    assert status == 200
    assert body["character"]["version"] == 2
    assert body["character"]["movementStyle"] == "calm"
    stale = call("PUT", f"{BASE}/characters/{zed['characterId']}", {**character_body("Zed"), "version": 1})
    assert stale[0] == 409
    assert call("PUT", f"{BASE}/characters/{zed['characterId']}", {**character_body("AMY"), "version": 2})[0] == 409


def test_duplicate_names_are_409(call: Call) -> None:
    assert call("POST", f"{BASE}/characters", character_body("Lamo"))[0] == 201
    status, body = call("POST", f"{BASE}/characters", character_body(" lamo "))
    assert status == 409
    assert body["error"]["message"] == "You already have a character called lamo. Pick another name."


@pytest.mark.parametrize(
    ("change", "where"),
    [
        ({"name": ""}, "name"),
        ({"name": "x" * 31}, "name"),
        ({"expressions": ["happy", "sad", "proud"]}, "neutral"),
        ({"expressions": ["neutral", "happy"]}, "faces"),
        ({"expressions": ["neutral", "happy", "smirk"]}, "expressions"),
        ({"movementStyle": "floaty"}, "movementStyle"),
        ({"traits": [f"t{n}" for n in range(9)]}, "traits"),
        ({"traits": ["x" * 31]}, "trait"),
        ({"description": "x" * 401}, "description"),
        ({"voice": {"style": "babble", "pitch": 3, "noises": [], "sfx": []}}, "pitch"),
        ({"voice": {"style": "babble", "pitch": 1, "noises": ["scream"], "sfx": []}}, "noises"),
        ({"voice": {"style": "babble", "pitch": 1, "noises": [], "sfx": [], "words": "hi"}}, "words"),
        ({"madeForKids": True}, "madeForKids"),
    ],
)
def test_bad_characters_are_refused(call: Call, change: dict[str, Any], where: str) -> None:
    status, body = call("POST", f"{BASE}/characters", {**character_body(), **change})
    assert status == 400
    assert where.lower() in body["error"]["message"].lower()


@pytest.mark.parametrize(
    "look",
    [
        {"skin": "red"},
        {"height": 2},
        {"body": "blob"},
        {"hair": {"style": "mohawk", "color": "#000000"}},
        {"outfit": {"top": "#000000", "bottom": "#000000", "accent": "#000000", "pattern": "tartan"}},
        {"accessory": "cape"},
        {"wings": True},
    ],
)
def test_bad_looks_are_refused(call: Call, look: dict[str, Any]) -> None:
    body = character_body()
    body["look"] = {**body["look"], **look}
    assert call("POST", f"{BASE}/characters", body)[0] == 400


def test_reference_pictures_upload_complete_and_delete(call: Call, s3_client: FakeS3, table: FakeTable) -> None:
    character = call("POST", f"{BASE}/characters", character_body())[1]["character"]
    cid = character["characterId"]
    status, body = call(
        "POST", f"{BASE}/characters/{cid}/references", {"filename": "me.png", "contentType": "image/png", "size": 2048}
    )
    assert status == 200
    asset_id = body["assetId"]
    assert body["headers"] == {"Content-Type": "image/png"}
    op, params, seconds = s3_client.presigned[-1]
    key = f"{prefix()}characters/{cid}/refs/{asset_id}.png"
    assert (op, params["Key"], params["ContentType"], params["ContentLength"], seconds) == (
        "put_object",
        key,
        "image/png",
        2048,
        900,
    )
    # Not sent yet: complete refuses.
    assert call("POST", f"{BASE}/characters/{cid}/references/{asset_id}/complete")[0] == 400
    s3_client.objects[key] = b"\x89PNG" + b"\0" * 2044
    status, body = call("POST", f"{BASE}/characters/{cid}/references/{asset_id}/complete")
    assert status == 200
    refs = body["character"]["references"]
    assert [r["assetId"] for r in refs] == [asset_id]
    assert refs[0]["url"].startswith("https://")
    assert body["character"]["version"] == 1  # an open editor's version stays valid
    asset = table.raw(pk(), f"ASSET#{asset_id}")
    assert asset is not None
    assert asset["kind"] == "character_ref"
    assert asset["characterId"] == cid
    # Completing twice is harmless.
    assert (
        len(call("POST", f"{BASE}/characters/{cid}/references/{asset_id}/complete")[1]["character"]["references"]) == 1
    )
    status, body = call("DELETE", f"{BASE}/characters/{cid}/references/{asset_id}")
    assert status == 200
    assert body["character"]["references"] == []
    assert key not in s3_client.objects
    assert table.raw(pk(), f"ASSET#{asset_id}") is None


def test_reference_rules(call: Call, s3_client: FakeS3) -> None:
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    url = f"{BASE}/characters/{cid}/references"
    assert call("POST", url, {"filename": "a.gif", "contentType": "image/gif", "size": 10})[0] == 400
    assert call("POST", url, {"filename": "a.png", "contentType": "image/png", "size": 10 * 1024 * 1024 + 1})[0] == 413
    assert call("POST", url, {"filename": "a.png", "contentType": "image/png", "size": 0})[0] == 400
    # The stored object is checked too: a file larger than allowed is deleted, not kept.
    asset_id = call("POST", url, {"filename": "a.webp", "contentType": "image/webp", "size": 100})[1]["assetId"]
    key = f"{prefix()}characters/{cid}/refs/{asset_id}.webp"
    s3_client.objects[key] = b"\0" * (10 * 1024 * 1024 + 5)
    assert call("POST", f"{url}/{asset_id}/complete")[0] == 400
    assert key not in s3_client.objects
    # At most 8 pictures (sent or being sent).
    for _ in range(8):
        assert call("POST", url, {"filename": "a.png", "contentType": "image/png", "size": 10})[0] == 200
    status, body = call("POST", url, {"filename": "a.png", "contentType": "image/png", "size": 10})
    assert status == 409
    assert "at most 8" in body["error"]["message"]


def test_a_vehicles_photos_say_outside_or_inside(call: Call, s3_client: FakeS3, table: FakeTable) -> None:
    """§45.47: each reference keeps its ``side`` (left out means outside); a vehicle has at most 6 outside and 4
    inside, a person's photos are all outside."""
    car = {**character_body("Rosso"), "kind": "car", "expressions": ["neutral"], "look": None}
    car["voice"] = {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine"]}
    car["car"] = {
        "body": "plane", "length": 1, "height": 1, "paint": "#d8352a", "accent": "#f4f1ea", "pattern": "plain",
        "windows": "clear", "wheels": {"style": "alloy", "rim": "#c9ccd2", "size": 1},
        "lights": {"front": "round", "rear": "bar"}, "extra": "none",
        "face": {"eyes": "none", "color": "#1c1842", "mouth": "none"}, "outline": "#1c1842",
    }  # fmt: skip
    status, made = call("POST", f"{BASE}/characters", car)
    assert status == 201, made
    cid = made["character"]["characterId"]
    url = f"{BASE}/characters/{cid}/references"
    photo = {"filename": "seat.png", "contentType": "image/png", "size": 10}
    status, up = call("POST", url, {**photo, "side": "inside"})
    assert status == 200
    key = f"{prefix()}characters/{cid}/refs/{up['assetId']}.png"
    s3_client.objects[key] = b"\0" * 10
    status, body = call("POST", f"{url}/{up['assetId']}/complete")
    assert status == 200
    assert body["character"]["references"][0]["side"] == "inside"
    stored = table.raw(pk(), f"CHAR#{cid}")
    assert stored is not None
    assert stored["references"][0]["side"] == "inside"
    assert call("POST", url, {**photo, "side": "top"})[0] == 400
    for _ in range(3):
        assert call("POST", url, {**photo, "side": "inside"})[0] == 200
    status, body = call("POST", url, {**photo, "side": "inside"})
    assert (status, body["error"]["message"]) == (409, "Pick up to 4 inside photos.")
    for _ in range(4):  # no side: outside, as before
        assert call("POST", url, photo)[0] == 200
    status, body = call("POST", url, {**photo, "side": "outside"})
    assert status == 409  # 8 in all
    # A person: no inside photos, and an outside one is stored as before (no side).
    pid = call("POST", f"{BASE}/characters", character_body("Pip"))[1]["character"]["characterId"]
    status, body = call("POST", f"{BASE}/characters/{pid}/references", {**photo, "side": "inside"})
    assert (status, body["error"]["message"]) == (400, "Inside photos are for a vehicle only.")
    status, up = call("POST", f"{BASE}/characters/{pid}/references", photo)
    s3_client.objects[f"{prefix()}characters/{pid}/refs/{up['assetId']}.png"] = b"\0" * 10
    refs = call("POST", f"{BASE}/characters/{pid}/references/{up['assetId']}/complete")[1]["character"]["references"]
    assert "side" not in refs[0]


def test_portrait_needs_ai_pictures_on(call: Call, agentcore: FakeAgentCore, table: FakeTable) -> None:
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    status, body = call("POST", f"{BASE}/characters/{cid}/portrait")
    assert status == 409
    assert (
        body["error"]["message"]
        == "AI pictures are off. Turn them on in Clips Funded › Settings › Video › Picture maker."
    )
    _turn_on_pictures(call)
    status, body = call("POST", f"{BASE}/characters/{cid}/portrait")
    assert status == 202
    job = body["job"]
    assert (job["contentType"], job["contentId"], job["jobType"], job["status"]) == (
        "character",
        cid,
        "portrait",
        "queued",
    )
    assert job["steps"] == [{"key": "portrait", "label": "Draw the picture", "status": "pending"}]
    assert job["configuration"]["run"] == ["portrait"]
    # the picked picture maker and the model it uses (null: its first that has not ended), §45.37 G1, G7
    assert job["meta"]["providers"] == {"images": "stability", "imageModel": "stable-image-core"}
    sent = agentcore.calls[-1]
    assert sent["payload"] == {
        "action": "process_portrait",
        "userId": USER,
        "workspaceId": "stories",
        "characterId": cid,
        "jobId": job["jobId"],
    }
    assert re.fullmatch(rf"cfstory-{job['jobId']}-[a-z0-9]{{8}}", sent["runtimeSessionId"])
    # A second tap while it runs is refused.
    assert call("POST", f"{BASE}/characters/{cid}/portrait")[0] == 409


def test_an_ended_picture_maker_is_never_called_for_a_portrait(
    call: Call, store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    """§45.37 G7: a workspace that still has Amazon Nova Canvas picked (from before it ended) is refused with the
    ended sentence and no call; picking it again is refused the same way, and nothing switches by itself."""
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    store.update(f"USER#{USER}#WSREG", "WS#stories", {"configuration": {"providers": {"images": "nova-canvas"}}})
    ended = (
        "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Clips Funded › "
        "Settings › Video."
    )
    calls = len(agentcore.calls)
    status, body = call("POST", f"{BASE}/characters/{cid}/portrait")
    assert (status, body["error"]["message"]) == (409, ended)
    assert len(agentcore.calls) == calls
    assert not [i for i in table.all() if str(i["sk"]).startswith("PJOB#")]
    workspace = call("GET", BASE)[1]["workspace"]
    assert workspace["configuration"]["providers"]["images"] == "nova-canvas"  # never swapped by itself
    status, body = call(
        "PATCH",
        BASE,
        {"version": workspace["version"], "configuration": {"providers": {"video": "builtin-2d"}}},
    )
    assert status == 200, body  # another setting saves; the old pick is not looked at again
    status, body = call(
        "PATCH",
        BASE,
        {"version": body["workspace"]["version"], "configuration": {"providers": {"imageModel": "nova-canvas"}}},
    )
    assert status == 400


def test_portrait_without_the_agent_fails_at_once(app: App, call: Call, s3_client: FakeS3) -> None:
    install(app, None, s3_client)
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    _turn_on_pictures(call)
    status, body = call("POST", f"{BASE}/characters/{cid}/portrait")
    assert status == 202
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == "The picture maker is not switched on yet, so making the picture did not start."


def test_a_finished_portrait_shows_on_the_character(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    _turn_on_pictures(call)
    job = call("POST", f"{BASE}/characters/{cid}/portrait")[1]["job"]
    key = f"{prefix()}characters/{cid}/portrait/01J00000000000000000000PIC.png"
    store.put(
        {
            "pk": pk(),
            "sk": "ASSET#01J00000000000000000000PIC",
            "type": "ws_asset",
            "userId": USER,
            "workspaceId": "stories",
            "assetId": "01J00000000000000000000PIC",
            "kind": "portrait",
            "characterId": cid,
            "key": key,
            "contentType": "image/png",
            "bytes": 10,
            "meta": {"current": 1},
            "createdAt": "2026-11-15T11:59:00.000Z",
        }
    )
    store.update(pk(), f"PJOB#{job['jobId']}", {"status": "ready"})
    portrait = call("GET", f"{BASE}/characters/{cid}")[1]["character"]["portrait"]
    assert portrait["assetId"] == "01J00000000000000000000PIC"
    assert key in portrait["url"]


def test_delete_waits_for_a_running_story_then_removes_everything(
    call: Call, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    cid = call("POST", f"{BASE}/characters", character_body("Lamo"))[1]["character"]["characterId"]
    story = seed_story(store, s3_client, characterIds=[cid], status="producing")
    job = seed_job(store, story)
    store.update(story["pk"], story["sk"], {"currentJobId": job["jobId"]})
    status, body = call("DELETE", f"{BASE}/characters/{cid}")
    assert status == 409
    assert body["error"]["message"] == "Lamo is in a story that is being made. Wait until it is done."
    store.update(job["pk"], job["sk"], {"status": "ready"})
    asset_id = call(
        "POST", f"{BASE}/characters/{cid}/references", {"filename": "a.png", "contentType": "image/png", "size": 4}
    )[1]["assetId"]
    key = f"{prefix()}characters/{cid}/refs/{asset_id}.png"
    s3_client.objects[key] = b"\x89PNG"
    call("POST", f"{BASE}/characters/{cid}/references/{asset_id}/complete")
    assert call("DELETE", f"{BASE}/characters/{cid}")[0] == 204
    assert table.raw(pk(), f"CHAR#{cid}") is None
    assert table.raw(pk(), f"ASSET#{asset_id}") is None
    assert key not in s3_client.objects
    assert story["videoKey"] in s3_client.objects  # the story's files are not the character's


def test_story_count_counts_the_stories_using_a_character(call: Call, store: db.Store) -> None:
    hero = seed_character(store)
    seed_story(store, characterIds=[hero["characterId"]])
    seed_story(store, characterIds=[hero["characterId"]], made=False)
    assert call("GET", f"{BASE}/characters/{hero['characterId']}")[1]["character"]["storyCount"] == 2


def _ts_ids(key: str) -> list[str]:
    text = (ENGINE / "catalog.ts").read_text()
    m = re.search(r"\n  " + key + r": \[(.*?)\n  \],", text, re.S)
    assert m, key
    return re.findall(r'id: "([^"]+)"', m.group(1))


def _ts_union(field: str) -> list[str]:
    text = (ENGINE / "types.ts").read_text()
    m = re.search(field + r'\s*:\s*((?:\s*\|?\s*"[^"]+")+)', text)
    assert m, field
    return re.findall(r'"([^"]+)"', m.group(1))


def test_the_api_vocabulary_mirrors_the_engine() -> None:
    assert list(catalog.EXPRESSIONS) == _ts_ids("expressions")
    assert list(catalog.MOVEMENT_STYLES) == _ts_ids("movementStyles")
    assert list(catalog.NOISES) == _ts_ids("noises")
    assert list(catalog.SFX) == _ts_ids("sfx")
    assert list(catalog.MUSIC_MOODS) == _ts_ids("musicMoods")
    assert list(catalog.LOOK_BODIES) == _ts_union("body")
    assert list(catalog.HAIR_STYLES) == _ts_union("hair: { style")
    assert list(catalog.EYE_SHAPES) == _ts_union("eyes: { shape")
    assert list(catalog.BROWS) == _ts_union("brows")
    assert list(catalog.NOSES) == _ts_union("nose")
    assert list(catalog.MOUTHS) == _ts_union("mouth")
    assert list(catalog.PATTERNS) == _ts_union("pattern")
    assert list(catalog.ACCESSORIES) == _ts_union("accessory")
    assert list(catalog.VOICE_STYLES) == _ts_union("  style")


def _ts_car_ids(key: str) -> list[str]:
    """One list of ``CATALOG.carLooks`` (catalog.ts, §45.42)."""
    text = (ENGINE / "catalog.ts").read_text()
    block = re.search(r"\n  carLooks: \{(.*?)\n  \},", text, re.S)
    assert block, "carLooks"
    m = re.search(r"\n    " + key + r": \[(.*?)\n    \],", block.group(1), re.S)
    assert m, key
    return re.findall(r'id: "([^"]+)"', m.group(1))


def _ts_type(name: str) -> list[str]:
    """The strings of ``export type {name} = "a" | "b" …;`` in types.ts (its ``//`` comment lines left out)."""
    text = re.sub(r"\n\s*//[^\n]*", "", (ENGINE / "types.ts").read_text())
    m = re.search(r"export type " + name + r' =((?:\s*\|?\s*"[^"]+")+);', text)
    assert m, name
    return re.findall(r'"([^"]+)"', m.group(1))


def test_the_api_car_vocabulary_mirrors_the_engine() -> None:
    assert list(catalog.CAR_BODIES) == _ts_car_ids("body") == _ts_type("CarBody")
    assert list(catalog.CAR_PATTERNS) == _ts_car_ids("pattern")
    assert list(catalog.CAR_WINDOWS) == _ts_car_ids("windows")
    assert list(catalog.CAR_WHEELS) == _ts_car_ids("wheels")
    assert list(catalog.CAR_FRONT_LIGHTS) == _ts_car_ids("frontLights")
    assert list(catalog.CAR_REAR_LIGHTS) == _ts_car_ids("rearLights")
    assert list(catalog.CAR_EXTRAS) == _ts_car_ids("extra")
    assert list(catalog.CAR_EYES) == _ts_car_ids("eyes")
    assert list(catalog.CAR_MOUTHS) == _ts_car_ids("mouth")
    assert list(catalog.CHARACTER_KINDS) == _ts_type("CharacterKind")


def test_the_api_vehicle_families_mirror_the_engine() -> None:
    """§45.47: ``VehicleType`` and the ``VEHICLE_OF`` table of engine/types.ts."""
    assert list(catalog.VEHICLE_TYPES) == _ts_type("VehicleType")
    text = (ENGINE / "types.ts").read_text()
    m = re.search(r"export const VEHICLE_OF: Record<CarBody, VehicleType> = \{(.*?)\};", text, re.S)
    assert m
    assert dict(re.findall(r"(\w+): \"(\w+)\"", m.group(1))) == catalog.VEHICLE_OF


# --- "Design with AI" (§45.5): a picture, then a task of the character agent ------------------------------------


def test_design_with_ai_uploads_a_hidden_picture_and_asks_the_character_agent(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    status, up = call(
        "POST", f"{BASE}/characters/design/uploads", {"filename": "cat.webp", "contentType": "image/webp", "size": 2048}
    )
    assert status == 200
    key = f"{prefix()}design/{up['assetId']}.webp"
    assert up["headers"] == {"Content-Type": "image/webp"}
    assert key in up["uploadUrl"]
    asset = store.get(pk(), f"ASSET#{up['assetId']}")
    assert asset is not None
    assert (asset["kind"], asset["key"], asset["bytes"]) == ("design_ref", key, 2048)
    # The Library hides it.
    assert call("GET", f"{BASE}/library")[1]["items"] == []
    # Before the picture arrives the task is refused; after, the character agent gets it.
    body = {"description": "A tall orange cat in a raincoat", "referenceAssetId": up["assetId"]}
    status, refused = call("POST", f"{BASE}/characters/design", body)
    assert status == 400
    assert refused["error"]["message"] == "The picture did not finish sending. Send it again."
    s3_client.objects[key] = b"webp"
    status, out = call("POST", f"{BASE}/characters/design", {**body, "override": {"model": "fable-5-1"}})
    assert status == 202
    task = out["task"]
    assert task["kind"] == "character_design"
    stored = store.get(pk(), f"TASK#{task['taskId']}")
    assert stored is not None
    assert stored["agentId"] == "character"
    assert stored["input"] == {
        "kind": "person",  # §45.42: a person, one option, the picture in the photo list too
        "count": 1,
        "description": "A tall orange cat in a raincoat",
        "references": [{"assetId": up["assetId"], "key": key, "contentType": "image/webp"}],
        "referenceAssetId": up["assetId"],
        "referenceKey": key,
        "referenceContentType": "image/webp",
    }
    assert stored["override"] == {"model": "fable-5-1"}
    assert agentcore.calls[-1]["payload"]["action"] == "run_task"
    # The draft comes back as the task's result; nothing is saved until the owner taps Save.
    draft = character_body("Marmalade")
    store.update(pk(), f"TASK#{task['taskId']}", {"status": "done", "result": {"character": draft}})
    shown = call("GET", f"{BASE}/tasks/{task['taskId']}")[1]["task"]
    assert shown["result"]["character"] == draft
    assert call("GET", f"{BASE}/characters")[1]["characters"] == []


def test_design_takes_a_characters_own_reference_too_but_only_of_this_workspace(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    hero = seed_character(store, name="Lamo")
    ref_key = f"{prefix()}characters/{hero['characterId']}/refs/01J0000000000000000000000R.png"
    s3_client.objects[ref_key] = b"png"
    store.put(
        {
            "pk": pk(),
            "sk": "ASSET#01J0000000000000000000000R",
            "type": "ws_asset",
            "userId": USER,
            "workspaceId": "stories",
            "assetId": "01J0000000000000000000000R",
            "kind": "character_ref",
            "characterId": hero["characterId"],
            "key": ref_key,
            "contentType": "image/png",
            "bytes": 3,
        }
    )
    assert call("POST", f"{BASE}/characters/design", {"referenceAssetId": "01J0000000000000000000000R"})[0] == 202
    story = seed_story(store, s3_client)
    video = {
        "pk": pk(),
        "sk": "ASSET#01J0000000000000000000000V",
        "type": "ws_asset",
        "userId": USER,
        "workspaceId": "stories",
        "assetId": "01J0000000000000000000000V",
        "kind": "final_video",
        "storyId": story["storyId"],
        "key": story["videoKey"],
    }
    store.put(video)
    other = {
        **video,
        "sk": "ASSET#01J0000000000000000000000W",
        "assetId": "01J0000000000000000000000W",
        "kind": "design_ref",
        "userId": "99999999-8888-7777-6666-555555555555",
    }
    store.put(other)
    for asset_id in ("01J0000000000000000000000V", "01J0000000000000000000000W", "01J0000000000000000000000Z", "x"):
        status, body = call("POST", f"{BASE}/characters/design", {"referenceAssetId": asset_id})
        assert status == 404, asset_id
        assert body["error"]["message"] == "We could not find that picture."
    assert len(store.query_all(pk(), "TASK#")) == 1  # only the one good task above


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("design", {}),
        ("design", {"description": "x" * 601}),
        ("design", {"description": "a cat", "colour": "red"}),
        ("design", {"description": "a cat", "override": {"effort": "huge"}}),
        ("design/uploads", {"filename": "a.gif", "contentType": "image/gif", "size": 3}),
        ("design/uploads", {"filename": "a.png", "contentType": "image/png", "size": 0}),
        ("design/uploads", {"filename": "a.png", "contentType": "image/png"}),
    ],
)
def test_design_bodies_are_checked(call: Call, store: db.Store, path: str, body: dict[str, Any]) -> None:
    assert call("POST", f"{BASE}/characters/{path}", body)[0] == 400
    assert store.query_all(pk(), "TASK#") == []


def test_a_too_big_design_picture_is_413(call: Call) -> None:
    body = {"filename": "a.png", "contentType": "image/png", "size": 10 * 1024 * 1024 + 1}
    assert call("POST", f"{BASE}/characters/design/uploads", body)[0] == 413
