"""Setup and accounts routes: F012 (a slow or busy TikTok while refreshing the token is 503 platform_down, not 500),
F051 (every setup and accounts route is 503 when posting setup is off) and F072 (new keys revoke the old token with
the old keys)."""

from __future__ import annotations

import functools
from typing import Any
from urllib.parse import parse_qs

import pytest

from clipfactory_api import db
from clipfactory_api.oauth.tokens import SecretsTokenProvider
from clipfactory_api.platforms.base import NetworkError
from clipfactory_api.routes import setup as setup_routes
from conftest import USER, Call
from fakes import FakeHttp, FakeSecretsManager
from test_oauth_state_formats import TIKTOK_ID, TIKTOK_SECRET
from test_setup_routes import PREFIX, connect_account, put_token, save_keys

# --- F012 ----------------------------------------------------------------------------------------------------------

EXPIRED = {"accessToken": "AT", "refreshToken": "RT", "expiresAt": "2026-11-15T11:00:00.000Z"}


def _tiktok_needing_refresh(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", EXPIRED)


@pytest.mark.parametrize("answer", [(503, {}), NetworkError("timeout")])
def test_creator_info_refresh_failure_is_503_try_again(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, answer: Any
) -> None:
    _tiktok_needing_refresh(call, store, secrets_client)
    http.answers.append(answer)  # TikTok's token endpoint does not answer
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert status == 503
    assert body["error"]["code"] == "platform_down"
    assert body["error"]["message"] == "TikTok did not answer. Try again in a minute."


def test_creator_info_busy_refresh_lease_is_503_try_again(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    _tiktok_needing_refresh(call, store, secrets_client)
    store.update(db.user_pk(USER), "ACCOUNT#tiktok", {"refreshLeaseUntil": "2099-01-01T00:00:00.000Z"})
    monkeypatch.setattr(
        setup_routes, "SecretsTokenProvider", functools.partial(SecretsTokenProvider, sleep=lambda _: None)
    )
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert status == 503
    assert body["error"]["code"] == "platform_down"


def test_creator_info_answer_failure_is_503(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.append(NetworkError("timeout"))
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert (status, body["error"]["code"]) == (503, "platform_down")


@pytest.mark.parametrize(
    "answer",
    [(500, {"error": {"code": "internal_error"}}), (502, {}), (429, {"error": {"code": "rate_limit_exceeded"}})],
)
def test_creator_info_tiktok_slow_or_down_answer_is_503_try_again(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, answer: Any
) -> None:
    """TikTok answered, but with a 5xx or "slow down": a try-again (503), never a 409 without a next step."""
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.append(answer)
    status, body = call("GET", "/v1/accounts/tiktok/creator-info")
    assert status == 503
    assert body["error"] == {"code": "platform_down", "message": "TikTok did not answer. Try again in a minute."}
    assert store.get(db.user_pk(USER), "ACCOUNT#tiktok")["status"] == "connected"  # type: ignore[index]


# --- F051 ----------------------------------------------------------------------------------------------------------

SETUP_ROUTES = [
    ("GET", "/v1/setup", None),
    ("GET", "/v1/setup/tiktok", None),
    ("PATCH", "/v1/setup/tiktok", {"step": "a1", "done": True}),
    ("PUT", "/v1/setup/tiktok/keys", {"clientId": TIKTOK_ID, "clientSecret": TIKTOK_SECRET}),
    ("DELETE", "/v1/setup/tiktok/keys", None),
    ("POST", "/v1/setup/tiktok/check", None),
    ("POST", "/v1/setup/tiktok/verification-file", {"filename": "tiktokABCD.txt", "content": "tiktok-developers"}),
    ("DELETE", "/v1/setup/tiktok/verification-file/tiktokABCD.txt", None),
    ("GET", "/v1/accounts", None),
    ("GET", "/v1/accounts/tiktok/creator-info", None),
    ("POST", "/v1/accounts/tiktok/connect", None),
    ("POST", "/v1/accounts/facebook/choose", {"accountId": "1"}),
    ("DELETE", "/v1/accounts/tiktok", None),
]


@pytest.mark.parametrize(("method", "path", "body"), SETUP_ROUTES)
def test_every_setup_route_is_503_when_posting_setup_is_off(
    call: Call, app: Any, method: str, path: str, body: Any
) -> None:
    app.oauth = None  # production: no OAUTH_STATE_SECRET / HOOKS_URL / APP_URL means no web files either
    app.web_files = None
    status, answer = call(method, path, body) if body is not None else call(method, path)
    assert status == 503, path
    assert answer["error"] == {"code": "unavailable", "message": "Posting setup is not switched on for this app yet."}


# --- F072 ----------------------------------------------------------------------------------------------------------

NEW_TIKTOK_ID = "awzyxwvu0987654321"


def test_new_keys_revoke_the_old_token_with_the_old_keys(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok")
    put_token(secrets_client, "tiktok", {"accessToken": "AT-OLD", "expiresAt": "2026-11-15T14:00:00.000Z"})
    http.answers.append((200, {}))  # revoke
    status, body = save_keys(call, "tiktok", clientId=NEW_TIKTOK_ID)
    assert status == 200
    assert body["setup"]["account"]["reason"] == "keys_changed"
    (revoke,) = http.calls
    sent = parse_qs(revoke.body.decode())
    assert sent["client_key"] == [TIKTOK_ID]  # the app the token was issued to, not the new one
    assert sent["token"] == ["AT-OLD"]
    assert secrets_client.json(f"{PREFIX}tiktok/app")["clientId"] == NEW_TIKTOK_ID
    assert f"{PREFIX}tiktok/token" not in secrets_client.values
