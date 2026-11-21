"""Fakes and helpers for the Content Rewards tests (docs/CONTRACTS.md §38.20). Offline only: no AWS, no CR.

``FakeCR`` is CR's OAuth server, MCP server and public JSON in one recorded ``Net``: it answers from queues and
per-tool handlers (shapes from CR's ``mcp-tools.json``) and keeps every request with its timeout.
"""

from __future__ import annotations

import json
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from clipfactory_api import db, s3
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import config, ids
from clipfactory_api.contentrewards.deps import CrDeps
from clipfactory_api.contentrewards.net import NetworkError
from clipfactory_api.oauth import state as oauth_state
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.platforms.base import HttpRequest, HttpResponse
from fakes import FakeSecretsManager

FIXTURES = Path(__file__).parent / "fixtures" / "contentrewards"
UUID = "200ea21b-be80-4db8-b552-8e32b148604e"
UUID2 = "a1cefc3b-4533-438f-8e70-a7299550f1cf"
CMP = ids.typeid("cmp", UUID)
CMP2 = ids.typeid("cmp", UUID2)
ORG_UUID = "b5d86b5d-b3a3-5970-809c-81b92ccff73c"
ORG = ids.typeid("org", ORG_UUID)
STATE_KEY = b"s" * 64
CLIENT_ID = "cli_test_123"
PREFIX = "cf-prod/platforms/"
TOKEN_NAME = f"{PREFIX}contentrewards/token"
APP_NAME = f"{PREFIX}contentrewards/app"
CAMPAIGNS_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-campaigns"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def response(status: int, body: Any = None, headers: dict[str, str] | None = None) -> HttpResponse:
    raw = body if isinstance(body, bytes) else json.dumps(body if body is not None else {}).encode()
    return HttpResponse(status, {k.lower(): v for k, v in (headers or {}).items()}, raw)


def tool_error(code: str, detail: str = "", status: int = 409) -> dict[str, Any]:
    """An MCP tool result with ``isError`` (CR's error object as text)."""
    text = json.dumps({"code": code, "detail": detail or code, "status": status, "request_id": "req_x", "errors": []})
    return {"__error__": {"isError": True, "content": [{"type": "text", "text": text}]}}


def page(rows: list[dict[str, Any]], *, more: bool = False, cursor: str | None = None) -> dict[str, Any]:
    return {"object": "list", "data": rows, "has_more": more, "next_cursor": cursor if more else None}


def listed_campaign(
    cmp_id: str = CMP,
    *,
    name: str = "$8,500 FaZe Tournament Clipping Campaign",
    access: str = "application",
    status: str = "active",
    platforms: list[dict[str, Any]] | None = None,
    description: str | None = "Clip the draft. Caption must include #FaZe @FaZeClan.",
    org: str = ORG,
) -> dict[str, Any]:
    def money(v: int | None) -> dict[str, Any] | None:
        return None if v is None else {"currency": "usd", "value": v}

    rows = platforms or [
        {
            "platform": "youtube",
            "rate": money(200),
            "min_payout": money(1000),
            "max_payout": money(35000),
            "min_views": None,
            "country_rates": None,
        },
        {
            "platform": "instagram",
            "rate": money(200),
            "min_payout": money(1000),
            "max_payout": money(35000),
            "min_views": None,
            "country_rates": None,
        },
    ]
    return {
        "object": "campaign",
        "id": cmp_id,
        "name": name,
        "organization": org,
        "access": access,
        "status": status,
        "type": "cpm",
        "visibility": "public",
        "description": description,
        "platforms": rows,
        "livemode": True,
    }


def public_campaign(
    uuid: str = UUID,
    *,
    name: str = "$8,500 FaZe Tournament Clipping Campaign",
    application: bool = True,
    status: str = "active",
    payout: list[dict[str, Any]] | None = None,
    budget: int = 850000,
    spent: int = 60992,
    rules: dict[str, Any] | None = None,
    requirement: dict[str, Any] | None = None,
    guidelines: str | None = "Caption must include #FaZe @FaZeClan\nVertical 9:16, at least 7 seconds",
    description: str = "FaZe Flank Invitational. Clip the official broadcast only.",
) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "payoutModel": payout
        if payout is not None
        else [
            {"platform": "youtube", "rate": 200, "minPayout": 1000, "maxPayout": 35000},
            {"platform": "instagram", "rate": 200, "minPayout": 1000, "maxPayout": 35000},
        ],
        "budget": budget,
        "requirement": requirement or {"preApproval": False, "brandLogo": False, "faceOnCamera": False},
        "rules": rules
        or {"branding": {"logoRequired": False}, "faceOnCamera": False, "sound": {"mustUseProvided": False}},
    }
    if guidelines is not None:
        cfg["content"] = {"guidelines": guidelines}
    return {
        "id": uuid,
        "name": name,
        "description": description,
        "organization": {"name": "ClippedIn", "logoUrl": "organizations/x/logo/y.png"},
        "organizationId": ORG_UUID,
        "private": False,
        "requiresApplication": application,
        "status": status,
        "statusReason": "funded",
        "type": "cpm",
        "metrics": {"budgetSpentCents": spent},
        "configuration": cfg,
    }


Answer = Any  # a dict (structuredContent), tool_error(...), an HttpResponse, an exception, or a callable(args)


@dataclass
class FakeCR:
    """CR in one ``Net``: ``(HttpRequest, timeout) -> HttpResponse``."""

    tools: dict[str, list[Answer]] = field(default_factory=dict)  # tool -> answers in order (the last repeats)
    tool_names: list[str] = field(
        default_factory=lambda: [
            "get_me",
            "list_my_campaigns",
            "create_my_submission",
            "list_my_submissions",
            "get_my_submission",
            "get_my_balance",
            "list_my_payouts",
            "send_feedback",
        ]
    )
    tokens: list[Any] = field(default_factory=list)  # /oauth2/token answers in order
    registers: list[Any] = field(default_factory=list)
    public: dict[str, Any] = field(default_factory=dict)  # url -> HttpResponse | dict (200 JSON) | exception
    mcp_http: list[Any] = field(default_factory=list)  # HTTP-level answers for the next MCP posts
    requests: list[tuple[HttpRequest, float]] = field(default_factory=list)
    revoked: list[str] = field(default_factory=list)
    issued: int = 0

    def answer(self, tool: str, *answers: Answer) -> None:
        self.tools[tool] = list(answers)

    def __call__(self, request: HttpRequest, timeout: float) -> HttpResponse:
        self.requests.append((request, timeout))
        url = request.url
        if url == config.REGISTER_URL:
            if self.registers:
                return self._pop(self.registers)
            return response(201, {"client_id": CLIENT_ID, "registration_access_token": "rat_secret"})
        if url == config.TOKEN_URL:
            if self.tokens:
                return self._pop(self.tokens)
            return self.token_ok()
        if url == config.REVOKE_URL:
            form = urllib.parse.parse_qs((request.body or b"").decode())
            self.revoked.append(form.get("token", [""])[0])
            return response(200, {})
        if url == config.MCP_URL:
            return self._mcp(request)
        if url in self.public:
            found = self.public[url]
            if isinstance(found, list):
                found = found.pop(0) if len(found) > 1 else found[0]
            if isinstance(found, BaseException):
                raise found
            return found if isinstance(found, HttpResponse) else response(200, found)
        raise NetworkError(f"unexpected {request.method} {url}", sent=False)

    def token_ok(self, *, scope: str | None = " ".join(config.SCOPES), lifetime: int = 600) -> HttpResponse:
        self.issued += 1
        body: dict[str, Any] = {
            "access_token": f"at_{self.issued}",
            "refresh_token": f"rt_{self.issued}",
            "token_type": "Bearer",
            "expires_in": lifetime,
        }
        if scope is not None:
            body["scope"] = scope
        return response(200, body)

    @staticmethod
    def _pop(queue: list[Any]) -> HttpResponse:
        found = queue.pop(0)
        if isinstance(found, BaseException):
            raise found
        return found  # type: ignore[no-any-return]

    def _mcp(self, request: HttpRequest) -> HttpResponse:
        message = json.loads(request.body or b"{}")
        method = message.get("method")
        if method == "notifications/initialized":
            return response(202, b"")
        if method == "initialize":
            return self._rpc(message, {"protocolVersion": config.PROTOCOL, "capabilities": {"tools": {}}})
        if self.mcp_http:
            found = self.mcp_http.pop(0)
            if isinstance(found, BaseException):
                raise found
            if found is not None:
                return found  # type: ignore[no-any-return]
        if method == "tools/list":
            return self._rpc(message, {"tools": [{"name": n} for n in self.tool_names]})
        tool = message["params"]["name"]
        args = message["params"].get("arguments") or {}
        queue = self.tools.get(tool)
        if not queue:
            raise AssertionError(f"unexpected tool call {tool}")
        found = queue.pop(0) if len(queue) > 1 else queue[0]
        if callable(found):
            found = found(args)
        if isinstance(found, BaseException):
            raise found
        if isinstance(found, HttpResponse):
            return found
        if isinstance(found, dict) and "__error__" in found:
            return self._rpc(message, found["__error__"])
        if isinstance(found, dict) and "__rpc_error__" in found:
            return response(200, {"jsonrpc": "2.0", "id": message.get("id"), "error": found["__rpc_error__"]})
        return self._rpc(message, {"structuredContent": found, "content": [{"type": "text", "text": "{}"}]})

    @staticmethod
    def _rpc(message: dict[str, Any], result: Any) -> HttpResponse:
        return response(200, {"jsonrpc": "2.0", "id": message.get("id"), "result": result})

    # what was sent ----------------------------------------------------------------------------------------------

    def calls(self, tool: str | None = None) -> list[tuple[dict[str, Any], dict[str, str], float]]:
        out = []
        for request, timeout in self.requests:
            if request.url != config.MCP_URL:
                continue
            message = json.loads(request.body or b"{}")
            if message.get("method") != "tools/call":
                continue
            if tool is None or message["params"]["name"] == tool:
                out.append((message["params"].get("arguments") or {}, request.headers, timeout))
        return out

    def tool_order(self) -> list[str]:
        return [
            json.loads(r.body or b"{}")["params"]["name"]
            for r, _t in self.requests
            if r.url == config.MCP_URL and json.loads(r.body or b"{}").get("method") == "tools/call"
        ]

    def token_forms(self) -> list[dict[str, list[str]]]:
        return [urllib.parse.parse_qs((r.body or b"").decode()) for r, _t in self.requests if r.url == config.TOKEN_URL]


class FakeInvoker:
    """``async_invoke.AsyncInvoker``'s CR calls, recorded."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.fail = False

    def _record(self, name: str, *args: Any) -> None:
        if self.fail:
            raise RuntimeError("invoke failed")
        self.calls.append((name, args))

    def read_campaign(self, user_id: str, campaign_id: str) -> None:
        self._record("read_campaign", user_id, campaign_id)

    def fetch_logo(self, user_id: str, campaign_id: str, url: str) -> None:
        self._record("fetch_logo", user_id, campaign_id, url)

    def brand_picture(self, user_id: str, campaign_id: str) -> None:
        self._record("brand_picture", user_id, campaign_id)

    def cr_check(self, user_id: str, what: str) -> None:
        self._record("cr_check", user_id, what)


class Sleeper:
    def __init__(self, clock: Any = None) -> None:
        self.slept: list[float] = []
        self.clock = clock

    def __call__(self, seconds: float) -> None:
        self.slept.append(seconds)
        if self.clock is not None:
            self.clock.now = self.clock.now + timedelta(seconds=seconds)


def make_deps(
    store: db.Store,
    secrets_client: FakeSecretsManager,
    fake: FakeCR,
    clock: Any,
    *,
    media: s3.Media | None = None,
    invoker: Any = None,
    sleep: Any = None,
) -> CrDeps:
    counter = [0.0]

    def monotonic() -> float:
        counter[0] += 0.001
        return counter[0] + clock.now.timestamp()

    return CrDeps(
        store=store,
        secrets=Secrets(secrets_client, PREFIX),
        net=fake,
        clock=clock,
        sleep=sleep or Sleeper(clock),
        monotonic=monotonic,
        media=media,
        invoker=invoker,
        state_key=lambda: STATE_KEY,
    )


def seed_connection(
    deps: CrDeps,
    user_id: str,
    now: datetime,
    *,
    status: str = "connected",
    can_submit: bool = True,
    expires_in: timedelta = timedelta(minutes=10),
    refresh: str = "rt_0",
    access: str = "at_0",
    creator: str = "cre_0123456789abcdefghjkmnpqrs",
    **fields: Any,
) -> dict[str, Any]:
    """A signed-in owner: the app secret, a token secret (its version on CRCONN) and CRCONN."""
    deps.secrets.write(APP_NAME, {"clientId": CLIENT_ID, "redirectUris": [], "registeredAt": iso(now), "extra": {}})
    secret = {
        "accessToken": access,
        "expiresAt": iso(now + expires_in),
        "refreshToken": refresh,
        "scope": " ".join(config.SCOPES),
        "creatorId": creator,
        "issuedAt": iso(now - timedelta(minutes=1)),
    }
    version = deps.secrets.write(TOKEN_NAME, secret, platform="contentrewards")
    item = {
        "pk": db.user_pk(user_id),
        "sk": db.CRCONN_SK,
        "type": "crconn",
        "userId": user_id,
        "status": status,
        "creatorId": creator,
        "scopes": list(config.SCOPES),
        "canSubmit": can_submit,
        "connectedAt": iso(now - timedelta(days=1)),
        "signInBy": iso(now + timedelta(days=89)),
        "tokenVersionId": version,
        "tokenIssuedAt": secret["issuedAt"],
        "lastRefreshAt": iso(now - timedelta(hours=1)),
        "crLinked": {},
        "updatedAt": iso(now),
        **fields,
    }
    deps.store.put(item)
    deps.store.put({"pk": db.CROWNERS_PK, "sk": db.user_pk(user_id), "type": "crowner", "since": iso(now)})
    return item


def seed_campaign(store: db.Store, user_id: str, now: datetime, uuid: str = UUID, **fields: Any) -> dict[str, Any]:
    from clipfactory_api.contentrewards import rules

    item: dict[str, Any] = {
        "pk": db.user_pk(user_id),
        "sk": db.campaign_sk(uuid),
        "type": "campaign",
        "userId": user_id,
        "campaignId": uuid,
        "url": f"https://contentrewards.com/c/campaigns/{uuid}",
        "name": "FaZe Clips",
        "brand": "FaZe",
        "access": "open",
        "campaignType": "cpm",
        "state": "active",
        "membership": "in",
        "crId": ids.typeid("cmp", uuid),
        "idMatch": "typeid",
        "pay": [
            {
                "platform": "youtube",
                "per1kCents": 200,
                "perPostCents": None,
                "minPayoutCents": 1000,
                "maxPayoutCents": 35000,
                "minViews": None,
            },
            {
                "platform": "instagram",
                "per1kCents": 200,
                "perPostCents": None,
                "minPayoutCents": 1000,
                "maxPayoutCents": 35000,
                "minViews": None,
            },
        ],
        "budget": {"totalCents": 850000, "spentCents": 60992, "leftCents": 789008, "usedPct": 7.2},
        "platformsPaid": ["youtube", "instagram"],
        "rulesState": "ready",
        "rules": {
            **rules.empty(),
            "requiredHashtags": ["#FaZe"],
            "requiredTags": ["@FaZeClan"],
            "lengthMinSec": 15,
            "lengthMaxSec": 60,
        },
        "plainRules": [],
        "uncertain": [],
        "logo": {"needed": False, "state": "none"},
        "sourceVideos": [],
        "anyway": [],
        "addedAt": iso(now - timedelta(hours=1)),
        "checkedAt": iso(now - timedelta(minutes=5)),
        "lastListedAt": iso(now - timedelta(minutes=5)),
        "listed": True,
        **fields,
    }
    store.put({k: v for k, v in item.items() if v is not None})
    return item


def seed_setup(store: db.Store, user_id: str, platform: str, *, audit: str | None = None) -> None:
    """A platform that is ``ready`` in GET /v1/setup (connected, no gate asking for action)."""
    store.put(
        {
            "pk": db.user_pk(user_id),
            "sk": f"ACCOUNT#{platform}",
            "type": "account",
            "userId": user_id,
            "platform": platform,
            "status": "connected",
            "handle": f"@{platform}fan",
            "accountId": f"{platform}-1",
        }
    )
    setup: dict[str, Any] = {
        "pk": db.user_pk(user_id),
        "sk": f"SETUP#{platform}",
        "type": "setup",
        "platform": platform,
        "stepsDone": {"key-publish", "public-live"},
    }
    if audit:
        setup["gates"] = {"posting_audit": {"state": audit}}
    store.put(setup)


def signed_state(nonce: str, exp: int) -> str:
    return oauth_state.sign(STATE_KEY, "contentrewards", nonce, exp)


def secret_values(secrets_client: FakeSecretsManager) -> list[str]:
    """Every secret string ever written (current and old versions), to scan answers, logs and items for leaks."""
    out = list(secrets_client.values.values())
    for versions in secrets_client.versions.values():
        out += list(versions.values())
    found: list[str] = []
    for text in out:
        try:
            value = json.loads(text)
        except ValueError:
            continue
        if isinstance(value, dict):
            for k in ("accessToken", "refreshToken"):
                if isinstance(value.get(k), str) and value[k]:
                    found.append(value[k])
    return found


Router = Callable[[dict[str, Any]], Any]
