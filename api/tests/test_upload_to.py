"""Upload to many places (docs/CONTRACTS.md §33): the chosen platforms, old clients, and one place's Try again."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db, posts
from clipfactory_api.flows import clip_flow
from conftest import CLIP_FLOW_ARN, USER, Call, seed_clip
from fakes import FakeLambda, FakeTable

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
