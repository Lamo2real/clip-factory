"""The fence every creative-agent write goes through, and the heartbeat that keeps it honest (§45.9.1, §45.11.1).

A task (``TASK#``) and a chat answer (``MSG#``) may be written only while they still carry the session the API gave
them and a live status (``queued``/``running``, ``pending``/``streaming``); a reference job (``PJOB#``) while it carries
its session and is not ``canceled``. The API's stale-heartbeat fence, Stop and Cancel all change one of these, so
the next agent write is refused and the run ends without writing anything else. Heavy work runs in a worker thread
while the event loop heartbeats every ``heartbeat_s`` seconds; a refused heartbeat ends the run.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from .common import Superseded, log, now_iso
from .store import Expr, Store

TASK_LIVE = ("queued", "running")
MSG_LIVE = ("pending", "streaming")


@dataclass
class Fence:
    store: Store
    pk: str
    sk: str
    session_id: str
    live: Sequence[str] | None = None  # the statuses the agent may write in (tasks, messages)
    not_status: str | None = None  # or the one status it may never write in (jobs: "canceled")
    lost: threading.Event = field(default_factory=threading.Event)

    def cond(self, e: Expr) -> Expr:
        e.exists().eq("sessionId", self.session_id)
        if self.live is not None:
            e.is_in("status", list(self.live))
        if self.not_status is not None:
            e.ne("status", self.not_status)
        return e

    def expr(self, fields: dict[str, Any], remove: Iterable[str] = ()) -> Expr:
        e = Expr().set(fields)
        remove = list(remove)
        if remove:
            e.remove(remove)
        return self.cond(e)

    def try_write(self, fields: dict[str, Any], remove: Iterable[str] = ()) -> bool:
        if self.lost.is_set():
            return False
        ok = self.store.update(self.pk, self.sk, self.expr(fields, remove))
        if not ok:
            self.lost.set()
        return ok

    def write(self, fields: dict[str, Any], remove: Iterable[str] = ()) -> None:
        if not self.try_write(fields, remove):
            raise Superseded(self.sk)

    def check_op(self) -> tuple[str, str, str, Expr]:
        return ("check", self.pk, self.sk, self.cond(Expr()))

    def update_op(self, fields: dict[str, Any], remove: Iterable[str] = ()) -> tuple[str, str, str, Expr]:
        return ("update", self.pk, self.sk, self.expr(fields, remove))

    def transact(self, ops: Sequence[tuple[str, str, str, Any]]) -> None:
        """Writes ``ops`` only while the fence holds (its own check or update must be one of them)."""
        if self.lost.is_set() or not self.store.transact(ops):
            self.lost.set()
            raise Superseded(self.sk)


async def run_with_heartbeat[T](fence: Fence, every_s: float, work: Callable[[], T]) -> T:
    """Runs ``work`` in a thread; heartbeats ``heartbeatAt`` on the fence meanwhile. A refused heartbeat raises
    ``Superseded`` at once (the thread's own next write is refused too)."""
    lost = asyncio.Event()

    async def beat() -> None:
        while True:
            await asyncio.sleep(every_s)
            ok = await asyncio.to_thread(fence.try_write, {"heartbeatAt": now_iso()})
            if not ok:
                log("info", "stories.fence_lost", sk=fence.sk)
                lost.set()
                return

    job = asyncio.ensure_future(asyncio.to_thread(work))
    job.add_done_callback(lambda f: None if f.cancelled() else f.exception())  # never "exception was never retrieved"
    beating = asyncio.ensure_future(beat())
    waiting = asyncio.ensure_future(lost.wait())
    try:
        await asyncio.wait({job, waiting}, return_when=asyncio.FIRST_COMPLETED)
        if job.done():
            return job.result()
        fence.lost.set()
        raise Superseded(fence.sk)
    finally:
        beating.cancel()
        waiting.cancel()
        if not job.done():
            fence.lost.set()  # the thread finishes on its own; every write it tries now is refused
