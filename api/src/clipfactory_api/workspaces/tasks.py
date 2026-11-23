"""AI tasks (``TASK#{taskId}``, docs/CONTRACTS.md §45.3, §45.5, §45.7, §45.9.1): AI work the API never does itself.

The API writes the task (``queued``, ``sessionId``, ``heartbeatAt = createdAt``, the owner's ``override`` for this
request only, ``ttl`` 30 days) and asks **Lamo Stories' own runtime** to do it (``run_task``, or ``check_models``); the
web polls ``GET …/tasks/{taskId}`` every second while it is ``queued`` or ``running``. The agent resolves the model and
effort (§45.25), heartbeats, and writes ``status``, ``model``, ``effort``, ``effortApplied``, ``result`` and ``error``,
every write conditional on the task's ``sessionId``; a task left without a heartbeat is failed by
``jobs.settle_task``.

What the agent reads from ``input`` (an internal attribute, by kind):

* ``brainstorm``: ``{count, topic?, category?}`` → ``result.drafts`` (IdeaInput[]);
* ``expand_idea``: ``{ideaId, durationSec}`` → ``result.concept`` (VideoConcept) and ``result.topicId`` (its pick of
  a guidance topic, or absent); the API puts the concept on the idea, does the topic match and returns
  ``result.idea``;
* ``variations``: ``{ideaId, count}`` → ``result.drafts`` (each with ``source: "variation"`` and ``parentIdeaId``);
* ``character_design``: ``{description?, referenceAssetId?, referenceKey?, referenceContentType?}`` (the picture, a
  ``design_ref`` or ``character_ref`` asset of this workspace, already checked) → ``result.character``
  (CharacterInput, a draft);
* ``captions``: ``{storyId, scriptVersion}`` → ``result.postCaptions`` (Captions, a draft the web saves through
  ``StoryPatch.postCaptions``) and ``result.storyId``;
* ``check_models`` (builder A2's route): ``{models?}``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso
from ..errors import ApiError
from ..ids import ulid
from ..log import log
from . import config, jobs, shapes
from . import types as ws
from .agent import new_session_id, time_for_call

KEEP: Final = timedelta(days=30)
KINDS: Final = (
    "chat",
    "brainstorm",
    "expand_idea",
    "variations",
    "storyboard",
    "scene_rewrite",
    "character_design",
    "reference_analysis",
    "fact_check",
    "final_review",
    "captions",
    "check_models",
)
STATUSES: Final = ("queued", "running", "done", "failed")

Item = dict[str, Any]


def task_sk(task_id: str) -> str:
    return f"{ws.TASK_SK}{task_id}"


def new_task(
    user_id: str,
    workspace_id: str,
    *,
    kind: str,
    task_input: Mapping[str, Any],
    override: Mapping[str, Any] | None,
    now: datetime,
) -> Item:
    if kind not in KINDS:
        raise ValueError(f"unknown task kind: {kind}")
    task_id = ulid()
    at = iso(now)
    item: Item = {
        "pk": ws.workspace_pk(user_id, workspace_id),
        "sk": task_sk(task_id),
        "type": ws.TYPE_TASK,
        "userId": user_id,
        "workspaceId": workspace_id,
        "taskId": task_id,
        "kind": kind,
        "status": "queued",
        "model": None,
        "effort": None,
        "effortApplied": None,
        "result": None,
        "input": {k: v for k, v in task_input.items() if v is not None},
        "sessionId": new_session_id(task_id),
        "heartbeatAt": at,
        "createdAt": at,
        "updatedAt": at,
        "ttl": int((now + KEEP).timestamp()),
    }
    if override:
        item["override"] = dict(override)
    agent = config.agent_for_task(kind)
    if agent is not None:
        item["agentId"] = str(agent.get("agentId"))
    return item


def public_task(item: Mapping[str, Any]) -> dict[str, Any]:
    """AiTask (§45.6): the internal ``input``, ``override``, ``sessionId``, ``heartbeatAt`` and ``agentId`` stay in."""
    status = item.get("status")
    effort = item.get("effort")
    applied = item.get("effortApplied")
    result = item.get("result")
    out: dict[str, Any] = {
        "taskId": str(item["taskId"]),
        "kind": str(item.get("kind") or ""),
        "status": status if status in STATUSES else "queued",
        "model": item.get("model") if isinstance(item.get("model"), str) else None,
        "effort": effort if effort in config.EFFORTS else None,
        "effortApplied": applied if isinstance(applied, bool) else None,
        **shapes.call_record(item),  # what the call really used (§45.35 D5)
        "result": dict(result) if isinstance(result, Mapping) else None,
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }
    if item.get("error"):
        out["error"] = str(item["error"])
    return out


def switched_off(store: db.Store, user_id: str, workspace_id: str, kind: str) -> str | None:
    """ "{Agent} is switched off. …" when the owner switched off the agent that does this kind (§45.26), else None.
    An agent that was never saved (``AGENT#`` is made on first use) is on."""
    agent = config.agent_for_task(kind)
    if agent is None:
        return None
    agent_id = str(agent.get("agentId"))
    found = store.get(ws.workspace_pk(user_id, workspace_id), f"{ws.AGENT_SK}{agent_id}")
    if found is None or found.get("userId") != user_id or found.get("workspaceId") != workspace_id:
        return None
    if found.get("active") is False:
        name = str(found.get("name") or agent.get("name") or agent_id)
        return f"{name} is switched off. Switch it on in Funded Clips › Settings › Agents."
    return None


def start(
    store: db.Store,
    agent: Any,
    task: Item,
    now: datetime,
    *,
    started: float | None = None,
    stop: Callable[[str], None] | None = None,
) -> Item:
    """Writes the task and asks Lamo Stories' runtime to do it. A refused or impossible start fails the task at once
    with a plain sentence (and ends a session the refusal may have opened, while the request still has time)."""
    store.put(task, if_absent=True)
    if agent is None or not getattr(agent, "ready", False):
        return jobs.fail_task_start(store, task, now, jobs.TASK_NOT_SET_UP)
    try:
        agent.start_task(
            user_id=str(task["userId"]),
            workspace_id=str(task["workspaceId"]),
            task_id=str(task["taskId"]),
            kind=str(task["kind"]),
            session_id=str(task["sessionId"]),
        )
    except Exception as e:
        log("warning", "stories.task_start_failed", taskId=task.get("taskId"), error=type(e).__name__)
        session_id = str(task["sessionId"])
        failed = jobs.fail_task_start(store, task, now, jobs.TASK_NOT_STARTED)
        if time_for_call(started):  # one more call still ends inside the request's 29 s
            jobs.stop_quietly(stop, session_id)
        return failed
    return dict(task)


def refuse_if_off(store: db.Store, user_id: str, workspace_id: str, kind: str) -> None:
    sentence = switched_off(store, user_id, workspace_id, kind)
    if sentence:
        raise ApiError(409, "conflict", sentence)
