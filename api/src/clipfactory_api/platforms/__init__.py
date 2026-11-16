"""Platform adapters by name (docs/CONTRACTS.md §14.5, §16.5, §17.6).

Each platform has its real stats adapter; posting goes through ``publishers`` (start → check → finish) and
``errors`` maps platform answers to plain sentences. The default token provider reports "not connected"; the Lambdas
pass ``oauth.tokens.SecretsTokenProvider`` (``make_adapters(tokens=...)``), so nothing reaches a platform without a
connected account.
"""

from __future__ import annotations

from .base import (
    AdapterBase,
    HttpClient,
    HttpRequest,
    HttpResponse,
    Metrics,
    NotConnectedError,
    PlatformAdapter,
    Published,
    PublishError,
    ResponseMeta,
    RetryablePublishError,
    StatsAdapter,
    StatsBatch,
    TokenProvider,
    no_tokens,
)
from .facebook import FacebookAdapter
from .instagram import InstagramAdapter
from .stub import LABELS, StubAdapter
from .tiktok import TikTokAdapter
from .x import XAdapter
from .youtube import YouTubeAdapter

PLATFORMS: tuple[str, ...] = ("youtube", "instagram", "facebook", "tiktok", "x")
ADAPTER_CLASSES: dict[str, type[AdapterBase]] = {
    "youtube": YouTubeAdapter,
    "tiktok": TikTokAdapter,
    "instagram": InstagramAdapter,
    "facebook": FacebookAdapter,
    "x": XAdapter,
}


def make_adapters(*, tokens: TokenProvider = no_tokens, graph_api_version: str = "v27.0") -> dict[str, AdapterBase]:
    return {name: cls(tokens=tokens, graph_api_version=graph_api_version) for name, cls in ADAPTER_CLASSES.items()}


_ADAPTERS: dict[str, AdapterBase] = make_adapters()


def adapter_for(platform: str) -> AdapterBase:
    try:
        return _ADAPTERS[platform]
    except KeyError as e:
        raise NotConnectedError(f"Unknown platform: {platform}.") from e


def label(platform: str) -> str:
    return LABELS.get(platform, platform)


__all__ = [
    "ADAPTER_CLASSES",
    "PLATFORMS",
    "AdapterBase",
    "HttpClient",
    "HttpRequest",
    "HttpResponse",
    "Metrics",
    "NotConnectedError",
    "PlatformAdapter",
    "PublishError",
    "Published",
    "ResponseMeta",
    "RetryablePublishError",
    "StatsAdapter",
    "StatsBatch",
    "StubAdapter",
    "adapter_for",
    "label",
    "make_adapters",
]
