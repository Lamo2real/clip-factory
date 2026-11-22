"""Lamo Stories never touches Clip Factory (docs/CONTRACTS.md §45.1, §45.19 "a separation test", §45.24, §45.32 #20,
§45.33 "The separation test's allowed exceptions", ADR-76).

Every Lamo Stories route is run with fakes: first a real flow through the AI routes (configuration, agents, skills,
chat, memory, references, onboarding, provider keys, usage, storage), then a sweep of **every** route in Lamo Stories'
own route table (core, AI, social and publishing) with seeded ids and sample bodies. Every DynamoDB key, S3 key or
prefix and Secrets Manager name touched is recorded, and must be inside Lamo Stories' own namespaces:
``USER#{u}#WS#…``, ``USER#{u}#WSREG``, ``OAUTH#ws.…``, ``ws/{u}/…`` and ``cf-prod/workspaces/…``. The only allowed
exceptions are §45.33's reads: five attributes of Clip Factory's ``ACCOUNT#`` items, the YouTube, TikTok and X app-key
secrets and the OAuth state key. Before and after, every Clip Factory item, secret and file is byte-identical, and
neither Clip Factory's agent runtime nor its functions were called. No network: sockets are refused.
"""

from __future__ import annotations

import ast
import copy
import re
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.http import Route
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import deps, provider_keys
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.routes import ROUTES
from clipfactory_api.workspaces.routes import ai as ai_routes
from conftest import STATE_KEY, STATE_SECRET, USER
from fakes import FakeAgentCore, FakeLambda, FakeS3, FakeSecretsManager, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    expression_problems,
    leaked,
    pk,
    prefix,
    seed,
    skill_md,
    ws_call,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "clipfactory_api"
GROUP = re.compile(r"\(\?P<(\w+)>\[\^/\]\+\)")
SOME_ID = "01JD0000000000000000000000"
ACCOUNT_ATTRIBUTES = {"pk", "sk", "platform", "status", "accountId"}
SHARED_APP_SECRETS = {f"cf-prod/platforms/{p}/app" for p in ("youtube", "tiktok", "x")}
WS_PREFIXES = (f"USER#{USER}#WS#", "OAUTH#ws.")
WS_EXACT = (f"USER#{USER}#WSREG",)
MB = 1024 * 1024


class RecordingS3(FakeS3):
    """``FakeS3`` that records every key or prefix any call names."""

    def __init__(self) -> None:
        super().__init__()
        self.touched: list[tuple[str, str]] = []

    def generate_presigned_url(self, op: str, Params: dict[str, Any], ExpiresIn: int) -> str:
        self.touched.append((f"presign:{op}", str(Params.get("Key"))))
        return super().generate_presigned_url(op, Params, ExpiresIn)

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.touched.append(("head", Key))
        return super().head_object(Bucket, Key)

    def put_object(self, **kw: Any) -> dict[str, Any]:
        self.touched.append(("put", str(kw["Key"])))
        return super().put_object(**kw)

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.touched.append(("get", Key))
        return super().get_object(Bucket, Key)

    def delete_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.touched.append(("delete", Key))
        return super().delete_object(Bucket, Key)

    def create_multipart_upload(self, Bucket: str, Key: str, ContentType: str) -> dict[str, Any]:
        self.touched.append(("multipart", Key))
        return super().create_multipart_upload(Bucket, Key, ContentType)

    def complete_multipart_upload(self, Bucket: str, Key: str, UploadId: str, MultipartUpload: Any) -> dict[str, Any]:
        self.touched.append(("complete", Key))
        return super().complete_multipart_upload(Bucket, Key, UploadId, MultipartUpload)

    def abort_multipart_upload(self, Bucket: str, Key: str, UploadId: str) -> dict[str, Any]:
        self.touched.append(("abort", Key))
        return super().abort_multipart_upload(Bucket, Key, UploadId)

    def list_objects_v2(self, Bucket: str, Prefix: str, **kw: Any) -> dict[str, Any]:
        self.touched.append(("list", Prefix))
        return super().list_objects_v2(Bucket, Prefix, **kw)

    def copy_object(self, **kw: Any) -> dict[str, Any]:
        source = kw.get("CopySource") or {}
        self.touched.append(("copy-from", str(source.get("Key") if isinstance(source, dict) else source)))
        self.touched.append(("copy-to", str(kw["Key"])))
        data = self.objects[str(source["Key"])] if isinstance(source, dict) else b""
        self.objects[str(kw["Key"])] = data
        return {}


@pytest.fixture
def s3_client() -> RecordingS3:
    return RecordingS3()


CLIPS_SECRETS = {
    STATE_SECRET: STATE_KEY,
    "cf-prod/platforms/youtube/app": '{"clientId":"yt-id","clientSecret":"yt-secret"}',
    "cf-prod/platforms/youtube/token": '{"accessToken":"clips-yt-token","refreshToken":"r","channelId":"UC1"}',
    "cf-prod/platforms/youtube/pending": '{"channels":[]}',
    "cf-prod/platforms/tiktok/app": '{"clientKey":"tt","clientSecret":"tt-secret"}',
    "cf-prod/platforms/tiktok/token": '{"accessToken":"clips-tt-token","openId":"o1"}',
    "cf-prod/platforms/instagram/app": '{"clientId":"meta","clientSecret":"meta-secret"}',
    "cf-prod/platforms/instagram/token": '{"accessToken":"clips-ig-token","igUserId":"ig1"}',
    "cf-prod/platforms/x/app": '{"clientId":"x","clientSecret":"x-secret"}',
    "cf-prod/ask/search-key": "search-key",
}


@pytest.fixture
def secrets_client() -> FakeSecretsManager:
    return FakeSecretsManager(dict(CLIPS_SECRETS))


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise OSError("the separation test never uses the network")

    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        provider_keys.KEYED, "runway", provider_keys.KeyedProvider("animation", "runway", "Runway (test only)")
    )


def _seed_clip_factory(store: db.Store, s3: FakeS3) -> None:
    """A little of everything Clip Factory keeps (§45.1): accounts, setup, a skill, a job and a clip, a rate counter,
    an OAuth state; files under its own prefixes."""
    user_pk = f"USER#{USER}"
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        store.put(
            {
                "pk": user_pk,
                "sk": f"ACCOUNT#{platform}",
                "type": "account",
                "userId": USER,
                "platform": platform,
                "status": "connected",
                "accountId": f"{platform}-1",
                "accountName": f"@lamo.clips on {platform}",
            }
        )
        store.put({"pk": user_pk, "sk": f"SETUP#{platform}", "type": "setup", "userId": USER, "stepsDone": ["keys"]})
    store.put(
        {"pk": user_pk, "sk": "SKILL#01JD00000000000000000000SK", "type": "skill", "userId": USER, "name": "hooks"}
    )
    store.put({"pk": user_pk, "sk": "JOB#01JD00000000000000000000JB", "type": "job", "userId": USER, "status": "done"})
    store.put(
        {"pk": user_pk, "sk": "CLIP#01JD00000000000000000000CL", "type": "clip", "userId": USER, "status": "review"}
    )
    store.put({"pk": user_pk, "sk": "SETTINGS", "type": "settings", "userId": USER, "clipModel": "fable-5-1"})
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "used": 100})
    store.put({"pk": "OAUTH#v1nonce", "sk": "STATE", "userId": USER, "platform": "youtube"})
    for key in (f"uploads/{USER}/u1/video.mp4", f"skills/{USER}/s1/r1/SKILL.md", "jobs/j1/clips/c1/clip.mp4"):
        s3.objects[key] = b"clip factory"


def _seed_stories(store: db.Store, s3: FakeS3) -> dict[str, str]:
    """Lamo Stories items other builders' routes read, so the sweep finds something under every id."""
    ids = {
        name: ulid() for name in ("ideaId", "characterId", "storyId", "assetId", "jobId", "taskId", "publishingJobId")
    }
    seed(store, f"{ws.IDEA_SK}{ids['ideaId']}", ws.TYPE_IDEA, ideaId=ids["ideaId"], title="Ice", logline="A skid.",
         category="comedy", status="saved", characterIds=[], storyIds=[], needsGuidance=False)  # fmt: skip
    seed(store, f"{ws.CHAR_SK}{ids['characterId']}", ws.TYPE_CHARACTER, characterId=ids["characterId"], name="Lamo",
         references=[], version=1)  # fmt: skip
    seed(store, f"{ws.STORY_SK}{ids['storyId']}", ws.TYPE_STORY, storyId=ids["storyId"], title="Ice", status="review",
         category="comedy", characterIds=[ids["characterId"]], stale=[], scriptVersion=1, version=1,
         scriptKey=f"{prefix()}stories/{ids['storyId']}/script/v1.json")  # fmt: skip
    s3.objects[f"{prefix()}stories/{ids['storyId']}/script/v1.json"] = b"{}"
    seed(store, f"{ws.ASSET_SK}{ids['assetId']}", ws.TYPE_ASSET, assetId=ids["assetId"], kind="final_video",
         storyId=ids["storyId"], bytes=10, key=f"{prefix()}stories/{ids['storyId']}/final/v1.mp4")  # fmt: skip
    seed(store, f"{ws.PJOB_SK}{ids['jobId']}", ws.TYPE_PJOB, jobId=ids["jobId"], contentType="animation",
         contentId=ids["storyId"], status="ready", steps=[], sessionId="cfstory-x", heartbeatAt="2026-11-15T11:00:00.000Z")  # fmt: skip
    seed(store, f"{ws.TASK_SK}{ids['taskId']}", ws.TYPE_TASK, taskId=ids["taskId"], kind="brainstorm", status="done")
    seed(store, f"{ws.SOCIAL_SK}youtube", ws.TYPE_SOCIAL, platform="youtube", socialAccountId="stories.youtube",
         connectionStatus="connected", externalAccountId="UC-stories", accountName="Lamo Stories")  # fmt: skip
    seed(store, f"{ws.PUBJOB_SK}{ids['publishingJobId']}", ws.TYPE_PUBJOB, publishingJobId=ids["publishingJobId"],
         contentId=ids["storyId"], platform="youtube", socialAccountId="stories.youtube", publishingStatus="failed")  # fmt: skip
    return ids


def _clips_snapshot(table: FakeTable, secrets: FakeSecretsManager, s3: FakeS3) -> dict[str, Any]:
    def stories_pk(value: str) -> bool:
        return value.startswith(WS_PREFIXES) or value in WS_EXACT or (value.startswith("USER#") and "#WS" in value)

    return {
        "items": {k: copy.deepcopy(v) for k, v in table.items.items() if not stories_pk(k[0])},
        "secrets": {k: v for k, v in secrets.values.items() if not k.startswith("cf-prod/workspaces/")},
        "files": {k: v for k, v in s3.objects.items() if not k.startswith("ws/")},
    }


# --- what was touched -----------------------------------------------------------------------------------------


def _keys(name: str, kw: dict[str, Any]) -> Iterator[tuple[str, str, str | None, dict[str, Any]]]:
    if name in {"get_item", "delete_item", "update_item"}:
        yield name, kw["Key"]["pk"], kw["Key"]["sk"], kw
    elif name == "put_item":
        yield name, kw["Item"]["pk"], kw["Item"]["sk"], kw
    elif name == "query":
        yield ("query-index" if kw.get("IndexName") else "query"), kw["ExpressionAttributeValues"][":pk"], None, kw
    elif name == "transact_write_items":
        for action in kw["TransactItems"]:
            ((kind, request),) = action.items()
            key = request.get("Item") or request.get("Key") or {}
            yield f"transact-{kind}", key.get("pk", ""), key.get("sk"), request
    elif name == "batch_get_item":
        for request in kw["RequestItems"].values():
            for key in request["Keys"]:
                yield "batch_get_item", key["pk"], key["sk"], request
    else:
        yield name, "?", None, kw


def _projection(kw: dict[str, Any]) -> set[str] | None:
    text = kw.get("ProjectionExpression")
    if not text:
        return None
    names = kw.get("ExpressionAttributeNames") or {}
    return {names.get(part.strip(), part.strip()) for part in str(text).split(",")}


def ddb_problems(table: FakeTable) -> list[str]:
    out = []
    for name, kw in table.calls:
        for op, pk_value, sk_value, request in _keys(name, kw):
            if op == "query-index":
                out.append(f"{op} on {pk_value} (Lamo Stories never reads an index)")
            elif pk_value.startswith(WS_PREFIXES) or pk_value in WS_EXACT:
                continue
            elif (
                op in {"get_item", "batch_get_item"}
                and pk_value == f"USER#{USER}"
                and str(sk_value or "").startswith("ACCOUNT#")
                and (_projection(request) or {"everything"}) <= ACCOUNT_ATTRIBUTES
            ):
                continue  # §45.33: the attribute-limited read of Clip Factory's ACCOUNT# items
            else:
                out.append(f"{op} {pk_value} {sk_value}")
    return out


def s3_problems(s3: RecordingS3) -> list[str]:
    return [f"{op} {key}" for op, key in s3.touched if not key.startswith(f"ws/{USER}/")]


def secret_problems(secrets: FakeSecretsManager) -> list[str]:
    out = []
    for op, name in secrets.calls:
        if name.startswith("cf-prod/workspaces/stories/"):
            continue
        if op == "get" and (name in SHARED_APP_SECRETS or name == STATE_SECRET):
            continue  # §45.33: the shared-app keys (YouTube, TikTok, X only) and the OAuth state key, read only
        out.append(f"{op} {name}")
    return out


# --- the run --------------------------------------------------------------------------------------------------


class Recorder:
    def __init__(self, call: WsCall) -> None:
        self.call = call
        self.responses: list[tuple[str, str, int, Any]] = []

    def __call__(self, method: str, path: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
        status, got = self.call(method, path, body, **kw)
        self.responses.append((method, path, status, got))
        return status, got


def _ai_flow(call: Recorder, s3: RecordingS3) -> None:
    """A real run through every AI route (the sweep below covers everybody's routes again)."""

    def ok(method: str, path: str, body: Any = None, expect: int = 200) -> Any:
        status, got = call(method, f"{BASE}{path}", body)
        assert status == expect, (method, path, status, got)
        return got

    ok("GET", "/ai")
    ok(
        "PUT",
        "/ai",
        {"defaultModel": "fable-5-2", "defaultEffort": "high", "tasks": {"chat": {"effort": "low"}}, "version": 0},
    )
    ok("PUT", "/ai/prices/opus-5-5", {"inputPer1M": 5, "outputPer1M": 25, "currency": "USD"})
    ok("PUT", "/ai/models/custom-llama", MODEL_DEF)  # a model the owner adds (§45.34), kept in MODELDEF# only
    ok("POST", "/ai/check-models", {"models": ["opus-5-5"]}, 202)
    ok("GET", "/usage")
    agent = ok("GET", "/agents/storyboard")["agent"]
    ok("PATCH", "/agents/storyboard", {"version": agent["version"], "model": "sonnet-5-5", "effort": "max"})
    ok("PATCH", "/agents/storyboard", {"reset": True})
    ok("GET", "/skills")
    up = ok("POST", "/skills/uploads", {"filename": "SKILL.md"})
    s3.objects[up["key"]] = skill_md().encode()
    uploaded = ok("POST", "/skills", {"skillId": up["skillId"], "key": up["key"]}, 201)["skill"]
    written = ok("POST", "/skills", {"title": "Mine", "description": "Use it.", "instructions": "Be funny."}, 201)[
        "skill"
    ]
    ok("GET", f"/skills/{written['skillId']}")
    edited = ok("PUT", f"/skills/{written['skillId']}", {"version": 1, "instructions": "Be funnier."})["skill"]
    ok("POST", f"/skills/{written['skillId']}/restore", {"revisionId": edited["revisions"][-1]["revisionId"]})
    ok("PUT", "/skills/vertical-short-hooks", {"version": 0, "enabled": False})
    conv = ok("POST", "/chat", {"title": "Ice"}, 201)["conversation"]
    picture = ok(
        "POST", f"/chat/{conv['convId']}/attachments", {"filename": "a.png", "contentType": "image/png", "size": 4}
    )
    s3.objects[f"{prefix()}chat/{conv['convId']}/{picture['assetId']}.png"] = b"\x89PNG"
    sent = ok("POST", f"/chat/{conv['convId']}/messages", {"text": "Idea?", "attachments": [{"assetId": picture["assetId"]}],
              "override": {"model": "opus-5-5"}}, 202)  # fmt: skip
    ok("GET", "/chat")
    ok("GET", f"/chat/{conv['convId']}")
    ok("POST", f"/chat/{conv['convId']}/messages/{sent['assistant']['msgId']}/stop")
    ok("PATCH", f"/chat/{conv['convId']}", {"model": "haiku-5-5"})
    mem = ok("POST", "/memory", {"text": "Lamo likes slapstick."}, 201)["item"]
    ok("GET", "/memory")
    ok("PATCH", f"/memory/{mem['memId']}", {"text": "Lamo loves slapstick."})
    created = ok(
        "POST", "/references", {"filename": "a.mp4", "contentType": "video/mp4", "size": 150 * MB, "title": "A"}, 201
    )
    ref_id = created["reference"]["refId"]
    upload_id = created["upload"]["uploadId"]
    parts = [{"partNumber": n, "etag": s3.send_part(upload_id, n, b"v")} for n in (1, 2)]
    ok("POST", f"/references/{ref_id}/complete", {"parts": parts})
    ok("POST", f"/references/{ref_id}/analyze", {"override": {"effort": "max"}}, 202)
    ok("GET", "/references")
    ok("GET", f"/references/{ref_id}")
    ok("PATCH", f"/references/{ref_id}", {"title": "B", "ai": {"model": "fable-5-1", "effort": None}})
    ok("GET", "/onboarding")
    ok("PATCH", "/onboarding", {"step": "agents", "done": True})
    ok("PATCH", "/onboarding", {"step": "instagram", "skipped": True})
    ok("PATCH", "/onboarding", {"finish": True})
    ok("PUT", "/providers/runway/key", {"key": "sk-live-0123456789abcdef"})
    ok("GET", "/storage")
    ok("POST", "/storage/cleanup", {})
    ok("DELETE", "/ai/models/custom-llama", expect=204)
    ok("DELETE", "/providers/runway/key", expect=204)
    ok("DELETE", f"/memory/{mem['memId']}", expect=204)
    ok("DELETE", f"/references/{ref_id}", expect=204)
    ok("DELETE", f"/chat/{conv['convId']}", expect=204)
    ok("DELETE", f"/skills/{uploaded['skillId']}", expect=204)


MODEL_DEF = {
    "label": "Llama 4 (test only)",
    "provider": "Meta",
    "modelId": "us.meta.llama4-maverick-17b-instruct-v1:0",
    "region": "us-east-1",
    "efforts": [],
    "defaultEffort": None,
    "vision": False,
    "maxOutputTokens": 8192,
    "price": None,
}
LOOK = {
    "body": "bean",
    "skin": "#f2c9a0",
    "height": 1,
    "width": 1,
    "hair": {"style": "short", "color": "#3b2a1a"},
    "eyes": {"shape": "round", "color": "#1c1842"},
    "brows": "thick",
    "nose": "button",
    "mouth": "wide",
    "outfit": {"top": "#ff6f61", "bottom": "#1c1842", "accent": "#ffc94a", "pattern": "plain"},
    "accessory": "none",
    "outline": "#1c1842",
}


def _sample_bodies(r: Route, ids: dict[str, str]) -> list[Any]:
    """Bodies that get past each route's checks (the shapes of §45.5 and §45.6), plus an empty one."""
    p, m = r.pattern.pattern, r.method
    if m in {"GET", "DELETE"}:
        return [None]
    character = {
        "name": "Bo",
        "description": "A driver.",
        "personality": "Calm.",
        "traits": ["calm"],
        "movementStyle": "calm",
        "expressions": ["neutral", "happy", "shocked"],
        "look": LOOK,
        "voice": {"style": "babble", "pitch": 1.0, "noises": ["gasp"], "sfx": ["boing"]},
    }
    brief = {"title": "Ice", "logline": "A skid.", "category": "comedy"}
    picture = {"filename": "a.png", "contentType": "image/png", "size": 10}
    samples: list[tuple[str, str, Any]] = [  # (method, the end of the route's pattern, body)
        ("POST", "/v1/workspaces", {"workspaceType": "stories", "workspaceName": "Lamo Cars"}),
        ("PATCH", "/v1/workspaces/(?P<ws>[^/]+)", {"version": 1, "workspaceName": "Lamo Stories"}),
        ("POST", "/ideas", brief),
        ("PATCH", "/ideas/(?P<ideaId>[^/]+)", {"title": "Ice 2"}),
        ("POST", "/ideas/generate", {"count": 2}),
        ("POST", "/variations", {"count": 2}),
        ("POST", "/characters", character),
        ("PUT", "/characters/(?P<characterId>[^/]+)", {**character, "version": 1}),
        ("POST", "/characters/(?P<characterId>[^/]+)/references", picture),
        ("POST", "/design/uploads", picture),
        ("POST", "/design", {"description": "A tall driver."}),
        ("POST", "/design", {"description": "Taller.", "characterId": ids["characterId"]}),
        ("POST", "/download", {"format": "webm"}),
        ("PUT", "/models/(?P<modelKey>[^/]+)", MODEL_DEF),
        (
            "PATCH",
            "/v1/workspaces/(?P<ws>[^/]+)",
            {
                "version": 2,
                "configuration": {
                    "production": {"keepReferences": "study_only", "keepChatPictures": "days_30", "keepVersions": 1}
                },
            },
        ),
        ("POST", "/stories", {"characterIds": [ids["characterId"]], "brief": brief}),
        ("PATCH", "/stories/(?P<storyId>[^/]+)", {"version": 1, "title": "Ice 2"}),
        ("POST", "/produce", {"from": "storyboard"}),
        ("POST", "/approve", {"version": 1}),
        ("POST", "/reject", {"reason": "no"}),
        ("POST", "/changes", {"note": "Faster."}),
        ("POST", "/publish", {"targets": [{"platform": "youtube", "socialAccountId": "stories.youtube"}]}),
        ("POST", "/share", {"confirm": True}),
        ("POST", "/choose", {"choiceId": "page-1"}),
        ("PUT", "/app", {"choice": "clips"}),
        ("PUT", "/app", {"choice": "own", "clientId": "own-id", "clientSecret": "own-secret"}),
    ]
    return [{}] + [body for method, end, body in samples if method == m and p.endswith(end + "$")]


def _path(r: Route, values: dict[str, str]) -> str:
    return GROUP.sub(lambda g: values.get(g.group(1), SOME_ID), r.pattern.pattern[1:-1])


def _install_everything(app: App, runtime: FakeRuntime, secrets: FakeSecretsManager, s3: FakeS3) -> None:
    """Lamo Stories' runtime, and whatever the other builders' dependencies take, over the same recording fakes."""
    found = deps.WsDeps(agent=runtime)
    if hasattr(found, "s3"):
        found.s3 = s3  # builder A's download client
    try:
        from clipfactory_api.workspaces import secrets as ws_secrets  # builder B's wrapper

        found.secrets = ws_secrets.WorkspaceSecrets(secrets)  # type: ignore[attr-defined]
    except Exception:  # noqa: S110 (not on this branch yet: B's routes then answer "not set up")
        pass
    deps.install(app, found)
    provider_keys.install(app, secrets)


def test_every_lamo_stories_route_stays_in_its_own_namespaces(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: RecordingS3,
    secrets_client: FakeSecretsManager,
    agentcore: FakeAgentCore,
    lambda_client: FakeLambda,
    keyed: None,
) -> None:
    _seed_clip_factory(store, s3_client)
    runtime = FakeRuntime()
    _install_everything(app, runtime, secrets_client, s3_client)
    call = Recorder(ws_call(app))
    ids = _seed_stories(store, s3_client)
    before = _clips_snapshot(table, secrets_client, s3_client)
    table.calls.clear()
    secrets_client.calls.clear()
    s3_client.touched.clear()

    _ai_flow(call, s3_client)
    flow = list(call.responses)
    hit = {
        (r.method, r.pattern.pattern)
        for r in ai_routes.ROUTES
        for m, p, s, _ in flow
        if m == r.method and r.pattern.match(p) and s < 300
    }
    assert len(hit) == len(ai_routes.ROUTES) == 41  # the real flow answered every AI route

    # every route of Lamo Stories' own table, with every id a seeded or a made-up one, writes and reads first
    values = {"ws": "stories", "platform": "youtube", "agentId": "creative_director", "modelKey": "custom-sweep",
              "providerId": "runway", "skillId": "nonverbal-storytelling", **ids}  # fmt: skip
    ordered = sorted(ROUTES, key=lambda r: r.method == "DELETE")
    for r in ordered:
        for body in _sample_bodies(r, ids):
            call(r.method, _path(r, values), body)
        if r.method != "DELETE":
            call(r.method, _path(r, {"ws": "stories"}), {} if r.method not in {"GET", "DELETE"} else None)

    # the sweep turned the keep settings on and cleared files with them (§45.34), inside the workspace only
    stored = table.items[(ws.registry_pk(USER), ws.workspace_sk("stories"))]["configuration"]["production"]
    assert (stored["keepReferences"], stored["keepVersions"]) == ("study_only", 1)
    assert [s for m, p, s, _ in call.responses if m == "POST" and p.endswith("/storage/cleanup")].count(200) >= 2
    assert ddb_problems(table) == []
    assert expression_problems(table) == []
    assert s3_problems(s3_client) == []
    assert secret_problems(secrets_client) == []
    assert _clips_snapshot(table, secrets_client, s3_client) == before
    # nothing ran in Clip Factory's agent runtime or its functions (§45.24)
    assert agentcore.calls == []
    assert agentcore.stopped == []
    assert [c for c in lambda_client.calls if "cf-prod-job-flow" in str(c.get("FunctionName"))] == []
    assert [c for c in lambda_client.calls if "story-flow" not in str(c.get("FunctionName"))] == []
    # every runtime call went to Lamo Stories' own runtime
    assert runtime.calls
    assert all(str(c.get("session_id", "cfstory-")).startswith("cfstory-") for c in runtime.calls)
    # the AI flow itself: no server errors and nothing internal in any answer
    assert [(m, p, s) for m, p, s, _ in flow if s >= 500] == []
    # (the reference upload answer's ``upload.uploadId`` and the skill upload's ``key`` are the contract's own)
    answers = [b for m, p, _, b in flow if b and not (m == "POST" and p.endswith("/references"))]
    answers += [b["reference"] for m, p, _, b in flow if b and m == "POST" and p.endswith("/references")]
    assert leaked(answers) == []
    # and nothing in any route's answer names a session, a partition, a secret or a raw file key
    strict = ("sessionId", "heartbeatAt", "USER#", "cf-prod/")
    for method, path, status, got in call.responses:
        text = repr(got)
        assert not [s for s in strict if s in text], (method, path, status)
    ai_paths = [p for m, p, s, _ in call.responses if "/workspaces/stories/" in p and s >= 500 and _is_ai(p)]
    assert ai_paths == []


def _is_ai(path: str) -> bool:
    return bool(
        re.search(r"/(ai|usage|agents|skills|chat|memory|references|onboarding|providers/[^/]+/key|storage)(/|$)", path)
    )


def test_the_problem_finders_catch_each_kind_of_breach() -> None:
    """The recorder's rules, proved on purpose-made breaches (so a passing run means something)."""
    t = FakeTable()
    store = db.Store(t)
    store.get(f"USER#{USER}", "ACCOUNT#youtube")  # no projection: every attribute, not allowed
    store.put({"pk": f"USER#{USER}", "sk": "SKILL#x"})
    store.query_page(f"USER#{USER}", "JOB#")
    store.get("RATE#youtube", "BUDGET")
    store.get(f"USER#{USER}#WS#stories", "AICONFIG")
    t.get_item(
        Key={"pk": f"USER#{USER}", "sk": "ACCOUNT#x"},
        ProjectionExpression="pk, sk, #s",
        ExpressionAttributeNames={"#s": "status"},
    )
    found = ddb_problems(t)
    assert len(found) == 4
    s3 = RecordingS3()
    s3.objects[f"skills/{USER}/s/r/SKILL.md"] = b"x"
    s3.get_object("b", f"skills/{USER}/s/r/SKILL.md")
    s3.put_object(Bucket="b", Key=f"ws/{USER}/stories/a", Body=b"x")
    s3.list_objects_v2("b", "ws/")
    assert s3_problems(s3) == [f"get skills/{USER}/s/r/SKILL.md", "list ws/"]
    sm = FakeSecretsManager({"cf-prod/platforms/youtube/token": "t", "cf-prod/platforms/instagram/app": "a"})
    sm.get_secret_value(SecretId="cf-prod/platforms/youtube/token")
    sm.get_secret_value(SecretId="cf-prod/platforms/instagram/app")
    sm.calls.append(("get", "cf-prod/platforms/youtube/app"))
    sm.calls.append(("put", "cf-prod/platforms/youtube/app"))
    assert secret_problems(sm) == [
        "get cf-prod/platforms/youtube/token",
        "get cf-prod/platforms/instagram/app",
        "put cf-prod/platforms/youtube/app",
    ]


# --- import scans (§45.32 #2) ---------------------------------------------------------------------------------

AI_MODULES = (
    "ai_config",
    "ai_resolve",
    "agents",
    "skills",
    "chat",
    "memory",
    "references",
    "onboarding",
    "usage",
    "provider_keys",
    "storage",
    "routes/ai",
    "model_defs",  # §45.34: the models the owner adds
    "retention",  # §45.34: keeping and clearing files
)
# Clip Factory's own model, skill, conversation and runtime code: never imported by the AI modules.
FORBIDDEN_FOR_AI = (
    "clipfactory_api.routes",
    "clipfactory_api.skill_prompt",
    "clipfactory_api.settings",
    "clipfactory_api.help",
    "clipfactory_api.ask",
    "clipfactory_api.learn",
    "clipfactory_api.agent_client",
    "clipfactory_api.flow_client",
    "clipfactory_api.oauth",
)


def _imports(path: Path) -> set[str]:
    rel = path.relative_to(SRC.parent).with_suffix("")
    package = list(rel.parts[:-1])
    out = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            out |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            base = package[: len(package) - (node.level - 1)] if node.level else []
            module = ".".join([*base, *(node.module.split(".") if node.module else [])])
            out.add(module)
            out |= {f"{module}.{a.name}" for a in node.names}
    return out


def test_no_lamo_stories_module_imports_clip_factorys_route_table() -> None:
    for path in sorted((SRC / "workspaces").rglob("*.py")):
        bad = [m for m in _imports(path) if m == "clipfactory_api.routes" or m.startswith("clipfactory_api.routes.")]
        assert bad == [], (path.name, bad)


def test_the_ai_modules_use_none_of_clip_factorys_ai() -> None:
    for name in AI_MODULES:
        path = SRC / "workspaces" / f"{name}.py"
        imported = _imports(path)
        bad = [m for m in imported if any(m == f or m.startswith(f + ".") for f in FORBIDDEN_FOR_AI)]
        assert bad == [], (name, bad)
        text = path.read_text()
        assert "config/models.json" not in text.replace("stories/config/models.json", "").replace(
            "Clip Factory's ``config/models.json``", ""
        ), name
        assert "load_builtins" not in text, name
        assert "cf_prod_clip_agent" not in text, name
        # only the pure SKILL.md and zip helpers of Clip Factory's skills module, never its built-in loader
        cf_skills = {m.rsplit(".", 1)[-1] for m in imported if m.startswith("clipfactory_api.skills.")}
        assert not cf_skills & {"load_builtins", "builtin_dir", "BuiltinSkill"}, name


def test_ws_secret_names_and_s3_keys_refuse_clip_factorys_namespaces() -> None:
    with pytest.raises(ValueError, match="Lamo Clips"):
        ws.workspace_pk(USER, "clips")
    with pytest.raises(ValueError, match="Lamo Clips"):
        ws.s3_prefix(USER, "clips")
    assert pk() == f"USER#{USER}#WS#stories"
