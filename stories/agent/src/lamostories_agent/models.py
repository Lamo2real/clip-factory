"""Model and effort resolution and the one model client (docs/CONTRACTS.md §45.25, ADR-77).

SCAFFOLD (Phase 1): the contract every Lamo Stories AI call goes through. Builder E implements ``ModelClient`` (the
Bedrock request with ``output_config.effort``, refusals, usage items); builder E2's chat, tasks and analysis call it.
Precedence, strongest first: the per-request override, the task's setting, the agent's, the workspace default.
There is never an automatic fallback to another model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from . import config


class ModelUnavailable(Exception):
    """The effective model cannot be used. The message is the owner's sentence; nothing runs on another model."""


@dataclass(frozen=True)
class Choice:
    model: str  # a key of stories/config/models.json
    effort: str | None  # None when the model has no effort setting (then effort_applied is False)
    source: str  # "request" | "task" | "agent" | "default"


def resolve(
    *,
    task: str,
    agent: dict[str, Any],
    ai: dict[str, Any],
    override: dict[str, Any] | None = None,
) -> Choice:
    """The effective model and effort for one call. Raises ``ModelUnavailable`` for an unknown model and never
    substitutes; an effort the model does not offer is dropped to the model's own default with source kept, and the
    caller records ``effort_applied`` truthfully."""
    override = override or {}
    task_cfg = (ai.get("tasks") or {}).get(task) or {}
    for source, cfg in (("request", override), ("task", task_cfg), ("agent", agent)):
        if cfg.get("model"):
            model_key, model_source = str(cfg["model"]), source
            break
    else:
        model_key, model_source = str(ai.get("defaultModel") or config.models()["defaultModel"]), "default"
    info = config.model(model_key)
    if info is None:
        raise ModelUnavailable(f"The model '{model_key}' is not in Lamo Stories' list. Pick another in Settings › AI.")
    effort: str | None = None
    for cfg in (override, task_cfg, agent):
        if cfg.get("effort"):
            effort = str(cfg["effort"])
            break
    else:
        effort = str(ai.get("defaultEffort") or config.models()["defaultEffort"])
    offered = list(info.get("efforts") or [])
    if not offered:
        effort = None
    elif effort not in offered:
        effort = info.get("defaultEffort")
    return Choice(model_key, effort, model_source)


@dataclass(frozen=True)
class Reply:
    text: str
    data: dict[str, Any] | None  # the parsed JSON when a schema was asked for
    tool_calls: list[dict[str, Any]]
    stop_reason: str
    model: str
    effort: str | None
    effort_applied: bool
    usage: dict[str, int]


class ModelClient(Protocol):
    def complete(
        self,
        *,
        task: str,
        agent_id: str,
        system: list[str],
        messages: list[dict[str, Any]],
        choice: Choice,
        schema: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 16000,
    ) -> Reply: ...
