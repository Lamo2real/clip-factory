"""The ``/v1/workspaces`` My Mac posts TikTok routes test_ws_http.py expects (CONTRACTS §47.10)."""

from __future__ import annotations

WS = "/v1/workspaces/stories"
JOB = f"{WS}/publishing/01JZ0000000000000000000PJ1/mac"

EXPECTED: set[tuple[str, str]] = {
    ("GET", f"{WS}/tiktok/mac"),
    ("POST", f"{WS}/tiktok/mac/ping"),
    ("POST", f"{WS}/tiktok/mac/login"),
    ("POST", f"{JOB}/claim"),
    ("POST", f"{JOB}/step"),
    ("POST", f"{JOB}/done"),
    ("POST", f"{JOB}/stopped"),
    ("POST", f"{JOB}/retry"),
    ("POST", f"{JOB}/posted"),
}
