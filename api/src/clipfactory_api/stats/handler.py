"""Lambda ``cf-prod-stats`` (docs/CONTRACTS.md §16.5).

* EventBridge scheduled event (``source == "aws.events"``) → ``run_tick``.
* ``{"action": "refresh", "userId", "clipId", "postIds"}`` (async Invoke by ``cf-prod-api`` on Refresh) →
  ``refresh_posts(reason="manual")`` on those posts, then ``refreshStartedAt`` is removed from each, always.
* ``{"action": "forget", "userId", "platform": "youtube"}`` (async Invoke by ``DELETE /v1/accounts/youtube``, §17.6):
  the numbers read from YouTube are removed from its posts (``metrics`` and the poll index) and their ``STAT#``
  snapshots deleted (YouTube Developer Policies: delete API data after revocation). Their day-7 numbers go too, and
  every creator lesson learned from YouTube numbers is deleted (no tombstone: the data behind it is gone, §16.12).
  The money read from YouTube goes as well (§25.6): channel snapshots, reported revenue, the money state and each
  post's ``revenue``. Nothing is deleted on a token expiry: only an explicit Disconnect sends this.
* ``{"action": "contentrewards", "userId", "what": "campaigns" | "money" | "all"}`` (async Invoke by ``cf-prod-api`` on
  Connect finish and money refresh, §38.12): ``contentrewards.poll.run_owner`` for that one owner, a 60 s budget.
* The scheduled tick also checks Content Rewards after the platform poll when ``CONTENT_REWARDS=on``
  (``contentrewards.poll.run_tick`` with ``min(45 s, what is left - 15 s)``); it never raises.
* Anything else → log ``stats.bad_event``.

Platform and network problems are handled inside ``refresh_posts`` (they become ``statsError``), so the handler
returns normally and EventBridge never retries; only a bug raises (and alarms).
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any

from .. import db, lessons, money
from ..ids import is_ulid
from ..log import log
from .poll import run_tick
from .refresh import StatsDeps, refresh_posts

DEFAULT_TIME_BUDGET = 240.0
MAX_POST_IDS = 10
CR_TICK_SECONDS = 45.0
CR_MARGIN_SECONDS = 15.0
CR_OWNER_SECONDS = 60.0
CR_WHAT = ("campaigns", "money", "all")


def handle(event: Any, deps: StatsDeps, cr: Callable[[], Any] | None = None) -> dict[str, Any]:
    """``cr`` builds the Content Rewards deps (None when switched off): ``_cr_from_env`` in the Lambda."""
    now = deps.clock()
    cr = _cr_from_env if cr is None else cr
    if isinstance(event, dict) and event.get("source") == "aws.events":
        started = time.monotonic()
        out = {"action": "tick", **run_tick(deps, now)}
        left = float(deps.time_budget_seconds) - (time.monotonic() - started)
        _cr_tick(cr, now, min(CR_TICK_SECONDS, left - CR_MARGIN_SECONDS))
        return out
    if isinstance(event, dict) and event.get("action") == "refresh":
        return _manual(event, deps)
    if isinstance(event, dict) and event.get("action") == "forget":
        return _forget(event, deps)
    if isinstance(event, dict) and event.get("action") == "contentrewards":
        return _content_rewards(event, cr, now)
    log("warning", "stats.bad_event")
    return {"action": "bad_event"}


def _cr_tick(cr: Callable[[], Any], now: Any, budget: float) -> None:
    if budget <= 0:
        return
    try:
        cr_deps = cr()
        if cr_deps is None:
            return
        from ..contentrewards import poll

        cr_deps.remaining = lambda: budget + CR_MARGIN_SECONDS
        poll.run_tick(cr_deps, now, budget)
    except Exception as e:  # the platform poll's work is done; CR checking never fails the tick
        log("error", "stats.cr_tick_failed", error=type(e).__name__)


def _content_rewards(event: dict[str, Any], cr: Callable[[], Any], now: Any) -> dict[str, Any]:
    user_id, what = event.get("userId"), event.get("what")
    if not (isinstance(user_id, str) and user_id and what in CR_WHAT):
        log("warning", "stats.bad_event")
        return {"action": "bad_event"}
    cr_deps = cr()
    if cr_deps is None:
        log("info", "stats.cr_off")
        return {"action": "contentrewards", "outcome": "off"}
    from ..contentrewards import poll

    deadline = time.monotonic() + CR_OWNER_SECONDS
    cr_deps.remaining = lambda: max(0.0, deadline - time.monotonic() + CR_MARGIN_SECONDS)
    report = poll.run_owner(cr_deps, user_id, now, what=str(what), deadline=deadline)
    return {"action": "contentrewards", "report": report}


_cr: Any = None


def _cr_from_env() -> Any:
    """The CR deps of ``cf-prod-stats`` (cached per container), or None while switched off (``CONTENT_REWARDS`` not
    ``on``, or no ``SECRET_PREFIX``). Rules reads it starts go to ``CAMPAIGNS_FUNCTION_ARN``."""
    global _cr
    if _cr is None:
        from ..contentrewards import config as cr_config
        from ..contentrewards import deps as cr_deps

        if not cr_config.enabled():
            return None
        from ..app import region
        from ..async_invoke import AsyncInvoker
        from ..flow_client import make_client

        env = os.environ
        invoker = AsyncInvoker(
            make_client(region()), env.get("STATS_FUNCTION_ARN", ""), "", "", env.get("CAMPAIGNS_FUNCTION_ARN", "")
        )
        _cr = cr_deps.from_env(get_deps().store, None, invoker)
    return _cr


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


FORGET_FIELDS = [
    "metrics",
    "gsi2pk",
    "gsi2sk",
    "statsDueAt",
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
    # The day-7 number is read from the platform too (§16.12): it goes, and so do the lessons built on it.
    "day7",
    "day7At",
    "day7Source",
    "day7State",
    "day7CheckedAt",
    "day7Verdict",  # the winner verdict and the baseline median it was judged against
    "revenue",  # §25.3: YouTube's estimate for the clip (read with the monetary scope)
    "revenueWindows",  # §27.6: the same estimate over the last 7, 30 and 90 reported days
]


def _forget(event: dict[str, Any], deps: StatsDeps) -> dict[str, Any]:
    user_id, platform = event.get("userId"), event.get("platform")
    if not (isinstance(user_id, str) and user_id and platform == "youtube"):
        log("warning", "stats.bad_event")
        return {"action": "bad_event"}
    pk = db.user_pk(user_id)
    found = [p for p in deps.store.query_all(pk, "POST#") if p.get("platform") == platform and p.get("type") == "post"]
    snapshots = 0
    for post in found:
        try:
            deps.store.update(post["pk"], post["sk"], {}, remove=FORGET_FIELDS)
        except db.ConditionFailed:
            continue
        for stat in deps.store.query_all(pk, db.stat_prefix(str(post["postId"]))):
            deps.store.delete(stat["pk"], stat["sk"])
            snapshots += 1
    removed = lessons.forget_platform(deps.store, user_id, platform)
    # §25.6: the channel snapshots, reported money and money state read from YouTube go too.
    money_items = money.forget_platform(deps.store, user_id, platform)
    log(
        "info",
        "stats.forget",
        platform=platform,
        posts=len(found),
        snapshots=snapshots,
        lessons=removed,
        money=money_items,
    )
    return {"action": "forget", "posts": len(found), "snapshots": snapshots, "lessons": removed, "money": money_items}


_deps: StatsDeps | None = None


def _from_env() -> StatsDeps:
    from ..app import table
    from ..oauth.tokens import token_provider_from_env
    from ..platforms import make_adapters
    from . import config

    env = os.environ
    store = db.Store(table(env["TABLE_NAME"]))
    cfg = config.load()
    tokens = token_provider_from_env(store)
    adapters = make_adapters(tokens=tokens, graph_api_version=cfg.graph_api_version) if tokens else make_adapters()
    return StatsDeps(
        store=store,
        adapters=lambda platform: adapters[platform],
        time_budget_seconds=float(env.get("STATS_TIME_BUDGET_SECONDS") or DEFAULT_TIME_BUDGET),
        cfg=cfg,
    )


def get_deps(factory: Callable[[], StatsDeps] = _from_env) -> StatsDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    return handle(event, get_deps())
