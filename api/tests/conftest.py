from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db, s3
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.app import App
from clipfactory_api.async_invoke import AsyncInvoker
from clipfactory_api.flow_client import FlowClient
from clipfactory_api.http import dispatch
from clipfactory_api.ids import ulid
from clipfactory_api.oauth import DEFAULT_SCOPES, OAuthEnv
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.routes import ROUTES
from clipfactory_api.routes.setup import WebFiles
from clipfactory_api.skills import load_builtins
from clipfactory_api.vectors import Vectors
from fakes import (
    FakeAgentCore,
    FakeCloudFront,
    FakeEmbeddings,
    FakeHttp,
    FakeLambda,
    FakeS3,
    FakeS3Vectors,
    FakeSecretsManager,
    FakeTable,
)

USER = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
NOW = datetime(2026, 11, 15, 12, 0, 0, tzinfo=UTC)
JOB_FLOW_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-job-flow:live"
CLIP_FLOW_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-clip-flow:live"
STATS_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-stats"
LEARN_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-learn"
BUILTIN_MD = """---
name: "short-form-video-playbook"
description: Plan, script and hook short clips.
---

# Playbook
"""


APP_URL = "https://d111111abcdef8.cloudfront.net"
HOOKS_URL = "https://abc123.execute-api.eu-north-1.amazonaws.com/v1"
STATE_SECRET = "cf-prod/oauth/state-key"
STATE_KEY = "s" * 64


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def table() -> FakeTable:
    return FakeTable()


@pytest.fixture
def s3_client() -> FakeS3:
    return FakeS3()


@pytest.fixture
def agentcore() -> FakeAgentCore:
    return FakeAgentCore()


@pytest.fixture
def lambda_client() -> FakeLambda:
    return FakeLambda()


@pytest.fixture
def s3v() -> FakeS3Vectors:
    return FakeS3Vectors()


@pytest.fixture
def embeddings() -> FakeEmbeddings:
    return FakeEmbeddings()


@pytest.fixture
def vectors(s3v: FakeS3Vectors, embeddings: FakeEmbeddings) -> Vectors:
    return Vectors(s3v, embeddings, "cf-prod-vectors-123", "clips", "amazon.titan-embed-text-v2:0")


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def builtin_dir(tmp_path: Path) -> Path:
    root = tmp_path / "builtin"
    (root / "short-form-video-playbook").mkdir(parents=True)
    (root / "short-form-video-playbook" / "SKILL.md").write_text(BUILTIN_MD)
    return root


@pytest.fixture
def store(table: FakeTable) -> db.Store:
    return db.Store(table)


@pytest.fixture
def secrets_client() -> FakeSecretsManager:
    return FakeSecretsManager({STATE_SECRET: STATE_KEY})


@pytest.fixture
def http() -> FakeHttp:
    """The platform HTTP of the posting setup; tests queue answers with ``http.answers``."""
    return FakeHttp()


@pytest.fixture
def oauth_env(secrets_client: FakeSecretsManager, http: FakeHttp, clock: Clock) -> OAuthEnv:
    secrets = Secrets(secrets_client)
    return OAuthEnv(
        secrets=secrets,
        app_url=APP_URL,
        hooks_url=HOOKS_URL,
        state_key=lambda: secrets.read_text(STATE_SECRET).encode(),
        http=http,
        clock=clock,
        graph_version="v27.0",
        scopes=dict(DEFAULT_SCOPES),
    )


@pytest.fixture
def web_s3() -> FakeS3:
    return FakeS3()


@pytest.fixture
def cloudfront() -> FakeCloudFront:
    return FakeCloudFront()


@pytest.fixture
def app(
    store: db.Store,
    s3_client: FakeS3,
    agentcore: FakeAgentCore,
    lambda_client: FakeLambda,
    vectors: Vectors,
    clock: Clock,
    builtin_dir: Path,
    oauth_env: OAuthEnv,
    web_s3: FakeS3,
    cloudfront: FakeCloudFront,
) -> App:
    return App(
        store=store,
        media=s3.Media(s3_client, "cf-prod-media-123"),
        agent=AgentClient(agentcore, "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent"),
        flows=FlowClient(lambda_client, JOB_FLOW_ARN, CLIP_FLOW_ARN),
        vectors=vectors,
        invoker=AsyncInvoker(lambda_client, STATS_ARN, LEARN_ARN),
        version="abc123",
        clock=clock,
        email_lookup=lambda sub, token: "owner@example.com" if token else None,
        builtins=lambda: load_builtins(builtin_dir),
        oauth=oauth_env,
        web_files=WebFiles(web_s3, "cf-prod-web-123", cloudfront, "E1ABCDEF"),
    )


def make_event(
    method: str,
    path: str,
    body: Any = None,
    *,
    query: dict[str, str] | None = None,
    sub: str | None = USER,
    raw: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "version": "2.0",
        "rawPath": path,
        "headers": {"authorization": "Bearer token-abc", "content-type": "application/json"},
        "requestContext": {"http": {"method": method}, "requestId": "req-1", "stage": "$default"},
        "isBase64Encoded": False,
    }
    if sub:
        event["requestContext"]["authorizer"] = {"jwt": {"claims": {"sub": sub}}}
    if query:
        event["queryStringParameters"] = query
    if raw is not None:
        event["body"] = raw
    elif body is not None:
        event["body"] = json.dumps(body)
    return event


Call = Callable[..., tuple[int, Any]]


@pytest.fixture
def call(app: App) -> Call:
    def _call(method: str, path: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
        out = dispatch(make_event(method, path, body, **kw), app, ROUTES)
        return out["statusCode"], (json.loads(out["body"]) if out["body"] else None)

    return _call


def seed_job(store: db.Store, user: str = USER, **fields: Any) -> dict[str, Any]:
    job_id = fields.pop("jobId", None) or ulid()
    item = {
        "pk": db.user_pk(user),
        "sk": db.job_sk(job_id),
        "type": "job",
        "userId": user,
        "jobId": job_id,
        "status": "running",
        "source": {"type": "link", "platform": "youtube", "url": "https://youtube.com/watch?v=x"},
        "clipTarget": {"min": 5, "max": 10},
        "steps": [{"key": "resolve", "label": "Check the source", "status": "running"}],
        "progress": 0.1,
        "clipCount": 0,
        "createdAt": "2026-11-15T11:00:00.000Z",
        "updatedAt": "2026-11-15T11:00:00.000Z",
        "sessionId": f"cfjob-{job_id}-abcdefgh",
        "heartbeatAt": "2026-11-15T11:59:00.000Z",
        **fields,
    }
    store.put(item)
    return item


CAPTIONS = {
    "youtubeTitle": "He did WHAT",
    "youtubeDescription": "Full stream on the channel.",
    "instagram": "No way #gaming",
    "facebook": "Watch this",
    "tiktok": "wait for it",
    "x": "unreal",
}


def seed_clip(
    store: db.Store, s3_client: FakeS3 | None = None, user: str = USER, job_id: str | None = None, **fields: Any
) -> dict[str, Any]:
    clip_id = fields.pop("clipId", None) or ulid()
    job_id = job_id or ulid()
    rank = fields.get("rank", 1)
    video_key = f"jobs/{job_id}/clips/{clip_id}/clip.mp4"
    cover_key = f"jobs/{job_id}/clips/{clip_id}/cover.jpg"
    item = {
        "pk": db.user_pk(user),
        "sk": db.clip_sk(clip_id),
        "gsi1pk": f"JOB#{job_id}",
        "gsi1sk": f"CLIP#{rank:03d}",
        "type": "clip",
        "userId": user,
        "clipId": clip_id,
        "jobId": job_id,
        "rank": rank,
        "status": "review",
        "momentType": "rage",
        "hook": "He lost it",
        "summary": "A big moment.",
        "durationSec": 31.5,
        "sourceStart": 100.0,
        "sourceEnd": 131.5,
        "layout": "facecam_top",
        "captions": dict(CAPTIONS),
        "checklist": {"items": [{"key": "length", "label": "Length", "pass": True}], "fixes": []},
        "score": 8,
        "createdAt": "2026-11-15T11:30:00.000Z",
        "videoKey": video_key,
        "coverKey": cover_key,
        **fields,
    }
    store.put(item)
    if s3_client is not None:
        s3_client.objects[video_key] = b"mp4"
        s3_client.objects[cover_key] = b"jpg"
    return item
