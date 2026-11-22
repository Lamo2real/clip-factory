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
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert (
        call("PATCH", BASE, {"version": version, "configuration": {"providers": {"images": "nova-canvas"}}})[0] == 200
    )


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


def test_portrait_needs_ai_pictures_on(call: Call, agentcore: FakeAgentCore, table: FakeTable) -> None:
    cid = call("POST", f"{BASE}/characters", character_body())[1]["character"]["characterId"]
    status, body = call("POST", f"{BASE}/characters/{cid}/portrait")
    assert status == 409
    assert (
        body["error"]["message"]
        == "AI pictures are off. Turn them on in Lamo Stories › Settings › Video › Picture maker."
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
        "description": "A tall orange cat in a raincoat",
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
