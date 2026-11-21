"""A page's two queries → one ``FinderCard`` (docs/CONTRACTS.md §41.2 "Normalizing", §41.3, §41.6 Tests P)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from clipfactory_api.contentrewards.finder import normalize
from finder_fakes import NOW, fixture, samples

CASES: dict[str, Any] = json.loads(fixture("normalize_cases.json"))["cases"]


def _row(p: dict[str, Any]) -> list[Any]:
    return [
        p["platform"],
        p["per1kCents"],
        p["perPostCents"],
        p["maxPayoutCents"],
        p.get("otherCountriesPer1kCents"),
        [g["per1kCents"] for g in p.get("countryRates") or []],
    ]


@pytest.mark.parametrize("key", sorted(CASES))
def test_every_sample(key: str) -> None:
    pair = samples()[key]
    card = normalize.card(pair["detail"], pair["card"], None, NOW)
    expect = CASES[key]
    got = {
        **card,
        "pay": [_row(p) for p in card["pay"]],
        "categories": [c["id"] for c in card["categories"]],
        "budget": {k: card["budget"][k] for k in ("totalCents", "spentCents", "leftCents")},
    }
    for field, value in expect.items():
        assert got[field] == value, (key, field)
    assert len(json.dumps(card).encode()) <= 6 * 1024
    assert "description" not in card
    assert pair["detail"]["description"][:40] not in json.dumps(card)  # the brand's text is read, never stored


def test_categories_card_first_then_the_detail_leaf_deduplicated() -> None:
    mack = samples()["d15-mack-twitch-apply"]
    card = normalize.card(mack["detail"], mack["card"], None, NOW)
    assert card["categories"] == [{"id": "pc-gaming", "name": "PC Gaming"}, {"id": "gaming", "name": "Gaming"}]
    alone = normalize.card(mack["detail"], None, None, NOW)
    assert [c["id"] for c in alone["categories"]] == ["pc-gaming"]
    odd = copy.deepcopy(mack)
    odd["card"]["categories"] = [
        {"id": "Bad Id", "name": "x"},
        {"id": "ok-1", "name": "N" * 60},
        *({"id": f"c{i}", "name": f"C{i}"} for i in range(9)),
    ]
    cats = normalize.card(odd["detail"], odd["card"], None, NOW)["categories"]
    assert len(cats) == 6
    assert cats[0] == {"id": "ok-1", "name": "N" * 40}


def test_on_discover_needs_active_listed_and_public() -> None:
    base = samples()["d18-pickleball"]["detail"]
    assert normalize.on_discover(base)
    for change in ({"status": "paused"}, {"showOnDiscover": False}, {"private": True}, {"organizationPrivate": True}):
        assert not normalize.on_discover({**base, **change}), change
    assert normalize.on_discover({k: v for k, v in base.items() if k != "showOnDiscover"})


def test_sentences_and_the_overlay_rule() -> None:
    assert normalize.sentences("Made in the U.S. Post it! Now?\nOK") == ["Made in the US Post it", "Now", "OK"]
    mack = "No watermarks from other apps and no other streamers' overlays or names in frame"
    assert normalize.overlay(mack) is None
    assert normalize.overlay("Every clip must include KreekCraft's overlay and drive viewers back!") == "needed"
    assert normalize.overlay("A small overlay looks nice.") == "maybe"
    assert normalize.overlay("A small overlay looks nice. You must use our overlay.") == "needed"
    assert normalize.overlay("Overlayed text is fine.") is None  # whole words only


def test_the_sound_rule_uses_only_the_words_sound_and_sounds() -> None:
    assert normalize.sound("Must add the official sound (muted) + #TheWeeknd #fayewong") == "needed"
    assert normalize.sound("$3,000 8lanco 'Every Little Thing' Sound Campaign") == "maybe"
    assert normalize.sound("Official sound at 100% volume.") == "maybe"
    assert normalize.sound("Audio: Use your own voice or any music, track or audio.") is None
    assert normalize.sound("Don't use trending sounds.") is None
    assert normalize.sound("Don\u2019t use trending sounds.") is None  # a curly apostrophe


def test_the_audience_rule() -> None:
    assert normalize.audience("Creators must be 21+ and US-based, with at least 50% US views per clip")
    assert normalize.audience("This is for English content that targets tier 1 audience.")
    assert normalize.audience("Only verified views from the US, UK, Canada count.")
    assert normalize.audience("Most viewers in the U.S. please")
    assert not normalize.audience("Send us your best views!")  # "us" is a word, not the country
    assert not normalize.audience("Post in the US.")  # no views, viewers, audience or based
    assert not normalize.audience("Big audience, any country.")


def test_languages_from_the_name_and_the_page_language_from_the_description() -> None:
    assert normalize.languages("Split-Screen UGC [English]", "short") == (["en"], None)
    assert normalize.languages(
        "Clips Hablando - 1$ por cada 1000 visitas", "Gana dinero clipeando a Carlos Esparraga. "
    ) == (
        [],
        None,
    )
    spanish = (
        "Gana dinero con los mejores clips del canal. Sube tus videos para que el público los vea y por cada mil "
        "visitas te pagamos. Es fácil y rápido para todos los creadores que quieren crecer en las redes."
    )
    assert normalize.page_language(spanish) == "es"
    assert normalize.page_language("the and the and the and") is None  # fewer than 25 words
    mixed = " ".join(["the and of", "el los las", "x"] * 9)
    assert normalize.page_language(mixed) is None  # no 1.5 times lead
    assert normalize.languages("日本語 [Japanese] clips", "")[0] == []  # only the six of the finder


def test_hidden_rules_group_ids_and_the_6_kb_cap() -> None:
    lanco = samples()["d07-8lanco-sound"]
    card = normalize.card(lanco["detail"], lanco["card"], None, NOW)
    assert (card["hiddenRules"], card["groupIds"]) == (2, ["e7b7aa0d-8d5c-460b-bb1e-803ad0492bc5"])
    ungodly = samples()["d11-ungodly-apply"]
    assert normalize.card(ungodly["detail"], ungodly["card"], None, NOW)["hiddenRules"] is None
    big = copy.deepcopy(samples()["d04-cod-dmz"])
    big["detail"]["configuration"]["geoRates"]["tiers"] = [
        {"label": f"Tier {i}", "countries": [f"C{j}" for j in range(60)], "platform": "tiktok", "rate": i}
        for i in range(12)
    ]
    big["card"]["group"] = {"name": "G", "campaignIds": [f"00000000-0000-4000-8000-{i:012d}" for i in range(40)]}
    fat = normalize.card(big["detail"], big["card"], None, NOW)
    assert len(json.dumps(fat).encode()) <= 6 * 1024
    assert len(fat["pay"][0]["countryRates"]) == 12  # the rates stay, the long country lists go


def test_listed_at_falls_back_to_the_sitemap_lastmod() -> None:
    pickle = samples()["d18-pickleball"]
    card = normalize.card(pickle["detail"], None, 1794677024, NOW)
    assert card["listedAt"] == "2026-11-14T17:23:44.000Z"
    assert card["brand"] == "Canadian National Pickleball League"


def test_budget_numbers() -> None:
    assert normalize.used_bps({"totalCents": 250000, "spentCents": 8990}) == 360
    assert normalize.used_bps({"totalCents": 0, "spentCents": 0}) is None
    assert normalize.used_bps({"totalCents": None, "spentCents": 5}) is None
    assert normalize.used_bps({"totalCents": 3, "spentCents": 1}) == 3333
    assert normalize.left_pct(360) == 96
    assert normalize.left_pct(7865) == 21
    assert normalize.left_pct(0) == 100
    assert normalize.left_pct(10000) == 0
