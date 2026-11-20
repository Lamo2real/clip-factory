"""proc.run kills the whole process group on a timeout, a cancel or a stall, makes the child the kernel's first
pick when memory runs out, and every call site passes a time limit (docs/CONTRACTS.md §30.3)."""

from __future__ import annotations

import ast
import asyncio
import os
import signal
from pathlib import Path

import pytest

from clipfactory_agent import proc
from clipfactory_agent.proc import CommandError, StalledError, oom_first, run, was_killed

SRC = Path(__file__).resolve().parents[1] / "src" / "clipfactory_agent"


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); on Linux its state says so.
    stat = Path(f"/proc/{pid}/stat")
    if stat.exists():
        try:
            return stat.read_text().split(")")[-1].split()[0] != "Z"
        except OSError:
            return False
    return True


async def gone(pid: int, within: float = 8.0) -> bool:
    loop = asyncio.get_running_loop()
    until = loop.time() + within
    while loop.time() < until:
        if not alive(pid):
            return True
        await asyncio.sleep(0.05)
    return not alive(pid)


def grandchild(tmp_path: Path) -> tuple[list[str], Path]:
    """A shell that starts a long sleep in the background (like yt-dlp starting ffmpeg) and waits for it."""
    pidfile = tmp_path / "pid"
    return ["sh", "-c", f"sleep 100 & echo $! > {pidfile}; wait"], pidfile


async def read_pid(pidfile: Path) -> int:
    for _ in range(100):
        if pidfile.exists() and pidfile.read_text().strip():
            return int(pidfile.read_text())
        await asyncio.sleep(0.02)
    raise AssertionError("the child never wrote its pid")


async def test_a_timeout_kills_the_whole_process_group(tmp_path: Path) -> None:
    cmd, pidfile = grandchild(tmp_path)
    with pytest.raises(TimeoutError):
        await run(cmd, time_limit=0.5)
    assert await gone(await read_pid(pidfile))  # no orphan sleep left behind


async def test_a_cancel_kills_the_whole_process_group(tmp_path: Path) -> None:
    cmd, pidfile = grandchild(tmp_path)
    task = asyncio.create_task(run(cmd, time_limit=60))
    pid = await read_pid(pidfile)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await gone(pid)


async def test_a_silent_command_is_killed_after_the_stall_limit(tmp_path: Path) -> None:
    cmd, pidfile = grandchild(tmp_path)
    with pytest.raises(StalledError):
        await run(cmd, time_limit=60, stall_limit=0.4)
    assert await gone(await read_pid(pidfile))


async def test_a_command_that_keeps_printing_is_not_stalled() -> None:
    script = "import sys, time\nfor i in range(6):\n    print(i, file=sys.stderr, flush=True)\n    time.sleep(0.1)"
    r = await run(["python3", "-c", script], time_limit=30, stall_limit=0.4)
    assert "5" in r.stderr


async def test_sigkill_is_told_apart() -> None:
    with pytest.raises(CommandError) as info:
        await run(["sh", "-c", "kill -9 $$"], time_limit=30)
    assert was_killed(info.value)
    with pytest.raises(CommandError) as other:
        await run(["sh", "-c", "exit 3"], time_limit=30)
    assert not was_killed(other.value)
    assert other.value.cmd == "sh"


def test_oom_first_wraps_only_on_linux(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(proc, "OOM_SCORE_FILE", tmp_path / "missing")
    assert oom_first(["ffmpeg", "-i", "x"]) == ["ffmpeg", "-i", "x"]
    score = tmp_path / "oom_score_adj"
    score.write_text("0")
    monkeypatch.setattr(proc, "OOM_SCORE_FILE", score)
    wrapped = oom_first(["ffmpeg", "-i", "a b"])
    assert wrapped[:2] == ["sh", "-c"] and wrapped[-3:] == ["ffmpeg", "-i", "a b"]  # arguments pass through as is


@pytest.mark.skipif(not Path("/proc/self/oom_score_adj").exists(), reason="Linux only")
async def test_the_child_is_the_kernels_first_pick() -> None:
    r = await run(["cat", "/proc/self/oom_score_adj"], time_limit=30)
    assert r.stdout.strip() == b"1000"


def test_every_proc_run_call_passes_a_time_limit() -> None:
    missing: list[str] = []
    calls = 0
    for path in sorted(SRC.glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
            owner = f.value.id if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) else ""
            if name == "run" and owner == "proc":
                calls += 1
                if not any(k.arg == "time_limit" for k in node.keywords) and not any(
                    k.arg is None
                    for k in node.keywords  # **kw forwarded (sources._run): checked at its callers
                ):
                    missing.append(f"{path.name}:{node.lineno}")
            if name == "_run" and path.name == "sources.py":
                calls += 1
                if not any(k.arg == "time_limit" for k in node.keywords):
                    missing.append(f"{path.name}:{node.lineno}")
    assert calls >= 15
    assert missing == []


def test_kill_signal_codes() -> None:
    assert -signal.SIGKILL in proc.KILLED_CODES and 137 in proc.KILLED_CODES


def test_a_failed_oom_score_write_says_nothing_on_stderr(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A write the kernel refuses must not put "can't create … denied" in stderr, error_tail or the owner's words."""
    import subprocess

    score = tmp_path / "oom_score_adj"
    score.write_text("0")
    monkeypatch.setattr(proc, "OOM_SCORE_FILE", score)
    wrapped = oom_first(["echo", "hi"])
    # Point the write at a place it cannot go (a folder that does not exist); the command still runs.
    script = wrapped[2].replace(str(score), str(tmp_path / "no" / "such" / "file"))
    r = subprocess.run([*wrapped[:2], script, *wrapped[3:]], capture_output=True, check=True)
    assert r.stdout == b"hi\n"
    assert r.stderr == b""


async def test_stdout_lines_reach_on_out_line_for_ffmpeg_progress() -> None:
    """ffmpeg's ``-progress pipe:1`` lines are read one by one for the live status line (§31) and not kept."""
    seen: list[str] = []
    r = await run(
        ["sh", "-c", "printf 'frame=1\\nout_time_us=41000000\\nprogress=continue\\n'"],
        time_limit=30,
        on_out_line=seen.append,
    )
    assert seen == ["frame=1", "out_time_us=41000000", "progress=continue"]
    assert r.stdout == b""


async def test_a_failing_out_line_reader_never_stops_the_command() -> None:
    def boom(line: str) -> None:
        raise ValueError(line)

    r = await run(["sh", "-c", "echo hi"], time_limit=30, on_out_line=boom)
    assert r.stderr == ""


async def test_a_last_stdout_line_without_a_newline_is_not_dropped() -> None:
    seen: list[str] = []
    await run(["sh", "-c", "printf 'a=1\\nout_time_us=5000000'"], time_limit=30, on_out_line=seen.append)
    assert seen == ["a=1", "out_time_us=5000000"]
