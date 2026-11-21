"""The scaffold's contract: the server answers, models resolve without substitution, and nothing imports Clip
Factory's agent (docs/CONTRACTS.md §45.11.1, §45.25, ADR-76)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lamostories_agent import config, models
from lamostories_agent.server import Actions, create_app

SRC = Path(__file__).resolve().parents[1] / "src" / "lamostories_agent"


def test_ping_and_health_and_unknown_action() -> None:
    client = TestClient(create_app(Actions()))
    assert client.get("/ping").json() == {"status": "Healthy"}
    assert client.post("/invocations", json={"action": "health"}).json() == {"ok": True}
    assert client.post("/invocations", json={"action": "nope"}).status_code == 400


def test_nothing_imports_clip_factory() -> None:
    for f in SRC.rglob("*.py"):
        assert not re.search(r"^\s*(from|import)\s+clipfactory_(agent|api)\b", f.read_text(), re.M), f


def test_models_file_lists_the_owners_models_with_their_efforts() -> None:
    keys = {m["key"] for m in config.models()["models"]}
    assert {"fable-5-2", "fable-5-1", "opus-5-5"} <= keys
    for m in config.models()["models"]:
        assert set(m["efforts"]) <= set(config.EFFORTS)
        assert m["defaultEffort"] in (*m["efforts"], None)


def test_precedence_request_then_task_then_agent_then_default() -> None:
    ai = {"defaultModel": "opus-5-5", "defaultEffort": "high", "tasks": {"storyboard": {"model": "fable-5-2"}}}
    agent = {"model": "sonnet-5-5", "effort": "low"}
    assert models.resolve(task="storyboard", agent=agent, ai=ai).model == "fable-5-2"
    assert models.resolve(task="chat", agent=agent, ai=ai) == models.Choice("sonnet-5-5", "low", "agent")
    got = models.resolve(task="chat", agent=agent, ai=ai, override={"model": "fable-5-1", "effort": "max"})
    assert got == models.Choice("fable-5-1", "max", "request")
    assert models.resolve(task="chat", agent={}, ai={}).model == "opus-5-5"


def test_an_unknown_model_is_never_substituted() -> None:
    with pytest.raises(models.ModelUnavailable, match="not in Lamo Stories' list"):
        models.resolve(task="chat", agent={"model": "gpt-9"}, ai={})
