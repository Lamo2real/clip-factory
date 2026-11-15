"""Small shared helpers: ids, time, logging and plain-language errors."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable
from datetime import UTC, datetime
from typing import Any

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid(now_ms: int | None = None, rand: bytes | None = None) -> str:
    """A 26-character ULID: 48 bits of milliseconds then 80 random bits, Crockford base32 (time-sortable)."""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    r = os.urandom(10) if rand is None else rand
    n = (ms << 80) | int.from_bytes(r, "big")
    return "".join(_CROCKFORD[(n >> (5 * i)) & 31] for i in reversed(range(26)))


def now_iso() -> str:
    t = datetime.now(UTC)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def hms(seconds: float) -> str:
    s = max(0, round(seconds))
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}"


def log(level: str, event: str, **fields: Any) -> None:
    """One JSON line per event on stdout, which AgentCore ships to CloudWatch."""
    line = {"level": level, "event": event, "time": now_iso(), **fields}
    sys.stdout.write(json.dumps(line, default=str) + "\n")
    sys.stdout.flush()


class UserFacingError(Exception):
    """A failure whose message is written for the owner and shown on the job as is."""


class TransientError(Exception):
    """A failure worth retrying (throttling, a network blip, a 5xx)."""


class JobCanceled(Exception):
    """The owner canceled the job."""


class JobSuperseded(JobCanceled):
    """A retry gave the job a new ``sessionId``, so this run is stale: it stops like a cancel but writes nothing more
    to the job (docs/CONTRACTS.md §13, "One run per job"). A subclass of JobCanceled so every place that lets a cancel
    through lets this through too."""


async def gather_all[T](*aws: Awaitable[T]) -> list[T]:
    """Like ``asyncio.gather``, but the first failure cancels the other tasks (and waits for them to finish
    cleaning up) before it is raised, so nothing is left running in the background."""
    tasks = [asyncio.ensure_future(a) for a in aws]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        pending = [t for t in tasks if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.wait(pending)
    for t in tasks:
        exc = None if t.cancelled() else t.exception()
        if exc is not None:
            raise exc
    return [t.result() for t in tasks]
