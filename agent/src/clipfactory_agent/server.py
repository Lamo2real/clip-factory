"""The AgentCore Runtime container: plain HTTP on port 8080 (docs/CONTRACTS.md §8).

GET /ping answers Healthy, or HealthyBusy while a job runs so AgentCore keeps the session alive.
POST /invocations takes ``process_job`` (accepted at once, runs in the background), ``cancel`` and ``health``.

The run's ``sessionId`` (the AgentCore runtime session the API invoked, also stored on the Job item) comes from the
``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`` header AgentCore adds, or from ``sessionId`` in the payload; every job
write of the run is fenced on it (docs/CONTRACTS.md §13, "One run per job")."""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Mapping
from typing import Any, Protocol

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .util import log

MAX_BODY = 64 * 1024
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SESSION = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"


class Runner(Protocol):
    @property
    def busy(self) -> bool: ...

    def submit(self, job_id: str, user_id: str, session_id: str | None = None) -> bool: ...

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
            started = runner.submit(job_id, user_id, session_id)
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


def build_app(env: Mapping[str, str] | None = None) -> Starlette:
    """Production wiring inside the container."""
    from .bedrock import Bedrock
    from .config import load_config
    from .jobs import JobRunner, Tracker, run_job
    from .pipeline import JobState, Pipeline
    from .store import Store
    from .transcribe import Transcriber

    cfg = load_config(env)
    store = Store(cfg.table, cfg.bucket, cfg.region)
    pipeline = Pipeline(cfg, store, Bedrock(cfg.model_id, cfg.region), Transcriber(store.transcribe, cfg.bucket))

    async def run(job_id: str, user_id: str, session_id: str | None) -> Any:
        if session_id is None:
            # Not invoked through AgentCore (a local run): fence on the session the job carries now.
            job = await store.get_job(user_id, job_id)
            session_id = str(job["sessionId"]) if job and job.get("sessionId") else None
            log("warn", "job.no_session_header", job=job_id, session=session_id)
        st = JobState(job_id=job_id, user_id=user_id, workdir=cfg.work_root / job_id, session_id=session_id)
        tracker = Tracker(store, user_id, job_id, session_id=session_id)
        status = await run_job(tracker, pipeline.steps(st, tracker), clip_count=lambda: len(st.candidates))
        log("info", "job.finished", job=job_id, status=status)
        return status

    log("info", "runtime.started", model=cfg.model_id, region=cfg.region)
    return create_app(JobRunner(run, cfg.work_root))


def main() -> None:
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="warning")  # noqa: S104


if __name__ == "__main__":
    main()
