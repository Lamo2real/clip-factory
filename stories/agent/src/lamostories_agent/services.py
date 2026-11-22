"""What this runtime's work uses, built once from its environment (docs/CONTRACTS.md §45.11.4), on first use.

Terraform passes ``CF_STORIES_TABLE``, ``CF_MEDIA_BUCKET``, ``CF_REGION``, ``CF_IMAGE_MODEL_ID``, ``CF_IMAGE_REGION``
and ``CF_VIDEO_BUCKET`` (empty while the US bucket is off); the image sets ``CF_STORIES_CONFIG_DIR``,
``CF_STORIES_SKILLS_DIR``, ``CF_STORIES_ENGINE_DIR`` and ``CF_WORK_DIR``. Nothing is called at import or at startup:
the AWS clients are made on their first call. ``get()`` is the one shared instance (the chat, tasks and reference
packages use the same ``models`` client and ``data``)."""

from __future__ import annotations

import os
import threading
from functools import cache
from pathlib import Path
from typing import Any

from . import config
from .data import StoryData
from .models import BedrockModels
from .pipeline import Services
from .store import Store

NOT_CONFIGURED = "Lamo Stories' agent is missing its table or bucket setting."
_lock = threading.Lock()
_held: dict[str, Services] = {}


class NotConfigured(RuntimeError):
    pass


@cache
def _client(service: str, region: str) -> Any:
    import boto3
    from botocore.config import Config

    cfg = Config(read_timeout=300, connect_timeout=10, retries={"max_attempts": 3, "mode": "standard"})
    return boto3.client(service, region_name=region, config=cfg)


def build(env: dict[str, str] | None = None) -> Services:
    env = dict(os.environ if env is None else env)
    table, bucket = env.get("CF_STORIES_TABLE", ""), env.get("CF_MEDIA_BUCKET", "")
    region = env.get("CF_REGION") or env.get("AWS_REGION") or "eu-north-1"
    if not table or not bucket:
        raise NotConfigured(NOT_CONFIGURED)
    store = Store(table, bucket, region)
    image = config.models().get("imageModel") or {}
    video = config.models().get("videoModel") or {}
    image_region = env.get("CF_IMAGE_REGION") or str(image.get("region") or "eu-west-1")
    video_region = str(video.get("region") or "us-east-1")

    def table_factory() -> Any:
        import boto3

        return boto3.session.Session(region_name=region).resource("dynamodb").Table(table)

    models = BedrockModels(table=table_factory, get_bytes=store.get_bytes_sync, region=region)
    work = Path(env.get("CF_WORK_DIR") or "/tmp/ls-work")
    return Services(
        data=StoryData(store),
        work_root=work / "jobs",
        models=models,
        engine_dir=config.engine_dir(),
        config_dir=config.config_dir(),
        image_model_id=env.get("CF_IMAGE_MODEL_ID") or str(image.get("modelId") or ""),
        image_client=lambda: _client("bedrock-runtime", image_region),
        video_bucket=env.get("CF_VIDEO_BUCKET", ""),
        video_model_id=str(video.get("modelId") or ""),
        reel_client=lambda: _client("bedrock-runtime", video_region),
        us_s3=lambda: _client("s3", video_region),
    )


def get() -> Services:
    with _lock:
        if "it" not in _held:
            _held["it"] = build()
        return _held["it"]


def install(services: Services | None) -> None:
    """Tests put their fakes here (``None`` forgets them)."""
    with _lock:
        _held.pop("it", None)
        if services is not None:
            _held["it"] = services
