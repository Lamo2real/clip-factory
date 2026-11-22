"""Lamo Stories' own configuration files (``stories/config``), never Clip Factory's ``config/`` (CONTRACTS §45.24).

In the Lambda zip they are package data (``clipfactory_api/stories_config/`` and the built-in Lamo Stories skills in
``clipfactory_api/stories_skills/``, bundled and validated by ``build_lambda.py``); in the repository and in tests they
are read from ``stories/config`` and ``stories/skills``.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any, Final

_PACKAGED = Path(__file__).resolve().parents[1] / "stories_config"
_REPO = Path(__file__).resolve().parents[4] / "stories" / "config"
_PACKAGED_SKILLS = Path(__file__).resolve().parents[1] / "stories_skills"
_REPO_SKILLS = Path(__file__).resolve().parents[4] / "stories" / "skills"

FILES: Final = ("guidance.json", "models.json", "agents.json", "workspace-defaults.json", "resolve-cases.json")
EFFORTS: Final = ("low", "medium", "high", "xhigh", "max")
EFFORT_LABEL: Final = {"low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Maximum"}


def config_dir() -> Path:
    return _PACKAGED if _PACKAGED.is_dir() else _REPO


def skills_dir() -> Path:
    """The built-in Lamo Stories skills (``stories/skills/<name>/SKILL.md``); Clip Factory's ``skills/`` never."""
    return _PACKAGED_SKILLS if _PACKAGED_SKILLS.is_dir() else _REPO_SKILLS


@cache
def load(name: str) -> dict[str, Any]:
    """One of ``models.json``, ``agents.json``, ``guidance.json``, ``workspace-defaults.json``, ``resolve-cases.json``."""
    data = json.loads((config_dir() / name).read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{name} is not a JSON object")
    return data


def workspace_defaults() -> dict[str, Any]:
    return {k: v for k, v in load("workspace-defaults.json").items() if not k.startswith("$")}


# --- additive helpers (builder A) ------------------------------------------------------------------------------


def models() -> list[dict[str, Any]]:
    """The reasoning models Lamo Stories may use (``stories/config/models.json``)."""
    return [dict(m) for m in load("models.json").get("models") or [] if isinstance(m, dict)]


def model(key: Any) -> dict[str, Any] | None:
    return next((m for m in models() if m.get("key") == key), None)


def agents() -> list[dict[str, Any]]:
    return [dict(a) for a in load("agents.json").get("agents") or [] if isinstance(a, dict)]


def agent_for_task(kind: str) -> dict[str, Any] | None:
    """The built-in agent that does a task kind (§45.26); None for ``check_models`` (no agent)."""
    return next((a for a in agents() if kind in (a.get("tasks") or [])), None)
