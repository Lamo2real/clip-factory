"""Fable watching the whole picture (ADR-40): the chunk plan, which frames are sent, cleaning the answers, and the
loop that never fails the job (resume, waiting out a busy service, splitting for size, deadline, cancel, guard)."""

from __future__ import annotations

import asyncio
import functools
import itertools
from typing import Any

import pytest

from clipfactory_agent import bedrock as bedrock_mod
from clipfactory_agent import guard, watch
from clipfactory_agent.bedrock import Bedrock, ModelError
from clipfactory_agent.guard import CallBudget, Deadline
from clipfactory_agent.retry import retry
from clipfactory_agent.schema import check
from clipfactory_agent.util import JobCanceled, TransientError
from clipfactory_agent.watch import Unit, run_track

from .deep_support import FakeFrames, ToolClient, block, client_error, event, make_picture, no_cancel

# --- the plan --------------------------------------------------------------------------------------------------


def test_plan_covers_the_whole_source_in_150_second_chunks_with_a_lead_in() -> None:
    units = watch.plan(1800)
    assert len(units) == 12
    assert (units[0].start, units[0].end, units[0].lead) == (0, 150, 0)
    assert (units[1].start, units[1].end, units[1].lead) == (150, 300, 144)  # 6 s of the chunk before
    assert units[-1].end == 1800
    assert [len(watch.plan(h * 3600)) for h in (2, 4, 12)] == [48, 96, 288]  # nothing is sampled away
    short = watch.plan(310)
    assert [(u.start, u.end) for u in short] == [(0, 150), (150, 300), (300, 310)]
    assert watch.plan(0) == []
    assert len(watch.plan(100 * 3600)) == guard.MAX_CHUNKS


def test_constants_match_the_decision() -> None:
    assert (watch.CHUNK_SECONDS, watch.CHUNK_OVERLAP, watch.WATCH_CONCURRENCY) == (150, 6, 8)


# --- frames ----------------------------------------------------------------------------------------------------


def test_one_frame_per_two_seconds_without_spikes() -> None:
    times = watch.frame_times(144, 300, [])
    assert times[0] == 144 and times[-1] == 298 and len(times) == 78
    assert all(b - a == 2 for a, b in itertools.pairwise(times))


def test_every_frame_around_a_spike_and_the_burst_cap() -> None:
    one = watch.frame_times(0, 150, [60])
    around = [t for t in one if 57 <= t <= 63]
    assert around == [57 + i * 0.5 for i in range(13)]  # every half second, 3 s either side
    assert len(one) == 75 + 10  # 13 frames, 3 of them already regular ones
    many = watch.frame_times(0, 150, [20, 40, 60, 80, 100, 120, 140])  # only the first five count
    assert len(many) == 75 + watch.BURST_MAX
    assert all(not 117 <= t <= 123 or t % 2 == 0 for t in many)  # the sixth spike got no extra frames
    # the nearest frames to each spike are kept when the cap bites
    assert {19.5, 20.5, 39.5, 40.5, 99.5, 100.5} <= set(many)
    assert watch.frame_times(0, 4, [100]) == [0, 2]  # a spike outside the chunk adds nothing


def test_spike_times_mixes_loud_and_fast_seconds() -> None:
    loud = [-40.0] * 300
    loud[100] = -10.0
    motion = [0.01] * 300
    motion[200] = 0.2
    assert sorted(watch.spike_times(loud, motion, 0, 300)) == [100, 200]
    assert watch.spike_times(loud, motion, 0, 90) == []
    assert watch.spike_times([], [], 0, 300) == []


def test_pick_frames_and_blocks() -> None:
    frames = [(t / 2, b"j%d" % t) for t in range(20)]
    picked = watch.pick_frames(frames, [0, 2, 3.5, 99])
    assert [t for t, _ in picked] == [0, 2, 3.5]
    blocks = watch.frame_blocks([(3731.0, b"a"), (3731.5, b"b")])
    assert blocks[0] == {"text": "[1:02:11] 3731 s"} and blocks[2] == {"text": "[1:02:11] 3731.5 s"}
    assert blocks[1] == {"image": {"format": "jpeg", "source": {"bytes": b"a"}}}


# --- cleaning the answer ---------------------------------------------------------------------------------------


def test_schema_is_strict() -> None:
    good = {"scene": "driving", "events": [event(10, 14)]}
    assert check(watch.SCENES_SCHEMA, good) == []
    assert check(watch.SCENES_SCHEMA, {"scene": "x", "events": [{**event(1, 2), "extra": 1}]})
    assert check(watch.SCENES_SCHEMA, {"scene": "x", "events": [event(1, 2, kind="dance")]})
    assert check(watch.SCENES_SCHEMA, {"scene": "x", "events": [event(1, 2)] * 13})
    assert check(watch.SCENES_SCHEMA, {"events": []})
    assert watch.SCENES_SCHEMA["additionalProperties"] is False


def test_clean_clamps_times_and_drops_dull_events() -> None:
    raw = {
        "scene": "  a   chase ",
        "events": [
            event(140, 160, intensity=12),  # runs past the chunk
            event(10, 20),  # before the chunk
            event(150, 155, kind="calm", intensity=3),  # dropped
            event(150, 155, kind="menu_or_loading", intensity=2),  # dropped
            event(150, 155, kind="calm", intensity=4),  # kept
            event(160, 150, kind="made_up", face="happy", what=" ".join(["w"] * 40)),
            "nonsense",
            {"start": "x", "end": 1},
        ],
    }
    out = watch.clean(raw, 144, 150 + 6)
    assert out["scene"] == "a chase"
    ev = out["events"]
    assert [(e["t0"], e["t1"]) for e in ev] == [(144, 156), (144, 144), (150, 155), (156, 156)]
    assert ev[0]["intensity"] == 10
    assert ev[2]["kind"] == "calm"
    assert ev[3]["kind"] == "other" and ev[3]["face"] == "none" and len(ev[3]["what"].split()) == 25
    assert watch.clean({"scene": "x", "events": [event(5, 9)]}, 300, 600, offset=300)["events"][0]["t0"] == 305
    assert len(watch.clean({"events": [event(1, 2)] * 30}, 0, 10)["events"]) == watch.MAX_EVENTS


# --- the loop ---------------------------------------------------------------------------------------------------


def units(n: int) -> list[Unit]:
    return [Unit(i, i * 150.0, (i + 1) * 150.0, max(0.0, i * 150.0 - 6)) for i in range(n)]


async def track(work: Any, n: int = 4, **kw: Any) -> watch.TrackResult:
    kw.setdefault("deadline", Deadline(60))
    kw.setdefault("check_cancel", no_cancel)
    return await run_track("fable", units(n), work, concurrency=kw.pop("concurrency", 2), **kw)


async def test_every_unit_done_and_checkpointed_at_once() -> None:
    saved: dict[int, dict[str, Any]] = {}
    progress: list[float] = []

    async def work(u: Unit) -> dict[str, Any]:
        return {"scene": f"s{u.i}", "events": []}

    async def save(u: Unit, body: dict[str, Any]) -> None:
        saved[u.i] = body

    r = await track(work, save=save, on_progress=progress.append)
    assert sorted(r.done) == [0, 1, 2, 3] and not r.failed and r.status == {"status": "ok"}
    assert saved[2] == {"i": 2, "start": 300.0, "end": 450.0, "ok": True, "scene": "s2", "events": []}
    assert progress[-1] == 1.0


async def test_resume_reuses_saved_chunks_and_only_watches_the_rest() -> None:
    calls: list[int] = []

    async def work(u: Unit) -> dict[str, Any]:
        calls.append(u.i)
        return {"scene": "new", "events": []}

    async def load(u: Unit) -> dict[str, Any] | None:
        if u.i == 2:
            raise OSError("S3 hiccup")  # a failed read is the same as nothing saved
        return {"i": u.i, "start": 0, "end": 1, "ok": True, "scene": "old", "events": []} if u.i < 2 else None

    r = await track(work, load=load)
    assert sorted(calls) == [2, 3] and r.reused == 2
    assert r.done[0]["scene"] == "old" and r.done[3]["scene"] == "new"


@pytest.fixture
def no_pauses(monkeypatch: pytest.MonkeyPatch) -> None:
    """The growing pauses between tries (and retry.py's inside each call) at zero, so the tests run at once."""
    monkeypatch.setattr(watch, "RETRY_BASE", 0.0)
    monkeypatch.setattr(bedrock_mod, "retry", functools.partial(retry, base=0.0))


async def test_a_busy_service_is_waited_out_up_to_max_tries(no_pauses: None) -> None:
    tries: dict[int, int] = {}

    async def work(u: Unit) -> dict[str, Any]:
        tries[u.i] = tries.get(u.i, 0) + 1
        if u.i == 1 and tries[1] < 4:
            raise TransientError("throttled past the retries")
        if u.i == 2:
            raise TransientError("still throttled")
        return {"scene": "", "events": []}

    r = await track(work)
    assert tries == {0: 1, 1: 4, 2: watch.MAX_TRIES, 3: 1}  # bounded: never a seventh try
    assert sorted(r.done) == [0, 1, 3] and r.failed == {2: "busy"}
    assert r.status["status"] == "partial" and r.status["done"] == 3
    assert r.failures() == [{"start": 300.0, "end": 450.0, "src": "fable", "reason": "busy"}]


async def test_pauses_grow_and_stop_at_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    pauses: list[float] = []
    real_sleep = asyncio.sleep

    async def sleep(s: float) -> None:
        pauses.append(s)
        await real_sleep(0)

    monkeypatch.setattr(watch.asyncio, "sleep", sleep)
    monkeypatch.setattr(watch.random, "random", lambda: 1.0)
    monkeypatch.setattr(watch, "RETRY_BASE", 5.0)

    async def work(u: Unit) -> dict[str, Any]:
        raise TransientError("busy")

    r = await track(work, n=1, deadline=Deadline(50))
    assert pauses == [5.0, 10.0, 20.0, 40.0]  # the fifth (60 s) would pass the 50 s deadline, so it is not taken
    assert r.failed == {0: "busy"}


async def test_a_rate_limited_account_still_gets_every_chunk_watched(no_pauses: None) -> None:
    """A fake Bedrock that serves at most 2 calls at once and throttles the rest: the pacer slows down and every
    chunk of a 2-hour source is watched, none lost as busy."""
    in_flight = 0
    most = 0

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        nonlocal in_flight, most
        if in_flight >= 2:
            raise client_error("ThrottlingException", "Too many requests")
        in_flight += 1
        most = max(most, in_flight)
        try:
            import time

            time.sleep(0.01)
            return {"scene": "", "events": []}
        finally:
            in_flight -= 1

    r = await chunks(ToolClient({"report_scenes": answer}), seconds=2 * 3600)
    assert len(r.done) == 48 and not r.failed and r.status == {"status": "ok"}
    assert most <= 2


async def test_the_pacer_halves_on_a_throttle_and_grows_back() -> None:
    pacer = watch.Pacer(8)
    budget = CallBudget("t", 100)

    async def throttled() -> None:
        raise client_error("ThrottlingException", "slow down")

    async def fine() -> int:
        return 1

    with pytest.raises(Exception, match="slow down"):
        await pacer.call(throttled, budget)
    assert pacer.limit == 4 and budget.used == 0  # a throttled call is not counted
    for _ in range(4):
        assert await pacer.call(fine, budget) == 1
    assert pacer.limit == 5 and budget.used == 4
    for _ in range(3):
        with pytest.raises(Exception, match="slow down"):
            await pacer.call(throttled)
    assert pacer.limit == 1  # never below one


async def test_a_refusal_or_a_bad_answer_is_not_tried_again() -> None:
    tries: dict[int, int] = {}

    async def work(u: Unit) -> dict[str, Any]:
        tries[u.i] = tries.get(u.i, 0) + 1
        if u.i == 0:
            raise ModelError("The model declined this request.")
        if u.i == 1:
            raise ModelError("The model's answer did not fit the expected shape")
        if u.i == 2:
            raise ValueError("a bug")
        return {"scene": "", "events": []}

    r = await track(work)
    assert tries == {0: 1, 1: 1, 2: 1, 3: 1}
    assert r.failed == {0: "refused", 1: "bad_answer", 2: "error"}


async def test_every_unit_failing_is_skipped_not_an_error() -> None:
    async def work(u: Unit) -> dict[str, Any]:
        raise ModelError("declined")

    r = await track(work)
    assert not r.done and r.status["status"] == "skipped"


async def test_deadline_keeps_what_is_done_and_stops_the_rest() -> None:
    now = [0.0]

    async def work(u: Unit) -> dict[str, Any]:
        now[0] += 40  # each call "takes" 40 s
        return {"scene": "", "events": []}

    r = await track(work, n=5, concurrency=1, deadline=Deadline(100, clock=lambda: now[0]))
    assert sorted(r.done) == [0, 1, 2] and r.failed == {3: "deadline", 4: "deadline"}


async def test_a_call_that_never_returns_is_cut_at_the_deadline() -> None:
    async def work(u: Unit) -> dict[str, Any]:
        if u.i == 1:
            await asyncio.sleep(60)
        return {"scene": "", "events": []}

    r = await track(work, n=2, deadline=Deadline(0.05))
    assert sorted(r.done) == [0] and r.failed == {1: "deadline"}


async def test_cancel_seen_between_chunks_stops_the_rest() -> None:
    started: list[int] = []
    flag = {"cancel": False}

    async def check() -> None:
        if flag["cancel"]:
            raise JobCanceled()

    async def work(u: Unit) -> dict[str, Any]:
        started.append(u.i)
        flag["cancel"] = True
        return {"scene": "", "events": []}

    with pytest.raises(JobCanceled):
        await run_track("fable", units(6), work, concurrency=1, deadline=Deadline(60), check_cancel=check)
    assert started == [0]  # every loop checks for a cancel: the other five never started


async def test_a_task_cancel_stops_the_running_calls() -> None:
    cleaned: list[int] = []
    running = asyncio.Event()

    async def work(u: Unit) -> dict[str, Any]:
        running.set()
        try:
            await asyncio.sleep(60)
        finally:
            cleaned.append(u.i)
        return {}

    task = asyncio.create_task(
        run_track("fable", units(4), work, concurrency=2, deadline=Deadline(60), check_cancel=no_cancel)
    )
    await running.wait()
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sorted(cleaned) == [0, 1]  # the two calls in flight were stopped; nothing is left running


async def test_a_tripped_guard_stops_the_track_and_keeps_what_it_has() -> None:
    budget = CallBudget("fable", 2)

    async def work(u: Unit) -> dict[str, Any]:
        budget.spend()
        return {"scene": "", "events": []}

    r = await track(work, n=5, concurrency=1)
    assert sorted(r.done) == [0, 1] and r.stopped == "guard"
    assert r.failed == {2: "guard", 3: "guard", 4: "guard"} and budget.used == 2


# --- Fable's own calls -----------------------------------------------------------------------------------------


def fable(client: Any) -> Bedrock:
    b = Bedrock("global.anthropic.claude-fable-5-1", "eu-north-1", client=client)
    b.forced_tool_choice = False
    return b


async def chunks(client: Any, seconds: float = 300, **kw: Any) -> watch.TrackResult:
    pic = make_picture(seconds)
    return await watch.watch_chunks(
        watch.plan(seconds),
        bedrock=fable(client),
        skills=block(),
        frames=kw.pop("frames", FakeFrames(pic)),
        words=kw.pop("words", [[150.0, 150.4, "no"], [150.5, 150.9, "way"]]),
        speakers=kw.pop("speakers", [[150.0, 151.0, "S1"]]),
        loud=[-40.0] * int(seconds),
        motion=pic.motion,
        budget=kw.pop("budget", guard.fable_budget(len(watch.plan(seconds)))),
        deadline=Deadline(60),
        check_cancel=no_cancel,
        **kw,
    )


async def test_a_chunk_request_has_stamped_frames_then_the_words() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "driving", "events": [event(160, 170)]}})
    r = await chunks(client)
    assert r.status == {"status": "ok"} and len(client.requests) == 2
    second = next(q for q in client.requests if "[0:02:24] 144 s" in str(q["messages"][0]["content"][0]))
    content = second["messages"][0]["content"]
    images = [i for i, c in enumerate(content) if "image" in c]
    assert len(images) == 78 and all(
        "text" in content[i - 1] and content[i - 1]["text"].startswith("[") for i in images
    )
    text = content[images[-1] + 1]["text"]
    assert "[0:02:30] S1: no way" in text and "Loud seconds: none" in text and "between 144 and 300 seconds" in text
    assert second["inferenceConfig"] == {"maxTokens": 8000}
    assert second["system"][0]["text"].startswith("<owner_skills")
    assert r.done[1]["events"][0]["t0"] == 160 and r.done[1]["events"][0]["kind"] == "crash"


def images(kw: dict[str, Any]) -> int:
    return sum(1 for c in kw["messages"][0]["content"] if "image" in c)


async def test_too_many_images_splits_the_chunk_until_the_model_takes_it() -> None:
    seen: list[int] = []

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        n = images(kw)
        seen.append(n)
        if n > 20:
            raise client_error("ValidationException", "too many images in the request")
        return {"scene": "piece", "events": [event(10, 12)]}

    client = ToolClient({"report_scenes": answer})
    r = await chunks(client, seconds=150)
    # 75 refused: limit 37, three pieces of 25; each refused: limit 12, three pieces each. No limit is named, so
    # it halves, and splitting goes on as deep as it must (not only once). The pieces run concurrently, so a refused
    # 25 can split before its siblings are sent: only the first request's place is fixed.
    assert seen[0] == 75 and sorted(seen[1:]) == [8, 8, 8, 8, 8, 8, 9, 9, 9, 25, 25, 25]
    assert r.status == {"status": "ok"} and len(r.done[0]["events"]) == 9


async def test_the_number_the_model_names_is_learned_and_later_chunks_start_there() -> None:
    seen: list[int] = []

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        n = images(kw)
        seen.append(n)
        if n > 20:
            raise client_error("ValidationException", "You can include up to 20 images.")
        return {"scene": "", "events": []}

    client = ToolClient({"report_scenes": answer})
    pic = make_picture(1500)
    b = fable(client)
    r = await watch.watch_chunks(
        watch.plan(1500),
        bedrock=b,
        skills=block(),
        frames=FakeFrames(pic),
        words=[],
        speakers=None,
        loud=[-40.0] * 1500,
        motion=pic.motion,
        budget=guard.fable_budget(10),
        deadline=Deadline(60),
        check_cancel=no_cancel,
    )
    assert b.image_limit == 20 and r.status == {"status": "ok"}
    assert max(n for n in seen if n <= 20) == 20
    # At most one refused call per chunk in flight when the limit was learned; never a refusal after that.
    refused = [n for n in seen if n > 20]
    assert len(refused) <= watch.WATCH_CONCURRENCY
    assert sum(1 for q in client.requests if images(q) <= 20) == 10 * 4  # 75-78 frames: 4 requests a chunk


async def test_every_chunk_refused_once_for_size_still_all_get_watched() -> None:
    """The case the review simulated: a limit of 60 images. Before, the call budget (2 x chunks + 8) tripped at about
    70%; now the budget grows with the learned size and every chunk is watched."""

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        if images(kw) > 60:
            raise client_error("ValidationException", "Request has too many images")
        return {"scene": "", "events": []}

    r = await chunks(ToolClient({"report_scenes": answer}), seconds=4 * 3600)
    assert len(r.done) == 96 and not r.failed and r.stopped is None


async def test_the_other_piece_is_tried_when_one_fails() -> None:
    seen: list[str] = []

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        n = images(kw)
        first = str(kw["messages"][0]["content"][0]["text"])
        seen.append(f"{n}@{first}")
        if n > 40:
            raise client_error("ValidationException", "too many images")
        if first.startswith("[0:00:00]"):
            raise client_error("ValidationException", "content blocked")  # refused for good, not for its size
        return {"scene": "second half", "events": [event(100, 104)]}

    r = await chunks(ToolClient({"report_scenes": answer}), seconds=150)
    assert len(seen) == 4  # the whole, then all three pieces although the first was refused
    assert r.status == {"status": "ok"} and r.done[0]["scene"] == "second half"
    assert len(r.done[0]["events"]) == 2


async def test_a_single_frame_refused_for_size_is_a_failed_chunk_not_a_loop() -> None:
    calls: list[int] = []

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        calls.append(images(kw))
        raise client_error("ValidationException", "image exceeds the size limit")

    r = await chunks(ToolClient({"report_scenes": answer}), seconds=150)
    assert r.failed == {0: "error"} and calls[0] == 75
    assert len(calls) < 2 * 75  # a binary split ends: every request is smaller than the one it came from


def test_split_and_thin() -> None:
    assert [len(g) for g in watch.split_frames(list(range(108)), 20)] == [18, 18, 18, 18, 18, 18]
    assert [len(g) for g in watch.split_frames(list(range(75)), 38)] == [38, 37]
    assert watch.split_frames([1, 2], 5) == [[1, 2]]
    assert watch.thin_frames(list(range(10)), 4) == [0, 3, 6, 9]
    assert watch.thin_frames(list(range(10)), 1) == [5]
    assert watch.thin_frames([1, 2], 5) == [1, 2]


def test_learning_the_image_limit() -> None:
    b = fable(ToolClient())
    assert watch.learn_image_limit(b, client_error("ValidationException", "up to 20 images"), 78) == 20
    assert watch.learn_image_limit(b, client_error("ValidationException", "too large"), 20) == 10  # only lowered
    assert watch.learn_image_limit(b, client_error("ValidationException", "108 images is too many"), 50) == 10
    assert b.image_limit == 10


async def test_no_frames_fails_only_that_chunk() -> None:
    frames = FakeFrames(make_picture(100))  # the picture is shorter than the sound
    client = ToolClient({"report_scenes": lambda kw: {"scene": "", "events": []}})
    r = await chunks(client, seconds=300, frames=frames)
    assert sorted(r.done) == [0] and r.failed == {1: "error"}


async def test_the_budget_bounds_the_calls() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "", "events": []}})
    r = await chunks(client, seconds=1500, budget=CallBudget("fable", 3))
    assert len(client.requests) == 3 and len(r.done) == 3 and r.stopped == "guard"


# --- the model pool and the usage log --------------------------------------------------------------------------


async def test_model_calls_run_in_their_own_pool_and_log_their_tokens(capsys: pytest.CaptureFixture[str]) -> None:
    import json
    import threading

    from clipfactory_agent import bedrock as bedrock_mod

    names: list[str] = []

    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        names.append(threading.current_thread().name)
        return {"scene": "", "events": []}

    await chunks(ToolClient({"report_scenes": answer}), seconds=150)
    # Not asyncio's default pool (six threads on two CPUs): the heartbeat writes never queue behind model calls.
    assert names and all(n.startswith("cf-model") for n in names)
    assert bedrock_mod.MODEL_THREADS == 16
    lines = [json.loads(ln) for ln in capsys.readouterr().out.splitlines() if '"bedrock.usage"' in ln]
    assert lines == [
        {
            "level": "info",
            "event": "bedrock.usage",
            "time": lines[0]["time"],
            "model": "global.anthropic.claude-fable-5-1",
            "tool": "report_scenes",
            "inputTokens": 100,
            "outputTokens": 20,
            "cacheReadInputTokens": 0,
            "cacheWriteInputTokens": 0,
        }
    ]
