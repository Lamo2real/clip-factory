"""The checked guidance list for driving-safety stories (docs/CONTRACTS.md §45.11.5, ADR-74).

``config/stories-guidance.json`` is bundled into the API zip as ``clipfactory_api/config/stories-guidance.json``
(``scripts/build_lambda.py`` validates it with ``parse``); the repository copy is the fallback in tests. Topic
matching happens once, here: an idea or story of category ``driving_safety`` gets ``safetyTopicId`` from the topics'
``keywords`` (and the model's pick, checked against the list); with no match it ``needsGuidance`` and cannot be made.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

_PARENTS = Path(__file__).resolve().parents
REPO_FILE = (_PARENTS[4] if len(_PARENTS) > 4 else Path("/nonexistent")) / "config" / "stories-guidance.json"
NO_GUIDANCE = "Lamo Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet."


class GuidanceError(ValueError):
    """``stories-guidance.json`` is missing a value or holds one the app cannot use."""


@dataclass(frozen=True)
class Topic:
    id: str
    title: str
    keywords: tuple[str, ...]
    raw: Mapping[str, Any]


@dataclass(frozen=True)
class Guidance:
    checked_at: str
    topics: tuple[Topic, ...]
    sources: Mapping[str, Mapping[str, Any]]

    def ids(self) -> list[str]:
        return [t.id for t in self.topics]

    def topic(self, topic_id: str | None) -> Topic | None:
        return next((t for t in self.topics if t.id == topic_id), None)


def _text(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GuidanceError(f"{where} must be text")
    return value


def _lines(raw: Mapping[str, Any], key: str, where: str, sources: Mapping[str, Any]) -> None:
    items = raw.get(key)
    if not isinstance(items, list):
        raise GuidanceError(f"{where}.{key} must be a list")
    for n, line in enumerate(items):
        here = f"{where}.{key}[{n}]"
        if not isinstance(line, dict):
            raise GuidanceError(f"{here} must be an object")
        _text(line.get("id"), f"{here}.id")
        _text(line.get("text"), f"{here}.text")
        if not isinstance(line.get("shown"), bool):
            raise GuidanceError(f"{here}.shown must be true or false")
        refs = line.get("sources")
        if not isinstance(refs, list) or not refs or any(r not in sources for r in refs):
            raise GuidanceError(f"{here}.sources must name known sources")
        if not line["shown"] and not isinstance(line.get("why"), str):
            raise GuidanceError(f"{here} is hidden, so it needs a why")


def parse(data: Any) -> Guidance:
    """Validates the whole file: every topic, step, dont and source. A bad edit fails the build, never a request."""
    if not isinstance(data, dict):
        raise GuidanceError("stories-guidance.json must hold one object")
    sources = data.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise GuidanceError("sources must be a non-empty object")
    for ref, source in sources.items():
        if not isinstance(source, dict):
            raise GuidanceError(f"sources.{ref} must be an object")
        for key in ("publisher", "title", "url", "quote"):
            _text(source.get(key), f"sources.{ref}.{key}")
        if not str(source["url"]).startswith("https://"):
            raise GuidanceError(f"sources.{ref}.url must be an https link")
    raw_topics = data.get("topics")
    if not isinstance(raw_topics, list) or not raw_topics:
        raise GuidanceError("topics must be a non-empty list")
    topics: list[Topic] = []
    seen: set[str] = set()
    for n, raw in enumerate(raw_topics):
        where = f"topics[{n}]"
        if not isinstance(raw, dict):
            raise GuidanceError(f"{where} must be an object")
        topic_id = _text(raw.get("id"), f"{where}.id")
        if topic_id in seen:
            raise GuidanceError(f"{where}.id {topic_id} is used twice")
        seen.add(topic_id)
        keywords = raw.get("keywords")
        if not isinstance(keywords, list) or not keywords or not all(isinstance(k, str) and k for k in keywords):
            raise GuidanceError(f"{where}.keywords must be a non-empty list of words")
        _lines(raw, "steps", where, sources)
        _lines(raw, "donts", where, sources)
        if not any(s["shown"] for s in raw["steps"]):
            raise GuidanceError(f"{where} shows no step")
        caveats = raw.get("caveats", [])
        if not isinstance(caveats, list) or not all(isinstance(c, str) for c in caveats):
            raise GuidanceError(f"{where}.caveats must be a list of text")
        citations = raw.get("citations", [])
        if not isinstance(citations, list) or any(c not in sources for c in citations):
            raise GuidanceError(f"{where}.citations must name known sources")
        topics.append(
            Topic(topic_id, _text(raw.get("title"), f"{where}.title"), tuple(k.lower() for k in keywords), raw)
        )
    checked = data.get("checkedAt")
    return Guidance(_text(checked, "checkedAt"), tuple(topics), sources)


def _read_text() -> str:
    packaged = resources.files("clipfactory_api").joinpath("config", "stories-guidance.json")
    if packaged.is_file():
        return packaged.read_text(encoding="utf-8")
    if REPO_FILE.is_file():
        return REPO_FILE.read_text(encoding="utf-8")
    raise GuidanceError("config/stories-guidance.json was not found")


def load(path: Path | None = None) -> Guidance:
    if path is not None:
        return parse(json.loads(path.read_text(encoding="utf-8")))
    return _load_cached()


@cache
def _load_cached() -> Guidance:
    return parse(json.loads(_read_text()))


# --- the public shape (GuidanceTopic, §45.6) -------------------------------------------------------------------


def _citation(source: Mapping[str, Any]) -> dict[str, str]:
    out = {"publisher": str(source["publisher"]), "title": str(source["title"]), "url": str(source["url"])}
    if isinstance(source.get("section"), str) and source["section"]:
        out["section"] = source["section"]
    return out


def citations(g: Guidance, topic: Topic) -> list[dict[str, str]]:
    """The topic's sources, resolved: its own citations first, then every step's and dont's, each once."""
    refs: list[str] = list(topic.raw.get("citations", []))
    for key in ("steps", "donts"):
        for line in topic.raw.get(key, []):
            refs.extend(line.get("sources", []))
    return [_citation(g.sources[r]) for r in dict.fromkeys(refs) if r in g.sources]


def _line(raw: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(raw["id"]), "text": str(raw["text"]), "shown": bool(raw["shown"])}
    if isinstance(raw.get("why"), str):
        out["why"] = raw["why"]
    return out


def public_topic(g: Guidance, topic: Topic) -> dict[str, Any]:
    raw = topic.raw
    return {
        "id": topic.id,
        "title": topic.title,
        "steps": [_line(s) for s in raw.get("steps", [])],
        "donts": [_line(d) for d in raw.get("donts", [])],
        "caveats": [str(c) for c in raw.get("caveats", [])],
        "citations": citations(g, topic),
    }


def topic_choices(g: Guidance) -> list[dict[str, str]]:
    """What a model may pick from: the ids and titles only."""
    return [{"id": t.id, "title": t.title} for t in g.topics]


# --- topic matching (§45.7) ------------------------------------------------------------------------------------


_BLOWOUT = re.compile(r"\b(?:blew|blown|blows|blowing|blow)\s*-?\s*out\b")


def _pattern(keyword: str) -> re.Pattern[str]:
    words = [re.escape(w) for w in keyword.split()]
    return re.compile(r"(?<![a-z0-9])" + r"\s+".join(words) + r"(?:s|es|d|ed|ing|ded|ding)?(?![a-z0-9])")


def _normal(texts: Iterable[str | None]) -> str:
    """Lower case, hyphens as spaces, and "blew out" / "blown out" as "blowout" (the list's word)."""
    text = " ".join(t for t in texts if t).lower().replace("-", " ")
    return _BLOWOUT.sub("blowout", text)


def _score(text: str, topic: Topic) -> int:
    """Each keyword found counts its number of words, so "car sliding on ice" outweighs a bare "ice"."""
    return sum(len(k.split()) for k in topic.keywords if _pattern(k).search(text))


def match(g: Guidance, texts: Iterable[str | None], pick: str | None = None) -> str | None:
    """The topic id the texts are about, else None. Keywords decide; the model's ``pick`` counts only when it is in
    the list, breaking a tie or standing in when no keyword is found."""
    text = _normal(texts)
    scored = [(t, _score(text, t)) for t in g.topics]
    best = max((s for _, s in scored), default=0)
    valid_pick = pick if pick in g.ids() else None
    if best == 0:
        return valid_pick
    leaders = [t.id for t, s in scored if s == best]
    if valid_pick in leaders:
        return valid_pick
    return leaders[0]


def keyword_match(g: Guidance, texts: Iterable[str | None]) -> str | None:
    """The keyword match alone (no model pick)."""
    return match(g, texts, None)
