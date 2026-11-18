"""The runaway guard for the deep analysis (docs/DECISIONS.md ADR-40): a bug must never call a service forever.

These are safety bounds, not a budget: the owner set no cost ceiling, so the limits sit well above what a full run
of the whole source needs (the plan is computed before the first call, and each track may make about three times that
many calls; a call the service turned away for being busy is not counted, since nothing was done or paid for, and the
retries of busy calls are bounded by watch.MAX_TRIES and the deadline instead). Passing one stops that track, which
keeps what it has; it never fails the job."""

from __future__ import annotations

import math
import time
from collections.abc import Callable

from .util import log

MAX_CHUNKS = 400  # 150-second chunks: 16 h 40 min of picture, twice the 8-hour session limit


class GuardTripped(Exception):
    """A track made more calls than its plan allows, or ran past its deadline. Not transient: nothing retries it."""


class CallBudget:
    """At most ``limit`` calls for one track. ``spend`` is called right before each model call."""

    def __init__(self, name: str, limit: int) -> None:
        self.name = name
        self.limit = max(0, int(limit))
        self.used = 0

    def spend(self) -> None:
        if self.used >= self.limit:
            log("error", "deep.guard_tripped", track=self.name, limit=self.limit, used=self.used)
            raise GuardTripped(f"{self.name}: more than {self.limit} calls")
        self.used += 1

    def refund(self) -> None:
        """The call was turned away (throttled) before the model did anything: it does not count."""
        self.used = max(0, self.used - 1)

    def allow(self, limit: int) -> None:
        """Raises the bound when the plan grows (Fable answering only smaller requests); never lowers it."""
        if int(limit) > self.limit:
            log("info", "deep.budget_raised", track=self.name, old=self.limit, new=int(limit))
            self.limit = int(limit)

    @property
    def left(self) -> int:
        return self.limit - self.used


class Deadline:
    """A point in time a track must finish by. ``clock`` is injectable for tests."""

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.seconds = float(seconds)
        self.end = clock() + self.seconds

    @property
    def left(self) -> float:
        return max(0.0, self.end - self._clock())

    @property
    def expired(self) -> bool:
        return self._clock() >= self.end

    def check(self, what: str) -> None:
        if self.expired:
            log("warn", "deep.deadline", what=what, seconds=round(self.seconds))
            raise GuardTripped(f"{what}: ran past its {self.seconds:.0f} s deadline")


def chunk_count(seconds: float, size: float) -> int:
    """How many ``size``-second chunks cover ``seconds``, never more than MAX_CHUNKS (logged when it bites)."""
    if seconds <= 0 or size <= 0:
        return 0
    n = math.ceil(seconds / size)
    if n > MAX_CHUNKS:
        log("error", "deep.guard_tripped", track="plan", limit=MAX_CHUNKS, wanted=n)
        return MAX_CHUNKS
    return n


def fable_budget(chunks: int, calls_per_chunk: int = 1) -> CallBudget:
    """Three calls per planned call: the call, a refusal for size that splits it, and one more try."""
    return CallBudget("fable", 3 * chunks * max(1, calls_per_chunk) + 8)


def nova_budget(parts: int) -> CallBudget:
    return CallBudget("nova", 3 * parts + 8)


def second_look_budget(candidates: int) -> CallBudget:
    """Three calls per moment, plus a few for finding how many frames one request may carry."""
    return CallBudget("second_look", 3 * candidates + 4)
