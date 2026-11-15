"""Placeholder adapters: every platform reports "not connected" until its integration exists."""

from __future__ import annotations

from .base import Metrics, NotConnectedError, Published, Record

LABELS = {"youtube": "YouTube", "instagram": "Instagram", "facebook": "Facebook", "tiktok": "TikTok", "x": "X"}


class StubAdapter:
    def __init__(self, platform: str) -> None:
        self.platform = platform

    def _not_connected(self) -> NotConnectedError:
        label = LABELS.get(self.platform, self.platform)
        return NotConnectedError(f"Posting to {label} arrives in the next phase.")

    def publish(self, clip: Record, account: Record | None) -> Published:
        raise self._not_connected()

    def metrics(self, post: Record, account: Record | None) -> Metrics:
        raise self._not_connected()
