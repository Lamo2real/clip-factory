"""The polite reader (docs/CONTRACTS.md §41.2, §41.6 Tests P): only allowed pages, one at a time, ≥ 1 s apart, ≤ 40,
the 100 s deadline, anonymous requests, and every backoff written the moment it happens."""

from __future__ import annotations

import copy
import itertools
import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso, parse
from clipfactory_api.contentrewards import fetch
from clipfactory_api.contentrewards.finder import robots, source
from finder_fakes import NOW, Monotonic, Site, campaign_page, fixture, html, look, samples, site, store, xml

ROBOTS = robots.parse(fixture("robots.txt").decode())
PICKLE = "3d9ef19f-1256-47ca-b630-e33e2c923969"


def _u(i: int) -> str:
    return f"00000000-0000-4000-8000-{i:012d}"


def _sitemap(uuids: list[str]) -> bytes:
    body = "".join(
        f"<url><loc>https://contentrewards.com/c/campaigns/{u}</loc><lastmod>2026-11-{1 + i % 20:02d}T00:00:00Z</lastmod></url>"
        for i, u in enumerate(uuids)
    )
    return f"<urlset>{body}</urlset>".encode()


def _page(uuid: str) -> bytes:
    pair = copy.deepcopy(samples()["d18-pickleball"])
    pair["detail"]["id"] = pair["card"]["id"] = uuid
    return campaign_page(pair["detail"], pair["card"]).encode()


def _many(n: int, clock: Monotonic | None = None) -> tuple[Site, list[str]]:
    uuids = [_u(i) for i in range(n)]
    fake = site(clock or Monotonic(), sitemap=_sitemap(uuids), pages={u: _page(u) for u in uuids})
    return fake, uuids


def _state(st: db.Store) -> dict[str, Any]:
    return st.get("CRPUBLIC", "STATE") or {}


def test_a_full_look_reads_only_allowed_pages_one_at_a_time_a_second_apart() -> None:
    st = store()
    fake = site(Monotonic())
    found = look(st, fake)
    urls = fake.urls()
    assert urls[:2] == ["https://contentrewards.com/robots.txt", "https://contentrewards.com/sitemap.xml"]
    for url in urls:
        path = url.removeprefix("https://contentrewards.com")
        assert url.startswith("https://contentrewards.com/")
        assert "/api/" not in url
        assert ROBOTS.allowed(path), url
    assert fake.most_in_flight == 1
    starts = [c.at for c in fake.calls]
    assert all(b - a >= 1.0 for a, b in itertools.pairwise(starts))
    assert {c.address for c in fake.calls} == {"104.18.0.1"}
    assert len(fake.pages()) <= 40
    assert [c.max_bytes for c in fake.calls[:2]] == [64 * 1024, 4 * 1024 * 1024]
    assert {c.max_bytes for c in fake.calls[2:]} == {2 * 1024 * 1024}
    assert all(c.timeout <= 10.0 for c in fake.calls)
    entries = found.entries or []
    assert len(fake.pages()) == len(entries)  # every entry is new: all of them, newest first
    cache = {i["uuid"]: i for i in st.query_all("CRPUBLIC", "CAMP#")}
    assert cache[PICKLE]["state"] == "ok"
    assert cache[PICKLE]["card"]["name"] == "Clip Pro Pickleball: CNPL Rallies & Highlights"
    assert cache[PICKLE]["lastmod"] == 1794677024
    assert cache[PICKLE]["ttl"] == int((parse(cache[PICKLE]["readAt"]) + timedelta(days=60)).timestamp())
    pub = st.get("CRPUBLIC", f"PUB#{PICKLE}") or {}
    assert pub["type"] == "crpubliccopy"
    assert pub["public"]["name"] == cache[PICKLE]["card"]["name"]
    assert pub["public"]["configuration"]["budget"] == 250000
    gone = [u for u, i in cache.items() if i["state"] == "gone"]
    assert "52a937dd-2e14-4e4b-8eaf-971ac5921208" in gone  # not one of the samples: the fake site's soft 404
    assert st.get("CRPUBLIC", "PUB#52a937dd-2e14-4e4b-8eaf-971ac5921208") is None
    assert (found.good, found.stopped, found.state) == (15, "done", None)
    assert all("username" not in json.dumps(i) for i in st.query_all("CRPUBLIC", ""))


def test_at_most_40_pages_and_the_100_s_deadline() -> None:
    fake, _uuids = _many(60)
    assert len(look(store(), fake).requests) == 42
    assert len(fake.pages()) == 40
    slow, _ = _many(60)
    slow.latency = 4.0
    start = slow.clock()
    found = look(store(), slow)
    assert found.stopped == "deadline"
    assert all(c.at - start < 100 for c in slow.calls)
    assert all(c.at + c.timeout - start <= 100.5 for c in slow.calls)
    assert 15 < len(slow.pages()) < 40


def test_the_requests_are_anonymous(monkeypatch: pytest.MonkeyPatch) -> None:
    """``fetch.https_open`` (the opener the reader wraps) sends only Host, the agent and Accept-Encoding."""
    sent: dict[str, Any] = {}

    class Sock:
        def settimeout(self, _t: float) -> None: ...
        def close(self) -> None: ...

    class Context:
        def wrap_socket(self, sock: Sock, server_hostname: str) -> Sock:
            sent["sni"] = server_hostname
            return sock

    class Response:
        status = 200

        def getheaders(self) -> list[tuple[str, str]]:
            return [("Content-Type", "text/plain")]

        def read1(self, _n: int) -> bytes:
            return b""

    class Conn:
        def __init__(self, host: str, port: int, timeout: float) -> None:
            self.sock: Any = None

        def request(self, method: str, target: str, headers: dict[str, str]) -> None:
            sent.update(method=method, target=target, headers=headers)

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None: ...

    monkeypatch.setattr(fetch.socket, "create_connection", lambda *_a, **_k: Sock())
    monkeypatch.setattr(fetch.ssl, "create_default_context", Context)
    monkeypatch.setattr(fetch.http.client, "HTTPConnection", Conn)
    reader = source.Reader(fetch.get, fetch.https_open, lambda _h: ["104.18.0.1"], Monotonic(), Monotonic().sleep)
    reader.read("https://contentrewards.com/robots.txt", max_bytes=1000, timeout=5.0, now=NOW)
    assert sent["method"] == "GET"
    assert sent["headers"] == {
        "Host": "contentrewards.com",
        "User-Agent": "ClipFactory/1",
        "Accept-Encoding": "identity",
    }
    assert not {"Cookie", "Authorization", "Referer"} & set(sent["headers"])


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/c/campaigns/" + PICKLE,
        "https://www.contentrewards.com/c/campaigns/" + PICKLE,
        "https://contentrewards.com:8443/c/campaigns/" + PICKLE,
        "https://contentrewards.com/api/campaign/campaigns/" + PICKLE,
        "https://contentrewards.com/home/x",
        "http://contentrewards.com/c/campaigns/" + PICKLE,
    ],
)
def test_a_redirect_off_the_allowed_pages_is_refused(location: str) -> None:
    st = store()
    fake = site(Monotonic(), sitemap=_sitemap([PICKLE]))
    fake.routes[f"/c/campaigns/{PICKLE}"] = (301, {"location": location}, b"")
    found = look(st, fake)
    assert len(fake.calls) == 3  # robots, sitemap, the page: the hop is never asked for
    assert found.good == 0
    item = st.get("CRPUBLIC", f"CAMP#{PICKLE}") or {}
    assert (item["fails"], item.get("card")) == (1, None)


def test_a_redirect_inside_the_allowed_pages_is_followed() -> None:
    fake = site(Monotonic(), sitemap=_sitemap([_u(1)]))
    fake.routes[f"/c/campaigns/{_u(1)}"] = (308, {"location": f"/c/campaigns/{PICKLE}"}, b"")
    found = look(store(), fake)
    assert fake.urls()[-1] == f"https://contentrewards.com/c/campaigns/{PICKLE}"
    assert found.good == 0  # it is another campaign's page: not this one
    assert fake.calls[-1].at - fake.calls[-2].at >= 1.0  # a hop is a request too


def test_429_with_retry_after_backs_off_at_once_doubling_up_to_24_hours() -> None:
    for looks_before, retry, hours in (
        (0, "120", 1.0),
        (0, "7200", 2.0),
        (2, "", 4.0),
        (3, "7200", 16.0),
        (6, "", 24.0),
    ):
        st = store()
        fake, uuids = _many(5)
        fake.routes[f"/c/campaigns/{uuids[2]}"] = (429, {"retry-after": retry} if retry else {}, b"")
        found = look(st, fake, state={"backoffLooks": looks_before})
        state = _state(st)  # written by the reader itself, before any end-of-look write
        assert found.stopped == "throttled"
        assert len(fake.pages()) == 3
        assert state["backoffLooks"] == looks_before + 1
        until = parse(state["backoffUntil"])
        assert until is not None
        wait = until - NOW
        assert timedelta(hours=hours) <= wait < timedelta(hours=hours, minutes=1), (looks_before, retry)


def test_429_on_the_sitemap_and_an_http_date_retry_after() -> None:
    st = store()
    fake = site(Monotonic())
    when = (NOW + timedelta(hours=3)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    fake.routes["/sitemap.xml"] = (503, {"retry-after": when}, b"")
    found = look(st, fake)
    assert (found.entries, fake.pages()) == (None, [])
    wait = (parse(_state(st)["backoffUntil"]) or NOW) - NOW
    assert timedelta(hours=3) - timedelta(seconds=5) <= wait <= timedelta(hours=3, seconds=5)


def test_403_three_looks_in_a_row_is_blocked_and_a_good_page_clears_it() -> None:
    st = store()
    blocked_looks = 0
    for n in range(1, 4):
        fake, uuids = _many(3)
        fake.routes[f"/c/campaigns/{uuids[0]}"] = (403, {}, b"")
        found = look(st, fake, state={"blockedLooks": blocked_looks})
        state = _state(st)
        assert state["blockedLooks"] == n
        wait = (parse(state["backoffUntil"]) or NOW) - NOW
        assert timedelta(hours=24) <= wait <= timedelta(hours=24, seconds=10)
        blocked_looks = state["blockedLooks"]
        assert (found.state == "blocked") is (n == 3)
    assert _state(st)["sourceState"] == "blocked"
    fake, _ = _many(2)
    found = look(st, fake, state=_state(st))
    assert found.good == 2  # run's end-of-look write then sets blockedLooks 0 and sourceState ok


@pytest.mark.parametrize("at", [0, 9])
def test_a_challenge_page_on_the_first_or_the_tenth_page_stops_like_a_403(at: int) -> None:
    st = store()
    fake, uuids = _many(20)
    order = list(source.plan([(u, 1_790_000_000 + i) for i, u in enumerate(uuids)], {}, [], NOW))
    fake.routes[f"/c/campaigns/{order[at]}"] = html(fixture("page-challenge.html"))
    found = look(st, fake)
    assert (found.stopped, len(fake.pages())) == ("blocked", at + 1)
    state = _state(st)
    assert state["blockedLooks"] == 1
    assert (parse(state["backoffUntil"]) or NOW) - NOW >= timedelta(hours=24)
    assert (st.get("CRPUBLIC", f"CAMP#{order[at]}") or {}).get("state") is None  # never marked gone


def test_5xx_skips_a_page_and_three_stop_the_look() -> None:
    st = store()
    fake, uuids = _many(6)
    order = source.plan([(u, 1_790_000_000 + i) for i, u in enumerate(uuids)], {}, [], NOW)
    fake.routes[f"/c/campaigns/{order[1]}"] = (500, {}, b"")
    found = look(st, fake)
    assert (found.good, found.stopped) == (5, "done")
    failed = st.get("CRPUBLIC", f"CAMP#{order[1]}") or {}
    assert (failed["fails"], failed.get("readAt")) == (1, None)
    assert "backoffUntil" not in _state(st)
    st2 = store()
    fake2, uuids2 = _many(6)
    for u in uuids2:
        fake2.routes[f"/c/campaigns/{u}"] = (502, {}, b"")
    found2 = look(st2, fake2)
    assert (found2.stopped, len(fake2.pages())) == ("failures", 3)
    assert parse(_state(st2)["backoffUntil"]) == NOW + timedelta(seconds=round(fake2.clock() - 1000.0, 6), hours=1)


def test_a_failing_card_counts_its_fails_on_its_cache_item() -> None:
    st = store()
    item = {"pk": "CRPUBLIC", "sk": f"CAMP#{_u(1)}", "type": "crpublic", "uuid": _u(1), "state": "ok", "fails": 1,
            "readAt": iso(NOW - timedelta(days=3)), "card": {"onDiscover": True, "groupIds": []}}  # fmt: skip
    st.put(item)
    fake = site(Monotonic(), sitemap=_sitemap([_u(1)]))
    fake.routes[f"/c/campaigns/{_u(1)}"] = (504, {}, b"")
    look(st, fake, cache={_u(1): item})
    after = st.get("CRPUBLIC", f"CAMP#{_u(1)}") or {}
    assert (after["fails"], after["readAt"], after["card"]) == (2, item["readAt"], item["card"])


def test_five_unreadable_pages_in_a_row_stop_with_a_6_hour_backoff(capsys: pytest.CaptureFixture[str]) -> None:
    st = store()
    fake, uuids = _many(8)
    for u in uuids:
        fake.routes[f"/c/campaigns/{u}"] = html(fixture("page-changed.html"))
    found = look(st, fake)
    assert (found.state, found.stopped, len(fake.pages())) == ("unreadable", "unreadable", 5)
    state = _state(st)
    assert state["sourceState"] == "unreadable"
    assert (parse(state["backoffUntil"]) or NOW) - NOW >= timedelta(hours=6)
    logs = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert any(e["event"] == "finder.format_changed" and e["level"] == "error" for e in logs)


def test_four_unreadable_then_a_good_page_goes_on() -> None:
    fake, uuids = _many(8)
    order = source.plan([(u, 1_790_000_000 + i) for i, u in enumerate(uuids)], {}, [], NOW)
    for u in order[:4]:
        fake.routes[f"/c/campaigns/{u}"] = html(fixture("page-changed.html"))
    found = look(store(), fake)
    assert (found.state, found.good, len(fake.pages())) == (None, 4, 8)


def test_retry_after_values() -> None:
    assert source.retry_after("120", NOW) == 120.0
    assert source.retry_after(None, NOW) == 0.0
    assert source.retry_after("soon", NOW) == 0.0
    when = (NOW + timedelta(minutes=10)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    assert 599 <= source.retry_after(when, NOW) <= 600


def test_the_reader_refuses_api_paths_even_if_robots_allowed_them() -> None:
    reader = source.Reader(fetch.get, lambda *_a: (200, {}, b""), None, Monotonic(), Monotonic().sleep)
    reader.rules = robots.parse("User-agent: *\nAllow: /\n")
    assert reader.allow(f"https://contentrewards.com/c/campaigns/{PICKLE}")
    assert not reader.allow("https://contentrewards.com/api/campaign/campaigns/discover")
    assert not reader.allow("https://contentrewards.com/c/campaigns/x#frag")
    assert reader.allow("https://contentrewards.com/robots.txt")
    reader.rules = None
    assert not reader.allow(f"https://contentrewards.com/c/campaigns/{PICKLE}")  # no robots.txt yet: nothing


def test_a_sitemap_challenge_is_blocked() -> None:
    st = store()
    fake = site(Monotonic())
    fake.routes["/sitemap.xml"] = xml(b"<html><head><title>Just a moment...</title></head></html>")
    found = look(st, fake)
    assert (found.stopped, found.entries) == ("blocked", None)
    assert _state(st)["blockedLooks"] == 1


PLAN_CASES: list[dict[str, Any]] = json.loads(fixture("plan_cases.json"))["cases"]


@pytest.mark.parametrize("case", PLAN_CASES, ids=[c["name"] for c in PLAN_CASES])
def test_the_plan(case: dict[str, Any]) -> None:
    entries = [(u, int(at.timestamp()) if (at := parse(m)) else None) for u, m in case["entries"]]
    got = source.plan(entries, case["cache"], case["matched"], NOW, case.get("cap", 40))
    assert got == case["expect"]


def test_the_plan_never_repeats_and_keeps_the_cap() -> None:
    entries = [(_u(i), 1_790_000_000 + i) for i in range(60)]
    cache = {
        _u(i): {"state": "ok", "readAt": iso(NOW - timedelta(days=3)), "card": {"onDiscover": True}} for i in range(30)
    }
    got = source.plan(entries, cache, [_u(1), _u(2)], NOW)
    assert len(got) == len(set(got)) == 40
    assert got[:2] == [_u(1), _u(2)]  # stale matches first
    assert got[2:32] == [_u(i) for i in range(59, 29, -1)]  # then never read, newest listing first
    assert got[32:] == [_u(0), *(_u(i) for i in range(3, 10))]  # then live rechecks


def test_these_tests_cannot_reach_the_network() -> None:
    import socket

    with pytest.raises(AssertionError):
        socket.create_connection(("contentrewards.com", 443))
    with pytest.raises(AssertionError):
        socket.getaddrinfo("contentrewards.com", 443)
    with pytest.raises(AssertionError):  # the real resolver (resolver=None) is refused too
        fetch.get("https://contentrewards.com/robots.txt", allow=lambda _u: True, max_bytes=10, budget=1.0)
