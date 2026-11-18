"""The second look: plain facts about each clip, and the traits the winners share (docs/CONTRACTS.md §16.12).

Only what is stored is used. A fact that is not stored (for example the pacing of a clip made before finalize
started writing ``wordCount`` and ``firstWordSec``) is missing: the clip does not count for that trait at all, on
either side of the comparison.

A trait is a **candidate** when at least 3 winners share it, those winners come from at least 2 different source
videos, at least 10 other clips have the same kind of fact to compare with, and it is at least 1.5 times as common
among the winners as among those other clips (``learning_rules``). An "all creators" trait also needs winners from at
least 2 different creators.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .clock import parse
from .creators import ALL_CREATORS
from .learning_rules import (
    TRAIT_MIN_CREATORS_ALL,
    TRAIT_MIN_LIFT,
    TRAIT_MIN_OTHERS,
    TRAIT_MIN_SOURCES,
    TRAIT_MIN_WINNERS,
)
from .winners import Group, Measured

Item = dict[str, Any]

MOMENT_LABELS = {
    "rage": "rage moments",
    "chaos": "chaos moments",
    "interaction": "chat or friend interaction moments",
    "no_way": "“no way” moments",
    "first_reaction": "first reactions",
    "hot_take": "hot takes",
}
LAYOUT_LABELS = {"facecam_top": "the face cam on top", "blur_fill": "the game filling the screen"}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def hook_words(hook: Any) -> int | None:
    words = str(hook or "").split()
    return len(words) if words else None


def facts(m: Measured) -> Item:
    """The stored facts of one measured post's clip. Absent keys are missing facts, never 0."""
    clip = m.clip
    out: Item = {}
    if clip.get("momentType") in MOMENT_LABELS:
        out["momentType"] = clip["momentType"]
    length = _number(clip.get("durationSec"))
    if length is not None and length > 0:
        out["lengthSec"] = round(length, 1)
    if clip.get("layout") in LAYOUT_LABELS:
        out["layout"] = clip["layout"]
    if str(clip.get("hook") or "").strip():
        out["hook"] = str(clip["hook"]).strip()
        out["hookWords"] = hook_words(clip["hook"])
    words = _number(clip.get("wordCount"))
    if words is not None and length:
        out["wordsPerSecond"] = round(words / length, 1)
    first = _number(clip.get("firstWordSec"))
    if first is not None and first >= 0:
        out["firstWordSec"] = round(first, 1)
    score = _number(clip.get("score"))
    if score is not None:
        out["score"] = int(score)
    posted = parse(m.post.get("postedAt")) if m.post else m.posted_at
    if posted is not None:
        out["postedHourUtc"] = posted.hour
    return out


# Buckets per numeric fact: (upper bound, trait id, label); the first bound the value fits under wins (None = no
# bound). Buckets never overlap, so each known fact gives exactly one trait.
Bucket = tuple[float | None, str, str]
BUCKETS: dict[str, tuple[Bucket, ...]] = {
    "lengthSec": (
        (19.99, "length:under-20", "clips under 20 seconds"),
        (29.99, "length:20-30", "clips of 20 to 30 seconds"),
        (45, "length:30-45", "clips of 30 to 45 seconds"),
        (None, "length:over-45", "clips over 45 seconds"),
    ),
    "hookWords": (
        (5, "hook:short", "short hooks of 5 words or fewer"),
        (8, "hook:6-8", "hooks of 6 to 8 words"),
        (None, "hook:long", "long hooks of 9 words or more"),
    ),
    "wordsPerSecond": (
        (1.99, "pace:calm", "calm talking (under 2 words a second)"),
        (2.99, "pace:normal", "normal talking speed (2 to 3 words a second)"),
        (None, "pace:fast", "fast talking (3 or more words a second)"),
    ),
    "firstWordSec": (
        (0.5, "start:instant", "talking right away (in the first half second)"),
        (1.5, "start:quick", "talking within 1.5 seconds"),
        (None, "start:quiet", "a quiet first 1.5 seconds"),
    ),
    "score": (
        (4, "score:low", "clips the agent scored 4 or less"),
        (7, "score:mid", "clips the agent scored 5 to 7"),
        (None, "score:high", "clips the agent scored 8 or more"),
    ),
}


def _bucket(value: float, buckets: tuple[Bucket, ...]) -> tuple[str, str]:
    for bound, trait, label in buckets:
        if bound is None or value <= bound:
            return trait, label
    raise AssertionError("the last bucket has no bound")


def traits(f: Mapping[str, Any]) -> dict[str, str]:
    """trait id -> plain label, for the facts that are known. One trait per fact (buckets never overlap)."""
    out: dict[str, str] = {}
    if "momentType" in f:
        out[f"moment:{f['momentType']}"] = MOMENT_LABELS[f["momentType"]]
    if "layout" in f:
        out[f"layout:{f['layout']}"] = f"clips with {LAYOUT_LABELS[f['layout']]}"
    for fact, buckets in BUCKETS.items():
        if fact in f:
            trait, label = _bucket(float(f[fact]), buckets)
            out[trait] = label
    if "postedHourUtc" in f:
        start = int(f["postedHourUtc"]) // 6 * 6
        out[f"hour:{start:02d}"] = f"posts made between {start:02d}:00 and {start + 5:02d}:59 UTC"
    return out


def _family(trait: str) -> str:
    return trait.split(":", 1)[0]


@dataclass(frozen=True)
class Candidate:
    """A trait the winners share, with every count the code computed (never the model)."""

    platform: str
    trait: str
    label: str
    winners_with: int
    winners_known: int
    others_with: int
    others_known: int
    sources: int
    support: tuple[str, ...]  # post ids of the winners that have the trait
    support_clips: tuple[str, ...]

    @property
    def key(self) -> str:
        return f"{self.platform}|{self.trait}"

    @property
    def winner_percent(self) -> int:
        return round(100 * self.winners_with / self.winners_known) if self.winners_known else 0

    @property
    def other_percent(self) -> int:
        return round(100 * self.others_with / self.others_known) if self.others_known else 0


def supporting(group: Group, trait: str) -> list[Measured]:
    """The group's winners that have ``trait``."""
    return [w for w in group.winners if trait in traits(facts(w))]


def candidates(group: Group) -> list[Candidate]:
    """The traits that pass all three guards, best supported first."""
    if not group.winners:
        return []
    win_traits = [(w, traits(facts(w))) for w in group.winners]
    other_traits = [traits(facts(o)) for o in group.others]
    labels: dict[str, str] = {}
    for _, t in win_traits:
        labels.update(t)
    out: list[Candidate] = []
    for trait, label in labels.items():
        family = _family(trait)
        with_trait = [w for w, t in win_traits if trait in t]
        winners_known = sum(1 for _, t in win_traits if any(_family(k) == family for k in t))
        others_known = sum(1 for t in other_traits if any(_family(k) == family for k in t))
        others_with = sum(1 for t in other_traits if trait in t)
        sources = len({w.source_id for w in with_trait})
        if len(with_trait) < TRAIT_MIN_WINNERS or sources < TRAIT_MIN_SOURCES or not winners_known:
            continue
        if others_known < TRAIT_MIN_OTHERS:
            continue  # nothing (or too little) to compare with: no lift can be shown
        if group.creator_key == ALL_CREATORS and len({w.creator_key for w in with_trait}) < TRAIT_MIN_CREATORS_ALL:
            continue  # one channel's habit is not a lesson for every creator
        winner_rate = len(with_trait) / winners_known
        other_rate = others_with / others_known
        if winner_rate < TRAIT_MIN_LIFT * other_rate:
            continue
        out.append(
            Candidate(
                platform=group.platform,
                trait=trait,
                label=label,
                winners_with=len(with_trait),
                winners_known=winners_known,
                others_with=others_with,
                others_known=others_known,
                sources=sources,
                support=tuple(sorted(w.post_id for w in with_trait)),
                support_clips=tuple(sorted(w.clip_id for w in with_trait)),
            )
        )
    out.sort(key=lambda c: (-c.winners_with, -(c.winner_percent - c.other_percent), c.trait))
    return out


def clip_row(m: Measured, *, transcript_chars: int = 600) -> Item:
    """What the model sees about one clip: its stored facts, its day-7 views and the start of what is said."""
    row: Item = {"clipId": m.clip_id, "day7Views": m.views, **facts(m)}
    spoken = " ".join(str(m.clip.get("spokenText") or "").split())
    if spoken:
        row["transcript"] = spoken[:transcript_chars]
    return row


def as_rows(items: Sequence[Measured]) -> list[Item]:
    return [clip_row(m) for m in items]
