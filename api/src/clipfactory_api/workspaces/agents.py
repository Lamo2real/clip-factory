"""Lamo Stories' five agents (docs/CONTRACTS.md §45.3 ``AGENT#``, §45.5, §45.6 ``Agent``, §45.26, ADR-78).

The built-ins come from ``stories/config/agents.json`` and are made in the workspace partition on first use (a
conditional put each, so two first uses at once make one); they are never deleted. The owner edits each agent's
instructions (**Reset** restores the file's), switches it on or off, and picks its model and effort (``null`` is the
workspace default) and its skills, in order. Clip Factory's agents and skills are separate and never read.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import ApiError, bad_request, conflict, not_found
from . import ai_config as cfg
from . import ai_resolve as res
from . import types as ws

INSTRUCTIONS_MAX: Final = 10_000
MAX_SKILLS: Final = 20
NOT_FOUND: Final = "We could not find that agent."
STALE: Final = "This agent was changed somewhere else. Load it again, then save."
PATCH_KEYS: Final = ("version", "instructions", "active", "model", "effort", "skillIds")


def agent_sk(agent_id: str) -> str:
    return f"{ws.AGENT_SK}{agent_id}"


def _new_item(user_id: str, workspace_id: str, default: Mapping[str, Any], at: str) -> dict[str, Any]:
    agent_id = str(default["agentId"])
    return {
        **cfg.base_item(user_id, workspace_id, agent_sk(agent_id), ws.TYPE_AGENT),
        "agentId": agent_id,
        "name": str(default.get("name") or agent_id),
        "tasks": [str(t) for t in default.get("tasks") or []],
        "instructions": str(default.get("instructions") or ""),
        "active": True,
        "skillIds": [str(s) for s in default.get("skills") or []],
        "version": 1,
        "createdAt": at,
        "updatedAt": at,
    }


def read_all(store: db.Store, user_id: str, workspace_id: str) -> dict[str, dict[str, Any]]:
    """The stored agents by id (no writes: those not made yet are left out)."""
    items = cfg.query_owned(store, user_id, workspace_id, ws.AGENT_SK)
    return {str(i.get("agentId")): i for i in items if i.get("agentId") in res.AGENT_IDS}


def read(store: db.Store, user_id: str, workspace_id: str, agent_id: str) -> dict[str, Any] | None:
    """One agent's stored item, or the file's built-in when it has not been made yet (None for an unknown id)."""
    if agent_id not in res.AGENT_IDS:
        return None
    item = cfg.get_owned(store, user_id, workspace_id, agent_sk(agent_id))
    if item:
        return item
    default = res.agent_default(agent_id)
    return _new_item(user_id, workspace_id, default, "") if default else None


def ensure(store: db.Store, user_id: str, workspace_id: str, now: datetime) -> dict[str, dict[str, Any]]:
    """Every built-in agent, made on first use; returns them by id in the file's order."""
    found = read_all(store, user_id, workspace_id)
    at = iso(now)
    for default in res.agent_defaults():
        agent_id = str(default.get("agentId"))
        if agent_id in found or agent_id not in res.AGENT_IDS:
            continue
        item = _new_item(user_id, workspace_id, default, at)
        with contextlib.suppress(db.ConditionFailed):  # made a moment ago by another request: use that one
            store.put(item, if_absent=True)
        stored = cfg.get_owned(store, user_id, workspace_id, agent_sk(agent_id))
        found[agent_id] = stored or item
    return {a: found[a] for a in res.AGENT_IDS if a in found}


def _words(text: Any) -> str:
    return " ".join(str(text or "").split())


def shown_instructions(stored: Any, default: Mapping[str, Any]) -> str:
    """The stored instructions, or the file's when they are an earlier default never edited (``formerInstructions``,
    as the agent reads them, §45.36 E5), such as the one that still said Lamo Stories. Nothing stored is rewritten."""
    text = str(stored or "")
    former = default.get("formerInstructions")
    if isinstance(former, list) and _words(text) in {_words(f) for f in former if isinstance(f, str)}:
        return str(default.get("instructions") or "")
    return text


def public(item: Mapping[str, Any]) -> dict[str, Any]:
    """``Agent`` (§45.6)."""
    agent_id = str(item.get("agentId"))
    default = res.agent_default(agent_id) or {}
    return {
        "agentId": agent_id,
        "name": str(default.get("name") or item.get("name") or agent_id),
        "tasks": [str(t) for t in default.get("tasks") or item.get("tasks") or []],
        "instructions": shown_instructions(item.get("instructions"), default),
        "defaultInstructions": str(default.get("instructions") or ""),
        "active": item.get("active") is not False,
        "model": item.get("model") or None,
        "effort": item.get("effort") or None,
        "skillIds": [str(s) for s in item.get("skillIds") or []],
        "version": int(item.get("version") or 0),
        "updatedAt": str(item.get("updatedAt") or item.get("createdAt") or ""),
    }


def switched_off(agent: Mapping[str, Any] | None) -> str | None:
    """The sentence an inactive agent's work stops with (§45.26), or None when it is on."""
    if agent is None or agent.get("active") is not False:
        return None
    name = public(agent)["name"]
    return f"{name} is switched off. Switch it on in Clips Funded › Settings › Agents."


def get(store: db.Store, user_id: str, workspace_id: str, agent_id: str, now: datetime) -> dict[str, Any]:
    if agent_id not in res.AGENT_IDS:
        raise not_found(NOT_FOUND)
    return ensure(store, user_id, workspace_id, now)[agent_id]


def clean_skill_ids(value: Any, known: Iterable[str]) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_SKILLS:
        raise bad_request(f"skillIds must be a list of at most {MAX_SKILLS} skills.", "skillIds")
    allowed = set(known)
    out: list[str] = []
    for skill_id in value:
        if not isinstance(skill_id, str) or skill_id not in allowed:
            raise bad_request("We could not find one of those skills. Load the skills again.", "skillIds")
        if skill_id in out:
            raise bad_request("Each skill can be picked once.", "skillIds")
        out.append(skill_id)
    return out


def patch(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    agent_id: str,
    body: Mapping[str, Any],
    *,
    now: datetime,
    known_skills: Iterable[str],
) -> dict[str, Any]:
    """PATCH ``{version, instructions?, active?, model?, effort?, skillIds?}`` or ``{reset: true}``."""
    item = get(store, user_id, workspace_id, agent_id, now)
    at = iso(now)
    if "reset" in body:
        validate.only_keys(body, ("reset", "version"))
        if body.get("reset") is not True:
            raise bad_request("reset must be true.", "reset")
        default = res.agent_default(agent_id) or {}
        return _update(store, item, {"instructions": str(default.get("instructions") or "")}, [], at, version=None)
    validate.only_keys(body, PATCH_KEYS)
    version = validate.whole_number(body.get("version"))
    if version is None:
        raise bad_request("version is required.", "version")
    if len(body) == 1:
        raise bad_request("Change at least one thing.")
    sets: dict[str, Any] = {}
    removes: list[str] = []
    if "instructions" in body:
        text = body.get("instructions")
        if not isinstance(text, str):
            raise bad_request("instructions must be text.", "instructions")
        cleaned = text.replace("\r\n", "\n").strip()
        if not cleaned:
            raise bad_request("Write what this agent should do, or tap Reset.", "instructions")
        if len(cleaned) > INSTRUCTIONS_MAX:
            raise bad_request(
                f"The instructions are too long (at most {INSTRUCTIONS_MAX:,} characters).", "instructions"
            )
        sets["instructions"] = cleaned
    if "active" in body:
        sets["active"] = validate.boolean(body.get("active"), "active")
    model = item.get("model") or None
    if "model" in body:
        model = cfg.optional_model(body.get("model"))
        if model:
            sets["model"] = model
        else:
            removes.append("model")
    effort = item.get("effort") or None
    if "effort" in body:
        effort = cfg.optional_effort(body.get("effort"))
        if effort:
            sets["effort"] = effort
        else:
            removes.append("effort")
    if effort and ("model" in body or "effort" in body):
        _check_setting(store, user_id, workspace_id, model, effort)
    if "skillIds" in body:
        sets["skillIds"] = clean_skill_ids(body.get("skillIds"), known_skills)
    return _update(store, item, sets, removes, at, version=version)


def _check_setting(store: db.Store, user_id: str, workspace_id: str, model: str | None, effort: str) -> None:
    """The agent's effort on the model it runs (its own, else the default), and its own model and effort together
    (§45.34 "Model and effort pairs")."""
    ai = cfg.current(store, user_id, workspace_id)
    try:
        res.check_effort_for(str(model or ai["defaultModel"]), effort)
        res.check_pair(model, effort)
    except res.ResolveError as e:
        raise bad_request(e.message, "effort") from e


def _update(
    store: db.Store, item: Mapping[str, Any], sets: dict[str, Any], removes: list[str], at: str, *, version: int | None
) -> dict[str, Any]:
    names = {"#u": "updatedAt", "#v": "version", "#uid": "userId", "#wid": "workspaceId"}
    values: dict[str, Any] = {":u": at, ":one": 1, ":uid": item["userId"], ":wid": item["workspaceId"]}
    parts = ["#u = :u"]
    for i, (field, value) in enumerate(sets.items()):
        names[f"#s{i}"] = field
        values[f":s{i}"] = value
        parts.append(f"#s{i} = :s{i}")
    expression = "SET " + ", ".join(parts)
    if removes:
        for i, field in enumerate(removes):
            names[f"#r{i}"] = field
        expression += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(removes)))
    expression += " ADD #v :one"
    condition = "attribute_exists(pk) AND #uid = :uid AND #wid = :wid"
    if version is not None:
        condition += " AND #v = :v"
        values[":v"] = version
    try:
        return store.update_expr(
            str(item["pk"]), str(item["sk"]), expression, condition=condition, names=names, values=values
        )
    except db.ConditionFailed as e:
        raise conflict(STALE) from e


def drop_skill(store: db.Store, user_id: str, workspace_id: str, skill_id: str, now: datetime) -> None:
    """Takes a deleted skill out of every agent that had it (the agents keep their other skills, in order)."""
    for item in read_all(store, user_id, workspace_id).values():
        ids = [str(s) for s in item.get("skillIds") or []]
        if skill_id not in ids:
            continue
        with contextlib.suppress(ApiError):  # the agent is gone or changed meanwhile: nothing left to take out
            _update(store, item, {"skillIds": [s for s in ids if s != skill_id]}, [], iso(now), version=None)
