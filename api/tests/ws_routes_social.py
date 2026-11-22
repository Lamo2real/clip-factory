"""The ``/v1/workspaces`` social, developer-app and publishing routes test_ws_http.py expects (CONTRACTS §45.5).

Lamo Stories' public OAuth callback (``GET /v1/stories-oauth/{platform}/callback``) is not a ``/v1/workspaces``
route: it lives in ``workspaces.routes.social.CALLBACK_ROUTES`` and ``CALLBACK`` below.
"""

from __future__ import annotations

WS = "/v1/workspaces/stories"

EXPECTED: set[tuple[str, str]] = {
    ("GET", f"{WS}/social"),
    ("POST", f"{WS}/social/youtube/connect"),
    ("POST", f"{WS}/social/instagram/choose"),
    ("POST", f"{WS}/social/youtube/check"),
    ("GET", f"{WS}/social/tiktok/creator-info"),
    ("DELETE", f"{WS}/social/youtube"),
    ("PUT", f"{WS}/social/youtube/app"),
    ("POST", f"{WS}/social/youtube/app/check"),
    ("DELETE", f"{WS}/social/youtube/app"),
    ("POST", f"{WS}/stories/01JZ0000000000000000000ST1/publish"),
    ("GET", f"{WS}/publishing"),
    ("POST", f"{WS}/publishing/01JZ0000000000000000000PJ1/retry"),
}

CALLBACK: set[tuple[str, str]] = {("GET", "/v1/stories-oauth/youtube/callback")}
