"""The day-7 number of a post: its views about 7 days after posting, frozen once (docs/CONTRACTS.md §16.12).

The stats poller keeps STAT# snapshots of every post (§16.3). Once a post's window (6.5 to 8.5 days after posting)
has closed, ``choose`` picks the reading closest to 7 days inside it and ``freeze`` writes it on the Post:

* ``day7``: the views of that reading (``0`` only when the platform said 0; a reading without views is not a reading)
* ``day7At``: when those views were read; ``day7Source``: ``{statKey, viewsReadAt}``, so every number can be traced
* ``day7State``: ``"frozen"``, or ``"missing"`` when no reading was taken in the window. Missing stays missing:
  nothing is guessed, stretched, copied from a later reading or set to 0.

Which time counts is when the views were READ, not when the snapshot was written: a refresh that did not read views
(only the insights on YouTube, only the counts on Instagram or Facebook) writes a snapshot with the old views (§16.5),
so each new snapshot carries ``viewsReadAt`` (= ``metrics.viewsUpdatedAt``, stamped only by the part that carried
views). A snapshot written before that field existed counts (at its ``at``) only when its
views differ from the snapshot before it, which proves they were freshly read.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from . import db
from .clock import iso, parse
from .learning_rules import DAY7_EARLIEST, DAY7_LATEST, DAY7_TARGET
from .log import log

Item = dict[str, Any]
FIELDS = ("day7", "day7At", "day7Source", "day7State", "day7CheckedAt", "day7Verdict")


@dataclass(frozen=True)
class Reading:
    views: int
    read_at: datetime
    stat_key: str


def _views(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value)


def readings(snapshots: Sequence[Mapping[str, Any]]) -> list[Reading]:
    """The real views readings among a post's snapshots (any order in, oldest snapshot first inside)."""
    ordered = sorted(snapshots, key=lambda s: (str(s.get("at") or ""), str(s.get("sk") or "")))
    out: list[Reading] = []
    seen: set[str] = set()
    previous: Mapping[str, Any] | None = None
    for snap in ordered:
        views = _views(snap.get("views"))
        read_at = parse(snap.get("viewsReadAt"))
        if read_at is None:
            # Written before viewsReadAt existed: only a change of views proves a fresh read at `at`.
            before = _views(previous.get("views")) if previous is not None else None
            if previous is not None and views is not None and before is not None and views != before:
                read_at = parse(snap.get("at"))
        previous = snap
        if views is None or read_at is None:
            continue
        stamp = iso(read_at)
        if stamp in seen:  # several snapshots can repeat one read (insights-only refreshes): the first one counts
            continue
        seen.add(stamp)
        out.append(Reading(views, read_at, str(snap.get("sk") or "")))
    return out


def choose(posted_at: datetime, snapshots: Sequence[Mapping[str, Any]]) -> Reading | None:
    """The reading closest to 7 days after posting, read between 6.5 and 8.5 days after it; ties -> the earlier."""
    lo, hi, target = posted_at + DAY7_EARLIEST, posted_at + DAY7_LATEST, posted_at + DAY7_TARGET
    inside = [r for r in readings(snapshots) if lo <= r.read_at <= hi]
    if not inside:
        return None
    return min(inside, key=lambda r: (abs((r.read_at - target).total_seconds()), r.read_at))


def due(post: Mapping[str, Any], now: datetime) -> bool:
    """A posted post whose window has closed and that has no day-7 answer yet."""
    if post.get("type") != "post" or post.get("status") != "posted" or post.get("day7State"):
        return False
    posted_at = parse(post.get("postedAt"))
    return posted_at is not None and now >= posted_at + DAY7_LATEST


def freeze(store: db.Store, post: Mapping[str, Any], now: datetime) -> str:
    """Writes the post's day-7 answer once; returns ``frozen``, ``missing`` or ``skipped`` (already answered)."""
    posted_at = parse(post.get("postedAt"))
    if posted_at is None:
        return "skipped"
    snapshots = store.query_all(str(post["pk"]), db.stat_prefix(str(post["postId"])))
    reading = choose(posted_at, snapshots)
    fields: Item = {"day7CheckedAt": iso(now)}
    if reading is None:
        fields["day7State"] = "missing"
    else:
        fields.update(
            {
                "day7State": "frozen",
                "day7": reading.views,
                "day7At": iso(reading.read_at),
                "day7Source": {"statKey": reading.stat_key, "viewsReadAt": iso(reading.read_at)},
            }
        )
    try:
        # Only once: a second run (or the automatic retry) finds day7State set and changes nothing. A number is only
        # written while the post still has its platform numbers: a disconnect (stats ``forget``) that ran after the
        # snapshots were read removed ``metrics``, so a forgotten platform's number never comes back.
        store.update(
            str(post["pk"]),
            str(post["sk"]),
            fields,
            expect_absent=["day7State"],
            expect_present=["metrics"] if reading is not None else (),
        )
    except db.ConditionFailed:
        return "skipped"
    log("info", "learn.day7", postId=post.get("postId"), state=fields["day7State"])
    return str(fields["day7State"])


def day7_views(post: Mapping[str, Any]) -> int | None:
    """The frozen day-7 views of a post, or None (missing, not frozen yet, or forgotten)."""
    if post.get("day7State") != "frozen":
        return None
    return _views(post.get("day7"))
