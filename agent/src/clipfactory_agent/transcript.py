"""Transcript text for prompts: timestamped lines and the windows a long transcript is read in."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from .util import hms

Word = Sequence[Any]  # [start, end, word]
WINDOW = 30 * 60
OVERLAP = 60
_SENTENCE_END = re.compile(r"[.?!]$")


def _speaker_at(turns: Sequence[Sequence[Any]], i: int, t: float) -> tuple[int, str | None]:
    """The speaker talking at ``t``; ``i`` is where the last lookup stopped (words come in time order)."""
    while i < len(turns) and float(turns[i][1]) <= t:
        i += 1
    if i < len(turns) and float(turns[i][0]) <= t + 0.05:
        return i, str(turns[i][2])
    return i, None


def timed_lines(
    words: Sequence[Word], start: float, end: float, speakers: Sequence[Sequence[Any]] | None = None
) -> list[tuple[float, str]]:
    """``(time, text)`` lines of about 8 seconds, broken at sentence ends. With ``speakers`` (``[start, end, "S1"]``
    turns) a line also breaks when the speaker changes and starts with ``S1:``."""
    out: list[tuple[float, str]] = []
    cur_t: float | None = None
    cur: list[str] = []
    cur_who: str | None = None
    turn = 0

    def flush() -> None:
        if cur_t is not None:
            text = " ".join(cur)
            out.append((cur_t, f"{cur_who}: {text}" if cur_who else text))

    for w in words:
        s, text = float(w[0]), str(w[2])
        if s < start or s >= end:
            continue
        who: str | None = None
        if speakers:
            turn, who = _speaker_at(speakers, turn, s)
            who = who or cur_who
        changed = bool(speakers) and cur_t is not None and who != cur_who
        if cur_t is None or changed or s - cur_t > 8 or (cur and _SENTENCE_END.search(cur[-1]) and s - cur_t > 4):
            flush()
            cur_t, cur, cur_who = s, [text], who
        else:
            cur.append(text)
    flush()
    return out


def lines(words: Sequence[Word], start: float, end: float, speakers: Sequence[Sequence[Any]] | None = None) -> str:
    """``[0:12:34] words…`` lines (see ``timed_lines``). Without ``speakers`` the text is what it always was."""
    return "\n".join(f"[{hms(t)}] {text}" for t, text in timed_lines(words, start, end, speakers))


def windows(total: float, size: float = WINDOW, overlap: float = OVERLAP) -> list[tuple[float, float]]:
    """``[start, end)`` windows covering ``total`` seconds, each overlapping the next a little so a moment that
    straddles a boundary is seen whole."""
    out: list[tuple[float, float]] = []
    t = 0.0
    while t < total:
        out.append((t, min(total, t + size + overlap)))
        t += size
    return out


def duration_of(words: Sequence[Word]) -> float:
    return float(words[-1][1]) if words else 0.0
