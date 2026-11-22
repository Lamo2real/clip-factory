"""The Private test run (docs/CONTRACTS.md §46.8; tests §46.15 ``test_autopost_private.py``).

Only the internal ``postOptions.test == "private"`` (written by auto-posting's private run, never by a request body)
turns on the test behaviour: YouTube as Only me without telling subscribers, Facebook finished as a draft, Instagram
uploaded and checked but never published. Each post is marked posted as private, so none joins the stats poller.
"""

from __future__ import annotations

import json
from datetime import timedelta

from autopost_support import PK, clip_of, deps, posts_of, ready, review_clip
from clipfactory_api import db, posts
from clipfactory_api.app import App
from clipfactory_api.autopost import run
from clipfactory_api.clock import iso
from clipfactory_api.flows.clip_flow import run_clip_flow
from clipfactory_api.platforms.base import Published
from clipfactory_api.platforms.publishers import FacebookPublisher, InstagramPublisher, YouTubePublisher
from conftest import NOW, USER, Call, Clock
from fakes import FakeDurableContext, FakeHttp, FakeS3, FakeTable
from test_publish_flow import YOUTUBE_OK, deps_for
from test_publishers import form, make_job

TEST = {"test": "private"}
FB_DRAFT_READY = {
    "status": {
        "video_status": "ready",
        "uploading_phase": {"status": "complete"},
        "processing_phase": {"status": "complete"},
        "publishing_phase": {"status": "not_started"},
    },
    "id": "1234567890123",
}


def private_run(app: App) -> run.Outcome:
    return run.run_once(deps(app), USER, "private_now", app.clock())


# --- the run --------------------------------------------------------------------------------------------------------


def test_a_private_run_sends_the_next_clip_with_every_post_marked_test(
    app: App, call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    ready(store, "youtube", "instagram", "facebook", "x", "tiktok", audit="ok")
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    second = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    outcome = private_run(app)
    assert outcome.run is not None
    run_id = f"{iso(NOW)}#private_now"
    assert (outcome.run["runId"], outcome.run["mode"]) == (run_id, "private")
    # One clip, and X (no private posts) and TikTok (never) left out.
    assert outcome.run["clips"] == [
        {
            "clipId": first["clipId"],
            "hook": "He lost it",
            "places": ["youtube", "instagram", "facebook"],
            "outcome": "sent",
        }
    ]
    found = posts_of(table, first["clipId"])
    assert set(found) == {"youtube", "instagram", "facebook"}
    assert {p["postOptions"]["test"] for p in found.values()} == {"private"}
    assert found["facebook"]["postOptions"] == TEST
    assert {p["autoRun"] for p in found.values()} == {run_id}
    stored = clip_of(store, first["clipId"])
    assert (stored["autoRun"], stored["autoAt"], stored["autoTest"]) == (run_id, iso(NOW), "private")
    assert clip_of(store, second["clipId"])["status"] == "review"
    # The public shapes: Clip.auto with test, each Post auto and test; postOptions never leaves.
    clip = call("GET", f"/v1/clips/{first['clipId']}")[1]["clip"]
    assert clip["auto"] == {"runId": run_id, "at": iso(NOW), "test": "private"}
    listed = call("GET", "/v1/posts")[1]["posts"]
    assert {(p["auto"], p["test"]) for p in listed} == {(True, "private")}
    assert not any("postOptions" in p for p in listed)


def test_a_private_run_never_takes_a_campaign_clip(app: App, store: db.Store, s3_client: FakeS3) -> None:
    from test_campaign_posting import FITS, campaign_clip, put_campaign, put_crconn

    ready(store, "youtube", "instagram")
    put_campaign(store)
    put_crconn(store)
    campaign_clip(store, checklist=FITS)
    outcome = private_run(app)
    assert outcome.run is not None
    assert (outcome.run["note"], outcome.run["clips"]) == ("Nothing in Review to test with.", [])


def test_upload_can_never_set_the_test(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ready(store, "youtube", "facebook", "tiktok")
    clip = review_clip(store, s3_client)
    tiktok = {
        "privacyLevel": "SELF_ONLY",
        "disableComment": False,
        "disableDuet": False,
        "disableStitch": False,
        "brandContent": False,
        "brandOrganic": False,
    }
    for body, message in [
        ({"platforms": ["youtube"], "options": {"youtube": {"test": "private"}}}, "Unknown field: test."),
        ({"platforms": ["facebook"], "options": {"facebook": TEST}}, "Unknown field: facebook."),
        ({"platforms": ["tiktok"], "tiktok": {**tiktok, "test": "private"}}, "Unknown field: test."),
        ({"platforms": ["youtube"], "auto": {"runId": "x", "at": "y", "test": "private"}}, "Unknown field: auto."),
    ]:
        status, out = call("POST", f"/v1/clips/{clip['clipId']}/confirm", body)
        assert (status, out["error"]["message"]) == (400, message)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube", "facebook"]})[0] == 200
    stored = clip_of(store, clip["clipId"])
    assert not {"autoRun", "autoAt", "autoTest"} & set(stored)
    for post in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True):
        assert "test" not in (post.get("postOptions") or {})
        assert "autoRun" not in post


# --- the publishers -------------------------------------------------------------------------------------------------


def test_youtube_private_test_is_only_me_without_telling_subscribers() -> None:
    http = FakeHttp((200, b"", {"Location": "https://upload.example/session"}), (201, "publish/youtube_video"))
    options = {**TEST, "privacy": "public", "notifySubscribers": True, "campaign": {"paidPartnership": False}}
    job, _, _ = make_job("youtube", http, options=options)
    YouTubePublisher().start(job)
    init = http.calls[0]
    assert init.url.endswith("&notifySubscribers=false")
    assert json.loads(init.body)["status"]["privacyStatus"] == "private"
    published = YouTubePublisher().published(job, {"videoId": "vid123"})
    assert (published.url, published.privacy) == ("https://www.youtube.com/shorts/vid123", "private")


def test_youtube_without_the_test_is_as_before() -> None:
    job, _, _ = make_job("youtube", FakeHttp(), options={"privacy": "public"})
    publisher = YouTubePublisher()
    assert publisher.metadata(job)["status"]["privacyStatus"] == "public"
    assert "notifySubscribers" not in publisher.upload_url(job)
    assert publisher.published(job, {"videoId": "v"}).privacy == "public"


def test_facebook_private_test_is_a_draft_on_the_page() -> None:
    http = FakeHttp(
        (200, "publish/facebook_start"),
        (200, "publish/facebook_upload"),
        (200, "publish/facebook_status_uploaded"),
        (200, "publish/facebook_finish"),
        (200, FB_DRAFT_READY),
    )
    job, saved, _ = make_job("facebook", http, data={"pageId": "p1"}, options=dict(TEST))
    publisher = FacebookPublisher()
    publisher.start(job)
    handle = saved[-1]
    assert publisher.check(job, handle).state == "ready_to_finish"
    after = publisher.finish(job, handle)
    assert form(http.calls[3])["video_state"] == ["DRAFT"]
    done = publisher.check(job, after.handle)
    assert done.state == "done"
    assert done.published == Published(
        url="", posted_at=iso(NOW), platform_post_id="1234567890123", stats_id=None, privacy="private"
    )
    assert len(http.calls) == 5  # no permalink read for a draft


def test_facebook_without_the_test_waits_for_publishing() -> None:
    http = FakeHttp((200, "publish/facebook_finish"), (200, FB_DRAFT_READY))
    job, _, _ = make_job("facebook", http, data={"pageId": "p1"})
    publisher = FacebookPublisher()
    after = publisher.finish(job, {"videoId": "1234567890123", "uploaded": True})
    assert form(http.calls[0])["video_state"] == ["PUBLISHED"]
    assert publisher.check(job, after.handle).state == "processing"


def test_instagram_private_test_is_checked_and_never_published() -> None:
    http = FakeHttp(
        (200, "publish/instagram_limit"),
        (200, "publish/instagram_container"),
        (200, "publish/instagram_upload"),
        (200, "publish/instagram_status_finished"),
    )
    job, saved, _ = make_job("instagram", http, data={"igUserId": "1784"}, options=dict(TEST))
    publisher = InstagramPublisher()
    publisher.start(job)
    done = publisher.check(job, saved[-1])
    assert done.state == "done"
    assert done.published == Published(
        url="", posted_at=iso(NOW), platform_post_id="17889455560051444", stats_id=None, privacy="private"
    )
    assert not any("media_publish" in u for u in http.urls)
    # A finish (a replayed step) never publishes either.
    assert publisher.finish(job, saved[-1]).state == "done"
    assert len(http.calls) == 4


def test_instagram_without_the_test_is_ready_to_publish() -> None:
    http = FakeHttp((200, "publish/instagram_status_finished"))
    job, _, _ = make_job("instagram", http, data={"igUserId": "1784"})
    handle = {"container": "17889455560051444", "uploaded": True}
    assert InstagramPublisher().check(job, handle).state == "ready_to_finish"


def test_private_posts_never_join_the_stats_poller(store: db.Store) -> None:
    for n, published in enumerate(
        [
            Published("https://www.youtube.com/shorts/v1", iso(NOW), "v1", "v1", "private"),
            Published("", iso(NOW), "1234567890123", None, "private"),
        ]
    ):
        item = {"pk": PK, "sk": db.post_sk(f"P{n}"), "type": "post", "postId": f"P{n}", "status": "queued"}
        item["platform"] = "youtube" if n == 0 else "facebook"
        store.put(item)
        written = posts.mark_posted(store, item, published, NOW)
        assert written["privacy"] == "private"
        assert not {"statsId", "statsDueAt", "gsi2pk", "gsi2sk"} & set(written)
        assert ("url" in written) == (n == 0)


# --- the whole way through the clip flow ----------------------------------------------------------------------------


def test_a_private_run_through_the_clip_flow_posts_nothing_public(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube", "instagram", "facebook")
    clip = review_clip(store, s3_client)
    private_run(app)
    http = FakeHttp(
        *YOUTUBE_OK,
        (200, "publish/instagram_limit"),
        (200, "publish/instagram_container"),
        (200, "publish/instagram_upload"),
        (200, "publish/instagram_status_finished"),
        (200, "publish/facebook_start"),
        (200, "publish/facebook_upload"),
        (200, "publish/facebook_status_uploaded"),
        (200, "publish/facebook_finish"),
        (200, FB_DRAFT_READY),
    )
    clock.now = NOW + timedelta(minutes=1)
    out = run_clip_flow(
        FakeDurableContext(), {"clipId": clip["clipId"], "userId": USER, "run": 1}, deps_for(store, http)
    )
    assert out["outcome"] == "done"
    assert json.loads(http.calls[0].body)["status"]["privacyStatus"] == "private"
    assert "notifySubscribers=false" in http.calls[0].url
    assert not any("media_publish" in u for u in http.urls)
    finish = next(c for c in http.calls if c.body and b"upload_phase=finish" in c.body)
    assert form(finish)["video_state"] == ["DRAFT"]
    found = posts_of(table, clip["clipId"])
    assert {p["status"] for p in found.values()} == {"posted"}
    assert {p["privacy"] for p in found.values()} == {"private"}
    assert not any({"statsId", "gsi2pk"} & set(p) for p in found.values())
    assert found["youtube"]["url"] == "https://www.youtube.com/shorts/vid123"
    assert "url" not in found["instagram"]
    assert "url" not in found["facebook"]
    assert clip_of(store, clip["clipId"])["status"] == "posted"
