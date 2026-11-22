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
AGENT_AT = "2026-11-10T10:00:00.000Z"  # when the agent cleared a reference after a job


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
    # the same marker Lamo Stories' agent writes after a job (one attribute for both, §45.35 D9)
    assert item["fileRemovedAt"] == "2026-11-15T12:00:00.000Z"
    assert "sourceRemovedAt" not in item  # the earlier name is only read, never written
    assert item["note"] == "The video was removed to save space. Its study stays."
    assert (item["status"], item["title"]) == ("analyzed", "Skid")
    # the page shows the study without the video, and studying it again is refused with the same words
    status, got = wcall("GET", f"{BASE}/references/{REF_A}")
    assert status == 200
    assert "url" not in got["reference"]
    assert got["reference"]["status"] == "analyzed"
    assert (got["reference"]["fileRemoved"], got["reference"]["bytes"]) == (True, 0)
    assert got["reference"]["studyKept"] is True  # "Its study stays." (§45.35 D9)
    kept = wcall("GET", f"{BASE}/references/{REF_B}")[1]["reference"]
    assert (kept["fileRemoved"], kept["studyKept"]) == (False, False)
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


# --- the agent's marker, the order of the writes, and the bound inside one story (review round) -----------------


def test_a_reference_the_agent_cleared_is_shown_cleared_and_never_counted_again(
    wcall: WsCall, store: db.Store, s3_client: FakeS3
) -> None:
    """Lamo Stories' agent clears a reference after a job with ``fileRemovedAt`` and ``note`` (§45.35 D9): no link
    to the file that is gone, nothing in storage, Analyze says why, and the API's cleanup does not count it again."""
    _keep(store, keepReferences="study_only")
    _reference(
        store, s3_client, REF_A, fileRemovedAt=AGENT_AT, note="The video was removed to save space. Its study stays."
    )
    folder = f"{prefix()}references/{REF_A}/"
    for key in (f"{folder}source.mp4", f"{folder}frames/0001.jpg", f"{folder}frames/0002.jpg"):
        del s3_client.objects[key]  # the agent deleted them
    status, got = wcall("GET", f"{BASE}/references/{REF_A}")
    assert status == 200
    assert "url" not in got["reference"]
    assert (got["reference"]["fileRemoved"], got["reference"]["bytes"]) == (True, 0)
    listed = wcall("GET", f"{BASE}/references")[1]["references"]
    assert [r["fileRemoved"] for r in listed] == [True]
    assert wcall("GET", f"{BASE}/storage")[1]["storage"]["bytes"]["references"] == 0
    status, refused = wcall("POST", f"{BASE}/references/{REF_A}/analyze", {})
    assert (status, refused["error"]["message"]) == (409, "The video was removed to save space. Its study stays.")
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}
    assert leaked([got, listed]) == []


def test_an_older_reference_cleared_under_the_earlier_mark_name_still_reads_cleared(
    wcall: WsCall, store: db.Store, s3_client: FakeS3
) -> None:
    """Round 3's API wrote ``sourceRemovedAt``: such an item still reads as cleared (no migration, §45.35 D9)."""
    _reference(store, s3_client, REF_A, sourceRemovedAt=AGENT_AT)
    shown = wcall("GET", f"{BASE}/references/{REF_A}")[1]["reference"]
    assert (shown["fileRemoved"], shown["studyKept"], "url" in shown) == (True, True, False)


def test_a_never_studied_video_cleared_by_age_keeps_no_study_and_says_so(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    """``days_30`` also clears a reference that was never studied (``ready`` or ``failed``): it is stored with the
    plain note, answers ``studyKept: false`` (the page says only "The video was removed to save space."), and
    Analyze says the same, never "Its study stays." (§45.35 D9)."""
    _keep(store, keepReferences="days_30")
    _reference(store, s3_client, REF_A, created=OLD, status="ready", analysisKey=None)
    _reference(store, s3_client, REF_B, created=OLD, status="failed", analysisKey=None)
    _reference(store, s3_client, REF_C, created=OLD)  # studied: its study stays
    assert _cleanup(wcall)["files"] == 9
    for ref_id, kept in ((REF_A, False), (REF_B, False), (REF_C, True)):
        item = table.raw(pk(), f"REFVID#{ref_id}")
        assert item["fileRemovedAt"] == "2026-11-15T12:00:00.000Z"
        assert item["note"] == (
            "The video was removed to save space. Its study stays." if kept else "The video was removed to save space."
        )
        shown = wcall("GET", f"{BASE}/references/{ref_id}")[1]["reference"]
        assert (shown["fileRemoved"], shown["studyKept"]) == (True, kept), ref_id
    status, refused = wcall("POST", f"{BASE}/references/{REF_A}/analyze", {})
    assert (status, refused["error"]["message"]) == (409, "The video was removed to save space.")
    status, refused = wcall("POST", f"{BASE}/references/{REF_C}/analyze", {})
    assert (status, refused["error"]["message"]) == (409, "The video was removed to save space. Its study stays.")


def test_cleanup_marks_a_reference_before_deleting_its_file(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _keep(store, keepReferences="study_only")
    # a study started between the read and the mark: the mark is refused and the file stays
    _reference(store, s3_client, REF_A, status="analyzing", currentJobId="01JD00000000000000000000J1")
    monkeypatch.setattr(retention, "_ref_due", lambda item, keep, now: True)
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}
    assert f"{prefix()}references/{REF_A}/source.mp4" in s3_client.objects
    assert not {"fileRemovedAt", "sourceRemovedAt"} & set(table.raw(pk(), f"REFVID#{REF_A}"))
    monkeypatch.undo()
    # S3 refuses the delete: the mark is taken back, so the next cleanup tries again
    _reference(store, s3_client, REF_B)
    real = s3_client.delete_object

    def refuse(**kw: Any) -> Any:
        raise RuntimeError("S3 is down")

    s3_client.delete_object = refuse  # type: ignore[method-assign]
    status, _ = wcall("POST", f"{BASE}/storage/cleanup", {})
    assert status >= 500
    assert not {"fileRemovedAt", "sourceRemovedAt", "note"} & set(table.raw(pk(), f"REFVID#{REF_B}"))
    assert "url" in wcall("GET", f"{BASE}/references/{REF_B}")[1]["reference"]
    s3_client.delete_object = real  # type: ignore[method-assign]
    assert _cleanup(wcall) == {"files": 3, "bytes": 5000}


@pytest.mark.parametrize("mark", ["fileRemovedAt", "sourceRemovedAt"])  # the name both write, and the earlier one
def test_analyze_never_starts_on_a_file_a_cleanup_marked_meanwhile(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch, mark: str
) -> None:
    """The cleanup's mark lands between Analyze's read and its write: the write's condition refuses it."""
    from clipfactory_api.workspaces import references

    _reference(store, s3_client, REF_A, **{mark: AGENT_AT})
    monkeypatch.setattr(references, "settle", lambda app, item, now: {k: v for k, v in item.items()
                                                                       if k != mark})  # fmt: skip
    status, body = wcall("POST", f"{BASE}/references/{REF_A}/analyze", {})
    assert (status, body["error"]["message"]) == (409, "The video was removed to save space. Its study stays.")
    assert not [i for i in table.all() if i["sk"].startswith("PJOB#")]
    assert table.raw(pk(), f"REFVID#{REF_A}")["status"] == "analyzed"


def test_chat_pictures_the_agent_cleared_are_not_counted_and_others_stay(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    conv = "01JD00000000000000000000CV"
    seed(store, f"CONV#{conv}", ws.TYPE_CONV, convId=conv, title="Ice", model=None, effort=None)
    gone, there = f"{prefix()}chat/{conv}/gone.png", f"{prefix()}chat/{conv}/there.png"
    elsewhere = f"{prefix()}design/other.png"  # inside the workspace, outside this chat: never deleted here
    s3_client.objects[there] = b"pngpng"
    s3_client.objects[elsewhere] = b"png"
    msg = "01JD00000000000000000000M1"
    seed(store, f"MSG#{conv}#{msg}", ws.TYPE_MSG, convId=conv, msgId=msg, role="user", text="Look", status="done",
         createdAt=OLD, attachments=[{"assetId": "g", "key": gone, "contentType": "image/png", "bytes": 300},
                                     {"assetId": "t", "key": there, "contentType": "image/png", "bytes": 6},
                                     {"assetId": "e", "key": elsewhere, "contentType": "image/png", "bytes": 3}])  # fmt: skip
    # while every picture is kept, every link is made
    assert len(wcall("GET", f"{BASE}/chat/{conv}")[1]["messages"][0]["attachments"]) == 3
    _keep(store, keepChatPictures="days_30")
    # the setting is on and the agent has cleared one: no link is made to a chat picture that old
    shown = wcall("GET", f"{BASE}/chat/{conv}")[1]["messages"][0]["attachments"]
    assert [a["assetId"] for a in shown] == ["e"]
    assert _cleanup(wcall) == {"files": 1, "bytes": 6}  # only the picture still there
    assert there not in s3_client.objects
    assert elsewhere in s3_client.objects
    item = table.raw(pk(), f"MSG#{conv}#{msg}")
    assert [a["assetId"] for a in item["attachments"]] == ["e"]
    assert _cleanup(wcall) == {"files": 0, "bytes": 0}


def test_one_story_with_more_old_files_than_one_call_takes_is_cleared_over_several_calls(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(retention, "MAX_FILES", 10)
    _keep(store, keepVersions=1)
    sid = "01JD00000000000000000000S1"
    keys = [_asset(store, s3_client, sid, "scene_still", v, 0, f"scenes/s{n}/still-v{v}.jpg")
            for v in (1, 2, 3) for n in range(5)]  # fmt: skip
    current = _asset(store, s3_client, sid, "final_video", 4, 1, "final/v4.mp4")
    seed(store, f"STORY#{sid}", ws.TYPE_STORY, storyId=sid, title="Ice", status="review", scriptVersion=4,
         videoKey=current, version=4)  # fmt: skip
    first = _cleanup(wcall)
    assert first == {"files": 5, "bytes": 500}  # 5 files and their 5 rows: the call's 10
    rows = [a for a in table.all() if a["sk"].startswith("ASSET#")]
    assert len(rows) == 11
    # every row left still names a file that is there, and every file deleted lost its row
    assert all(a["key"] in s3_client.objects for a in rows)
    calls = [_cleanup(wcall) for _ in range(3)]
    assert calls == [{"files": 5, "bytes": 500}, {"files": 5, "bytes": 500}, {"files": 0, "bytes": 0}]
    assert not [k for k in keys if k in s3_client.objects]
    assert current in s3_client.objects
    assert [a["key"] for a in table.all() if a["sk"].startswith("ASSET#")] == [current]


def test_a_failed_file_delete_keeps_its_row_for_the_next_call(
    wcall: WsCall, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    _keep(store, keepVersions=1)
    sid = "01JD00000000000000000000S1"
    old = _asset(store, s3_client, sid, "final_video", 1, 0, "final/v1.mp4")
    current = _asset(store, s3_client, sid, "final_video", 2, 1, "final/v2.mp4")
    seed(store, f"STORY#{sid}", ws.TYPE_STORY, storyId=sid, title="Ice", status="review", scriptVersion=2,
         videoKey=current, version=4)  # fmt: skip
    real = s3_client.delete_object

    def refuse(**kw: Any) -> Any:
        raise RuntimeError("S3 is down")

    s3_client.delete_object = refuse  # type: ignore[method-assign]
    assert wcall("POST", f"{BASE}/storage/cleanup", {})[0] >= 500
    assert [a["key"] for a in table.all() if a["sk"].startswith("ASSET#") and a["key"] == old] == [old]
    s3_client.delete_object = real  # type: ignore[method-assign]
    assert _cleanup(wcall) == {"files": 1, "bytes": 100}
    assert old not in s3_client.objects
