"""The owner's learnings (docs/CONTRACTS.md §5 Learning, §16.7): what worked on earlier posts, distilled after 48
hours, and the "Best of week" learnings written from the owner's weekly picks. The latest four best-of-week learnings
and the latest ten others go into the moment-selection prompt, best-of-week first."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

FETCH = 50  # newest LEARNING# items read per job
LIMIT = 10  # other learnings in the prompt
WEEK_LIMIT = 4  # "Best of week" learnings in the prompt
MAX_CHARS = 500
WEEK_HEADING = "The owner's best-of-week picks taught"
OTHER_HEADING = "Learnings"


class LearningSource(Protocol):
    async def latest_learnings(self, user_id: str, n: int = LIMIT) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class Learnings:
    """The two groups of the prompt, newest first."""

    week: list[str] = field(default_factory=list)
    other: list[str] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.week) + len(self.other)


def _newest_first(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # A re-learned week keeps its learningId but gets a new createdAt, so createdAt decides; the id breaks ties.
    return sorted(rows, key=lambda r: (str(r.get("createdAt") or ""), str(r.get("learningId") or "")), reverse=True)


def texts(rows: list[dict[str, Any]], limit: int = LIMIT) -> list[str]:
    """Newest first, one line each, empty ones dropped."""
    out = [" ".join(str(r.get("text") or "").split())[:MAX_CHARS] for r in _newest_first(rows)]
    return [t for t in out if t][:limit]


def split(rows: list[dict[str, Any]]) -> Learnings:
    """The latest four ``kind == "week"`` learnings and the latest ten others."""
    week = [r for r in rows if r.get("kind") == "week"]
    other = [r for r in rows if r.get("kind") != "week"]
    return Learnings(week=texts(week, WEEK_LIMIT), other=texts(other, LIMIT))


def prompt_section(learnings: Learnings) -> str:
    """Both groups under their headings, best-of-week first; an empty group is left out (all empty → "")."""
    parts = []
    if learnings.week:
        parts.append(
            f"{WEEK_HEADING} (most recent first; these come from the clips the owner starred as the best of each "
            "week, so they matter most):\n" + "\n".join(f"- {t}" for t in learnings.week)
        )
    if learnings.other:
        parts.append(
            f"{OTHER_HEADING} from earlier clips (most recent first; apply what fits):\n"
            + "\n".join(f"- {t}" for t in learnings.other)
        )
    return "\n\n".join(parts)


async def load(store: LearningSource, user_id: str) -> Learnings:
    return split(await store.latest_learnings(user_id, FETCH))
