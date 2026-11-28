"""Can I earn yet? (docs/CONTRACTS.md §58): the one-word status, the once-only Ready and Close milestones, and the
push that tells the owner which app and what to do next.

The rules under test: "Ready" only when every requirement is met (an ``or`` pair needs one), "Close" from 90% with
every requirement visible, "Can't see" whenever a number can't be read (never a guess), "Not here" for a programme not
open in the owner's country, each milestone once ever, Ready wins over Close, and nothing is applied for: the owner
only gets where to go.
"""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db, money
from clipfactory_api.app import App
from clipfactory_api.money import collect, rules, view
from clipfactory_api.money.collect import MoneyDeps
from clipfactory_api.push import devices, notify
from clipfactory_api.realtime.broadcast import _deserializer
from clipfactory_api.stats import config as stats_config
from conftest import USER, Call, Clock
from fakes import FakeHttp, FakeSecretsManager
from test_money import NOW, YT_SCOPES, FakeTokens, connect, state
from test_push import APPLE, SECRET, SUBJECT, VAPID_PEM, Browser, PushService, _record

PK = db.user_pk(USER)


@pytest.fixture
def http() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def run(store: db.Store, http: FakeHttp) -> MoneyDeps:
    return MoneyDeps(
        store=store,
        tokens=FakeTokens(),
        http=http,
        clock=lambda: NOW,
        rules=rules.load(),
        platforms=stats_config.load(),
    )


def goal(
    key: str, current: int | None, target: int, *, kind: str = "bar", partner: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {"key": key, "kind": kind, "current": current, "goal": target}
    out["reached"] = current is not None and current >= target
    if partner:
        out["or"] = partner
    return out


# --- the one word ---------------------------------------------------------------------------------------------------


def test_ready_needs_every_requirement_and_one_of_an_or_pair() -> None:
    goals = [
        goal("subscribers", 1000, 1000),
        goal("watchHours", 120, 4000, partner="shortsViews"),
        goal("shortsViews", 10_000_000, 10_000_000, partner="watchHours"),
    ]
    assert rules.readiness(goals) == ("ready", 100)
    goals[0] = goal("subscribers", 999, 1000)
    assert rules.readiness(goals) == ("close", 99)  # rounded down: 99.9% is never "100%"


def test_close_is_90_percent_of_the_slowest_requirement() -> None:
    assert rules.readiness([goal("followers", 9000, 10000), goal("views30", 95_000, 100_000)]) == ("close", 90)
    assert rules.readiness([goal("followers", 8999, 10000), goal("views30", 100_000, 100_000)]) == ("not_yet", 89)


def test_percent_is_whole_numbers_never_a_float_rounding() -> None:
    goals = [goal("subscribers", 1000, 1000), goal("shortsViews", 2_900_000, 10_000_000)]
    assert rules.readiness(goals) == ("not_yet", 29)


def test_after_ready_under_an_older_rule_nothing_more() -> None:
    rule = rules.pick(rules.load(), "instagram", today=NOW.date(), in_program=False, country="SE")
    assert isinstance(rule, rules.Rule)
    goals, _ = rules.progress(rule, {"followers": 470})
    assert collect._milestone("instagram", rule, goals, {"instagram:ready:old-rule"}, None) == []


def test_an_or_pair_counts_its_best_half() -> None:
    goals = [
        goal("subscribers", 950, 1000),
        goal("watchHours", 100, 4000, partner="shortsViews"),
        goal("shortsViews", 9_500_000, 10_000_000, partner="watchHours"),
    ]
    assert rules.readiness(goals) == ("close", 95)


def test_a_number_it_cant_read_is_cant_see_never_a_guess() -> None:
    goals = [goal("followers", None, 10000), goal("views30", 100_000, 100_000)]
    assert rules.readiness(goals) == ("cant_see", 100)
    assert rules.readiness([]) == ("cant_see", None)


def test_a_required_number_without_a_bar_keeps_x_from_ready() -> None:
    goals = [
        goal("premium", 1, 1, kind="tick"),
        goal("verifiedFollowers", 600, 500),
        {
            "key": "impressions90",
            "kind": "number",
            "current": 9_000_000,
            "goal": None,
            "reached": False,
            "required": True,
        },
    ]
    assert rules.readiness(goals)[0] == "cant_see"


# --- the card --------------------------------------------------------------------------------------------------------


def _ready(store: db.Store, platform: str, country: str | None = "SE") -> dict[str, Any]:
    if country:
        store.put({"pk": PK, "sk": money.PREFS_SK, "country": country})
    cards = {c["platform"]: c for c in view.money_view(store, USER, NOW)["platforms"]}
    return cards[platform].get("ready") or {}


def test_youtube_card_says_how_far_and_where_to_apply(store: db.Store) -> None:
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    numbers = {"subscribers": 412, "shortsViews90": 3_100_000, "watchHours365": 20, "uploads90": 40}
    store.put({"pk": PK, "sk": money.state_sk("youtube"), "state": "not_yet", "numbers": numbers})
    ready = _ready(store, "youtube")
    assert ready["status"] == "not_yet"
    assert ready["word"] == "Not yet"
    assert ready["percent"] == 31  # Shorts views are the slowest: 3.1M of 10M
    assert ready["next"] == "31% there. Keep posting!"
    assert ready["checked"] == rules.load().as_of.isoformat()
    assert all(u.startswith("https://support.google.com/") for u in ready["sources"])
    numbers.update(subscribers=1000, shortsViews90=10_000_000)
    store.put({"pk": PK, "sk": money.state_sk("youtube"), "state": "not_yet", "numbers": numbers})
    ready = _ready(store, "youtube")
    assert (ready["status"], ready["word"]) == ("ready", "Ready")
    assert ready["next"] == "Apply in YouTube Studio › Earn."
    assert ready["nextUrl"] == "https://studio.youtube.com/"


def test_creator_rewards_is_not_here_in_sweden(store: db.Store) -> None:
    connect(store, "tiktok", ["user.info.basic", "user.info.stats", "video.list"], account_id="TT1")
    store.put({"pk": PK, "sk": money.state_sk("tiktok"), "state": "not_available", "numbers": {"followers": 20000}})
    ready = _ready(store, "tiktok")
    assert (ready["status"], ready["word"]) == ("not_open", "Not here")
    assert ready["next"] == "Creator Rewards isn't open in Sweden yet."
    assert "Mexico" in ready["regionNote"]


def test_facebook_is_invite_only_and_joined_is_joined(store: db.Store) -> None:
    connect(store, "facebook", [], account_id="PAGE1")
    store.put({"pk": PK, "sk": money.state_sk("facebook"), "state": "unknown", "numbers": {"followers": 50}})
    ready = _ready(store, "facebook")
    assert (ready["status"], ready["word"]) == ("invite", "Invite")
    assert ready["sources"]
    assert all(u.startswith("https://creators.facebook.com/") for u in ready["sources"])
    connect(store, "youtube", YT_SCOPES, account_id="UC1")
    store.put({"pk": PK, "sk": money.state_sk("youtube"), "state": "in_program", "numbers": {"subscribers": 5000}})
    assert _ready(store, "youtube")["word"] == "Joined"


def test_not_connected_has_no_ready_block(store: db.Store) -> None:
    cards = view.money_view(store, USER, NOW)["platforms"]
    assert all("ready" not in c for c in cards)


# --- the milestones (once each, Ready wins) ---------------------------------------------------------------------------


def test_instagram_ready_is_queued_once_with_what_to_do(run: MoneyDeps, store: db.Store, http: FakeHttp) -> None:
    connect(store, "instagram", [], account_id="1784")
    http.answers.append((200, {"followers_count": 640, "id": "1784"}))
    collect.run_platform(run, USER, "instagram", now=NOW, country="SE")
    pending = state(store, "instagram")["pendingCelebrations"]
    ready = [c for c in pending if c["kind"] == "ready"]
    assert ready == [
        {
            "key": "instagram:ready:ig-gifts",
            "platform": "instagram",
            "kind": "ready",
            "text": "You can join Instagram Gifts on Instagram! Apply in Professional dashboard › Monetization.",
        }
    ]
    http.answers.append((200, {"followers_count": 700, "id": "1784"}))
    collect.run_platform(run, USER, "instagram", now=NOW, country="SE")
    again = [c for c in state(store, "instagram")["pendingCelebrations"] if c["kind"] == "ready"]
    assert len(again) == 1  # never queued twice


def test_close_once_and_never_after_ready(run: MoneyDeps, store: db.Store, http: FakeHttp) -> None:
    connect(store, "instagram", [], account_id="1784")
    http.answers.append((200, {"followers_count": 460, "id": "1784"}))
    collect.run_platform(run, USER, "instagram", now=NOW, country="SE")
    kinds = [c["kind"] for c in state(store, "instagram")["pendingCelebrations"]]
    assert kinds == ["close"]
    assert (
        state(store, "instagram")["pendingCelebrations"][0]["text"]
        == "Instagram money is close: 92% there. Keep posting!"
    )
    http.answers.append((200, {"followers_count": 470, "id": "1784"}))
    collect.run_platform(run, USER, "instagram", now=NOW, country="SE")
    assert [c["kind"] for c in state(store, "instagram")["pendingCelebrations"]] == ["close"]


def test_ready_straight_away_skips_close() -> None:
    rule = rules.pick(rules.load(), "instagram", today=NOW.date(), in_program=False, country="SE")
    assert isinstance(rule, rules.Rule)
    goals, _ = rules.progress(rule, {"followers": 900})
    found = collect._milestone("instagram", rule, goals, {"instagram:ready:ig-gifts"}, None)
    assert found == []  # ready already seen: no late "close" either


def test_no_milestone_where_the_programme_isnt_open(store: db.Store) -> None:
    rule = rules.pick(rules.load(), "tiktok", today=NOW.date(), in_program=False, country="SE")
    assert rule == "not_open"
    assert not [
        c
        for c in collect._celebrate("tiktok", rule, {"followers": 50_000}, "not_available", {}, first_money_due=False)
        if c["kind"] in {"ready", "close"}
    ]


# --- the push ----------------------------------------------------------------------------------------------------------


@pytest.fixture
def iphone() -> Browser:
    return Browser(APPLE)


@pytest.fixture
def service(iphone: Browser) -> PushService:
    return PushService([iphone])


@pytest.fixture
def push_app(app: App, service: PushService) -> App:
    app.push = devices.VapidKey(FakeSecretsManager({SECRET: VAPID_PEM}), SECRET, SUBJECT)
    app.push_post = service
    return app


@pytest.fixture
def notify_deps(push_app: App, service: PushService, clock: Clock) -> notify.NotifyDeps:
    return notify.NotifyDeps(
        store=push_app.store, key=push_app.push, deserialize=_deserializer(), post=service, clock=clock
    )


@pytest.fixture
def phone(call: Call, iphone: Browser, push_app: App) -> None:
    assert call("PUT", "/v1/push/devices/phone-12345678", iphone.json())[0] in (200, 201)


READY = {
    "key": "youtube:ready:ypp-2023",
    "platform": "youtube",
    "kind": "ready",
    "text": "You can join YouTube Partner Program on YouTube! Apply in YouTube Studio › Earn.",
}
GOAL = {
    "key": "youtube:goal:subscribers:1000",
    "platform": "youtube",
    "kind": "goal",
    "text": "You hit 1,000 subscribers!",
}


def ms(**fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": "MONEYSTATE#youtube", "type": "moneystate", "platform": "youtube", **fields}


def test_ready_is_pushed_once_with_the_platform_and_next_step(
    notify_deps: notify.NotifyDeps, phone: None, service: PushService
) -> None:
    record = _record(ms(pendingCelebrations=[]), ms(pendingCelebrations=[GOAL, READY]))
    notify.process({"Records": [record]}, notify_deps)
    notify.process({"Records": [record]}, notify_deps)  # a stream retry: nothing twice
    assert [(m["title"], m["body"], m["tag"], m["url"]) for m in service.shown] == [
        ("Clip Factory", READY["text"], "earn-youtube", "/money")
    ]
    assert notify_deps.store.get(PK, "NOTIFIED#earn#youtube:ready:ypp-2023")


def test_a_milestone_already_pending_or_seen_is_not_pushed_again(
    notify_deps: notify.NotifyDeps, phone: None, service: PushService
) -> None:
    notify.process(
        {"Records": [_record(ms(pendingCelebrations=[READY]), ms(pendingCelebrations=[READY]))]}, notify_deps
    )
    seen = ms(pendingCelebrations=[READY], celebrated={READY["key"]: "2026-11-28T08:00:00.000Z"})
    notify.process({"Records": [_record(ms(pendingCelebrations=[]), seen)]}, notify_deps)
    assert service.shown == []


def test_earn_off_sends_nothing(call: Call, notify_deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    status, _ = call("PUT", "/v1/settings", {"notify": {"earn": False}})
    assert status == 200
    notify.process({"Records": [_record(ms(pendingCelebrations=[]), ms(pendingCelebrations=[READY]))]}, notify_deps)
    assert service.shown == []
