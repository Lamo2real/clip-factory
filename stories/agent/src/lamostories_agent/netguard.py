"""The egress guard of a reference fetch (docs/CONTRACTS.md §45.40, ADR-88): every byte a fetch reads from the
internet goes through one CONNECT-only proxy on ``127.0.0.1``, started for that fetch on a random port and closed
after it.

* Only ``CONNECT host:443``. Any other method, an absolute-URI request (plain http) or any other port gets ``405`` and
  the connection is closed, so the fetch is https only.
* The host must pass ``config.safe_host``; it is resolved off the event loop (10 s at most) and every address must pass
  ``config.public_ip`` (no loopback, private, link-local such as 169.254.169.254 and 169.254.170.2, ``fd00:ec2::/32``,
  multicast, reserved or unspecified address). The tunnel then connects to the checked address itself, so a name that
  answers differently a moment later (DNS rebinding) never reaches a private address.
* Every redirect and every CDN hop is a new CONNECT, so each one is checked again.
* All bytes coming in, across all tunnels, are counted; past ``cap`` every tunnel is closed and ``over`` is set, so the
  size limit holds while streaming even when Content-Length is wrong or missing.
* A tunnel where neither way has moved for 60 s is closed (a download that only streams in is never idle); at most 16
  connections are open at once, each counted from the moment it is accepted. Logs hold host names and counts only,
  never paths.

``async with Guard(cap=bytes) as g``: ``g.url`` (``http://127.0.0.1:{port}``) is the proxy for yt-dlp and for
``http.client``'s ``set_tunnel``; ``g.over`` and ``g.refused`` (how many CONNECTs were refused) say what happened."""

from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import Awaitable, Callable
from types import TracebackType
from typing import Final

from . import config
from .util import log

Resolver = Callable[[str], list[str]]
Opener = Callable[[str, int, float], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]

HEAD_MAX: Final = 8 * 1024
HEAD_SECONDS: Final = 10.0
RESOLVE_SECONDS: Final = 10.0
CHUNK: Final = 64 * 1024


def _resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


async def _open(address: str, port: int, seconds: float) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    return await asyncio.wait_for(asyncio.open_connection(address, port), seconds)


def _answer(status: int, reason: str) -> bytes:
    return f"HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()


def _target(line: str) -> tuple[str, int] | None:
    """``CONNECT host:port HTTP/1.x`` → ``(host, port)``; None for anything else (a GET, an absolute URI)."""
    parts = line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or not parts[2].startswith("HTTP/1."):
        return None
    host, colon, port = parts[1].rpartition(":")
    if not colon or not port.isdigit():
        return None
    host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    return (host.lower().rstrip("."), int(port)) if host else None


class Guard:
    def __init__(
        self,
        *,
        cap: int,
        resolve: Resolver = _resolve,
        connect_timeout: float = 10.0,
        idle_timeout: float = 60.0,
        max_tunnels: int = 16,
        opener: Opener = _open,
    ) -> None:
        self.cap = cap
        self._resolve = resolve
        self._connect_timeout = connect_timeout
        self._idle_timeout = idle_timeout
        self._max_tunnels = max_tunnels
        self._opener = opener
        self.received = 0
        self.over = False
        self.refused = 0
        self.tunnels = 0
        self.hosts: dict[str, int] = {}  # host → bytes in (the log line)
        self._server: asyncio.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self.port = 0

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def __aenter__(self) -> Guard:
        self._server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.port = int(self._server.sockets[0].getsockname()[1])
        return self

    async def __aexit__(
        self, kind: type[BaseException] | None, value: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.close()

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
        self._close_all()
        for task in list(self._tasks):
            task.cancel()
        for task in list(self._tasks):
            with contextlib.suppress(BaseException):
                await task
        if self._server is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), 5)
            self._server = None
        log("info", "stories.fetch_egress", bytes=self.received, over=self.over, refused=self.refused,
            hosts=dict(self.hosts))  # fmt: skip

    def _close_all(self) -> None:
        for writer in list(self._writers):
            with contextlib.suppress(Exception):
                writer.close()
        self._writers.clear()

    def _refuse(self, writer: asyncio.StreamWriter, status: int, reason: str, host: str = "") -> None:
        self.refused += 1
        log("warn", "stories.fetch_egress_refused", status=status, host=host[:253])
        with contextlib.suppress(Exception):
            writer.write(_answer(status, reason))
            writer.close()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        try:
            await self._serve(reader, writer)
        except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            pass
        finally:
            if task is not None:
                self._tasks.discard(task)
            with contextlib.suppress(Exception):
                writer.close()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.over:
            self._refuse(writer, 403, "Forbidden")
            return
        # The slot is taken as the connection is accepted, so CONNECTs arriving together never pass the limit.
        if self.tunnels >= self._max_tunnels:
            self._refuse(writer, 503, "Busy")
            return
        self.tunnels += 1
        try:
            await self._tunnel(reader, writer)
        finally:
            self.tunnels -= 1

    async def _tunnel(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_SECONDS)
        except asyncio.LimitOverrunError:
            self._refuse(writer, 405, "Method Not Allowed")
            return
        if len(head) > HEAD_MAX:
            self._refuse(writer, 405, "Method Not Allowed")
            return
        target = _target(head.split(b"\r\n", 1)[0].decode("latin-1"))
        if target is None or target[1] != 443:
            self._refuse(writer, 405, "Method Not Allowed", target[0] if target else "")
            return
        host = target[0]
        if not config.safe_host(host):
            self._refuse(writer, 403, "Forbidden", host)
            return
        try:
            addresses = await asyncio.wait_for(asyncio.to_thread(self._resolve, host), RESOLVE_SECONDS)
        except (OSError, TimeoutError, ValueError):
            self._refuse(writer, 502, "Bad Gateway", host)
            return
        if not addresses or not all(config.public_ip(a) for a in addresses):
            self._refuse(writer, 403, "Forbidden", host)
            return
        try:
            up_reader, up_writer = await self._opener(addresses[0], 443, self._connect_timeout)
        except (OSError, TimeoutError):
            self._refuse(writer, 502, "Bad Gateway", host)
            return
        self._writers.update((writer, up_writer))
        try:
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            moved = [asyncio.get_running_loop().time()]  # the tunnel's last byte, either way
            await asyncio.gather(self._pipe(reader, up_writer, None, moved), self._pipe(up_reader, writer, host, moved))
        finally:
            for w in (writer, up_writer):
                self._writers.discard(w)
                with contextlib.suppress(Exception):
                    w.close()

    async def _pipe(
        self, source: asyncio.StreamReader, sink: asyncio.StreamWriter, inbound: str | None, moved: list[float]
    ) -> None:
        """Copies one way until either side ends, or until the tunnel has been idle both ways for ``idle_timeout``
        (``moved``, shared by both ways: the request side of a download stays silent while its answer streams in);
        ``inbound`` (the host) counts what comes in."""
        loop = asyncio.get_running_loop()
        try:
            while True:
                left = self._idle_timeout - (loop.time() - moved[0])
                if left <= 0:
                    break
                try:
                    chunk = await asyncio.wait_for(source.read(CHUNK), left)
                except TimeoutError:
                    continue  # the other way may have moved meanwhile: looked at again above
                moved[0] = loop.time()
                if not chunk:
                    break
                if inbound is not None:
                    self.received += len(chunk)
                    self.hosts[inbound] = self.hosts.get(inbound, 0) + len(chunk)
                    if self.received > self.cap:
                        self.over = True
                        self._close_all()
                        break
                sink.write(chunk)
                await sink.drain()
        except (OSError, TimeoutError, asyncio.IncompleteReadError):
            pass
        finally:
            with contextlib.suppress(Exception):
                sink.close()
