from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import agent as agent_mod
from clipfactory_agent.agent import Brief, MomentTools, brief_json, find_moments, system_prompt, task_prompt
from clipfactory_agent.bedrock import Bedrock, Facecam, ModelError, facecam_from_box
from clipfactory_agent.moments import CANDIDATES_SCHEMA
from clipfactory_agent.schema import check
from clipfactory_agent.util import UserFacingError

from .conftest import raw_moment


def brief(duration: float = 4000, clip_min: int = 2, clip_max: int = 3) -> Brief:
    words = [[t, t + 0.3, f"word{t}"] for t in range(0, int(duration), 2)]
    loud = [-40.0] * int(duration)
    loud[500] = -10.0
    return Brief(
        title="Big stream",
        channel="Streamer",
        platform="youtube",
        duration=duration,
        notes="#GTA6 please",
        clip_min=clip_min,
        clip_max=clip_max,
        length=(20, 45),
        words=words,
        loud=loud,
        heatmap=[{"start": 600, "end": 620, "value": 1.0}],
        skills_text="<skill>rules</skill>",
        learnings=["Rage clips win"],
    )


def test_prompts_carry_rules_skills_and_learnings() -> None:
    b = brief()
    s = system_prompt(b)
    assert "<skill>rules</skill>" in s and "Rage clips win" in s and "20–45 seconds" in s
    assert "3 windows" in task_prompt(b)
    j = brief_json(b)
    assert j["clips"] == {"min": 2, "max": 3, "candidatesWanted": 5}
    assert len(j["transcriptWindows"]) == 3


def test_moment_tools_read_and_coverage() -> None:
    covered: list[float] = []
    t = MomentTools(brief(), on_coverage=covered.append)
    text, err = t.read_transcript({"start": 0, "end": 1800})
    assert (
        not err
        and "Transcript 0:00:00–0:30:00" in text
        and "0:08:20 (+30 dB)" in text
        and "Most replayed: 0:10:00" in text
    )
    assert covered[-1] == pytest.approx(0.45)
    t.read_transcript({"start": 1700, "end": 3600})
    assert t.coverage() == pytest.approx(0.9)
    assert t.read_transcript({"start": 0, "end": 3000})[1] is True  # too long a window
    assert t.read_transcript({"start": 10, "end": 5})[1] is True
    assert json.loads(t.get_brief({})[0])["video"]["title"] == "Big stream"
    assert "Loudness spikes" in t.list_spikes({})[0]


def test_submit_moments_validates_and_replaces_overlaps() -> None:
    t = MomentTools(brief())
    text, err = t.submit_moments(
        {"moments": [raw_moment(), raw_moment(hook="bad"), raw_moment(start=300, end=330, payoff_at=320, peak_at=320)]}
    )
    assert not err and "Accepted 2 of 3" in text and "#1" in text
    t.submit_moments({"moments": [raw_moment(start=105, end=135, payoff_at=130, peak_at=130, score=9)]})
    assert sorted(m.start for m in t.moments) == [105, 300]
    assert t.submit_moments({"moments": "x"})[1] is True
    assert t.submit_moments({"moments": [raw_moment(needs_context=True)]})[1] is True


class FakeBedrock:
    def __init__(self, per_window: list[dict[str, Any]]) -> None:
        self.per_window = per_window
        self.calls = 0

    async def structured(self, **kw: Any) -> dict[str, Any]:
        self.calls += 1
        if self.calls == 2:
            raise ModelError("bad answer")  # one failed window must not sink the job
        assert check(kw["schema"], {"candidates": self.per_window}) == []
        return {"candidates": self.per_window}


async def test_find_moments_falls_back_to_converse(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def sdk_fails(*a: Any, **kw: Any) -> list[Any]:
        raise RuntimeError("CLI exited")

    monkeypatch.setattr(agent_mod, "find_with_sdk", sdk_fails)
    cands = [
        raw_moment(start=s, end=s + 30, payoff_at=s + 28, peak_at=s + 20, score=8 - s / 1000) for s in (100, 400, 700)
    ]
    assert check(CANDIDATES_SCHEMA, {"candidates": cands}) == []
    fake = FakeBedrock(cands)
    progress: list[float] = []
    chosen, spares = await find_moments(
        brief(),
        bedrock=fake,  # type: ignore[arg-type]
        model_id="m",
        region="eu-north-1",
        workdir=tmp_path,
        skill_names=[],
        on_progress=progress.append,
    )
    assert [m.start for m in chosen] == [100, 400, 700]
    assert spares == []
    assert progress[-1] == 1.0


async def test_find_moments_keeps_sdk_moments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def sdk(b: Brief, tools: MomentTools, **kw: Any) -> list[Any]:
        tools.submit_moments(
            {"moments": [raw_moment(start=s, end=s + 30, payoff_at=s + 25, peak_at=s + 20) for s in (100, 500, 900)]}
        )
        return tools.moments

    monkeypatch.setattr(agent_mod, "find_with_sdk", sdk)
    fake = FakeBedrock([])
    chosen, _ = await find_moments(
        brief(),
        bedrock=fake,  # type: ignore[arg-type]
        model_id="m",
        region="r",
        workdir=tmp_path,
        skill_names=["playbook"],
        on_progress=lambda f: None,
    )
    assert len(chosen) == 3 and fake.calls == 0


async def test_find_moments_none_found(tmp_path: Path) -> None:
    with pytest.raises(UserFacingError, match="No clip-worthy moments"):
        await find_moments(
            brief(),
            bedrock=FakeBedrock([]),  # type: ignore[arg-type]
            model_id="m",
            region="r",
            workdir=tmp_path,
            skill_names=[],
            on_progress=lambda f: None,
            use_sdk=False,
        )


class FakeConverse:
    """A boto3 bedrock-runtime stand-in that refuses forced tool choice, like Claude Fable 5.1."""

    def __init__(self, answers: list[dict[str, Any]]) -> None:
        self.answers = answers
        self.requests: list[dict[str, Any]] = []

    def converse(self, **kw: Any) -> dict[str, Any]:
        from botocore.exceptions import ClientError

        self.requests.append(kw)
        if "tool" in kw["toolConfig"]["toolChoice"]:
            raise ClientError(
                {"Error": {"Code": "ValidationException", "Message": "tool_choice is not supported"}}, "Converse"
            )
        return self.answers.pop(0)


def tool_answer(value: Any) -> dict[str, Any]:
    return {
        "stopReason": "tool_use",
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "report_layout", "input": value}}],
            }
        },
    }


async def test_structured_switches_to_auto_and_corrects_bad_answers() -> None:
    good = {"has_facecam": True, "x": 960, "y": 0, "w": 300, "h": 200, "scene": "gameplay"}
    fake = FakeConverse([tool_answer({"has_facecam": True}), tool_answer(good)])
    b = Bedrock("global.anthropic.claude-fable-5-1", "eu-north-1", client=fake)
    layout = await b.detect_layout(b"jpeg", 1280, 720)
    assert layout.facecam == Facecam(0.75, 0.0, 300 / 1280, 200 / 720)
    assert b.forced_tool_choice is False
    assert len(fake.requests) == 3
    retry_msg = fake.requests[2]["messages"][-1]["content"][0]["toolResult"]
    assert retry_msg["status"] == "error" and "missing" in retry_msg["content"][0]["text"]
    assert fake.requests[0]["modelId"] == "global.anthropic.claude-fable-5-1"


async def test_structured_gives_up_after_three_bad_answers() -> None:
    fake = FakeConverse([{"stopReason": "end_turn", "output": {"message": {"content": [{"text": "hi"}]}}}] * 3)
    b = Bedrock("m", "r", client=fake)
    b.forced_tool_choice = False
    with pytest.raises(ModelError):
        await b.detect_layout(b"jpeg", 1280, 720)


def test_facecam_from_box_rejects_implausible_boxes() -> None:
    assert facecam_from_box({"has_facecam": False}, 1280, 720).facecam is None
    assert (
        facecam_from_box(
            {"has_facecam": True, "x": 0, "y": 0, "w": 20, "h": 20, "scene": "gameplay"}, 1280, 720
        ).facecam
        is None
    )
    assert (
        facecam_from_box(
            {"has_facecam": True, "x": 0, "y": 0, "w": 1200, "h": 700, "scene": "gameplay"}, 1280, 720
        ).facecam
        is None
    )
    assert (
        facecam_from_box(
            {"has_facecam": True, "x": 1200, "y": 0, "w": 200, "h": 200, "scene": "other"}, 1280, 720
        ).facecam
        is None
    )


async def test_sdk_options_and_tool_wrappers(tmp_path: Path) -> None:
    from clipfactory_agent.agent import sdk_options

    t = MomentTools(brief())
    opts = sdk_options(
        brief(),
        t,
        model_id="global.anthropic.claude-fable-5-1",
        region="eu-north-1",
        workdir=tmp_path,
        skill_names=["short-form-video-playbook"],
    )
    assert opts.model == "global.anthropic.claude-fable-5-1"
    assert opts.env["ANTHROPIC_MODEL"] == "global.anthropic.claude-fable-5-1"
    assert opts.env["CLAUDE_CODE_USE_BEDROCK"] == "1" and opts.env["HOME"] == str(tmp_path / "home")
    assert opts.allowed_tools == [
        f"mcp__clips__{n}" for n in ("get_brief", "read_transcript", "list_spikes", "submit_moments")
    ]
    assert opts.setting_sources == ["project"] and opts.cwd == str(tmp_path)
    assert opts.skills == ["short-form-video-playbook"]
    deny = await opts.can_use_tool("Bash", {"command": "ls"}, None)
    assert deny.behavior == "deny"
    allow = await opts.can_use_tool("mcp__clips__submit_moments", {}, None)
    assert allow.behavior == "allow"
