"""Lamo Stories' own configuration files (``stories/config``), never Clip Factory's ``config/`` (CONTRACTS §45.24).

In the Lambda zip they are package data (``clipfactory_api/stories_config/``, bundled by ``build_lambda.py``); in the
repository and in tests they are read from ``stories/config``.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

_PACKAGED = Path(__file__).resolve().parents[1] / "stories_config"
_REPO = Path(__file__).resolve().parents[4] / "stories" / "config"


def config_dir() -> Path:
    return _PACKAGED if _PACKAGED.is_dir() else _REPO


@cache
def load(name: str) -> dict[str, Any]:
    """One of ``models.json``, ``agents.json``, ``guidance.json``, ``workspace-defaults.json``, ``resolve-cases.json``."""
    data = json.loads((config_dir() / name).read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{name} is not a JSON object")
    return data


def workspace_defaults() -> dict[str, Any]:
    return {k: v for k, v in load("workspace-defaults.json").items() if not k.startswith("$")}
