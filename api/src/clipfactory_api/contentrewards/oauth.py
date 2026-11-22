"""CR's OAuth server (``id.contentrewards.com``): register, authorize URL, code exchange, refresh, revoke (§38.9).

Public client (RFC 7591, no secret), PKCE S256, five fixed loopback redirects. Nothing here logs a code, a state, a
token or a query string.
"""

from __future__ import annotations

import json
import urllib.parse
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from ..clock import iso
from ..platforms.base import HttpRequest, HttpResponse
from . import config
from .net import Net, NetworkError

FORM = "application/x-www-form-urlencoded"
TOKEN_TIMEOUT = 8.0
REGISTER_TIMEOUT = 8.0


class OAuthFail(Exception):
    """``kind``: ``dead`` (invalid_grant / 401: sign in again), ``invalid_client`` (register again), ``rate`` (429,
    ``retry_after``), ``down`` (5xx, network; ``sent`` says whether the request may have reached CR), ``error``."""

    def __init__(self, kind: str, *, retry_after: float | None = None, sent: bool = True, code: str = "") -> None:
        super().__init__(kind)
        self.kind = kind
        self.retry_after = retry_after
        self.sent = sent
        self.code = code


def redirect_uri(port: int) -> str:
    return f"http://127.0.0.1:{port}/"


def redirect_uris() -> list[str]:
    return [redirect_uri(p) for p in config.PORTS]


def registration_body() -> dict[str, Any]:
    return {
        "client_name": config.CLIENT_NAME,
        "redirect_uris": redirect_uris(),
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }


def retry_after(response: HttpResponse) -> float | None:
    raw = response.headers.get("retry-after")
    try:
        return max(0.0, float(raw)) if raw is not None else None
    except ValueError:
        return None


def _error_code(response: HttpResponse) -> str:
    body = response.json()
    return str(body.get("error") or "") if isinstance(body, Mapping) else ""


def _send(net: Net, request: HttpRequest, timeout: float) -> HttpResponse:
    try:
        return net(request, timeout)
    except NetworkError as e:
        raise OAuthFail("down", sent=e.sent) from e


def register(net: Net, now: datetime) -> dict[str, Any]:
    """``{clientId, redirectUris, registeredAt, extra}`` for the app secret (never DynamoDB, logs or the web)."""
    body = json.dumps(registration_body()).encode()
    request = HttpRequest(
        "POST",
        config.REGISTER_URL,
        {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": config.USER_AGENT},
        body,
    )
    response = _send(net, request, REGISTER_TIMEOUT)
    if response.status == 429:
        raise OAuthFail("rate", retry_after=retry_after(response), code=_error_code(response))
    if response.status >= 500:
        raise OAuthFail("down")
    data = response.json()
    if response.status not in (200, 201) or not isinstance(data, Mapping) or not data.get("client_id"):
        raise OAuthFail("error", code=_error_code(response))
    extra = {k: v for k, v in data.items() if k != "client_id"}
    return {
        "clientId": str(data["client_id"]),
        "redirectUris": redirect_uris(),
        "registeredAt": iso(now),
        "extra": extra,
    }


def authorize_url(client_id: str, port: int, state: str, challenge: str) -> str:
    """Exactly one of each parameter, ``resource`` with no trailing slash, every value URL-encoded."""
    query = urllib.parse.urlencode(
        [
            ("response_type", "code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri(port)),
            ("scope", " ".join(config.SCOPES)),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("resource", config.MCP_URL),
        ],
        quote_via=urllib.parse.quote,
    )
    return f"{config.AUTHORIZE_URL}?{query}"


def _form(fields: list[tuple[str, str]]) -> bytes:
    return urllib.parse.urlencode(fields).encode()


def _token_request(fields: list[tuple[str, str]]) -> HttpRequest:
    return HttpRequest(
        "POST",
        config.TOKEN_URL,
        {"Content-Type": FORM, "Accept": "application/json", "User-Agent": config.USER_AGENT},
        _form(fields),
    )


def _token_answer(response: HttpResponse, *, refreshing: bool) -> dict[str, Any]:
    code = _error_code(response)
    if response.status == 429:
        raise OAuthFail("rate", retry_after=retry_after(response), code=code)
    if response.status >= 500:
        raise OAuthFail("down", code=code)
    if code == "invalid_client":
        raise OAuthFail("invalid_client", code=code)
    if code == "invalid_grant" or (refreshing and response.status == 401):
        raise OAuthFail("dead", code=code)
    data = response.json()
    if response.status != 200 or not isinstance(data, Mapping) or not data.get("access_token"):
        raise OAuthFail("error", code=code)
    return dict(data)


def secret_from(
    answer: Mapping[str, Any],
    now: datetime,
    *,
    requested: tuple[str, ...],
    creator_id: str = "",
    old: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The token secret ``{accessToken, expiresAt, refreshToken, scope, creatorId, issuedAt}``. With no ``scope`` in
    the answer (RFC 6749 §5.1) the requested scopes were granted."""
    scope = answer.get("scope")
    if not isinstance(scope, str) or not scope.strip():
        scope = str((old or {}).get("scope") or " ".join(requested))
    try:
        lifetime = int(answer.get("expires_in") or 600)
    except (TypeError, ValueError):
        lifetime = 600
    refresh = answer.get("refresh_token") or (old or {}).get("refreshToken")
    return {
        "accessToken": str(answer["access_token"]),
        "expiresAt": iso(now + timedelta(seconds=max(30, lifetime))),
        "refreshToken": str(refresh or ""),
        "scope": " ".join(scope.split()),
        "creatorId": creator_id or str((old or {}).get("creatorId") or ""),
        "issuedAt": iso(now),
    }


def exchange(net: Net, client_id: str, redirect: str, code: str, verifier: str) -> dict[str, Any]:
    request = _token_request(
        [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", client_id),
            ("code_verifier", verifier),
            ("resource", config.MCP_URL),
        ]
    )
    return _token_answer(_send(net, request, TOKEN_TIMEOUT), refreshing=False)


def refresh(net: Net, client_id: str, refresh_token: str, timeout: float = TOKEN_TIMEOUT) -> dict[str, Any]:
    request = _token_request(
        [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
            ("resource", config.MCP_URL),
        ]
    )
    return _token_answer(_send(net, request, timeout), refreshing=True)


def revoke(net: Net, client_id: str, refresh_token: str) -> bool:
    """Best effort: True when CR answered 200."""
    if not refresh_token:
        return False
    request = HttpRequest(
        "POST",
        config.REVOKE_URL,
        {"Content-Type": FORM, "User-Agent": config.USER_AGENT},
        _form([("token", refresh_token), ("client_id", client_id)]),
    )
    try:
        return net(request, TOKEN_TIMEOUT).status == 200
    except NetworkError:
        return False
