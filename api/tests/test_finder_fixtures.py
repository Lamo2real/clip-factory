"""The committed finder fixtures carry no other creator's data (docs/CONTRACTS.md §41.6 Tests P)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

import finder_cases
from clipfactory_api.contentrewards.finder import rsc

FILES = sorted(p for p in finder_cases.FIXTURES.iterdir() if p.is_file())
OTHERS = ("topClips", "topEarners", "chartPoints")


def _walk(value: Any, path: str = "") -> list[str]:
    bad: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("username", "whopUsername"):
                bad.append(f"{path}.{key}")
            if key in OTHERS and child not in ([], None):
                bad.append(f"{path}.{key}")
            bad += _walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for i, child in enumerate(value):
            bad += _walk(child, f"{path}[{i}]")
    return bad


def _stream_values(path: Path) -> list[Any]:
    stream = "".join(rsc.pushes(path.read_text(encoding="utf-8")))
    values = []
    for _rid, kind, text in rsc.rows(stream):
        if kind == "J" and text[:1] in "[{":
            try:
                values.append(json.loads(text))
            except ValueError:
                continue
    return values


def test_the_fixture_set() -> None:
    names = {p.name for p in FILES}
    assert names == {
        "samples.json", "match_cases.json", "normalize_cases.json", "plan_cases.json", "robots.txt", "sitemap.xml",
        "sitemap-index.xml", "page-open.html", "page-apply.html", "page-pool.html", "page-geo.html",
        "page-soft-404.html", "page-changed.html", "page-challenge.html",
    }  # fmt: skip


@pytest.mark.parametrize("path", FILES, ids=[p.name for p in FILES])
def test_no_username_and_no_other_creators_parts(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    assert "username" not in text.lower()
    assert "whopusername" not in text.lower()
    if path.suffix == ".json":
        assert _walk(json.loads(text)) == []
    if path.suffix == ".html":
        for value in _stream_values(path):
            assert _walk(value) == []
        for name in OTHERS:
            assert not re.search(rf'\\"{name}\\":\[(?!\])', text), name
        assert not re.search(r"avatarUrl|postUrl|tiktok\.com/@|\"userId\\\"", text)


def test_the_pages_keep_only_the_stream_and_the_robots_meta() -> None:
    for path in FILES:
        if path.suffix != ".html" or path.name == "page-challenge.html":
            continue
        text = path.read_text(encoding="utf-8")
        scripts = re.findall(r"<script[^>]*>(.*?)</script>", text, re.DOTALL)
        assert all(
            s.startswith(("self.__next_f.push([1,", "(self.__next_f=self.__next_f||[]).push([0])")) for s in scripts
        )
        assert re.findall(r"<meta name=\"robots\"", text), path.name
        assert "<img" not in text
        assert "<a " not in text


def test_the_committed_cases_are_what_finder_cases_writes() -> None:
    for name, made in (
        ("match_cases.json", finder_cases.match_cases()),
        ("normalize_cases.json", finder_cases.normalize_cases()),
        ("plan_cases.json", finder_cases.plan_cases()),
    ):
        assert json.loads((finder_cases.FIXTURES / name).read_text(encoding="utf-8")) == made, name


def test_the_cleaner() -> None:
    raw = {"metrics": {"topClips": [{"username": "a"}], "chartPoints": [1], "budgetSpentCents": 3}, "username": "b"}
    assert finder_cases.clean(raw, empty=True) == {
        "metrics": {"topClips": [], "chartPoints": [], "budgetSpentCents": 3}
    }
    assert finder_cases.clean(raw, empty=False) == {"metrics": {"budgetSpentCents": 3}}
    rows = [("50", "T", "Ünï ✂️"), ("18", "J", '{"a":1}')]
    assert finder_cases.stream_rows(finder_cases.build_stream(rows)) == rows
