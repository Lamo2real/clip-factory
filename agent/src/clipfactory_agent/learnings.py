"""What the agent is told it learned (docs/CONTRACTS.md §16.7, §16.12; docs/AGENT.md "Learnings loop").

Two groups reach the prompts, in this order, right after the skills block:

1. **Prior learnings** (``prior_section``): the creator lessons the daily run is sure about (``LESSON#`` items,
   ``kind "creator"``, status ``active`` and not expired) for this job's creator, then the active "all creators"
   ones. Plain patterns, one per line, under the exact heading "Prior learnings": the input the owner's clipper
   skill accepts. No lessons → no section at all (never an empty heading). Trial, turned off, deleted and expired
   lessons are never given. They go into the moment-picking prompt and every call that picks moments or writes hooks
   (the second look against the picture, which keeps, swaps or drops moments and can write a new hook; the checklist
   review, which can write a new hook; and the captions). The watchers that only report what is seen get none.
2. **The owner's best-of-week picks** (``prompt_section``): the latest four "Best of week" learnings, moment-picking
   prompt only.

The one-sentence 48-hour learnings (Learning items without ``kind``) are retired: they read too much into a handful of
clips, so they never reach a prompt any more. They stay readable on Insights as older notes.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .creators import ALL_CREATORS

FETCH = 50  # newest LEARNING# items read per job
WEEK_LIMIT = 4  # "Best of week" learnings in the prompt
MAX_CHARS = 500
WEEK_HEADING = "The owner's best-of-week picks taught"
PRIOR_HEADING = "Prior learnings"
PRIOR_NOTE = (
    "Patterns from this creator's past clips that did far better than normal 7 days after posting. Advice, never a "
    "rule: lean toward them when picking moments and writing hooks, and follow the owner's skills and notes first."
)
MAX_PRIOR = 10  # 5 active per creator + 5 active for all creators (the daily run caps each at 5)


class LearningSource(Protocol):
    async def latest_learnings(self, user_id: str, n: int = FETCH) -> list[dict[str, Any]]: ...

    async def creator_lessons(self, user_id: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class Learnings:
    """The groups of the prompts."""

    week: list[str] = field(default_factory=list)
    prior: list[str] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.week) + len(self.prior)


def _newest_first(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # A re-learned week keeps its learningId but gets a new createdAt, so createdAt decides; the id breaks ties.
    return sorted(rows, key=lambda r: (str(r.get("createdAt") or ""), str(r.get("learningId") or "")), reverse=True)


def _line(text: Any) -> str:
    return " ".join(str(text or "").split())[:MAX_CHARS]


def texts(rows: list[dict[str, Any]], limit: int) -> list[str]:
    """Newest first, one line each, empty ones dropped."""
    out = [_line(r.get("text")) for r in _newest_first(rows)]
    return [t for t in out if t][:limit]


def week_texts(rows: list[dict[str, Any]]) -> list[str]:
    """The latest four ``kind == "week"`` learnings. Learnings without a kind (the retired 48-hour ones) are left out."""
    return texts([r for r in rows if r.get("kind") == "week"], WEEK_LIMIT)


def _active(row: Mapping[str, Any], now: datetime) -> bool:
    if row.get("kind") != "creator" or row.get("status") != "active":
        return False
    try:
        expires = datetime.fromisoformat(str(row.get("expiresAt") or "").replace("Z", "+00:00"))
    except ValueError:
        return False  # no expiry: not a lesson the daily run wrote, so not one to trust
    return expires > now


def prior_texts(rows: Iterable[Mapping[str, Any]], creator_keys: Iterable[str], now: datetime) -> list[str]:
    """Active lessons for this job's creator (any of its keys) first, then active "all creators" lessons. Best
    supported first inside each group; the same text once."""
    keys = set(creator_keys)
    live = [r for r in rows if _active(r, now)]

    def order(r: Mapping[str, Any]) -> tuple[int, str, str]:
        return (-len(r.get("supportPostIds") or []), str(r.get("confirmedAt") or ""), str(r.get("lessonId") or ""))

    mine = sorted((r for r in live if r.get("creatorKey") in keys), key=order)
    everyone = sorted((r for r in live if r.get("creatorKey") == ALL_CREATORS), key=order)
    out: list[str] = []
    for r in [*mine, *everyone]:
        line = _line(r.get("text"))
        if line and line not in out:
            out.append(line)
    return out[:MAX_PRIOR]


def prior_section(prior: list[str]) -> str:
    """The "Prior learnings" input: heading, one-line note, one plain pattern per line. "" when there are none."""
    if not prior:
        return ""
    return f"{PRIOR_HEADING}\n{PRIOR_NOTE}\n" + "\n".join(f"- {t}" for t in prior)


def with_prior(prior: list[str], task_system: str) -> str:
    """A task's own system prompt with "Prior learnings" first, so it sits right after the skills block."""
    section = prior_section(prior)
    return f"{section}\n\n{task_system}" if section else task_system


def prompt_section(learnings: Learnings) -> str:
    """The best-of-week group under its heading ("" when there is none). Prior learnings go first separately."""
    if not learnings.week:
        return ""
    return (
        f"{WEEK_HEADING} (most recent first; these come from the clips the owner starred as the best of each week, so "
        "they matter most):\n" + "\n".join(f"- {t}" for t in learnings.week)
    )


async def load(store: LearningSource, user_id: str, creator_keys: Iterable[str], now: datetime) -> Learnings:
    week = week_texts(await store.latest_learnings(user_id, FETCH))
    prior = prior_texts(await store.creator_lessons(user_id), creator_keys, now)
    return Learnings(week=week, prior=prior)
