"""The owner's per-request model and effort, and a video's own setting, checked against Lamo Stories' own model list
(docs/CONTRACTS.md §45.6, §45.25, ADR-77): an unknown model or an effort a model does not offer is refused with the
owner's sentence, never swapped; Clip Factory's ``config/models.json`` is never read."""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api.errors import ApiError
from clipfactory_api.workspaces import config, overrides


def test_a_full_or_partial_override_is_kept_as_given() -> None:
    assert overrides.model_override({"model": "fable-5-2", "effort": "max"}) == {"model": "fable-5-2", "effort": "max"}
    assert overrides.model_override({"effort": "low"}) == {"effort": "low"}
    assert overrides.model_override({"model": "haiku-5-5"}) == {"model": "haiku-5-5"}
    assert overrides.model_override({}) is None
    assert overrides.model_override(None) is None
    assert overrides.model_override({"model": None, "effort": None}) is None


@pytest.mark.parametrize(
    "value",
    [
        {"model": "gpt-9"},
        {"model": ""},
        {"model": 5},
        {"effort": "turbo"},
        {"effort": "High"},
        {"model": "opus-5-5", "temperature": 1},
        "opus-5-5",
    ],
)
def test_bad_overrides_are_400(value: Any) -> None:
    with pytest.raises(ApiError) as e:
        overrides.model_override(value)
    assert e.value.status == 400


def test_an_effort_the_model_does_not_offer_is_refused_never_swapped(monkeypatch: pytest.MonkeyPatch) -> None:
    listed = config.models()
    limited = [{**m, "efforts": ["low", "medium", "high"]} if m["key"] == "haiku-5-5" else m for m in listed] + [
        {"key": "plain", "label": "Plain model", "modelId": "x", "efforts": []}
    ]
    monkeypatch.setattr(config, "models", lambda: limited)
    with pytest.raises(ApiError) as e:
        overrides.model_override({"model": "haiku-5-5", "effort": "max"})
    assert e.value.message == "Claude Haiku 5.5 does not offer Maximum. Pick another level."
    with pytest.raises(ApiError) as e:
        overrides.ai_setting({"model": "plain", "effort": "low"})
    assert e.value.message == "Plain model has no effort setting; it runs at its own level."
    assert overrides.ai_setting({"model": "plain", "effort": None}) == {"model": "plain", "effort": None}
    assert overrides.model_override({"model": "haiku-5-5", "effort": "high"}) == {
        "model": "haiku-5-5",
        "effort": "high",
    }


def test_a_videos_own_setting_has_both_keys() -> None:
    assert overrides.ai_setting({"model": None, "effort": None}) == {"model": None, "effort": None}
    assert overrides.ai_setting({"effort": "xhigh"}) == {"model": None, "effort": "xhigh"}
    with pytest.raises(ApiError):
        overrides.ai_setting({"model": "nope", "effort": None})


def test_every_model_key_and_effort_comes_from_lamo_stories_own_list() -> None:
    keys = {m["key"] for m in config.models()}
    assert {"fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"} <= keys
    assert set(config.EFFORTS) == {"low", "medium", "high", "xhigh", "max"}
    assert config.config_dir().parts[-2:] == ("stories", "config")
    source = Path(overrides.__file__).read_text() + Path(config.__file__).read_text()
    tree = ast.parse(source)
    strings = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    assert not [s for s in strings if s.endswith("config/models.json") and "stories" not in s]
    assert "CLIP_MODELS" not in source
    assert "clipModel" not in source
