"""Lamo Stories' own configuration files (``stories/config``, copied to ``/app/stories/config`` in the image).

SCAFFOLD (Phase 1): the loaders every builder uses; builders E and E2 extend them additively.

The bundled model list (``models.json``) is read once per process. The models an owner added in Lamo Stories ›
Settings › AI (``MODELDEF#{key}`` items of the workspace, docs/CONTRACTS.md §45.34 "Adding models without a release")
are merged over it per call (``merged_models``), never cached across workspaces.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable, Mapping
from functools import cache
from pathlib import Path
from typing import Any

EFFORTS = ("low", "medium", "high", "xhigh", "max")
CUSTOM_KEY = re.compile(r"^custom-[a-z0-9-]{1,40}$")
MAX_CUSTOM = 20
MODELDEF_PREFIX = "MODELDEF#"


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


def model(key: str, catalog: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """One model of ``catalog`` (a ``merged_models`` answer), or of the bundled list when none is given."""
    for m in (catalog if catalog is not None else models())["models"]:
        if m["key"] == key:
            return dict(m)
    return None


def model_from_def(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A ``MODELDEF#{key}`` item (the owner's ``ModelDef``: label, provider, modelId, region, efforts, defaultEffort,
    vision, maxOutputTokens, price) as an entry of the model list, or None when it cannot be used: a key that is not
    ``custom-…`` or that shadows a bundled model, or no model id. It is called by its own model id (a Bedrock model
    id, an inference profile id or an ARN) in its own Region, and offers exactly the efforts the owner listed."""
    nested = item.get("model")
    body: Mapping[str, Any] = nested if isinstance(nested, Mapping) else item
    key = str(item.get("key") or body.get("key") or str(item.get("sk") or "").removeprefix(MODELDEF_PREFIX))
    if not CUSTOM_KEY.match(key) or any(m["key"] == key for m in models()["models"]):
        return None
    model_id = str(body.get("modelId") or "").strip()
    if not model_id:
        return None
    efforts = [str(e) for e in body.get("efforts") or [] if e in EFFORTS]
    default = body.get("defaultEffort")
    region = str(body.get("region") or "").strip() or None
    price = body.get("price")
    try:
        out_tokens = int(body.get("maxOutputTokens") or 0) or None
    except (TypeError, ValueError):
        out_tokens = None
    return {
        "key": key,
        "label": str(body.get("label") or key).strip() or key,
        "provider": str(body.get("provider") or "Amazon Bedrock"),
        "modelId": model_id,
        "profile": model_id,
        "region": region,
        "regions": [region] if region else [],
        "efforts": list(dict.fromkeys(efforts)),
        "defaultEffort": default if default in efforts else None,
        "vision": body.get("vision") is True,
        "maxOutputTokens": out_tokens,
        "pricing": dict(price) if isinstance(price, Mapping) else None,
        "custom": True,
    }


def merged_models(defs: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The bundled list with the workspace's own models after it (at most ``MAX_CUSTOM``, in key order); a bundled
    model is never replaced."""
    base = models()
    seen = {str(m["key"]) for m in base["models"]}
    extra: list[dict[str, Any]] = []
    for item in sorted(defs, key=lambda d: str(d.get("sk") or d.get("key") or "")):
        entry = model_from_def(item)
        if entry is None or entry["key"] in seen or len(extra) >= MAX_CUSTOM:
            continue
        seen.add(entry["key"])
        extra.append(entry)
    return {**base, "models": [*base["models"], *extra]}
