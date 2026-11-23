"""**Check models** (Settings › AI): one tiny real call per model through the model client, and each model's
``MODELSTATUS#`` written with what happened (docs/CONTRACTS.md §45.25).

``ok`` on any answer, ``denied`` or ``not_found`` on the matching Bedrock refusal, ``error`` otherwise, each with one
plain line and ``checkedAt``. Each call names its model explicitly (a per-request override), so nothing is ever
checked on another model; the lowest effort the model offers and 512 output tokens keep the call small. The client
sends it bare (``task="check_models"``: no agent instructions, skills or memory) and writes no MODELSTATUS# of its
own: this check writes exactly one item per model, with the key attribute ``model`` (§45.34) and ``by: "check"``
(setup step 1 ticks from it, §45.35 D7; a later call's own status keeps it). The models the owner
added (``MODELDEF#``) are checked like the bundled ones. The check runs whichever agents are switched on (the
client's ``allow_inactive`` when it has one), and a failure that sent nothing to the model never changes a status.
Each check has the shape a real call to that model has (§45.35 D1): a model that takes tools gets one tiny tool with
automatic choice, streamed as the chat calls it, so a model Bedrock refuses tools for shows the client's sentence
("… does not accept tool use here …", §45.36 E6) instead of "Works".

The makers' models (picture, video and sound, §45.37 G2) are checked in the same task, with an access check that
costs nothing (``maker_check``): ``input.makers`` names the ones to check (maker model keys); with neither
``models`` nor ``makers`` every reasoning model and every maker model that has not ended is checked, and with only
``makers`` no reasoning model is called. Each writes one ``MAKERSTATUS#{key}`` (``by: "check"``).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from lamostories_agent import config, maker_check, models

from .ask import named, owner_sentence, usage_of, user
from .common import Superseded, TaskFailed, clip, log, now_iso
from .services import accepts
from .store import Expr
from .work import Outcome, TaskEnv

OK_LINE = "It answered. Ready to use."
NOT_SENT = "Checking the models did not finish. Tap Try again."
NOT_A_CALL = frozenset({"AgentOff", "EffortUnavailable", "TaskFailed"})
REFUSALS = frozenset({"ModelRefused"})
PROMPT = "This is an availability check from Clips Funded. Reply with the one word: ok"
# A model that takes tools is checked with one tiny tool (automatic choice), streamed as the chat calls it, so a model
# Bedrock refuses tools for (some only while streaming) shows that sentence here, never "Works" (§45.36 E6).
CHECK_TOOL = {
    "name": "say_ok",
    "description": "Not needed for this check: just reply with the word ok.",
    "input_schema": {"type": "object", "properties": {}},
}


def _quiet(_text: str) -> None:
    """The check streams like the chat, but nobody reads its text while it comes."""


def _chain(e: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def _bedrock_code(x: BaseException) -> str:
    response = getattr(x, "response", None)
    error = ((response or {}).get("Error") or {}) if isinstance(response, dict) else {}
    return str(error.get("Code") or "")


def model_answered(e: BaseException) -> bool:
    """True when the failure is what a real call to the model did: Bedrock's own error (or the client's sentence
    made from one), or the call's connection. False when nothing was sent (an agent switched off, a setting, a bug):
    then the model's status is left as it is. An effort Bedrock itself refused (``sent``) is a real call."""
    if any(getattr(x, "sent", False) is True for x in _chain(e)):
        return True
    if named(e, NOT_A_CALL):
        return False
    for x in _chain(e):
        if _bedrock_code(x) or getattr(x, "status", None) in ("denied", "not_found", "error"):
            return True
        if any(c.__module__.startswith(("botocore", "urllib3")) for c in type(x).__mro__ if c is not BaseException):
            return True
    return False


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
                "model": key,
                "status": status,
                "line": line,
                "checkedAt": at,
                "by": "check",  # written by Check models: what ticks setup step 1 (§45.35 D7)
            }
        ),
    )


def catalog_of(env: TaskEnv) -> dict[str, Any]:
    """The bundled models and the workspace's own (``MODELDEF#``), read for this check only (the same items, owned
    the same way, as the model client's ``Workspace.models()``)."""
    defs = [
        d
        for d in env.svc.store.query(env.pk, config.MODELDEF_PREFIX)
        if d.get("userId") in (None, env.user_id) and d.get("workspaceId") in (None, env.workspace_id)
    ]
    return config.merged_models(defs)


def wanted(value: Any, catalog: dict[str, Any] | None = None) -> list[str]:
    known = [str(m["key"]) for m in (catalog or config.models())["models"]]
    if isinstance(value, list) and value:
        return [k for k in dict.fromkeys(str(v) for v in value) if k in known]
    return known


def makers_of(env: TaskEnv) -> dict[str, list[dict[str, Any]]]:
    """The bundled makers' models and the workspace's own (``MAKERDEF#``), read for this check only."""
    defs = [
        d
        for d in env.svc.store.query(env.pk, config.MAKERDEF_PREFIX)
        if d.get("userId") in (None, env.user_id) and d.get("workspaceId") in (None, env.workspace_id)
    ]
    return config.merged_makers(defs)


def wanted_makers(value: Any, makers: dict[str, list[dict[str, Any]]], *, sweep: bool) -> list[dict[str, Any]]:
    """The maker models to check: the named ones (any of them, an ended one too: it reads ended), or with ``sweep``
    every one that has not ended."""
    every = [m for kind in config.MAKER_KINDS for m in makers.get(kind) or []]
    if isinstance(value, list) and value:
        names = list(dict.fromkeys(str(v) for v in value))
        return [m for name in names for m in every if m["key"] == name]
    return [m for m in every if not config.ended(m)] if sweep else []


def checker_of(env: TaskEnv) -> maker_check.MakerChecker:
    """The maker checker: the task services' own, else one from the shared services' clients."""
    found = getattr(env.svc, "maker_checker", None)
    if found is not None:
        return found
    try:
        from lamostories_agent import services as shared

        svc = shared.get()
        found = maker_check.MakerChecker(bedrock=svc.bedrock_control, polly=svc.polly, keys=svc.provider_keys,
                                         http=svc.http)  # fmt: skip
    except Exception as e:  # its own settings are missing: every maker check says so plainly
        log("error", "stories.maker_checker_missing", error=type(e).__name__)
        found = maker_check.MakerChecker()
    env.svc.maker_checker = found
    return found


def check_makers(env: TaskEnv, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each maker model once, with its access check (no cost); one ``MAKERSTATUS#`` per model."""
    if not entries:
        return []
    checker = checker_of(env)
    out: list[dict[str, Any]] = []
    for entry in entries:
        if env.fence.lost.is_set():
            raise Superseded(env.fence.sk)
        status, line = checker.check(env.workspace_id, entry)
        at = now_iso()
        item = maker_check.status_item(env.user_id, env.workspace_id, entry, status, line, at)
        env.svc.store.update(env.pk, item["sk"], Expr().set({k: v for k, v in item.items() if k not in ("pk", "sk")}))
        log("info", "stories.maker_checked", model=entry["key"], status=status)
        out.append({"key": entry["key"], "label": str(entry.get("label") or entry["key"]), "kind": entry.get("kind"),
                    "status": status, "line": line, "checkedAt": at})  # fmt: skip
    return out


def check_models(env: TaskEnv) -> Outcome:
    """Each model once. A failure that is not the model's (no call was made: the agent switched off, a setting) ends
    the whole task with its sentence and leaves every status as it was. The makers' models are checked after them,
    at no cost (§45.37 G2)."""
    client = env.svc.model
    extra: dict[str, Any] = {"allow_inactive": True} if accepts(client, "allow_inactive") else {}
    results: list[dict[str, Any]] = []
    catalog = catalog_of(env)
    asked_models, asked_makers = env.input.get("models"), env.input.get("makers")
    only_makers = isinstance(asked_makers, list) and bool(asked_makers) and not asked_models
    makers = wanted_makers(asked_makers, makers_of(env), sweep=not asked_models and not only_makers)
    for key in [] if only_makers else wanted(asked_models, catalog):
        if env.fence.lost.is_set():
            raise Superseded(env.fence.sk)
        info = config.model(key, catalog) or {}
        label = str(info.get("label") or key)
        efforts = list(info.get("efforts") or [])
        override: dict[str, Any] = {"model": key}
        if efforts:
            override["effort"] = "low" if "low" in efforts else efforts[0]
        shape: dict[str, Any] = dict(extra)
        if config.call_shape(info)[1]:  # the same shape a real call has: its tools, streamed like the chat (D1, E6)
            shape.update(tools=[CHECK_TOOL], on_text=_quiet)
        try:
            reply = client.complete(
                env.ctx, task=models.CHECK_TASK, messages=[user(PROMPT)], override=override, max_tokens=512, **shape
            )
            status, line = "ok", OK_LINE
            usage = usage_of(reply)
        except Exception as e:
            usage = {"input": 0, "output": 0}
            if named(e, REFUSALS):  # a refusal is an answer: the model is there and may be used
                status, line = "ok", OK_LINE
            elif not model_answered(e):
                log("warning", "stories.model_check_not_sent", model=key, error=type(e).__name__)
                raise TaskFailed(owner_sentence(e) or NOT_SENT) from e
            else:
                status = classify(e)
                line = _line(status, e, label)
                log("info", "stories.model_check_failed", model=key, status=status, error=type(e).__name__)
        at = now_iso()
        write_status(env, key, status, line, at)
        results.append({"key": key, "label": label, "status": status, "line": line, "checkedAt": at, "usage": usage})
    made = check_makers(env, makers)
    return Outcome({"models": results, "makers": made}, None, model=None, effort=None, effort_applied=None)
