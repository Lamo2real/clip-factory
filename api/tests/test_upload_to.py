"""Upload to many places (docs/CONTRACTS.md §33): the chosen platforms, old clients, and one place's Try again; and
each place's own options sent with Upload, over the owner's My settings (§34)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db, post_preset, posts
from clipfactory_api.flows import clip_flow
from clipfactory_api.platforms.publishers import InstagramPublisher, XPublisher, YouTubePublisher
from conftest import CLIP_FLOW_ARN, USER, Call, seed_clip
from fakes import FakeHttp, FakeLambda, FakeTable
from test_publishers import form, make_job

TIKTOK = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}


def _connect(store: db.Store, *platforms: str) -> None:
    for platform in platforms:
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": f"ACCOUNT#{platform}",
                "type": "account",
                "userId": USER,
                "platform": platform,
                "status": "connected",
            }
        )


def _starts(lambda_client: FakeLambda) -> list[dict[str, Any]]:
    return [c for c in lambda_client.calls if c["FunctionName"] == CLIP_FLOW_ARN]


def _confirm(call: Call, clip_id: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/confirm", body or {})


# --- Chosen platforms ----------------------------------------------------------------------------------------------


def test_platforms_creates_exactly_those_posts_and_stores_upload_to(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _connect(store, "youtube", "instagram", "facebook", "tiktok")
    clip = seed_clip(store)
    status, body = _confirm(call, clip["clipId"], {"platforms": ["instagram", "youtube"]})
    assert status == 200
    assert [p["platform"] for p in body["posts"]] in (["youtube", "instagram"], ["instagram", "youtube"])
    assert {p["status"] for p in body["posts"]} == {"queued"}
    # STATS_ORDER, whatever order the client sent.
    assert body["clip"]["uploadTo"] == ["youtube", "instagram"]
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert stored["uploadTo"] == ["youtube", "instagram"]


def test_platforms_wins_over_where_clips_go(call: Call, store: db.Store) -> None:
    _connect(store, "youtube", "facebook")
    assert call("PUT", "/v1/settings", {"platforms": ["youtube"]})[0] == 200
    clip = seed_clip(store)
    status, body = _confirm(call, clip["clipId"], {"platforms": ["facebook"]})
    assert status == 200
    assert [p["platform"] for p in body["posts"]] == ["facebook"]


def test_a_platform_that_is_not_set_up_is_refused(call: Call, store: db.Store) -> None:
    _connect(store, "youtube")
    clip = seed_clip(store)
    status, body = _confirm(call, clip["clipId"], {"platforms": ["youtube", "x"]})
    assert status == 400
    assert body["error"]["message"] == "X is not set up yet. Turn it off, then tap Upload."
    stored = store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored is not None
    assert stored["status"] == "review"
    assert posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) == []


@pytest.mark.parametrize(
    ("platforms", "message"),
    [
        ([], "Pick at least one place to upload to."),
        ("youtube", "Pick at least one place to upload to."),
        (["youtube", "youtube"], "YouTube is in the list twice. Pick each place once."),
        (["myspace"], "One of the places to upload to is not one Clip Factory knows."),
        ([3], "One of the places to upload to is not one Clip Factory knows."),
    ],
)
def test_bad_platform_lists_are_refused(call: Call, store: db.Store, platforms: object, message: str) -> None:
    _connect(store, "youtube")
    clip = seed_clip(store)
    status, body = _confirm(call, clip["clipId"], {"platforms": platforms})
    assert status == 400
    assert body["error"]["message"] == message


def test_tiktok_choices_are_needed_only_when_tiktok_is_chosen(call: Call, store: db.Store) -> None:
    _connect(store, "youtube", "tiktok")
    first, second = seed_clip(store), seed_clip(store)
    assert _confirm(call, first["clipId"], {"platforms": ["youtube"]})[0] == 200
    status, body = _confirm(call, second["clipId"], {"platforms": ["youtube", "tiktok"]})
    assert status == 400
    assert body["error"]["message"] == "Pick who can see it on TikTok."
    assert _confirm(call, second["clipId"], {"platforms": ["youtube", "tiktok"], "tiktok": TIKTOK})[0] == 200


def test_old_clients_without_platforms_post_as_before(call: Call, store: db.Store) -> None:
    _connect(store, "youtube")
    clip = seed_clip(store)
    status, body = _confirm(call, clip["clipId"])
    assert status == 200
    assert "uploadTo" not in body["clip"]
    by_platform = {p["platform"]: p["status"] for p in body["posts"]}
    assert by_platform == {
        "youtube": "queued",
        "instagram": "pending_integration",
        "facebook": "pending_integration",
        "tiktok": "pending_integration",
        "x": "pending_integration",
    }


def test_ensure_posts_follows_upload_to_after_a_lost_race(store: db.Store) -> None:
    """The flow creates the posts when Confirm stopped before writing them: it follows the clip's uploadTo."""
    _connect(store, "youtube", "facebook")
    clip = seed_clip(store, status="confirmed", uploadTo=["facebook"], flowRun=1)
    created = posts.create_for_clip(store, USER, clip, {"platforms": ["youtube", "x"]}, "2026-11-20T00:00:00.000Z")
    assert [p["platform"] for p in created] == ["facebook"]
    assert hasattr(clip_flow, "ensure_posts")


def test_existing_clips_without_upload_to_are_unchanged(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = seed_clip(store, status="posted", publishState="started", postsCreated=True, flowRun=1)
    before = table.raw(clip["pk"], clip["sk"])
    status, body = _confirm(call, clip["clipId"])
    assert status == 200
    assert "uploadTo" not in body["clip"]
    assert table.raw(clip["pk"], clip["sk"]) == before


# --- One place's Try again on an uploaded clip ---------------------------------------------------------------------


def _posted_clip_with_one_failed(store: db.Store) -> dict[str, Any]:
    clip = seed_clip(
        store, status="posted", publishState="started", postsCreated=True, flowRun=1, uploadTo=["youtube", "x"]
    )
    for platform, state in (("youtube", "posted"), ("x", "failed")):
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
                "status": state,
                **(
                    {"error": "X said no. Press Try again.", "publishHandle": {"mediaId": "m"}}
                    if state == "failed"
                    else {"url": "https://youtube.com/shorts/v"}
                ),
            }
        )
    return clip


def test_try_again_for_one_place_requeues_only_that_post(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "youtube", "x")
    clip = _posted_clip_with_one_failed(store)
    status, body = _confirm(call, clip["clipId"], {"platforms": ["x"]})
    assert status == 200
    assert body["clip"]["status"] == "posted"
    by_platform = {p["platform"]: p for p in body["posts"]}
    assert by_platform["youtube"]["status"] == "posted"
    assert by_platform["x"]["status"] == "queued"
    assert "error" not in by_platform["x"]
    assert "publishHandle" not in (table.raw(db.user_pk(USER), db.post_sk("Px")) or {})
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert (stored["status"], stored["flowRun"]) == ("posted", 2)
    (start,) = _starts(lambda_client)
    assert json.loads(start["Payload"])["run"] == 2


def test_try_again_naming_a_place_that_did_not_fail_changes_nothing(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "youtube", "x")
    clip = _posted_clip_with_one_failed(store)
    before = table.raw(clip["pk"], clip["sk"])
    status, body = _confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert status == 200
    assert {p["platform"]: p["status"] for p in body["posts"]} == {"youtube": "posted", "x": "failed"}
    assert table.raw(clip["pk"], clip["sk"]) == before
    assert _starts(lambda_client) == []


def test_flow_treats_a_posted_clip_with_queued_posts_as_decided() -> None:
    assert "posted" in clip_flow.DECIDED


# --- My settings (postPreset) --------------------------------------------------------------------------------------


# --- Each place's own options (§34.3) ------------------------------------------------------------------------------


def test_per_clip_options_go_on_their_posts(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube", "instagram", "x", "tiktok")
    clip = seed_clip(store)
    options = {
        "youtube": {"privacy": "unlisted", "category": "24", "madeForKids": False},
        "instagram": {"shareToFeed": False},
        "x": {"replies": "following"},
    }
    status, body = _confirm(
        call,
        clip["clipId"],
        {"platforms": ["youtube", "instagram", "x", "tiktok"], "options": options, "tiktok": TIKTOK},
    )
    assert status == 200
    stored = {p["platform"]: p for p in table.all() if p.get("type") == "post"}
    assert stored["youtube"]["postOptions"] == options["youtube"]
    assert stored["instagram"]["postOptions"] == {"shareToFeed": False}
    assert stored["x"]["postOptions"] == {"replies": "following"}
    assert stored["tiktok"]["postOptions"] == TIKTOK
    # postOptions are internal: never in the response.
    assert all("postOptions" not in p for p in body["posts"])


def test_options_for_a_place_that_is_not_going_are_dropped(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube", "x")
    clip = seed_clip(store)
    options = {"x": {"replies": "following"}}
    assert _confirm(call, clip["clipId"], {"platforms": ["youtube"], "options": options})[0] == 200
    assert [p.get("postOptions") for p in table.all() if p.get("type") == "post"] == [None]


@pytest.mark.parametrize(
    "options",
    [
        {"tiktok": {"privacy": "PUBLIC_TO_EVERYONE"}},
        {"youtube": {"privacy": "everyone"}},
        {"youtube": {"madeForKids": "no"}},
        {"youtube": {"syntheticMedia": True}},
        {"facebook": {}},
        {"x": {"replies": "nobody"}},
        [],
    ],
)
def test_bad_per_clip_options_are_refused(call: Call, store: db.Store, options: object) -> None:
    _connect(store, "youtube")
    clip = seed_clip(store)
    assert _confirm(call, clip["clipId"], {"platforms": ["youtube"], "options": options})[0] == 400


# --- Publishers follow the per-clip options, then My settings ------------------------------------------------------


def test_youtube_follows_the_clip_options() -> None:
    job, _, _ = make_job(
        "youtube",
        FakeHttp(),
        options={"privacy": "unlisted", "category": "24", "embeddable": False, "madeForKids": True},
    )
    meta = YouTubePublisher().metadata(job)
    assert meta["status"] == {
        "privacyStatus": "unlisted",
        "selfDeclaredMadeForKids": True,
        "containsSyntheticMedia": False,
        "embeddable": False,
    }
    assert meta["snippet"]["categoryId"] == "24"


def test_youtube_without_options_keeps_the_old_choices_and_is_never_for_kids() -> None:
    job, _, _ = make_job(
        "youtube", FakeHttp(), settings={"youtubePrivacy": "private", "postPreset": post_preset.defaults()}
    )
    meta = YouTubePublisher().metadata(job)
    assert meta["status"] == {
        "privacyStatus": "private",
        "selfDeclaredMadeForKids": False,
        "containsSyntheticMedia": False,
    }
    assert meta["snippet"]["categoryId"] == "20"
    assert "notifySubscribers" not in YouTubePublisher.upload_url(job)


def test_youtube_uses_my_settings_when_the_clip_says_nothing() -> None:
    preset = {**post_preset.defaults(), "youtube": {"category": "23", "notifySubscribers": False, "embeddable": True}}
    job, _, _ = make_job("youtube", FakeHttp(), settings={"youtubePrivacy": "public", "postPreset": preset})
    assert YouTubePublisher().metadata(job)["snippet"]["categoryId"] == "23"
    assert YouTubePublisher.upload_url(job).endswith("&notifySubscribers=false")
    # The clip's own choice wins over My settings.
    job, _, _ = make_job(
        "youtube",
        FakeHttp(),
        options={"notifySubscribers": True},
        settings={"youtubePrivacy": "public", "postPreset": preset},
    )
    assert "notifySubscribers" not in YouTubePublisher.upload_url(job)


def test_instagram_share_to_feed_follows_the_option() -> None:
    http = FakeHttp(
        (200, "publish/instagram_limit"), (200, "publish/instagram_container"), (200, "publish/instagram_upload")
    )
    job, _, _ = make_job("instagram", http, data={"igUserId": "1784"}, options={"shareToFeed": False})
    InstagramPublisher().start(job)
    assert form(http.calls[1])["share_to_feed"] == ["false"]


def test_x_reply_settings_follow_the_option() -> None:
    http = FakeHttp((201, "publish/x_tweet"))
    job, _, _ = make_job(
        "x", http, handle={"mediaId": "m1", "finalized": True}, data={"username": "o"}, options={"replies": "following"}
    )
    XPublisher().finish(job, job.handle)
    assert json.loads(http.calls[0].body)["reply_settings"] == "following"
    http = FakeHttp((201, "publish/x_tweet"))
    job, _, _ = make_job(
        "x", http, handle={"mediaId": "m1", "finalized": True}, data={"username": "o"}, options={"replies": "everyone"}
    )
    XPublisher().finish(job, job.handle)
    assert "reply_settings" not in json.loads(http.calls[0].body)
