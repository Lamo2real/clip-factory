"""A campaign page's data (docs/CONTRACTS.md §41.2 "The page parser", §41.6 Tests P)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api.contentrewards.finder import rsc
from finder_fakes import fixture, samples

PICKLE = "3d9ef19f-1256-47ca-b630-e33e2c923969"
COD = "a1cefc3b-4533-438f-8e70-a7299550f1cf"
KAI = "1d2bcb00-c904-415f-aa82-f95b96baad86"
UNGODLY = "0d341d7d-e390-4807-9149-9b5294dff3e6"
OTHERS = ("topClips", "topEarners", "chartPoints", "username", "whopUsername")


def _page(name: str) -> str:
    return fixture(name).decode("utf-8")


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def _defined(value: Any) -> Any:
    """A saved sample as the stream means it: ``"$undefined"`` is an absent key."""
    if isinstance(value, dict):
        return {k: _defined(v) for k, v in value.items() if v != "$undefined"}
    if isinstance(value, list):
        return [_defined(v) for v in value]
    return value


def _stream_page(stream: str, robots: str = "index, follow") -> str:
    half = len(stream) // 2
    pushes = "".join(
        f"<script>self.__next_f.push([1,{json.dumps(part)}])</script>" for part in (stream[:half], stream[half:])
    )
    return f'<html><head><meta name="robots" content="{robots}"/></head><body>{pushes}</body></html>'


@pytest.mark.parametrize(
    ("name", "uuid", "sample"),
    [
        ("page-open.html", PICKLE, "d18-pickleball"),
        ("page-geo.html", COD, "d04-cod-dmz"),
        ("page-pool.html", KAI, "d05-kai-pool"),
        ("page-apply.html", UNGODLY, "d11-ungodly-apply"),
    ],
)
def test_each_trimmed_page_has_its_detail_and_card(name: str, uuid: str, sample: str) -> None:
    page = rsc.page(200, _page(name), uuid)
    assert page.kind == "campaign"
    pair = _defined(samples()[sample])
    assert page.detail == pair["detail"]  # the same object §38.10 reads as JSON (T rows resolved)
    assert page.card is not None
    assert {k: v for k, v in page.card.items() if k != "metrics"} == {
        k: v for k, v in pair["card"].items() if k != "metrics"
    }
    assert not _keys(page.detail) & set(OTHERS)
    assert not _keys(page.card) & set(OTHERS)  # other creators' parts are dropped while parsing


def test_a_t_row_is_resolved_and_the_stream_is_joined_across_pushes() -> None:
    page = rsc.page(200, _page("page-apply.html"), UNGODLY)
    guidelines = page.detail["configuration"]["content"]["guidelines"]
    assert guidelines.startswith("• The clip: Drop us into the fight.")
    assert len(rsc.pushes(_page("page-open.html"))) == 3
    assert rsc.page(200, _page("page-open.html"), PICKLE).detail["description"].startswith("Clip official CNPL")


def test_strings_undefined_double_dollar_refs_and_utf8_lengths() -> None:
    text = "Ünïcode ✂️ clip"
    size = len(text.encode())
    data = {
        "id": PICKLE,
        "name": "$$3,000 8lanco 'Every Little Thing' Sound Campaign",
        "gone": "$undefined",
        "list": ["a", "$undefined"],
        "description": "$5a",
        "other": "$L2b",
        "missing": "$99",
        "username": "someone",
        "metrics": {"topClips": [{"username": "x"}], "budgetSpentCents": 5},
    }
    row = [
        "$",
        "$L2b",
        None,
        {"state": {"queries": [{"queryKey": ["campaigns", "detail", PICKLE], "state": {"data": data}}]}},
    ]
    stream = f'1:"$Sreact.fragment"\n5a:T{size:x},{text}18:{json.dumps(row)}\n'
    found = rsc.queries(_stream_page(stream))
    detail = found[("campaigns", "detail", PICKLE)]
    assert detail["name"] == "$3,000 8lanco 'Every Little Thing' Sound Campaign"
    assert "gone" not in detail
    assert detail["list"] == ["a", None]
    assert detail["description"] == text
    assert detail["other"] == "$L2b"
    assert detail["missing"] == "$99"
    assert "username" not in detail
    assert detail["metrics"] == {"budgetSpentCents": 5}


def test_undefined_on_a_real_page_is_an_absent_key() -> None:
    assert samples()["d05-kai-pool"]["detail"]["organization"]["logoUrl"] == "$undefined"
    page = rsc.page(200, _page("page-pool.html"), KAI)
    assert "logoUrl" not in page.detail["organization"]


def test_query_keys_that_are_not_lists_are_skipped() -> None:
    found = rsc.queries(_page("page-geo.html"))
    assert ("user", "me") in found
    assert all(isinstance(k, tuple) for k in found)
    assert not any(k[0].startswith("$") for k in found)


def test_gone_changed_and_challenge_pages() -> None:
    assert rsc.page(200, _page("page-soft-404.html"), PICKLE).kind == "gone"
    assert rsc.page(404, "", PICKLE).kind == "gone"
    assert rsc.page(200, _page("page-changed.html"), PICKLE).kind == "unreadable"
    assert rsc.page(200, _page("page-challenge.html"), PICKLE).kind == "challenge"
    # a bot wall that also says noindex is still a challenge, never a removed campaign
    wall = '<html><head><meta name="robots" content="noindex,nofollow"></head><body>Just a moment...</body></html>'
    assert rsc.page(200, wall, PICKLE).kind == "challenge"
    # the right page shape for another campaign is not this one
    assert rsc.page(200, _page("page-open.html"), COD).kind == "unreadable"
    assert rsc.noindex(_page("page-soft-404.html"))
    assert not rsc.noindex(_page("page-open.html"))


def test_a_detail_whose_id_differs_is_not_the_campaign() -> None:
    row = [
        "$",
        "$L2b",
        None,
        {"state": {"queries": [{"queryKey": ["campaigns", "detail", PICKLE], "state": {"data": {"id": COD}}}]}},
    ]
    assert rsc.page(200, _stream_page(f"18:{json.dumps(row)}\n"), PICKLE).kind == "unreadable"


def test_broken_rows_never_raise() -> None:
    stream = '18:{"queries": [not json\nzz:nothing\n5a:Tffff,short'
    assert rsc.queries(_stream_page(stream)) == {}
    assert rsc.page(200, _stream_page(stream), PICKLE).kind == "unreadable"
