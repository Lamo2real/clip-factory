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


def lines(words: Sequence[Word], start: float, end: float) -> str:
    """``[0:12:34] words…`` lines of about 8 seconds, broken at sentence ends."""
    out: list[tuple[float, str]] = []
    cur_t: float | None = None
    cur: list[str] = []
    for w in words:
        s, text = float(w[0]), str(w[2])
        if s < start or s >= end:
            continue
        if cur_t is None or s - cur_t > 8 or (cur and _SENTENCE_END.search(cur[-1]) and s - cur_t > 4):
            if cur_t is not None:
                out.append((cur_t, " ".join(cur)))
            cur_t, cur = s, [text]
        else:
            cur.append(text)
    if cur_t is not None:
        out.append((cur_t, " ".join(cur)))
    return "\n".join(f"[{hms(t)}] {text}" for t, text in out)


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
