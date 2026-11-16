"""The help corpus: shape, validation, the bundled copy and the deployed copy (docs/CONTRACTS.md §19.2, §19.6).

The web build writes ``web/src/features/help/help-corpus.json`` (committed) and a hashed copy next to the deployed
UI, named by ``<meta name="cf-help-corpus">`` in ``index.html``. ``build_lambda.py`` copies the committed file into
the zip as ``clipfactory_api/help/corpus.json``. ``load`` prefers the deployed copy (so a UI deploy updates the
answers without an API deploy), reads it from ``APP_URL`` only, and falls back to the last good copy, then the
bundled one.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict

from ..log import log
from .text import DEFAULT_STOPWORDS, DEFAULT_SYNONYMS, is_sensitive

METRICS = frozenset(
    {
        "best_clip_week_views",
        "week_total_views",
        "week_clips",
        "review_waiting",
        "jobs_running",
        "clips_posted",
        "latest_job",
        "clip_views",
        "skills_on",
        "accounts_connected",
    }
)
KINDS = frozenset({"page", "apple", "guide"})
DEVICES = frozenset({"phone", "tablet", "desktop"})
OSES = frozenset({"mac", "windows", "linux", "chromeos", "ios", "android", "unknown"})
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
CORPUS_PATH_RE = re.compile(r"^/assets/help-corpus\.[0-9a-f]{12}\.json$")
MAX_ANSWER = 400
MAX_STEPS = 6
MAX_ACTIONS = 2
MAX_LABEL = 24
INDEX_MAX_BYTES = 512 * 1024
CORPUS_MAX_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT_S = 3.0
FRESH_FOR = timedelta(minutes=10)
RETRY_AFTER_FAILURE = timedelta(minutes=1)

Fetcher = Callable[[str, float, int], bytes]  # (url, timeout seconds, max bytes) → body; raises on any failure


class HelpAction(TypedDict):
    id: str
    label: str
    to: str
    highlight: NotRequired[list[str]]


class HelpLive(TypedDict):
    metric: str
    text: str
    range: NotRequired[str]


class HelpWhen(TypedDict, total=False):
    device: list[str]
    os: list[str]
    installed: bool


class HelpDoc(TypedDict):
    id: str
    kind: str
    route: str
    where: str
    title: str
    keywords: list[str]
    answer: str
    steps: list[str]
    actions: list[HelpAction]
    hash: NotRequired[str]
    highlight: NotRequired[list[str]]
    when: NotRequired[HelpWhen]
    live: NotRequired[HelpLive]
    suggest: NotRequired[bool]
    extends: NotRequired[str]


class CorpusError(ValueError):
    """The corpus is not usable (bad shape, duplicate ids, sensitive words)."""


@dataclass(frozen=True)
class Corpus:
    version: str
    docs: list[HelpDoc]
    synonyms: dict[str, str]
    stopwords: frozenset[str]
    source: Literal["deployed", "bundled"] = "bundled"


EMPTY = Corpus("none", [], dict(DEFAULT_SYNONYMS), DEFAULT_STOPWORDS)


# --- shape and validation ---------------------------------------------------------------------------------------


def _str(value: Any, what: str, *, max_len: int | None = None, empty_ok: bool = False) -> str:
    if not isinstance(value, str) or (not empty_ok and not value.strip()):
        raise CorpusError(f"{what} must be a non-empty string")
    if max_len is not None and len(value) > max_len:
        raise CorpusError(f"{what} is longer than {max_len} characters")
    if is_sensitive(value):
        raise CorpusError(f"{what} contains a sensitive word")
    return value


def _str_list(value: Any, what: str, *, max_items: int | None = None) -> list[str]:
    if not isinstance(value, list):
        raise CorpusError(f"{what} must be a list")
    if max_items is not None and len(value) > max_items:
        raise CorpusError(f"{what} has more than {max_items} items")
    return [_str(v, f"{what}[{i}]") for i, v in enumerate(value)]


def _action(raw: Any, where: str) -> HelpAction:
    if not isinstance(raw, dict):
        raise CorpusError(f"{where} must be an object")
    to = _str(raw.get("to"), f"{where}.to")
    if not to.startswith("/") or to.startswith("//"):
        raise CorpusError(f"{where}.to must be an app path")
    action: HelpAction = {
        "id": _str(raw.get("id"), f"{where}.id"),
        "label": _str(raw.get("label"), f"{where}.label", max_len=MAX_LABEL),
        "to": to,
    }
    if "highlight" in raw:
        action["highlight"] = _str_list(raw["highlight"], f"{where}.highlight")
    return action


def _when(raw: Any, where: str) -> HelpWhen:
    if not isinstance(raw, dict) or set(raw) - {"device", "os", "installed"}:
        raise CorpusError(f"{where} has unknown keys")
    when: HelpWhen = {}
    if "device" in raw:
        devices = _str_list(raw["device"], f"{where}.device")
        if set(devices) - DEVICES:
            raise CorpusError(f"{where}.device has an unknown device")
        when["device"] = devices
    if "os" in raw:
        oses = _str_list(raw["os"], f"{where}.os")
        if set(oses) - OSES:
            raise CorpusError(f"{where}.os has an unknown OS")
        when["os"] = oses
    if "installed" in raw:
        if not isinstance(raw["installed"], bool):
            raise CorpusError(f"{where}.installed must be true or false")
        when["installed"] = raw["installed"]
    return when


def _doc(raw: Any, n: int) -> HelpDoc:
    if not isinstance(raw, dict):
        raise CorpusError(f"docs[{n}] must be an object")
    where = f"docs[{n}]"
    doc_id = _str(raw.get("id"), f"{where}.id")
    if not ID_RE.match(doc_id):
        raise CorpusError(f"{where}.id {doc_id!r} is not kebab-case")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise CorpusError(f"{where}.kind must be page, apple or guide")
    actions_raw = raw.get("actions", [])
    if not isinstance(actions_raw, list) or len(actions_raw) > MAX_ACTIONS:
        raise CorpusError(f"{where}.actions must be a list of at most {MAX_ACTIONS}")
    doc: HelpDoc = {
        "id": doc_id,
        "kind": kind,
        "route": _str(raw.get("route"), f"{where}.route"),
        "where": _str(raw.get("where"), f"{where}.where"),
        "title": _str(raw.get("title"), f"{where}.title"),
        "keywords": _str_list(raw.get("keywords", []), f"{where}.keywords"),
        "answer": _str(raw.get("answer"), f"{where}.answer", max_len=MAX_ANSWER),
        "steps": _str_list(raw.get("steps", []), f"{where}.steps", max_items=MAX_STEPS),
        "actions": [_action(a, f"{where}.actions[{i}]") for i, a in enumerate(actions_raw)],
    }
    for key in ("hash", "extends"):
        if key in raw:
            doc[key] = _str(raw[key], f"{where}.{key}")
    if "highlight" in raw:
        doc["highlight"] = _str_list(raw["highlight"], f"{where}.highlight")
    if "when" in raw:
        doc["when"] = _when(raw["when"], f"{where}.when")
    if "suggest" in raw:
        doc["suggest"] = bool(raw["suggest"])
    if "live" in raw:
        live = raw["live"]
        if not isinstance(live, dict) or live.get("metric") not in METRICS:
            raise CorpusError(f"{where}.live.metric is not a known metric")
        spec: HelpLive = {"metric": live["metric"], "text": _str(live.get("text"), f"{where}.live.text")}
        if "range" in live:
            if live["range"] not in {"this_week", "last_week"}:
                raise CorpusError(f"{where}.live.range must be this_week or last_week")
            spec["range"] = live["range"]
        doc["live"] = spec
    return doc


def _synonyms(raw: Any) -> dict[str, str]:
    """``{variant: canonical}``. A list value is read the other way round, ``{canonical: [variants]}``."""
    if raw is None:
        return dict(DEFAULT_SYNONYMS)
    if not isinstance(raw, dict):
        raise CorpusError("synonyms must be an object")
    out: dict[str, str] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            out[str(key).lower()] = value.lower()
        elif isinstance(value, list) and all(isinstance(v, str) for v in value):
            for variant in value:
                out[variant.lower()] = str(key).lower()
        else:
            raise CorpusError("a synonym must map to words or a list of words")
    return out


def parse(data: bytes | str, source: Literal["deployed", "bundled"] = "bundled") -> Corpus:
    try:
        raw = json.loads(data)
    except (ValueError, UnicodeDecodeError) as e:
        raise CorpusError("the corpus is not JSON") from e
    if not isinstance(raw, dict) or not isinstance(raw.get("docs"), list):
        raise CorpusError("the corpus must be an object with docs")
    if raw.get("app", "clip-factory") != "clip-factory":
        raise CorpusError("the corpus is for another app")
    docs = [_doc(d, n) for n, d in enumerate(raw["docs"])]
    ids = [d["id"] for d in docs]
    if len(set(ids)) != len(ids):
        raise CorpusError("doc ids are not unique")
    action_ids = [a["id"] for d in docs for a in d["actions"]]
    if len(set(action_ids)) != len(action_ids):
        raise CorpusError("action ids are not unique")
    stop = raw.get("stopwords")
    stopwords = frozenset(w.lower() for w in stop) if isinstance(stop, list) and stop else DEFAULT_STOPWORDS
    version = raw.get("version")
    return Corpus(
        str(version) if isinstance(version, str | int) else "unknown",
        docs,
        _synonyms(raw.get("synonyms")),
        stopwords,
        source,
    )


# --- the bundled copy -------------------------------------------------------------------------------------------


def bundled_path() -> Path:
    """The copy in the zip; in a checkout without a build, the web app's committed corpus."""
    packaged = Path(__file__).resolve().parent / "corpus.json"
    if packaged.is_file():
        return packaged
    return Path(__file__).resolve().parents[4] / "web" / "src" / "features" / "help" / "help-corpus.json"


_bundled: dict[Path, Corpus] = {}


def bundled(path: Path | None = None) -> Corpus:
    target = path or bundled_path()
    cached = _bundled.get(target)
    if cached is not None:
        return cached
    try:
        corpus = parse(target.read_bytes(), "bundled")
    except (OSError, CorpusError) as e:
        log("error", "help.corpus_bundled_bad", error=type(e).__name__, reason=str(e)[:200])
        corpus = EMPTY
    _bundled[target] = corpus
    return corpus


# --- the deployed copy ------------------------------------------------------------------------------------------


class _MetaReader(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.content: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "meta" or self.content is not None:
            return
        values = dict(attrs)
        if values.get("name") == "cf-help-corpus":
            self.content = values.get("content") or ""


def corpus_path_from_index(html: str) -> str | None:
    """The ``cf-help-corpus`` meta's path, only when it is ``/assets/help-corpus.<12 hex>.json``."""
    reader = _MetaReader()
    reader.feed(html)
    content = (reader.content or "").strip()
    return content if CORPUS_PATH_RE.match(content) else None


def origin_of(app_url: str) -> str | None:
    parts = urllib.parse.urlsplit(app_url.strip())
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        return None
    return f"{parts.scheme}://{parts.netloc}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect could point at another host; the corpus is only ever read from APP_URL itself."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def urllib_fetch(url: str, timeout: float, max_bytes: int) -> bytes:
    if not url.startswith(("https://", "http://")):
        raise ValueError("only http(s) is fetched")
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers={"accept": "application/json, text/html"})  # noqa: S310 (scheme checked)
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError(f"status {response.status}")
        body: bytes = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise ValueError("too large")
    return body


@dataclass
class CorpusCache:
    """The deployed corpus for one warm Lambda."""

    deployed: Corpus | None = None
    path: str | None = None
    fresh_until: datetime | None = None
    retry_at: datetime | None = None
    fetches: list[str] = field(default_factory=list)  # paths fetched (for tests and the log)


_CACHE = CorpusCache()


def _fetch_deployed(fetcher: Fetcher, origin: str, cache: CorpusCache) -> Corpus:
    index = fetcher(f"{origin}/index.html", FETCH_TIMEOUT_S, INDEX_MAX_BYTES)
    path = corpus_path_from_index(index.decode("utf-8", errors="replace"))
    if path is None:
        raise CorpusError("index.html names no help corpus")
    if path == cache.path and cache.deployed is not None:
        return cache.deployed  # the hashed file is immutable: same name, same content
    body = fetcher(f"{origin}{path}", FETCH_TIMEOUT_S, CORPUS_MAX_BYTES)
    corpus = parse(body, "deployed")
    if not corpus.docs:
        raise CorpusError("the deployed corpus has no docs")
    cache.path = path
    cache.fetches.append(path)
    return corpus


def load(
    fetcher: Fetcher | None,
    app_url: str,
    now: datetime,
    *,
    bundled_file: Path | None = None,
    cache: CorpusCache | None = None,
) -> Corpus:
    """The corpus to answer from: the deployed copy (cached 10 minutes), else the last good one, else the bundled."""
    cache = _CACHE if cache is None else cache
    origin = origin_of(app_url) if app_url else None
    if fetcher is None or origin is None:
        return bundled(bundled_file)
    if cache.deployed is not None and cache.fresh_until is not None and now < cache.fresh_until:
        return cache.deployed
    if cache.retry_at is not None and now < cache.retry_at:
        return cache.deployed or bundled(bundled_file)
    try:
        corpus = _fetch_deployed(fetcher, origin, cache)
    except Exception as e:
        log("warning", "help.corpus_fetch_failed", error=type(e).__name__)
        cache.retry_at = now + RETRY_AFTER_FAILURE
        return cache.deployed or bundled(bundled_file)
    cache.deployed = corpus
    cache.fresh_until = now + FRESH_FOR
    cache.retry_at = None
    return corpus
