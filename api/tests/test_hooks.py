"""cf-prod-hooks: the REST API for platform webhooks and OAuth callbacks (docs/CONTRACTS.md §14.3)."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any

import pytest

from clipfactory_api import hooks
from conftest import NOW, Clock
from fakes import FakeSSM, FakeTable

APP_URL = "https://d111111abcdef8.cloudfront.net"


@pytest.fixture
def ssm() -> FakeSSM:
    return FakeSSM("verify-me-123")


@pytest.fixture
def deps(store: Any, ssm: FakeSSM) -> hooks.HooksDeps:
    return hooks.HooksDeps(
        store=store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(ssm, "/cf-prod/hooks/verify-token"),
        clock=Clock(),
    )


def _event(
    method: str,
    resource: str,
    platform: str,
    *,
    query: dict[str, str] | None = None,
    body: str | None = None,
    b64: bool = False,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "httpMethod": method,
        "resource": resource,
        "path": resource.replace("{platform}", platform),
        "pathParameters": {"platform": platform},
        "queryStringParameters": query,
        "headers": headers or {"Content-Type": "application/json", "User-Agent": "facebookexternalua"},
        "body": body,
        "isBase64Encoded": b64,
        "requestContext": {"requestId": "rest-1", "stage": "v1"},
    }


def _body(out: Mapping[str, Any]) -> Any:
    return json.loads(out["body"]) if out["body"] else None


@pytest.mark.parametrize("platform", ["instagram", "facebook"])
def test_meta_challenge_ok(deps: hooks.HooksDeps, ssm: FakeSSM, platform: str) -> None:
    query = {"hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "1158201444"}
    out = hooks.handle(_event("GET", "/hooks/{platform}", platform, query=query), deps)
    assert out["statusCode"] == 200
    assert out["body"] == "1158201444"
    assert out["headers"]["content-type"].startswith("text/plain")
    assert out["headers"]["x-content-type-options"] == "nosniff"
    assert ssm.calls == [{"Name": "/cf-prod/hooks/verify-token", "WithDecryption": True}]


@pytest.mark.parametrize(
    "query",
    [
        {"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1"},
        {"hub.mode": "unsubscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "1"},
        {"hub.mode": "subscribe", "hub.challenge": "1"},
        {"hub.mode": "subscribe", "hub.verify_token": "verify-me-123"},
        {"hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "x" * 600},
        {},
    ],
)
def test_meta_challenge_forbidden(deps: hooks.HooksDeps, query: dict[str, str]) -> None:
    out = hooks.handle(_event("GET", "/hooks/{platform}", "facebook", query=query or None), deps)
    assert out["statusCode"] == 403
    assert _body(out)["error"]["code"] == "forbidden"


def test_verify_token_is_cached_for_five_minutes(ssm: FakeSSM) -> None:
    clock = {"now": 1000.0}
    read = hooks.ssm_token_reader(ssm, "/p", now=lambda: clock["now"])
    read()
    clock["now"] += 299
    read()
    assert len(ssm.calls) == 1
    clock["now"] += 2
    read()
    assert len(ssm.calls) == 2


def test_youtube_challenge(deps: hooks.HooksDeps) -> None:
    query = {
        "hub.mode": "subscribe",
        "hub.topic": "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC123",
        "hub.challenge": "abc123",
        "hub.lease_seconds": "432000",
    }
    out = hooks.handle(_event("GET", "/hooks/{platform}", "youtube", query=query), deps)
    assert (out["statusCode"], out["body"]) == (200, "abc123")
    query["hub.mode"] = "unsubscribe"
    assert hooks.handle(_event("GET", "/hooks/{platform}", "youtube", query=query), deps)["statusCode"] == 200


@pytest.mark.parametrize(
    "query",
    [
        {"hub.mode": "subscribe", "hub.topic": "https://evil.example/feed", "hub.challenge": "a"},
        {"hub.mode": "publish", "hub.topic": "https://www.youtube.com/xml/feeds/videos.xml", "hub.challenge": "a"},
        {"hub.mode": "subscribe", "hub.topic": "https://www.youtube.com/xml/feeds/videos.xml"},
    ],
)
def test_youtube_bad_challenge(deps: hooks.HooksDeps, query: dict[str, str]) -> None:
    out = hooks.handle(_event("GET", "/hooks/{platform}", "youtube", query=query), deps)
    assert out["statusCode"] == 400
    assert _body(out)["error"]["code"] == "bad_request"


@pytest.mark.parametrize("platform", ["tiktok", "x"])
def test_tiktok_and_x_verification_not_implemented(deps: hooks.HooksDeps, platform: str) -> None:
    out = hooks.handle(_event("GET", "/hooks/{platform}", platform, query={"crc_token": "x"}), deps)
    assert out["statusCode"] == 501
    assert _body(out)["error"]["code"] == "not_implemented"


def test_post_stores_a_hook_item(deps: hooks.HooksDeps, table: FakeTable) -> None:
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "facebookexternalua",
        "X-Hub-Signature-256": "sha256=abc",
        "Authorization": "never stored",
        "Cookie": "never stored",
    }
    raw = json.dumps({"object": "instagram", "entry": [{"id": "1"}]})
    out = hooks.handle(_event("POST", "/hooks/{platform}", "instagram", body=raw, headers=headers), deps)
    assert out["statusCode"] == 200
    assert _body(out) == {"ok": True}
    ((key, item),) = table.items.items()
    assert key[0] == "HOOK#instagram"
    assert key[1].startswith("HOOK#")
    assert item["type"] == "hook"
    assert item["platform"] == "instagram"
    assert item["receivedAt"] == "2026-11-15T12:00:00.000Z"
    assert item["headers"] == {
        "content-type": "application/json",
        "user-agent": "facebookexternalua",
        "x-hub-signature-256": "sha256=abc",
    }
    assert item["body"] == raw
    assert item["bodyEncoding"] == "text"
    assert item["signature"] == "unverified"
    assert item["ttl"] == int(NOW.timestamp()) + 14 * 86400


def test_post_keeps_a_base64_body_as_sent(deps: hooks.HooksDeps, table: FakeTable) -> None:
    encoded = base64.b64encode(b"\x00\x01binary").decode()
    out = hooks.handle(_event("POST", "/hooks/{platform}", "youtube", body=encoded, b64=True), deps)
    assert out["statusCode"] == 200
    (item,) = table.items.values()
    assert (item["body"], item["bodyEncoding"]) == (encoded, "base64")


def test_post_over_256_kb_is_too_large(deps: hooks.HooksDeps, table: FakeTable) -> None:
    out = hooks.handle(_event("POST", "/hooks/{platform}", "facebook", body="x" * (256 * 1024 + 1)), deps)
    assert out["statusCode"] == 413
    assert _body(out)["error"]["code"] == "too_large"
    assert table.items == {}
    ok = hooks.handle(_event("POST", "/hooks/{platform}", "facebook", body="x" * (256 * 1024)), deps)
    assert ok["statusCode"] == 200


def test_post_with_an_invalid_signature_is_refused(deps: hooks.HooksDeps, table: FakeTable) -> None:
    deps.verify = lambda platform, headers, body: "invalid"
    out = hooks.handle(_event("POST", "/hooks/{platform}", "facebook", body="{}"), deps)
    assert out["statusCode"] == 401
    assert _body(out)["error"]["code"] == "unauthorized"
    assert table.items == {}


def test_phase_one_signatures_are_unverified() -> None:
    for platform in ("youtube", "instagram", "facebook", "tiktok", "x"):
        assert hooks.verify_signature(platform, {"x-hub-signature-256": "sha256=0"}, b"{}") == "unverified"


@pytest.mark.parametrize("platform", ["youtube", "instagram", "facebook", "tiktok", "x"])
def test_oauth_callback_without_secrets_redirects_with_error(deps: hooks.HooksDeps, platform: str) -> None:
    query = {"code": "SECRET-CODE", "state": "SECRET-STATE"}
    out = hooks.handle(_event("GET", "/oauth/{platform}/callback", platform, query=query), deps)
    assert out["statusCode"] == 302
    assert out["headers"]["location"] == f"{APP_URL}/settings/posting/setup/{platform}?result=error"
    assert out["headers"]["cache-control"] == "no-store"
    assert out["headers"]["referrer-policy"] == "no-referrer"


def test_unknown_platform_is_404(deps: hooks.HooksDeps, table: FakeTable) -> None:
    for method, resource in (
        ("GET", "/hooks/{platform}"),
        ("POST", "/hooks/{platform}"),
        ("GET", "/oauth/{platform}/callback"),
    ):
        out = hooks.handle(_event(method, resource, "myspace", body="{}"), deps)
        assert out["statusCode"] == 404
        assert _body(out)["error"]["code"] == "not_found"
    assert table.items == {}


def test_query_strings_and_bodies_are_never_logged(deps: hooks.HooksDeps, capsys: pytest.CaptureFixture[str]) -> None:
    hooks.handle(
        _event("GET", "/oauth/{platform}/callback", "youtube", query={"code": "SECRET-CODE", "state": "S-STATE"}), deps
    )
    hooks.handle(
        _event(
            "GET",
            "/hooks/{platform}",
            "facebook",
            query={"hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "CH-42"},
        ),
        deps,
    )
    hooks.handle(_event("POST", "/hooks/{platform}", "facebook", body='{"secret":"BODY-SECRET"}'), deps)
    logged = capsys.readouterr().out
    assert logged
    for secret in ("SECRET-CODE", "S-STATE", "verify-me-123", "CH-42", "BODY-SECRET"):
        assert secret not in logged


def test_internal_errors_use_the_error_shape(
    deps: hooks.HooksDeps, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(**_: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(table, "put_item", broken)
    out = hooks.handle(_event("POST", "/hooks/{platform}", "youtube", body="{}"), deps)
    assert out["statusCode"] == 500
    assert _body(out)["error"]["code"] == "internal"


def test_whop_is_served_on_the_oauth_callback_only(deps: hooks.HooksDeps, table: FakeTable) -> None:
    """§40.6: Connect Whop comes back on ``/oauth/whop/callback``; ``/hooks/whop`` does not exist."""
    for method in ("GET", "POST"):
        out = hooks.handle(_event(method, "/hooks/{platform}", "whop", body="{}"), deps)
        assert out["statusCode"] == 404
        assert _body(out)["error"]["code"] == "not_found"
    assert table.items == {}
    out = hooks.handle(_event("GET", "/oauth/{platform}/callback", "whop", query={"code": "C", "state": "S"}), deps)
    assert out["statusCode"] == 302  # without secrets: a fixed Get paid page and a listed code
    assert out["headers"]["location"] == f"{APP_URL}/settings/posting/getpaid/contentrewards?result=whop_error#whop"
    assert out["headers"]["referrer-policy"] == "no-referrer"
    assert "whop" in hooks.HOOK_PLATFORMS
    assert "whop" not in hooks.PLATFORMS


def test_bank_is_served_on_the_oauth_callback_only(deps: hooks.HooksDeps, table: FakeTable) -> None:
    """§40.5.5: BankID comes back on ``/oauth/bank/callback``, always to the public page ``/bank-done``;
    ``/hooks/bank`` does not exist."""
    for method in ("GET", "POST"):
        out = hooks.handle(_event(method, "/hooks/{platform}", "bank", body="{}"), deps)
        assert out["statusCode"] == 404
        assert _body(out)["error"]["code"] == "not_found"
    assert table.items == {}
    out = hooks.handle(_event("GET", "/oauth/{platform}/callback", "bank", query={"code": "C", "state": "S"}), deps)
    assert out["statusCode"] == 302  # without secrets: the public page and a listed code
    assert out["headers"]["location"] == f"{APP_URL}/bank-done?result=bank_error"
    assert out["headers"]["referrer-policy"] == "no-referrer"
    assert out["headers"]["cache-control"] == "no-store"
    assert table.items == {}
    assert "bank" in hooks.HOOK_PLATFORMS
    assert "bank" in hooks.CALLBACK_ONLY
    assert "bank" not in hooks.PLATFORMS
