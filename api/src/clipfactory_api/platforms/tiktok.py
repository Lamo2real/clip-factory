"""TikTok: Display API ``/v2/video/query/`` (docs/CONTRACTS.md §16.3).

``POST https://open.tiktokapis.com/v2/video/query/?fields=...`` with ``{"filters": {"video_ids": [≤ 20]}}``, scope
``video.list``. It gives views, likes, comments and shares only (no saves, watch time or reach). Posts of an
unaudited app are private (``SELF_ONLY``) and have no public id, so they are never read (``privacy: "private"``).
Limit: 600 requests per minute per endpoint; over it the answer is 429 with ``error.code = rate_limit_exceeded``.
"""

from __future__ import annotations

import json
from datetime import datetime

from .base import (
    AdapterBase,
    HttpClient,
    HttpRequest,
    Record,
    ResponseMeta,
    StatsBatch,
    chunks,
    stats_id,
    to_int,
)

QUERY_URL = (
    "https://open.tiktokapis.com/v2/video/query/?fields=id,share_url,view_count,like_count,comment_count,share_count"
)
IDS_PER_REQUEST = 20


class TikTokAdapter(AdapterBase):
    platform = "tiktok"
    label = "TikTok"

    def query_request(self, ids: list[str], token: str) -> HttpRequest:
        body = json.dumps({"filters": {"video_ids": ids}}, separators=(",", ":")).encode()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        return HttpRequest("POST", QUERY_URL, headers, body)

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        private = [p for p in posts if not stats_id(p)]
        self.missing(batch, private, "Posted privately. TikTok shows numbers after the app is approved.")
        for chunk in chunks([p for p in posts if stats_id(p)], IDS_PER_REQUEST):
            by_id = {stats_id(p): str(p["postId"]) for p in chunk}
            resp = http(self.query_request([i for i in by_id if i], token))
            body = resp.json()
            error = body.get("error") if isinstance(body, dict) else None
            code = str((error or {}).get("code") or "") or None
            meta = ResponseMeta(status=resp.status, headers=dict(resp.headers))
            if resp.status >= 400 or (code and code != "ok"):
                meta.error_code = code or str(resp.status)
            part = StatsBatch(meta=meta, requests=1)
            if meta.error_code is None and isinstance(body, dict):
                for video in (body.get("data") or {}).get("videos") or []:
                    if not isinstance(video, dict) or video.get("id") not in by_id:
                        continue
                    part.results[by_id[video["id"]]] = {
                        "views": to_int(video.get("view_count")),
                        "likes": to_int(video.get("like_count")),
                        "comments": to_int(video.get("comment_count")),
                        "shares": to_int(video.get("share_count")),
                        "extra": {},
                    }
                self.missing(part, chunk, "TikTok could not find this video. It may be private or deleted.")
            else:
                self.missing(part, chunk, "TikTok did not answer. We will try again soon.")
            batch.merge(part)
            if meta.error_code == "rate_limit_exceeded" or resp.status == 429:
                break
        self.missing(batch, posts, "TikTok is busy. We will try again in a minute.")
        return batch
