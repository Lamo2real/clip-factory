"""Which model and reasoning effort a Lamo Stories call uses (docs/CONTRACTS.md §45.25, ADR-77).

The API's copy of the one resolver: the agent's ``lamostories_agent.models.resolve`` implements the same rules and
both pass every case of ``stories/config/resolve-cases.json``. Precedence, strongest first, with model and effort
merged **separately** (a level that sets only the effort takes the model from the levels below):

1. the per-request override (a chat message's "Just for this message", "Make it a full idea", Analyze, a remake);
2. the conversation's setting (chat turns) or the project's (``Story.ai``, ``ReferenceVideo.ai``);
3. the task's (``tasks[kind]`` of the AI configuration);
4. the agent's own ``model`` / ``effort``;
5. the workspace default (``defaultModel``, ``defaultEffort``; without a saved configuration the defaults of
   ``stories/config/models.json``).

An unknown model and an effort the model does not offer are refused with the owner's sentence, never swapped for
another one. ``from`` names the level the model came from. Pure: no I/O beyond the bundled configuration files.
Clip Factory's ``config/models.json`` is never read.

**Models the owner added** (§45.34 "Adding models without a release"): a workspace's ``MODELDEF#{key}`` items are
merged after the bundled list wherever models are listed, checked or resolved. They are per workspace: each request
binds its own workspace's loader (``bind``, called by ``guard.require_workspace`` for every ``/v1/workspaces/{ws}``
route) and the list is read once, on first use, for that request only; an unbound call (no workspace) sees the
bundled models alone. A custom key never shadows a bundled one.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Iterator, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Final

from . import config

EFFORTS: Final = ("low", "medium", "high", "xhigh", "max")
EFFORT_LABEL: Final = {"low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Maximum"}
LEVELS: Final = ("request", "conversation", "project", "task", "agent")
TASK_KINDS: Final = (
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
    "text_edit",  # §45.37 G5: short chat edits (rename, fix a word, shorten a caption), the creative director's
    "animation_plan",  # §45.37 G5: the storyboard's re-staging pass (detailed animation planning)
)
# Plain names for the tasks table (Settings › AI), in the owner's words.
TASK_LABEL: Final = {
    "chat": "Chat",
    "brainstorm": "Find ideas",
    "expand_idea": "Make it a full idea",
    "variations": "More like this",
    "storyboard": "Write the story",
    "scene_rewrite": "Remake a scene",
    "character_design": "Design a character",
    "reference_analysis": "Study a video",
    "fact_check": "Check the facts",
    "final_review": "Last look at the video",
    "captions": "Write the post captions",
    "text_edit": "Small text edits",
    "animation_plan": "Plan the animation",
}
# Suggestions shown next to each task, never forced (§45.25; the owner's second request §4).
SUGGESTED_EFFORT: Final = {
    "chat": "medium",
    "brainstorm": "medium",
    "expand_idea": "high",
    "variations": "medium",
    "storyboard": "high",
    "scene_rewrite": "high",
    "character_design": "medium",
    "reference_analysis": "high",
    "fact_check": "high",
    "final_review": "high",
    "captions": "low",
    "text_edit": "low",  # the owner's "Simple text modifications: Low"
    "animation_plan": "high",  # the owner's "Detailed animation planning: High"
}
AGENT_IDS: Final = ("creative_director", "video_analysis", "storyboard", "character", "quality_assurance")


class ResolveError(Exception):
    """The effective model or effort cannot be used. ``kind`` is ``"model"`` or ``"effort"``; the message is the
    owner's sentence (§45.25: refused, never swapped)."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# --- the models the owner added (per workspace, per request) ---------------------------------------------------


@dataclass
class _Scope:
    """One request's workspace: who it is for and how to read its ``MODELDEF#`` items (read once, on first use)."""

    user_id: str
    workspace_id: str
    loader: Callable[[], list[dict[str, Any]]]
    loaded: list[dict[str, Any]] | None = field(default=None)


_SCOPE: ContextVar[_Scope | None] = ContextVar("ws_custom_models", default=None)


def bind(user_id: str, workspace_id: str, loader: Callable[[], list[dict[str, Any]]]) -> None:
    """This request works in this workspace: its own added models (from ``loader``) join the list."""
    _SCOPE.set(_Scope(user_id, workspace_id, loader))


def unbind() -> None:
    """No workspace (a request that lists workspaces, a callback, a test): the bundled models only."""
    _SCOPE.set(None)


def forget_custom() -> None:
    """The workspace's added models changed (a PUT or DELETE of one): read them again on next use."""
    scope = _SCOPE.get()
    if scope is not None:
        scope.loaded = None


def bound_to() -> tuple[str, str] | None:
    scope = _SCOPE.get()
    return (scope.user_id, scope.workspace_id) if scope is not None else None


@contextlib.contextmanager
def overlay(extra: list[dict[str, Any]]) -> Iterator[None]:
    """While a save is checked: these added models in place of the stored ones of the same keys."""
    scope = _SCOPE.get()
    keys = {str(m.get("key")) for m in extra}
    merged = [m for m in custom_models() if str(m.get("key")) not in keys] + [dict(m) for m in extra]
    user_id, workspace_id = (scope.user_id, scope.workspace_id) if scope is not None else ("", "")
    token = _SCOPE.set(_Scope(user_id, workspace_id, lambda: merged, merged))
    try:
        yield
    finally:
        _SCOPE.reset(token)


def custom_models() -> list[dict[str, Any]]:
    """The bound workspace's added models (``models.json``-shaped, ``custom: True``), or none."""
    scope = _SCOPE.get()
    if scope is None:
        return []
    if scope.loaded is None:
        scope.loaded = [dict(m) for m in scope.loader()]
    return [dict(m) for m in scope.loaded]


def bundled_models() -> list[dict[str, Any]]:
    """The reasoning models of ``stories/config/models.json``, in the file's order."""
    return [dict(m) for m in config.load("models.json").get("models") or [] if isinstance(m, dict)]


def bundled_keys() -> set[str]:
    return {str(m.get("key")) for m in bundled_models()}


# --- the lists ------------------------------------------------------------------------------------------------


def models() -> list[dict[str, Any]]:
    """The reasoning models Lamo Stories may use: the file's, in its order, then the workspace's added ones (a key
    the file has already is never replaced)."""
    listed = bundled_models()
    keys = {str(m.get("key")) for m in listed}
    return listed + [m for m in custom_models() if str(m.get("key")) not in keys]


def model(key: Any) -> dict[str, Any] | None:
    if not isinstance(key, str):
        return None
    return next((m for m in models() if m.get("key") == key), None)


def default_model() -> str:
    return str(config.load("models.json").get("defaultModel") or "")


def default_effort() -> str:
    return str(config.load("models.json").get("defaultEffort") or "")


def agent_defaults() -> list[dict[str, Any]]:
    """The five built-in agents of ``stories/config/agents.json``."""
    return [dict(a) for a in config.load("agents.json").get("agents") or [] if isinstance(a, dict)]


def agent_default(agent_id: Any) -> dict[str, Any] | None:
    return next((a for a in agent_defaults() if a.get("agentId") == agent_id), None)


def agent_for_task(task: str) -> str | None:
    """The agent that does a task kind (§45.26); None for ``check_models`` (no agent)."""
    found = next((a for a in agent_defaults() if task in (a.get("tasks") or [])), None)
    return str(found["agentId"]) if found else None


def model_label(key: str) -> str:
    found = model(key)
    return str(found["label"]) if found else key


# --- sentences ------------------------------------------------------------------------------------------------


def unknown_model(key: str) -> str:
    return f"Funded Clips has no model called '{key}'. Pick another one in Funded Clips › Settings › AI."


def unknown_effort(effort: str) -> str:
    return f"'{effort}' is not an effort level. Pick Low, Medium, High, Extra high or Maximum."


def effort_not_offered(model_key: str, effort: str) -> str:
    """ "Claude Haiku 5.5 does not offer Maximum. Pick another level." (§45.25)."""
    return f"{model_label(model_key)} does not offer {EFFORT_LABEL.get(effort, effort)}. Pick another level."


def no_effort_setting(model_key: str) -> str:
    """An effort saved together with a model that has none (§45.34 "Model and effort pairs")."""
    return f"{model_label(model_key)} has no effort setting; it runs at its own level."


# --- the resolver ---------------------------------------------------------------------------------------------


def _level(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _set(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def resolve(
    *,
    task: str,
    agent: Mapping[str, Any] | None = None,
    ai: Mapping[str, Any] | None = None,
    request: Mapping[str, Any] | None = None,
    conversation: Mapping[str, Any] | None = None,
    project: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The ``Effective`` of one call: ``{model, effort, effortApplied, from}``. Raises ``ResolveError`` for an unknown
    model, an unknown effort, or an effort the effective model does not offer. ``conversation`` applies to chat
    turns and ``project`` to a story's or a reference's work (§45.25 level 2)."""
    cfg = _level(ai)
    tasks = _level(cfg.get("tasks"))
    levels: list[tuple[str, Mapping[str, Any]]] = [
        ("request", _level(request)),
        ("conversation", _level(conversation)),
        ("project", _level(project)),
        ("task", _level(tasks.get(task))),
        ("agent", _level(agent)),
    ]
    model_key, source = None, "default"
    for name, level in levels:
        if _set(level.get("model")):
            model_key, source = str(level["model"]), name
            break
    if model_key is None:
        model_key = str(cfg.get("defaultModel") or default_model())
    info = model(model_key)
    if info is None:
        raise ResolveError("model", unknown_model(model_key))
    effort = next((str(level["effort"]) for _, level in levels if _set(level.get("effort"))), None)
    if effort is None:
        effort = str(cfg.get("defaultEffort") or default_effort())
    if effort not in EFFORTS:
        raise ResolveError("effort", unknown_effort(effort))
    offered = [str(e) for e in info.get("efforts") or []]
    if not offered:  # the model has no effort setting: it runs at its own level and nothing is sent
        return {"model": model_key, "effort": None, "effortApplied": False, "from": source}
    if effort not in offered:
        raise ResolveError("effort", effort_not_offered(model_key, effort))
    return {"model": model_key, "effort": effort, "effortApplied": True, "from": source}


def shown(
    *,
    task: str,
    agent: Mapping[str, Any] | None = None,
    ai: Mapping[str, Any] | None = None,
    request: Mapping[str, Any] | None = None,
    conversation: Mapping[str, Any] | None = None,
    project: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], str | None]:
    """What to show for a setting that is stored but can no longer be used (a model removed from the list, an
    effort the newly picked model does not offer): the levels' own values with ``effortApplied`` false, and the
    sentence the call would stop with. Never raises; a usable setting returns ``(resolve(...), None)``."""
    try:
        return resolve(task=task, agent=agent, ai=ai, request=request, conversation=conversation, project=project), None
    except ResolveError as e:
        problem = e.message
    cfg = _level(ai)
    levels = [
        ("request", _level(request)),
        ("conversation", _level(conversation)),
        ("project", _level(project)),
        ("task", _level(_level(cfg.get("tasks")).get(task))),
        ("agent", _level(agent)),
    ]
    found = next(((n, str(lv["model"])) for n, lv in levels if _set(lv.get("model"))), None)
    source, model_key = found if found else ("default", str(cfg.get("defaultModel") or default_model()))
    effort = next((str(lv["effort"]) for _, lv in levels if _set(lv.get("effort"))), None)
    effort = effort or str(cfg.get("defaultEffort") or default_effort())
    return {
        "model": model_key,
        "effort": effort if effort in EFFORTS else None,
        "effortApplied": False,
        "from": source,
    }, problem


def check_effort_for(model_key: str, effort: str | None) -> None:
    """Raises ``ResolveError`` when ``effort`` is set and ``model_key``'s model does not offer it (used when a
    setting is saved: the owner is told at once)."""
    info = model(model_key)
    if info is None:
        raise ResolveError("model", unknown_model(model_key))
    if effort is None:
        return
    if effort not in EFFORTS:
        raise ResolveError("effort", unknown_effort(effort))
    offered = [str(e) for e in info.get("efforts") or []]
    if offered and effort not in offered:
        raise ResolveError("effort", effort_not_offered(model_key, effort))


def check_pair(model_key: str | None, effort: str | None) -> None:
    """One setting that names both a model and an effort (a task's, an agent's, a conversation's, a video's): the
    model must offer that effort, and a model with no effort setting takes none (§45.34 "Model and effort pairs":
    refused when saved; only an inherited effort runs such a model with no effort sent)."""
    if not model_key or not effort:
        return
    check_effort_for(model_key, effort)
    info = model(model_key) or {}
    if not [e for e in info.get("efforts") or [] if e in EFFORTS]:
        raise ResolveError("effort", no_effort_setting(model_key))


def story_effective(
    story: Mapping[str, Any],
    *,
    ai: Mapping[str, Any] | None,
    agents: Mapping[str, Mapping[str, Any]],
    task: str = "storyboard",
    override: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], str | None]:
    """The effective model and effort of one task of a story's jobs (the story's own ``ai`` is the project level),
    with the sentence the job would stop with when it cannot be used."""
    agent_id = agent_for_task(task)
    return shown(
        task=task,
        agent=agents.get(agent_id) if agent_id else None,
        ai=ai,
        request=override,
        project=_level(story.get("ai")),
    )
