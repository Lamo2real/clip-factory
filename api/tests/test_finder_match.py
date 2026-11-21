"""Matching, ranking and the server's words (docs/CONTRACTS.md §41.3, §41.5 ``matchedWant``, §41.6 Tests P)."""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from typing import Any

import pytest

from clipfactory_api.contentrewards import gates
from clipfactory_api.contentrewards.finder import config, match, normalize, words
from clipfactory_api.oauth import setup as oauth_setup
from finder_fakes import NOW, USER, fixture, samples, seed_places, store

CASES: list[dict[str, Any]] = json.loads(fixture("match_cases.json"))["cases"]
# The contract's line (§41.3), word for word.
DEFAULTS_LINE = (
    '{"on": true, "minPer1kCents": 100, "places": null, "categories": [], "minLeftPct": 25, "access": "open", '
    '"otherPay": false, "languages": [], "tellMe": true}'
)
BANNED = re.compile(r"\b(cpm|budget|api|mcp|scrape|sitemap|robots)\b", re.IGNORECASE)


def _cards() -> list[dict[str, Any]]:
    out = []
    for pair in samples().values():
        card = normalize.card(pair["detail"], pair["card"], None, NOW)
        out.append({**card, "readAt": "2026-11-21T10:00:00.000Z"})
    return out


def _resolve(case: dict[str, Any]) -> tuple[list[str], bool]:
    st = store()
    seed_places(st, USER, case["places"], tiktok_ok=case["tiktokOk"])
    setups = oauth_setup.all_setups(st, USER, NOW)
    want = match.with_defaults(case["want"])
    asked = list(want["places"]) if want["places"] is not None else ["youtube", "tiktok", "instagram", "facebook", "x"]
    return gates.upload_places(asked, setups, {}), gates.tiktok_waits(["tiktok"], setups)


def _find(case: dict[str, Any], cards: list[dict[str, Any]]) -> dict[str, Any]:
    places, waits = _resolve(case)
    now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
    return match.find(
        cards, case["want"], places=places, own=case["own"], hidden=case["hidden"], now=now, tiktok_waits=waits
    )


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_golden_case(case: dict[str, Any]) -> None:
    cards = _cards()
    result = _find(case, cards)
    expect = case["expect"]
    by_id = {m["campaignId"]: m for m in result["matches"]}
    assert [m["campaignId"] for m in result["matches"]] == expect["order"]
    assert [m["rank"] for m in result["matches"]] == list(range(1, len(expect["order"]) + 1))
    assert [[s["code"], s["count"]] for s in result["skipped"]] == [s[:2] for s in expect["skipped"]]
    texts = {s["code"]: s["text"] for s in result["skipped"]}
    for row in expect["skipped"]:
        if len(row) == 3:
            assert texts[row[0]] == row[2]
    assert result["looked"] == expect["looked"]
    assert sum(s["count"] for s in result["skipped"]) + len(result["matches"]) == result["looked"]
    for uuid, lines in expect.get("lines", {}).items():
        m = by_id[uuid]
        assert m["why"] == lines["why"], uuid
        assert m["notes"] == lines["notes"], uuid
        assert m["headsUp"] == lines["headsUp"], uuid
        assert m["cantTell"] == lines["cantTell"], uuid
        if "pay" in lines:
            assert [p["line"] for p in m["pay"]] == lines["pay"], uuid
    for uuid, code in expect.get("refused", {}).items():
        one = _find(case, [c for c in cards if c["uuid"] == uuid])
        assert [s["code"] for s in one["skipped"]] == [code], uuid
    if "noNote" in expect:
        assert all(expect["noNote"] not in m["notes"] for m in result["matches"])


def test_the_match_shape() -> None:
    result = _find(CASES[0], _cards())
    pickle = next(m for m in result["matches"] if m["campaignId"] == "3d9ef19f-1256-47ca-b630-e33e2c923969")
    assert pickle["url"] == "https://contentrewards.com/c/campaigns/3d9ef19f-1256-47ca-b630-e33e2c923969"
    assert pickle["budget"] == {
        "totalCents": 250000,
        "leftCents": 241010,
        "usedPct": 3.6,
        "line": "$2,410.10 left of $2,500",
        "asOf": "2026-11-21T10:00:00.000Z",
        "tag": "Content Rewards' numbers",
    }
    assert pickle["pay"][0] == {
        "platform": "youtube",
        "line": "$1.50 per 1,000 views · up to $250 a clip",
        "per1kCents": 150,
        "topPer1kCents": 150,
        "perPostCents": None,
        "maxPayoutCents": 25000,
        "geo": False,
    }
    assert pickle["maxPerClipCents"] == 25000
    assert pickle["categories"] == [
        {"id": "sports-highlights", "name": "Sports Highlights"},
        {"id": "sports", "name": "Sports"},
    ]
    assert (pickle["access"], pickle["kind"], pickle["hiddenRules"]) == ("open", "cpm", 0)
    assert pickle["launchedAt"] == "2026-11-14T17:23:44.000Z"
    assert set(pickle) == {
        "campaignId", "url", "name", "brand", "access", "kind", "pay", "maxPerClipCents", "budget", "categories",
        "why", "notes", "headsUp", "cantTell", "hiddenRules", "launchedAt", "rank",
    }  # fmt: skip
    assert "isNew" not in pickle  # added by the api (Q)
    assert "opened" not in pickle


def test_the_defaults_literal_and_with_defaults() -> None:
    assert json.loads(DEFAULTS_LINE) == config.DEFAULTS
    assert list(config.DEFAULTS) == list(json.loads(DEFAULTS_LINE))
    assert match.with_defaults(None) == config.DEFAULTS
    odd = match.with_defaults({"minPer1kCents": "lots", "on": 1, "places": ["youtube"], "extra": True})
    assert odd == {**config.DEFAULTS, "places": ["youtube"]}


def test_matched_want_against_the_literal_case() -> None:
    # Shared with Q's finderapi.py: SHA-256 over {"places": resolvedPlaces, "want": want with the defaults}.
    assert match.matched_want({}, ["youtube", "instagram"]) == "9043b6e229b09300"
    assert match.matched_want(config.DEFAULTS, ["youtube", "instagram"]) == "9043b6e229b09300"
    assert match.matched_want({}, ["youtube"]) != "9043b6e229b09300"


def _card(uuid: str, **fields: Any) -> dict[str, Any]:
    card: dict[str, Any] = {
        "uuid": uuid,
        "name": f"Campaign {uuid[-2:]}",
        "brand": "Brand",
        "onDiscover": True,
        "access": "open",
        "kind": "cpm",
        "pay": [
            {"platform": "youtube", "per1kCents": 150, "perPostCents": None, "maxPayoutCents": None, "minViews": None}
        ],
        "platformsPaid": ["youtube"],
        "budget": {"totalCents": 100000, "spentCents": 1000, "leftCents": 99000, "usedPct": 1.0},
        "categories": [{"id": "gaming", "name": "Gaming"}],
        "contentTypes": ["clipping"],
        "toggles": {"preApproval": False, "sound": False, "logoRequired": False, "faceOnCamera": False},
        "overlay": None,
        "sound": None,
        "audience": False,
        "namedLanguages": [],
        "pageLanguage": "en",
        "hiddenRules": 0,
        "launchedAt": "2026-11-01T00:00:00.000Z",
    }
    card.update(fields)
    return card


def _u(i: int) -> str:
    return f"00000000-0000-4000-8000-{i:012d}"


def _go(cards: list[dict[str, Any]], **want: Any) -> dict[str, Any]:
    return match.find(cards, want, places=["youtube"], own=[], hidden=[], now=NOW)


def test_ranking_ties_and_the_20_cap() -> None:
    cards = [_card(_u(i)) for i in range(25)]
    cards[3]["budget"] = {"totalCents": 200000, "spentCents": 1000, "leftCents": 199000, "usedPct": 0.5}
    cards[4]["launchedAt"] = "2026-11-20T00:00:00.000Z"
    cards[5]["launchedAt"] = None
    cards[6]["budget"] = {"totalCents": None, "spentCents": None, "leftCents": None, "usedPct": None}
    cards[7]["pay"][0]["per1kCents"] = 300
    result = _go(cards)
    order = [m["campaignId"] for m in result["matches"]]
    assert len(order) == 20
    # pay first, then the money left, then the newest (unknown last), then the uuid; the 20 cap
    assert order == [_u(7), _u(3), _u(4), _u(0), _u(1), _u(2), *(_u(i) for i in range(8, 22))]
    small = [m["campaignId"] for m in _go([cards[6], cards[5], cards[0]])["matches"]]
    assert small == [_u(0), _u(5), _u(6)]  # no launch date after one, a can't-tell line after all
    assert [m["rank"] for m in result["matches"]] == list(range(1, 21))
    assert result["looked"] == 25
    tie = _go([_card(_u(2)), _card(_u(1))])
    assert [m["campaignId"] for m in tie["matches"]] == [_u(1), _u(2)]  # the uuid last


def test_heads_ups_and_cant_tell_lines() -> None:
    result = _go(
        [
            _card(
                _u(1),
                overlay="maybe",
                toggles={"preApproval": False, "sound": False, "logoRequired": False, "faceOnCamera": True},
            ),
            _card(_u(2), budget={"totalCents": None, "spentCents": None, "leftCents": None, "usedPct": None}),
            _card(_u(3), contentTypes=["clipping", "sound"], audience=True),
        ]
    )
    by_id = {m["campaignId"]: m for m in result["matches"]}
    assert by_id[_u(1)]["headsUp"] == [words.HEADS_OVERLAY, words.HEADS_FACE]
    assert by_id[_u(2)]["cantTell"] == ["I can't tell how much money is left."]
    assert by_id[_u(2)]["why"] == "Pays $1.50 per 1,000 views on YouTube. Open to join."
    assert by_id[_u(2)]["budget"]["line"] is None
    assert by_id[_u(3)]["headsUp"] == [words.HEADS_SOUND, words.HEADS_AUDIENCE]


def test_topic_and_language_only_when_he_picked_some() -> None:
    none = _card(_u(1), categories=[])
    assert _go([none])["matches"][0]["cantTell"] == []
    picked = _go([none, _card(_u(2))], categories=["gaming"])
    assert picked["matches"][1]["cantTell"] == ["I can't tell what it's about."]
    assert (
        picked["matches"][0]["why"]
        == "Pays $1.50 per 1,000 views on YouTube. Gaming. 99% of the money left. Open to join."
    )
    other = _go([_card(_u(3), categories=[{"id": "music", "name": "Music"}])], categories=["gaming"])
    assert [s["code"] for s in other["skipped"]] == ["topic"]
    spanish = _go([_card(_u(4), pageLanguage="es")], languages=["en"])
    assert spanish["matches"][0]["headsUp"] == ["Its page is in Spanish."]
    named = _go([_card(_u(5), namedLanguages=["es"]), _card(_u(6), namedLanguages=["en", "es"])], languages=["en"])
    assert [m["campaignId"] for m in named["matches"]] == [_u(6)]
    assert named["skipped"][0]["text"] == "1 campaign wants another language."
    unknown = _go([_card(_u(7), pageLanguage=None)], languages=["en"])
    assert unknown["matches"][0]["cantTell"] == ["I can't tell the language."]
    assert _go([_card(_u(7), pageLanguage=None)])["matches"][0]["cantTell"] == []


def test_other_kinds_of_pay() -> None:
    per_post = _card(
        _u(1),
        kind="per_post",
        pay=[
            {"platform": "youtube", "per1kCents": None, "perPostCents": 500, "maxPayoutCents": None, "minViews": 1000}
        ],
    )
    retainer = _card(_u(2), kind="retainer", pay=[{"platform": "youtube", "per1kCents": None, "perPostCents": None}])
    other = _card(_u(3), kind="other", pay=[{"platform": "youtube", "per1kCents": None, "perPostCents": None}])
    assert [s["code"] for s in _go([per_post])["skipped"]] == ["other_pay"]
    result = _go([other, retainer, per_post], otherPay=True)
    assert [m["campaignId"] for m in result["matches"]] == [_u(1), _u(2), _u(3)]  # per post, retainer, other
    first, second, third = result["matches"]
    assert first["why"] == "Pays $5.00 for each approved post on YouTube. 99% of the money left. Open to join."
    assert first["pay"][0]["line"] == "$5.00 for each approved post · needs 1,000 views"
    assert second["pay"][0]["line"] == "Pays picked creators each month"
    assert second["why"].startswith("Pays picked creators each month on YouTube.")
    assert third["pay"][0]["line"] == "Pays in its own way. See its page."
    assert third["why"].startswith("Pays in its own way on YouTube.")


def test_not_on_discover_is_never_shown_and_refusals_come_from_the_page_only() -> None:
    result = _go([_card(_u(1), onDiscover=False), _card(_u(2))])
    assert result["looked"] == 1
    assert [s["code"] for s in result["skipped"]] == []
    gone = _go([_card(_u(3), budget={"totalCents": 100, "spentCents": 95, "leftCents": 5, "usedPct": 95.0})])
    assert gone["skipped"][0]["code"] == "budget_gone"
    low = _go([_card(_u(4), pay=[{"platform": "youtube", "per1kCents": 50}])])
    assert low["skipped"][0]["text"] == "1 campaign pays less than $1.00 per 1,000 views."


@pytest.mark.parametrize(
    ("code", "n", "want", "text"),
    [
        ("low_pay", 62, {"minPer1kCents": 100}, "62 pay less than $1.00 per 1,000 views."),
        ("low_pay", 1, {"minPer1kCents": 50}, "1 campaign pays less than $0.50 per 1,000 views."),
        ("budget_low", 31, {"minLeftPct": 25}, "31 have less than a quarter of the money left."),
        ("budget_low", 2, {"minLeftPct": 50}, "2 have less than half the money left."),
        ("budget_low", 1, {"minLeftPct": 75}, "1 campaign has less than three quarters of the money left."),
        ("budget_gone", 3, {}, "3 have almost no money left."),
        ("not_your_places", 12, {}, "12 don't pay for the places you post."),
        ("not_your_places", 1, {}, "1 campaign doesn't pay for the places you post."),
        ("apply", 9, {}, "9 want you to apply first."),
        ("other_pay", 2, {}, "2 pay per post or share a prize."),
        ("cant_make", 5, {}, "5 need something Clip Factory can't make."),
        ("topic", 7, {}, "7 are about other things."),
        ("language", 2, {}, "2 want another language."),
        ("hidden", 3, {}, "3 you said Not for me."),
        ("own", 1, {}, "1 campaign is in your campaigns already."),
    ],
)
def test_skipped_words(code: str, n: int, want: dict[str, Any], text: str) -> None:
    assert words.skipped(code, n, match.with_defaults(want)) == text


def test_every_line_is_short_plain_and_only_content_rewards_numbers() -> None:
    cards = _cards()
    pairs = {c["uuid"]: c for c in cards}
    lines: list[str] = [
        words.HEADS_SOUND, words.HEADS_OVERLAY, words.HEADS_FACE, words.HEADS_AUDIENCE, words.NOTE_GEO,
        words.NOTE_TIKTOK, words.CANT_MONEY, words.CANT_TOPIC, words.CANT_LANGUAGE, words.page_in("es"),
        words.also_pays(["facebook", "x"]), words.hidden_rules(1), words.hidden_rules(2),
    ]  # fmt: skip
    for case in CASES:
        result = _find(case, copy.deepcopy(cards))
        lines += [s["text"] for s in result["skipped"]]
        for m in result["matches"]:
            card = pairs[m["campaignId"]]
            numbers = {card["budget"]["leftCents"], card["budget"]["totalCents"]}
            for row in card["pay"]:
                numbers |= {row.get("per1kCents"), row.get("maxPayoutCents"), row.get("otherCountriesPer1kCents")}
                numbers |= {g.get("per1kCents") for g in row.get("countryRates") or []}
            shown = [m["why"], m["budget"]["line"] or "", *(p["line"] for p in m["pay"])]
            for line in shown:
                for amount in re.findall(r"\$([0-9][0-9,]*(?:\.[0-9]{2})?)", line):
                    cents = round(float(amount.replace(",", "")) * 100)
                    assert cents in numbers, (m["campaignId"], line)  # CR's own number, only formatted
            lines += [*shown, *m["notes"], *m["headsUp"], *m["cantTell"]]
    for line in lines:
        assert len(line.split()) <= 26, line
        assert not BANNED.search(line), line
        assert "CR " not in line


def test_rates_always_show_cents() -> None:
    assert words.rate(150) == "$1.50"
    assert words.rate(100) == "$1.00"
    assert words.rate(1200) == "$12.00"
    assert words.money_left(241010, 250000) == "$2,410.10 left of $2,500"
    assert words.money_left(None, 250000) is None
