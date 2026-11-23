"""Clips Funded's own PO token sidecar (docs/CONTRACTS.md §45.40, ADR-88; the ADR-52 way, copied from Clip Factory,
never imported): loopback only, no write permission, its own read-only Deno cache, started only when a YouTube link
asks, restarted when it stops, and off with ``CF_STORIES_POT=off``. No network: a fake Deno that exits at once."""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path

import pytest

from lamostories_agent import pot


def test_the_command_is_loopback_and_read_only() -> None:
    cmd = pot.command(Path("/opt/bgutil/server"))
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1" and cmd[cmd.index("--port") + 1] == "4416"
    assert not any(a.startswith("--allow-write") or a in ("-A", "--allow-all", "--allow-run") for a in cmd)
    assert "--allow-read=/opt/bgutil/server/node_modules" in cmd and cmd[-5].endswith("src/main.ts")


def test_its_own_deno_cache_and_yt_dlp_arguments() -> None:
    env = {"CF_STORIES_POT_HOME": "/opt/bgutil/server", "CF_STORIES_POT_DENO_DIR": "/opt/bgutil/deno-cache"}
    assert pot.deno_env(env) == {"DENO_DIR": "/opt/bgutil/deno-cache"}
    assert pot.deno_env({}) == {}
    assert pot.ytdlp_args(env) == ["--extractor-args", "youtube:player_client=default,mweb", "--extractor-args",
                                   "youtubepot-bgutilscript:server_home=/opt/bgutil/server"]  # fmt: skip
    assert pot.ytdlp_args({}) == ["--extractor-args", "youtube:player_client=default,mweb"]


async def test_off_restarted_when_it_stops_and_stopped_for_good(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "server"
    (home / "src").mkdir(parents=True)
    (home / "src" / "main.ts").write_text("")
    count = tmp_path / "starts"
    deno = tmp_path / "deno"
    deno.write_text(f'#!/bin/sh\necho "$DENO_DIR" >> {count}\nexit 3\n')
    deno.chmod(deno.stat().st_mode | stat.S_IEXEC)

    assert pot.from_env({"CF_STORIES_POT": "off", "CF_STORIES_POT_HOME": str(home)}) is None
    assert pot.from_env({"CF_STORIES_POT_HOME": str(tmp_path / "nowhere")}) is None
    assert await pot.start({"CF_STORIES_POT": "off", "CF_STORIES_POT_HOME": str(home)}) is None
    assert await pot.ready(0.1) is True  # nothing to wait for

    server = pot.from_env({"CF_STORIES_POT_HOME": str(home), "CF_STORIES_POT_DENO": str(deno),
                           "CF_STORIES_POT_DENO_DIR": "/opt/cache"})  # fmt: skip
    assert server is not None
    server.backoff = 0.01
    monkeypatch.setattr(pot, "PORT", 1)  # nothing listens there
    server.start()
    try:
        for _ in range(200):
            if count.is_file() and len(count.read_text().split()) >= 3:
                break
            await asyncio.sleep(0.02)
        assert count.read_text().split()[:3] == ["/opt/cache"] * 3  # it exited and was started again, its own cache
        assert await server.ready(0.3) is False
    finally:
        await server.stop()
    n = len(count.read_text().split())
    await asyncio.sleep(0.1)
    assert len(count.read_text().split()) == n  # stopped for good


async def test_it_starts_only_when_a_youtube_link_asks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[object] = []

    async def start(env: object = None) -> None:
        started.append(env)

    monkeypatch.setattr(pot, "start", start)
    pot.configure({"CF_STORIES_POT": "off"})
    try:
        assert started == []  # configure only remembers
        assert await pot.ready(0.01) is True
        assert started == [{"CF_STORIES_POT": "off"}]
    finally:
        pot._config.clear()


async def test_ping_reads_a_real_http_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handle(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        await r.readline()
        w.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"version":"2.0.2"}')
        await w.drain()
        w.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    monkeypatch.setattr(pot, "PORT", server.sockets[0].getsockname()[1])
    try:
        assert await pot.ping() is True
    finally:
        server.close()
        await server.wait_closed()


def test_the_providers_line_keeps_unavailable_with_its_provider() -> None:
    line = (
        "[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.2 (external), "
        "bgutil:script-node-2.0.2 (external, unavailable), bgutil:script-deno-2.0.2 (external, unavailable)"
    )
    assert pot.providers_of(line) == {
        "bgutil:http-2.0.2": {"external"},
        "bgutil:script-node-2.0.2": {"external", "unavailable"},
        "bgutil:script-deno-2.0.2": {"external", "unavailable"},
    }
    assert pot.providers_of("no providers here") == {}
