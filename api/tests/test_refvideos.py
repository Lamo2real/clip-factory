"""The owner's reference videos, "Edit like these" (docs/CONTRACTS.md §57): routes, limits, stale uploads, the agent
start on complete and "Try again". In-memory items, the fake bucket and the fake agent runtime only."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest

from clipfactory_api import db, refvideos
from clipfactory_api.agent_client import AgentClient, AgentError
from conftest import NOW, OTHER, USER, Call, Clock
from fakes import FakeAgentCore, FakeS3, FakeTable

WRONG = "That file is not a video we can use. Use MP4, MOV or WebM up to 500 MB."
FULL = "You have 10 reference videos. Delete one first."
GONE = "We could not find that video."
NO_START = "We could not look at this video. Try again."
F1 = "01HREFFAILED00000000000001"
S1 = "01HREFSTUCK000000000000001"
BUCKET_URL = "https://cf-prod-media-123.s3.eu-north-1.amazonaws.com/refs/"


def start(call: Call, *, name: str = "My Edit.mp4", content_type: str = "video/mp4", size: int = 1000) -> str:
    status, made = call("POST", "/v1/refvideos", {"filename": name, "contentType": content_type, "size": size})
    assert status == 201, made
    return str(made["refId"])


def upload(s3_client: FakeS3, ref_id: str, size: int = 1000) -> str:
    key = next(p[1]["Key"] for p in s3_client.presigned if p[0] == "put_object" and ref_id in p[1]["Key"])
    s3_client.objects[key] = b"v" * size
    return str(key)


def add(call: Call, s3_client: FakeS3, **kw: Any) -> tuple[int, Any, str]:
    ref_id = start(call, **kw)
    upload(s3_client, ref_id, kw.get("size", 1000))
    return (*call("POST", f"/v1/refvideos/{ref_id}/complete"), ref_id)


def item(table: FakeTable, ref_id: str, user: str = USER) -> dict[str, Any] | None:
    return table.raw(db.user_pk(user), refvideos.sk(ref_id))


def seed(table: FakeTable, ref_id: str, **fields: Any) -> dict[str, Any]:
    row = refvideos.new_item(
        USER,
        ref_id,
        refvideos.object_key(USER, ref_id, "mp4"),
        name=ref_id,
        content_type="video/mp4",
        size=10,
        now=fields.pop("now", NOW),
    )
    row.update(fields)
    table.items[(row["pk"], row["sk"])] = row
    return row


# --- adding one --------------------------------------------------------------------------------------------------


def test_create_gives_a_sized_signed_put_and_an_uploading_item(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    status, body = call(
        "POST",
        "/v1/refvideos",
        {"filename": "C:\\clips\\Best Edit!.mov", "contentType": "video/quicktime", "size": 5000},
    )
    assert status == 201
    ref_id = body["refId"]
    assert set(body) == {"refId", "uploadUrl", "headers"}
    assert body["uploadUrl"].startswith(BUCKET_URL)
    assert body["headers"] == {"Content-Type": "video/quicktime"}
    op, params, seconds = s3_client.presigned[-1]
    assert (op, params["Key"], params["ContentType"], params["ContentLength"]) == (
        "put_object",
        f"refs/{USER}/{ref_id}.mov",
        "video/quicktime",
        5000,
    )
    assert seconds == 3600
    stored = item(table, ref_id)
    assert stored is not None
    assert (stored["status"], stored["name"], stored["analyzeRev"], stored["type"]) == (
        "uploading",
        "Best-Edit",
        0,
        "refvideo",
    )


@pytest.mark.parametrize(
    ("content_type", "ext"), [("video/mp4", "mp4"), ("video/webm", "webm"), ("video/x-m4v", "m4v")]
)
def test_every_video_type_keeps_its_own_extension(call: Call, table: FakeTable, content_type: str, ext: str) -> None:
    ref_id = start(call, content_type=content_type)
    stored = item(table, ref_id)
    assert stored is not None
    assert stored["key"] == f"refs/{USER}/{ref_id}.{ext}"


@pytest.mark.parametrize(
    "body",
    [
        {"filename": "a.avi", "contentType": "video/x-msvideo", "size": 10},
        {"filename": "a.png", "contentType": "image/png", "size": 10},
        {"filename": "a.mp4", "contentType": "video/mp4", "size": 500 * 1024 * 1024 + 1},
        {"filename": "a.mp4", "contentType": "video/mp4", "size": 0},
        {"filename": "a.mp4", "contentType": "video/mp4", "size": True},
        {"filename": "a.mp4", "contentType": "video/mp4"},
    ],
)
def test_create_refuses_other_types_and_sizes_with_one_sentence(
    call: Call, table: FakeTable, body: dict[str, Any]
) -> None:
    status, out = call("POST", "/v1/refvideos", body)
    assert (status, out["error"]["message"]) == (400, WRONG)
    assert not [i for i in table.all() if i["sk"].startswith("REFVID#")]


def test_the_largest_file_is_allowed(call: Call) -> None:
    start(call, size=500 * 1024 * 1024)


def test_create_refuses_unknown_fields(call: Call) -> None:
    assert call("POST", "/v1/refvideos", {"filename": "a.mp4", "contentType": "video/mp4", "size": 1, "x": 1})[0] == 400
    assert call("POST", "/v1/refvideos", {"contentType": "video/mp4", "size": 1})[0] == 400


def test_at_most_ten_and_stale_uploads_are_cleared(
    call: Call, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    for n in range(9):
        seed(table, f"R{n}", status="ready")
    stale = seed(table, "OLD", now=NOW - timedelta(hours=2))
    s3_client.objects[stale["key"]] = b"partial"
    start(call)  # the tenth; the stale upload did not count and is gone with its file
    assert item(table, "OLD") is None
    assert stale["key"] in s3_client.deleted
    status, out = call("POST", "/v1/refvideos", {"filename": "a.mp4", "contentType": "video/mp4", "size": 1})
    assert (status, out["error"]["message"]) == (409, FULL)


# --- complete: the agent starts ------------------------------------------------------------------------------------


def test_complete_starts_the_agent_once_with_a_fresh_session(
    call: Call, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    status, body, ref_id = add(call, s3_client)
    assert status == 202
    video = body["refvideo"]
    assert (video["refId"], video["status"], video["name"]) == (ref_id, "analyzing", "My-Edit")
    assert video["videoUrl"].startswith(BUCKET_URL)
    assert "thumbUrl" not in video
    assert "error" not in video
    (sent,) = agentcore.calls
    assert sent["payload"] == {"action": "reference", "userId": USER, "refId": ref_id, "rev": 1}
    assert sent["runtimeSessionId"].startswith(f"cfjob-{ref_id}-")
    stored = item(table, ref_id)
    assert stored is not None
    assert (stored["status"], stored["analyzeRev"], stored["analyzeStartedAt"]) == (
        "analyzing",
        1,
        "2026-11-15T12:00:00.000Z",
    )


def test_complete_again_while_looking_or_ready_does_not_ask_twice(
    call: Call, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    _status, _body, ref_id = add(call, s3_client)
    status, body = call("POST", f"/v1/refvideos/{ref_id}/complete")
    assert (status, body["refvideo"]["status"]) == (202, "analyzing")
    table.items[(db.user_pk(USER), refvideos.sk(ref_id))]["status"] = "ready"
    status, body = call("POST", f"/v1/refvideos/{ref_id}/complete")
    assert (status, body["refvideo"]["status"]) == (200, "ready")
    assert len(agentcore.calls) == 1


def test_complete_without_the_file_or_with_the_wrong_size(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    ref_id = start(call, size=1000)
    status, out = call("POST", f"/v1/refvideos/{ref_id}/complete")
    assert (status, out["error"]["message"]) == (400, WRONG)
    assert item(table, ref_id) is not None  # not uploaded yet: kept for the upload
    key = upload(s3_client, ref_id, size=999)
    status, out = call("POST", f"/v1/refvideos/{ref_id}/complete")
    assert (status, out["error"]["message"]) == (400, WRONG)
    assert item(table, ref_id) is None
    assert key in s3_client.deleted


def test_try_again_on_a_failed_video_bumps_the_rev_and_clears_the_error(
    call: Call, table: FakeTable, agentcore: FakeAgentCore
) -> None:
    seed(table, F1, status="failed", analyzeRev=3, error="We could not read this video. Try again.")
    status, body = call("POST", f"/v1/refvideos/{F1}/complete")
    assert status == 202
    assert body["refvideo"]["status"] == "analyzing"
    assert "error" not in body["refvideo"]
    stored = item(table, F1)
    assert stored is not None
    assert stored["analyzeRev"] == 4
    assert "error" not in stored
    assert agentcore.calls[-1]["payload"]["rev"] == 4


def test_a_look_stuck_for_twenty_minutes_may_start_again(
    call: Call, table: FakeTable, agentcore: FakeAgentCore, clock: Clock
) -> None:
    seed(table, S1, status="analyzing", analyzeRev=1, analyzeStartedAt="2026-11-15T11:45:00.000Z")
    assert call("POST", f"/v1/refvideos/{S1}/complete")[0] == 202
    assert agentcore.calls == []  # 15 minutes: still looking
    clock.now = NOW + timedelta(minutes=6)
    assert call("POST", f"/v1/refvideos/{S1}/complete")[0] == 202
    assert [c["payload"]["rev"] for c in agentcore.calls] == [2]
    assert len({c["runtimeSessionId"] for c in agentcore.calls}) == 1


@pytest.mark.parametrize("way", ["unreachable", "refused"])
def test_an_agent_that_cannot_start_leaves_a_failed_video_and_503(
    call: Call, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore, way: str
) -> None:
    if way == "unreachable":
        agentcore.fail = True
    else:
        agentcore.reply = {"accepted": False}
    status, out, ref_id = add(call, s3_client)
    assert (status, out["error"]["message"]) == (503, NO_START)
    stored = item(table, ref_id)
    assert stored is not None
    assert (stored["status"], stored["error"], stored["analyzeRev"]) == ("failed", NO_START, 1)
    agentcore.fail, agentcore.reply = False, None
    status, body = call("POST", f"/v1/refvideos/{ref_id}/complete")  # Try again
    assert (status, body["refvideo"]["status"]) == (202, "analyzing")
    assert agentcore.calls[-1]["payload"]["rev"] == 2


def test_complete_of_another_owners_or_an_unknown_video_is_404(call: Call, s3_client: FakeS3) -> None:
    ref_id = start(call)
    upload(s3_client, ref_id)
    status, out = call("POST", f"/v1/refvideos/{ref_id}/complete", sub=OTHER)
    assert (status, out["error"]["message"]) == (404, GONE)
    assert call("POST", "/v1/refvideos/not-an-id!/complete")[0] == 404
    assert call("POST", f"/v1/refvideos/{ref_id}/complete", {"x": 1})[0] == 400


# --- the list --------------------------------------------------------------------------------------------------------


def test_list_is_newest_first_without_uploads_and_with_the_agents_result(call: Call, table: FakeTable) -> None:
    seed(
        table,
        "A1",
        status="ready",
        now=NOW - timedelta(days=2),
        thumbKey=refvideos.thumb_key(USER, "A1"),
        summary=["Big yellow words", "Cuts every second"],
        unsupported=["Added music"],
        duration=Decimal("31.5"),
        style={"captions": {"present": True}},
    )
    seed(table, "B2", status="failed", now=NOW - timedelta(days=1), error="We could not read this video. Try again.")
    seed(table, "C3", status="uploading")
    seed(table, "D4", status="ready", thumbKey=f"refs/{OTHER}/D4-thumb.jpg")  # never another owner's file
    status, body = call("GET", "/v1/refvideos")
    assert status == 200
    videos = body["refvideos"]
    assert [v["refId"] for v in videos] == ["D4", "B2", "A1"]
    a1 = videos[2]
    assert set(a1) == {
        "refId",
        "name",
        "status",
        "createdAt",
        "videoUrl",
        "thumbUrl",
        "summary",
        "unsupported",
        "duration",
    }
    assert a1["thumbUrl"].startswith(BUCKET_URL)
    assert "A1-thumb.jpg" in a1["thumbUrl"]
    assert (a1["summary"], a1["unsupported"], a1["duration"]) == (
        ["Big yellow words", "Cuts every second"],
        ["Added music"],
        31.5,
    )
    assert videos[1]["error"] == "We could not read this video. Try again."
    assert "thumbUrl" not in videos[0]
    assert call("GET", "/v1/refvideos", sub=OTHER)[1] == {"refvideos": []}


# --- delete ----------------------------------------------------------------------------------------------------------


def test_delete_removes_the_item_then_the_video_and_thumbnail(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    _status, _body, ref_id = add(call, s3_client)
    thumb = refvideos.thumb_key(USER, ref_id)
    s3_client.objects[thumb] = b"jpg"
    table.items[(db.user_pk(USER), refvideos.sk(ref_id))]["thumbKey"] = thumb
    assert call("DELETE", f"/v1/refvideos/{ref_id}", sub=OTHER)[0] == 404
    assert call("DELETE", f"/v1/refvideos/{ref_id}") == (204, None)
    assert item(table, ref_id) is None
    work = {f"refs/{USER}/{ref_id}-work-1.m4a", f"refs/{USER}/{ref_id}-work-1.json"}  # a stopped agent's leftovers
    assert set(s3_client.deleted) == {f"refs/{USER}/{ref_id}.mp4", thumb, *work}
    status, out = call("DELETE", f"/v1/refvideos/{ref_id}")
    assert (status, out["error"]["message"]) == (404, GONE)


def test_delete_never_touches_a_file_outside_the_owners_folder(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    seed(table, "X1", status="ready", key="uploads/someone/else.mp4", thumbKey="refs/other/deeper/x.jpg")
    assert call("DELETE", "/v1/refvideos/X1")[0] == 204
    assert s3_client.deleted == [refvideos.thumb_key(USER, "X1")]


# --- the agent client ----------------------------------------------------------------------------------------------


def test_agent_client_reference_payload_and_refusal() -> None:
    fake = FakeAgentCore()
    client = AgentClient(fake, "arn:runtime")
    client.reference("U", "01HREF0000000000000000000A", 3)
    (sent,) = fake.calls
    assert sent["payload"] == {"action": "reference", "userId": "U", "refId": "01HREF0000000000000000000A", "rev": 3}
    assert len(sent["runtimeSessionId"]) == 41
    fake.reply = {"accepted": False}
    with pytest.raises(AgentError):
        client.reference("U", "01HREF0000000000000000000A", 4)
    fake.reply = {"error": "busy"}
    with pytest.raises(AgentError):
        client.reference("U", "01HREF0000000000000000000A", 5)
    with pytest.raises(AgentError):
        AgentClient(FakeAgentCore(), "").reference("U", "01HREF0000000000000000000A", 1)
