"""Shared helpers for the Lamo Stories AI tests (docs/CONTRACTS.md §45.19, §45.25-§45.33). Offline only: the repo's
fakes, no AWS, no network.

``FakeRuntime`` stands in for Lamo Stories' own AgentCore runtime client (``workspaces.agent.StoryAgent``, builder
A) with the same keyword-only methods; ``install`` puts it (and the provider-key Secrets Manager client) on the app;
``ws_call`` dispatches through Lamo Stories' own route table only; the ``seed_*`` helpers write items as the agent or
the other routes would. This module holds no tests.
"""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Callable, Iterable
from typing import Any

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.http import dispatch
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import deps, provider_keys
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.routes import ROUTES
from conftest import USER, make_event
from fakes import FakeS3

WS = "stories"
BASE = f"/v1/workspaces/{WS}"
STORIES_ARN = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_prod_story_agent"
AT = "2026-11-15T11:00:00.000Z"

WsCall = Callable[..., tuple[int, Any]]


class FakeRuntime:
    """Lamo Stories' runtime client: records every start and stop; ``fail`` makes the next starts raise."""

    runtime_arn = STORIES_ARN

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.stopped: list[str] = []
        self.fail = False

    def _record(self, action: str, **kw: Any) -> None:
        self.calls.append({"action": action, **kw})
        if self.fail:
            raise RuntimeError("runtime answered 503")

    def start_task(self, *, user_id: str, workspace_id: str, task_id: str, kind: str, session_id: str) -> None:
        action = "check_models" if kind == "check_models" else "run_task"
        self._record(action, user_id=user_id, workspace_id=workspace_id, task_id=task_id, session_id=session_id)

    def start_chat_turn(self, *, user_id: str, workspace_id: str, conv_id: str, msg_id: str, session_id: str) -> None:
        self._record(
            "chat_turn",
            user_id=user_id,
            workspace_id=workspace_id,
            conv_id=conv_id,
            msg_id=msg_id,
            session_id=session_id,
        )

    def start_reference(self, *, user_id: str, workspace_id: str, ref_id: str, job_id: str, session_id: str) -> None:
        self._record(
            "process_reference",
            user_id=user_id,
            workspace_id=workspace_id,
            ref_id=ref_id,
            job_id=job_id,
            session_id=session_id,
        )

    def start_story(self, *, user_id: str, workspace_id: str, story_id: str, job_id: str, session_id: str) -> None:
        self._record("process_story", user_id=user_id, workspace_id=workspace_id, story_id=story_id, job_id=job_id)

    def start_portrait(
        self, *, user_id: str, workspace_id: str, character_id: str, job_id: str, session_id: str
    ) -> None:
        self._record("process_portrait", user_id=user_id, workspace_id=workspace_id, character_id=character_id)

    def cancel(self, item_id: str, session_id: str) -> None:
        self.calls.append({"action": "cancel", "id": item_id, "session_id": session_id})

    def cancel_story(self, job_id: str, session_id: str) -> None:
        self.calls.append({"action": "cancel", "id": job_id, "session_id": session_id})

    def stop_session(self, session_id: str) -> None:
        self.stopped.append(session_id)

    @property
    def ready(self) -> bool:
        return True

    def actions(self) -> list[str]:
        return [str(c["action"]) for c in self.calls]


def install(app: App, runtime: FakeRuntime | None, secrets_client: Any = None) -> FakeRuntime | None:
    """Lamo Stories' runtime (None: not switched on) and the provider-key Secrets Manager client."""
    deps.install(app, deps.WsDeps(agent=runtime))
    if secrets_client is not None:
        provider_keys.install(app, secrets_client)
    return runtime


def ws_call(app: App) -> WsCall:
    def _call(method: str, path: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
        out = dispatch(make_event(method, path, body, **kw), app, ROUTES)
        return out["statusCode"], (json.loads(out["body"]) if out["body"] else None)

    return _call


# --- seeds ----------------------------------------------------------------------------------------------------


def pk(user: str = USER, workspace_id: str = WS) -> str:
    return ws.workspace_pk(user, workspace_id)


def prefix(user: str = USER, workspace_id: str = WS) -> str:
    return ws.s3_prefix(user, workspace_id)


def base(sk: str, type_: str, user: str = USER, workspace_id: str = WS) -> dict[str, Any]:
    return {"pk": pk(user, workspace_id), "sk": sk, "type": type_, "userId": user, "workspaceId": workspace_id}


def seed_workspace(store: db.Store, user: str = USER, workspace_id: str = WS, **config: Any) -> None:
    from clipfactory_api.workspaces import guard

    store.put(
        {
            "pk": ws.registry_pk(user),
            "sk": ws.workspace_sk(workspace_id),
            "type": ws.TYPE_WORKSPACE,
            "userId": user,
            "workspaceId": workspace_id,
            "workspaceName": "Lamo Stories",
            "workspaceType": ws.STORIES,
            "configuration": {**guard.default_stories_config(), **config},
            "version": 1,
            "createdAt": AT,
            "updatedAt": AT,
        }
    )


def seed(
    store: db.Store, sk: str, type_: str, user: str = USER, workspace_id: str = WS, **fields: Any
) -> dict[str, Any]:
    item = {**base(sk, type_, user, workspace_id), "createdAt": AT, "updatedAt": AT, **fields}
    store.put(item)
    return item


def seed_idea(store: db.Store, user: str = USER, workspace_id: str = WS) -> str:
    idea_id = ulid()
    seed(store, f"{ws.IDEA_SK}{idea_id}", ws.TYPE_IDEA, user, workspace_id, ideaId=idea_id, title="Ice", status="saved")
    return idea_id


def seed_social(store: db.Store, platform: str, status: str = "connected") -> None:
    seed(
        store,
        f"{ws.SOCIAL_SK}{platform}",
        ws.TYPE_SOCIAL,
        platform=platform,
        socialAccountId=ws.social_account_id(WS, platform),
        connectionStatus=status,
    )


def seed_usage(store: db.Store, day: str, model: str, **fields: Any) -> None:
    item_id = ulid()
    seed(store, f"{ws.USAGE_SK}{day}#{item_id}", ws.TYPE_USAGE, kind="model", model=model, usageId=item_id, **fields)


def seed_asset(store: db.Store, kind: str, size: int) -> None:
    asset_id = ulid()
    seed(store, f"{ws.ASSET_SK}{asset_id}", ws.TYPE_ASSET, assetId=asset_id, kind=kind, bytes=size, key="k")


def skill_md(
    name: str = "funny-endings", description: str = "Use for every ending.", body: str = "# Funny endings\n\nEnd big."
) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


def skill_zip(md: str | None = None, extra: dict[str, bytes] | None = None) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("funny/SKILL.md", md or skill_md())
        for name, data in (extra or {}).items():
            z.writestr(f"funny/{name}", data)
    return out.getvalue()


def upload_skill(
    call: WsCall, s3: FakeS3, data: bytes, filename: str = "SKILL.md", skill_id: str | None = None
) -> dict[str, Any]:
    """Asks for an upload URL and "uploads" the file into the fake bucket, as the browser would."""
    body: dict[str, Any] = {"filename": filename}
    if skill_id:
        body["skillId"] = skill_id
    status, up = call("POST", f"{BASE}/skills/uploads", body)
    assert status == 200, up
    s3.objects[up["key"]] = data
    return dict(up)


# --- what must never leave the API ----------------------------------------------------------------------------

INTERNAL = (
    "sessionId",
    "heartbeatAt",
    "requested",
    "uploadId",
    "analysisKey",
    "uploads",
    "summaryUpToMsgId",
    "statusBefore",
    "partCount",
    "override",
    "pk",
    "sk",
    "userId",
    "ttl",
)


def _strings(value: Any, path: str = "") -> Iterable[tuple[str, str]]:
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _strings(v, f"{path}.{k}")
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v, f"{path}[]")
    elif isinstance(value, str):
        yield path, value


def leaked(responses: Iterable[Any], *, allowed_key_paths: Iterable[str] = (".key",)) -> list[str]:
    """Internal attributes, raw S3 keys, partition keys or secret names found in responses. The skill upload
    answer's ``key`` is the one raw key the contract hands out (§45.5 ``skills/uploads``)."""
    found: list[str] = []
    allowed = set(allowed_key_paths)
    for body in responses:
        text = json.dumps(body)
        found += [f"field {name}" for name in INTERNAL if f'"{name}"' in text]
        found += ["USER#"] if "USER#" in text else []
        found += ["a secret name"] if "cf-prod/" in text else []
        for where, value in _strings(body):
            if value.startswith("ws/") and where not in allowed:
                found.append(f"a raw ws/ key at {where}")
    return found
