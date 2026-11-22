"""A campaign page's data (docs/CONTRACTS.md §41.2 "The page parser"). Pure.

A page ``/c/campaigns/{uuid}`` is server-rendered by Next.js: its data sits in ``self.__next_f.push([1,"…"])`` scripts
(an RSC stream) holding react-query's dehydrated state. ``queries`` joins the pushes, splits the stream into rows
(``<hex id>:<json>\\n`` or ``<hex id>:T<hex length>,<that many UTF-8 bytes>``) and keeps ``queryKey → state.data`` of
every ``{"queries": [...]}`` whose key is a list, with the stream's strings resolved. The parts about other creators
(``topClips``, ``topEarners``, ``chartPoints`` and every ``username``) are dropped here and never stored or logged.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

_PUSH = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', re.DOTALL)
_ANY_PUSH = re.compile(r"self\.__next_f\.push\(")
_META = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_ROBOTS_NAME = re.compile(r"""\bname\s*=\s*["']?robots["'\s/>]""", re.IGNORECASE)
_ROW_ID = re.compile(rb"([0-9a-f]{1,8}):")
_REF = re.compile(r"^\$([0-9a-f]{1,8})$")
_UNDEFINED = object()
DROP = frozenset({"topClips", "topEarners", "chartPoints", "username", "whopUsername"})

QueryKey = tuple[str, ...]


@dataclass
class Page:
    """``kind``: ``campaign`` (the detail query is there), ``gone`` (a removed campaign: the soft-404 page, a stream
    with ``noindex`` and no detail), ``challenge`` (a bot wall: no stream at all), ``unreadable`` (a stream without the
    detail and without ``noindex``: a format change)."""

    kind: str
    detail: dict[str, Any] = field(default_factory=dict)
    card: dict[str, Any] | None = None


def pushes(html_text: str) -> list[str]:
    out: list[str] = []
    for found in _PUSH.finditer(html_text):
        try:
            value = json.loads(found.group(1))
        except ValueError:
            continue
        if isinstance(value, str):
            out.append(value)
    return out


def rows(stream: str) -> Iterator[tuple[str, str, Any]]:
    """``(id, kind, value)``: ``kind`` ``T`` (text) or ``J`` (the raw JSON text of a row); other tags are skipped."""
    data = stream.encode("utf-8")
    pos, end = 0, len(data)
    while pos < end:
        found = _ROW_ID.match(data, pos)
        if found is None:
            nxt = data.find(b"\n", pos)
            pos = end if nxt < 0 else nxt + 1
            continue
        row_id = found.group(1).decode()
        pos = found.end()
        if data[pos : pos + 1] == b"T":
            comma = data.find(b",", pos)
            size_text = data[pos + 1 : comma] if comma > 0 else b""
            if comma < 0 or not re.fullmatch(rb"[0-9a-f]{1,8}", size_text):
                nxt = data.find(b"\n", pos)
                pos = end if nxt < 0 else nxt + 1
                continue
            size = int(size_text, 16)
            text = data[comma + 1 : comma + 1 + size].decode("utf-8", errors="replace")
            pos = comma + 1 + size
            yield row_id, "T", text
            continue
        nxt = data.find(b"\n", pos)
        line = data[pos:] if nxt < 0 else data[pos:nxt]
        pos = end if nxt < 0 else nxt + 1
        yield row_id, "J", line.decode("utf-8", errors="replace")


def _query_states(value: Any) -> Iterator[list[Any]]:
    if isinstance(value, dict):
        found = value.get("queries")
        if isinstance(found, list):
            yield found
        for child in value.values():
            yield from _query_states(child)
    elif isinstance(value, list):
        for child in value:
            yield from _query_states(child)


def _resolve(value: Any, texts: dict[str, str]) -> Any:
    if isinstance(value, str):
        if value == "$undefined":
            return _UNDEFINED
        if value.startswith("$$"):
            return value[1:]
        ref = _REF.match(value)
        if ref and ref.group(1) in texts:
            return texts[ref.group(1)]
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in value.items():
            if key in DROP:
                continue
            resolved = _resolve(child, texts)
            if resolved is not _UNDEFINED:
                out[key] = resolved
        return out
    if isinstance(value, list):
        items = [_resolve(child, texts) for child in value]
        return [None if item is _UNDEFINED else item for item in items]
    return value


def queries(html_text: str) -> dict[QueryKey, Any]:
    stream = "".join(pushes(html_text))
    texts: dict[str, str] = {}
    candidates: list[str] = []
    for row_id, kind, value in rows(stream):
        if kind == "T":
            texts[row_id] = value
        elif '"queries"' in value and value[:1] in "[{":
            candidates.append(value)
    out: dict[QueryKey, Any] = {}
    for raw in candidates:
        try:
            parsed = json.loads(raw)
        except ValueError:
            continue
        for states in _query_states(parsed):
            for query in states:
                if not isinstance(query, dict) or not isinstance(query.get("queryKey"), list):
                    continue
                key = tuple(str(part) for part in query["queryKey"])
                state = query.get("state")
                data = state.get("data") if isinstance(state, dict) else None
                out[key] = _resolve(data, texts)
    return out


def noindex(html_text: str) -> bool:
    return any(_ROBOTS_NAME.search(tag) and "noindex" in tag.lower() for tag in _META.findall(html_text))


def page(status: int, html_text: str, uuid: str) -> Page:
    """What one read of ``/c/campaigns/{uuid}`` is (§41.2): 404 → ``gone``; 200 → by its content."""
    if status in (404, 410):
        return Page("gone")
    uuid = uuid.lower()
    found = queries(html_text)
    detail = next(
        (v for k, v in found.items() if k[:2] == ("campaigns", "detail") and len(k) == 3 and k[2].lower() == uuid),
        None,
    )
    if isinstance(detail, dict) and str(detail.get("id") or "").lower() == uuid:
        card = next(
            (
                v
                for k, v in found.items()
                if k[:2] == ("campaigns", "discover-card") and len(k) == 3 and k[2].lower() == uuid
            ),
            None,
        )
        return Page("campaign", detail, card if isinstance(card, dict) else None)
    if not _ANY_PUSH.search(html_text):
        return Page("challenge")  # no stream at all: a bot wall (even one that says noindex) is never "gone"
    if noindex(html_text):
        return Page("gone")
    return Page("unreadable")
