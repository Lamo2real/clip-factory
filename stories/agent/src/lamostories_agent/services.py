"""What this runtime's work uses, built once from its environment (docs/CONTRACTS.md §45.11.4), on first use.

Terraform passes ``CF_STORIES_TABLE``, ``CF_MEDIA_BUCKET``, ``CF_REGION``, ``CF_IMAGE_MODEL_ID``, ``CF_IMAGE_REGION``,
``CF_VIDEO_BUCKET`` (empty while the us-east-1 bucket is off), ``CF_VIDEO_WEST_BUCKET`` (Luma AI Ray2's us-west-2
bucket, empty while ``stories_video_west_bucket`` is off, §45.37 G7) and ``CF_PROVIDER_KEYS_PREFIX`` (the workspaces'
secret prefix, ``cf-prod/workspaces/``: the owner's keys for the keyed hosts are read per call under
``{prefix}{workspaceId}/providers/{host}``, §45.37 G4); the image sets ``CF_STORIES_CONFIG_DIR``,
``CF_STORIES_SKILLS_DIR``, ``CF_STORIES_ENGINE_DIR`` and ``CF_WORK_DIR``. Nothing is called at import or at startup:
the AWS clients are made on their first call. ``get()`` is the one shared instance (the chat, tasks and reference
packages use the same ``models`` client and ``data``). Which picture, video and sound model a job uses is read from
the workspace for each job (§45.37 G1), never from the environment."""

from __future__ import annotations

import os
import threading
from functools import cache
from pathlib import Path
from typing import Any

from . import config
from . import hosts as keyed
from .data import StoryData
from .models import BedrockModels
from .pipeline import Services
from .store import Store

NOT_CONFIGURED = "Funded Clips' agent is missing its table or bucket setting."
PROVIDER_KEYS_PREFIX = "cf-prod/workspaces/"  # when the runtime's environment does not say (Terraform does)
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

    provider_keys = keyed.ProviderKeys(
        env.get("CF_PROVIDER_KEYS_PREFIX") or PROVIDER_KEYS_PREFIX, lambda: _client("secretsmanager", region)
    )
    models = BedrockModels(table=table_factory, get_bytes=store.get_bytes_sync, region=region, keys=provider_keys)
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
        bedrock_runtime=lambda r: _client("bedrock-runtime", r),
        bedrock_control=lambda r: _client("bedrock", r),
        s3_in=lambda r: _client("s3", r),
        video_west_bucket=env.get("CF_VIDEO_WEST_BUCKET", ""),
        provider_keys=provider_keys,
        http=keyed.https,
        polly=lambda r: _client("polly", r),
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
