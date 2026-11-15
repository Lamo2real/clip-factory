"""Platform adapters by name. Phase 2 replaces a stub here with a real adapter, one platform at a time."""

from __future__ import annotations

from .base import Metrics, NotConnectedError, PlatformAdapter, Published, PublishError, RetryablePublishError
from .stub import LABELS, StubAdapter

PLATFORMS: tuple[str, ...] = ("youtube", "instagram", "facebook", "tiktok", "x")

_ADAPTERS: dict[str, PlatformAdapter] = {name: StubAdapter(name) for name in PLATFORMS}


def adapter_for(platform: str) -> PlatformAdapter:
    try:
        return _ADAPTERS[platform]
    except KeyError as e:
        raise NotConnectedError(f"Unknown platform: {platform}.") from e


def label(platform: str) -> str:
    return LABELS.get(platform, platform)


__all__ = [
    "PLATFORMS",
    "Metrics",
    "NotConnectedError",
    "PlatformAdapter",
    "PublishError",
    "Published",
    "RetryablePublishError",
    "adapter_for",
    "label",
]
