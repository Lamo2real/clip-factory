"""One request, one resolver scope (docs/CONTRACTS.md §45.34 "Adding models without a release").

``guard.require_workspace`` binds the caller's workspace (its ``MODELDEF#`` models) to ``ai_resolve`` for the rest of
the request. A warm Lambda serves one call after another on the same thread, so every Lamo Stories route is wrapped:
the scope is cleared before the handler runs and again when it ends, whatever happens, and a route that names no
workspace (the workspace list, the OAuth callback) only ever sees the bundled models.
"""

from __future__ import annotations

from ...app import App
from ...http import Request, Response, Route
from .. import ai_resolve


def scoped(r: Route) -> Route:
    handler = r.handler

    def run(app: App, req: Request) -> Response:
        ai_resolve.unbind()
        try:
            return handler(app, req)
        finally:
            ai_resolve.unbind()

    run.__name__ = getattr(handler, "__name__", "route")
    run.__doc__ = handler.__doc__
    return Route(r.method, r.pattern, run, r.public)
