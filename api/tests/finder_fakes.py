"""Fakes for the campaign finder's tests (docs/CONTRACTS.md §41.6 Tests): no AWS, no Content Rewards, no network.

A recording ``opener`` (the shape of ``fetch.https_open``) serving a fake Content Rewards site, ``resolver`` that
answers one public address, a fake monotonic clock with a ``sleep`` that advances it, a fake datetime clock and a
store over the in-memory table. ``cf-prod-campaigns``' deps here have no MCP client and no Secrets client.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from clipfactory_api import db, s3
from clipfactory_api.contentrewards.handler import CampaignsDeps
from fakes import FakeS3, FakeTable

FIXTURES = Path(__file__).parent / "fixtures" / "finder"
NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=UTC)
USER = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
Answer = tuple[int, dict[str, str], bytes]


def resolver(_host: str) -> list[str]:
    return ["104.18.0.1"]


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def samples() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(fixture("samples.json"))
    return loaded


class Monotonic:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += max(0.0, seconds)


class WallClock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


def campaign_page(detail: dict[str, Any], card: dict[str, Any] | None = None) -> str:
    """A campaign page in the saved pages' stream shape (the detail query and, when given, the Discover card)."""
    uuid = str(detail["id"])
    queries: list[dict[str, Any]] = [
        {"state": {"data": None, "status": "success"}, "queryKey": "$11:props:state:queries:0:queryKey"},
        {"state": {"data": detail, "status": "success"}, "queryKey": ["campaigns", "detail", uuid]},
    ]
    if card is not None:
        queries.append({"state": {"data": card, "status": "success"}, "queryKey": ["campaigns", "discover-card", uuid]})
    row = ["$", "$L2b", None, {"state": {"mutations": [], "queries": queries}, "children": "$undefined"}]
    stream = '1:"$Sreact.fragment"\n18:' + json.dumps(row, separators=(",", ":")) + "\n"
    literal = json.dumps(stream).replace("<", "\\u003c")
    return (
        '<!DOCTYPE html><html><head><meta name="robots" content="index, follow"/></head><body>'
        f"<script>self.__next_f.push([1,{literal}])</script></body></html>"
    )


def sample_page(key: str) -> bytes:
    pair = samples()[key]
    return campaign_page(pair["detail"], pair["card"]).encode()


def html(body: str | bytes, status: int = 200, **headers: str) -> Answer:
    data = body.encode() if isinstance(body, str) else body
    return status, {"content-type": "text/html; charset=utf-8", **headers}, data


def xml(body: bytes, status: int = 200) -> Answer:
    return status, {"content-type": "application/xml"}, body


def text(body: bytes, status: int = 200) -> Answer:
    return status, {"content-type": "text/plain"}, body


@dataclass
class Call:
    address: str
    host: str
    target: str
    timeout: float
    max_bytes: int
    at: float


@dataclass
class Site:
    """A fake contentrewards.com: ``routes`` maps a path (and query) to an answer or a function of the call
    number; anything else is the soft-404 page. ``latency`` seconds pass on the monotonic clock per request."""

    clock: Monotonic
    routes: dict[str, Answer | Callable[[int], Answer]] = field(default_factory=dict)
    latency: float = 0.2
    calls: list[Call] = field(default_factory=list)
    in_flight: int = 0
    most_in_flight: int = 0
    fail: Callable[[Call], None] | None = None

    def __call__(self, address: str, host: str, target: str, timeout: float, max_bytes: int) -> Answer:
        call = Call(address, host, target, timeout, max_bytes, self.clock())
        self.calls.append(call)
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            if self.fail is not None:
                self.fail(call)
            self.clock.now += self.latency
            route = self.routes.get(target)
            if route is None:
                answer = html(fixture("page-soft-404.html"))
            elif callable(route):
                answer = route(len(self.calls))
            else:
                answer = route
            status, headers, body = answer
            return status, headers, body[: max_bytes + 1]
        finally:
            self.in_flight -= 1

    def urls(self) -> list[str]:
        return [f"https://{c.host}{c.target}" for c in self.calls]

    def pages(self) -> list[str]:
        return [c.target for c in self.calls if c.target.startswith("/c/campaigns/")]


def site(clock: Monotonic, *, sitemap: bytes | None = None, pages: dict[str, bytes] | None = None) -> Site:
    """The 21 Nov robots.txt, the trimmed sitemap and every sample's page."""
    routes: dict[str, Answer | Callable[[int], Answer]] = {
        "/robots.txt": text(fixture("robots.txt")),
        "/sitemap.xml": xml(sitemap if sitemap is not None else fixture("sitemap.xml")),
    }
    for key, pair in samples().items():
        routes[f"/c/campaigns/{pair['detail']['id']}"] = html(sample_page(key))
    for uuid, body in (pages or {}).items():
        routes[f"/c/campaigns/{uuid}"] = html(body)
    return Site(clock, routes)


def look(
    st: db.Store,
    fake: Site,
    *,
    state: dict[str, Any] | None = None,
    cache: dict[str, Any] | None = None,
    matched: list[str] | None = None,
    now: datetime = NOW,
) -> Any:
    """``source.read`` with the fake site, the fake resolver and the fake clocks (never a real sleep)."""
    from clipfactory_api.contentrewards import fetch
    from clipfactory_api.contentrewards.finder import source

    return source.read(
        st,
        state or {},
        cache or {},
        matched or [],
        now,
        get=fetch.get,
        opener=fake,
        resolver=resolver,
        monotonic=fake.clock,
        sleep=fake.clock.sleep,
    )


def store() -> db.Store:
    return db.Store(FakeTable())


class NoModel:
    def converse(self, **_kw: Any) -> Any:
        raise AssertionError("the finder never calls a model")


def deps(st: db.Store, clock: WallClock) -> CampaignsDeps:
    return CampaignsDeps(store=st, media=s3.Media(FakeS3(), "b"), bedrock=NoModel(), model_id="m", clock=clock)


def seed_owner(st: db.Store, user_id: str, now: datetime, *, want: dict[str, Any] | None = None, **fields: Any) -> None:
    """``CROWNERS`` and a ``CRFIND`` the way Q's first PATCH writes it."""
    from clipfactory_api.contentrewards.finder import config

    st.put({"pk": db.CROWNERS_PK, "sk": db.user_pk(user_id), "type": "crowner", "userId": user_id, "since": "x"})
    item: dict[str, Any] = {
        "pk": db.user_pk(user_id),
        "sk": "CRFIND",
        "type": "crfind",
        "userId": user_id,
        "want": {**config.DEFAULTS, **(want or {})},
        "createdAt": (now - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        **fields,
    }
    st.put(item)


def seed_places(st: db.Store, user_id: str, places: list[str], *, tiktok_ok: bool = False) -> None:
    from cr_support import seed_setup

    for platform in places:
        seed_setup(st, user_id, platform, audit="ok" if platform == "tiktok" and tiktok_ok else None)
