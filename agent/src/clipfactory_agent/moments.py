"""Clip moments: the schema Claude answers with, validation and clamping, de-duplication, and the final pick of
``clipTarget.min..max`` moments plus spares."""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .schema import check

MOMENT_TYPES = ["rage", "chaos", "interaction", "no_way", "first_reaction", "hot_take"]
DEFAULT_LENGTH = (20.0, 45.0)  # playbook A6
MAX_TEASE = 3.0

MOMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "start",
        "end",
        "moment_type",
        "hook",
        "first_words",
        "tease_start",
        "tease_end",
        "payoff_at",
        "peak_at",
        "why",
        "needs_context",
        "score",
        "people",
        "summary",
    ],
    "properties": {
        "start": {
            "type": "number",
            "description": "Clip start, seconds from the start of the video, just before the moment.",
        },
        "end": {"type": "number", "description": "Clip end in seconds, right on the payoff."},
        "moment_type": {"type": "string", "enum": MOMENT_TYPES},
        "hook": {"type": "string", "description": "On-screen text hook: 6–8 words that open a question, not a label."},
        "first_words": {
            "type": "string",
            "description": "What the viewer hears in the first second: the words, or the sound when nobody talks.",
        },
        "tease_start": {
            "type": ["number", "null"],
            "description": "Optional payoff tease: 1–2 s of the best line, played first. Seconds in the video, or null.",
        },
        "tease_end": {"type": ["number", "null"]},
        "payoff_at": {"type": "number", "description": "When the payoff happens, seconds in the video."},
        "peak_at": {"type": "number", "description": "The most intense second (used for the cover image)."},
        "why": {"type": "string", "description": "Why it works, in one sentence."},
        "needs_context": {"type": "boolean", "description": "True if a stranger would need earlier context to get it."},
        "score": {"type": "number", "description": "1–10: how likely it is to do well."},
        "people": {"type": "array", "items": {"type": "string"}, "description": "People clearly in the moment."},
        "summary": {"type": "string", "description": "One line: what happens."},
    },
}

CANDIDATES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["candidates"],
    "properties": {"candidates": {"type": "array", "maxItems": 8, "items": MOMENT_SCHEMA}},
}


@dataclass
class Moment:
    start: float
    end: float
    moment_type: str
    hook: str
    first_words: str
    payoff_at: float
    peak_at: float
    why: str
    score: float
    summary: str
    people: list[str] = field(default_factory=list)
    tease: tuple[float, float] | None = None
    picked_for: str | None = None  # why it was picked, in a few plain words; built by code (signals.picked_for)

    @property
    def length(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["tease"] = list(self.tease) if self.tease else None
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Moment:
        tease = d.get("tease")
        return cls(
            start=float(d["start"]),
            end=float(d["end"]),
            moment_type=str(d["moment_type"]),
            hook=str(d["hook"]),
            first_words=str(d.get("first_words", "")),
            payoff_at=float(d["payoff_at"]),
            peak_at=float(d["peak_at"]),
            why=str(d.get("why", "")),
            score=float(d["score"]),
            summary=str(d.get("summary", "")),
            people=[str(p) for p in d.get("people") or []],
            tease=(float(tease[0]), float(tease[1])) if tease else None,
            picked_for=str(d["picked_for"]) if d.get("picked_for") else None,
        )


def word_count(text: str) -> int:
    return len(text.split())


def length_target(notes: str | None) -> tuple[float, float]:
    """The clip length to aim for: the playbook's 20–45 s, unless the owner's notes name one ("15-30 seconds",
    "under 60 s")."""
    text = (notes or "").lower()
    unit = r"\s*(?:s|sec|secs|seconds?)\b"
    m = re.search(r"(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})" + unit, text)
    if m:
        lo, hi = sorted((float(m.group(1)), float(m.group(2))))
        if lo >= 5 and hi <= 180 and hi - lo >= 5:
            return lo, hi
    m = re.search(r"(?:under|max(?:imum)?|at most|no longer than|up to)\s*(\d{1,3})" + unit, text)
    if m:
        hi = float(m.group(1))
        if 8 <= hi <= 180:
            return min(DEFAULT_LENGTH[0], round(hi * 0.6)), hi
    return DEFAULT_LENGTH


def validate(raw: dict[str, Any], *, duration: float, length: tuple[float, float]) -> tuple[Moment | None, list[str]]:
    """A clean Moment from the model's answer, with its timing clamped to the length target, or the reasons it was
    rejected (worded for the model, so it can correct itself)."""
    problems = check(MOMENT_SCHEMA, raw)
    if problems:
        return None, problems
    lo, hi = length
    start, end = float(raw["start"]), float(raw["end"])
    payoff = float(raw["payoff_at"])
    if raw["needs_context"]:
        return None, ["needs_context is true: a stranger would not get it"]
    if not (0 <= start < end):
        return None, ["start must be before end and not negative"]
    if duration and start >= duration:
        return None, [f"start is past the end of the video ({duration:.0f} s)"]
    hook = " ".join(str(raw["hook"]).split())
    words = word_count(hook)
    if words < 4 or words > 10:
        return None, [f"the hook has {words} words; it must have 6–8"]
    if end - start > hi:
        end = start + hi
    if end - start < lo:
        end = start + lo
    if duration:
        end = min(end, duration)
        if end - start < max(5.0, lo * 0.5):
            return None, ["too close to the end of the video to make a full clip"]
    if payoff > end + 0.5 or payoff < start:
        return None, [f"payoff_at must fall inside the clip and the clip must be at most {hi:.0f} s"]
    tease: tuple[float, float] | None = None
    ts, te = raw.get("tease_start"), raw.get("tease_end")
    # The tease replays the payoff line, so it must come from inside the clip itself.
    if (
        ts is not None
        and te is not None
        and 0 < float(te) - float(ts) <= MAX_TEASE
        and start <= float(ts)
        and float(te) <= end
    ):
        tease = (float(ts), float(te))
    peak = float(raw["peak_at"])
    if not start <= peak <= end:
        peak = min(max(payoff, start), end)
    return (
        Moment(
            start=round(start, 2),
            end=round(end, 2),
            moment_type=str(raw["moment_type"]),
            hook=hook,
            first_words=str(raw["first_words"])[:300],
            payoff_at=round(payoff, 2),
            peak_at=round(peak, 2),
            why=str(raw["why"])[:500],
            score=max(1.0, min(10.0, float(raw["score"]))),
            summary=str(raw["summary"])[:300],
            people=[str(p)[:80] for p in raw.get("people") or []][:8],
            tease=tease,
        ),
        [],
    )


def overlaps(a: Moment, b: Moment) -> bool:
    return a.start < b.end and b.start < a.end


def dedupe(moments: list[Moment]) -> list[Moment]:
    """Overlapping moments (transcript windows overlap) keep only the higher score."""
    out: list[Moment] = []
    for m in sorted(moments, key=lambda m: -m.score):
        if not any(overlaps(m, o) for o in out):
            out.append(m)
    return out


def spare_count(n: int) -> int:
    return min(3, math.ceil(n / 2))


def choose(
    moments: list[Moment], clip_min: int, clip_max: int, good_score: float = 6.0
) -> tuple[list[Moment], list[Moment]]:
    """The clips to cut and the spares, best first.

    How many: every moment scoring ``good_score`` or more, but at least ``clip_min`` and at most ``clip_max`` (fewer
    only when fewer exist). Order: by score, with a small penalty for repeating a moment type, so the set is varied."""
    pool = dedupe(moments)
    good = sum(1 for m in pool if m.score >= good_score)
    want = max(clip_min, min(clip_max, good))
    ordered: list[Moment] = []
    used: dict[str, int] = {}
    rest = list(pool)
    while rest:
        best = max(rest, key=lambda m: m.score - 0.75 * used.get(m.moment_type, 0))
        rest.remove(best)
        ordered.append(best)
        used[best.moment_type] = used.get(best.moment_type, 0) + 1
    chosen = ordered[:want]
    spares = ordered[want : want + spare_count(len(chosen))]
    return chosen, spares
