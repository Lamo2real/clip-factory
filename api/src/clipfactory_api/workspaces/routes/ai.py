"""Lamo Stories' AI configuration, agents, skills, chat, memory, references, onboarding, usage, provider keys and
storage routes (docs/CONTRACTS.md §45.5, §45.25–§45.31).

SCAFFOLD (Phase 1): builder A2 adds the routes; tests/ws_routes_ai.py lists them for test_ws_http.py.
"""

from __future__ import annotations

from ...http import Route

ROUTES: list[Route] = []
