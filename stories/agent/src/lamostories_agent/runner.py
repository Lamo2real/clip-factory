"""Background work of this runtime and the job actions (docs/CONTRACTS.md §45.11.1, §45.33).

``JobRunner`` is the server's ``Runner``: one task per id (a job, a task, a chat turn), ``spawn`` answers at once and
the work runs on the event loop (its heavy parts in processes and threads); a second start of an id that still runs
is ignored; ``cancel`` stops it (its Deno, rasterizer and ffmpeg processes die with it); ``busy`` drives ``/ping``'s
``HealthyBusy``; ``shutdown`` cancels everything when the container stops (the job is then failed by the API's
stale-heartbeat fence and "Try again" resumes from its first unfinished step, because finished steps' files stay).

``register`` adds this builder's actions: ``process_story``, ``process_portrait``, ``process_reference``,
``provider_check`` (Try it, §45.35 D2: ``{userId, workspaceId, jobId, providerId?}``, ``providerId`` ``nova-reel``
when left out) and ``cancel``. Each runs as the session AgentCore invoked it in (``sessionId``, from the session header): every write is
fenced on it, so a start for a job that a newer run owns, or that already ended, does nothing."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Coroutine
from typing import Any

from . import keys
from .data import JobFence
from .util import log

Spawned = Coroutine[Any, Any, None]


class JobRunner:
    def __init__(self) -> None:
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.sessions: dict[str, str] = {}

    def spawn(self, id: str, session_id: str, coro: Spawned) -> bool:
        running = self.tasks.get(id)
        if running is not None and not running.done():
            coro.close()
            log("info", "stories.duplicate_ignored", id=id, session=session_id, running=self.sessions.get(id))
            return False

        async def go() -> None:
            try:
                await coro
            except asyncio.CancelledError:
                log("info", "stories.stopped", id=id)
            except Exception as e:
                log("error", "stories.crashed", id=id, error=type(e).__name__, detail=str(e)[:1500])

        task = asyncio.get_running_loop().create_task(go(), name=f"ls-{id}")
        self.tasks[id] = task
        self.sessions[id] = session_id

        def forget(t: asyncio.Task[None]) -> None:
            if self.tasks.get(id) is t:
                self.tasks.pop(id, None)
                self.sessions.pop(id, None)

        task.add_done_callback(forget)
        return True

    def cancel(self, id: str) -> bool:
        task = self.tasks.get(id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def busy(self) -> bool:
        return any(not t.done() for t in self.tasks.values())

    async def shutdown(self, within: float = 20.0) -> None:
        running = [t for t in self.tasks.values() if not t.done()]
        if not running:
            return
        log("warn", "stories.shutdown", running=len(running))
        for t in running:
            t.cancel()
        with contextlib.suppress(Exception):
            await asyncio.wait(running, timeout=within)


def _ids(inv: dict[str, Any], *names: str) -> dict[str, str] | None:
    out: dict[str, str] = {}
    for name in names:
        value = inv.get(name)
        if not isinstance(value, str) or not value:
            return None
        if name == "workspaceId":
            if value == keys.CLIPS or not keys.WORKSPACE_ID.match(value):
                return None
        elif not keys.SAFE_ID.match(value):
            return None
        out[name] = value
    return out


def register(actions: Any, runner: Any, services: Callable[[], Any]) -> None:
    """``services`` builds (once) what the jobs need; it is called on the first start, never at startup."""
    from .pipeline import StoryJob, clean_work
    from .portrait import PortraitJob
    from .provider_check import PROVIDERS, ProviderCheckJob
    from .refjob import ReferenceJob

    def starter(
        job_cls: type[Any], content: str, default: str | None = None
    ) -> Callable[[dict[str, Any]], dict[str, Any]]:
        def start(inv: dict[str, Any]) -> dict[str, Any]:
            if default is not None and not inv.get(content):
                inv = {**inv, content: default}
            ids = _ids(inv, "userId", "workspaceId", content, "jobId")
            session = inv.get("sessionId")
            if ids is None:
                return {"accepted": False, "error": "The request is missing an id."}
            if not isinstance(session, str) or not session:
                return {"accepted": False, "error": "The request has no session."}
            try:
                svc = services()
            except RuntimeError as e:  # services.NotConfigured: the runtime has no table or bucket setting
                log("error", "stories.not_configured", detail=str(e)[:200])
                return {"accepted": False, "error": str(e)}
            fence = JobFence(ids["userId"], ids["workspaceId"], ids["jobId"], session)
            job = job_cls(svc, fence, ids[content])

            async def work() -> None:
                try:
                    status = await job.run()
                    log("info", "stories.finished", job=fence.job_id, kind=job_cls.__name__, status=status)
                finally:
                    clean_work(svc.work_root / fence.job_id)

            started = runner.spawn(ids["jobId"], session, work())
            return {"accepted": True, "id": ids["jobId"], **({} if started else {"running": True})}

        return start

    def cancel(inv: dict[str, Any]) -> dict[str, Any]:
        target = inv.get("id") or inv.get("jobId")
        if not isinstance(target, str) or not keys.SAFE_ID.match(target):
            return {"accepted": False, "error": "The request is missing an id."}
        return {"accepted": True, "id": target, "stopped": bool(runner.cancel(target))}

    actions.register("process_story", starter(StoryJob, "storyId"))
    actions.register("process_portrait", starter(PortraitJob, "characterId"))
    actions.register("process_reference", starter(ReferenceJob, "refId"))
    actions.register("provider_check", starter(ProviderCheckJob, "providerId", PROVIDERS[0]))
    actions.register("cancel", cancel)
    actions.busy_checks.append(runner.busy)
