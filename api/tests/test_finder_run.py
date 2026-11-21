"""One look (docs/CONTRACTS.md §41.2 limits, §41.4 notice, §41.5 the job, §41.6 Tests P)."""

from __future__ import annotations

import copy
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso, parse
from clipfactory_api.contentrewards import handler
from clipfactory_api.contentrewards.finder import match, run, sitemap
from clipfactory_api.oauth import setup as oauth_setup
from finder_fakes import (
    NOW,
    OTHER,
    USER,
    Monotonic,
    Site,
    WallClock,
    campaign_page,
    deps,
    fixture,
    html,
    resolver,
    samples,
    seed_owner,
    seed_places,
    site,
    store,
)

SET_UP = ["youtube", "instagram", "facebook", "x"]
NEW = "00000000-0000-4000-8000-000000000001"


class LambdaTimeout(BaseException):
    """Lambda stopping the function: not an ``Exception``, so nothing inside catches it."""


def _go(st: db.Store, clock: WallClock, fake: Site, why: str, user_id: str | None = None) -> dict[str, Any]:
    return run.run(
        deps(st, clock),
        user_id,
        why,
        clock(),
        opener=fake,
        resolver=resolver,
        monotonic=fake.clock,
        sleep=fake.clock.sleep,
    )


def _crfind(st: db.Store, user_id: str = USER) -> dict[str, Any]:
    return st.get(db.user_pk(user_id), "CRFIND") or {}


def _state(st: db.Store) -> dict[str, Any]:
    return st.get("CRPUBLIC", "STATE") or {}


def _owner(st: db.Store, user_id: str = USER, **fields: Any) -> None:
    seed_owner(st, user_id, NOW, **fields)
    seed_places(st, user_id, SET_UP)


def _with_new_campaign(fake: Site) -> None:
    """One more campaign: listed now, paying $2.50 on YouTube."""
    pair = copy.deepcopy(samples()["d18-pickleball"])
    pair["detail"]["id"] = pair["card"]["id"] = NEW
    for row in pair["detail"]["configuration"]["payoutModel"]:
        row["rate"] = 250
    fake.routes[f"/c/campaigns/{NEW}"] = html(campaign_page(pair["detail"], pair["card"]))
    body = fixture("sitemap.xml").replace(
        b"</urlset>",
        f"<url><loc>https://contentrewards.com/c/campaigns/{NEW}</loc><lastmod>2026-11-21T15:00:00Z</lastmod></url></urlset>".encode(),
    )
    fake.routes["/sitemap.xml"] = (200, {"content-type": "application/xml"}, body)


def test_a_scheduled_look_reads_once_and_matches_every_owner_that_is_on() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    _owner(st, OTHER, want={"access": "any"})
    st.put({"pk": db.CROWNERS_PK, "sk": db.user_pk("no-finder"), "type": "crowner", "userId": "no-finder"})
    _owner(st, "stopped", want={"on": False})
    out = _go(st, clock, fake, "schedule")
    assert out["outcome"] == "read"
    assert out["owners"] == 2
    assert fake.urls()[:2] == ["https://contentrewards.com/robots.txt", "https://contentrewards.com/sitemap.xml"]
    mine = _crfind(st)
    assert [m["campaignId"] for m in mine["matches"]][:2] == [
        "c0c37381-e244-4643-98bd-edbff4bc1465",
        "a1cefc3b-4533-438f-8e70-a7299550f1cf",
    ]
    assert len(mine["matches"]) == 6
    assert len(_crfind(st, OTHER)["matches"]) == 8  # "Also ones I apply to"
    assert mine["matchedAt"] == iso(NOW)
    assert mine["matchedWant"] == match.matched_want(mine["want"], SET_UP)
    assert mine["shown"] == {m["campaignId"]: iso(NOW) for m in mine["matches"]}
    assert mine["looked"] == {"campaigns": 15, "pending": 0}
    assert mine["skipped"][0] == {"code": "cant_make", "count": 4, "text": "4 need something Clip Factory can't make."}
    assert mine["sourceState"] == "ok"
    assert mine["categories"][0] == {"id": "personal-brand", "name": "Personal Brand", "count": 3}
    assert len(mine["categories"]) <= 12
    assert "notice" not in mine  # the first look never tells
    assert all(m["budget"]["asOf"] > iso(NOW) for m in mine["matches"])  # when the page was read
    assert st.get(db.user_pk("no-finder"), "CRFIND") is None  # a look never creates CRFIND
    assert "matchedAt" not in _crfind(st, "stopped")
    state = _state(st)
    assert state["type"] == "crpublicstate"
    assert (state["lastReadAt"], state["lastLookAt"], state["sitemapAt"]) == (iso(NOW), iso(NOW), iso(NOW))
    assert state["readsToday"] == {"day": "2026-11-21", "n": 1}
    assert state["nextRunAt"] == iso(NOW + timedelta(hours=6))
    assert "runningUntil" not in state
    assert state["sourceState"] == "ok"
    assert state["cached"] == len(st.query_all("CRPUBLIC", "CAMP#"))
    assert state["robots"]["text"].startswith("User-agent: *")
    entries = sitemap.entries_from_gz(state["entriesGz"])
    assert entries == sitemap.parse(fixture("sitemap.xml")).entries
    assert match.with_defaults(mine["want"]) == match.with_defaults(
        {}
    )  # Q's attributes untouched (null places unstored)


def test_the_notice_once_a_day_only_on_scheduled_looks() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    _go(st, clock, fake, "start", USER)
    assert "notice" not in _crfind(st)
    st.update(db.user_pk(USER), "CRFIND", {"seenAt": iso(NOW + timedelta(minutes=5))})  # he saw the matches
    clock.advance(hours=6)
    _go(st, clock, fake, "schedule")
    assert "notice" not in _crfind(st)  # nothing new since his visit
    _with_new_campaign(fake)
    clock.advance(hours=6)
    _go(st, clock, fake, "schedule")
    notice = _crfind(st)["notice"]
    assert notice == {"key": "2026112200:1", "count": 1, "at": iso(clock())}
    assert NEW in [m["campaignId"] for m in _crfind(st)["matches"]]
    clock.advance(hours=6)
    st.update(db.user_pk(USER), "CRFIND", {"hidden": {NEW}})
    _go(st, clock, fake, "schedule")
    assert _crfind(st)["notice"] == notice  # at most one a day
    for why in ("check_now", "want", "start"):
        clock.advance(hours=25)
        st.update(db.user_pk(USER), "CRFIND", {"hidden": {"c0c37381-e244-4643-98bd-edbff4bc1465"}})
        st.update(db.user_pk(USER), "CRFIND", {"shown": {}})
        _go(st, clock, fake, why, USER)
        assert _crfind(st)["notice"] == notice, why  # never on a start, Check now or a change


def test_tell_me_off_never_notices() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER, want={"tellMe": False}, matchedAt=iso(NOW - timedelta(days=1)))
    _go(st, clock, fake, "schedule")
    assert "notice" not in _crfind(st)
    _owner(st, OTHER, matchedAt=iso(NOW - timedelta(days=1)))
    clock.advance(hours=6)
    _go(st, clock, fake, "schedule")
    assert _crfind(st, OTHER)["notice"]["count"] == 6  # he never visited: every match is new to him
    assert "notice" not in _crfind(st)


def test_a_change_of_want_matches_from_the_cache_and_reads_nothing() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    _go(st, clock, fake, "start", USER)
    calls = len(fake.calls)
    st.update(db.user_pk(USER), "CRFIND", {"want": {**_crfind(st)["want"], "minPer1kCents": 200, "access": "any"}})
    clock.advance(minutes=1)
    out = _go(st, clock, fake, "want", USER)
    assert out == {"action": "find", "outcome": "matched", "owners": 1}
    assert len(fake.calls) == calls
    assert [m["campaignId"] for m in _crfind(st)["matches"]] == ["c0c37381-e244-4643-98bd-edbff4bc1465"]
    assert _crfind(st)["matchedAt"] == iso(clock())


def test_a_look_that_cannot_take_the_lease() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    st.put({"pk": "CRPUBLIC", "sk": "STATE", "type": "crpublicstate", "runningUntil": iso(NOW + timedelta(seconds=60))})
    assert _go(st, clock, fake, "schedule")["outcome"] == "busy"
    assert fake.calls == []
    assert "matchedAt" not in _crfind(st)
    out = _go(st, clock, fake, "check_now", USER)
    assert (out["outcome"], fake.calls) == ("matched", [])  # its own owner only, from the cache
    assert _crfind(st)["matchedAt"] == iso(NOW)
    assert _state(st)["runningUntil"] == iso(NOW + timedelta(seconds=60))  # the other look's lease stays


def test_the_30_minute_gap_and_6_reading_looks_a_day() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    _go(st, clock, fake, "check_now", USER)
    first = len(fake.calls)
    clock.advance(minutes=10)
    assert _go(st, clock, fake, "check_now", USER)["outcome"] == "matched"
    assert len(fake.calls) == first
    clock.advance(minutes=10)
    _go(st, clock, fake, "schedule")
    assert len(fake.calls) == first  # inside the gap a scheduled look only matches
    assert _state(st)["nextRunAt"] == iso(clock() + timedelta(minutes=15))  # the read is allowed at 12:30
    clock.advance(minutes=11)
    assert _go(st, clock, fake, "check_now", USER)["outcome"] == "read"
    st.update("CRPUBLIC", "STATE", {"readsToday": {"day": "2026-11-21", "n": 6}})
    clock.advance(hours=1)
    assert _go(st, clock, fake, "schedule")["outcome"] == "matched"
    assert _state(st)["nextRunAt"] == "2026-11-22T00:00:00.000Z"
    clock.now = parse("2026-11-22T00:05:00.000Z") or NOW
    assert _go(st, clock, fake, "schedule")["outcome"] == "read"
    assert _state(st)["readsToday"] == {"day": "2026-11-22", "n": 1}


def test_a_look_that_dies_after_its_first_page_then_reads_nothing_15_minutes_later() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)

    def die(call: Any) -> None:
        if len([c for c in fake.calls if c.target.startswith("/c/campaigns/")]) == 2:
            raise LambdaTimeout

    fake.fail = die
    with pytest.raises(LambdaTimeout):
        _go(st, clock, fake, "schedule")
    pages = len(fake.pages())
    state = _state(st)
    assert (state["lastReadAt"], state["readsToday"]["n"]) == (iso(NOW), 1)  # counted before the first request
    assert state["nextRunAt"] == iso(NOW + timedelta(hours=6))
    fake.fail = None
    clock.advance(minutes=15)
    out = _go(st, clock, fake, "schedule")
    assert (out["outcome"], len(fake.pages())) == ("matched", pages)
    assert "runningUntil" not in _state(st)


def test_a_look_that_raises_inside_is_failed_never_a_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)

    def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("bug")

    monkeypatch.setattr(run, "cache_items", broken)
    assert _go(st, clock, fake, "schedule") == {"action": "find", "outcome": "failed"}
    clock.advance(minutes=15)
    monkeypatch.undo()
    assert _go(st, clock, fake, "schedule")["outcome"] == "matched"  # the lease update counted it


def test_one_owners_failure_never_stops_the_others(monkeypatch: pytest.MonkeyPatch) -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    _owner(st, OTHER)
    real = oauth_setup.all_setups

    def flaky(store_: db.Store, user_id: str, now: Any = None) -> Any:
        if user_id == USER:
            raise RuntimeError("bad item")
        return real(store_, user_id, now)

    monkeypatch.setattr(oauth_setup, "all_setups", flaky)
    out = _go(st, clock, fake, "schedule")
    assert (out["outcome"], out["owners"]) == ("read", 1)
    assert "matches" not in _crfind(st)
    assert len(_crfind(st, OTHER)["matches"]) == 6


def test_source_states() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    fake.routes["/sitemap.xml"] = (500, {}, b"")
    st.put({"pk": "CRPUBLIC", "sk": "STATE", "type": "crpublicstate", "sitemapAt": iso(NOW - timedelta(hours=2))})
    _go(st, clock, fake, "schedule")
    assert _state(st)["sourceState"] == "ok"  # a good read 2 hours ago: the cache is still fresh
    clock.advance(days=1)
    _go(st, clock, fake, "schedule")
    assert _state(st)["sourceState"] == "down"
    assert _crfind(st)["sourceState"] == "down"
    fake.routes["/sitemap.xml"] = (200, {"content-type": "application/xml"}, fixture("sitemap.xml"))
    st.update("CRPUBLIC", "STATE", {"sourceState": "blocked", "blockedLooks": 3})
    clock.advance(hours=6)
    _go(st, clock, fake, "schedule")
    state = _state(st)
    assert (state["sourceState"], state["blockedLooks"]) == ("ok", 0)  # cleared by the next good page


def test_not_allowed_waits_for_the_daily_robots_read() -> None:
    st, clock, fake = store(), WallClock(), site(Monotonic())
    _owner(st, USER)
    fake.routes["/robots.txt"] = (200, {"content-type": "text/plain"}, b"User-agent: *\nDisallow: /c/\n")
    _go(st, clock, fake, "schedule")
    assert (_state(st)["sourceState"], fake.urls()) == ("not_allowed", ["https://contentrewards.com/robots.txt"])
    assert _crfind(st)["sourceState"] == "not_allowed"
    clock.advance(hours=6)
    _go(st, clock, fake, "schedule")
    assert len(fake.calls) == 1  # nothing read until the daily read is due
    assert _state(st)["nextRunAt"] == iso(NOW + timedelta(hours=24))
    fake.routes["/robots.txt"] = (200, {"content-type": "text/plain"}, fixture("robots.txt"))
    clock.now = NOW + timedelta(hours=24)
    _go(st, clock, fake, "schedule")
    assert _state(st)["sourceState"] == "ok"
    assert len(fake.pages()) > 0


def test_cards_count_only_while_listed_or_a_recent_group_sibling() -> None:
    cache = {
        "a": {"state": "ok", "readAt": iso(NOW - timedelta(days=1)), "card": {"uuid": "a", "groupIds": ["s"]}},
        "s": {"state": "ok", "readAt": iso(NOW - timedelta(days=13)), "card": {"uuid": "s", "groupIds": []}},
        "old": {"state": "ok", "readAt": iso(NOW - timedelta(days=15)), "card": {"uuid": "old", "groupIds": []}},
        "g": {"state": "gone", "readAt": iso(NOW), "card": {"uuid": "g"}},
        "new": {"state": "ok", "readAt": iso(NOW + timedelta(seconds=5)), "card": {"uuid": "new", "groupIds": []}},
    }
    counted = run.counted(cache, [("a", None), ("g", None)], NOW, NOW)
    assert [c["uuid"] for c in counted] == ["a", "new", "s"]
    assert counted[0]["readAt"] == cache["a"]["readAt"]
    assert [c["uuid"] for c in run.counted(cache, None, None, NOW)] == ["a", "new", "old", "s"]


def test_the_handler_find_action(monkeypatch: pytest.MonkeyPatch) -> None:
    st, clock = store(), WallClock()
    d = deps(st, clock)
    monkeypatch.delenv("CR_FINDER", raising=False)
    assert handler.handle({"action": "find", "why": "schedule"}, d) == {"action": "find", "outcome": "off"}
    monkeypatch.setenv("CR_FINDER", "off")
    assert handler.handle({"action": "find", "why": "want", "userId": USER}, d) == {"action": "find", "outcome": "off"}
    monkeypatch.setenv("CR_FINDER", "on")
    _owner(st, USER)
    assert handler.handle({"action": "find", "why": "want", "userId": USER}, d) == {
        "action": "find",
        "outcome": "matched",
        "owners": 1,
    }
    for bad in (
        {"action": "find"},
        {"action": "find", "why": "often"},
        {"action": "find", "why": "start"},
        {"action": "find", "why": "want", "userId": 7},
        {"action": "find", "why": "check_now", "userId": ""},
    ):
        assert handler.handle(bad, d) == {"action": "bad_event"}, bad
    assert not hasattr(d, "secrets")
    assert not hasattr(d, "net")  # no MCP client, no Secrets client
