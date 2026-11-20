"""Regression tests: one bad clip, Kick audio, long system prompts, long videos, missed cancels, orphaned parts."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import agent as agent_mod
from clipfactory_agent import proc, sources
from clipfactory_agent.agent import MomentTools, sdk_options, sdk_timeout, system_prompt
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.jobs import STEPS, Tracker, run_job
from clipfactory_agent.pipeline import JobState, Pipeline
from clipfactory_agent.skills import SkillDoc, skills_block
from clipfactory_agent.util import JobCanceled, TransientError, UserFacingError, gather_all

from .conftest import make_moment, raw_moment
from .test_agent import FakeBedrock, brief
from .test_jobs import FakeStore, ok_steps

# --- gather_all ------------------------------------------------------------------------------------------------


async def test_gather_all_cancels_the_others_on_first_failure() -> None:
    cleaned: list[int] = []

    async def slow(i: int) -> int:
        try:
            await asyncio.sleep(60)
        finally:
            cleaned.append(i)
        return i

    async def boom() -> int:
        await asyncio.sleep(0)
        raise ValueError("part failed")

    with pytest.raises(ValueError, match="part failed"):
        await gather_all(slow(1), boom(), slow(2))
    assert sorted(cleaned) == [1, 2]  # both siblings were cancelled and ran their cleanup
    assert await gather_all(asyncio.sleep(0, "a"), asyncio.sleep(0, "b")) == ["a", "b"]


# --- render: one clip's failure ----------------------------------------------------------------------------------


class FakeTracker:
    def __init__(self) -> None:
        self.canceled = False

    async def check_cancel(self) -> None:
        if self.canceled:
            raise JobCanceled()

    def report(self, fraction: float, *, alive: bool = True) -> None:
        pass

    def say(self, note: str) -> None:
        pass


def render_state(n: int) -> JobState:
    st = JobState(job_id="01JOB", user_id="u", workdir=Path("/tmp/none"))
    st.chosen = [make_moment(start=100 + 100 * i, end=130 + 100 * i) for i in range(n)]
    return st


async def test_one_clip_failing_with_a_user_facing_error_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    p = Pipeline(None, None, None, None)  # type: ignore[arg-type]

    async def cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        if index == 1:
            raise UserFacingError("The video could not be downloaded from YouTube. Check the link and tap Try again.")
        return Candidate(m, None, index=index)  # type: ignore[arg-type]

    monkeypatch.setattr(p, "_cut", cut)
    st = render_state(3)
    msg = await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert [c.index for c in st.candidates] == [0, 2]
    assert msg == "Cut 2 clips; 1 could not be cut."


async def test_every_clip_failing_shows_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    p = Pipeline(None, None, None, None)  # type: ignore[arg-type]

    async def cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        raise UserFacingError("This video is private or members-only, so it can't be downloaded.")

    monkeypatch.setattr(p, "_cut", cut)
    with pytest.raises(UserFacingError, match="private"):
        await p.render(render_state(2), FakeTracker())  # type: ignore[arg-type]


async def test_cancel_during_render_stops_the_other_cuts(monkeypatch: pytest.MonkeyPatch) -> None:
    p = Pipeline(None, None, None, None)  # type: ignore[arg-type]
    stopped: list[int] = []

    async def cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        if index == 0:
            await asyncio.sleep(0.01)
            raise JobCanceled()
        try:
            await asyncio.sleep(60)
        finally:
            stopped.append(index)
        raise AssertionError("unreachable")

    monkeypatch.setattr(p, "_cut", cut)
    with pytest.raises(JobCanceled):
        await asyncio.wait_for(p.render(render_state(2), FakeTracker()), 5)  # type: ignore[arg-type]
    assert stopped == [1]


def test_section_errors_are_retryable() -> None:
    e403 = proc.CommandError("yt-dlp", 1, "ERROR: unable to download video data: HTTP Error 403: Forbidden")
    frag = proc.CommandError("yt-dlp", 1, "ERROR: fragment 3 not found, unable to continue")
    assert isinstance(sources.explain(e403, "youtube", False, section=True), TransientError)
    assert isinstance(sources.explain(frag, "youtube", False, section=True), TransientError)
    # For the whole-video steps they still read as a plain failure the owner sees.
    assert isinstance(sources.explain(e403, "youtube", False), UserFacingError)
    gone = proc.CommandError("yt-dlp", 1, "ERROR: Video unavailable")
    assert isinstance(sources.explain(gone, "youtube", False, section=True), UserFacingError)


# --- audio format ----------------------------------------------------------------------------------------------


async def test_audio_download_never_falls_back_to_the_best_video(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[list[str]] = []

    async def run(cmd: list[str], **kw: Any) -> Any:
        seen.append(cmd)
        (tmp_path / "audio.m4a").write_bytes(b"x")
        return None

    monkeypatch.setattr(proc, "run", run)
    await sources.download_audio("https://kick.com/x/videos/abc", tmp_path, max_seconds=None)
    fmt = seen[0][seen[0].index("-f") + 1]
    assert fmt == sources.AUDIO_FORMAT
    assert fmt.split("/")[:3] == ["ba[ext=m4a]", "ba", "Audio_Only"]
    assert "b" not in fmt.split("/") and fmt.split("/")[-2:] == ["wa*", "w"]


# --- the agent: prompt file, timeout, unread windows -----------------------------------------------------------


async def test_system_prompt_goes_through_a_file(tmp_path: Path) -> None:
    b = brief()
    big = skills_block([SkillDoc("big", "", "x" * 300_000, False)])  # past Linux's 128 KiB limit for one argument
    opts = sdk_options(b, MomentTools(b), model_id="m", region="r", workdir=tmp_path, skill_names=[], skills=big)
    assert opts.system_prompt["type"] == "file"
    text = Path(opts.system_prompt["path"]).read_text(encoding="utf-8")
    assert text == big.text + "\n\n" + system_prompt(b)
    assert text.startswith("<owner_skills") and text.count("<owner_skills") == 1
    assert opts.effort == "high"


def test_sdk_timeout_scales_with_the_video() -> None:
    assert sdk_timeout(brief(duration=3600)) == 45 * 60
    assert sdk_timeout(brief(duration=6 * 3600)) == 12 * 8 * 60
    assert sdk_timeout(brief(duration=12 * 3600)) > sdk_timeout(brief(duration=6 * 3600))


def test_unread_windows() -> None:
    t = MomentTools(brief(duration=4000))
    wins = [(0.0, 1860.0), (1800.0, 3660.0), (3600.0, 4000.0)]
    t.read_transcript({"start": 0, "end": 1860})
    assert t.unread(wins) == [(1800.0, 3660.0), (3600.0, 4000.0)]
    t.read_transcript({"start": 1800, "end": 3660})
    assert t.unread(wins) == [(3600.0, 4000.0)]


async def test_timed_out_agent_hands_the_unread_windows_to_converse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def slow_sdk(b: Any, tools: MomentTools, **kw: Any) -> list[Any]:
        tools.read_transcript({"start": 0, "end": 1860})
        tools.submit_moments(
            {"moments": [raw_moment(start=s, end=s + 30, payoff_at=s + 25, peak_at=s + 20) for s in (100, 500, 900)]}
        )
        await asyncio.sleep(60)
        return tools.moments

    monkeypatch.setattr(agent_mod, "find_with_sdk", slow_sdk)
    monkeypatch.setattr(agent_mod, "sdk_timeout", lambda b: 0.05)
    windows_seen: list[Any] = []
    real = agent_mod.find_with_converse

    async def converse(b: Any, bedrock: Any, on_progress: Any = None, windows: Any = None, *, skills: Any) -> list[Any]:
        windows_seen.append(windows)
        return await real(b, bedrock, on_progress, windows, skills=skills)

    monkeypatch.setattr(agent_mod, "find_with_converse", converse)
    chosen, _ = await agent_mod.find_moments(
        brief(),
        bedrock=FakeBedrock([]),  # type: ignore[arg-type]
        model_id="m",
        region="r",
        workdir=tmp_path,
        skill_names=[],
        skills=skills_block([]),
        on_progress=lambda f: None,
    )
    assert len(chosen) == 3
    assert windows_seen == [[(1800.0, 3660.0), (3600.0, 4000.0)]]  # only what the agent never read


# --- cancel seen through a heartbeat ---------------------------------------------------------------------------


async def test_refused_heartbeat_stops_a_long_step() -> None:
    store = FakeStore()
    started = asyncio.Event()

    async def long_download() -> str:
        started.set()
        await asyncio.sleep(60)  # yt-dlp on an 8-hour stream
        return "never"

    async def owner_cancels() -> None:
        await started.wait()
        store.status = "canceled"  # the API wrote it; its signal to the container failed

    canceller = asyncio.create_task(owner_cancels())
    t = Tracker(store, "U", "J", heartbeat=0.02, flush=0.01)
    status = await asyncio.wait_for(run_job(t, ok_steps(download=long_download), clip_count=lambda: 0), 5)
    await canceller
    assert status == "canceled"
    steps = {s["key"]: s for s in store.last["steps"]}
    assert steps["download"]["status"] == "skipped" and steps["download"]["message"] == "Canceled."
    assert len(STEPS) == len(store.last["steps"])
