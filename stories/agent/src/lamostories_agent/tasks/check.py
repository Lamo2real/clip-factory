"""**Check models** (Settings › AI): one tiny real call per model through the model client, and each model's
``MODELSTATUS#`` written with what happened (docs/CONTRACTS.md §45.25).

``ok`` on any answer, ``denied`` or ``not_found`` on the matching Bedrock refusal, ``error`` otherwise, each with one
plain line and ``checkedAt``. Each call names its model explicitly (a per-request override), so nothing is ever
checked on another model; the lowest effort the model offers keeps the call small.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from .. import config
from .ask import owner_sentence, usage_of, user
from .common import Superseded, clip, log, now_iso
from .store import Expr
from .work import Outcome, TaskEnv

OK_LINE = "It answered. Ready to use."
PROMPT = "This is an availability check from Lamo Stories. Reply with the one word: ok"


def _chain(e: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def classify(e: BaseException) -> str:
    """``denied``, ``not_found`` or ``error`` for a failed call (the client's own status wins when it gives one)."""
    for x in _chain(e):
        own = getattr(x, "status", None) or getattr(x, "kind", None)
        if own in ("denied", "not_found", "error"):
            return str(own)
        response = getattr(x, "response", None)
        error = (response or {}).get("Error") or {} if isinstance(response, dict) else {}
        code = str(error.get("Code") or "")
        message = str(error.get("Message") or "").lower()
        if code in ("AccessDeniedException", "UnrecognizedClientException", "AccessDenied"):
            return "denied"
        if code == "ResourceNotFoundException":
            return "not_found"
        if code == "ValidationException" and ("model identifier" in message or "not found" in message):
            return "not_found"
    text = " ".join(str(x) for x in _chain(e)).lower()
    if any(w in text for w in ("access", "not authorized", "denied", "opt-in", "opt in", "entitle")):
        return "denied"
    if any(w in text for w in ("not found", "invalid model", "model identifier", "isn't in", "is not in")):
        return "not_found"
    return "error"


def _line(status: str, e: BaseException, label: str) -> str:
    said = owner_sentence(e)
    if said:
        return clip(said, 300)
    if status == "denied":
        return f"Amazon Bedrock refused {label} for this account. Turn on access to it in the Bedrock console, or pick another model."
    if status == "not_found":
        return f"Amazon Bedrock could not find {label} in this Region. Pick another model."
    return f"{label} did not answer the check. Try again later."


def write_status(env: TaskEnv, key: str, status: str, line: str, at: str) -> None:
    env.svc.store.update(
        env.pk,
        f"MODELSTATUS#{key}",
        Expr().set(
            {
                "type": "ws_modelstatus",
                "userId": env.user_id,
                "workspaceId": env.workspace_id,
                "modelKey": key,
                "status": status,
                "line": line,
                "checkedAt": at,
            }
        ),
    )


def wanted(value: Any) -> list[str]:
    known = [str(m["key"]) for m in config.models()["models"]]
    if isinstance(value, list) and value:
        return [k for k in dict.fromkeys(str(v) for v in value) if k in known]
    return known


def check_models(env: TaskEnv) -> Outcome:
    results: list[dict[str, Any]] = []
    for key in wanted(env.input.get("models")):
        if env.fence.lost.is_set():
            raise Superseded(env.fence.sk)
        info = config.model(key) or {}
        label = str(info.get("label") or key)
        efforts = list(info.get("efforts") or [])
        override: dict[str, Any] = {"model": key}
        if efforts:
            override["effort"] = "low" if "low" in efforts else efforts[0]
        try:
            reply = env.svc.model.complete(
                env.ctx, task="check_models", messages=[user(PROMPT)], override=override, max_tokens=512
            )
            status, line = "ok", OK_LINE
            usage = usage_of(reply)
        except Exception as e:
            status = classify(e)
            line = _line(status, e, label)
            usage = {"input": 0, "output": 0}
            log("info", "stories.model_check_failed", model=key, status=status, error=type(e).__name__)
        at = now_iso()
        write_status(env, key, status, line, at)
        results.append({"key": key, "label": label, "status": status, "line": line, "checkedAt": at, "usage": usage})
    return Outcome({"models": results}, None, model=None, effort=None, effort_applied=None)
