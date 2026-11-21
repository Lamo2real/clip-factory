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
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
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
    today = body["usage"]["days"][-1]["byModel"]
    # a provider with a known cost has its own row (no tokens); one without a price adds no "0 tokens" line
    assert today == [{"model": "nova-reel", "input": 0, "output": 0, "cost": 0.48, "currency": "USD"}]
    assert body["usage"]["totals"] == [{"model": "nova-reel", "input": 0, "output": 0, "cost": 0.96, "currency": "USD"}]
    assert body["usage"]["renderMinutes"] == 1.0


def test_a_long_context_call_uses_the_long_context_price(wcall: WsCall, store: db.Store) -> None:
    seed_usage(store, "2026-11-15", "haiku-5-5", input=200_000, output=10_000)
    seed_usage(store, "2026-11-15", "haiku-5-5", input=50_000, output=10_000)
    _, body = wcall("GET", f"{BASE}/usage")
    (row,) = body["usage"]["days"][-1]["byModel"]
    # 200k at $0.5 + 10k at $2.5 (above 100k input) and 50k at $0.1 + 10k at $0.5
    assert row["cost"] == round(0.1 + 0.025 + 0.005 + 0.005, 4)


def test_storage_from_the_items_not_a_listing(wcall: WsCall, store: db.Store, table: FakeTable) -> None:
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
    assert body["storage"] == {
        "bytes": {"videos": 1010, "scenes": 220, "audio": 30, "references": 5000, "skills": 7, "other": 12},
        "files": 10,
    }
