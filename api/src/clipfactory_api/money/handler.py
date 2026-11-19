"""Lambda ``cf-prod-money`` (docs/CONTRACTS.md §25.6).

* EventBridge daily run (``source == "aws.events"``, 06:00 UTC) → every owner in ``MONEYOWNERS`` (one Query).
* ``{"action": "refresh", "userId"}`` (async Invoke by ``cf-prod-api`` on Check now, at most once an hour).
* Anything else → log ``money.bad_event``.

Platform problems become ``lastError`` on the money state, so the handler returns normally and EventBridge never
retries; only a bug raises (and alarms).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .. import db
from ..log import log
from . import owners
from .collect import MoneyDeps, run_user

DEFAULT_TIME_BUDGET = 240.0


def handle(event: Any, deps: MoneyDeps) -> dict[str, Any]:
    if isinstance(event, dict) and event.get("source") == "aws.events":
        found = owners(deps.store)
        started = deps.monotonic()
        done = 0
        for user_id in found:
            if deps.monotonic() - started > deps.time_budget_seconds:
                log("warning", "money.time_budget", owners=len(found), done=done)
                break
            run_user(deps, user_id)
            done += 1
        return {"action": "daily", "owners": done}
    if isinstance(event, dict) and event.get("action") == "refresh":
        target = event.get("userId")
        if not isinstance(target, str) or not target:
            log("warning", "money.bad_event")
            return {"action": "bad_event"}
        outcomes = run_user(deps, target)
        return {"action": "refresh", "states": {o.platform: o.state for o in outcomes}}
    log("warning", "money.bad_event")
    return {"action": "bad_event"}


_deps: MoneyDeps | None = None


def _from_env() -> MoneyDeps:
    from ..app import table
    from ..oauth.tokens import token_provider_from_env
    from ..platforms.base import urllib_client
    from ..stats import config

    store = db.Store(table(os.environ["TABLE_NAME"]))
    cfg = config.load()
    return MoneyDeps(
        store=store,
        tokens=token_provider_from_env(store),
        http=urllib_client,
        platforms=cfg,
        graph_version=cfg.graph_api_version,
        time_budget_seconds=float(os.environ.get("MONEY_TIME_BUDGET_SECONDS") or DEFAULT_TIME_BUDGET),
    )


def get_deps(factory: Callable[[], MoneyDeps] = _from_env) -> MoneyDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    deps = get_deps()
    if deps.tokens is None:
        log("error", "money.no_secrets")
        return {"action": "no_secrets"}
    return handle(event, deps)
