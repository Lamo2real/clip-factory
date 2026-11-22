"""The checked guidance list as the creative agents use it (docs/CONTRACTS.md §45.11.5, ADR-74).

Ideas and concepts about driving safety may only use a topic of ``stories/config/guidance.json`` and only its
**shown** steps and donts. Topic matching for saved ideas and stories stays the API's (§45.7); here a driving-safety
draft is kept only when its own words already name a topic by that same keyword rule, so saving it gives it its
checked advice.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from lamostories_agent import config

_BLOWOUT = re.compile(r"\b(?:blew|blown|blows|blowing|blow)\s*-?\s*out\b")


def topics() -> list[dict[str, Any]]:
    return [t for t in config.guidance().get("topics") or [] if isinstance(t, dict) and t.get("id")]


def topic(topic_id: str | None) -> dict[str, Any] | None:
    return next((t for t in topics() if t["id"] == topic_id), None) if topic_id else None


def choices() -> list[dict[str, str]]:
    """What a model may pick from: ids and titles only."""
    return [{"id": str(t["id"]), "title": str(t.get("title") or "")} for t in topics()]


def shown(t: dict[str, Any]) -> dict[str, Any]:
    """A topic's shown steps and donts only (a hidden one is never put on screen), with its caveats."""
    return {
        "id": t["id"],
        "title": t.get("title"),
        "steps": [{"id": s.get("id"), "text": s.get("text")} for s in t.get("steps") or [] if s.get("shown")],
        "donts": [{"id": d.get("id"), "text": d.get("text")} for d in t.get("donts") or [] if d.get("shown")],
        "caveats": list(t.get("caveats") or []),
    }


def publishers(t: dict[str, Any]) -> list[str]:
    """The publishers a topic's shown advice cites, in order (for the post descriptions)."""
    raw = config.guidance().get("sources") or {}
    sources: dict[str, Any] = (
        raw if isinstance(raw, dict) else {str(s.get("id")): s for s in raw if isinstance(s, dict)}
    )
    ids: list[str] = []
    for line in [*(t.get("steps") or []), *(t.get("donts") or [])]:
        if line.get("shown"):
            ids += [str(s) for s in line.get("sources") or []]
    ids += [str(c) if not isinstance(c, dict) else str(c.get("id") or "") for c in t.get("citations") or []]
    out: list[str] = []
    for sid in ids:
        pub = (sources.get(sid) or {}).get("publisher")
        if pub and pub not in out:
            out.append(str(pub))
    return out


def _pattern(keyword: str) -> re.Pattern[str]:
    words = [re.escape(w) for w in keyword.lower().split()]
    return re.compile(r"(?<![a-z0-9])" + r"\s+".join(words) + r"(?:s|es|d|ed|ing|ded|ding)?(?![a-z0-9])")


def keyword_match(texts: Iterable[str | None]) -> str | None:
    """The topic the words are about by the keyword rule (each keyword counts its number of words), else None."""
    text = _BLOWOUT.sub("blowout", " ".join(t for t in texts if t).lower().replace("-", " "))
    best, best_id = 0, None
    for t in topics():
        score = sum(len(str(k).split()) for k in t.get("keywords") or [] if _pattern(str(k)).search(text))
        if score > best:
            best, best_id = score, str(t["id"])
    return best_id
