"""Outside files for ``cf-prod-campaigns``: logos, brand pictures and public Google Docs (docs/CONTRACTS.md §38.10).

Every hop goes through the SSRF guard of ``ask/fetch.py`` (https only, every address public, the connection made to
the checked address), at most 3 redirects, and each hop must pass the caller's ``allow`` (host allow-lists); no
cookies or auth headers; one deadline for the whole fetch; a byte cap.
"""

from __future__ import annotations

import http.client
import socket
import ssl
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass

from ..ask import fetch as guard

USER_AGENT = "ClipFactory/1"
MAX_REDIRECTS = 3
READ_CHUNK = 64 * 1024

# (address, host, path+query, seconds left, max bytes) → (status, headers lower-cased, body ≤ max + 1)
Opener = Callable[[str, str, str, float, int], tuple[int, dict[str, str], bytes]]
Resolver = Callable[[str], list[str]]


class FetchFail(Exception):
    """``reason``: ``host`` (a hop off the allow-list), ``private`` (not a public address), ``status``, ``too_big``,
    ``timeout``, ``network``, ``redirects``, ``signin`` (a redirect to a sign-in page)."""

    def __init__(self, reason: str, location: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.location = location


@dataclass(frozen=True)
class Fetched:
    url: str
    status: int
    content_type: str
    body: bytes


def https_open(
    address: str, host: str, target: str, timeout: float, max_bytes: int
) -> tuple[int, dict[str, str], bytes]:
    deadline = time.monotonic() + timeout

    def left() -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        return remaining

    context = ssl.create_default_context()
    raw = socket.create_connection((address, 443), timeout=left())
    try:
        sock = context.wrap_socket(raw, server_hostname=host)
        conn = http.client.HTTPConnection(host, 443, timeout=left())
        conn.sock = sock
        conn.request("GET", target, headers={"Host": host, "User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
        sock.settimeout(left())
        response = conn.getresponse()
        headers = {k.lower(): v for k, v in response.getheaders()}
        chunks: list[bytes] = []
        size = 0
        while size <= max_bytes:
            sock.settimeout(left())
            chunk = response.read1(READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        conn.close()
        return response.status, headers, b"".join(chunks)[: max_bytes + 1]
    finally:
        raw.close()


def get(
    url: str,
    *,
    allow: Callable[[str], bool],
    max_bytes: int,
    budget: float,
    signin: Callable[[str], bool] = lambda _url: False,
    resolver: Resolver | None = None,
    opener: Opener = https_open,
    clock: Callable[[], float] = time.monotonic,
) -> Fetched:
    deadline = clock() + budget
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if not current.startswith("https://") or not allow(current):
            raise FetchFail("host", current)
        parts = urllib.parse.urlsplit(current)
        host = (parts.hostname or "").lower()
        try:
            addresses = resolver(host) if resolver is not None else guard.resolve(host)
        except guard.FetchError as e:
            raise FetchFail("network") from e
        if not addresses or not all(guard.public_address(a) for a in addresses):
            raise FetchFail("private")
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        left = deadline - clock()
        if left <= 0.05:
            raise FetchFail("timeout")
        try:
            status, headers, body = opener(addresses[0], host, target, left, max_bytes)
        except TimeoutError as e:
            raise FetchFail("timeout") from e
        except Exception as e:
            raise FetchFail("network") from e
        if status in {301, 302, 303, 307, 308}:
            nxt = urllib.parse.urljoin(current, headers.get("location", ""))
            if signin(nxt):
                raise FetchFail("signin", nxt)
            current = nxt
            continue
        if status != 200:
            raise FetchFail("status")
        if len(body) > max_bytes:
            raise FetchFail("too_big")
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        return Fetched(current, status, ctype, body)
    raise FetchFail("redirects")


def host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def host_in(url: str, exact: set[str] | frozenset[str], suffixes: tuple[str, ...] = ()) -> bool:
    """https, port 443 only, and the host is one of ``exact`` or ends with one of ``suffixes`` at a dot boundary."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.port not in (None, 443) or parts.username or parts.password:
        return False
    host = (parts.hostname or "").lower()
    return host in exact or any(host.endswith(s) and s.startswith(".") for s in suffixes)
