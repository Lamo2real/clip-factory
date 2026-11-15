"""The interface every social platform adapter implements (real ones arrive in phase 2).

Adapters run inside the durable ``cf-prod-clip-flow`` (docs/CONTRACTS.md §14.5). A publish step can run more than
once (steps are at-least-once), so an adapter that can pass ``idempotency_key`` to its platform sets
``idempotent = True``; the flow then retries it freely. One that cannot sets ``idempotent = False`` and the flow
runs each attempt at most once.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

Record = dict[str, Any]


class NotConnectedError(Exception):
    """No usable account for this platform; the post waits as ``pending_integration``."""


class PublishError(Exception):
    """The platform refused the post for good (a bad video, a policy block): retrying cannot help."""


class RetryablePublishError(PublishError):
    """A passing problem (rate limit, platform outage, network): the flow tries the step again."""


@dataclass(frozen=True)
class Published:
    url: str
    posted_at: str


@dataclass(frozen=True)
class Metrics:
    views: int
    likes: int
    comments: int
    shares: int


class PlatformAdapter(Protocol):
    platform: str
    idempotent: bool

    def publish(self, clip: Record, account: Record | None, *, idempotency_key: str) -> Published: ...

    def metrics(self, post: Record, account: Record | None) -> Metrics: ...
