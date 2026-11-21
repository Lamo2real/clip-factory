"""Lamo Stories agent: reference-video analysis (docs/CONTRACTS.md §45.28, §45.33).

Action ``process_reference { userId, workspaceId, refId, jobId }`` (answered ``{"accepted": true, "id": jobId}`` at
once): the video analysis agent studies an uploaded video's structure and timing from its frames and measured sound
(``reference.analyze``). Registered here unless the server already has it.
"""

from __future__ import annotations

from typing import Any

from ..tasks import services
from ..tasks.common import log
from .analyze import run_reference


def register(actions: Any, runner: Any) -> None:
    """Registers ``process_reference`` (see server.register_all)."""
    if "process_reference" in getattr(actions, "table", {}):
        log("info", "stories.process_reference_already_registered")
        return
    run = services.runner_for(actions, runner)

    def process_reference(payload: dict[str, Any]) -> dict[str, Any]:
        job_id = str(payload.get("jobId") or "")
        if not job_id or not payload.get("refId"):
            return {"accepted": False, "error": "refId and jobId are required"}

        async def work() -> None:
            try:
                svc = services.get(run)
            except Exception as e:  # no table or client: the API's fence fails the job ("Tap Try again")
                log("error", "stories.services_missing", job=job_id, error=type(e).__name__, detail=str(e))
                return
            await run_reference(svc, payload)

        return services.accept(run, job_id, str(payload.get("sessionId") or ""), work())

    actions.register("process_reference", process_reference)
