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
from clipfactory_agent.skills import skills_block
from clipfactory_agent.util import UserFacingError

from .conftest import raw_moment

NO_SKILLS = skills_block([])


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
        week_learnings=["Rage clips win"],
    )


def test_prompts_carry_rules_skills_and_learnings() -> None:
    b = brief()
    s = system_prompt(b)
    assert "<owner_skills" not in s  # the skills block goes first in every call, never inside the task prompt
    assert "Rage clips win" in s and "20–45 seconds" in s
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
        skills=NO_SKILLS,
        on_progress=progress.append,
    )
    assert [m.start for m in chosen] == [100, 400, 700]
    assert spares == []
    assert progress[-1] == 1.0


async def test_find_moments_keeps_sdk_moments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def sdk(b: Brief, tools: MomentTools, **kw: Any) -> list[Any]:
        for s in range(0, int(b.duration), 1800):  # it read the whole video
            tools.read_transcript({"start": s, "end": min(b.duration, s + 1800)})
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
        skills=NO_SKILLS,
        on_progress=lambda f: None,
    )
    assert len(chosen) == 3 and fake.calls == 0


async def test_find_moments_reads_what_a_successful_sdk_run_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """F013: an SDK run that ends with success after reading only the first window still gets the rest read."""

    async def sdk(b: Brief, tools: MomentTools, **kw: Any) -> list[Any]:
        tools.read_transcript({"start": 0, "end": 1800})
        tools.submit_moments(
            {"moments": [raw_moment(start=s, end=s + 30, payoff_at=s + 25, peak_at=s + 20) for s in (100, 500, 900)]}
        )
        return tools.moments

    monkeypatch.setattr(agent_mod, "find_with_sdk", sdk)
    later = [raw_moment(start=3000, end=3030, payoff_at=3025, peak_at=3020, score=9)]
    seen: list[str] = []

    class Spy:
        calls = 0

        async def structured(self, **kw: Any) -> dict[str, Any]:
            Spy.calls += 1
            seen.append(kw["content"][0]["text"])
            return {"candidates": later}

    b = brief(duration=4000, clip_min=2, clip_max=4)
    chosen, _ = await find_moments(
        b,
        bedrock=Spy(),  # type: ignore[arg-type]
        model_id="m",
        region="r",
        workdir=tmp_path,
        skill_names=[],
        skills=NO_SKILLS,
        on_progress=lambda f: None,
    )
    assert Spy.calls == 2  # the two windows the run never read, not the one it did
    assert all("0:00:00–" not in t for t in seen)
    assert 3000 in [m.start for m in chosen]


async def test_converse_window_failure_of_any_kind_is_skipped() -> None:
    """F014: max_tokens (TransientError) or throttling (ClientError) in one window loses only that window."""
    from botocore.exceptions import ClientError

    from clipfactory_agent.agent import find_with_converse
    from clipfactory_agent.util import TransientError

    good = [raw_moment(start=s, end=s + 30, payoff_at=s + 28, peak_at=s + 20) for s in (100, 400)]

    class Flaky:
        calls = 0

        async def structured(self, **kw: Any) -> dict[str, Any]:
            Flaky.calls += 1
            if Flaky.calls == 1:
                raise TransientError("The model ran out of room for its answer.")
            if Flaky.calls == 2:
                raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "Converse")
            return {"candidates": good}

    found = await find_with_converse(brief(duration=6000), Flaky(), skills=NO_SKILLS)  # type: ignore[arg-type]
    assert Flaky.calls == 4 and len(found) == 4  # 4 windows: 2 failed and were skipped, 2 answered


async def test_converse_cancel_stops_the_other_windows() -> None:
    """F014: a failure that does escape a window (a cancel) cancels its siblings instead of leaving them running."""
    import asyncio

    from clipfactory_agent.agent import find_with_converse
    from clipfactory_agent.util import JobCanceled

    finished: list[int] = []

    class Slow:
        calls = 0

        async def structured(self, **kw: Any) -> dict[str, Any]:
            Slow.calls += 1
            n = Slow.calls
            if n == 1:
                raise JobCanceled()
            await asyncio.sleep(0.2)
            finished.append(n)
            return {"candidates": []}

    with pytest.raises(JobCanceled):
        await find_with_converse(brief(duration=6000), Slow(), skills=NO_SKILLS)  # type: ignore[arg-type]
    await asyncio.sleep(0.3)
    assert finished == []


async def test_model_down_in_every_window_is_a_busy_service_not_a_dull_video(tmp_path: Path) -> None:
    """F014 follow-up: when every Converse window fails, the error is raised (the step retries and then says a service
    was busy) instead of reporting "No clip-worthy moments" for a video nobody read."""
    from clipfactory_agent.util import TransientError

    class Down:
        async def structured(self, **kw: Any) -> dict[str, Any]:
            raise TransientError("The model ran out of room for its answer.")

    with pytest.raises(TransientError):
        await find_moments(
            brief(duration=6000),
            bedrock=Down(),  # type: ignore[arg-type]
            model_id="m",
            region="r",
            workdir=tmp_path,
            skill_names=[],
            skills=NO_SKILLS,
            on_progress=lambda f: None,
            use_sdk=False,
        )


async def test_model_down_after_a_partial_sdk_run_keeps_its_moments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """F013/F014: the SDK run's moments still make clips when Converse for the windows it skipped is down."""
    from clipfactory_agent.util import TransientError

    async def sdk(b: Brief, tools: MomentTools, **kw: Any) -> list[Any]:
        tools.read_transcript({"start": 0, "end": 1800})
        tools.submit_moments(
            {"moments": [raw_moment(start=s, end=s + 30, payoff_at=s + 25, peak_at=s + 20) for s in (100, 500, 900)]}
        )
        return tools.moments

    monkeypatch.setattr(agent_mod, "find_with_sdk", sdk)

    class Down:
        async def structured(self, **kw: Any) -> dict[str, Any]:
            raise TransientError("busy")

    chosen, _ = await find_moments(
        brief(duration=4000, clip_min=2, clip_max=3),
        bedrock=Down(),  # type: ignore[arg-type]
        model_id="m",
        region="r",
        workdir=tmp_path,
        skill_names=[],
        skills=NO_SKILLS,
        on_progress=lambda f: None,
    )
    assert len(chosen) >= 2


async def test_find_moments_none_found(tmp_path: Path) -> None:
    with pytest.raises(UserFacingError, match="No clip-worthy moments"):
        await find_moments(
            brief(),
            bedrock=FakeBedrock([]),  # type: ignore[arg-type]
            model_id="m",
            region="r",
            workdir=tmp_path,
            skill_names=[],
            skills=NO_SKILLS,
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
    layout = await b.detect_layout(b"jpeg", 1280, 720, skills=NO_SKILLS)
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
        await b.detect_layout(b"jpeg", 1280, 720, skills=NO_SKILLS)


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
        skills=NO_SKILLS,
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


# --- the deep analysis (ADR-40): nothing changes without signals, and the picture is read when it is there --------

import hashlib  # noqa: E402

from clipfactory_agent import signals as signals_mod  # noqa: E402
from clipfactory_agent import transcript  # noqa: E402
from clipfactory_agent.agent import OPEN_RULE, PICTURE_RULES, hints, worth_reading  # noqa: E402
from clipfactory_agent.signals import Event, HotSpot, Signals  # noqa: E402

from .deep_support import ToolClient  # noqa: E402

# sha256 (first 16 hex) of what the code on origin/main at 0abfbe2 (before ADR-40) produced for ``brief()``.
# "system" is what the learning-from-results code (ADR-41) produced before ADR-40 for the same brief: it sends the
# best-of-week learnings under their own heading and no 48-hour ones, so its bytes differ from 0abfbe2 on purpose.
BEFORE = {
    "system": "51ab340136c0f21c",
    "hints": "efd5468f6b44f116",
    "read": "a72fac1edde97034",
    "lines": "d9ed6b299a654c35",
    "brief": "4744cbf25e319701",
}


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def test_without_signals_every_prompt_is_byte_identical_to_before() -> None:
    b = brief()
    assert b.signals is None and b.speakers is None
    assert digest(system_prompt(b)) == BEFORE["system"]
    assert digest(hints(b, 0, 1800)) == BEFORE["hints"]
    assert digest(MomentTools(b).read_transcript({"start": 0, "end": 1800})[0]) == BEFORE["read"]
    assert digest(transcript.lines(b.words, 0, 1800)) == BEFORE["lines"]
    assert digest(json.dumps(brief_json(b), sort_keys=True)) == BEFORE["brief"]
    assert OPEN_RULE in system_prompt(b) and "Picture notes" not in system_prompt(b)
    assert "picture" not in brief_json(b)


def test_speakers_without_picture_signals_are_explained_to_the_finder() -> None:
    from clipfactory_agent import verify, watch
    from clipfactory_agent.agent import SPEAKER_NOTE

    b = brief()
    b.speakers = [[0.0, 900.0, "S1"], [900.0, 1800.0, "S2"]]
    s = system_prompt(b)
    assert SPEAKER_NOTE in s and "restart" in s and "Picture notes" not in s and OPEN_RULE in s
    read = MomentTools(b).read_transcript({"start": 0, "end": 1800})[0]
    assert "S1: " in read
    assert '"S1:"' in watch.WATCH_SYSTEM and '"S1:"' in verify.VERIFY_SYSTEM
    b.speakers = None
    assert SPEAKER_NOTE not in system_prompt(b)


def test_the_gate_without_signals_is_the_old_400_characters() -> None:
    b = brief()
    assert worth_reading(b, 0, 1800, "x" * 400) is True
    assert worth_reading(b, 0, 1800, "x" * 399) is False
    assert worth_reading(b, 0, 1800, "") is False


def with_picture(b: Brief, events: list[Event] | None = None, hotspots: list[HotSpot] | None = None) -> Brief:
    motion = [0.01] * int(b.duration)
    motion[700] = 0.2
    b.signals = Signals(
        duration=b.duration,
        events=events or [],
        hotspots=hotspots or [],
        motion=motion,
        coverage={"picture": 0.8},
    )
    return b


def test_with_signals_the_prompts_gain_the_picture() -> None:
    crash = Event(700, 706, "crash", "car flips off the bridge", 9, True, "shocked", "", ["fable", "nova"])
    spot = HotSpot(700, 6.0, True, ["fable", "motion"], ["seen", "fast picture"])
    b = with_picture(brief(), [crash], [spot])
    s = system_prompt(b)
    assert PICTURE_RULES in s and "machine-made evidence like the loudness spikes, not proof" in s
    assert "A moment may have no talking at all" in s and "first_words describes the sound heard" in s
    assert OPEN_RULE not in s and "Never open on a still, quiet picture" in s
    assert s.index("Picture notes") < s.index("Rage clips win")  # stable rules first, then the learnings
    assert brief_json(b)["picture"] == {"watched": True, "coveragePercent": 80}
    h = hints(b, 0, 1800).splitlines()
    assert h[0].startswith("Loudness spikes:") and h[1].startswith("Most replayed:")  # the two old lines stay
    assert h[2] == "Fast picture: 0:11:40 (x20)"
    assert h[3] == "Hot spots: 0:11:40 (seen + fast picture, nobody talking)"
    text, err = MomentTools(b).read_transcript({"start": 0, "end": 1800})
    assert not err
    assert "[0:11:40] (seen) crash 9/10, nobody talking: car flips off the bridge | face: shocked" in text
    assert text.index("[0:11:30] word690") < text.index("(seen) crash") < text.index("[0:11:40] word700")


def test_speakers_prefix_the_lines() -> None:
    b = brief(duration=600)
    b.speakers = [[0, 9, "S1"], [9, 30, "S2"]]
    text = signals_mod.timeline(b, 0, 20)
    assert text.splitlines()[0].startswith("[0:00:00] S1: word0") and "[0:00:10] S2: word10" in text


async def test_a_silent_window_with_a_strong_picture_event_is_read() -> None:
    def quiet_brief() -> Brief:
        b = brief(duration=1800)
        b.words = []  # nobody talks at all
        return b

    client = ToolClient()
    found = await agent_mod.find_with_converse(quiet_brief(), Bedrock("m", "r", client=client), skills=NO_SKILLS)
    assert found == [] and client.requests == []  # today: a window without words is never read

    crash = Event(700, 706, "crash", "car flips off the bridge", 9, True, "none", "", ["fable"])
    b = with_picture(quiet_brief(), [crash])
    answer = raw_moment(start=695, end=720, payoff_at=706, peak_at=703, first_words="tyres screeching, then a splash")
    client = ToolClient({"submit_moments": lambda kw: {"candidates": [answer]}})
    found = await agent_mod.find_with_converse(b, Bedrock("m", "r", client=client), skills=NO_SKILLS)
    assert [m.start for m in found] == [695] and found[0].first_words == "tyres screeching, then a splash"
    prompt = client.requests[-1]["messages"][0]["content"][0]["text"]
    assert "(seen) crash 9/10, nobody talking: car flips off the bridge" in prompt and "Fast picture:" in prompt

    weak = with_picture(quiet_brief(), [Event(700, 706, "other", "driving", 3, True, "none", "", ["fable"])])
    weak.signals.motion = []  # type: ignore[union-attr]
    client = ToolClient()
    await agent_mod.find_with_converse(weak, Bedrock("m", "r", client=client), skills=NO_SKILLS)
    assert client.requests == []  # a weak event alone does not make a silent window worth a call

    spot = with_picture(quiet_brief(), hotspots=[HotSpot(900, 2.0, True, ["motion"], ["fast picture"])])
    assert worth_reading(spot, 0, 1800, "") is True  # a hot spot with nobody talking is read too
