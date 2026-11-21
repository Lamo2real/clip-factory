"""``/v1/workspaces`` routes (docs/CONTRACTS.md §45.5): core (builder A) and social and publishing (builder B).

Appended once, at the end of ``routes.ROUTES``; no existing route changes.
"""

from __future__ import annotations

from ...http import Route
from . import core, social

ROUTES: list[Route] = [*core.ROUTES, *social.ROUTES]
