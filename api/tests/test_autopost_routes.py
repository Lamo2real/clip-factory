"""Auto-posting's API (docs/CONTRACTS.md §46.3, §46.9; tests §46.15 ``test_autopost_routes.py``): the setting and its
``onAt``, the owner registry, ``GET /v1/autopost`` (each list and the times) and the test runs with their limit."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from autopost_support import PK, SLOT, clip_of, deps, ready, review_clip, state, turn_on
from clipfactory_api import db, settings
from clipfactory_api.autopost import OWNERS_PK, UNKNOWN, run
from clipfactory_api.clock import iso
from conftest import NOW, USER, Call, Clock, seed_clip, seed_job
from fakes import FakeS3, FakeTable

DEFAULT = {"on": False, "everyHours": 5, "perRun": 1, "practice": False}


def put(call: Call, auto: Any) -> tuple[int, Any]:
    return call("PUT", "/v1/settings", {"autoPost": auto})


# --- Settings.autoPost (§46.3) --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("auto", "message"),
    [
        ({"everyHours": 0}, "Pick 1 to 24 hours."),
        ({"everyHours": 25}, "Pick 1 to 24 hours."),
        ({"everyHours": 2.5}, "Pick 1 to 24 hours."),
        ({"everyHours": "5"}, "Pick 1 to 24 hours."),
        ({"everyHours": True}, "Pick 1 to 24 hours."),
        ({"perRun": 0}, "Pick 1 to 5 clips."),
        ({"perRun": 6}, "Pick 1 to 5 clips."),
        ({"perRun": 1.5}, "Pick 1 to 5 clips."),
        ({"onAt": "2026-11-15T12:00:00.000Z"}, UNKNOWN),
        ({"on": True, "onAt": "2026-11-15T12:00:00.000Z"}, UNKNOWN),
        ({"often": 3}, UNKNOWN),
        ({"on": "yes"}, "on must be true or false."),
        ({"practice": 1}, "practice must be true or false."),
        ("on", "autoPost must be a JSON object."),
    ],
)
def test_bad_auto_post_settings_are_refused(call: Call, table: FakeTable, auto: Any, message: str) -> None:
    status, body = put(call, auto)
    assert (status, body["error"]["message"]) == (400, message)
    assert call("GET", "/v1/settings")[1]["settings"]["autoPost"] == DEFAULT
    assert table.raw(OWNERS_PK, f"USER#{USER}") is None
    assert UNKNOWN == "autoPost has a setting Clip Factory does not know."


def test_whole_numbers_are_taken(call: Call) -> None:
    status, body = put(call, {"everyHours": 24.0, "perRun": 5})
    assert status == 200
    assert body["settings"]["autoPost"] == {**DEFAULT, "everyHours": 24, "perRun": 5}


def test_on_at_is_written_when_it_goes_on_and_kept_otherwise(call: Call, clock: Clock) -> None:
    status, body = put(call, {"on": True})
    assert status == 200
    assert body["settings"]["autoPost"] == {**DEFAULT, "on": True, "onAt": iso(NOW)}
    clock.now = NOW + timedelta(hours=1)
    status, body = put(call, {"on": True, "everyHours": 3})
    assert body["settings"]["autoPost"] == {**DEFAULT, "on": True, "everyHours": 3, "onAt": iso(NOW)}
    # Each key is merged over the stored value.
    status, body = put(call, {"perRun": 2})
    assert body["settings"]["autoPost"] == {
        "on": True,
        "everyHours": 3,
        "perRun": 2,
        "practice": False,
        "onAt": iso(NOW),
    }
    status, body = put(call, {"on": False})
    assert body["settings"]["autoPost"]["on"] is False
    assert body["settings"]["autoPost"]["onAt"] == iso(NOW)
    clock.now = NOW + timedelta(hours=2, minutes=7)
    status, body = put(call, {"on": True, "practice": True})
    assert body["settings"]["autoPost"] == {
        "on": True,
        "everyHours": 3,
        "perRun": 2,
        "practice": True,
        "onAt": iso(clock.now),
    }
    assert call("GET", "/v1/settings")[1]["settings"]["autoPost"] == body["settings"]["autoPost"]
    # Other settings never touch it.
    assert call("PUT", "/v1/settings", {"clipMin": 3})[1]["settings"]["autoPost"] == body["settings"]["autoPost"]


def test_a_stored_value_that_no_longer_validates_reads_the_defaults(store: db.Store, call: Call) -> None:
    store.put({"pk": PK, "sk": db.SETTINGS_SK, "type": "settings", "autoPost": {"on": True, "everyHours": 99}})
    assert call("GET", "/v1/settings")[1]["settings"]["autoPost"] == DEFAULT
    assert settings.with_defaults({"autoPost": "on"})["autoPost"] == DEFAULT
    assert settings.with_defaults(None)["autoPost"] == DEFAULT


def test_every_put_with_auto_post_registers_the_owner(call: Call, table: FakeTable, clock: Clock) -> None:
    assert call("PUT", "/v1/settings", {"clipMin": 3})[0] == 200
    assert table.raw(OWNERS_PK, f"USER#{USER}") is None
    assert put(call, {"everyHours": 4})[0] == 200
    registry = {
        "pk": OWNERS_PK,
        "sk": f"USER#{USER}",
        "type": "autopostowner",
        "userId": USER,
        "since": iso(NOW),
    }
    assert table.raw(OWNERS_PK, f"USER#{USER}") == registry
    clock.now = NOW + timedelta(days=1)
    assert put(call, {"on": True})[0] == 200
    assert table.raw(OWNERS_PK, f"USER#{USER}") == registry  # the first since stays


# --- GET /v1/autopost (§46.9) ---------------------------------------------------------------------------------------


def test_status_while_off(call: Call, store: db.Store, s3_client: FakeS3, clock: Clock) -> None:
    ready(store, "youtube", "instagram")
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z", hook="First")
    missing = review_clip(store, made="2026-11-15T09:00:00.000Z", hook="No video")
    store.update(PK, db.clip_sk(missing["clipId"]), {"hook": "No video"}, remove=["videoKey"])
    status, body = call("GET", "/v1/autopost")
    assert status == 200
    assert body["autoPost"] == DEFAULT
    assert (body["nextRunAt"], body["perDay"]) == (None, 4.8)
    assert body["places"] == ["youtube", "instagram"]
    assert body["leftOut"] == [
        {"platform": "tiktok", "reason": "tiktok_yourself"},
        {"platform": "facebook", "reason": "not_set_up"},
        {"platform": "x", "reason": "not_set_up"},
    ]
    assert len(body["nextUp"]) == 1
    up = body["nextUp"][0]
    assert (up["clipId"], up["jobId"], up["hook"]) == (first["clipId"], first["jobId"], "First")
    assert up["coverUrl"].startswith("https://")
    assert "runAt" not in up  # no times while off
    assert body["waiting"] == [
        {
            "clipId": missing["clipId"],
            "jobId": missing["jobId"],
            "hook": "No video",
            "coverUrl": body["waiting"][0]["coverUrl"],
            "reason": "Its video is missing.",
        }
    ]
    assert (body["runs"], body["failed"], body["tiktokYourself"]) == ([], [], [])


def test_status_while_on_gives_each_clip_its_time(call: Call, store: db.Store, clock: Clock) -> None:
    ready(store, "youtube")
    turn_on(store, every=3, per_run=2)
    job = seed_job(store, status="ready", createdAt="2026-11-15T08:00:00.000Z")
    made = [seed_clip(store, job_id=job["jobId"], rank=n) for n in range(1, 13)]
    clock.now = NOW + timedelta(minutes=30)
    body = call("GET", "/v1/autopost")[1]
    assert body["nextRunAt"] == iso(SLOT)
    assert body["perDay"] == 16
    assert len(body["nextUp"]) == 10
    assert [u["clipId"] for u in body["nextUp"]] == [c["clipId"] for c in made[:10]]
    hours = [0, 0, 3, 3, 6, 6, 9, 9, 12, 12]
    assert [u["runAt"] for u in body["nextUp"]] == [iso(SLOT + timedelta(hours=h)) for h in hours]


def test_status_after_a_run_lists_its_posts_the_failed_and_tiktok_yourself(
    app: Any, call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube", "instagram")
    turn_on(store)
    clip = review_clip(store, s3_client, hook="Big moment")
    clock.now = SLOT + timedelta(seconds=5)
    run.run_once(deps(app), USER, "scheduled", SLOT)
    stored = clip_of(store, clip["clipId"])
    youtube_id, instagram_id = stored["postIds"]
    store.update(PK, db.post_sk(youtube_id), {"status": "posted", "url": "https://www.youtube.com/shorts/v1"})
    store.update(PK, db.post_sk(instagram_id), {"status": "failed", "error": "Instagram did not like this video file."})
    body = call("GET", "/v1/autopost")[1]
    run_id = f"{iso(SLOT)}#scheduled"
    assert body["runs"] == [
        {
            "runId": run_id,
            "at": iso(SLOT),
            "kind": "scheduled",
            "mode": "live",
            "state": "done",
            "clips": [
                {
                    "clipId": clip["clipId"],
                    "hook": "Big moment",
                    "places": ["youtube", "instagram"],
                    "outcome": "sent",
                    "posts": [
                        {"platform": "youtube", "status": "posted", "url": "https://www.youtube.com/shorts/v1"},
                        {
                            "platform": "instagram",
                            "status": "failed",
                            "error": "Instagram did not like this video file.",
                        },
                    ],
                }
            ],
        }
    ]
    assert body["failed"] == [
        {
            "postId": instagram_id,
            "clipId": clip["clipId"],
            "hook": "Big moment",
            "platform": "instagram",
            "error": "Instagram did not like this video file.",
            "at": iso(SLOT + timedelta(seconds=5)),
        }
    ]
    assert [t["clipId"] for t in body["tiktokYourself"]] == [clip["clipId"]]
    assert body["tiktokYourself"][0]["hook"] == "Big moment"
    assert body["nextRunAt"] == iso(SLOT + timedelta(hours=5))
    # The clip and its posts say they were auto-posted; the internal fields never leave.
    one = call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]
    assert one["auto"] == {"runId": run_id, "at": iso(SLOT)}
    assert not {"autoRun", "autoAt", "autoTest"} & set(one)
    listed = call("GET", "/v1/posts")[1]["posts"]
    assert {p["auto"] for p in listed} == {True}
    assert not any("postOptions" in p or "autoRun" in p or "test" in p for p in listed)
    # Didn't work's Try again is the Library's: confirm with that one place.
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})
    assert status == 200
    assert call("GET", "/v1/autopost")[1]["failed"] == []


def test_a_clip_posted_on_tiktok_by_hand_leaves_tiktok_yourself(
    app: Any, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    clock.now = SLOT + timedelta(seconds=5)
    run.run_once(deps(app), USER, "scheduled", SLOT)
    assert len(call("GET", "/v1/autopost")[1]["tiktokYourself"]) == 1
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})[0] == 200
    assert call("GET", "/v1/autopost")[1]["tiktokYourself"] == []


def test_recent_lists_only_the_posts_its_run_made(
    app: Any, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    clock.now = SLOT + timedelta(seconds=5)
    run.run_once(deps(app), USER, "scheduled", SLOT)
    # Post it yourself (§42) adds the owner's own TikTok post to the clip: it was never part of the run.
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})[0] == 200
    assert "tiktok" in {p["platform"] for p in call("GET", "/v1/posts")[1]["posts"]}
    (recent,) = call("GET", "/v1/autopost")[1]["runs"]
    assert recent["clips"][0]["places"] == ["youtube"]
    assert [p["platform"] for p in recent["clips"][0]["posts"]] == ["youtube"]


# --- POST /v1/autopost/run (§46.8, §46.9) ---------------------------------------------------------------------------


def test_practice_run_now_sends_nothing_and_never_moves_the_schedule(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: Any
) -> None:
    ready(store, "youtube", "x")
    clip = review_clip(store, s3_client, hook="Practice me")
    status, body = call("POST", "/v1/autopost/run", {"kind": "practice"})  # auto-posting is off: it runs anyway
    assert status == 200
    run_id = f"{iso(NOW)}#practice_now"
    assert body["run"] == {
        "runId": run_id,
        "at": iso(NOW),
        "kind": "practice_now",
        "mode": "practice",
        "state": "done",
        "clips": [
            {
                "clipId": clip["clipId"],
                "hook": "Practice me",
                "places": ["youtube", "x"],
                "outcome": "would_send",
                "posts": [],
            }
        ],
    }
    assert clip_of(store, clip["clipId"])["status"] == "review"
    assert "lastRunAt" not in state(store)
    assert state(store)["lastNowAt"] == iso(NOW)
    assert lambda_client.calls == []
    assert call("GET", "/v1/autopost")[1]["runs"][0]["runId"] == run_id


def test_private_run_now_its_limit_and_nothing_to_test(
    call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube", "facebook", "x")
    clip = review_clip(store, s3_client)
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert status == 200
    assert (body["run"]["kind"], body["run"]["mode"]) == ("private_now", "private")
    sent = body["run"]["clips"][0]
    assert (sent["clipId"], sent["places"], sent["outcome"]) == (clip["clipId"], ["youtube", "facebook"], "sent")
    assert {(p["platform"], p["status"], p["test"]) for p in sent["posts"]} == {
        ("youtube", "queued", "private"),
        ("facebook", "queued", "private"),
    }
    clock.now = NOW + timedelta(seconds=59)
    status, body = call("POST", "/v1/autopost/run", {"kind": "practice"})
    assert (status, body["error"]["message"]) == (409, "A test run just started. Wait a minute.")
    clock.now = NOW + timedelta(seconds=60)
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert status == 200
    assert (body["run"]["note"], body["run"]["clips"]) == ("Nothing in Review to test with.", [])
    assert "lastRunAt" not in state(store)


def test_a_run_now_whose_flow_did_not_start_still_finishes(
    call: Call, store: db.Store, s3_client: FakeS3, lambda_client: Any
) -> None:
    ready(store, "youtube")
    clip = review_clip(store, s3_client)
    lambda_client.fail = True
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    # The owner is there: the run is done and the Library offers Try again for the clip (startPending, §14.5).
    assert status == 200
    assert (body["run"]["state"], body["run"]["clips"][0]["outcome"]) == ("done", "sent")
    assert call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]["startPending"] is True


def test_private_run_now_with_nothing_set_up(call: Call, store: db.Store) -> None:
    review_clip(store)
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert status == 200
    assert (body["run"]["note"], body["run"]["clips"]) == ("Nothing is set up to post to.", [])


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "Pick practice or private."),
        ({"kind": "live"}, "Pick practice or private."),
        ({"kind": "scheduled"}, "Pick practice or private."),
        ({"kind": ["practice"]}, "Pick practice or private."),
        ({"kind": "practice", "now": True}, "Unknown field: now."),
    ],
)
def test_bad_run_now_bodies_are_refused(call: Call, store: db.Store, body: Any, message: str) -> None:
    status, out = call("POST", "/v1/autopost/run", body)
    assert (status, out["error"]["message"]) == (400, message)
    assert state(store) == {}
