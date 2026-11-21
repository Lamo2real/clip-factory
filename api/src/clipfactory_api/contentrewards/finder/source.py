"""The polite reader of Content Rewards' public pages (docs/CONTRACTS.md §41.2).

Exactly three kinds of URL, nothing else, ever: ``/robots.txt`` (at most once a day, a failed try included),
``/sitemap.xml`` (and at most 5 child ``.xml`` sitemaps its index names) and ``/c/campaigns/{uuid}`` (the plan, at most
40 a look). Every request is a ``GET`` through ``fetch.get`` (§38.10's SSRF guard: https only, public addresses only, at
most 3 redirects), one at a time, at least 1 s between the starts of two requests, ``User-Agent: ClipFactory/1``, no
cookie, no ``Authorization``, no ``Referer``; every hop must be ``contentrewards.com`` on port 443, one of those exact
paths (no query, no ``%``, no dot segment) **and** a path the stored robots.txt allows. Never an ``/api/`` path, never
``/c/discover``, never a ``?group=1`` page, even when a redirect points there. The status and ``Retry-After`` of a
non-200 answer are taken by this module's own ``opener`` wrapper around ``fetch.https_open`` (``fetch.py`` is
unchanged). The network and the clocks are passed in, so tests never look anything up. Backoffs are written to
``CRPUBLIC/STATE`` the moment a 429, 503, 403 or challenge arrives.
"""

from __future__ import annotations

import email.utils
import re
import time
import urllib.parse
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from ... import db
from ...clock import iso, parse
from ...log import log
from .. import fetch, links, public
from ..util import obj
from . import config, normalize, robots, rsc, sitemap
from .sitemap import Entry

Item = dict[str, Any]
PK = "CRPUBLIC"
STATE_SK = "STATE"
CAMP_PREFIX = "CAMP#"
PUB_PREFIX = "PUB#"
_PAGE = re.compile(r"/c/campaigns/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def campaign_id(value: object) -> str | None:
    """A uuid as a lower-case string, else ``None`` (brand data names group siblings: never read anything else)."""
    if not isinstance(value, str) or not links.UUID.match(value):
        return None
    return value.lower()


def camp_sk(uuid: str) -> str:
    return f"{CAMP_PREFIX}{uuid}"


def pub_sk(uuid: str) -> str:
    return f"{PUB_PREFIX}{uuid}"


def page_url(uuid: str) -> str:
    return f"{config.SITE}{config.PAGE_PATH}{uuid}"


def _ttl(at: datetime) -> int:
    return int((at + config.CACHE_TTL).timestamp())


# --- the plan (pure) -----------------------------------------------------------------------------------------------


def _at(item: Mapping[str, Any], name: str) -> datetime | None:
    return parse(item.get(name))


def _older(item: Mapping[str, Any], now: datetime, age: timedelta, name: str = "readAt") -> bool:
    at = _at(item, name)
    return at is None or now - at > age


def _last_try(item: Mapping[str, Any]) -> datetime | None:
    times = [t for t in (_at(item, "readAt"), _at(item, "triedAt")) if t is not None]
    return max(times) if times else None


def never_read(item: Mapping[str, Any] | None) -> bool:
    """No ``CAMP#`` item, or only failed tries (no card, no read) fewer than 3."""
    if item is None:
        return True
    return item.get("readAt") is None and int(item.get("fails") or 0) < config.FAILS_OFF


def plan(
    entries: list[Entry],
    cache: Mapping[str, Mapping[str, Any]],
    matched: Iterable[str],
    now: datetime,
    cap: int = config.PAGES_PER_LOOK,
) -> list[str]:
    """The pages this look reads, in order, without repeats, at most ``cap`` (§41.2 "The plan"). A sitemap
    ``lastmod`` is the first listing and never moves, so it only orders pages never read; freshness comes from
    reading pages again. Every sitemap entry can be read (no age window)."""
    out: list[str] = []
    seen: set[str] = set()

    def take(uuids: Iterable[str]) -> bool:
        for uuid in uuids:
            if len(out) >= cap:
                return True
            if uuid not in seen:
                seen.add(uuid)
                out.append(uuid)
        return len(out) >= cap

    listed = dict(entries)
    siblings: list[str] = []
    for item in cache.values():
        for g in (item.get("card") or {}).get("groupIds") or []:
            sibling = campaign_id(g)
            if sibling is not None and sibling not in listed and sibling not in siblings:
                siblings.append(sibling)
    eligible = set(listed) | set(siblings)

    def oldest(uuids: Iterable[str], name: str = "readAt") -> list[str]:
        def key(u: str) -> tuple[float, str]:
            at = _last_try(cache[u]) if name == "try" else _at(cache[u], name)
            return (at.timestamp() if at else 0.0, u)

        return sorted(uuids, key=key)

    # 1. current matches whose read is older than 12 hours (at most 10), oldest read first
    current = [c for c in (campaign_id(m) for m in matched) if c is not None]
    stale = [
        u
        for u in dict.fromkeys(current)
        if u in cache and u in eligible and cache[u].get("readAt") and _older(cache[u], now, config.MATCH_STALE)
    ]
    if take(oldest(stale)[: config.MATCH_STALE_MAX]):
        return out
    # 2. never read: sitemap entries newest lastmod first, then missing group siblings in the order found
    fresh = [u for u, _m in entries if never_read(cache.get(u))]
    fresh.sort(key=lambda u: (listed[u] is None, -(listed[u] or 0), u))
    if take(fresh) or take(u for u in siblings if never_read(cache.get(u))):
        return out
    # 3. live cards read more than 2 days ago, oldest read first
    live = [
        u
        for u in eligible
        if (live_item := cache.get(u)) is not None
        and live_item.get("state") == "ok"
        and (live_item.get("card") or {}).get("onDiscover") is True
        and int(live_item.get("fails") or 0) < config.FAILS_OFF
        and live_item.get("readAt")
        and _older(live_item, now, config.RECHECK_LIVE)
    ]
    if take(oldest(live)):
        return out
    # 4. not on Discover, unreadable, or failing (3 fails) cards read more than 14 days ago, oldest first
    off = []
    for u in eligible:
        off_item = cache.get(u)
        if off_item is None or never_read(off_item) or u in seen:
            continue
        failing = int(off_item.get("fails") or 0) >= config.FAILS_OFF
        not_live = off_item.get("state") == "ok" and (off_item.get("card") or {}).get("onDiscover") is not True
        if not (failing or not_live or off_item.get("state") == "unreadable"):
            continue
        last = _last_try(off_item)
        if last is None or now - last > config.RECHECK_OFF:
            off.append(u)
    if take(oldest(off, "try")):
        return out
    # 5. a gone page only when its sitemap lastmod changed (a new listing)
    take(
        u
        for u, m in entries
        if (gone := cache.get(u)) is not None and gone.get("state") == "gone" and gone.get("lastmod") != m
    )
    return out


# --- one look's network -------------------------------------------------------------------------------------------


class ReadFail(Exception):
    """``kind``: ``gone`` (404/410), ``throttled`` (429/503), ``blocked`` (403), ``failed`` (5xx, other status,
    timeout, network, too big, a refused hop)."""

    def __init__(self, kind: str, status: int | None = None, retry_after: float = 0.0) -> None:
        super().__init__(kind)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after


def retry_after(value: str | None, now: datetime) -> float:
    """Seconds from ``Retry-After`` (a number of seconds or an HTTP date); 0 when absent or unreadable."""
    if not value:
        return 0.0
    text = value.strip()
    if text.isdigit():
        return float(text)
    try:
        when = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return 0.0
    when = when if when.tzinfo else when.replace(tzinfo=UTC)
    return max(0.0, (when - now).total_seconds())


@dataclass
class Reader:
    """One look's requests: one at a time, ≥ 1 s between starts, each hop on ``contentrewards.com:443`` and allowed
    by the stored robots.txt. ``requests`` lists every URL asked for (hops included), for the logs' counts and tests."""

    get: Callable[..., fetch.Fetched]
    opener: fetch.Opener
    resolver: fetch.Resolver | None
    monotonic: Callable[[], float]
    sleep: Callable[[float], None]
    rules: robots.Robots | None = None
    children: frozenset[str] = frozenset()  # the child sitemaps' paths this look's index named
    requests: list[str] = field(default_factory=list)
    _last_start: float | None = None
    _status: int | None = None
    _headers: dict[str, str] = field(default_factory=dict)

    def allow(self, url: str) -> bool:
        """An exact allow-list (every hop of a redirect too): ``/robots.txt``; ``/sitemap.xml``, a child sitemap its
        index named or ``/c/campaigns/{uuid}``, each only when the stored robots.txt allows it. No query, no
        fragment, no ``%``, no ``.`` or ``..`` segment, never ``/api/``."""
        if not fetch.host_in(url, frozenset({config.HOST})):
            return False
        parts = urllib.parse.urlsplit(url)
        path = parts.path
        if parts.query or parts.fragment or "%" in path or path.startswith("/api/"):
            return False
        if any(segment in {".", ".."} for segment in path.split("/")):
            return False
        if path == "/robots.txt":
            return True
        known = path == "/sitemap.xml" or path in self.children or _PAGE.fullmatch(path) is not None
        return known and self.rules is not None and self.rules.allowed(path)

    def _open(
        self, address: str, host: str, target: str, timeout: float, max_bytes: int
    ) -> tuple[int, dict[str, str], bytes]:
        waited = 0.0
        if self._last_start is not None:
            wait = self._last_start + config.REQUEST_GAP - self.monotonic()
            if wait > 0:
                self.sleep(wait)
                waited = wait
        if timeout - waited <= 0.05:
            raise TimeoutError
        self._last_start = self.monotonic()
        self.requests.append(f"https://{host}{target}")
        status, headers, body = self.opener(address, host, target, timeout - waited, max_bytes)
        self._status, self._headers = status, dict(headers)
        return status, headers, body

    def read(self, url: str, *, max_bytes: int, timeout: float, now: datetime) -> fetch.Fetched:
        self._status, self._headers = None, {}
        try:
            return self.get(
                url,
                allow=self.allow,
                max_bytes=max_bytes,
                budget=timeout,
                resolver=self.resolver,
                opener=self._open,
                clock=self.monotonic,
            )
        except fetch.FetchFail as e:
            status = self._status if e.reason == "status" else None
            if status in (404, 410):
                raise ReadFail("gone", status) from e
            if status in (429, 503):
                raise ReadFail("throttled", status, retry_after(self._headers.get("retry-after"), now)) from e
            if status == 403:
                raise ReadFail("blocked", status) from e
            raise ReadFail("failed", status) from e


# --- the look's reading ------------------------------------------------------------------------------------------


@dataclass
class Look:
    """What one reading look found. ``entries`` is ``None`` when the sitemap was not read; ``state`` is the
    ``sourceState`` this look decided (``None``: unchanged)."""

    robots_kept: Item | None = None  # a new robots.txt copy to store
    robots_tried: Item | None = None  # robots.txt could not be read: the stored copy (if any) with this try's time
    entries: list[Entry] | None = None
    state: str | None = None
    stopped: str | None = None
    pages: int = 0
    good: int = 0
    throttled: bool = False
    blocked: bool = False
    fail: ReadFail | None = None  # a 429, 503, 403 or challenge before the pages (robots.txt, the sitemap)
    requests: list[str] = field(default_factory=list)


def _state_update(store: db.Store, fields: Mapping[str, Any]) -> None:
    """A backoff, written at once (its own UpdateItem; creates ``STATE`` when it is missing)."""
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":f{i}": v for i, v in enumerate(fields.values())}
    update = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields)))
    store.update_expr(PK, STATE_SK, update, names=names, values=values)


def robots_last(state: Mapping[str, Any]) -> datetime | None:
    """The last time robots.txt was asked for: its good read or a failed try, whichever is later."""
    stored = obj(state.get("robots"))
    times = [t for t in (parse(stored.get("readAt")), parse(stored.get("triedAt"))) if t is not None]
    return max(times) if times else None


def _robots(reader: Reader, state: Mapping[str, Any], now: datetime, look: Look) -> robots.Robots | None:
    stored = obj(state.get("robots"))
    text = stored.get("text") if isinstance(stored.get("text"), str) else None
    read_at = parse(stored.get("readAt"))
    usable = text is not None and read_at is not None and now - read_at <= config.ROBOTS_USABLE
    last = robots_last(state)
    if text is not None and usable and last is not None and now - last < config.ROBOTS_EVERY:
        return robots.parse(text)  # read (or tried) in the last 24 h: at most one robots.txt request a day
    try:
        got = reader.read(config.ROBOTS_URL, max_bytes=config.ROBOTS_MAX_BYTES, timeout=config.ROBOTS_TIMEOUT, now=now)
        body = got.body.decode("utf-8-sig", errors="replace")
        if got.content_type == "text/html" or "<html" in body[:2048].lower():
            raise ReadFail("failed", 200)  # a web page in its place (a bot wall) is no robots.txt: never "allow all"
        kept = robots.compact(body)
        if len(kept.encode()) > config.ROBOTS_KEEP_BYTES:
            raise ReadFail("failed", 200)
    except ReadFail as e:
        log("info", "finder.read", what="robots", outcome=e.kind, status=(e.status or 0) // 100)
        if e.kind in ("throttled", "blocked"):
            look.fail = e
        look.robots_tried = {**stored, "triedAt": iso(now)}
        if text is not None and usable:
            return robots.parse(text)
        return None
    log("info", "finder.read", what="robots", outcome="ok", status=2)
    look.robots_kept = {"text": kept, "readAt": iso(now)}
    return robots.parse(kept)


def _sitemap(reader: Reader, now: datetime, look: Look, left: Callable[[], float]) -> list[Entry] | None:
    def one(url: str) -> sitemap.Sitemap:
        budget = min(config.SITEMAP_TIMEOUT, left())
        if budget < 1.0:
            raise ReadFail("failed")
        got = reader.read(url, max_bytes=config.SITEMAP_MAX_BYTES, timeout=budget, now=now)
        head = got.body[:2048].lower()
        if b"<html" in head and b"<urlset" not in head and b"<sitemapindex" not in head:
            raise ReadFail("challenge")
        return sitemap.parse(got.body)

    try:
        top = one(config.SITEMAP_URL)
        if top.kind == "urlset":
            entries = top.entries
        else:
            paths = (urllib.parse.urlsplit(child).path for child in top.children[: config.SITEMAP_CHILDREN])
            reader.children = frozenset(p for p in paths if p.endswith(".xml"))
            parts = []
            for child in top.children[: config.SITEMAP_CHILDREN]:
                if not reader.allow(child):
                    continue
                found = one(child)
                if found.kind == "urlset":
                    parts.append(found.entries)
            entries = sitemap.merge(parts)
        if not entries:
            raise sitemap.SitemapError("no campaign pages")  # a changed sitemap never empties the stored list
    except (ReadFail, sitemap.SitemapError) as e:
        kind = e.kind if isinstance(e, ReadFail) else "unreadable"
        log("info", "finder.read", what="sitemap", outcome=kind, status=(getattr(e, "status", None) or 0) // 100)
        if isinstance(e, ReadFail) and e.kind in ("throttled", "blocked", "challenge"):
            look.fail = e
        return None
    log("info", "finder.read", what="sitemap", outcome="ok", status=2, entries=len(entries))
    return entries


def _backoff(store: db.Store, state: Mapping[str, Any], at: datetime, fail: ReadFail, look: Look) -> None:
    if fail.kind == "throttled":
        n = int(state.get("backoffLooks") or 0)
        wait = max(timedelta(seconds=fail.retry_after), config.BACKOFF_MIN) * (2**n)
        until = at + min(wait, config.BACKOFF_MAX)
        _state_update(store, {"backoffUntil": iso(until), "backoffLooks": n + 1})
        look.stopped, look.throttled = "throttled", True
        log(
            "warning",
            "finder.backoff",
            status=(fail.status or 0) // 100,
            hours=round(min(wait, config.BACKOFF_MAX).total_seconds() / 3600, 2),
        )
        return
    base = 0 if look.good > 0 else int(state.get("blockedLooks") or 0)  # a good page this look cleared it
    blocked = base + 1
    fields: Item = {"backoffUntil": iso(at + config.BLOCKED_BACKOFF), "blockedLooks": blocked}
    if blocked >= config.BLOCKED_AFTER:
        fields["sourceState"] = "blocked"
        look.state = "blocked"
    _state_update(store, fields)
    look.stopped, look.blocked = "blocked", True
    log("warning", "finder.blocked", looks=blocked, challenge=fail.kind == "challenge")


@dataclass
class Parsed:
    kind: str
    detail: Item = field(default_factory=dict)
    card: Item | None = None  # the FinderCard


def _parse(got: fetch.Fetched, uuid: str, lastmod: int | None, at: datetime) -> Parsed:
    """The page and its ``FinderCard``; anything that can't be made sense of is ``unreadable``, never a raise."""
    try:
        page = rsc.page(got.status, got.body.decode("utf-8", errors="replace"), uuid)
        if page.kind != "campaign":
            return Parsed(page.kind)
        return Parsed("campaign", page.detail, normalize.card(page.detail, page.card, lastmod, at))
    except Exception as e:  # brand data is untrusted: a shape this code doesn't know is a format change
        log("warning", "finder.parse_failed", error=type(e).__name__)
        return Parsed("unreadable")


def _put_page(store: db.Store, uuid: str, lastmod: int | None, page: Parsed, at: datetime) -> None:
    item: Item = {
        "pk": PK,
        "sk": camp_sk(uuid),
        "type": "crpublic",
        "uuid": uuid,
        "state": "ok" if page.kind == "campaign" else page.kind,
        "lastmod": lastmod,
        "readAt": iso(at),
        "fails": 0,
        "ttl": _ttl(at),
    }
    if page.kind == "campaign":
        item["card"] = page.card
        store.put(
            {
                "pk": PK,
                "sk": pub_sk(uuid),
                "type": "crpubliccopy",
                "uuid": uuid,
                "public": public.strip(page.detail),
                "readAt": iso(at),
                "ttl": _ttl(at),
            }
        )
    store.put(item)


def _failed(store: db.Store, uuid: str, lastmod: int | None, cached: Mapping[str, Any] | None, at: datetime) -> None:
    """``fails + 1`` on its cache item (a never-read page gets an item with no card, so it is not tried forever)."""
    if cached is not None:
        store.update(PK, camp_sk(uuid), {"fails": int(cached.get("fails") or 0) + 1, "triedAt": iso(at)})
        return
    store.put(
        {
            "pk": PK,
            "sk": camp_sk(uuid),
            "type": "crpublic",
            "uuid": uuid,
            "state": "unreadable",
            "lastmod": lastmod,
            "fails": 1,
            "triedAt": iso(at),
            "ttl": _ttl(at),
        }
    )


@dataclass
class _Pages:
    """The page loop of one look: its counters and the clock."""

    store: db.Store
    state: Mapping[str, Any]
    cache: Mapping[str, Mapping[str, Any]]
    reader: Reader
    look: Look
    now: datetime
    start: float
    lastmods: dict[str, int | None]
    failures: int = 0
    unreadable: int = 0

    def at(self) -> datetime:
        return self.now + timedelta(seconds=max(0.0, self.reader.monotonic() - self.start))

    def left(self) -> float:
        return config.READ_DEADLINE - (self.reader.monotonic() - self.start)

    def one(self, uuid: str) -> bool:
        """Read one page; False when the look stops here."""
        store, look, lastmod = self.store, self.look, self.lastmods.get(uuid)
        left = self.left()
        if left < 1.0:
            look.stopped = "deadline"
            return False
        look.pages += 1
        try:
            got = self.reader.read(
                page_url(uuid), max_bytes=config.PAGE_MAX_BYTES, timeout=min(config.PAGE_TIMEOUT, left), now=self.now
            )
            page = _parse(got, uuid, lastmod, self.at())
        except ReadFail as fail:
            return self.failed(uuid, fail)
        if page.kind == "challenge":
            _backoff(store, self.state, self.at(), ReadFail("challenge", 200), look)
            return False
        _put_page(store, uuid, lastmod, page, self.at())
        if page.kind != "unreadable":
            self.unreadable = 0
            look.good += page.kind == "campaign"
            return True
        self.unreadable += 1
        if self.unreadable < config.UNREADABLE_STOP:
            return True
        _state_update(store, {"backoffUntil": iso(self.at() + config.UNREADABLE_BACKOFF), "sourceState": "unreadable"})
        look.state, look.stopped = "unreadable", "unreadable"
        log("error", "finder.format_changed", pages=self.unreadable)
        return False

    def failed(self, uuid: str, fail: ReadFail) -> bool:
        if fail.kind == "gone":
            _put_page(self.store, uuid, self.lastmods.get(uuid), Parsed("gone"), self.at())
            self.unreadable = 0
            return True
        if fail.kind in ("throttled", "blocked"):
            _backoff(self.store, self.state, self.at(), fail, self.look)
            return False
        _failed(self.store, uuid, self.lastmods.get(uuid), self.cache.get(uuid), self.at())
        self.failures += 1
        log("info", "finder.read", what="page", outcome="failed", status=(fail.status or 0) // 100)
        if self.failures < config.PAGE_FAILS_STOP:
            return True
        _state_update(self.store, {"backoffUntil": iso(self.at() + config.PAGE_FAILS_BACKOFF)})
        self.look.stopped = "failures"
        return False


def read(
    store: db.Store,
    state: Mapping[str, Any],
    cache: Mapping[str, Mapping[str, Any]],
    matched: Iterable[str],
    now: datetime,
    *,
    get: Callable[..., fetch.Fetched] = fetch.get,
    opener: fetch.Opener = fetch.https_open,
    resolver: fetch.Resolver | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Look:
    """One reading look: robots.txt when due, the sitemap, the plan, the pages, until 100 s after the start. The
    cache items (``CAMP#``, ``PUB#``) are written as pages are read; backoffs the moment they happen."""
    start = monotonic()
    reader = Reader(get, opener, resolver, monotonic, sleep)
    look = Look(requests=reader.requests)
    pages = _Pages(store, state, cache, reader, look, now, start, {})
    rules = _robots(reader, state, now, look)
    if look.fail is not None:
        _backoff(store, state, pages.at(), look.fail, look)
        if rules is None and look.state is None:
            look.state = "down"
        return look
    if rules is None:
        look.state, look.stopped = "down", "robots"
        return look
    reader.rules = rules
    if not robots.needed(rules):
        look.state, look.stopped = "not_allowed", "robots"
        log("warning", "finder.not_allowed")
        return look
    entries = _sitemap(reader, now, look, pages.left)
    if look.fail is not None:
        _backoff(store, state, pages.at(), look.fail, look)
        return look
    if entries is None:
        look.stopped = "sitemap"
        return look
    look.entries = entries
    pages.lastmods = dict(entries)
    look.stopped = "done"
    for uuid in plan(entries, cache, matched, now):
        if not pages.one(uuid):
            break
    log(
        "info",
        "finder.look_read",
        pages=look.pages,
        good=look.good,
        requests=len(reader.requests),
        stopped=look.stopped,
    )
    return look
