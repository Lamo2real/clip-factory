"""Clip moments: the schema Claude answers with, validation and clamping, de-duplication, and the final pick of
``clipTarget.min..max`` moments plus spares."""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from .schema import check

if TYPE_CHECKING:
    from .campaign import Campaign

MOMENT_TYPES = ["rage", "chaos", "interaction", "no_way", "first_reaction", "hot_take"]
DEFAULT_LENGTH = (20.0, 45.0)  # the default length target
MAX_TEASE = 3.0
# "Your take" (docs/CONTRACTS.md, owner request 2026-11-27): the channel's own one-sentence comment on a moment. The
# model is asked for 5–14 words; code accepts 4–16 and at most 90 characters.
TAKE_WORDS = (4, 16)
TAKE_MAX_CHARS = 90
TAKE_STYLE_MAX = 120
# How ``validate`` treats the take: "off" always blanks it (the job has none), "keep" keeps a good one and blanks a bad
# one, "strict" does the same and also says why (the moment is kept with no take and comes back with the reason, so the
# model can send it again with a better one; a moment is never lost over its take).
TakeMode = Literal["off", "keep", "strict"]

MOMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "start",
        "end",
        "moment_type",
        "hook",
        "take",
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
        "take": {
            "type": "string",
            "description": "The channel's own one-sentence comment on the moment: 5–14 words, at most 90 characters. "
            "It adds what the viewer cannot see; it never describes the picture or repeats the hook. Empty when the "
            "rules say this job has no take.",
        },
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
    take: str = ""  # "Your take": the channel's own one-sentence comment; empty when the clip has none

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
            take=str(d.get("take") or ""),
        )


def word_count(text: str) -> int:
    return len(text.split())


# Emoji and other pictographs (category So), their joiners, selectors and skin tones, and every control, format,
# private-use and unassigned character.
_DROP_CATEGORIES = {"So", "Cc", "Cf", "Cs", "Co", "Cn"}
_EMOJI_PARTS = re.compile("[\ufe00-\ufe0f\u20e3\U0001f3fb-\U0001f3ff\U000e0020-\U000e007f]")


def clean_take(text: object) -> str:
    """A take as it may be shown and spoken: no emoji, no control characters, single spaces."""
    if not isinstance(text, str):
        return ""
    spaced = "".join(" " if c in "\n\r\t" else c for c in _EMOJI_PARTS.sub("", text))
    return " ".join("".join(c for c in spaced if unicodedata.category(c) not in _DROP_CATEGORIES).split())


def take_problem(take: str) -> str | None:
    """Why a cleaned take can't be used, worded for the model, or None when it can."""
    words = word_count(take)
    lo, hi = TAKE_WORDS
    if words < lo or words > hi:
        return f"the take has {words} words; it must be one sentence of 5–14 words"
    if len(take) > TAKE_MAX_CHARS:
        return f"the take has {len(take)} characters; it must have at most {TAKE_MAX_CHARS}"
    if "#" in take or "@" in take:
        return "the take must have no hashtags and no @handles"
    letters = [c for c in take if c.isalpha()]
    if len(letters) >= 4 and all(c.isupper() for c in letters):
        return "the take must not be in all caps"
    return None


def clean_style(text: object) -> str:
    """The owner's few words on how they talk (the ``takeStyle`` setting), as the prompt shows them."""
    return clean_take(text)[:TAKE_STYLE_MAX].strip()


_UNIT = r"\s*(?:s|sec|secs|seconds?)\b"
# "at least 7 seconds", "minimum 30 s", "over 20 sec", "longer than 15 seconds" and "30+ seconds". A "min" right after
# a number ("10 min 30 sec") is minutes, not a minimum.
_AT_LEAST = re.compile(
    r"(?:\bat least|\bminimum|(?<!\d\s)\bmin\.?|\b(?P<over>over|longer than))\s*(?P<n>\d{1,3})" + _UNIT
)
_PLUS = re.compile(r"(?P<n>\d{1,3})\s*\+" + _UNIT)
# The words just before a hit that turn it around: "never over 60 seconds", "no clips over 50 seconds", "don't go
# over 45 sec", "shouldn't be longer than 50 seconds" (up to three words between, but never across "and"/"but").
_NEGATED = re.compile(
    r"(?:\b(?:no|not|never|nothing|none|without)\b|n[’']t)(?:\s+(?!(?:and|but|or|then)\b)\w+){0,3}\s*$"
)
_AT_MOST = re.compile(r"(?:under|max(?:imum)?|at most|no longer than|up to)\s*(\d{1,3})" + _UNIT)
MAX_LENGTH = 180.0


def _under(hi: float) -> tuple[float, float]:
    """Today's rule for a maximum alone: aim a little under it, never above the default's minimum."""
    return min(DEFAULT_LENGTH[0], round(hi * 0.6)), hi


def _at_least(lo: float) -> tuple[float, float]:
    """A minimum alone: from it to at least 15 s more (and 45 s), capped at MAX_LENGTH."""
    return lo, max(lo, min(MAX_LENGTH, max(lo + 15, 45.0)))


def _notes_bounds(text: str) -> tuple[float | None, float | None]:
    """The first minimum and the first maximum the notes name. "over"/"longer than" after a "no", "not", "never" or
    "n't" is a maximum ("never over 60 seconds"); any other turned-around minimum is left out."""
    least: float | None = None
    most: tuple[int, float] | None = None
    hits = sorted([*_AT_LEAST.finditer(text), *_PLUS.finditer(text)], key=lambda h: h.start())
    for h in hits:
        n = float(h.group("n"))
        if _NEGATED.search(text[: h.start()]):
            if h.re is _AT_LEAST and h.group("over") and most is None:
                most = (h.start(), n)
        elif least is None and 1 <= n <= MAX_LENGTH - 15:
            least = n
    m = _AT_MOST.search(text)
    if m and (most is None or m.start() < most[0]):
        most = (m.start(), float(m.group(1)))
    return least, most[1] if most else None


def length_target(notes: str | None, campaign: Campaign | None = None) -> tuple[float, float]:
    """The clip length to aim for: the default 20–45 s, unless the owner's notes name one ("15-30 seconds",
    "under 60 s", "at least 30 seconds"). A campaign's own length (``lengthMinSec``/``lengthMaxSec``, §38.13) wins
    over both."""
    if campaign is not None:
        lo_c, hi_c = campaign.length
        if lo_c is not None and hi_c is not None:
            return lo_c, hi_c
        if lo_c is not None:
            return _at_least(lo_c)
        if hi_c is not None:
            return _under(hi_c)
    text = (notes or "").lower()
    m = re.search(r"(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})" + _UNIT, text)
    if m:
        lo, hi = sorted((float(m.group(1)), float(m.group(2))))
        if lo >= 5 and hi <= 180 and hi - lo >= 5:
            return lo, hi
    least, most = _notes_bounds(text)
    if most is not None and 8 <= most <= 180:
        if least is not None and least + 5 <= most:
            return least, most
        return _under(most)
    if least is not None:
        return _at_least(least)
    return DEFAULT_LENGTH


def validate(
    raw: dict[str, Any], *, duration: float, length: tuple[float, float], take: TakeMode = "keep"
) -> tuple[Moment | None, list[str]]:
    """A clean Moment from the model's answer, with its timing clamped to the length target, or the reasons it was
    rejected (worded for the model, so it can correct itself). ``take`` says what happens to the moment's take
    (``TakeMode``); an answer without one (a saved moment from before takes) is read as an empty take. In "strict" mode
    a moment whose only fault is its take comes back with an empty take AND the reason, so the caller keeps it and can
    still ask for a better take."""
    if isinstance(raw, dict) and "take" not in raw:
        raw = {**raw, "take": ""}
    problems = check(MOMENT_SCHEMA, raw)
    if problems:
        return None, problems
    own = "" if take == "off" else clean_take(raw["take"])
    notes: list[str] = []
    if own and (bad := take_problem(own)):
        notes = [bad]
        own = ""
    elif take == "strict" and not own:
        notes = ["the take is empty; write one sentence of 5–14 words"]
    if take != "strict":
        notes = []
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
            take=own,
        ),
        notes,
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
