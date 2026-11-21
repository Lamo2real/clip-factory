"""Lamo Stories social accounts, publish and publishing jobs (docs/CONTRACTS.md §45.5, §45.13, §45.14).

SCAFFOLD (Phase 1): builder B adds the routes; tests/ws_routes_social.py lists them for test_http.py.
"""

from __future__ import annotations

from ...http import Route

ROUTES: list[Route] = []
