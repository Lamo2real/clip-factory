from __future__ import annotations

import pytest

from clipfactory_api import db, settings
from clipfactory_api.s3 import cookies_key
from conftest import USER, Call, seed_clip, seed_job
from fakes import FakeS3

DEFAULTS = {
    "clipMin": 5,
    "clipMax": 10,
    "maxSourceHours": 6,
    "soundEnabled": True,
    "reduceMotion": False,
    "clickSound": 6,
    "errorSound": 5,
    "hasYoutubeCookies": False,
    "platforms": ["youtube", "instagram", "facebook", "tiktok", "x"],
    "youtubePrivacy": "public",
}


def test_settings_defaults(call: Call) -> None:
    assert call("GET", "/v1/settings") == (200, {"settings": DEFAULTS})


def test_put_settings_partial_and_persisted(call: Call) -> None:
    status, body = call(
        "PUT", "/v1/settings", {"clipMin": 3, "platforms": ["x", "youtube", "x"], "soundEnabled": False}
    )
    assert status == 200
    assert body["settings"] == {**DEFAULTS, "clipMin": 3, "platforms": ["youtube", "x"], "soundEnabled": False}
    assert call("GET", "/v1/settings")[1] == body


def test_put_settings_ignores_read_only(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", {**DEFAULTS, "hasYoutubeCookies": True})
    assert status == 200
    assert body["settings"]["hasYoutubeCookies"] is False


@pytest.mark.parametrize(
    "patch",
    [
        {"clipMin": 0},
        {"clipMin": 11},
        {"clipMin": 2.5},
        {"clipMin": "3"},
        {"clipMin": float("nan")},
        {"clipMax": float("inf")},
        {"maxSourceHours": float("-inf")},
        {"clipMax": 4},  # below the default clipMin of 5
        {"maxSourceHours": 13},
        {"soundEnabled": "yes"},
        {"platforms": ["myspace"]},
        {"platforms": "youtube"},
        {"theme": "dark"},
    ],
)
def test_put_settings_validation(call: Call, patch: dict[str, object]) -> None:
    status, body = call("PUT", "/v1/settings", patch)
    assert status == 400
    assert body["error"]["code"] == "bad_request"


def test_sound_defaults_are_the_owners_picks() -> None:
    assert settings.DEFAULTS["clickSound"] == 6  # "Water drop"
    assert settings.DEFAULTS["errorSound"] == 5  # "Nope nope nope"


@pytest.mark.parametrize("field", ["clickSound", "errorSound"])
@pytest.mark.parametrize("value", [1, 30, 17, 12.0])
def test_put_sound_choice_saved(call: Call, field: str, value: float) -> None:
    status, body = call("PUT", "/v1/settings", {field: value})
    assert status == 200
    assert body["settings"][field] == int(value)
    assert isinstance(body["settings"][field], int)
    assert call("GET", "/v1/settings")[1]["settings"][field] == int(value)
    assert call("GET", "/v1/me")[1]["settings"][field] == int(value)


def test_put_both_sounds_keeps_other_settings(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", {"clickSound": 1, "errorSound": 30})
    assert status == 200
    assert body["settings"] == {**DEFAULTS, "clickSound": 1, "errorSound": 30}


@pytest.mark.parametrize("field", ["clickSound", "errorSound"])
@pytest.mark.parametrize(
    ("value", "message"),
    [
        (0, "number 0. Pick one from 1 to 30."),
        (31, "number 31. Pick one from 1 to 30."),
        (-3, "number -3. Pick one from 1 to 30."),
        (2.5, "by its number, from 1 to 30."),
        ("6", "by its number, from 1 to 30."),
        (True, "by its number, from 1 to 30."),
        (False, "by its number, from 1 to 30."),
        (None, "by its number, from 1 to 30."),
        ([6], "by its number, from 1 to 30."),
        (float("nan"), "by its number, from 1 to 30."),
        (float("inf"), "by its number, from 1 to 30."),
        (float("-inf"), "by its number, from 1 to 30."),
    ],
)
def test_put_sound_validation(call: Call, field: str, value: object, message: str) -> None:
    status, body = call("PUT", "/v1/settings", {field: value})
    assert status == 400
    assert body["error"]["code"] == "bad_request"
    label = "click sound" if field == "clickSound" else "error sound"
    assert label in body["error"]["message"]
    assert body["error"]["message"].endswith(message)
    assert call("GET", "/v1/settings")[1]["settings"][field] == DEFAULTS[field]  # nothing saved


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity", "1e999"])
@pytest.mark.parametrize("field", ["clickSound", "errorSound", "clipMin", "clipMax", "maxSourceHours"])
def test_put_settings_non_finite_numbers_are_400_not_500(call: Call, field: str, raw: str) -> None:
    # Python's json.loads accepts these literals, so they reach the validators as float nan/inf.
    status, body = call("PUT", "/v1/settings", raw=f'{{"{field}": {raw}}}')
    assert status == 400
    assert body["error"]["code"] == "bad_request"
    assert call("GET", "/v1/settings")[1]["settings"][field] == DEFAULTS[field]  # nothing saved


def test_bad_stored_non_finite_numbers_fall_back_to_defaults() -> None:
    out = settings.with_defaults({"clickSound": float("nan"), "errorSound": float("inf"), "clipMin": float("nan")})
    assert (out["clickSound"], out["errorSound"], out["clipMin"]) == (6, 5, 5)


def test_old_stored_settings_without_sounds_read_as_defaults(call: Call, store: db.Store) -> None:
    store.put({"pk": db.user_pk(USER), "sk": db.SETTINGS_SK, "type": "settings", "userId": USER, "clipMin": 3})
    got = call("GET", "/v1/settings")[1]["settings"]
    assert (got["clipMin"], got["clickSound"], got["errorSound"]) == (3, 6, 5)
    # Saving another setting writes the defaults in, so the stored item is complete afterwards.
    assert call("PUT", "/v1/settings", {"reduceMotion": True})[0] == 200
    item = store.get(db.user_pk(USER), db.SETTINGS_SK)
    assert item is not None
    assert (item["clickSound"], item["errorSound"]) == (6, 5)


def test_bad_stored_sounds_fall_back_to_defaults() -> None:
    out = settings.with_defaults({"clickSound": True, "errorSound": 99})
    assert (out["clickSound"], out["errorSound"]) == (6, 5)
    out = settings.with_defaults({"clickSound": 30, "errorSound": 1})
    assert (out["clickSound"], out["errorSound"]) == (30, 1)


def test_corrupt_stored_settings_fall_back_to_defaults() -> None:
    out = settings.with_defaults({"clipMin": "lots", "clipMax": 2, "platforms": ["bogus"]})
    assert out["clipMin"] == 5
    assert out["clipMax"] == 5  # never below clipMin
    assert out["platforms"] == DEFAULTS["platforms"]


def test_cookies_upload_and_delete(call: Call, s3_client: FakeS3) -> None:
    status, body = call("POST", "/v1/settings/cookies", {"filename": "cookies.txt"})
    assert status == 200
    assert set(body) == {"uploadUrl", "headers"}
    op, params, _ = s3_client.presigned[-1]
    assert (op, params["Key"]) == ("put_object", cookies_key(USER))
    s3_client.objects[cookies_key(USER)] = b"# Netscape"
    assert call("GET", "/v1/settings")[1]["settings"]["hasYoutubeCookies"] is True
    assert call("DELETE", "/v1/settings/cookies") == (204, None)
    assert cookies_key(USER) not in s3_client.objects
    assert call("POST", "/v1/settings/cookies", {"filename": "cookies.json"})[0] == 400


def test_me(call: Call, store: db.Store) -> None:
    seed_job(store, status="running")
    seed_job(store, status="queued")
    seed_job(store, status="ready")
    seed_clip(store)
    seed_clip(store, status="posted")
    status, body = call("GET", "/v1/me")
    assert status == 200
    assert body["user"] == {"id": USER, "email": "owner@example.com"}
    assert body["settings"] == DEFAULTS
    assert body["counts"] == {"review": 1, "running": 2, "posted": 1}


def test_uploads_presign(call: Call, s3_client: FakeS3) -> None:
    status, body = call(
        "POST", "/v1/uploads", {"filename": "../My Stream (1).MP4", "contentType": "video/mp4", "size": 10}
    )
    assert status == 200
    assert body["key"] == f"uploads/{USER}/{body['uploadId']}/My-Stream-1.MP4"
    assert body["headers"] == {"Content-Type": "video/mp4"}
    op, params, expires = s3_client.presigned[-1]
    assert (op, params["ContentType"], expires) == ("put_object", "video/mp4", 3600)


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"filename": "a.mp4", "contentType": "image/png", "size": 10}, 400),
        ({"filename": "a.mp4", "contentType": "video/mp4", "size": 0}, 400),
        ({"filename": "a.mp4", "contentType": "video/mp4", "size": "10"}, 400),
        ({"filename": "a.mp4", "contentType": "video/mp4", "size": 5 * 1024**3 + 1}, 413),
        ({"contentType": "video/mp4", "size": 10}, 400),
    ],
)
def test_uploads_validation(call: Call, body: dict[str, object], code: int) -> None:
    assert call("POST", "/v1/uploads", body)[0] == code


def test_accounts(call: Call, store: db.Store) -> None:
    status, body = call("GET", "/v1/accounts")
    assert status == 200
    assert body["accounts"] == [
        {"platform": p, "status": "not_connected"} for p in ("youtube", "instagram", "facebook", "tiktok", "x")
    ]
    store.put({"pk": db.user_pk(USER), "sk": "ACCOUNT#x#1", "platform": "x", "status": "connected", "handle": "@me"})
    _, body = call("GET", "/v1/accounts")
    assert body["accounts"][-1] == {"platform": "x", "status": "connected", "handle": "@me"}


def test_posts_and_insights(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    _, confirmed = call("POST", f"/v1/clips/{clip['clipId']}/confirm")
    post = confirmed["posts"][0]
    _, all_posts = call("GET", "/v1/posts")
    assert len(all_posts["posts"]) == 5
    _, by_clip = call("GET", "/v1/posts", query={"clipId": clip["clipId"]})
    assert {p["platform"] for p in by_clip["posts"]} == {"youtube", "instagram", "facebook", "tiktok", "x"}
    store.update(
        db.user_pk(USER),
        db.post_sk(post["postId"]),
        {"metrics": {"views": 10, "likes": 1, "comments": 0, "shares": 0, "checkedAt": "2026-11-17T12:00:00.000Z"}},
    )
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "LEARNING#01JABCDEFGHJKMNPQRSTVWXYZ0",
            "learningId": "01JABCDEFGHJKMNPQRSTVWXYZ0",
            "text": "Short hooks win.",
            "createdAt": "2026-11-17T12:00:00.000Z",
            "postIds": [post["postId"]],
        }
    )
    status, body = call("GET", "/v1/insights")
    assert status == 200
    assert body["learnings"][0]["text"] == "Short hooks win."
    assert [p["postId"] for p in body["posts"]] == [post["postId"]]
    assert body["posts"][0]["metrics"]["views"] == 10


@pytest.mark.parametrize("value", ["public", "unlisted", "private"])
def test_youtube_privacy_choice(call: Call, value: str) -> None:
    status, body = call("PUT", "/v1/settings", {"youtubePrivacy": value})
    assert status == 200
    assert body["settings"]["youtubePrivacy"] == value


@pytest.mark.parametrize("value", ["everyone", "", None, 1])
def test_youtube_privacy_is_checked(call: Call, value: object) -> None:
    status, body = call("PUT", "/v1/settings", {"youtubePrivacy": value})
    assert status == 400
    assert "YouTube" in body["error"]["message"]
