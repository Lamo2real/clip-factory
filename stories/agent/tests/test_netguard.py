"""The egress guard of a reference fetch (docs/CONTRACTS.md §45.40): CONNECT to port 443 only, every address public and
the tunnel made to the checked address itself, every byte that comes in counted against the cap. No network: a fake
resolver, and an opener that reaches a local stand-in for the far end while recording the address it was given."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest

from lamostories_agent import netguard

PUBLIC = "93.184.216.34"


class Far:
    """The far end: answers ``reply`` to whatever comes, then echoes; ``opened`` records the address of each tunnel."""

    def __init__(self, reply: bytes = b"hello") -> None:
        self.reply = reply
        self.opened: list[tuple[str, int]] = []
        self.port = 0
        self.server: asyncio.Server | None = None

    async def start(self) -> None:
        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            writer.write(self.reply)
            await writer.drain()
            while data := await reader.read(1024):
                writer.write(data)
                await writer.drain()
            writer.close()

        self.server = await asyncio.start_server(serve, "127.0.0.1", 0)
        self.port = int(self.server.sockets[0].getsockname()[1])

    async def opener(
        self, address: str, port: int, seconds: float
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        self.opened.append((address, port))
        return await asyncio.open_connection("127.0.0.1", self.port)


def resolver(answers: dict[str, list[str]]) -> Callable[[str], list[str]]:
    def resolve(host: str) -> list[str]:
        if host not in answers:
            raise OSError("no such host")
        return answers[host]

    return resolve


@pytest.fixture
async def far() -> AsyncIterator[Far]:
    found = Far()
    await found.start()
    yield found
    assert found.server is not None
    found.server.close()


async def rest(reader: asyncio.StreamReader) -> bytes:
    """Whatever comes until the guard closes the connection (a reset is a close too)."""
    try:
        return await asyncio.wait_for(reader.read(), 5)
    except ConnectionResetError:
        return b""


async def ask(guard: netguard.Guard, line: str) -> tuple[str, asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_connection("127.0.0.1", guard.port)
    writer.write(f"{line}\r\nHost: x\r\n\r\n".encode())
    await writer.drain()
    status = (await asyncio.wait_for(reader.readline(), 5)).decode().strip()
    return status, reader, writer


ANSWERS = {
    "video.example": [PUBLIC],
    "inner.example": ["10.1.2.3"],
    "rebind.example": [PUBLIC, "10.0.0.1"],
    "meta.example": ["169.254.170.2"],
}


async def test_a_public_host_on_443_is_tunnelled_to_the_checked_address(far: Far) -> None:
    async with netguard.Guard(cap=10_000, resolve=resolver(ANSWERS), opener=far.opener) as g:
        assert g.url == f"http://127.0.0.1:{g.port}"
        status, reader, writer = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        assert status == "HTTP/1.1 200 Connection established"
        assert await asyncio.wait_for(reader.readexactly(2), 5) == b"\r\n"  # the end of the 200 answer
        assert await asyncio.wait_for(reader.readexactly(5), 5) == b"hello"
        writer.write(b"ping")
        await writer.drain()
        assert await asyncio.wait_for(reader.readexactly(4), 5) == b"ping"
        writer.close()
    assert far.opened == [(PUBLIC, 443)]  # the address that was checked, never the name again
    assert (g.received, g.over, g.refused) == (9, False, 0)


@pytest.mark.parametrize(
    ("line", "status"),
    [
        ("CONNECT 127.0.0.1:443 HTTP/1.1", "403"),
        ("CONNECT localhost:443 HTTP/1.1", "403"),
        ("CONNECT 10.0.0.7:443 HTTP/1.1", "403"),
        ("CONNECT inner.example:443 HTTP/1.1", "403"),
        ("CONNECT 169.254.169.254:443 HTTP/1.1", "403"),
        ("CONNECT meta.example:443 HTTP/1.1", "403"),
        ("CONNECT [fd00:ec2::254]:443 HTTP/1.1", "403"),
        ("CONNECT [::1]:443 HTTP/1.1", "403"),
        ("CONNECT rebind.example:443 HTTP/1.1", "403"),  # one answer private: refused, not tried in turn
        ("CONNECT video.example:80 HTTP/1.1", "405"),
        ("CONNECT video.example:8443 HTTP/1.1", "405"),
        ("GET http://video.example/ HTTP/1.1", "405"),
        ("GET / HTTP/1.1", "405"),
        ("POST video.example:443 HTTP/1.1", "405"),
        ("CONNECT unknown.example:443 HTTP/1.1", "502"),
    ],
)
async def test_everything_else_is_refused_and_nothing_is_opened(far: Far, line: str, status: str) -> None:
    async with netguard.Guard(cap=10_000, resolve=resolver(ANSWERS), opener=far.opener) as g:
        got, reader, writer = await ask(g, line)
        assert got.split(" ")[1] == status, got
        await rest(reader)  # and the connection is closed
        writer.close()
    assert far.opened == []
    assert g.refused == 1


async def test_past_the_cap_every_tunnel_is_closed(far: Far) -> None:
    far.reply = b"x" * 50_000
    async with netguard.Guard(cap=20_000, resolve=resolver(ANSWERS), opener=far.opener) as g:
        _, r1, w1 = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        _, r2, w2 = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        got = [len(await rest(r)) for r in (r1, r2)]
        w1.close()
        w2.close()
        assert g.over is True
        assert sum(got) < 50_000 * 2  # never all of it
        status, _, w3 = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        assert status.split(" ")[1] == "403"  # nothing more once over
        w3.close()
    assert g.received > g.cap


async def test_at_most_max_tunnels_and_an_idle_one_is_closed(far: Far) -> None:
    async with netguard.Guard(cap=10_000, resolve=resolver(ANSWERS), opener=far.opener, max_tunnels=1,
                              idle_timeout=0.3) as g:  # fmt: skip
        s1, r1, w1 = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        s2, _, w2 = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        assert (s1.split(" ")[1], s2.split(" ")[1]) == ("200", "503")
        await rest(r1)  # idle: closed by the guard
        w1.close()
        w2.close()


async def test_the_log_names_hosts_and_counts_never_paths(far: Far, capsys: pytest.CaptureFixture[str]) -> None:
    async with netguard.Guard(cap=10_000, resolve=resolver(ANSWERS), opener=far.opener) as g:
        _, reader, writer = await ask(g, "CONNECT video.example:443 HTTP/1.1")
        await asyncio.wait_for(reader.readexactly(7), 5)
        writer.close()
        await ask(g, "GET http://video.example/secret/path?token=abc HTTP/1.1")
    lines: list[dict[str, Any]] = [json.loads(ln) for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")]
    text = json.dumps(lines)
    assert "secret" not in text and "token" not in text
    (summary,) = [ln for ln in lines if ln["event"] == "stories.fetch_egress"]
    assert summary["hosts"] == {"video.example": 5} and summary["refused"] == 1
