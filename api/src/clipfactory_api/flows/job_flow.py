"""``cf-prod-job-flow``: one durable execution per job run (docs/CONTRACTS.md §14.4).

Started by the API (``job-{jobId}-{flowRun}`` on the alias ``live``) with ``{"jobId", "userId", "sessionId", "run"}``:

1. ``agent-done`` callback: 8 h timeout, 6 min heartbeat timeout (the agent heartbeats every 2 min from its own
   thread, §30.3).
2. Step ``start-agent``: if the job is still ``queued`` with this ``sessionId``, send ``process_job`` with the callback
   id to the AgentCore runtime (3 attempts on throttling/5xx/connection errors); if it is already ``running`` with
   this ``sessionId`` (an earlier attempt reached the agent), go on to wait; otherwise (missing, newer session or
   ended) end as ``superseded``.
3. Wait for the callback, with no compute while waiting. Success → step ``finish``. The agent's own failure
   (``JobFailed``, ``Canceled``, ``Superseded``) → step ``fail`` (plus ``stop-session`` when this run failed).
4. A timeout, a missed heartbeat or ``AgentStopped`` (the container is shutting down) does not fail the job: it is
   resumed (docs/CONTRACTS.md §30.1) while each attempt moves it forward (its progress went up), at most
   ``MAX_RESUMES`` times; only ``MAX_STALLED`` resumes after attempts that made no progress are allowed. Step ``resume-n`` gives the job a new
   ``sessionId`` (which fences the old container out) with status ``queued``, ``pickUp`` and the note "Picking up
   where it stopped…", keeping its steps, progress and saved files; step ``stop-old-n`` ends the old session; then
   ``agent-done-n`` / ``start-agent-n`` run as in 1-3 on the new session, on the newest runtime version. Only after
   the last resume is the job failed, with words that say Try again picks up where it left off.

5. Mac fetches it (docs/CONTRACTS.md §35): the agent's ``MacFetch`` failure (YouTube blocked the cloud), or a job
   started from the desktop app (``macFetch.up``, checked by ``start-agent``), does not fail the job. ``mac-wait-n``
   marks it waiting for the owner's Mac (with the ``mac-done-n`` callback id, 24 h, no compute while waiting);
   after 2 minutes ``mac-nudge-n`` marks it for the "Open Clip Factory on your Mac" notification if no Mac has
   claimed it. When the API reports the Mac's upload, ``mac-source-n`` turns the job into an upload job on a new
   session and the next attempt runs the agent on it. A timeout fails it with "Your Mac didn't get the video. Use a
   video file instead." Only one Mac fetch per flow run.

Every write is conditional on this run's ``sessionId``, so a superseded run never touches a newer one. The handler
returns ``{"jobId", "outcome"}`` and never raises for these expected outcomes: ``DurableExecutionFailed`` means a bug.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from aws_durable_execution_sdk_python import (
    CallbackError,
    CallbackTimeoutError,
    DurableContext,
    StepError,
    durable_execution,
)
from aws_durable_execution_sdk_python.config import CallbackConfig, Duration

from .. import db, macfetch
from ..agent_client import AgentClient, AgentError
from ..clock import Clock, iso, utcnow
from ..jobs import ACTIVE, START_FAILED, picked_up_steps
from ..log import log
from . import TransientError, error_message, error_type, retrying, transient

STOPPED_MESSAGE = "Making the clips stopped. Tap Try again to pick up where it left off."
RESUME_NOTE = "Picking up where it stopped…"
MAX_ERROR_CHARS = 256
CALLBACK_HOURS = 8
CALLBACK_TIMEOUT = Duration.from_hours(CALLBACK_HOURS)
HEARTBEAT_TIMEOUT = Duration.from_minutes(6)
QUIET_TYPES = {"Canceled": "canceled", "Superseded": "superseded"}
MAX_RESUMES = 6  # the most resumes of one flow run, and only while each attempt moves the job forward
MAX_STALLED = 2  # resumes after an attempt that made no progress (the old limit, now only for a stuck job)
PROGRESS_STEP = 0.001  # progress (0..1) must rise by more than this for an attempt to count as moving forward
AGENT_STOPPED = "AgentStopped"  # the agent got SIGTERM (a stopped session, a retired version): resume at once
# The whole execution may run 8.5 h (infra/modules/flows: execution_timeout). A resume needs at least this much of the
# 8 h left, and its callback gets only what is left, so the execution never outlives its timeout with the job running.
RESUME_MIN_SECONDS = 20 * 60
MAC_FETCH = "MacFetch"  # the agent's failure type: YouTube blocked the cloud, wait for the owner's Mac (§35)
MAC_FAILED = "MacFailed"  # the API's failure type: the Mac stopped (its words are the message)
MAC_TIMEOUT = Duration.from_hours(macfetch.WAIT_HOURS)
MAC_NUDGE = Duration.from_minutes(macfetch.NUDGE_MINUTES)

Item = dict[str, Any]


@dataclass
class JobFlowDeps:
    store: db.Store
    agent: AgentClient
    clock: Clock = field(default=utcnow)


@dataclass(frozen=True)
class Run:
    job_id: str
    user_id: str
    session_id: str

    @property
    def pk(self) -> str:
        return db.user_pk(self.user_id)

    @property
    def sk(self) -> str:
        return db.job_sk(self.job_id)


def parse_event(event: Any) -> Run | None:
    if not isinstance(event, dict):
        return None
    values = [event.get(k) for k in ("jobId", "userId", "sessionId")]
    if not all(isinstance(v, str) and v for v in values):
        return None
    return Run(*[str(v) for v in values])


def run_job_flow(ctx: Any, event: Any, deps: JobFlowDeps) -> dict[str, Any]:
    run = parse_event(event)
    if run is None:
        log("error", "job_flow.bad_event")
        return {"jobId": event.get("jobId") if isinstance(event, dict) else None, "outcome": "bad_event"}
    first = run
    timeout = CALLBACK_TIMEOUT
    stalled = 0
    mac_used = False
    for attempt in range(MAX_RESUMES + 1):
        ended, resumed = _attempt(ctx, deps, run, attempt, timeout, stalled=stalled, mac_used=mac_used)
        if resumed is None:
            return _done(first, ended or "failed")
        run = Run(run.job_id, run.user_id, str(resumed["sessionId"]))
        timeout = Duration.from_seconds(int(resumed["seconds"]))
        stalled = int(resumed.get("stalled") or 0)
        mac_used = mac_used or bool(resumed.get("mac"))
    raise AssertionError("the last attempt never resumes")  # pragma: no cover


@dataclass(frozen=True)
class _Stop:
    kind: str | None
    timed_out: bool
    message: str


def _attempt(
    ctx: Any,
    deps: JobFlowDeps,
    run: Run,
    attempt: int,
    timeout: Duration,
    *,
    stalled: int = 0,
    mac_used: bool = False,
) -> tuple[str | None, dict[str, Any] | None]:
    """One agent run on ``run.session_id``: ``(outcome, None)`` when the flow ends, ``(None, resumed)`` to go on with
    the new session ``begin_resume`` gave the job. The first attempt keeps the names it always had ("agent-done",
    "start-agent", "fail", "finish"), so an execution started before resumes existed replays as checkpointed."""
    suffix = f"-{attempt}" if attempt else ""
    callback = ctx.create_callback(
        name=f"agent-done{suffix}", config=CallbackConfig(timeout=timeout, heartbeat_timeout=HEARTBEAT_TIMEOUT)
    )
    callback_id = str(callback.callback_id)
    try:
        started = ctx.step(
            lambda _sc: start_agent(deps, run, callback_id),
            name=f"start-agent{suffix}",
            config=retrying(TransientError),
        )
    except StepError as e:
        log("error", "job_flow.start_failed", jobId=run.job_id, error=error_message(e))
        return ctx.step(lambda _sc: fail(deps, run, None, START_FAILED), name="fail", config=retrying()), None
    if started.get("skipped"):
        return "superseded", None
    if started.get("mac") and not mac_used and attempt < MAX_RESUMES:
        # Started from the desktop app: the cloud never asks YouTube; the owner's Mac gets the video (§35.1).
        return _wait_for_mac(ctx, deps, run, attempt, stop_old=False)
    try:
        raw = callback.result()
    except CallbackError as e:
        stop = _Stop(error_type(e, callback), isinstance(e, CallbackTimeoutError), error_message(e))
        if stop.kind == MAC_FETCH and not stop.timed_out and not mac_used and attempt < MAX_RESUMES:
            return _wait_for_mac(ctx, deps, run, attempt, stop_old=True)
        return _stopped(ctx, deps, run, attempt, stop, since=_progress(started.get("progress")), stalled=stalled)
    clip_count = clip_count_from(raw)
    return ctx.step(lambda _sc: finish(deps, run, clip_count), name="finish", config=retrying()), None


def _wait_for_mac(
    ctx: Any, deps: JobFlowDeps, run: Run, attempt: int, *, stop_old: bool
) -> tuple[str | None, dict[str, Any] | None]:
    """Waits (no compute) for the owner's Mac to send the video (§35.1), then hands the job to a new session as an
    upload job: ``(None, resumed)`` to go on with the next attempt, or ``(outcome, None)`` when the flow ends."""
    suffix = f"-{attempt}" if attempt else ""
    callback = ctx.create_callback(name=f"mac-done{suffix}", config=CallbackConfig(timeout=MAC_TIMEOUT))
    callback_id = str(callback.callback_id)
    began = ctx.step(lambda _sc: begin_mac_wait(deps, run, callback_id), name=f"mac-wait{suffix}", config=retrying())
    if began.get("outcome"):
        return str(began["outcome"]), None
    if stop_old:
        ctx.step(lambda _sc: stop_session(deps, run), name=f"mac-stop-old{suffix}", config=retrying())
    ctx.wait(MAC_NUDGE, name=f"mac-nudge-after{suffix}")
    ctx.step(lambda _sc: nudge_mac(deps, run), name=f"mac-nudge{suffix}", config=retrying())
    try:
        raw = callback.result()
    except CallbackError as e:
        kind = error_type(e, callback)
        timed_out = isinstance(e, CallbackTimeoutError)
        message = macfetch.TIMED_OUT if timed_out or kind != MAC_FAILED else error_message(e)
        outcome = ctx.step(
            lambda _sc: fail(deps, run, None if timed_out else kind, message),
            name=f"mac-fail{suffix}",
            config=retrying(),
        )
        log("info", "job_flow.mac_ended", jobId=run.job_id, timedOut=timed_out, errorType=kind, outcome=outcome)
        return outcome, None
    resumed = ctx.step(lambda _sc: switch_to_mac_upload(deps, run, raw), name=f"mac-source{suffix}", config=retrying())
    if resumed.get("sessionId"):
        return None, {**resumed, "mac": True}
    return str(resumed.get("outcome") or "failed"), None


def _progress(raw: Any) -> float | None:
    try:
        return None if raw is None else float(raw)
    except (TypeError, ValueError):
        return None


def _stopped(
    ctx: Any,
    deps: JobFlowDeps,
    run: Run,
    attempt: int,
    stop: _Stop,
    *,
    since: float | None = None,
    stalled: int = 0,
) -> tuple[str | None, dict[str, Any] | None]:
    """The callback failed. A timeout, a missed heartbeat or ``AgentStopped`` resumes the job while resumes are left
    (§30.1): ``since`` is the job's progress when this attempt started, ``stalled`` the resumes so far after attempts
    that made none. Anything else, or the last one, fails it."""
    log(
        "info",
        "job_flow.callback_failed",
        jobId=run.job_id,
        errorType=stop.kind,
        timedOut=stop.timed_out,
        attempt=attempt,
    )
    stopped = stop.timed_out or stop.kind == AGENT_STOPPED
    if stopped and attempt < MAX_RESUMES:
        n = attempt + 1
        resumed = ctx.step(
            lambda _sc: begin_resume(deps, run, n, since=since, stalled=stalled), name=f"resume-{n}", config=retrying()
        )
        if resumed.get("sessionId"):
            ctx.step(lambda _sc: stop_session(deps, run), name=f"stop-old-{n}", config=retrying())
            return None, resumed
        if resumed.get("outcome"):
            return str(resumed["outcome"]), None  # canceled, retried by the owner, ended or gone
    # The agent's own plain sentence for a job it failed; anything else (timeout, missed heartbeat, a container
    # stopped once too often) is a stop that Try again picks up from.
    message = stop.message if stop.kind == "JobFailed" and not stop.timed_out else STOPPED_MESSAGE
    outcome = ctx.step(lambda _sc: fail(deps, run, stop.kind, message, pick_up=stopped), name="fail", config=retrying())
    if outcome == "failed":
        ctx.step(lambda _sc: stop_session(deps, run), name="stop-session", config=retrying())
    return outcome, None


def _done(run: Run, outcome: str) -> dict[str, Any]:
    log("info", "job_flow.done", jobId=run.job_id, outcome=outcome)
    return {"jobId": run.job_id, "outcome": outcome}


def clip_count_from(raw: Any) -> int | None:
    """``clipCount`` from the agent's success result (``{"jobId", "clipCount"}`` as JSON text or bytes)."""
    try:
        data = json.loads(raw) if isinstance(raw, str | bytes | bytearray) else raw
    except ValueError:
        return None
    value = data.get("clipCount") if isinstance(data, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


# --- steps (each idempotent: it reads before it acts and every write is conditional) ---------------------------------


def _get(deps: JobFlowDeps, run: Run) -> Item | None:
    try:
        return deps.store.get(run.pk, run.sk)
    except Exception as e:
        raise transient(e) from e


def start_agent(deps: JobFlowDeps, run: Run, callback_id: str) -> dict[str, Any]:
    """Sends ``process_job`` for this run. Skips (the flow ends ``superseded``) only when the job is gone, belongs to
    a newer run or has already ended. ``running`` with this run's ``sessionId`` means an earlier attempt of this
    at-least-once step reached the agent (a read timeout after the agent's ``begin()``, or a crash before the
    checkpoint): the run is started, so the flow goes on to wait for the callback and its heartbeat timeout. A job
    still ``queued`` is (re)sent; the agent ignores a duplicate ``process_job`` for a job it is already running."""
    job = _get(deps, run)
    status = (job or {}).get("status")
    if job is None or job.get("sessionId") != run.session_id or status not in ACTIVE:
        log("info", "job_flow.skip_start", jobId=run.job_id, status=status)
        return {"skipped": True}
    progress = _progress(job.get("progress")) or 0.0  # where this attempt starts (a resume counts what it adds)
    mac = job.get("macFetch")
    if isinstance(mac, dict) and mac.get("up") and mac.get("state") in macfetch.WAITING_STATES:
        log("info", "job_flow.mac_up_front", jobId=run.job_id)
        return {"skipped": False, "mac": True, "progress": progress}
    if status == "running":
        log("info", "job_flow.already_started", jobId=run.job_id)
        return {"skipped": False, "progress": progress}
    try:
        deps.agent.start_job(run.job_id, run.user_id, run.session_id, callback_id)
    except AgentError as e:
        if e.retryable:
            raise TransientError(str(e)) from e
        raise
    log("info", "job_flow.agent_started", jobId=run.job_id)
    return {"skipped": False, "progress": progress}


def _state_outcome(job: Item | None, run: Run) -> str | None:
    """The outcome the job's current state already tells, or None when this run may still write it."""
    if job is None:
        return "missing"
    if job.get("sessionId") != run.session_id:
        return "superseded"
    status = str(job.get("status") or "")
    if status in ACTIVE:
        return None
    return status


def fail(deps: JobFlowDeps, run: Run, kind: str | None, message: str, *, pick_up: bool = False) -> str:
    """Marks this run failed with ``message`` unless the agent, a cancel or a newer run already decided the job's
    state. Returns the outcome: ``failed``, ``canceled``, ``superseded``, ``ready`` or ``missing``. ``pick_up``: the
    run stopped (it did not fail on its own), so Try again keeps what it saved (``pickUp``, §30.6)."""
    if kind in QUIET_TYPES:
        return QUIET_TYPES[kind]  # the API or the newer run already wrote the state
    job = _get(deps, run)
    known = _state_outcome(job, run)
    if known is not None or job is None:
        return known or "missing"
    text = (message or "").strip()[:MAX_ERROR_CHARS] or STOPPED_MESSAGE
    now = iso(deps.clock())
    steps = [
        {**s, "status": "failed", "message": text, "finishedAt": now} if s.get("status") == "running" else s
        for s in job.get("steps", [])
        if isinstance(s, dict)
    ]
    fields: dict[str, Any] = {"status": "failed", "error": text, "steps": steps, "updatedAt": now}
    if pick_up:
        fields["pickUp"] = True
    try:
        deps.store.update(
            run.pk,
            run.sk,
            fields,
            remove=["note"],
            expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]},
        )
    except db.ConditionFailed:
        return _state_outcome(_get(deps, run), run) or "failed"
    except Exception as e:
        raise transient(e) from e
    log("warning", "job_flow.failed_job", jobId=run.job_id, errorType=kind)
    return "failed"


def finish(deps: JobFlowDeps, run: Run, clip_count: int | None) -> str:
    """The agent reported success: make sure the job reads ``ready`` (the agent normally wrote it already)."""
    job = _get(deps, run)
    known = _state_outcome(job, run)
    if known is not None:
        return known
    fields: dict[str, Any] = {"status": "ready", "progress": 1, "updatedAt": iso(deps.clock())}
    if clip_count is not None:
        fields["clipCount"] = clip_count
    try:
        deps.store.update(run.pk, run.sk, fields, expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]})
    except db.ConditionFailed:
        return _state_outcome(_get(deps, run), run) or "ready"
    except Exception as e:
        raise transient(e) from e
    return "ready"


def _elapsed_seconds(job: Item, now_iso: str) -> float:
    """How long this flow run's agent has been at it: since its first step started (Try again resets the steps; a
    resume keeps them). 0 when that cannot be told."""
    from datetime import datetime

    steps = [s for s in job.get("steps") or [] if isinstance(s, dict)]
    # Try again that picks up keeps the done steps (and their old times) but marks when this flow run began.
    first = str(job["runStartedAt"]) if job.get("runStartedAt") else None
    first = first or next((str(s["startedAt"]) for s in steps if s.get("startedAt")), None)
    if not first:
        return 0.0
    try:
        a = datetime.fromisoformat(first.replace("Z", "+00:00"))
        b = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    return max(0.0, (b - a).total_seconds())


def begin_resume(
    deps: JobFlowDeps, run: Run, n: int, *, since: float | None = None, stalled: int = 0
) -> dict[str, Any]:
    """Hands a job that stopped partway to a new session (§30.1): ``{"sessionId", "seconds", "stalled"}`` (the new
    callback's timeout and the resumes so far after attempts that made no progress), or ``{"outcome"}`` when the job
    must not resume (canceled, retried by the owner, ended, gone), or ``{}`` to fail it (too little of the 8 h left,
    or a job that stopped ``MAX_STALLED`` times already without moving forward). ``since``: the job's progress when the
    attempt that stopped began (None: unknown, counted as moving forward). Only adds and changes fields: the steps, progress, clip count and
    saved files stay. The new ``sessionId`` fences the old container: from now on none of its writes land."""
    job = _get(deps, run)
    known = _state_outcome(job, run)
    if known is not None or job is None:
        log("info", "job_flow.no_resume", jobId=run.job_id, outcome=known)
        return {"outcome": known or "missing"}
    now = iso(deps.clock())
    left = CALLBACK_HOURS * 3600 - _elapsed_seconds(job, now)
    if left < RESUME_MIN_SECONDS:
        log("info", "job_flow.no_time_to_resume", jobId=run.job_id, left=int(left))
        return {}
    progress = _progress(job.get("progress")) or 0.0
    moved = since is None or progress > since + PROGRESS_STEP
    if not moved:
        if stalled >= MAX_STALLED:
            log("info", "job_flow.stuck", jobId=run.job_id, stalled=stalled)
            return {}
        stalled += 1
    from ..agent_client import new_session_id

    session = new_session_id(run.job_id)
    try:
        deps.store.update(
            run.pk,
            run.sk,
            {
                "status": "queued",
                "sessionId": session,
                "resumes": n,
                "pickUp": True,
                "note": RESUME_NOTE,
                "heartbeatAt": now,
                "updatedAt": now,
            },
            expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]},
        )
    except db.ConditionFailed:
        outcome = _state_outcome(_get(deps, run), run) or "superseded"
        log("info", "job_flow.no_resume", jobId=run.job_id, outcome=outcome)
        return {"outcome": outcome}
    except Exception as e:
        raise transient(e) from e
    log("warning", "job_flow.resumed", jobId=run.job_id, resumes=n, moved=moved, stalled=stalled)
    return {"sessionId": session, "seconds": int(left), "stalled": stalled}


def _mac_map(job: Item) -> dict[str, Any]:
    mac = job.get("macFetch")
    return dict(mac) if isinstance(mac, dict) else {}


def _waiting_step(job: Item) -> str:
    """The step that waits for the Mac: the one the agent was running when YouTube blocked it, else Find the video."""
    for s in job.get("steps") or []:
        if isinstance(s, dict) and s.get("status") == "running":
            return str(s.get("key"))
    return "resolve"


def begin_mac_wait(deps: JobFlowDeps, run: Run, callback_id: str) -> dict[str, Any]:
    """Marks the job waiting for the owner's Mac (§35.1): ``macFetch.state`` ``waiting`` (kept when a Mac already
    claimed it), the callback id the API completes, the waiting step running with "Waiting for your Mac to get the
    video", and the same words on the live line. ``{}`` to wait, ``{"outcome"}`` when the job already ended."""
    job = _get(deps, run)
    known = _state_outcome(job, run)
    if known is not None or job is None:
        return {"outcome": known or "missing"}
    now = iso(deps.clock())
    old = _mac_map(job)
    mac = {**old, "since": old.get("since") or now}
    if mac.get("state") not in ("getting", "sending"):
        mac["state"] = "waiting"
    key = _waiting_step(job)
    steps = []
    for step in job.get("steps") or []:
        if isinstance(step, dict) and step.get("key") == key:
            waiting = {**step, "status": "running", "message": macfetch.WAITING}
            waiting["startedAt"] = step.get("startedAt") or now
            waiting.pop("finishedAt", None)
            steps.append(waiting)
        else:
            steps.append(step)
    try:
        deps.store.update(
            run.pk,
            run.sk,
            {"status": "running", "macFetch": mac, "macCallbackId": callback_id, "steps": steps, "updatedAt": now},
            remove=["note"],
            expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]},
        )
    except db.ConditionFailed:
        return {"outcome": _state_outcome(_get(deps, run), run) or "superseded"}
    except Exception as e:
        raise transient(e) from e
    _live_line(deps, run, key, macfetch.WAITING, now)
    log("info", "job_flow.mac_waiting", jobId=run.job_id, step=key, upFront=bool(mac.get("up")))
    return {}


def _live_line(deps: JobFlowDeps, run: Run, step: str, text: str, now: str) -> None:
    """The live status line (§31) says the job waits for the Mac. Best effort: the step's message says it too."""
    ttl = int(deps.clock().timestamp()) + 7 * 86400
    try:
        deps.store.update_expr(
            run.pk,
            f"JOBLIVE#{run.job_id}",
            "SET #type = :type, jobId = :job, sessionId = :session, step = :step, #text = :text, #at = :now, "
            "lastChange = :now, #ttl = :ttl REMOVE detail, tech, since, i, n, pct",
            names={"#type": "type", "#text": "text", "#at": "at", "#ttl": "ttl"},
            values={
                ":type": "jobLive",
                ":job": run.job_id,
                ":session": run.session_id,
                ":step": step,
                ":text": text,
                ":now": now,
                ":ttl": ttl,
            },
        )
    except Exception as e:
        log("warning", "job_flow.mac_live_failed", jobId=run.job_id, error=type(e).__name__)


def nudge_mac(deps: JobFlowDeps, run: Run) -> dict[str, bool]:
    """Two minutes in, no Mac has claimed the job: ``macFetch.nudgedAt`` is set, and cf-prod-notify sends "Open Clip
    Factory on your Mac to continue" (§35.2). Nothing when a Mac is already on it or the job moved on."""
    job = _get(deps, run)
    if job is None or _state_outcome(job, run) is not None:
        return {"nudged": False}
    mac = _mac_map(job)
    if mac.get("state") != "waiting" or mac.get("nudgedAt"):
        return {"nudged": False}
    now = iso(deps.clock())
    try:
        deps.store.update(
            run.pk,
            run.sk,
            {"macFetch": {**mac, "nudgedAt": now}, "updatedAt": now},
            expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]},
        )
    except db.ConditionFailed:
        return {"nudged": False}
    except Exception as e:
        raise transient(e) from e
    log("info", "job_flow.mac_nudged", jobId=run.job_id)
    return {"nudged": True}


def mac_result(raw: Any, user_id: str, job_id: str) -> dict[str, Any] | None:
    """The API's success result (``{"key", "size", "title"?, "creator"?, "durationSec"?}``), checked again here."""
    try:
        data = json.loads(raw) if isinstance(raw, str | bytes | bytearray) else raw
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("key") != macfetch.upload_key(user_id, job_id):
        return None
    size = data.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= macfetch.MAX_SIZE:
        return None
    return data


def switch_to_mac_upload(deps: JobFlowDeps, run: Run, raw: Any) -> dict[str, Any]:
    """The Mac's video arrived (§35.3): the job becomes an upload job on a new session. It keeps the link, the title
    and the creator (``source.url``, ``title``, ``channel``) and says ``fetchedBy: "mac"``; done steps stay done (a
    Cut-step block keeps its moments), the waiting step and later ones go back to pending, and the new run gets a
    fresh 8 h. ``{"sessionId", "seconds", "stalled"}``, or ``{"outcome"}``."""
    job = _get(deps, run)
    known = _state_outcome(job, run)
    if known is not None or job is None:
        return {"outcome": known or "missing"}
    data = mac_result(raw, run.user_id, run.job_id)
    if data is None:
        log("error", "job_flow.mac_bad_result", jobId=run.job_id)
        return {"outcome": fail(deps, run, None, macfetch.FAILURE_WORDS["send"])}
    from ..agent_client import new_session_id

    old = dict(job.get("source") or {})
    source = {
        **old,
        "type": "upload",
        "platform": "upload",
        "key": data["key"],
        "filename": "video.mp4",
        "fetchedBy": "mac",
        "linkPlatform": old.get("platform") or "youtube",
    }
    for field_name, key, limit in (("title", "title", 200), ("channel", "creator", 120)):
        text = macfetch.clean_text(data.get(key), limit)
        if text and not old.get(field_name):
            source[field_name] = text
    now = iso(deps.clock())
    mac = {**_mac_map(job), "state": "done", "at": now}
    for internal in ("deviceId", "uploadId"):
        mac.pop(internal, None)
    session = new_session_id(run.job_id)
    try:
        deps.store.update(
            run.pk,
            run.sk,
            {
                "status": "queued",
                "sessionId": session,
                "source": source,
                "macFetch": mac,
                "steps": picked_up_steps(job.get("steps")),
                "pickUp": True,
                "note": macfetch.SENT_NOTE,
                "runStartedAt": now,
                "heartbeatAt": now,
                "updatedAt": now,
            },
            remove=["macCallbackId", "error"],
            expect_in={"status": list(ACTIVE), "sessionId": [run.session_id]},
        )
    except db.ConditionFailed:
        return {"outcome": _state_outcome(_get(deps, run), run) or "superseded"}
    except Exception as e:
        raise transient(e) from e
    log("info", "job_flow.mac_source", jobId=run.job_id, size=data["size"])
    return {"sessionId": session, "seconds": CALLBACK_HOURS * 3600, "stalled": 0}


def stop_session(deps: JobFlowDeps, run: Run) -> dict[str, bool]:
    """Ends the failed run's runtime session (its container). Errors are logged and ignored."""
    try:
        deps.agent.stop_session(run.session_id)
    except Exception as e:
        log("warning", "job_flow.stop_session_failed", jobId=run.job_id, error=type(e).__name__)
        return {"stopped": False}
    return {"stopped": True}


# --- Lambda entry point ---------------------------------------------------------------------------------------------

_deps: JobFlowDeps | None = None


def _from_env() -> JobFlowDeps:
    from .. import agent_client
    from ..app import region, table

    env = os.environ
    return JobFlowDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        agent=AgentClient(agent_client.make_client(region(), read_timeout=60), env["AGENT_RUNTIME_ARN"]),
    )


def get_deps(factory: Callable[[], JobFlowDeps] = _from_env) -> JobFlowDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


@durable_execution
def handler(event: Any, context: DurableContext) -> dict[str, Any]:
    return run_job_flow(context, event, get_deps())
