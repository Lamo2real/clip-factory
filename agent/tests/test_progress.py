"""The progress bar matches the steps: below 100% until the job is ready, never backwards, and a step reloaded from a
run that stopped is never counted twice (owner report 2026-11-20: 100% while "Check each clip" was still running)."""

from __future__ import annotations

from typing import Any

from clipfactory_agent.jobs import STEPS, WORKING_CAP, StepDone, Tracker, run_job

from .test_jobs import FakeStore

KEYS = [k for k, _, _ in STEPS]


def saved_steps(done_upto: str, stopped: str = "failed") -> list[dict[str, Any]]:
    """A step list as a stopped run left it: every step before ``done_upto`` (inclusive) done, the next one ``stopped``."""
    out = [{"key": k, "label": label, "status": "pending"} for k, label, _ in STEPS]
    cut = KEYS.index(done_upto)
    for s in out[: cut + 1]:
        s.update(status="done", message=f"{s['key']} first time")
    if cut + 1 < len(out):
        out[cut + 1]["status"] = stopped
    return out


def ticking(tr: Tracker, writes: list[tuple[str | None, float]]) -> Any:
    """A step that reports its own progress in ten ticks, as the real steps do (reloaded ones too)."""

    async def fn() -> StepDone:
        for i in range(1, 11):
            tr.report(i / 10)
            writes.append((tr.current, tr.progress))
        return StepDone("ok")

    return fn


def check(
    store: FakeStore, seen: list[tuple[str | None, float]], start: float = 0.0, reloaded: frozenset[str] = frozenset()
) -> None:
    written = [w["progress"] for w in store.writes]
    assert written == sorted(written), "the bar went backwards"
    assert written[0] >= start
    assert written[-1] == 1.0 and store.last["status"] == "ready"
    for w in store.writes[:-1]:
        left = [s["key"] for s in w["steps"] if s["status"] not in ("done", "skipped")]
        if left:
            assert w["progress"] <= WORKING_CAP, f"100% with {left} left"
    # While a step runs, the bar never passes the share of every step up to and including it (a reloaded step only
    # holds the place the stopped run had reached).
    total = sum(wt for _, _, wt in STEPS)
    for key, p in seen:
        assert key is not None
        if key in reloaded:
            assert p <= max(start, store.writes[0]["progress"])
            continue
        upto = sum(wt for k, _, wt in STEPS[: KEYS.index(key) + 1]) / total
        assert p <= min(WORKING_CAP, upto) + 1e-9, f"{p} while {key} ran"


async def test_a_fresh_run_stays_below_100_until_ready() -> None:
    store = FakeStore()
    tr = Tracker(store, "U", "J", heartbeat=5, flush=5)
    seen: list[tuple[str | None, float]] = []
    status = await run_job(tr, [(k, ticking(tr, seen)) for k in KEYS], clip_count=lambda: 3)
    assert status == "ready"
    check(store, seen)
    # Finish up done but the job not yet marked ready: still not 100%.
    before_ready = store.writes[-2]
    assert all(s["status"] == "done" for s in before_ready["steps"]) and before_ready["progress"] == WORKING_CAP


async def resumed(job: dict[str, Any]) -> tuple[FakeStore, Tracker, list[tuple[str | None, float]]]:
    store = FakeStore()
    tr = Tracker(store, "U", "J", heartbeat=5, flush=5, resume=job)
    seen: list[tuple[str | None, float]] = []
    status = await run_job(tr, [(k, ticking(tr, seen)) for k in KEYS], clip_count=lambda: 10)
    assert status == "ready"
    return store, tr, seen


async def test_reloaded_steps_are_not_counted_twice() -> None:
    """The owner's job: everything up to Cut the clips done, Check each clip stopped. Reloading the cut clips ticks
    the bar; those ticks used to add Cut the clips' share a second time and fill the bar to 100%."""
    job = {"pickUp": True, "steps": saved_steps("render"), "progress": 0.87}
    store, tr, seen = await resumed(job)
    check(store, seen, start=0.87, reloaded=frozenset(tr.restored))
    while_checking = [
        w["progress"]
        for w in store.writes
        if next(s for s in w["steps"] if s["key"] == "checklist")["status"] != "done"
    ]
    assert max(while_checking) < 0.96


async def test_auto_pick_up_after_a_dead_worker_never_goes_back() -> None:
    """The job flow's resume (§30.1): the step that was running goes back to pending, the bar keeps its place."""
    job = {"pickUp": True, "steps": saved_steps("watch", stopped="running"), "progress": 0.6}
    store, tr, seen = await resumed(job)
    check(store, seen, start=0.6, reloaded=frozenset(tr.restored))
    assert store.writes[0]["progress"] == 0.6


async def test_try_again_after_a_stopped_run_keeps_its_place() -> None:
    """Try again on a run that stopped partway (``pickUp``, §30.6): same as a pick-up, from what the API kept."""
    job = {"pickUp": True, "steps": saved_steps("select"), "progress": 0.65}
    store, tr, seen = await resumed(job)
    check(store, seen, start=0.65, reloaded=frozenset(tr.restored))


async def test_a_carried_100_percent_is_brought_back_to_the_steps() -> None:
    """A job that already shows 100% with steps left (written before this fix) drops to what its steps allow."""
    job = {"pickUp": True, "steps": saved_steps("render"), "progress": 1.0}
    store, tr, seen = await resumed(job)
    assert store.writes[0]["progress"] < 1.0
    check(store, seen, start=store.writes[0]["progress"], reloaded=frozenset(tr.restored))


async def test_try_again_from_scratch_starts_at_zero() -> None:
    job = {"steps": saved_steps("render"), "progress": 1.0}  # no pickUp: a fresh run
    store, _, seen = await resumed(job)
    assert store.writes[0]["progress"] == 0.0
    check(store, seen)
