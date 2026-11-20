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
    "earningsRates": {},
    "earningsPaid": {},
    "setupSkipped": [],
    "backgroundColours": ["#0f372b", "#efe7da", "#e8392b"],
    "glassStrength": "clear",
    "clipModel": "fable-5-1",
    "followPaused": False,
    "followDailyMax": 0,
    "followMinMinutes": 30,
    "notify": {"ready": True, "stopped": True, "resumed": False, "steps": False},
    # §36 My settings: the owner's own post choices per platform, never made for kids.
    "postPreset": {
        "youtube": {"category": "20", "notifySubscribers": True, "embeddable": True},
        "tiktok": {"privacy": "PUBLIC_TO_EVERYONE", "comments": True, "duet": True, "stitch": True},
        "instagram": {"shareToFeed": True},
        "facebook": {},
        "x": {"replies": "everyone"},
    },
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
        {"setupSkipped": ["myspace"]},
        {"setupSkipped": "tiktok"},
        {"setupSkipped": [1]},
        {"setupSkipped": None},
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


# ---------- Retired earnings (§21 → §25): still stored and validated, never read, so nothing is lost ----------


def test_retired_earnings_settings_stay_and_the_guess_config_is_gone() -> None:
    from pathlib import Path

    assert settings.MAX_USD_PER_1000 == 100
    assert settings.DEFAULTS["earningsRates"] == {}
    assert settings.DEFAULTS["earningsPaid"] == {}
    assert not (Path(__file__).resolve().parents[2] / "config" / "earnings.json").exists()


def test_put_earnings_saved_and_kept_in_order(call: Call) -> None:
    rates = {"x": 0.12, "youtube": 0.07, "tiktok": 0, "facebook": 100}
    status, body = call("PUT", "/v1/settings", {"earningsRates": rates, "earningsPaid": {"tiktok": True, "x": False}})
    assert status == 200
    got = body["settings"]
    assert got["earningsRates"] == {"youtube": 0.07, "tiktok": 0, "facebook": 100, "x": 0.12}
    assert list(got["earningsRates"]) == ["youtube", "facebook", "tiktok", "x"]
    assert got["earningsPaid"] == {"tiktok": True, "x": False}
    assert got["clipMin"] == DEFAULTS["clipMin"]
    assert call("GET", "/v1/settings")[1] == body
    # Sending the map again replaces it: a platform left out goes back to the default.
    status, body = call("PUT", "/v1/settings", {"earningsRates": {"youtube": 0.05}})
    assert body["settings"]["earningsRates"] == {"youtube": 0.05}
    assert body["settings"]["earningsPaid"] == {"tiktok": True, "x": False}


@pytest.mark.parametrize("value", [0, 0.01, 0.5, 1.2, 99.99, 100, 3.0])
def test_put_earnings_rate_ok(call: Call, value: float) -> None:
    status, body = call("PUT", "/v1/settings", {"earningsRates": {"youtube": value}})
    assert status == 200
    assert body["settings"]["earningsRates"]["youtube"] == value


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"earningsRates": {"youtube": -0.01}}, "less than 0"),
        ({"earningsRates": {"youtube": 100.01}}, "at most 100"),
        ({"earningsRates": {"youtube": 0.055}}, "2 numbers after the dot"),
        ({"earningsRates": {"youtube": "0.05"}}, "as a number"),
        ({"earningsRates": {"youtube": True}}, "as a number"),
        ({"earningsRates": {"youtube": None}}, "as a number"),
        ({"earningsRates": {"myspace": 1}}, "Unknown platform"),
        ({"earningsRates": [0.05]}, "each app by name"),
        ({"earningsPaid": {"tiktok": "yes"}}, "true or false"),
        ({"earningsPaid": {"tiktok": 1}}, "true or false"),
        ({"earningsPaid": "all"}, "each app by name"),
    ],
)
def test_put_earnings_validation(call: Call, patch: dict[str, object], message: str) -> None:
    status, body = call("PUT", "/v1/settings", patch)
    assert status == 400
    assert body["error"]["code"] == "bad_request"
    assert message in body["error"]["message"]


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_put_earnings_non_finite_is_400(call: Call, raw: str) -> None:
    status, _body = call("PUT", "/v1/settings", raw=f'{{"earningsRates": {{"x": {raw}}}}}')
    assert status == 400


def test_old_or_bad_stored_earnings_read_as_defaults() -> None:
    out = settings.with_defaults({"earningsRates": {"youtube": -5}, "earningsPaid": {"x": "nope"}})
    assert out["earningsRates"] == {}
    assert out["earningsPaid"] == {}
    assert settings.with_defaults(None)["earningsRates"] is not settings.DEFAULTS["earningsRates"]


# ---------- The floating setup to-do list (§17.13): confirmed skips ----------


def test_setup_skipped_is_saved_in_order_without_repeats(call: Call) -> None:
    """§17.13: confirmed skips live on the server, so every device hides the same rows."""
    status, body = call("PUT", "/v1/settings", {"setupSkipped": ["x", "tiktok", "x"]})
    assert status == 200
    assert body["settings"]["setupSkipped"] == ["tiktok", "x"]
    assert call("GET", "/v1/settings")[1]["settings"]["setupSkipped"] == ["tiktok", "x"]
    assert call("GET", "/v1/me")[1]["settings"]["setupSkipped"] == ["tiktok", "x"]
    # Un-skip: the list shrinks; other settings stay as they were.
    status, body = call("PUT", "/v1/settings", {"setupSkipped": ["x"]})
    assert status == 200
    assert body["settings"] == {**DEFAULTS, "setupSkipped": ["x"]}


@pytest.mark.parametrize("value", [["myspace"], "tiktok", [1], None, {"x": True}])
def test_setup_skipped_is_checked(call: Call, value: object) -> None:
    status, body = call("PUT", "/v1/settings", {"setupSkipped": value})
    assert status == 400
    assert body["error"]["code"] == "bad_request"


def test_setup_skipped_bad_stored_value_falls_back_to_none_skipped() -> None:
    assert settings.with_defaults({"setupSkipped": ["myspace"]})["setupSkipped"] == []
    assert settings.with_defaults({"setupSkipped": "x"})["setupSkipped"] == []
    assert settings.with_defaults({"setupSkipped": ["x", "youtube"]})["setupSkipped"] == ["youtube", "x"]


# ---------- Background modes (§22) ----------


NEW_DEFAULT = ["#0f372b", "#efe7da", "#e8392b"]  # bottle green, bone, vermilion (ADR-43)
OLD_DEFAULT = ["#9caf88", "#f7f5ef", "#e8412c"]  # the colours before the bottle-green look


def test_background_mode_has_no_server_default() -> None:
    # Absent until saved, so the device decides (§22.1): a picture already on it keeps showing after the upgrade.
    out = settings.with_defaults(None)
    assert "backgroundMode" not in out
    assert out["glassStrength"] == "clear"
    assert out["backgroundColours"] == NEW_DEFAULT
    # A fresh list each time, so one owner's colours can never leak into the shared defaults.
    out["backgroundColours"].append("#000000")
    assert settings.with_defaults(None)["backgroundColours"] == NEW_DEFAULT


def test_background_choice_saved(call: Call) -> None:
    status, body = call(
        "PUT",
        "/v1/settings",
        {
            "backgroundMode": "colours",
            "backgroundColours": ["#F6C945", "#2b6cb0", "#f6c945"],
            "glassStrength": "frosted",
        },
    )
    assert status == 200
    got = body["settings"]
    assert (got["backgroundMode"], got["glassStrength"]) == ("colours", "frosted")
    assert got["backgroundColours"] == ["#f6c945", "#2b6cb0"]  # lower case, repeats dropped
    assert call("GET", "/v1/settings")[1] == body


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"backgroundMode": "window"}, "See-through, Picture or Colours"),
        ({"backgroundMode": None}, "See-through, Picture or Colours"),
        ({"glassStrength": "solid"}, "Clear or Frosted"),
        ({"backgroundColours": []}, "1 to 3 colours"),
        ({"backgroundColours": ["#111111", "#222222", "#333333", "#444444"]}, "1 to 3 colours"),
        ({"backgroundColours": ["red"]}, "#0f372b"),
        ({"backgroundColours": "#0f372b"}, "#0f372b"),
        ({"backgroundColours": ["#12345"]}, "#0f372b"),
    ],
)
def test_background_choice_is_checked(call: Call, patch: dict[str, object], message: str) -> None:
    status, body = call("PUT", "/v1/settings", patch)
    assert status == 400
    assert message in body["error"]["message"]


def test_background_mode_stays_absent_until_saved(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", {"glassStrength": "frosted"})
    assert status == 200
    assert "backgroundMode" not in body["settings"]
    status, body = call("PUT", "/v1/settings", {"backgroundMode": "picture"})
    assert status == 200
    assert body["settings"]["backgroundMode"] == "picture"
    assert call("GET", "/v1/settings")[1]["settings"]["backgroundMode"] == "picture"
    # A later save of something else keeps it.
    status, body = call("PUT", "/v1/settings", {"soundEnabled": False})
    assert body["settings"]["backgroundMode"] == "picture"


def test_bad_stored_background_falls_back_to_defaults() -> None:
    out = settings.with_defaults({"backgroundMode": "nope", "backgroundColours": ["x"], "glassStrength": 3})
    assert "backgroundMode" not in out
    assert out["glassStrength"] == "clear"
    assert out["backgroundColours"] == NEW_DEFAULT


# ---------- AI model for clip jobs (ADR-42) ----------


def test_clip_models_match_config() -> None:
    import json
    from pathlib import Path

    config = json.loads((Path(__file__).resolve().parents[2] / "config" / "models.json").read_text())
    assert list(settings.CLIP_MODELS) == config["clipModels"]
    assert settings.DEFAULTS["clipModel"] == config["agentModel"]
    assert config["agentModel"] in config["clipModels"]
    for key in config["clipModels"]:
        entry = config["models"][key]
        assert entry["modelId"].startswith("anthropic.claude-")
        assert entry["label"].startswith("Claude ")
        assert 0 < len(entry["line"]) <= 60


@pytest.mark.parametrize("value", ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"])
def test_put_clip_model_saved(call: Call, value: str) -> None:
    status, body = call("PUT", "/v1/settings", {"clipModel": value})
    assert status == 200
    assert body["settings"] == {**DEFAULTS, "clipModel": value}
    assert call("GET", "/v1/settings")[1] == body


@pytest.mark.parametrize(
    "value", ["nova-2-lite", "gpt", "", None, 5, ["fable-5-2"], "global.anthropic.claude-fable-5-2"]
)
def test_put_clip_model_is_checked(call: Call, value: object) -> None:
    status, body = call("PUT", "/v1/settings", {"clipModel": value})
    assert status == 400
    assert "AI model" in body["error"]["message"]


def test_old_or_bad_stored_clip_model_reads_as_default(call: Call, store: db.Store) -> None:
    # A settings item saved before the field existed keeps every other choice and reads the default model.
    store.put({"pk": db.user_pk(USER), "sk": db.SETTINGS_SK, "type": "settings", "userId": USER, "clipMin": 3})
    got = call("GET", "/v1/settings")[1]["settings"]
    assert (got["clipMin"], got["clipModel"]) == (3, "fable-5-1")
    # A key that is no longer offered (or junk) falls back to the default; the rest of the item is kept.
    assert settings.with_defaults({"clipModel": "claude-old-1", "clipMax": 7})["clipModel"] == "fable-5-1"
    assert settings.with_defaults({"clipModel": 3})["clipModel"] == "fable-5-1"
    assert settings.with_defaults({"clipModel": "opus-5-5"})["clipModel"] == "opus-5-5"


def test_untouched_old_default_colours_read_as_the_new_default() -> None:
    # ADR-43: an owner who never changed the colours has the old trio stored; it follows the new look on read.
    stored = {"backgroundColours": list(OLD_DEFAULT)}
    assert settings.with_defaults(stored)["backgroundColours"] == NEW_DEFAULT
    assert (
        settings.with_defaults({"backgroundColours": [c.upper() for c in OLD_DEFAULT]})["backgroundColours"]
        == NEW_DEFAULT
    )
    # Read time only: what is stored is not touched.
    assert stored == {"backgroundColours": OLD_DEFAULT}


def test_old_default_colours_are_saved_as_the_new_default_on_the_next_save(call: Call, store: db.Store) -> None:
    # No migration job: the mapped trio is written only when the owner next saves any setting, as every default is.
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.SETTINGS_SK,
            "type": "settings",
            "userId": USER,
            "backgroundColours": OLD_DEFAULT,
        }
    )
    assert call("GET", "/v1/settings")[1]["settings"]["backgroundColours"] == NEW_DEFAULT
    item = store.get(db.user_pk(USER), db.SETTINGS_SK)
    assert item is not None
    assert item["backgroundColours"] == OLD_DEFAULT  # a read writes nothing
    assert call("PUT", "/v1/settings", {"soundEnabled": False})[0] == 200
    item = store.get(db.user_pk(USER), db.SETTINGS_SK)
    assert item is not None
    assert item["backgroundColours"] == NEW_DEFAULT


@pytest.mark.parametrize(
    "chosen",
    [
        ["#e8412c", "#f7f5ef", "#9caf88"],  # the old trio reordered
        ["#9caf88", "#f7f5ef"],  # a subset of it
        ["#9caf88"],
        ["#f6c945", "#2b6cb0"],  # an owner's own choice
    ],
)
def test_other_colour_choices_are_kept(chosen: list[str]) -> None:
    assert settings.with_defaults({"backgroundColours": chosen})["backgroundColours"] == chosen


def test_post_preset_saves_per_platform_and_keeps_the_rest(call: Call) -> None:
    status, body = call(
        "PUT", "/v1/settings", {"postPreset": {"tiktok": {"duet": False}, "x": {"replies": "following"}}}
    )
    assert status == 200
    preset = body["settings"]["postPreset"]
    assert preset["tiktok"] == {**DEFAULTS["postPreset"]["tiktok"], "duet": False}  # type: ignore[index]
    assert preset["x"] == {"replies": "following"}
    assert preset["youtube"] == DEFAULTS["postPreset"]["youtube"]  # type: ignore[index]
    # Other saved settings are untouched by a preset save.
    assert body["settings"]["youtubePrivacy"] == "public"
    assert call("GET", "/v1/settings")[1] == body


@pytest.mark.parametrize(
    "preset",
    [
        {"youtube": {"madeForKids": True}},
        {"youtube": {"madeForKids": False}},
        {"youtube": {"selfDeclaredMadeForKids": True}},
    ],
)
def test_post_preset_can_never_say_made_for_kids(call: Call, preset: dict[str, object]) -> None:
    status, body = call("PUT", "/v1/settings", {"postPreset": preset})
    assert status == 400
    assert body["error"]["message"] == "My settings never mark a clip as made for kids."


@pytest.mark.parametrize(
    "preset",
    [
        {"tiktok": {"privacy": "EVERYONE"}},
        {"tiktok": {"commercial": True}},
        {"youtube": {"category": "99"}},
        {"x": {"replies": "nobody"}},
        {"instagram": {"shareToFeed": "yes"}},
        {"threads": {}},
        "public",
    ],
)
def test_post_preset_refuses_bad_choices(call: Call, preset: object) -> None:
    assert call("PUT", "/v1/settings", {"postPreset": preset})[0] == 400


def test_stored_bad_preset_reads_the_defaults() -> None:
    out = settings.with_defaults({"postPreset": {"youtube": {"madeForKids": True}}})
    assert out["postPreset"] == DEFAULTS["postPreset"]
