"""Lambda ``cf-prod-autopost`` (docs/CONTRACTS.md §46.11).

The EventBridge rule ``cf-prod-autopost-hourly`` (``cron(0 * * * ? *)``, ``source == "aws.events"``) → every owner in
``AUTOPOSTOWNERS`` (one Query) runs ``run_once(..., "scheduled", slot)``, the slot being the hour of the event's own
``time`` (a retried delivery is the same slot, so it resumes its own run). One owner's failure is logged and the
others still run; the invocation then fails, so Lambda's retry (the same event) resumes that owner's run while every
finished run answers ``done``. Anything else → log ``autopost.bad_event``.

Env: ``TABLE_NAME``, ``MEDIA_BUCKET``, ``CLIP_FLOW_ARN`` (the clip flow's ``live`` alias), ``SECRET_PREFIX`` and
``CONTENT_REWARDS`` and ``CR_REMAKE`` (the campaign fit check, §39.3; the same switches as cf-prod-api),
``AUTOPOST_TIME_BUDGET_SECONDS`` (240).
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Callable
from typing import Any

from ..clock import iso, parse
from ..log import log
from . import owners, schedule
from .run import CLIP_SECONDS, DEFAULT_TIME_BUDGET, RunDeps, run_once


class OwnersFailed(Exception):
    """At least one owner's run failed this tick (each was logged); raised after the others ran."""


def handle(event: Any, deps: RunDeps) -> dict[str, Any]:
    if not (isinstance(event, dict) and event.get("source") == "aws.events"):
        log("warning", "autopost.bad_event")
        return {"action": "bad_event"}
    moment = parse(event.get("time"))
    if moment is None:
        log("warning", "autopost.bad_event", reason="time")
        return {"action": "bad_event"}
    slot = schedule.floor_hour(moment)
    # The whole tick shares one time budget (the Lambda stops at 300 s).
    tick = dataclasses.replace(deps, deadline=deps.monotonic() + deps.time_budget_seconds)
    found = owners(deps.app.store)
    results: dict[str, str] = {}
    failed = 0
    for user_id in found:
        try:
            results[user_id] = run_once(tick, user_id, "scheduled", slot).result
        except Exception as e:  # one owner never stops the others
            failed += 1
            log("error", "autopost.owner_failed", userId=user_id, slot=iso(slot), error=type(e).__name__)
    log("info", "autopost.tick", slot=iso(slot), owners=len(found), ran=sum(r == "ran" for r in results.values()))
    if failed:
        raise OwnersFailed(f"{failed} of {len(found)} owners failed at {iso(slot)}")
    return {"action": "tick", "slot": iso(slot), "owners": len(found), "results": results}


_deps: RunDeps | None = None


def _from_env() -> RunDeps:
    from .. import db, s3
    from ..agent_client import AgentClient
    from ..app import App, region, table
    from ..contentrewards import deps as cr_deps
    from ..flow_client import FlowClient, make_client

    env = os.environ
    reg = region()
    store = db.Store(table(env["TABLE_NAME"]))
    # The App Upload's code takes. A run reads no files and signs no links (no S3 grant): the media client is never
    # called; the agent is never used.
    media = s3.Media(s3.make_client(reg), env["MEDIA_BUCKET"])
    app = App(
        store=store,
        media=media,
        agent=AgentClient(None, ""),
        flows=FlowClient(make_client(reg), "", env["CLIP_FLOW_ARN"]),
        contentrewards=cr_deps.from_env(store, None, None),  # None unless CONTENT_REWARDS is on (§38.8)
    )
    budget = float(env.get("AUTOPOST_TIME_BUDGET_SECONDS") or DEFAULT_TIME_BUDGET)
    return RunDeps(app=app, time_budget_seconds=budget, clip_seconds=CLIP_SECONDS)


def get_deps(factory: Callable[[], RunDeps] = _from_env) -> RunDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    deps = get_deps()
    cr = deps.app.contentrewards
    if cr is not None:
        cr.until(deps.time_budget_seconds)  # this invocation's own time, for the fit check's token guard
    return handle(event, deps)
