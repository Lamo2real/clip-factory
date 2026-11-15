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
    "hasYoutubeCookies": False,
    "platforms": ["youtube", "instagram", "facebook", "tiktok", "x"],
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


def test_connect_is_not_implemented(call: Call) -> None:
    status, body = call("POST", "/v1/accounts/youtube/connect")
    assert status == 501
    assert body == {"error": {"code": "not_implemented", "message": "Connecting accounts arrives in the next phase."}}
    assert call("POST", "/v1/accounts/myspace/connect")[0] == 404


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
