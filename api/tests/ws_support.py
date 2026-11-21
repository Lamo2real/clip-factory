"""Shared helpers for the Lamo Stories core tests (docs/CONTRACTS.md §45.19). Offline only: the repo's fakes, no AWS.

``install`` puts the story agent (over ``FakeAgentCore``) and the download S3 client (``FakeS3``) on the app through
``workspaces.deps``; ``FakeModel`` answers the idea helper's Converse calls from a queue; the ``seed_*`` helpers write
items exactly as the API, the agent or the story flow would.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Iterable
from typing import Any

from clipfactory_api import db
from clipfactory_api.app import App, HelpDeps
from clipfactory_api.ids import ulid
from clipfactory_api.workspaces import deps, guard
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.agent import StoryAgent
from clipfactory_api.workspaces.expr import Update
from conftest import USER
from fakes import FakeAgentCore, FakeS3

WS = "stories"
BASE = f"/v1/workspaces/{WS}"
ARN = "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent"
BUCKET = "cf-prod-media-123"
HELP_MODEL = "eu.anthropic.claude-haiku-5-5"
AT = "2026-11-15T11:00:00.000Z"

LOOK: dict[str, Any] = {
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
VOICE: dict[str, Any] = {"style": "babble", "pitch": 1.2, "noises": ["gasp", "phew"], "sfx": ["boing"]}


def character_body(name: str = "Lamo", **extra: Any) -> dict[str, Any]:
    return {
        "name": name,
        "description": "A cheerful driver with a big red jacket.",
        "personality": "Curious, a bit clumsy, always learns.",
        "traits": ["curious", "clumsy"],
        "movementStyle": "bouncy",
        "expressions": ["neutral", "happy", "shocked", "relieved"],
        "look": copy.deepcopy(LOOK),
        "voice": copy.deepcopy(VOICE),
        **extra,
    }


def install(app: App, agentcore: FakeAgentCore | None, s3_client: FakeS3) -> deps.WsDeps:
    """The story agent over the fake AgentCore (None: making videos not switched on) and the download client."""
    agent = StoryAgent(agentcore, ARN) if agentcore is not None else None
    return deps.install(app, deps.WsDeps(agent=agent, s3=s3_client))


class FakeModel:
    """The idea helper's Bedrock client: Converse answers from a queue (text, or an exception to raise)."""

    def __init__(self, *answers: Any, stop_reason: str = "end_turn") -> None:
        self.answers = list(answers)
        self.stop_reason = stop_reason
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        assert self.answers, "the model was asked more often than the test expected"
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        text = answer if isinstance(answer, str) else json.dumps(answer)
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            "stopReason": self.stop_reason,
            "usage": {"inputTokens": 10, "outputTokens": 20},
        }

    def system_texts(self, n: int = -1) -> list[str]:
        return [b["text"] for b in self.calls[n]["system"] if "text" in b]

    def user_text(self, n: int = -1) -> str:
        return str(self.calls[n]["messages"][0]["content"][-1]["text"])


def use_model(app: App, model: FakeModel) -> FakeModel:
    app.help = HelpDeps(model_id=HELP_MODEL, bedrock=lambda: model)
    return model


# --- seeds ----------------------------------------------------------------------------------------------------


def pk(user: str = USER, workspace_id: str = WS) -> str:
    return ws.workspace_pk(user, workspace_id)


def prefix(user: str = USER, workspace_id: str = WS) -> str:
    return ws.s3_prefix(user, workspace_id)


def seed_workspace(store: db.Store, user: str = USER, workspace_id: str | None = None, name: str = "Lamo Cars") -> str:
    workspace_id = workspace_id or ulid()
    store.put(
        {
            "pk": ws.registry_pk(user),
            "sk": ws.workspace_sk(workspace_id),
            "type": ws.TYPE_WORKSPACE,
            "userId": user,
            "workspaceId": workspace_id,
            "workspaceName": name,
            "workspaceType": ws.STORIES,
            "configuration": guard.default_stories_config(),
            "version": 1,
            "createdAt": AT,
            "updatedAt": AT,
        }
    )
    return workspace_id


def seed_character(store: db.Store, user: str = USER, workspace_id: str = WS, **fields: Any) -> dict[str, Any]:
    character_id = fields.pop("characterId", None) or ulid()
    body = character_body(fields.pop("name", "Lamo"))
    item = {
        "pk": pk(user, workspace_id),
        "sk": f"{ws.CHAR_SK}{character_id}",
        "type": ws.TYPE_CHARACTER,
        "userId": user,
        "workspaceId": workspace_id,
        "characterId": character_id,
        **body,
        "references": [],
        "pendingRefs": {},
        "refsVersion": 0,
        "version": 1,
        "createdAt": AT,
        "updatedAt": AT,
        **fields,
    }
    store.put(item)
    return item


def seed_idea(store: db.Store, user: str = USER, workspace_id: str = WS, **fields: Any) -> dict[str, Any]:
    idea_id = fields.pop("ideaId", None) or ulid()
    item = {
        "pk": pk(user, workspace_id),
        "sk": f"{ws.IDEA_SK}{idea_id}",
        "type": ws.TYPE_IDEA,
        "userId": user,
        "workspaceId": workspace_id,
        "ideaId": idea_id,
        "title": "The kitchen dance",
        "logline": "Lamo dances while the toast burns.",
        "category": "comedy",
        "characterIds": [],
        "source": "manual",
        "status": "saved",
        "needsGuidance": False,
        "createdAt": AT,
        "updatedAt": AT,
        **fields,
    }
    store.put(item)
    return item


def script(scenes: int = 2, seconds: float = 6) -> dict[str, Any]:
    """A small story script (the shape of web/src/stories/engine/types.ts StoryScript)."""
    each = seconds / scenes
    return {
        "engine": 1,
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "durationSec": seconds,
        "title": "Ice test",
        "seed": 7,
        "cast": {"c1": {"characterId": "ch1", "name": "Lamo", "look": LOOK, "movementStyle": "bouncy", "voice": VOICE}},
        "scenes": [
            {
                "sceneId": f"s{n + 1}",
                "title": f"Scene {n + 1}",
                "durationSec": each,
                "set": "icy_road",
                "view": "side",
                "camera": "wide",
                "actors": [{"castId": "c1", "x": 0.5, "y": 0.7, "facing": "right"}],
                "props": [],
                "beats": [{"at": 0.5, "dur": 1, "who": "c1", "do": "gasp", "face": "shocked"}],
                "sfx": [{"id": f"s{n + 1}.fx0", "at": 0.5, "sfx": "skid", "volume": 0.8}],
                "caption": "Ease off the accelerator" if n == 0 else None,
                "note": None,
            }
            for n in range(scenes)
        ],
        "music": {"mood": "playful", "volume": 0.4},
        "captionsOn": True,
        "captions": [{"id": "cap1", "at": 0.5, "dur": 2, "text": "Ease off the accelerator"}],
        "safety": None,
    }


def story_key(story_id: str, name: str, user: str = USER, workspace_id: str = WS) -> str:
    return f"{prefix(user, workspace_id)}stories/{story_id}/{name}"


def seed_story(
    store: db.Store,
    s3_client: FakeS3 | None = None,
    user: str = USER,
    workspace_id: str = WS,
    *,
    made: bool = True,
    **fields: Any,
) -> dict[str, Any]:
    """A story; ``made`` gives it script v1, a final video, a cover and scene stills (as the agent leaves them)."""
    story_id = fields.pop("storyId", None) or ulid()
    item: dict[str, Any] = {
        "pk": pk(user, workspace_id),
        "sk": f"{ws.STORY_SK}{story_id}",
        "type": ws.TYPE_STORY,
        "userId": user,
        "workspaceId": workspace_id,
        "storyId": story_id,
        "contentType": "animation",
        "title": "Ice test",
        "status": "review",
        "category": "comedy",
        "characterIds": [],
        "durationSec": 45,
        "captionsOn": True,
        "musicMood": "playful",
        "postCaptions": {
            "youtubeTitle": "Ice!",
            "youtubeDescription": "",
            "instagram": "",
            "facebook": "",
            "tiktok": "",
            "x": "",
        },
        "scenes": [],
        "scriptVersion": 0,
        "stale": [],
        "posted": [],
        "version": 3,
        "createdAt": AT,
        "updatedAt": AT,
    }
    if made:
        the_script = script()
        item.update(
            {
                "scriptVersion": 1,
                "scriptKey": story_key(story_id, "script/v1.json", user, workspace_id),
                "videoKey": story_key(story_id, "final/v1.mp4", user, workspace_id),
                "coverKey": story_key(story_id, "final/cover-v1.jpg", user, workspace_id),
                "stillKeys": {
                    s["sceneId"]: story_key(story_id, f"scenes/{s['sceneId']}/still-v1.jpg", user, workspace_id)
                    for s in the_script["scenes"]
                },
                "scenes": [
                    {"sceneId": s["sceneId"], "title": s["title"], "durationSec": s["durationSec"]}
                    for s in the_script["scenes"]
                ],
                "actualDurationSec": 6,
                "safety": {
                    "topicId": None,
                    "status": "ok",
                    "problems": [],
                    "checkedScriptVersion": 1,
                    "citations": [],
                },
            }
        )
        if s3_client is not None:
            s3_client.objects[item["scriptKey"]] = json.dumps(the_script).encode()
            s3_client.objects[item["videoKey"]] = b"mp4"
            s3_client.objects[item["coverKey"]] = b"jpg"
    item.update(fields)
    store.put(item)
    return item


def seed_job(
    store: db.Store, story: dict[str, Any] | None = None, user: str = USER, workspace_id: str = WS, **fields: Any
) -> dict[str, Any]:
    job_id = fields.pop("jobId", None) or ulid()
    steps = [
        {"key": k, "label": k, "status": "pending"}
        for k in ("storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview")
    ]
    item = {
        "pk": pk(user, workspace_id),
        "sk": f"{ws.PJOB_SK}{job_id}",
        "type": ws.TYPE_PJOB,
        "userId": user,
        "workspaceId": workspace_id,
        "jobId": job_id,
        "contentType": "animation",
        "contentId": story["storyId"] if story else ulid(),
        "jobType": "produce",
        "status": "running",
        "steps": steps,
        "progress": 0,
        "configuration": {"run": [s["key"] for s in steps]},
        "meta": {},
        "sessionId": f"cfstory-{job_id}-abcdefgh",
        "heartbeatAt": "2026-11-15T11:59:00.000Z",
        "createdAt": AT,
        "updatedAt": AT,
        **fields,
    }
    store.put(item)
    return item


def seed_asset(
    store: db.Store,
    s3_client: FakeS3 | None = None,
    user: str = USER,
    workspace_id: str = WS,
    **fields: Any,
) -> dict[str, Any]:
    asset_id = fields.pop("assetId", None) or ulid()
    item = {
        "pk": pk(user, workspace_id),
        "sk": f"{ws.ASSET_SK}{asset_id}",
        "type": ws.TYPE_ASSET,
        "userId": user,
        "workspaceId": workspace_id,
        "assetId": asset_id,
        "kind": "final_video",
        "key": f"{prefix(user, workspace_id)}stories/x/final/v1.mp4",
        "contentType": "video/mp4",
        "bytes": 1234,
        "version": 1,
        "meta": {"current": 1},
        "createdAt": AT,
        **fields,
    }
    store.put(item)
    if s3_client is not None:
        s3_client.objects[item["key"]] = b"x"
    return item


def seed_item(
    store: db.Store, sk: str, item_type: str, user: str = USER, workspace_id: str = WS, **fields: Any
) -> dict[str, Any]:
    item = {"pk": pk(user, workspace_id), "sk": sk, "type": item_type, "userId": user, "workspaceId": workspace_id}
    item.update(fields)
    store.put(item)
    return item


def agent_step(
    store: db.Store,
    story_id: str,
    job_id: str,
    key: str,
    *,
    message: str | None = None,
    user: str = USER,
    workspace_id: str = WS,
    **story_set: Any,
) -> None:
    """What the agent writes when a step finishes (§45.9.1): the step's result on the story with the step taken out
    of ``stale`` (``version`` + 1, only while the story points at the job), then the step ``done`` on the job."""
    story = store.get(pk(user, workspace_id), f"{ws.STORY_SK}{story_id}")
    assert story is not None and story.get("currentJobId") == job_id
    sets = {**story_set, "stale": [s for s in story.get("stale") or [] if s != key], "updatedAt": AT}
    Update(str(story["pk"]), str(story["sk"]), sets=sets).bump().equals("currentJobId", job_id).run(store)
    job = store.get(pk(user, workspace_id), f"{ws.PJOB_SK}{job_id}")
    assert job is not None
    steps = [
        {**s, "status": "done", "finishedAt": AT, **({"message": message} if message else {})}
        if s["key"] == key
        else s
        for s in job["steps"]
    ]
    store.update(str(job["pk"]), str(job["sk"]), {"status": "running", "steps": steps})


def agent_end(
    store: db.Store,
    story_id: str,
    job_id: str,
    *,
    failed_at: str | None = None,
    user: str = USER,
    workspace_id: str = WS,
) -> None:
    """The agent's last write: ``review`` with the run's steps out of ``stale``, or ``failed`` at a step with it and
    every later step of the run added to ``stale``; ``currentJobId`` cleared."""
    story = store.get(pk(user, workspace_id), f"{ws.STORY_SK}{story_id}")
    job = store.get(pk(user, workspace_id), f"{ws.PJOB_SK}{job_id}")
    assert story is not None and job is not None and story.get("currentJobId") == job_id
    order = ["storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview"]
    run = list(job["configuration"]["run"])
    stale = list(story.get("stale") or [])
    if failed_at is None:
        sets: dict[str, Any] = {"status": "review", "stale": [s for s in stale if s not in run]}
        job_status = "ready"
        steps = [{**s, "status": "done"} if s["key"] in run else s for s in job["steps"]]
    else:
        later = [s for s in run if order.index(s) >= order.index(failed_at)]
        sets = {"status": "failed", "stale": [s for s in order if s in stale or s in later]}
        job_status = "failed"
        steps = [{**s, "status": "failed"} if s["key"] == failed_at else s for s in job["steps"]]
    update = Update(str(story["pk"]), str(story["sk"]), sets={**sets, "currentJobId": None, "updatedAt": AT})
    update.bump().equals("currentJobId", job_id).run(store)
    store.update(str(job["pk"]), str(job["sk"]), {"status": job_status, "steps": steps})


def presigned_keys(s3_client: FakeS3) -> list[str]:
    return [str(params["Key"]) for _, params, _ in s3_client.presigned]


def outside(keys: Iterable[str], user: str = USER, workspace_id: str = WS) -> list[str]:
    """Keys that are not files of this workspace (``ws/{user}/{ws}/``): must always be empty."""
    return [k for k in keys if not k.startswith(prefix(user, workspace_id))]


INTERNAL = ("scriptKey", "videoKey", "coverKey", "stillKeys", "sessionId", "heartbeatAt", "pendingRefs", "statusBefore")


def leaked(responses: Iterable[Any]) -> list[str]:
    """Internal attributes or bare S3 keys found in responses (each file is a presigned URL, never a raw key; a step's
    ``key`` is its step name, which is fine)."""
    found = []
    for body in responses:
        text = json.dumps(body)
        found += [f"field {name}" for name in INTERNAL if f'"{name}"' in text]
        found += ["a raw ws/ key"] if '"ws/' in text else []
        found += ["USER#"] if "USER#" in text else []
    return found
