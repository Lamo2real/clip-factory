"""The tools Ask may call while answering one question (docs/CONTRACTS.md §28.3, §28.4). All read only.

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
from .prompt import READ_MY_SECTIONS, SETUP_PLATFORMS
from .search import QUERY_CHARS, SearchError, SearchProvider
from .state import Reader

CAPS = {
    "web_search": 6,
    "web_fetch": 6,
    "read_app_doc": 6,
    "read_my_clip_factory": 6,
    "read_setup_guide": 6,
    "show_app_buttons": 2,
}
# Official help and developer pages ``web_fetch`` may open with no search key and no link in the conversation
# (§28.3): the platforms' own help and developer documentation, never posts, Pages, groups, forums or comments.
# Each entry is an exact host (``www.`` optional) and the path prefixes that hold that documentation; link shims
# (l.facebook.com, lm.facebook.com) and the bare facebook.com or aws.amazon.com are not on it. The SSRF guard in
# fetch.py still checks every address, and every redirect hop must stay official or on the same host.
OFFICIAL_DOC_PAGES: dict[str, tuple[str, ...]] = {
    "developers.facebook.com": ("/docs/", "/documentation/"),
    "facebook.com": ("/help/", "/business/help/"),
    "business.facebook.com": ("/business/help/",),
    "help.instagram.com": ("/",),
    "transparency.meta.com": ("/",),
    "developers.tiktok.com": ("/doc/",),
    "support.tiktok.com": ("/",),
    "developers.google.com": ("/",),
    "support.google.com": (),  # only /{product}/answer/{id} (SUPPORT_GOOGLE_ANSWER): never the community threads
    "cloud.google.com": ("/docs/",),
    "docs.x.com": ("/",),
    "developer.x.com": ("/en/docs/",),
    "help.x.com": ("/",),
    "docs.aws.amazon.com": ("/",),
    "docs.anthropic.com": ("/",),
    "docs.claude.com": ("/",),
    "platform.claude.com": ("/docs/",),
}
SUPPORT_GOOGLE_ANSWER = re.compile(r"/[a-z0-9_-]{1,40}/answer/\d{1,12}")
# Keyless official reads are capped lower than web_fetch's own cap and trimmed, so a setup question stays cheap.
OFFICIAL_FETCH_CAP = 3
OFFICIAL_TEXT_CHARS = 15_000
OFFICIAL_PDF_BYTES = 500_000
SETUP_STEP_ACTION = re.compile(r"setup-step:([a-z]+):([a-z0-9-]{1,40})")
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


def official(url: str) -> bool:
    """True for an https page of a platform's own help or developer documentation (OFFICIAL_DOC_PAGES)."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower().rstrip(".").removeprefix("www.")
    if parts.scheme != "https" or not host or parts.username or parts.password or parts.port not in {None, 443}:
        return False
    if host not in OFFICIAL_DOC_PAGES:
        return False
    path = parts.path or "/"
    if host == "support.google.com":
        return bool(SUPPORT_GOOGLE_ANSWER.match(path))
    return any(path.startswith(prefix) for prefix in OFFICIAL_DOC_PAGES[host])


def without_query(url: str) -> str:
    """The URL with no query string: a keyless official read may not carry words the model chose (§28.3)."""
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path or "/", "", ""))


def hop_check(start: str) -> Callable[[str], bool]:
    """For a fetch allowed only as official or a guide page: a redirect may go to another official page or stay on
    the same host, never anywhere else (no link shim, no open redirect)."""
    start_host = (urllib.parse.urlsplit(start).hostname or "").lower()

    def ok(url: str) -> bool:
        return official(url) or (urllib.parse.urlsplit(url).hostname or "").lower() == start_host

    return ok


def setup_step_action(knowledge: Knowledge, action_id: str) -> dict[str, Any] | None:
    """The button for ``setup-step:{platform}:{stepId}``: opens that step of the setup guide and lights it."""
    m = SETUP_STEP_ACTION.fullmatch(action_id)
    if not m or m.group(1) not in SETUP_PLATFORMS:
        return None
    platform, step_id = m.group(1), m.group(2)
    step = next((st for st in knowledge.setup_steps.get(platform, []) if st.get("id") == step_id), None)
    if step is None:
        return None
    name = {"youtube": "YouTube", "tiktok": "TikTok", "x": "X"}.get(platform, platform.capitalize())
    return {
        "id": action_id,
        "label": f"Open {name} step {step.get('n')}",
        "to": f"/settings/posting/setup/{platform}#step-{step_id}",
        "highlight": [f"step-{step_id}"],
    }


def guide_urls(knowledge: Knowledge) -> set[str]:
    """Every page a setup step opens: web_fetch may read them without a search (§28.3)."""
    out = set()
    for rows in knowledge.setup_steps.values():
        for st in rows:
            url = (st.get("open") or {}).get("url") if isinstance(st.get("open"), dict) else None
            if isinstance(url, str):
                norm = web.normalise(url)
                if norm:
                    out.add(norm)
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
    fetcher: Callable[..., web.Page]  # (url) or (url, allow=hop check)
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
    doc_urls: set[str] = field(default_factory=set)  # pages the setup guides open: readable, not live links
    # The kill switch's ``web: false``: no outside page at all except links the owner typed himself (§28.6).
    web_off: bool = False
    official_used: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.links |= set(self.allowed_urls)
        self.typed = frozenset(self.allowed_urls)  # the owner's own links (search results are added later)

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
        if self.soft_deadline() and name in {
            "web_search",
            "web_fetch",
            "read_app_doc",
            "read_my_clip_factory",
            "read_setup_guide",
        }:
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
            if name == "read_setup_guide":
                return self._guide(args)
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
        if target is not None and self.web_off:
            if target not in self.typed:
                return Outcome("Web reading is turned off. I can only open a link the owner typed himself.", True)
            return self._open(target, None)
        if target is not None and (target in self.allowed_urls or target in self.doc_urls):
            # A search result or his own link may redirect anywhere public; a guide page only stays official.
            return self._open(target, None if target in self.allowed_urls else hop_check(target))
        if target is None or not official(target):
            return Outcome(
                "I can only open official help and developer documentation pages, pages from the setup guide, links "
                "from this answer's search results or links the owner typed himself.",
                True,
            )
        with self._lock:
            if self.official_used >= OFFICIAL_FETCH_CAP:
                return Outcome(LIMIT_REACHED, True)
            self.official_used += 1
        target = without_query(target)
        return self._open(target, hop_check(target))

    def _open(self, target: str, hops: Callable[[str], bool] | None) -> Outcome:
        """Fetch one page. ``hops`` set: an official or guide page, read with no key, so every redirect is checked,
        the text is trimmed and big PDFs are refused."""
        status = ("reading", f"Reading {domain(target)}…")
        try:
            page = self.fetcher(target) if hops is None else self.fetcher(target, allow=hops)
        except web.FetchError as e:
            return Outcome(str(e), True, status)
        if hops is None or hops(page.url):
            with self._lock:
                self.links.add(page.url)
        if page.kind == "pdf":
            if not self.tool_docs:
                return Outcome("I can't read PDFs from the web yet", True, status)
            if hops is not None and len(page.data) > OFFICIAL_PDF_BYTES:
                return Outcome("that PDF is too big to read here; ask him to send it as a file", True, status)
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
        if hops is not None:
            text = text[:OFFICIAL_TEXT_CHARS]
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

    def _guide(self, args: dict[str, Any]) -> Outcome:
        platform, step_id = args.get("platform"), args.get("stepId")
        if set(args) - {"platform", "stepId"} or platform not in SETUP_PLATFORMS:
            return Outcome('{"INVALID_JSON": "platform must be youtube, tiktok, instagram, facebook or x"}', True)
        if step_id is not None and not isinstance(step_id, str):
            return Outcome('{"INVALID_JSON": "stepId must be a string"}', True)
        rows = self.knowledge.setup_steps.get(str(platform), [])
        if not rows:
            return Outcome("that guide is not in this version of the app", True)
        if step_id:
            rows = [r for r in rows if r.get("id") == step_id]
            if not rows:
                return Outcome("no such step; read the whole guide to see the step ids", True)
        try:
            mine = next((r for r in self.reader.setup() if r.get("platform") == platform), None)
        except Exception as e:  # his progress is a bonus: the guide itself still answers
            log("warning", "ask.setup_read_failed", error=type(e).__name__)
            mine = None
        lines = [
            f"Setup guide: {platform} (Settings › Posting › Set up posting › {platform}). "
            f"Steps checked on {rows[0].get('checkedOn') or 'unknown'}. Outside sites change; trust his picture "
            "and the official page over these words when they differ.",
        ]
        if mine is not None:
            nxt = mine.get("next") or {}
            lines.append(
                f"His progress: {mine.get('state')}, {mine.get('stepsDone')} of {mine.get('stepsTotal')} steps ticked"
                + (f", next by his ticks: step {nxt.get('number')} {nxt.get('id')}" if nxt else "")
                + f", connected: {'yes' if mine.get('connected') else 'no'}."
            )
        part = ""
        for r in rows:
            if r.get("partTitle") != part:
                part = str(r.get("partTitle") or "")
                lines.append(f"\nPart: {part}")
            head = f"{r.get('n')}. [{r.get('id')}] {r.get('title')}"
            if r.get("optional"):
                head += " (optional)"
            if r.get("auto"):
                head += f" (ticks itself: {r.get('auto')})"
            lines.append(head)
            lines.extend(f"   - {line}" for line in r.get("say") or [])
            for hint in r.get("ifYouSee") or []:
                lines.append(f"   - If you see {hint.get('see')}: {hint.get('do')}")
            opens = r.get("open")
            if isinstance(opens, dict) and isinstance(opens.get("url"), str):
                lines.append(f"   - Opens: {opens.get('label')} {opens['url']}")
            lines.append(f"   - Button to this step: setup-step:{platform}:{r.get('id')}")
        return Outcome("\n".join(lines), False, ("checking_app", "Reading the setup guide…"))

    def _buttons(self, args: dict[str, Any]) -> Outcome:
        ids = args.get("actionIds")
        if set(args) != {"actionIds"} or not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            return Outcome('{"INVALID_JSON": "actionIds must be a list of strings"}', True)
        known, unknown = [], []
        for action_id in ids[:2]:
            action = self.knowledge.actions.get(action_id)
            step = setup_step_action(self.knowledge, action_id) if action is None else None
            if action is not None and self.route_ok(action.to):
                if all(a["id"] != action.id for a in self.actions):
                    known.append(action.public())
            elif step is not None:
                if all(a["id"] != step["id"] for a in self.actions):
                    known.append(step)
            else:
                unknown.append(action_id)
        self.actions = (self.actions + known)[:2]
        if known:
            self.on_actions(list(self.actions))
        if unknown:
            return Outcome("unknown action ids: " + ", ".join(unknown[:5]), True)
        return Outcome("shown", False)
