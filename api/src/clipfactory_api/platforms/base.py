"""The interface every social platform adapter implements (docs/CONTRACTS.md §14.5, §16.5).

Adapters run inside the durable ``cf-prod-clip-flow`` (publishing) and in ``cf-prod-stats`` (numbers). A publish
step can run more than once (steps are at-least-once), so an adapter that can pass ``idempotency_key`` to its
platform sets ``idempotent = True``; the flow then retries it freely. One that cannot sets ``idempotent = False``
and the flow runs each attempt at most once.

Reading numbers goes through ``fetch_stats``: one HTTP request per ``idsPerRequest`` chunk, the platform's answer
mapped to ``PostMetrics`` fields (§16.3), and the response's status and rate headers returned as ``ResponseMeta`` so
the shared budget (``stats.budget.record``) can stop before a platform blocks the app. HTTP goes through an
``HttpClient`` callable: ``urllib`` in production, a recorder with saved responses in the tests.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

Record = dict[str, Any]
HTTP_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class NotConnectedError(Exception):
    """No usable account for this platform; the post waits as ``pending_integration``."""


class PublishError(Exception):
    """The platform refused the post for good (a bad video, a policy block): retrying cannot help."""


class RetryablePublishError(PublishError):
    """A passing problem (rate limit, platform outage, network): the flow tries the step again."""


class StatsUnavailableError(Exception):
    """The platform answered, but without usable numbers (a bad status, an error body)."""


@dataclass(frozen=True)
class Published:
    url: str
    posted_at: str
    platform_post_id: str | None = None  # the platform's id of the post (§16.3)
    stats_id: str | None = None  # the id its stats API takes; None while a TikTok post is private
    privacy: str = "public"  # "private" for TikTok SELF_ONLY posts of an unaudited app


@dataclass(frozen=True)
class Metrics:
    """The common four numbers; ``None`` means "this platform does not say" (not 0)."""

    views: int | None
    likes: int | None
    comments: int | None
    shares: int | None


# --- HTTP ---------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict[str, str]  # lower-case names
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None


HttpClient = Callable[[HttpRequest], HttpResponse]


class NetworkError(Exception):
    """The request never got an HTTP answer (DNS, connection, timeout)."""


def urllib_client(request: HttpRequest) -> HttpResponse:
    """The production ``HttpClient``. Only fixed platform API hosts are called (https, built by the adapters)."""
    if not request.url.startswith("https://"):
        raise NetworkError("only https requests are allowed")
    req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:  # noqa: S310
            return HttpResponse(resp.status, _lower(resp.headers.items()), resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as e:
        return HttpResponse(e.code, _lower(e.headers.items() if e.headers else []), e.read(MAX_RESPONSE_BYTES))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NetworkError(type(e).__name__) from e


def _lower(items: Any) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in items}


# --- stats ----------------------------------------------------------------------------------------------------------


@dataclass
class ResponseMeta:
    """What the budget needs from the platform's last answer."""

    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    error_code: str | None = None  # the platform's own error code/reason ("quotaExceeded", "80002", ...)
    retry_after: int | None = None  # seconds, when the platform said


@dataclass
class StatsBatch:
    """``results``: fast counts per post id (``views``/``likes``/``comments``/``shares`` and ``extra``; a key that
    is absent was not read and keeps its stored value). ``insights``: slow insight fields per post id (only when they
    were read). ``errors``: a plain sentence per post id that got no numbers."""

    results: dict[str, Record] = field(default_factory=dict)
    insights: dict[str, Record] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    meta: ResponseMeta = field(default_factory=ResponseMeta)
    requests: int = 0
    units: int = 0

    def merge(self, other: StatsBatch) -> None:
        self.results.update(other.results)
        self.insights.update(other.insights)
        self.errors.update(other.errors)
        self.requests += other.requests
        self.units += other.units
        if other.meta.status >= 400 or self.meta.status < 400:
            self.meta = other.meta


class PlatformAdapter(Protocol):
    platform: str
    idempotent: bool

    def publish(self, clip: Record, account: Record | None, *, idempotency_key: str) -> Published: ...

    def metrics(self, post: Record, account: Record | None) -> Metrics: ...


class StatsAdapter(Protocol):
    platform: str

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch: ...


TokenProvider = Callable[[str, Record], str]


def no_tokens(platform: str, account: Record) -> str:
    """Phase 1: tokens come from Secrets Manager in phase 2, so every platform is "not connected" until then."""
    from .stub import LABELS

    raise NotConnectedError(f"Connecting {LABELS.get(platform, platform)} arrives in the next phase.")


def to_int(value: Any) -> int | None:
    """A count from a platform answer (numbers, numeric strings); anything else is ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def to_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def ms_to_seconds(value: Any) -> float | None:
    """Meta returns watch times in milliseconds; the app shows seconds (one decimal)."""
    number = to_number(value)
    return None if number is None else round(float(number) / 1000, 1)


def put_present(target: dict[str, Any], key: str, value: Any) -> None:
    """Only fields the platform actually returned are stored: absent stays absent, never 0 (§16.3)."""
    if value is not None:
        target[key] = value


def chunks(items: list[Record], size: int) -> list[list[Record]]:
    return [items[i : i + size] for i in range(0, len(items), size)] if items else []


def stats_id(post: Mapping[str, Any]) -> str | None:
    value = post.get("statsId")
    return str(value) if isinstance(value, str) and value else None


class AdapterBase:
    """Shared by the five real adapters. Publishing arrives in phase 2; until then ``publish`` reports "not
    connected". ``metrics`` (§14) is ``fetch_stats`` for one post. Every stats read needs an account and a token,
    so with no account (phase 1: ``posts.connected_account`` is always ``None``) nothing reaches the network."""

    platform = ""
    label = ""
    idempotent = True

    def __init__(self, *, tokens: TokenProvider = no_tokens, graph_api_version: str = "v25.0") -> None:
        self._tokens = tokens
        self.graph_api_version = graph_api_version

    def _not_connected(self) -> NotConnectedError:
        return NotConnectedError(f"Posting to {self.label} arrives in the next phase.")

    def publish(self, clip: Record, account: Record | None, *, idempotency_key: str) -> Published:
        raise self._not_connected()

    def token(self, account: Record | None) -> str:
        if account is None:
            raise NotConnectedError(f"Connect {self.label} in Settings › Posting › Accounts.")
        return self._tokens(self.platform, account)

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        raise NotImplementedError

    def metrics(self, post: Record, account: Record | None) -> Metrics:
        batch = self.fetch_stats([post], account, now=datetime.now(UTC), want_insights=False, http=urllib_client)
        post_id = str(post.get("postId"))
        if post_id not in batch.results:
            raise RetryablePublishError(batch.errors.get(post_id, f"{self.label} sent no numbers."))
        found = batch.results[post_id]
        return Metrics(
            views=found.get("views"),
            likes=found.get("likes"),
            comments=found.get("comments"),
            shares=found.get("shares"),
        )

    def missing(self, batch: StatsBatch, posts: list[Record], text: str) -> None:
        """Marks every post of the chunk without numbers with ``text``."""
        for post in posts:
            pid = str(post["postId"])
            if pid not in batch.results:
                batch.errors.setdefault(pid, text)


# --- Meta Graph API helpers (Instagram, Facebook) -------------------------------------------------------------------

GRAPH_HOST = "https://graph.facebook.com"


def graph_meta(resp: HttpResponse) -> ResponseMeta:
    """Status, headers (``x-business-use-case-usage`` and ``x-app-usage`` among them) and the Graph error code."""
    meta = ResponseMeta(status=resp.status, headers=dict(resp.headers))
    body = resp.json()
    error = body.get("error") if isinstance(body, dict) else None
    if resp.status >= 400 or isinstance(error, dict):
        code = (error or {}).get("code")
        meta.error_code = str(code) if code is not None else str(resp.status)
    return meta


def graph_error_message(resp: HttpResponse) -> str:
    body = resp.json()
    error = body.get("error") if isinstance(body, dict) else None
    return str((error or {}).get("message") or "") if isinstance(error, dict) else ""


def insight_values(node: Any) -> dict[str, Any]:
    """``{"data": [{"name", "values": [{"value"}]} | {"name", "total_value": {"value"}}]}`` → ``{name: value}``.
    A metric with no data (Meta returns an empty set, not 0) is left out."""
    out: dict[str, Any] = {}
    rows = node.get("data") if isinstance(node, dict) else None
    for row in rows or []:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            continue
        value: Any = None
        values = row.get("values")
        if isinstance(values, list) and values and isinstance(values[-1], dict):
            value = values[-1].get("value")
        elif isinstance(row.get("total_value"), dict):
            value = row["total_value"].get("value")
        if value is not None:
            out[row["name"]] = value
    return out
