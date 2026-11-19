from __future__ import annotations

import asyncio
from typing import Any

from clipfactory_agent.jobs import STEPS, StepDone, Tracker, failure_message, run_job
from clipfactory_agent.util import JobSuperseded, TransientError, UserFacingError


class FakeStore:
    """The Job item as the real Store fences it: a write of another session raises JobSuperseded."""

    def __init__(self, session: str | None = None) -> None:
        self.writes: list[dict[str, Any]] = []
        self.status = "queued"
        self.removed: list[str] = []
        self.session = session

    async def update_job(
        self,
        user_id: str,
        job_id: str,
        fields: dict[str, Any],
        *,
        unless_canceled: bool,
        session_id: str | None = None,
        remove: tuple[str, ...] = (),
    ) -> bool:
        if session_id is not None and session_id != self.session:
            raise JobSuperseded()
        if unless_canceled and self.status == "canceled":
            return False
        self.writes.append({k: (list(map(dict, v)) if k == "steps" else v) for k, v in fields.items()})
        self.removed += remove
        self.status = fields.get("status", self.status)
        return True

    @property
    def last(self) -> dict[str, Any]:
        return self.writes[-1]


def ok_steps(seen: list[str] | None = None, **overrides: Any) -> list[tuple[str, Any]]:
    out = []
    for key, _, _ in STEPS:

        async def fn(key: str = key) -> StepDone | str | None:
            if seen is not None:
                seen.append(key)
            if key in overrides:
                return await overrides[key]()
            return f"{key} done"

        out.append((key, fn))
    return out


def tracker(store: FakeStore) -> Tracker:
    return Tracker(store, "U", "J", session_id=store.session, heartbeat=0.05, flush=0.01)


async def test_run_job_marks_every_step_and_ends_ready() -> None:
    store = FakeStore()
    seen: list[str] = []
    status = await run_job(tracker(store), ok_steps(seen), clip_count=lambda: 7)
    assert status == "ready"
    assert seen == [k for k, _, _ in STEPS]
    assert store.writes[0]["status"] == "running" and store.removed == ["error", "note", "pickUp"]
    assert store.last["status"] == "ready" and store.last["clipCount"] == 7 and store.last["progress"] == 1.0
    assert all(s["status"] == "done" and s["message"] == f"{s['key']} done" for s in store.last["steps"])
    assert all("heartbeatAt" in w for w in store.writes)
    progress = [w["progress"] for w in store.writes]
    assert progress == sorted(progress)


async def test_progress_inside_a_step_is_flushed() -> None:
    store = FakeStore()
    t = tracker(store)

    async def slow() -> str:
        t.report(0.5)
        await asyncio.sleep(0.05)
        return "ok"

    await run_job(t, ok_steps(transcribe=slow), clip_count=lambda: 1)
    mid = [w for w in store.writes if next(s for s in w["steps"] if s["key"] == "transcribe")["status"] == "running"]
    assert any(0.14 < w["progress"] < 0.27 for w in mid)


async def test_user_facing_failure_is_shown_as_is() -> None:
    store = FakeStore()

    async def boom() -> str:
        raise UserFacingError("This video is private or members-only, so it can't be downloaded.")

    status = await run_job(tracker(store), ok_steps(download=boom), clip_count=lambda: 0)
    assert status == "failed"
    assert store.last["status"] == "failed"
    assert store.last["error"].startswith("This video is private")
    steps = {s["key"]: s for s in store.last["steps"]}
    assert steps["resolve"]["status"] == "done"
    assert steps["download"]["status"] == "failed" and steps["download"]["message"].startswith("This video")
    assert steps["transcribe"]["status"] == "pending"


async def test_unexpected_failure_gets_a_plain_message() -> None:
    store = FakeStore()

    async def boom() -> str:
        raise KeyError("internal detail")

    await run_job(tracker(store), ok_steps(render=boom), clip_count=lambda: 0)
    assert store.last["error"] == failure_message("render", KeyError())
    assert "internal detail" not in store.last["error"]


async def test_transient_errors_are_retried() -> None:
    store = FakeStore()
    calls = {"n": 0}

    async def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 2:
            raise TransientError("busy")
        return "fine"

    import clipfactory_agent.retry as retry_mod

    real_sleep = retry_mod.asyncio.sleep
    retry_mod.asyncio.sleep = lambda _s: real_sleep(0)  # type: ignore[assignment]
    try:
        status = await run_job(tracker(store), ok_steps(analyze=flaky), clip_count=lambda: 1)
    finally:
        retry_mod.asyncio.sleep = real_sleep  # type: ignore[assignment]
    assert status == "ready" and calls["n"] == 2


async def test_cancel_seen_through_a_refused_write() -> None:
    store = FakeStore()

    async def owner_cancels() -> str:
        store.status = "canceled"  # the API marked the job canceled
        return "done"

    status = await run_job(tracker(store), ok_steps(transcribe=owner_cancels), clip_count=lambda: 0)
    assert status == "canceled"
    steps = {s["key"]: s["status"] for s in store.last["steps"]}
    assert store.last["status"] == "canceled"
    assert steps["analyze"] == "skipped" and steps["finalize"] == "skipped"


async def test_task_cancel_marks_job_canceled() -> None:
    store = FakeStore()
    started = asyncio.Event()

    async def forever() -> str:
        started.set()
        await asyncio.sleep(60)
        return "never"

    task = asyncio.create_task(run_job(tracker(store), ok_steps(select=forever), clip_count=lambda: 0))
    await started.wait()
    task.cancel()
    assert await task == "canceled"
    steps = {s["key"]: s for s in store.last["steps"]}
    assert store.last["status"] == "canceled"
    assert steps["select"]["status"] == "skipped" and steps["select"]["message"] == "Canceled."


async def test_heartbeat_keeps_writing() -> None:
    store = FakeStore()

    async def wait() -> str:
        await asyncio.sleep(0.2)
        return "ok"

    await run_job(tracker(store), ok_steps(select=wait), clip_count=lambda: 1)
    running = [w for w in store.writes if next(s for s in w["steps"] if s["key"] == "select")["status"] == "running"]
    assert len(running) >= 3  # the start write plus heartbeats


async def test_skipped_step() -> None:
    store = FakeStore()

    async def skip() -> StepDone:
        return StepDone("Nothing to do.", skipped=True)

    await run_job(tracker(store), ok_steps(analyze=skip), clip_count=lambda: 1)
    steps = {s["key"]: s for s in store.last["steps"]}
    assert steps["analyze"]["status"] == "skipped"


# --- one run per job: every write is fenced on the run's sessionId ------------------------------------------------


def retried(store: FakeStore, status: str = "queued") -> None:
    """What the API's Retry does to the Job item while the old run is still going."""
    store.session = "S2"
    store.status = status
    store.writes.append({"status": status, "by": "retry"})


async def test_superseded_run_stops_at_its_next_write_and_writes_nothing() -> None:
    store = FakeStore("S1")
    seen: list[str] = []

    async def retry_meanwhile() -> str:
        retried(store)
        return "done"

    status = await run_job(tracker(store), ok_steps(seen, transcribe=retry_meanwhile), clip_count=lambda: 0)
    assert status == "superseded"
    assert store.last == {"status": "queued", "by": "retry"}  # the newer run's state is left as it is
    assert seen == ["resolve", "download", "transcribe"]


async def test_superseded_seen_by_the_heartbeat_stops_the_running_step() -> None:
    store = FakeStore("S1")
    stopped = asyncio.Event()

    async def long_step() -> str:
        retried(store, "running")
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            stopped.set()
            raise
        return "never"

    status = await asyncio.wait_for(
        run_job(tracker(store), ok_steps(select=long_step), clip_count=lambda: 0), timeout=5
    )
    assert status == "superseded" and stopped.is_set()
    assert store.last == {"status": "running", "by": "retry"}


async def test_cancel_signal_after_a_retry_does_not_write_canceled() -> None:
    store = FakeStore("S1")
    started = asyncio.Event()

    async def forever() -> str:
        started.set()
        await asyncio.sleep(60)
        return "never"

    task = asyncio.create_task(run_job(tracker(store), ok_steps(select=forever), clip_count=lambda: 0))
    await started.wait()
    retried(store)
    task.cancel()
    assert await task == "superseded"
    assert store.last == {"status": "queued", "by": "retry"}


async def test_failure_after_a_retry_does_not_write_failed() -> None:
    store = FakeStore("S1")

    async def boom() -> str:
        retried(store)
        raise UserFacingError("This video is private.")

    status = await run_job(tracker(store), ok_steps(download=boom), clip_count=lambda: 0)
    assert status == "superseded"
    assert store.last == {"status": "queued", "by": "retry"}


async def test_superseded_raised_inside_a_step_is_not_a_failure() -> None:
    store = FakeStore("S1")

    async def step_write() -> str:
        retried(store)
        await store.update_job("U", "J", {"source": {}}, unless_canceled=True, session_id="S1")
        return "never"

    status = await run_job(tracker(store), ok_steps(resolve=step_write), clip_count=lambda: 0)
    assert status == "superseded"
    assert store.last == {"status": "queued", "by": "retry"}
    assert all(w.get("status") != "failed" for w in store.writes)


async def test_superseded_before_begin_writes_nothing() -> None:
    store = FakeStore("S2")  # Retry happened before the old run even started
    t = Tracker(store, "U", "J", session_id="S1", heartbeat=0.05, flush=0.01)
    assert await run_job(t, ok_steps(), clip_count=lambda: 0) == "superseded"
    assert store.writes == []


async def test_own_session_cancel_still_marks_canceled() -> None:
    store = FakeStore("S1")

    async def owner_cancels() -> str:
        store.status = "canceled"
        return "done"

    status = await run_job(tracker(store), ok_steps(analyze=owner_cancels), clip_count=lambda: 0)
    assert status == "canceled" and store.last["status"] == "canceled"


# --- the ten steps: one list in the agent, the API and the web mock (ADR-40) --------------------------------------


def test_step_weights_sum_to_one() -> None:
    assert len(STEPS) == 10 and [k for k, _, _ in STEPS][4] == "watch"
    assert abs(sum(w for _, _, w in STEPS) - 1.0) < 1e-9
    assert all(w > 0 for _, _, w in STEPS)


def test_step_keys_and_labels_match_the_api_and_the_web_mock() -> None:
    import ast
    import re
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    ours = [(k, label) for k, label, _ in STEPS]
    assert ours == [
        ("resolve", "Find the video"),
        ("download", "Get the video"),
        ("transcribe", "Write down the words"),
        ("analyze", "Listen for big moments"),
        ("watch", "Watch the video"),
        ("select", "Pick the best moments"),
        ("render", "Cut the clips"),
        ("checklist", "Check each clip"),
        ("captions", "Write the captions"),
        ("finalize", "Finish up"),
    ]
    tree = ast.parse((repo / "api" / "src" / "clipfactory_api" / "jobs.py").read_text("utf-8"))
    api = next(
        ast.literal_eval(n.value)
        for n in tree.body
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id == "STEPS" and n.value
    )
    assert [tuple(s) for s in api] == ours
    fixtures = (repo / "web" / "src" / "api" / "mock" / "fixtures.ts").read_text("utf-8")
    body = re.search(r"STEP_LABELS: Record<StepKey, string> = \{(.*?)\};", fixtures, re.S)
    assert body
    assert re.findall(r"(\w+): \"([^\"]+)\"", body.group(1)) == ours
    types = (repo / "web" / "src" / "api" / "types.ts").read_text("utf-8")
    union = re.search(r"export type StepKey =(.*?);", types, re.S)
    assert union and re.findall(r"\"(\w+)\"", union.group(1)) == [k for k, _ in ours]


def test_labels_are_short_and_plain() -> None:
    for _, label, _ in STEPS:
        assert len(label.split()) <= 4 and len(label) <= 24, label
        assert not any(w in label.lower() for w in ("transcribe", "analyze", "audio", "render", "checklist")), label
    assert failure_message("watch", RuntimeError("x")).startswith(
        "Something went wrong while trying to watch the video."
    )
