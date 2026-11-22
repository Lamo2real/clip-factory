"""The API's model and effort resolver (docs/CONTRACTS.md §45.25, ADR-77): every shared case of
``stories/config/resolve-cases.json`` (the agent's resolver runs the same ones), plus the rules the cases do not
spell out: an effort the model does not offer is refused with the owner's sentence, a model with no effort setting
sends none, and model and effort merge separately across the five levels."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import config

CASES = config.load("resolve-cases.json")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_every_shared_case(case: dict[str, Any]) -> None:
    kwargs = {k: case.get(k) for k in ("agent", "ai", "request", "conversation", "project")}
    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(res.ResolveError) as e:
            res.resolve(task=case["task"], **kwargs)
        assert e.value.kind == expect["error"]
        assert e.value.message.endswith(".")
        return
    got = res.resolve(task=case["task"], **kwargs)
    assert {k: got[k] for k in ("model", "effort", "from")} == expect
    assert got["effortApplied"] is True


def _limited(monkeypatch: pytest.MonkeyPatch, efforts: list[str]) -> None:
    models = res.models()
    for m in models:
        if m["key"] == "haiku-5-5":
            m["efforts"] = efforts
    monkeypatch.setattr(res, "models", lambda: [dict(m) for m in models])


def test_an_effort_the_model_does_not_offer_is_refused_never_swapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _limited(monkeypatch, ["low", "medium", "high"])
    with pytest.raises(res.ResolveError) as e:
        res.resolve(task="chat", ai={"defaultModel": "haiku-5-5", "defaultEffort": "max"})
    assert e.value.kind == "effort"
    assert e.value.message == "Claude Haiku 5.5 does not offer Maximum. Pick another level."
    # a lower level's effort is checked against the model a higher level picked
    with pytest.raises(res.ResolveError):
        res.resolve(task="chat", request={"model": "haiku-5-5"}, agent={"effort": "xhigh"})


def test_a_model_without_an_effort_setting_sends_none(monkeypatch: pytest.MonkeyPatch) -> None:
    _limited(monkeypatch, [])
    got = res.resolve(task="captions", request={"model": "haiku-5-5", "effort": "max"})
    assert got == {"model": "haiku-5-5", "effort": None, "effortApplied": False, "from": "request"}


def test_the_file_defaults_apply_without_a_saved_configuration() -> None:
    got = res.resolve(task="chat")
    assert got == {"model": "opus-5-5", "effort": "high", "effortApplied": True, "from": "default"}


def test_levels_merge_model_and_effort_separately() -> None:
    ai = {"defaultModel": "opus-5-5", "defaultEffort": "high", "tasks": {"chat": {"effort": "low"}}}
    got = res.resolve(
        task="chat", ai=ai, agent={"model": "sonnet-5-5", "effort": "max"}, conversation={"effort": "medium"}
    )
    assert (got["model"], got["effort"], got["from"]) == ("sonnet-5-5", "medium", "agent")
    got = res.resolve(task="chat", ai=ai, agent={"model": "sonnet-5-5", "effort": "max"})
    assert (got["model"], got["effort"], got["from"]) == ("sonnet-5-5", "low", "agent")
    got = res.resolve(task="storyboard", ai=ai, project={"model": "fable-5-1"}, request={"effort": "xhigh"})
    assert (got["model"], got["effort"], got["from"]) == ("fable-5-1", "xhigh", "project")


def test_null_and_empty_levels_mean_the_level_below() -> None:
    got = res.resolve(task="chat", conversation={"model": None, "effort": ""}, agent={"model": "fable-5-2"})
    assert got["model"] == "fable-5-2"
    assert got["from"] == "agent"


def test_shown_never_raises_and_says_why(monkeypatch: pytest.MonkeyPatch) -> None:
    effective, problem = res.shown(task="chat", conversation={"model": "gone-1"})
    assert effective["model"] == "gone-1"
    assert effective["effortApplied"] is False
    assert problem is not None
    assert "gone-1" in problem
    ok, none = res.shown(task="chat")
    assert none is None
    assert ok == res.resolve(task="chat")


def test_every_task_has_one_agent_a_label_and_a_suggestion() -> None:
    for kind in res.TASK_KINDS:
        assert res.agent_for_task(kind) in res.AGENT_IDS
        assert res.TASK_LABEL[kind]
        assert res.SUGGESTED_EFFORT[kind] in res.EFFORTS
    assert res.agent_for_task("check_models") is None
    assert {a["agentId"] for a in res.agent_defaults()} == set(res.AGENT_IDS)


def test_the_suggestions_the_owner_asked_for() -> None:
    # "Creative brainstorming: Medium ... reference-video analysis: High, Storyboard: High, Simple text: Low, Final
    # quality review: High" (the second request, §4) and §45.25's list.
    assert res.SUGGESTED_EFFORT["brainstorm"] == "medium"
    assert res.SUGGESTED_EFFORT["reference_analysis"] == "high"
    assert res.SUGGESTED_EFFORT["storyboard"] == "high"
    assert res.SUGGESTED_EFFORT["scene_rewrite"] == "high"
    assert res.SUGGESTED_EFFORT["captions"] == "low"
    assert res.SUGGESTED_EFFORT["fact_check"] == "high"
    assert res.SUGGESTED_EFFORT["final_review"] == "high"


def test_story_effective_uses_the_story_as_the_project_level() -> None:
    agents = {"storyboard": {"model": "sonnet-5-5"}}
    eff, problem = res.story_effective({"ai": {"model": "fable-5-2", "effort": None}}, ai={}, agents=agents)
    assert problem is None
    assert (eff["model"], eff["from"]) == ("fable-5-2", "project")
    eff, _ = res.story_effective({"ai": {"model": None}}, ai={}, agents=agents, task="storyboard")
    assert (eff["model"], eff["from"]) == ("sonnet-5-5", "agent")
    eff, _ = res.story_effective({}, ai={}, agents=agents, override={"model": "haiku-5-5"})
    assert eff["from"] == "request"


def test_only_lamo_stories_model_list_is_read() -> None:
    keys = {m["key"] for m in res.models()}
    assert keys == {"fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"}
    assert str(config.config_dir()).endswith(("stories/config", "stories_config"))
