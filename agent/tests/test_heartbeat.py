"""The heartbeat thread (docs/CONTRACTS.md §30.3): it beats while the loop is alive, even a CPU-starved one, stops when
the loop has been stuck for LOOP_STALL, tries again 20 s after a failed send, and logs the container's memory."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from clipfactory_agent import heartbeat as hb
from clipfactory_agent.heartbeat import HeartbeatThread, Liveness, free_memory, memory


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def events(out: str) -> list[dict[str, object]]:
    return [json.loads(ln) for ln in out.splitlines() if ln.startswith("{")]


def test_the_contract_numbers() -> None:
    assert hb.HEARTBEAT_SECONDS == 120 and hb.RETRY_SECONDS == 20 and hb.LOOP_STALL == 300
    assert hb.HEARTBEAT_SECONDS * 3 == 6 * 60  # the flow's heartbeat timeout allows three lost beats


async def test_the_thread_keeps_beating_while_the_loop_is_cpu_starved() -> None:
    sent: list[float] = []
    live = Liveness()

    def send() -> bool:
        sent.append(time.monotonic())
        return True

    thread = HeartbeatThread(send, live, every=0.02, stall=5.0, read_memory=dict)
    thread.start()
    try:
        await asyncio.sleep(0.01)
        before = len(sent)
        time.sleep(0.3)  # the loop is blocked (a busy ffmpeg parse, a starved CPU): no await runs
        during = len(sent) - before
    finally:
        thread.stop()
        thread.join(2)
    assert during >= 5  # the old loop-driven heartbeat sent nothing here
    assert thread.last_beat is not None


def test_no_beat_once_the_loop_has_stalled(capsys: pytest.CaptureFixture[str]) -> None:
    clock = Clock()
    live = Liveness(clock)
    sent: list[int] = []
    thread = HeartbeatThread(lambda: sent.append(1) or True, live, clock=clock, read_memory=lambda: {"current": 7})
    assert thread.tick() == hb.HEARTBEAT_SECONDS and sent == [1]
    clock.t += hb.LOOP_STALL  # nothing ticked the loop for 5 minutes
    assert thread.tick() == hb.RETRY_SECONDS
    assert thread.tick() == hb.RETRY_SECONDS
    assert sent == [1] and thread.stalled
    stalled = [e for e in events(capsys.readouterr().out) if e["event"] == "agent.loop_stalled"]
    assert len(stalled) == 1 and stalled[0]["current"] == 7  # logged once, with the memory
    live.tick()  # the loop came back
    assert thread.tick() == hb.HEARTBEAT_SECONDS and sent == [1, 1] and not thread.stalled


def test_a_failed_send_is_tried_again_in_20_seconds_and_last_beat_only_on_success() -> None:
    clock = Clock()
    results = [False, True]
    thread = HeartbeatThread(lambda: results.pop(0), Liveness(clock), clock=clock, read_memory=dict)
    assert thread.tick() == 20.0
    assert thread.last_beat is None
    clock.t += 20
    assert thread.tick() == 120.0
    assert thread.last_beat == clock.t and thread.beats == 1


def test_a_send_that_raises_never_kills_the_thread() -> None:
    def boom() -> bool:
        raise RuntimeError("network")

    thread = HeartbeatThread(boom, Liveness(), read_memory=dict)
    assert thread.tick() == hb.RETRY_SECONDS


def test_a_closed_callback_ends_the_thread() -> None:
    thread = HeartbeatThread(lambda: True, Liveness(), closed=lambda: True, every=0.01)
    thread.start()
    thread.join(2)
    assert not thread.is_alive() and thread.beats == 0


def test_every_beat_logs_the_memory(capsys: pytest.CaptureFixture[str]) -> None:
    thread = HeartbeatThread(lambda: True, Liveness(), read_memory=lambda: {"current": 1, "max": 2, "oom_kills": 0})
    thread.tick()
    (mem,) = [e for e in events(capsys.readouterr().out) if e["event"] == "agent.mem"]
    assert (mem["current"], mem["max"], mem["oom_kills"]) == (1, 2, 0)


def test_memory_from_cgroup_and_meminfo(tmp_path: Path) -> None:
    cg = tmp_path / "cg"
    cg.mkdir()
    (cg / "memory.current").write_text("3000\n")
    (cg / "memory.max").write_text("8000\n")
    (cg / "memory.events").write_text("low 0\nhigh 0\nmax 4\noom 1\noom_kill 2\n")
    assert memory(cg, tmp_path / "none") == {"current": 3000, "max": 8000, "oom_kills": 2}
    assert free_memory(cg, tmp_path / "none") == 5000
    (cg / "memory.max").write_text("max\n")  # no cgroup limit: the machine's memory
    info = tmp_path / "meminfo"
    info.write_text("MemTotal:       8 kB\nMemFree:        1 kB\nMemAvailable:   6 kB\n")
    assert memory(cg, info) == {"current": 3000, "max": 8192, "oom_kills": 2}
    # Free memory never mixes the cgroup's use with the machine's total: with no limit it is MemAvailable.
    assert free_memory(cg, info) == 6144
    assert memory(tmp_path / "nothing", tmp_path / "nothing") == {}
    assert free_memory(tmp_path / "nothing", tmp_path / "nothing") is None


async def test_the_loop_ticks_on_its_own_while_a_write_is_stuck() -> None:
    """A Job item write stuck for minutes (throttling, a full thread pool) must not look like a dead loop: the ticks
    come from their own task, which waits on nothing."""
    from clipfactory_agent.heartbeat import keep_ticking

    now = [0.0]
    live = Liveness(lambda: now[0])
    now[0] = 1000.0  # the last tick looks old
    lock = asyncio.Lock()
    await lock.acquire()  # the tracker's write holds its lock and never returns

    async def stuck_write() -> None:
        async with lock:
            pass

    writer = asyncio.create_task(stuck_write())
    ticker = asyncio.create_task(keep_ticking(live, every=0.01))
    await asyncio.sleep(0.05)
    assert live.age() == 0.0
    ticker.cancel()
    writer.cancel()
