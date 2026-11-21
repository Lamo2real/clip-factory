"""Shared seeds for the Lamo Stories social and publishing tests (docs/CONTRACTS.md §45.13, §45.14, §45.30).
Fakes only.

The routes are served by Lamo Stories' own Lambda (``workspaces/http.py``), so these tests dispatch with
``workspaces.routes.ROUTES`` plus the public callback (``ws_call``), never with Clip Factory's route table. The
developer app of every seeded account follows §45.30: Facebook and Instagram always Lamo Stories' own Meta app;
YouTube, TikTok and X Clip Factory's app unless a test picks ``own``.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

from clipfactory_api import db, hooks
from clipfactory_api.app import App
from clipfactory_api.http import dispatch
from clipfactory_api.oauth import META, OAuthEnv, formats, setup
from clipfactory_api.workspaces import deps, guard
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.routes import ROUTES as WS_ROUTES
from clipfactory_api.workspaces.routes.social import CALLBACK_ROUTES
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from conftest import APP_URL, NOW, USER, Call, Clock, make_event
from fakes import FakeSecretsManager, FakeSSM, FakeTable
from test_oauth_state_formats import GOOD

WS = "stories"
PK = ws.workspace_pk(USER, WS)
APP = "cf-prod/platforms/"
WSP = "cf-prod/workspaces/"
STORY_ID = "01JZ0000000000000000000ST1"
STORY_FLOW_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-story-flow:live"
# Lamo Stories' own callback base (STORIES_OAUTH_CALLBACK): {apiUrl}/v1/stories-oauth
STORIES_CALLBACK = "https://api123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth"
SHARED = ("youtube", "tiktok", "x")
IDENTITY = {"youtube": "UC-STORIES", "tiktok": "open-stories", "instagram": "1799", "facebook": "p9", "x": "77"}
CLIPS_IDENTITY = {"youtube": "UC123", "tiktok": "open-1", "instagram": "1784", "facebook": "p1", "x": "42"}
TOKENS = {
    "youtube": {
        "accessToken": "ya29.WS-ACCESS",
        "expiresAt": "2026-11-15T14:00:00.000Z",
        "refreshToken": "1//WS-REFRESH",
        "channelId": IDENTITY["youtube"],
    },
    "tiktok": {
        "accessToken": "act.WS-ACCESS",
        "expiresAt": "2026-11-15T14:00:00.000Z",
        "refreshToken": "rft.WS-REFRESH",
        "refreshExpiresAt": "2027-11-15T12:00:00.000Z",
        "openId": IDENTITY["tiktok"],
        "username": "lamostories",
    },
    "instagram": {"pageAccessToken": "EAAG-WS-PAGE", "pageId": "p9", "igUserId": IDENTITY["instagram"], "userId": "u1"},
    "facebook": {"pageAccessToken": "EAAG-WS-FB", "pageId": IDENTITY["facebook"], "userId": "u1"},
    "x": {
        "accessToken": "X-WS-ACCESS",
        "expiresAt": "2026-11-15T14:00:00.000Z",
        "refreshToken": "X-WS-REFRESH",
        "xUserId": IDENTITY["x"],
        "username": "lamostories",
    },
}
WS_SECRET_VALUES = [
    "ya29.WS-ACCESS",
    "1//WS-REFRESH",
    "act.WS-ACCESS",
    "rft.WS-REFRESH",
    "EAAG-WS-PAGE",
    "EAAG-WS-FB",
    "X-WS-ACCESS",
    "X-WS-REFRESH",
]


class FakeStarter:
    """Stands in for ``workspaces.flow.StoryFlowStarter``."""

    def __init__(self, *, fail: bool = False) -> None:
        self.ready = True
        self.fail = fail
        self.started: list[dict[str, Any]] = []

    def start(self, user_id: str, workspace_id: str, story_id: str, ids: list[str], run: int) -> Any:
        from clipfactory_api.workspaces.flow import FlowStartError, Started, story_flow_name

        if self.fail:
            raise FlowStartError("invoke failed: ServiceException")
        self.started.append(
            {"userId": user_id, "workspaceId": workspace_id, "storyId": story_id, "publishingJobIds": ids, "run": run}
        )
        return Started(story_flow_name(story_id, run), "arn:x")


def install(app: App, secrets_client: FakeSecretsManager, starter: Any = None) -> WorkspaceSecrets:
    found = WorkspaceSecrets(secrets_client)
    deps.install(app, deps.WsDeps(story_flow_arn=STORY_FLOW_ARN, secrets=found, flow=starter))
    return found


def ws_call(app: App) -> Call:
    """Requests to Lamo Stories' own Lambda: its ``/v1/workspaces`` table and its public callback."""

    def _call(method: str, path: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
        out = dispatch(make_event(method, path, body, **kw), app, [*WS_ROUTES, *CALLBACK_ROUTES])
        return out["statusCode"], (json.loads(out["body"]) if out["body"] else None)

    return _call


def stories_callback(app: App, platform: str, query: dict[str, str]) -> str:
    """``GET /v1/stories-oauth/{platform}/callback`` (public: no JWT); the ``Location`` it answers."""
    event = make_event("GET", f"/v1/stories-oauth/{platform}/callback", query=query, sub=None)
    event["headers"] = {}
    out = dispatch(event, app, [*WS_ROUTES, *CALLBACK_ROUTES])
    assert out["statusCode"] == 302, out
    assert out["headers"]["referrer-policy"] == "no-referrer"
    assert out["headers"]["cache-control"] == "no-store"
    assert out["body"] == ""
    return str(out["headers"]["location"])


def default_choice(platform: str) -> str:
    return "own" if platform in META else "clips"


def app_keys(secrets_client: FakeSecretsManager, *platforms: str) -> None:
    """Clip Factory's app keys (``cf-prod/platforms/{p}/app``): only YouTube, TikTok and X ever have a shared choice."""
    for platform in platforms or SHARED:
        secrets_client.values[f"{APP}{platform}/app"] = json.dumps({**GOOD[platform], "userId": USER})


def own_keys(secrets_client: FakeSecretsManager, *platforms: str, keys: dict[str, Any] | None = None) -> None:
    """Lamo Stories' own app keys (``cf-prod/workspaces/stories/{p}/app``)."""
    for platform in platforms or META:
        value = {**(keys or GOOD[platform]), "savedAt": "2026-11-15T09:00:00.000Z"}
        secrets_client.values[f"{WSP}{WS}/{platform}/app"] = json.dumps(value)


def app_field(platform: str, choice: str | None) -> dict[str, Any]:
    if choice is None:
        return {}
    if choice == "clips":
        return {"choice": "clips"}
    return {
        "choice": "own",
        "savedAt": "2026-11-15T09:00:00.000Z",
        "hints": {k: formats.hint(k, v) for k, v in GOOD[platform].items()},
    }


def choose_app(store: db.Store, platform: str, choice: str | None) -> None:
    """The owner's app choice on ``SOCIAL#{platform}`` (made ``not_connected`` when it does not exist yet)."""
    from clipfactory_api.workspaces import social as ws_social

    ws_social.upsert_account(store, USER, WS, platform, now=NOW, fields={"app": app_field(platform, choice)})


def choices(store: db.Store, secrets_client: FakeSecretsManager, *platforms: str) -> None:
    """Every platform's default app chosen, with its keys (Clip Factory's for YouTube, TikTok and X)."""
    app_keys(secrets_client)
    own_keys(secrets_client)
    for platform in platforms or ws.PLATFORMS:
        choose_app(store, platform, default_choice(platform))


def workspace(store: db.Store) -> dict[str, Any]:
    return guard.ensure_first_stories(store, USER, NOW)


def social(
    store: db.Store,
    secrets_client: FakeSecretsManager,
    platform: str,
    *,
    status: str = "connected",
    identity: str | None = None,
    token: dict[str, Any] | None = None,
    choice: str | None = "default",
    **fields: Any,
) -> dict[str, Any]:
    """A connected Lamo Stories account with its workspace token secret and its app choice (and that app's keys)."""
    identity = identity or IDENTITY[platform]
    picked = default_choice(platform) if choice == "default" else choice
    if picked == "own":
        own_keys(secrets_client, platform)
    elif picked == "clips":
        app_keys(secrets_client, platform)
    item = {
        "pk": PK,
        "sk": f"SOCIAL#{platform}",
        "type": "ws_social",
        "userId": USER,
        "workspaceId": WS,
        "socialAccountId": f"{WS}.{platform}",
        "platform": platform,
        "connectionStatus": status,
        "externalAccountId": identity,
        "accountName": f"Lamo Stories {platform}",
        "handle": "@lamostories",
        "appClientId": GOOD[platform]["clientId"],
        "connectedAt": "2026-11-15T10:00:00.000Z",
        "lastCheckedAt": "2026-11-15T10:00:00.000Z",
        "sharedWithClips": False,
        **({"app": app_field(platform, picked)} if picked else {}),
        "createdAt": "2026-11-15T10:00:00.000Z",
        "updatedAt": "2026-11-15T10:00:00.000Z",
        **fields,
    }
    store.put(item)
    value = dict(token if token is not None else TOKENS[platform])
    if token is None:
        value[ws.SECRET_IDENTITY[platform]] = identity
    secrets_client.values[f"{WSP}{WS}/{platform}/token"] = json.dumps(value)
    return item


def clips_account(store: db.Store, secrets_client: FakeSecretsManager | None, platform: str, **fields: Any) -> None:
    """Lamo Clips' own connection (``ACCOUNT#`` and its ``cf-prod/platforms/`` token)."""
    setup.put_account(
        store,
        USER,
        platform,
        "connected",
        now=NOW,
        fields={"handle": "@owner", "name": "Owner Plays", "accountId": CLIPS_IDENTITY[platform], **fields},
    )
    if secrets_client is not None:
        token: dict[str, Any] = {"accessToken": "CLIPS-ACCESS", "pageAccessToken": "CLIPS-PAGE"}
        token["igUserId" if platform == "instagram" else "pageId"] = CLIPS_IDENTITY[platform]
        secrets_client.values[f"{APP}{platform}/token"] = json.dumps(token)


def story(store: db.Store, *, status: str = "approved", **fields: Any) -> dict[str, Any]:
    item = {
        "pk": PK,
        "sk": f"STORY#{STORY_ID}",
        "type": "ws_story",
        "userId": USER,
        "workspaceId": WS,
        "storyId": STORY_ID,
        "contentType": "animation",
        "title": "Ice is slippery",
        "status": status,
        "category": "driving_safety",
        "actualDurationSec": 44.5,
        "postCaptions": {
            "youtubeTitle": "How to stop a skid on ice",
            "youtubeDescription": "Based on UK Highway Code advice.",
            "instagram": "Ice! #driving",
            "facebook": "Stay calm on ice",
            "tiktok": "ice tips",
            "x": "ice tips",
        },
        "videoKey": f"ws/{USER}/{WS}/stories/{STORY_ID}/final/v1.mp4",
        "coverKey": f"ws/{USER}/{WS}/stories/{STORY_ID}/final/cover-v1.jpg",
        "posted": [],
        "version": 3,
        "createdAt": "2026-11-15T09:00:00.000Z",
        "updatedAt": "2026-11-15T11:00:00.000Z",
        **fields,
    }
    store.put(item)
    return item


def hooks_deps(store: db.Store, oauth_env: OAuthEnv, clock: Clock, stories_callback: str = STORIES_CALLBACK) -> Any:
    return hooks.HooksDeps(
        store=store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=clock,
        oauth=oauth_env,
        stories_oauth_callback=stories_callback,
    )


def callback_event(platform: str, query: dict[str, str]) -> dict[str, Any]:
    return {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "path": f"/oauth/{platform}/callback",
        "pathParameters": {"platform": platform},
        "queryStringParameters": query,
        "headers": {},
        "requestContext": {"requestId": "rest-ws", "stage": "v1"},
    }


def land(deps_: Any, platform: str, query: dict[str, str]) -> str:
    out = hooks.handle(callback_event(platform, query), deps_)
    assert out["statusCode"] == 302
    assert out["headers"]["referrer-policy"] == "no-referrer"
    return str(out["headers"]["location"])


def ws_start(call: Call, platform: str) -> str:
    status, body = call("POST", f"/v1/workspaces/{WS}/social/{platform}/connect")
    assert status == 200, body
    return str(parse_qs(urlsplit(body["authorizeUrl"]).query)["state"][0])


def landing(platform: str, result: str, *, ws_id: str | None = WS) -> str:
    url = f"{APP_URL}/stories/connections?platform={platform}&result={result}"
    return url + (f"&ws={ws_id}" if ws_id else "")


def lamo_clips_items(table: FakeTable) -> list[dict[str, Any]]:
    """Every item that is not Lamo Stories' (nor a consumed OAuth state), for before/after checks."""
    return sorted(
        (i for i in table.all() if not str(i["pk"]).startswith(("OAUTH#", f"USER#{USER}#WS"))),
        key=lambda i: (str(i["pk"]), str(i["sk"])),
    )


def clips_secret_writes(secrets_client: FakeSecretsManager) -> list[tuple[str, str]]:
    return [(op, name) for op, name in secrets_client.writes if name.startswith(APP)]


# --- publishing jobs and the story flow ---------------------------------------------------------------------------

MB = 1024 * 1024


def pubjob(store: db.Store, platform: str, job_id: str = "01JZ0000000000000000000PJ1", **fields: Any) -> dict[str, Any]:
    item = {
        "pk": PK,
        "sk": f"PUBJOB#{job_id}",
        "type": "ws_pubjob",
        "userId": USER,
        "workspaceId": WS,
        "publishingJobId": job_id,
        "contentId": STORY_ID,
        "socialAccountId": f"{WS}.{platform}",
        "platform": platform,
        "publishingStatus": "queued",
        "accountName": f"Lamo Stories {platform}",
        "externalAccountId": IDENTITY[platform],
        "flowRun": 1,
        "postOptions": {"privacy": "public", "category": "27"} if platform == "youtube" else {},
        "createdAt": "2026-11-15T11:59:00.000Z",
        "updatedAt": "2026-11-15T11:59:00.000Z",
        **fields,
    }
    store.put(item)
    return item


def flow_deps(store: db.Store, secrets_client: FakeSecretsManager, http: Any, clock: Clock, **extra: Any) -> Any:
    from clipfactory_api.flows.story_flow import StoryFlowDeps
    from clipfactory_api.oauth.secrets import Secrets
    from clipfactory_api.platforms.publishers import publisher_for
    from clipfactory_api.stats import config
    from fakes import FakeVideo

    def no_state_key() -> bytes:
        raise AssertionError("the story flow never reads the state key")

    oauth = OAuthEnv(
        secrets=Secrets(secrets_client), app_url="", hooks_url="", state_key=no_state_key, http=http, clock=clock
    )
    found: dict[str, Any] = {
        "store": store,
        "oauth": oauth,
        "secrets": WorkspaceSecrets(secrets_client),
        "publishers": publisher_for,
        "video": lambda _story: FakeVideo(3 * MB),
        "clock": clock,
        "sleep": lambda _s: None,
        "http": http,
        "cfg": config.load(),
        **extra,
    }
    return StoryFlowDeps(**found)


def flow_event(*job_ids: str, run: int = 1) -> dict[str, Any]:
    return {
        "userId": USER,
        "workspaceId": WS,
        "storyId": STORY_ID,
        "publishingJobIds": list(job_ids or ["01JZ0000000000000000000PJ1"]),
        "run": run,
    }


def ready(store: db.Store, secrets_client: FakeSecretsManager, *platforms: str) -> None:
    """A Lamo Stories workspace with an approved story and connected accounts on ``platforms`` (each with its
    default app: Lamo Stories' own Meta app, Clip Factory's app for the others)."""
    app_keys(secrets_client)
    own_keys(secrets_client)
    workspace(store)
    story(store)
    for platform in platforms:
        social(store, secrets_client, platform)
