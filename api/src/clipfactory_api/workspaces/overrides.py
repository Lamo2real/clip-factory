"""The owner's per-request model and effort (``ModelOverride``) and a video's own setting (``Story.ai``), checked
against Lamo Stories' own model list (docs/CONTRACTS.md §45.6, §45.25, ADR-77).

Checked as the body is read: the model is a key of ``stories/config/models.json``, the effort is one of the five
levels, and when both are given the model offers that effort ("Claude Haiku 5.5 does not offer Maximum. Pick another
level."). ``refuse_unusable`` then checks an effort given alone against the model that will really run (the task's,
the agent's or the workspace default: §45.25 "refused, never swapped: when saved"), through the API's one resolver
(``workspaces/ai_resolve.py``, with ``ai_config`` and ``agents``: builder A2's modules). Until those are in this build
it checks nothing more, and Lamo Stories' agent refuses such an effort with the same sentence when it calls.
Overrides are carried on the stored item (``PJOB#.configuration.override``, ``TASK#.override``) and never saved as a
setting. Clip Factory's ``config/models.json`` is never read.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterable, Mapping
from typing import Any, Final

from .. import db, validate
from ..errors import bad_request
from . import config

# The tasks a story's jobs run (§45.25 "Tasks"); a video's own setting is the project level of each.
STORY_TASKS: Final = ("storyboard", "scene_rewrite", "fact_check", "final_review", "captions")
RESOLVER_MODULES: Final = ("ai_resolve", "ai_config", "agents")


def _model(value: Any, field: str) -> dict[str, Any]:
    """A key of ``stories/config/models.json``, or of a model the owner added to this workspace (§45.34)."""
    if not isinstance(value, str) or not value:
        raise bad_request(f"{field} must be a model key.", field)
    found = config.model(value)
    if found is None:
        from .ai_resolve import custom_models

        found = next((m for m in custom_models() if m.get("key") == value), None)
    if found is None:
        raise bad_request("We don't know that model. Pick one in Funded Clips › Settings › AI.", field)
    return found


def _effort(value: Any, field: str) -> str:
    if value not in config.EFFORTS:
        raise bad_request("effort must be low, medium, high, xhigh or max.", field)
    return str(value)


def _pair(model: dict[str, Any] | None, effort: str | None, field: str) -> None:
    if model is None or effort is None:
        return
    offered = list(model.get("efforts") or [])
    if not offered:
        raise bad_request(f"{model.get('label')} has no effort setting; it runs at its own level.", field)
    if effort not in offered:
        raise bad_request(
            f"{model.get('label')} does not offer {config.EFFORT_LABEL[effort]}. Pick another level.", field
        )


def model_override(value: Any, field: str = "override") -> dict[str, str] | None:
    """``ModelOverride`` ``{ model?, effort? }``, checked; None when absent or empty (nothing to override)."""
    if value is None:
        return None
    body = validate.obj(value, field)
    validate.only_keys(body, {"model", "effort"})
    out: dict[str, str] = {}
    model = None
    if body.get("model") is not None:
        model = _model(body["model"], f"{field}.model")
        out["model"] = str(body["model"])
    if body.get("effort") is not None:
        out["effort"] = _effort(body["effort"], f"{field}.effort")
    _pair(model, out.get("effort"), field)
    return out or None


def ai_setting(value: Any, field: str = "ai") -> dict[str, str | None]:
    """A video's own ``{ model: string | null, effort: Effort | null }`` (§45.25 level 2), kept with it."""
    body = validate.obj(value, field)
    validate.only_keys(body, {"model", "effort"})
    model = _model(body["model"], f"{field}.model") if body.get("model") is not None else None
    effort = _effort(body["effort"], f"{field}.effort") if body.get("effort") is not None else None
    _pair(model, effort, field)
    return {"model": str(body["model"]) if model is not None else None, "effort": effort}


def empty_setting() -> dict[str, None]:
    return {"model": None, "effort": None}


# --- the effective model (§45.25 "refused, never swapped: when saved") ------------------------------------------


def _sets(value: Mapping[str, Any] | None) -> bool:
    return any(isinstance(v, str) and v for v in (value or {}).values())


def resolver() -> tuple[Any, ...] | None:
    """Builder A2's ``ai_resolve``, ``ai_config`` and ``agents`` modules once they are in this build, else None. A
    module that is there but fails to import is an error, never skipped."""
    found = []
    for name in RESOLVER_MODULES:
        full = f"{__package__}.{name}"
        try:
            found.append(importlib.import_module(full))
        except ModuleNotFoundError as e:
            if e.name != full:
                raise
            return None
    return tuple(found)


def _problem(
    res: Any, kind: str, project: Mapping[str, Any] | None, request: Mapping[str, Any] | None, *, ai: Any, agents: Any
) -> str | None:
    """The sentence the call would stop with, or None when the effective model and effort can be used."""
    _, problem = res.story_effective({"ai": dict(project or {})}, ai=ai, agents=agents, task=kind, override=request)
    return str(problem) if problem else None


def refuse_unusable(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    *,
    project: Mapping[str, Any] | None,
    request: Mapping[str, Any] | None = None,
    field: str,
    kinds: Iterable[str] = STORY_TASKS,
) -> None:
    """400 with the resolver's sentence when the setting being saved makes a task's effective model and effort
    unusable. ``field`` names what is being saved: ``"ai"`` (a video's own setting, ``project``) or ``"override"``
    (``request``, on top of the video's stored ``project``). Only a problem this setting brings is refused: one the
    levels below already have (a model removed from the list, say) is the call's to report, so it never blocks this
    save."""
    new = request if field == "override" else project
    if not _sets(new):
        return
    found = resolver()
    if found is None:
        return  # not in this build yet: the agent refuses it with the same sentence when it calls
    res, ai_config, agents_mod = found
    ai = ai_config.current(store, user_id, workspace_id)
    agents = agents_mod.read_all(store, user_id, workspace_id)
    below = project if field == "override" else None
    for kind in kinds:
        problem = _problem(res, kind, project, request, ai=ai, agents=agents)
        if problem and _problem(res, kind, below, None, ai=ai, agents=agents) is None:
            raise bad_request(problem, field)
