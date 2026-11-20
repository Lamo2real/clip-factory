"""GET /v1/clips/{id}/performance and POST /v1/clips/{id}/stats/refresh (docs/CONTRACTS.md §16.2)."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.ids import ulid
from clipfactory_api.performance import downsample
from clipfactory_api.stats import STATS_ORDER
from conftest import NOW, OTHER, STATS_ARN, USER, Call, seed_clip
from fakes import FakeLambda, FakeS3, FakeTable

INTERNAL = (
    "statsId",
    "platformPostId",
    "gsi2pk",
    "gsi2sk",
    "statsDueAt",
    "refreshStartedAt",
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
    "revision",
    "unpickedClipIds",
    "videoKey",
    "coverKey",
    "publishState",
    "flowRun",
)


def metrics(views: int | None, likes: int | None = 1, **extra: Any) -> dict[str, Any]:
    return {
        "views": views,
        "likes": likes,
        "comments": 2,
        "shares": None,
        "checkedAt": iso(NOW - timedelta(minutes=3)),
        "metricsUpdatedAt": iso(NOW - timedelta(minutes=3)),
        "extra": extra,
    }


def seed_post(
    store: db.Store, clip: dict[str, Any], platform: str, status: str = "posted", **fields: Any
) -> dict[str, Any]:
    post_id = fields.pop("postId", None) or ulid()
    item = {
        "pk": db.user_pk(clip["userId"]),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": clip["userId"],
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        "status": status,
        **fields,
    }
    if status == "posted":
        item.setdefault("postedAt", iso(NOW - timedelta(hours=5)))
        item.setdefault("url", f"https://{platform}.example/{post_id}")
        item.setdefault("privacy", "public")
        item.setdefault("statsId", f"{platform}-id")
        item.setdefault("platformPostId", f"{platform}-pid")
        item.setdefault("statsDueAt", iso(NOW))
        item.setdefault("gsi2pk", "STATS")
        item.setdefault("gsi2sk", f"{iso(NOW)}#{post_id}")
    store.put(item)
    return item


def connect(store: db.Store, *platforms: str) -> None:
    for p in platforms:
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": f"ACCOUNT#{p}#1",
                "type": "account",
                "userId": USER,
                "platform": p,
                "status": "connected",
            }
        )


def posted_clip(store: db.Store, s3: FakeS3, **fields: Any) -> dict[str, Any]:
    return seed_clip(store, s3, status="posted", decidedAt="2026-11-15T09:00:00.000Z", **fields)


# --- GET performance -------------------------------------------------------------------------------------------------


def test_performance_has_five_platforms_in_stats_order_with_the_status_mapping(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    clip = posted_clip(store, s3_client)
    yt = seed_post(store, clip, "youtube", metrics=metrics(1200, extra_n=1), statsError="YouTube did not answer.")
    seed_post(store, clip, "tiktok", privacy="private", statsId=None)
    seed_post(store, clip, "instagram", "pending_integration")
    seed_post(store, clip, "facebook", "failed", error="Posting to Facebook did not work. Press Try again.")
    seed_post(store, clip, "x", "queued")
    connect(store, "youtube")
    status, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    assert status == 200
    assert [p["platform"] for p in body["posts"]] == list(STATS_ORDER)
    assert [p["status"] for p in body["posts"]] == [
        "posted",
        "posted_private",
        "waiting_for_connection",
        "failed",
        "posting",
    ]
    youtube = body["posts"][0]
    assert youtube["account"] == "connected"
    assert body["posts"][1]["account"] == "not_connected"
    assert youtube["postId"] == yt["postId"]
    assert youtube["url"] == yt["url"]
    assert youtube["updatedAt"] == iso(NOW - timedelta(minutes=3))
    assert youtube["metrics"]["views"] == 1200
    assert youtube["metrics"]["shares"] is None
    assert youtube["metrics"]["extra"] == {"extra_n": 1}
    assert youtube["error"] == "YouTube did not answer."
    assert youtube["refreshing"] is False
    assert youtube["final"] is False
    assert body["posts"][3]["error"] == "Posting to Facebook did not work. Press Try again."
    assert body["posts"][2]["metrics"] is None
    assert body["clip"]["videoUrl"].startswith("https://")
    assert body["clip"]["coverUrl"].startswith("https://")
    assert body["clip"]["totalViews"] == 1200
    assert body["totals"] == {
        "views": 1200,
        "likes": 1,
        "comments": 2,
        "shares": 0,
        "platformsPosted": 2,
        "updatedAt": iso(NOW - timedelta(minutes=3)),
    }
    assert body["bestPlatform"] == "youtube"
    assert body["bestThisWeek"] is False
    assert body["week"] is None
    assert body["weekAnchorAt"] == yt["postedAt"]
    text = json.dumps(body)
    for field in INTERNAL:
        assert f'"{field}"' not in text, field


def test_performance_of_a_kept_clip_without_posts(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(
        store, s3_client, status="confirmed", decidedAt="2026-11-15T09:00:00.000Z", best=True, bestWeek="2026-W46"
    )
    status, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    assert status == 200
    assert [p["status"] for p in body["posts"]] == ["not_posted"] * 5
    assert body["series"] == {}
    assert body["totals"] == {"views": 0, "likes": 0, "comments": 0, "shares": 0, "platformsPosted": 0}
    assert body["bestPlatform"] is None
    assert "totalViews" not in body["clip"]
    assert body["bestThisWeek"] is True
    assert body["week"] == "2026-W46"
    assert body["weekAnchorAt"] == "2026-11-15T09:00:00.000Z"


def test_best_platform_ties_go_to_the_earlier_platform(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(store, clip, "x", metrics=metrics(500))
    seed_post(store, clip, "instagram", metrics=metrics(500, likes=None))
    seed_post(store, clip, "facebook", metrics=metrics(None))
    _, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    assert body["bestPlatform"] == "instagram"
    assert body["totals"]["views"] == 1000
    assert body["totals"]["likes"] == 2  # null likes count as 0


def test_series_is_downsampled_to_60_points_keeping_the_last(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = posted_clip(store, s3_client)
    post = seed_post(store, clip, "tiktok", metrics=metrics(999))
    for i in range(520):
        at = iso(NOW - timedelta(hours=520) + timedelta(hours=i, minutes=7 if i % 3 else 0))
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": db.stat_sk(post["postId"], at),
                "type": "stat",
                "postId": post["postId"],
                "at": at,
                "views": i,
            }
        )
    _, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    series = body["series"]["tiktok"]
    assert 2 <= len(series) <= 60
    assert series[-1]["views"] == 519  # the newest point, even past 500 snapshots
    assert [p["at"] for p in series] == sorted(p["at"] for p in series)
    assert set(body["series"]) == {"tiktok"}


def test_downsample() -> None:
    points = [{"at": iso(NOW + timedelta(minutes=i)), "views": i} for i in range(61)]
    out = downsample(points)
    assert len(out) <= 60
    assert out[-1] == points[-1]
    assert downsample(points[:10]) == points[:10]


@pytest.mark.parametrize("status", ["review", "declined"])
def test_performance_404_before_keep_or_after_throw_away(call: Call, store: db.Store, status: str) -> None:
    clip = seed_clip(store, status=status)
    code, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    assert code == 404
    assert body["error"] == {"code": "not_found", "message": "This clip has no numbers yet. Upload it first."}
    code, _ = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {})
    assert code == 404


def test_performance_404_for_another_owner(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, user=OTHER, status="posted")
    assert call("GET", f"/v1/clips/{clip['clipId']}/performance")[0] == 404
    assert call("GET", "/v1/clips/not-a-ulid/performance")[0] == 404


def test_refreshing_and_next_allowed(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(
        store,
        clip,
        "youtube",
        metrics=metrics(5),
        refreshStartedAt=iso(NOW - timedelta(minutes=1)),
        nextRefreshAt=iso(NOW + timedelta(minutes=4)),
    )
    seed_post(
        store,
        clip,
        "tiktok",
        refreshStartedAt=iso(NOW - timedelta(minutes=6)),
        nextRefreshAt=iso(NOW - timedelta(minutes=1)),
    )
    _, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    youtube, tiktok = body["posts"][0], body["posts"][1]
    assert youtube["refreshing"] is True
    assert youtube["nextAllowedAt"] == iso(NOW + timedelta(minutes=4))
    assert tiktok["refreshing"] is False
    assert "nextAllowedAt" not in tiktok  # in the past = now


# --- POST stats/refresh ----------------------------------------------------------------------------------------------


def _refresh_invokes(lambda_client: FakeLambda) -> list[dict[str, Any]]:
    return [c for c in lambda_client.calls if c["FunctionName"] == STATS_ARN]


def test_refresh_statuses(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = posted_clip(store, s3_client)
    yt = seed_post(store, clip, "youtube")
    seed_post(store, clip, "tiktok", privacy="private")
    ig = seed_post(store, clip, "instagram")
    seed_post(store, clip, "facebook")  # not connected
    connect(store, "youtube", "tiktok", "instagram", "x")  # x: no post
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {})
    assert status == 202
    by = {r["platform"]: r for r in body["platforms"]}
    assert [r["platform"] for r in body["platforms"]] == list(STATS_ORDER)
    assert by["youtube"] == {
        "platform": "youtube",
        "status": "started",
        "nextAllowedAt": iso(NOW + timedelta(minutes=5)),
    }
    assert by["tiktok"] == {
        "platform": "tiktok",
        "status": "private",
        "note": "TikTok shows numbers after the app is approved.",
    }
    assert by["instagram"] == {
        "platform": "instagram",
        "status": "started",
        "nextAllowedAt": iso(NOW + timedelta(minutes=30)),
        "note": "Instagram numbers can take up to 2 days to settle.",
    }
    assert by["facebook"] == {
        "platform": "facebook",
        "status": "not_connected",
        "note": "Connect Facebook in Settings › Posting › Set up posting.",
    }
    assert by["x"] == {"platform": "x", "status": "not_posted"}
    (invoke,) = _refresh_invokes(lambda_client)
    assert invoke["InvocationType"] == "Event"
    assert "DurableExecutionName" not in invoke
    assert invoke["payload"] == {
        "action": "refresh",
        "userId": USER,
        "clipId": clip["clipId"],
        "postIds": [yt["postId"], ig["postId"]],
    }
    stored = db.from_dynamo(table.raw(yt["pk"], yt["sk"]))
    assert stored["refreshStartedAt"] == iso(NOW)
    assert stored["nextRefreshAt"] == iso(NOW + timedelta(minutes=5))


def test_refresh_too_soon_honours_next_refresh_at(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: FakeLambda
) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(store, clip, "youtube", nextRefreshAt=iso(NOW + timedelta(minutes=3)))
    seed_post(store, clip, "x", refreshStartedAt=iso(NOW - timedelta(minutes=2)))  # still running
    connect(store, "youtube", "x")
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["x", "youtube"]})
    assert body["platforms"] == [
        {"platform": "youtube", "status": "too_soon", "nextAllowedAt": iso(NOW + timedelta(minutes=3))},
        {"platform": "x", "status": "too_soon"},
    ]
    assert _refresh_invokes(lambda_client) == []


def test_refresh_after_the_cooldown_claims_again(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(store, clip, "x", nextRefreshAt=iso(NOW), refreshStartedAt=iso(NOW - timedelta(minutes=6)))
    connect(store, "x")
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["x"]})
    assert body["platforms"][0]["status"] == "started"
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["x"]})
    assert body["platforms"] == [
        {"platform": "x", "status": "too_soon", "nextAllowedAt": iso(NOW + timedelta(minutes=5))}
    ]


def test_refresh_blocked_honours_blocked_until(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: FakeLambda
) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(store, clip, "facebook")
    connect(store, "facebook")
    store.put({"pk": "RATE#facebook", "sk": "BUDGET", "type": "rate", "blockedUntil": iso(NOW + timedelta(minutes=42))})
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["facebook"]})
    assert body["platforms"] == [
        {"platform": "facebook", "status": "blocked", "nextAllowedAt": iso(NOW + timedelta(minutes=42))}
    ]
    assert _refresh_invokes(lambda_client) == []


def test_refresh_invoke_failure_rolls_the_claim_back(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: FakeLambda, table: FakeTable
) -> None:
    clip = posted_clip(store, s3_client)
    fb = seed_post(store, clip, "facebook")
    connect(store, "facebook")
    lambda_client.fail = True
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["facebook"]})
    assert status == 202
    assert body["platforms"] == [
        {
            "platform": "facebook",
            "status": "blocked",
            "nextAllowedAt": iso(NOW + timedelta(minutes=1)),
            "note": "Could not check right now. Try again in a minute.",
        }
    ]
    stored = db.from_dynamo(table.raw(fb["pk"], fb["sk"]))
    assert "refreshStartedAt" not in stored
    assert "nextRefreshAt" not in stored
    lambda_client.fail = False
    _, body = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", {"platforms": ["facebook"]})
    assert body["platforms"][0]["status"] == "started"
    assert body["platforms"][0]["note"] == "Facebook numbers can take up to 2 days to settle."


@pytest.mark.parametrize("body", [{"platforms": ["myspace"]}, {"platforms": "youtube"}, {"other": 1}])
def test_refresh_rejects_unknown_platforms(call: Call, store: db.Store, body: Any) -> None:
    clip = seed_clip(store, status="posted")
    status, out = call("POST", f"/v1/clips/{clip['clipId']}/stats/refresh", body)
    assert status == 400
    assert out["error"]["code"] == "bad_request"


def test_clip_list_and_detail_carry_total_views(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = posted_clip(store, s3_client)
    seed_post(store, clip, "youtube", metrics=metrics(700))
    seed_post(store, clip, "x", metrics=metrics(None))
    seed_post(store, clip, "tiktok", "failed", metrics=metrics(9999))  # not posted: not counted
    _, body = call("GET", "/v1/clips", query={"status": "posted"})
    assert body["clips"][0]["totalViews"] == 700
    _, body = call("GET", f"/v1/clips/{clip['clipId']}")
    assert body["clip"]["totalViews"] == 700


def test_posts_public_shape(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="posted")
    seed_post(store, clip, "tiktok", metrics={"views": 3, "checkedAt": "2026-11-15T00:00:00.000Z"}, privacy="private")
    _, body = call("GET", "/v1/posts", query={"clipId": clip["clipId"]})
    (post,) = body["posts"]
    assert post["privacy"] == "private"
    assert post["refreshing"] is False
    assert post["metrics"] == {
        "views": 3,
        "likes": None,
        "comments": None,
        "shares": None,
        "checkedAt": "2026-11-15T00:00:00.000Z",
        "metricsUpdatedAt": "2026-11-15T00:00:00.000Z",
        "extra": {},
    }
    for field in INTERNAL:
        assert field not in post
