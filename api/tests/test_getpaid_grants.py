"""Get paid's two reading connections (docs/CONTRACTS.md §40.6, tests §40.8 "api (K)"): "Allow payment reading"
(YouTube's AdSense, its own token) and "Connect Whop" (Whop's public PKCE sign-in), through the real callback.

Owner rule: a new connection must never reset a connected platform or saved data. So the AdSense grant never touches
``ACCOUNT#youtube``, the YouTube token, ``SETUP#`` or ``MONEYSTATE#``, and anything short of a clean success writes
nothing at all.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, hooks
from clipfactory_api.app import App
from clipfactory_api.getpaid import grants
from clipfactory_api.oauth import OAuthEnv, callback, providers, state
from clipfactory_api.platforms.base import HttpRequest, HttpResponse
from conftest import APP_URL, HOOKS_URL, STATE_KEY, USER, Call, Clock
from cr_support import FakeCR, make_deps
from fakes import FakeHttp, FakeSecretsManager, FakeSSM, FakeTable
from test_oauth_state_formats import GOOD

PK = db.user_pk(USER)
ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly"
GOOGLE_TOKEN = {
    "access_token": "ya29.ADSENSE",
    "expires_in": 3599,
    "refresh_token": "1//ADSENSE-REFRESH",
    "scope": ADSENSE_SCOPE,
    "token_type": "Bearer",
}
ACCOUNTS = {
    "accounts": [
        {"name": "accounts/pub-1234567890123456", "displayName": "Main", "state": "READY"},
        {"name": "accounts/pub-6543210987654321", "displayName": "Second", "state": "READY"},
    ]
}
API_OFF = {
    "error": {
        "code": 403,
        "status": "PERMISSION_DENIED",
        "errors": [{"reason": "accessNotConfigured"}],
    }
}
SERVICE_DISABLED = {
    "error": {
        "code": 403,
        "status": "PERMISSION_DENIED",
        "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "SERVICE_DISABLED"}],
    }
}
WHOP_META = {
    "issuer": "https://api.whop.com",
    "authorization_endpoint": "https://api.whop.com/oauth/authorize",
    "token_endpoint": "https://api.whop.com/oauth/token",
    "revocation_endpoint": "https://api.whop.com/oauth/revoke",
}
WHOP_TOKEN = {
    "access_token": "whop-ACCESS",
    "refresh_token": "whop-REFRESH",
    "expires_in": 3600,
    "token_type": "Bearer",
    "scope": "openid user:balance:read payout:withdrawal:read payout:destination:read identity:read",
}
WHOP_ME = {"id": "user_abc123", "username": "owner", "name": "Owner"}
WHOP_KEY = "app_AbCdEfGh1234wxyz"
SECRETS_SEEN = ("ya29.ADSENSE", "1//ADSENSE-REFRESH", "whop-ACCESS", "whop-REFRESH", "pub-1234567890123456")


@pytest.fixture(autouse=True)
def _no_cached_metadata() -> Iterator[None]:
    grants.forget_metadata()
    yield
    grants.forget_metadata()


@pytest.fixture
def hooks_deps(store: db.Store, oauth_env: OAuthEnv, clock: Clock) -> hooks.HooksDeps:
    return hooks.HooksDeps(
        store=store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=clock,
        oauth=oauth_env,
    )


@pytest.fixture
def whop_app(app: App, secrets_client: FakeSecretsManager, clock: Clock) -> App:
    app.contentrewards = make_deps(app.store, secrets_client, FakeCR(), clock)
    app.whop_connect = True
    return app


def back(hooks_deps: hooks.HooksDeps, platform: str, query: dict[str, str]) -> tuple[str, str]:
    """The callback through cf-prod-hooks: ``(the page it lands on, the result code)``."""
    event = {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "path": f"/oauth/{platform}/callback",
        "pathParameters": {"platform": platform},
        "queryStringParameters": query,
        "headers": {},
        "requestContext": {"requestId": "rest-getpaid", "stage": "v1"},
    }
    out = hooks.handle(event, hooks_deps)
    assert out["statusCode"] == 302
    assert out["headers"]["referrer-policy"] == "no-referrer"
    parts = urlsplit(out["headers"]["location"])
    assert f"{parts.scheme}://{parts.netloc}" == APP_URL
    return parts.path + (f"#{parts.fragment}" if parts.fragment else ""), parse_qs(parts.query)["result"][0]


def snapshot(table: FakeTable) -> dict[tuple[str, str], Any]:
    return {(i["pk"], i["sk"]): copy.deepcopy(i) for i in table.all() if not str(i["pk"]).startswith("OAUTH#")}


def seed_youtube(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    """A connected YouTube with its own token, setup ticks and money state: none of it may change."""
    store.put(
        {
            "pk": PK,
            "sk": "ACCOUNT#youtube",
            "type": "account",
            "userId": USER,
            "platform": "youtube",
            "status": "connected",
            "accountId": "UC123",
            "scopes": ["https://www.googleapis.com/auth/youtube.upload"],
        }
    )
    store.put({"pk": PK, "sk": "SETUP#youtube", "type": "setup", "platform": "youtube", "stepsDone": {"connect"}})
    store.put({"pk": PK, "sk": "MONEYSTATE#youtube", "type": "moneystate", "state": "in_program"})
    secrets_client.values["cf-prod/platforms/youtube/token"] = json.dumps({"accessToken": "ya29.YOUTUBE"})


def payments_start(call: Call) -> tuple[str, dict[str, list[str]]]:
    assert call("PUT", "/v1/setup/youtube/keys", GOOD["youtube"])[0] == 200
    status, body = call("POST", "/v1/accounts/youtube/connect", {"grant": "payments"})
    assert status == 200, body
    query = parse_qs(urlsplit(body["authorizeUrl"]).query)
    return str(query["state"][0]), query


# --- "Allow payment reading" -------------------------------------------------------------------------------------


def test_the_payments_authorize_url_asks_for_the_adsense_scope_only(call: Call, table: FakeTable) -> None:
    signed, q = payments_start(call)
    assert q["scope"] == [ADSENSE_SCOPE]
    assert "include_granted_scopes" not in q
    assert (q["access_type"], q["prompt"]) == (["offline"], ["consent select_account"])
    assert q["redirect_uri"] == [f"{HOOKS_URL}/oauth/youtube/callback"]  # the same YouTube keys and redirect
    nonce = state.verify(STATE_KEY.encode(), "youtube", signed, 1_794_744_000)
    assert q["code_challenge"] == [state.pkce(STATE_KEY.encode(), nonce)[1]]
    assert q["code_challenge_method"] == ["S256"]
    item = next(i for i in table.all() if str(i["pk"]).startswith("OAUTH#"))
    assert item["grant"] == "payments"


def test_payments_need_saved_keys_not_a_connection(call: Call) -> None:
    status, body = call("POST", "/v1/accounts/youtube/connect", {"grant": "payments"})
    assert (status, body["error"]["message"]) == (409, "Paste your YouTube keys first. Tap Set up YouTube.")
    assert call("PUT", "/v1/setup/youtube/keys", GOOD["youtube"])[0] == 200
    assert call("POST", "/v1/accounts/youtube/connect", {"grant": "payments"})[0] == 200  # YouTube not connected
    assert call("PUT", "/v1/setup/tiktok/keys", GOOD["tiktok"])[0] == 200
    status, _ = call("POST", "/v1/accounts/tiktok/connect", {"grant": "payments"})
    assert status == 400
    status, body = call("POST", "/v1/accounts/youtube/connect", {"grant": "everything"})
    assert (status, body["error"]["message"]) == (400, 'grant can be "money" or "payments".')


def test_allow_payment_reading_saves_its_own_token_and_nothing_else(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_youtube(store, secrets_client)

    def never(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("providers.exchange must never run for a payments grant")

    monkeypatch.setattr(providers, "exchange", never)
    signed, _ = payments_start(call)
    before = snapshot(table)
    youtube_token = secrets_client.values["cf-prod/platforms/youtube/token"]
    http.answers.extend([(200, GOOGLE_TOKEN), (200, ACCOUNTS)])
    page, result = back(hooks_deps, "youtube", {"code": "4/CODE", "state": signed})
    assert (page, result) == ("/settings/posting/getpaid/youtube", "payments_allowed")
    token_call, accounts_call = http.calls
    assert token_call.url == providers.GOOGLE_TOKEN
    form = parse_qs(token_call.body.decode())
    assert form["grant_type"] == ["authorization_code"]
    assert form["code"] == ["4/CODE"]
    assert form["client_id"] == [GOOD["youtube"]["clientId"]]
    assert "code_verifier" in form
    assert form["redirect_uri"] == [f"{HOOKS_URL}/oauth/youtube/callback"]
    assert accounts_call.url == "https://adsense.googleapis.com/v2/accounts"
    assert accounts_call.headers["Authorization"] == "Bearer ya29.ADSENSE"
    secret = secrets_client.json("cf-prod/platforms/adsense/token")
    assert secret == {
        "accessToken": "ya29.ADSENSE",
        "expiresAt": "2026-11-15T12:59:59.000Z",
        "refreshToken": "1//ADSENSE-REFRESH",
        "scope": ADSENSE_SCOPE,
        "clientId": GOOD["youtube"]["clientId"],
        "accounts": ["accounts/pub-1234567890123456", "accounts/pub-6543210987654321"],
    }
    tags = {t["Key"]: t["Value"] for t in secrets_client.tags["cf-prod/platforms/adsense/token"]}
    assert tags == {"app": "cf-prod", "platform": "adsense"}
    after = snapshot(table)
    conn = after.pop((PK, "PAYCONN#adsense"))
    assert {k: conn[k] for k in ("type", "source", "status", "scopes", "lastResult")} == {
        "type": "payconn",
        "source": "adsense",
        "status": "connected",
        "scopes": [ADSENSE_SCOPE],
        "lastResult": "payments_allowed",
    }
    assert conn["accounts"][0] == {"name": "accounts/pub-1234567890123456", "displayName": "Main"}
    assert conn["connectedAt"] == "2026-11-15T12:00:00.000Z"
    assert after == before  # ACCOUNT#youtube, SETUP#youtube and MONEYSTATE#youtube are untouched
    assert secrets_client.values["cf-prod/platforms/youtube/token"] == youtube_token
    status, body = call("GET", "/v1/getpaid")
    assert status == 200
    assert body["connections"]["adsense"] == {
        "source": "adsense",
        "status": "connected",
        "accountName": "Main (…3456)",
        "connectedAt": "2026-11-15T12:00:00.000Z",
        "lastResult": "payments_allowed",
    }
    text = json.dumps(body)
    for value in SECRETS_SEEN:
        assert value not in text


@pytest.mark.parametrize(
    ("query", "answers", "result"),
    [
        ({"error": "access_denied"}, [], "payments_denied"),
        ({"error": "server_error"}, [], "payments_error"),
        ({}, [], "payments_error"),
        ({"code": "4/CODE"}, [(400, {"error": "invalid_grant"})], "payments_error"),  # a dead or reused code
        ({"code": "4/CODE"}, [(200, {**GOOGLE_TOKEN, "scope": "openid"})], "payments_missing"),
        ({"code": "4/CODE"}, [(200, GOOGLE_TOKEN), (200, {})], "payments_no_account"),
        ({"code": "4/CODE"}, [(200, GOOGLE_TOKEN), (403, {"error": {"code": 403}})], "payments_no_account"),
        ({"code": "4/CODE"}, [(200, GOOGLE_TOKEN), (403, API_OFF)], "payments_api_off"),
        ({"code": "4/CODE"}, [(200, GOOGLE_TOKEN), (403, SERVICE_DISABLED)], "payments_api_off"),
        ({"code": "4/CODE"}, [(200, GOOGLE_TOKEN), (500, {})], "payments_error"),
    ],
)
def test_anything_short_of_success_writes_nothing(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    query: dict[str, str],
    answers: list[Any],
    result: str,
) -> None:
    seed_youtube(store, secrets_client)
    signed, _ = payments_start(call)
    before = snapshot(table)
    secrets_before = dict(secrets_client.values)
    http.answers.extend(answers)
    page, found = back(hooks_deps, "youtube", {**query, "state": signed})
    assert (page, found) == ("/settings/posting/getpaid/youtube", result)
    assert snapshot(table) == before
    assert secrets_client.values == secrets_before
    assert result in grants.SENTENCES


def test_only_the_adsense_scope_is_checked(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    signed, _ = payments_start(call)
    http.answers.extend([(200, {**GOOGLE_TOKEN, "scope": f"openid {ADSENSE_SCOPE}"}), (200, ACCOUNTS)])
    assert back(hooks_deps, "youtube", {"code": "4/CODE", "state": signed})[1] == "payments_allowed"


def test_a_reused_or_expired_payments_state_writes_nothing(
    call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, table: FakeTable, clock: Clock
) -> None:
    signed, _ = payments_start(call)
    http.answers.extend([(200, GOOGLE_TOKEN), (200, ACCOUNTS)])
    assert back(hooks_deps, "youtube", {"code": "4/CODE", "state": signed})[1] == "payments_allowed"
    before = snapshot(table)
    page, result = back(hooks_deps, "youtube", {"code": "4/CODE", "state": signed})
    assert (page, result) == ("/settings/posting/setup/youtube", "expired")  # no grant survives a used state
    assert snapshot(table) == before


def test_stop_payment_reading_never_calls_google(
    call: Call,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    store: db.Store,
    secrets_client: FakeSecretsManager,
) -> None:
    seed_youtube(store, secrets_client)
    signed, _ = payments_start(call)
    http.answers.extend([(200, GOOGLE_TOKEN), (200, ACCOUNTS)])
    assert back(hooks_deps, "youtube", {"code": "4/CODE", "state": signed})[1] == "payments_allowed"
    store.put({"pk": PK, "sk": "PAYSTATE#youtube", "type": "paystate", "firstReadDone": True})
    store.put({"pk": PK, "sk": "PAYOUT#youtube#2026-10-23#3456", "type": "payout", "amountText": "kr 1,00 SEK"})
    calls = len(http.calls)
    status, _ = call("DELETE", "/v1/getpaid/connections/adsense")
    assert status == 204
    assert len(http.calls) == calls  # never Google's revoke: it would end the YouTube connection too
    assert all(providers.GOOGLE_REVOKE not in c.url for c in http.calls)
    assert "cf-prod/platforms/adsense/token" not in secrets_client.values
    assert "cf-prod/platforms/youtube/token" in secrets_client.values
    conn = store.get(PK, "PAYCONN#adsense")
    assert conn is not None
    assert conn["status"] == "not_connected"
    assert conn["stoppedAt"] == "2026-11-15T12:00:00.000Z"
    assert "connectedAt" not in conn
    assert store.get(PK, "PAYSTATE#youtube") is not None  # records of real money stay
    assert store.get(PK, "PAYOUT#youtube#2026-10-23#3456") is not None
    assert (store.get(PK, "ACCOUNT#youtube") or {})["status"] == "connected"


# --- "Connect Whop" -------------------------------------------------------------------------------------------------


class WhopHttp(FakeHttp):
    """Whop's fakes refuse a call without ``Api-Version-Date: 2026-11-20``."""

    def __call__(self, request: Any) -> Any:
        if "whop.com" in request.url and request.headers.get("Api-Version-Date") != "2026-11-20":
            self.calls.append(request)
            return HttpResponse(400, {}, b'{"error":"missing Api-Version-Date"}')
        return super().__call__(request)


@pytest.fixture
def whop_http(oauth_env: OAuthEnv) -> WhopHttp:
    fake = WhopHttp()
    oauth_env.http = fake
    return fake


def whop_start(call: Call, whop_http: WhopHttp) -> tuple[str, dict[str, list[str]]]:
    status, body = call("PUT", "/v1/getpaid/whop/key", {"clientId": WHOP_KEY})
    assert status == 200, body
    whop_http.answers.append((200, WHOP_META))
    status, body = call("POST", "/v1/getpaid/whop/connect")
    assert status == 200, body
    url = urlsplit(body["authorizeUrl"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://api.whop.com/oauth/authorize"
    query = parse_qs(url.query)
    return str(query["state"][0]), query


def test_connect_whop_authorize_url(call: Call, whop_app: App, whop_http: WhopHttp, table: FakeTable) -> None:
    signed, q = whop_start(call, whop_http)
    assert q["client_id"] == [WHOP_KEY]
    assert q["response_type"] == ["code"]
    assert q["redirect_uri"] == [f"{HOOKS_URL}/oauth/whop/callback"]
    assert q["scope"] == ["openid user:balance:read payout:withdrawal:read payout:destination:read identity:read"]
    assert "withdraw_funds" not in json.dumps(q)
    assert "admin" not in json.dumps(q)
    nonce = state.verify(STATE_KEY.encode(), "whop", signed, 1_794_744_000)
    assert q["code_challenge"] == [state.pkce(STATE_KEY.encode(), nonce)[1]]
    assert q["code_challenge_method"] == ["S256"]
    item = next(i for i in table.all() if str(i["pk"]).startswith("OAUTH#"))
    assert (item["platform"], item["redirectUri"]) == ("whop", f"{HOOKS_URL}/oauth/whop/callback")
    calls = len(whop_http.calls)
    assert call("POST", "/v1/getpaid/whop/connect")[0] == 200  # the metadata is kept for a day
    assert len(whop_http.calls) == calls


def test_the_whop_grant_is_a_public_pkce_exchange(
    call: Call,
    whop_app: App,
    whop_http: WhopHttp,
    hooks_deps: hooks.HooksDeps,
    store: db.Store,
    secrets_client: FakeSecretsManager,
) -> None:
    signed, _ = whop_start(call, whop_http)
    grants.forget_metadata()
    whop_http.answers.extend([(200, WHOP_META), (200, WHOP_TOKEN), (200, WHOP_ME)])
    page, result = back(hooks_deps, "whop", {"code": "whop-code", "state": signed})
    assert (page, result) == ("/settings/posting/getpaid/contentrewards#whop", "whop_connected")
    meta, token_call, me_call = whop_http.calls[-3:]
    assert meta.url == grants.WHOP_METADATA
    assert token_call.url == "https://api.whop.com/oauth/token"
    form = parse_qs(token_call.body.decode())
    assert form["grant_type"] == ["authorization_code"]
    assert form["client_id"] == [WHOP_KEY]
    assert "code_verifier" in form
    assert "client_secret" not in form  # a public client: no secret
    assert me_call.url == "https://api.whop.com/api/v1/users/me"
    assert me_call.headers["Authorization"] == "Bearer whop-ACCESS"
    for c in whop_http.calls:
        assert c.headers["Api-Version-Date"] == "2026-11-20"
    secret = secrets_client.json("cf-prod/platforms/whop/token")
    assert secret["accessToken"] == "whop-ACCESS"
    assert secret["whopUserId"] == "user_abc123"
    conn = store.get(PK, "PAYCONN#whop")
    assert conn is not None
    assert {k: conn[k] for k in ("status", "accountId", "accountName", "lastResult")} == {
        "status": "connected",
        "accountId": "user_abc123",
        "accountName": "@owner",
        "lastResult": "whop_connected",
    }
    assert conn["tokenVersionId"]
    _status, body = call("GET", "/v1/getpaid")
    whop_conn = body["connections"]["whop"]
    assert (whop_conn["status"], whop_conn["accountName"]) == ("connected", "@owner")
    assert grants.SENTENCES["whop_connected"].format(name="@owner") == (
        "Clip Factory can see your Whop payouts now (@owner)."
    )
    for value in SECRETS_SEEN:
        assert value not in json.dumps(body)
    assert "tokenVersionId" not in json.dumps(body)


@pytest.mark.parametrize(
    ("query", "answers", "result"),
    [
        ({"error": "access_denied"}, [], "whop_denied"),
        ({"error": "temporarily_unavailable"}, [], "whop_error"),
        ({"code": "c"}, [(200, WHOP_META), (200, {**WHOP_TOKEN, "scope": "openid user:balance:read"})], "whop_missing"),
        ({"code": "c"}, [(200, WHOP_META), (400, {"error": "invalid_grant"})], "whop_expired"),
        ({"code": "c"}, [(200, WHOP_META), (502, {})], "whop_error"),
        ({"code": "c"}, [(200, WHOP_META), (200, WHOP_TOKEN), (401, {})], "whop_error"),
        ({"code": "c"}, [(500, {})], "whop_error"),
    ],
)
def test_a_whop_refusal_writes_nothing(
    call: Call,
    whop_app: App,
    whop_http: WhopHttp,
    hooks_deps: hooks.HooksDeps,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    query: dict[str, str],
    answers: list[Any],
    result: str,
) -> None:
    signed, _ = whop_start(call, whop_http)
    grants.forget_metadata()
    before = snapshot(table)
    secrets_before = dict(secrets_client.values)
    whop_http.answers.extend(answers)
    assert back(hooks_deps, "whop", {**query, "state": signed}) == (
        "/settings/posting/getpaid/contentrewards#whop",
        result,
    )
    assert snapshot(table) == before
    assert secrets_client.values == secrets_before


def test_a_whop_call_without_the_version_header_is_refused_by_the_fake(whop_http: WhopHttp) -> None:
    out = whop_http(HttpRequest("GET", grants.WHOP_ME, {}))
    assert out.status == 400


def test_a_reused_whop_state_writes_nothing(
    call: Call, whop_app: App, whop_http: WhopHttp, hooks_deps: hooks.HooksDeps, table: FakeTable
) -> None:
    signed, _ = whop_start(call, whop_http)
    whop_http.answers.extend([(200, WHOP_TOKEN), (200, WHOP_ME)])
    assert back(hooks_deps, "whop", {"code": "c", "state": signed})[1] == "whop_connected"
    before = snapshot(table)
    assert back(hooks_deps, "whop", {"code": "c", "state": signed})[1] == "whop_expired"
    assert back(hooks_deps, "whop", {"code": "c", "state": "v1.forged"})[1] == "whop_expired"
    assert snapshot(table) == before


def test_whop_is_refused_on_hooks_and_is_a_fixed_page_on_the_callback(hooks_deps: hooks.HooksDeps) -> None:
    for method in ("GET", "POST"):
        event = {
            "httpMethod": method,
            "resource": "/hooks/{platform}",
            "path": "/hooks/whop",
            "pathParameters": {"platform": "whop"},
            "headers": {},
            "body": "{}",
            "requestContext": {"requestId": "r"},
        }
        assert hooks.handle(event, hooks_deps)["statusCode"] == 404
    assert callback.location(APP_URL, "whop", "error") == (
        f"{APP_URL}/settings/posting/getpaid/contentrewards?result=whop_error#whop"
    )
    assert callback.location(APP_URL, "whop", "anything") == (
        f"{APP_URL}/settings/posting/getpaid/contentrewards?result=whop_error#whop"
    )
    assert callback.location(APP_URL, "youtube", "payments_allowed") == (
        f"{APP_URL}/settings/posting/getpaid/youtube?result=payments_allowed"
    )


def test_stop_reading_whop_revokes_keeps_the_key_and_the_payouts(
    call: Call,
    whop_app: App,
    whop_http: WhopHttp,
    hooks_deps: hooks.HooksDeps,
    store: db.Store,
    secrets_client: FakeSecretsManager,
) -> None:
    signed, _ = whop_start(call, whop_http)
    whop_http.answers.extend([(200, WHOP_TOKEN), (200, WHOP_ME)])
    assert back(hooks_deps, "whop", {"code": "c", "state": signed})[1] == "whop_connected"
    store.put({"pk": PK, "sk": "PAYOUT#contentrewards#2026-11-10#po_1", "type": "payout", "status": "completed"})
    whop_http.answers.append((200, {}))
    status, _ = call("DELETE", "/v1/getpaid/connections/whop")
    assert status == 204
    revoke = whop_http.calls[-1]
    assert revoke.url == "https://api.whop.com/oauth/revoke"
    assert parse_qs(revoke.body.decode())["token"] == ["whop-REFRESH"]
    assert "cf-prod/platforms/whop/token" not in secrets_client.values
    assert secrets_client.json("cf-prod/platforms/whop/app")["clientId"] == WHOP_KEY
    conn = store.get(PK, "PAYCONN#whop") or {}
    assert conn["status"] == "keys_saved"
    assert store.get(PK, "PAYOUT#contentrewards#2026-11-10#po_1") is not None


def test_a_failing_whop_revoke_still_stops(
    call: Call, whop_app: App, whop_http: WhopHttp, hooks_deps: hooks.HooksDeps, secrets_client: FakeSecretsManager
) -> None:
    signed, _ = whop_start(call, whop_http)
    whop_http.answers.extend([(200, WHOP_TOKEN), (200, WHOP_ME), (500, {})])
    assert back(hooks_deps, "whop", {"code": "c", "state": signed})[1] == "whop_connected"
    assert call("DELETE", "/v1/getpaid/connections/whop")[0] == 204
    assert "cf-prod/platforms/whop/token" not in secrets_client.values


def test_a_new_whop_key_while_connected_ends_the_old_sign_in(
    call: Call,
    whop_app: App,
    whop_http: WhopHttp,
    hooks_deps: hooks.HooksDeps,
    store: db.Store,
    secrets_client: FakeSecretsManager,
) -> None:
    signed, _ = whop_start(call, whop_http)
    whop_http.answers.extend([(200, WHOP_TOKEN), (200, WHOP_ME)])
    assert back(hooks_deps, "whop", {"code": "c", "state": signed})[1] == "whop_connected"
    status, body = call("PUT", "/v1/getpaid/whop/key", {"clientId": WHOP_KEY})  # the same key: still connected
    assert body["connections"]["whop"]["status"] == "connected"
    status, body = call("PUT", "/v1/getpaid/whop/key", {"clientId": "app_Another1234"})
    assert status == 200
    assert body["connections"]["whop"]["status"] == "keys_saved"
    assert body["connections"]["whop"]["reason"] == "keys_changed"
    assert body["connections"]["whop"]["keyHint"] == "app_An…1234"
    assert "cf-prod/platforms/whop/token" not in secrets_client.values
