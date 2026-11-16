"""The five stats adapters: exact requests (§16.3), batch sizes, and recorded answers mapped to PostMetrics."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api.ids import ulid
from clipfactory_api.platforms import (
    ADAPTER_CLASSES,
    NotConnectedError,
    adapter_for,
)
from clipfactory_api.platforms.facebook import FacebookAdapter
from clipfactory_api.platforms.instagram import InstagramAdapter
from clipfactory_api.platforms.tiktok import TikTokAdapter
from clipfactory_api.platforms.x import XAdapter
from clipfactory_api.platforms.youtube import YouTubeAdapter
from fakes import FakeHttp

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
ACCOUNT = {"platform": "x", "status": "connected", "platformUserId": "17841400000000000"}


def tokens(platform: str, account: dict[str, Any]) -> str:
    return f"token-{platform}"


def post(platform: str, stats_id: str | None, *, age: timedelta = timedelta(days=1), **fields: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "postId": ulid(),
        "platform": platform,
        "status": "posted",
        "postedAt": (NOW - age).isoformat().replace("+00:00", "Z"),
        **fields,
    }
    if stats_id is not None:
        item["statsId"] = stats_id
    return item


def query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlsplit(url).query)


# --- the phase-1 guard --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("platform", list(ADAPTER_CLASSES))
def test_no_account_means_not_connected_and_no_http(platform: str) -> None:
    http = FakeHttp()
    with pytest.raises(NotConnectedError, match="Connect"):
        adapter_for(platform).fetch_stats([post(platform, "1")], None, now=NOW, want_insights=True, http=http)
    assert http.calls == []


@pytest.mark.parametrize("platform", list(ADAPTER_CLASSES))
def test_phase_one_tokens_are_not_there_yet(platform: str) -> None:
    http = FakeHttp()
    with pytest.raises(NotConnectedError, match="next phase"):
        adapter_for(platform).fetch_stats([post(platform, "1")], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.calls == []
    with pytest.raises(NotConnectedError):
        adapter_for(platform).metrics(post(platform, "1"), None)


# --- YouTube ------------------------------------------------------------------------------------------------------


def test_youtube_fast_request_and_mapping() -> None:
    a, b = post("youtube", "dQw4w9WgXcQ"), post("youtube", "aBcDeFgHiJk")
    http = FakeHttp((200, "youtube_videos_list"))
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a, b], ACCOUNT, now=NOW, want_insights=False, http=http)
    (call,) = http.calls
    assert call.method == "GET"
    assert call.url == "https://www.googleapis.com/youtube/v3/videos?part=statistics&id=dQw4w9WgXcQ,aBcDeFgHiJk"
    assert call.headers["Authorization"] == "Bearer token-youtube"
    assert batch.units == 1
    assert batch.requests == 1
    assert batch.results[a["postId"]] == {"views": 8412, "likes": 611, "comments": 47, "extra": {}}
    # Hidden like count: likes is null ("YouTube does not say"), never 0; shares only comes from Analytics.
    assert batch.results[b["postId"]] == {"views": 120, "likes": None, "comments": 3, "extra": {}}
    assert "shares" not in batch.results[a["postId"]]
    assert batch.insights == {}


def test_youtube_51_ids_make_2_requests_of_1_unit() -> None:
    posts = [post("youtube", f"vid{i:08d}") for i in range(51)]
    http = FakeHttp((200, {"items": []}), (200, {"items": []}))
    batch = YouTubeAdapter(tokens=tokens).fetch_stats(posts, ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 2
    assert len(query(http.urls[0])["id"][0].split(",")) == 50
    assert len(query(http.urls[1])["id"][0].split(",")) == 1
    assert batch.units == 2
    assert len(batch.errors) == 51  # not found → a plain sentence each, no numbers


def test_youtube_insights_request_and_mapping() -> None:
    a = post("youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    http = FakeHttp((200, "youtube_videos_list"), (200, "youtube_analytics_report"))
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert http.urls[1] == (
        "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2026-11-13&endDate=2026-11-16"
        "&metrics=views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,"
        "shares,subscribersGained&dimensions=video&filters=video==dQw4w9WgXcQ"
    )
    assert batch.units == 1  # Analytics has its own quota
    assert batch.insights[a["postId"]] == {
        "shares": 93,
        "extra": {
            "engagedViews": 6100,
            "watchMinutes": 1520.5,
            "avgViewSeconds": 22,
            "avgViewPercent": 71.3,
            "subscribersGained": 12,
        },
    }


def test_youtube_quota_exceeded_reports_the_reason() -> None:
    body = {
        "error": {"code": 403, "message": "quota", "errors": [{"reason": "quotaExceeded", "domain": "youtube.quota"}]}
    }
    http = FakeHttp((403, body))
    a = post("youtube", "dQw4w9WgXcQ")
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert batch.meta.status == 403
    assert batch.meta.error_code == "quotaExceeded"
    assert "daily limit" in batch.errors[a["postId"]]
    assert len(http.calls) == 1  # no Analytics call after a quota stop


# --- TikTok -------------------------------------------------------------------------------------------------------


def test_tiktok_request_and_mapping() -> None:
    a = post("tiktok", "7301234567890123456")
    http = FakeHttp((200, "tiktok_video_query"))
    batch = TikTokAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    (call,) = http.calls
    assert call.method == "POST"
    assert call.url == (
        "https://open.tiktokapis.com/v2/video/query/?fields=id,share_url,view_count,like_count,comment_count,share_count"
    )
    assert json.loads(call.body) == {"filters": {"video_ids": ["7301234567890123456"]}}
    assert call.headers["Content-Type"] == "application/json"
    assert batch.results[a["postId"]] == {"views": 25500, "likes": 3100, "comments": 210, "shares": 405, "extra": {}}


def test_tiktok_21_ids_make_2_requests() -> None:
    posts = [post("tiktok", str(7000 + i)) for i in range(21)]
    empty = {"data": {"videos": []}, "error": {"code": "ok"}}
    http = FakeHttp((200, empty), (200, empty))
    TikTokAdapter(tokens=tokens).fetch_stats(posts, ACCOUNT, now=NOW, want_insights=False, http=http)
    sizes = [len(json.loads(c.body)["filters"]["video_ids"]) for c in http.calls]
    assert sizes == [20, 1]


def test_tiktok_rate_limited_and_private() -> None:
    a, private = post("tiktok", "7301234567890123456"), post("tiktok", None, privacy="private")
    body = {"error": {"code": "rate_limit_exceeded", "message": "slow down"}}
    http = FakeHttp((429, body))
    batch = TikTokAdapter(tokens=tokens).fetch_stats([a, private], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert batch.meta.status == 429
    assert batch.meta.error_code == "rate_limit_exceeded"
    assert batch.results == {}
    assert "approved" in batch.errors[private["postId"]]  # never asked for: no public id while private
    assert len(http.calls) == 1


# --- Instagram ----------------------------------------------------------------------------------------------------


def test_instagram_request_and_mapping() -> None:
    a = post("instagram", "17900000000000001")
    http = FakeHttp((200, "instagram_media"))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    (url,) = http.urls
    assert url == (
        "https://graph.facebook.com/v25.0/17841400000000000/media?fields=id,permalink,media_product_type,timestamp,"
        "like_count,comments_count,insights.metric(views,reach,saved,shares,total_interactions,reposts,"
        "ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate)&limit=50"
    )
    asked = url.split("insights.metric(", 1)[1].split(")", 1)[0].split(",")
    for banned in ("impressions", "plays", "ig_reels_aggregated_all_plays_count"):
        assert banned not in asked
    assert batch.results[a["postId"]] == {"likes": 420, "comments": 31}
    assert batch.insights[a["postId"]] == {
        "views": 15800,
        "shares": 58,
        "extra": {
            "reach": 9100,
            "saved": 77,
            "totalInteractions": 590,
            "avgWatchSeconds": 7.3,  # 7350 ms → s
            "totalWatchSeconds": 116130.0,
            "skipRatePercent": 38.5,
        },  # "reposts" came back as an empty set: absent, never 0
    }


def test_instagram_follows_pages_until_found_or_too_old() -> None:
    wanted = post("instagram", "17900000000000999")
    page2 = {
        "data": [
            {
                "id": "17900000000000999",
                "timestamp": "2026-11-10T10:00:00+0000",
                "like_count": 5,
                "comments_count": 0,
                "insights": {"data": [{"name": "views", "values": [{"value": 80}]}]},
            }
        ],
        "paging": {"next": "https://graph.facebook.com/v25.0/17841400000000000/media?after=X2&limit=50"},
    }
    http = FakeHttp((200, "instagram_media"), (200, page2))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([wanted], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.urls[1] == "https://graph.facebook.com/v25.0/17841400000000000/media?after=QVFIUjVuYXVFZA&limit=50"
    assert len(http.calls) == 2  # found on page 2: no third page
    assert batch.insights[wanted["postId"]]["views"] == 80
    old = {"data": [{"id": "1", "timestamp": "2026-10-01T10:00:00+0000"}], "paging": {"next": page2["paging"]["next"]}}
    http = FakeHttp((200, old))
    missing = post("instagram", "404")
    batch = InstagramAdapter(tokens=tokens).fetch_stats([missing], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 1  # older than 31 days: stop paging
    assert "could not find" in batch.errors[missing["postId"]]


def test_instagram_drops_a_rejected_metric_and_retries_once() -> None:
    a = post("instagram", "17900000000000001")
    error = {"error": {"message": "(#100) The metric reposts is not supported", "type": "OAuthException", "code": 100}}
    http = FakeHttp((400, error), (200, "instagram_media"))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert "reposts" in http.urls[0]
    assert ",reposts," not in http.urls[1]
    assert batch.insights[a["postId"]]["views"] == 15800
    http = FakeHttp((400, error), (400, error))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 2  # only one retry
    assert a["postId"] in batch.errors


def test_instagram_throttle_is_never_retried() -> None:
    a = post("instagram", "17900000000000001")
    usage = json.dumps(
        {
            "17841400000000000": [
                {
                    "type": "instagram",
                    "call_count": 100,
                    "total_cputime": 20,
                    "total_time": 30,
                    "estimated_time_to_regain_access": 90,
                }
            ]
        }
    )
    error = {"error": {"message": "Application request limit reached", "code": 80002}}
    http = FakeHttp((400, error, {"X-Business-Use-Case-Usage": usage}))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 1
    assert batch.meta.error_code == "80002"
    assert batch.meta.headers["x-business-use-case-usage"] == usage
    assert "busy" in batch.errors[a["postId"]]


# --- Facebook -----------------------------------------------------------------------------------------------------


def test_facebook_requests_and_mapping() -> None:
    a = post("facebook", "1234567890123456", platformPostId="111222333_444555666")
    http = FakeHttp((200, "facebook_video_insights"), (200, "facebook_post_views"))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.urls == [
        "https://graph.facebook.com/v25.0/?ids=1234567890123456&fields=video_insights.metric(blue_reels_play_count,"
        "fb_reels_total_plays,fb_reels_replay_count,post_video_avg_time_watched,post_video_view_time,"
        "post_video_followers,post_video_likes_by_reaction_type,post_video_social_actions)",
        "https://graph.facebook.com/v25.0/?ids=111222333_444555666&fields=insights.metric(post_total_media_view_unique)",
    ]
    for banned in ("post_impressions_unique", "total_video_impressions", "total_video_views_unique", "impressions"):
        assert all(banned not in u for u in http.urls)
    assert batch.results[a["postId"]] == {"comments": None, "shares": None}
    assert batch.insights[a["postId"]] == {
        "views": 6900,
        "likes": 387,  # sum of the reactions
        "extra": {
            "initialPlays": 5200,
            "replays": 1700,
            "reactions": {"like": 280, "love": 41, "haha": 66},
            "commentsAndShares": 44,
            "avgWatchSeconds": 6.4,
            "totalWatchSeconds": 44160.0,
            "followsGained": 14,
            "reachUnique": 4100,
        },
    }


def test_facebook_reach_is_guarded() -> None:
    a = post("facebook", "1234567890123456", platformPostId="111222333_444555666")
    gone = {"error": {"message": "(#100) The value must be a valid insights metric", "code": 100}}
    http = FakeHttp((200, "facebook_video_insights"), (400, gone))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert "reachUnique" not in batch.insights[a["postId"]]["extra"]
    assert batch.insights[a["postId"]]["views"] == 6900
    assert batch.meta.error_code is None  # a reach error never blocks the platform


# --- X ------------------------------------------------------------------------------------------------------------


def test_x_request_and_mapping() -> None:
    a = post("x", "1857000000000000001")
    http = FakeHttp((200, "x_tweets_lookup", {"x-rate-limit-remaining": "3499", "x-rate-limit-reset": "1763295300"}))
    batch = XAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.urls == [
        "https://api.x.com/2/tweets?ids=1857000000000000001&tweet.fields=public_metrics,non_public_metrics,"
        "organic_metrics,created_at&expansions=attachments.media_keys&media.fields=public_metrics,non_public_metrics"
    ]
    assert batch.results[a["postId"]] == {
        "views": 4300,  # the video's view_count, never impression_count
        "likes": 140,
        "comments": 9,
        "shares": 12,
        "extra": {
            "impressions": 9800,
            "reposts": 12,
            "quotes": 2,
            "bookmarks": 6,
            "linkClicks": 3,
            "profileClicks": 27,
            "engagements": 310,
            "playback0": 4300,
            "playback25": 2900,
            "playback50": 1800,
            "playback75": 1100,
            "playback100": 640,
        },
    }
    assert batch.meta.retry_after == 1763295300


def test_x_old_posts_drop_the_owner_only_fields_and_101_ids_make_2_requests() -> None:
    young = [post("x", str(10**18 + i)) for i in range(101)]
    old = post("x", "1700000000000000001", age=timedelta(days=30))
    http = FakeHttp((200, {"data": []}), (200, {"data": []}), (200, {"data": []}))
    XAdapter(tokens=tokens).fetch_stats([*young, old], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 3
    assert [len(query(u)["ids"][0].split(",")) for u in http.urls] == [100, 1, 1]
    assert "non_public_metrics" in http.urls[0]
    last = query(http.urls[2])
    assert last["ids"] == ["1700000000000000001"]
    assert last["tweet.fields"] == ["public_metrics,created_at"]
    assert last["media.fields"] == ["public_metrics"]
    assert "organic_metrics" not in http.urls[2]


def test_x_rate_limited() -> None:
    a = post("x", "1857000000000000001")
    http = FakeHttp((429, {"title": "Too Many Requests"}, {"x-rate-limit-reset": "1763295300"}))
    batch = XAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert batch.meta.status == 429
    assert batch.meta.retry_after == 1763295300
    assert a["postId"] in batch.errors


def test_metrics_is_fetch_stats_for_one_post(monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_api.platforms import base

    http = FakeHttp((200, "tiktok_video_query"))
    monkeypatch.setattr(base, "urllib_client", http)
    m = TikTokAdapter(tokens=tokens).metrics(post("tiktok", "7301234567890123456"), ACCOUNT)
    assert (m.views, m.likes, m.comments, m.shares) == (25500, 3100, 210, 405)


def test_urllib_client_only_calls_https() -> None:
    from clipfactory_api.platforms.base import HttpRequest, NetworkError, urllib_client

    with pytest.raises(NetworkError):
        urllib_client(HttpRequest("GET", "http://example.com/"))
