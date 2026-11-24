"""``/v1/workspaces`` routes (docs/CONTRACTS.md §45.5): core (builder A), series (§45.44), AI and the creative tools
(builder A2), and social and publishing (builder B). Served only by Lamo Stories' own Lambda (``workspaces/http.py``). This package lives
outside Clip Factory's ``routes`` package, so importing it never loads Clip Factory's route table.
"""

from __future__ import annotations

from ...http import Route
from . import ai, core, series, social
from .scope import scoped

# Each request starts and ends with no workspace's added models bound (§45.34: the resolver's scope is per request,
# never carried into the next call a warm Lambda serves); ``guard.require_workspace`` binds the caller's own.
ROUTES: list[Route] = [scoped(r) for r in (*core.ROUTES, *series.ROUTES, *ai.ROUTES, *social.ROUTES)]
