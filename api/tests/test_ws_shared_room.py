"""Sharing Clip Factory's developer app, protected (docs/CONTRACTS.md §45.37 G6; the owner: "Keep it, protect CF").

(a) Lamo Stories counts what it uses on the shared app only in its own ``SHAREUSE#`` items and never writes Clip
Factory's ``RATE#`` counters, settings or X budget; (b) Clip Factory's share (its auto-posting schedule plus headroom
for its manual posts) is reserved on YouTube, X and TikTok, and a Lamo Stories post can never use it up; (c) with no
room the post waits with a plain line and goes out by itself after the reset; (f) Clip Factory's own posting path is
untouched: its own X charge still has its whole share."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.clock import UTC, iso
from clipfactory_api.flows.story_flow import run_story_flow
from clipfactory_api.stats import budget, config
from clipfactory_api.workspaces import publish, shared_room
from conftest import NOW, USER, Clock
from fakes import FakeDurableContext, FakeHttp, FakeSecretsManager, FakeTable

CFG = config.load()
JOB_SK = "PUBJOB#01JZ0000000000000000000PJ1"


def _scope(store: db.Store) -> shared_room.Scope:
    return shared_room.Scope(store, USER, "stories")


def _auto(store: db.Store, *, on: bool = True, every: int = 6, per: int = 1) -> None:
    """Clip Factory's auto-posting setting (§46.3): now 1 clip every 6 hours on every platform."""
    setting = {"on": on, "everyHours": every, "perRun": per, "practice": False}
    store.put({"pk": db.user_pk(USER), "sk": "SETTINGS", "type": "settings", "autoPost": setting})


def _clips_counters(table: FakeTable) -> str:
    """Clip Factory's own counters (``RATE#{platform}``; Lamo Stories' are all ``RATE#WS#…``)."""
    found = (i for i in table.all() if str(i["pk"]).startswith("RATE#") and not str(i["pk"]).startswith("RATE#WS#"))
    return json.dumps(sorted(found, key=str), default=str)


def test_clip_factorys_schedule_is_read_only_through_one_attribute(store: db.Store, table: FakeTable) -> None:
    assert shared_room.clips_auto_per_day(store, USER) == 0  # no setting: auto-posting is off
    _auto(store)
    assert shared_room.clips_auto_per_day(store, USER) == 4  # 1 clip every 6 hours
    _auto(store, every=5, per=2)
    assert shared_room.clips_auto_per_day(store, USER) == 10  # 2 every 5 hours: 9.6, rounded up
    _auto(store, on=False)
    assert shared_room.clips_auto_per_day(store, USER) == 0
    store.put({"pk": db.user_pk(USER), "sk": "SETTINGS", "type": "settings", "autoPost": {"on": True, "perRun": "x"}})
    assert shared_room.clips_auto_per_day(store, USER) == shared_room.AUTO_FALLBACK  # unreadable: reserve the most
    reads = [kw for op, kw in table.calls if op == "get_item" and kw["Key"]["sk"] == "SETTINGS"]
    assert reads
    assert all(set(kw["ExpressionAttributeNames"].values()) == {"pk", "sk", "autoPost"} for kw in reads)


def test_youtube_keeps_clip_factorys_uploads_and_reads(store: db.Store, table: FakeTable) -> None:
    _auto(store)
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "dayKey": "2026-11-15", "unitsUsed": 4500,
               "version": 3})  # fmt: skip
    before = _clips_counters(table)
    scope = _scope(store)
    share = shared_room.allowance(store, USER, "youtube", NOW, CFG)
    # videos.insert's 100 uploads a day, minus Clip Factory's 4 auto-posts and 10 for its own manual posts
    assert share.posts == 100 - (4 + 10)
    # the 10,000-unit pool: Clip Factory keeps its reserveUnits and at least 1,000 above what it used today
    assert share.units == 10000 - 500 - (4500 + 1000)
    for _ in range(86):
        assert shared_room.take(scope, "youtube", NOW, cfg=CFG, posts=1).ok
    refused = shared_room.take(scope, "youtube", NOW, cfg=CFG, posts=1)
    assert (refused.ok, refused.until, refused.reason) == (False, budget.youtube_next_reset(NOW), "posts")
    assert shared_room.take(scope, "youtube", NOW, cfg=CFG, units=share.units).ok  # type: ignore[arg-type]
    assert not shared_room.take(scope, "youtube", NOW, cfg=CFG, units=1).ok
    own = table.raw("RATE#WS#~shared#youtube", "SHAREUSE#youtube#2026-11-15")
    assert own is not None
    assert (own["posts"], own["units"], own["type"]) == (86, share.units, "ws_shareuse")
    assert _clips_counters(table) == before  # Clip Factory's counters: byte for byte
    # the next Pacific day starts again from nothing (Lamo Stories' own counter is per window)
    tomorrow = budget.youtube_next_reset(NOW) + timedelta(minutes=1)
    assert shared_room.take(scope, "youtube", tomorrow, cfg=CFG, posts=1).ok


def test_x_keeps_clip_factorys_month_and_its_own_charge_still_has_its_whole_share(
    store: db.Store, table: FakeTable
) -> None:
    _auto(store)
    store.put({"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 3.0, "version": 7})
    scope = _scope(store)
    price = float(CFG.platform("x").budget["usdPerPost"])
    per_cf_post = price + 4 * float(CFG.platform("x").budget["usdPerPostRead"])
    days_left = 30 - 15 + 1
    reserve = days_left * max(3.0 / 15, (4 + 2) * per_cf_post)
    share = shared_room.allowance(store, USER, "x", NOW, CFG)
    assert share.usd == pytest.approx(10 - 3.0 - reserve)
    posts = 0
    while shared_room.take(scope, "x", NOW, cfg=CFG, usd=price).ok:
        posts += 1
    assert posts == int((share.usd or 0) // price + 1e-9)
    mine = float((table.raw("RATE#WS#~shared#x", "SHAREUSE#x#2026-11") or {})["usd"])
    assert mine <= (share.usd or 0) + 1e-9
    assert 10 - 3.0 - mine >= reserve - 1e-9  # what is left is at least Clip Factory's reserve for the month
    # Clip Factory's own posting path never counts Lamo Stories' spend: its budget item is as it was, and its own
    # charge still has every dollar of its limit
    assert store.get("RATE#x", "BUDGET") == {
        "pk": "RATE#x",
        "sk": "BUDGET",
        "type": "rate",
        "monthKey": "2026-11",
        "monthUsd": 3.0,
        "version": 7,
    }
    assert budget.charge_post(store, NOW, cfg=CFG)
    # tomorrow Clip Factory's reserve is a day smaller: Lamo Stories may look again then
    refused = shared_room.take(scope, "x", NOW, cfg=CFG, usd=price)
    assert refused.until is not None
    assert refused.until.date() >= (NOW + timedelta(days=1)).date()


def test_tiktok_keeps_clip_factorys_requests_and_waits_while_it_is_throttled(store: db.Store, table: FakeTable) -> None:
    scope = _scope(store)
    share = shared_room.allowance(store, USER, "tiktok", NOW, CFG)
    assert share.requests == 600 - 300 - 100  # the app's calls a minute, minus Clip Factory's useAtMost and headroom
    for _ in range(200):
        assert shared_room.take(scope, "tiktok", NOW, cfg=CFG, requests=1).ok
    refused = shared_room.take(scope, "tiktok", NOW, cfg=CFG, requests=1)
    assert (refused.ok, refused.until) == (False, datetime(2026, 11, 15, 12, 1, tzinfo=UTC))
    assert shared_room.take(scope, "tiktok", NOW + timedelta(minutes=1), cfg=CFG, requests=1).ok
    # Clip Factory's own counter is blocked (TikTok throttled the app): Lamo Stories waits as long
    until = NOW + timedelta(minutes=5)
    store.put({"pk": "RATE#tiktok", "sk": "BUDGET", "type": "rate", "blockedUntil": iso(until)})
    later = NOW + timedelta(minutes=2)
    blocked = shared_room.take(scope, "tiktok", later, cfg=CFG, requests=1)
    assert (blocked.ok, blocked.until, blocked.reason) == (False, until, "clips_blocked")
    assert shared_room.room(scope, "tiktok", later, cfg=CFG).ok is False
    # TikTok said the app's daily limit is reached: Lamo Stories stops for the rest of the UTC day, its own item only
    store.delete("RATE#tiktok", "BUDGET")
    stop = shared_room.block_after("tiktok", "daily", later)
    assert stop == datetime(2026, 11, 16, tzinfo=UTC)
    shared_room.block(scope, "tiktok", stop, "daily", later)
    assert shared_room.take(scope, "tiktok", later, cfg=CFG, requests=1).until == stop
    assert store.get("RATE#tiktok", "BUDGET") is None  # never Clip Factory's


@pytest.mark.parametrize("platform", ["youtube", "x", "tiktok"])
def test_every_stories_workspace_together_gets_one_share(store: db.Store, table: FakeTable, platform: str) -> None:
    """The reviewer's G6 major: the share is the app's, so two owners' stories workspaces (and a second workspace of
    one owner) that all share Clip Factory's app never use more than one share between them."""
    from conftest import OTHER

    _auto(store)
    other_ws = "01JZ00000000000000000000W2"
    scopes = [_scope(store), shared_room.Scope(store, USER, other_ws), shared_room.Scope(store, OTHER, "stories")]
    share = shared_room.allowance(store, USER, platform, NOW, CFG)
    price = float(CFG.platform("x").budget["usdPerPost"])
    amount: dict[str, Any] = {"youtube": {"posts": 1}, "x": {"usd": price}, "tiktok": {"requests": 1}}[platform]
    took = 0
    for turn in range(3000):  # the three take turns
        if shared_room.take(scopes[turn % 3], platform, NOW, cfg=CFG, **amount).ok:
            took += 1
    limit = {"youtube": share.posts, "x": int((share.usd or 0) // price + 1e-9), "tiktok": share.requests}[platform]
    assert 0 < took <= (limit or 0)  # one share for all of them, never three
    counters = [i for i in table.all() if str(i["sk"]).startswith(f"SHAREUSE#{platform}#")]
    assert [str(i["pk"]) for i in counters] == [f"RATE#WS#~shared#{platform}"]
    if platform != "tiktok":  # TikTok counts calls a minute only
        by = counters[0]["byWorkspace"]
        assert set(by) == {f"{USER}#stories", f"{USER}#{other_ws}", f"{OTHER}#stories"}
        name = "posts" if platform == "youtube" else "usd"
        assert sum(float(v[name]) for v in by.values()) == pytest.approx(float(counters[0][name]))
    assert all(shared_room.take(scope, platform, NOW, cfg=CFG, **amount).ok is False for scope in scopes)


def test_x_says_plainly_that_clip_factorys_own_burst_can_pass_the_limit(store: db.Store) -> None:
    """Clip Factory's own X charge counts only its own spend (its code is untouched): when it posts on schedule the
    month stays inside the limit; when it bursts late in the month, the total can pass the limit by at most what
    Lamo Stories spent, and the card says so."""
    _auto(store)
    store.put({"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 3.0, "version": 1})
    scope = _scope(store)
    price = float(CFG.platform("x").budget["usdPerPost"])
    while shared_room.take(scope, "x", NOW, cfg=CFG, usd=price).ok:
        pass
    stories = float(shared_room.used(scope, "x", NOW)["usd"])
    limit = float(CFG.platform("x").budget["monthlyUsd"])
    # on schedule: Clip Factory's reserve covers the rest of its month
    reserve = 3.0 + (limit - 3.0 - shared_room.allowance(store, USER, "x", NOW, CFG).usd)  # type: ignore[operator]
    assert reserve + stories <= limit + 1e-9
    # a late burst: Clip Factory's own charge still takes every dollar of the limit
    late = datetime(2026, 11, 30, 20, 0, tzinfo=UTC)
    while budget.charge_post(store, late, cfg=CFG):
        pass
    clips = float(store.get("RATE#x", "BUDGET")["monthUsd"])  # type: ignore[index]
    assert clips <= limit + 1e-9
    assert clips + stories <= limit + stories + 1e-9
    assert shared_room.X_OVER_LIMIT in social_limits()


def social_limits() -> list[str]:
    from clipfactory_api.workspaces import social

    return social.limits("x", "clips")


def test_the_waiting_line_names_the_time() -> None:
    until = datetime(2026, 11, 16, 8, 0, 30, tzinfo=UTC)
    assert shared_room.waiting_line(until) == "Waiting: Clip Factory's posts go first. Posts at 16 Nov 08:00 UTC."


def test_a_waiting_post_is_not_stuck_and_shows_its_line(store: db.Store, table: FakeTable) -> None:
    waits = NOW + timedelta(days=10)
    job = sup.pubjob(
        store,
        "x",
        updatedAt=iso(NOW - timedelta(days=2)),
        waitUntil=iso(waits),
        waiting=shared_room.waiting_line(waits),
    )
    assert not publish.stuck(job, NOW)  # its flow is waiting, not gone
    assert not publish.stuck(job, waits + timedelta(hours=5))
    assert publish.stuck(job, waits + publish.STUCK_AFTER)
    shown = publish.public_job(job)
    assert (shown["waitingUntil"], shown["waiting"]) == (iso(waits), shared_room.waiting_line(waits))
    assert "waitUntil" not in shown
    posted = publish.public_job({**job, "publishingStatus": "posted"})
    assert (posted["waitingUntil"], posted["waiting"]) == (None, None)


class TimedContext(FakeDurableContext):
    """Each wait moves the clock on, as the real waits do."""

    def __init__(self, clock: Clock) -> None:
        super().__init__()
        self.clock = clock

    def wait(self, duration: Any, name: str | None = None) -> None:
        super().wait(duration, name=name)
        self.clock.now += timedelta(seconds=duration.to_seconds())


YOUTUBE_OK = [
    (200, b"", {"Location": "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=a"}),
    (201, "publish/youtube_video"),
    (200, "publish/youtube_uploaded"),
    (200, "publish/youtube_processed"),
]


def test_a_youtube_post_waits_for_the_next_quota_day_and_then_posts_by_itself(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    """Lamo Stories used its share of today's uploads on Clip Factory's Google project: the post waits for the
    Pacific reset (nothing is sent, Clip Factory's counters stay as they were), then goes out by itself."""
    sup.ready(store, secrets_client, "youtube")
    token = {**sup.TOKENS["youtube"], "expiresAt": "2027-01-01T00:00:00.000Z"}
    sup.social(store, secrets_client, "youtube", token=token)
    _auto(store)
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "dayKey": "2026-11-15", "unitsUsed": 10})
    store.put({"pk": "RATE#WS#~shared#youtube", "sk": "SHAREUSE#youtube#2026-11-15", "type": "ws_shareuse",
               "platform": "youtube", "posts": 86, "version": 1})  # fmt: skip
    before = _clips_counters(table)
    sup.pubjob(store, "youtube")
    http = FakeHttp(*YOUTUBE_OK, *([(200, {"items": []}), (403, {"error": {"code": 403}})] * 4))
    ctx = TimedContext(clock)
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert ctx.steps[1:5] == ["validate-youtube", "room-youtube-1", "room-youtube-2", "publish-youtube"]
    reset = budget.youtube_next_reset(NOW)
    assert ctx.waits[0] == ("wait-room-youtube-1", int((reset - NOW).total_seconds()) + 30)
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "posted"
    assert "waitUntil" not in job
    assert "waiting" not in job
    assert _clips_counters(table) == before
    next_day = table.raw("RATE#WS#~shared#youtube", f"SHAREUSE#youtube#{budget.youtube_day_key(reset)}")
    assert next_day is not None
    assert next_day["posts"] == 1


def test_the_platforms_own_daily_limit_on_the_shared_app_makes_the_post_wait(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    """YouTube itself says the project's uploads are used up (Clip Factory may have posted more than its reserve):
    Lamo Stories steps back until the Pacific reset (its own counter only) instead of failing, so Clip Factory's
    next post is not fighting it."""
    sup.ready(store, secrets_client, "youtube")
    before = _clips_counters(table)
    sup.pubjob(store, "youtube")
    quota = (403, {"error": {"code": 403, "errors": [{"reason": "quotaExceeded"}]}})
    http = FakeHttp(quota)
    ctx = FakeDurableContext()
    seen: dict[str, Any] = {}
    real_wait = ctx.wait

    def wait(duration: Any, name: str | None = None) -> None:
        if not seen:
            seen.update(job=dict(table.raw(sup.PK, JOB_SK) or {}), name=name)
        real_wait(duration, name=name)

    ctx.wait = wait  # type: ignore[method-assign]
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert seen["name"] == "wait-publish-youtube"
    assert seen["job"]["publishingStatus"] in ("queued", "publishing")
    assert seen["job"]["waiting"].startswith("Waiting: Clip Factory's posts go first. Posts at ")
    own = table.raw("RATE#WS#~shared#youtube", "SHAREUSE#youtube#2026-11-15")
    assert own is not None
    assert own["blockedUntil"] == iso(budget.youtube_next_reset(NOW))
    assert _clips_counters(table) == before


def test_a_slow_down_on_the_shared_app_makes_the_post_wait_and_then_post(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    """The reviewer's G6 minor: a slow-down answer (a retryable ``rate`` problem) on Clip Factory's shared app is not
    retried into the throttled app until the job fails: Lamo Stories steps back for the window (its own counter only),
    the post waits with its line, and goes out after the window by itself."""
    sup.ready(store, secrets_client, "youtube")
    token = {**sup.TOKENS["youtube"], "expiresAt": "2027-01-01T00:00:00.000Z"}
    sup.social(store, secrets_client, "youtube", token=token)
    before = _clips_counters(table)
    sup.pubjob(store, "youtube")
    slow = (403, {"error": {"code": 403, "errors": [{"reason": "rateLimitExceeded"}]}})
    http = FakeHttp(slow, *YOUTUBE_OK, *([(200, {"items": []}), (403, {"error": {"code": 403}})] * 4))
    ctx = TimedContext(clock)
    seen: dict[str, Any] = {}
    real_wait = ctx.wait

    def wait(duration: Any, name: str | None = None) -> None:
        if not seen:
            seen.update(job=dict(table.raw(sup.PK, JOB_SK) or {}), name=name, seconds=duration.to_seconds())
        real_wait(duration, name=name)

    ctx.wait = wait  # type: ignore[method-assign]
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert seen["name"] == "wait-publish-youtube"
    assert seen["seconds"] <= 120  # a slow-down: about a minute, not a day
    assert seen["job"]["waiting"].startswith("Waiting: Clip Factory's posts go first. Posts at ")
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "posted"
    own = table.raw("RATE#WS#~shared#youtube", "SHAREUSE#youtube#2026-11-15")
    assert own is not None
    assert own["blockedReason"] == "rate"
    assert _clips_counters(table) == before  # Clip Factory's counters: byte for byte
