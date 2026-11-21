"""robots.txt (docs/CONTRACTS.md §41.2 "robots.txt", §41.6 Tests P)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import fetch
from clipfactory_api.contentrewards.finder import robots, source
from finder_fakes import NOW, Monotonic, fixture, resolver, site, store, text

CR = fixture("robots.txt").decode()
UUID = "3d9ef19f-1256-47ca-b630-e33e2c923969"


@pytest.mark.parametrize(
    ("path", "allowed"),
    [
        ("/sitemap.xml", True),
        (f"/c/campaigns/{UUID}", True),
        ("/c/discover", True),
        ("/robots.txt", True),
        ("/api/campaign/campaigns/discover", False),
        (f"/api/campaign/campaigns/{UUID}", False),
        ("/home", False),
        ("/home/x", False),
        ("/home?x", False),
        ("/homepage", True),
        ("/dev/anything", False),
        ("/onboarding", False),
        ("/onboarding2", True),
    ],
)
def test_the_21_nov_file(path: str, allowed: bool) -> None:
    assert robots.parse(CR).allowed(path) is allowed
    assert robots.needed(robots.parse(CR))


def test_dollar_star_longest_match_and_allow_on_a_tie() -> None:
    rules = robots.parse(
        "User-agent: *\nDisallow: /*.json$\nDisallow: /a\nAllow: /a/b\nDisallow: /c/*/x\nAllow: /t\nDisallow: /t\n"
    )
    assert not rules.allowed("/data.json")
    assert rules.allowed("/data.json?x=1")  # $ anchors the end of the whole path and query
    assert not rules.allowed("/a/c")
    assert rules.allowed("/a/b/c")  # the longer Allow wins
    assert not rules.allowed("/c/campaigns/x")
    assert rules.allowed("/c/campaigns/y")
    assert rules.allowed("/t")  # same length: Allow wins


def test_the_clipfactory_group_wins_over_star_and_groups_join() -> None:
    text_ = (
        "User-agent: *\nDisallow: /\n\n"
        "User-agent: ClipFactory\nDisallow: /secret\n\n"
        "User-agent: other\nUser-agent: clipfactory/1\nDisallow: /also\n"
    )
    rules = robots.parse(text_)
    assert rules.allowed("/c/campaigns/x")
    assert not rules.allowed("/secret/1")
    assert not rules.allowed("/also")
    assert not robots.parse("User-agent: *\nDisallow: /\n").allowed("/sitemap.xml")


def test_empty_disallow_allows_all_and_percent_encoding_is_compared_decoded() -> None:
    assert robots.parse("User-agent: *\nDisallow:\n").allowed("/anything")
    rules = robots.parse("User-agent: *\nDisallow: /%7Euser\nDisallow: /a%2Fb\n")
    assert not rules.allowed("/~user/page")
    assert not rules.allowed("/a/b")
    assert not rules.allowed("/a%2fb")
    assert robots.parse("").allowed("/x")


def test_a_byte_order_mark_never_turns_the_file_into_allow_all() -> None:
    rules = robots.parse("\ufeffUser-agent: *\nDisallow: /api/\nDisallow: /home\n")
    assert not rules.allowed("/home")
    assert not rules.allowed("/api/x")
    assert rules.allowed(f"/c/campaigns/{UUID}")


def test_forbidding_what_is_needed_and_the_compact_copy() -> None:
    forbids = "User-agent: *\nDisallow: /c/campaigns/\n"
    assert not robots.needed(robots.parse(forbids))
    assert not robots.needed(robots.parse("User-agent: *\nDisallow: /sitemap.xml\n"))
    compact = robots.compact(CR)
    for path in ("/home?x", "/homepage", "/api/x", f"/c/campaigns/{UUID}", "/refer", "/referral"):
        assert robots.parse(compact).allowed(path) == robots.parse(CR).allowed(path)
    assert len(compact.encode()) <= 8 * 1024


def _look(state: dict[str, object], routes: dict[str, object] | None = None) -> tuple[source.Look, list[str]]:
    clock = Monotonic()
    fake = site(clock)
    fake.routes.update(routes or {})
    look = source.read(
        store(), state, {}, [], NOW, get=fetch.get, opener=fake, resolver=resolver, monotonic=clock, sleep=clock.sleep
    )
    return look, fake.urls()


def test_a_stale_copy_is_used_up_to_7_days_then_nothing_is_read() -> None:
    down = {"/robots.txt": text(b"", 500)}
    copy = {"text": "User-agent: *\nDisallow: /api/\n", "readAt": iso(NOW - timedelta(days=6))}
    look, urls = _look({"robots": copy}, down)
    assert urls[0] == "https://contentrewards.com/robots.txt"
    assert look.entries is not None  # the 6-day-old copy was used
    assert look.robots_kept is None
    old = {"text": copy["text"], "readAt": iso(NOW - timedelta(days=8))}
    look, urls = _look({"robots": old}, down)
    assert urls == ["https://contentrewards.com/robots.txt"]
    assert look.state == "down"
    look, urls = _look({}, down)
    assert (urls, look.state) == (["https://contentrewards.com/robots.txt"], "down")


def test_a_fresh_copy_is_not_read_again_and_a_new_one_is_kept() -> None:
    fresh = {"text": robots.compact(CR), "readAt": iso(NOW - timedelta(hours=3))}
    _, urls = _look({"robots": fresh})
    assert "https://contentrewards.com/robots.txt" not in urls
    look, urls = _look({"robots": {**fresh, "readAt": iso(NOW - timedelta(hours=25))}})
    assert urls[0] == "https://contentrewards.com/robots.txt"
    assert look.robots_kept == {"text": robots.compact(CR), "readAt": iso(NOW)}


def test_a_failed_read_is_a_try_and_the_copy_is_used_without_asking_again_for_24_hours() -> None:
    down = {"/robots.txt": text(b"", 500)}
    copy = {"text": robots.compact(CR), "readAt": iso(NOW - timedelta(days=2))}
    look, urls = _look({"robots": copy}, down)
    assert urls[0] == "https://contentrewards.com/robots.txt"
    assert look.entries is not None
    assert (look.robots_kept, look.robots_tried) == (None, {**copy, "triedAt": iso(NOW)})
    tried = {**copy, "triedAt": iso(NOW - timedelta(hours=23))}
    look, urls = _look({"robots": tried}, down)
    assert "https://contentrewards.com/robots.txt" not in urls  # tried 23 h ago: the 2-day-old copy is used
    assert (look.entries is not None, look.robots_tried) == (True, None)
    look, urls = _look({"robots": {**tried, "triedAt": iso(NOW - timedelta(hours=24))}}, down)
    assert urls[0] == "https://contentrewards.com/robots.txt"
    old = {**copy, "readAt": iso(NOW - timedelta(days=8)), "triedAt": iso(NOW - timedelta(hours=1))}
    look, urls = _look({"robots": old}, down)  # no usable copy: a try is all this look can do
    assert (urls, look.state) == (["https://contentrewards.com/robots.txt"], "down")


def test_a_byte_order_mark_in_the_file_read() -> None:
    look, urls = _look({}, {"/robots.txt": text(b"\xef\xbb\xbfUser-agent: *\nDisallow: /c/\n")})
    assert (look.state, urls) == ("not_allowed", ["https://contentrewards.com/robots.txt"])
    assert look.robots_kept == {"text": "User-agent: *\nDisallow: /c/\n", "readAt": iso(NOW)}


def test_forbidding_robots_means_not_allowed_and_nothing_else_is_read() -> None:
    look, urls = _look({}, {"/robots.txt": text(b"User-agent: *\nDisallow: /c/\n")})
    assert look.state == "not_allowed"
    assert urls == ["https://contentrewards.com/robots.txt"]


def test_a_web_page_in_place_of_robots_txt_is_never_allow_all() -> None:
    page = (200, {"content-type": "text/html"}, b"<html><body>Just a moment...</body></html>")
    look, urls = _look({}, {"/robots.txt": page})
    assert look.state == "down"
    assert urls == ["https://contentrewards.com/robots.txt"]
