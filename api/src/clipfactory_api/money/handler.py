"""Lambda ``cf-prod-money`` (docs/CONTRACTS.md §25.6).

* EventBridge daily run (``source == "aws.events"``, 06:00 UTC) → every owner in ``MONEYOWNERS`` (one Query).
* ``{"action": "refresh", "userId"}`` (async Invoke by ``cf-prod-api`` on Check now, at most once an hour). It never
  reads the bank (§40.5.6): only the daily run calls ``run_user(…, bank=True)``.
* ``{"action": "bank", "userId", "first", "psu": {"ip", "ua", "lang"}, "at"}`` (async Invoke by ``cf-prod-api`` on the
  bank page's Check now, §40.5.6): only the bank read, for that owner. An async event can wait in Lambda's queue for up
  to an hour, so when ``at`` is more than 120 s old ``psu`` is dropped and the read is unattended (he has left). The
  PSU details go to Enable Banking for that one read only: never stored, never logged.
* Anything else → log ``money.bad_event``.

Platform problems become ``lastError`` on the money state, so the handler returns normally and EventBridge never
retries; only a bug raises (and alarms).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from .. import db
from ..clock import parse
from ..log import log
from . import owners
from .collect import MoneyDeps, run_user

DEFAULT_TIME_BUDGET = 240.0
PSU_FRESH = timedelta(seconds=120)


def handle(event: Any, deps: MoneyDeps) -> dict[str, Any]:
    if isinstance(event, dict) and event.get("source") == "aws.events":
        found = owners(deps.store)
        started = deps.monotonic()
        done = 0
        for user_id in found:
            if deps.monotonic() - started > deps.time_budget_seconds:
                log("warning", "money.time_budget", owners=len(found), done=done)
                break
            run_user(deps, user_id, bank=True)
            done += 1
        return {"action": "daily", "owners": done}
    if isinstance(event, dict) and event.get("action") == "refresh":
        target = event.get("userId")
        if not isinstance(target, str) or not target:
            log("warning", "money.bad_event")
            return {"action": "bad_event"}
        outcomes = run_user(deps, target)
        return {"action": "refresh", "states": {o.platform: o.state for o in outcomes}}
    if isinstance(event, dict) and event.get("action") == "bank":
        return _bank(event, deps)
    log("warning", "money.bad_event")
    return {"action": "bad_event"}


def _bank(event: dict[str, Any], deps: MoneyDeps) -> dict[str, Any]:
    """His bank Check now: only the bank read (240 s budget), attended only while the event is fresh."""
    from ..bankread import collect as bank_collect

    target = event.get("userId")
    if not isinstance(target, str) or not target:
        log("warning", "money.bad_event")
        return {"action": "bad_event"}
    now = deps.clock()
    raw = event.get("at")
    at = (
        datetime.fromtimestamp(raw, UTC)
        if isinstance(raw, int | float) and not isinstance(raw, bool) and raw > 0
        else parse(raw)
    )
    fresh = at is not None and now - at <= PSU_FRESH
    psu = event.get("psu") if fresh and isinstance(event.get("psu"), dict) else None
    started = deps.monotonic()
    out = bank_collect.run(
        deps,
        target,
        now,
        psu=psu,
        mine=fresh,
        remaining=lambda: deps.time_budget_seconds - (deps.monotonic() - started),
    )
    return {"action": "bank", "result": out.get("result")}


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
        bank_reading=(os.environ.get("BANK_READING") or "off") == "on",
        app_url=os.environ.get("APP_URL") or "",
        content_rewards=(os.environ.get("CONTENT_REWARDS") or "off") == "on",
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
