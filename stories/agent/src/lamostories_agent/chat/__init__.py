"""Lamo Stories agent: the creative chat (docs/CONTRACTS.md §45.27, ADR-78).

Action ``chat_turn { userId, workspaceId, convId, msgId }`` (answered ``{"accepted": true, "id": msgId}`` at once):
the creative director answers the owner's newest message with Lamo Stories' tools only, streaming its text into the
answer's ``MSG#`` and returning buttons for anything that needs the owner's tap (``chat.tools``).
"""

from __future__ import annotations

from typing import Any

from lamostories_agent.tasks import services
from lamostories_agent.tasks.common import log

from .turn import run_turn


def register(actions: Any, runner: Any) -> None:
    """Registers ``chat_turn`` (see server.register_all)."""
    run = services.runner_for(actions, runner)

    def chat_turn(payload: dict[str, Any]) -> dict[str, Any]:
        msg_id = str(payload.get("msgId") or "")
        if not msg_id or not payload.get("convId"):
            return {"accepted": False, "error": "convId and msgId are required"}

        async def work() -> None:
            try:
                svc = services.get(run)
            except Exception as e:  # no table or client: the API's fence fails the answer ("Tap Try again")
                log("error", "stories.services_missing", msg=msg_id, error=type(e).__name__, detail=str(e))
                return
            await run_turn(svc, payload)

        return services.accept(run, msg_id, str(payload.get("sessionId") or ""), work())

    actions.register("chat_turn", chat_turn)
