from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db, posts
from conftest import CAPTIONS, CLIP_FLOW_ARN, OTHER, USER, Call, seed_clip
from fakes import FakeLambda, FakeS3, FakeS3Vectors, FakeTable


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


def _clip_flow_calls(lambda_client: FakeLambda) -> list[dict[str, Any]]:
    return [c for c in lambda_client.calls if c["FunctionName"] == CLIP_FLOW_ARN]


def test_confirm_creates_posts_and_starts_the_clip_flow(
    call: Call, store: db.Store, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"captions": {"x": "edited"}})
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    assert body["clip"]["captions"]["x"] == "edited"
    assert body["clip"]["decidedAt"] == "2026-11-15T12:00:00.000Z"
    for hidden in ("publishState", "postsCreated", "flowRun", "flowExecutionArn", "videoKey", "coverKey"):
        assert hidden not in body["clip"]
    assert {p["platform"] for p in body["posts"]} == {"youtube", "instagram", "facebook", "tiktok", "x"}
    assert {p["status"] for p in body["posts"]} == {"pending_integration"}
    (start,) = _clip_flow_calls(lambda_client)
    assert start["InvocationType"] == "Event"
    assert start["DurableExecutionName"] == f"clip-{clip['clipId']}-1"
    assert start["Payload"] == json.dumps({"clipId": clip["clipId"], "run": 1, "userId": USER}, sort_keys=True)
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert stored["publishState"] == "started"
    assert stored["postsCreated"] is True
    assert stored["flowRun"] == 1
    assert stored["flowExecutionArn"].startswith("arn:aws:lambda:")
    # The clip and its posts are written in one transaction.
    (transaction,) = [kw for op, kw in table.calls if op == "transact_write_items"]
    assert len(transaction["TransactItems"]) == 6


def test_confirm_writes_posts_once(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = seed_clip(store)
    call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 5


def test_confirm_queues_post_for_connected_platform(call: Call, store: db.Store) -> None:
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "ACCOUNT#youtube#1",
            "type": "account",
            "userId": USER,
            "platform": "youtube",
            "status": "connected",
        }
    )
    clip = seed_clip(store)
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    by_platform = {p["platform"]: p["status"] for p in body["posts"]}
    assert by_platform["youtube"] == "queued"
    assert by_platform["x"] == "pending_integration"


def test_confirm_never_tries_a_skipped_platform_that_is_not_connected(call: Call, store: db.Store) -> None:
    """§17.13: a skip only takes a platform off the setup to-do list; posting does not change. A platform that is not
    connected is never tried, skipped or not, and a connected one (skipped while a gate needed the owner) is posted to
    as before."""
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "ACCOUNT#youtube#1",
            "type": "account",
            "userId": USER,
            "platform": "youtube",
            "status": "connected",
        }
    )
    assert call("PUT", "/v1/settings", {"setupSkipped": ["youtube", "tiktok", "x"]})[0] == 200
    clip = seed_clip(store)
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    by_platform = {p["platform"]: p["status"] for p in body["posts"]}
    assert by_platform["youtube"] == "queued"
    assert by_platform["tiktok"] == "pending_integration"
    assert by_platform["x"] == "pending_integration"


def test_confirm_again_while_started_is_a_no_op(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    clip = seed_clip(store)
    first = call("POST", f"/v1/clips/{clip['clipId']}/confirm")[1]
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert len(_clip_flow_calls(lambda_client)) == 1
    assert sorted(p["postId"] for p in body["posts"]) == sorted(p["postId"] for p in first["posts"])


def test_confirm_survives_a_failed_start_and_the_next_confirm_starts_it(
    call: Call, store: db.Store, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = seed_clip(store)
    lambda_client.fail = True
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    assert table.raw(clip["pk"], clip["sk"])["publishState"] == "pending"  # type: ignore[index]
    lambda_client.fail = False
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    names = [c["DurableExecutionName"] for c in _clip_flow_calls(lambda_client)]
    assert names == [f"clip-{clip['clipId']}-1", f"clip-{clip['clipId']}-1"]  # same name and payload: idempotent
    assert table.raw(clip["pk"], clip["sk"])["publishState"] == "started"  # type: ignore[index]
    assert len(body["posts"]) == 5


def test_confirm_already_started_execution_is_a_no_op(
    call: Call, store: db.Store, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = seed_clip(store)
    # The flow is already running (an earlier start whose reply was lost) with another payload.
    lambda_client.started[f"clip-{clip['clipId']}-1"] = "{}"
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert stored["publishState"] == "started"
    assert "flowExecutionArn" not in stored


def test_confirm_of_a_posted_clip_is_a_no_op(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    clip = seed_clip(store, status="posted", publishState="started", postsCreated=True, flowRun=1)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert body["clip"]["status"] == "posted"
    assert _clip_flow_calls(lambda_client) == []


def test_try_again_after_failed_publish_starts_run_two(
    call: Call, store: db.Store, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = seed_clip(store, status="failed", publishState="started", postsCreated=True, flowRun=1)
    pk = db.user_pk(USER)
    for platform, state in (("youtube", "failed"), ("x", "pending_integration")):
        store.put(
            {
                "pk": pk,
                "sk": db.post_sk(f"P{platform}"),
                "gsi1pk": f"CLIP#{clip['clipId']}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": USER,
                "postId": f"P{platform}",
                "clipId": clip["clipId"],
                "platform": platform,
                "status": state,
                **(
                    {"error": "Posting to YouTube did not work. Press Try again.", "publishHandle": {"videoId": "v"}}
                    if state == "failed"
                    else {}
                ),
            }
        )
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    (start,) = _clip_flow_calls(lambda_client)
    assert start["DurableExecutionName"] == f"clip-{clip['clipId']}-2"
    assert json.loads(start["Payload"])["run"] == 2
    statuses = {p["platform"]: p for p in body["posts"]}
    assert statuses["youtube"]["status"] == "queued"
    assert "error" not in statuses["youtube"]
    assert statuses["x"]["status"] == "pending_integration"
    assert "publishHandle" not in (table.raw(pk, db.post_sk("Pyoutube")) or {})  # a fresh upload, not a resume
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert (stored["flowRun"], stored["publishState"]) == (2, "started")


def test_confirm_declined_clip_conflicts(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    clip = seed_clip(store, status="declined")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 409
    assert body["error"]["code"] == "conflict"
    assert lambda_client.calls == []


def test_confirm_race_with_a_parallel_confirm(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip = seed_clip(store)
    real = posts.create_for_clip

    def lose_race(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        # A parallel Confirm finishes first: it created the posts and set publishState pending.
        monkeypatch.setattr(posts, "create_for_clip", real)
        real(*args, **kwargs)
        raise db.ConditionFailed("lost")

    monkeypatch.setattr(posts, "create_for_clip", lose_race)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    assert len(body["posts"]) == 5
    assert len(_clip_flow_calls(lambda_client)) == 1  # the pending flow was started by this request


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


def test_confirm_only_posts_to_enabled_platforms(call: Call, store: db.Store) -> None:
    call("PUT", "/v1/settings", {"platforms": ["tiktok", "youtube"]})
    clip = seed_clip(store)
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert sorted(p["platform"] for p in body["posts"]) == ["tiktok", "youtube"]


# --- vectors: decline and "like clips that did well" ---------------------------------------------------------------


def _vector(
    s3v: FakeS3Vectors, clip_id: str, *, user: str = USER, status: str = "performed", distance: float = 0.1
) -> None:
    s3v.vectors[clip_id] = {
        "key": clip_id,
        "data": {"float32": [0.5] * 1024},
        "metadata": {
            "userId": user,
            "momentType": "rage",
            "platforms": ["youtube"],
            "status": status,
            "scoreBucket": "high",
            "hook": "meta hook",
            "title": "meta title",
            "summary": "s",
            "performance": json.dumps(
                {
                    "views": 1200,
                    "likes": 80,
                    "comments": 4,
                    "shares": 9,
                    "posts": 1,
                    "checkedAt": "2026-11-10T00:00:00.000Z",
                }
            ),
        },
        "distance": distance,
    }


def test_decline_deletes_the_vector(call: Call, store: db.Store, s3v: FakeS3Vectors) -> None:
    clip = seed_clip(store)
    _vector(s3v, clip["clipId"], status="review")
    assert call("POST", f"/v1/clips/{clip['clipId']}/decline")[0] == 200
    assert clip["clipId"] not in s3v.vectors
    assert (
        "delete_vectors",
        {"vectorBucketName": "cf-prod-vectors-123", "indexName": "clips", "keys": [clip["clipId"]]},
    ) in s3v.calls


def test_decline_survives_a_vector_error(call: Call, store: db.Store, s3v: FakeS3Vectors) -> None:
    clip = seed_clip(store)
    s3v.fail = True
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/decline")
    assert status == 200
    assert body["clip"]["status"] == "declined"


def test_similar_drops_self_filters_by_owner_and_performed(
    call: Call, store: db.Store, s3v: FakeS3Vectors, s3_client: FakeS3
) -> None:
    clip = seed_clip(store)
    _vector(s3v, clip["clipId"], status="review", distance=0.0)
    good = [seed_clip(store, s3_client) for _ in range(6)]
    for n, c in enumerate(good):
        _vector(s3v, c["clipId"], distance=0.05 * (n + 1))
    review = seed_clip(store)
    _vector(s3v, review["clipId"], status="review", distance=0.01)
    foreign = seed_clip(store, user=OTHER)
    _vector(s3v, foreign["clipId"], user=OTHER, distance=0.01)
    status, body = call("GET", f"/v1/clips/{clip['clipId']}/similar")
    assert status == 200
    out = body["clips"]
    assert len(out) == 5
    ids = [c["clipId"] for c in out]
    assert clip["clipId"] not in ids
    assert review["clipId"] not in ids
    assert foreign["clipId"] not in ids
    assert [c["similarity"] for c in out] == sorted((c["similarity"] for c in out), reverse=True)
    first = out[0]
    assert first["clipId"] == good[0]["clipId"]
    assert first["similarity"] == 0.95
    assert first["hook"] == "He lost it"
    assert first["title"] == CAPTIONS["youtubeTitle"]
    assert first["momentType"] == "rage"
    assert first["performance"]["views"] == 1200
    assert first["coverUrl"].startswith("https://")
    (query,) = [kw for op, kw in s3v.calls if op == "query_vectors"]
    assert query["topK"] == 6
    assert query["filter"] == {"$and": [{"userId": {"$eq": USER}}, {"status": {"$eq": "performed"}}]}
    assert query["returnMetadata"] is True
    assert query["returnDistance"] is True


def test_similar_skips_declined_and_missing_clips(call: Call, store: db.Store, s3v: FakeS3Vectors) -> None:
    clip = seed_clip(store)
    _vector(s3v, clip["clipId"], status="review", distance=0.0)
    declined = seed_clip(store, status="declined")
    _vector(s3v, declined["clipId"])
    _vector(s3v, "01JGONEGONEGONEGONEGONEGON")
    assert call("GET", f"/v1/clips/{clip['clipId']}/similar") == (200, {"clips": []})


def test_similar_is_empty_without_a_vector_or_on_errors(call: Call, store: db.Store, s3v: FakeS3Vectors) -> None:
    clip = seed_clip(store)
    assert call("GET", f"/v1/clips/{clip['clipId']}/similar") == (200, {"clips": []})
    _vector(s3v, clip["clipId"])
    s3v.fail = True
    assert call("GET", f"/v1/clips/{clip['clipId']}/similar") == (200, {"clips": []})


def test_similar_is_404_for_another_owners_clip(call: Call, store: db.Store) -> None:
    foreign = seed_clip(store, user=OTHER)
    assert call("GET", f"/v1/clips/{foreign['clipId']}/similar")[0] == 404


def test_confirm_resumes_a_clip_kept_before_flow_runs_existed(
    call: Call, store: db.Store, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = seed_clip(store, status="confirmed", publishState="pending")
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 200
    (start,) = _clip_flow_calls(lambda_client)
    assert start["DurableExecutionName"] == f"clip-{clip['clipId']}-1"
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert (stored["publishState"], stored["flowRun"]) == ("started", 1)


# --- §17.8: the "Post to TikTok" sheet ------------------------------------------------------------------------------

TIKTOK = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": True,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": True,
}


def _connect_tiktok(store: db.Store) -> None:
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "ACCOUNT#tiktok",
            "type": "account",
            "userId": USER,
            "platform": "tiktok",
            "status": "connected",
        }
    )


def test_keep_with_tiktok_connected_needs_the_sheet(call: Call, store: db.Store) -> None:
    _connect_tiktok(store)
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    assert status == 400
    assert body["error"]["message"] == "Pick who can see it on TikTok."
    assert store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))["status"] == "review"  # type: ignore[index]


def test_keep_stores_the_tiktok_choices_on_the_tiktok_post(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect_tiktok(store)
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"tiktok": TIKTOK})
    assert status == 200
    tiktok = next(p for p in body["posts"] if p["platform"] == "tiktok")
    assert tiktok["status"] == "queued"
    assert "postOptions" not in tiktok
    stored = table.raw(db.user_pk(USER), db.post_sk(tiktok["postId"]))
    assert stored is not None
    assert stored["postOptions"] == TIKTOK
    others = [p for p in table.all() if p.get("type") == "post" and p["platform"] != "tiktok"]
    assert all("postOptions" not in p for p in others)


@pytest.mark.parametrize(
    "options",
    [
        {"privacyLevel": "EVERYONE"},
        {**TIKTOK, "privacyLevel": "SELF_ONLY", "brandContent": True},
        {**TIKTOK, "privacyLevel": "FOLLOWER_OF_CREATOR", "brandContent": True},
        {**TIKTOK, "disableDuet": "no"},
        {**TIKTOK, "extra": 1},
        "public",
    ],
)
def test_tiktok_choices_are_checked(call: Call, store: db.Store, options: object) -> None:
    clip = seed_clip(store)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"tiktok": options})[0] == 400


def test_keep_without_tiktok_connected_needs_no_sheet(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 200


def _failed_clip_with_posts(store: db.Store, old: dict[str, object]) -> dict[str, object]:
    clip = seed_clip(store, status="failed", publishState="started", postsCreated=True, flowRun=1)
    for platform in ("tiktok", "youtube"):
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": db.post_sk(f"P{platform}"),
                "gsi1pk": f"CLIP#{clip['clipId']}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": USER,
                "postId": f"P{platform}",
                "clipId": clip["clipId"],
                "platform": platform,
                "status": "failed",
                "error": "Pick who can see it on TikTok again, then press Try again.",
                **({"postOptions": old} if platform == "tiktok" else {}),
            }
        )
    return clip


def test_try_again_with_new_tiktok_choices_replaces_the_old_ones(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect_tiktok(store)
    old = {**TIKTOK, "privacyLevel": "FOLLOWER_OF_CREATOR"}
    clip = _failed_clip_with_posts(store, old)
    new = {**TIKTOK, "privacyLevel": "SELF_ONLY", "brandContent": False}
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"tiktok": new})
    assert status == 200
    assert {p["platform"]: p["status"] for p in body["posts"]} == {"tiktok": "queued", "youtube": "queued"}
    assert all("postOptions" not in p for p in body["posts"])
    tiktok = table.raw(db.user_pk(USER), db.post_sk("Ptiktok"))
    assert tiktok is not None
    assert tiktok["postOptions"] == new
    youtube = table.raw(db.user_pk(USER), db.post_sk("Pyoutube"))
    assert youtube is not None
    assert "postOptions" not in youtube
    (start,) = _clip_flow_calls(lambda_client)
    assert json.loads(start["Payload"])["run"] == 2


def test_try_again_without_tiktok_choices_keeps_the_old_ones(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect_tiktok(store)
    clip = _failed_clip_with_posts(store, TIKTOK)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm")[0] == 200
    tiktok = table.raw(db.user_pk(USER), db.post_sk("Ptiktok"))
    assert tiktok is not None
    assert (tiktok["status"], tiktok["postOptions"]) == ("queued", TIKTOK)


def test_picked_for_passes_through_when_the_agent_wrote_it(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    """docs/CONTRACTS.md §5: ``pickedFor`` is the agent's few plain words on why the moment was picked (ADR-40)."""
    with_why = seed_clip(store, s3_client, pickedFor="Loud laugh + Fast action")
    without = seed_clip(store, s3_client)
    status, body = call("GET", "/v1/clips")
    assert status == 200
    by_id = {c["clipId"]: c for c in body["clips"]}
    assert by_id[with_why["clipId"]]["pickedFor"] == "Loud laugh + Fast action"
    assert "pickedFor" not in by_id[without["clipId"]]  # an older clip, or nothing stood out: no field at all
    status, body = call("GET", f"/v1/clips/{with_why['clipId']}")
    assert status == 200
    assert body["clip"]["pickedFor"] == "Loud laugh + Fast action"


def test_your_take_passes_through_when_the_agent_wrote_it(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    """Your take (2026-11-27): ``take`` (the channel's own one-line comment) and ``takeSpoken`` (a voice read it out)
    are public as the agent wrote them; an older clip, or one made with Your take off, has neither key."""
    spoken = seed_clip(store, s3_client, take="He was right all along, and nobody listened.", takeSpoken=True)
    written = seed_clip(store, s3_client, take="Watch the left hand, not the ball.")
    old = seed_clip(store, s3_client)
    status, body = call("GET", "/v1/clips")
    assert status == 200
    by_id = {c["clipId"]: c for c in body["clips"]}
    assert by_id[spoken["clipId"]]["take"] == "He was right all along, and nobody listened."
    assert by_id[spoken["clipId"]]["takeSpoken"] is True
    assert by_id[written["clipId"]]["take"] == "Watch the left hand, not the ball."
    assert "takeSpoken" not in by_id[written["clipId"]]
    assert "take" not in by_id[old["clipId"]]
    assert "takeSpoken" not in by_id[old["clipId"]]
    status, body = call("GET", f"/v1/clips/{spoken['clipId']}")
    assert status == 200
    assert (body["clip"]["take"], body["clip"]["takeSpoken"]) == ("He was right all along, and nobody listened.", True)


def test_a_campaign_copy_never_carries_your_take() -> None:
    """Your take, point 3: a campaign copy is made from the listed moment fields only, and the take is not one."""
    from clipfactory_api.contentrewards import remake

    assert not {"take", "takeSpoken"} & set(remake.MOMENT)
