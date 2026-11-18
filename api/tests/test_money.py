"""Real earnings (docs/CONTRACTS.md §25): the collector, the states, the money rows, the screens' shapes and routes.

Every platform answer here is recorded (``FakeHttp``); nothing reaches a network. The rule under test everywhere:
only money a platform reported, tagged as its estimate, never calculated, and states never go down by themselves.
"""

from __future__ import annotations

import dataclasses
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from clipfactory_api import db, money
from clipfactory_api.money import collect, handler, rules, sources, view
from clipfactory_api.money.collect import MoneyDeps
from clipfactory_api.oauth import setup
from clipfactory_api.platforms.base import NetworkError, ReconnectNeededError
from clipfactory_api.stats import config as stats_config
from clipfactory_api.stats.handler import handle as stats_handle
from conftest import MONEY_ARN, USER, Call
from fakes import FakeHttp, FakeLambda, FakeTable

NOW = datetime(2026, 11, 18, 6, 0, 0, tzinfo=UTC)
MONETARY = sources.MONETARY_SCOPE
YT_SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
]


@dataclasses.dataclass
class Creds:
    access_token: str


class FakeTokens:
    """``SecretsTokenProvider.credentials`` stand-in: a fixed token, or a raise per platform."""

    def __init__(self) -> None:
        self.raises: dict[str, BaseException] = {}
        self.asked: list[str] = []

    def credentials(self, platform: str, account: dict[str, Any]) -> Creds:
        self.asked.append(platform)
        if platform in self.raises:
            raise self.raises[platform]
        return Creds(f"TOKEN-{platform}")


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def tokens() -> FakeTokens:
    return FakeTokens()


@pytest.fixture
def fake_http() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def deps(store: db.Store, tokens: FakeTokens, fake_http: FakeHttp, clock: Clock) -> MoneyDeps:
    return MoneyDeps(
        store=store,
        tokens=tokens,
        http=fake_http,
        clock=clock,
        rules=rules.load(),
        platforms=stats_config.load(),
    )


def connect(store: db.Store, platform: str, scopes: list[str], account_id: str = "ACC1", **extra: Any) -> None:
    setup.put_account(
        store, USER, platform, "connected", now=NOW, fields={"accountId": account_id, "scopes": scopes, **extra}
    )


def state(store: db.Store, platform: str) -> dict[str, Any]:
    return store.get(db.user_pk(USER), money.state_sk(platform)) or {}


def revenue_rows(store: db.Store, platform: str) -> list[dict[str, Any]]:
    return store.query_all(db.user_pk(USER), money.revenue_prefix(platform))


# --- recorded YouTube answers ----------------------------------------------------------------------------------

CHANNEL = {
    "items": [
        {
            "id": "UC1",
            "statistics": {"subscriberCount": "812", "hiddenSubscriberCount": False},
            "contentDetails": {"relatedPlaylists": {"uploads": "UU1"}},
        }
    ]
}


def playlist(days_ago: list[int], private: tuple[int, ...] = ()) -> dict[str, Any]:
    items = []
    for i, d in enumerate(days_ago):
        stamp = (NOW - timedelta(days=d)).isoformat().replace("+00:00", "Z")
        items.append(
            {
                "contentDetails": {"videoPublishedAt": stamp},
                "status": {"privacyStatus": "private" if i in private else "public"},
            }
        )
    return {"items": items}


def report(headers: list[str], rows: list[list[Any]]) -> dict[str, Any]:
    return {"columnHeaders": [{"name": h} for h in headers], "rows": rows}


SHORTS = report(["engagedViews"], [[1_200_000]])
WATCH = report(
    ["creatorContentType", "estimatedMinutesWatched"],
    [["SHORTS", 99_999], ["VIDEO_ON_DEMAND", 60_000], ["LIVE_STREAM", 30_000]],
)


def yt_error(status: int, reason: str) -> tuple[int, dict[str, Any]]:
    return status, {"error": {"code": status, "errors": [{"reason": reason, "message": reason}]}}


def money_days(*amounts: tuple[str, float, float]) -> dict[str, Any]:
    return report(["day", "estimatedRevenue", "estimatedAdRevenue"], [[d, r, a] for d, r, a in amounts])


def yt_answers(money_answer: Any = None, *, extra: list[Any] | None = None) -> list[Any]:
    out: list[Any] = [(200, CHANNEL), (200, playlist([2, 10, 40, 120])), (200, SHORTS), (200, WATCH)]
    if money_answer is not None:
        out.append(money_answer)
    return out + (extra or [])


# --- YouTube: the state matrix ---------------------------------------------------------------------------------


def test_without_the_money_scope_youtube_needs_your_ok_and_shows_real_progress(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    fake_http.answers.extend(yt_answers())
    out = collect.run_platform(deps, USER, "youtube", now=NOW, country=None)
    assert out.state == "needs_permission"
    assert fake_http.answers == []
    assert not any("estimatedRevenue" in u for u in fake_http.urls)  # never asked without the scope
    item = state(store, "youtube")
    assert item["numbers"] == {"subscribers": 812, "uploads90": 3, "shortsViews90": 1_200_000, "watchHours365": 1500}
    acct = store.get(db.user_pk(USER), "ACCOUNT#youtube")
    assert acct is not None
    assert acct["moneyScopesMissing"] is True
    snap = store.query_all(db.user_pk(USER), money.acctstat_prefix("youtube"))
    assert len(snap) == 1
    assert snap[0]["ttl"] == int((NOW + timedelta(days=800)).timestamp())
    card = view.money_view(store, USER, NOW)["platforms"][0]
    assert card["state"] == "needs_permission"
    assert card["needsPermission"]["button"] == "Allow money reading"
    assert card["needsPermission"]["copy"][0]["value"] == MONETARY
    assert [g["key"] for g in card["goals"]] == ["subscribers", "watchHours", "shortsViews"]
    assert card["goals"][0] | {} == card["goals"][0]
    assert card["goals"][0]["current"] == 812
    assert card["goals"][0]["goal"] == 1000
    assert "revenue" not in card


def test_watch_hours_count_long_videos_and_lives_only() -> None:
    http = FakeHttp(*yt_answers())
    reading = sources.read_youtube(http, "T", scopes=YT_SCOPES, now=NOW, video_ids={})
    assert reading.numbers["watchHours365"] == 1500  # (60,000 + 30,000) minutes / 60, Shorts left out
    shorts_url = unquote(http.urls[2])
    assert "filters=creatorContentType==SHORTS" in shorts_url
    assert "startDate=2026-08-20" in shorts_url  # 90 days ending yesterday
    assert "endDate=2026-11-17" in shorts_url


def test_uploads_stop_at_the_first_video_older_than_90_days() -> None:
    http = FakeHttp(
        (200, CHANNEL), (200, {**playlist([1, 5, 95, 2]), "nextPageToken": "P2"}), (200, SHORTS), (200, WATCH)
    )
    reading = sources.read_youtube(http, "T", scopes=YT_SCOPES, now=NOW, video_ids={})
    assert reading.numbers["uploads90"] == 2
    assert len([u for u in http.urls if "playlistItems" in u]) == 1  # never paged past the old one


def test_hidden_subscribers_are_never_a_zero() -> None:
    hidden = {"items": [{"statistics": {"hiddenSubscriberCount": True}, "contentDetails": {}}]}
    http = FakeHttp((200, hidden), (200, SHORTS), (200, WATCH))
    reading = sources.read_youtube(http, "T", scopes=YT_SCOPES, now=NOW, video_ids={})
    assert "subscribers" not in reading.numbers
    assert reading.missing["subscribers"] == "Your subscriber count is hidden on YouTube."


@pytest.mark.parametrize(
    ("answer", "shorts_ok", "expected", "error"),
    [
        (yt_error(403, "forbidden"), True, "not_yet", None),
        (yt_error(403, "forbidden"), False, "error", "YouTube didn't answer. Clip Factory checks again tomorrow."),
        (yt_error(403, "accessNotConfigured"), True, "error", "Turn on YouTube Analytics API in Google Cloud."),
        (
            yt_error(403, "quotaExceeded"),
            True,
            "error",
            "YouTube's daily limit is used up. Clip Factory checks again tomorrow.",
        ),
        (yt_error(403, "insufficientPermissions"), True, "needs_permission", None),
        (yt_error(500, "backendError"), True, "error", "YouTube didn't answer. Clip Factory checks again tomorrow."),
        ((200, money_days(("2026-11-16", 0, 0))), True, "in_program", None),
        ((200, money_days(("2026-11-16", 0.12, 0.1))), True, "earning", None),
    ],
)
def test_youtube_state_comes_only_from_real_signals(
    deps: MoneyDeps,
    store: db.Store,
    fake_http: FakeHttp,
    answer: Any,
    shorts_ok: bool,
    expected: str,
    error: str | None,
) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    answers = yt_answers(answer)
    if not shorts_ok:
        answers[2] = yt_error(403, "accessNotConfigured")
    if answer[0] == 200:
        answers.append((400, {"error": {"code": 400}}))  # the Shorts split is not offered: hidden
    fake_http.answers.extend(answers)
    out = collect.run_platform(deps, USER, "youtube", now=NOW, country=None)
    assert out.state == expected
    assert state(store, "youtube").get("lastError") == error


def test_in_the_programme_never_goes_down_and_detected_at_is_written_once(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp, clock: Clock
) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    fake_http.answers.extend(yt_answers((200, money_days(("2026-11-16", 0, 0))), extra=[(400, {})]))
    assert collect.run_platform(deps, USER, "youtube", now=NOW, country=None).state == "in_program"
    first = state(store, "youtube")
    assert first["detectedAt"] == "2026-11-18T06:00:00.000Z"
    assert [c["key"] for c in first["pendingCelebrations"]] == ["youtube:in_program"]
    # A bad day: 403 forbidden. Still in the programme, with a plain "couldn't check".
    later = NOW + timedelta(days=1)
    fake_http.answers.extend(yt_answers(yt_error(403, "forbidden")))
    assert collect.run_platform(deps, USER, "youtube", now=later, country=None).state == "in_program"
    second = state(store, "youtube")
    assert second["detectedAt"] == first["detectedAt"]
    assert second["lastError"] == collect.CHECK_FAILED
    assert [c["key"] for c in second["pendingCelebrations"]] == ["youtube:in_program"]  # queued once
    # A network outage keeps it too.
    fake_http.answers.append(NetworkError("timeout"))
    assert collect.run_platform(deps, USER, "youtube", now=later, country=None).state == "in_program"


def test_reported_money_is_stored_as_received_and_revisions_are_marked(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    fake_http.answers.extend(
        yt_answers((200, money_days(("2026-11-15", 0.42, 0.40), ("2026-11-16", 1.1, 1.0))), extra=[(400, {})])
    )
    collect.run_platform(deps, USER, "youtube", now=NOW, country=None)
    money_url = unquote(next(u for u in fake_http.urls if "estimatedRevenue,estimatedAdRevenue" in u))
    assert "startDate=2026-09-01" in money_url  # this month and the two before it: month-end changes are caught
    rows = {r["date"]: r for r in revenue_rows(store, "youtube")}
    assert rows["2026-11-15"]["amountMicros"] == 420_000
    assert rows["2026-11-15"]["currency"] == "USD"
    assert rows["2026-11-15"]["source"] == "youtube.estimatedRevenue"
    assert rows["2026-11-15"]["estimate"] is True
    assert rows["2026-11-15"]["breakdown"] == {"adsMicros": 400_000}
    assert "revisedAt" not in rows["2026-11-15"]
    # YouTube changes the 15th at month end.
    later = NOW + timedelta(days=1)
    fake_http.answers.extend(
        yt_answers((200, money_days(("2026-11-15", 0.40, 0.40), ("2026-11-16", 1.1, 1.0))), extra=[(400, {})])
    )
    collect.run_platform(deps, USER, "youtube", now=later, country=None)
    rows = {r["date"]: r for r in revenue_rows(store, "youtube")}
    assert rows["2026-11-15"]["amountMicros"] == 400_000
    assert rows["2026-11-15"]["previousMicros"] == 420_000
    assert rows["2026-11-15"]["revisedAt"] == "2026-11-19T06:00:00.000Z"
    assert "revisedAt" not in rows["2026-11-16"]
    item = state(store, "youtube")
    assert item["state"] == "earning"
    assert item["adsOn"] is True


def test_first_money_waits_until_it_survives_a_later_read(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    positive = (200, money_days(("2026-11-16", 0.12, 0.1)))
    fake_http.answers.extend(yt_answers(positive, extra=[(400, {})]))
    collect.run_platform(deps, USER, "youtube", now=NOW, country=None)
    keys = [c["key"] for c in state(store, "youtube")["pendingCelebrations"]]
    assert "youtube:first_money" not in keys
    fake_http.answers.extend(yt_answers(positive, extra=[(400, {})]))
    collect.run_platform(deps, USER, "youtube", now=NOW + timedelta(days=2), country=None)
    assert "youtube:first_money" not in [c["key"] for c in state(store, "youtube")["pendingCelebrations"]]
    fake_http.answers.extend(yt_answers(positive, extra=[(400, {})]))
    collect.run_platform(deps, USER, "youtube", now=NOW + timedelta(days=3), country=None)
    pending = state(store, "youtube")["pendingCelebrations"]
    assert [c["key"] for c in pending].count("youtube:first_money") == 1
    assert next(c for c in pending if c["key"] == "youtube:first_money")["text"] == "Your first money from YouTube!"


def test_the_shorts_split_shows_only_when_youtube_offers_it(deps: MoneyDeps, store: db.Store) -> None:
    split = report(["creatorContentType", "estimatedRevenue"], [["SHORTS", 1.5], ["VIDEO_ON_DEMAND", 2.25]])
    http = FakeHttp(*yt_answers((200, money_days(("2026-11-16", 3.75, 3))), extra=[(200, split)]))
    reading = sources.read_youtube(http, "T", scopes=[*YT_SCOPES, MONETARY], now=NOW, video_ids={})
    assert reading.split == {"month": "2026-11", "shortsMicros": 1_500_000, "longMicros": 2_250_000}
    http = FakeHttp(*yt_answers((200, money_days(("2026-11-16", 3.75, 3))), extra=[(400, {"error": {}})]))
    reading = sources.read_youtube(http, "T", scopes=[*YT_SCOPES, MONETARY], now=NOW, video_ids={})
    assert reading.split is None


def test_each_clip_gets_youtubes_estimate_without_touching_its_numbers(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    pk = db.user_pk(USER)
    store.put(
        {
            "pk": pk,
            "sk": "POST#01JZ0000000000000000000001",
            "type": "post",
            "postId": "01JZ0000000000000000000001",
            "platform": "youtube",
            "status": "posted",
            "statsId": "vidA",
            "postedAt": "2026-11-01T10:00:00.000Z",
            "metrics": {"views": 1234, "extra": {"engagedViews": 900}},
        }
    )
    per_video = report(["video", "estimatedRevenue"], [["vidA", 0.42], ["notOurs", 9.99]])
    fake_http.answers.extend(
        yt_answers((200, money_days(("2026-11-16", 0.42, 0.4))), extra=[(400, {}), (200, per_video)])
    )
    collect.run_platform(deps, USER, "youtube", now=NOW, country=None)
    video_url = unquote(fake_http.urls[-1])
    assert "dimensions=video" in video_url
    assert "filters=video==vidA" in video_url
    assert "startDate=2026-11-01" in video_url
    post = store.get(pk, "POST#01JZ0000000000000000000001")
    assert post is not None
    assert post["metrics"] == {"views": 1234, "extra": {"engagedViews": 900}}
    assert post["revenue"]["amountMicros"] == 420_000
    assert post["revenue"]["source"] == "youtube.estimatedRevenue"
    shown = view.clip_revenue(post)
    assert shown is not None
    assert shown["tag"] == "YouTube's estimate"


def test_youtube_rules_switch_on_1_february_2027_in_the_view(store: db.Store) -> None:
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    pk = db.user_pk(USER)
    store.put({"pk": pk, "sk": money.state_sk("youtube"), "state": "not_yet", "numbers": {"subscribers": 1500}})
    before = view.money_view(store, USER, datetime(2027, 1, 31, tzinfo=UTC))["platforms"][0]
    after = view.money_view(store, USER, datetime(2027, 2, 1, tzinfo=UTC))["platforms"][0]
    assert {g["key"]: g["goal"] for g in before["goals"]}["watchHours"] == 4000
    assert {g["key"]: g["goal"] for g in after["goals"]}["watchHours"] == 8000
    assert any("8,000" in e for e in before["extras"])
    assert not any("8,000" in e for e in after["extras"])


def test_goal_reached_always_says_youtube_checks_more(store: db.Store) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": money.state_sk("youtube"),
            "state": "not_yet",
            "numbers": {"subscribers": 1200, "watchHours365": 4100, "shortsViews90": 0},
        }
    )
    card = view.money_view(store, USER, NOW)["platforms"][0]
    assert card["state"] == "goal_reached"
    assert card["pill"] == "Goal reached"
    assert card["line"] == "Goal reached. YouTube also checks things we can't see."


# --- Facebook ------------------------------------------------------------------------------------------------------


def fb_answers(earnings_value: Any) -> list[Any]:
    insights = {
        "data": [
            {"name": "page_video_view_time", "values": [{"value": 600_000}, {"value": 1_200_000}]},
            {"name": "creator_monetization_qualified_views", "values": [{"value": 40}, {"value": 2}]},
        ]
    }
    earning = {
        "data": [
            {
                "name": "content_monetization_earnings",
                "values": [{"value": earnings_value, "end_time": "2026-11-16T08:00:00+0000"}],
            }
        ],
        "paging": {"next": "https://graph.facebook.com/v27.0/p1/insights?access_token=SECRET-TOKEN"},
    }
    approx = {"data": [{"name": "monetization_approximate_earnings", "values": []}]}
    # followers, insights, then two 90-day windows for each earnings metric (Sept 1 to Nov 17 fits one)
    return [(200, {"followers_count": 321, "id": "p1"}), (200, insights), (200, earning), (200, approx)]


def test_facebook_money_stays_hidden_until_the_live_check(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp, table: FakeTable
) -> None:
    connect(store, "facebook", [], account_id="p1")
    fake_http.answers.extend(fb_answers({"currency": "USD", "microAmount": 2_500_000}))
    out = collect.run_platform(deps, USER, "facebook", now=NOW, country=None)
    assert out.state == "unknown"
    assert revenue_rows(store, "facebook") == []
    raw = state(store, "facebook")["rawEarnings"]
    assert "SECRET-TOKEN" not in json.dumps(raw)
    assert "paging" not in json.dumps(raw)
    assert "SECRET-TOKEN" not in json.dumps(table.all(), default=str)
    card = view.money_view(store, USER, NOW)["platforms"][3]
    assert card["platform"] == "facebook"
    assert card["state"] == "unknown"
    assert card["line"] == "Not earning yet. Meta doesn't tell apps if you've joined."
    assert card["comingSoon"].startswith("Facebook money: coming soon")
    assert "revenue" not in card
    assert {g["key"]: g["current"] for g in card["goals"]} == {
        "followers": 321,
        "minutes60": 30,
        "qualifiedViews60": 42,
    }
    assert all(g["kind"] == "number" for g in card["goals"])


def verified_rules() -> rules.Monetization:
    cfg = rules.load()
    fb = dataclasses.replace(cfg.platform("facebook"), money_verified=True)
    return dataclasses.replace(cfg, platforms={**cfg.platforms, "facebook": fb})


def test_facebook_money_once_verified_keeps_metas_unit_and_currency(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    deps.rules = verified_rules()
    connect(store, "facebook", [], account_id="p1")
    fake_http.answers.extend(fb_answers({"currency": "sek", "microAmount": 2_500_000}))
    assert collect.run_platform(deps, USER, "facebook", now=NOW, country=None).state == "earning"
    (row,) = revenue_rows(store, "facebook")
    assert row["amountMicros"] == 2_500_000
    assert row["currency"] == "SEK"
    assert row["unit"] == "micro_amount"
    assert row["source"] == "facebook.content_monetization_earnings"
    card = view.money_view(store, USER, NOW, deps.rules)["platforms"][3]
    assert card["revenue"]["tag"] == "Meta's estimate"
    assert card["revenue"]["currency"] == "SEK"


def test_a_bare_meta_number_is_never_shown_and_an_erroring_metric_has_no_fallback(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    deps.rules = verified_rules()
    connect(store, "facebook", [], account_id="p1")
    fake_http.answers.extend(fb_answers(12.5))  # no unit, no currency: unknown, so nothing
    collect.run_platform(deps, USER, "facebook", now=NOW, country=None)
    assert revenue_rows(store, "facebook") == []
    answers = fb_answers({"currency": "USD", "microAmount": 1})
    answers[2] = (400, {"error": {"code": 100, "message": "(#100) The metric was removed", "access_token": "X"}})
    fake_http.answers.extend(answers)
    assert collect.run_platform(deps, USER, "facebook", now=NOW, country=None).state == "unknown"
    assert revenue_rows(store, "facebook") == []


# --- Instagram, TikTok, X --------------------------------------------------------------------------------------


def test_instagram_shows_followers_against_gifts_and_says_it_does_not_share(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "instagram", [], account_id="1784")
    fake_http.answers.append((200, {"followers_count": 640, "id": "1784"}))
    assert collect.run_platform(deps, USER, "instagram", now=NOW, country="SE").state == "not_available"
    card = view.money_view(store, USER, NOW)["platforms"][2]
    assert card["state"] == "goal_reached"
    assert card["line"] == "Goal reached. Instagram also checks things we can't see."
    assert card["notShared"] == "Instagram doesn't share earnings with apps."
    assert card["goals"][0]["note"] == "Instagram also checks age, country and rules"
    assert [c["text"] for c in state(store, "instagram")["pendingCelebrations"]] == ["You hit 500 followers for Gifts!"]


def tiktok_page(views: list[int], durations: list[int], more: bool, cursor: int = 0) -> dict[str, Any]:
    videos = [
        {"id": str(i), "view_count": v, "duration": d} for i, (v, d) in enumerate(zip(views, durations, strict=True))
    ]
    return {"data": {"videos": videos, "cursor": cursor, "has_more": more}, "error": {"code": "ok"}}


def test_tiktok_without_follower_reading_still_counts_views_and_waits_30_days(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "tiktok", ["user.info.basic", "video.publish", "video.list"], account_id="open-1")
    fake_http.answers.extend(
        [(200, tiktok_page([100, 50], [61, 30], True, cursor=99)), (200, tiktok_page([7], [90], False))]
    )
    store.put({"pk": db.user_pk(USER), "sk": money.PREFS_SK, "country": "US"})
    out = collect.run_platform(deps, USER, "tiktok", now=NOW, country="US")
    assert out.state == "needs_permission"
    assert json.loads(fake_http.calls[1].body)["cursor"] == 99  # pages through every video
    assert not any("user/info" in u for u in fake_http.urls)
    snap = store.get(db.user_pk(USER), money.acctstat_sk("tiktok", "2026-11-18"))
    assert snap is not None
    assert snap["viewsTotal"] == 157
    card = view.money_view(store, USER, NOW)["platforms"][1]
    assert card["needsPermission"]["button"] == "Allow follower reading"
    goals = {g["key"]: g for g in card["goals"]}
    assert goals["followers"]["missing"] == "Press Allow follower reading once TikTok approves it."
    assert goals["views30"]["countingDaysLeft"] == 30
    assert goals["views30"]["current"] is None
    assert "Videos 1 min or longer: 2 of your last 20." in card["extras"]
    assert "Don't switch to a Business account. Creator Rewards won't pay it." in card["extras"]


def test_tiktok_30_day_views_are_a_clamped_snapshot_delta(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "tiktok", ["user.info.basic", "video.publish", "video.list", "user.info.stats"], account_id="o1")
    pk = db.user_pk(USER)
    store.put({"pk": pk, "sk": money.PREFS_SK, "country": "US"})
    old_day = (NOW - timedelta(days=31)).date().isoformat()
    store.put({"pk": pk, "sk": money.acctstat_sk("tiktok", old_day), "day": old_day, "viewsTotal": 5000})
    fake_http.answers.extend(
        [(200, {"data": {"user": {"follower_count": 10_500}}}), (200, tiktok_page([4000], [70], False))]
    )
    assert collect.run_platform(deps, USER, "tiktok", now=NOW, country="US").state == "not_available"
    assert state(store, "tiktok")["numbers"] == {"followers": 10_500, "views30": 0}  # a deleted video: clamped at 0
    card = view.money_view(store, USER, NOW)["platforms"][1]
    assert card["state"] == "not_available"
    assert {g["key"]: g["reached"] for g in card["goals"]} == {"followers": True, "views30": False}


def test_tiktok_goals_need_a_country(store: db.Store) -> None:
    connect(store, "tiktok", ["user.info.stats"], account_id="o1")
    store.put({"pk": db.user_pk(USER), "sk": money.state_sk("tiktok"), "state": "not_available", "numbers": {}})
    card = view.money_view(store, USER, NOW)["platforms"][1]
    assert card["goals"] == []
    assert "Pick your country at the top to see this programme's goals." in card["extras"]
    store.put({"pk": db.user_pk(USER), "sk": money.PREFS_SK, "country": "other"})
    card = view.money_view(store, USER, NOW)["platforms"][1]
    assert any("not open in your country" in e for e in card["extras"])


def test_x_reads_once_a_day_against_the_budget_and_has_no_impressions_bar(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp
) -> None:
    connect(store, "x", [], account_id="42")
    pk = db.user_pk(USER)
    store.put(
        {
            "pk": pk,
            "sk": "POST#01JZ0000000000000000000009",
            "type": "post",
            "platform": "x",
            "status": "posted",
            "postedAt": "2026-11-10T00:00:00.000Z",
            "metrics": {"extra": {"impressions": 4321}},
        }
    )
    fake_http.answers.extend(
        [
            (400, {"title": "Invalid Request"}),  # verified_followers_count refused as a field
            (200, {"data": {"id": "42", "subscription_type": "Premium", "public_metrics": {"followers_count": 900}}}),
        ]
    )
    collect.run_platform(deps, USER, "x", now=NOW, country="US")
    budget_item = store.get("RATE#x", "BUDGET")
    assert budget_item is not None
    assert budget_item["monthUsd"] > 0
    item = state(store, "x")
    assert item["numbers"] == {"premium": True, "impressions90": 4321}
    assert item["missing"]["verifiedFollowers"] == "X didn't share this."
    card = view.money_view(store, USER, NOW)["platforms"][4]
    goals = {g["key"]: g for g in card["goals"]}
    assert goals["impressions90"]["kind"] == "number"
    assert goals["impressions90"]["goal"] is None
    assert goals["premium"]["reached"] is True
    assert card["notShared"] == "X doesn't share earnings with apps."


# --- one platform failing never stops the others; tokens only through the provider -------------------------


def test_one_platform_failing_never_stops_the_others(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp, tokens: FakeTokens
) -> None:
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    connect(store, "instagram", [], account_id="1784")
    tokens.raises["youtube"] = ReconnectNeededError("dead")
    fake_http.answers.append((200, {"followers_count": 12}))
    outcomes = {o.platform: o for o in collect.run_user(deps, USER)}
    assert outcomes["youtube"].error == "Connect YouTube again in Settings › Posting › Set up posting."
    assert outcomes["instagram"].state == "not_available"
    assert outcomes["tiktok"].state == "not_connected"
    assert tokens.asked == ["youtube", "instagram"]


def test_a_bug_in_one_platform_is_contained(deps: MoneyDeps, store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    connect(store, "instagram", [], account_id="1784")

    def boom(*_a: Any, **_k: Any) -> Any:
        raise KeyError("bug")

    monkeypatch.setattr(collect, "_read", boom)
    outcomes = collect.run_user(deps, USER, platforms=("instagram",))
    assert outcomes[0].error == collect.CHECK_FAILED
    assert state(store, "instagram")["lastError"] == collect.CHECK_FAILED


# --- the money view: nothing fake, nothing secret ----------------------------------------------------------------


def test_money_this_month_adds_only_earning_platforms_per_currency(store: db.Store) -> None:
    connect(store, "youtube", [*YT_SCOPES, MONETARY], account_id="UC1")
    pk = db.user_pk(USER)
    store.put({"pk": pk, "sk": money.state_sk("youtube"), "state": "earning", "numbers": {}})
    for day, amount in (("2026-11-02", 1_000_000), ("2026-11-10", 11_400_000), ("2026-10-30", 5_000_000)):
        store.put(
            {
                "pk": pk,
                "sk": money.revenue_sk("youtube", day),
                "date": day,
                "amountMicros": amount,
                "currency": "USD",
                "unit": "USD",
                "source": "youtube.estimatedRevenue",
            }
        )
    out = view.money_view(store, USER, NOW)
    assert out["thisMonth"] == [{"currency": "USD", "amountMicros": 12_400_000, "platforms": ["youtube"]}]
    rev = out["platforms"][0]["revenue"]
    assert rev["tag"] == "YouTube's estimate"
    assert rev["source"] == "youtube.estimatedRevenue"
    assert rev["months"] == [
        {"month": "2026-10", "amountMicros": 5_000_000},
        {"month": "2026-11", "amountMicros": 12_400_000},
    ]
    text = json.dumps(out).lower()
    for word in ("paid you", "received", "actual", "access_token", "googleapis.com/auth"):
        assert word not in text or word == "googleapis.com/auth"
    assert "googleapis.com/auth" not in json.dumps({k: v for k, v in out.items() if k != "platforms"})


def test_every_money_figure_names_its_platform_source_and_currency(store: db.Store) -> None:
    test_money_this_month_adds_only_earning_platforms_per_currency(store)
    out = view.money_view(store, USER, NOW)
    for card in out["platforms"]:
        block = card.get("revenue")
        if block:
            assert block["platform"] == card["platform"]
            assert block["source"]
            assert block["currency"]
            assert block["tag"].endswith("'s estimate")


def test_not_connected_platforms_say_so(store: db.Store) -> None:
    out = view.money_view(store, USER, NOW)
    assert [c["state"] for c in out["platforms"]] == ["not_connected"] * 5
    assert out["country"] is None
    assert out["countries"][0] == {"code": "US", "name": "United States"}


# --- routes ------------------------------------------------------------------------------------------------------


def test_get_money_registers_the_owner_for_the_daily_run(call: Call, store: db.Store) -> None:
    status, body = call("GET", "/v1/money")
    assert status == 200
    assert [c["platform"] for c in body["platforms"]] == ["youtube", "tiktok", "instagram", "facebook", "x"]
    assert money.owners(store) == [USER]
    call("GET", "/v1/money")
    assert money.owners(store) == [USER]


def test_check_now_runs_at_most_once_an_hour(call: Call, lambda_client: FakeLambda, app: Any) -> None:
    status, body = call("POST", "/v1/money/refresh")
    assert status == 202
    assert body["started"] is True
    sent = [c for c in lambda_client.calls if c["FunctionName"] == MONEY_ARN]
    assert [c["payload"] for c in sent] == [{"action": "refresh", "userId": USER}]
    status, body = call("POST", "/v1/money/refresh")
    assert status == 200
    assert body == {"started": False, "nextAllowedAt": "2026-11-18T07:00:00.000Z"}
    assert len([c for c in lambda_client.calls if c["FunctionName"] == MONEY_ARN]) == 1
    _, view_body = call("GET", "/v1/money")
    assert view_body["nextCheckAllowedAt"] == "2026-11-18T07:00:00.000Z"
    app.clock.now = app.clock.now + timedelta(hours=1, seconds=1)
    assert call("POST", "/v1/money/refresh")[0] == 202


def test_a_failed_check_now_gives_the_hour_back(call: Call, lambda_client: FakeLambda) -> None:
    lambda_client.fail = True
    assert call("POST", "/v1/money/refresh")[0] == 503
    lambda_client.fail = False
    assert call("POST", "/v1/money/refresh")[0] == 202


def test_country_is_picked_from_the_list(call: Call) -> None:
    status, body = call("PUT", "/v1/money/country", {"country": "SE"})
    assert status == 200
    assert body["country"] == "SE"
    status, body = call("PUT", "/v1/money/country", {"country": "XX"})
    assert status == 400
    assert body["error"]["field"] == "country"


def test_only_a_pending_celebration_can_be_seen_and_it_never_plays_again(call: Call, store: db.Store) -> None:
    pk = db.user_pk(USER)
    pending = {"key": "youtube:in_program", "platform": "youtube", "kind": "in_program", "text": "You're in!"}
    store.put({"pk": pk, "sk": money.state_sk("youtube"), "state": "in_program", "pendingCelebrations": [pending]})
    assert call("POST", "/v1/money/seen", {"key": "youtube:first_money"})[0] == 404
    assert call("POST", "/v1/money/seen", {"key": "nonsense"})[0] == 404
    status, body = call("POST", "/v1/money/seen", {"key": "youtube:in_program"})
    assert status == 200
    assert body["celebrations"] == []
    item = store.get(pk, money.state_sk("youtube"))
    assert item is not None
    assert "youtube:in_program" in item["celebrated"]
    assert call("POST", "/v1/money/seen", {"key": "youtube:in_program"})[0] == 404


def test_money_days_route(call: Call, store: db.Store) -> None:
    pk = db.user_pk(USER)
    for day in ("2026-11-01", "2026-11-02"):
        store.put(
            {
                "pk": pk,
                "sk": money.revenue_sk("youtube", day),
                "date": day,
                "amountMicros": 10,
                "currency": "USD",
                "unit": "USD",
                "source": "youtube.estimatedRevenue",
            }
        )
    status, body = call("GET", "/v1/money/youtube/days", query={"from": "2026-11-02", "to": "2026-11-30"})
    assert status == 200
    assert [d["date"] for d in body["days"]] == ["2026-11-02"]
    assert body["days"][0]["tag"] == "YouTube's estimate"
    assert call("GET", "/v1/money/youtube/days", query={"from": "2020-01-01", "to": "2026-11-30"})[0] == 400
    assert call("GET", "/v1/money/myspace/days")[0] == 404
    assert call("GET", "/v1/money/youtube/days", query={"from": "yesterday"})[0] == 400


# --- forget (explicit YouTube Disconnect only) -------------------------------------------------------------------


def test_forget_deletes_the_youtube_money_only(store: db.Store) -> None:
    from test_stats import make_deps

    pk = db.user_pk(USER)
    for platform in ("youtube", "tiktok"):
        store.put({"pk": pk, "sk": money.state_sk(platform), "state": "not_available"})
        store.put({"pk": pk, "sk": money.acctstat_sk(platform, "2026-11-17"), "day": "2026-11-17"})
        store.put({"pk": pk, "sk": money.revenue_sk(platform, "2026-11-17"), "amountMicros": 1})
    store.put(
        {
            "pk": pk,
            "sk": "POST#01JZ0000000000000000000001",
            "type": "post",
            "postId": "01JZ0000000000000000000001",
            "platform": "youtube",
            "status": "posted",
            "revenue": {"amountMicros": 5},
        }
    )
    out = stats_handle({"action": "forget", "userId": USER, "platform": "youtube"}, make_deps(store, FakeHttp()))
    assert out["money"] == 3
    left = {i["sk"] for i in store.query_all(pk, "")}
    assert money.state_sk("tiktok") in left
    assert money.revenue_sk("tiktok", "2026-11-17") in left
    assert not [s for s in left if "youtube" in s]
    post = store.get(pk, "POST#01JZ0000000000000000000001")
    assert post is not None
    assert "revenue" not in post


# --- the Lambda --------------------------------------------------------------------------------------------------


def test_the_daily_run_reads_every_registered_owner(deps: MoneyDeps, store: db.Store, fake_http: FakeHttp) -> None:
    money.register_owner(store, USER, NOW)
    connect(store, "instagram", [], account_id="1784")
    fake_http.answers.append((200, {"followers_count": 10}))
    assert handler.handle({"source": "aws.events"}, deps) == {"action": "daily", "owners": 1}
    assert state(store, "instagram")["numbers"] == {"followers": 10}
    assert handler.handle({"action": "refresh"}, deps) == {"action": "bad_event"}
    assert handler.handle({"what": "ever"}, deps) == {"action": "bad_event"}


def test_the_money_lambda_never_writes_outside_the_owner_or_registry(
    deps: MoneyDeps, store: db.Store, fake_http: FakeHttp, table: FakeTable
) -> None:
    """The role has no DeleteItem, and the run only writes the owner's money items, the Account's
    ``moneyScopesMissing``, Post ``revenue`` and the shared rate budgets."""
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    before = {(i["pk"], i["sk"]) for i in table.all()}
    fake_http.answers.extend(yt_answers())
    collect.run_user(deps, USER, platforms=("youtube",))
    changed = {(i["pk"], i["sk"]) for i in table.all()} - before
    assert all(pk == db.user_pk(USER) or pk.startswith("RATE#") for pk, _ in changed)
    assert not [c for c in table.calls if c[0] == "delete_item"]


def test_youtube_urls_never_carry_the_token() -> None:
    http = FakeHttp(*yt_answers())
    sources.read_youtube(http, "SECRET-TOKEN", scopes=YT_SCOPES, now=NOW, video_ids={})
    assert not [u for u in http.urls if "SECRET-TOKEN" in u]
    q = parse_qs(urlsplit(http.urls[2]).query)
    assert q["ids"] == ["channel==MINE"]


# --- per clip and per week (§25.5) ---------------------------------------------------------------------------------


def test_the_clip_page_shows_youtubes_estimate_only_when_reported(call: Call, store: db.Store) -> None:
    from conftest import seed_clip
    from test_performance import seed_post

    clip = seed_clip(store, status="posted")
    seed_post(
        store,
        clip,
        "youtube",
        revenue={
            "amountMicros": 420_000,
            "currency": "USD",
            "through": "2026-11-17",
            "source": "youtube.estimatedRevenue",
        },
    )
    seed_post(store, clip, "facebook", revenue={"amountMicros": 9, "currency": "USD", "source": "x"})  # unverified
    seed_post(store, clip, "tiktok")
    status, body = call("GET", f"/v1/clips/{clip['clipId']}/performance")
    assert status == 200
    rows = {r["platform"]: r for r in body["posts"]}
    assert rows["youtube"]["revenue"] == {
        "platform": "youtube",
        "amountMicros": 420_000,
        "currency": "USD",
        "source": "youtube.estimatedRevenue",
        "through": "2026-11-17",
        "tag": "YouTube's estimate",
    }
    assert "revenue" not in rows["facebook"]
    assert "revenue" not in rows["tiktok"]


def test_this_week_gets_the_reported_total_per_platform(call: Call, store: db.Store) -> None:
    pk = db.user_pk(USER)
    for day, amount in (("2026-11-08", 1_000_000), ("2026-11-10", 500_000), ("2026-11-15", 250_000), ("2026-11-16", 9)):
        store.put(
            {
                "pk": pk,
                "sk": money.revenue_sk("youtube", day),
                "date": day,
                "amountMicros": amount,
                "currency": "USD",
                "unit": "USD",
                "source": "youtube.estimatedRevenue",
            }
        )
    query = {"from": "2026-11-08T23:00:00.000Z", "to": "2026-11-15T23:00:00.000Z"}
    status, body = call("GET", "/v1/weeks/2026-W46", query=query)
    assert status == 200
    assert body["week"]["revenueByPlatform"] == {
        "youtube": {
            "platform": "youtube",
            "currency": "USD",
            "amountMicros": 750_000,  # Monday 9 to Sunday 15, as YouTube counts days
            "source": "youtube.estimatedRevenue",
            "tag": "YouTube's estimate",
        }
    }


def test_a_week_without_reported_money_has_no_money_field(call: Call) -> None:
    query = {"from": "2026-11-08T23:00:00.000Z", "to": "2026-11-15T23:00:00.000Z"}
    _, body = call("GET", "/v1/weeks/2026-W46", query=query)
    assert "revenueByPlatform" not in body["week"]
