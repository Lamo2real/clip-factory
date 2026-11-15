"""The interface every social platform adapter implements (real ones arrive in phase 2)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

Record = dict[str, Any]


class NotConnectedError(Exception):
    """No usable account for this platform; the post waits as ``pending_integration``."""


class PublishError(Exception):
    """The platform refused the post. ``retryable`` errors are left to SQS to try again."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


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

    def publish(self, clip: Record, account: Record | None) -> Published: ...

    def metrics(self, post: Record, account: Record | None) -> Metrics: ...
