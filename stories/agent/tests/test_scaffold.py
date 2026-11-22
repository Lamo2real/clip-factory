"""The scaffold's contract: the server answers, models resolve without substitution, and nothing imports Clip
Factory's agent (docs/CONTRACTS.md §45.11.1, §45.25, ADR-76)."""

from __future__ import annotations

import json
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


def test_the_shared_resolver_cases() -> None:
    cases = json.loads((config.config_dir() / "resolve-cases.json").read_text())["cases"]
    assert len(cases) >= 9
    for case in cases:
        kwargs = {k: case.get(k) for k in ("agent", "ai", "conversation", "project")}
        expect = case["expect"]
        if "error" in expect:
            exc = models.ModelUnavailable if expect["error"] == "model" else models.EffortUnavailable
            with pytest.raises(exc):
                models.resolve(task=case["task"], override=case.get("request"), **kwargs)
            continue
        got = models.resolve(task=case["task"], override=case.get("request"), **kwargs)
        assert (got.model, got.effort, got.source) == (expect["model"], expect["effort"], expect["from"]), case["name"]


def test_build_app_registers_every_package() -> None:
    from lamostories_agent.server import build_app

    assert build_app() is not None
