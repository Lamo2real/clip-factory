"""The owner's learnings (docs/CONTRACTS.md §5 Learning): what worked on earlier posts, distilled after 48 hours.
The latest ten go into the moment-selection prompt."""

from __future__ import annotations

from typing import Any, Protocol

LIMIT = 10
MAX_CHARS = 500


class LearningSource(Protocol):
    async def latest_learnings(self, user_id: str, n: int = LIMIT) -> list[dict[str, Any]]: ...


def texts(rows: list[dict[str, Any]], limit: int = LIMIT) -> list[str]:
    """Newest first, one line each, empty ones dropped."""
    newest = sorted(rows, key=lambda r: str(r.get("learningId") or r.get("createdAt") or ""), reverse=True)
    out = [" ".join(str(r.get("text") or "").split())[:MAX_CHARS] for r in newest]
    return [t for t in out if t][:limit]


async def load(store: LearningSource, user_id: str) -> list[str]:
    return texts(await store.latest_learnings(user_id, LIMIT))
