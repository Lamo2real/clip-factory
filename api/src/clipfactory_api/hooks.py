"""``cf-prod-hooks``: the public REST API for platform webhooks and OAuth callbacks (docs/CONTRACTS.md §14.3).

* ``GET /hooks/{platform}``: subscription checks. Meta (Instagram, Facebook) must echo ``hub.challenge`` when
  ``hub.verify_token`` matches the SSM SecureString ``/cf-prod/hooks/verify-token``; YouTube (PubSubHubbub) must echo
  it for its video feed topics. TikTok and X arrive in phase 2 (501).
* ``POST /hooks/{platform}``: the raw event is stored as a ``HOOK#`` item (14-day ``ttl``) and nothing else runs
  inline. Signatures are checked by ``verify_signature``; phase 1 has no app secrets, so it answers "unverified".
* ``POST /hooks/twitch`` and ``POST /hooks/kick`` (§24.4, Follow creators): signed deliveries only (401 otherwise),
  stored once by message id, then the creator's live state changes (``follow.webhooks``).
* ``GET /oauth/{platform}/callback``: the OAuth callback of §17.5 (``oauth.callback``). It always answers ``302`` to
  ``{APP_URL}/settings/posting/setup/{platform}?result={code}`` (a fixed path and a listed code: no open redirect).
  On ``connected`` the clips waiting for that place go out (``release``, §17.6): it starts the clip flow on the alias
  in ``CLIP_FLOW_ARN``.

Query strings (OAuth ``code``/``state``, Meta's verify token) and bodies are never logged.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Literal

from . import db
from .clock import Clock, iso, utcnow
from .ids import ulid
from .log import log
from .oauth import OAuthEnv
from .settings import PLATFORMS

if TYPE_CHECKING:
    from .follow.platforms import FollowEnv
    from .follow.webhooks import KickKeys
    from .release import ClipFlowStarter

MAX_BODY_BYTES = 256 * 1024
MAX_CHALLENGE_CHARS = 512
HOOK_TTL = timedelta(days=14)
TOKEN_CACHE_SECONDS = 300
YOUTUBE_TOPIC = "https://www.youtube.com/xml/feeds/videos.xml"
META = frozenset({"instagram", "facebook"})
# §24: Twitch and Kick send Follow creators' webhooks. They are not posting platforms (never in settings.PLATFORMS),
# have no OAuth callback, and every delivery must be signed.
FOLLOW_HOOKS = ("twitch", "kick")
HOOK_PLATFORMS: tuple[str, ...] = PLATFORMS + FOLLOW_HOOKS
KEPT_HEADERS = (
    "content-type",
    "user-agent",
    "x-hub-signature-256",
    "x-hub-signature",
    "x-tiktok-signature",
    "x-twitter-webhooks-signature",
    "twitch-eventsub-message-id",
    "twitch-eventsub-message-type",
    "twitch-eventsub-message-timestamp",
    "twitch-eventsub-subscription-type",
    "kick-event-message-id",
    "kick-event-type",
    "kick-event-message-timestamp",
    "kick-event-version",
)
Verdict = Literal["valid", "unverified", "invalid"]


def verify_signature(platform: str, headers: Mapping[str, str], raw_body: bytes) -> Verdict:
    """Checks a webhook's signature. Phase 1 has no platform app secrets yet, so every event is "unverified";
    phase 2 checks ``x-hub-signature-256`` (Meta), ``x-tiktok-signature`` and ``x-twitter-webhooks-signature`` here."""
    return "unverified"


@dataclass
class HooksDeps:
    store: db.Store
    app_url: str
    verify_token: Callable[[], str]
    clock: Clock = field(default=utcnow)
    verify: Callable[[str, Mapping[str, str], bytes], Verdict] = field(default=verify_signature)
    oauth: OAuthEnv | None = None  # None: the callback answers result=error (secrets not configured)
    follow: FollowEnv | None = None  # §24: Twitch's EventSub secret; None: every Twitch delivery is a 401
    kick_keys: KickKeys | None = None  # §24: Kick's public key; None: every Kick delivery is a 401
    flows: ClipFlowStarter | None = None  # §17.6: starts the clip flow for posts released on connect; None: none


def ssm_token_reader(client: Any, name: str, now: Callable[[], float] = time.time) -> Callable[[], str]:
    """Reads the SecureString with decryption, cached per container for 5 minutes."""
    cache: dict[str, tuple[str, float]] = {}
    lock = threading.Lock()

    def read() -> str:
        with lock:
            hit = cache.get(name)
            if hit and now() - hit[1] < TOKEN_CACHE_SECONDS:
                return hit[0]
        value = str(client.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"])
        with lock:
            cache[name] = (value, now())
        return value

    return read


def _response(
    status: int, body: Any = None, *, text: str | None = None, headers: Mapping[str, str] | None = None
) -> dict[str, Any]:
    out_headers = {"cache-control": "no-store", "x-content-type-options": "nosniff", **(headers or {})}
    if text is not None:
        out_headers["content-type"] = "text/plain; charset=utf-8"
        payload = text
    elif body is None:
        payload = ""
    else:
        out_headers["content-type"] = "application/json"
        payload = json.dumps(body, separators=(",", ":"))
    return {"statusCode": status, "headers": out_headers, "body": payload, "isBase64Encoded": False}


def _error(status: int, code: str, message: str) -> dict[str, Any]:
    return _response(status, {"error": {"code": code, "message": message}})


def _query(event: Mapping[str, Any]) -> dict[str, str]:
    raw = event.get("queryStringParameters") or {}
    return {str(k): str(v) for k, v in raw.items()} if isinstance(raw, Mapping) else {}


def _headers(event: Mapping[str, Any]) -> dict[str, str]:
    raw = event.get("headers") or {}
    return {str(k).lower(): str(v) for k, v in raw.items()} if isinstance(raw, Mapping) else {}


def handle(event: Mapping[str, Any], deps: HooksDeps) -> dict[str, Any]:
    method = str(event.get("httpMethod") or "GET").upper()
    resource = str(event.get("resource") or "")
    params = event.get("pathParameters") or {}
    platform = str(params.get("platform") or "") if isinstance(params, Mapping) else ""
    request_id = str((event.get("requestContext") or {}).get("requestId") or "")
    if platform not in HOOK_PLATFORMS or (platform in FOLLOW_HOOKS and resource != "/hooks/{platform}"):
        log("info", "hooks.unknown_platform", method=method, resource=resource, requestId=request_id)
        return _error(404, "not_found", "We do not support that platform.")
    try:
        if platform in FOLLOW_HOOKS and method == "POST":
            out = _follow_hook(platform, event, deps)
        elif platform in FOLLOW_HOOKS:
            out = _error(404, "not_found", "That address does not exist.")
        elif resource == "/hooks/{platform}" and method == "GET":
            out = _verify_subscription(platform, _query(event), deps)
        elif resource == "/hooks/{platform}" and method == "POST":
            out = _receive(platform, event, deps)
        elif resource == "/oauth/{platform}/callback" and method == "GET":
            out = _oauth_callback(platform, event, deps)
        else:
            out = _error(404, "not_found", "That address does not exist.")
    except Exception as e:
        log("error", "hooks.internal", platform=platform, error=type(e).__name__, requestId=request_id)
        out = _error(500, "internal", "Something went wrong on our side. Please try again.")
    log(
        "info",
        "hooks",
        method=method,
        resource=resource,
        platform=platform,
        status=out["statusCode"],
        requestId=request_id,
    )
    return out


def _oauth_callback(platform: str, event: Mapping[str, Any], deps: HooksDeps) -> dict[str, Any]:
    from .oauth import callback

    result = "error"
    if deps.oauth is not None:
        try:
            result = callback.handle_callback(platform, _query(event), deps.store, deps.oauth, deps.flows)
        except Exception as e:  # the owner always lands on the setup page with a plain sentence
            log("error", "hooks.oauth_failed", platform=platform, error=type(e).__name__)
            result = "error"
    headers = {"location": callback.location(deps.app_url, platform, result), "referrer-policy": "no-referrer"}
    return _response(302, headers=headers)


def _challenge(query: Mapping[str, str]) -> str | None:
    value = query.get("hub.challenge")
    return value if value and len(value) <= MAX_CHALLENGE_CHARS else None


def _verify_subscription(platform: str, query: Mapping[str, str], deps: HooksDeps) -> dict[str, Any]:
    if platform in META:
        challenge = _challenge(query)
        given = query.get("hub.verify_token") or ""
        expected = deps.verify_token()
        matches = bool(given and expected) and hmac.compare_digest(given.encode(), expected.encode())
        if query.get("hub.mode") != "subscribe" or not matches or challenge is None:
            return _error(403, "forbidden", "The verify token does not match.")
        return _response(200, text=challenge)
    if platform == "youtube":
        challenge = _challenge(query)
        topic = query.get("hub.topic") or ""
        if (
            query.get("hub.mode") not in {"subscribe", "unsubscribe"}
            or not topic.startswith(YOUTUBE_TOPIC)
            or challenge is None
        ):
            return _error(400, "bad_request", "This is not a valid YouTube subscription check.")
        return _response(200, text=challenge)
    return _error(501, "not_implemented", "Webhooks for this platform arrive in the next phase.")


def _raw_body(event: Mapping[str, Any]) -> tuple[bytes, str, Literal["text", "base64"]]:
    raw = event.get("body") or ""
    text = raw if isinstance(raw, str) else ""
    if event.get("isBase64Encoded"):
        try:
            return base64.b64decode(text, validate=True), text, "base64"
        except (ValueError, binascii.Error):
            return b"", text, "base64"
    return text.encode("utf-8"), text, "text"


def _receive(platform: str, event: Mapping[str, Any], deps: HooksDeps) -> dict[str, Any]:
    body, stored, encoding = _raw_body(event)
    if len(body) > MAX_BODY_BYTES or len(stored) > MAX_BODY_BYTES * 4 // 3 + 4:
        return _error(413, "too_large", "The event is too large.")
    headers = _headers(event)
    verdict = deps.verify(platform, headers, body)
    if verdict == "invalid":
        return _error(401, "unauthorized", "The signature does not match.")
    now = deps.clock()
    hook_id = ulid()
    deps.store.put(
        {
            "pk": f"HOOK#{platform}",
            "sk": f"HOOK#{hook_id}",
            "type": "hook",
            "platform": platform,
            "receivedAt": iso(now),
            "headers": {k: headers[k] for k in KEPT_HEADERS if k in headers},
            "body": stored,
            "bodyEncoding": encoding,
            "signature": verdict,
            "ttl": int((now + HOOK_TTL).timestamp()),
        }
    )
    log("info", "hooks.stored", platform=platform, hookId=hook_id, size=len(body), signature=verdict)
    return _response(200, {"ok": True})


def _follow_hook(platform: str, event: Mapping[str, Any], deps: HooksDeps) -> dict[str, Any]:
    """Twitch EventSub and Kick (§24.4): verified first, stored once, then the live state changes."""
    from .follow import webhooks

    body, stored, _encoding = _raw_body(event)
    if len(body) > MAX_BODY_BYTES or len(stored) > MAX_BODY_BYTES * 4 // 3 + 4:
        return _error(413, "too_large", "The event is too large.")
    headers = _headers(event)
    now = deps.clock()
    if platform == "twitch":
        if deps.follow is None:
            return _error(401, "unauthorized", "The signature does not match.")
        outcome = webhooks.twitch(deps.store, deps.follow, headers, body, now)
    else:
        if deps.kick_keys is None:
            return _error(401, "unauthorized", "The signature does not match.")
        outcome = webhooks.kick(deps.store, deps.kick_keys, headers, body, now)
    log("info", "hooks.follow", platform=platform, status=outcome.status, outcome=outcome.note)
    if outcome.text is not None:
        return _response(outcome.status, text=outcome.text)
    return _response(outcome.status, outcome.body)


_deps: HooksDeps | None = None


def _from_env() -> HooksDeps:
    import boto3
    from botocore.config import Config

    from .app import region, table
    from .oauth import money_scopes_from_config, scopes_from_config
    from .oauth.secrets import PREFIX, Secrets
    from .stats import config

    env = os.environ
    ssm = boto3.client("ssm", region_name=region(), config=Config(retries={"mode": "standard"}, read_timeout=3))
    store = db.Store(table(env["TABLE_NAME"]))
    oauth = None
    if env.get("OAUTH_STATE_SECRET"):
        sm = boto3.client(
            "secretsmanager", region_name=region(), config=Config(retries={"mode": "standard"}, read_timeout=5)
        )
        secrets = Secrets(sm, env.get("SECRET_PREFIX") or PREFIX)
        state_name = env["OAUTH_STATE_SECRET"]
        oauth = OAuthEnv(
            secrets=secrets,
            app_url=env["APP_URL"],
            hooks_url=env.get("HOOKS_URL", ""),
            state_key=lambda: secrets.read_text(state_name).encode(),
            graph_version=config.load().graph_api_version,
            scopes=scopes_from_config(),
            money_scopes=money_scopes_from_config(),
        )
    from .follow.platforms import FollowEnv
    from .follow.webhooks import KickKeys
    from .platforms.base import urllib_client

    follow_sm = boto3.client(
        "secretsmanager", region_name=region(), config=Config(retries={"mode": "standard"}, read_timeout=5)
    )
    flows = None
    if env.get("CLIP_FLOW_ARN"):
        from .flow_client import FlowClient, make_client

        flows = FlowClient(make_client(region()), "", env["CLIP_FLOW_ARN"])  # the clip flow only, never the job flow
    return HooksDeps(
        store=store,
        app_url=env["APP_URL"],
        verify_token=ssm_token_reader(ssm, env.get("VERIFY_TOKEN_PARAM", "/cf-prod/hooks/verify-token")),
        oauth=oauth,
        follow=FollowEnv(
            secrets=Secrets(follow_sm, env.get("SECRET_PREFIX") or PREFIX), hooks_url=env.get("HOOKS_URL", "")
        ),
        kick_keys=KickKeys(urllib_client),
        flows=flows,
    )


def get_deps(factory: Callable[[], HooksDeps] = _from_env) -> HooksDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    return handle(event, get_deps())
