"""§25.4 "Allow money reading": the money grant merges into the existing connection and never replaces it.

Owner rule: deploys and new features must never reset a connected platform or saved data. So a money grant writes
the token secret and one UpdateItem on the Account, keeps every other Account field (even ones this code does not
know), never touches posts, snapshots, settings, lessons or the setup gates, and writes nothing at all when anything
is off (cancel, a scope missing, another channel, a dead code, an account that is not connected).
"""

from __future__ import annotations

import copy
import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, hooks
from clipfactory_api.oauth import DEFAULT_MONEY_SCOPES, OAuthEnv, callback, setup
from clipfactory_api.oauth.tokens import SecretsTokenProvider
from conftest import APP_URL, USER, Call, Clock
from fakes import FakeHttp, FakeSecretsManager, FakeSSM, FakeTable
from test_oauth_callback import (
    PREFIX,
    SUCCESS,
    TIKTOK_CREATOR,
    TIKTOK_TOKEN,
    TIKTOK_USER,
    YOUTUBE_CHANNELS,
    YOUTUBE_TOKEN,
    YT_SCOPES,
    back,
    start,
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


MONETARY = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
YT_MONEY_TOKEN = {
    **YOUTUBE_TOKEN,
    "access_token": "ya29.MONEY",
    "refresh_token": "1//MONEY",
    "scope": f"{YT_SCOPES} {MONETARY}",
}
TT_MONEY_TOKEN = {
    **TIKTOK_TOKEN,
    "access_token": "act.MONEY",
    "scope": "user.info.basic,video.publish,video.list,user.info.stats",
}


def connect_normally(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, platform: str) -> None:
    signed = start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert back(hooks_deps, platform, {"code": "FIRST", "state": signed}) == "connected"


def money_start(call: Call, platform: str) -> tuple[str, str]:
    status, body = call("POST", f"/v1/accounts/{platform}/connect", {"grant": "money"})
    assert status == 200, body
    url = str(body["authorizeUrl"])
    return url, str(parse_qs(urlsplit(url).query)["state"][0])


def money_back(hooks_deps: hooks.HooksDeps, platform: str, query: dict[str, str]) -> str:
    event = {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "path": f"/oauth/{platform}/callback",
        "pathParameters": {"platform": platform},
        "queryStringParameters": query,
        "headers": {},
        "requestContext": {"requestId": "rest-money", "stage": "v1"},
    }
    out = hooks.handle(event, hooks_deps)
    assert out["statusCode"] == 302
    location = out["headers"]["location"]
    prefix = f"{APP_URL}/settings/posting/money?result="
    assert location.startswith(prefix), location
    result, _, rest = location[len(prefix) :].partition("&")
    assert rest == f"platform={platform}"
    assert result in callback.MONEY_RESULTS
    return result


def seed_owner_data(store: db.Store, platform: str) -> None:
    """Extra Account fields this code knows nothing about, and the owner's other items."""
    pk = db.user_pk(USER)
    store.update(
        pk,
        f"ACCOUNT#{platform}",
        {"someFutureField": {"keep": True}, "moneyScopesMissing": True, "reconnectBy": "2027-01-01T00:00:00.000Z"},
    )
    store.put(
        {
            "pk": pk,
            "sk": "POST#01JZ0000000000000000000001",
            "type": "post",
            "platform": platform,
            "metrics": {"views": 9},
        }
    )
    store.put({"pk": pk, "sk": "STAT#01JZ0000000000000000000001#2026-11-14", "views": 9})
    store.put({"pk": pk, "sk": "SETTINGS", "type": "settings", "clipMin": 3, "earningsRates": {"youtube": 2.5}})
    store.put({"pk": pk, "sk": "LESSON#01JZ0000000000000000000002", "type": "lesson", "text": "Hooks win"})
    setup.set_gate(store, USER, platform, "published_app", state="ok", now=hooks_deps_now())


def hooks_deps_now() -> Any:
    from conftest import NOW

    return NOW


def snapshot(table: FakeTable) -> dict[tuple[str, str], Any]:
    return {(i["pk"], i["sk"]): copy.deepcopy(i) for i in table.all() if not str(i["pk"]).startswith("OAUTH#")}


# --- Connect never changes -------------------------------------------------------------------------------------------


def test_normal_connect_asks_for_exactly_the_old_scopes(call: Call) -> None:
    from test_oauth_state_formats import GOOD

    for platform, expected in (
        ("youtube", YT_SCOPES),
        ("tiktok", "user.info.basic,video.publish,video.list"),
    ):
        assert call("PUT", f"/v1/setup/{platform}/keys", GOOD[platform])[0] == 200
        _, body = call("POST", f"/v1/accounts/{platform}/connect")
        query = parse_qs(urlsplit(body["authorizeUrl"]).query)
        assert query["scope"] == [expected]
        assert MONETARY not in body["authorizeUrl"]
        assert "user.info.stats" not in body["authorizeUrl"]


def test_money_grant_needs_a_connection_and_a_platform_that_shares_money(call: Call) -> None:
    from test_oauth_state_formats import GOOD

    for platform in ("youtube", "instagram"):
        assert call("PUT", f"/v1/setup/{platform}/keys", GOOD[platform])[0] == 200
    status, body = call("POST", "/v1/accounts/youtube/connect", {"grant": "money"})
    assert status == 409
    assert "Connect YouTube first" in body["error"]["message"]
    status, body = call("POST", "/v1/accounts/instagram/connect", {"grant": "money"})
    assert status == 400
    status, _ = call("POST", "/v1/accounts/youtube/connect", {"grant": "everything"})
    assert status == 400


# --- YouTube --------------------------------------------------------------------------------------------------------


def test_youtube_money_grant_merges_into_the_connection(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
) -> None:
    connect_normally(call, hooks_deps, http, "youtube")
    seed_owner_data(store, "youtube")
    before = snapshot(table)
    url, signed = money_start(call, "youtube")
    query = parse_qs(urlsplit(url).query)
    assert query["scope"] == [f"{YT_SCOPES} {MONETARY}"]
    assert query["include_granted_scopes"] == ["true"]
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    http.answers.extend([(200, YT_MONEY_TOKEN), (200, YOUTUBE_CHANNELS)])
    assert money_back(hooks_deps, "youtube", {"code": "MONEY-CODE", "state": signed}) == "money_allowed"

    after = snapshot(table)
    key = (db.user_pk(USER), "ACCOUNT#youtube")
    old, new = before.pop(key), after.pop(key)
    assert after == before  # posts, snapshots, settings, lessons, the setup item and its gates: untouched
    assert new["someFutureField"] == {"keep": True}
    assert new["reconnectBy"] == old["reconnectBy"]
    assert new["status"] == "connected"
    assert new["connectedAt"] == old["connectedAt"]
    assert "moneyScopesMissing" not in new
    assert MONETARY in new["scopes"]
    assert set(old["scopes"]) <= set(new["scopes"])
    assert secrets_client.json(f"{PREFIX}youtube/token")["accessToken"] == "ya29.MONEY"


@pytest.mark.parametrize(
    ("answers", "query", "expected"),
    [
        ([], {"error": "access_denied"}, "money_denied"),
        ([(200, YOUTUBE_TOKEN), (200, YOUTUBE_CHANNELS)], {"code": "C"}, "money_missing"),  # the box was not ticked
        (
            [(200, YT_MONEY_TOKEN), (200, {"items": [{"id": "UC999", "snippet": {"title": "Other"}}]})],
            {"code": "C"},
            "money_wrong_account",
        ),
        ([(400, {"error": "invalid_grant"})], {"code": "C"}, "money_error"),
        ([(200, {**YT_MONEY_TOKEN, "scope": MONETARY})], {"code": "C"}, "money_missing"),  # Connect scopes gone
    ],
)
def test_youtube_money_grant_writes_nothing_when_anything_is_off(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    answers: list[Any],
    query: dict[str, str],
    expected: str,
) -> None:
    connect_normally(call, hooks_deps, http, "youtube")
    seed_owner_data(store, "youtube")
    before = snapshot(table)
    token_before = secrets_client.values[f"{PREFIX}youtube/token"]
    _, signed = money_start(call, "youtube")
    http.answers.extend(answers)
    assert money_back(hooks_deps, "youtube", {**query, "state": signed}) == expected
    assert snapshot(table) == before
    assert secrets_client.values[f"{PREFIX}youtube/token"] == token_before


def test_a_money_grant_after_a_disconnect_changes_nothing(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
) -> None:
    connect_normally(call, hooks_deps, http, "youtube")
    _, signed = money_start(call, "youtube")
    store.update(db.user_pk(USER), "ACCOUNT#youtube", {"status": "needs_reconnect"})
    before = snapshot(table)
    http.answers.extend([(200, YT_MONEY_TOKEN), (200, YOUTUBE_CHANNELS)])
    assert money_back(hooks_deps, "youtube", {"code": "C", "state": signed}) == "money_not_connected"
    assert snapshot(table) == before


def test_an_expired_money_state_goes_to_the_setup_page_like_any_other(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
) -> None:
    connect_normally(call, hooks_deps, http, "youtube")
    money_start(call, "youtube")
    assert back(hooks_deps, "youtube", {"code": "C", "state": "not-a-state"}) == "expired"


# --- TikTok ---------------------------------------------------------------------------------------------------------


def test_tiktok_follower_grant_merges_and_a_refusal_changes_nothing(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
) -> None:
    connect_normally(call, hooks_deps, http, "tiktok")
    seed_owner_data(store, "tiktok")
    before = snapshot(table)
    token_before = secrets_client.values[f"{PREFIX}tiktok/token"]

    # TikTok has not approved user.info.stats yet: the authorize step comes back with an error.
    url, signed = money_start(call, "tiktok")
    assert parse_qs(urlsplit(url).query)["scope"] == ["user.info.basic,video.publish,video.list,user.info.stats"]
    assert money_back(hooks_deps, "tiktok", {"error": "invalid_scope", "state": signed}) == "money_missing"
    assert snapshot(table) == before
    assert secrets_client.values[f"{PREFIX}tiktok/token"] == token_before

    # Approved: the new token (with every old scope too) is merged in.
    _, signed = money_start(call, "tiktok")
    http.answers.extend([(200, TT_MONEY_TOKEN), (200, TIKTOK_USER), (200, TIKTOK_CREATOR)])
    assert money_back(hooks_deps, "tiktok", {"code": "C", "state": signed}) == "money_allowed"
    acct = store.get(db.user_pk(USER), "ACCOUNT#tiktok")
    assert acct is not None
    assert "user.info.stats" in acct["scopes"]
    assert acct["someFutureField"] == {"keep": True}
    assert json.loads(secrets_client.values[f"{PREFIX}tiktok/token"])["accessToken"] == "act.MONEY"


def test_the_money_scopes_are_the_config_ones() -> None:
    from clipfactory_api.oauth import money_scopes_from_config

    assert money_scopes_from_config() == DEFAULT_MONEY_SCOPES


# --- the shared token manager: one rotation, never two ------------------------------------------------------------


def test_two_refreshers_rotate_a_tiktok_token_once(
    store: db.Store, oauth_env: OAuthEnv, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    """cf-prod-money and cf-prod-stats share SecretsTokenProvider. While the stats run is in the middle of rotating
    TikTok's refresh token (it holds the lease), the money run never refreshes with the old one: it waits and gives
    up politely (the next run reads the new token). Exactly one rotation happens."""
    from clipfactory_api.platforms.base import RetryablePublishError
    from test_oauth_state_formats import GOOD

    secrets_client.values[f"{PREFIX}tiktok/app"] = json.dumps({**GOOD["tiktok"], "userId": USER})
    secrets_client.values[f"{PREFIX}tiktok/token"] = json.dumps(
        {"accessToken": "OLD", "expiresAt": "2026-11-15T12:03:00.000Z", "refreshToken": "R1"}
    )
    account = setup.put_account(store, USER, "tiktok", "connected", now=hooks_deps_now(), fields={"handle": "@me"})
    money = SecretsTokenProvider(store, oauth_env, sleep=lambda _s: None)
    stats = SecretsTokenProvider(store, oauth_env, sleep=lambda _s: None)
    money_outcome: list[str] = []
    rotated = {"access_token": "NEW", "expires_in": 86400, "refresh_token": "R2", "refresh_expires_in": 31_536_000}

    def platform(request: Any) -> Any:
        if not money_outcome:  # the money run starts while stats waits for TikTok's answer
            try:
                money_outcome.append(money("tiktok", account))
            except RetryablePublishError:
                money_outcome.append("waited")
        http.answers.append((200, rotated))
        return http(request)

    oauth_env.http = platform
    assert stats("tiktok", account) == "NEW"
    assert money_outcome == ["waited"]
    assert len([c for c in http.calls if "oauth/token" in c.url]) == 1
    assert json.loads(secrets_client.values[f"{PREFIX}tiktok/token"])["refreshToken"] == "R2"
    assert money("tiktok", account) == "NEW"  # the next money run uses the rotated token, no second rotation
    assert len([c for c in http.calls if "oauth/token" in c.url]) == 1
