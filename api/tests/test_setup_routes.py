"""/v1/setup and /v1/accounts: keys, Check it, Connect, choose, disconnect (docs/CONTRACTS.md §17.4, §17.12)."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db
from clipfactory_api.oauth import OAuthEnv, setup, state
from conftest import APP_URL, HOOKS_URL, STATE_KEY, USER, Call
from fakes import FakeCloudFront, FakeHttp, FakeLambda, FakeS3, FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD, META_CONFIG, X_SECRET, YOUTUBE_ID, YOUTUBE_SECRET

PREFIX = "cf-prod/platforms/"
ORDER = ["youtube", "tiktok", "instagram", "facebook", "x"]


def save_keys(call: Call, platform: str, **override: str) -> tuple[int, Any]:
    return call("PUT", f"/v1/setup/{platform}/keys", {**GOOD[platform], **override})


def connect_account(store: db.Store, platform: str, **fields: Any) -> None:
    setup.put_account(
        store,
        USER,
        platform,
        "connected",
        now=__import__("conftest").NOW,
        fields={"handle": "@me", "accountId": "acct-1", "connectedAt": "2026-11-15T10:00:00.000Z", **fields},
    )


def put_token(secrets_client: FakeSecretsManager, platform: str, value: dict[str, Any]) -> None:
    secrets_client.values[f"{PREFIX}{platform}/token"] = json.dumps(value)


def leaked(secret: str, *, responses: list[Any], table: FakeTable, logs: str) -> list[str]:
    where = []
    if any(secret in json.dumps(r) for r in responses):
        where.append("response")
    if secret in json.dumps(table.all(), default=str):
        where.append("dynamodb")
    if secret in logs:
        where.append("logs")
    return where


# --- the list ----------------------------------------------------------------------------------------------------


def test_setup_list_starts_empty_with_values(call: Call) -> None:
    status, body = call("GET", "/v1/setup")
    assert status == 200
    assert [p["platform"] for p in body["platforms"]] == ORDER
    assert body["ready"] == 0
    youtube = body["platforms"][0]
    assert youtube == {
        "platform": "youtube",
        "stepsDone": [],
        "ready": False,
        "keys": {"saved": False},
        "account": {"platform": "youtube", "status": "not_connected"},
        "gates": [{"key": "published_app", "state": "action"}],
    }
    assert body["platforms"][1]["files"] == []
    assert [g["key"] for g in body["platforms"][1]["gates"]] == ["app_review", "posting_audit"]
    assert body["platforms"][2]["gates"] == []
    assert body["platforms"][3]["gates"] == [{"key": "app_live", "state": "limited"}]
    assert body["platforms"][4]["gates"] == [{"key": "credits", "state": "unknown"}]
    values = body["values"]
    assert values["appName"] == "Clip Factory"
    assert values["websiteUrl"] == f"{APP_URL}/about.html"
    assert values["websitePrefix"] == f"{APP_URL}/"
    assert values["privacyUrl"] == f"{APP_URL}/legal/privacy.html"
    assert values["termsUrl"] == f"{APP_URL}/legal/terms.html"
    assert values["dataDeletionUrl"] == f"{APP_URL}/legal/privacy.html#delete"
    assert values["appDomain"] == "d111111abcdef8.cloudfront.net"
    assert values["hooksDomain"] == "abc123.execute-api.eu-north-1.amazonaws.com"
    assert values["redirectUris"] == {p: f"{HOOKS_URL}/oauth/{p}/callback" for p in ORDER}
    assert values["scopes"]["tiktok"] == ["user.info.basic", "video.publish", "video.list"]
    assert values["ownerEmail"] == "owner@example.com"


def test_unknown_platform_is_404(call: Call) -> None:
    assert call("GET", "/v1/setup/myspace")[0] == 404
    assert call("POST", "/v1/accounts/myspace/connect")[0] == 404


def test_tick_and_untick_steps(call: Call) -> None:
    status, body = call("PATCH", "/v1/setup/youtube", {"step": "key-publish", "done": True})
    assert status == 200
    assert body["setup"]["stepsDone"] == ["key-publish"]
    assert body["setup"]["gates"] == [{"key": "published_app", "state": "ok"}]
    call("PATCH", "/v1/setup/youtube", {"step": "ready-channel", "done": True})
    _, body = call("PATCH", "/v1/setup/youtube", {"step": "key-publish", "done": False})
    assert body["setup"]["stepsDone"] == ["ready-channel"]
    assert call("PATCH", "/v1/setup/youtube", {"step": "Bad Step!", "done": True})[0] == 400
    assert call("PATCH", "/v1/setup/youtube", {"step": "x", "done": "yes"})[0] == 400


def test_facebook_live_step_opens_its_gate(call: Call) -> None:
    _, body = call("PATCH", "/v1/setup/facebook", {"step": "public-live", "done": True})
    assert body["setup"]["gates"] == [{"key": "app_live", "state": "ok"}]


@pytest.mark.parametrize(
    ("value", "gate"), [("draft", "limited"), ("in_review", "waiting"), ("live", "ok"), ("not_approved", "limited")]
)
def test_tiktok_review_status_is_picked_by_the_owner(call: Call, value: str, gate: str) -> None:
    _, body = call("PATCH", "/v1/setup/tiktok", {"gate": "app_review", "state": value})
    assert body["setup"]["gates"][0]["key"] == "app_review"
    assert body["setup"]["gates"][0]["state"] == gate


def test_review_status_only_for_tiktok(call: Call) -> None:
    assert call("PATCH", "/v1/setup/youtube", {"gate": "app_review", "state": "live"})[0] == 400
    assert call("PATCH", "/v1/setup/tiktok", {"gate": "app_review", "state": "maybe"})[0] == 400


def test_too_many_steps(call: Call, store: db.Store) -> None:
    setup.record(store, USER, "x", __import__("conftest").NOW, add_steps=[f"s-{i}" for i in range(60)])
    assert call("PATCH", "/v1/setup/x", {"step": "one-more", "done": True})[0] == 400


# --- keys ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("platform", ORDER)
def test_keys_are_saved_in_secrets_manager_and_only_hints_come_back(
    call: Call,
    platform: str,
    secrets_client: FakeSecretsManager,
    table: FakeTable,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status, body = save_keys(call, platform)
    assert status == 200
    keys = body["setup"]["keys"]
    assert keys["saved"] is True
    assert keys["savedAt"] == "2026-11-15T12:00:00.000Z"
    assert set(keys["hints"]) == set(GOOD[platform])
    stored = secrets_client.json(f"{PREFIX}{platform}/app")
    assert {k: stored[k] for k in GOOD[platform]} == GOOD[platform]
    assert stored["userId"] == USER
    assert {t["Key"]: t["Value"] for t in secrets_client.tags[f"{PREFIX}{platform}/app"]} == {
        "app": "cf-prod",
        "platform": platform,
    }
    _, again = call("GET", f"/v1/setup/{platform}")
    logs = capsys.readouterr().out
    secret = GOOD[platform]["clientSecret"]
    assert leaked(secret, responses=[body, again], table=table, logs=logs) == []


def test_bad_keys_keep_nothing(call: Call, secrets_client: FakeSecretsManager) -> None:
    status, body = save_keys(call, "youtube", clientSecret="AIza-not-it")
    assert status == 400
    assert "GOCSPX-" in body["error"]["message"]
    assert f"{PREFIX}youtube/app" not in secrets_client.values
    assert call("PUT", "/v1/setup/youtube/keys", {"clientId": YOUTUBE_ID})[0] == 400
    assert call("PUT", "/v1/setup/youtube/keys", {**GOOD["youtube"], "configId": META_CONFIG})[0] == 400
    assert (
        call("PUT", "/v1/setup/instagram/keys", {k: v for k, v in GOOD["instagram"].items() if k != "configId"})[0]
        == 400
    )


def test_meta_login_url_in_the_config_box(call: Call, secrets_client: FakeSecretsManager) -> None:
    url = f"https://www.facebook.com/v27.0/dialog/oauth?client_id=1&config_id={META_CONFIG}&redirect_uri=x"
    assert save_keys(call, "instagram", configId=url)[0] == 200
    assert secrets_client.json(f"{PREFIX}instagram/app")["configId"] == META_CONFIG


def test_new_keys_disconnect_the_account(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    save_keys(call, "x")
    connect_account(store, "x")
    put_token(secrets_client, "x", {"accessToken": "AT-1", "refreshToken": "RT-1"})
    http.answers.append((200, {}))  # revoke
    status, body = save_keys(call, "x", clientId="A" * 30)
    assert status == 200
    assert body["setup"]["account"] == {"platform": "x", "status": "not_connected", "reason": "keys_changed"}
    assert f"{PREFIX}x/token" not in secrets_client.values
    assert http.urls == ["https://api.x.com/2/oauth2/revoke"]


def test_same_keys_again_keep_the_account(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    save_keys(call, "x")
    connect_account(store, "x")
    put_token(secrets_client, "x", {"accessToken": "AT-1"})
    _, body = save_keys(call, "x", clientSecret=X_SECRET[::-1])
    assert body["setup"]["account"]["status"] == "connected"


def test_delete_keys(call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT"})
    http.answers.append((200, {}))
    assert call("DELETE", "/v1/setup/tiktok/keys")[0] == 204
    assert not [n for n in secrets_client.values if n.startswith(f"{PREFIX}tiktok/")]
    _, body = call("GET", "/v1/setup/tiktok")
    assert body["setup"]["keys"] == {"saved": False}
    assert body["setup"]["account"]["status"] == "not_connected"


# --- connect ---------------------------------------------------------------------------------------------------------


def test_connect_needs_keys(call: Call) -> None:
    status, body = call("POST", "/v1/accounts/youtube/connect")
    assert status == 409
    assert body["error"] == {"code": "conflict", "message": "Paste your YouTube keys first."}


def _authorize(call: Call, platform: str) -> tuple[str, dict[str, list[str]], dict[str, Any]]:
    save_keys(call, platform)
    status, body = call("POST", f"/v1/accounts/{platform}/connect")
    assert status == 200
    assert body["expiresAt"] == "2026-11-15T12:10:00.000Z"
    url = body["authorizeUrl"]
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}", parse_qs(parts.query), body


def _state_item(table: FakeTable) -> dict[str, Any]:
    (item,) = [i for i in table.all() if i["pk"].startswith("OAUTH#")]
    return item


def test_connect_youtube_url(call: Call, table: FakeTable) -> None:
    base, q, _ = _authorize(call, "youtube")
    assert base == "https://accounts.google.com/o/oauth2/v2/auth"
    assert q["client_id"] == [YOUTUBE_ID]
    assert q["redirect_uri"] == [f"{HOOKS_URL}/oauth/youtube/callback"]
    assert q["response_type"] == ["code"]
    assert q["scope"] == [
        "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly "
        "https://www.googleapis.com/auth/youtube.upload"
    ]
    assert (q["access_type"], q["prompt"], q["include_granted_scopes"]) == (["offline"], ["consent"], ["true"])
    assert q["code_challenge_method"] == ["S256"]
    nonce = state.verify(STATE_KEY.encode(), "youtube", q["state"][0], 1_794_744_000)
    assert q["code_challenge"] == [state.pkce(STATE_KEY.encode(), nonce)[1]]
    item = _state_item(table)
    assert item["pk"] == f"OAUTH#{nonce}"
    assert (item["sk"], item["type"], item["userId"], item["platform"]) == ("STATE", "oauth", USER, "youtube")
    assert item["redirectUri"] == f"{HOOKS_URL}/oauth/youtube/callback"
    assert item["ttl"] == 1_794_744_000 + 600 + 300
    verifier = state.pkce(STATE_KEY.encode(), nonce)[0]
    assert verifier not in json.dumps(table.all(), default=str)  # derived, never stored


def test_connect_tiktok_url(call: Call) -> None:
    base, q, body = _authorize(call, "tiktok")
    assert base == "https://www.tiktok.com/v2/auth/authorize/"
    assert q["client_key"] == [GOOD["tiktok"]["clientId"]]
    assert q["scope"] == ["user.info.basic,video.publish,video.list"]
    assert q["disable_auto_auth"] == ["1"]
    assert "code_challenge" not in q
    assert "client_secret" not in body["authorizeUrl"]
    assert GOOD["tiktok"]["clientSecret"] not in body["authorizeUrl"]


@pytest.mark.parametrize("platform", ["instagram", "facebook"])
def test_connect_meta_url_has_no_scope(call: Call, platform: str) -> None:
    base, q, _ = _authorize(call, platform)
    assert base == "https://www.facebook.com/v27.0/dialog/oauth"
    assert q["config_id"] == [META_CONFIG]
    assert "scope" not in q
    assert "code_challenge" not in q
    assert ("override_default_response_type" in q) == (platform == "instagram")
    assert "auth_type" not in q


def test_facebook_rerequest_after_missing_permissions(call: Call, store: db.Store) -> None:
    setup.record(store, USER, "facebook", __import__("conftest").NOW, {"lastResult": "missing_permissions"})
    _, q, _ = _authorize(call, "facebook")
    assert q["auth_type"] == ["rerequest"]


def test_connect_x_url(call: Call) -> None:
    base, q, _ = _authorize(call, "x")
    assert base == "https://x.com/i/oauth2/authorize"
    assert q["scope"] == ["tweet.read tweet.write users.read media.write offline.access"]
    assert q["code_challenge_method"] == ["S256"]
    assert q["redirect_uri"] == [f"{HOOKS_URL}/oauth/x/callback"]


def test_connect_without_server_setup_is_503(call: Call, app: Any) -> None:
    app.oauth = None
    assert call("GET", "/v1/setup")[0] == 503


# --- check -----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("platform", "answers", "code"),
    [
        ("youtube", [(400, {"error": "invalid_grant"})], "not_connected"),
        ("youtube", [(401, {"error": "invalid_client"})], "keys_wrong"),
        ("youtube", [(400, {"error": "redirect_uri_mismatch"})], "redirect_wrong"),
        ("youtube", [(503, {})], "platform_down"),
        ("tiktok", [(200, {"access_token": "clt.x", "expires_in": 7200})], "not_connected"),
        ("tiktok", [(401, {"error": "invalid_client"})], "keys_wrong"),
        ("instagram", [(200, {"access_token": "app|t"}), (200, {"name": "Clip Factory", "id": "1"})], "not_connected"),
        ("facebook", [(400, {"error": {"code": 101, "message": "Error validating client secret."}})], "keys_wrong"),
        ("x", [(400, {"error": "invalid_request"})], "not_connected"),
        ("x", [(401, {"error": "unauthorized_client"})], "keys_wrong"),
    ],
)
def test_check_keys(call: Call, http: FakeHttp, platform: str, answers: list[Any], code: str) -> None:
    save_keys(call, platform)
    http.answers.extend(answers)
    status, body = call("POST", f"/v1/setup/{platform}/check")
    assert status == 200
    check = body["check"]
    assert check["code"] == code
    assert check["ok"] is (code == "not_connected")
    assert check["at"] == "2026-11-15T12:00:00.000Z"
    assert body["setup"]["keys"]["check"] == check
    assert GOOD[platform]["clientSecret"] not in json.dumps(body)
    if platform == "youtube":
        sent = parse_qs(http.calls[0].body.decode())
        assert sent["code"] == ["cf-check"]
        assert sent["redirect_uri"] == [f"{HOOKS_URL}/oauth/youtube/callback"]


def test_check_meta_names_the_app(call: Call, http: FakeHttp) -> None:
    save_keys(call, "instagram")
    http.answers.extend([(200, {"access_token": "app|t"}), (200, {"name": "Clip Factory"})])
    connect = call("POST", "/v1/setup/instagram/check")[1]["check"]
    assert connect["code"] == "not_connected"
    assert (http.calls[0].method, http.urls[0]) == ("POST", "https://graph.facebook.com/v27.0/oauth/access_token")
    assert parse_qs((http.calls[0].body or b"").decode())["grant_type"] == ["client_credentials"]
    assert GOOD["instagram"]["clientSecret"] not in http.urls[0]
    assert http.urls[1] == f"https://graph.facebook.com/v27.0/{GOOD['instagram']['clientId']}?fields=name"


def test_check_without_keys_is_409(call: Call) -> None:
    assert call("POST", "/v1/setup/x/check")[0] == 409


def test_check_a_connected_account(
    call: Call, store: db.Store, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    save_keys(call, "x")
    connect_account(store, "x")
    put_token(secrets_client, "x", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z", "username": "me"})
    http.answers.extend([(400, {"error": "invalid_request"}), (200, {"data": {"id": "1"}})])
    _, body = call("POST", "/v1/setup/x/check")
    assert body["check"]["code"] == "ok"
    assert body["check"]["account"] == "ok"
    assert http.calls[1].headers["Authorization"] == "Bearer AT"


def test_check_finds_a_dead_token(
    call: Call, store: db.Store, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    save_keys(call, "youtube")
    connect_account(store, "youtube")
    put_token(secrets_client, "youtube", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.extend([(400, {"error": "invalid_grant"}), (401, {"error": {"code": 401}})])
    _, body = call("POST", "/v1/setup/youtube/check")
    assert body["check"]["code"] == "token_dead"
    assert body["check"]["account"] == "dead"
    assert body["setup"]["account"]["status"] == "needs_reconnect"
    assert body["setup"]["account"]["reason"] == "token_dead"


def test_check_x_credits_empty(call: Call, store: db.Store, http: FakeHttp, secrets_client: FakeSecretsManager) -> None:
    save_keys(call, "x")
    connect_account(store, "x")
    put_token(secrets_client, "x", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.extend([(400, {}), (402, {"title": "CreditsDepleted"})])
    _, body = call("POST", "/v1/setup/x/check")
    assert body["check"]["code"] == "credits_empty"
    assert body["setup"]["gates"] == [{"key": "credits", "state": "action", "at": "2026-11-15T12:00:00.000Z"}]
    assert body["setup"]["ready"] is False


# --- TikTok verification file --------------------------------------------------------------------------------------


def test_tiktok_file_upload_and_delete(call: Call, web_s3: FakeS3, cloudfront: FakeCloudFront) -> None:
    name = "tiktokAbCdEf123456.txt"
    status, body = call("POST", "/v1/setup/tiktok/verification-file", {"filename": name, "content": "tiktok-dev=xyz"})
    assert status == 200
    assert body["setup"]["files"] == [name]
    assert web_s3.objects[name] == b"tiktok-dev=xyz"
    (put,) = web_s3.puts
    assert put == {
        "Bucket": "cf-prod-web-123",
        "Key": name,
        "ContentType": "text/plain; charset=utf-8",
        "CacheControl": "no-cache",
    }
    assert cloudfront.invalidations[0]["Paths"] == {"Quantity": 1, "Items": [f"/{name}"]}
    assert call("DELETE", f"/v1/setup/tiktok/verification-file/{name}")[0] == 204
    assert name not in web_s3.objects
    assert call("GET", "/v1/setup/tiktok")[1]["setup"]["files"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"filename": "index.html", "content": "x"},
        {"filename": "../tiktok1234.txt", "content": "x"},
        {"filename": "tiktokAbCd.txt", "content": "x" * 5000},
        {"filename": "tiktokAbCd.txt", "content": "<script>é</script>"},
        {"filename": "tiktokAbCd.txt", "content": "  "},
        {"filename": "tiktokAbCd.txt"},
    ],
)
def test_tiktok_file_is_checked(call: Call, web_s3: FakeS3, body: dict[str, Any]) -> None:
    assert call("POST", "/v1/setup/tiktok/verification-file", body)[0] == 400
    assert web_s3.objects == {}


def test_tiktok_file_delete_refuses_other_names(call: Call, web_s3: FakeS3) -> None:
    web_s3.objects["index.html"] = b"app"
    assert call("DELETE", "/v1/setup/tiktok/verification-file/index.html")[0] == 404
    assert "index.html" in web_s3.objects


# --- choose, disconnect, creator info ------------------------------------------------------------------------------


def _choices(store: db.Store, secrets_client: FakeSecretsManager, platform: str) -> None:
    now = __import__("conftest").NOW
    setup.put_account(store, USER, platform, "choose_account", now=now)
    choices = [{"id": "p1", "name": "Page One"}, {"id": "p2", "name": "Page Two", "avatarUrl": "https://x/a.png"}]
    setup.record(store, USER, platform, now, {"choices": choices, "choicesExpireAt": "2026-11-15T12:30:00.000Z"})
    pending: dict[str, Any] = {
        "choices": choices,
        "userId": "u1",
        "tokens": {"p1": "PAGE-TOKEN-1", "p2": "PAGE-TOKEN-2"},
    }
    if platform == "instagram":
        pending["pages"] = {"p1": "fbpage-1", "p2": "fbpage-2"}
    secrets_client.values[f"{PREFIX}{platform}/pending"] = json.dumps(pending)


def test_choose_a_facebook_page(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    _choices(store, secrets_client, "facebook")
    _, listed = call("GET", "/v1/setup/facebook")
    assert listed["setup"]["account"]["choices"] == [
        {"id": "p1", "name": "Page One"},
        {"id": "p2", "name": "Page Two", "avatarUrl": "https://x/a.png"},
    ]
    assert "PAGE-TOKEN" not in json.dumps(listed)
    status, body = call("POST", "/v1/accounts/facebook/choose", {"accountId": "p2"})
    assert status == 200
    account = body["setup"]["account"]
    assert (account["status"], account["handle"], account["name"]) == ("connected", "Page Two", "Page Two")
    assert "choices" not in account
    assert secrets_client.json(f"{PREFIX}facebook/token") == {
        "pageAccessToken": "PAGE-TOKEN-2",
        "pageId": "p2",
        "userId": "u1",
    }
    assert f"{PREFIX}facebook/pending" not in secrets_client.values
    stored = store.get(db.user_pk(USER), "ACCOUNT#facebook")
    assert stored is not None
    assert stored["accountId"] == "p2"


def test_choose_an_instagram_account(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    _choices(store, secrets_client, "instagram")
    assert call("POST", "/v1/accounts/instagram/choose", {"accountId": "p1"})[0] == 200
    assert secrets_client.json(f"{PREFIX}instagram/token") == {
        "pageAccessToken": "PAGE-TOKEN-1",
        "pageId": "fbpage-1",
        "igUserId": "p1",
        "userId": "u1",
    }


def test_choose_refuses_unknown_or_old_choices(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, clock: Any
) -> None:
    _choices(store, secrets_client, "facebook")
    assert call("POST", "/v1/accounts/facebook/choose", {"accountId": "p9"})[0] == 409
    clock.now = clock.now.replace(hour=13)
    assert call("POST", "/v1/accounts/facebook/choose", {"accountId": "p1"})[0] == 409
    assert call("POST", "/v1/accounts/youtube/choose", {"accountId": "p1"})[0] == 400


def test_disconnect_youtube_revokes_deletes_and_forgets(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, lambda_client: FakeLambda
) -> None:
    save_keys(call, "youtube")
    connect_account(store, "youtube")
    put_token(secrets_client, "youtube", {"accessToken": "AT", "refreshToken": "RT-SECRET"})
    http.answers.append((200, {}))
    assert call("DELETE", "/v1/accounts/youtube")[0] == 204
    (revoke,) = http.calls
    assert revoke.url == "https://oauth2.googleapis.com/revoke"
    assert parse_qs(revoke.body.decode()) == {"token": ["RT-SECRET"]}
    assert f"{PREFIX}youtube/token" not in secrets_client.values
    assert f"{PREFIX}youtube/app" in secrets_client.values  # Connect again keeps the keys
    (invoke,) = lambda_client.calls
    assert invoke["payload"] == {"action": "forget", "userId": USER, "platform": "youtube"}
    assert call("GET", "/v1/accounts")[1]["accounts"][0] == {"platform": "youtube", "status": "not_connected"}


def test_disconnect_survives_a_failing_revoke(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT"})
    http.answers.append(RuntimeError("boom"))
    assert call("DELETE", "/v1/accounts/tiktok")[0] == 204
    assert f"{PREFIX}tiktok/token" not in secrets_client.values


def test_accounts_hide_internal_fields(call: Call, store: db.Store) -> None:
    connect_account(store, "x", name="Me", avatarUrl="https://pbs.twimg.com/a.jpg", scopes=["tweet.read"])
    store.update(db.user_pk(USER), "ACCOUNT#x", {"refreshLeaseUntil": "2026-11-15T12:00:30.000Z"})
    x = call("GET", "/v1/accounts")[1]["accounts"][-1]
    assert x == {
        "platform": "x",
        "status": "connected",
        "handle": "@me",
        "name": "Me",
        "avatarUrl": "https://pbs.twimg.com/a.jpg",
        "connectedAt": "2026-11-15T10:00:00.000Z",
    }


CREATOR = {
    "data": {
        "creator_avatar_url": "https://p16.tiktokcdn.com/a.jpeg",
        "creator_username": "owner",
        "creator_nickname": "Owner",
        "privacy_level_options": ["SELF_ONLY"],
        "comment_disabled": False,
        "duet_disabled": True,
        "stitch_disabled": False,
        "max_video_post_duration_sec": 600,
    },
    "error": {"code": "ok", "message": "", "log_id": "1"},
}


def test_creator_info(call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp) -> None:
    assert call("GET", "/v1/accounts/tiktok/creator-info")[0] == 409
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.append((200, CREATOR))
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert status == 200
    assert body["creator"] == {
        "nickname": "Owner",
        "username": "owner",
        "avatarUrl": "https://p16.tiktokcdn.com/a.jpeg",
        "privacyOptions": ["SELF_ONLY"],
        "commentDisabled": False,
        "duetDisabled": True,
        "stitchDisabled": False,
        "maxDurationSec": 600,
    }
    assert http.calls[0].url == "https://open.tiktokapis.com/v2/post/publish/creator_info/query/"
    _, listed = call("GET", "/v1/setup/tiktok")
    assert listed["setup"]["gates"][1] == {"key": "posting_audit", "state": "limited", "at": "2026-11-15T12:00:00.000Z"}


def test_creator_info_spam_error_is_a_friendly_409(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.append((200, {"data": {}, "error": {"code": "spam_risk_user_banned_from_posting"}}))
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert status == 409
    assert body["error"]["message"] == "TikTok is not letting this account post right now."


def test_oauth_env_redirect_uri_has_no_trailing_slash(oauth_env: OAuthEnv) -> None:
    oauth_env.hooks_url = HOOKS_URL + "/"
    assert oauth_env.redirect_uri("x") == f"{HOOKS_URL}/oauth/x/callback"


def test_yt_secret_constant_is_good() -> None:
    assert YOUTUBE_SECRET.startswith("GOCSPX-")
