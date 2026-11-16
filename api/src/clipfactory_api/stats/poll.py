"""``run_tick``: the 15-minute EventBridge tick of ``cf-prod-stats`` (docs/CONTRACTS.md §16.5).

Reads only the posts that are due (sparse ``gsi2``: ``gsi2pk = "STATS"``, ``gsi2sk = "{statsDueAt}#{postId}"``, so
the query is a range read of what is due now, oldest first) and hands them to ``refresh_posts``. Posts it cannot
reach before ``STATS_TIME_BUDGET_SECONDS`` stay due for the next tick.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..clock import iso
from ..log import log
from .refresh import RefreshReport, StatsDeps, refresh_posts

MAX_DUE = 2000


def run_tick(deps: StatsDeps, now: datetime) -> dict[str, Any]:
    due = deps.store.query_stats_due(f"{iso(now)}#~", cap=MAX_DUE)
    items = [i for i in due if i.get("type") == "post"]
    report: RefreshReport = refresh_posts(deps, items, reason="poll", now=now)
    blocked = sorted(set(report.blocked))
    deferred = sum(1 for o in report.outcomes.values() if o == "deferred")
    log(
        "info",
        "stats.tick",
        posts=len(items),
        requests=report.requests,
        updated=len(report.updated),
        blocked=",".join(blocked),
        errors=len(report.errors),
        deferred=deferred,
    )
    return {
        "posts": len(items),
        "requests": report.requests,
        "updated": len(report.updated),
        "blocked": blocked,
        "errors": len(report.errors),
        "deferred": deferred,
    }
