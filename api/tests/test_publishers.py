"""The start → check → finish publishers with recorded platform answers (docs/CONTRACTS.md §17.6, §17.12)."""

from __future__ import annotations

import itertools
import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api.oauth.providers import AppKeys
from clipfactory_api.oauth.tokens import Credentials
from clipfactory_api.platforms import errors
from clipfactory_api.platforms.base import NetworkError, PublishError, PublishJob, RetryablePublishError
from clipfactory_api.platforms.publishers import (
    FacebookPublisher,
    InstagramPublisher,
    TikTokPublisher,
    XPublisher,
    YouTubePublisher,
    chunk_plan,
    instagram_caption,
    publisher_for,
    tiktok_chunks,
    x_text,
)
from clipfactory_api.stats.config import PUBLISH_DEFAULTS
from conftest import CAPTIONS, NOW, Clock
from fakes import FakeHttp, FakeVideo

MB = 1024 * 1024
SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xa298sd_f"
META_SECRET = "0123456789abcdef0123456789abcdef"


def make_job(
    platform: str,
    http: FakeHttp,
    *,
    size: int = 3 * MB,
    handle: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
    settings: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
    captions: dict[str, Any] | None = None,
) -> tuple[PublishJob, list[dict[str, Any]], FakeVideo]:
    saved: list[dict[str, Any]] = []
    video = FakeVideo(size)
    post: dict[str, Any] = {"postId": "P1", "platform": platform, "status": "queued"}
    if handle is not None:
        post["publishHandle"] = handle
    access = "PAGE-TOKEN" if platform == "facebook" else "ACCESS-TOKEN"
    job = PublishJob(
        post=post,
        clip={"clipId": "C1", "captions": captions or dict(CAPTIONS), "durationSec": 31.5, "hook": "He lost it"},
        account={"platform": platform, "accountId": "acct"},
        creds=Credentials(platform, access, AppKeys("1234567890", META_SECRET), data or {}),
        video=video,
        options=options or {},
        settings=settings or {"youtubePrivacy": "public"},
        http=http,
        config=config or dict(PUBLISH_DEFAULTS[platform]),
        save=saved.append,
        now=Clock(NOW),
    )
    return job, saved, video


def form(request: Any) -> dict[str, list[str]]:
    return parse_qs(request.body.decode())


# --- YouTube -------------------------------------------------------------------------------------------------------


def test_youtube_resumable_upload_in_8_mb_chunks() -> None:
    http = FakeHttp(
        (200, b"", {"Location": SESSION}),
        (308, b"", {"Range": "bytes=0-8388607"}),
        (308, b"", {"Range": "bytes=0-16777215"}),
        (201, "publish/youtube_video"),
    )
    job, saved, _ = make_job("youtube", http, size=20 * MB, settings={"youtubePrivacy": "unlisted"})
    progress = YouTubePublisher().start(job)
    init = http.calls[0]
    assert init.method == "POST"
    assert init.url == "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
    assert init.headers["X-Upload-Content-Length"] == str(20 * MB)
    assert init.headers["X-Upload-Content-Type"] == "video/mp4"
    assert init.headers["Authorization"] == "Bearer ACCESS-TOKEN"
    assert json.loads(init.body) == {
        "snippet": {"title": "He did WHAT", "description": "Full stream on the channel.", "categoryId": "20"},
        "status": {"privacyStatus": "unlisted", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False},
    }
    ranges = [c.headers["Content-Range"] for c in http.calls[1:]]
    assert ranges == [
        f"bytes 0-{8 * MB - 1}/{20 * MB}",
        f"bytes {8 * MB}-{16 * MB - 1}/{20 * MB}",
        f"bytes {16 * MB}-{20 * MB - 1}/{20 * MB}",
    ]
    assert all((8 * MB) % (256 * 1024) == 0 for _ in ranges)
    # The session URL is kept only while the upload runs (it is a capability URL), then dropped.
    assert saved == [{"sessionUri": SESSION}, {"videoId": "vid123"}]
    assert "sessionUri" not in progress.handle
    assert (progress.state, progress.check_after) == ("processing", 30)


def test_youtube_resumes_after_an_interruption() -> None:
    http = FakeHttp((308, b"", {"Range": "bytes=0-8388607"}), (200, "publish/youtube_video"))
    job, saved, video = make_job("youtube", http, size=12 * MB, handle={"sessionUri": SESSION})
    YouTubePublisher().start(job)
    assert http.calls[0].headers["Content-Range"] == f"bytes */{12 * MB}"
    assert http.calls[1].headers["Content-Range"] == f"bytes {8 * MB}-{12 * MB - 1}/{12 * MB}"
    assert [c.method for c in http.calls] == ["PUT", "PUT"]  # no second video created
    assert video.reads == [(8 * MB, 12 * MB)]
    assert saved[-1] == {"videoId": "vid123"}


def test_youtube_resume_when_the_upload_already_finished() -> None:
    http = FakeHttp((200, "publish/youtube_video"))
    job, saved, _ = make_job("youtube", http, handle={"sessionUri": SESSION})
    assert YouTubePublisher().start(job).handle == {"videoId": "vid123"}
    assert saved[-1] == {"videoId": "vid123"}
    assert len(http.calls) == 1


def test_youtube_expired_session_starts_again() -> None:
    http = FakeHttp((404, b""), (200, b"", {"Location": SESSION + "2"}), (200, "publish/youtube_video"))
    job, _, _ = make_job("youtube", http, handle={"sessionUri": SESSION})
    YouTubePublisher().start(job)
    assert [c.method for c in http.calls] == ["PUT", "POST", "PUT"]


def test_youtube_with_a_video_id_only_checks() -> None:
    http = FakeHttp()
    job, _, _ = make_job("youtube", http, handle={"sessionUri": SESSION, "videoId": "vid123"})
    progress = YouTubePublisher().start(job)
    assert (progress.state, progress.handle) == ("processing", {"videoId": "vid123"})
    assert http.calls == []


def test_youtube_check() -> None:
    http = FakeHttp((200, "publish/youtube_uploaded"), (200, "publish/youtube_processed"))
    job, _, _ = make_job("youtube", http)
    publisher = YouTubePublisher()
    handle = {"videoId": "vid123"}
    assert publisher.check(job, handle).state == "processing"
    done = publisher.check(job, handle)
    assert http.calls[0].url == "https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=vid123"
    assert done.state == "done"
    assert done.published is not None
    assert done.published.url == "https://www.youtube.com/shorts/vid123"
    assert (done.published.platform_post_id, done.published.stats_id) == ("vid123", "vid123")


def test_youtube_rejected() -> None:
    http = FakeHttp(
        (200, {"items": [{"id": "v", "status": {"uploadStatus": "rejected", "rejectionReason": "duplicate"}}]})
    )
    job, _, _ = make_job("youtube", http)
    with pytest.raises(PublishError, match="duplicate"):
        YouTubePublisher().check(job, {"videoId": "v"})


def test_youtube_metadata_limits() -> None:
    job, _, _ = make_job(
        "youtube",
        FakeHttp(),
        captions={"youtubeTitle": "<b>" + "T" * 200, "youtubeDescription": "é" * 4000 + "<script>"},
    )
    meta = YouTubePublisher().metadata(job)
    assert len(meta["snippet"]["title"]) == 100
    assert "<" not in meta["snippet"]["title"]
    assert len(meta["snippet"]["description"].encode()) <= 5000
    assert "<" not in meta["snippet"]["description"]


def test_youtube_quota_error_is_a_daily_cap() -> None:
    body = {"error": {"code": 403, "errors": [{"reason": "quotaExceeded"}]}}
    http = FakeHttp((403, body))
    job, _, _ = make_job("youtube", http)
    with pytest.raises(PublishError) as e:
        YouTubePublisher().start(job)
    assert not isinstance(e.value, RetryablePublishError)
    assert str(e.value) == "YouTube says slow down. Press Try again tomorrow."


# --- TikTok --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("size", "chunk", "count", "last"),
    [
        (3 * MB, 3 * MB, 1, 3 * MB),
        (70 * MB, 10 * MB, 7, 10 * MB),
        (200 * MB, 10 * MB, 20, 10 * MB),
        (75 * MB + 123, 10 * MB, 7, 15 * MB + 123),
    ],
)
def test_tiktok_chunk_math(size: int, chunk: int, count: int, last: int) -> None:
    assert tiktok_chunks(size) == (chunk, count)
    plan = chunk_plan(size, chunk)
    assert len(plan) == count
    assert plan[-1][1] - plan[-1][0] == last
    assert plan[-1][1] == size
    assert all(b == c for (_, b), (c, _) in itertools.pairwise(plan))


def test_tiktok_start_sends_the_file_in_chunks() -> None:
    size = 70 * MB
    http = FakeHttp((200, "publish/tiktok_creator"), (200, "publish/tiktok_init"), *[(206, b"")] * 6, (201, b""))
    options = {"privacyLevel": "PUBLIC_TO_EVERYONE", "disableComment": True, "brandContent": False}
    job, saved, _ = make_job("tiktok", http, size=size, options=options)
    progress = TikTokPublisher().start(job)
    assert http.calls[0].url == "https://open.tiktokapis.com/v2/post/publish/creator_info/query/"
    init = http.calls[1]
    assert init.url == "https://open.tiktokapis.com/v2/post/publish/video/init/"
    sent = json.loads(init.body)
    assert sent["source_info"] == {
        "source": "FILE_UPLOAD",
        "video_size": size,
        "chunk_size": 10 * MB,
        "total_chunk_count": 7,
    }
    assert sent["post_info"] == {
        "title": "wait for it",
        "privacy_level": "PUBLIC_TO_EVERYONE",
        "disable_comment": True,
        "disable_duet": False,
        "disable_stitch": True,  # the creator turned Stitch off
        "brand_content_toggle": False,
        "brand_organic_toggle": False,
        "is_aigc": False,
    }
    puts = http.calls[2:]
    assert len(puts) == 7
    assert puts[0].url.startswith("https://open-upload.tiktokapis.com/video/?upload_id=")
    assert puts[0].headers["Content-Range"] == f"bytes 0-{10 * MB - 1}/{size}"
    assert puts[-1].headers["Content-Range"] == f"bytes {60 * MB}-{size - 1}/{size}"
    assert saved[0]["publishId"] == "v_pub_file~v2-1.7"
    assert saved[-1] == {
        "publishId": "v_pub_file~v2-1.7",
        "username": "owner",
        "privacy": "PUBLIC_TO_EVERYONE",
        "uploaded": True,
    }
    assert "uploadUrl" not in saved[-1]
    assert (progress.state, progress.check_after) == ("processing", 15)


def test_tiktok_refuses_a_privacy_the_creator_cannot_use() -> None:
    http = FakeHttp(
        (
            200,
            {
                **json.loads(__import__("fakes").stats_fixture("publish/tiktok_creator")),
                "data": {"privacy_level_options": ["SELF_ONLY"]},
            },
        )
    )
    job, _, _ = make_job("tiktok", http, options={"privacyLevel": "PUBLIC_TO_EVERYONE"})
    with pytest.raises(PublishError, match="Pick who can see it on TikTok"):
        TikTokPublisher().start(job)


@pytest.mark.parametrize("privacy", ["SELF_ONLY", "FOLLOWER_OF_CREATOR"])
def test_tiktok_refuses_branded_content_that_is_not_for_everyone_or_friends(privacy: str) -> None:
    http = FakeHttp(
        (
            200,
            {
                **json.loads(__import__("fakes").stats_fixture("publish/tiktok_creator")),
                "data": {
                    "privacy_level_options": [
                        "PUBLIC_TO_EVERYONE",
                        "MUTUAL_FOLLOW_FRIENDS",
                        "FOLLOWER_OF_CREATOR",
                        "SELF_ONLY",
                    ]
                },
            },
        )
    )
    job, _, _ = make_job("tiktok", http, options={"privacyLevel": privacy, "brandContent": True})
    with pytest.raises(PublishError, match="Pick who can see it on TikTok"):
        TikTokPublisher().start(job)
    assert len(http.calls) == 1  # never init: nothing reaches TikTok


def test_tiktok_refuses_a_too_long_clip() -> None:
    creator = json.loads(__import__("fakes").stats_fixture("publish/tiktok_creator"))
    creator["data"]["max_video_post_duration_sec"] = 10
    job, _, _ = make_job("tiktok", FakeHttp((200, creator)), options={"privacyLevel": "SELF_ONLY"})
    with pytest.raises(PublishError, match="longer than TikTok allows"):
        TikTokPublisher().start(job)


def test_tiktok_spam_error_on_creator_info() -> None:
    http = FakeHttp((200, {"data": {}, "error": {"code": "spam_risk_too_many_posts"}}))
    job, _, _ = make_job("tiktok", http, options={"privacyLevel": "SELF_ONLY"})
    with pytest.raises(PublishError, match="Press Try again tomorrow"):
        TikTokPublisher().start(job)


def test_tiktok_check_private_and_public() -> None:
    publisher = TikTokPublisher()
    http = FakeHttp((200, "publish/tiktok_status_processing"), (200, "publish/tiktok_status_complete"))
    job, _, _ = make_job("tiktok", http)
    private = {"publishId": "v1", "username": "owner", "privacy": "SELF_ONLY", "uploaded": True}
    assert publisher.check(job, private).state == "processing"
    assert json.loads(http.calls[0].body) == {"publish_id": "v1"}
    done = publisher.check(job, private)
    assert done.published is not None
    assert done.published.privacy == "private"
    assert done.published.stats_id is None
    assert done.published.url == "https://www.tiktok.com/@owner"
    public = publisher.published(job, {**private, "privacy": "PUBLIC_TO_EVERYONE", "postIds": ["7311"]})
    assert (public.stats_id, public.url) == ("7311", "https://www.tiktok.com/@owner/video/7311")
    waiting = publisher.published(job, {**private, "privacy": "PUBLIC_TO_EVERYONE", "postIds": []})
    assert waiting.stats_id is None


@pytest.mark.parametrize(("reason", "retryable"), [("internal", True), ("file_format_check_failed", False)])
def test_tiktok_failed(reason: str, retryable: bool) -> None:
    http = FakeHttp((200, {"data": {"status": "FAILED", "fail_reason": reason}, "error": {"code": "ok"}}))
    job, _, _ = make_job("tiktok", http)
    with pytest.raises(PublishError) as e:
        TikTokPublisher().check(job, {"publishId": "v1"})
    assert isinstance(e.value, RetryablePublishError) is retryable


# --- Instagram -------------------------------------------------------------------------------------------------------


def test_instagram_resumable_upload_then_publish() -> None:
    http = FakeHttp(
        (200, "publish/instagram_limit"),
        (200, "publish/instagram_container"),
        (200, "publish/instagram_upload"),
        (200, "publish/instagram_status_finished"),
        (200, "publish/instagram_publish"),
        (200, "publish/instagram_permalink"),
    )
    job, saved, _ = make_job("instagram", http, data={"igUserId": "1784"}, captions={"instagram": "#a " * 40})
    publisher = InstagramPublisher()
    assert publisher.start(job).state == "processing"
    assert http.calls[0].url.startswith(
        "https://graph.facebook.com/v27.0/1784/content_publishing_limit?fields=config%2Cquota_usage&appsecret_proof="
    )
    container = form(http.calls[1])
    assert http.calls[1].url == "https://graph.facebook.com/v27.0/1784/media"
    assert container["media_type"] == ["REELS"]
    assert container["upload_type"] == ["resumable"]
    assert container["share_to_feed"] == ["true"]
    assert container["caption"][0].count("#a") == 30
    assert "appsecret_proof" in container
    upload = http.calls[2]
    assert upload.url == "https://rupload.facebook.com/ig-api-upload/v27.0/17889455560051444"
    assert upload.headers["Authorization"] == "OAuth ACCESS-TOKEN"
    assert (upload.headers["offset"], upload.headers["file_size"]) == ("0", str(3 * MB))
    assert len(upload.body) == 3 * MB
    assert saved == [{"container": "17889455560051444"}, {"container": "17889455560051444", "uploaded": True}]
    handle = saved[-1]
    assert publisher.check(job, handle).state == "ready_to_finish"
    done = publisher.finish(job, handle)
    assert form(http.calls[4])["creation_id"] == ["17889455560051444"]
    assert done.published is not None
    assert done.published.url == "https://www.instagram.com/reel/C1a2b3c4d5/"
    assert done.published.stats_id == "17920238422030506"


def test_instagram_video_url_fallback() -> None:
    http = FakeHttp((200, "publish/instagram_limit"), (200, "publish/instagram_container"))
    job, saved, _ = make_job(
        "instagram", http, data={"igUserId": "1784"}, config={**PUBLISH_DEFAULTS["instagram"], "source": "video_url"}
    )
    InstagramPublisher().start(job)
    sent = form(http.calls[1])
    assert sent["video_url"][0].startswith("https://cf-prod-media-123.s3.")
    assert "upload_type" not in sent
    assert len(http.calls) == 2
    assert saved[-1]["uploaded"] is True


def test_instagram_upload_5xx_falls_back_to_video_url() -> None:
    # Seen in prod on 21 Nov 2026: rupload answered 500 three times for a good file. Instagram fetches it instead.
    http = FakeHttp(
        (200, "publish/instagram_limit"),
        (200, "publish/instagram_container"),
        (500, {"debug_info": {"type": "ProcessingFailedError", "message": "Request processing failed"}}),
        (200, {"id": "17900000000000002"}),
    )
    job, saved, _ = make_job("instagram", http, data={"igUserId": "1784"})
    progress = InstagramPublisher().start(job)
    assert progress.state == "processing"
    assert form(http.calls[1])["upload_type"] == ["resumable"]
    retry = form(http.calls[3])
    assert http.calls[3].url == "https://graph.facebook.com/v27.0/1784/media"
    assert retry["video_url"][0].startswith("https://cf-prod-media-123.s3.")
    assert "upload_type" not in retry
    assert retry["media_type"] == ["REELS"]
    assert saved[-1] == {"container": "17900000000000002", "uploaded": True}


def test_instagram_daily_limit() -> None:
    http = FakeHttp((200, {"data": [{"config": {"quota_total": 50}, "quota_usage": 50}]}))
    job, _, _ = make_job("instagram", http, data={"igUserId": "1784"})
    with pytest.raises(PublishError, match="Instagram's daily limit is reached"):
        InstagramPublisher().start(job)


def test_instagram_container_error() -> None:
    http = FakeHttp((200, {"status_code": "ERROR"}))
    job, _, _ = make_job("instagram", http, data={"igUserId": "1784"})
    with pytest.raises(PublishError, match="did not like this video file"):
        InstagramPublisher().check(job, {"container": "c1", "uploaded": True})


# --- Facebook --------------------------------------------------------------------------------------------------------


def test_facebook_reel_upload_finish_and_permalink() -> None:
    http = FakeHttp(
        (200, "publish/facebook_start"),
        (200, "publish/facebook_upload"),
        (200, "publish/facebook_status_uploaded"),
        (400, {"error": {"code": 100, "message": "(#100) Param video_state must be one of {DRAFT, PUBLISHED}"}}),
        (200, "publish/facebook_finish"),
        (200, "publish/facebook_status_published"),
        (200, "publish/facebook_permalink"),
    )
    job, saved, _ = make_job("facebook", http, data={"pageId": "p1"})
    publisher = FacebookPublisher()
    publisher.start(job)
    assert http.calls[0].url == "https://graph.facebook.com/v27.0/p1/video_reels"
    assert form(http.calls[0])["upload_phase"] == ["start"]
    upload = http.calls[1]
    assert upload.url == "https://rupload.facebook.com/video-upload/v27.0/1234567890123"
    assert upload.headers["Authorization"] == "OAuth PAGE-TOKEN"
    assert (upload.headers["offset"], upload.headers["file_size"]) == ("0", str(3 * MB))
    handle = saved[-1]
    assert handle == {"videoId": "1234567890123", "uploaded": True}
    assert publisher.check(job, handle).state == "ready_to_finish"
    after = publisher.finish(job, handle)
    first, second = form(http.calls[3]), form(http.calls[4])
    assert (first["video_state"], second["video_state"]) == (["PUBLISHED"], ["complete"])
    assert first["description"] == ["Watch this"]
    assert after.state == "processing"
    assert after.handle["postId"] == "111222333_444555666"
    done = publisher.check(job, after.handle)
    assert done.published is not None
    assert done.published.url == "https://www.facebook.com/reel/1234567890123"
    assert (done.published.stats_id, done.published.platform_post_id) == ("1234567890123", "111222333_444555666")


def test_facebook_resumes_from_bytes_transferred() -> None:
    status = {"status": {"uploading_phase": {"status": "in_progress", "bytes_transfered": MB}}}
    http = FakeHttp((200, status), (200, "publish/facebook_upload"))
    job, _, video = make_job("facebook", http, data={"pageId": "p1"}, handle={"videoId": "v9"})
    FacebookPublisher().start(job)
    assert http.calls[1].headers["offset"] == str(MB)
    assert video.reads == [(MB, 3 * MB)]


def test_facebook_file_url_fallback() -> None:
    http = FakeHttp((200, "publish/facebook_start"), (200, "publish/facebook_upload"))
    job, _, _ = make_job(
        "facebook", http, data={"pageId": "p1"}, config={**PUBLISH_DEFAULTS["facebook"], "source": "file_url"}
    )
    FacebookPublisher().start(job)
    assert http.calls[1].headers["file_url"].startswith("https://")
    assert http.calls[1].body == b""


def test_facebook_upload_failed() -> None:
    http = FakeHttp((200, {"status": {"video_status": "upload_failed"}}))
    job, _, _ = make_job("facebook", http, data={"pageId": "p1"})
    with pytest.raises(PublishError, match="Facebook did not like"):
        FacebookPublisher().check(job, {"videoId": "v", "uploaded": True})


# --- X ---------------------------------------------------------------------------------------------------------------


def test_x_upload_in_4_mb_appends_and_tweet() -> None:
    size = 10 * MB
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (204, b""),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
    )
    caption = "unreal https://example.com/x " + "word " * 80
    job, saved, _ = make_job("x", http, size=size, data={"username": "owner"}, captions={"x": caption})
    publisher = XPublisher()
    progress = publisher.start(job)
    assert json.loads(http.calls[0].body) == {
        "media_type": "video/mp4",
        "total_bytes": size,
        "media_category": "tweet_video",
    }
    appends = http.calls[1:4]
    assert [a.url for a in appends] == ["https://api.x.com/2/media/upload/1880028106020515840/append"] * 3
    for index, append in enumerate(appends):
        assert f'name="segment_index"\r\n\r\n{index}\r\n'.encode() in append.body
        assert append.headers["Content-Type"].startswith("multipart/form-data; boundary=")
    assert http.calls[4].url == "https://api.x.com/2/media/upload/1880028106020515840/finalize"
    assert (progress.state, progress.check_after) == ("processing", 5)
    assert saved[-1] == {"mediaId": "1880028106020515840", "finalized": True}
    ready = publisher.check(job, progress.handle)
    assert http.calls[5].url == "https://api.x.com/2/media/upload?command=STATUS&media_id=1880028106020515840"
    assert ready.state == "ready_to_finish"
    done = publisher.finish(job, ready.handle)
    tweet = json.loads(http.calls[6].body)
    assert tweet["media"] == {"media_ids": ["1880028106020515840"]}
    assert "http" not in tweet["text"]
    assert len(tweet["text"]) <= 280
    assert tweet["text"].endswith("…")
    assert done.published is not None
    assert done.published.url == "https://x.com/owner/status/1880028300000000001"


def test_x_finish_after_a_replay_does_not_tweet_twice() -> None:
    http = FakeHttp()
    job, _, _ = make_job("x", http, data={"username": "owner"})
    done = XPublisher().finish(job, {"mediaId": "m", "finalized": True, "tweetId": "t1"})
    assert done.published is not None
    assert done.published.stats_id == "t1"
    assert http.calls == []


@pytest.mark.parametrize(
    ("status", "body", "kind"),
    [
        (402, {"title": "CreditsDepleted"}, "credits"),
        (403, {"detail": "You are not allowed to create a Tweet with duplicate content."}, "duplicate"),
        (429, {"title": "Too Many Requests"}, "rate"),
        (401, {"title": "Unauthorized"}, "reconnect"),
    ],
)
def test_x_errors(status: int, body: dict[str, Any], kind: str) -> None:
    http = FakeHttp((status, body))
    job, _, _ = make_job("x", http)
    with pytest.raises(PublishError) as e:
        XPublisher().finish(job, {"mediaId": "m"})
    assert e.value.problem.kind == kind  # type: ignore[attr-defined]


def test_network_errors_are_retryable() -> None:
    http = FakeHttp(NetworkError("timeout"))
    job, _, _ = make_job("x", http)
    with pytest.raises(RetryablePublishError, match="X did not answer"):
        XPublisher().start(job)


# --- captions and the friendly error table -------------------------------------------------------------------------


def test_caption_rules() -> None:
    assert x_text("see https://a.b/c and www.d.e now") == "see and now"
    long = x_text("a" * 300)
    assert len(long) <= 280
    assert long.endswith("…")
    tags = " ".join(f"#t{i}" for i in range(35))
    kept = instagram_caption(tags)
    assert kept.count("#") == 30
    assert "#t29" in kept
    assert "#t30" not in kept
    assert len(instagram_caption("x" * 3000)) == 2200


@pytest.mark.parametrize(
    ("platform", "status", "body", "retryable", "sentence"),
    [
        (
            "youtube",
            403,
            {"error": {"errors": [{"reason": "rateLimitExceeded"}]}},
            True,
            "YouTube says slow down. Clip Factory tries again later.",
        ),
        (
            "youtube",
            403,
            {"error": {"errors": [{"reason": "uploadLimitExceeded"}]}},
            False,
            "YouTube did not accept the upload. Check your channel in YouTube Studio.",
        ),
        (
            "tiktok",
            429,
            {"error": {"code": "rate_limit_exceeded"}},
            True,
            "TikTok says slow down. Clip Factory tries again later.",
        ),
        (
            "tiktok",
            403,
            {"error": {"code": "unaudited_client_can_only_post_to_private_accounts"}},
            False,
            "Make your TikTok account private (Setup step 3), then press Try again.",
        ),
        (
            "tiktok",
            403,
            {"error": {"code": "reached_active_user_cap"}},
            False,
            "TikTok's daily limit for your app is reached. Try tomorrow.",
        ),
        ("tiktok", 400, {"error": {"code": "duration_check_failed"}}, False, "TikTok did not like this video file."),
        ("instagram", 400, {"error": {"code": 4}}, True, "Instagram says slow down. Clip Factory tries again later."),
        ("facebook", 400, {"error": {"code": 80001}}, True, "Facebook says slow down. Clip Factory tries again later."),
        (
            "instagram",
            400,
            {"error": {"code": 100, "error_subcode": 2207026}},
            False,
            "Instagram did not like this video file.",
        ),
        (
            "facebook",
            400,
            {"error": {"code": 190}},
            False,
            "Connect Facebook again in Settings › Posting › Set up posting, then press Try again.",
        ),
        (
            "x",
            402,
            {},
            False,
            "Your X credits ran out. Buy more in console.x.com › Billing › Credits, then press Try again.",
        ),
        ("x", 503, {}, True, "X did not answer."),
        ("youtube", 418, {}, False, "Posting to YouTube did not work. Press Try again."),
    ],
)
def test_friendly_errors(platform: str, status: int, body: dict[str, Any], retryable: bool, sentence: str) -> None:
    assert errors.friendly(platform, status, json.dumps(body).encode()) == (retryable, sentence)


def test_publisher_for_every_platform() -> None:
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        assert publisher_for(platform).platform == platform
    assert urlsplit(SESSION).scheme == "https"
