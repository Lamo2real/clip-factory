"""Library › This week: a week's kept clips sorted by views and the owner's "Best this week" picks (§16.2, §16.3).

A week is an ISO week id (``2026-W46``). The web sends the owner's local Monday 00:00 and next Monday 00:00 as UTC
instants (``from``/``to``), so a week follows the owner's time zone (167 or 169 hours around a DST change). A clip
belongs to the week holding its anchor: its earliest ``postedAt``, else ``decidedAt`` (kept, not posted yet).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from . import clips, db, s3
from .clock import parse
from .performance import anchor_at, latest_by_platform
from .stats import STATS_ORDER

Item = dict[str, Any]
WEEK_ID = re.compile(r"^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$")
WEEK_STATUSES = frozenset({"confirmed", "publishing", "posted", "failed"})
MIN_HOURS, MAX_HOURS = 167, 169
MONDAY_SLACK = timedelta(hours=14)
MAX_PICKS = 10
LEARN_STATES = ("none", "learning", "done", "skipped", "failed")
SUMMARY_FIELDS = ("week", "from", "to", "clipIds", "savedAt", "learnState", "learningId")
BAD_WEEK = "That week does not look right. Go back to This week."
TOTAL_FIELDS = ("views", "likes", "comments", "shares")


def iso_monday(week: str) -> datetime | None:
    """00:00 UTC of the ISO Monday of ``week``, or None when the id is not a real ISO week (e.g. W53 of a year
    that has only 52)."""
    m = WEEK_ID.match(week or "")
    if not m:
        return None
    try:
        return datetime.fromisocalendar(int(m.group(1)), int(m.group(2)), 1).replace(tzinfo=UTC)
    except ValueError:
        return None


def week_bounds_ok(week: str, from_: str | None, to: str | None) -> tuple[datetime, datetime] | None:
    """The parsed (from, to) when they fit ``week``: 167–169 hours apart and ``from`` within 14 h of the ISO
    Monday 00:00 UTC (every time zone's local Monday midnight is). None otherwise."""
    monday = iso_monday(week)
    start, end = parse(from_), parse(to)
    if monday is None or start is None or end is None:
        return None
    hours = (end - start).total_seconds() / 3600
    if not MIN_HOURS <= hours <= MAX_HOURS or abs(start - monday) > MONDAY_SLACK:
        return None
    return start, end


def public_week(item: Mapping[str, Any]) -> Item:
    """``WeekSummary`` (also the ``week`` live event). Internal fields (``revision``, ``unpickedClipIds``) stay."""
    out: Item = {k: item[k] for k in SUMMARY_FIELDS if k in item and item[k] is not None}
    out["clipIds"] = [str(c) for c in item.get("clipIds") or []]
    if out.get("learnState") not in LEARN_STATES:
        out["learnState"] = "none"
    return out


def get_week(store: db.Store, user_id: str, week: str) -> Item | None:
    return store.get(db.user_pk(user_id), db.week_sk(week))


def _views_of(post: Item) -> int | None:
    metrics = post.get("metrics")
    views = metrics.get("views") if isinstance(metrics, dict) else None
    return int(views) if isinstance(views, int | float) and not isinstance(views, bool) else None


def week_entries(store: db.Store, user_id: str, start: datetime, end: datetime) -> list[tuple[Item, list[Item], str]]:
    """(Clip item, its posts, anchorAt) for every kept clip anchored in [start, end). Single owner: reading all of
    the owner's clips and posts is small, and the filter runs here."""
    pk = db.user_pk(user_id)
    clip_items = [c for c in store.query_all(pk, "CLIP#") if c.get("type") == "clip"]
    by_clip = clips.posts_by_clip([p for p in store.query_all(pk, "POST#") if p.get("type") == "post"])
    out = []
    for clip in clip_items:
        if clip.get("status") not in WEEK_STATUSES:
            continue
        clip_posts = by_clip.get(str(clip["clipId"]), [])
        anchor = anchor_at(clip, clip_posts)
        moment = parse(anchor)
        if moment is not None and start <= moment < end:
            out.append((clip, clip_posts, anchor))
    return out


def week_clip(clip: Item, clip_posts: list[Item], anchor: str, week: str, media: s3.Media | None) -> Item:
    by_platform = latest_by_platform(clip_posts)
    measured = [p for p in clip_posts if p.get("status") == "posted" and isinstance(p.get("metrics"), dict)]
    totals = {
        k: sum(
            int(v) if isinstance(v := p["metrics"].get(k), int | float) and not isinstance(v, bool) else 0
            for p in measured
        )
        for k in TOTAL_FIELDS
    }
    views: Item = {}
    for platform in STATS_ORDER:
        post = by_platform.get(platform)
        if post is not None and post.get("status") == "posted":
            views[platform] = _views_of(post)
    return {
        "clip": clips.public_clip(clip, media, posts=clip_posts, video=False),
        "anchorAt": anchor,
        "posted": any(p.get("status") == "posted" for p in clip_posts),
        "totals": totals,
        "views": views,
        "best": clip.get("best") is True and clip.get("bestWeek") == week,
    }


def week_clips(
    store: db.Store, user_id: str, from_: datetime, to: datetime, *, week: str = "", media: s3.Media | None = None
) -> list[Item]:
    """The week's ``WeekClip[]``, sorted by total views (high first), then newest anchor first."""
    rows = [week_clip(c, p, a, week, media) for c, p, a in week_entries(store, user_id, from_, to)]
    rows.sort(key=lambda r: str(r["anchorAt"]), reverse=True)
    rows.sort(key=lambda r: int(r["totals"]["views"]), reverse=True)
    return rows


def summary_for(item: Item | None, week: str, from_: str, to: str) -> Item:
    if item is None:
        return {"week": week, "from": from_, "to": to, "clipIds": [], "learnState": "none"}
    return public_week(item)


def week_view(
    store: db.Store,
    user_id: str,
    week: str,
    *,
    start: datetime,
    end: datetime,
    from_: str,
    to: str,
    media: s3.Media | None = None,
    item: Item | None = None,
) -> Item:
    from .learn import public_learning

    item = item if item is not None else get_week(store, user_id, week)
    view = summary_for(item, week, from_, to)
    view["clips"] = week_clips(store, user_id, start, end, week=week, media=media)
    # A stored pick whose clip has since moved to another week (its first post landed after Sunday) is not shown
    # as picked here; the next save of this week drops it (routes/weeks.py).
    listed = {str(row["clip"]["clipId"]) for row in view["clips"]}
    view["clipIds"] = [c for c in view["clipIds"] if c in listed]
    learning_id = (item or {}).get("learningId")
    if learning_id:
        learning = store.get(db.user_pk(user_id), db.learning_sk(str(learning_id)))
        if learning is not None:
            view["learning"] = public_learning(learning)
    return view


def posted_post_ids(clip_posts: list[Item]) -> list[str]:
    return [str(p["postId"]) for p in clip_posts if p.get("status") == "posted"]
