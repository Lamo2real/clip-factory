"""Workspaces, dashboard, ideas, characters, stories, library, providers and guidance (docs/CONTRACTS.md §45.5).

SCAFFOLD (Phase 1): builder A adds the routes; tests/ws_routes_core.py lists them for test_http.py.
"""

from __future__ import annotations

from ...http import Route

ROUTES: list[Route] = []
