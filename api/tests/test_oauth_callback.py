"""GET /oauth/{platform}/callback through cf-prod-hooks (docs/CONTRACTS.md §17.5, §17.12)."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from clipfactory_api import db, hooks
from clipfactory_api.oauth import OAuthEnv, callback, state
from conftest import APP_URL, HOOKS_URL, STATE_KEY, USER, Call, Clock
from fakes import FakeHttp, FakeSecretsManager, FakeSSM, FakeTable
from test_oauth_state_formats import GOOD

PREFIX = "cf-prod/platforms/"
YT_SCOPES = (
    "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly "
    "https://www.googleapis.com/auth/youtube.upload"
)


@pytest.fixture
def hooks_deps(store: db.Store, oauth_env: OAuthEnv, clock: Clock) -> hooks.HooksDeps:
    return hooks.HooksDeps(
        store=store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=clock,
        oauth=oauth_env,
    )


def start(call: Call, platform: str) -> str:
    """Saves keys, presses Connect and returns the state the platform would send back."""
    assert call("PUT", f"/v1/setup/{platform}/keys", GOOD[platform])[0] == 200
    _, body = call("POST", f"/v1/accounts/{platform}/connect")
    return str(parse_qs(urlsplit(body["authorizeUrl"]).query)["state"][0])


def back(hooks_deps: hooks.HooksDeps, platform: str, query: dict[str, str]) -> str:
    event = {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "path": f"/oauth/{platform}/callback",
        "pathParameters": {"platform": platform},
        "queryStringParameters": query,
        "headers": {},
        "requestContext": {"requestId": "rest-9", "stage": "v1"},
    }
    out = hooks.handle(event, hooks_deps)
    assert out["statusCode"] == 302
    assert out["headers"]["cache-control"] == "no-store"
    assert out["headers"]["referrer-policy"] == "no-referrer"
    location = out["headers"]["location"]
    prefix = f"{APP_URL}/settings/posting/setup/{platform}?result="
    assert location.startswith(prefix)
    result = str(location[len(prefix) :])
    assert result in callback.RESULTS
    return result


def account(store: db.Store, platform: str) -> dict[str, Any] | None:
    return store.get(db.user_pk(USER), f"ACCOUNT#{platform}")


def token(secrets_client: FakeSecretsManager, platform: str) -> Any:
    return secrets_client.json(f"{PREFIX}{platform}/token")


# --- recorded platform answers -------------------------------------------------------------------------------------

YOUTUBE_TOKEN = {
    "access_token": "ya29.ACCESS",
    "expires_in": 3599,
    "refresh_token": "1//REFRESH",
    "scope": YT_SCOPES,
    "token_type": "Bearer",
}
YOUTUBE_CHANNELS = {
    "items": [
        {
            "id": "UC123",
            "snippet": {
                "title": "Owner Plays",
                "customUrl": "@ownerplays",
                "thumbnails": {"default": {"url": "https://yt3.ggpht.com/a.jpg"}},
            },
        }
    ]
}
TIKTOK_TOKEN = {
    "access_token": "act.ACCESS",
    "expires_in": 86400,
    "open_id": "open-1",
    "refresh_expires_in": 31536000,
    "refresh_token": "rft.REFRESH",
    "scope": "user.info.basic,video.publish,video.list",
    "token_type": "Bearer",
}
TIKTOK_USER = {"data": {"user": {"open_id": "open-1", "display_name": "Owner", "avatar_url": "https://p16/a.jpg"}}}
TIKTOK_CREATOR = {
    "data": {
        "creator_username": "owner",
        "creator_nickname": "Owner",
        "creator_avatar_url": "https://p16/c.jpg",
        "privacy_level_options": ["SELF_ONLY"],
    },
    "error": {"code": "ok"},
}
META_TOKEN = {"access_token": "EAAG-USER", "token_type": "bearer"}
META_LONG = {"access_token": "EAAG-LONG", "token_type": "bearer"}
IG_ME = {"id": "u1"}
IG_PAGE_1 = {
    "id": "p1",
    "name": "Owner Page",
    "access_token": "EAAG-PAGE-1",
    "instagram_business_account": {"id": "1784", "username": "owner", "profile_picture_url": "https://ig/a.jpg"},
}
IG_PAGE_2 = {
    "id": "p2",
    "name": "Second Page",
    "access_token": "EAAG-PAGE-2",
    "instagram_business_account": {"id": "1785", "username": "second"},
}
IG_NO_IG = {"id": "p3", "name": "Plain Page", "access_token": "EAAG-PAGE-3"}
IG_ONE = {"data": [IG_PAGE_1, IG_NO_IG]}
IG_TWO = {"data": [IG_PAGE_1, IG_PAGE_2]}
FB_PERMS = {
    "data": [
        {"permission": p, "status": "granted"}
        for p in ("pages_show_list", "pages_read_engagement", "pages_manage_posts", "read_insights")
    ]
}
FB_PAGE = {"id": "p1", "name": "Owner Page", "access_token": "EAAG-PAGE-1", "tasks": ["CREATE_CONTENT", "MANAGE"]}
FB_VIEWER = {"id": "p3", "name": "Viewer Page", "access_token": "EAAG-PAGE-3", "tasks": ["ANALYZE"]}
X_TOKEN = {
    "token_type": "bearer",
    "expires_in": 7200,
    "access_token": "X-ACCESS",
    "scope": "tweet.read tweet.write users.read media.write offline.access",
    "refresh_token": "X-REFRESH",
}
X_ME = {"data": {"id": "42", "name": "Owner", "username": "owner", "profile_image_url": "https://pbs.twimg.com/a.jpg"}}

SUCCESS = {
    "youtube": [(200, YOUTUBE_TOKEN), (200, YOUTUBE_CHANNELS)],
    "tiktok": [(200, TIKTOK_TOKEN), (200, TIKTOK_USER), (200, TIKTOK_CREATOR)],
    "instagram": [(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (200, IG_ONE)],
    "facebook": [
        (200, META_TOKEN),
        (200, {"access_token": "EAAG-LONG"}),
        (200, FB_PERMS),
        (200, {"id": "u1"}),
        (200, {"data": [FB_PAGE, FB_VIEWER]}),
    ],
    "x": [(200, X_TOKEN), (200, X_ME)],
}
SECRETS_SEEN = [
    "ya29.ACCESS",
    "1//REFRESH",
    "act.ACCESS",
    "rft.REFRESH",
    "EAAG-USER",
    "EAAG-PAGE-1",
    "X-ACCESS",
    "X-REFRESH",
]


@pytest.mark.parametrize("platform", list(SUCCESS))
def test_connect_success(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    capsys: pytest.CaptureFixture[str],
    platform: str,
) -> None:
    signed = start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert back(hooks_deps, platform, {"code": "THE-CODE", "state": signed}) == "connected"
    stored = account(store, platform)
    assert stored is not None
    assert stored["status"] == "connected"
    assert stored["connectedAt"] == "2026-11-15T12:00:00.000Z"
    assert http.answers == []
    _, listed = call("GET", f"/v1/setup/{platform}")
    public = listed["setup"]["account"]
    assert public["status"] == "connected"
    assert "accountId" not in public
    logs = capsys.readouterr().out
    dumped = json.dumps(table.all(), default=str) + json.dumps(listed) + logs
    for secret in [*SECRETS_SEEN, "THE-CODE", signed, GOOD[platform]["clientSecret"]]:
        assert secret not in dumped, secret
    assert not [i for i in table.all() if i["pk"].startswith("OAUTH#")]  # consumed


def test_youtube_details(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "youtube")
    http.answers.extend(SUCCESS["youtube"])
    back(hooks_deps, "youtube", {"code": "C0DE", "state": signed})
    exchange = parse_qs(http.calls[0].body.decode())
    nonce = signed.split(".")[1]
    assert exchange == {
        "code": ["C0DE"],
        "client_id": [GOOD["youtube"]["clientId"]],
        "client_secret": [GOOD["youtube"]["clientSecret"]],
        "redirect_uri": [f"{HOOKS_URL}/oauth/youtube/callback"],
        "grant_type": ["authorization_code"],
        "code_verifier": [state.pkce(STATE_KEY.encode(), nonce)[0]],
    }
    assert http.calls[1].url == "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true"
    assert token(secrets_client, "youtube") == {
        "accessToken": "ya29.ACCESS",
        "expiresAt": "2026-11-15T12:59:59.000Z",
        "refreshToken": "1//REFRESH",
        "scope": " ".join(sorted(YT_SCOPES.split())),
        "channelId": "UC123",
    }
    stored = account(store, "youtube")
    assert stored is not None
    assert (stored["handle"], stored["name"], stored["avatarUrl"]) == (
        "@ownerplays",
        "Owner Plays",
        "https://yt3.ggpht.com/a.jpg",
    )


def test_tiktok_details(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, store: db.Store) -> None:
    signed = start(call, "tiktok")
    http.answers.extend(SUCCESS["tiktok"])
    back(hooks_deps, "tiktok", {"code": "C0DE", "state": signed})
    sent = parse_qs(http.calls[0].body.decode())
    assert sent["client_key"] == [GOOD["tiktok"]["clientId"]]
    assert "code_verifier" not in sent
    stored = account(store, "tiktok")
    assert stored is not None
    assert stored["handle"] == "@owner"
    assert stored["reconnectBy"] == "2027-11-08T12:00:00.000Z"
    _, listed = call("GET", "/v1/setup/tiktok")
    assert listed["setup"]["gates"][1]["state"] == "limited"


def test_meta_calls_send_appsecret_proof(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp) -> None:
    signed = start(call, "instagram")
    http.answers.extend(SUCCESS["instagram"])
    back(hooks_deps, "instagram", {"code": "C0DE", "state": signed})
    first = http.calls[0]
    assert (first.method, first.url) == ("POST", "https://graph.facebook.com/v27.0/oauth/access_token")
    assert parse_qs((first.body or b"").decode())["client_secret"] == [GOOD["instagram"]["clientSecret"]]
    second = http.calls[1]
    assert (second.method, second.url) == ("POST", "https://graph.facebook.com/v27.0/oauth/access_token")
    assert parse_qs((second.body or b"").decode())["grant_type"] == ["fb_exchange_token"]
    for later in http.calls[2:]:
        assert later.method == "GET"
        assert "appsecret_proof=" in later.url
        assert "EAAG-USER" not in later.url
        assert "EAAG-LONG" not in later.url
    assert "instagram_business_account" in unquote(http.calls[3].url)


def test_instagram_keeps_only_the_page_token(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "instagram")
    http.answers.extend(SUCCESS["instagram"])
    assert back(hooks_deps, "instagram", {"code": "C0DE", "state": signed}) == "connected"
    assert token(secrets_client, "instagram") == {
        "pageAccessToken": "EAAG-PAGE-1",
        "pageId": "p1",
        "igUserId": "1784",
        "userId": "u1",
    }
    dumped = json.dumps(secrets_client.values)
    assert "EAAG-USER" not in dumped
    assert "EAAG-LONG" not in dumped


def test_facebook_keeps_only_the_page_token(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "facebook")
    http.answers.extend(SUCCESS["facebook"])
    back(hooks_deps, "facebook", {"code": "C0DE", "state": signed})
    assert token(secrets_client, "facebook") == {"pageAccessToken": "EAAG-PAGE-1", "pageId": "p1", "userId": "u1"}
    assert "EAAG-LONG" not in json.dumps(secrets_client.values)
    exchanges = [c for c in http.calls if c.url.endswith("/oauth/access_token")]
    assert [c.method for c in exchanges] == ["POST", "POST"]  # the code exchange and fb_exchange_token
    assert parse_qs((exchanges[1].body or b"").decode())["grant_type"] == ["fb_exchange_token"]
    assert all(GOOD["facebook"]["clientSecret"] not in c.url for c in http.calls)


def test_x_details(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager) -> None:
    signed = start(call, "x")
    http.answers.extend(SUCCESS["x"])
    back(hooks_deps, "x", {"code": "C0DE", "state": signed})
    assert http.calls[0].headers["Authorization"].startswith("Basic ")
    assert parse_qs(http.calls[0].body.decode())["code_verifier"]
    assert token(secrets_client, "x")["xUserId"] == "42"
    assert token(secrets_client, "x")["refreshToken"] == "X-REFRESH"


# --- choose ----------------------------------------------------------------------------------------------------------


def test_several_instagram_accounts_need_a_choice(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "instagram")
    http.answers.extend([(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (200, IG_TWO)])
    assert back(hooks_deps, "instagram", {"code": "C", "state": signed}) == "choose"
    assert token(secrets_client, "instagram") is None
    pending = secrets_client.json(f"{PREFIX}instagram/pending")
    assert pending["tokens"] == {"1784": "EAAG-PAGE-1", "1785": "EAAG-PAGE-2"}
    assert "EAAG-LONG" not in json.dumps(pending)
    _, body = call("GET", "/v1/setup/instagram")
    assert body["setup"]["account"]["status"] == "choose_account"
    assert [c["id"] for c in body["setup"]["account"]["choices"]] == ["1784", "1785"]
    _, chosen = call("POST", "/v1/accounts/instagram/choose", {"accountId": "1785"})
    assert chosen["setup"]["account"]["handle"] == "@second"
    assert token(secrets_client, "instagram") == {
        "pageAccessToken": "EAAG-PAGE-2",
        "pageId": "p2",
        "igUserId": "1785",
        "userId": "u1",
    }


def test_an_expired_choice_deletes_the_pending_tokens(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    signed = start(call, "instagram")
    http.answers.extend([(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (200, IG_TWO)])
    assert back(hooks_deps, "instagram", {"code": "C", "state": signed}) == "choose"
    assert secrets_client.json(f"{PREFIX}instagram/pending") is not None
    clock.now += timedelta(minutes=31)
    status, body = call("POST", "/v1/accounts/instagram/choose", {"accountId": "1785"})
    assert status == 409
    assert body["error"]["message"] == "That list is too old. Press Connect again."
    assert secrets_client.json(f"{PREFIX}instagram/pending") is None
    _, listed = call("GET", "/v1/setup/instagram")
    assert "choices" not in listed["setup"]["account"]


def test_a_new_connect_deletes_an_old_pending_secret(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "facebook")
    second = {**FB_PAGE, "id": "p2", "name": "Second", "access_token": "EAAG-PAGE-2"}
    http.answers.extend([*SUCCESS["facebook"][:4], (200, {"data": [FB_PAGE, second]})])
    assert back(hooks_deps, "facebook", {"code": "C", "state": signed}) == "choose"
    assert secrets_client.json(f"{PREFIX}facebook/pending") is not None
    assert call("POST", "/v1/accounts/facebook/connect")[0] == 200
    assert secrets_client.json(f"{PREFIX}facebook/pending") is None
    assert "EAAG-PAGE-2" not in json.dumps(secrets_client.values)


def test_several_pages_need_a_choice(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp) -> None:
    signed = start(call, "facebook")
    second = {**FB_PAGE, "id": "p2", "name": "Second", "access_token": "EAAG-PAGE-2"}
    http.answers.extend([*SUCCESS["facebook"][:4], (200, {"data": [FB_PAGE, second]})])
    assert back(hooks_deps, "facebook", {"code": "C", "state": signed}) == "choose"
    assert call("POST", "/v1/accounts/facebook/choose", {"accountId": "p2"})[0] == 200


# --- every way it can go wrong ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("platform", "answers", "result"),
    [
        (
            "youtube",
            [(200, {**YOUTUBE_TOKEN, "scope": "https://www.googleapis.com/auth/youtube.upload"})],
            "missing_permissions",
        ),
        ("youtube", [(200, YOUTUBE_TOKEN), (200, {"items": []})], "no_channel"),
        ("youtube", [(401, {"error": "invalid_client"})], "keys_wrong"),
        ("youtube", [(400, {"error": "redirect_uri_mismatch"})], "redirect_wrong"),
        ("youtube", [(503, {})], "platform_down"),
        (
            "youtube",
            [__import__("clipfactory_api.platforms.base", fromlist=["NetworkError"]).NetworkError("x")],
            "platform_down",
        ),
        ("youtube", [(400, {"error": "invalid_grant"})], "error"),
        ("tiktok", [(200, {**TIKTOK_TOKEN, "scope": "user.info.basic"})], "missing_permissions"),
        (
            "tiktok",
            [(400, {"error": "invalid_request", "error_description": "redirect_uri is not matched"})],
            "redirect_wrong",
        ),
        ("tiktok", [(401, {"error": "invalid_client"})], "keys_wrong"),
        (
            "instagram",
            [(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (200, {"data": [IG_NO_IG]})],
            "no_accounts",
        ),
        (
            "instagram",
            [(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (400, {"error": {"code": 10, "message": "no"}})],
            "wrong_account_type",
        ),
        ("instagram", [(400, {"error": {"code": 101, "message": "Error validating client secret"}})], "keys_wrong"),
        (
            "facebook",
            [
                (200, META_TOKEN),
                (200, {"access_token": "L"}),
                (200, {"data": [{"permission": "pages_manage_posts", "status": "declined"}]}),
            ],
            "missing_permissions",
        ),
        ("facebook", [*SUCCESS["facebook"][:4], (200, {"data": [FB_VIEWER]})], "no_pages"),
        ("x", [(200, {**X_TOKEN, "scope": "tweet.read users.read"})], "missing_permissions"),
        ("x", [(401, {"error": "unauthorized_client"})], "keys_wrong"),
    ],
)
def test_callback_results(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    platform: str,
    answers: list[Any],
    result: str,
) -> None:
    signed = start(call, platform)
    http.answers.extend(answers)
    assert back(hooks_deps, platform, {"code": "C", "state": signed}) == result
    assert token(secrets_client, platform) is None
    stored = account(store, platform)
    assert stored is None or stored["status"] != "connected"
    _, body = call("GET", f"/v1/setup/{platform}")
    assert body["setup"]["ready"] is False


def test_missing_permissions_makes_facebook_ask_again(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp) -> None:
    signed = start(call, "facebook")
    http.answers.extend(
        [
            (200, META_TOKEN),
            (200, {"access_token": "L"}),
            (200, {"data": [{"permission": "read_insights", "status": "declined"}]}),
        ]
    )
    back(hooks_deps, "facebook", {"code": "C", "state": signed})
    _, again = call("POST", "/v1/accounts/facebook/connect")
    assert "auth_type=rerequest" in again["authorizeUrl"]


@pytest.mark.parametrize(
    ("error", "result"), [("access_denied", "denied"), ("user_denied", "denied"), ("server_error", "error")]
)
def test_owner_pressed_cancel(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, error: str, result: str) -> None:
    signed = start(call, "tiktok")
    assert back(hooks_deps, "tiktok", {"error": error, "state": signed}) == result
    assert http.calls == []


def test_state_is_single_use(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp) -> None:
    signed = start(call, "x")
    http.answers.extend(SUCCESS["x"])
    assert back(hooks_deps, "x", {"code": "C", "state": signed}) == "connected"
    assert back(hooks_deps, "x", {"code": "C", "state": signed}) == "expired"
    assert http.answers == []


def test_state_checks(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, clock: Clock) -> None:
    signed = start(call, "youtube")
    assert back(hooks_deps, "youtube", {"code": "C"}) == "expired"
    assert back(hooks_deps, "youtube", {"code": "C", "state": signed[:-2] + "AA"}) == "expired"
    assert back(hooks_deps, "x", {"code": "C", "state": signed}) == "expired"  # another platform's state
    clock.now = clock.now.replace(minute=11)
    assert back(hooks_deps, "youtube", {"code": "C", "state": signed}) == "expired"
    assert http.calls == []


def test_a_forged_state_without_its_item_is_expired(hooks_deps: hooks.HooksDeps, http: FakeHttp) -> None:
    signed = state.sign(STATE_KEY.encode(), "youtube", state.new_nonce(), 1_794_744_600)
    assert back(hooks_deps, "youtube", {"code": "C", "state": signed}) == "expired"
    assert http.calls == []


def test_redirect_is_fixed_whatever_the_query(call: Call, hooks_deps: hooks.HooksDeps) -> None:
    query = {"state": "x", "redirect": "https://evil.example", "next": "//evil.example", "result": "connected"}
    assert back(hooks_deps, "youtube", query) == "expired"
    assert callback.location(APP_URL, "youtube", "https://evil.example") == (
        f"{APP_URL}/settings/posting/setup/youtube?result=error"
    )


def test_query_is_never_logged(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, capsys: pytest.CaptureFixture[str]
) -> None:
    signed = start(call, "x")
    http.answers.extend(SUCCESS["x"])
    capsys.readouterr()
    back(hooks_deps, "x", {"code": "SECRET-CODE-9", "state": signed})
    logs = capsys.readouterr().out
    assert logs
    for secret in ("SECRET-CODE-9", signed, signed.split(".")[1], "X-ACCESS", "X-REFRESH"):
        assert secret not in logs


def test_keys_deleted_before_the_callback(
    call: Call, hooks_deps: hooks.HooksDeps, secrets_client: FakeSecretsManager
) -> None:
    signed = start(call, "x")
    del secrets_client.values[f"{PREFIX}x/app"]
    assert back(hooks_deps, "x", {"code": "C", "state": signed}) == "keys_wrong"


def test_unexpected_failure_still_lands_on_the_setup_page(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, monkeypatch: pytest.MonkeyPatch
) -> None:
    signed = start(call, "x")

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("boom")

    from clipfactory_api.oauth import providers

    monkeypatch.setattr(providers, "exchange", broken)
    assert back(hooks_deps, "x", {"code": "C", "state": signed}) == "error"
