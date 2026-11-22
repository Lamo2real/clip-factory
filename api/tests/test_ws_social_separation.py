"""No Lamo Stories social or publishing setting changes anything in Clip Factory (CONTRACTS §45.19, §45.32 #20,
§45.33 "The separation test's allowed exceptions").

Every route of ``workspaces/routes/social.py`` (and the public callback), then the story flow on every platform with
both developer-app choices, runs against a seeded Clip Factory. Every DynamoDB key, query and secret name they touch
is recorded: nothing outside ``USER#{u}#WS#…``, ``USER#{u}#WSREG``, ``OAUTH#ws.…`` and ``cf-prod/workspaces/…``,
except the allowed reads (six attributes of ``ACCOUNT#``, the YouTube, TikTok and X app keys, the OAuth state key;
the story flow on the shared app also Clip Factory's ``RATE#`` counters and its settings' ``autoPost``, read only,
§45.37 G6)
and ``RATE#{platform}`` writes only for the shared-app choice. Clip Factory's items and secrets are byte-identical
after.
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.flows.story_flow import run_story_flow
from clipfactory_api.oauth import setup
from clipfactory_api.workspaces import apps
from conftest import STATE_SECRET, USER, Call, Clock
from fakes import FakeDurableContext, FakeHttp, FakeSecretsManager, FakeTable
from test_oauth_callback import SUCCESS
from test_oauth_state_formats import GOOD

ROOT = "/v1/workspaces/stories/social"
ALLOWED_PK = (f"USER#{USER}#WS#", f"USER#{USER}#WSREG", "OAUTH#ws.")
CLIPS_APP_READS = {f"cf-prod/platforms/{p}/app" for p in ("youtube", "tiktok", "x")}


@pytest.fixture(autouse=True)
def _callback_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(apps.CALLBACK_ENV, sup.STORIES_CALLBACK)


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


def clip_factory(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    """A Clip Factory with every platform connected, its setup items, tokens and app keys (Meta's too)."""
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        sup.clips_account(store, secrets_client, platform)
        setup.record(store, USER, platform, sup.NOW, {"keysSavedAt": "2026-11-01T00:00:00.000Z"})
        secrets_client.values[f"cf-prod/platforms/{platform}/app"] = json.dumps(GOOD[platform])
    store.put({"pk": db.user_pk(USER), "sk": "SETTINGS", "type": "settings", "youtubePrivacy": "private"})
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "dayKey": "2026-11-15", "unitsUsed": 10})


def clips_world(table: FakeTable, secrets_client: FakeSecretsManager) -> tuple[list[Any], dict[str, str]]:
    items = sorted(
        json.dumps(i, sort_keys=True, default=str)
        for i in table.all()
        if not str(i["pk"]).startswith((*ALLOWED_PK, "RATE#WS#"))
    )
    secrets = {k: v for k, v in secrets_client.values.items() if not k.startswith(sup.WSP)}
    return items, copy.deepcopy(secrets)


def assert_only_allowed(table: FakeTable, secrets_client: FakeSecretsManager, *, since: int, rates: set[str]) -> None:
    for op, kw in table.calls[since:]:
        if op == "transact_write_items":
            keys = [(next(iter(a.values())).get("Key") or next(iter(a.values()))["Item"]) for a in kw["TransactItems"]]
        elif op == "query":
            keys = [{"pk": kw["ExpressionAttributeValues"][":pk"], "sk": ""}]
        else:
            keys = [kw.get("Key") or kw["Item"]]
        for key in keys:
            pk, sk = str(key["pk"]), str(key.get("sk") or "")
            if pk.startswith(ALLOWED_PK):
                continue
            if pk == f"USER#{USER}" and op == "get_item" and sk.startswith("ACCOUNT#"):
                names = set(kw["ExpressionAttributeNames"].values())
                assert names == {"pk", "sk", "platform", "status", "accountId", "handle"}  # §45.37 G8 b
                continue
            if pk == f"USER#{USER}" and op == "get_item" and sk == "SETTINGS":
                # §45.37 G6: Clip Factory's auto-posting schedule, read only, and nothing else of its settings
                assert rates, (op, pk)  # only the story flow, on Clip Factory's shared app, reads it
                assert set(kw["ExpressionAttributeNames"].values()) == {"pk", "sk", "autoPost"}
                continue
            if pk.startswith("RATE#") and not pk.startswith("RATE#WS#"):
                # Clip Factory's counters: read only, and only to work out the room its share leaves (§45.37 G6)
                assert pk in rates, (op, pk)
                assert op == "get_item", (op, pk)
                continue
            if pk.startswith("RATE#WS#stories#"):
                continue
            if pk.startswith("RATE#WS#~shared#") and sk.startswith("SHAREUSE#"):
                # §45.37 G6: Lamo Stories' one counter of Clip Factory's shared app, all workspaces together
                assert rates, (op, pk)  # only the story flow, on Clip Factory's shared app, counts there
                continue
            raise AssertionError(f"{op} touched {pk} {sk}")
    for _, name in secrets_client.calls:
        assert name.startswith(f"{sup.WSP}stories/") or name in CLIPS_APP_READS or name == STATE_SECRET, name
    for op, name in secrets_client.writes:
        assert name.startswith(f"{sup.WSP}stories/"), (op, name)


def test_every_social_route_stays_inside_lamo_stories(
    call: Call,
    app: App,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
) -> None:
    clip_factory(store, secrets_client)
    sup.workspace(store)
    sup.install(app, secrets_client, sup.FakeStarter())
    sup.story(store)
    before = clips_world(table, secrets_client)
    since = len(table.calls)
    secrets_client.calls.clear()
    http.answers.extend([(400, {"error": "invalid_grant"})] * 2 + [(200, {"access_token": "T"}), (200, {"name": "A"})])
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        body = {"choice": "clips"} if platform in sup.SHARED else {"choice": "own", **GOOD[platform]}
        assert call("PUT", f"{ROOT}/{platform}/app", body)[0] == 200
        if platform in ("youtube", "x"):
            assert call("PUT", f"{ROOT}/{platform}/app", {"choice": "own", **GOOD[platform]})[0] == 200
            assert call("POST", f"{ROOT}/{platform}/app/check")[0] == 200
            assert call("DELETE", f"{ROOT}/{platform}/app")[0] == 204
            assert call("PUT", f"{ROOT}/{platform}/app", {"choice": "clips"})[0] == 200
    assert call("POST", f"{ROOT}/facebook/app/check")[0] == 200
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        signed = sup.ws_start(call, platform)
        http.answers.extend(SUCCESS[platform])
        if platform in sup.SHARED:  # through Clip Factory's callback: a forward, nothing else
            location = sup.land(sup.hooks_deps(store, app.oauth, app.clock), platform, {"code": "C", "state": signed})  # type: ignore[arg-type]
            assert location.startswith(sup.STORIES_CALLBACK)
        landed = sup.stories_callback(app, platform, {"code": "C", "state": signed})
        assert "result=same_as_clips&" in landed or "result=connected&" in landed, landed
    http.answers.extend(
        [
            (200, {"items": [{"id": "UC123"}]}),
            (200, {"data": {"user": {"open_id": "open-1"}}, "error": {"code": "ok"}}),
            (200, "publish/tiktok_creator"),
        ]
    )
    for method, path, body in (
        ("GET", ROOT, None),
        ("POST", f"{ROOT}/youtube/check", None),
        ("POST", f"{ROOT}/tiktok/check", None),
        ("GET", f"{ROOT}/tiktok/creator-info", None),
        ("POST", f"{ROOT}/youtube/share", {"confirm": True}),
        ("POST", f"{ROOT}/instagram/choose", {"choiceId": "1"}),
        ("POST", f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish", {"targets": []}),
        (
            "POST",
            f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish",
            {"targets": [{"platform": "facebook", "socialAccountId": "stories.facebook"}]},
        ),
        ("GET", "/v1/workspaces/stories/publishing", None),
        ("DELETE", f"{ROOT}/x", None),
        ("DELETE", f"{ROOT}/instagram/app", None),
    ):
        status, answer = call(method, path, body)
        assert status < 500, (method, path, answer)
    assert_only_allowed(table, secrets_client, since=since, rates=set())
    assert clips_world(table, secrets_client) == before


@pytest.mark.parametrize("choice", ["own", "clips"])
@pytest.mark.parametrize("platform", ["youtube", "x"])
def test_the_story_flow_stays_inside_lamo_stories(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock, platform: str, choice: str
) -> None:
    clip_factory(store, secrets_client)
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, platform, choice=choice)
    sup.pubjob(store, platform, appChoice=choice)
    before = clips_world(table, secrets_client)
    since = len(table.calls)
    secrets_client.calls.clear()
    answers: dict[str, list[Any]] = {
        "youtube": [
            (200, b"", {"Location": "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=a"}),
            (201, "publish/youtube_video"),
            (200, "publish/youtube_uploaded"),
            (200, "publish/youtube_processed"),
            *[(200, {"items": []}), (403, {"error": {"code": 403}})] * 4,
        ],
        "x": [(402, {"title": "CreditsDepleted"})],
    }
    http = FakeHttp(*answers[platform])
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    shared = {f"RATE#{platform}"} if choice == "clips" else set()
    assert_only_allowed(table, secrets_client, since=since, rates=shared)
    # §45.37 G6 (a, f): with Clip Factory's shared app too, every Clip Factory item (its RATE# counters, settings and
    # X budget included) and secret is byte for byte as it was
    assert clips_world(table, secrets_client) == before
