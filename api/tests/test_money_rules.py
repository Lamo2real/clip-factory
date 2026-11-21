"""config/monetization.json (docs/CONTRACTS.md §25.2): every goal has an official source, and rules switch by date,
programme state and country."""

from __future__ import annotations

import copy
import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api.money import rules
from clipfactory_api.stats import config

ROOT = Path(__file__).resolve().parents[2]
RAW: dict[str, Any] = json.loads((ROOT / "config" / "monetization.json").read_text())


def test_the_committed_file_loads() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    assert cfg.as_of == date(2026, 11, 21)
    assert set(cfg.platforms) == {"youtube", "tiktok", "instagram", "facebook", "x"}
    assert "other" in cfg.country_codes()


def test_every_goal_names_an_official_source() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    for platform in cfg.platforms.values():
        for rule in platform.rules:
            for goal in (*rule.goals, *rule.more):
                assert goal["source"].startswith("https://"), goal
                host = goal["source"].split("/")[2]
                assert host in rules.OFFICIAL_HOSTS, goal
                assert goal["verifiedHow"] in {"official-page", "official-snippet"}, goal


@pytest.mark.parametrize("host", ["https://www.someblog.com/how-much-youtube-pays", "http://support.google.com/x"])
def test_a_third_party_or_plain_http_source_is_refused(host: str) -> None:
    raw = copy.deepcopy(RAW)
    raw["platforms"]["youtube"]["rules"][0]["goals"][0]["source"] = host
    with pytest.raises(rules.RulesError, match="source"):
        rules.parse(raw)


def test_a_goal_without_a_source_is_refused() -> None:
    raw = copy.deepcopy(RAW)
    del raw["platforms"]["instagram"]["rules"][0]["goals"][0]["source"]
    with pytest.raises(rules.RulesError, match="source"):
        rules.parse(raw)


def test_no_money_rates_live_in_the_config() -> None:
    keys: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            keys.extend(k.lower() for k in node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(RAW)
    assert not [k for k in keys if any(w in k for w in ("usd", "per1000", "rpm", "cpm", "rate", "paysperview"))]


def test_youtube_rules_switch_on_1_february_2027() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    before = rules.pick(cfg, "youtube", today=date(2027, 1, 31), in_program=False, country=None)
    after = rules.pick(cfg, "youtube", today=date(2027, 2, 1), in_program=False, country=None)
    assert isinstance(before, rules.Rule)
    assert isinstance(after, rules.Rule)
    goals = {g["key"]: g["goal"] for g in before.goals}
    assert goals == {"subscribers": 1000, "watchHours": 4000, "shortsViews": 10_000_000}
    assert {g["key"]: g["goal"] for g in after.goals} == {
        "subscribers": 1000,
        "watchHours": 8000,
        "shortsViews": 20_000_000,
    }
    assert before.upcoming
    assert "8,000" in before.upcoming
    in_before = rules.pick(cfg, "youtube", today=date(2027, 1, 31), in_program=True, country=None)
    in_after = rules.pick(cfg, "youtube", today=date(2027, 2, 1), in_program=True, country=None)
    assert in_before is None
    assert isinstance(in_after, rules.Rule)
    assert in_after.goals[0]["key"] == "keepShorts"


def test_tiktok_goals_depend_on_the_country() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    today = date(2026, 11, 18)
    assert rules.pick(cfg, "tiktok", today=today, in_program=False, country=None) == "no_country"
    assert rules.pick(cfg, "tiktok", today=today, in_program=False, country="other") == "not_open"
    us = rules.pick(cfg, "tiktok", today=today, in_program=False, country="US")
    jp = rules.pick(cfg, "tiktok", today=today, in_program=False, country="JP")
    assert isinstance(us, rules.Rule)
    assert isinstance(jp, rules.Rule)
    assert us.goals[0]["goal"] == 10_000
    assert jp.goals[0]["goal"] == 50_000


def test_facebook_has_no_finish_line_and_money_waits_for_a_live_check() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    fb = cfg.platform("facebook")
    assert fb.rules == ()
    assert fb.money_verified is False  # flipped only after one live call is checked against Meta Business Suite


def test_progress_measures_or_goals_and_missing_numbers() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    rule = rules.pick(cfg, "youtube", today=date(2026, 11, 18), in_program=False, country=None)
    assert isinstance(rule, rules.Rule)
    goals, more = rules.progress(rule, {"subscribers": 1200, "watchHours365": 100, "shortsViews90": 11_000_000})
    assert [g["reached"] for g in goals] == [True, False, True]
    assert rules.all_reached(goals)
    goals, _ = rules.progress(rule, {"subscribers": 812, "watchHours365": 4100, "shortsViews90": 0})
    assert not rules.all_reached(goals)
    assert goals[0]["current"] == 812
    assert goals[0]["goal"] == 1000
    assert goals[0]["note"] == "YouTube rounds this"
    assert [g["key"] for g in more] == ["fanSubscribers", "fanUploads", "fanWatchHours", "fanShortsViews"]
    tik = rules.pick(cfg, "tiktok", today=date(2026, 11, 18), in_program=False, country="US")
    assert isinstance(tik, rules.Rule)
    goals, _ = rules.progress(
        tik,
        {
            "followers": None,
            "views30": 5,
            "missing": {"followers": "Allow follower reading"},
            "counting": {"views30": 12},
        },
    )
    assert goals[0]["missing"] == "Allow follower reading"
    assert goals[0]["current"] is None
    assert goals[1]["countingDaysLeft"] == 12
    assert goals[1]["current"] is None


def test_x_impressions_are_a_number_without_a_bar() -> None:
    cfg = rules.load(ROOT / "config" / "monetization.json")
    rule = rules.pick(cfg, "x", today=date(2026, 11, 18), in_program=False, country="US")
    assert isinstance(rule, rules.Rule)
    goals, _ = rules.progress(rule, {"premium": True, "verifiedFollowers": 120, "impressions90": 40_000})
    by = {g["key"]: g for g in goals}
    assert by["premium"]["kind"] == "tick"
    assert by["premium"]["reached"]
    assert by["impressions90"]["kind"] == "number"
    assert by["impressions90"]["goal"] is None
    assert not rules.all_reached(goals)


def test_the_get_paid_config_fixes() -> None:
    """§40.3: X's programme is Original Content Rewards in Creator Studio; Creator Rewards isn't open in Sweden;
    YouTube's 2027 rules cite answer 12843009. The goals keep their ids, so stored celebrations stay."""
    cfg = rules.load(ROOT / "config" / "monetization.json")
    x = cfg.platform("x")
    assert x.programme == "Original Content Rewards"
    assert dict(x.status_where) == {"label": "X › Creator Studio", "url": "https://x.com/i/jf/creators/studio"}
    assert dict(x.paid_where) == {
        "label": "X › Creator Studio (paid through Stripe)",
        "url": "https://x.com/i/jf/creators/studio",
    }
    x_rule = next(r for r in RAW["platforms"]["x"]["rules"])
    assert x_rule["id"] == "x-revenue-sharing"  # the id stays
    assert {g["key"] for g in x_rule["goals"]} == {"premium", "verifiedFollowers", "impressions90"}
    assert {g["source"] for g in x_rule["goals"]} == {"https://help.x.com/en/using-x/original-content-rewards"}
    tiktok = cfg.platform("tiktok")
    assert dict(tiktok.status_where) == {"label": "TikTok Studio › Monetization"}
    open_rule = next(r for r in RAW["platforms"]["tiktok"]["rules"] if r["id"] == "tiktok-rewards")
    assert open_rule["countries"] == ["US", "GB", "DE", "FR", "BR"]
    today = date(2026, 11, 21)
    assert rules.pick(cfg, "tiktok", today=today, in_program=False, country="SE") == "not_open"
    assert isinstance(rules.pick(cfg, "tiktok", today=today, in_program=False, country="JP"), rules.Rule)
    for r in RAW["platforms"]["tiktok"]["rules"]:
        for g in r["goals"]:
            assert g["source"] == "https://www.tiktok.com/creator-academy/en/article/creator-rewards-program"
    by_id = {r["id"]: r for r in RAW["platforms"]["youtube"]["rules"]}
    for rule_id in ("ypp-2027", "ypp-2027-keep-shorts"):
        assert {g["source"] for g in by_id[rule_id]["goals"]} == {"https://support.google.com/youtube/answer/12843009"}
    assert {g["source"] for g in by_id["ypp-2023"]["goals"] + by_id["ypp-2023"].get("more", [])} == {
        "https://support.google.com/youtube/answer/72851"
    }
    # Each new source is on its platform's own help host.
    for host in ("help.x.com", "www.tiktok.com", "support.google.com"):
        assert host in rules.OFFICIAL_HOSTS


def test_money_scopes_are_only_for_allow_money_reading() -> None:
    cfg = config.load()
    assert cfg.platform("youtube").money_scopes == ("https://www.googleapis.com/auth/yt-analytics-monetary.readonly",)
    assert cfg.platform("tiktok").money_scopes == ("user.info.stats",)
    for name in ("instagram", "facebook", "x"):
        assert cfg.platform(name).money_scopes == ()
    # Connect keeps exactly today's scopes.
    assert cfg.platform("youtube").scopes == (
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
    )
    assert cfg.platform("tiktok").scopes == ("user.info.basic", "video.publish", "video.list")


def test_payment_scopes_are_only_for_allow_payment_reading() -> None:
    """§40.6: ``paymentScopes`` (YouTube's AdSense permission) never overlaps Connect's or money reading's."""
    cfg = config.load()
    assert cfg.platform("youtube").payment_scopes == ("https://www.googleapis.com/auth/adsense.readonly",)
    for name in ("tiktok", "instagram", "facebook", "x"):
        assert cfg.platform(name).payment_scopes == ()
    assert "https://www.googleapis.com/auth/adsense.readonly" not in cfg.platform("youtube").scopes
    raw = copy.deepcopy(cfg.raw)
    raw["platforms"]["youtube"]["paymentScopes"] = ["https://www.googleapis.com/auth/youtube.readonly"]
    with pytest.raises(config.ConfigError, match="paymentScopes"):
        config.parse(raw)
    raw["platforms"]["youtube"]["paymentScopes"] = ["https://www.googleapis.com/auth/yt-analytics-monetary.readonly"]
    with pytest.raises(config.ConfigError, match="paymentScopes"):
        config.parse(raw)
    raw["platforms"]["youtube"]["paymentScopes"] = "adsense"
    with pytest.raises(config.ConfigError, match="paymentScopes"):
        config.parse(raw)
