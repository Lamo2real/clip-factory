"""Clips Funded's own PO token sidecar (docs/CONTRACTS.md §45.40, ADR-88): bgutil-ytdlp-pot-provider's HTTP server, run
with the image's Deno on 127.0.0.1:4416 inside this runtime, so yt-dlp's ``default`` and ``mweb`` YouTube clients get
the token YouTube asks cloud addresses for when a reference link is a YouTube video.

Copied from Clip Factory's ``clipfactory_agent/pot.py`` (ADR-52), never imported (ADR-76); it shares nothing with Clip
Factory's runtime: no cookies, no proxy secret, no tokens, its own process in this container. The server only listens
on loopback and gets no write permission; it reaches YouTube only through the fetch's own egress guard (the plugin hands
it the guard as its proxy). It starts the first time a YouTube link is fetched (nothing else runs Deno for it); if it
stops, a supervisor starts it again with a growing pause, and while it is down yt-dlp falls back to the plugin's script
mode by itself. ``CF_STORIES_POT=off`` starts nothing (tests, or an emergency)."""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
from collections.abc import Mapping
from pathlib import Path

from .util import log

HOST = "127.0.0.1"
PORT = 4416
MAX_BACKOFF = 60.0
# The image's own settings (stories/agent/Dockerfile): the server's folder, its read-only Deno cache.
HOME_ENV = "CF_STORIES_POT_HOME"
DENO_DIR_ENV = "CF_STORIES_POT_DENO_DIR"


def command(home: Path, deno: str = "deno") -> list[str]:
    modules = home / "node_modules"
    return [
        deno,
        "run",
        "--allow-env",
        "--allow-net",
        f"--allow-ffi={modules}",
        f"--allow-read={modules}",
        str(home / "src" / "main.ts"),
        "--host",
        HOST,
        "--port",
        str(PORT),
    ]


def deno_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """``DENO_DIR`` for anything that runs the server's code (the server, the plugin's script mode): its own cache,
    built into the image, so it never fetches a module at run time. Empty when the image has none."""
    e = os.environ if env is None else env
    folder = e.get(DENO_DIR_ENV) or ""
    return {"DENO_DIR": folder} if folder else {}


def ytdlp_args(env: Mapping[str, str] | None = None) -> list[str]:
    """What a YouTube call adds: yt-dlp's default clients plus mweb (ADR-52), and the script mode's folder as the
    backup when the server is down (the HTTP provider needs no arguments: it asks 127.0.0.1:4416)."""
    e = os.environ if env is None else env
    out = ["--extractor-args", "youtube:player_client=default,mweb"]
    home = e.get(HOME_ENV) or ""
    if home:
        out += ["--extractor-args", f"youtubepot-bgutilscript:server_home={home}"]
    return out


async def ping(within: float = 2.0) -> bool:
    """True when the server answers GET /ping."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(HOST, PORT), within)
    except (OSError, TimeoutError):
        return False
    try:
        writer.write(f"GET /ping HTTP/1.0\r\nHost: {HOST}\r\n\r\n".encode())
        await writer.drain()
        head = await asyncio.wait_for(reader.readline(), within)
        return b" 200 " in head
    except (OSError, TimeoutError):
        return False
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()


class PotServer:
    def __init__(self, home: Path, deno: str = "deno", backoff: float = 1.0, env: Mapping[str, str] | None = None):
        self.home = home
        self.deno = deno
        self.backoff = backoff
        self.starts = 0
        self._env = dict(env or {})
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._supervise())

    async def _supervise(self) -> None:
        pause = self.backoff
        while True:
            try:
                self.starts += 1
                self._proc = await asyncio.create_subprocess_exec(
                    *command(self.home, self.deno),
                    start_new_session=True,  # its own process group: stop() kills all of it
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env={**os.environ, **self._env, "DENO_NO_UPDATE_CHECK": "1", "DENO_NO_PROMPT": "1"},
                )
                code = await self._proc.wait()
                log("warn", "stories.pot_exit", code=code, starts=self.starts)
            except OSError as e:
                log("warn", "stories.pot_exit", error=type(e).__name__, starts=self.starts)
            await asyncio.sleep(pause)
            pause = min(MAX_BACKOFF, pause * 2)

    async def ready(self, within: float = 10.0) -> bool:
        loop = asyncio.get_running_loop()
        until = loop.time() + within
        while True:
            if await ping():
                return True
            if loop.time() >= until:
                return False
            await asyncio.sleep(0.25)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        if self._proc is not None:
            from .proc import kill_group

            await kill_group(self._proc, grace=2.0)  # Deno and anything it started
        self._proc = None


def from_env(env: Mapping[str, str] | None = None) -> PotServer | None:
    """The sidecar this container should run, or None (``CF_STORIES_POT=off``, or no server folder with a main.ts)."""
    e = os.environ if env is None else env
    if (e.get("CF_STORIES_POT") or "on").strip().lower() == "off":
        return None
    home = e.get(HOME_ENV) or ""
    if not home or not (Path(home) / "src" / "main.ts").is_file():
        return None
    return PotServer(Path(home), deno=e.get("CF_STORIES_POT_DENO") or "deno", env=deno_env(e))


_running: list[PotServer] = []  # the container's one sidecar, while the app runs
_config: list[Mapping[str, str] | None] = []  # set by configure(): the sidecar may start when a YouTube link asks


def configure(env: Mapping[str, str] | None = None) -> None:
    """Remembers how to start the sidecar, without starting it: ``ready()`` starts it the first time a YouTube link
    needs it (a story, a chat or an uploaded reference never runs it)."""
    _config.clear()
    _config.append(env)


async def ensure_started() -> PotServer | None:
    """The sidecar, started now if the app configured one and it is not running yet."""
    if _running:
        return _running[0]
    if not _config:
        return None
    return await start(_config[0])


async def start(env: Mapping[str, str] | None = None) -> PotServer | None:
    await stop()
    server = from_env(env)
    if server is None:
        log("info", "stories.pot_off")
        return None
    server.start()
    _running.append(server)
    return server


async def stop() -> None:
    while _running:
        await _running.pop().stop()


async def ready(within: float = 10.0) -> bool:
    """Starts the sidecar if it is not running (only YouTube links ask), then waits at most ``within`` seconds (never
    more than 10) for it. True with no sidecar: there is nothing to wait for, and yt-dlp's script mode or no token at
    all is what happens then."""
    await ensure_started()
    if not _running:
        return True
    ok = await _running[0].ready(min(within, 10.0))
    if not ok:
        log("warn", "stories.pot_not_ready")
    return ok


_PROVIDER = re.compile(r"([\w.-]+:[\w.-]+)(?:\s*\(([^)]*)\))?")


def providers_of(line: str) -> dict[str, set[str]]:
    """yt-dlp's ``PO Token Providers: a-1 (external), b-2 (external, unavailable)`` line as {name: tags}. A tag list
    holds commas of its own, so the line is read provider by provider, never split on every comma."""
    listed = line.split("PO Token Providers:", 1)[1] if "PO Token Providers:" in line else ""
    return {
        m.group(1): {t.strip() for t in (m.group(2) or "").split(",") if t.strip()} for m in _PROVIDER.finditer(listed)
    }


async def self_check(env: Mapping[str, str] | None = None) -> list[str]:
    """What the image build checks (``python -m lamostories_agent.pot``): yt-dlp lists both bgutil providers as usable,
    and the server starts and answers /ping. Returns the problems found; none means it works. Never reaches YouTube:
    yt-dlp is pointed at a dead local proxy, and the provider list is printed before the first request."""
    problems: list[str] = []
    e = dict(os.environ if env is None else env)
    home = e.get(HOME_ENV)
    if not home:
        return [f"{HOME_ENV} is not set"]
    run = await asyncio.create_subprocess_exec(
        "yt-dlp",
        "-v",
        "--simulate",
        "--ignore-config",
        "--no-cache-dir",
        "--retries",
        "0",
        "--extractor-retries",
        "0",
        "--proxy",
        "http://127.0.0.1:9",
        *ytdlp_args(e),
        "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
        env={**e, **deno_env(e)},
    )
    out, _ = await asyncio.wait_for(run.communicate(), 120)
    line = next((ln for ln in out.decode("utf-8", "replace").splitlines() if "PO Token Providers:" in ln), "")
    print(line.strip() or "yt-dlp printed no PO Token Providers line")
    providers = providers_of(line)
    if not any(name.startswith("bgutil:http-") and "unavailable" not in tags for name, tags in providers.items()):
        problems.append("yt-dlp does not list bgutil:http as usable")
    if not any(
        name.startswith("bgutil:script-deno-") and "unavailable" not in tags for name, tags in providers.items()
    ):
        problems.append("yt-dlp lists bgutil:script-deno as unavailable (or not at all)")
    server = from_env(e)
    if server is None:
        problems.append("no PO token server (CF_STORIES_POT=off or no src/main.ts)")
        return problems
    server.start()
    try:
        if not await server.ready(60):
            problems.append("the PO token server did not answer /ping")
    finally:
        await server.stop()
    return problems


def main() -> None:
    import sys

    problems = asyncio.run(self_check())
    for p in problems:
        print(f"PO token check: {p}", file=sys.stderr)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
