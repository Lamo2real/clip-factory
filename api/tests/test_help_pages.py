"""HelpContext.page is the web router's Route["name"] (docs/CONTRACTS.md §19.6): every page the app can be on must
be one the API accepts, or Ask fails with a 400 on that page (audit F004: skill pages)."""

from __future__ import annotations

import re

import pytest

from clipfactory_api.help import retrieve
from clipfactory_api.routes import help as help_route
from help_support import REPO

ROUTER = REPO / "web" / "src" / "lib" / "router.ts"
TYPES = REPO / "web" / "src" / "features" / "help" / "types.ts"


def _route_names() -> set[str]:
    text = ROUTER.read_text()
    block = text[text.index("export type Route =") : text.index("export const MOTION_GALLERY_PATH")]
    return set(re.findall(r'\{\s*name:\s*"([a-z_]+)"', block))


def _client_pages() -> set[str]:
    text = TYPES.read_text()
    found = re.search(r"HELP_PAGES = \[([^\]]*)\]", text)
    assert found, "HELP_PAGES not found in types.ts"
    return set(re.findall(r'"([a-z_]+)"', found.group(1)))


def test_the_router_has_routes() -> None:
    assert {"home", "settings", "skill", "not_found"} <= _route_names()


def test_every_route_name_is_an_accepted_page() -> None:
    assert _route_names() <= help_route.PAGES


def test_every_page_the_client_sends_is_accepted() -> None:
    assert _client_pages() <= help_route.PAGES
    assert _client_pages() <= _route_names()


@pytest.mark.parametrize("page", sorted(_route_names()))
def test_parse_accepts_every_route_name(page: str) -> None:
    class _Req:
        def json(self) -> dict[str, object]:
            return {"question": "How do I write a skill?", "context": {"device": "desktop", "os": "mac", "page": page}}

    question, _, context = help_route._parse(_Req())  # type: ignore[arg-type]
    assert question == "How do I write a skill?"
    assert context is not None
    assert context.page == page


def test_a_skill_page_boosts_like_settings() -> None:
    assert retrieve.boost_page("skill") == "settings"
    assert retrieve.boost_page("settings") == "settings"
    assert retrieve.boost_page("home") == "home"
    assert retrieve.boost_page(None) is None
