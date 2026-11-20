"""Long steps the owner can follow, and that always end (owner report 2026-11-20, job 01M7T90YCMC2767AR0WJ9XWMKY):
Check each clip took 30 minutes with no sign of life and the bar at 100%, then Finish up failed. Here: the checks run
side by side and say how far they are; every call has a time limit; a step with no sign of life is ended by the
watchdog with a plain sentence; a model that is not turned on says how to turn it on; and Try again after Finish up
reuses the cut, checked and captioned clips."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from clipfactory_agent import bedrock as bedrock_mod
from clipfactory_agent import jobs as jobs_mod
from clipfactory_agent import pipeline as pipeline_mod
from clipfactory_agent import retry as retry_mod
from clipfactory_agent.bedrock import MODEL_ACCESS_MESSAGE, Bedrock
from clipfactory_agent.checklist import Candidate, Measured
from clipfactory_agent.jobs import STEPS, StepDone, Tracker, creep, failure_message, run_job, stalled_message
from clipfactory_agent.pipeline import UNCHECKED, JobState, clip_item
from clipfactory_agent.render import RenderResult
from clipfactory_agent.store import to_ddb

from .conftest import make_moment
from .test_jobs import FakeStore
from .test_pipeline import World

KEYS = [k for k, _, _ in STEPS]


@pytest.fixture(autouse=True)
def _no_shutdown() -> Any:
    jobs_mod.SHUTDOWN.clear()
    yield
    jobs_mod.SHUTDOWN.clear()


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> World:
    return World(tmp_path, monkeypatch)


def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    # Only retry's own wait: the step watchdog and the heartbeat loop keep the real asyncio.sleep.
    monkeypatch.setattr(retry_mod, "asyncio", SimpleNamespace(sleep=no_sleep))


def access_denied() -> ClientError:
    return ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "You don't have access to the model with the id."}},
        "Converse",
    )


KEEP = {
    "zero_context": True,
    "zero_context_note": "clear",
    "pays_off": True,
    "pays_off_note": "lands",
    "hook_ok": True,
    "hook_note": "fine",
    "new_hook": None,
    "move_start_by": 0,
    "move_end_by": 0,
    "verdict": "keep",
}


class Counts:
    def __init__(self, world: World, monkeypatch: pytest.MonkeyPatch, drop: set[float] = frozenset()) -> None:  # type: ignore[assignment]
        self.reviews: list[float] = []
        self.renders: list[float] = []
        real_render = pipeline_mod.render_clip

        async def review(_self: Any, st: JobState, c: Candidate) -> dict[str, Any]:
            self.reviews.append(c.moment.start)
            return {**KEEP, "verdict": "drop"} if c.moment.start in drop else dict(KEEP)

        async def render(m: Any, **kw: Any) -> RenderResult:
            self.renders.append(m.start)
            return await real_render(m, **kw)

        monkeypatch.setattr(pipeline_mod.Pipeline, "_review", review)
        monkeypatch.setattr(pipeline_mod, "render_clip", render)
        self.world = world

    def captions_calls(self) -> int:
        return len(self.world.fable.calls("submit_captions"))


def fail_first_put(world: World) -> None:
    """Finish up fails on the first clip, as the owner's job did ("[ValidationError, None]")."""
    real = world.store.put_clip
    calls = {"n": 0}

    async def put_clip(item: dict[str, Any], fence: Any = None) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "[ValidationError, None]"},
                    "CancellationReasons": [{"Code": "ValidationError"}, {"Code": "None"}],
                },
                "TransactWriteItems",
            )
        await real(item, fence)

    world.store.put_clip = put_clip  # type: ignore[method-assign]


async def finish_up_failed(world: World, monkeypatch: pytest.MonkeyPatch) -> Counts:
    counts = Counts(world, monkeypatch, drop={300.0})
    fail_first_put(world)
    status, _, steps = await world.run()
    assert status == "failed"
    assert steps["finalize"]["status"] == "failed"
    assert steps["checklist"]["message"] == "2 clips passed; 1 swapped for other moments."
    assert world.store.clips == []
    return counts


async def test_try_again_after_finish_up_reuses_the_checked_clips_and_captions(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    counts = await finish_up_failed(world, monkeypatch)
    renders, reviews, captions = len(counts.renders), len(counts.reviews), counts.captions_calls()
    saved = world.store.json("checked.json")
    assert [r["index"] for r in saved["clips"]] == [0, 2]  # clip 1 was swapped for spare 2
    assert world.store.has("checked/02/done.json") and not world.store.has("checked/00/done.json")
    ids = [r["id"] for r in world.store.json("clips.json")["clips"]]

    world.store.job.update(status="queued", pickUp=True)  # what Try again writes (api jobs.picks_up)
    status, st, steps = await world.run()
    assert status == "ready"
    assert len(counts.renders) == renders  # nothing cut again, the swapped clip neither
    assert len(counts.reviews) == reviews  # nothing checked again
    assert counts.captions_calls() == captions  # the captions come back too
    assert steps["render"]["message"] == "Used the 2 clips cut and checked last time."
    assert steps["checklist"]["message"] == "Used the checks from last time for 2 clips."
    assert [c["clipId"] for c in world.store.clips] == ids
    assert [c.moment.start for c in st.candidates] == [100.0, 450.0]
    keys = {i["key"] for i in world.store.clips[1]["checklist"]["items"]}
    assert {"hear", "zero_context"} <= keys  # the checks themselves came back with the clip


async def test_try_again_after_finish_up_from_before_the_checklist_was_saved(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The owner's own job ran before ``checked.json`` existed: its clips come back from ``clips.json``. Only the
    swapped clip, never saved, is cut once more from its saved moment; nothing is checked or captioned again."""
    counts = await finish_up_failed(world, monkeypatch)
    for key in [k for k in world.store.files if "/checked" in k]:
        del world.store.files[key]
    renders, reviews, captions = list(counts.renders), len(counts.reviews), counts.captions_calls()
    ids = [r["id"] for r in world.store.json("clips.json")["clips"]]

    world.store.job.update(status="queued", pickUp=True)
    status, _, _ = await world.run()
    assert status == "ready"
    assert counts.renders[len(renders) :] == [450.0]
    assert len(counts.reviews) == reviews
    assert counts.captions_calls() == captions
    assert [c["clipId"] for c in world.store.clips] == ids
    items = {i["key"]: i for i in world.store.clips[0]["checklist"]["items"]}
    assert items["review"]["pass"] is True and items["hear"]["pass"] is True


async def test_checks_run_side_by_side_and_say_how_far_they_are(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    Counts(world, monkeypatch)
    running = {"now": 0, "peak": 0}

    async def slow_measure(video: Path) -> Measured:
        running["now"] += 1
        running["peak"] = max(running["peak"], running["now"])
        await asyncio.sleep(0.05)
        running["now"] -= 1
        return Measured(-10.0, 5.0)

    monkeypatch.setattr(pipeline_mod, "measure", slow_measure)
    status, _, _ = await world.run()
    assert status == "ready"
    assert running["peak"] == 2  # both clips at once
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines() if x.startswith("{")]
    notes = [x["note"] for x in lines if x["event"] == "job.step_note" and x["step"] == "checklist"]
    assert notes[0] == "Checking 2 clips…"
    assert "Checking clip 1 of 2…" in notes and "Checking clip 2 of 2…" in notes
    checked = [x for x in lines if x["event"] == "checklist.clip_checked"]
    assert sorted(x["index"] for x in checked) == [0, 1] and all(x["outcome"] == "passed" for x in checked)
    progress = [w["progress"] for w in world.store.writes if "progress" in w]
    assert progress == sorted(progress)


async def test_a_review_with_no_answer_is_given_up_and_the_clip_still_checked(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    def hang(kw: dict[str, Any]) -> Any:
        time.sleep(0.5)
        return KEEP

    world.fable.handlers["submit_review"] = hang
    monkeypatch.setattr(pipeline_mod, "REVIEW_SECONDS", 0.05)
    status, _, _ = await world.run()
    assert status == "ready"
    notes = {i["note"] for c in world.store.clips for i in c["checklist"]["items"]}
    assert "Claude could not review this clip; check it yourself." in notes


async def test_checks_that_never_finish_still_end_with_clips(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every check hangs: each is given up, the spare too, and the clips go on to the owner saying they were not
    checked. Write the captions and Finish up run; the job is ready."""
    Counts(world, monkeypatch)

    async def stuck(video: Path) -> Measured:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    monkeypatch.setattr(pipeline_mod, "measure", stuck)
    monkeypatch.setattr(pipeline_mod, "CHECK_CLIP_SECONDS", 0.05)
    status, _, steps = await world.run()
    assert status == "ready", steps
    assert steps["captions"]["status"] == "done" and steps["finalize"]["status"] == "done"
    assert world.store.clips
    for clip in world.store.clips:
        assert clip["checklist"]["items"][0] == {"key": "checked", "label": "Checked", "pass": False, "note": UNCHECKED}


# --- the watchdog --------------------------------------------------------------------------------------------------


def quick(store: FakeStore, limit: float) -> Tracker:
    return Tracker(store, "U", "J", heartbeat=5, flush=5, stall_seconds=dict.fromkeys(KEYS, limit), watch_tick=0.01)


async def test_a_step_with_no_sign_of_life_is_ended_with_a_plain_sentence() -> None:
    store = FakeStore()
    tr = quick(store, 0.1)
    later: list[str] = []

    async def ok() -> StepDone:
        later.append(tr.current or "")
        return StepDone("ok")

    async def stuck() -> StepDone:
        async with creep(tr.report, 0.0, 0.9, expected=1.0, every=0.01):  # the bar creeping is no sign of life
            await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    steps = [(k, stuck if k == "checklist" else ok) for k in KEYS]
    status = await asyncio.wait_for(run_job(tr, steps, clip_count=lambda: 0), 5)
    assert status == "failed"
    assert (
        store.last["error"]
        == stalled_message("checklist")
        == ("Check each clip stopped moving. Tap Try again to pick up where it left off.")
    )
    assert store.last["pickUp"] is True  # Try again picks up with the clips already cut
    assert "captions" not in later


async def test_a_slow_step_that_keeps_saying_how_far_it_is_is_never_ended() -> None:
    store = FakeStore()
    tr = quick(store, 0.1)

    async def slow() -> StepDone:
        for i in range(10):  # 0.3 s in all, three times the quiet limit
            await asyncio.sleep(0.03)
            tr.say(f"Checked {i + 1} of 10 clips.")
        return StepDone("done slowly")

    status = await run_job(tr, [(k, slow) for k in KEYS], clip_count=lambda: 1)
    assert status == "ready"


# --- the model is not turned on ------------------------------------------------------------------------------------


async def test_a_model_that_is_not_turned_on_says_where_to_turn_it_on(monkeypatch: pytest.MonkeyPatch) -> None:
    no_backoff(monkeypatch)
    calls: list[int] = []

    class Denied:
        def converse(self, **kw: Any) -> Any:
            calls.append(1)
            raise access_denied()

    store = FakeStore()
    tr = Tracker(store, "U", "J", heartbeat=5, flush=5)
    b = Bedrock("m", "eu-north-1", client=Denied())

    async def checklist() -> StepDone:
        await b._call({"modelId": "m"})
        return StepDone("never")

    async def ok() -> StepDone:
        return StepDone("ok")

    status = await run_job(tr, [(k, checklist if k == "checklist" else ok) for k in KEYS], clip_count=lambda: 0)
    assert status == "failed"
    assert store.last["error"] == MODEL_ACCESS_MESSAGE
    assert "Stockholm" in MODEL_ACCESS_MESSAGE and "Model catalog" in MODEL_ACCESS_MESSAGE
    assert "Claude Opus 5.5" in MODEL_ACCESS_MESSAGE and "Claude Opus 4.8" in MODEL_ACCESS_MESSAGE
    assert len(calls) == 1  # not tried again, no hang
    assert failure_message("captions", RuntimeError("x")) != MODEL_ACCESS_MESSAGE


async def test_a_review_refused_for_model_access_ends_the_job_with_that_sentence(world: World) -> None:
    def denied(kw: dict[str, Any]) -> Any:
        raise access_denied()

    world.fable.handlers["submit_review"] = denied
    status, _, steps = await world.run()
    assert status == "failed"
    assert steps["checklist"]["message"] == MODEL_ACCESS_MESSAGE[:300]


async def test_a_model_call_that_never_answers_is_given_up(monkeypatch: pytest.MonkeyPatch) -> None:
    no_backoff(monkeypatch)
    monkeypatch.setattr(bedrock_mod, "CALL_SECONDS", 0.05)

    class Hangs:
        def __init__(self) -> None:
            self.calls = 0

        def converse(self, **kw: Any) -> Any:
            self.calls += 1
            time.sleep(0.2)
            return {}

    client = Hangs()
    b = Bedrock("m", "eu-north-1", client=client)
    with pytest.raises(TimeoutError):
        await b._call({"modelId": "m"})
    assert client.calls == 4  # each try given up after CALL_SECONDS, then no more


# --- sizes ---------------------------------------------------------------------------------------------------------


def test_a_resumed_ten_clip_job_fits_dynamodb_with_room_to_spare() -> None:
    """The Clip items and the Job item of a big resumed job (ten clips, two of them swapped, every caption at its
    longest, every note at its longest) stay far below DynamoDB's 400 KB item limit."""
    st = JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"), session_id="S")
    st.source = {"type": "upload", "title": "x" * 300, "durationSec": 1564.0}
    longest = {
        "youtubeTitle": "t" * 100,
        "youtubeDescription": "d" * 5000,
        "instagram": "i" * 2200,
        "facebook": "f" * 5000,
        "tiktok": "k" * 2200,
        "x": "x" * 280,
    }
    from clipfactory_agent.checklist import Item

    for i in range(10):
        index = i if i < 8 else 10 + i  # two spares
        m = make_moment(start=100 + 100 * i, end=145 + 100 * i, hook="h" * 200, summary="s" * 2000)
        caps = [{"t0": j * 0.5, "t1": j * 0.5 + 0.5, "text": "word " * 3} for j in range(90)]
        r = RenderResult(Path("c.mp4"), Path("c.jpg"), 45.0, [(m.start, m.end)], caps, "full", True)
        items = [Item(f"k{j}", "label " * 10, j % 2 == 0, "n" * 300) for j in range(12)]
        c = Candidate(m, r, items, ["fix " * 50] * 3, index=index)
        st.candidates.append(c)
        st.clip_ids[id(c)] = f"01M7T90YCMC2767AR0WJ9XWMK{i}"
        st.captions[st.clip_ids[id(c)]] = dict(longest)
    sizes = [
        len(json.dumps(to_ddb(clip_item(st, c, st.clip_ids[id(c)], n, "p/", "upload", "")), default=str))
        for n, c in enumerate(st.candidates, start=1)
    ]
    assert max(sizes) < 64_000, sizes
    tr = Tracker(FakeStore(), "U", "J", heartbeat=5, flush=5)
    for s in tr.steps:
        s.update(status="done", message="m" * 300, startedAt="2026-11-20T04:18:13.041Z", finishedAt="x" * 24)
    job = {"steps": tr.steps, "source": st.source, "error": "e" * 500, "note": "n" * 100, "progress": 0.99}
    assert len(json.dumps(job)) < 16_000


# --- review fixes ---------------------------------------------------------------------------------------------------


def test_access_denied_outside_bedrock_is_not_blamed_on_the_model() -> None:
    err = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no access"}}, "GetSecretValue")
    assert bedrock_mod.model_unavailable(err) is False
    assert failure_message("captions", err) != MODEL_ACCESS_MESSAGE
    assert bedrock_mod.model_unavailable(access_denied()) is True


async def test_nothing_checked_says_so(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    Counts(world, monkeypatch)

    async def stuck(video: Path) -> Measured:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    monkeypatch.setattr(pipeline_mod, "measure", stuck)
    monkeypatch.setattr(pipeline_mod, "CHECK_CLIP_SECONDS", 0.05)
    status, _, steps = await world.run()
    assert status == "ready", steps
    msg = steps["checklist"]["message"]
    assert "could not be checked" in msg and "passed" not in msg and "swapped" not in msg


async def test_a_fatal_error_in_a_later_check_is_seen_at_once() -> None:
    from clipfactory_agent.checklist import Outcome, check_all

    async def check(c: Any) -> Outcome:
        if c == 2:
            raise ValueError("fatal")
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    async def cut(m: Any) -> Any:
        return None

    t0 = time.monotonic()
    with pytest.raises(ValueError):
        await asyncio.wait_for(check_all([0, 1, 2], [], check=check, cut=cut, want=3, limit=3), 5)  # type: ignore[arg-type]
    assert time.monotonic() - t0 < 2


async def test_cancelling_the_run_while_a_stalled_step_is_stopped_is_not_swallowed() -> None:
    async def stubborn() -> StepDone:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            await asyncio.sleep(0.3)  # slow cleanup
            raise
        return StepDone("x")

    store = FakeStore()
    tr = quick(store, 0.05)
    t = asyncio.ensure_future(jobs_mod.watched(tr, "resolve", stubborn))
    await asyncio.sleep(0.15)  # the watchdog is now waiting on the stubborn step's cleanup
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
