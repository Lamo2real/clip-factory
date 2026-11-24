"""The links a reference video may come from (docs/CONTRACTS.md §45.40): the agent's copy of the allowlist gives every
answer of the shared fixture (``fixtures/reference_links.json``, read by the API's and the web's suites too), and its
code is the API's copy, line for line (a copy, never an import: the isolation test forbids ``clipfactory_*``)."""

from __future__ import annotations

import ast
import json
from typing import Any

import pytest

from lamostories_agent import reflinks
from ls_fakes import FIXTURES, REPO

FIXTURE = json.loads((FIXTURES / "reference_links.json").read_text("utf-8"))
GOOD = [c for c in FIXTURE["cases"] if "url" in c]
BAD = [c for c in FIXTURE["cases"] if "why" in c]


def test_the_fixture_names_every_site_and_every_refusal() -> None:
    assert FIXTURE["sites"] == reflinks.SITE_NAMES
    assert FIXTURE["platforms"] == list(reflinks.PLATFORMS)
    assert {c["site"] for c in GOOD} == set(reflinks.SITES)
    assert {c["why"] for c in BAD} == set(reflinks.WHYS) == set(reflinks.SENTENCES)


@pytest.mark.parametrize("case", GOOD, ids=[c["in"][:60] for c in GOOD])
def test_a_good_link_is_cleaned(case: dict[str, str]) -> None:
    assert reflinks.clean_link(case["in"]) == (case["url"], case["site"])
    assert reflinks.clean_link(case["url"]) == (case["url"], case["site"])  # a cleaned link stays as it is
    assert reflinks.site_of(case["url"]) == case["site"]


@pytest.mark.parametrize("case", BAD, ids=[c["in"][:60] or "empty" for c in BAD])
def test_a_bad_link_says_why(case: dict[str, str]) -> None:
    with pytest.raises(reflinks.LinkRefused) as e:
        reflinks.clean_link(case["in"])
    assert e.value.why == case["why"]
    assert e.value.sentence == reflinks.SENTENCES[case["why"]]


def test_at_most_2048_characters_and_never_a_control_character() -> None:
    for text in ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=" + "a" * 2048, "https://youtu.be/dQw4w9WgXcQ\x00",
                 "x" * 5000, 7):  # fmt: skip
        with pytest.raises(reflinks.LinkRefused) as e:
            reflinks.clean_link(text)  # type: ignore[arg-type]
        assert e.value.why == "not_a_link"
    assert reflinks.site_of("https://vimeo.com/1") is None


def _code(path: Any) -> str:
    """The module without its docstring: what must be the same in both copies."""
    tree = ast.parse(path.read_text("utf-8"))
    body = tree.body[1:] if isinstance(tree.body[0], ast.Expr) else tree.body
    return "\n".join(ast.unparse(node) for node in body)


def test_the_api_s_copy_is_the_same_code() -> None:
    api = REPO / "api" / "src" / "clipfactory_api" / "workspaces" / "reflinks.py"
    mine = REPO / "stories" / "agent" / "src" / "lamostories_agent" / "reflinks.py"
    assert _code(api) == _code(mine)
