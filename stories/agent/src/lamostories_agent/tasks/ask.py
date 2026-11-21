"""One structured model call, checked by code, asked once more when the answer breaks the rules (§45.7, §45.25).

Every call goes through builder E's ``ModelClient.complete``: it picks the owner's model and effort, adds the agent's
instructions, skills and memory as the system blocks, and records usage and model status. Callers here never pass a
model or a system prompt; the per-request override (``TASK#.override``, a message's ``requested``, a job's) is passed
as is. A model the owner picked that cannot be used stops the work with the client's own sentence: there is never a
retry on another model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Sequence
from typing import Any

from .. import models
from .common import TaskFailed, as_dict, log
from .services import Services

REFUSED = "The AI model said no to this request. Try other words."
OWNER_ERRORS: tuple[type[BaseException], ...] = (models.ModelUnavailable, models.EffortUnavailable)

Check = Callable[[Any, bool], tuple[Any, list[str]]]


def owner_sentence(e: BaseException) -> str | None:
    """The plain sentence an exception carries for the owner, if it is one of ours or the model client's."""
    if isinstance(e, TaskFailed | models.ModelUnavailable | models.EffortUnavailable):
        return str(e).strip() or None
    for name in ("owner_sentence", "sentence", "plain"):
        found = getattr(e, name, None)
        if isinstance(found, str) and found.strip():
            return found.strip()
    return None


def is_owner_error(e: BaseException) -> bool:
    return isinstance(e, OWNER_ERRORS) or any(
        isinstance(getattr(e, n, None), str) for n in ("owner_sentence", "sentence", "plain")
    )


def user(*blocks: str | dict[str, Any]) -> dict[str, Any]:
    return {"role": "user", "content": [b if isinstance(b, dict) else {"text": b} for b in blocks if b]}


def assistant_turn(reply: models.Reply) -> dict[str, Any]:
    content = [dict(b) for b in (reply.content or []) if isinstance(b, dict)]
    if not content:
        content = [{"text": reply.text or "(no answer)"}]
    return {"role": "assistant", "content": content}


def usage_of(reply: models.Reply) -> dict[str, int]:
    u = reply.usage or {}

    def pick(*names: str) -> int:
        for n in names:
            v = u.get(n)
            if isinstance(v, int | float):
                return int(v)
        return 0

    return {
        "input": pick("input", "inputTokens", "input_tokens"),
        "output": pick("output", "outputTokens", "output_tokens"),
    }


def tool_calls(reply: models.Reply) -> list[dict[str, Any]]:
    """``[{"id", "name", "input"}]`` from the reply's tool calls, or from its raw ``toolUse`` blocks."""
    out: list[dict[str, Any]] = []
    raw: list[Any] = list(reply.tool_calls or [])
    if not raw:
        raw = [b for b in reply.content or [] if isinstance(b, dict) and "toolUse" in b]
    for call in raw:
        if not isinstance(call, dict):
            continue
        body = as_dict(call.get("toolUse")) or call
        cid = body.get("toolUseId") or body.get("id")
        name = body.get("name")
        args = body.get("input")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {"_raw": args}
        if cid and name:
            out.append({"id": str(cid), "name": str(name), "input": args if isinstance(args, dict) else {}})
    return out


_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)


def reply_json(reply: models.Reply) -> Any:
    if reply.data is not None:
        return reply.data
    text = reply.text or ""
    m = _FENCE.match(text)
    return json.loads(m.group(1) if m else text)


def ask_json(
    svc: Services,
    ctx: models.CallContext,
    *,
    task: str,
    messages: Sequence[dict[str, Any]],
    schema: dict[str, Any],
    check: Check,
    override: dict[str, Any] | None,
    failure: str,
    max_tokens: int = 16000,
) -> tuple[Any, models.Reply]:
    """The checked value and the reply it came from. ``check(parsed, final)`` returns ``(value, problems)``: the value
    is taken when there are no problems, or on the second try when it is not ``None``. Otherwise ``failure``."""
    msgs = list(messages)
    last_error: BaseException | None = None
    for attempt in range(2):
        final = attempt == 1
        try:
            reply = svc.model.complete(
                ctx, task=task, messages=msgs, override=override, schema=schema, max_tokens=max_tokens
            )
        except Exception as e:
            if is_owner_error(e):
                raise
            log("warning", "stories.model_call_failed", task=task, attempt=attempt + 1, error=type(e).__name__)
            last_error = e
            continue
        if reply.stop_reason == "refusal":
            raise TaskFailed(REFUSED)
        try:
            parsed = reply_json(reply)
        except ValueError:
            problems = ["the answer was not the JSON asked for"]
            value = None
        else:
            value, problems = check(parsed, final)
        if value is not None and (not problems or final):
            return value, reply
        log("info", "stories.answer_rejected", task=task, attempt=attempt + 1, problems=len(problems))
        if not final:
            msgs = [
                *msgs,
                assistant_turn(reply),
                user(
                    "Your last answer broke these rules. Answer again with the whole JSON and fix them: "
                    + "; ".join(problems[:10])
                ),
            ]
    raise TaskFailed(failure) from last_error
