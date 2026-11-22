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

from lamostories_agent import models

from .common import TaskFailed, as_dict, log
from .services import Services

REFUSED = "The AI model said no to this request. Try other words."
# The model client's own exceptions (builder E's ``models.py``), known by name so this package needs no more than the
# ModelClient contract: each message is the owner's sentence, shown as it is and never retried.
OWNER_ERRORS = frozenset({"ModelUnavailable", "EffortUnavailable", "AgentOff", "ModelRefused", "UserFacingError"})
# The ones a different model could fix ("Pick another model").
MODEL_PROBLEMS = frozenset({"ModelUnavailable", "EffortUnavailable", "ModelRefused"})
# A run that was stopped or taken over (ours, or builder E's job fence): it passes through untouched.
STOPPED = frozenset({"Superseded", "JobSuperseded", "JobCanceled"})
RETRY = "Your last answer broke these rules. Answer again with the whole JSON and fix them: "

Check = Callable[[Any, bool], tuple[Any, list[str]]]


def named(e: BaseException, names: frozenset[str] | set[str] | tuple[str, ...]) -> bool:
    """True when ``e`` is (a subclass of) an exception class with one of these names."""
    return any(c.__name__ in names for c in type(e).__mro__)


def owner_sentence(e: BaseException) -> str | None:
    """The plain sentence an exception carries for the owner, if it is one of ours or the model client's."""
    if isinstance(e, TaskFailed) or named(e, OWNER_ERRORS):
        return str(e).strip() or None
    for name in ("owner_sentence", "sentence", "plain"):
        found = getattr(e, name, None)
        if isinstance(found, str) and found.strip():
            return found.strip()
    return None


def is_owner_error(e: BaseException) -> bool:
    return (
        isinstance(e, TaskFailed)
        or named(e, OWNER_ERRORS)
        or any(isinstance(getattr(e, n, None), str) for n in ("owner_sentence", "sentence", "plain"))
    )


def is_model_problem(e: BaseException) -> bool:
    return named(e, MODEL_PROBLEMS)


def user(*blocks: str | dict[str, Any]) -> dict[str, Any]:
    return {"role": "user", "content": [b if isinstance(b, dict) else {"text": b} for b in blocks if b]}


def assistant_turn(reply: models.Reply) -> dict[str, Any]:
    content = [dict(b) for b in (reply.content or []) if isinstance(b, dict)]
    if not content:
        content = [{"text": reply.text or "(no answer)"}]
    return {"role": "assistant", "content": content}


def retry_turn(reply: models.Reply, problems: Sequence[str]) -> dict[str, Any]:
    """The owner-side turn that asks once more: a ``toolResult`` (an error) for every tool call of the answer, which
    Converse requires after an assistant ``toolUse``, else the problems as text."""
    text = RETRY + "; ".join(list(problems)[:10])
    uses = [b["toolUse"] for b in reply.content or [] if isinstance(b, dict) and isinstance(b.get("toolUse"), dict)]
    results = [
        {"toolResult": {"toolUseId": str(u["toolUseId"]), "content": [{"text": text}], "status": "error"}}
        for u in uses
        if u.get("toolUseId")
    ]
    return {"role": "user", "content": results or [{"text": text}]}


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
    """One checked structured answer through the model client (see ``ask_checked``)."""

    def send(msgs: list[dict[str, Any]]) -> models.Reply:
        return svc.model.complete(
            ctx, task=task, messages=msgs, override=override, schema=schema, max_tokens=max_tokens
        )

    return ask_checked(send, task=task, messages=messages, check=check, failure=failure)


def ask_checked(
    send: Callable[[list[dict[str, Any]]], models.Reply],
    *,
    task: str,
    messages: Sequence[dict[str, Any]],
    check: Check,
    failure: str,
) -> tuple[Any, models.Reply]:
    """The checked value and the reply it came from. ``send(messages)`` makes the call; ``check(parsed, final)``
    returns ``(value, problems)``: the value is taken when there are no problems, or on the second try when it is not
    ``None``. Otherwise ``failure``.

    The client's own sentences (a model that can't be used, a refusal, an agent switched off) stop the work as they
    are, and so does a run that was stopped. Anything else the client raises (it already retried what was temporary,
    and already asked once more for an answer that broke the schema) fails with ``failure``, the cause kept for the
    caller. Only code's own checks (lengths, the catalog, the guidance match) ask once more here."""
    msgs = list(messages)
    for attempt in range(2):
        final = attempt == 1
        try:
            reply = send(msgs)
        except Exception as e:
            if is_owner_error(e) or named(e, STOPPED):
                raise
            log("warning", "stories.model_call_failed", task=task, attempt=attempt + 1, error=type(e).__name__)
            raise TaskFailed(failure) from e
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
            msgs = [*msgs, assistant_turn(reply), retry_turn(reply, problems)]
    raise TaskFailed(failure)
