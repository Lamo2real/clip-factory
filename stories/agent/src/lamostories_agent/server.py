"""The Lamo Stories runtime's HTTP server: ``GET /ping`` and ``POST /invocations`` (docs/CONTRACTS.md §45.11.1).

SCAFFOLD (Phase 1): a working server with an empty action table. Builder E implements the ``Runner`` and registers
``process_story``, ``process_portrait``, ``process_reference`` and ``cancel``; builder E2 fills ``register`` in its own
packages (``chat``, ``tasks``, ``reference``), which ``build_app`` already calls, for ``run_task``, ``chat_turn`` and
``check_models``. Each action handler takes the payload and returns the immediate answer; the work runs in the
background and ``busy()`` says whether anything still runs.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Coroutine
from typing import Any, Protocol

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

MAX_BODY = 64 * 1024
Action = Callable[[dict[str, Any]], dict[str, Any]]


class Runner(Protocol):
    """Runs background work, one coroutine per id (§45.33). Builder E implements it."""

    def spawn(self, id: str, session_id: str, coro: Coroutine[Any, Any, None]) -> bool: ...

    def cancel(self, id: str) -> bool: ...

    def busy(self) -> bool: ...

    async def shutdown(self) -> None: ...


class Actions:
    def __init__(self) -> None:
        self.table: dict[str, Action] = {}
        self.busy_checks: list[Callable[[], bool]] = []

    def register(self, name: str, fn: Action) -> None:
        if name in self.table or name == "health":
            raise ValueError(f"action already registered: {name}")
        self.table[name] = fn

    def busy(self) -> bool:
        return any(check() for check in self.busy_checks)


def create_app(actions: Actions) -> Starlette:
    async def ping(_: Request) -> JSONResponse:
        return JSONResponse({"status": "HealthyBusy" if actions.busy() else "Healthy"})

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
        fn = actions.table.get(str(action))
        if fn is None:
            return bad("Unknown action.")
        return JSONResponse(fn(inv))

    return Starlette(
        routes=[Route("/ping", ping, methods=["GET"]), Route("/invocations", invocations, methods=["POST"])]
    )


def register_all(actions: Actions, runner: Runner | None) -> None:
    """Every package's actions, from a fixed list (builder E adds its own here; E2's packages are already listed)."""
    from . import chat, reference, tasks

    for package in (chat, tasks, reference):
        package.register(actions, runner)


def build_app() -> Starlette:
    """The app uvicorn serves (``--factory``)."""
    actions = Actions()
    register_all(actions, None)
    return create_app(actions)


def main() -> None:
    import uvicorn

    uvicorn.run(build_app, factory=True, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # noqa: S104
