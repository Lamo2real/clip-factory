"""Runtime configuration from the environment (docs/CONTRACTS.md §8)."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

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


def model_from_models_json(path: Path, key: str = "agentModel") -> str | None:
    """``global.anthropic.claude-…`` from config/models.json, for when CF_MODEL_ID is not set. ``key`` names which
    model: ``agentModel`` (Fable) or ``watchModel`` (the second watcher).

    A model's own ``profilePrefix`` wins over the top-level one (docs/CONTRACTS.md §19.5).
    """
    try:
        data = json.loads(path.read_text("utf-8"))
        entry = data["models"][data[key]]
        model = entry["modelId"]
        prefix = entry.get("profilePrefix") or data.get("profilePrefix")
        return f"{prefix}.{model}" if prefix else str(model)
    except (OSError, ValueError, KeyError, TypeError):
        return None


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
    )
