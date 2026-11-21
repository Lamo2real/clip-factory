"""Lamo Stories' AI configuration: default model and effort, per-task choices, prices, model status and Check models
(docs/CONTRACTS.md §45.3 ``AICONFIG``, ``MODELSTATUS#``, ``TASK#``; §45.5; §45.6; §45.25; ADR-77).

The configuration is the item ``AICONFIG`` of the workspace partition, made by the first PUT with a conditional put
and updated only on its ``version``; until then the defaults of ``stories/config/models.json`` apply. Everything is
validated against that file (never Clip Factory's ``config/models.json``): an unknown model, an effort the model does
not offer or an unknown task is a 400 with the owner's sentence. ``MODELSTATUS#`` items are written only by Lamo
Stories' agent after a real call; a model is never shown as available because it is listed. **Check models** writes a
``TASK#`` of kind ``check_models`` and asks Lamo Stories' own runtime (never Clip Factory's) to make one tiny call per
model.

``configSavedAt`` is set only by a save of the configuration itself (PUT ``…/ai``), never by a price alone, so the
setup's steps 1–3 (§45.33) tick only when the owner really saved his AI settings.

The runtime helpers at the end (``runtime``, ``new_session``, ``stop_quietly``, ``stops_last``) are shared by the chat
and the reference analysis; they reach Lamo Stories' runtime only through ``workspaces.deps.of(app).agent``. A
best-effort stop (the item's new ``sessionId`` already fences the old run) is made once, and only while one more call
still ends inside the request's 29 s; a route that starts work makes its stops after the start (``stops_last``).
"""

from __future__ import annotations

import contextlib
import math
import re
import time
from collections.abc import Iterator, Mapping
from contextvars import ContextVar
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import ApiError, bad_request, conflict
from ..ids import random_suffix, ulid
from ..log import log
from . import ai_resolve as res
from . import deps, guard
from . import types as ws

# Provider ids (§45.6 says prices are "by model key or provider id"), refused for now: ``Price`` is per million
# tokens and has no per-picture or per-second field, so a typed provider price could never be applied (contractIssues).
PRICE_PROVIDERS: Final = ("nova-canvas", "nova-reel")
NO_PROVIDER_PRICE: Final = "Prices can be typed for AI models only. Video and picture makers have no price to type yet."
CURRENCY: Final = re.compile(r"^[A-Z]{3}$")
MAX_PRICE: Final = 100_000.0
STALE: Final = "Your AI settings were changed somewhere else. Load them again, then save."
MODEL_STATUSES: Final = ("ok", "not_checked", "denied", "not_found", "error")
STATUS_LINE: Final = {
    "not_checked": "Not checked yet. Tap Check models to try it.",
    "ok": "It answered on its last call.",
    "denied": "Amazon Bedrock refused this model for this account.",
    "not_found": "Amazon Bedrock could not find this model.",
    "error": "Its last call failed. Try again, or pick another model.",
}
OWNER_PRICE_NOTE: Final = "Your own price."
TASK_TTL_DAYS: Final = 30
NOT_ON: Final = "Lamo Stories' AI helper isn't switched on yet."
TASK_DID_NOT_START: Final = "The helper did not start. Tap Try again."


# --- shared item helpers --------------------------------------------------------------------------------------


def pk(user_id: str, workspace_id: str) -> str:
    return ws.workspace_pk(user_id, workspace_id)


def get_owned(store: db.Store, user_id: str, workspace_id: str, sk: str) -> dict[str, Any] | None:
    """The item at ``sk`` of the caller's workspace partition, only when its own ``userId`` and ``workspaceId`` agree
    (the second, independent ownership check of §45.3)."""
    item = store.get(pk(user_id, workspace_id), sk)
    return item if guard.owned(item, user_id, workspace_id) else None


def query_owned(store: db.Store, user_id: str, workspace_id: str, prefix: str, **kw: Any) -> list[dict[str, Any]]:
    items = store.query_all(pk(user_id, workspace_id), prefix, consistent=True, **kw)
    return [i for i in items if guard.owned(i, user_id, workspace_id)]


def base_item(user_id: str, workspace_id: str, sk: str, type_: str) -> dict[str, Any]:
    return {"pk": pk(user_id, workspace_id), "sk": sk, "type": type_, "userId": user_id, "workspaceId": workspace_id}


def ttl_after(now: datetime, days: int) -> int:
    return int(now.timestamp()) + days * 86400


def number(value: Any, field: str, *, lo: float = 0.0, hi: float = MAX_PRICE) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)):
        raise bad_request(f"{field} must be a number.")
    if not lo <= float(value) <= hi:
        raise bad_request(f"{field} must be between {lo:g} and {hi:g}.")
    return float(value)


def optional_model(value: Any, field: str = "model") -> str | None:
    """``None``/``""`` (the level below decides) or a key of ``stories/config/models.json``."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise bad_request(f"{field} must be text.")
    if res.model(value) is None:
        raise bad_request(res.unknown_model(value), field)
    return value


def optional_effort(value: Any, field: str = "effort") -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in res.EFFORTS:
        raise bad_request(res.unknown_effort(str(value)), field)
    return value


def clean_override(value: Any) -> dict[str, str] | None:
    """A ``ModelOverride`` (``{model?, effort?}``): just for this request, never saved as a setting (§45.25)."""
    if value is None:
        return None
    body = validate.obj(value, "override")
    validate.only_keys(body, ("model", "effort"))
    out: dict[str, str] = {}
    model = optional_model(body.get("model"), "override")
    effort = optional_effort(body.get("effort"), "override")
    if model:
        out["model"] = model
    if effort:
        out["effort"] = effort
    return out or None


def clean_setting(value: Any, field: str = "ai") -> dict[str, str | None]:
    """A project's own setting (``{model, effort}``, each null for "default"), as kept on a story or a reference."""
    body = validate.obj(value, field)
    validate.only_keys(body, ("model", "effort"))
    model = optional_model(body.get("model"), field)
    effort = optional_effort(body.get("effort"), field)
    if model and effort:
        try:
            res.check_effort_for(model, effort)
        except res.ResolveError as e:
            raise bad_request(e.message, field) from e
    return {"model": model, "effort": effort}


# --- the AI configuration -------------------------------------------------------------------------------------


def defaults() -> dict[str, Any]:
    return {"defaultModel": res.default_model(), "defaultEffort": res.default_effort(), "tasks": {}, "prices": {}}


def read(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any] | None:
    return get_owned(store, user_id, workspace_id, ws.AICONFIG_SK)


def saved(store: db.Store, user_id: str, workspace_id: str) -> bool:
    """Whether the owner saved his AI configuration (PUT ``…/ai``); a price typed on its own does not count."""
    return bool((read(store, user_id, workspace_id) or {}).get("configSavedAt"))


def current(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any]:
    """The ``StoriesAiConfig`` in use: the saved item, or the file's defaults with ``version`` 0 (nothing saved)."""
    item = read(store, user_id, workspace_id)
    return public(item)


def public(item: Mapping[str, Any] | None) -> dict[str, Any]:
    base = defaults()
    if not item:
        return {**base, "version": 0}
    tasks = item.get("tasks") if isinstance(item.get("tasks"), Mapping) else {}
    prices = item.get("prices") if isinstance(item.get("prices"), Mapping) else {}
    return {
        "defaultModel": str(item.get("defaultModel") or base["defaultModel"]),
        "defaultEffort": str(item.get("defaultEffort") or base["defaultEffort"]),
        "tasks": {
            k: {f: v[f] for f in ("model", "effort") if isinstance(v, Mapping) and v.get(f)}
            for k, v in (tasks or {}).items()
            if k in res.TASK_KINDS
        },
        "prices": {str(k): public_price(v) for k, v in (prices or {}).items() if isinstance(v, Mapping)},
        "version": int(item.get("version") or 0),
    }


def public_price(value: Mapping[str, Any]) -> dict[str, Any]:
    long_context = value.get("longContext") if isinstance(value.get("longContext"), Mapping) else None
    return {
        "inputPer1M": float(value.get("inputPer1M") or 0),
        "outputPer1M": float(value.get("outputPer1M") or 0),
        "cacheReadPer1M": _num_or_none(value.get("cacheReadPer1M")),
        "cacheWritePer1M": _num_or_none(value.get("cacheWritePer1M")),
        "longContext": (
            {
                "aboveInputTokens": int(long_context.get("aboveInputTokens") or 0),
                "inputPer1M": float(long_context.get("inputPer1M") or 0),
                "outputPer1M": float(long_context.get("outputPer1M") or 0),
            }
            if long_context
            else None
        ),
        "currency": str(value.get("currency") or "USD"),
        "source": str(value.get("source") or "owner"),
        "note": str(value.get("note") or ""),
    }


def _num_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def clean_price(value: Any, field: str = "price", *, short: bool = False) -> dict[str, Any]:
    """The owner's ``Price`` (source ``owner``). ``short``: only ``{inputPer1M, outputPer1M, currency}`` (the price
    route's body)."""
    body = validate.obj(value, field)
    if short:
        validate.only_keys(body, ("inputPer1M", "outputPer1M", "currency"))
    else:
        validate.only_keys(
            body,
            (
                "inputPer1M",
                "outputPer1M",
                "cacheReadPer1M",
                "cacheWritePer1M",
                "longContext",
                "currency",
                "source",
                "note",
            ),
        )
    price: dict[str, Any] = {
        "inputPer1M": number(body.get("inputPer1M"), "inputPer1M"),
        "outputPer1M": number(body.get("outputPer1M"), "outputPer1M"),
        "cacheReadPer1M": None,
        "cacheWritePer1M": None,
        "longContext": None,
        "currency": _currency(body.get("currency")),
        "source": "owner",
        "note": OWNER_PRICE_NOTE,
    }
    for name in ("cacheReadPer1M", "cacheWritePer1M"):
        if body.get(name) is not None:
            price[name] = number(body.get(name), name)
    if body.get("longContext") is not None:
        lc = validate.obj(body.get("longContext"), "longContext")
        validate.only_keys(lc, ("aboveInputTokens", "inputPer1M", "outputPer1M"))
        price["longContext"] = {
            "aboveInputTokens": validate.integer(lc.get("aboveInputTokens"), "aboveInputTokens", lo=1, hi=10_000_000),
            "inputPer1M": number(lc.get("inputPer1M"), "longContext.inputPer1M"),
            "outputPer1M": number(lc.get("outputPer1M"), "longContext.outputPer1M"),
        }
    note = body.get("note")
    if note is not None:
        price["note"] = validate.string(body, "note", required=False, max_len=200) or OWNER_PRICE_NOTE
    return price


def _currency(value: Any) -> str:
    if not isinstance(value, str) or not CURRENCY.match(value.strip().upper()):
        raise bad_request("currency must be a three-letter code, for example USD or EUR.", "currency")
    return value.strip().upper()


def clean_config(
    body: Mapping[str, Any], current_ai: Mapping[str, Any], agents: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    """A PUT body (``StoriesAiConfig & {version}``) checked against ``stories/config/models.json``; missing
    ``tasks`` or ``prices`` keep the saved ones."""
    validate.only_keys(body, ("defaultModel", "defaultEffort", "tasks", "prices", "version"))
    version = validate.whole_number(body.get("version"))
    if version is None or version < 0:
        raise bad_request("version is required.", "version")
    default_model = optional_model(body.get("defaultModel"), "defaultModel")
    if default_model is None:
        raise bad_request("Pick a default model.", "defaultModel")
    default_effort = optional_effort(body.get("defaultEffort"), "defaultEffort")
    if default_effort is None:
        raise bad_request("Pick a default effort.", "defaultEffort")
    try:
        res.check_effort_for(default_model, default_effort)
    except res.ResolveError as e:
        raise bad_request(e.message, "defaultEffort") from e
    tasks: dict[str, dict[str, str]] = dict(current_ai.get("tasks") or {})
    if "tasks" in body:
        raw = validate.obj(body.get("tasks"), "tasks")
        tasks = {}
        for kind, cfg in raw.items():
            if kind not in res.TASK_KINDS:
                raise bad_request(f"There is no AI task called '{kind}'.", "tasks")
            if cfg is None:
                continue
            entry = validate.obj(cfg, f"tasks.{kind}")
            validate.only_keys(entry, ("model", "effort"))
            cleaned = {
                k: v
                for k, v in (
                    ("model", optional_model(entry.get("model"), f"tasks.{kind}")),
                    ("effort", optional_effort(entry.get("effort"), f"tasks.{kind}")),
                )
                if v
            }
            if cleaned:
                tasks[kind] = cleaned
    prices: dict[str, Any] = dict(current_ai.get("prices") or {})
    if "prices" in body:
        raw_prices = validate.obj(body.get("prices"), "prices")
        prices = {}
        for key, value in raw_prices.items():
            if key in PRICE_PROVIDERS:
                raise bad_request(NO_PROVIDER_PRICE, "prices")
            if res.model(key) is None:
                raise bad_request(f"There is no model called '{key}' to set a price for.", "prices")
            prices[key] = clean_price(value, f"prices.{key}")
    out = {
        "defaultModel": default_model,
        "defaultEffort": default_effort,
        "tasks": tasks,
        "prices": prices,
        "version": version,
    }
    for kind in res.TASK_KINDS:  # every task must still be usable with the new settings and its agent's own
        agent_id = res.agent_for_task(kind)
        try:
            res.resolve(task=kind, agent=agents.get(agent_id or ""), ai=out)
        except res.ResolveError as e:
            raise bad_request(f"{res.TASK_LABEL[kind]}: {e.message}", "tasks") from e
    return out


def save(store: db.Store, user_id: str, workspace_id: str, cleaned: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """Saves the configuration on its version: version 0 makes the item (a conditional put), any other updates it
    only while the stored version is the same. A stale version is a 409."""
    at = iso(now)
    version = int(cleaned["version"])
    fields = {k: cleaned[k] for k in ("defaultModel", "defaultEffort", "tasks", "prices")}
    if version == 0:
        item = {
            **base_item(user_id, workspace_id, ws.AICONFIG_SK, ws.TYPE_AICONFIG),
            **fields,
            "version": 1,
            "configSavedAt": at,
            "createdAt": at,
            "updatedAt": at,
        }
        try:
            store.put(item, if_absent=True)
        except db.ConditionFailed as e:
            raise conflict(STALE) from e
        return public(item)
    try:
        item = store.update_expr(
            pk(user_id, workspace_id),
            ws.AICONFIG_SK,
            "SET #dm = :dm, #de = :de, #t = :t, #p = :p, #u = :u, #cs = :u, #v = :nv",
            condition="attribute_exists(pk) AND #v = :v AND #uid = :uid AND #wid = :wid",
            names={
                "#dm": "defaultModel",
                "#de": "defaultEffort",
                "#t": "tasks",
                "#p": "prices",
                "#u": "updatedAt",
                "#cs": "configSavedAt",
                "#v": "version",
                "#uid": "userId",
                "#wid": "workspaceId",
            },
            values={
                ":dm": fields["defaultModel"],
                ":de": fields["defaultEffort"],
                ":t": fields["tasks"],
                ":p": fields["prices"],
                ":u": at,
                ":nv": version + 1,
                ":v": version,
                ":uid": user_id,
                ":wid": workspace_id,
            },
        )
    except db.ConditionFailed as e:
        raise conflict(STALE) from e
    return public(item)


def set_price(
    store: db.Store, user_id: str, workspace_id: str, key: str, price: dict[str, Any] | None, *, now: datetime
) -> dict[str, Any]:
    """Sets (or with ``None`` clears) the owner's price of one model; read, change, write on the version, a few times
    if another save wins meanwhile. A price alone makes the item with the file's defaults but no ``configSavedAt``."""
    at = iso(now)
    for _ in range(4):
        item = read(store, user_id, workspace_id)
        if item is None:
            prices = {key: price} if price else {}
            fresh = {
                **base_item(user_id, workspace_id, ws.AICONFIG_SK, ws.TYPE_AICONFIG),
                **defaults(),
                "prices": prices,
                "version": 1,
                "createdAt": at,
                "updatedAt": at,
            }
            try:
                store.put(fresh, if_absent=True)
            except db.ConditionFailed:
                continue
            return public(fresh)
        prices = dict(item.get("prices") or {})
        if price:
            prices[key] = price
        else:
            prices.pop(key, None)
        version = int(item.get("version") or 0)
        try:
            updated = store.update_expr(
                pk(user_id, workspace_id),
                ws.AICONFIG_SK,
                "SET #p = :p, #u = :u, #v = :nv",
                condition="attribute_exists(pk) AND #v = :v",
                names={"#p": "prices", "#u": "updatedAt", "#v": "version"},
                values={":p": prices, ":u": at, ":nv": version + 1, ":v": version},
            )
        except db.ConditionFailed:
            continue
        return public(updated)
    raise conflict(STALE)


# --- models, their status and price ---------------------------------------------------------------------------


def model_status_items(store: db.Store, user_id: str, workspace_id: str) -> dict[str, dict[str, Any]]:
    items = query_owned(store, user_id, workspace_id, ws.MODELSTATUS_SK)
    return {str(i["sk"])[len(ws.MODELSTATUS_SK) :]: i for i in items}


def model_info(m: Mapping[str, Any], status: Mapping[str, Any] | None, ai: Mapping[str, Any]) -> dict[str, Any]:
    """``ModelInfo`` (§45.6): the owner's price beats the file's list price."""
    key = str(m.get("key"))
    owner_price = (ai.get("prices") or {}).get(key)
    listed = m.get("pricing") if isinstance(m.get("pricing"), Mapping) else None
    price = public_price(owner_price) if owner_price else (public_price(listed) if listed else None)
    state = str((status or {}).get("status") or "not_checked")
    if state not in MODEL_STATUSES:
        state = "error"
    checked = (status or {}).get("checkedAt")
    return {
        "key": key,
        "label": str(m.get("label") or key),
        "provider": str(m.get("provider") or ""),
        "modelId": str(m.get("modelId") or ""),
        "efforts": [str(e) for e in m.get("efforts") or [] if e in res.EFFORTS],
        "defaultEffort": str(m["defaultEffort"]) if m.get("defaultEffort") in res.EFFORTS else None,
        "vision": bool(m.get("vision")),
        "status": state,
        "statusLine": str((status or {}).get("line") or STATUS_LINE[state]),
        "checkedAt": str(checked) if isinstance(checked, str) and checked else None,
        "price": price,
    }


def model_infos(store: db.Store, user_id: str, workspace_id: str, ai: Mapping[str, Any]) -> list[dict[str, Any]]:
    statuses = model_status_items(store, user_id, workspace_id)
    return [model_info(m, statuses.get(str(m.get("key"))), ai) for m in res.models()]


def task_infos(ai: Mapping[str, Any], agents: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """``TaskInfo`` for every task, with its effective model and effort (precedence of §45.25)."""
    out = []
    for kind in res.TASK_KINDS:
        agent_id = res.agent_for_task(kind) or ""
        effective, _ = res.shown(task=kind, agent=agents.get(agent_id), ai=ai)
        out.append(
            {
                "kind": kind,
                "label": res.TASK_LABEL[kind],
                "agentId": agent_id,
                "suggestedEffort": res.SUGGESTED_EFFORT[kind],
                "effective": effective,
            }
        )
    return out


def effective_for(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    task: str,
    *,
    request: Mapping[str, Any] | None = None,
    conversation: Mapping[str, Any] | None = None,
    project: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The effective model and effort of one call of this workspace (raises ``ResolveError``)."""
    from . import agents as agents_mod

    agent_id = res.agent_for_task(task)
    agent = agents_mod.read(store, user_id, workspace_id, agent_id) if agent_id else None
    return res.resolve(
        task=task,
        agent=agent,
        ai=current(store, user_id, workspace_id),
        request=request,
        conversation=conversation,
        project=project,
    )


def story_effective_for(
    store: db.Store, user_id: str, workspace_id: str, story: Mapping[str, Any], task: str = "storyboard"
) -> dict[str, Any]:
    """The story's effective model and effort for one of its tasks (the story's ``ai`` is the project level), for the
    story routes to show (§45.25: the API returns the effective values on the story)."""
    from . import agents as agents_mod

    agents = agents_mod.read_all(store, user_id, workspace_id)
    effective, _ = res.story_effective(story, ai=current(store, user_id, workspace_id), agents=agents, task=task)
    return effective


# --- Check models (a TASK# for Lamo Stories' runtime) ---------------------------------------------------------


def public_task(item: Mapping[str, Any]) -> dict[str, Any]:
    """``AiTask`` (§45.6); ``sessionId``, ``heartbeatAt``, ``override`` and ``input`` stay inside."""
    out: dict[str, Any] = {
        "taskId": item.get("taskId"),
        "kind": item.get("kind"),
        "status": item.get("status") or "queued",
        "model": item.get("model"),
        "effort": item.get("effort"),
        "effortApplied": item.get("effortApplied") if isinstance(item.get("effortApplied"), bool) else None,
        "result": item.get("result") if isinstance(item.get("result"), Mapping) else None,
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }
    if item.get("error"):
        out["error"] = str(item["error"])
    return out


def clean_check_models(body: Mapping[str, Any]) -> list[str]:
    validate.only_keys(body, ("models",))
    raw = body.get("models")
    if raw is None:
        return [str(m["key"]) for m in res.models()]
    if not isinstance(raw, list) or not raw or len(raw) > len(res.models()):
        raise bad_request("models must be a list of the models to check.", "models")
    keys: list[str] = []
    for key in raw:
        if not isinstance(key, str) or res.model(key) is None:
            raise bad_request(res.unknown_model(str(key)), "models")
        if key not in keys:
            keys.append(key)
    return keys


def start_check_models(app: Any, user_id: str, workspace_id: str, keys: list[str], now: datetime) -> dict[str, Any]:
    """Writes the task (``queued``, its own ``sessionId`` and ``heartbeatAt``) and asks the runtime to run it; a
    runtime that is off or refuses fails the task at once with a plain sentence."""
    task_id = ulid()
    at = iso(now)
    session_id = new_session(task_id)
    item = {
        **base_item(user_id, workspace_id, f"{ws.TASK_SK}{task_id}", ws.TYPE_TASK),
        "taskId": task_id,
        "kind": "check_models",
        "status": "queued",
        "input": {"models": keys},
        "createdAt": at,
        "updatedAt": at,
        "sessionId": session_id,
        "heartbeatAt": at,
        "ttl": ttl_after(now, TASK_TTL_DAYS),
    }
    app.store.put(item, if_absent=True)
    agent = runtime(app)
    problem = NOT_ON if agent is None else None
    if agent is not None:
        try:
            agent.start_task(
                user_id=user_id, workspace_id=workspace_id, task_id=task_id, kind="check_models", session_id=session_id
            )
        except Exception as e:
            log("warning", "ws.check_models_not_started", error=type(e).__name__, taskId=task_id)
            problem = TASK_DID_NOT_START
    if problem is None:
        return public_task(item)
    return public_task(_fail_task(app.store, item, problem, now))


def _fail_task(store: db.Store, item: Mapping[str, Any], message: str, now: datetime) -> dict[str, Any]:
    try:
        return store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"status": "failed", "error": message, "updatedAt": iso(now)},
            expect_in={"status": ["queued"], "sessionId": [item["sessionId"]]},
        )
    except db.ConditionFailed:
        return store.get(str(item["pk"]), str(item["sk"])) or dict(item)


# --- Lamo Stories' runtime (never Clip Factory's) -------------------------------------------------------------

SESSION_PREFIX: Final = "cfstory-"


def runtime(app: Any) -> Any:
    """Lamo Stories' own runtime client (``workspaces.agent.StoryAgent``), or None while it is not switched on."""
    return deps.of(app).agent


def new_session(item_id: str) -> str:
    """``cfstory-{id}-{8 random}`` (43 characters for a ULID), the session of one task, turn or job (§45.5)."""
    session = f"{SESSION_PREFIX}{item_id}-{random_suffix(8)}"
    if len(session) < 33:
        raise ValueError("session id too short")
    return session


# One runtime call at worst (3 s connect + 20 s read, ``workspaces/agent.py``), the request's 29 s (API Gateway's and
# the Lambda's limit) and what a request still does after its last best-effort call: the same budget as builder A's
# ``agent.time_for_call``.
CALL_SECONDS: Final = 23.0
REQUEST_SECONDS: Final = 29.0
AFTER_CALL_SECONDS: Final = 2.0
_STARTED: ContextVar[float | None] = ContextVar("ws_ai_request_started", default=None)
_DEFERRED: ContextVar[list[str] | None] = ContextVar("ws_ai_deferred_stops", default=None)


def begin_request(started: float | None) -> None:
    """Called by every AI route on arrival with the request's ``time.monotonic()`` (``Request.started``)."""
    _STARTED.set(started)
    _DEFERRED.set(None)


def time_for_call(*, after: float = AFTER_CALL_SECONDS) -> bool:
    """Whether one more runtime call still ends inside the request's 29 s with ``after`` seconds to spare."""
    started = _STARTED.get()
    if started is None:
        return True
    return time.monotonic() - started + CALL_SECONDS + after <= REQUEST_SECONDS


def stop_quietly(app: Any, session_id: Any) -> None:
    """Best effort: the item's new ``sessionId`` already fences the old run, so a failed or skipped stop changes
    nothing. Inside ``stops_last`` it waits for the route's start; otherwise one try, only while there is time."""
    agent = runtime(app)
    if agent is None or not isinstance(session_id, str) or not session_id:
        return
    deferred = _DEFERRED.get()
    if deferred is not None:
        deferred.append(session_id)
        return
    _stop_now(agent, session_id)


def _stop_now(agent: Any, session_id: str) -> None:
    if not time_for_call():
        log("info", "ws.stop_skipped", reason="no_time")
        return
    with contextlib.suppress(Exception):
        agent.stop_session(session_id, attempts=1)


@contextlib.contextmanager
def stops_last(app: Any) -> Iterator[None]:
    """For a route that starts work on the runtime: the stops of runs it fences wait until its start is done (or
    refused), so a slow stop never eats the time the start needs."""
    if _DEFERRED.get() is not None:  # already inside one
        yield
        return
    token = _DEFERRED.set([])
    try:
        yield
    finally:
        sessions = _DEFERRED.get() or []
        _DEFERRED.reset(token)
        agent = runtime(app)
        for session_id in dict.fromkeys(sessions):
            if agent is not None:
                _stop_now(agent, session_id)


def require(condition: bool, status: int, code: str, message: str) -> None:
    if not condition:
        raise ApiError(status, code, message)
