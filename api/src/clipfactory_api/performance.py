"""The clip performance page: one clip's numbers on every platform (docs/CONTRACTS.md §16.2).

``public_performance`` builds ``ClipPerformance``: always five platforms in ``STATS_ORDER`` (YouTube, TikTok,
Instagram, Facebook, X), each with its status, account state, latest ``PostMetrics`` and refresh state; the
sparkline series from the STAT# snapshots (≤ 60 points, evenly spread over time, the newest always kept); totals
where a ``null`` counts as 0; the best platform (most views, ties to the earlier platform).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from . import clips, posts, s3
from .clock import iso, parse
from .platforms import label
from .stats import STATS_ORDER

Item = dict[str, Any]
MAX_SNAPSHOTS = 500
MAX_POINTS = 60
NO_NUMBERS_STATUSES = frozenset({"review", "declined"})
NO_NUMBERS_YET = "This clip has no numbers yet. Upload it first."
TOTAL_FIELDS = ("views", "likes", "comments", "shares")


def perf_status(post: Mapping[str, Any] | None) -> str:
    """§16.2 status mapping, first match wins."""
    if post is None:
        return "not_posted"
    status = post.get("status")
    if status == "pending_integration":
        return "waiting_for_connection"
    if status == "queued":
        return "posting"
    if status == "failed":
        return "failed"
    if status == "posted":
        return "posted_private" if post.get("privacy") == "private" else "posted"
    return "not_posted"


def latest_by_platform(items: list[Item]) -> dict[str, Item]:
    """One post per platform (a clip has at most one; the newest wins if an old one lingers)."""
    out: dict[str, Item] = {}
    for item in sorted(items, key=lambda p: str(p.get("postId") or "")):
        if item.get("type", "post") == "post":
            out[str(item.get("platform"))] = item
    return out


def downsample(points: list[Item], limit: int = MAX_POINTS) -> list[Item]:
    """At most ``limit`` points spread evenly by time: the newest point of each equal time slice. The very last
    point is always kept (it is the newest of the last slice)."""
    if len(points) <= limit:
        return points
    start = parse(points[0]["at"])
    end = parse(points[-1]["at"])
    if start is None or end is None or end <= start:
        return points[-limit:]
    span = (end - start).total_seconds()
    slices: dict[int, Item] = {}
    for point in points:
        moment = parse(point["at"]) or start
        index = min(limit - 1, int((moment - start).total_seconds() / span * limit))
        slices[index] = point
    return [slices[i] for i in sorted(slices)]


def series_for(snapshots: list[Item]) -> list[Item]:
    ordered = sorted(snapshots, key=lambda s: str(s.get("at") or ""))
    points = [
        {"at": str(s["at"]), "views": int(s["views"])}
        for s in ordered
        if isinstance(s.get("at"), str)
        and isinstance(s.get("views"), int | float)
        and not isinstance(s.get("views"), bool)
    ]
    return downsample(points)


def anchor_at(clip: Mapping[str, Any], clip_posts: list[Item]) -> str:
    """The clip's week anchor: its earliest ``postedAt``, else ``decidedAt`` (kept, not posted yet)."""
    posted = sorted(str(p["postedAt"]) for p in clip_posts if p.get("postedAt"))
    if posted:
        return posted[0]
    return str(clip.get("decidedAt") or clip.get("createdAt") or "")


def _number(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def platform_performance(platform: str, post: Item | None, account_status: str, now: datetime) -> Item:
    metrics = posts.public_metrics(post.get("metrics")) if post else None
    out: Item = {
        "platform": platform,
        "status": perf_status(post),
        "account": account_status,
        "metrics": metrics,
        "refreshing": bool(post) and posts.is_refreshing(post or {}, now),
        "final": bool(metrics and metrics.get("final")),
    }
    if post is None:
        return out
    out["postId"] = post["postId"]
    for key in ("url", "postedAt"):
        if post.get(key):
            out[key] = post[key]
    if post.get("by") == "you":
        out["by"] = "you"  # posted on TikTok by the owner himself (§41)
    if metrics:
        if metrics.get("metricsUpdatedAt"):
            out["updatedAt"] = metrics["metricsUpdatedAt"]
        if metrics.get("insightsUpdatedAt"):
            out["insightsUpdatedAt"] = metrics["insightsUpdatedAt"]
    next_at = parse(post.get("nextRefreshAt"))
    if next_at is not None and next_at > now:
        out["nextAllowedAt"] = iso(next_at)
    error = post.get("error") if post.get("status") == "failed" else post.get("statsError")
    if isinstance(error, str) and error:
        out["error"] = error
    # §25.3: the money this clip made, only when its platform reported it (YouTube's estimate, never a guess).
    from .money.view import clip_revenue

    revenue = clip_revenue(post) if post.get("status") == "posted" else None
    if revenue is not None:
        out["revenue"] = revenue
    return out


def public_performance(
    clip: Item,
    clip_posts: list[Item],
    accounts: list[Item],
    snapshots: Mapping[str, list[Item]],
    now: datetime,
    *,
    media: s3.Media | None = None,
) -> Item:
    """``ClipPerformance``. ``snapshots`` maps postId → its STAT# items (oldest first)."""
    by_platform = latest_by_platform(clip_posts)
    # §16.2 knows three account states; a Meta account still being picked (§17.4 choose_account) is not connected.
    known = {"connected", "needs_reconnect"}
    account_status = {
        str(a.get("platform")): str(a.get("status")) if a.get("status") in known else "not_connected" for a in accounts
    }
    rows = [
        platform_performance(p, by_platform.get(p), account_status.get(p, "not_connected"), now) for p in STATS_ORDER
    ]
    series: Item = {}
    for platform in STATS_ORDER:
        post = by_platform.get(platform)
        if post is None:
            continue
        points = series_for(snapshots.get(str(post["postId"]), []))
        if points:
            series[platform] = points
    measured = [r["metrics"] for r in rows if r["metrics"] is not None]
    totals: Item = {k: sum(_number(m.get(k)) for m in measured) for k in TOTAL_FIELDS}
    totals["platformsPosted"] = sum(1 for r in rows if r["status"] in {"posted", "posted_private"})
    stamps = [str(m["metricsUpdatedAt"]) for m in measured if m.get("metricsUpdatedAt")]
    if stamps:
        totals["updatedAt"] = max(stamps)
    best: str | None = None
    best_views = 0
    for row in rows:  # STATS_ORDER: a tie keeps the earlier platform
        views = (row["metrics"] or {}).get("views")
        if isinstance(views, int | float) and not isinstance(views, bool) and views > best_views:
            best, best_views = row["platform"], int(views)
    starred = clip.get("best") is True
    return {
        "clip": clips.public_clip(clip, media, posts=clip_posts),
        "posts": rows,
        "series": series,
        "totals": totals,
        "bestPlatform": best,
        "bestThisWeek": starred,
        "week": clip.get("bestWeek") if starred and clip.get("bestWeek") else None,
        "weekAnchorAt": anchor_at(clip, clip_posts),
    }


def connect_note(platform: str) -> str:
    return f"Connect {label(platform)} in Settings › Posting › Set up posting."
