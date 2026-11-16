"""Instagram Reels: one field-expanded media listing per page of 50 (docs/CONTRACTS.md §16.3).

``GET /{v}/{ig-user-id}/media?fields=id,permalink,media_product_type,timestamp,like_count,comments_count,
insights.metric(...)&limit=50`` returns the counts and insights of 50 reels in one HTTP request; pages are followed
until every wanted reel is found or the listing reaches reels older than 31 days. ``views`` is the views metric
(``plays`` and ``ig_reels_aggregated_all_plays_count`` were removed in 2025; ``impressions`` never existed for
Reels and is never asked for). Watch times arrive in milliseconds and are stored in seconds. Meta delays this data
by up to 48 hours, so every insight is in the slow group "Can take 2 days".

If Meta rejects one metric (error code 100, e.g. a metric retired after this was written) that metric is dropped for
the run and the request is sent once more without it. A throttle (code 80002) is never retried: retries extend
Meta's block, and ``stats.budget.record`` blocks the platform instead.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from .base import (
    GRAPH_HOST,
    AdapterBase,
    HttpClient,
    HttpRequest,
    Record,
    StatsBatch,
    graph_error_message,
    graph_meta,
    insight_values,
    ms_to_seconds,
    put_present,
    stats_id,
    to_int,
    to_number,
)

METRICS: tuple[str, ...] = (
    "views",
    "reach",
    "saved",
    "shares",
    "total_interactions",
    "reposts",
    "ig_reels_avg_watch_time",
    "ig_reels_video_view_total_time",
    "reels_skip_rate",
)
PAGE_SIZE = 50
MAX_PAGES = 20
LOOKBACK = timedelta(days=31)
BAD_METRIC_CODE = "100"


class InstagramAdapter(AdapterBase):
    platform = "instagram"
    label = "Instagram"

    def media_request(self, ig_user_id: str, token: str, metrics: tuple[str, ...] = METRICS) -> HttpRequest:
        fields = (
            f"id,permalink,media_product_type,timestamp,like_count,comments_count,insights.metric({','.join(metrics)})"
        )
        url = f"{GRAPH_HOST}/{self.graph_api_version}/{quote(ig_user_id, safe='')}/media?fields={fields}&limit={PAGE_SIZE}"
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        user_id = str((account or {}).get("platformUserId") or "")
        wanted = {stats_id(p): str(p["postId"]) for p in posts if stats_id(p)}
        if not user_id or not wanted:
            self.missing(batch, posts, "Connect Instagram again in Settings › Posting › Accounts.")
            return batch
        metrics = METRICS
        request: HttpRequest | None = self.media_request(user_id, token, metrics)
        retried = False
        pages = 0
        oldest = now - LOOKBACK
        while request is not None and pages < MAX_PAGES:
            resp = http(request)
            meta = graph_meta(resp)
            batch.requests += 1
            batch.meta = meta
            if meta.error_code is not None:
                dropped = self._bad_metrics(graph_error_message(resp), metrics)
                if meta.error_code == BAD_METRIC_CODE and dropped and not retried:
                    retried = True
                    metrics = tuple(m for m in metrics if m not in dropped)
                    request = self.media_request(user_id, token, metrics)
                    continue
                break
            pages += 1
            body = resp.json() if isinstance(resp.json(), dict) else {}
            reached_old = False
            for media in body.get("data") or []:
                if not isinstance(media, dict):
                    continue
                if media.get("id") in wanted:
                    self._map(batch, wanted[media["id"]], media)
                stamp = _parse_time(media.get("timestamp"))
                if stamp is not None and stamp < oldest:
                    reached_old = True
            found_all = all(pid in batch.results for pid in wanted.values())
            next_url = (body.get("paging") or {}).get("next")
            if found_all or reached_old or not isinstance(next_url, str) or not next_url.startswith(f"{GRAPH_HOST}/"):
                request = None
            else:
                request = HttpRequest("GET", next_url, {"Authorization": f"Bearer {token}"})
        text = (
            "Instagram is busy. We will try again later."
            if batch.meta.error_code is not None
            else "Instagram could not find this reel. It may be deleted."
        )
        self.missing(batch, posts, text)
        return batch

    @staticmethod
    def _bad_metrics(message: str, metrics: tuple[str, ...]) -> set[str]:
        """The metric(s) a code-100 error names. "must be one of ..." lists the allowed values, so then the bad
        ones are those requested but not listed; otherwise the message names the bad one."""
        lowered = message.lower()
        if "must be one of" in lowered:
            allowed = lowered.split("must be one of", 1)[1]
            return {m for m in metrics if m not in _words(allowed)}
        return {m for m in metrics if m in _words(lowered)}

    def _map(self, batch: StatsBatch, post_id: str, media: dict[str, Any]) -> None:
        values = insight_values(media.get("insights"))
        batch.results[post_id] = {
            "likes": to_int(media.get("like_count")),
            "comments": to_int(media.get("comments_count")),
        }
        extra: dict[str, Any] = {}
        put_present(extra, "reach", to_int(values.get("reach")))
        put_present(extra, "saved", to_int(values.get("saved")))
        put_present(extra, "reposts", to_int(values.get("reposts")))
        put_present(extra, "totalInteractions", to_int(values.get("total_interactions")))
        put_present(extra, "avgWatchSeconds", ms_to_seconds(values.get("ig_reels_avg_watch_time")))
        put_present(extra, "totalWatchSeconds", ms_to_seconds(values.get("ig_reels_video_view_total_time")))
        skip = to_number(values.get("reels_skip_rate"))
        put_present(extra, "skipRatePercent", round(float(skip), 1) if skip is not None else None)
        slow: dict[str, Any] = {"extra": extra}
        put_present(slow, "views", to_int(values.get("views")))  # empty set (not ready yet): keep the last value
        put_present(slow, "shares", to_int(values.get("shares")))
        batch.insights[post_id] = slow


def _words(text: str) -> set[str]:
    return {w for w in "".join(c if c.isalnum() or c == "_" else " " for c in text).split() if w}


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00").replace("+0000", "+00:00"))
    except ValueError:
        return None
