"""Every AI route fails closed (docs/CONTRACTS.md §45.3 "Ownership is in the key", §45.5, §45.19): another owner's
workspace id is a 404 and writes nothing, a Lamo Clips id is the 409 of every **S** route, a malformed id is a 404,
another owner never reaches this owner's conversations, messages, notes, skills or reference videos, and every
route is registered exactly once."""

from __future__ import annotations

import re
from typing import Any

import pytest

import ws_routes_ai
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.http import Route
from clipfactory_api.workspaces import guard
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.routes import ai
from conftest import OTHER, USER
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    upload_skill,
    ws_call,
)

OTHER_WS = "01JD00000000000000000000WS"
GROUP = re.compile(r"\(\?P<(\w+)>\[\^/\]\+\)")
SOME_ID = "01JD0000000000000000000000"


def path_of(r: Route, values: dict[str, str]) -> str:
    return GROUP.sub(lambda m: values.get(m.group(1), SOME_ID), r.pattern.pattern[1:-1])


def _ids(**over: str) -> dict[str, str]:
    return {"ws": "stories", "agentId": "storyboard", "modelKey": "opus-5-5", "providerId": "runway", **over}


ROUTES = [pytest.param(r, id=f"{r.method} {path_of(r, _ids())}") for r in ai.ROUTES]


@pytest.fixture
def runtime(app: App) -> FakeRuntime:
    found = install(app, FakeRuntime())
    assert found is not None
    return found


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime) -> WsCall:
    return ws_call(app)


def test_every_route_is_listed_once() -> None:
    concrete = {(r.method, path_of(r, _ids(agentId="creative_director"))) for r in ai.ROUTES}
    assert concrete == ws_routes_ai.EXPECTED
    assert len(ai.ROUTES) == len(ws_routes_ai.EXPECTED) == 43  # §45.37 G2: + PUT and DELETE …/makers/models/{key}
    assert all(r.public is False for r in ai.ROUTES)  # JWT on every route


@pytest.mark.parametrize("r", ROUTES)
def test_another_owners_workspace_is_404_and_writes_nothing(
    r: Route, wcall: WsCall, store: db.Store, table: FakeTable, runtime: FakeRuntime
) -> None:
    store.put(
        {
            "pk": ws.registry_pk(OTHER),
            "sk": ws.workspace_sk(OTHER_WS),
            "type": ws.TYPE_WORKSPACE,
            "userId": OTHER,
            "workspaceId": OTHER_WS,
            "workspaceName": "Theirs",
            "workspaceType": "stories",
            "configuration": guard.default_stories_config(),
            "version": 1,
        }
    )
    before = table.all()
    status, body = wcall(r.method, path_of(r, _ids(ws=OTHER_WS)), {})
    assert status == 404, body
    assert body["error"]["message"] == "We could not find that workspace."
    assert table.all() == before
    assert runtime.calls == []


@pytest.mark.parametrize("r", ROUTES)
def test_a_clips_id_is_the_stories_only_409(r: Route, wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall(r.method, path_of(r, _ids(ws="clips")), {})
    assert status == 409, body
    assert body["error"]["message"] == "That is a Clips Funded page. Switch to Clips Funded first."
    assert table.all() == []


@pytest.mark.parametrize("r", ROUTES)
def test_a_malformed_workspace_id_is_404(r: Route, wcall: WsCall, table: FakeTable) -> None:
    assert wcall(r.method, path_of(r, _ids(ws="USER#x")), {})[0] == 404
    assert wcall(r.method, path_of(r, _ids(ws="lamo-stories")), {})[0] == 404
    assert table.all() == []


def test_another_owner_never_reaches_this_owners_items(
    app: App, wcall: WsCall, s3_client: FakeS3, table: FakeTable, runtime: FakeRuntime
) -> None:
    _, conv = wcall("POST", f"{BASE}/chat", {})
    conv_id = conv["conversation"]["convId"]
    _, sent = wcall("POST", f"{BASE}/chat/{conv_id}/messages", {"text": "hi"})
    msg_id = sent["assistant"]["msgId"]
    _, mem = wcall("POST", f"{BASE}/memory", {"text": "mine"})
    _, skill = wcall("POST", f"{BASE}/skills", {"title": "Mine", "description": "Only mine.", "instructions": "x"})
    _, ref = wcall(
        "POST", f"{BASE}/references", {"filename": "a.mp4", "contentType": "video/mp4", "size": 10, "title": "A"}
    )
    up = upload_skill(wcall, s3_client, b"---\nname: a\ndescription: b\n---\n")
    values = _ids(
        convId=conv_id,
        msgId=msg_id,
        memId=mem["item"]["memId"],
        skillId=skill["skill"]["skillId"],
        refId=ref["reference"]["refId"],
    )
    mine = {k: v for k, v in table.items.items() if k[0] == f"USER#{USER}#WS#stories"}
    calls = len(runtime.calls)
    for r in ai.ROUTES:
        if not any(g in r.pattern.pattern for g in ("convId", "memId", "skillId", "refId")):
            continue
        status, body = wcall(r.method, path_of(r, values), _body_for(r, up), sub=OTHER)
        assert status == 404, (r.method, r.pattern.pattern, status, body)
    # the other owner's first use made their own workspace, and nothing of this owner changed
    assert {k: v for k, v in table.items.items() if k[0] == f"USER#{USER}#WS#stories"} == mine
    assert len(runtime.calls) == calls
    assert not [k for k in table.items if k[0].startswith(f"USER#{OTHER}#WS#") and "SKILL#" in k[1]]


def _body_for(r: Route, up: dict[str, Any]) -> dict[str, Any]:
    p = r.pattern.pattern
    if p.endswith("/messages$"):
        return {"text": "hello"}
    if p.endswith("/attachments$"):
        return {"filename": "a.png", "contentType": "image/png", "size": 10}
    if p.endswith("/restore$"):
        return {"revisionId": SOME_ID}
    if p.endswith("/complete$"):
        return {"parts": [{"partNumber": 1, "etag": "x"}]}
    if "/memory/" in p and r.method == "PATCH":
        return {"text": "theirs"}
    if "/skills/" in p and r.method == "PUT":
        return {"version": 1, "enabled": False}
    if "/chat/" in p and r.method == "PATCH":
        return {"title": "theirs"}
    if "/references/" in p and r.method == "PATCH":
        return {"title": "theirs"}
    return {}
