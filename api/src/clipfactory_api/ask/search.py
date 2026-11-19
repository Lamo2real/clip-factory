"""Web search for Ask (docs/CONTRACTS.md §27.3): the Brave Search API behind a small ``SearchProvider`` interface.

Checked against Brave's own docs (2026-11-19): ``GET https://api.search.brave.com/res/v1/web/search`` with the key in
the ``X-Subscription-Token`` header; ``q``, ``count`` (≤ 20), ``freshness`` (``pd``/``pw``/``pm``/``py``) and
``safesearch``; results in ``web.results[]`` (``title``, ``url``, ``description``). The Search plan costs $5 per
1,000 requests with $5 of free credit each month.

The key lives only in Secrets Manager (``cf-prod/ask/search-key``); it is read with ``GetSecretValue``, cached five
minutes per warm Lambda, and never logged, echoed or put in the prompt. Swapping the provider is one class.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
SEARCH_TIMEOUT_S = 4.0
RESULT_COUNT = 8
SNIPPET_CHARS = 600
QUERY_CHARS = 200
KEY_CACHE_S = 300.0
MAX_KEY_CHARS = 200
FRESHNESS = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}
USER_AGENT = "ClipFactoryAsk/1.0"


class SearchError(Exception):
    """The search failed (time, status, bad body). The message is a code, never the key or the query."""


@dataclass(frozen=True)
class Result:
    url: str
    title: str
    snippet: str


class SearchProvider(Protocol):
    def search(self, key: str, query: str, freshness: str | None) -> list[Result]: ...


# (url, headers, timeout) → body bytes; tests replace it.
HttpGet = Callable[[str, dict[str, str], float], bytes]


def urllib_get(url: str, headers: dict[str, str], timeout: float) -> bytes:
    request = urllib.request.Request(url, headers=headers, method="GET")  # noqa: S310 (fixed https URL)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            body: bytes = response.read(2_000_000)
            return body
    except Exception as e:
        raise SearchError(type(e).__name__) from None


def _strip_tags(text: str) -> str:
    from html import unescape

    out, depth = [], 0
    for ch in text:
        if ch == "<":
            depth += 1
        elif ch == ">" and depth:
            depth -= 1
        elif not depth:
            out.append(ch)
    return " ".join(unescape("".join(out)).split())


class BraveSearch:
    def __init__(self, get: HttpGet = urllib_get) -> None:
        self._get = get

    def search(self, key: str, query: str, freshness: str | None) -> list[Result]:
        params = {"q": query[:QUERY_CHARS], "count": str(RESULT_COUNT), "safesearch": "moderate"}
        if freshness in FRESHNESS:
            params["freshness"] = FRESHNESS[freshness]
        url = BRAVE_URL + "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "X-Subscription-Token": key, "User-Agent": USER_AGENT}
        body = self._get(url, headers, SEARCH_TIMEOUT_S)
        try:
            data = json.loads(body)
        except ValueError:
            raise SearchError("bad_json") from None
        rows = ((data.get("web") or {}).get("results") or []) if isinstance(data, dict) else []
        out = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            link, title = row.get("url"), row.get("title")
            if not isinstance(link, str) or not link.startswith("https://") or not isinstance(title, str):
                continue
            snippet = _strip_tags(str(row.get("description") or ""))[:SNIPPET_CHARS]
            out.append(Result(link, _strip_tags(title)[:200], snippet or _strip_tags(title)))
        return out[:RESULT_COUNT]


class KeyReader:
    """Reads the search key from Secrets Manager, cached for five minutes. ``None`` means no key (web: no_key)."""

    def __init__(self, secrets: Any, name: str, clock: Callable[[], float] = time.monotonic) -> None:
        self._secrets = secrets
        self._name = name
        self._clock = clock
        self._lock = threading.Lock()
        self._value: str | None = None
        self._read_at: float | None = None

    def get(self) -> str | None:
        with self._lock:
            if self._read_at is not None and self._clock() - self._read_at < KEY_CACHE_S:
                return self._value
        try:
            out = self._secrets.get_secret_value(SecretId=self._name)
            value = str(out.get("SecretString") or "").strip() or None
        except Exception as e:
            code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
            if code != "ResourceNotFoundException":
                raise SearchError("key_unreadable") from None
            value = None
        with self._lock:
            self._value, self._read_at = value, self._clock()
        return value

    def forget(self) -> None:
        with self._lock:
            self._value, self._read_at = None, None
