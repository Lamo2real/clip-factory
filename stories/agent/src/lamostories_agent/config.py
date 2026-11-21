"""Lamo Stories' own configuration files (``stories/config``, copied to ``/app/stories/config`` in the image).

SCAFFOLD (Phase 1): the loaders every builder uses; builders E and E2 extend them additively.
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path
from typing import Any

EFFORTS = ("low", "medium", "high", "xhigh", "max")


def config_dir() -> Path:
    """``CF_STORIES_CONFIG_DIR`` in the image; the repository's ``stories/config`` in tests."""
    found = os.environ.get("CF_STORIES_CONFIG_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[3] / "config"


def skills_dir() -> Path:
    found = os.environ.get("CF_STORIES_SKILLS_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[3] / "skills"


def engine_dir() -> Path:
    """The engine folder (``web/src/stories/engine`` in the repository, ``/app/stories-engine`` in the image)."""
    found = os.environ.get("CF_STORIES_ENGINE_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[4] / "web" / "src" / "stories" / "engine"


@cache
def models() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "models.json").read_text()))


@cache
def agents() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "agents.json").read_text()))


@cache
def guidance() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "guidance.json").read_text()))


def model(key: str) -> dict[str, Any] | None:
    for m in models()["models"]:
        if m["key"] == key:
            return dict(m)
    return None
