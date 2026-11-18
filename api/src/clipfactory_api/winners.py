"""Which posted clips did far better than normal (docs/CONTRACTS.md §16.12, ADR-40).

Every number here is a frozen day-7 view count (``day7.py``). Platforms are never compared with each other or
added up: each post is judged against posts on its own platform only.

* **Baseline** of a post: the same creator's other posts on that platform that have a day-7 number and were posted
  in the last 90 days (the clip under test left out). Fewer than 20 -> every creator's posts on that platform
  (scope "all creators"), also at least 20, each first divided by its own creator's median so a bigger channel's
  normal clips never look like winners (``POOL_MIN_CREATOR_POSTS``). Fewer again -> the post is not judged.
* **Winner**: day-7 views >= 2 x the baseline median AND a robust z-score >= 2.5 on log(1 + views), with the MAD
  floored (``learning_rules.MAD_FLOOR``) so a very even baseline does not make every small bump a winner, at least
  ``WINNER_MIN_VIEWS`` views and a baseline median of at least ``BASELINE_MIN_MEDIAN`` (tiny numbers are noise).
* Each post is judged **once**, in the first run after its day-7 number froze, and the verdict is stored on the post
  (``day7Verdict``, ``settle``): a later shift of the 90-day baseline never turns an old post into a new winner.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .clock import iso, parse
from .creators import ALL_CREATORS
from .learning_rules import (
    BASELINE_DAYS,
    BASELINE_MIN_MEDIAN,
    JUDGE_WITHIN,
    MAD_FLOOR,
    MAD_SCALE,
    MIN_BASELINE,
    POOL_MIN_CREATOR_POSTS,
    WINNER_MIN_VIEWS,
    WINNER_RATIO,
    WINNER_Z,
)

Item = dict[str, Any]


@dataclass(frozen=True)
class Measured:
    """One post with a frozen day-7 number, joined with its clip and creator."""

    post_id: str
    clip_id: str
    source_id: str  # the source video the clip was cut from (its link or upload; the job when unknown)
    platform: str
    creator_key: str | None
    creator_name: str
    views: int
    posted_at: datetime
    clip: Mapping[str, Any] = field(default_factory=dict, compare=False, hash=False)
    post: Mapping[str, Any] = field(default_factory=dict, compare=False, hash=False)


@dataclass(frozen=True)
class Verdict:
    scope: str | None  # "creator", "all", or None (not enough posts to judge)
    winner: bool
    baseline: int  # posts in the baseline used
    median: float | None


def median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    n = len(ordered)
    if n == 0:
        raise ValueError("median of nothing")
    mid = n // 2
    return float(ordered[mid]) if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def robust_z(views: float, baseline: Sequence[float]) -> float:
    """(log(1+v) - median) / (1.4826 x max(MAD, floor)), all on log(1 + views)."""
    logs = [math.log1p(max(0.0, b)) for b in baseline]
    center = median(logs)
    mad = median([abs(x - center) for x in logs])
    return (math.log1p(max(0.0, views)) - center) / (MAD_SCALE * max(mad, MAD_FLOOR))


def is_winner(views: float, baseline: Sequence[float], *, raw_views: int | None = None) -> bool:
    """``raw_views``: the post's real day-7 views when ``views`` is a scaled value (the owner-wide fallback)."""
    if len(baseline) < MIN_BASELINE:
        return False
    if (views if raw_views is None else raw_views) < WINNER_MIN_VIEWS:
        return False
    mid = median(baseline)
    if mid < BASELINE_MIN_MEDIAN:
        return False
    return views > mid and views >= WINNER_RATIO * mid and robust_z(views, baseline) >= WINNER_Z


def pooled(pool: Sequence[Measured], m: Measured) -> tuple[float, list[float], float] | None:
    """The owner-wide comparison for ``m``: (m's scaled views, the scaled baseline, m's own creator median), or None.

    Every post is divided by its own creator's median on this platform (1.0 = normal for that creator) and multiplied
    by the median of those creator medians (a typical creator's size), so channels of very different sizes compare
    fairly. Creators with fewer than ``POOL_MIN_CREATOR_POSTS`` other posts here (or a median of 0) are left out,
    and so is ``m`` when its own creator is one of them. Uploads with no creator count as one creator."""
    by_creator: dict[str | None, list[Measured]] = {}
    for q in pool:
        if q.clip_id != m.clip_id:
            by_creator.setdefault(q.creator_key, []).append(q)
    medians: dict[str | None, float] = {}
    for key, rows in by_creator.items():
        if len(rows) >= POOL_MIN_CREATOR_POSTS:
            mid = median([q.views for q in rows])
            if mid > 0:
                medians[key] = mid
    if m.creator_key not in medians:
        return None
    members = [q for key, rows in by_creator.items() if key in medians for q in rows]
    if len(members) < MIN_BASELINE:
        return None
    scale = median(list(medians.values()))
    base = [q.views / medians[q.creator_key] * scale for q in members]
    return m.views / medians[m.creator_key] * scale, base, medians[m.creator_key]


def recent(measured: Iterable[Measured], now: datetime) -> list[Measured]:
    """Posts made in the last ``BASELINE_DAYS`` days (both the clips judged and their baselines)."""
    since = now - timedelta(days=BASELINE_DAYS)
    return [m for m in measured if m.posted_at >= since]


def judge(measured: Sequence[Measured]) -> dict[str, Verdict]:
    """A verdict for every post (by post id). ``measured`` must already be limited to the last 90 days."""
    out: dict[str, Verdict] = {}
    by_platform: dict[str, list[Measured]] = {}
    for m in measured:
        by_platform.setdefault(m.platform, []).append(m)
    for pool in by_platform.values():
        for m in pool:
            own = [q.views for q in pool if m.creator_key and q.creator_key == m.creator_key and q.clip_id != m.clip_id]
            if len(own) >= MIN_BASELINE:
                out[m.post_id] = Verdict("creator", is_winner(m.views, own), len(own), median(own))
                continue
            fair = pooled(pool, m)
            if fair is not None:
                scaled, base, own_median = fair
                out[m.post_id] = Verdict("all", is_winner(scaled, base, raw_views=m.views), len(base), own_median)
            else:
                out[m.post_id] = Verdict(None, False, sum(1 for q in pool if q.clip_id != m.clip_id), None)
    return out


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def stored_verdict(post: Mapping[str, Any]) -> Verdict | None:
    raw = post.get("day7Verdict")
    if not isinstance(raw, Mapping) or raw.get("scope") not in ("creator", "all"):
        return None
    base = _number(raw.get("baseline"))
    return Verdict(str(raw["scope"]), raw.get("winner") is True, int(base or 0), _number(raw.get("median")))


def verdict_item(v: Verdict, now: datetime) -> dict[str, Any]:
    """What is stored on the post (``day7Verdict``): judged once, traceable."""
    out: dict[str, Any] = {"scope": v.scope, "winner": v.winner, "baseline": v.baseline, "judgedAt": iso(now)}
    if v.median is not None:
        out["median"] = round(v.median, 2)
    return out


def settle(
    measured: Sequence[Measured], current: Mapping[str, Verdict], now: datetime
) -> tuple[dict[str, Verdict], dict[str, Verdict]]:
    """(the verdict to use for every post, the verdicts to store now).

    A stored verdict always wins. A post without one is judged now only within ``JUDGE_WITHIN`` of its day-7 number
    freezing; later it counts as a normal clip and is never judged (the baseline it would meet is not its own)."""
    out: dict[str, Verdict] = {}
    new: dict[str, Verdict] = {}
    for m in measured:
        stored = stored_verdict(m.post)
        if stored is not None:
            out[m.post_id] = stored
            continue
        v = current.get(m.post_id) or Verdict(None, False, 0, None)
        frozen_at = parse(m.post.get("day7CheckedAt")) or parse(m.post.get("day7At"))
        if v.scope is not None and frozen_at is not None and now - frozen_at <= JUDGE_WITHIN:
            out[m.post_id] = v
            new[m.post_id] = v
        else:
            out[m.post_id] = Verdict(v.scope, False, v.baseline, v.median)
    return out, new


@dataclass
class Group:
    """Where a lesson can come from: one creator (or every creator) on one platform."""

    creator_key: str  # ALL_CREATORS for the owner-wide group
    creator_name: str
    platform: str
    scope: str  # "creator" | "all"
    population: list[Measured]  # every measured post the group compares
    winners: list[Measured]

    @property
    def others(self) -> list[Measured]:
        ids = {w.post_id for w in self.winners}
        return [m for m in self.population if m.post_id not in ids]

    @property
    def median_views(self) -> float | None:
        return median([m.views for m in self.population]) if self.population else None


def groups(measured: Sequence[Measured], verdicts: Mapping[str, Verdict]) -> list[Group]:
    """One group per (creator, platform) judged on its own baseline, and one "all creators" group per platform for
    the posts judged on the owner-wide baseline. Winners of one group never count as normal clips in another."""
    winners_anywhere = {pid for pid, v in verdicts.items() if v.winner}
    out: list[Group] = []
    by_platform: dict[str, list[Measured]] = {}
    for m in measured:
        by_platform.setdefault(m.platform, []).append(m)
    for platform in sorted(by_platform):
        pool = by_platform[platform]
        creators: dict[str, list[Measured]] = {}
        for m in pool:
            if m.creator_key and verdicts.get(m.post_id, Verdict(None, False, 0, None)).scope == "creator":
                creators.setdefault(m.creator_key, [])
        for key in sorted(creators):
            members = [m for m in pool if m.creator_key == key]
            wins = [m for m in members if verdicts[m.post_id].scope == "creator" and verdicts[m.post_id].winner]
            name = next((m.creator_name for m in members if m.creator_name), "")
            mine = {w.post_id for w in wins}
            population = [m for m in members if m.post_id not in winners_anywhere or m.post_id in mine]
            out.append(Group(key, name, platform, "creator", population, wins))
        if any(verdicts.get(m.post_id) and verdicts[m.post_id].scope == "all" for m in pool):
            wins = [m for m in pool if verdicts[m.post_id].scope == "all" and verdicts[m.post_id].winner]
            mine = {w.post_id for w in wins}
            population = [m for m in pool if m.post_id not in winners_anywhere or m.post_id in mine]
            out.append(Group(ALL_CREATORS, "", platform, "all", population, wins))
    return out


def needed(measured: Sequence[Measured], creator_key: str | None) -> dict[str, int]:
    """Per platform: how many more measured posts this creator needs before its own clips can be judged on their own
    baseline (a post's baseline leaves the post itself out, so ``MIN_BASELINE + 1`` posts are needed)."""
    out: dict[str, int] = {}
    for m in measured:
        out.setdefault(m.platform, 0)
    for platform in out:
        count = sum(1 for m in measured if m.platform == platform and m.creator_key == creator_key)
        out[platform] = max(0, MIN_BASELINE + 1 - count)
    return out
