"""Runtime configuration from the environment (docs/CONTRACTS.md §8)."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_VECTOR_INDEX = "clips"
DEFAULT_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"


@dataclass(frozen=True)
class Config:
    region: str
    table: str
    bucket: str
    model_id: str
    skills_dir: Path
    work_root: Path
    vector_bucket: str | None = None  # S3 Vectors bucket; unset = no "what worked before" and no clip vectors
    vector_index: str = DEFAULT_VECTOR_INDEX
    embed_model_id: str = DEFAULT_EMBED_MODEL_ID
    # The second watcher of the deep analysis (Amazon Nova 2 Lite, docs/DECISIONS.md ADR-40). None: that track is off.
    watch_model_id: str | None = None
    deep_enabled: bool = True  # CF_DEEP=off: no picture download, the watch step is skipped
    # The owner's choice of model for clip jobs (docs/DECISIONS.md ADR-42): the key of the default model (agentModel,
    # whose profile id is ``model_id``) and every model the owner may pick, key -> profile id, from clipModels.
    default_model_key: str | None = None
    clip_models: dict[str, str] = field(default_factory=dict)


def _read(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def profile_id(data: Mapping[str, Any], model_key: str) -> str | None:
    """The id to call model ``model_key`` of a parsed config/models.json with: ``<prefix>.<modelId>``, where the
    model's own ``profilePrefix`` wins over the top-level one (docs/CONTRACTS.md §19.5); no prefix at all, the bare
    model id. None when the key names no model."""
    try:
        entry = data["models"][model_key]
        model = entry["modelId"]
        prefix = entry.get("profilePrefix") or data.get("profilePrefix")
        return f"{prefix}.{model}" if prefix else str(model)
    except (KeyError, TypeError, AttributeError):
        return None


def model_from_models_json(path: Path, key: str = "agentModel") -> str | None:
    """``global.anthropic.claude-…`` from config/models.json, for when CF_MODEL_ID is not set. ``key`` names which
    model: ``agentModel`` (Fable) or ``watchModel`` (the second watcher).

    A model's own ``profilePrefix`` wins over the top-level one (docs/CONTRACTS.md §19.5).
    """
    data = _read(path)
    if data is None:
        return None
    model_key = data.get(key)
    return profile_id(data, model_key) if isinstance(model_key, str) else None


def clip_models_from_models_json(path: Path) -> dict[str, str]:
    """Every model the owner may pick for clip jobs (``clipModels``, docs/DECISIONS.md ADR-42), key -> profile id, in
    the file's order. A key that names no model is left out; no file or no list, none."""
    data = _read(path)
    keys = data.get("clipModels") if data else None
    if data is None or not isinstance(keys, list):
        return {}
    out: dict[str, str] = {}
    for k in keys:
        if isinstance(k, str) and (pid := profile_id(data, k)):
            out[k] = pid
    return out


def load_config(env: Mapping[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    missing = [k for k in ("CF_TABLE", "CF_MEDIA_BUCKET") if not e.get(k)]
    region = e.get("CF_REGION") or e.get("AWS_REGION") or e.get("AWS_DEFAULT_REGION")
    if not region:
        missing.append("CF_REGION")
    models_json = Path(e.get("CF_CONFIG_DIR", "/app/config")) / "models.json"
    model = e.get("CF_MODEL_ID") or model_from_models_json(models_json)
    if not model:
        missing.append("CF_MODEL_ID")
    if missing:
        raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")
    assert region and model
    default_key = (_read(models_json) or {}).get("agentModel")
    return Config(
        region=region,
        table=e["CF_TABLE"],
        bucket=e["CF_MEDIA_BUCKET"],
        model_id=model,
        skills_dir=Path(e.get("CF_SKILLS_DIR", "/app/skills")),
        work_root=Path(e.get("CF_WORK_DIR", "/tmp/cf-work")),
        vector_bucket=e.get("CF_VECTOR_BUCKET") or None,
        vector_index=e.get("CF_VECTOR_INDEX") or DEFAULT_VECTOR_INDEX,
        embed_model_id=e.get("CF_EMBED_MODEL_ID") or DEFAULT_EMBED_MODEL_ID,
        watch_model_id=e.get("CF_WATCH_MODEL_ID") or model_from_models_json(models_json, "watchModel"),
        deep_enabled=(e.get("CF_DEEP") or "on").strip().lower() != "off",
        default_model_key=default_key if isinstance(default_key, str) else None,
        clip_models=clip_models_from_models_json(models_json),
    )
