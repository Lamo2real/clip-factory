"""The checked guidance list (``stories/config/guidance.json``, docs/CONTRACTS.md §45.11.5, ADR-74).

A driving-safety story is made only from one topic of this list, and only from its **shown** steps and donts (a road
authority states them and no cited source contradicts them). Hidden steps are never given to the writer and never put
on screen; the video then says "Check your local road rules."."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import log

FILE = "guidance.json"


@dataclass(frozen=True)
class Topic:
    id: str
    title: str
    steps: list[dict[str, Any]]  # shown ones only: {id, text}
    donts: list[dict[str, Any]]  # shown ones only: {id, text}
    hidden: list[dict[str, Any]]  # {id, text, why}: never shown, given to the checker as "not checked"
    caveats: list[str]
    country_notes: str
    citations: list[dict[str, str]]  # {publisher, title, url, section?}

    @property
    def shown_ids(self) -> set[str]:
        return {str(s["id"]) for s in self.steps} | {str(d["id"]) for d in self.donts}

    def brief(self) -> dict[str, Any]:
        """What the writer gets: the shown steps and donts only, never a hidden one."""
        return {
            "topicId": self.id,
            "title": self.title,
            "steps": [{"id": s["id"], "text": s["text"]} for s in self.steps],
            "donts": [{"id": d["id"], "text": d["text"]} for d in self.donts],
            "endCard": "Check your local road rules.",
        }


@dataclass(frozen=True)
class Guidance:
    topics: dict[str, Topic]
    checked_at: str

    def topic(self, topic_id: str | None) -> Topic | None:
        return self.topics.get(topic_id) if topic_id else None

    def titles(self) -> list[str]:
        return [t.title for t in self.topics.values()]


def _citation(src: dict[str, Any]) -> dict[str, str]:
    out = {k: str(src[k]) for k in ("publisher", "title", "url") if src.get(k)}
    if src.get("section"):
        out["section"] = str(src["section"])
    return out


def parse(data: dict[str, Any]) -> Guidance:
    sources = data.get("sources") or {}
    topics: dict[str, Topic] = {}
    for t in data.get("topics") or []:
        tid = str(t.get("id") or "")
        if not tid:
            continue
        steps = [s for s in t.get("steps") or [] if s.get("shown") is True]
        donts = [d for d in t.get("donts") or [] if d.get("shown") is True]
        hidden = [
            {"id": s.get("id"), "text": s.get("text"), "why": s.get("why", "")}
            for s in [*(t.get("steps") or []), *(t.get("donts") or [])]
            if s.get("shown") is not True
        ]
        used: list[str] = []
        for s in [*steps, *donts]:
            for ref in s.get("sources") or []:
                if ref not in used:
                    used.append(ref)
        order = [c for c in t.get("citations") or [] if c in used] + [
            c for c in used if c not in (t.get("citations") or [])
        ]
        citations = [_citation(sources[c]) for c in order if isinstance(sources.get(c), dict)]
        topics[tid] = Topic(
            id=tid,
            title=str(t.get("title") or tid),
            steps=steps,
            donts=donts,
            hidden=hidden,
            caveats=[str(c) for c in t.get("caveats") or []],
            country_notes=str(t.get("countryNotes") or ""),
            citations=citations,
        )
    return Guidance(topics, str(data.get("checkedAt") or ""))


def load(config_dir: Path) -> Guidance:
    path = config_dir / FILE
    try:
        return parse(json.loads(path.read_text("utf-8")))
    except (OSError, ValueError) as e:
        log("error", "stories.guidance_missing", path=str(path), error=type(e).__name__)
        return Guidance({}, "")
