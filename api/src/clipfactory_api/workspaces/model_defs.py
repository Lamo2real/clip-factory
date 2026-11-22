"""Reasoning models the owner adds himself, without a release (docs/CONTRACTS.md §45.34 "Adding models without a
release"; the owner's second request §3: "support adding new models and providers without rebuilding the
application").

Settings › AI › "Add a model": ``PUT /v1/workspaces/{ws}/ai/models/{key}`` with a ``ModelDef`` (a reasoning model on
Amazon Bedrock: who makes it, its Bedrock model id, inference profile id or ARN, its Region, the efforts it takes,
pictures or not, its longest answer and a price) → ``{ model: ModelInfo }``; ``DELETE`` → ``204``, or ``409`` naming
the setting while any saved setting still picks it. Stored as ``MODELDEF#{key}`` in the workspace partition only; the
API's resolver (``ai_resolve``, bound per request by ``guard.require_workspace``) and Lamo Stories' agent (per call)
merge them after ``stories/config/models.json``. A key matches ``^custom-[a-z0-9-]{1,40}$`` and never shadows a
bundled key; at most 20 per workspace. Adding a model never makes it look available: its ``ModelInfo.status`` is
``not_checked`` until Check models (or a real call) answers.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..log import log
from . import ai_config as cfg
from . import ai_resolve as res
from . import types as ws

KEY: Final = re.compile(r"^custom-[a-z0-9-]{1,40}$")
MAX_MODELS: Final = 20
LABEL_MAX: Final = 60
PROVIDER_MAX: Final = 40
MAX_OUTPUT: Final = 500_000
REGION: Final = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-[0-9]{1,2}$")
# A Bedrock model id (``anthropic.claude-…``, ``amazon.nova-pro-v1:0``) or a cross-Region inference profile id
# (``us.…``, ``eu.…``, ``global.…``).
MODEL_ID: Final = re.compile(r"^(?:[a-z][a-z-]{1,9}\.)?[a-z0-9]{2,30}\.[a-z0-9][a-z0-9.:_-]{0,127}$")
# A Bedrock ARN: a foundation model, an inference profile (system or application) or a provisioned or custom model.
ARN: Final = re.compile(
    r"^arn:aws(?:-[a-z]+)*:bedrock:[a-z]{2}(?:-gov)?-[a-z]+-[0-9]{1,2}:(?:[0-9]{12})?:"
    r"(?:foundation-model|inference-profile|application-inference-profile|provisioned-model|custom-model|"
    r"imported-model|custom-model-deployment)/[A-Za-z0-9][A-Za-z0-9.:_/-]{0,200}$"
)
FIELDS: Final = (
    "label",
    "provider",
    "modelId",
    "region",
    "efforts",
    "defaultEffort",
    "vision",
    "maxOutputTokens",
    "price",
)

NOT_FOUND: Final = "Lamo Stories has no added model with that name."
BAD_KEY: Final = "A model you add needs a name like custom-my-model (small letters, digits and dashes)."
TAKEN: Final = "Lamo Stories already has a model with that name. Pick another name."
TOO_MANY: Final = f"You can add at most {MAX_MODELS} models. Remove one first."
BUNDLED: Final = "That model comes with Lamo Stories, so it can't be removed."
BAD_MODEL_ID: Final = (
    "That is not a Bedrock model id. Paste the model id (like anthropic.claude-opus-5-5), the inference profile id "
    "(like global.anthropic.claude-opus-5-5) or its ARN from the Amazon Bedrock console."
)
BAD_REGION: Final = "Type the AWS Region code where the model runs, like us-east-1 or eu-north-1."


def model_sk(key: str) -> str:
    return f"{ws.MODELDEF_SK}{key}"


# --- reading (the resolver's loader) ----------------------------------------------------------------------------


def as_model(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A ``MODELDEF#`` item as a ``models.json`` entry (``custom: True``), or None when it is not a usable one."""
    key = item.get("key")
    model_id = item.get("modelId")
    region = item.get("region")
    if not isinstance(key, str) or not KEY.match(key) or not isinstance(model_id, str) or not isinstance(region, str):
        return None
    efforts = [str(e) for e in item.get("efforts") or [] if e in res.EFFORTS]
    default = item.get("defaultEffort") if item.get("defaultEffort") in efforts else None
    price = item.get("price") if isinstance(item.get("price"), Mapping) else None
    return {
        "key": key,
        "label": str(item.get("label") or key),
        "provider": str(item.get("provider") or ""),
        "modelId": model_id,
        "profile": model_id,
        "regions": [region],
        "region": region,
        "efforts": efforts,
        "defaultEffort": default,
        "vision": bool(item.get("vision")),
        "maxOutputTokens": int(item.get("maxOutputTokens") or 0) or None,
        "pricing": dict(price) if price else None,
        "custom": True,
    }


def items(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    return [
        i for i in cfg.query_owned(store, user_id, workspace_id, ws.MODELDEF_SK) if i.get("type") == ws.TYPE_MODELDEF
    ]


def load(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    """The workspace's added models, by key, each a ``models.json`` entry; a key the file has is never one."""
    bundled = res.bundled_keys()
    out = []
    for item in sorted(items(store, user_id, workspace_id), key=lambda i: str(i.get("key") or "")):
        found = as_model(item)
        if found is not None and found["key"] not in bundled:
            out.append(found)
    return out


def bind(store: db.Store, user_id: str, workspace_id: str) -> None:
    """This request is in this workspace: its added models join the resolver's list (read once, on first use)."""
    res.bind(user_id, workspace_id, lambda: load(store, user_id, workspace_id))


# --- checking a ModelDef ---------------------------------------------------------------------------------------


def clean_key(key: Any) -> str:
    if not isinstance(key, str) or not KEY.match(key):
        raise bad_request(BAD_KEY, "key")
    if key in res.bundled_keys():
        raise bad_request(TAKEN, "key")
    return key


def _text(body: Mapping[str, Any], name: str, limit: int, sentence: str) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not " ".join(value.split()):
        raise bad_request(sentence, name)
    text = " ".join(value.split())
    if len(text) > limit:
        raise bad_request(f"That is too long (at most {limit} characters).", name)
    return text


def clean_model_id(value: Any) -> str:
    if not isinstance(value, str):
        raise bad_request(BAD_MODEL_ID, "modelId")
    text = value.strip()
    if len(text) > 300 or not (MODEL_ID.match(text) or ARN.match(text)):
        raise bad_request(BAD_MODEL_ID, "modelId")
    return text


def clean_region(value: Any) -> str:
    if not isinstance(value, str) or not REGION.match(value.strip()):
        raise bad_request(BAD_REGION, "region")
    return value.strip()


def clean_efforts(value: Any) -> list[str]:
    """The efforts the model takes (may be empty: it runs at its own level), in the usual order, each once."""
    if not isinstance(value, list):
        raise bad_request("efforts must be a list of effort levels (it may be empty).", "efforts")
    for e in value:
        if e not in res.EFFORTS:
            raise bad_request(res.unknown_effort(str(e)), "efforts")
    return [e for e in res.EFFORTS if e in value]


def clean(body: Mapping[str, Any]) -> dict[str, Any]:
    """A ``ModelDef`` body, checked: every sentence is one the owner can act on."""
    validate.only_keys(body, FIELDS)
    efforts = clean_efforts(body.get("efforts"))
    default = body.get("defaultEffort")
    if default is not None and (default not in res.EFFORTS or default not in efforts):
        raise bad_request("Pick the model's own effort from the efforts it takes, or leave it empty.", "defaultEffort")
    vision = body.get("vision")
    if not isinstance(vision, bool):
        raise bad_request("Say whether the model can look at pictures.", "vision")
    price = body.get("price")
    return {
        "label": _text(body, "label", LABEL_MAX, "Give the model a name people can read."),
        "provider": _text(body, "provider", PROVIDER_MAX, "Say who makes the model, like Anthropic or Amazon."),
        "modelId": clean_model_id(body.get("modelId")),
        "region": clean_region(body.get("region")),
        "efforts": efforts,
        "defaultEffort": default,
        "vision": vision,
        "maxOutputTokens": validate.integer(body.get("maxOutputTokens"), "maxOutputTokens", lo=1, hi=MAX_OUTPUT),
        "price": cfg.clean_price(price, "price") if price is not None else None,
    }


# --- saving and removing ---------------------------------------------------------------------------------------


def _check_settings_still_work(store: db.Store, user_id: str, workspace_id: str, found: dict[str, Any]) -> None:
    """Changing a model that is picked somewhere must leave every saved setting usable (the same rules as saving
    it): an effort saved with it that it no longer takes, in a task, an agent, a chat, a video or a reference video,
    is refused now with that setting's name, not at the next save or the next call."""
    from . import agents as agents_mod

    key = str(found["key"])
    ai = cfg.current(store, user_id, workspace_id)
    agents = agents_mod.read_all(store, user_id, workspace_id)
    with res.overlay([found]):
        if ai.get("defaultModel") == key:
            try:
                res.check_effort_for(key, ai.get("defaultEffort"))
            except res.ResolveError as e:
                raise bad_request(_still_saved(e.message, USED_DEFAULT), "efforts") from e
        for place, setting in _settings(store, user_id, workspace_id, ai=ai, agents=agents):
            if setting.get("model") != key or not setting.get("effort"):
                continue
            try:
                res.check_pair(key, str(setting["effort"]))
            except res.ResolveError as e:
                raise bad_request(_still_saved(e.message, place), "efforts") from e
        for kind in res.TASK_KINDS:
            agent_id = res.agent_for_task(kind) or ""
            try:
                res.resolve(task=kind, agent=agents.get(agent_id), ai=ai)
            except res.ResolveError as e:
                raise bad_request(f"{res.TASK_LABEL[kind]}: {e.message}", "efforts") from e


def _still_saved(sentence: str, place: str) -> str:
    return f"{place[:1].upper()}{place[1:]}: {sentence}"


def put(
    store: db.Store, user_id: str, workspace_id: str, key: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """Adds or replaces one model; returns its ``ModelInfo``."""
    key = clean_key(key)
    fields = clean(body)
    existing = cfg.get_owned(store, user_id, workspace_id, model_sk(key))
    if existing is None and len(items(store, user_id, workspace_id)) >= MAX_MODELS:
        raise conflict(TOO_MANY)
    at = iso(now)
    item = {
        **cfg.base_item(user_id, workspace_id, model_sk(key), ws.TYPE_MODELDEF),
        "key": key,
        **fields,
        "createdAt": str((existing or {}).get("createdAt") or at),
        "updatedAt": at,
    }
    found = as_model(item)
    if found is None:  # unreachable: ``clean`` checked every field as_model reads
        raise bad_request(BAD_KEY, "key")
    if existing is not None:
        _check_settings_still_work(store, user_id, workspace_id, found)
    if existing is None:
        try:
            store.put(item, if_absent=True)
        except db.ConditionFailed as e:
            raise conflict("That model was added a moment ago somewhere else. Load the page again.") from e
    else:
        store.put_when(
            item,
            "#u = :u AND #w = :w",
            names={"#u": "userId", "#w": "workspaceId"},
            values={":u": user_id, ":w": workspace_id},
        )
    res.forget_custom()
    log("info", "ws.model_added" if existing is None else "ws.model_changed", key=key)
    ai = cfg.current(store, user_id, workspace_id)
    status = cfg.model_status_items(store, user_id, workspace_id).get(key)
    return cfg.model_info(found, status, ai)


USED_DEFAULT: Final = "the default model in Settings › AI"


def _settings(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    *,
    ai: Mapping[str, Any],
    agents: Mapping[str, Mapping[str, Any]],
) -> list[tuple[str, Mapping[str, Any]]]:
    """Every saved ``{model, effort}`` setting other than the default, in plain words: the tasks, the agents, the
    chats, the videos and the reference videos."""
    out: list[tuple[str, Mapping[str, Any]]] = []
    for kind, setting in (ai.get("tasks") or {}).items():
        if isinstance(setting, Mapping):
            out.append((f"the task “{res.TASK_LABEL.get(kind, kind)}” in Settings › AI", setting))
    for agent in agents.values():
        out.append((f"{agent.get('name') or agent.get('agentId')} in Settings › Agents", agent))
    for conv in cfg.query_owned(store, user_id, workspace_id, ws.CONV_SK):
        out.append((f"the chat “{conv.get('title') or ''}”", conv))
    for prefix, what in ((ws.STORY_SK, "the video"), (ws.REFVID_SK, "the reference video")):
        for found in cfg.query_owned(store, user_id, workspace_id, prefix):
            own = found.get("ai") if isinstance(found.get("ai"), Mapping) else {}
            out.append((f"{what} “{found.get('title') or ''}”", own or {}))
    return out


def _uses(store: db.Store, user_id: str, workspace_id: str, key: str) -> list[str]:
    """Every saved setting that picks ``key``, in plain words."""
    from . import agents as agents_mod

    ai = cfg.current(store, user_id, workspace_id)
    agents = agents_mod.read_all(store, user_id, workspace_id)
    out = [USED_DEFAULT] if ai.get("defaultModel") == key else []
    saved = _settings(store, user_id, workspace_id, ai=ai, agents=agents)
    return out + [place for place, setting in saved if setting.get("model") == key]


def delete(store: db.Store, user_id: str, workspace_id: str, key: str, *, now: datetime) -> None:
    """Removes an added model; ``409`` naming the setting while one still picks it. Its price and status go too."""
    if isinstance(key, str) and key in res.bundled_keys():
        raise conflict(BUNDLED)
    if not isinstance(key, str) or not KEY.match(key):
        raise not_found(NOT_FOUND)
    item = cfg.get_owned(store, user_id, workspace_id, model_sk(key))
    if item is None:
        raise not_found(NOT_FOUND)
    used = _uses(store, user_id, workspace_id, key)
    if used:
        label = str(item.get("label") or key)
        raise conflict(f"{label} is still picked for {used[0]}. Pick another model there first, then remove it.")
    owner = {"userId": [user_id], "workspaceId": [workspace_id]}
    if not store.delete_if(cfg.pk(user_id, workspace_id), model_sk(key), owner):
        raise not_found(NOT_FOUND)
    store.delete_if(cfg.pk(user_id, workspace_id), f"{ws.MODELSTATUS_SK}{key}", owner)
    if key in (cfg.current(store, user_id, workspace_id).get("prices") or {}):
        cfg.set_price(store, user_id, workspace_id, key, None, now=now)
    res.forget_custom()
    log("info", "ws.model_removed", key=key)
