"""``sitemap.xml`` and ``entriesGz`` (docs/CONTRACTS.md §41.2 row 2, §41.5 data, §41.6 Tests P)."""

from __future__ import annotations

import json
import random
import uuid as uuidlib
from datetime import UTC, datetime

from clipfactory_api.contentrewards.finder import config, sitemap
from finder_fakes import Monotonic, fixture, look, samples, site, store, xml

PICKLE = "3d9ef19f-1256-47ca-b630-e33e2c923969"


def _urlset(*urls: str) -> bytes:
    body = "".join(urls)
    return f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'.encode()


def _url(loc: str, lastmod: str | None = "2026-11-14T17:23:44.000Z") -> str:
    mod = f"<lastmod>{lastmod}</lastmod>" if lastmod is not None else ""
    return f"<url><loc>{loc}</loc>{mod}</url>"


def test_the_trimmed_sitemap_keeps_only_campaign_pages_with_lastmod_as_listed_at() -> None:
    found = sitemap.parse(fixture("sitemap.xml"))
    assert found.kind == "urlset"
    uuids = [u for u, _ in found.entries]
    assert len(uuids) == len(set(uuids)) >= 20
    listed = {pair["detail"]["id"]: pair["card"]["listedAt"] for pair in samples().values()}
    lastmods = dict(found.entries)
    for uuid, at in listed.items():
        assert lastmods[uuid] == int(datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp())
    assert "237c2143-cbcc-4296-81f1-7da057a53264" not in lastmods  # ForgeGUI's missing sibling


def test_only_exact_campaign_locs() -> None:
    body = _urlset(
        _url(f"https://contentrewards.com/c/campaigns/{PICKLE.upper()}"),
        _url("https://contentrewards.com/c/campaigns/a1cefc3b-4533-438f-8e70-a7299550f1cf?group=1"),
        _url("https://contentrewards.com/c/campaigns/c0c37381-e244-4643-98bd-edbff4bc1465#x"),
        _url("https://contentrewards.com/c/campaigns/c49840ae-ca22-4745-8a42-b675847e0355/"),
        _url("https://www.contentrewards.com/c/campaigns/e4a9465f-d415-4e30-bf53-e46014958bc6"),
        _url("http://contentrewards.com/c/campaigns/d5d8b659-68ac-41d5-9e53-ab89545f437d"),
        _url("https://contentrewards.com/c/discover"),
        _url("https://contentrewards.com/c/campaigns/1d2bcb00-c904-415f-aa82-f95b96baad86", None),
        _url("https://contentrewards.com/c/campaigns/2eaa14fb-6927-4136-897e-b096e0d907d6", "2026-11-18"),
        _url("https://contentrewards.com/c/campaigns/6e8cb2c6-7724-44a4-83da-66697acb20af", "soon"),
        _url(f"https://contentrewards.com/c/campaigns/{PICKLE}"),  # a repeat
    )
    found = sitemap.parse(body).entries
    assert found == [
        (PICKLE, 1794677024),
        ("1d2bcb00-c904-415f-aa82-f95b96baad86", None),
        ("2eaa14fb-6927-4136-897e-b096e0d907d6", int(datetime(2026, 11, 18, tzinfo=UTC).timestamp())),
        ("6e8cb2c6-7724-44a4-83da-66697acb20af", None),
    ]


def test_an_index_names_at_most_5_children_on_contentrewards_com() -> None:
    found = sitemap.parse(fixture("sitemap-index.xml"))
    assert found.kind == "index"
    assert found.children == [
        "https://contentrewards.com/sitemap-campaigns-1.xml",
        "https://contentrewards.com/sitemap-campaigns-2.xml",
    ]
    many = "".join(f"<sitemap><loc>https://contentrewards.com/s{i}.xml</loc></sitemap>" for i in range(9))
    assert len(sitemap.parse(f"<sitemapindex>{many}</sitemapindex>".encode()).children) == 5


def test_the_5000_cap() -> None:
    rng = random.Random(7)
    locs = [str(uuidlib.UUID(int=rng.getrandbits(128), version=4)) for _ in range(5100)]
    found = sitemap.parse(_urlset(*(_url(f"https://contentrewards.com/c/campaigns/{u}") for u in locs)))
    assert len(found.entries) == config.MAX_ENTRIES
    assert [u for u, _ in found.entries] == locs[:5000]
    assert len(sitemap.merge([found.entries, found.entries])) == 5000


def test_entries_gz_round_trip_and_the_state_item_stays_under_350_kb() -> None:
    rng = random.Random(3)
    entries = [
        (str(uuidlib.UUID(int=rng.getrandbits(128), version=4)), 1_700_000_000 + rng.randrange(10**8))
        for _ in range(5000)
    ]
    entries[7] = (entries[7][0], None)
    blob = sitemap.entries_gz(entries)
    assert sitemap.entries_from_gz(blob) == entries

    class Binary:  # boto3's Binary keeps the bytes in .value
        def __init__(self, value: bytes) -> None:
            self.value = value

    assert sitemap.entries_from_gz(Binary(blob)) == entries
    assert sitemap.entries_from_gz(b"not gzip") == []
    assert sitemap.entries_from_gz(None) == []
    robots_text = "User-agent: *\n" + "Disallow: /x\n" * ((8 * 1024 - 14) // 13)
    item = {
        "pk": "CRPUBLIC",
        "sk": "STATE",
        "type": "crpublicstate",
        "robots": {"text": robots_text[: 8 * 1024], "readAt": "2026-11-21T12:00:00.000Z"},
        "lastLookAt": "2026-11-21T12:00:00.000Z",
        "lastReadAt": "2026-11-21T12:00:00.000Z",
        "sitemapAt": "2026-11-21T12:00:00.000Z",
        "nextRunAt": "2026-11-21T18:00:00.000Z",
        "runningUntil": "2026-11-21T12:02:30.000Z",
        "backoffUntil": "2026-11-21T13:00:00.000Z",
        "backoffLooks": 3,
        "blockedLooks": 2,
        "readsToday": {"day": "2026-11-21", "n": 6},
        "cached": 5000,
        "sourceState": "ok",
    }
    size = len(json.dumps(item).encode()) + len("entriesGz") + len(blob)  # names + values, a generous estimate
    assert size < config.STATE_MAX_BYTES


def test_the_reader_follows_an_index_only_on_contentrewards_com() -> None:
    clock = Monotonic()
    fake = site(clock, sitemap=fixture("sitemap-index.xml"))
    one = _urlset(_url(f"https://contentrewards.com/c/campaigns/{PICKLE}"))
    two = _urlset(_url("https://contentrewards.com/c/campaigns/a1cefc3b-4533-438f-8e70-a7299550f1cf"))
    fake.routes["/sitemap-campaigns-1.xml"] = xml(one)
    fake.routes["/sitemap-campaigns-2.xml"] = xml(two)
    found = look(store(), fake)
    assert [u for u, _ in found.entries or []] == [PICKLE, "a1cefc3b-4533-438f-8e70-a7299550f1cf"]
    assert all(c.host == "contentrewards.com" for c in fake.calls)
    assert "https://elsewhere.example/sitemap.xml" not in fake.urls()


def test_a_sitemap_over_4_mb_or_without_campaigns_is_not_read() -> None:
    clock = Monotonic()
    big = site(clock, sitemap=b"<urlset>" + b" " * (4 * 1024 * 1024) + b"</urlset>")
    found = look(store(), big)
    assert (found.entries, found.stopped, big.pages()) == (None, "sitemap", [])
    assert big.calls[-1].max_bytes == 4 * 1024 * 1024
    empty = site(clock, sitemap=_urlset(_url("https://contentrewards.com/c/discover")))
    found = look(store(), empty)
    assert (found.entries, empty.pages()) == (None, [])
