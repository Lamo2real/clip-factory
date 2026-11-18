"""The AgentCore Runtime container: plain HTTP on port 8080 (docs/CONTRACTS.md §8).

GET /ping answers Healthy, or HealthyBusy while a job runs so AgentCore keeps the session alive.
POST /invocations takes ``process_job`` (accepted at once, runs in the background), ``cancel`` and ``health``.
``process_job`` comes from the durable job flow ``cf-prod-job-flow`` with a ``callbackId``: the run heartbeats to it
and ends by sending success or failure (docs/CONTRACTS.md §14.4). Without ``callbackId`` (local runs, tests) no
callback is sent.

The run's ``sessionId`` (the AgentCore runtime session the job flow invoked, chosen by the API and stored on the Job
item) comes from the ``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`` header AgentCore adds, or from ``sessionId`` in the
payload; every job write of the run is fenced on it (docs/CONTRACTS.md §13, "One run per job")."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .callback import DurableCallback
from .callback import report as report_outcome
from .util import log

if TYPE_CHECKING:
    from .jobs import JobFactory, StepFn, Tracker
    from .pipeline import JobState

MAX_BODY = 64 * 1024
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SESSION = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_CALLBACK = re.compile(r"^[\x21-\x7e]{1,2048}$")  # printable ASCII, no spaces; the id is opaque
SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"


class Runner(Protocol):
    @property
    def busy(self) -> bool: ...

    def submit(
        self, job_id: str, user_id: str, session_id: str | None = None, callback_id: str | None = None
    ) -> bool: ...

    def cancel(self, job_id: str, session_id: str | None = None) -> bool: ...


def create_app(runner: Runner) -> Starlette:
    state = {"last_update": int(time.time())}

    async def ping(_: Request) -> JSONResponse:
        return JSONResponse(
            {"status": "HealthyBusy" if runner.busy else "Healthy", "time_of_last_update": state["last_update"]}
        )

    def bad(message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": "bad_request", "message": message}}, status_code=400)

    async def invocations(request: Request) -> JSONResponse:
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return bad("The request is too large.")
        try:
            inv = json.loads(raw or b"{}")
        except ValueError:
            return bad("The request is not JSON.")
        if not isinstance(inv, dict):
            return bad("The request must be a JSON object.")
        action = inv.get("action")
        if action == "health":
            return JSONResponse({"ok": True})
        job_id = inv.get("jobId")
        if not isinstance(job_id, str) or not _ID.match(job_id):
            return bad("jobId is missing or invalid.")
        session_id = inv.get("sessionId") or request.headers.get(SESSION_HEADER) or None
        if session_id is not None and (not isinstance(session_id, str) or not _SESSION.match(session_id)):
            return bad("sessionId is invalid.")
        state["last_update"] = int(time.time())
        if action == "process_job":
            user_id = inv.get("userId")
            if not isinstance(user_id, str) or not _ID.match(user_id):
                return bad("userId is missing or invalid.")
            callback_id = inv.get("callbackId")
            if callback_id is not None and (not isinstance(callback_id, str) or not _CALLBACK.match(callback_id)):
                return bad("callbackId is invalid.")
            started = runner.submit(job_id, user_id, session_id, callback_id)
            log("info", "job.accepted", job=job_id, session=session_id, started=started)
            return JSONResponse({"accepted": True, "jobId": job_id})
        if action == "cancel":
            stopped = runner.cancel(job_id, session_id)
            log("info", "job.cancel", job=job_id, stopped=stopped)
            return JSONResponse({"canceled": stopped, "jobId": job_id})
        return bad("Unknown action.")

    async def not_found(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse({"error": {"code": "not_found", "message": "Not found."}}, status_code=404)

    return Starlette(
        routes=[Route("/ping", ping, methods=["GET"]), Route("/invocations", invocations, methods=["POST"])],
        exception_handlers={404: not_found, 405: not_found},
    )


class RunStore(Protocol):
    async def get_job(self, user_id: str, job_id: str) -> dict[str, Any] | None: ...

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


class StepSource(Protocol):
    def steps(self, st: JobState, tr: Tracker) -> list[tuple[str, StepFn]]: ...


async def close_run(pipeline: StepSource, st: JobState | None) -> None:
    """Stops whatever the run left working in the background (the picture preparation). Never raises."""
    close = getattr(pipeline, "close", None)
    if st is None or close is None:
        return
    try:
        await close(st)
    except Exception as e:
        log("warn", "job.close_failed", job=st.job_id, error=type(e).__name__)


@dataclass(frozen=True)
class Settled:
    """A ``process_job`` for a run that must not (re)start: the job already ended, or a newer run owns it."""

    status: str
    clip_count: int = 0
    error: str | None = None


def settled(job: dict[str, Any] | None, session_id: str | None) -> Settled | None:
    """None when the run should go ahead (the job is ``queued``, or ``running`` in this session after a container
    restart); otherwise the outcome to report again. The job flow's ``start-agent`` step is at-least-once, so a
    ``process_job`` can arrive after this run already finished: it never runs the job twice."""
    if not job:
        return Settled("failed", error="This job no longer exists.")
    if session_id is not None and job.get("sessionId") != session_id:
        return Settled("superseded")
    status = str(job.get("status") or "")
    if status in ("queued", "running"):
        return None
    if status == "ready":
        return Settled("ready", clip_count=int(job.get("clipCount") or 0))
    if status == "canceled":
        return Settled("canceled")
    return Settled("failed", error=str(job.get("error") or "") or None)


CallbackFactory = Callable[[str], DurableCallback]


def make_run(
    store: RunStore,
    pipeline: StepSource,
    work_root: Path,
    new_callback: CallbackFactory,
    new_tracker: Callable[..., Tracker] | None = None,
) -> JobFactory:
    """The job run: fences on the session, runs the pipeline, and reports the outcome to the job flow."""
    from .jobs import Tracker, run_job
    from .pipeline import JobState

    make_tracker = new_tracker or Tracker

    async def run(job_id: str, user_id: str, session_id: str | None, callback_id: str | None) -> str:
        cb = new_callback(callback_id) if callback_id else None
        st: JobState | None = None
        try:
            job = await store.get_job(user_id, job_id)
            if session_id is None:
                # Not invoked through AgentCore (a local run): fence on the session the job carries now.
                session_id = str(job["sessionId"]) if job and job.get("sessionId") else None
                log("warn", "job.no_session_header", job=job_id, session=session_id)
            done = settled(job, session_id)
            if done is not None:
                log("info", "job.duplicate_ignored", job=job_id, session=session_id, status=done.status)
                await report_outcome(cb, done.status, job_id=job_id, clip_count=done.clip_count, error=done.error)
                return done.status
            st = JobState(job_id=job_id, user_id=user_id, workdir=work_root / job_id, session_id=session_id)
            tracker = make_tracker(store, user_id, job_id, session_id=session_id, on_beat=cb.beat if cb else None)
            status = await run_job(tracker, pipeline.steps(st, tracker), clip_count=lambda: len(st.candidates))
            log("info", "job.finished", job=job_id, status=status)
            await report_outcome(cb, status, job_id=job_id, clip_count=len(st.candidates), error=tracker.error)
            return status
        except asyncio.CancelledError:
            if cb:
                await report_outcome(cb, "canceled", job_id=job_id, clip_count=0, error=None)
            raise
        except Exception:
            if cb:
                await report_outcome(cb, "failed", job_id=job_id, clip_count=0, error=None)
            raise
        finally:
            await close_run(pipeline, st)
            if cb:
                await cb.close()

    return run


def build_app(env: Mapping[str, str] | None = None) -> Starlette:
    """Production wiring inside the container."""
    from .bedrock import Bedrock
    from .callback import lambda_client
    from .config import load_config
    from .jobs import JobRunner
    from .pipeline import Pipeline
    from .store import Store
    from .transcribe import Transcriber
    from .vectors import Vectors

    cfg = load_config(env)
    store = Store(cfg.table, cfg.bucket, cfg.region)
    vectors = (
        Vectors(cfg.vector_bucket, cfg.vector_index, cfg.embed_model_id, cfg.region) if cfg.vector_bucket else None
    )
    if vectors is None:
        log("warn", "vectors.disabled", reason="CF_VECTOR_BUCKET is not set")
    # The second watcher of the deep analysis runs on its own client: another model id, and no cache points (Nova's
    # prompt cache is smaller than the skills block).
    watcher = (
        Bedrock(cfg.watch_model_id, cfg.region, cache_points=False) if cfg.deep_enabled and cfg.watch_model_id else None
    )
    pipeline = Pipeline(
        cfg,
        store,
        Bedrock(cfg.model_id, cfg.region),
        Transcriber(store.transcribe, cfg.bucket),
        vectors=vectors,
        watch_bedrock=watcher,
    )
    client: list[Any] = []

    def new_callback(callback_id: str) -> DurableCallback:
        if not client:
            client.append(lambda_client(cfg.region))
        return DurableCallback(callback_id, client[0])

    log(
        "info",
        "runtime.started",
        model=cfg.model_id,
        clipModels=list(cfg.clip_models),  # the owner may pick any of these per job (ADR-42)
        region=cfg.region,
        vectors=vectors is not None,
        deep=cfg.deep_enabled,
        watchModel=cfg.watch_model_id if watcher else None,
    )
    return create_app(JobRunner(make_run(store, pipeline, cfg.work_root, new_callback), cfg.work_root))


def main() -> None:
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="warning")  # noqa: S104


if __name__ == "__main__":
    main()
