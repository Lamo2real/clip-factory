"""What the agent is told it learned (docs/CONTRACTS.md §16.7, §16.12).

"Prior learnings": only active creator lessons for this job's creator, then active "all creators" ones; the exact
heading; left out entirely when there are none; present in every moment-picking and hook-writing call. The retired
48-hour learnings never reach a prompt."""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from clipfactory_agent import agent as agent_mod
from clipfactory_agent import captions as captions_mod
from clipfactory_agent import learnings
from clipfactory_agent.agent import Brief, system_prompt
from clipfactory_agent.bedrock import Bedrock
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.creators import ALL_CREATORS
from clipfactory_agent.pipeline import JobState, Pipeline
from clipfactory_agent.render import RenderResult

from .conftest import make_moment
from .test_agent import brief as long_brief
from .test_skills_everywhere import RecordingClient, owner_block

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
ME = "youtube:id:UCme"
MY_NAME = "youtube:name:me"
OTHER = "youtube:id:UCother"


def week(i: int, text: str | None = None) -> dict[str, Any]:
    return {
        "learningId": f"01W{i:02d}",
        "kind": "week",
        "week": f"2026-W{i:02d}",
        "createdAt": f"2026-01-{i:02d}T10:00:00Z",
        "text": text or f"week {i}",
    }


def old48(i: int) -> dict[str, Any]:
    """A retired 48-hour learning: no kind."""
    return {"learningId": f"01C{i:02d}", "createdAt": f"2026-02-{i:02d}T10:00:00Z", "text": f"clip {i}"}


def lesson(text: str, creator: str = ME, status: str = "active", **kw: Any) -> dict[str, Any]:
    return {
        "lessonId": text[:24].ljust(24, "0"),
        "kind": "creator",
        "creatorKey": creator,
        "status": status,
        "text": text,
        "supportPostIds": ["P1"],
        "expiresAt": "2027-01-01T00:00:00.000Z",
        **kw,
    }


class Store:
    def __init__(self, rows: list[dict[str, Any]], lessons_: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows
        self.lessons = lessons_ or []
        self.asked: list[int] = []

    async def latest_learnings(self, user_id: str, n: int = 10) -> list[dict[str, Any]]:
        self.asked.append(n)
        return self.rows[:n]

    async def creator_lessons(self, user_id: str) -> list[dict[str, Any]]:
        return self.lessons


async def test_load_keeps_four_week_learnings_and_drops_the_retired_48_hour_ones() -> None:
    rows = [old48(i) for i in range(1, 15)] + [week(i) for i in range(1, 8)]
    store = Store(rows, [lesson("Open on the scream.")])
    got = await learnings.load(store, "U", [ME], NOW)
    assert store.asked == [50]
    assert got.week == ["week 7", "week 6", "week 5", "week 4"]
    assert got.prior == ["Open on the scream."]
    assert len(got) == 5


def test_only_active_unexpired_lessons_for_this_creator_then_all_creators() -> None:
    rows = [
        lesson("All creators: short hooks.", ALL_CREATORS, supportPostIds=["a", "b", "c"]),
        lesson("Mine, well supported.", ME, supportPostIds=["a", "b", "c"]),
        lesson("Mine, by my old name key.", MY_NAME),
        lesson("Someone else's.", OTHER),
        lesson("Still trying it.", ME, status="trial"),
        lesson("Turned off.", ME, status="off"),
        lesson("Deleted.", ME, status="deleted"),
        lesson("Expired on the page.", ME, status="expired"),
        lesson("Past its date.", ME, expiresAt="2026-11-19T00:00:00.000Z"),
        lesson("No date at all.", ME, expiresAt=None),
        {**lesson("A week learning, not a lesson.", ME), "kind": "week"},
    ]
    assert learnings.prior_texts(rows, [ME, MY_NAME], NOW) == [
        "Mine, well supported.",
        "Mine, by my old name key.",
        "All creators: short hooks.",
    ]
    # An upload (no creator key) still gets the all-creators lessons.
    assert learnings.prior_texts(rows, [], NOW) == ["All creators: short hooks."]


def test_the_section_has_the_exact_heading_and_plain_lines() -> None:
    text = learnings.prior_section(["Open on the scream.", "Keep hooks to 5 words or fewer."])
    lines = text.splitlines()
    assert lines[0] == "Prior learnings"
    assert "advice, never a rule" in lines[1].lower()
    assert lines[2:] == ["- Open on the scream.", "- Keep hooks to 5 words or fewer."]
    for banned in ("{", "lessonId", "evidence", "views"):
        assert banned not in "\n".join(lines[2:])


def test_no_lessons_means_no_section_at_all() -> None:
    assert learnings.prior_section([]) == ""
    assert learnings.with_prior([], "Task.") == "Task."
    s = system_prompt(brief())
    assert "Prior learnings" not in s
    assert s.startswith("You are the clip finder")


def brief(**kw: Any) -> Brief:
    base: dict[str, Any] = {
        "title": "T",
        "channel": "C",
        "platform": "youtube",
        "duration": 600.0,
        "notes": "",
        "clip_min": 1,
        "clip_max": 3,
        "length": (20.0, 45.0),
        "words": [],
        "loud": [],
    }
    return Brief(**{**base, **kw})


def test_the_moment_prompt_puts_prior_learnings_first_then_rules_then_week_picks() -> None:
    s = system_prompt(brief(prior=["Open on the scream."], week_learnings=["Picks open on a scream"]))
    assert s.startswith("Prior learnings\n")
    assert s.index("Open on the scream.") < s.index("You are the clip finder")
    assert s.index("Loudness spikes") < s.index("The owner's best-of-week picks taught")
    assert s.count("Prior learnings") == 1


def test_week_section_alone() -> None:
    assert learnings.prompt_section(learnings.Learnings()) == ""
    only_week = learnings.prompt_section(learnings.Learnings(week=["w"]))
    assert only_week.startswith("The owner's best-of-week picks taught") and "- w" in only_week


def test_a_relearned_week_counts_as_new_by_created_at() -> None:
    old_id_new_text = {**week(1, "re-learned"), "createdAt": "2026-03-01T00:00:00Z"}
    assert learnings.week_texts([week(5), old_id_new_text, week(2, "  ")]) == ["re-learned", "week 5"]


# --- every moment-picking and hook-writing call gets it, right after the skills block -------------------------

PRIOR = ["Open on the scream."]


def _assert_prior_after_block(requests: list[dict[str, Any]], block: Any) -> None:
    assert requests
    for r in requests:
        system = r["system"]
        assert system[0]["text"] == block.text
        assert system[-1]["text"].startswith("Prior learnings\n")
        assert "- Open on the scream." in system[-1]["text"]


async def test_the_moment_fallback_call_gets_prior_learnings() -> None:
    client = RecordingClient()
    block = owner_block()
    b = dataclasses.replace(long_brief(), prior=PRIOR)  # a video with words, so the fallback asks per window
    await agent_mod.find_with_converse(b, Bedrock("m", "r", client=client), skills=block)
    _assert_prior_after_block(client.requests, block)


async def test_the_sdk_prompt_file_gets_prior_learnings(tmp_path: Path) -> None:
    block = owner_block()
    b = brief(prior=PRIOR)
    opts = agent_mod.sdk_options(
        b, agent_mod.MomentTools(b), model_id="m", region="r", workdir=tmp_path, skill_names=[], skills=block
    )
    text = Path(opts.system_prompt["path"]).read_text("utf-8")
    assert text.startswith(block.text + "\n\nPrior learnings\n")


async def test_the_checklist_review_gets_prior_learnings(tmp_path: Path) -> None:
    client = RecordingClient()
    block = owner_block()
    pipe = Pipeline(SimpleNamespace(), None, Bedrock("m", "r", client=client), None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path)
    st.skills_block, st.prior = block, PRIOR
    r = RenderResult(tmp_path / "c.mp4", tmp_path / "c.jpg", 30.0, [(100, 130)], [], "full", False)
    await pipe._review(st, Candidate(make_moment(), r))
    _assert_prior_after_block(client.requests, block)
    assert "You review short vertical clips" in client.requests[0]["system"][-1]["text"]


async def test_the_captions_get_prior_learnings(tmp_path: Path) -> None:
    client = RecordingClient()
    block = owner_block()
    pipe = Pipeline(SimpleNamespace(), None, Bedrock("m", "r", client=client), None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path)
    st.skills_block, st.prior = block, PRIOR
    st.skills = SimpleNamespace(full_text="", docs=[])  # type: ignore[assignment]
    r = RenderResult(tmp_path / "c.mp4", tmp_path / "c.jpg", 30.0, [(100, 130)], [], "full", False)
    st.candidates = [Candidate(make_moment(), r)]
    await pipe.write_captions(st, SimpleNamespace())  # type: ignore[arg-type]
    _assert_prior_after_block(client.requests, block)
    assert "You write social captions" in client.requests[0]["system"][-1]["text"]


async def test_the_second_look_gets_prior_learnings() -> None:
    """The second look (ADR-40) keeps, swaps or drops picked moments and can write a new hook, so it is a
    moment-picking and hook-writing call too."""
    from clipfactory_agent import verify

    from .deep_support import FakeFrames, make_picture, no_cancel

    client = RecordingClient()
    block = owner_block()
    await verify.second_look(
        [make_moment()],
        [],
        bedrock=Bedrock("m", "r", client=client),
        skills=block,
        frames=FakeFrames(make_picture(600)),
        words=[],
        speakers=None,
        duration=600,
        length=(20, 45),
        clip_min=1,
        check_cancel=no_cancel,
        prior=PRIOR,
    )
    _assert_prior_after_block(client.requests, block)
    assert "You check one picked clip moment" in client.requests[0]["system"][-1]["text"]


async def test_no_lessons_leave_every_call_without_the_heading(tmp_path: Path) -> None:
    client = RecordingClient()
    block = owner_block()
    await captions_mod.write_captions(
        Bedrock("m", "r", client=client),
        [captions_mod.ClipText("A", make_moment(), "no way")],
        notes="",
        skills=block,
        skills_text="",
        system=learnings.with_prior([], "You write social captions for short clips."),
    )
    assert all("Prior learnings" not in str(r["system"]) for r in client.requests)


async def test_analyze_loads_lessons_for_the_jobs_creator(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    (builtin / "playbook").mkdir(parents=True)
    (builtin / "playbook" / "SKILL.md").write_text("---\nname: playbook\n---\nCore")

    class AnalyzeStore(Store):
        async def exists(self, key: str) -> bool:
            return True

        async def get_json(self, key: str) -> Any:
            return [-40.0] * 10

        async def skill_rows(self, user_id: str) -> list[dict[str, Any]]:
            return []

        async def get_bytes(self, key: str) -> bytes:
            raise FileNotFoundError(key)

    store = AnalyzeStore([old48(1)], [lesson("Mine.", ME), lesson("Not mine.", OTHER)])
    pipe = Pipeline(SimpleNamespace(skills_dir=builtin, deep_enabled=False), store, None, None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path / "work")
    st.source = {"platform": "youtube", "channelId": "UCme", "channel": "Me"}
    await pipe.analyze(st, SimpleNamespace(report=lambda f: None))  # type: ignore[arg-type]
    assert st.prior == ["Mine."]
    assert st.week_learnings == []
