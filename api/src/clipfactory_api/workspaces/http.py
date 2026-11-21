"""``cf-prod-stories-api``: Lamo Stories' own Lambda (docs/CONTRACTS.md §45.5, §45.24, ADR-76).

API Gateway sends ``ANY /v1/workspaces`` and ``ANY /v1/workspaces/{proxy+}`` here; every other path still goes to
``cf-prod-api``, whose route table (``routes.ROUTES``) does not include these routes. The request handling, JWT claims
and error envelopes are the shared ``http.dispatch`` (used read-only).
"""

from __future__ import annotations

from typing import Any

from ..app import App
from ..http import dispatch

_app: App | None = None


def _get_app() -> App:
    global _app
    if _app is None:
        from ..app import from_env

        _app = from_env()
    return _app


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    from .routes import ROUTES

    return dispatch(event, _get_app, ROUTES)
