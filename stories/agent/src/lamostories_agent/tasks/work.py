"""``run_task`` and ``check_models``: one AI task from its ``TASK#`` item to its end (docs/CONTRACTS.md §45.6, §45.9.1).

The API writes the task (``queued``, its ``sessionId``, ``heartbeatAt``, the owner's per-request ``override`` and the
task's inputs) and invokes the agent. Here the task goes ``running``, its handler runs in a worker thread while the
event loop heartbeats every 20 s, and it ends ``done`` with ``result`` and the effective ``model``, ``effort`` and
``effortApplied``, or ``failed`` with one plain sentence. Every write is fenced on the task's session and a live
status, so a task the API's fence already failed, or that a newer run owns, is never written again. Writes the task
makes to other items (an idea's concept) go in the same transaction as its end.

The task's inputs are read from the item's ``input`` map (``topic``, ``category``, ``count``, ``ideaId``,
``durationSec``, ``description``, ``referenceAssetId``, ``storyId``, ``models``), and, for any of these names it does not
carry, from the item's top level.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .. import models
from .ask import owner_sentence
from .common import Superseded, TaskFailed, log, now_iso, owned, ws_pk
from .fence import TASK_LIVE, Fence, run_with_heartbeat
from .services import Services

INPUT_KEYS = (
    "topic",
    "category",
    "count",
    "ideaId",
    "durationSec",
    "description",
    "referenceAssetId",
    "storyId",
    "models",
)
KIND_AGENT = {
    "brainstorm": "creative_director",
    "expand_idea": "creative_director",
    "variations": "creative_director",
    "character_design": "character",
    "captions": "storyboard",
    "check_models": "creative_director",
}
FAILURE = {
    "brainstorm": "The idea helper could not finish. Tap Try again.",
    "expand_idea": "The idea helper could not finish. Tap Try again.",
    "variations": "The idea helper could not finish. Tap Try again.",
    "character_design": "The character helper could not finish. Tap Try again.",
    "captions": "The caption helper could not finish. Tap Try again.",
    "check_models": "Checking the models did not finish. Tap Try again.",
}
UNKNOWN_KIND = "Lamo Stories' agent does not know that kind of AI work yet."


@dataclass
class TaskEnv:
    svc: Services
    ctx: models.CallContext
    user_id: str
    workspace_id: str
    pk: str
    item: dict[str, Any]
    input: dict[str, Any]
    override: dict[str, Any] | None
    fence: Fence


@dataclass
class Outcome:
    result: dict[str, Any]
    reply: models.Reply | None = None  # the effective model, effort and effortApplied come from it
    ops: list[tuple[str, str, str, Any]] = field(default_factory=list)  # written with the task's end
    model: str | None = None  # when there is no single reply (check_models)
    effort: str | None = None
    effort_applied: bool | None = None


Handler = Callable[[TaskEnv], Outcome]


def task_input(item: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in INPUT_KEYS:
        if key in item:
            out[key] = item[key]
    for name in ("input", "params", "request"):
        found = item.get(name)
        if isinstance(found, dict):
            out.update(found)
    return out


def override_of(value: Any) -> dict[str, Any] | None:
    """A ``ModelOverride`` (model and/or effort) from the stored item; anything else is ignored."""
    if not isinstance(value, dict):
        return None
    out = {k: str(value[k]) for k in ("model", "effort") if isinstance(value.get(k), str) and value[k]}
    return out or None


def merge_override(first: Any, second: Any) -> dict[str, Any] | None:
    """Two levels of §45.25 as one override: ``first`` (the request's) over ``second`` (the conversation's or the
    project's), model and effort merged separately; the client's own levels (task, agent, default) come after."""
    a = override_of(first) or {}
    b = override_of(second) or {}
    out = {k: a.get(k) or b.get(k) for k in ("model", "effort") if a.get(k) or b.get(k)}
    return out or None


def agent_off(svc: Services, pk: str, agent_id: str) -> str | None:
    """The owner's sentence when the agent is switched off (§45.26), else None."""
    item = svc.store.get(pk, f"AGENT#{agent_id}")
    if item is not None and item.get("active") is False:
        name = str(item.get("name") or _agent_name(agent_id))
        return f"{name} is switched off. Switch it on in Lamo Stories › Settings › Agents."
    return None


def _agent_name(agent_id: str) -> str:
    from .. import config

    for a in config.agents().get("agents") or []:
        if a.get("agentId") == agent_id:
            return str(a.get("name") or agent_id)
    return agent_id


def handlers() -> dict[str, Handler]:
    from . import captions, check, design, ideas

    return {
        "brainstorm": ideas.brainstorm,
        "expand_idea": ideas.expand,
        "variations": ideas.variations,
        "character_design": design.character_design,
        "captions": captions.captions_again,
        "check_models": check.check_models,
    }


async def run_task(svc: Services, payload: dict[str, Any], *, kinds: tuple[str, ...] | None = None) -> str:
    """Runs one task to its end. Returns what happened (for logs and tests): done, failed, superseded or skipped."""
    user_id = str(payload.get("userId") or "")
    workspace_id = str(payload.get("workspaceId") or "")
    task_id = str(payload.get("taskId") or "")
    try:
        pk = ws_pk(user_id, workspace_id)
    except ValueError:
        log("warning", "stories.task_bad_payload", task=task_id)
        return "skipped"
    sk = f"TASK#{task_id}"
    item = await asyncio.to_thread(svc.store.get, pk, sk)
    if not item or not owned(item, user_id, workspace_id) or item.get("status") not in TASK_LIVE:
        log("info", "stories.task_not_live", task=task_id, status=(item or {}).get("status"))
        return "skipped"
    session_id = str(item.get("sessionId") or "")
    asked = payload.get("sessionId")
    if not session_id or (asked and asked != session_id):
        log("info", "stories.task_other_session", task=task_id)
        return "skipped"
    fence = Fence(svc.store, pk, sk, session_id, live=TASK_LIVE)
    kind = str(item.get("kind") or "")
    handler = handlers().get(kind)
    if handler is None or (kinds is not None and kind not in kinds):
        return await _fail(fence, UNKNOWN_KIND)
    agent_id = KIND_AGENT[kind]
    ctx = models.CallContext(user_id, workspace_id, agent_id, session_id, task_id=task_id)
    env = TaskEnv(svc, ctx, user_id, workspace_id, pk, item, task_input(item), override_of(item.get("override")), fence)
    try:
        off = None if kind == "check_models" else await asyncio.to_thread(agent_off, svc, pk, agent_id)
        if off:
            return await _fail(fence, off)
        at = now_iso()
        await asyncio.to_thread(fence.write, {"status": "running", "heartbeatAt": at, "updatedAt": at})
        outcome = await run_with_heartbeat(fence, svc.heartbeat_s, lambda: handler(env))
        await asyncio.to_thread(_finish, fence, outcome)
    except Superseded:
        log("info", "stories.task_superseded", task=task_id)
        return "superseded"
    except Exception as e:
        sentence = owner_sentence(e) or FAILURE.get(kind, UNKNOWN_KIND)
        if not isinstance(e, TaskFailed | models.ModelUnavailable | models.EffortUnavailable):
            log("error", "stories.task_crashed", task=task_id, kind=kind, error=type(e).__name__, detail=str(e))
        return await _fail(fence, sentence)
    log("info", "stories.task_done", task=task_id, kind=kind)
    return "done"


def _finish(fence: Fence, outcome: Outcome) -> None:
    reply = outcome.reply
    at = now_iso()
    fields: dict[str, Any] = {
        "status": "done",
        "result": outcome.result,
        "updatedAt": at,
        "heartbeatAt": at,
        "model": reply.model if reply else outcome.model,
        "effort": reply.effort if reply else outcome.effort,
        "effortApplied": reply.effort_applied if reply else outcome.effort_applied,
    }
    if outcome.ops:
        fence.transact([*outcome.ops, fence.update_op(fields)])
    else:
        fence.write(fields)


async def _fail(fence: Fence, sentence: str) -> str:
    at = now_iso()
    ok = await asyncio.to_thread(
        fence.try_write, {"status": "failed", "error": sentence, "updatedAt": at, "heartbeatAt": at}
    )
    return "failed" if ok else "superseded"
