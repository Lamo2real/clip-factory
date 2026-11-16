"""platforms.json, the shared rate budget, refresh_posts, the 15-minute tick and the cf-prod-stats handler (§16.3–§16.5)."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.ids import ulid
from clipfactory_api.platforms import ResponseMeta, make_adapters
from clipfactory_api.stats import STATS_ORDER, budget, config
from clipfactory_api.stats.handler import handle
from clipfactory_api.stats.poll import run_tick
from clipfactory_api.stats.refresh import StatsDeps, merge_metrics, refresh_posts
from conftest import USER
from fakes import FakeHttp, FakeTable

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
CFG = config.load(config.REPO_FILE)
ACCOUNT = {"platform": "any", "status": "connected", "platformUserId": "17841400000000000"}


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class Ticker:
    """A fake ``time.monotonic``: every call moves ``step`` seconds on."""

    def __init__(self, step: float = 0.0) -> None:
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


def tokens(platform: str, account: dict[str, Any]) -> str:
    return "token"


def make_deps(
    store: db.Store, http: FakeHttp, *, connected: tuple[str, ...] = STATS_ORDER, clock: Clock | None = None, **kw: Any
) -> StatsDeps:
    adapters = make_adapters(tokens=tokens)
    sleeps: list[float] = []
    deps = StatsDeps(
        store=store,
        http=http,
        adapters=lambda p: adapters[p],
        clock=clock or Clock(),
        sleep=sleeps.append,
        accounts=lambda _s, _u, p: ACCOUNT if p in connected else None,
        cfg=CFG,
        **kw,
    )
    deps.sleeps = sleeps  # type: ignore[attr-defined]
    return deps


def seed_post(
    store: db.Store,
    platform: str,
    stats_id: str | None,
    *,
    age: timedelta = timedelta(hours=10),
    due: datetime | None = None,
    window: bool = True,
    **fields: Any,
) -> dict[str, Any]:
    post_id = ulid()
    clip_id = fields.pop("clipId", None) or ulid()
    item: dict[str, Any] = {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip_id}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip_id,
        "platform": platform,
        "status": "posted",
        "privacy": "public",
        "url": f"https://{platform}.example/{post_id}",
        "postedAt": iso(NOW - age),
        **fields,
    }
    if stats_id:
        item["statsId"] = stats_id
    if window and stats_id:
        due_at = iso(due or NOW - timedelta(minutes=1))
        item.update({"statsDueAt": due_at, "gsi2pk": "STATS", "gsi2sk": f"{due_at}#{post_id}"})
    store.put(item)
    return item


def stored(table: FakeTable, item: dict[str, Any]) -> dict[str, Any]:
    raw = table.raw(item["pk"], item["sk"])
    assert raw is not None
    return db.from_dynamo(raw)  # type: ignore[no-any-return]


def snapshots(store: db.Store, post: dict[str, Any]) -> list[dict[str, Any]]:
    return store.query_all(db.user_pk(USER), db.stat_prefix(post["postId"]))


# --- config ---------------------------------------------------------------------------------------------------------


def test_config_validates_the_repo_file() -> None:
    assert CFG.order == STATS_ORDER
    assert set(CFG.platforms) == set(STATS_ORDER)
    assert CFG.graph_api_version == "v25.0"
    assert (CFG.poll_window_days, CFG.snapshot_ttl_days, CFG.snapshot_every_minutes) == (30, 90, 60)
    assert CFG.age_tier_hours == (48, 168, 720)
    assert CFG.tick_minutes == 15
    expected = {
        "youtube": (15, (15, 30, 120), 5, 50),
        "tiktok": (15, (15, 30, 120), 5, 20),
        "instagram": (30, (30, 60, 360), 30, 50),
        "facebook": (30, (30, 60, 360), 30, 50),
        "x": (15, (15, 30, 120), 5, 100),
    }
    for name, (minimum, tiers, cooldown, ids) in expected.items():
        p = CFG.platform(name)
        assert (p.min_interval, p.tier_intervals, p.manual_cooldown, p.ids_per_request) == (
            minimum,
            tiers,
            cooldown,
            ids,
        )
    assert CFG.platform("youtube").insights_interval == 360
    assert CFG.platform("youtube").budget == {
        "kind": "daily_units",
        "dailyUnits": 10000,
        "reserveUnits": 3000,
        "unitsPerCall": 1,
        "blockOn": ["quotaExceeded", "rateLimitExceeded"],
    }
    assert CFG.platform("tiktok").budget["useAtMost"] == 300
    assert CFG.platform("instagram").budget["throttleCodes"] == [80002]
    assert CFG.platform("facebook").budget["throttleCodes"] == [80001]
    assert CFG.platform("x").budget["monthlyUsd"] == 10
    assert CFG.platform("x").non_public_max_age_days == 30
    assert config.load() == CFG  # the package copy (or the checkout) is the same file


def test_config_tick_follows_the_smallest_interval_and_rejects_bad_values() -> None:
    raw = copy.deepcopy(CFG.raw)
    for p in raw["platforms"].values():
        p["minIntervalMinutes"] = 30
        p["tierIntervalsMinutes"] = [30, 60, 360]
    assert config.parse(raw).tick_minutes == 30
    bad = copy.deepcopy(CFG.raw)
    bad["platforms"]["youtube"]["tierIntervalsMinutes"] = [5, 30, 120]  # below minIntervalMinutes
    with pytest.raises(config.ConfigError):
        config.parse(bad)
    bad = copy.deepcopy(CFG.raw)
    del bad["platforms"]["x"]
    with pytest.raises(config.ConfigError):
        config.parse(bad)
    bad = copy.deepcopy(CFG.raw)
    bad["platforms"]["tiktok"]["budget"]["kind"] = "meta_buc"
    with pytest.raises(config.ConfigError):
        config.parse(bad)


@pytest.mark.parametrize(
    ("platform", "age", "minutes"),
    [
        ("youtube", timedelta(hours=47), 15),
        ("youtube", timedelta(hours=49), 30),
        ("youtube", timedelta(days=8), 120),
        ("youtube", timedelta(days=31), 120),
        ("instagram", timedelta(hours=47), 30),
        ("instagram", timedelta(hours=49), 60),
        ("instagram", timedelta(days=8), 360),
        ("facebook", timedelta(days=31), 360),
        ("x", timedelta(hours=47), 15),
    ],
)
def test_interval_for_tiers(platform: str, age: timedelta, minutes: int) -> None:
    assert config.interval_for(CFG, platform, NOW - age, NOW) == minutes


# --- budget ---------------------------------------------------------------------------------------------------------


def test_youtube_budget_keeps_the_upload_reserve(store: db.Store) -> None:
    store.put(
        {"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "dayKey": "2026-11-16", "unitsUsed": 6999, "version": 3}
    )
    assert isinstance(budget.reserve(store, "youtube", 1, NOW, cfg=CFG), budget.Reserved)
    blocked = budget.reserve(store, "youtube", 1, NOW, cfg=CFG)
    assert isinstance(blocked, budget.Blocked)
    assert blocked.next_allowed_at == datetime(2026, 11, 17, 8, 0, tzinfo=UTC)
    assert store.get("RATE#youtube", "BUDGET")["unitsUsed"] == 7000  # type: ignore[index]


def test_youtube_day_key_is_pacific_standard() -> None:
    early = datetime(2026, 11, 16, 7, 59, tzinfo=UTC)
    assert budget.youtube_day_key(early) == "2026-11-15"
    assert budget.youtube_next_reset(early) == datetime(2026, 11, 16, 8, 0, tzinfo=UTC)
    assert budget.youtube_day_key(datetime(2026, 11, 16, 8, 0, tzinfo=UTC)) == "2026-11-16"


def test_a_new_day_starts_the_counter_again(store: db.Store) -> None:
    store.put(
        {"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "dayKey": "2026-11-15", "unitsUsed": 7000, "version": 1}
    )
    assert isinstance(budget.reserve(store, "youtube", 1, NOW, cfg=CFG), budget.Reserved)
    item = store.get("RATE#youtube", "BUDGET")
    assert item is not None
    assert (item["dayKey"], item["unitsUsed"], item["version"]) == ("2026-11-16", 1, 2)


def test_reserve_is_atomic(store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two reservations racing for the last slot: one wins, the other re-reads and is blocked."""
    store.put(
        {
            "pk": "RATE#tiktok",
            "sk": "BUDGET",
            "type": "rate",
            "minuteKey": "2026-11-16T12:00",
            "requestsThisMinute": 299,
            "version": 7,
        }
    )
    real_write = budget._write
    inner: list[budget.Reservation] = []

    def racing(*args: Any) -> None:
        monkeypatch.setattr(budget, "_write", real_write)
        inner.append(budget.reserve(store, "tiktok", 1, NOW, cfg=CFG))  # the other caller sneaks in first
        real_write(*args)

    monkeypatch.setattr(budget, "_write", racing)
    outer = budget.reserve(store, "tiktok", 1, NOW, cfg=CFG)
    assert isinstance(inner[0], budget.Reserved)
    assert isinstance(outer, budget.Blocked)
    assert outer.next_allowed_at == NOW + timedelta(minutes=1)
    assert store.get("RATE#tiktok", "BUDGET")["requestsThisMinute"] == 300  # type: ignore[index]


def test_reserve_creates_the_budget_item(store: db.Store, table: FakeTable) -> None:
    assert isinstance(budget.reserve(store, "x", 1, NOW, ids=["1", "2"], cfg=CFG), budget.Reserved)
    item = store.get("RATE#x", "BUDGET")
    assert item is not None
    assert item["type"] == "rate"
    assert item["platform"] == "x"
    assert item["requestsThisWindow"] == 1
    assert item["windowKey"] == "2026-11-16T12:00"
    assert item["dayPostIds"] == ["1", "2"]
    assert item["monthKey"] == "2026-11"
    assert item["monthUsd"] == pytest.approx(0.01)


def test_blocked_until_blocks_every_kind(store: db.Store) -> None:
    for platform in STATS_ORDER:
        store.put({"pk": f"RATE#{platform}", "sk": "BUDGET", "blockedUntil": iso(NOW + timedelta(minutes=9))})
        result = budget.reserve(store, platform, 1, NOW, cfg=CFG)
        assert isinstance(result, budget.Blocked)
        assert result.next_allowed_at == NOW + timedelta(minutes=9)
    store.put({"pk": "RATE#tiktok", "sk": "BUDGET", "blockedUntil": iso(NOW - timedelta(seconds=1))})
    assert isinstance(budget.reserve(store, "tiktok", 1, NOW, cfg=CFG), budget.Reserved)


def test_record_youtube_quota_exceeded_blocks_until_0800_utc(store: db.Store) -> None:
    until = budget.record(store, "youtube", ResponseMeta(status=403, error_code="quotaExceeded"), NOW, cfg=CFG)
    assert until == datetime(2026, 11, 17, 8, 0, tzinfo=UTC)
    item = store.get("RATE#youtube", "BUDGET")
    assert item is not None
    assert item["blockedUntil"] == "2026-11-17T08:00:00.000Z"
    assert item["blockedReason"] == "quotaExceeded"
    assert budget.record(store, "youtube", ResponseMeta(status=403, error_code="forbidden"), NOW, cfg=CFG) is None


def test_record_tiktok_429_blocks_one_minute(store: db.Store) -> None:
    meta = ResponseMeta(status=429, error_code="rate_limit_exceeded")
    assert budget.record(store, "tiktok", meta, NOW, cfg=CFG) == NOW + timedelta(minutes=1)


def _usage(pct: int, eta: int = 0) -> dict[str, str]:
    row = {
        "type": "instagram",
        "call_count": pct,
        "total_cputime": 3,
        "total_time": 4,
        "estimated_time_to_regain_access": eta,
    }
    low = {"type": "pages", "call_count": 1, "total_cputime": 1, "total_time": 1, "estimated_time_to_regain_access": 0}
    return {"x-business-use-case-usage": json.dumps({"178": [low, row]})}


def test_record_meta_throttle_uses_the_regain_time(store: db.Store) -> None:
    meta = ResponseMeta(status=400, headers=_usage(100, eta=90), error_code="80002")
    assert budget.record(store, "instagram", meta, NOW, cfg=CFG) == NOW + timedelta(minutes=90)
    meta = ResponseMeta(status=400, headers=_usage(100, eta=10), error_code="80002")
    assert budget.record(store, "instagram", meta, NOW, cfg=CFG) == NOW + timedelta(minutes=60)  # minBlockMinutes
    item = store.get("RATE#instagram", "BUDGET")
    assert item is not None
    assert item["buc"]["callCount"] == 100  # the highest entry of the header
    assert item["buc"]["estimatedTimeToRegainAccess"] == 10
    assert budget.record(store, "facebook", ResponseMeta(status=400, error_code="80002"), NOW, cfg=CFG) is None


def test_record_meta_usage_over_75_percent_blocks(store: db.Store) -> None:
    assert budget.record(store, "facebook", ResponseMeta(headers=_usage(74)), NOW, cfg=CFG) is None
    assert store.get("RATE#facebook", "BUDGET")["buc"]["callCount"] == 74  # type: ignore[index]
    assert budget.record(store, "facebook", ResponseMeta(headers=_usage(75)), NOW, cfg=CFG) == NOW + timedelta(
        minutes=15
    )
    assert budget.record(store, "facebook", ResponseMeta(headers=_usage(80, eta=40)), NOW, cfg=CFG) == NOW + timedelta(
        minutes=40
    )


def test_record_x_429_waits_for_the_reset(store: db.Store) -> None:
    reset = int((NOW + timedelta(minutes=7)).timestamp())
    meta = ResponseMeta(status=429, error_code="429", retry_after=reset)
    assert budget.record(store, "x", meta, NOW, cfg=CFG) == NOW + timedelta(minutes=7)
    item = store.get("RATE#x", "BUDGET")
    assert item is not None
    assert item["blockedUntil"] == iso(NOW + timedelta(minutes=7))


def test_x_monthly_cap(store: db.Store) -> None:
    store.put(
        {
            "pk": "RATE#x",
            "sk": "BUDGET",
            "monthKey": "2026-11",
            "monthUsd": 9.996,
            "dayKey": "2026-11-16",
            "dayPostIds": {"seen"},
            "version": 2,
        }
    )
    assert isinstance(budget.reserve(store, "x", 1, NOW, ids=["seen"], cfg=CFG), budget.Reserved)  # free re-read today
    blocked = budget.reserve(store, "x", 1, NOW, ids=["new-1"], cfg=CFG)
    assert isinstance(blocked, budget.Blocked)
    assert blocked.reason == "monthly_cap"
    assert blocked.next_allowed_at == datetime(2026, 12, 1, tzinfo=UTC)
    item = store.get("RATE#x", "BUDGET")
    assert item is not None
    assert item["blockedReason"] == "monthly_cap"
    assert item["blockedUntil"] == "2026-12-01T00:00:00.000Z"


# --- refresh_posts, run_tick ------------------------------------------------------------------------------------------


def test_phase_one_nothing_reaches_the_network(store: db.Store) -> None:
    """No connected account (phase 1): every post ends not_connected, zero HTTP calls."""
    from clipfactory_api import posts

    for platform in STATS_ORDER:
        seed_post(store, platform, f"{platform}-1")
    http = FakeHttp()
    deps = StatsDeps(store=store, http=http, clock=Clock(), cfg=CFG, accounts=posts.connected_account)
    summary = run_tick(deps, NOW)
    assert summary["posts"] == 5
    assert summary["updated"] == 0
    assert http.calls == []
    # The default adapters with a (wrongly) connected account still stop at the phase-1 token guard.
    deps = StatsDeps(store=store, http=http, clock=Clock(), cfg=CFG, accounts=lambda *_: ACCOUNT)
    report = refresh_posts(deps, store.query_all(db.user_pk(USER), "POST#"), reason="manual", now=NOW)
    assert set(report.outcomes.values()) == {"not_connected"}
    assert http.calls == []


def test_tick_reads_only_due_posts_and_writes_metrics(store: db.Store, table: FakeTable) -> None:
    due = seed_post(store, "tiktok", "7301234567890123456", age=timedelta(hours=10))
    seed_post(store, "tiktok", "7301234567890000000", due=NOW + timedelta(minutes=5))
    seed_post(store, "tiktok", "7301234567890000001", window=False)  # final: left the window
    http = FakeHttp((200, "tiktok_video_query"))
    summary = run_tick(make_deps(store, http), NOW)
    assert summary == {"posts": 1, "requests": 1, "updated": 1, "blocked": [], "errors": 0, "deferred": 0}
    assert json.loads(http.calls[0].body) == {"filters": {"video_ids": ["7301234567890123456"]}}
    item = stored(table, due)
    assert item["metrics"]["views"] == 25500
    assert item["metrics"]["shares"] == 405
    assert item["metrics"]["metricsUpdatedAt"] == iso(NOW)
    assert item["metrics"]["checkedAt"] == iso(NOW)
    assert item["statsDueAt"] == iso(NOW + timedelta(minutes=15))
    assert item["gsi2sk"] == f"{iso(NOW + timedelta(minutes=15))}#{due['postId']}"
    assert "statsError" not in item
    (snap,) = snapshots(store, due)
    assert snap["sk"] == f"STAT#{due['postId']}#{iso(NOW)}"
    assert (snap["type"], snap["views"], snap["likes"], snap["platform"]) == ("stat", 25500, 3100, "tiktok")
    assert snap["ttl"] == int((NOW + timedelta(days=90)).timestamp())
    gsi2_query = next(c for c in table.calls if c[0] == "query" and c[1].get("IndexName") == "gsi2")[1]
    assert gsi2_query["KeyConditionExpression"] == "gsi2pk = :pk AND gsi2sk <= :max"
    assert gsi2_query["ExpressionAttributeValues"] == {":pk": "STATS", ":max": f"{iso(NOW)}#~"}


def test_tick_paginates_the_due_posts(store: db.Store, table: FakeTable) -> None:
    for i in range(5):
        seed_post(store, "x", f"18570000000000000{i:02d}")
    table.page_size = 2
    http = FakeHttp((200, {"data": []}))
    assert run_tick(make_deps(store, http), NOW)["posts"] == 5
    assert len(http.calls) == 1  # one request for all five (≤ 100 ids)


def _tiktok_views(views: int) -> dict[str, Any]:
    return {
        "data": {
            "videos": [
                {
                    "id": "7301234567890123456",
                    "view_count": views,
                    "like_count": 1,
                    "comment_count": 0,
                    "share_count": 0,
                }
            ]
        },
        "error": {"code": "ok"},
    }


def test_snapshot_rules(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456")
    clock = Clock()
    answers = [1000, 1000, 1000, 1020, 1025]
    http = FakeHttp(*[(200, _tiktok_views(v)) for v in answers])
    deps = make_deps(store, http, clock=clock)

    def read(at: datetime) -> int:
        clock.now = at
        refresh_posts(deps, [stored(table, post)], reason="manual", now=at)
        return len(snapshots(store, post))

    assert read(NOW) == 1  # the first read always
    assert read(NOW + timedelta(minutes=10)) == 1  # same views, 10 min
    assert read(NOW + timedelta(minutes=61)) == 2  # ≥ 60 min
    assert read(NOW + timedelta(minutes=80)) == 3  # +2 % and ≥ 15 min
    assert read(NOW + timedelta(minutes=100)) == 3  # +0.5 %
    assert stored(table, post)["lastSnapshotAt"] == iso(NOW + timedelta(minutes=80))


def test_final_snapshot_at_30_days_leaves_the_window(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456", age=timedelta(days=30, minutes=1))
    post["lastSnapshotAt"] = iso(NOW - timedelta(minutes=5))
    store.put(post)
    http = FakeHttp((200, "tiktok_video_query"), (200, "tiktok_video_query"))
    deps = make_deps(store, http)
    run_tick(deps, NOW)
    item = stored(table, post)
    assert item["metrics"]["final"] is True
    assert "gsi2pk" not in item
    assert "gsi2sk" not in item
    (snap,) = snapshots(store, post)
    assert snap["final"] is True
    assert run_tick(deps, NOW + timedelta(hours=1))["posts"] == 0  # no more automatic polls
    # A manual refresh still works afterwards and keeps it final, out of the window.
    report = refresh_posts(deps, [stored(table, post)], reason="manual", now=NOW + timedelta(hours=2))
    assert report.outcomes[post["postId"]] == "updated"
    assert stored(table, post)["metrics"]["final"] is True
    assert "gsi2pk" not in stored(table, post)


def test_time_budget_leaves_the_rest_due(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456")
    http = FakeHttp()
    summary = run_tick(make_deps(store, http, monotonic=Ticker(step=300), time_budget_seconds=240), NOW)
    assert summary["deferred"] == 1
    assert http.calls == []
    assert stored(table, post)["gsi2sk"] == post["gsi2sk"]


def test_youtube_insights_every_360_minutes_and_slow_values_kept(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    clock = Clock()
    http = FakeHttp(
        (200, "youtube_videos_list"),
        (200, "youtube_analytics_report"),
        (200, "youtube_videos_list"),
    )
    deps = make_deps(store, http, clock=clock)
    refresh_posts(deps, [stored(table, post)], reason="poll", now=NOW)
    item = stored(table, post)
    assert len(http.calls) == 2
    assert item["insightsDueAt"] == iso(NOW + timedelta(minutes=360))
    assert item["metrics"]["shares"] == 93
    assert item["metrics"]["extra"]["watchMinutes"] == 1520.5
    assert item["metrics"]["insightsUpdatedAt"] == iso(NOW)
    later = NOW + timedelta(minutes=30)
    clock.now = later
    refresh_posts(deps, [stored(table, post)], reason="poll", now=later)
    assert len(http.calls) == 3  # counts only: no Analytics call before insightsDueAt
    item = stored(table, post)
    assert item["metrics"]["shares"] == 93  # slow values kept between reads
    assert item["metrics"]["extra"]["engagedViews"] == 6100
    assert item["metrics"]["insightsUpdatedAt"] == iso(NOW)
    assert item["metrics"]["metricsUpdatedAt"] == iso(later)
    assert item["statsDueAt"] == iso(later + timedelta(minutes=30))  # 3 days old: second tier


def test_server_errors_are_retried_twice_then_recorded(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456")
    http = FakeHttp((503, b"down"), (502, b"down"), (500, b"down"))
    deps = make_deps(store, http)
    report = refresh_posts(deps, [stored(table, post)], reason="poll", now=NOW)
    assert len(http.calls) == 3
    assert deps.sleeps == [1.0, 4.0]  # type: ignore[attr-defined]
    assert report.outcomes[post["postId"]] == "error"
    item = stored(table, post)
    assert item["statsError"] == "TikTok did not answer. We will try again soon."
    assert item["statsDueAt"] == iso(NOW + timedelta(minutes=15))
    assert "metrics" not in item


def test_network_errors_are_retried(store: db.Store, table: FakeTable) -> None:
    from clipfactory_api.platforms.base import NetworkError

    post = seed_post(store, "tiktok", "7301234567890123456")
    http = FakeHttp(NetworkError("timeout"), (200, "tiktok_video_query"))
    report = refresh_posts(make_deps(store, http), [stored(table, post)], reason="poll", now=NOW)
    assert report.outcomes[post["postId"]] == "updated"


def test_a_blocked_platform_makes_no_request(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "instagram", "17900000000000001")
    store.put({"pk": "RATE#instagram", "sk": "BUDGET", "blockedUntil": iso(NOW + timedelta(hours=1))})
    http = FakeHttp()
    summary = run_tick(make_deps(store, http), NOW)
    assert summary["blocked"] == ["instagram"]
    assert http.calls == []
    item = stored(table, post)
    until = iso(NOW + timedelta(hours=1))
    assert item["statsDueAt"] == until  # due again when the block ends, not on every tick before that
    assert item["gsi2sk"] == f"{until}#{post['postId']}"
    assert "statsError" not in item
    assert run_tick(make_deps(store, http), NOW + timedelta(minutes=15))["posts"] == 0


def test_not_connected_posts_move_on_and_leave_the_window_at_30_days(store: db.Store, table: FakeTable) -> None:
    """No connected account: no read, no error, but the post is pushed one interval on so it never sits at the
    head of the due index; past pollWindowDays it leaves the index for good."""
    young = seed_post(store, "youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    old = seed_post(store, "tiktok", "7301234567890123456", age=timedelta(days=30, minutes=1))
    http = FakeHttp()
    deps = make_deps(store, http, connected=())
    summary = run_tick(deps, NOW)
    assert (summary["posts"], summary["updated"], summary["errors"]) == (2, 0, 0)
    assert http.calls == []
    item = stored(table, young)
    due = iso(NOW + timedelta(minutes=30))  # 3 days old: second tier
    assert (item["statsDueAt"], item["gsi2sk"], item["gsi2pk"]) == (due, f"{due}#{young['postId']}", "STATS")
    assert "statsError" not in item
    assert "metrics" not in item
    gone = stored(table, old)
    assert "gsi2pk" not in gone
    assert "gsi2sk" not in gone
    assert run_tick(deps, NOW + timedelta(minutes=15))["posts"] == 0  # nothing re-read before it is due
    assert run_tick(deps, NOW + timedelta(minutes=30))["posts"] == 1
    # A post outside the window (a manual refresh of a final post) is not touched.
    report = refresh_posts(deps, [stored(table, old)], reason="manual", now=NOW)
    assert report.outcomes[old["postId"]] == "not_connected"
    assert stored(table, old) == gone


def test_a_missing_token_spends_no_budget(store: db.Store, table: FakeTable) -> None:
    """A "connected" Account but no token (phase 1, or revoked): not_connected before budget.reserve."""

    def no_token(platform: str, account: dict[str, Any]) -> str:
        from clipfactory_api.platforms import NotConnectedError

        raise NotConnectedError("no token")

    adapters = make_adapters(tokens=no_token)
    post = seed_post(store, "youtube", "dQw4w9WgXcQ")
    http = FakeHttp()
    deps = make_deps(store, http)  # the account says "connected"
    deps.adapters = lambda p: adapters[p]
    report = refresh_posts(deps, [stored(table, post)], reason="poll", now=NOW)
    assert report.outcomes[post["postId"]] == "not_connected"
    assert http.calls == []
    assert store.get("RATE#youtube", "BUDGET") is None  # no quota reserved
    assert stored(table, post)["statsDueAt"] == iso(NOW + timedelta(minutes=15))


def test_youtube_budget_charges_units_per_call_from_the_config(store: db.Store, table: FakeTable) -> None:
    """unitsPerCall times one videos.list per chunk; the Analytics report has its own quota and is not charged."""
    raw = copy.deepcopy(CFG.raw)
    raw["platforms"]["youtube"]["budget"]["unitsPerCall"] = 3
    cfg = config.parse(raw)
    post = seed_post(store, "youtube", "dQw4w9WgXcQ", age=timedelta(days=3))
    no_id = seed_post(store, "youtube", None, window=False)
    http = FakeHttp((200, "youtube_videos_list"), (200, "youtube_analytics_report"))
    deps = make_deps(store, http)
    deps.cfg = cfg
    report = refresh_posts(deps, [stored(table, post)], reason="poll", now=NOW)
    assert report.outcomes[post["postId"]] == "updated"
    assert len(http.calls) == 2  # counts + the insights report
    item = store.get("RATE#youtube", "BUDGET")
    assert item is not None
    assert item["unitsUsed"] == 3
    # A chunk with no YouTube id sends no request and is charged nothing.
    refresh_posts(deps, [stored(table, no_id)], reason="manual", now=NOW)
    assert len(http.calls) == 2
    assert store.get("RATE#youtube", "BUDGET")["unitsUsed"] == 3  # type: ignore[index]
    bad = copy.deepcopy(CFG.raw)
    bad["platforms"]["youtube"]["budget"]["unitsPerCall"] = 0
    with pytest.raises(config.ConfigError, match="unitsPerCall"):
        config.parse(bad)


def test_instagram_throttle_blocks_and_is_not_retried(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "instagram", "17900000000000001")
    error = {"error": {"message": "Application request limit reached", "code": 80002}}
    http = FakeHttp((400, error, _usage(100, eta=90)))
    deps = make_deps(store, http)
    report = refresh_posts(deps, [stored(table, post)], reason="poll", now=NOW)
    assert len(http.calls) == 1
    assert deps.sleeps == []  # type: ignore[attr-defined]
    assert report.blocked == ["instagram"]
    item = store.get("RATE#instagram", "BUDGET")
    assert item is not None
    assert item["blockedUntil"] == iso(NOW + timedelta(minutes=90))


def test_private_and_unposted_posts_are_never_read(store: db.Store) -> None:
    private = seed_post(store, "tiktok", None, privacy="private")
    queued = seed_post(store, "x", "1", status="queued")
    http = FakeHttp()
    report = refresh_posts(make_deps(store, http), [private, queued], reason="manual", now=NOW)
    assert report.outcomes == {private["postId"]: "private", queued["postId"]: "not_posted"}
    assert http.calls == []


def test_merge_metrics_keeps_what_was_not_read() -> None:
    old = {
        "views": 10,
        "likes": 1,
        "comments": None,
        "shares": 3,
        "checkedAt": "2026-11-15T00:00:00.000Z",
        "extra": {"watchMinutes": 4.5},
    }
    merged = merge_metrics(old, {"views": 20, "likes": 2, "comments": 1, "extra": {}}, None, NOW)
    assert merged["shares"] == 3
    assert merged["extra"] == {"watchMinutes": 4.5}
    assert merged["metricsUpdatedAt"] == iso(NOW)
    assert "insightsUpdatedAt" not in merged
    legacy = merge_metrics(old, None, {"shares": 5, "extra": {}}, NOW)
    assert legacy["metricsUpdatedAt"] == "2026-11-15T00:00:00.000Z"  # §5 checkedAt read as the fast time
    assert legacy["insightsUpdatedAt"] == iso(NOW)


# --- the handler ------------------------------------------------------------------------------------------------------


def test_handler_scheduled_event_runs_the_tick(store: db.Store) -> None:
    seed_post(store, "tiktok", "7301234567890123456")
    out = handle(
        {"source": "aws.events", "detail-type": "Scheduled Event"},
        make_deps(store, FakeHttp((200, "tiktok_video_query"))),
    )
    assert out["action"] == "tick"
    assert out["updated"] == 1


def test_handler_manual_refresh_clears_the_claim(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456", refreshStartedAt=iso(NOW), nextRefreshAt=iso(NOW))
    event = {"action": "refresh", "userId": USER, "clipId": post["clipId"], "postIds": [post["postId"]]}
    out = handle(event, make_deps(store, FakeHttp((503, b""), (503, b""), (503, b""))))
    assert out["outcomes"] == {post["postId"]: "error"}  # expected errors never raise
    item = stored(table, post)
    assert "refreshStartedAt" not in item
    assert item["nextRefreshAt"] == iso(NOW)  # the cooldown stays


def test_handler_manual_refresh_clears_the_claim_even_on_a_bug(store: db.Store, table: FakeTable) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456", refreshStartedAt=iso(NOW))
    event = {"action": "refresh", "userId": USER, "clipId": post["clipId"], "postIds": [post["postId"]]}
    with pytest.raises(RuntimeError):
        handle(event, make_deps(store, FakeHttp(RuntimeError("bug"))))
    assert "refreshStartedAt" not in stored(table, post)


def test_handler_manual_refresh_ignores_other_clips_posts(store: db.Store) -> None:
    post = seed_post(store, "tiktok", "7301234567890123456")
    http = FakeHttp()
    out = handle(
        {"action": "refresh", "userId": USER, "clipId": ulid(), "postIds": [post["postId"]]}, make_deps(store, http)
    )
    assert out["updated"] == []
    assert http.calls == []


@pytest.mark.parametrize(
    "event",
    [{}, {"action": "dance"}, {"action": "refresh", "userId": USER, "clipId": "c", "postIds": ["../x"]}, "nope", None],
)
def test_handler_bad_events(store: db.Store, event: Any) -> None:
    assert handle(event, make_deps(store, FakeHttp())) == {"action": "bad_event"}


def test_handler_builds_deps_once(monkeypatch: pytest.MonkeyPatch, store: db.Store) -> None:
    from clipfactory_api.stats import handler as module

    calls: list[int] = []

    def factory() -> StatsDeps:
        calls.append(1)
        return make_deps(store, FakeHttp())

    monkeypatch.setattr(module, "_deps", None)
    module.get_deps(factory)
    module.get_deps(factory)
    assert calls == [1]
    monkeypatch.setattr(module, "_deps", None)
