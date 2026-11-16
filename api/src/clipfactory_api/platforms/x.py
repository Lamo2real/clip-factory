"""X: post lookup by ids, ``GET /2/tweets`` (docs/CONTRACTS.md §16.3).

One request reads up to 100 posts with their attached video. The views number is the video's
``public_metrics.view_count`` (never ``impression_count``). Owner-only numbers (``non_public_metrics``,
``organic_metrics``: impressions, link and profile clicks, how far people watched) need user-context auth and only
exist for posts younger than 30 days, so older posts are read in a separate request without those fields.
Limits: 3,500 requests per 15 minutes per app; X bills every post read (deduplicated per UTC day), which
``stats.budget`` caps at ``monthlyUsd``.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

from ..clock import parse
from .base import (
    AdapterBase,
    HttpClient,
    HttpRequest,
    Record,
    ResponseMeta,
    StatsBatch,
    chunks,
    put_present,
    stats_id,
    to_int,
)

TWEETS_URL = "https://api.x.com/2/tweets"
IDS_PER_REQUEST = 100
NON_PUBLIC_MAX_AGE = timedelta(days=30)
FULL_FIELDS = (
    "tweet.fields=public_metrics,non_public_metrics,organic_metrics,created_at"
    "&expansions=attachments.media_keys&media.fields=public_metrics,non_public_metrics"
)
PUBLIC_FIELDS = "tweet.fields=public_metrics,created_at&expansions=attachments.media_keys&media.fields=public_metrics"


def _meta(status: int, headers: dict[str, str], body: Any) -> ResponseMeta:
    meta = ResponseMeta(status=status, headers=dict(headers))
    reset = to_int(headers.get("x-rate-limit-reset"))
    if status == 429:
        meta.error_code = "429"
    elif status >= 400:
        title = body.get("title") if isinstance(body, dict) else None
        meta.error_code = str(title or status)
    if reset is not None:
        meta.retry_after = reset  # epoch seconds when the window resets
    return meta


class XAdapter(AdapterBase):
    platform = "x"
    label = "X"
    idempotent = False  # X has no idempotency key for new posts

    def __init__(self, *args: Any, non_public_max_age: timedelta = NON_PUBLIC_MAX_AGE, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.non_public_max_age = non_public_max_age

    def lookup_request(self, ids: list[str], token: str, *, non_public: bool) -> HttpRequest:
        fields = FULL_FIELDS if non_public else PUBLIC_FIELDS
        url = f"{TWEETS_URL}?ids={','.join(quote(i, safe='') for i in ids)}&{fields}"
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        usable = [p for p in posts if stats_id(p)]
        self.missing(batch, [p for p in posts if not stats_id(p)], "This post has no X id yet.")
        young = [p for p in usable if not self._old(p, now)]
        old = [p for p in usable if self._old(p, now)]
        for group, non_public in ((young, True), (old, False)):
            for chunk in chunks(group, IDS_PER_REQUEST):
                part = self._chunk(chunk, token, http, non_public=non_public)
                batch.merge(part)
                if part.meta.status == 429:
                    self.missing(batch, posts, "X is busy. We will try again soon.")
                    return batch
        self.missing(batch, posts, "X could not find this post. It may be deleted.")
        return batch

    def _old(self, post: Record, now: datetime) -> bool:
        posted = parse(post.get("postedAt"))
        return posted is not None and now - posted >= self.non_public_max_age

    def _chunk(self, chunk: list[Record], token: str, http: HttpClient, *, non_public: bool) -> StatsBatch:
        by_id = {stats_id(p): str(p["postId"]) for p in chunk}
        resp = http(self.lookup_request([i for i in by_id if i], token, non_public=non_public))
        body = resp.json()
        batch = StatsBatch(meta=_meta(resp.status, resp.headers, body), requests=1)
        if resp.status >= 400 or not isinstance(body, dict):
            self.missing(batch, chunk, "X did not answer. We will try again soon.")
            return batch
        media = {
            m.get("media_key"): m
            for m in (body.get("includes") or {}).get("media") or []
            if isinstance(m, dict) and m.get("media_key")
        }
        for tweet in body.get("data") or []:
            if not isinstance(tweet, dict) or tweet.get("id") not in by_id:
                continue
            batch.results[by_id[tweet["id"]]] = self._map(tweet, media)
        return batch

    @staticmethod
    def _map(tweet: dict[str, Any], media: dict[Any, dict[str, Any]]) -> Record:
        public = tweet.get("public_metrics") or {}
        private = tweet.get("non_public_metrics") or {}
        keys = (tweet.get("attachments") or {}).get("media_keys") or []
        attached = [media[k] for k in keys if k in media]
        video = next(
            (m for m in attached if m.get("type") in {"video", "animated_gif"}), attached[0] if attached else None
        )
        video_public = (video or {}).get("public_metrics") or {}
        video_private = (video or {}).get("non_public_metrics") or {}
        extra: dict[str, Any] = {}
        put_present(extra, "impressions", to_int(public.get("impression_count")))
        put_present(extra, "reposts", to_int(public.get("retweet_count")))
        put_present(extra, "quotes", to_int(public.get("quote_count")))
        put_present(extra, "bookmarks", to_int(public.get("bookmark_count")))
        put_present(extra, "linkClicks", to_int(private.get("url_link_clicks")))
        put_present(extra, "profileClicks", to_int(private.get("user_profile_clicks")))
        put_present(extra, "engagements", to_int(private.get("engagements")))
        for n in (0, 25, 50, 75, 100):
            put_present(extra, f"playback{n}", to_int(video_private.get(f"playback_{n}_count")))
        return {
            "views": to_int(video_public.get("view_count")),
            "likes": to_int(public.get("like_count")),
            "comments": to_int(public.get("reply_count")),
            "shares": to_int(public.get("retweet_count")),
            "extra": extra,
        }
