"""Lamo Stories agent: AI tasks (docs/CONTRACTS.md §45.7, §45.11.2, §45.25, §45.26, §45.33).

Actions (``POST /invocations``, answered ``{"accepted": true, "id"}`` at once, the work in the background):

* ``run_task { userId, workspaceId, taskId }``: the ``TASK#`` of kind ``brainstorm`` (AI ideas), ``expand_idea``
  (Make it a full idea), ``variations`` (More like this), ``character_design`` (Design with AI) or ``captions``
  (Write them again);
* ``check_models { userId, workspaceId, taskId }``: the ``TASK#`` of kind ``check_models`` (one tiny real call per
  model, ``MODELSTATUS#`` written).

Every model call goes through builder E's ``ModelClient`` (the owner's model and effort, the agent's instructions and
enabled skills, the memory, usage and model status; never another model).
"""

from __future__ import annotations

from typing import Any

from . import services
from .common import log
from .work import run_task


def register(actions: Any, runner: Any) -> None:
    """Registers ``run_task`` and ``check_models`` (see server.register_all)."""
    run = services.runner_for(actions, runner)

    def start(kinds: tuple[str, ...] | None) -> Any:
        def action(payload: dict[str, Any]) -> dict[str, Any]:
            task_id = str(payload.get("taskId") or "")
            if not task_id:
                return {"accepted": False, "error": "taskId is required"}

            async def work() -> None:
                try:
                    svc = services.get(run)
                except Exception as e:  # no table or client: the API's fence fails the task ("Tap Try again")
                    log("error", "stories.services_missing", task=task_id, error=type(e).__name__, detail=str(e))
                    return
                await run_task(svc, payload, kinds=kinds)

            return services.accept(run, task_id, str(payload.get("sessionId") or ""), work())

        return action

    actions.register("run_task", start(None))  # any task kind, so a check started as a task still runs
    actions.register("check_models", start(("check_models",)))
