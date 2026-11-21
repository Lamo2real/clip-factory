"""Lamo Stories' own Lambda serves exactly the /v1/workspaces routes, and Clip Factory's table has none of them
(docs/CONTRACTS.md §45.5, §45.17, ADR-76)."""

from __future__ import annotations

import ws_routes_ai
import ws_routes_core
import ws_routes_social
from clipfactory_api.routes import ROUTES as CLIPS_ROUTES
from clipfactory_api.workspaces import http as ws_http
from clipfactory_api.workspaces.routes import ROUTES
from conftest import make_event


def test_every_workspace_route_is_registered_and_nothing_else() -> None:
    expected = ws_routes_core.EXPECTED | ws_routes_social.EXPECTED | ws_routes_ai.EXPECTED
    for method, path in expected:
        assert path.startswith("/v1/workspaces"), path
        assert any(r.method == method and r.pattern.match(path) for r in ROUTES), (method, path)
    assert len(ROUTES) == len(expected)
    for r in ROUTES:
        assert r.pattern.pattern.startswith("^/v1/workspaces"), r.pattern.pattern


def test_clip_factory_routes_have_no_workspace_route() -> None:
    assert not [r for r in CLIPS_ROUTES if "/v1/workspaces" in r.pattern.pattern]


def test_the_stories_lambda_does_not_load_clip_factorys_route_table() -> None:
    import subprocess
    import sys

    code = "import sys, clipfactory_api.workspaces.http as h; import clipfactory_api.workspaces.routes; print('clipfactory_api.routes' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


def test_the_stories_lambda_answers_404_outside_its_routes() -> None:
    out = ws_http.dispatch(make_event("GET", "/v1/jobs"), lambda: None, ROUTES)  # type: ignore[arg-type,return-value]
    assert out["statusCode"] == 404
