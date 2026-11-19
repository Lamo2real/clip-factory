"""``web_fetch`` for Ask, with an SSRF guard (docs/CONTRACTS.md §28.3).

Only https; every host is resolved and every address must be public (no private, loopback, link-local, CGNAT,
multicast, reserved or metadata address, and no IPv6 form that carries an IPv4 address inside: NAT64, 6to4,
Teredo), checked again on each of at most 3 redirects; one deadline for the whole fetch (DNS, connect, every redirect
and every read, at most 10 s and never past the answer's own budget), at most 2 MB of body; ``text/html``, ``text/plain``, ``application/json`` and ``application/pdf`` only; a fixed generic
User-Agent and no cookies or auth headers. The connection goes to the address that was checked (the Host header and
TLS server name stay the host name), so DNS cannot change between the check and the request.

HTML becomes readable text (scripts, styles, nav, header and footer dropped), at most 40,000 characters.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import socket
import ssl
import time
import urllib.parse
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from html.parser import HTMLParser

TIMEOUT_S = 6.0  # the most one request may take
FETCH_BUDGET_S = 10.0  # the most one whole fetch (DNS, redirects, reads) may take
DNS_TIMEOUT_S = 2.0
READ_CHUNK = 64 * 1024
MAX_BYTES = 2_000_000
MAX_PDF_BYTES = 2_000_000
MAX_REDIRECTS = 3
MAX_TEXT = 40_000
USER_AGENT = "Mozilla/5.0 (compatible; ClipFactoryAsk/1.0)"
TYPES = ("text/html", "text/plain", "application/json", "application/pdf")
_DROP_TAGS = frozenset({"script", "style", "nav", "footer", "header", "noscript", "svg", "form", "iframe", "template"})
_BLOCK_TAGS = frozenset({"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre"})
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
# IPv6 ranges that carry or translate to an IPv4 address (NAT64, local NAT64, 6to4, Teredo): never fetched.
_V4_IN_V6 = tuple(
    ipaddress.ip_network(n) for n in ("64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32", "::/96")
)
_dns = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ask-dns")


class FetchError(Exception):
    """A plain-words reason for the tool result (never contains the URL)."""


@dataclass(frozen=True)
class Page:
    url: str
    title: str
    kind: str  # "text" or "pdf"
    text: str = ""
    data: bytes = b""


Resolver = Callable[[str], list[str]]


def resolve(host: str, timeout: float = DNS_TIMEOUT_S) -> list[str]:
    """The host's addresses, with a timeout (``getaddrinfo`` itself has none, so it runs on a small pool)."""
    future = _dns.submit(socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM)
    try:
        infos = future.result(timeout=max(0.1, timeout))
    except FutureTimeout:
        raise FetchError("that site took too long to find") from None
    except OSError:
        raise FetchError("that site could not be found") from None
    return sorted({str(info[4][0]) for info in infos})


def public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None or ip.teredo is not None or any(ip in n for n in _V4_IN_V6):
            return False
    if ip in _CGNAT:
        return False
    return bool(ip.is_global) and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def normalise(url: str) -> str | None:
    """https URL without fragment, or None. An http URL is upgraded."""
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        return None
    if parts.port not in {None, 443, 80}:
        return None
    host = parts.hostname.lower()
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return None
    path = parts.path or "/"
    return urllib.parse.urlunsplit(("https", host, path, parts.query, ""))


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _DROP_TAGS:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _DROP_TAGS and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_text(html: str) -> tuple[str, str]:
    """(title, readable text)."""
    parser = _Text()
    with contextlib.suppress(Exception):  # a broken page still gives what was read so far
        parser.feed(html)
        parser.close()
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    text = "\n".join(line for line in lines if line)
    return " ".join(parser.title.split())[:200], text[:MAX_TEXT]


# (address, host, path+query, seconds left for this request) → (status, headers lower-cased, body ≤ MAX_BYTES + 1)
Opener = Callable[[str, str, str, float], tuple[int, dict[str, str], bytes]]


def https_open(address: str, host: str, target: str, timeout: float) -> tuple[int, dict[str, str], bytes]:
    """One GET to a checked address. ``timeout`` is the whole request's time (connect, TLS, headers and every read),
    not a per-read timeout, so a page that trickles one byte at a time still ends on time."""
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
        conn.request(
            "GET",
            target,
            headers={"Host": host, "User-Agent": USER_AGENT, "Accept": ", ".join(TYPES), "Accept-Encoding": "identity"},
        )
        sock.settimeout(left())
        response = conn.getresponse()
        headers = {k.lower(): v for k, v in response.getheaders()}
        chunks: list[bytes] = []
        size = 0
        while size <= MAX_BYTES:
            sock.settimeout(left())
            chunk = response.read1(READ_CHUNK) if hasattr(response, "read1") else response.read(READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        conn.close()
        return response.status, headers, b"".join(chunks)[: MAX_BYTES + 1]
    finally:
        raw.close()


def fetch(
    url: str,
    *,
    resolver: Resolver | None = None,
    opener: Opener = https_open,
    budget: float = FETCH_BUDGET_S,
    clock: Callable[[], float] = time.monotonic,
    allow: Callable[[str], bool] | None = None,
) -> Page:
    """One page, with one deadline for everything (``budget`` seconds, at most ``FETCH_BUDGET_S``). With ``allow``,
    every redirect hop must pass it too, or the fetch stops before that hop is opened (§28.3: a page Ask opened only
    because it is official may not bounce it to another site, for example through a link shim)."""
    deadline = clock() + min(budget, FETCH_BUDGET_S)

    def left(cap: float) -> float:
        remaining = deadline - clock()
        if remaining <= 0.05:
            raise FetchError("that page took too long")
        return min(cap, remaining)

    current = normalise(url)
    if current is None:
        raise FetchError("that link can't be opened")
    for _ in range(MAX_REDIRECTS + 1):
        parts = urllib.parse.urlsplit(current)
        host = parts.hostname or ""
        addresses = resolver(host) if resolver is not None else resolve(host, left(DNS_TIMEOUT_S))
        if not addresses or not all(public_address(a) for a in addresses):
            raise FetchError("that site is not on the public web")
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        try:
            status, headers, body = opener(addresses[0], host, target, left(TIMEOUT_S))
        except FetchError:
            raise
        except TimeoutError:
            raise FetchError("that page took too long") from None
        except Exception:
            raise FetchError("that page could not be read") from None
        if status in {301, 302, 303, 307, 308}:
            nxt = normalise(urllib.parse.urljoin(current, headers.get("location", "")))
            if nxt is None or (allow is not None and not allow(nxt)):
                raise FetchError("that page sent me somewhere I can't go")
            current = nxt
            continue
        if status != 200:
            raise FetchError(f"that page answered {status}")
        if len(body) > MAX_BYTES:
            raise FetchError("that page is too big")
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype not in TYPES:
            raise FetchError("that kind of page can't be read")
        if ctype == "application/pdf":
            if not body.startswith(b"%PDF-"):
                raise FetchError("that PDF is damaged")
            return Page(current, parts.path.rsplit("/", 1)[-1] or host, "pdf", data=body)
        charset = "utf-8"
        for piece in headers.get("content-type", "").split(";")[1:]:
            if piece.strip().lower().startswith("charset="):
                charset = piece.split("=", 1)[1].strip() or "utf-8"
        try:
            text = body.decode(charset, errors="replace")
        except LookupError:
            text = body.decode("utf-8", errors="replace")
        if ctype == "text/html":
            title, readable = html_text(text)
            return Page(current, title or host, "text", text=readable)
        return Page(current, host, "text", text=text[:MAX_TEXT])
    raise FetchError("that page sent me around too many times")
