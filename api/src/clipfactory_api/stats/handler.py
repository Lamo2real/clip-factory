"""Lambda ``cf-prod-stats`` (docs/CONTRACTS.md §16.5).

* EventBridge scheduled event (``source == "aws.events"``) → ``run_tick``.
* ``{"action": "refresh", "userId", "clipId", "postIds"}`` (async Invoke by ``cf-prod-api`` on Refresh) →
  ``refresh_posts(reason="manual")`` on those posts, then ``refreshStartedAt`` is removed from each, always.
* Anything else → log ``stats.bad_event``.

Platform and network problems are handled inside ``refresh_posts`` (they become ``statsError``), so the handler
returns normally and EventBridge never retries; only a bug raises (and alarms).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .. import db
from ..ids import is_ulid
from ..log import log
from .poll import run_tick
from .refresh import StatsDeps, refresh_posts

DEFAULT_TIME_BUDGET = 240.0
MAX_POST_IDS = 10


def handle(event: Any, deps: StatsDeps) -> dict[str, Any]:
    now = deps.clock()
    if isinstance(event, dict) and event.get("source") == "aws.events":
        return {"action": "tick", **run_tick(deps, now)}
    if isinstance(event, dict) and event.get("action") == "refresh":
        return _manual(event, deps)
    log("warning", "stats.bad_event")
    return {"action": "bad_event"}


def _manual(event: dict[str, Any], deps: StatsDeps) -> dict[str, Any]:
    user_id, clip_id, post_ids = event.get("userId"), event.get("clipId"), event.get("postIds")
    if not (
        isinstance(user_id, str)
        and user_id
        and isinstance(clip_id, str)
        and isinstance(post_ids, list)
        and all(isinstance(p, str) and is_ulid(p) for p in post_ids)
    ):
        log("warning", "stats.bad_event")
        return {"action": "bad_event"}
    post_ids = list(dict.fromkeys(post_ids))[:MAX_POST_IDS]
    pk = db.user_pk(user_id)
    try:
        found = deps.store.batch_get((pk, db.post_sk(p)) for p in post_ids)
        items = [i for i in found if i.get("clipId") == clip_id and i.get("type") == "post"]
        report = refresh_posts(deps, items, reason="manual", now=deps.clock())
    finally:
        for post_id in post_ids:
            try:
                deps.store.update(pk, db.post_sk(post_id), {}, remove=["refreshStartedAt"])
            except db.ConditionFailed:
                continue  # the post is gone
    log(
        "info", "stats.manual", clipId=clip_id, posts=len(items), updated=len(report.updated), errors=len(report.errors)
    )
    return {"action": "refresh", "updated": sorted(report.updated), "outcomes": report.outcomes}


_deps: StatsDeps | None = None


def _from_env() -> StatsDeps:
    from ..app import table

    env = os.environ
    return StatsDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        time_budget_seconds=float(env.get("STATS_TIME_BUDGET_SECONDS") or DEFAULT_TIME_BUDGET),
    )


def get_deps(factory: Callable[[], StatsDeps] = _from_env) -> StatsDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    return handle(event, get_deps())
