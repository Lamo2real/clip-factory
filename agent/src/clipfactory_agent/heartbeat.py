"""The job flow's heartbeat, sent from its own thread (docs/CONTRACTS.md §30.3).

The asyncio loop runs the whole job: ffmpeg, model calls, the Job item's progress. The heartbeat used to ride that
loop too, so a loop that froze (or a container starved for memory) looked exactly like a dead one only after 15
minutes. Now a plain thread sends ``SendDurableExecutionCallbackHeartbeat`` every 2 minutes with its own boto3 client:

* it beats only while the loop is alive: the loop touches ``Liveness.tick()`` every few seconds, and when it has not
  for ``LOOP_STALL`` seconds the thread logs ``agent.loop_stalled`` and stops beating, so the flow resumes the job
  (§30.1) instead of waiting hours on a hung process;
* a failed send is tried again after 20 seconds, not after a whole period; the time of the last beat is set only when
  a send went through;
* every beat logs the container's memory (``agent.mem``), so the next stop shows whether memory ran out.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .util import log

HEARTBEAT_SECONDS = 120.0  # the flow's heartbeat timeout is 6 minutes: three beats may be lost
RETRY_SECONDS = 20.0
LOOP_STALL = 300.0
CGROUP = Path("/sys/fs/cgroup")
MEMINFO = Path("/proc/meminfo")


class Liveness:
    """When the asyncio loop last showed it is alive. Written by the loop, read by the heartbeat thread."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.last = clock()

    def tick(self) -> None:
        self.last = self.clock()

    def age(self) -> float:
        return self.clock() - self.last


def _read_int(path: Path) -> int | None:
    try:
        text = path.read_text().strip()
    except OSError:
        return None
    if text == "max":
        return None
    try:
        return int(text.split()[0])
    except (ValueError, IndexError):
        return None


def memory(root: Path = CGROUP, meminfo: Path = MEMINFO) -> dict[str, int]:
    """The container's memory in bytes: ``current`` and ``max`` from cgroup v2 (``/proc/meminfo`` when there is no
    cgroup limit), and ``oom_kills`` (processes the kernel killed for memory). Missing values are left out."""
    out: dict[str, int] = {}
    current = _read_int(root / "memory.current")
    limit = _read_int(root / "memory.max")
    if current is not None:
        out["current"] = current
    if limit is not None:
        out["max"] = limit
    try:
        for line in (root / "memory.events").read_text().splitlines():
            name, _, value = line.partition(" ")
            if name == "oom_kill":
                out["oom_kills"] = int(value)
    except (OSError, ValueError):
        pass
    if "max" not in out or "current" not in out:
        try:
            info = {
                k.strip(): int(v.split()[0]) * 1024
                for k, _, v in (ln.partition(":") for ln in meminfo.read_text().splitlines())
                if v.strip()
            }
            out.setdefault("max", info["MemTotal"])
            out.setdefault("current", info["MemTotal"] - info["MemAvailable"])
        except (OSError, KeyError, ValueError, IndexError):
            pass
    return out


def free_memory(root: Path = CGROUP, meminfo: Path = MEMINFO) -> int | None:
    """Bytes the container can still use, or None when it cannot be told (not Linux)."""
    m = memory(root, meminfo)
    if "max" in m and "current" in m:
        return max(0, m["max"] - m["current"])
    return None


class HeartbeatThread(threading.Thread):
    """Calls ``send`` (True when the flow received the beat; ``closed()`` True when the callback is over) every
    ``every`` seconds while ``liveness`` is fresh. ``stop()`` ends it within one wait."""

    def __init__(
        self,
        send: Callable[[], bool],
        liveness: Liveness,
        *,
        closed: Callable[[], bool] = lambda: False,
        every: float = HEARTBEAT_SECONDS,
        retry_after: float = RETRY_SECONDS,
        stall: float = LOOP_STALL,
        clock: Callable[[], float] = time.monotonic,
        read_memory: Callable[[], dict[str, int]] = memory,
        ref: str = "",
    ) -> None:
        super().__init__(name="callback-heartbeat", daemon=True)
        self.send = send
        self.liveness = liveness
        self.closed = closed
        self.every = every
        self.retry_after = retry_after
        self.stall = stall
        self.clock = clock
        self.read_memory = read_memory
        self.ref = ref
        self.last_beat: float | None = None  # set only after a send went through
        self.beats = 0
        self.stalled = False
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    @property
    def stopping(self) -> bool:
        return self._stop_event.is_set()

    def tick(self) -> float:
        """One round: beats if it may; returns how long to wait before the next round."""
        if self.closed():
            self._stop_event.set()
            return 0.0
        age = self.liveness.age()
        if age >= self.stall:
            if not self.stalled:
                log("error", "agent.loop_stalled", callback=self.ref, seconds=round(age), **self._mem())
            self.stalled = True
            return self.retry_after  # no beat: the flow notices in a few minutes and resumes the job
        if self.stalled:
            log("info", "agent.loop_recovered", callback=self.ref, seconds=round(age))
            self.stalled = False
        try:
            ok = self.send()
        except Exception as e:  # never kills the thread
            log("warn", "callback.send_failed", what="heartbeat", callback=self.ref, error=type(e).__name__)
            ok = False
        if not ok:
            return self.retry_after
        self.last_beat = self.clock()
        self.beats += 1
        log("info", "agent.mem", callback=self.ref, **self._mem())
        return self.every

    def _mem(self) -> dict[str, Any]:
        try:
            return dict(self.read_memory())
        except Exception:
            return {}

    def run(self) -> None:
        wait = 0.0
        while not self._stop_event.wait(wait):
            wait = self.tick()
