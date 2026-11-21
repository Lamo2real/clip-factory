"""Workspace isolation, enforced on the backend (docs/CONTRACTS.md §45.3, §45.19; acceptance criteria 2, 8, 12, 13).

Another owner's workspace id finds nothing (404) on every core route; Lamo Clips' id on a Lamo Stories page is a
409; an item whose ``userId`` or ``workspaceId`` attribute disagrees with its key is never returned; Lamo Clips'
own lists answer exactly the same before and after a whole Lamo Stories flow; no new item reaches a stream prefix
or Lamo Clips' partition; and no presigned URL or key outside ``ws/{userId}/{workspaceId}/`` is ever produced.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

import ws_routes_core
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import types as ws
from conftest import CAPTIONS, OTHER, USER, Call, seed_clip
from conftest import seed_job as seed_clip_job
from fakes import FakeAgentCore, FakeS3, FakeTable
from test_ws_keys import stream_prefixes
from ws_support import (
    BASE,
    FakeModel,
    character_body,
    install,
    leaked,
    outside,
    pk,
    prefix,
    presigned_keys,
    seed_asset,
    seed_character,
    seed_idea,
    seed_item,
    seed_job,
    seed_story,
    seed_workspace,
    story_key,
    use_model,
)

NOT_FOUND = "We could not find that workspace."
NOT_STORIES = "That is a Lamo Stories page. Switch to Lamo Stories first."
WORKSPACE_ROUTES = sorted((m, p) for m, p in ws_routes_core.EXPECTED if p.startswith("/v1/workspaces/stories"))
STORIES_ONLY = [(m, p) for m, p in WORKSPACE_ROUTES if not (p == "/v1/workspaces/stories" and m == "GET")]
WS_TYPES = {
    ws.TYPE_WORKSPACE,
    ws.TYPE_IDEA,
    ws.TYPE_CHARACTER,
    ws.TYPE_STORY,
    ws.TYPE_PJOB,
    ws.TYPE_ASSET,
    ws.TYPE_SOCIAL,
    ws.TYPE_PUBJOB,
    ws.TYPE_ACTIVITY,
    ws.TYPE_PROVIDER,
}


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


def _on(path: str, workspace_id: str) -> str:
    return path.replace("/v1/workspaces/stories", f"/v1/workspaces/{workspace_id}", 1)


@pytest.mark.parametrize(("method", "path"), WORKSPACE_ROUTES)
def test_another_owners_workspace_is_404_on_every_core_route(
    call: Call, store: db.Store, method: str, path: str
) -> None:
    theirs = seed_workspace(store, OTHER, name="Their studio")
    seed_story(store, user=OTHER, workspace_id=theirs)
    before = json.dumps(store._table.all(), sort_keys=True, default=str)  # type: ignore[attr-defined]
    status, body = call(method, _on(path, theirs), {} if method in {"POST", "PATCH", "PUT"} else None)
    assert status == 404, (method, path, body)
    assert body["error"]["message"] == NOT_FOUND
    assert json.dumps(store._table.all(), sort_keys=True, default=str) == before  # type: ignore[attr-defined]  # nothing written


@pytest.mark.parametrize(("method", "path"), STORIES_ONLY)
def test_lamo_clips_on_a_lamo_stories_route_is_409(call: Call, table: FakeTable, method: str, path: str) -> None:
    status, body = call(method, _on(path, "clips"), {} if method in {"POST", "PATCH", "PUT"} else None)
    assert status == 409, (method, path)
    assert body["error"] == {"code": "conflict", "message": NOT_STORIES}
    assert not any(k[0].startswith(f"USER#{USER}#WS#clips") for k in table.items)


def test_lamo_clips_itself_answers_as_the_built_in_workspace(call: Call) -> None:
    status, body = call("GET", "/v1/workspaces/clips")
    assert status == 200
    assert body["workspace"]["builtin"] is True


def test_the_same_ids_under_another_owner_find_nothing(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    story = seed_story(store, s3_client, user=OTHER)
    idea = seed_idea(store, user=OTHER)
    hero = seed_character(store, user=OTHER)
    # "stories" is every owner's own first Lamo Stories workspace: the key is built from the caller's sub.
    assert call("GET", f"{BASE}/stories/{story['storyId']}")[0] == 404
    assert call("GET", f"{BASE}/characters/{hero['characterId']}")[0] == 404
    assert call("PATCH", f"{BASE}/ideas/{idea['ideaId']}", {"title": "mine now"})[0] == 404
    assert call("GET", f"{BASE}/stories")[1]["stories"] == []
    assert call("GET", f"{BASE}/ideas")[1]["ideas"] == []
    assert call("GET", f"{BASE}/characters")[1]["characters"] == []
    assert call("DELETE", f"{BASE}/stories/{story['storyId']}")[0] == 404
    assert store.get(story["pk"], story["sk"]) is not None
    assert story["videoKey"] in s3_client.objects


def test_an_item_whose_attributes_disagree_with_its_key_is_never_returned(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    for bad in ({"userId": OTHER}, {"workspaceId": "01JZ0000000000000000000000"}):
        story = seed_story(store, s3_client, **bad)
        idea = seed_idea(store, **bad)
        hero = seed_character(store, **bad)
        asset = seed_asset(store, s3_client, **bad)
        job = seed_job(store, story, **bad)
        store.update(story["pk"], story["sk"], {"currentJobId": job["jobId"]})
        seed_item(
            store,
            "ACT#2026-11-15T09:00:00.000Z#x",
            "ws_activity",
            kind="made",
            storyId=story["storyId"],
            title="x",
            at="x",
            **bad,
        )
        seed_item(
            store,
            "PUBJOB#01J000000000000000000000X",
            "ws_pubjob",
            publishingStatus="failed",
            contentId=story["storyId"],
            **bad,
        )
        assert call("GET", f"{BASE}/stories/{story['storyId']}")[0] == 404
        assert call("GET", f"{BASE}/characters/{hero['characterId']}")[0] == 404
        assert call("DELETE", f"{BASE}/ideas/{idea['ideaId']}")[0] == 404
        assert call("GET", f"{BASE}/stories")[1]["stories"] == []
        assert call("GET", f"{BASE}/ideas")[1]["ideas"] == []
        assert call("GET", f"{BASE}/characters")[1]["characters"] == []
        assert call("GET", f"{BASE}/library")[1]["items"] == []
        dashboard = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
        assert dashboard["counts"]["review"] == 0
        assert dashboard["activity"] == []
        assert dashboard["needsYou"] == []
        assert store.get(asset["pk"], asset["sk"]) is not None
        for item in store.query_all(pk(), ""):
            store.delete(item["pk"], item["sk"])


# --- a whole Lamo Stories flow, and what Lamo Clips sees around it ---------------------------------------------


CLIPS_READS = ("/v1/clips", "/v1/jobs", "/v1/posts", "/v1/accounts", "/v1/setup", "/v1/me")


def _seed_lamo_clips(store: db.Store, s3_client: FakeS3) -> None:
    job = seed_clip_job(store, status="ready")
    seed_clip(store, s3_client, job_id=job["jobId"])
    seed_clip(store, s3_client, job_id=job["jobId"], status="posted", rank=2)
    store.put(
        {
            "pk": f"USER#{USER}",
            "sk": "POST#01J0000000000000000000POST",
            "type": "post",
            "userId": USER,
            "postId": "01J0000000000000000000POST",
            "clipId": "c",
            "platform": "youtube",
            "status": "posted",
            "createdAt": "2026-11-15T11:00:00.000Z",
            "captions": CAPTIONS,
        }
    )
    store.put(
        {
            "pk": f"USER#{USER}",
            "sk": "ACCOUNT#youtube",
            "type": "account",
            "userId": USER,
            "platform": "youtube",
            "status": "connected",
            "accountId": "UC_clips",
            "accountName": "Lamo Clips Channel",
        }
    )


def _clips_view(call: Call) -> dict[str, Any]:
    view = {}
    for path in CLIPS_READS:
        status, body = call("GET", path, query={"status": "all"} if path == "/v1/clips" else None)
        view[path] = (status, body)
    return view


def _clips_partition(table: FakeTable) -> str:
    return json.dumps(
        {f"{k[0]}|{k[1]}": v for k, v in table.items.items() if k[0] == f"USER#{USER}"}, sort_keys=True, default=str
    )


def _flow(call: Call, app: App, store: db.Store, s3_client: FakeS3) -> list[Any]:
    """Every core route, the way the screens use them, with the agent's and the flow's writes faked."""
    out: list[Any] = []

    def go(method: str, path: str, body: Any = None, **kw: Any) -> Any:
        status, answer = call(method, path, body, **kw)
        assert status < 400, (method, path, status, answer)
        out.append(answer)
        return answer

    go("GET", "/v1/workspaces")
    version = go("GET", BASE)["workspace"]["version"]
    go("PATCH", BASE, {"version": version, "configuration": {"providers": {"images": "nova-canvas"}}})
    hero = go("POST", f"{BASE}/characters", character_body("Lamo"))["character"]
    cid = hero["characterId"]
    up = go(
        "POST", f"{BASE}/characters/{cid}/references", {"filename": "me.jpg", "contentType": "image/jpeg", "size": 3}
    )
    s3_client.objects[f"{prefix()}characters/{cid}/refs/{up['assetId']}.jpg"] = b"jpg"
    go("POST", f"{BASE}/characters/{cid}/references/{up['assetId']}/complete")
    go("POST", f"{BASE}/characters/{cid}/portrait")
    idea = go(
        "POST",
        f"{BASE}/ideas",
        {"title": "Black ice", "logline": "The car slides on black ice.", "category": "driving_safety"},
    )["idea"]
    use_model(
        app,
        FakeModel(
            json.dumps(
                {
                    "ideas": [
                        {
                            "title": "Toast",
                            "logline": "Toast flies.",
                            "category": "comedy",
                            "topicId": "",
                            "characters": ["Lamo"],
                        }
                    ]
                }
            )
        ),
    )
    go("POST", f"{BASE}/ideas/generate", {"count": 1})
    created = go("POST", f"{BASE}/stories", {"ideaId": idea["ideaId"], "characterIds": [cid]})
    sid, job_id = created["story"]["storyId"], created["job"]["jobId"]
    # The agent makes the video (its writes, faked here as they land in the table and the bucket).
    from ws_support import script as make_script

    s3_client.objects[story_key(sid, "script/v1.json")] = json.dumps(make_script()).encode()
    s3_client.objects[story_key(sid, "final/v1.mp4")] = b"mp4"
    store.update(
        pk(),
        f"STORY#{sid}",
        {
            "status": "review",
            "scriptVersion": 1,
            "scriptKey": story_key(sid, "script/v1.json"),
            "videoKey": story_key(sid, "final/v1.mp4"),
            "actualDurationSec": 6,
            "scenes": [
                {"sceneId": "s1", "title": "a", "durationSec": 3},
                {"sceneId": "s2", "title": "b", "durationSec": 3},
            ],
            "safety": {
                "topicId": "skid-recovery",
                "status": "ok",
                "problems": [],
                "checkedScriptVersion": 1,
                "citations": [],
            },
        },
        remove=["currentJobId"],
    )
    store.update(pk(), f"PJOB#{job_id}", {"status": "ready"})
    seed_asset(store, s3_client, storyId=sid, key=story_key(sid, "final/v1.mp4"))
    seed_item(store, "PROVIDER#animation#builtin-2d", "ws_provider", state="on", checkedAt="2026-11-15T11:00:00.000Z")
    seed_item(
        store,
        "SOCIAL#youtube",
        "ws_social",
        platform="youtube",
        connectionStatus="connected",
        accountName="Lamo Stories Channel",
    )
    seed_item(
        store,
        "PUBJOB#01J0000000000000000000PJ1",
        "ws_pubjob",
        contentId=sid,
        platform="youtube",
        publishingStatus="posted",
    )
    story = go("GET", f"{BASE}/stories/{sid}")["story"]
    story = go(
        "PATCH",
        f"{BASE}/stories/{sid}",
        {"version": story["version"], "captions": [{"id": "c1", "at": 0, "dur": 2, "text": "Ease off"}]},
    )["story"]
    go("POST", f"{BASE}/stories/{sid}/produce", {})
    go("POST", f"{BASE}/stories/{sid}/cancel")
    store.update(
        pk(),
        f"STORY#{sid}",
        {
            "stale": [],
            "safety": {
                "topicId": "skid-recovery",
                "status": "ok",
                "problems": [],
                "checkedScriptVersion": 2,
                "citations": [],
            },
        },
    )
    story = go("GET", f"{BASE}/stories/{sid}")["story"]
    go("POST", f"{BASE}/stories/{sid}/approve", {"version": story["version"]})
    go("GET", f"{BASE}/stories/{sid}/download")
    go("GET", f"{BASE}/stories/{sid}/jobs")
    go("GET", f"{BASE}/stories")
    go("GET", f"{BASE}/library")
    go("GET", f"{BASE}/dashboard")
    go("GET", f"{BASE}/providers")
    go("GET", f"{BASE}/guidance")
    go("GET", f"{BASE}/characters")
    other = go(
        "POST",
        f"{BASE}/stories",
        {"brief": {"title": "Toast", "logline": "Toast flies.", "category": "comedy"}, "characterIds": [cid]},
    )
    call("DELETE", f"{BASE}/stories/{other['story']['storyId']}")
    go("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Cars"})
    return out


def test_lamo_clips_lists_are_exactly_the_same_before_and_after(
    call: Call, app: App, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    _seed_lamo_clips(store, s3_client)
    before = _clips_view(call)
    partition = _clips_partition(table)
    clips_objects = {k: v for k, v in s3_client.objects.items() if not k.startswith("ws/")}
    _flow(call, app, store, s3_client)
    assert _clips_partition(table) == partition  # Lamo Stories wrote nothing into USER#{userId}
    assert _clips_view(call) == before
    assert {k: v for k, v in s3_client.objects.items() if not k.startswith("ws/")} == clips_objects
    assert before["/v1/me"][1]["counts"] == {"review": 1, "running": 0, "posted": 1}
    assert [a["status"] for a in before["/v1/accounts"][1]["accounts"] if a["platform"] == "youtube"] == ["connected"]


def test_every_new_item_stays_out_of_the_streams_and_lamo_clips_readers(
    call: Call, app: App, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    _flow(call, app, store, s3_client)
    prefixes = stream_prefixes()
    new = [i for (p, _), i in table.items.items() if p.startswith(f"USER#{USER}#")]
    assert {i["type"] for i in new} >= {
        "workspace",
        "ws_idea",
        "ws_character",
        "ws_story",
        "ws_pjob",
        "ws_asset",
        "ws_activity",
    }
    for item in new:
        assert not any(str(item["sk"]).startswith(p) for p in prefixes), item["sk"]
        assert not any(k.startswith("gsi") for k in item), item["sk"]
        assert item["type"] in WS_TYPES
        assert item["userId"] == USER
        assert item["pk"] in {ws.registry_pk(USER), pk()} or item["pk"].startswith(f"USER#{USER}#WS#")
    assert all(p == f"USER#{USER}" or p.startswith(f"USER#{USER}#") for p, _ in table.items)


def test_no_presigned_url_or_key_outside_the_workspace(
    call: Call, app: App, store: db.Store, s3_client: FakeS3
) -> None:
    responses = _flow(call, app, store, s3_client)
    keys = presigned_keys(s3_client)
    assert keys, "the flow presigned files"
    assert outside(keys) == []
    written = [p["Key"] for p in s3_client.puts] + list(s3_client.deleted)
    assert outside(written) == []
    assert leaked(responses) == []
    for body in responses:
        text = json.dumps(body)
        for url in [w for w in text.split('"') if w.startswith("https://") and ".amazonaws.com/" in w]:
            assert f".amazonaws.com/{prefix()}" in url, url  # every presigned link is a file of this workspace
