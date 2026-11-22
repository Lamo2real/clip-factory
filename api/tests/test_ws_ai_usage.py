"""Model usage and cost, and storage (docs/CONTRACTS.md §45.5 ``…/usage`` and ``…/storage``, §45.6, §45.25, §45.29,
§45.33): tokens summed by day and model from ``USAGE#`` items, a cost only when a price is known (the owner's beats
the list price), long-context prices per call, render minutes from provider usage; storage summed from ``ASSET#``,
``REFVID#`` and skill revisions, never an S3 listing."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import types as ws
from fakes import FakeTable
from test_ws_ai_support import (
    AT,
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    prefix,
    seed,
    seed_asset,
    seed_usage,
    ws_call,
)


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def test_tokens_and_cost_by_day_and_model(wcall: WsCall, store: db.Store) -> None:
    seed_usage(store, "2026-11-15", "opus-5-5", input=1_000_000, output=100_000)
    seed_usage(store, "2026-11-15", "opus-5-5", input=500_000, output=0, cacheRead=1_000_000)
    seed_usage(store, "2026-11-14", "fable-5-2", input=10, output=20)
    seed_usage(store, "2026-10-01", "opus-5-5", input=99, output=99)  # older than 30 days
    seed(store, "USAGE#2026-11-15#p1", ws.TYPE_USAGE, kind="provider", providerId="builtin-2d", renderSec=90.5)
    seed(store, "USAGE#2026-11-15#p2", ws.TYPE_USAGE, kind="provider", providerId="nova-canvas", images=1)
    status, body = wcall("GET", f"{BASE}/usage")
    assert status == 200
    usage = body["usage"]
    assert len(usage["days"]) == 30
    assert usage["days"][-1]["day"] == "2026-11-15"
    assert usage["days"][0]["day"] == "2026-10-17"
    today = usage["days"][-1]["byModel"]
    # opus: 1.5M input at $4 + 1M cache reads at $0.2 + 0.1M output at $20 = 6 + 0.2 + 2
    assert today == [{"model": "opus-5-5", "input": 2_500_000, "output": 100_000, "cost": 8.2, "currency": "USD"}]
    totals = {t["model"]: t for t in usage["totals"]}
    assert totals["opus-5-5"]["cost"] == 8.2
    assert totals["fable-5-2"]["input"] == 10
    assert usage["renderMinutes"] == 1.5
    status, body = wcall("GET", f"{BASE}/usage", query={"days": "1"})
    assert [d["day"] for d in body["usage"]["days"]] == ["2026-11-15"]
    assert wcall("GET", f"{BASE}/usage", query={"days": "31"})[0] == 400
    assert wcall("GET", f"{BASE}/usage", query={"days": "0"})[0] == 400


def test_the_owners_price_wins_and_no_price_means_no_cost(
    wcall: WsCall, store: db.Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    models = res.models()
    for m in models:
        if m["key"] == "sonnet-5-5":
            m["pricing"] = None
    monkeypatch.setattr(res, "models", lambda: [dict(m) for m in models])
    seed_usage(store, "2026-11-15", "sonnet-5-5", input=1_000_000, output=0)
    seed_usage(store, "2026-11-15", "opus-5-5", input=1_000_000, output=0)
    _, body = wcall("GET", f"{BASE}/usage")
    rows = {r["model"]: r for r in body["usage"]["days"][-1]["byModel"]}
    assert (rows["sonnet-5-5"]["cost"], rows["sonnet-5-5"]["currency"]) == (None, None)  # "No price set."
    assert rows["opus-5-5"]["cost"] == 4.0
    wcall("PUT", f"{BASE}/ai/prices/sonnet-5-5", {"inputPer1M": 3, "outputPer1M": 15, "currency": "EUR"})
    _, body = wcall("GET", f"{BASE}/usage")
    rows = {r["model"]: r for r in body["usage"]["days"][-1]["byModel"]}
    assert (rows["sonnet-5-5"]["cost"], rows["sonnet-5-5"]["currency"]) == (3.0, "EUR")


def test_provider_usage_is_priced_only_when_its_price_is_known(wcall: WsCall, store: db.Store) -> None:
    usage = ws.TYPE_USAGE
    seed(store, "USAGE#2026-11-15#p1", usage, kind="provider", providerId="nova-canvas", images=2, cost=None)
    seed(
        store,
        "USAGE#2026-11-15#p2",
        usage,
        kind="provider",
        providerId="nova-reel",
        videoSec=6,
        cost=0.48,
        currency="USD",
    )
    seed(
        store,
        "USAGE#2026-11-14#p3",
        usage,
        kind="provider",
        providerId="nova-reel",
        videoSec=6,
        cost=0.48,
        currency="USD",
    )
    seed(store, "USAGE#2026-11-15#p4", usage, kind="provider", providerId="builtin-2d", renderSec=60, cost=None)
    _, body = wcall("GET", f"{BASE}/usage")
    day = body["usage"]["days"][-1]
    # model rows never carry a provider id (§45.34): providers have their own rows, in units
    assert day["byModel"] == []
    assert body["usage"]["totals"] == []
    assert day["byProvider"] == [
        {"provider": "nova-canvas", "units": 2, "unit": "image", "cost": None, "currency": None},  # "No price yet"
        {"provider": "nova-reel", "units": 6, "unit": "second", "cost": 0.48, "currency": "USD"},  # the agent's cost
        {"provider": "builtin-rig", "units": 60, "unit": "second", "cost": 0.0, "currency": None},  # free, built in
    ]
    assert day["renderMinutes"] == 1.0
    assert body["usage"]["days"][-2]["renderMinutes"] == 0.0
    totals = {t["provider"]: t for t in body["usage"]["totalsByProvider"]}
    assert totals["nova-reel"] == {
        "provider": "nova-reel",
        "units": 12,
        "unit": "second",
        "cost": 0.96,
        "currency": "USD",
    }
    assert totals["builtin-rig"]["cost"] == 0.0
    assert body["usage"]["renderMinutes"] == 1.0


def test_provider_usage_in_units_priced_by_the_owners_per_unit_price(wcall: WsCall, store: db.Store) -> None:
    """The agent's ``USAGE#`` items of kind ``provider`` carry ``provider``, ``units`` and ``unit`` (§45.34); the
    owner's per-picture or per-second price prices them; built-in render seconds are the day's render minutes."""
    usage = ws.TYPE_USAGE
    seed(store, "USAGE#2026-11-15#a", usage, kind="provider", provider="nova-canvas", units=3, unit="image")
    seed(store, "USAGE#2026-11-15#b", usage, kind="provider", provider="nova-reel", units=12, unit="second")
    seed(store, "USAGE#2026-11-15#c", usage, kind="provider", provider="builtin-rig", units=90, unit="second")
    seed(store, "USAGE#2026-11-14#d", usage, kind="provider", provider="builtin-2d", units=30, unit="second")
    seed(store, "USAGE#2026-11-14#e", usage, kind="provider", provider="nova-reel", units=6, unit="second")
    seed_usage(store, "2026-11-15", "opus-5-5", input=10, output=10)
    prices = {
        "nova-canvas": {"inputPer1M": 0, "outputPer1M": 0, "perUnit": 0.04, "currency": "USD"},
        "nova-reel": {"inputPer1M": 0, "outputPer1M": 0, "perUnit": 0.08, "currency": "USD"},
    }
    assert wcall("PUT", f"{BASE}/ai", {"defaultModel": "opus-5-5", "defaultEffort": "high", "prices": prices,
                                       "version": 0})[0] == 200  # fmt: skip
    _, body = wcall("GET", f"{BASE}/usage")
    today, yesterday = body["usage"]["days"][-1], body["usage"]["days"][-2]
    assert [r["model"] for r in today["byModel"]] == ["opus-5-5"]
    rows = {r["provider"]: r for r in today["byProvider"]}
    assert rows["nova-canvas"] == {
        "provider": "nova-canvas",
        "units": 3,
        "unit": "image",
        "cost": 0.12,
        "currency": "USD",
    }
    assert rows["nova-reel"]["cost"] == 0.96
    assert rows["builtin-rig"] == {
        "provider": "builtin-rig",
        "units": 90,
        "unit": "second",
        "cost": 0.0,
        "currency": None,
    }
    assert (today["renderMinutes"], yesterday["renderMinutes"]) == (1.5, 0.5)
    assert body["usage"]["renderMinutes"] == 2.0
    totals = {t["provider"]: t for t in body["usage"]["totalsByProvider"]}
    assert (totals["nova-reel"]["units"], totals["nova-reel"]["cost"]) == (18, 1.44)
    assert totals["builtin-rig"]["units"] == 120
    # every day is listed with its own render minutes and provider rows
    assert all(set(d) == {"day", "byModel", "renderMinutes", "byProvider"} for d in body["usage"]["days"])


def test_a_day_without_a_known_price_leaves_the_total_unpriced(wcall: WsCall, store: db.Store) -> None:
    usage = ws.TYPE_USAGE
    seed(store, "USAGE#2026-11-15#a", usage, kind="provider", provider="nova-reel", units=6, unit="second",
         cost=0.5, currency="USD")  # fmt: skip
    seed(store, "USAGE#2026-11-14#b", usage, kind="provider", provider="nova-reel", units=6, unit="second")
    _, body = wcall("GET", f"{BASE}/usage")
    (total,) = body["usage"]["totalsByProvider"]
    assert (total["units"], total["cost"], total["currency"]) == (12, None, None)


def test_a_long_context_call_uses_the_long_context_price(wcall: WsCall, store: db.Store) -> None:
    seed_usage(store, "2026-11-15", "haiku-5-5", input=200_000, output=10_000)
    seed_usage(store, "2026-11-15", "haiku-5-5", input=50_000, output=10_000)
    _, body = wcall("GET", f"{BASE}/usage")
    (row,) = body["usage"]["days"][-1]["byModel"]
    # 200k at $0.5 + 10k at $2.5 (above 100k input) and 50k at $0.1 + 10k at $0.5
    assert row["cost"] == round(0.1 + 0.025 + 0.005 + 0.005, 4)


def test_storage_from_the_items_not_a_listing(
    wcall: WsCall, store: db.Store, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AWS_REGION", "eu-north-1")  # the media bucket's Region (§45.34 ``location``)
    seed_asset(store, "final_video", 1000)
    seed_asset(store, "cover", 10)
    seed_asset(store, "scene_clip", 200)
    seed_asset(store, "scene_still", 20)
    seed_asset(store, "audio", 30)
    seed_asset(store, "storyboard", 5)
    seed_asset(store, "design_ref", 7)
    seed(store, "REFVID#r1", ws.TYPE_REFVID, refId="r1", status="analyzed", bytes=5000)
    seed(store, "REFVID#r2", ws.TYPE_REFVID, refId="r2", status="uploading", bytes=9999)
    seed(
        store,
        "SKILL#s1",
        ws.TYPE_SKILL,
        skillId="s1",
        builtin=False,
        revisions=[{"revisionId": "a", "size": 3}, {"revisionId": "b", "size": 4}],
    )
    seed(store, "SKILL#nonverbal-storytelling", ws.TYPE_SKILL, skillId="nonverbal-storytelling", builtin=True)
    seed(store, "ASSET#theirs", ws.TYPE_ASSET, user="someone-else", kind="final_video", bytes=10**9)
    status, body = wcall("GET", f"{BASE}/storage")
    assert status == 200
    # storyboards and captions count under scenes ("Scenes and storyboards", §45.34)
    assert body["storage"] == {
        "bytes": {"videos": 1010, "scenes": 225, "audio": 30, "references": 5000, "skills": 7, "other": 7},
        "files": 10,
        "location": {"region": "eu-north-1", "folder": f"s3://cf-prod-media-123/{prefix()}"},
    }


def test_captions_count_as_scenes_and_a_cleared_reference_holds_nothing(wcall: WsCall, store: db.Store) -> None:
    seed_asset(store, "captions", 40)
    seed_asset(store, "storyboard", 2)
    seed(store, "REFVID#r1", ws.TYPE_REFVID, refId="r1", status="analyzed", bytes=5000, fileRemovedAt=AT)
    _, body = wcall("GET", f"{BASE}/storage")
    assert body["storage"]["bytes"]["scenes"] == 42
    assert body["storage"]["bytes"]["references"] == 0
    assert body["storage"]["files"] == 2


def test_a_maker_models_own_price_counts_and_sound_is_priced_too(wcall: WsCall, store: db.Store) -> None:
    """The reviewer's G1/G2 minor: the price the owner typed on his own maker model prices what it made (by the
    item's ``modelId``), before his price of the maker; the sound makers can be priced (per second of sound, per
    character spoken) and their characters are counted."""
    picture = {"kind": "image", "label": "My SD", "provider": "Stability AI", "host": "bedrock",
               "modelId": "stability.sd3-5-large-v1:0", "region": "us-west-2",
               "price": {"perUnit": 0.08, "unit": "image", "currency": "USD"}}  # fmt: skip
    assert wcall("PUT", f"{BASE}/makers/models/custom-sd", picture)[0] == 200
    status, body = wcall("PUT", f"{BASE}/ai", {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0,
                                               "prices": {
        "own-images": {"perUnit": 0.5, "unit": "image", "inputPer1M": 0, "outputPer1M": 0, "currency": "USD"},
        "polly": {"perUnit": 0.00002, "unit": "character", "inputPer1M": 0, "outputPer1M": 0, "currency": "USD"},
        "elevenlabs": {"perUnit": 0.01, "unit": "second", "inputPer1M": 0, "outputPer1M": 0, "currency": "USD"},
    }})  # fmt: skip
    assert status == 200, body
    usage = ws.TYPE_USAGE
    seed(store, "USAGE#2026-11-15#a", usage, kind="provider", provider="own-images", units=2, unit="image",
         modelId="stability.sd3-5-large-v1:0")  # fmt: skip
    seed(store, "USAGE#2026-11-15#b", usage, kind="provider", provider="polly", units=1000, unit="character",
         modelId="neural")  # fmt: skip
    seed(store, "USAGE#2026-11-15#c", usage, kind="provider", provider="elevenlabs", units=30, unit="second",
         modelId="eleven_text_to_sound_v2")  # fmt: skip
    _, body = wcall("GET", f"{BASE}/usage")
    totals = {t["provider"]: t for t in body["usage"]["totalsByProvider"]}
    assert (totals["own-images"]["cost"], totals["own-images"]["currency"]) == (0.16, "USD")  # the model's price
    assert (totals["polly"]["units"], totals["polly"]["unit"], totals["polly"]["cost"]) == (1000, "character", 0.02)
    assert totals["elevenlabs"]["cost"] == 0.3
    wrong = {"elevenlabs": {"perUnit": 1, "unit": "image", "inputPer1M": 0, "outputPer1M": 0, "currency": "USD"}}
    status, body = wcall("PUT", f"{BASE}/ai", {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 1,
                                               "prices": wrong})  # fmt: skip
    assert status == 400
    assert body["error"]["message"].startswith("ElevenLabs is priced per second of sound")
