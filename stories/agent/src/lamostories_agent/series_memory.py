"""A series' bounded memory for the idea helper and the story writer (docs/CONTRACTS.md §45.44, ADR-92).

A series (``SERIES#{seriesId}``) keeps its story so far (≤ 1500 characters, written by the recap task after each
approval or edited by the owner) and a short summary per episode. What a prompt gets of it is bounded: the story so
far, the newest 5 episode summaries, and up to 20 titles of older episodes and the series' saved ideas, at most 8000
bytes of JSON in all, so a long series never grows the prompt. Pure: no I/O, no model. Series memory never goes into
``MEM#`` (the workspace's own memory).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

MAX_BYTES = 8000
LAST_EPISODES = 5
EARLIER_TITLES = 20
SUMMARY_MAX = 400
STORY_SO_FAR_MAX = 1500
TITLE_MAX = 80
EPISODE_STATUSES = ("approved", "published")


def _text(value: Any, limit: int) -> str:
    """One line of text, its spaces tidied, cut to ``limit`` characters."""
    return " ".join(str(value if value is not None else "").split())[:limit]


def _keep_lines(value: Any, limit: int) -> str:
    """A text cut to ``limit`` characters that keeps its own lines (the story so far's four labelled parts)."""
    lines = [" ".join(line.split()) for line in str(value if value is not None else "").splitlines()]
    return "\n".join(line for line in lines if line)[:limit]


def episodes(series_id: str, stories: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The series' approved and published stories in the order of approval, as the API numbers them (§45.44)."""
    found = [s for s in stories if s.get("seriesId") == series_id and s.get("status") in EPISODE_STATUSES]
    return sorted(found, key=lambda s: (str(s.get("approvedAt") or s.get("updatedAt") or ""), str(s.get("storyId"))))


def _summaries(series: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for entry in series.get("summaries") or []:
        if isinstance(entry, Mapping) and isinstance(entry.get("storyId"), str) and entry.get("summary"):
            out[entry["storyId"]] = _text(entry["summary"], SUMMARY_MAX)
    return out


def car_words(car: Any) -> str:
    """The car's look in words (the character agent's ``car_words``); a plain "a car" when it cannot be read."""
    if not isinstance(car, Mapping) or not car:
        return "a car"
    try:
        from .tasks.characters import car_words as words  # on first use, so importing the writer does not load tasks

        return str(words(car))[:80] or "a car"
    except Exception:
        return "a car"


def cast_of(series: Mapping[str, Any], characters: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The series' cast in words, the people first (the first one is the main character), then its car."""
    found = [characters[c] for c in series.get("castIds") or [] if isinstance(c, str) and c in characters]
    people = [c for c in found if (c.get("kind") or "person") != "car"]
    cars = [c for c in found if c.get("kind") == "car"]
    out: list[dict[str, Any]] = [
        {"name": _text(c.get("name"), 30), "kind": "person", "main": n == 0} for n, c in enumerate(people)
    ]
    out += [{"name": _text(c.get("name"), 30), "kind": "car", "car": car_words(c.get("car"))} for c in cars]
    return out


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def series_context(
    series: Mapping[str, Any],
    stories: Sequence[Mapping[str, Any]],
    ideas: Sequence[Mapping[str, Any]],
    characters: Mapping[str, Mapping[str, Any]],
    *,
    this_story_id: str | None = None,
) -> dict[str, Any]:
    """≤ 8000 bytes of JSON: the series, its cast, the episode number of the video being made (its own number when
    it is an episode already, else the next one), the story so far, the newest 5 episodes before it with their
    summaries, and up to 20 earlier titles (older episodes, then the series' saved ideas) never to repeat."""
    series_id = str(series.get("seriesId") or "")
    eps = list(episodes(series_id, stories))
    own = next((n for n, s in enumerate(eps, start=1) if this_story_id and s.get("storyId") == this_story_id), None)
    before = eps[: own - 1] if own else [s for s in eps if s.get("storyId") != this_story_id]
    number = own or len(before) + 1
    stored = _summaries(series)
    first = max(0, len(before) - LAST_EPISODES)
    last = [
        {
            "n": first + i + 1,
            "title": _text(s.get("title"), TITLE_MAX),
            "summary": stored.get(str(s.get("storyId"))) or None,
        }
        for i, s in enumerate(before[first:])
    ]
    titles: list[str] = []
    for s in before[:first]:
        titles.append(_text(s.get("title"), TITLE_MAX))
    for idea in ideas:
        if idea.get("seriesId") == series_id and idea.get("status") != "used":
            titles.append(_text(idea.get("title"), TITLE_MAX))
    earlier = [t for t in dict.fromkeys(t for t in titles if t)][-EARLIER_TITLES:]
    out: dict[str, Any] = {
        "name": _text(series.get("name"), 40),
        "about": _text(series.get("line"), 120),
        "cast": cast_of(series, characters),
        "episode": number,
        "storySoFar": _keep_lines(series.get("storySoFar"), STORY_SO_FAR_MAX),
        "lastEpisodes": last,
        "earlierTitles": earlier,
    }
    # Bounded whatever the text is (many-byte letters): the oldest titles go first, then the oldest summaries, then
    # the story so far is cut.
    while _size(out) > MAX_BYTES and out["earlierTitles"]:
        out["earlierTitles"] = out["earlierTitles"][1:]
    while _size(out) > MAX_BYTES and len(out["lastEpisodes"]) > 1:
        out["lastEpisodes"] = out["lastEpisodes"][1:]
    while _size(out) > MAX_BYTES and out["storySoFar"]:
        out["storySoFar"] = out["storySoFar"][: max(0, len(out["storySoFar"]) - 100)]
    while _size(out) > MAX_BYTES and out["lastEpisodes"] and out["lastEpisodes"][0]["summary"]:
        out["lastEpisodes"][0]["summary"] = out["lastEpisodes"][0]["summary"][:-50] or None
    return out
