"""API Gateway HTTP API (payload v2) → router → JSON response (docs/CONTRACTS.md §5).

API Gateway's CORS configuration answers preflights and adds the CORS headers, so this layer only has to make
sure an OPTIONS request that reaches it is harmless. Every error leaves as
``{"error": {"code", "message"}}`` with a plain-English message; unexpected failures are logged with the
request id and returned as ``internal`` without details. Every error body also carries the API Gateway
``requestId`` next to ``error`` (§19.6), so the owner can hand over one code that finds the one log line.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .app import App, from_env
from .errors import ApiError, bad_request, not_found, too_large
from .log import log

MAX_BODY_BYTES = 64 * 1024

JsonBody = dict[str, Any]


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str]
    raw_body: bytes
    user_id: str
    claims: dict[str, Any]
    token: str
    request_id: str
    params: dict[str, str] = field(default_factory=dict)

    def json(self, max_bytes: int = MAX_BODY_BYTES) -> JsonBody:
        if not self.raw_body.strip():
            return {}
        if len(self.raw_body) > max_bytes:
            raise too_large("The request is too large.")
        try:
            body = json.loads(self.raw_body)
        except (ValueError, UnicodeDecodeError) as e:
            raise bad_request("The request body is not valid JSON.") from e
        if not isinstance(body, dict):
            raise bad_request("The request body must be a JSON object.")
        return body


@dataclass(frozen=True)
class Response:
    status: int
    body: JsonBody | None = None
    headers: dict[str, str] = field(default_factory=dict)


Handler = Callable[[App, Request], Response]


@dataclass(frozen=True)
class Route:
    method: str
    pattern: re.Pattern[str]
    handler: Handler
    public: bool = False


def route(method: str, path: str, handler: Handler, *, public: bool = False) -> Route:
    """``path`` uses ``{name}`` for one path segment, e.g. ``/v1/jobs/{jobId}``."""
    regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", path)
    return Route(method, re.compile(f"^{regex}$"), handler, public)


def ok(body: JsonBody, status: int = 200) -> Response:
    return Response(status, body)


def no_content() -> Response:
    return Response(204)


def _json_response(
    status: int, body: JsonBody | None, extra_headers: Mapping[str, str] | None = None
) -> dict[str, Any]:
    headers = {"content-type": "application/json", "cache-control": "no-store"}
    for name, value in (extra_headers or {}).items():
        headers[name.lower()] = value
    return {
        "statusCode": status,
        "headers": headers,
        "body": "" if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False),
    }


def error_response(
    status: int,
    code: str,
    message: str,
    request_id: str = "",
    *,
    field: str | None = None,
    extra: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    error: JsonBody = {"code": code, "message": message}
    if field:
        error["field"] = field
    error.update(extra or {})
    return _json_response(status, {"error": error, "requestId": request_id}, headers)


def _path(event: Mapping[str, Any]) -> str:
    path = str(event.get("rawPath") or "/")
    stage = (event.get("requestContext") or {}).get("stage")
    # A named stage shows up in rawPath; the $default stage does not.
    if stage and stage != "$default" and path.startswith(f"/{stage}/"):
        path = path[len(stage) + 1 :]
    return path.rstrip("/") or "/"


def _body(event: Mapping[str, Any]) -> bytes:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            return base64.b64decode(raw, validate=False)
        except (ValueError, binascii.Error) as e:
            raise bad_request("The request body could not be read.") from e
    return raw.encode() if isinstance(raw, str) else bytes(raw)


def _claims(event: Mapping[str, Any]) -> dict[str, Any]:
    authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
    claims = (authorizer.get("jwt") or {}).get("claims") or {}
    return dict(claims) if isinstance(claims, Mapping) else {}


def _bearer(event: Mapping[str, Any]) -> str:
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    value = str(headers.get("authorization") or "")
    return value[7:].strip() if value[:7].lower() == "bearer " else ""


def dispatch(event: Mapping[str, Any], app: App | Callable[[], App], routes: list[Route]) -> dict[str, Any]:
    context = event.get("requestContext") or {}
    method = str((context.get("http") or {}).get("method") or "GET").upper()
    path = _path(event)
    request_id = str(context.get("requestId") or "")
    if method == "OPTIONS":
        return {"statusCode": 204, "headers": {"cache-control": "no-store"}, "body": ""}
    try:
        matched: tuple[Route, dict[str, str]] | None = None
        path_known = False
        for candidate in routes:
            m = candidate.pattern.match(path)
            if not m:
                continue
            path_known = True
            if candidate.method == method:
                matched = (candidate, m.groupdict())
                break
        if matched is None:
            if path_known:
                return error_response(405, "bad_request", "That action is not allowed here.", request_id)
            raise not_found("That address does not exist.")
        chosen, params = matched
        claims = _claims(event)
        user_id = str(claims.get("sub") or "")
        if not chosen.public and not user_id:
            raise ApiError(401, "unauthorized", "Please sign in again.")
        request = Request(
            method=method,
            path=path,
            query={str(k): str(v) for k, v in (event.get("queryStringParameters") or {}).items()},
            raw_body=_body(event),
            user_id=user_id,
            claims=claims,
            token=_bearer(event),
            request_id=request_id,
            params=params,
        )
        resolved = app if isinstance(app, App) else app()
        response = chosen.handler(resolved, request)
        log("info", "http", method=method, path=chosen.pattern.pattern, status=response.status, requestId=request_id)
        return _json_response(response.status, response.body, response.headers)
    except ApiError as e:
        log("info", "http.error", method=method, status=e.status, code=e.code, requestId=request_id)
        return error_response(e.status, e.code, e.message, request_id, field=e.field, extra=e.extra, headers=e.headers)
    except Exception as e:
        log("error", "http.internal", method=method, error=type(e).__name__, detail=str(e), requestId=request_id)
        return error_response(500, "internal", "Something went wrong on our side. Please try again.", request_id)


_app: App | None = None


def _get_app() -> App:
    global _app
    if _app is None:
        _app = from_env()
    return _app


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    from .routes import ROUTES

    return dispatch(event, _get_app, ROUTES)
