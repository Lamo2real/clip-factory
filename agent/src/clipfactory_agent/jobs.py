"""Running a job: the step list, progress and heartbeats on the Job item, cooperative cancel, retries of transient
failures, and plain-language failure messages (docs/CONTRACTS.md §8)."""

from __future__ import annotations

import asyncio
import contextlib
import functools
import math
import shutil
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from . import livestatus
from .bedrock import MODEL_ACCESS_MESSAGE, model_unavailable
from .retry import is_transient, retry
from .util import JobCanceled, JobSuperseded, NeedsMac, UserFacingError, log, now_iso

# The ten steps, their owner-facing labels (kid-proof words) and their share of the progress bar. The keys and labels
# are the same list in api/src/clipfactory_api/jobs.py and web/src/api/mock/fixtures.ts (tests/test_jobs.py checks).
STEPS: list[tuple[str, str, float]] = [
    ("resolve", "Find the video", 0.02),
    ("download", "Get the video", 0.10),
    ("transcribe", "Write down the words", 0.18),
    ("analyze", "Listen for big moments", 0.03),
    ("watch", "Watch the video", 0.18),
    ("select", "Pick the best moments", 0.14),
    ("render", "Cut the clips", 0.21),
    ("checklist", "Check each clip", 0.09),
    ("captions", "Write the captions", 0.04),
    ("finalize", "Finish up", 0.01),
]
LABELS = {k: label for k, label, _ in STEPS}
HEARTBEAT_SECONDS = 30.0  # the contract asks for at most 60
FLUSH_SECONDS = 5.0
# Set when the container is shutting down (SIGTERM from AgentCore: a stopped session or a retired version). A run
# cancelled then is not "canceled by the owner": it ends ``stopped``, writes nothing, and tells the job flow, which
# resumes the job on a new session (docs/CONTRACTS.md §30).
SHUTDOWN = threading.Event()
RESUME_NOTE_FIELDS = ("note", "pickUp")  # what a run that ends (ready or failed) clears
# The most the bar shows while any step is left: 100% only once the job is ready (``finish_ready``).
WORKING_CAP = 0.99
# The step watchdog: a step that shows no sign of life (no progress, no new note) for this long is ended with a plain
# message instead of hanging while the heartbeat keeps the job "running" (owner report 2026-11-20). Every limit is
# far above the longest quiet stretch a healthy step has: each step reports at least per clip, per chunk or per
# download tick, and every call inside has its own time limit (ffmpeg 30 min, one model try 12 min, a review 24 min,
# a clip check 35 min, a clip's cut 100 min, the whole-video download 90 min). The Cut steps wait out that download without a sign, so
# their limit is above it. Seconds.
STALL_SECONDS: dict[str, float] = {
    "resolve": 60 * 60,
    "download": 90 * 60,
    "transcribe": 120 * 60,
    "analyze": 60 * 60,
    "watch": 120 * 60,
    "select": 90 * 60,
    "render": 100 * 60,
    "checklist": 100 * 60,
    "captions": 30 * 60,
    "finalize": 30 * 60,
}
WATCH_TICK = 30.0


class StepStalled(UserFacingError):
    """The step watchdog ended a step that showed no sign of life for too long."""


def stalled_message(key: str) -> str:
    return f"{LABELS.get(key, 'This step')} stopped moving. Tap Try again to pick up where it left off."


def _steps_ceiling(steps: list[dict[str, Any]]) -> float:
    """The most progress the step list allows: the finished steps' share plus the whole share of the first step not
    finished yet (the one that was running), never above ``WORKING_CAP``. A carried-over progress above this is not
    real (an older run counted a reloaded step twice) and is brought back down to it."""
    total = sum(w for _, _, w in STEPS)
    status = {s.get("key"): s.get("status") for s in steps}
    done = sum(w for k, _, w in STEPS if status.get(k) in ("done", "skipped"))
    nxt = next((w for k, _, w in STEPS if status.get(k) not in ("done", "skipped")), 0.0)
    return min(WORKING_CAP, round((done + nxt) / total, 4))


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
        resume: dict[str, Any] | None = None,
        stall_seconds: dict[str, float] | None = None,
        watch_tick: float = WATCH_TICK,
        live: livestatus.LiveStatus | None = None,
    ) -> None:
        self.store = store
        self.stall_seconds = {**STALL_SECONDS, **(stall_seconds or {})}
        self.watch_tick = watch_tick
        self.last_sign = 0.0  # loop time of the running step's last sign of life (start, progress, a note)
        self._step_began = 0.0
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
        # Picking up a job that stopped partway (§30): the steps it already finished stay done (the pipeline still
        # runs them, quietly, to load what they saved) and the progress bar does not go back.
        self.restored: set[str] = set()
        self.resuming = bool(resume and resume.get("pickUp"))
        if resume and self.resuming:
            saved = {s.get("key"): s for s in resume.get("steps") or [] if isinstance(s, dict)}
            for s in self.steps:
                old = saved.get(s["key"])
                if old and old.get("status") in ("done", "skipped"):
                    s.update({k: v for k, v in old.items() if k in ("status", "message", "startedAt", "finishedAt")})
                    self.restored.add(s["key"])
            try:
                carried = float(resume.get("progress") or 0)
            except (TypeError, ValueError):
                carried = 0.0
            # Keeps what the stopped run had (the bar never goes back), but never more than its steps allow.
            self.progress = max(0.0, min(carried, _steps_ceiling(self.steps)))
        self.current: str | None = None
        self.canceled = asyncio.Event()
        self._fraction = 0.0
        self._dirty = False
        self._last_write = 0.0
        self._loop_task: asyncio.Task[None] | None = None
        self._owner: asyncio.Task[Any] | None = None
        self._lock = asyncio.Lock()
        # The live status line (§31): its own small item, written about once a second while the words change. A
        # store without ``put_live`` (the tests' fakes) has none.
        put_live = getattr(store, "put_live", None)
        if live is None and callable(put_live):
            live = livestatus.LiveStatus(functools.partial(put_live, user_id), job_id, session_id)
        self.live = live
        # What the job's AI has cost so far (usage.Meter.summary): written to the Job item as ``aiCost`` with every
        # write once there is something to show, so a failed or stopped job still shows what it spent.
        self.cost: Callable[[], dict[str, Any] | None] | None = None
        if live is not None:
            live.on_emit = self._touch
        self._live_token: Any = None

    def _touch(self) -> None:
        """A live line update is a sign of life for the step watchdog, when it comes from the event loop (a call
        from a worker thread has no loop time to give and is skipped)."""
        try:
            self.last_sign = asyncio.get_running_loop().time()
        except RuntimeError:
            return

    def step(self, key: str) -> dict[str, Any]:
        return next(s for s in self.steps if s["key"] == key)

    def _compute(self) -> float:
        """Finished steps' shares plus the running step's share times how far it is. A step already in the finished
        shares (just marked done, or reloaded from the run that stopped) adds nothing more: counting it twice pushed
        the bar to 100% with steps left (owner report 2026-11-20). Below 100% until the job is ready; never lower
        than before."""
        total = sum(w for _, _, w in STEPS)
        done = sum(w for k, _, w in STEPS if self.step(k)["status"] in ("done", "skipped"))
        counted = self.current is None or self.step(self.current)["status"] in ("done", "skipped")
        cur = 0.0 if counted else next((w for k, _, w in STEPS if k == self.current), 0.0)
        return max(self.progress, min(WORKING_CAP, round((done + cur * self._fraction) / total, 4)))

    async def _write(
        self, fields: dict[str, Any], *, unless_canceled: bool = True, remove: tuple[str, ...] = ()
    ) -> bool:
        async with self._lock:
            if self.superseded:
                raise JobSuperseded()
            try:
                cost = self.cost() if self.cost else None
                ok = await self.store.update_job(
                    self.user_id,
                    self.job_id,
                    {
                        "steps": self.steps,
                        "progress": self.progress,
                        "heartbeatAt": now_iso(),
                        **({"aiCost": cost} if cost else {}),
                        **fields,
                    },
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
        # A resumed run keeps the clip count and the steps already done; it never resets them.
        fields: dict[str, Any] = {"status": "running"} if self.resuming else {"status": "running", "clipCount": 0}
        if not await self._write(fields, remove=("error",)):
            raise JobCanceled()
        self._owner = asyncio.current_task()
        self._signal_alive()
        self._loop_task = asyncio.create_task(self._beat())
        if self.live is not None:
            self._live_token = self.live.start()
            if self.resuming:
                self.live.emit("resume", done=len(self.restored))

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
            self._signal_alive()  # the loop is alive, whatever the write below does
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
        if self.live is not None:
            self.live.closed = True
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
        if self.live is not None:
            await self.live.stop()

    def _now(self) -> float:
        try:
            return asyncio.get_running_loop().time()
        except RuntimeError:
            return 0.0

    def report(self, fraction: float, *, alive: bool = True) -> None:
        """Progress within the current step (0..1); written by the heartbeat loop shortly after. ``alive`` False is
        the bar creeping on its own while one long call runs (``creep``): it moves the bar but is no sign of life
        for the step watchdog."""
        if alive:
            self.last_sign = self._now()
        self._fraction = max(self._fraction, min(1.0, fraction))
        new = self._compute()
        if new > self.progress:
            self.progress = new
            self._dirty = True

    def say(self, note: str) -> None:
        """What the running step is doing now, in plain words ("Checked 4 of 10 clips."), shown under the step on the
        job page while it runs; the step's final message replaces it. A sign of life for the watchdog. A step
        reloaded from a run that stopped keeps its old message."""
        key = self.current
        if key is None or key in self.restored:
            return
        self.last_sign = self._now()
        s = self.step(key)
        note = note[:300]
        if s.get("message") != note:
            s["message"] = note
            self._dirty = True
            log("info", "job.step_note", job=self.job_id, step=key, note=note)
        if self.live is not None:
            self.live.emit("note", text=note)

    async def check_cancel(self) -> None:
        if self.superseded:
            raise JobSuperseded()
        if self.canceled.is_set():
            raise JobCanceled()

    async def start(self, key: str) -> None:
        await self.check_cancel()
        self.current, self._fraction = key, 0.0
        self.last_sign = self._step_began = self._now()
        log("info", "job.step_start", job=self.job_id, step=key, reloaded=key in self.restored)
        if key in self.restored:
            return  # done in the run that stopped: the step reloads what it saved, the owner sees it stay done
        s = self.step(key)
        s.update(status="running", startedAt=now_iso())
        s.pop("message", None)
        s.pop("finishedAt", None)
        if self.live is not None:
            self.live.emit("step", key=key)
        await self._write({})
        if self.live is not None:
            await self.live.flush(force=True)  # a new step shows at once
        await self.check_cancel()

    async def done(self, key: str, message: str | None, *, skipped: bool = False) -> None:
        log(
            "info",
            "job.step_done",
            job=self.job_id,
            step=key,
            skipped=skipped,
            seconds=round(self._now() - self._step_began, 1),
            detail=(message or "")[:300],
        )
        if key in self.restored:
            self._fraction = 1.0
            self.current = None
            return
        s = self.step(key)
        s.update(status="skipped" if skipped else "done", finishedAt=now_iso())
        s.pop("message", None)  # a live note ("Checked 4 of 10 clips.") never outlives the step
        if message:
            s["message"] = message[:300]
        self._fraction = 1.0
        self.progress = self._compute()
        self.current = None
        await self._write({})

    async def finish_ready(self, clip_count: int) -> None:
        self.progress = 1.0
        await self._write({"status": "ready", "clipCount": clip_count}, remove=RESUME_NOTE_FIELDS)

    async def finish_failed(self, message: str, *, pick_up: bool = False) -> None:
        """``pick_up``: the step was ended by the watchdog, not by a fault of the video, so Try again picks up where it
        stopped with the moments and clips already saved (``pickUp`` stays on the job, docs/CONTRACTS.md §30.6)."""
        if self.superseded:
            return
        if self.current:
            s = self.step(self.current)
            s.update(status="failed", message=message[:300], finishedAt=now_iso())
        self.error = message[:500]
        if pick_up:
            await self._write({"status": "failed", "error": self.error, "pickUp": True}, remove=("note",))
            return
        await self._write({"status": "failed", "error": self.error}, remove=RESUME_NOTE_FIELDS)

    async def wait_for_mac(self, note: str) -> None:
        """YouTube blocked the cloud (§35.1): the job stays ``running`` and the step that was blocked says it waits for
        the owner's Mac. The job flow takes it from here (it waits for the Mac's upload, then starts a new run)."""
        if self.superseded:
            return
        if self.current:
            s = self.step(self.current)
            s.update(status="running", message=note[:300])
            s.pop("finishedAt", None)
        if self.live is not None:
            self.live.emit("note", text=note)
        await self._write({}, remove=("note",))

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


@contextlib.asynccontextmanager
async def creep(
    report: Callable[..., None], start: float, end: float, expected: float, *, every: float = 5.0
) -> AsyncIterator[None]:
    """Moves the bar smoothly from ``start`` toward ``end`` while one long call runs (a model answer, a cut): fast at
    first, slower as it nears ``end``, never reaching it (``expected`` seconds gets about two thirds of the way).
    It is no sign of life for the watchdog (``alive=False``): a call that hangs still gets caught."""
    loop = asyncio.get_running_loop()
    t0 = loop.time()

    async def tick() -> None:
        while True:
            await asyncio.sleep(every)
            done = 1 - math.exp(-(loop.time() - t0) / max(1.0, expected))
            report(start + (end - start) * done, alive=False)

    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


def _causes(e: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and cur not in out and len(out) < 8:
        out.append(cur)
        cur = cur.__cause__ or cur.__context__
    return out


def failure_message(step: str | None, e: BaseException) -> str:
    if any(model_unavailable(x) for x in _causes(e)):
        # The model is not turned on for this account (Bedrock model access): one plain sentence with the exact step.
        return MODEL_ACCESS_MESSAGE
    if isinstance(e, UserFacingError):
        return str(e)
    what = LABELS.get(step or "", "this step").lower()
    if is_transient(e):
        return f"A service was busy while trying to {what} and did not recover. Tap Try again."
    return f"Something went wrong while trying to {what}. Tap Try again; if it happens again, try another video."


async def _stop(task: asyncio.Future[Any]) -> None:
    """Cancels ``task`` and waits for it to end. Its own cancel or error is dropped; a cancel sent to the caller
    meanwhile is not."""
    task.cancel()
    try:
        with contextlib.suppress(Exception):
            await task
    except asyncio.CancelledError:
        cur = asyncio.current_task()
        if cur is not None and cur.cancelling():
            raise


async def watched(tr: Tracker, key: str, fn: StepFn) -> StepDone | str | None:
    """Runs one step under the watchdog: a step with no sign of life (``Tracker.report``, ``say``) for
    ``tr.stall_seconds[key]`` is stopped and raises StepStalled with a plain message. A cancel of the run stops the
    step too.

    Quiet time counts only while the event loop runs. When the whole loop is held up (a busy machine, a long
    garbage-collection pause, a paused VM) nothing in it runs, the step included, and the watchdog wakes late. That
    lateness is not the step's silence: the step's own wake-up is due at the same moment and only runs after the
    watchdog's, so counting it ended a step that was saying how far it was a moment before (nightly run 45395204955).
    A step with no sign of life is still ended once it has been quiet for the limit while the loop ran."""
    limit = tr.stall_seconds.get(key)
    if not limit:
        return await fn()
    loop = asyncio.get_running_loop()
    tr.last_sign = loop.time()  # a step tried again starts its quiet time afresh
    task: asyncio.Future[StepDone | str | None] = asyncio.ensure_future(fn())
    tick = min(tr.watch_tick, limit)
    sign = tr.last_sign
    held = 0.0  # how long the loop was held up since the step's last sign of life
    try:
        while True:
            asked = loop.time()
            done, _ = await asyncio.wait({task}, timeout=tick)
            if task in done:
                return task.result()
            now = loop.time()
            if tr.last_sign != sign:
                sign, held = tr.last_sign, 0.0
            # Woke later than asked: the loop was held up that long. Only a hold-up since the last sign counts, so a
            # hold-up before it never lends the step quiet time it did not have (quiet is never below 0).
            held = min(held + max(0.0, now - asked - tick), now - sign)
            quiet = now - sign - held
            if quiet >= limit:
                log("error", "job.step_stalled", job=tr.job_id, step=key, seconds=round(quiet))
                await _stop(task)
                raise StepStalled(stalled_message(key))
    finally:
        if not task.done():
            await _stop(task)


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
            result = await retry(
                functools.partial(watched, tracker, key, fn), what=f"step.{key}", attempts=step_attempts, base=5.0
            )
            done = result if isinstance(result, StepDone) else StepDone(message=result)
            await tracker.done(key, done.message, skipped=done.skipped)
            await tracker.check_cancel()
        await tracker.finish_ready(clip_count())
        return "ready"
    except (JobCanceled, asyncio.CancelledError) as e:
        await tracker.stop()
        if SHUTDOWN.is_set() and not isinstance(e, JobCanceled):
            # The container is going away, not the owner canceling: leave the job as it is (its saved steps and
            # clips are the checkpoint) and let the job flow resume it on a new session.
            log("info", "job.stopped_by_shutdown", job=tracker.job_id, step=tracker.current)
            return "stopped"
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
    except NeedsMac as e:
        log("info", "job.needs_mac", job=tracker.job_id, step=tracker.current, reason=e.reason)
        await tracker.stop()
        try:
            await tracker.wait_for_mac(str(e))
        except JobSuperseded:
            log("info", "job.superseded", job=tracker.job_id, step=tracker.current)
            return "superseded"
        except Exception as e2:
            log("error", "job.mac_write_failed", job=tracker.job_id, error=type(e2).__name__)
        tracker.error = str(e)
        return "mac"
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
            await tracker.finish_failed(failure_message(tracker.current, e), pick_up=isinstance(e, StepStalled))
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

    async def shutdown(self, within: float = 20.0) -> None:
        """The container is shutting down (SIGTERM): every running job stops as ``stopped`` (not canceled) and tells
        the job flow, which resumes it on a new session. Waits at most ``within`` seconds."""
        SHUTDOWN.set()
        running = [t for t in self.tasks.values() if not t.done()]
        if not running:
            return
        log("warn", "runtime.shutdown", jobs=len(running))
        for t in running:
            t.cancel()
        await asyncio.wait(running, timeout=within)

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
