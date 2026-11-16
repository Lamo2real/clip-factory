"""``cf-prod-job-flow``: one durable execution per job run (docs/CONTRACTS.md §14.4).

Started by the API (``job-{jobId}-{flowRun}`` on the alias ``live``) with ``{"jobId", "userId", "sessionId", "run"}``:

1. ``agent-done`` callback: 8 h timeout, 15 min heartbeat timeout (the agent heartbeats at most every 5 min).
2. Step ``start-agent``: if the job is still ``queued`` with this ``sessionId``, send ``process_job`` with the callback
   id to the AgentCore runtime (3 attempts on throttling/5xx/connection errors); if it is already ``running`` with
   this ``sessionId`` (an earlier attempt reached the agent), go on to wait; otherwise (missing, newer session or
   ended) end as ``superseded``.
3. Wait for the callback, with no compute while waiting. Success → step ``finish``. A failure, a timeout or a
   missed heartbeat → step ``fail`` (plus ``stop-session`` when this run failed).

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

from .. import db
from ..agent_client import AgentClient, AgentError
from ..clock import Clock, iso, utcnow
from ..jobs import ACTIVE, START_FAILED
from ..log import log
from . import TransientError, error_message, error_type, retrying, transient

STOPPED_MESSAGE = "Making the clips stopped partway. Tap Try again."
MAX_ERROR_CHARS = 256
CALLBACK_TIMEOUT = Duration.from_hours(8)
HEARTBEAT_TIMEOUT = Duration.from_minutes(15)
QUIET_TYPES = {"Canceled": "canceled", "Superseded": "superseded"}

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
    callback = ctx.create_callback(
        name="agent-done", config=CallbackConfig(timeout=CALLBACK_TIMEOUT, heartbeat_timeout=HEARTBEAT_TIMEOUT)
    )
    callback_id = str(callback.callback_id)
    try:
        started = ctx.step(
            lambda _sc: start_agent(deps, run, callback_id), name="start-agent", config=retrying(TransientError)
        )
    except StepError as e:
        log("error", "job_flow.start_failed", jobId=run.job_id, error=error_message(e))
        outcome = ctx.step(lambda _sc: fail(deps, run, None, START_FAILED), name="fail", config=retrying())
        return _done(run, outcome)
    if started.get("skipped"):
        return _done(run, "superseded")
    try:
        raw = callback.result()
    except CallbackError as e:
        kind = error_type(e, callback)
        timed_out = isinstance(e, CallbackTimeoutError)
        # The agent's own plain sentence for a job it failed; anything else (timeout, missed heartbeat) is a stop.
        message = error_message(e) if kind == "JobFailed" and not timed_out else STOPPED_MESSAGE
        log("info", "job_flow.callback_failed", jobId=run.job_id, errorType=kind, timedOut=timed_out)
        outcome = ctx.step(lambda _sc: fail(deps, run, kind, message), name="fail", config=retrying())
        if outcome == "failed":
            ctx.step(lambda _sc: stop_session(deps, run), name="stop-session", config=retrying())
        return _done(run, outcome)
    clip_count = clip_count_from(raw)
    outcome = ctx.step(lambda _sc: finish(deps, run, clip_count), name="finish", config=retrying())
    return _done(run, outcome)


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


def start_agent(deps: JobFlowDeps, run: Run, callback_id: str) -> dict[str, bool]:
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
    if status == "running":
        log("info", "job_flow.already_started", jobId=run.job_id)
        return {"skipped": False}
    try:
        deps.agent.start_job(run.job_id, run.user_id, run.session_id, callback_id)
    except AgentError as e:
        if e.retryable:
            raise TransientError(str(e)) from e
        raise
    log("info", "job_flow.agent_started", jobId=run.job_id)
    return {"skipped": False}


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


def fail(deps: JobFlowDeps, run: Run, kind: str | None, message: str) -> str:
    """Marks this run failed with ``message`` unless the agent, a cancel or a newer run already decided the job's
    state. Returns the outcome: ``failed``, ``canceled``, ``superseded``, ``ready`` or ``missing``."""
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
    try:
        deps.store.update(
            run.pk,
            run.sk,
            {"status": "failed", "error": text, "steps": steps, "updatedAt": now},
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
