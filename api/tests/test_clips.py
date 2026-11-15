from __future__ import annotations

from datetime import timedelta

import pytest

from clipfactory_api import db, posts
from conftest import CAPTIONS, OTHER, USER, Call, Clock, seed_clip
from fakes import FakeS3, FakeSQS, FakeTable


def test_list_defaults_to_review(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    review = seed_clip(store, s3_client)
    seed_clip(store, s3_client, status="posted")
    seed_clip(store, s3_client, user=OTHER)
    status, body = call("GET", "/v1/clips")
    assert status == 200
    assert [c["clipId"] for c in body["clips"]] == [review["clipId"]]
    clip = body["clips"][0]
    assert clip["videoUrl"].endswith("op=get_object&X-Amz-Signature=fake")
    assert clip["coverUrl"]
    assert clip["durationSec"] == 31.5
    assert clip["score"] == 8
    for hidden in ("pk", "sk", "gsi1pk", "gsi1sk", "type", "userId", "videoKey", "coverKey"):
        assert hidden not in clip


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("review", {"review"}),
        ("confirmed", {"confirmed", "publishing", "failed"}),
        ("posted", {"posted"}),
        ("declined", {"declined"}),
        ("all", {"review", "confirmed", "publishing", "failed", "posted", "declined"}),
    ],
)
def test_list_by_status(call: Call, store: db.Store, status: str, expected: set[str]) -> None:
    for state in ("review", "confirmed", "publishing", "failed", "posted", "declined"):
        seed_clip(store, status=state)
    _, body = call("GET", "/v1/clips", query={"status": status})
    assert {c["status"] for c in body["clips"]} == expected


def test_list_by_job(call: Call, store: db.Store) -> None:
    job_id = "01JABCDEFGHJKMNPQRSTVWXYZ0"
    a = seed_clip(store, job_id=job_id, rank=2)
    b = seed_clip(store, job_id=job_id, rank=1)
    seed_clip(store)
    _, body = call("GET", "/v1/clips", query={"jobId": job_id, "status": "all"})
    assert [c["clipId"] for c in body["clips"]] == [b["clipId"], a["clipId"]]


def test_list_rejects_bad_query(call: Call) -> None:
    assert call("GET", "/v1/clips", query={"status": "nope"})[0] == 400
    assert call("GET", "/v1/clips", query={"jobId": "bad"})[0] == 400


def test_declined_clip_has_no_links(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="declined")
    _, body = call("GET", f"/v1/clips/{clip['clipId']}")
    assert "videoUrl" not in body["clip"]


def test_get_clip_not_found_for_other_owner(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, user=OTHER)
    assert call("GET", f"/v1/clips/{clip['clipId']}")[0] == 404


def test_patch_captions(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    status, body = call("PATCH", f"/v1/clips/{clip['clipId']}", {"captions": {"x": "new x", "tiktok": ""}})
    assert status == 200
    assert body["clip"]["captions"] == {**CAPTIONS, "x": "new x", "tiktok": ""}


@pytest.mark.parametrize(
    "captions",
    [{"snapchat": "x"}, {"x": 5}, {"x": "a" * 281}, {"youtubeTitle": "t" * 101}, "text"],
)
def test_patch_captions_validation(call: Call, store: db.Store, captions: object) -> None:
    clip = seed_clip(store)
    assert call("PATCH", f"/v1/clips/{clip['clipId']}", {"captions": captions})[0] == 400


def test_patch_requires_captions_and_review(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    assert call("PATCH", f"/v1/clips/{clip['clipId']}", {})[0] == 400
    done = seed_clip(store, status="confirmed")
    assert call("PATCH", f"/v1/clips/{done['clipId']}", {"captions": {"x": "y"}})[0] == 409


def test_confirm_creates_posts_and_enqueues(call: Call, store: db.Store, sqs: FakeSQS, table: FakeTable) -> None:
    call("PUT", "/v1/settings", {"platforms": ["tiktok", "youtube"]})
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"captions": {"tiktok": "edited"}})
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    assert body["clip"]["decidedAt"] == "2026-11-15T12:00:00.000Z"
    assert body["clip"]["captions"]["tiktok"] == "edited"
    assert [p["platform"] for p in body["posts"]] == ["youtube", "tiktok"]
    assert all(p["status"] == "pending_integration" for p in body["posts"])
    assert sqs.sent == [{"QueueUrl": sqs.sent[0]["QueueUrl"], "body": {"userId": USER, "clipId": clip["clipId"]}}]
    stored = table.raw(db.user_pk(USER), db.post_sk(body["posts"][0]["postId"]))
    assert stored is not None
    assert stored["gsi1pk"] == f"CLIP#{clip['clipId']}"
    assert stored["gsi1sk"] == "POST#youtube"


def test_confirm_queues_post_for_connected_platform(call: Call, store: db.Store) -> None:
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "ACCOUNT#youtube#1",
            "platform": "youtube",
            "status": "connected",
            "handle": "@me",
        }
    )
    clip = seed_clip(store)
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    statuses = {p["platform"]: p["status"] for p in body["posts"]}
    assert statuses["youtube"] == "queued"
    assert statuses["x"] == "pending_integration"
    assert len(statuses) == 5


def test_confirm_twice_conflicts(call: Call, store: db.Store, sqs: FakeSQS) -> None:
    clip = seed_clip(store)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 200
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 409
    assert len(sqs.sent) == 1


def test_confirm_survives_queue_failure(call: Call, store: db.Store, sqs: FakeSQS) -> None:
    sqs.fail = True
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    for hidden in ("publishState", "publishClaimAt"):
        assert hidden not in body["clip"]


def test_confirm_again_resumes_an_unfinished_confirm(
    call: Call, store: db.Store, sqs: FakeSQS, table: FakeTable, clock: Clock
) -> None:
    call("PUT", "/v1/settings", {"platforms": ["youtube", "tiktok", "x"]})
    clip = seed_clip(store)
    sqs.fail = True
    _, first = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert table.raw(clip["pk"], clip["sk"])["publishState"] == "pending"  # type: ignore[index]
    # Simulate a Confirm that died part-way: one post is missing.
    table.items.pop((db.user_pk(USER), db.post_sk(first["posts"][-1]["postId"])))
    sqs.fail = False
    # Straight away it is still a conflict: the first request might still be running.
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 409
    clock.now += timedelta(minutes=2)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert sorted(p["platform"] for p in body["posts"]) == ["tiktok", "x", "youtube"]
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 3  # no duplicates
    assert [m["body"] for m in sqs.sent] == [{"userId": USER, "clipId": clip["clipId"]}]
    assert table.raw(clip["pk"], clip["sk"])["publishState"] == "enqueued"  # type: ignore[index]
    # Once queued, it is decided for good.
    clock.now += timedelta(minutes=2)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 409
    assert len(sqs.sent) == 1


def test_decline_deletes_files(call: Call, store: db.Store, s3_client: FakeS3, table: FakeTable) -> None:
    clip = seed_clip(store, s3_client)
    other = seed_clip(store, s3_client)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/decline")
    assert status == 200
    assert body["clip"]["status"] == "declined"
    assert "videoUrl" not in body["clip"]
    assert clip["videoKey"] not in s3_client.objects
    assert clip["coverKey"] not in s3_client.objects
    assert other["videoKey"] in s3_client.objects
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert "videoKey" not in stored


def test_decline_only_in_review(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(store, s3_client, status="confirmed")
    assert call("POST", f"/v1/clips/{clip['clipId']}/decline")[0] == 409
    assert clip["videoKey"] in s3_client.objects
