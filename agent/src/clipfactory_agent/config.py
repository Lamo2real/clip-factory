"""Runtime configuration from the environment (docs/CONTRACTS.md §8)."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    region: str
    table: str
    bucket: str
    model_id: str
    skills_dir: Path
    work_root: Path


def model_from_models_json(path: Path) -> str | None:
    """``global.anthropic.claude-…`` from config/models.json, for when CF_MODEL_ID is not set."""
    try:
        data = json.loads(path.read_text("utf-8"))
        model = data["models"][data["agentModel"]]["modelId"]
        prefix = data.get("profilePrefix")
        return f"{prefix}.{model}" if prefix else str(model)
    except (OSError, ValueError, KeyError, TypeError):
        return None


def load_config(env: Mapping[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    missing = [k for k in ("CF_TABLE", "CF_MEDIA_BUCKET") if not e.get(k)]
    region = e.get("CF_REGION") or e.get("AWS_REGION") or e.get("AWS_DEFAULT_REGION")
    if not region:
        missing.append("CF_REGION")
    model = e.get("CF_MODEL_ID") or model_from_models_json(Path(e.get("CF_CONFIG_DIR", "/app/config")) / "models.json")
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
    )
