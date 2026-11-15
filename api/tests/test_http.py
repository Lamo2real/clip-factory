from __future__ import annotations

import base64
import json

from clipfactory_api.app import App
from clipfactory_api.http import MAX_BODY_BYTES, dispatch
from clipfactory_api.routes import ROUTES
from conftest import Call, make_event


def test_health_is_public(call: Call) -> None:
    status, body = call("GET", "/v1/health", sub=None)
    assert status == 200
    assert body == {"ok": True, "version": "abc123"}


def test_protected_route_without_sub_is_unauthorized(call: Call) -> None:
    status, body = call("GET", "/v1/me", sub=None)
    assert status == 401
    assert body["error"]["code"] == "unauthorized"


def test_unknown_path_is_not_found(call: Call) -> None:
    status, body = call("GET", "/v1/nope")
    assert status == 404
    assert body == {"error": {"code": "not_found", "message": "That address does not exist."}}


def test_wrong_method_on_known_path(call: Call) -> None:
    status, body = call("DELETE", "/v1/jobs")
    assert status == 405
    assert body["error"]["code"] == "bad_request"


def test_options_is_harmless(app: App) -> None:
    out = dispatch(make_event("OPTIONS", "/v1/jobs", sub=None), app, ROUTES)
    assert out["statusCode"] == 204
    assert out["body"] == ""


def test_invalid_json(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", raw="{nope")
    assert status == 400
    assert body["error"]["message"] == "The request body is not valid JSON."


def test_body_must_be_object(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", raw="[1, 2]")
    assert status == 400
    assert body["error"]["code"] == "bad_request"


def test_body_too_large(call: Call) -> None:
    status, body = call("PUT", "/v1/settings", raw=json.dumps({"x": "a" * (MAX_BODY_BYTES + 1)}))
    assert status == 413
    assert body["error"]["code"] == "too_large"


def test_base64_body(app: App) -> None:
    event = make_event("PUT", "/v1/settings")
    event["body"] = base64.b64encode(json.dumps({"soundEnabled": False}).encode()).decode()
    event["isBase64Encoded"] = True
    out = dispatch(event, app, ROUTES)
    assert out["statusCode"] == 200
    assert json.loads(out["body"])["settings"]["soundEnabled"] is False


def test_named_stage_prefix_is_stripped(app: App) -> None:
    event = make_event("GET", "/prod/v1/health", sub=None)
    event["requestContext"]["stage"] = "prod"
    assert dispatch(event, app, ROUTES)["statusCode"] == 200


def test_trailing_slash(call: Call) -> None:
    assert call("GET", "/v1/health/", sub=None)[0] == 200


def test_unexpected_error_is_internal_without_details(app: App) -> None:
    def boom(*_: object, **__: object) -> None:
        raise RuntimeError("secret detail")

    app.store.query_all = boom  # type: ignore[method-assign]
    out = dispatch(make_event("GET", "/v1/me"), app, ROUTES)
    assert out["statusCode"] == 500
    body = json.loads(out["body"])
    assert body["error"]["code"] == "internal"
    assert "secret" not in out["body"]


def test_responses_are_json_and_not_cached(app: App) -> None:
    out = dispatch(make_event("GET", "/v1/health", sub=None), app, ROUTES)
    assert out["headers"]["content-type"] == "application/json"
    assert out["headers"]["cache-control"] == "no-store"


def test_app_factory_is_lazy(app: App) -> None:
    built = []

    def factory() -> App:
        built.append(1)
        return app

    dispatch(make_event("GET", "/v1/nope"), factory, ROUTES)
    assert built == []
    dispatch(make_event("GET", "/v1/health", sub=None), factory, ROUTES)
    assert built == [1]


def test_every_contract_route_is_registered() -> None:
    expected = {
        ("GET", "/v1/health"),
        ("GET", "/v1/me"),
        ("POST", "/v1/uploads"),
        ("POST", "/v1/jobs"),
        ("GET", "/v1/jobs"),
        ("GET", "/v1/jobs/X"),
        ("POST", "/v1/jobs/X/cancel"),
        ("POST", "/v1/jobs/X/retry"),
        ("GET", "/v1/clips"),
        ("GET", "/v1/clips/X"),
        ("PATCH", "/v1/clips/X"),
        ("POST", "/v1/clips/X/confirm"),
        ("POST", "/v1/clips/X/decline"),
        ("GET", "/v1/skills"),
        ("POST", "/v1/skills/uploads"),
        ("POST", "/v1/skills"),
        ("PATCH", "/v1/skills/X"),
        ("DELETE", "/v1/skills/X"),
        ("GET", "/v1/skills/X/content"),
        ("GET", "/v1/settings"),
        ("PUT", "/v1/settings"),
        ("POST", "/v1/settings/cookies"),
        ("DELETE", "/v1/settings/cookies"),
        ("GET", "/v1/accounts"),
        ("POST", "/v1/accounts/youtube/connect"),
        ("GET", "/v1/posts"),
        ("GET", "/v1/insights"),
    }
    for method, path in expected:
        assert any(r.method == method and r.pattern.match(path) for r in ROUTES), (method, path)
    assert len(ROUTES) == len(expected)
