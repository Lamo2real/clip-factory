"""/v1/clips/{clipId}/performance and /v1/clips/{clipId}/stats/refresh (docs/CONTRACTS.md §16.2).

Refresh never bypasses a platform's limits: each post is claimed with one conditional write (a manual cooldown per
platform, and no second refresh while one is running), a blocked platform budget answers ``blocked``, and the
reading itself runs in ``cf-prod-stats`` (async Invoke), which goes through the same rate budget as the poller.
The new numbers reach the page as ``post`` events on the WebSocket.
"""

from __future__ import annotations

import contextlib
from datetime import datetime, timedelta
from typing import Any

from .. import db, performance, posts
from ..app import App
from ..async_invoke import InvokeError
from ..clock import iso
from ..errors import bad_request, not_found
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log
from ..platforms import label
from ..stats import STATS_ORDER, budget, config

SETTLE_NOTE = "{label} numbers can take up to 2 days to settle."
SLOW_PLATFORMS = frozenset({"instagram", "facebook"})
PRIVATE_NOTE = "TikTok shows numbers after the app is approved."
TRY_LATER_NOTE = "Could not check right now. Try again in a minute."
CLAIM_SECONDS = 300


def _clip_with_numbers(app: App, req: Request) -> dict[str, Any]:
    clip_id = req.params["clipId"]
    item = app.store.get(db.user_pk(req.user_id), db.clip_sk(clip_id)) if is_ulid(clip_id) else None
    if item is None or item.get("type") != "clip":
        raise not_found("We could not find that clip.")
    if item.get("status") in performance.NO_NUMBERS_STATUSES:
        raise not_found(performance.NO_NUMBERS_YET)
    return item


def get_performance(app: App, req: Request) -> Response:
    clip = _clip_with_numbers(app, req)
    found = posts.posts_for_clip(app.store, req.user_id, clip["clipId"])
    latest = performance.latest_by_platform(found)
    pk = db.user_pk(req.user_id)
    # The newest 500 snapshots (read newest first so the latest point is never cut off), oldest first again in
    # ``series_for``.
    snapshots = {
        str(p["postId"]): app.store.query_page(
            pk, db.stat_prefix(str(p["postId"])), limit=performance.MAX_SNAPSHOTS, newest_first=True
        ).items
        for p in latest.values()
        if p.get("status") == "posted"
    }
    body = performance.public_performance(
        clip, found, posts.accounts(app.store, req.user_id), snapshots, app.clock(), media=app.media
    )
    return ok(body)


def _requested(body: dict[str, Any]) -> list[str]:
    raw = body.get("platforms")
    if raw is None:
        return list(STATS_ORDER)
    if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
        raise bad_request("platforms must be a list of platform names.")
    unknown = [p for p in raw if p not in STATS_ORDER]
    if unknown:
        raise bad_request(f"Unknown platform: {unknown[0]}.")
    return [p for p in STATS_ORDER if p in raw]


def _claim(app: App, post: dict[str, Any], now: datetime, cooldown_minutes: int) -> tuple[bool, str | None]:
    """One conditional UpdateItem: no cooldown running and no refresh started in the last 5 minutes."""
    next_at = iso(now + timedelta(minutes=cooldown_minutes))
    try:
        app.store.update_expr(
            str(post["pk"]),
            str(post["sk"]),
            "SET #started = :now, #next = :next",
            condition=(
                "attribute_exists(pk) AND #status = :posted"
                " AND (attribute_not_exists(#next) OR #next <= :now)"
                " AND (attribute_not_exists(#started) OR #started < :stale)"
            ),
            names={"#started": "refreshStartedAt", "#next": "nextRefreshAt", "#status": "status"},
            values={
                ":now": iso(now),
                ":next": next_at,
                ":stale": iso(now - timedelta(seconds=CLAIM_SECONDS)),
                ":posted": "posted",
            },
        )
    except db.ConditionFailed:
        current = app.store.get(str(post["pk"]), str(post["sk"])) or {}
        stored = current.get("nextRefreshAt")
        return False, stored if isinstance(stored, str) else None
    return True, next_at


def refresh(app: App, req: Request) -> Response:
    body = req.json()
    if set(body) - {"platforms"}:
        raise bad_request(f"Unknown field: {sorted(set(body) - {'platforms'})[0]}.")
    wanted = _requested(body)
    clip = _clip_with_numbers(app, req)
    now = app.clock()
    cfg = config.load()
    latest = performance.latest_by_platform(posts.posts_for_clip(app.store, req.user_id, clip["clipId"]))
    results: list[dict[str, Any]] = []
    started: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for platform in wanted:
        post = latest.get(platform)
        name = label(platform)
        if post is None or post.get("status") != "posted":
            results.append({"platform": platform, "status": "not_posted"})
            continue
        if post.get("privacy") == "private":
            results.append({"platform": platform, "status": "private", "note": PRIVATE_NOTE})
            continue
        if posts.connected_account(app.store, req.user_id, platform) is None:
            results.append(
                {"platform": platform, "status": "not_connected", "note": performance.connect_note(platform)}
            )
            continue
        until = budget.blocked_until(budget.get_budget(app.store, platform), now)
        if until is not None:
            results.append({"platform": platform, "status": "blocked", "nextAllowedAt": iso(until)})
            continue
        claimed, next_at = _claim(app, post, now, cfg.platform(platform).manual_cooldown)
        if not claimed:
            entry: dict[str, Any] = {"platform": platform, "status": "too_soon"}
            if next_at:
                entry["nextAllowedAt"] = next_at
            results.append(entry)
            continue
        entry = {"platform": platform, "status": "started", "nextAllowedAt": next_at}
        if platform in SLOW_PLATFORMS:
            entry["note"] = SETTLE_NOTE.format(label=name)
        results.append(entry)
        started.append((post, entry))
    if started:
        _start(app, req, clip, started, now)
    log("info", "stats.refresh_requested", clipId=clip["clipId"], started=len(started))
    return ok({"platforms": results}, status=202)


def _start(
    app: App, req: Request, clip: dict[str, Any], started: list[tuple[dict[str, Any], dict[str, Any]]], now: datetime
) -> None:
    post_ids = [str(p["postId"]) for p, _ in started]
    try:
        if app.invoker is None:
            raise InvokeError("the stats function is not configured")
        app.invoker.refresh_stats(req.user_id, clip["clipId"], post_ids)
    except InvokeError as e:
        log("error", "stats.refresh_invoke_failed", clipId=clip["clipId"], error=str(e))
        retry_at = iso(now + timedelta(minutes=1))
        for post, entry in started:
            with contextlib.suppress(db.ConditionFailed):
                app.store.update(str(post["pk"]), str(post["sk"]), {}, remove=["refreshStartedAt", "nextRefreshAt"])
            entry.clear()
            entry.update(
                {"platform": post["platform"], "status": "blocked", "nextAllowedAt": retry_at, "note": TRY_LATER_NOTE}
            )
