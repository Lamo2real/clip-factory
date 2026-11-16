"""YouTube: Data API v3 for live counts, Analytics API v2 for the slow insights (docs/CONTRACTS.md §16.3).

* Fast: ``GET /youtube/v3/videos?part=statistics&id={≤50 ids}``, 1 quota unit per call whatever the number of ids.
  ``viewCount`` (Shorts count every play and replay since 2025-03-31), ``likeCount``, ``commentCount``.
  ``favoriteCount`` is always 0 and dislikes are private, so neither is read. ``shares`` only comes from Analytics.
* Slow: ``GET /v2/reports?ids=channel==MINE&...&dimensions=video&filters=video=={≤50 ids}``. Google processes this
  data with a 48–72 hour delay, so it is read every ``insightsIntervalMinutes`` (6 h) and shown as "Updates daily".
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from .base import (
    AdapterBase,
    HttpClient,
    HttpRequest,
    HttpResponse,
    Record,
    ResponseMeta,
    StatsBatch,
    chunks,
    put_present,
    stats_id,
    to_int,
    to_number,
)

VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports"
IDS_PER_REQUEST = 50
QUOTA_REASONS = frozenset({"quotaExceeded", "rateLimitExceeded", "dailyLimitExceeded"})
QUOTA_TEXT = "YouTube's daily limit is used up. Numbers come back tomorrow."
ANALYTICS_METRICS = (
    "views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,"
    "subscribersGained"
)


def _meta(resp: HttpResponse) -> ResponseMeta:
    meta = ResponseMeta(status=resp.status, headers=dict(resp.headers))
    if resp.status >= 400:
        body = resp.json()
        error = body.get("error") if isinstance(body, dict) else None
        reasons = [e.get("reason") for e in (error or {}).get("errors", []) if isinstance(e, dict)]
        meta.error_code = next((str(r) for r in reasons if r), None) or str(resp.status)
    return meta


class YouTubeAdapter(AdapterBase):
    platform = "youtube"
    label = "YouTube"

    def videos_request(self, ids: list[str], token: str) -> HttpRequest:
        url = f"{VIDEOS_URL}?part=statistics&id={','.join(quote(i, safe='') for i in ids)}"
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}", "Accept": "application/json"})

    def reports_request(self, ids: list[str], start: str, end: str, token: str) -> HttpRequest:
        url = (
            f"{REPORTS_URL}?ids=channel==MINE&startDate={start}&endDate={end}&metrics={ANALYTICS_METRICS}"
            f"&dimensions=video&filters=video=={','.join(quote(i, safe='') for i in ids)}"
        )
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}", "Accept": "application/json"})

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        usable = [p for p in posts if stats_id(p)]
        self.missing(batch, [p for p in posts if not stats_id(p)], "This video has no YouTube id yet.")
        for chunk in chunks(usable, IDS_PER_REQUEST):
            batch.merge(self._fast(chunk, token, http))
            if batch.meta.status >= 400 and batch.meta.error_code in QUOTA_REASONS:
                self.missing(batch, usable, QUOTA_TEXT)
                return batch
        if want_insights:
            for chunk in chunks(usable, IDS_PER_REQUEST):
                batch.merge(self._slow(chunk, token, now, http))
        return batch

    def _fast(self, chunk: list[Record], token: str, http: HttpClient) -> StatsBatch:
        by_id = {stats_id(p): str(p["postId"]) for p in chunk}
        resp = http(self.videos_request([i for i in by_id if i], token))
        batch = StatsBatch(meta=_meta(resp), requests=1, units=1)
        body = resp.json()
        if resp.status >= 400 or not isinstance(body, dict):
            quota = batch.meta.error_code in QUOTA_REASONS
            self.missing(batch, chunk, QUOTA_TEXT if quota else "YouTube did not answer. We will try again soon.")
            return batch
        for row in body.get("items") or []:
            if not isinstance(row, dict) or row.get("id") not in by_id:
                continue
            stats = row.get("statistics") or {}
            batch.results[by_id[row["id"]]] = {
                "views": to_int(stats.get("viewCount")),
                "likes": to_int(stats.get("likeCount")),
                "comments": to_int(stats.get("commentCount")),
                "extra": {},
            }
        self.missing(batch, chunk, "YouTube could not find this video. It may be private or deleted.")
        return batch

    def _slow(self, chunk: list[Record], token: str, now: datetime, http: HttpClient) -> StatsBatch:
        by_id = {stats_id(p): str(p["postId"]) for p in chunk}
        posted = [str(p.get("postedAt") or "")[:10] for p in chunk if p.get("postedAt")]
        start = min(posted) if posted else (now - timedelta(days=30)).date().isoformat()
        resp = http(self.reports_request([i for i in by_id if i], start, now.date().isoformat(), token))
        # Analytics has its own quota, so its answer never blocks the Data API budget (default meta).
        batch = StatsBatch(requests=1, units=0)
        body = resp.json()
        if resp.status >= 400 or not isinstance(body, dict):
            return batch  # slow numbers are a bonus: the fast counts stand on their own
        headers = [str(h.get("name")) for h in body.get("columnHeaders") or [] if isinstance(h, dict)]
        for row in body.get("rows") or []:
            if not isinstance(row, list) or len(row) != len(headers):
                continue
            values: dict[str, Any] = dict(zip(headers, row, strict=True))
            post_id = by_id.get(values.get("video"))
            if post_id is None:
                continue
            extra: dict[str, Any] = {}
            put_present(extra, "engagedViews", to_int(values.get("engagedViews")))
            put_present(extra, "watchMinutes", to_number(values.get("estimatedMinutesWatched")))
            put_present(extra, "avgViewSeconds", to_number(values.get("averageViewDuration")))
            put_present(extra, "avgViewPercent", to_number(values.get("averageViewPercentage")))
            put_present(extra, "subscribersGained", to_int(values.get("subscribersGained")))
            slow: dict[str, Any] = {"extra": extra}
            put_present(slow, "shares", to_int(values.get("shares")))
            batch.insights[post_id] = slow
        return batch
