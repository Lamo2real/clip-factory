"""Lamo Stories social accounts, developer apps, publish and publishing jobs, and its own OAuth callback
(docs/CONTRACTS.md §45.5, §45.13, §45.14, §45.30). Served only by Lamo Stories' own Lambda (``workspaces/http.py``).

Every ``/v1/workspaces`` route here is **S** (a ``stories`` workspace; Lamo Clips' id is a 409) and builds every key
from the JWT's ``sub`` and the path's workspace id (``workspaces.guard``). Tokens and app secrets never leave
Secrets Manager: no response, item or log holds one. Of Clip Factory's data only the five comparable attributes of
its ``ACCOUNT#`` items and, for the shared-app choice, its YouTube, TikTok and X app keys are ever read.

``CALLBACK_ROUTES`` holds the public ``GET /v1/stories-oauth/{platform}/callback`` (§45.13.3: no JWT; the signed,
single-use state is its authorization). It is kept out of ``ROUTES`` because ``ROUTES`` is, by its test, exactly the
JWT ``/v1/workspaces`` table; ``workspaces/http.py`` (not builder B's file) must dispatch ``CALLBACK_ROUTES`` too
before API Gateway's public route reaches it.
"""

from __future__ import annotations

import os
from typing import Any

from ... import validate
from ...app import App
from ...errors import ApiError, bad_request, not_found
from ...http import Request, Response, no_content, ok, route
from ...oauth import OAuthEnv
from ...workspaces import deps as ws_deps
from ...workspaces import flow as ws_flow
from ...workspaces import guard, publish, social, social_callback
from ...workspaces import secrets as ws_secrets
from ...workspaces import types as ws

WS = "/v1/workspaces/{ws}"
CALLBACK_PATH = "/v1/stories-oauth/{platform}/callback"


def _workspace(app: App, req: Request) -> dict[str, object]:
    return guard.require_workspace(app.store, req.user_id, req.params["ws"], stories=True, now=app.clock())


def _platform(req: Request) -> str:
    platform = req.params["platform"]
    if platform not in ws.PLATFORMS:
        raise not_found("We do not support that platform.")
    return platform


def _env(app: App) -> OAuthEnv:
    if app.oauth is None:
        raise ApiError(503, "unavailable", social.NOT_ON)
    return app.oauth


def _secrets_or_none(app: App) -> ws_secrets.WorkspaceSecrets | None:
    """The workspace secrets from ``workspaces.deps`` (tests install fakes); built once from the environment."""
    deps = ws_deps.of(app)
    if deps.secrets is None:
        deps.secrets = ws_secrets.from_env()
    found: ws_secrets.WorkspaceSecrets | None = deps.secrets
    return found


def _secrets(app: App) -> ws_secrets.WorkspaceSecrets:
    return social.secrets_or_503(_secrets_or_none(app))


def _starter(app: App) -> Any:
    """The story flow starter from ``workspaces.deps`` (tests install fakes); None while ``STORY_FLOW_ARN`` is empty
    (publishing not switched on)."""
    deps = ws_deps.of(app)
    if deps.flow is None and deps.story_flow_arn:
        deps.flow = ws_flow.from_env(deps.story_flow_arn)
    return deps.flow


def _scope(app: App, req: Request) -> social.Scope:
    """The checked workspace (404 / 409 otherwise) as the scope every key and secret name is built from."""
    workspace = _workspace(app, req)
    return social.Scope(app.store, _secrets(app), req.user_id, str(workspace["workspaceId"]))


def _account(app: App, scope: social.Scope, platform: str) -> Response:
    return ok({"account": social.public_of(scope, platform, app.clock())})


# --- social accounts -------------------------------------------------------------------------------------------


def list_social(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    _env(app)
    return ok(social.list_accounts(scope, app.clock()))


def connect(app: App, req: Request) -> Response:
    """Connect and Reconnect: the same call (the account keeps its ``socialAccountId``)."""
    scope = _scope(app, req)
    platform = _platform(req)
    validate.only_keys(req.json(), set())
    return ok(social.connect(scope, _env(app), platform, app.clock()))


def choose(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    body = req.json()
    validate.only_keys(body, {"choiceId"})
    choice = validate.required_string(body, "choiceId", max_len=64)
    social.choose(scope, _env(app), platform, choice, app.clock())
    return _account(app, scope, platform)


def share(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    body = req.json()
    validate.only_keys(body, {"confirm"})
    if body.get("confirm") is not True:
        raise bad_request("Tap Use it for both again to say yes.", "confirm")
    _env(app)
    social.share(scope, platform, app.clock())
    return _account(app, scope, platform)


def check(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    validate.only_keys(req.json(), set())
    social.check(scope, _env(app), platform, app.clock())
    return _account(app, scope, platform)


def tiktok_creator_info(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    return ok({"creator": social.creator_info(scope, _env(app))})


def disconnect(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    _env(app)
    social.disconnect(scope, platform, app.clock())
    return no_content()


# --- the developer app (§45.30) -------------------------------------------------------------------------------


def put_app(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    _env(app)
    return ok({"account": social.set_app(scope, platform, req.json(), app.clock())})


def check_app(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    validate.only_keys(req.json(), set())
    return ok({"check": social.check_app(scope, _env(app), platform, app.clock())})


def delete_app(app: App, req: Request) -> Response:
    scope = _scope(app, req)
    platform = _platform(req)
    _env(app)
    social.delete_app(scope, platform, app.clock())
    return no_content()


# --- publishing ------------------------------------------------------------------------------------------------


def publish_story(app: App, req: Request) -> Response:
    workspace = _workspace(app, req)
    _env(app)
    scope = social.Scope(app.store, _secrets(app), req.user_id, str(workspace["workspaceId"]))
    jobs = publish.publish(scope, _starter(app), workspace, req.params["storyId"], req.json(), now=app.clock())
    return ok({"publishingJobs": jobs}, status=202)


def list_publishing(app: App, req: Request) -> Response:
    workspace = _workspace(app, req)
    story_id = req.query.get("storyId") or None
    found = publish.list_jobs(app.store, req.user_id, str(workspace["workspaceId"]), story_id)
    settled = publish.settle_stuck(app.store, found, app.clock())  # a job whose flow is gone shows Try again
    return ok({"publishingJobs": [publish.public_job(j) for j in settled]})


def retry_publishing(app: App, req: Request) -> Response:
    workspace = _workspace(app, req)
    _env(app)
    scope = social.Scope(app.store, _secrets(app), req.user_id, str(workspace["workspaceId"]))
    job = publish.retry(scope, _starter(app), workspace, req.params["publishingJobId"], req.json(), now=app.clock())
    return ok({"publishingJob": job}, status=202)


# --- Lamo Stories' own OAuth callback (§45.13.3) -----------------------------------------------------------------


def oauth_callback(app: App, req: Request) -> Response:
    """Public: the signed single-use ``w1.`` state is the only authorization. Always ``302`` to Lamo Stories'
    Social accounts page with a listed code; nothing from the request is reflected."""
    platform = str(req.params.get("platform") or "")
    env = app.oauth
    result, workspace_id = "error", None
    if env is not None:
        result, workspace_id = social_callback.handle(platform, req.query, app.store, env, _secrets_or_none(app))
    app_url = env.app_url if env is not None else os.environ.get("APP_URL", "")
    headers = {
        "location": social_callback.landing(app_url, platform, result, workspace_id),
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
    }
    return Response(302, None, headers)


ROUTES = [
    route("GET", f"{WS}/social", list_social),
    route("POST", f"{WS}/social/{{platform}}/connect", connect),
    route("POST", f"{WS}/social/{{platform}}/choose", choose),
    route("POST", f"{WS}/social/{{platform}}/share", share),
    route("POST", f"{WS}/social/{{platform}}/check", check),
    route("GET", f"{WS}/social/tiktok/creator-info", tiktok_creator_info),
    route("DELETE", f"{WS}/social/{{platform}}", disconnect),
    route("PUT", f"{WS}/social/{{platform}}/app", put_app),
    route("POST", f"{WS}/social/{{platform}}/app/check", check_app),
    route("DELETE", f"{WS}/social/{{platform}}/app", delete_app),
    route("POST", f"{WS}/stories/{{storyId}}/publish", publish_story),
    route("GET", f"{WS}/publishing", list_publishing),
    route("POST", f"{WS}/publishing/{{publishingJobId}}/retry", retry_publishing),
]

# Public (no JWT). Not in ROUTES: see the module docstring.
CALLBACK_ROUTES = [route("GET", CALLBACK_PATH, oauth_callback, public=True)]
