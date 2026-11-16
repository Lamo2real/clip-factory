"""``refresh_posts``: the one code path that reads a post's numbers (docs/CONTRACTS.md §16.5).

The 15-minute poller (``reason="poll"``), the Refresh button (``"manual"``, through ``cf-prod-stats``) and the
clip-flow's ``metrics`` step (``"flow"``) all come here, so every read goes through the same rate budget.

Per platform, in ``STATS_ORDER``: no connected account or no token → ``not_connected`` (no HTTP and no budget
spent); a blocked budget → ``blocked``; else for each ``idsPerRequest`` chunk: ``budget.reserve`` →
``adapter.fetch_stats`` (5xx and network errors are tried twice more, after 1 s and 4 s; a Meta throttle never) →
``budget.record`` → one UpdateItem per post, plus a STAT# snapshot when it is due. A failing read sets ``statsError``
and pushes ``statsDueAt`` one interval on, so a broken post never loops. A post that could not be read at all
(``not_connected``, ``blocked``) is pushed on too, without an error: one interval on, or to ``blockedUntil``; a
never-connected post past ``pollWindowDays`` leaves the poll index for good. Only the time-budget ``deferred`` posts
stay due for the next tick.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .. import db, posts
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from ..platforms import NotConnectedError, PublishError, StatsBatch, adapter_for, label
from ..platforms.base import HttpClient, NetworkError, ResponseMeta, stats_id, urllib_client
from . import STATS_ORDER, budget, config

Item = dict[str, Any]
COMMON = ("views", "likes", "comments", "shares")
RETRY_DELAYS = (1.0, 4.0)
SNAPSHOT_MIN_GAP = timedelta(minutes=15)
SNAPSHOT_CHANGE = 0.01
REASONS = ("poll", "manual", "flow")


@dataclass
class StatsDeps:
    store: db.Store
    http: HttpClient = urllib_client
    adapters: Callable[[str], Any] = adapter_for
    clock: Clock = utcnow
    sleep: Callable[[float], None] = time.sleep
    monotonic: Callable[[], float] = time.monotonic
    accounts: Callable[[db.Store, str, str], Item | None] = posts.connected_account
    time_budget_seconds: float = 240.0
    cfg: config.PlatformsConfig | None = None

    @property
    def config(self) -> config.PlatformsConfig:
        if self.cfg is None:
            self.cfg = config.load()
        return self.cfg


@dataclass
class RefreshReport:
    updated: dict[str, Item] = field(default_factory=dict)  # postId → the merged PostMetrics
    outcomes: dict[str, str] = field(default_factory=dict)  # postId → updated | error | not_connected | blocked | ...
    errors: dict[str, str] = field(default_factory=dict)
    blocked: list[str] = field(default_factory=list)
    requests: int = 0

    def mark(self, items: Iterable[Item], outcome: str) -> None:
        for item in items:
            self.outcomes.setdefault(str(item["postId"]), outcome)


def merge_metrics(old: Item | None, fast: Item | None, slow: Item | None, now: datetime) -> Item:
    """The new ``Post.metrics``: fast fields + ``metricsUpdatedAt`` when counts were read, slow fields +
    ``insightsUpdatedAt`` when insights were read; everything not read keeps its stored value."""
    old = dict(old or {})
    out: Item = {k: old.get(k) for k in COMMON}
    extra: Item = dict(old.get("extra") or {})
    stamp = iso(now)
    updated_at = old.get("metricsUpdatedAt") or old.get("checkedAt")
    for part, kind in ((fast, "fast"), (slow, "slow")):
        if part is None:
            continue
        for key in COMMON:
            if key in part:
                out[key] = part[key]
        extra.update(part.get("extra") or {})
        if kind == "fast":
            updated_at = stamp
        else:
            out["insightsUpdatedAt"] = stamp
    if "insightsUpdatedAt" not in out and old.get("insightsUpdatedAt"):
        out["insightsUpdatedAt"] = old["insightsUpdatedAt"]
    if updated_at is None:
        updated_at = stamp
    out["metricsUpdatedAt"] = updated_at
    out["checkedAt"] = updated_at
    if old.get("final"):
        out["final"] = True
    out["extra"] = extra
    return out


def snapshot_due(post: Item, views: int | None, now: datetime, *, every_minutes: int, final: bool) -> bool:
    """§16.3: no snapshot yet, ≥ ``snapshotEveryMinutes`` since the last, views moved ≥ 1 % and ≥ 15 min passed, or the
    final read."""
    last = parse(post.get("lastSnapshotAt"))
    if final or last is None:
        return True
    gap = now - last
    if gap >= timedelta(minutes=every_minutes):
        return True
    if gap < SNAPSHOT_MIN_GAP:
        return False
    before = post.get("lastSnapshotViews")
    if views is None:
        return False
    if not isinstance(before, int | float) or before <= 0:
        return views > 0
    return abs(views - before) / before >= SNAPSHOT_CHANGE


def _in_window(post: Item) -> bool:
    return post.get("gsi2pk") == db.STATS_GSI_PK


def write_result(deps: StatsDeps, post: Item, fast: Item | None, slow: Item | None, now: datetime) -> Item:
    cfg = deps.config
    platform = str(post["platform"])
    old = post.get("metrics") if isinstance(post.get("metrics"), dict) else None
    metrics = merge_metrics(old, fast, slow, now)
    posted_at = parse(post.get("postedAt"))
    newly_final = not metrics.get("final") and config.is_final_age(cfg, posted_at, now) and _in_window(post)
    if newly_final:
        metrics["final"] = True
    sets: Item = {"metrics": metrics}
    remove = ["statsError"]
    if not metrics.get("final"):
        due = iso(now + timedelta(minutes=config.interval_for(cfg, platform, posted_at, now)))
        sets["statsDueAt"] = due
        if _in_window(post):
            sets["gsi2sk"] = f"{due}#{post['postId']}"
    else:
        remove += ["gsi2pk", "gsi2sk"]
    insights_every = cfg.platform(platform).insights_interval
    if slow is not None and insights_every:
        sets["insightsDueAt"] = iso(now + timedelta(minutes=insights_every))
    views = metrics.get("views")
    snap = snapshot_due(post, views, now, every_minutes=cfg.snapshot_every_minutes, final=bool(newly_final))
    if snap:
        sets["lastSnapshotAt"] = iso(now)
        if views is None:
            remove.append("lastSnapshotViews")  # internal: the views of the last snapshot, for the 1 % rule
        else:
            sets["lastSnapshotViews"] = views
    try:
        deps.store.update(post["pk"], post["sk"], sets, remove=remove)
    except db.ConditionFailed:
        log("warning", "stats.post_gone", postId=post.get("postId"))
        return metrics
    if snap:
        _put_snapshot(deps, post, metrics, now, final=bool(newly_final))
    return metrics


def _put_snapshot(deps: StatsDeps, post: Item, metrics: Item, now: datetime, *, final: bool) -> None:
    at = iso(now)
    item: Item = {
        "pk": post["pk"],
        "sk": db.stat_sk(str(post["postId"]), at),
        "type": "stat",
        "userId": post.get("userId"),
        "postId": post["postId"],
        "clipId": post.get("clipId"),
        "platform": post["platform"],
        "at": at,
        "ttl": int((now + timedelta(days=deps.config.snapshot_ttl_days)).timestamp()),
        **{k: metrics.get(k) for k in COMMON},  # None values are left out: "the platform does not say"
    }
    if final:
        item["final"] = True
    deps.store.put(item)


def write_error(deps: StatsDeps, post: Item, text: str, now: datetime) -> None:
    posted_at = parse(post.get("postedAt"))
    due = iso(now + timedelta(minutes=config.interval_for(deps.config, str(post["platform"]), posted_at, now)))
    sets: Item = {"statsError": text[:300], "statsDueAt": due}
    if _in_window(post):
        sets["gsi2sk"] = f"{due}#{post['postId']}"
    try:
        deps.store.update(post["pk"], post["sk"], sets)
    except db.ConditionFailed:
        log("warning", "stats.post_gone", postId=post.get("postId"))


def write_skipped(deps: StatsDeps, post: Item, now: datetime, *, until: datetime | None = None) -> None:
    """No read happened (no connected account, or the platform's budget is blocked): move the post on in the poll
    index so it does not sit at the head of ``gsi2`` and get re-read every tick. Blocked → due at ``until`` (when
    the block ends); not connected → one interval on, and once the post is past ``pollWindowDays`` it leaves the
    index (no final read is possible; a manual refresh still works). No ``statsError``: nothing went wrong."""
    if not _in_window(post):
        return
    cfg = deps.config
    posted_at = parse(post.get("postedAt"))
    sets: Item = {}
    remove: list[str] = []
    if until is None and config.is_final_age(cfg, posted_at, now):
        remove = ["gsi2pk", "gsi2sk"]
    else:
        at = until if until is not None and until > now else None
        if at is None:
            at = now + timedelta(minutes=config.interval_for(cfg, str(post["platform"]), posted_at, now))
        due = iso(at)
        sets = {"statsDueAt": due, "gsi2sk": f"{due}#{post['postId']}"}
    try:
        deps.store.update(post["pk"], post["sk"], sets, remove=remove)
    except db.ConditionFailed:
        log("warning", "stats.post_gone", postId=post.get("postId"))


def _skip(
    deps: StatsDeps,
    report: RefreshReport,
    rows: list[Item],
    outcome: str,
    now: datetime,
    *,
    until: datetime | None = None,
) -> None:
    report.mark(rows, outcome)
    for post in rows:
        if report.outcomes.get(str(post["postId"])) == outcome:  # only the posts this outcome applies to
            write_skipped(deps, post, now, until=until)


def _fetch(
    deps: StatsDeps, adapter: Any, chunk: list[Item], account: Item, now: datetime, *, insights: bool
) -> StatsBatch:
    """One chunk, with two more tries on 5xx/network errors (never on a Meta throttle, which is a 4xx)."""
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            batch: StatsBatch = adapter.fetch_stats(chunk, account, now=now, want_insights=insights, http=deps.http)
        except NetworkError as e:
            if attempt < len(RETRY_DELAYS):
                deps.sleep(RETRY_DELAYS[attempt])
                continue
            failed = StatsBatch(meta=ResponseMeta(status=599, error_code="network"))
            failed.errors = {str(p["postId"]): f"Could not reach {label(adapter.platform)} ({e})." for p in chunk}
            return failed
        if batch.meta.status >= 500 and attempt < len(RETRY_DELAYS):
            deps.sleep(RETRY_DELAYS[attempt])
            continue
        return batch
    raise AssertionError("unreachable")


def _cost(platform: str, chunk: list[Item], deps: StatsDeps, now: datetime) -> int:
    if platform == "x":
        limit = deps.config.platform("x").non_public_max_age_days or 30
        ages = {(now - (parse(p.get("postedAt")) or now)) >= timedelta(days=limit) for p in chunk}
        return len(ages)  # young and old posts go in separate requests
    p = deps.config.platform(platform)
    if p.budget_kind == "daily_units":
        # YouTube Data API units: ``unitsPerCall`` per videos.list request, one request per ``idsPerRequest`` ids
        # (posts without a YouTube id are not sent). The insights report goes to the YouTube Analytics API, which
        # has its own quota, so it is not charged to this budget.
        ids = sum(1 for post in chunk if stats_id(post))
        return int(p.budget["unitsPerCall"]) * math.ceil(ids / p.ids_per_request)
    return 1


def refresh_posts(
    deps: StatsDeps,
    items: list[Item],
    *,
    reason: str,
    now: datetime,
) -> RefreshReport:
    """Reads fresh numbers for ``items`` (Post items, internal fields included) and writes them back."""
    if reason not in REASONS:
        raise ValueError(f"unknown refresh reason: {reason}")
    cfg = deps.config
    report = RefreshReport()
    started = deps.monotonic()
    readable: dict[tuple[str, str], list[Item]] = {}
    for item in items:
        if item.get("status") != "posted":
            report.mark([item], "not_posted")
        elif item.get("privacy") == "private":
            report.mark([item], "private")
        elif item.get("platform") not in STATS_ORDER:
            report.mark([item], "not_posted")
        else:
            readable.setdefault((str(item["platform"]), str(item.get("userId") or "")), []).append(item)
    for platform in STATS_ORDER:
        groups = [(user, rows) for (p, user), rows in readable.items() if p == platform]
        for user_id, rows in groups:
            _refresh_platform(
                deps, report, platform, user_id=user_id, rows=rows, now=now, reason=reason, started=started, cfg=cfg
            )
    return report


def _refresh_platform(
    deps: StatsDeps,
    report: RefreshReport,
    platform: str,
    *,
    user_id: str,
    rows: list[Item],
    now: datetime,
    reason: str,
    started: float,
    cfg: config.PlatformsConfig,
) -> None:
    account = deps.accounts(deps.store, user_id, platform)
    if account is None:
        _skip(deps, report, rows, "not_connected", now)
        return
    adapter = deps.adapters(platform)
    token_check = getattr(adapter, "token", None)  # AdapterBase.token; the §16.5 StatsAdapter may lack it
    try:
        if callable(token_check):
            token_check(account)  # no token (not connected, or revoked) → stop before any budget is spent
    except (NotConnectedError, PublishError):  # ReconnectNeededError, a refresh that could not run: skipped (§17.6)
        _skip(deps, report, rows, "not_connected", now)
        return
    until = budget.blocked_until(budget.get_budget(deps.store, platform), now)
    if until is not None:
        _skip(deps, report, rows, "blocked", now, until=until)
        report.blocked.append(platform)
        return
    size = cfg.platform(platform).ids_per_request
    pending = list(rows)
    while pending:
        chunk, pending = pending[:size], pending[size:]
        if reason == "poll" and deps.monotonic() - started >= deps.time_budget_seconds:
            report.mark([*chunk, *pending], "deferred")  # still due: the next tick reads them
            return
        insights = platform == "youtube" and any((parse(p.get("insightsDueAt")) or now) <= now for p in chunk)
        ids = [str(p.get("statsId")) for p in chunk if p.get("statsId")]
        reservation = budget.reserve(deps.store, platform, _cost(platform, chunk, deps, now), now, ids=ids, cfg=cfg)
        if isinstance(reservation, budget.Blocked):
            _skip(deps, report, [*chunk, *pending], "blocked", now, until=reservation.next_allowed_at)
            report.blocked.append(platform)
            return
        try:
            batch = _fetch(deps, adapter, chunk, account, now, insights=insights)
        except (NotConnectedError, PublishError):
            _skip(deps, report, [*chunk, *pending], "not_connected", now)
            return
        report.requests += batch.requests
        blocked_at = budget.record(deps.store, platform, batch.meta, now, cfg=cfg)
        for post in chunk:
            post_id = str(post["postId"])
            fast, slow = batch.results.get(post_id), batch.insights.get(post_id)
            if fast is not None or slow is not None:
                report.updated[post_id] = write_result(deps, post, fast, slow, now)
                report.outcomes[post_id] = "updated"
            elif blocked_at is not None and post_id not in batch.errors:
                _skip(deps, report, [post], "blocked", now, until=blocked_at)
            else:
                text = batch.errors.get(post_id) or f"{label(platform)} sent no numbers this time."
                report.errors[post_id] = text
                report.outcomes[post_id] = "error"
                write_error(deps, post, text, now)
        if blocked_at is not None:
            _skip(deps, report, pending, "blocked", now, until=blocked_at)
            report.blocked.append(platform)
            return
