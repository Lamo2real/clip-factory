"""Running a job: the step list, progress and heartbeats on the Job item, cooperative cancel, retries of transient
failures, and plain-language failure messages (docs/CONTRACTS.md §8)."""

from __future__ import annotations

import asyncio
import contextlib
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .retry import is_transient, retry
from .util import JobCanceled, JobSuperseded, UserFacingError, log, now_iso

STEPS: list[tuple[str, str, float]] = [
    ("resolve", "Find the video", 0.02),
    ("download", "Download the audio", 0.12),
    ("transcribe", "Transcribe", 0.24),
    ("analyze", "Analyze", 0.04),
    ("select", "Pick the moments", 0.16),
    ("render", "Cut the clips", 0.26),
    ("checklist", "Run the checklist", 0.11),
    ("captions", "Write captions", 0.04),
    ("finalize", "Finish", 0.01),
]
LABELS = {k: label for k, label, _ in STEPS}
HEARTBEAT_SECONDS = 30.0  # the contract asks for at most 60
FLUSH_SECONDS = 5.0


class JobStore(Protocol):
    async def update_job(
        self,
        user_id: str,
        job_id: str,
        fields: dict[str, Any],
        *,
        unless_canceled: bool,
        session_id: str | None = None,
        remove: tuple[str, ...] = (),
    ) -> bool: ...


@dataclass
class StepDone:
    message: str | None = None
    skipped: bool = False


StepFn = Callable[[], Awaitable[StepDone | str | None]]


class Tracker:
    """The job's steps and progress, written to the Job item: on every step change at once, on progress at most every
    few seconds, and a heartbeat at least every 30 seconds. A write refused because the owner canceled the job
    sets the cancel flag. ``on_beat`` runs on every tick of the heartbeat loop (and once at the start): the durable
    callback's heartbeat to the job flow hangs off it (docs/CONTRACTS.md §14.4) and throttles itself.

    Every write is fenced on ``session_id``, the runtime session this run was invoked in: once a retry has given the
    job a new session, a write raises JobSuperseded, the run is marked ``superseded`` and nothing more is written."""

    def __init__(
        self,
        store: JobStore,
        user_id: str,
        job_id: str,
        *,
        session_id: str | None = None,
        heartbeat: float = HEARTBEAT_SECONDS,
        flush: float = FLUSH_SECONDS,
        on_beat: Callable[[], None] | None = None,
    ) -> None:
        self.store = store
        self.on_beat = on_beat
        self.error: str | None = None  # the plain-sentence error written with status failed
        self.user_id = user_id
        self.job_id = job_id
        self.session_id = session_id
        self.superseded = False
        self.heartbeat = heartbeat
        self.flush = flush
        self.steps: list[dict[str, Any]] = [{"key": k, "label": label, "status": "pending"} for k, label, _ in STEPS]
        self.progress = 0.0
        self.current: str | None = None
        self.canceled = asyncio.Event()
        self._fraction = 0.0
        self._dirty = False
        self._last_write = 0.0
        self._loop_task: asyncio.Task[None] | None = None
        self._owner: asyncio.Task[Any] | None = None
        self._lock = asyncio.Lock()

    def step(self, key: str) -> dict[str, Any]:
        return next(s for s in self.steps if s["key"] == key)

    def _compute(self) -> float:
        total = sum(w for _, _, w in STEPS)
        done = sum(w for k, _, w in STEPS if self.step(k)["status"] in ("done", "skipped"))
        cur = next((w for k, _, w in STEPS if k == self.current), 0.0)
        return max(self.progress, min(1.0, round((done + cur * self._fraction) / total, 4)))

    async def _write(
        self, fields: dict[str, Any], *, unless_canceled: bool = True, remove: tuple[str, ...] = ()
    ) -> bool:
        async with self._lock:
            if self.superseded:
                raise JobSuperseded()
            try:
                ok = await self.store.update_job(
                    self.user_id,
                    self.job_id,
                    {"steps": self.steps, "progress": self.progress, "heartbeatAt": now_iso(), **fields},
                    unless_canceled=unless_canceled,
                    session_id=self.session_id,
                    remove=remove,
                )
            except JobSuperseded:
                self.mark_superseded()
                raise
            self._last_write = asyncio.get_running_loop().time()
            self._dirty = False
        if not ok and unless_canceled:
            self.canceled.set()
        return ok

    async def begin(self) -> None:
        if not await self._write({"status": "running", "clipCount": 0}, remove=("error",)):
            raise JobCanceled()
        self._owner = asyncio.current_task()
        self._signal_alive()
        self._loop_task = asyncio.create_task(self._beat())

    def _signal_alive(self) -> None:
        if self.on_beat is None:
            return
        try:
            self.on_beat()
        except Exception as e:  # the callback heartbeat is never fatal
            log("warn", "job.on_beat_failed", job=self.job_id, error=type(e).__name__)

    async def _beat(self) -> None:
        while True:
            await asyncio.sleep(self.flush)
            due = asyncio.get_running_loop().time() - self._last_write >= self.heartbeat
            if self._dirty or due:
                try:
                    ok = await self._write({})
                except JobSuperseded:
                    self._abort()
                    return
                except Exception as e:  # a missed heartbeat is not fatal; the next one tries again
                    log("warn", "job.heartbeat_failed", job=self.job_id, error=type(e).__name__)
                    self._signal_alive()
                    continue
                if not ok:
                    self._abort()
                    return
            self._signal_alive()

    def mark_superseded(self) -> None:
        """A newer run owns the job: from now on this run writes nothing to it."""
        if not self.superseded:
            log("info", "job.superseded_seen", job=self.job_id, session=self.session_id, step=self.current)
        self.superseded = True
        self.canceled.set()

    def _abort(self) -> None:
        """The owner canceled the job (or a retry superseded this run) but no signal reached this container: stop the
        running step now (which kills its yt-dlp, ffmpeg or agent run) instead of waiting hours for the next step
        boundary."""
        owner = self._owner
        if owner and not owner.done():
            log("info", "job.cancel_seen", job=self.job_id, step=self.current, superseded=self.superseded)
            owner.cancel()

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None

    def report(self, fraction: float) -> None:
        """Progress within the current step (0..1); written by the heartbeat loop shortly after."""
        self._fraction = max(self._fraction, min(1.0, fraction))
        new = self._compute()
        if new > self.progress:
            self.progress = new
            self._dirty = True

    async def check_cancel(self) -> None:
        if self.superseded:
            raise JobSuperseded()
        if self.canceled.is_set():
            raise JobCanceled()

    async def start(self, key: str) -> None:
        await self.check_cancel()
        self.current, self._fraction = key, 0.0
        s = self.step(key)
        s.update(status="running", startedAt=now_iso())
        s.pop("message", None)
        s.pop("finishedAt", None)
        await self._write({})
        await self.check_cancel()

    async def done(self, key: str, message: str | None, *, skipped: bool = False) -> None:
        s = self.step(key)
        s.update(status="skipped" if skipped else "done", finishedAt=now_iso())
        if message:
            s["message"] = message[:300]
        self._fraction = 1.0
        self.progress = self._compute()
        self.current = None
        await self._write({})

    async def finish_ready(self, clip_count: int) -> None:
        self.progress = 1.0
        await self._write({"status": "ready", "clipCount": clip_count})

    async def finish_failed(self, message: str) -> None:
        if self.superseded:
            return
        if self.current:
            s = self.step(self.current)
            s.update(status="failed", message=message[:300], finishedAt=now_iso())
        self.error = message[:500]
        await self._write({"status": "failed", "error": self.error})

    async def finish_canceled(self) -> None:
        if self.superseded:
            return
        now = now_iso()
        for s in self.steps:
            if s["status"] in ("running", "pending"):
                s.update(status="skipped", finishedAt=now)
                if s["key"] == self.current:
                    s["message"] = "Canceled."
        await self._write({"status": "canceled"}, unless_canceled=False)


def failure_message(step: str | None, e: BaseException) -> str:
    if isinstance(e, UserFacingError):
        return str(e)
    what = LABELS.get(step or "", "this step").lower()
    if is_transient(e):
        return f"A service was busy while trying to {what} and did not recover. Tap Try again."
    return f"Something went wrong while trying to {what}. Tap Try again; if it happens again, try another video."


async def run_job(
    tracker: Tracker,
    steps: list[tuple[str, StepFn]],
    *,
    clip_count: Callable[[], int],
    step_attempts: int = 3,
) -> str:
    """Runs ``steps`` in order and leaves the job ready, failed or canceled. Returns that final status, or
    ``superseded`` when a retry handed the job to a newer run: then the job is left exactly as that run wrote it."""
    try:
        await tracker.begin()
        for key, fn in steps:
            await tracker.start(key)
            result = await retry(fn, what=f"step.{key}", attempts=step_attempts, base=5.0)
            done = result if isinstance(result, StepDone) else StepDone(message=result)
            await tracker.done(key, done.message, skipped=done.skipped)
            await tracker.check_cancel()
        await tracker.finish_ready(clip_count())
        return "ready"
    except (JobCanceled, asyncio.CancelledError) as e:
        await tracker.stop()
        if isinstance(e, JobSuperseded):
            tracker.mark_superseded()
        if tracker.superseded:
            log("info", "job.superseded", job=tracker.job_id, step=tracker.current)
            return "superseded"
        log("info", "job.canceled", job=tracker.job_id, step=tracker.current)
        try:
            await tracker.finish_canceled()
        except JobSuperseded:
            log("info", "job.superseded", job=tracker.job_id, step=tracker.current)
            return "superseded"
        return "canceled"
    except Exception as e:
        log(
            "error",
            "job.failed",
            job=tracker.job_id,
            step=tracker.current,
            error=type(e).__name__,
            detail=str(e)[:1500],
        )
        await tracker.stop()
        try:
            await tracker.finish_failed(failure_message(tracker.current, e))
        except JobSuperseded:
            log("info", "job.superseded", job=tracker.job_id, step=tracker.current)
            return "superseded"
        except Exception as e2:
            log("error", "job.fail_write_failed", job=tracker.job_id, error=type(e2).__name__)
        return "failed"
    finally:
        await tracker.stop()


JobFactory = Callable[[str, str, str | None, str | None], Awaitable[Any]]
"""``(job_id, user_id, session_id, callback_id)`` → the run's final status."""


class JobRunner:
    """Jobs running in this container, as background tasks; never blocks a request."""

    def __init__(self, run: JobFactory, work_root: Path | None = None) -> None:
        self._run = run
        self.work_root = work_root
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self.sessions: dict[str, str | None] = {}

    @property
    def busy(self) -> bool:
        return any(not t.done() for t in self.tasks.values())

    def submit(self, job_id: str, user_id: str, session_id: str | None = None, callback_id: str | None = None) -> bool:
        """Starts the job (as the run of ``session_id``, reporting to the job flow's ``callback_id``) unless it is
        already running here. True when started; a duplicate ``process_job`` (the flow's start step is at-least-once)
        is ignored."""
        running = self.tasks.get(job_id)
        if running and not running.done():
            if self.sessions.get(job_id) != session_id:
                log("warn", "job.other_run_here", job=job_id, running=self.sessions.get(job_id), asked=session_id)
            else:
                log("info", "job.duplicate_ignored", job=job_id, session=session_id)
            return False

        async def go() -> None:
            try:
                await self._run(job_id, user_id, session_id, callback_id)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log("error", "job.crashed", job=job_id, error=type(e).__name__, detail=str(e)[:1500])
            finally:
                if self.work_root:
                    shutil.rmtree(self.work_root / job_id, ignore_errors=True)

        task = asyncio.create_task(go(), name=f"job-{job_id}")
        self.tasks[job_id] = task
        self.sessions[job_id] = session_id

        def forget(t: asyncio.Task[Any]) -> None:
            if self.tasks.get(job_id) is t:
                self.tasks.pop(job_id, None)
                self.sessions.pop(job_id, None)

        task.add_done_callback(forget)
        return True

    def cancel(self, job_id: str, session_id: str | None = None) -> bool:
        """Cancels the job's run here; a cancel addressed to another run (another session) is ignored."""
        task = self.tasks.get(job_id)
        if not task or task.done():
            return False
        running = self.sessions.get(job_id)
        if session_id and running and running != session_id:
            return False
        task.cancel()  # kills any running ffmpeg/yt-dlp; run_job then marks the job canceled
        return True
