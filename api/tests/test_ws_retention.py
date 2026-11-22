"""Keeping and clearing files (docs/CONTRACTS.md §45.34 "Keeping and clearing files"; the owner's second request §6F:
"Media storage. Reference-video storage. Asset retention."): ``POST …/storage/cleanup`` applies
``production.keepReferences``, ``keepChatPictures`` and ``keepVersions`` now. It deletes files only under the
workspace's own ``ws/{u}/{ws}/``, updates the ``REFVID#``, ``MSG#`` and ``ASSET#`` items that named them, leaves a
running job's story and a reference being studied alone, keeps each reference's study, is bounded per call, and a
second call finds nothing more."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import retention
from clipfactory_api.workspaces import types as ws
from conftest import USER
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    prefix,
    seed,
    seed_workspace,
    ws_call,
)

OLD = "2026-08-01T10:00:00.000Z"  # more than 90 days before the clock's 2026-11-15
RECENT = "2026-11-01T10:00:00.000Z"  # 14 days before


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def _keep(store: db.Store, **production: Any) -> None:
    from clipfactory_api.workspaces import guard

    defaults = guard.default_stories_config()["production"]
    seed_workspace(store, production={**defaults, **production})


def _cleanup(wcall: WsCall) -> dict[str, int]:
    status, body = wcall("POST", f"{BASE}/storage/cleanup", {})
    assert status == 200, body
    return dict(body["removed"])


def _reference(store: db.Store, s3: FakeS3, ref_id: str, *, created: str = RECENT, **fields: Any) -> dict[str, Any]:
    folder = f"{prefix()}references/{ref_id}/"
    s3.objects[f"{folder}source.mp4"] = b"video"
    s3.objects[f"{folder}frames/0001.jpg"] = b"f1"
    s3.objects[f"{folder}frames/0002.jpg"] = b"f2"
    s3.objects[f"{folder}analysis.json"] = json.dumps({"summary": "A skid."}).encode()
    item: dict[str, Any] = {
        "refId": ref_id,
        "title": "Skid",
        "status": "analyzed",
        "bytes": 5000,
        "key": f"{folder}source.mp4",
        "analysisKey": f"{folder}analysis.json",
        "createdAt": created,
        **fields,
    }
    return seed(store, f"REFVID#{ref_id}", ws.TYPE_REFVID, **{k: v for k, v in item.items() if v is not None})


REF_A = "01JD00000000000000000000RA"
REF_B = "01JD00000000000000000000RB"
REF_C = "01JD00000000000000000000RC"


def test_keeping_everything_clears_nothing(wcall: WsCall, store: db.Store, s3_client: FakeS3) -> None:
    _reference(store, s3_client, REF_A, created=OLD)
    before = dict(s3_client.objects)
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}
    assert s3_client.objects == before


def test_study_only_clears_a_studied_videos_file_and_frames_and_keeps_its_study(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    _keep(store, keepReferences="study_only")
    _reference(store, s3_client, REF_A)
    _reference(store, s3_client, REF_B, status="ready", analysisKey=None)  # not studied yet: kept
    _reference(store, s3_client, REF_C, status="analyzing", currentJobId="01JD00000000000000000000J1")  # being studied
    assert _cleanup(wcall) == {"files": 3, "bytes": 5000}
    folder = f"{prefix()}references/{REF_A}/"
    assert f"{folder}source.mp4" not in s3_client.objects
    assert not [k for k in s3_client.objects if k.startswith(f"{folder}frames/")]
    assert f"{folder}analysis.json" in s3_client.objects  # the study stays
    assert f"{prefix()}references/{REF_B}/source.mp4" in s3_client.objects
    assert f"{prefix()}references/{REF_C}/source.mp4" in s3_client.objects
    item = table.raw(pk(), f"REFVID#{REF_A}")
    assert item["fileRemovedAt"] == "2026-11-15T12:00:00.000Z"
    assert (item["status"], item["title"]) == ("analyzed", "Skid")
    # the page shows the study without the video, and studying it again is refused with the same words
    status, got = wcall("GET", f"{BASE}/references/{REF_A}")
    assert status == 200
    assert "url" not in got["reference"]
    assert got["reference"]["status"] == "analyzed"
    assert leaked([got]) == []
    status, refused = wcall("POST", f"{BASE}/references/{REF_A}/analyze", {})
    assert (status, refused["error"]["message"]) == (409, "The video was removed to save space. Its study stays.")
    # storage no longer counts it
    assert wcall("GET", f"{BASE}/storage")[1]["storage"]["bytes"]["references"] == 10000
    # a second call finds nothing more
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}


@pytest.mark.parametrize(("keep", "cleared"), [("days_30", [REF_A]), ("days_90", [REF_A])])
def test_reference_videos_older_than_the_days_kept_lose_their_file(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, keep: str, cleared: list[str]
) -> None:
    _keep(store, keepReferences=keep)
    _reference(store, s3_client, REF_A, created=OLD)
    _reference(store, s3_client, REF_B, created=RECENT)
    removed = _cleanup(wcall)
    assert removed["bytes"] == 5000
    for ref_id in (REF_A, REF_B):
        present = f"{prefix()}references/{ref_id}/source.mp4" in s3_client.objects
        assert present is (ref_id not in cleared), ref_id
        assert f"{prefix()}references/{ref_id}/analysis.json" in s3_client.objects


def test_old_chat_pictures_go_and_the_words_stay(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    _keep(store, keepChatPictures="days_30")
    conv = "01JD00000000000000000000CV"
    seed(store, f"CONV#{conv}", ws.TYPE_CONV, convId=conv, title="Ice", model=None, effort=None)
    old_key, new_key = f"{prefix()}chat/{conv}/a.png", f"{prefix()}chat/{conv}/b.png"
    s3_client.objects[old_key] = b"png"
    s3_client.objects[new_key] = b"png"
    seed(store, f"MSG#{conv}#01JD00000000000000000000M1", ws.TYPE_MSG, convId=conv, msgId="01JD00000000000000000000M1",
         role="user", text="Look at this", status="done", createdAt=OLD,
         attachments=[{"assetId": "a", "key": old_key, "contentType": "image/png", "bytes": 300}])  # fmt: skip
    seed(store, f"MSG#{conv}#01JD00000000000000000000M2", ws.TYPE_MSG, convId=conv, msgId="01JD00000000000000000000M2",
         role="user", text="And this", status="done", createdAt=RECENT,
         attachments=[{"assetId": "b", "key": new_key, "contentType": "image/png", "bytes": 200}])  # fmt: skip
    assert _cleanup(wcall) == {"files": 1, "bytes": 300}
    assert old_key not in s3_client.objects
    assert new_key in s3_client.objects
    old = table.raw(pk(), f"MSG#{conv}#01JD00000000000000000000M1")
    assert (old["attachments"], old["text"]) == ([], "Look at this")
    assert old["picturesRemovedAt"] == "2026-11-15T12:00:00.000Z"
    _, got = wcall("GET", f"{BASE}/chat/{conv}")
    shown = {m["msgId"]: m for m in got["messages"]}
    assert shown["01JD00000000000000000000M1"]["attachments"] == []
    assert len(shown["01JD00000000000000000000M2"]["attachments"]) == 1
    assert leaked([got]) == []
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}


def _asset(store: db.Store, s3: FakeS3, story_id: str, kind: str, version: int, current: int, name: str,
           **meta: Any) -> str:  # fmt: skip
    key = f"{prefix()}stories/{story_id}/{name}"
    s3.objects[key] = b"x"
    asset_id = ulid()
    seed(store, f"ASSET#{asset_id}", ws.TYPE_ASSET, assetId=asset_id, kind=kind, storyId=story_id, key=key,
         bytes=100, version=version, meta={"current": current, **meta})  # fmt: skip
    return key


def test_only_the_last_versions_kept_stay(wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable) -> None:
    _keep(store, keepVersions=1)
    sid = "01JD00000000000000000000S1"
    v1_video = _asset(store, s3_client, sid, "final_video", 1, 0, "final/v1.mp4")
    v1_board = _asset(store, s3_client, sid, "storyboard", 1, 0, "script/v1.json", by="writer")  # the writer's newest
    s3_client.objects[f"{prefix()}stories/{sid}/script/v1.writer.json"] = b"{}"
    v2_board = _asset(store, s3_client, sid, "storyboard", 2, 0, "script/v2.json", by="owner")
    s3_client.objects[f"{prefix()}stories/{sid}/script/v2.writer.json"] = b"{}"
    v2_still = _asset(store, s3_client, sid, "scene_still", 2, 0, "scenes/s1/still-v2.jpg")
    v3_video = _asset(store, s3_client, sid, "final_video", 3, 1, "final/v3.mp4")
    seed(store, f"STORY#{sid}", ws.TYPE_STORY, storyId=sid, title="Ice", status="review", scriptVersion=3,
         videoKey=v3_video, stillKeys={"s1": v2_still}, version=4)  # fmt: skip
    busy = "01JD00000000000000000000S2"
    busy_old = _asset(store, s3_client, busy, "final_video", 1, 0, "final/v1.mp4")
    seed(store, f"STORY#{busy}", ws.TYPE_STORY, storyId=busy, title="Busy", status="producing", scriptVersion=5,
         currentJobId="01JD00000000000000000000J9", version=2)  # fmt: skip
    removed = _cleanup(wcall)
    assert removed == {"files": 2, "bytes": 200}
    assert v1_video not in s3_client.objects
    assert v2_board not in s3_client.objects
    assert f"{prefix()}stories/{sid}/script/v2.writer.json" not in s3_client.objects
    assert v1_board in s3_client.objects  # the writer's newest storyboard is always kept
    assert v2_still in s3_client.objects  # the story still names it
    assert v3_video in s3_client.objects
    assert busy_old in s3_client.objects  # its job may be writing right now
    kinds = sorted((a["kind"], a["version"]) for a in table.all() if a["sk"].startswith("ASSET#"))
    assert ("final_video", 1) in kinds  # the busy story's
    assert ("storyboard", 2) not in kinds
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}


def test_a_key_outside_the_workspace_is_never_deleted(wcall: WsCall, store: db.Store, s3_client: FakeS3) -> None:
    _keep(store, keepReferences="study_only", keepChatPictures="days_30")
    s3_client.objects["uploads/clip-factory/video.mp4"] = b"clip factory"
    s3_client.objects[f"ws/{USER}/other-ws/references/x/source.mp4"] = b"other"
    seed(store, f"REFVID#{REF_A}", ws.TYPE_REFVID, refId=REF_A, title="x", status="analyzed", bytes=1,
         key="uploads/clip-factory/video.mp4", analysisKey="x")  # fmt: skip
    seed(store, f"REFVID#{REF_B}", ws.TYPE_REFVID, refId=REF_B, title="y", status="analyzed", bytes=1,
         key=f"ws/{USER}/other-ws/references/x/source.mp4", analysisKey="x")  # fmt: skip
    seed(store, "MSG#c#m", ws.TYPE_MSG, convId="c", msgId="m", role="user", createdAt=OLD,
         attachments=[{"assetId": "z", "key": "uploads/clip-factory/video.mp4", "bytes": 9}])  # fmt: skip
    _cleanup(wcall)
    assert "uploads/clip-factory/video.mp4" in s3_client.objects
    assert f"ws/{USER}/other-ws/references/x/source.mp4" in s3_client.objects


def test_one_call_is_bounded_and_the_next_goes_on(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(retention, "MAX_FILES", 3)
    _keep(store, keepReferences="study_only")
    for ref_id in (REF_A, REF_B, REF_C):
        _reference(store, s3_client, ref_id)
    calls = [_cleanup(wcall) for _ in range(4)]
    assert calls[:3] == [{"files": 3, "bytes": 5000}] * 3  # one video's file and two frames per call
    assert calls[3] == {"files": 0, "bytes": 0}
    assert not [k for k in s3_client.objects if k.endswith("source.mp4")]


def test_cleanup_is_a_lamo_stories_route_with_no_body(wcall: WsCall) -> None:
    assert wcall("POST", f"{BASE}/storage/cleanup", {"everything": True})[0] == 400
    status, body = wcall("POST", "/v1/workspaces/clips/storage/cleanup", {})
    assert (status, body["error"]["message"]) == (409, "That is a Lamo Stories page. Switch to Lamo Stories first.")
    assert wcall("POST", "/v1/workspaces/01JD0000000000000000000000/storage/cleanup", {})[0] == 404
