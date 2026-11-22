"""Lamo Stories agent: reference-video analysis (docs/CONTRACTS.md §45.28, §45.33).

``analyze(run)`` is what builder E's ``ReferenceJob`` (its ``process_reference``, ``refjob.find_analyze``) awaits: the
video analysis agent studies the downloaded video's structure and timing from its frames and measured sound and
returns the ``ReferenceAnalysis``; E's job writes ``analysis.json`` and ``REFVID#``. Only when the server has no
``process_reference`` of its own (the scaffold) does ``register`` add this package's: the same steps on its own fence
(``study.run_reference``).
"""

from __future__ import annotations

from typing import Any

from lamostories_agent.tasks import services
from lamostories_agent.tasks.common import log

from .study import analyze, run_reference

__all__ = ["analyze", "register"]


def register(actions: Any, runner: Any) -> None:
    """Registers ``process_reference`` unless the server already has it (see server.register_all)."""
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
            except Exception as e:  # no table or bucket: the API's fence fails the job ("Tap Try again")
                log("error", "stories.services_missing", job=job_id, error=type(e).__name__, detail=str(e))
                return
            await run_reference(svc, payload)

        return services.accept(run, job_id, str(payload.get("sessionId") or ""), work())

    actions.register("process_reference", process_reference)
