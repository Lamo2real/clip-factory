"""``/v1/workspaces`` routes (docs/CONTRACTS.md §45.5): core (builder A), AI and the creative tools (builder A2), and
social and publishing (builder B). Served only by Lamo Stories' own Lambda (``workspaces/http.py``). This package lives
outside Clip Factory's ``routes`` package, so importing it never loads Clip Factory's route table.
"""

from __future__ import annotations

from ...http import Route
from . import ai, core, social

ROUTES: list[Route] = [*core.ROUTES, *ai.ROUTES, *social.ROUTES]
