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
from clipfactory_api.platforms.base import NetworkError
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
    http = FakeHttp((200, "youtube_videos_list"), (200, "youtube_analytics_report"), (200, "youtube_retention_report"))
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert http.urls[1] == (
        "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2026-11-13&endDate=2026-11-16"
        "&metrics=views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,"
        "shares,subscribersGained&dimensions=video&filters=video==dQw4w9WgXcQ"
    )
    assert http.urls[2] == (  # §56: one video per request (the API refuses a list)
        "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2026-11-13&endDate=2026-11-16"
        "&metrics=audienceWatchRatio&dimensions=elapsedVideoTimeRatio&filters=video==dQw4w9WgXcQ"
    )
    assert batch.units == 1  # Analytics has its own quota
    assert batch.requests == 3
    assert batch.insights[a["postId"]] == {
        "shares": 93,
        "retention": {
            "points": [[1.0, 112.0], [25.0, 84.6], [50.0, 71.2], [100.0, 40.0]],  # sorted; rewatches can pass 100
            "readAt": "2026-11-16T12:00:00.000Z",
            "source": "youtube",
        },
        "extra": {
            "engagedViews": 6100,
            "watchMinutes": 1520.5,
            "avgViewSeconds": 22,
            "avgViewPercent": 71.3,
            "subscribersGained": 12,
        },
    }


@pytest.mark.parametrize(
    "answer",
    [
        (403, {"error": {"code": 403, "errors": [{"reason": "forbidden"}]}}),
        (200, {"columnHeaders": [{"name": "elapsedVideoTimeRatio"}, {"name": "audienceWatchRatio"}], "rows": []}),
        (
            200,
            {"columnHeaders": [{"name": "elapsedVideoTimeRatio"}, {"name": "audienceWatchRatio"}], "rows": [[0.5, 1]]},
        ),
        NetworkError("timed out"),
    ],
)
def test_youtube_retention_is_guarded(answer: Any) -> None:
    """§56: an error, no rows or a single point leaves ``retention`` out; the report's numbers stand."""
    a = post("youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    http = FakeHttp((200, "youtube_videos_list"), (200, "youtube_analytics_report"), answer)
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert "retention" not in batch.insights[a["postId"]]
    assert batch.insights[a["postId"]]["shares"] == 93
    assert batch.meta.error_code is None  # never blocks the Data API budget


def test_youtube_retention_without_a_report_row_and_no_graph_after_a_failed_report() -> None:
    a = post("youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    http = FakeHttp(
        (200, "youtube_videos_list"), (200, {"columnHeaders": [], "rows": []}), (200, "youtube_retention_report")
    )
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert batch.insights[a["postId"]]["extra"] == {}
    assert batch.insights[a["postId"]]["retention"]["source"] == "youtube"
    http = FakeHttp((200, "youtube_videos_list"), (500, b"down"))
    batch = YouTubeAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=True, http=http)
    assert len(http.calls) == 2
    assert batch.insights == {}


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
        "https://graph.facebook.com/v27.0/17841400000000000/media?fields=id,permalink,media_product_type,timestamp,"
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
        "paging": {"next": "https://graph.facebook.com/v27.0/17841400000000000/media?after=X2&limit=50"},
    }
    http = FakeHttp((200, "instagram_media"), (200, page2))
    batch = InstagramAdapter(tokens=tokens).fetch_stats([wanted], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.urls[1] == "https://graph.facebook.com/v27.0/17841400000000000/media?after=QVFIUjVuYXVFZA&limit=50"
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


FB_INSIGHTS = (
    "?fields=video_insights.metric(blue_reels_play_count,fb_reels_total_plays,fb_reels_replay_count,"
    "post_video_avg_time_watched,post_video_view_time,post_video_followers,post_video_likes_by_reaction_type,"
    "post_video_social_actions)"
)
FB_REACH = "?fields=insights.metric(post_total_media_view_unique)"
FB_RETENTION = "?fields=video_insights.metric(post_video_retention_graph)"
NO_DATA: dict[str, Any] = {"video_insights": {"data": []}}
# What Graph v26.0+ answers to the old ``?ids=`` batch form (checked against the live API, signed out, 23 Nov).
IDS_DEPRECATED = {
    "error": {
        "message": "The ids query parameter is deprecated in v26.0+.",
        "type": "FacebookApiException",
        "code": 100,
    }
}


def stats_logs(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    return [line for line in lines if str(line.get("event", "")).startswith("stats.")]


def test_facebook_requests_and_mapping() -> None:
    a = post("facebook", "1234567890123456", platformPostId="111222333_444555666")
    http = FakeHttp((200, "facebook_video_insights"), (200, "facebook_post_views"), (200, "facebook_retention_graph"))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert http.urls == [
        f"https://graph.facebook.com/v27.0/1234567890123456{FB_INSIGHTS}",
        f"https://graph.facebook.com/v27.0/111222333_444555666{FB_REACH}",
        f"https://graph.facebook.com/v27.0/1234567890123456{FB_RETENTION}",
    ]
    assert all(c.headers == {"Authorization": "Bearer token-facebook"} for c in http.calls)
    for banned in ("post_impressions_unique", "total_video_impressions", "total_video_views_unique", "impressions"):
        assert all(banned not in u for u in http.urls)
    assert batch.requests == 3
    assert batch.results[a["postId"]] == {"comments": None, "shares": None}
    assert batch.insights[a["postId"]] == {
        "views": 6900,
        "likes": 387,  # sum of the reactions
        "retention": {  # buckets in number order ("10" last), spread over 0-100, ratios times 100
            "points": [[0.0, 100.0], [25.0, 90.0], [50.0, 80.0], [75.0, 72.0], [100.0, 35.0]],
            "readAt": "2026-11-16T12:00:00.000Z",
            "source": "facebook",
        },
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


def test_facebook_never_uses_the_ids_lookup_graph_v26_removed() -> None:
    """Graph v26.0+ refuses every ``?ids=`` request (error 100), so each Reel and each post is its own node read."""
    reels = [post("facebook", f"12345678901234{n}", platformPostId=f"111222333_44455566{n}") for n in range(3)]
    names = ("facebook_video_insights", "facebook_post_views", "facebook_retention_graph")
    http = FakeHttp(*[(200, name) for _ in reels for name in names])
    batch = FacebookAdapter(tokens=tokens).fetch_stats(reels, ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 9
    for url in http.urls:
        assert "ids=" not in url
        assert not urlsplit(url).path.endswith("/v27.0/")  # never the root node
    assert [urlsplit(u).path for u in http.urls] == [
        p
        for n in range(3)
        for p in (f"/v27.0/12345678901234{n}", f"/v27.0/111222333_44455566{n}", f"/v27.0/12345678901234{n}")
    ]
    assert {r["postId"] for r in reels} == set(batch.insights)
    assert all(batch.insights[r["postId"]]["views"] == 6900 for r in reels)
    assert batch.errors == {}
    assert batch.requests == 9


def test_facebook_one_failing_reel_does_not_block_the_rest(capsys: pytest.CaptureFixture[str]) -> None:
    gone_reel = post("facebook", "1111111111111111", platformPostId="111222333_000000001")
    broken = post("facebook", "2222222222222222", platformPostId="111222333_000000002")
    fine = post("facebook", "1234567890123456")  # no post id: no reach request
    gone = {
        "error": {
            "message": "Unsupported get request. Object with ID '1111111111111111' does not exist, cannot be loaded "
            "due to missing permissions, or does not support this operation.",
            "type": "GraphMethodException",
            "code": 100,
            "error_subcode": 33,
        }
    }
    http = FakeHttp((400, gone), (400, IDS_DEPRECATED), (200, "facebook_video_insights"), (200, NO_DATA))
    batch = FacebookAdapter(tokens=tokens).fetch_stats(
        [gone_reel, broken, fine], ACCOUNT, now=NOW, want_insights=False, http=http
    )
    assert len(http.calls) == 4
    assert batch.errors == {
        gone_reel["postId"]: "Facebook could not find this Reel. It may be deleted.",
        broken["postId"]: "Facebook did not answer. We will try again soon.",
    }
    assert batch.insights[fine["postId"]]["views"] == 6900
    assert batch.meta.error_code == "100"  # not a throttle and not a dead token: nothing is blocked
    lines = stats_logs(capsys)
    assert [(x["level"], x["event"], x["platform"], x["code"]) for x in lines] == [
        ("warning", "stats.read_failed", "facebook", "100/33"),
        ("warning", "stats.read_failed", "facebook", "100"),
    ]
    assert lines[1]["error"] == "The ids query parameter is deprecated in v26.0+."
    assert "<id>" in lines[0]["error"]
    text = json.dumps(lines)
    for secret in ("1111111111111111", "2222222222222222", "token-facebook", "111222333"):
        assert secret not in text


@pytest.mark.parametrize("code", ["80001", "190"])
def test_facebook_throttle_or_dead_token_stops_the_batch(code: str) -> None:
    reels = [post("facebook", f"12345678901234{n}") for n in range(3)]
    answer = {"error": {"message": "Stop", "code": int(code)}}
    http = FakeHttp((200, "facebook_video_insights"), (200, NO_DATA), (400, answer))
    batch = FacebookAdapter(tokens=tokens).fetch_stats(reels, ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 3  # the third Reel is never asked for
    assert batch.meta.error_code == code
    assert batch.insights[reels[0]["postId"]]["views"] == 6900
    assert batch.errors[reels[1]["postId"]] == "Facebook did not answer. We will try again soon."
    assert batch.errors[reels[2]["postId"]] == "Facebook is busy. We will try again later."


def test_facebook_reach_is_guarded() -> None:
    a = post("facebook", "1234567890123456", platformPostId="111222333_444555666")
    gone = {"error": {"message": "(#100) The value must be a valid insights metric", "code": 100}}
    http = FakeHttp((200, "facebook_video_insights"), (400, gone), (400, gone))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert "reachUnique" not in batch.insights[a["postId"]]["extra"]
    assert "retention" not in batch.insights[a["postId"]]  # §56: a graph error is guarded the same way
    assert batch.insights[a["postId"]]["views"] == 6900
    assert batch.meta.error_code is None  # a reach error never blocks the platform


def test_facebook_reach_throttle_stops_the_batch() -> None:
    a = post("facebook", "1234567890123456", platformPostId="111222333_444555666")
    b = post("facebook", "1234567890123457", platformPostId="111222333_444555667")
    throttled = {"error": {"message": "Too many calls", "code": 80001}}
    http = FakeHttp((200, "facebook_video_insights"), (400, throttled))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a, b], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 2
    assert batch.meta.error_code == "80001"
    assert batch.insights[a["postId"]]["views"] == 6900
    assert batch.errors[b["postId"]] == "Facebook is busy. We will try again later."


def _fb_graph(value: Any) -> dict[str, Any]:
    return {"video_insights": {"data": [{"name": "post_video_retention_graph", "values": [{"value": value}]}]}}


@pytest.mark.parametrize(
    ("value", "points"),
    [
        ({"0": 100, "15": 40, "5": 70.5}, [[0.0, 100.0], [50.0, 70.5], [100.0, 40.0]]),  # already percent
        ([1.2, 0.6], [[0.0, 120.0], [100.0, 60.0]]),  # a list of ratios
        ({"x": 1, "1": 0.5, "2": None}, None),  # one usable bucket: no curve
        ("not a graph", None),
    ],
)
def test_facebook_retention_shapes(value: Any, points: list[list[float]] | None) -> None:
    a = post("facebook", "1234567890123456")
    http = FakeHttp((200, "facebook_video_insights"), (200, _fb_graph(value)))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert batch.insights[a["postId"]].get("retention", {}).get("points") == points


def test_facebook_retention_throttle_stops_the_batch() -> None:
    a = post("facebook", "1234567890123456")
    b = post("facebook", "1234567890123457")
    throttled = {"error": {"message": "Too many calls", "code": 80001}}
    http = FakeHttp((200, "facebook_video_insights"), (400, throttled))
    batch = FacebookAdapter(tokens=tokens).fetch_stats([a, b], ACCOUNT, now=NOW, want_insights=False, http=http)
    assert len(http.calls) == 2
    assert batch.meta.error_code == "80001"
    assert "retention" not in batch.insights[a["postId"]]
    assert batch.insights[a["postId"]]["views"] == 6900


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
