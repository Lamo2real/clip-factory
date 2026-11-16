"""SecretsTokenProvider: refreshes, rotation, the lease and dead tokens (docs/CONTRACTS.md §17.6)."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs

import pytest

from clipfactory_api import db
from clipfactory_api.oauth import OAuthEnv, setup
from clipfactory_api.oauth.tokens import ReconnectNeededError, SecretsTokenProvider
from clipfactory_api.platforms import NotConnectedError
from clipfactory_api.platforms.base import RetryablePublishError
from conftest import NOW, USER
from fakes import FakeHttp, FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD

PREFIX = "cf-prod/platforms/"
SOON = "2026-11-15T12:03:00.000Z"  # inside the 5-minute margin
LATER = "2026-11-15T14:00:00.000Z"


def seed(store: db.Store, secrets_client: FakeSecretsManager, platform: str, token: dict[str, Any]) -> dict[str, Any]:
    secrets_client.values[f"{PREFIX}{platform}/app"] = json.dumps({**GOOD[platform], "userId": USER})
    secrets_client.values[f"{PREFIX}{platform}/token"] = json.dumps(token)
    return setup.put_account(store, USER, platform, "connected", now=NOW, fields={"handle": "@me"})


@pytest.fixture
def provider(store: db.Store, oauth_env: OAuthEnv) -> SecretsTokenProvider:
    return SecretsTokenProvider(store, oauth_env, sleep=lambda _s: None)


def test_a_fresh_token_is_used_as_is(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "youtube", {"accessToken": "AT", "expiresAt": LATER, "refreshToken": "RT"})
    assert provider("youtube", account) == "AT"
    creds = provider.credentials("youtube", account)
    assert creds.app.client_id == GOOD["youtube"]["clientId"]
    assert http.calls == []


def test_no_token_is_not_connected(provider: SecretsTokenProvider, store: db.Store) -> None:
    with pytest.raises(NotConnectedError):
        provider("x", {"pk": db.user_pk(USER), "sk": "ACCOUNT#x", "userId": USER, "platform": "x"})


def test_facebook_uses_the_page_token(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    account = seed(store, secrets_client, "facebook", {"pageAccessToken": "PAGE", "pageId": "p1"})
    assert provider("facebook", account) == "PAGE"


def test_instagram_uses_the_page_token_and_never_refreshes(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    token = {"pageAccessToken": "IG-PAGE", "pageId": "p1", "igUserId": "1", "expiresAt": SOON}
    account = seed(store, secrets_client, "instagram", token)
    assert provider("instagram", account) == "IG-PAGE"
    assert http.calls == []


def test_google_refresh_keeps_the_refresh_token(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "youtube", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "RT"})
    http.answers.append((200, {"access_token": "NEW", "expires_in": 3599, "scope": "s"}))
    assert provider("youtube", account) == "NEW"
    sent = parse_qs(http.calls[0].body.decode())
    assert sent["grant_type"] == ["refresh_token"]
    assert sent["refresh_token"] == ["RT"]
    stored = secrets_client.json(f"{PREFIX}youtube/token")
    assert (stored["accessToken"], stored["refreshToken"], stored["expiresAt"]) == (
        "NEW",
        "RT",
        "2026-11-15T12:59:59.000Z",
    )


@pytest.mark.parametrize("platform", ["tiktok", "x"])
def test_rotation_writes_the_new_secret_before_the_token_is_used(
    provider: SecretsTokenProvider,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    platform: str,
) -> None:
    account = seed(store, secrets_client, platform, {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    answer: dict[str, Any] = {"access_token": "NEW", "expires_in": 7200, "refresh_token": "R2"}
    if platform == "tiktok":
        answer["refresh_expires_in"] = 31_536_000
    http.answers.append((200, answer))
    order: list[str] = []
    original = secrets_client.put_secret_value

    def put(**kw: Any) -> dict[str, Any]:
        order.append("secret")
        return original(**kw)

    secrets_client.put_secret_value = put  # type: ignore[method-assign,assignment]
    token = provider(platform, account)
    order.append("used")
    assert token == "NEW"
    assert order == ["secret", "used"]
    assert secrets_client.json(f"{PREFIX}{platform}/token")["refreshToken"] == "R2"
    stored = table.raw(db.user_pk(USER), f"ACCOUNT#{platform}")
    assert stored is not None
    assert "refreshLeaseUntil" not in stored  # cleared


def test_a_held_lease_waits_for_the_other_refresher(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "x", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    store.update(db.user_pk(USER), "ACCOUNT#x", {"refreshLeaseUntil": "2026-11-15T12:00:20.000Z"})
    sleeps: list[float] = []

    def other_refresher_finishes(_s: float) -> None:
        sleeps.append(_s)
        secrets_client.values[f"{PREFIX}x/token"] = json.dumps(
            {"accessToken": "THEIRS", "expiresAt": LATER, "refreshToken": "R2"}
        )

    provider.sleep = other_refresher_finishes
    assert provider("x", account) == "THEIRS"
    assert sleeps == [1.0]
    assert http.calls == []  # never a second refresh with the already-rotated R1


def test_a_stuck_lease_gives_up_politely(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "tiktok", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    store.update(db.user_pk(USER), "ACCOUNT#tiktok", {"refreshLeaseUntil": "2026-11-15T12:00:20.000Z"})
    with pytest.raises(RetryablePublishError):
        provider("tiktok", account)
    assert http.calls == []


def test_an_expired_lease_is_taken_over(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "x", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    store.update(db.user_pk(USER), "ACCOUNT#x", {"refreshLeaseUntil": "2026-11-15T11:59:00.000Z"})
    http.answers.append((200, {"access_token": "NEW", "expires_in": 7200, "refresh_token": "R2"}))
    assert provider("x", account) == "NEW"


@pytest.mark.parametrize(
    ("platform", "answer"),
    [
        ("youtube", (400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."})),
        ("tiktok", (400, {"error": "invalid_grant", "error_description": "refresh_token is expired"})),
        ("x", (400, {"error": "invalid_request", "error_description": "Value passed for the token was invalid."})),
    ],
)
def test_a_refused_refresh_token_needs_reconnect(
    provider: SecretsTokenProvider,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    platform: str,
    answer: Any,
) -> None:
    account = seed(store, secrets_client, platform, {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    http.answers.append(answer)
    with pytest.raises(ReconnectNeededError, match=r"Connect .* again in Settings › Posting › Set up posting"):
        provider(platform, account)
    stored = store.get(db.user_pk(USER), f"ACCOUNT#{platform}")
    assert stored is not None
    assert (stored["status"], stored["reason"]) == ("needs_reconnect", "token_dead")


def test_a_platform_outage_is_retryable(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "youtube", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R"})
    http.answers.append((503, {}))
    with pytest.raises(RetryablePublishError):
        provider("youtube", account)
    stored = store.get(db.user_pk(USER), "ACCOUNT#youtube")
    assert stored is not None
    assert stored["status"] == "connected"


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "x"])
@pytest.mark.parametrize("status", [408, 429])
def test_a_busy_or_slow_token_endpoint_is_retryable_not_dead(
    provider: SecretsTokenProvider,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    platform: str,
    status: int,
) -> None:
    account = seed(store, secrets_client, platform, {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    http.answers.append((status, {"error": "rate_limit_exceeded"}))
    with pytest.raises(RetryablePublishError):
        provider(platform, account)
    stored = store.get(db.user_pk(USER), f"ACCOUNT#{platform}")
    assert stored is not None
    assert stored["status"] == "connected"
    assert secrets_client.json(f"cf-prod/platforms/{platform}/token")["refreshToken"] == "R1"


def test_tiktok_refresh_token_ending_soon(
    provider: SecretsTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    account = seed(store, secrets_client, "tiktok", {"accessToken": "OLD", "expiresAt": SOON, "refreshToken": "R1"})
    http.answers.append(
        (200, {"access_token": "NEW", "expires_in": 86400, "refresh_token": "R2", "refresh_expires_in": 3 * 86400})
    )
    provider("tiktok", account)
    stored = store.get(db.user_pk(USER), "ACCOUNT#tiktok")
    assert stored is not None
    assert stored["reason"] == "expires_soon"
    assert stored["reconnectBy"] == "2026-11-11T12:00:00.000Z"
    assert stored["status"] == "connected"


def test_secrets_cache_and_fresh_reads(secrets_client: FakeSecretsManager) -> None:
    from clipfactory_api.oauth.secrets import Secrets

    ticks = [0.0]
    secrets = Secrets(secrets_client, now=lambda: ticks[0])
    secrets_client.values["cf-prod/platforms/x/app"] = json.dumps({"clientId": "a"})
    assert secrets.read("cf-prod/platforms/x/app") == {"clientId": "a"}
    secrets_client.values["cf-prod/platforms/x/app"] = json.dumps({"clientId": "b"})
    assert secrets.read("cf-prod/platforms/x/app") == {"clientId": "a"}  # cached
    assert secrets.read("cf-prod/platforms/x/app", fresh=True) == {"clientId": "b"}
    ticks[0] = 301.0
    secrets_client.values["cf-prod/platforms/x/app"] = json.dumps({"clientId": "c"})
    assert secrets.read("cf-prod/platforms/x/app") == {"clientId": "c"}
    secrets.write("cf-prod/platforms/x/app", {"clientId": "d"}, platform="x")
    assert secrets_client.writes[-1] == ("put", "cf-prod/platforms/x/app")
    secrets.write("cf-prod/platforms/x/token", {"accessToken": "t"}, platform="x")
    assert secrets_client.writes[-1] == ("create", "cf-prod/platforms/x/token")
    secrets.delete("cf-prod/platforms/x/token")
    secrets.delete("cf-prod/platforms/x/token")  # already gone: fine
    assert secrets.read("cf-prod/platforms/x/token") is None
    with pytest.raises(ValueError, match="unknown secret kind"):
        secrets.name("x", "password")
