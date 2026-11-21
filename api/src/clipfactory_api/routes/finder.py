"""/v1/contentrewards/finder: the campaign finder (docs/CONTRACTS.md §41.5).

Under ``/v1/contentrewards``, so §38.8's rule holds (an api from before §41 answers 404, a switched-off Content
Rewards 503); each route also answers 503 ``unavailable`` "Coming soon." unless ``CR_FINDER=on``. ``GET`` reads items
only (``CRFIND``, the setups, his campaigns, ``CRPUBLIC/STATE``, ``CRCONN``), never Content Rewards.
"""

from __future__ import annotations

from typing import Any

from .. import validate
from ..app import App
from ..http import Request, Response, ok
from .contentrewards import _deps, _now


def _finder_deps(app: App, req: Request) -> Any:
    from ..contentrewards import finderapi

    deps = _deps(app, req)
    finderapi.require()
    return deps


def get_finder(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    now = _now(app)
    found = finderapi.Context(deps, req.user_id, now)
    if found.stale() and finderapi.start_look(deps, req.user_id, "want", now, idle_only=True):
        found.reload()
    return ok(found.view())


def patch_finder(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    body = req.json()
    validate.only_keys(body, {"want", "seenAll", "unhideAll"})
    now = _now(app)
    finderapi.patch(deps, req.user_id, body, now)
    return ok({"finder": finderapi.Context(deps, req.user_id, now).view()})


def check(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    status, body = finderapi.check_now(deps, req.user_id, _now(app))
    return ok(body, status)


def patch_match(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    body = req.json()
    validate.only_keys(body, {"said"})
    if "said" not in body:
        from ..errors import bad_request

        raise bad_request("Send said.", "said")
    now = _now(app)
    finderapi.said(deps, req.user_id, req.params["campaignId"], body["said"], now)
    return ok({"finder": finderapi.Context(deps, req.user_id, now).view()})


def add_match(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    status, campaign = finderapi.add(deps, req.user_id, req.params["campaignId"], _now(app))
    return ok({"campaign": campaign}, status)


def joined(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    return ok({"added": finderapi.joined(deps, req.user_id, _now(app))})


def ask(app: App, req: Request) -> Response:
    from ..contentrewards import finderapi

    deps = _finder_deps(app, req)
    return ok({"askedAt": finderapi.ask(deps, req.user_id, _now(app))})
