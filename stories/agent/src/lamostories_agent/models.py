"""Model and effort resolution and the one model client (docs/CONTRACTS.md §45.25, §45.33, ADR-77).

SCAFFOLD (Phase 1): the contract every Lamo Stories AI call goes through. Builder E implements ``ModelClient`` (Bedrock
Converse with ``additionalModelRequestFields={"output_config": {"effort": ...}}``, refusals, MODELSTATUS# and USAGE#);
builder E2's chat, tasks and analysis call it. Precedence, strongest first, model and effort merged separately: the
per-request override, the conversation's or the project's setting, the task's, the agent's, the workspace default.
There is never an automatic fallback to another model, and an effort the model does not offer is refused, never
swapped. ``stories/config/resolve-cases.json`` holds the shared cases (the API's resolver passes the same ones).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import config

LEVELS = ("request", "conversation", "project", "task", "agent")


class ModelUnavailable(Exception):
    """The effective model cannot be used. The message is the owner's sentence; nothing runs on another model."""


class EffortUnavailable(Exception):
    """The effective effort is not one the model offers. The message is the owner's sentence; it is never swapped."""


@dataclass(frozen=True)
class Choice:
    model: str  # a key of stories/config/models.json
    effort: str | None  # None when the model has no effort setting (then effort_applied is False)
    effort_applied: bool
    source: str  # where the model came from: one of LEVELS or "default"


def resolve(
    *,
    task: str,
    agent: dict[str, Any] | None = None,
    ai: dict[str, Any] | None = None,
    override: dict[str, Any] | None = None,
    conversation: dict[str, Any] | None = None,
    project: dict[str, Any] | None = None,
) -> Choice:
    """The effective model and effort for one call (§45.25). ``conversation`` applies to chat turns, ``project`` to a
    story's or a reference's jobs; pass at most one of them."""
    ai = ai or {}
    task_cfg = (ai.get("tasks") or {}).get(task) or {}
    levels: list[tuple[str, dict[str, Any]]] = [
        ("request", override or {}),
        ("conversation", conversation or {}),
        ("project", project or {}),
        ("task", task_cfg),
        ("agent", agent or {}),
    ]
    model_key, source = None, "default"
    for name, cfg in levels:
        if cfg.get("model"):
            model_key, source = str(cfg["model"]), name
            break
    if model_key is None:
        model_key = str(ai.get("defaultModel") or config.models()["defaultModel"])
    info = config.model(model_key)
    if info is None:
        raise ModelUnavailable(f"The model '{model_key}' is not in Lamo Stories' list. Pick another in Settings › AI.")
    effort = next((str(cfg["effort"]) for _, cfg in levels if cfg.get("effort")), None)
    if effort is None:
        effort = str(ai.get("defaultEffort") or config.models()["defaultEffort"])
    offered = list(info.get("efforts") or [])
    if not offered:
        return Choice(model_key, None, False, source)
    if effort not in offered:
        raise EffortUnavailable(
            f"{info['label']} does not offer the effort '{effort}'. Pick another level in Lamo Stories › Settings › AI."
        )
    return Choice(model_key, effort, True, source)


@dataclass(frozen=True)
class CallContext:
    """Who a call works for and its fence (§45.33)."""

    user_id: str
    workspace_id: str
    agent_id: str
    session_id: str
    job_id: str | None = None
    task_id: str | None = None
    conv_id: str | None = None
    msg_id: str | None = None


@dataclass(frozen=True)
class Reply:
    text: str
    data: dict[str, Any] | None  # the parsed JSON when a schema was asked for
    tool_calls: list[dict[str, Any]]
    content: list[dict[str, Any]]  # the raw assistant blocks, for tool loops
    stop_reason: str
    model: str
    effort: str | None
    effort_applied: bool
    usage: dict[str, int] = field(default_factory=dict)


class ModelClient(Protocol):
    def complete(
        self,
        ctx: CallContext,
        *,
        task: str,
        messages: list[dict[str, Any]],
        override: dict[str, Any] | None = None,
        schema: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 16000,
        on_text: Callable[[str], None] | None = None,
    ) -> Reply:
        """Resolves the model and effort itself, builds the system blocks (the agent's instructions, its enabled skills,
        the workspace memory), sends the request, writes MODELSTATUS# and USAGE#. Called from a worker thread."""
        ...
