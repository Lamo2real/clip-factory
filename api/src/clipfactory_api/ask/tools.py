"""The tools Ask may call while answering one question (docs/CONTRACTS.md §27.3, §27.4). All read only.

``Toolbox`` holds the per-answer state: the caps per tool, the URLs ``web_fetch`` may open (search results of this
answer and URLs the owner typed himself, never a URL a page or file mentioned), the numbered sources and the links
the panel may make live after the answer.
"""

from __future__ import annotations

import base64
import re
import threading
import urllib.parse
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from ..log import log
from . import fetch as web
from .knowledge import Knowledge, read_section
from .prompt import READ_MY_SECTIONS
from .search import QUERY_CHARS, SearchError, SearchProvider
from .state import Reader

CAPS = {"web_search": 6, "web_fetch": 6, "read_app_doc": 6, "read_my_clip_factory": 6, "show_app_buttons": 2}
LIMIT_REACHED = "limit reached, answer with what you have"
LIBRARY_SOURCE = "clip-factory://library/"
URL_IN_TEXT = re.compile(r"https?://[^\s<>\"'`)\]]+")
MAX_SOURCES = 30


@dataclass
class Outcome:
    content: Any  # str or a list of content blocks for the tool_result
    is_error: bool = False
    status: tuple[str, str] | None = None  # (kind, label) for ask.status


def typed_urls(texts: Iterable[str]) -> set[str]:
    out = set()
    for text in texts:
        for raw in URL_IN_TEXT.findall(text):
            url = web.normalise(raw.rstrip(".,;:!?"))
            if url:
                out.add(url)
    return out


def domain(url: str) -> str:
    host = urllib.parse.urlsplit(url).hostname or ""
    return host.removeprefix("www.")


@dataclass
class Toolbox:
    knowledge: Knowledge
    reader: Reader
    search_key: str | None
    provider: SearchProvider | None
    fetcher: Callable[[str], web.Page]
    allowed_urls: set[str]
    on_actions: Callable[[list[dict[str, Any]]], None]
    route_ok: Callable[[str], bool] = lambda _to: True
    soft_deadline: Callable[[], bool] = lambda: False
    used: dict[str, int] = field(default_factory=lambda: dict.fromkeys(CAPS, 0))
    links: set[str] = field(default_factory=set)
    sources: list[dict[str, Any]] = field(default_factory=list)
    titles: dict[str, str] = field(default_factory=dict)  # document title → "file" | "app"
    actions: list[dict[str, Any]] = field(default_factory=list)
    tool_docs: bool = True  # PDFs from the web as document blocks inside tool_result
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.links |= set(self.allowed_urls)

    def allow(self, url: str) -> None:
        """A URL ``web_fetch`` may open and the panel may make live (thread-safe: tools run in parallel)."""
        with self._lock:
            self.allowed_urls.add(web.normalise(url) or url)
            self.links.add(url)

    # --- sources --------------------------------------------------------------------------------------------------

    def source_for(self, citation: Any) -> int | None:
        """The 1-based source number for one citation of the final answer, adding it when new."""
        ctype = getattr(citation, "type", "")
        entry: dict[str, Any]
        if ctype == "search_result_location":
            src = str(getattr(citation, "source", "") or "")
            title = str(getattr(citation, "title", "") or "")
            if src.startswith(LIBRARY_SOURCE):
                entry = {"kind": "app", "title": title or "Clip Factory guide"}
            else:
                entry = {"kind": "web", "title": title or domain(src), "url": src}
        elif ctype in {"char_location", "page_location", "content_block_location"}:
            title = str(getattr(citation, "document_title", "") or "")
            kind = self.titles.get(title, "file")
            entry = {"kind": kind, "title": title or "your file"}
            if kind == "file":
                entry["file"] = title
            page = getattr(citation, "start_page_number", None)
            if ctype == "page_location" and isinstance(page, int):
                entry["where"] = f"page {page}"
        else:
            return None
        for i, s in enumerate(self.sources):
            if all(s.get(k) == v for k, v in entry.items()):
                return i + 1
        if len(self.sources) >= MAX_SOURCES:
            return None
        entry["n"] = len(self.sources) + 1
        self.sources.append(entry)
        return int(entry["n"])

    # --- running a tool -----------------------------------------------------------------------------------------

    def run(self, name: str, args: Any) -> Outcome:
        if name not in CAPS or not isinstance(args, dict):
            return Outcome('{"INVALID_JSON": "the input was not an object"}', True)
        if self.soft_deadline() and name in {"web_search", "web_fetch", "read_app_doc", "read_my_clip_factory"}:
            return Outcome("time is up, answer with what you have", True)
        with self._lock:  # parallel calls of one turn share the caps
            if self.used[name] >= CAPS[name]:
                return Outcome(LIMIT_REACHED, True)
            self.used[name] += 1
        try:
            if name == "web_search":
                return self._search(args)
            if name == "web_fetch":
                return self._fetch(args)
            if name == "read_app_doc":
                return self._doc(args)
            if name == "read_my_clip_factory":
                return self._mine(args)
            return self._buttons(args)
        except Exception as e:  # a tool never ends the answer
            log("warning", "ask.tool_failed", tool=name, error=type(e).__name__)
            return Outcome("that did not work this time", True)

    def _search(self, args: dict[str, Any]) -> Outcome:
        query, fresh = args.get("query"), args.get("freshness")
        if set(args) - {"query", "freshness"} or not isinstance(query, str) or not query.strip():
            return Outcome('{"INVALID_JSON": "query must be a string"}', True)
        if fresh is not None and fresh not in {"day", "week", "month", "year"}:
            return Outcome('{"INVALID_JSON": "freshness must be day, week, month or year"}', True)
        if self.provider is None or not self.search_key:
            return Outcome("web search is not set up", True, ("searching", "Searching the web…"))
        try:
            results = self.provider.search(self.search_key, query[:QUERY_CHARS], fresh)
        except SearchError:
            return Outcome("search is not working right now", True, ("searching", "Searching the web…"))
        blocks = []
        for r in results:
            self.allow(r.url)  # stored normalised, as web_fetch compares it
            blocks.append(
                {
                    "type": "search_result",
                    "source": r.url,
                    "title": r.title or domain(r.url),
                    "content": [{"type": "text", "text": r.snippet or r.title}],
                    "citations": {"enabled": True},
                }
            )
        if not blocks:
            return Outcome("no results", False, ("searching", "Searching the web…"))
        return Outcome(blocks, False, ("searching", "Searching the web…"))

    def _fetch(self, args: dict[str, Any]) -> Outcome:
        url = args.get("url")
        if set(args) != {"url"} or not isinstance(url, str):
            return Outcome('{"INVALID_JSON": "url must be a string"}', True)
        target = web.normalise(url)
        if target is None or target not in self.allowed_urls:
            return Outcome(
                "I can only open links from this answer's search results or links the owner typed himself.", True
            )
        status = ("reading", f"Reading {domain(target)}…")
        try:
            page = self.fetcher(target)
        except web.FetchError as e:
            return Outcome(str(e), True, status)
        with self._lock:
            self.links.add(page.url)
        if page.kind == "pdf":
            if not self.tool_docs:
                return Outcome("I can't read PDFs from the web yet", True, status)
            title = page.title[:120]
            with self._lock:
                self.titles[title] = "web"
            pdf: dict[str, Any] = {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.b64encode(page.data).decode(),
                },
                "title": title,
                "citations": {"enabled": True},
            }
            return Outcome([pdf], False, status)
        text = page.text or "(the page had no readable text)"
        block: dict[str, Any] = {
            "type": "search_result",
            "source": page.url,
            "title": page.title or domain(page.url),
            "content": [{"type": "text", "text": text}],
            "citations": {"enabled": True},
        }
        return Outcome([block], False, status)

    def _doc(self, args: dict[str, Any]) -> Outcome:
        doc_id, part = args.get("id"), args.get("part", 1)
        if set(args) - {"id", "part"} or "id" not in args or not isinstance(doc_id, str):
            return Outcome('{"INVALID_JSON": "id must be a string"}', True)
        if not isinstance(part, int) or isinstance(part, bool) or part < 1:
            return Outcome('{"INVALID_JSON": "part must be a whole number from 1"}', True)
        entry = self.knowledge.entry(doc_id)
        if entry is None:
            return Outcome("no library section with that id; pick one from the library index", True)
        text = read_section(doc_id, self.knowledge, part=part)
        if text is None:
            return Outcome("that section has no such part", True)
        block = {
            "type": "search_result",
            "source": LIBRARY_SOURCE + doc_id,
            "title": entry.title,
            "content": [{"type": "text", "text": text}],
            "citations": {"enabled": True},
        }
        return Outcome([block], False, ("checking_app", "Reading the Clip Factory guide…"))

    def _mine(self, args: dict[str, Any]) -> Outcome:
        section, item_id = args.get("section"), args.get("id")
        if set(args) - {"section", "id"} or section not in READ_MY_SECTIONS:
            return Outcome('{"INVALID_JSON": "section is not one of the listed sections"}', True)
        if item_id is not None and (not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id)):
            return Outcome("that id does not look right", True)
        try:
            return Outcome(self.reader.section(str(section), item_id), False, ("checking_app", "Checking your setup…"))
        except LookupError as e:
            return Outcome(str(e), True, ("checking_app", "Checking your setup…"))

    def _buttons(self, args: dict[str, Any]) -> Outcome:
        ids = args.get("actionIds")
        if set(args) != {"actionIds"} or not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            return Outcome('{"INVALID_JSON": "actionIds must be a list of strings"}', True)
        known, unknown = [], []
        for action_id in ids[:2]:
            action = self.knowledge.actions.get(action_id)
            if action is not None and self.route_ok(action.to):
                if all(a["id"] != action.id for a in self.actions):
                    known.append(action.public())
            else:
                unknown.append(action_id)
        self.actions = (self.actions + known)[:2]
        if known:
            self.on_actions(list(self.actions))
        if unknown:
            return Outcome("unknown action ids: " + ", ".join(unknown[:5]), True)
        return Outcome("shown", False)
