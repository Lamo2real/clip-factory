"""What a job's AI cost (docs/CONTRACTS.md §51): usage capture, the price maths and the stored shape."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from clipfactory_agent import usage
from clipfactory_agent.bedrock import Bedrock
from clipfactory_agent.jobs import Tracker
from clipfactory_agent.skills import SkillsBlock
from clipfactory_agent.store import to_ddb
from clipfactory_agent.usage import Meter, Prices

REPO = Path(__file__).resolve().parents[2]

DATA = {
    "models": {
        "fable-5-1": {"label": "Claude Fable 5.1", "modelId": "anthropic.claude-fable-5-1"},
        "nova-2-lite": {"label": "Amazon Nova 2 Lite", "modelId": "amazon.nova-2-lite-v1:0"},
    },
    "embeddingModel": {"label": "Titan", "modelId": "amazon.titan-embed-text-v2:0"},
    "pricing": {
        "checkedOn": "2026-11-25",
        "models": {
            "fable-5-1": {
                "inputPerMTok": 10.0,
                "outputPerMTok": 50.0,
                "cacheReadPerMTok": 1.0,
                "cacheWritePerMTok": 12.5,
                "confirmed": True,
            },
            "nova-2-lite": {"inputPerMTok": 0.3, "outputPerMTok": 2.5, "confirmed": True},
        },
        "embedding": {"inputPerMTok": 0.02, "outputPerMTok": 0.0, "confirmed": True},
        "transcribe": {"perMinute": 0.024, "confirmed": True},
    },
}
FABLE = "global.anthropic.claude-fable-5-1"


def meter(data: dict[str, Any] | None = None, base: dict[str, Any] | None = None) -> Meter:
    return Meter(Prices(data or DATA), base)


def test_the_price_maths_per_million_tokens() -> None:
    m = meter()
    m.record(FABLE, input=1_000_000, output=100_000, cache_read=2_000_000, cache_write=400_000)
    s = m.summary()
    assert s is not None
    (row,) = s["models"]
    assert row["key"] == "fable-5-1" and row["label"] == "Claude Fable 5.1"
    assert row["tokens"] == 3_500_000 and row["calls"] == 1
    # 10 + 5 + 2 + 5
    assert row["dollars"] == 22.0 and row["estimated"] is False
    assert s["totalDollars"] == 22.0 and s["totalTokens"] == 3_500_000
    assert s["pricesChecked"] == "2026-11-25" and s["estimated"] is False


def test_each_model_and_transcribe_and_embeddings_get_their_own_line() -> None:
    m = meter()
    m.record(FABLE, input=1000, output=1000)
    m.record(FABLE, input=1000, output=0)
    m.record("eu.amazon.nova-2-lite-v1:0", input=2_000_000, output=0)
    m.record(usage.EMBEDDING, input=500_000)
    m.record_transcribe(150)  # 2.5 minutes
    s = m.summary()
    assert s is not None
    by = {r["key"]: r for r in s["models"]}
    assert by["fable-5-1"]["calls"] == 2 and by["fable-5-1"]["inputTokens"] == 2000
    assert by["nova-2-lite"]["dollars"] == 0.6
    assert by["embedding"]["dollars"] == 0.01
    assert s["transcribe"] == {"seconds": 150.0, "minutes": 2.5, "estimated": False, "dollars": 0.06}
    assert s["totalDollars"] == round(by["fable-5-1"]["dollars"] + 0.6 + 0.01 + 0.06, 6)
    assert s["totalCalls"] == 4


def test_a_price_that_is_not_confirmed_is_never_invented() -> None:
    data = json.loads(json.dumps(DATA))
    data["pricing"]["models"]["fable-5-1"]["confirmed"] = False
    data["pricing"]["transcribe"]["confirmed"] = False
    m = meter(data)
    m.record(FABLE, input=1000, output=1000)
    m.record_transcribe(60)
    s = m.summary()
    assert s is not None
    assert "dollars" not in s["models"][0] and s["models"][0]["estimated"] is True
    assert "dollars" not in s["transcribe"] and s["transcribe"]["estimated"] is True
    assert s["totalDollars"] == 0 and s["estimated"] is True
    assert s["models"][0]["tokens"] == 2000  # the tokens are still exact


def test_a_missing_cache_price_makes_the_row_an_estimate_not_a_zero_bill() -> None:
    data = json.loads(json.dumps(DATA))
    data["pricing"]["models"]["nova-2-lite"].pop("inputPerMTok")
    m = meter(data)
    m.record("eu.amazon.nova-2-lite-v1:0", input=1_000_000, output=1_000_000, cache_read=5)
    s = m.summary()
    assert s is not None
    assert s["models"][0]["dollars"] == 2.5 and s["models"][0]["estimated"] is True and s["estimated"] is True


def test_nothing_recorded_shows_nothing_never_zeros() -> None:
    assert meter().summary() is None
    m = meter()
    m.record_transcribe(0)
    assert m.summary() is None and not m.used


def test_a_model_the_config_does_not_know_keeps_its_id_and_has_no_price() -> None:
    m = meter()
    m.record("global.anthropic.claude-mystery-9", input=10, output=5)
    s = m.summary()
    assert s is not None
    (row,) = s["models"]
    assert row["key"] == "global.anthropic.claude-mystery-9" and "dollars" not in row and row["estimated"] is True


def test_a_resumed_job_adds_to_what_the_earlier_runs_wrote() -> None:
    first = meter()
    first.record(FABLE, input=1_000_000)
    first.record_transcribe(60)
    saved = first.summary()
    assert saved is not None
    second = meter(base=json.loads(json.dumps(saved)))
    second.record(FABLE, input=1_000_000, output=1_000_000)
    s = second.summary()
    assert s is not None
    assert s["models"][0]["inputTokens"] == 2_000_000 and s["models"][0]["calls"] == 2
    assert s["transcribe"]["seconds"] == 60.0
    assert s["totalDollars"] == round(20 + 50 + 0.024, 6)


def test_the_stored_shape_survives_dynamodb() -> None:
    m = meter()
    m.record(FABLE, input=123, output=45, cache_read=6)
    m.record_transcribe(90)
    s = m.summary()
    stored = to_ddb(s)
    assert set(stored) >= {
        "v",
        "models",
        "transcribe",
        "totalTokens",
        "totalCalls",
        "totalDollars",
        "estimated",
        "pricesChecked",
    }
    assert set(stored["models"][0]) == {
        "key",
        "label",
        "calls",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "tokens",
        "dollars",
        "estimated",
    }


def test_the_real_price_file_prices_every_model_a_job_can_call() -> None:
    data = json.loads((REPO / "config" / "models.json").read_text("utf-8"))
    prices = Prices(data)
    assert prices.checked_on
    for key in [*data["clipModels"], data["watchModel"]]:
        entry = prices.pricing["models"][key]
        assert entry.get("source"), key
        if entry.get("confirmed"):
            assert entry["inputPerMTok"] >= 0 and entry["outputPerMTok"] >= 0
    assert "source" in prices.pricing["transcribe"] and "source" in prices.pricing["embedding"]
    for bare in (data["models"][k]["modelId"] for k in data["clipModels"]):
        assert prices.resolve("global." + bare)[0] in data["models"]


# --- capture ---------------------------------------------------------------------------------------------------


class Fake:
    def __init__(self) -> None:
        self.calls = 0

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.calls += 1
        return {
            "stopReason": "tool_use",
            "usage": {"inputTokens": 100, "outputTokens": 20, "cacheReadInputTokens": 7, "cacheWriteInputTokens": 3},
            "output": {"message": {"content": [{"toolUse": {"toolUseId": "t", "name": "x", "input": {"ok": True}}}]}},
        }


NO_SKILLS = SkillsBlock("", [])


def test_every_bedrock_answer_is_recorded_for_the_running_job_and_adds_no_call() -> None:
    fake = Fake()
    b = Bedrock(FABLE, "eu-north-1", client=fake)
    m = meter()
    token = usage.bind(m)
    try:
        asyncio.run(
            b.structured(
                system="s",
                skills=NO_SKILLS,
                content=[{"text": "hi"}],
                tool="x",
                description="d",
                schema={"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}},
            )
        )
    finally:
        usage.bind(None)
        del token
    assert fake.calls == 1  # recording is not a model call
    s = m.summary()
    assert s is not None
    row = s["models"][0]
    assert (row["calls"], row["inputTokens"], row["outputTokens"], row["cacheReadTokens"], row["cacheWriteTokens"]) == (
        1,
        100,
        20,
        7,
        3,
    )


def test_with_no_job_running_nothing_is_recorded_and_nothing_breaks() -> None:
    usage.bind(None)
    usage.record(FABLE, input=5)
    usage.record_transcribe(10)
    assert usage.current() is None


def test_the_agent_sdk_result_is_recorded_per_model_else_as_the_runs_totals() -> None:
    m = meter()
    usage.bind(m)
    try:
        usage.record_sdk_result(
            SimpleNamespace(
                model_usage={
                    FABLE: {
                        "inputTokens": 10,
                        "outputTokens": 5,
                        "cacheReadInputTokens": 100,
                        "cacheCreationInputTokens": 20,
                    }
                },
                usage=None,
                num_turns=4,
            ),
            FABLE,
        )
        usage.record_sdk_result(
            SimpleNamespace(
                model_usage=None,
                usage={
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "cache_read_input_tokens": 3,
                    "cache_creation_input_tokens": 4,
                },
                num_turns=3,
            ),
            FABLE,
        )
    finally:
        usage.bind(None)
    s = m.summary()
    assert s is not None
    (row,) = s["models"]
    assert (row["calls"], row["inputTokens"], row["outputTokens"], row["cacheReadTokens"], row["cacheWriteTokens"]) == (
        4,
        11,
        7,
        103,
        24,
    )


class Store:
    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []

    async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
        self.writes.append(fields)
        return True


def test_the_job_item_carries_the_cost_so_far_also_when_the_job_fails() -> None:
    async def go() -> list[dict[str, Any]]:
        store = Store()
        tr = Tracker(store, "u", "j", session_id=None, live=None)  # type: ignore[arg-type]
        m = meter()
        tr.cost = m.summary
        await tr.begin()
        assert "aiCost" not in store.writes[-1]  # nothing spent yet: no zeros
        m.record(FABLE, input=1000, output=1000)
        await tr.finish_failed("Boom")
        await tr.stop()
        return store.writes

    writes = asyncio.run(go())
    assert writes[-1]["status"] == "failed"
    assert writes[-1]["aiCost"]["totalTokens"] == 2000


def test_a_price_that_depends_on_the_request_shows_as_about() -> None:
    data = json.loads(json.dumps(DATA))
    data["pricing"]["models"]["fable-5-1"]["approximate"] = True
    m = meter(data)
    m.record(FABLE, input=1_000_000)
    s = m.summary()
    assert s is not None
    assert s["models"][0]["dollars"] == 10.0 and s["models"][0]["estimated"] is True and s["estimated"] is True
