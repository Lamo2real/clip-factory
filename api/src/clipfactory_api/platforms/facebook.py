"""Facebook Reels: ``video_insights`` of the Reel's video id (docs/CONTRACTS.md §16.3).

``GET /{v}/?ids={≤50 video ids}&fields=video_insights.metric(...)`` reads many Reels in one HTTP request (each id
still counts against the Page's rate budget). Every Reels metric is lifetime only; times are milliseconds and stored
in seconds. ``fb_reels_total_plays`` is the views number; likes are the sum of the reactions breakdown; comments and
shares come only combined (``post_video_social_actions``), so ``comments``/``shares`` stay ``null``.

Impressions and unique-views metrics (``post_impressions_unique``, ``total_video_impressions*``,
``total_video_views_unique``) stop working when Graph API v26.0 ships and are never asked for. Reach comes from the
guarded ``post_total_media_view_unique`` on the Reel's post id: any error there just leaves ``reachUnique`` out.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import quote

from .base import (
    GRAPH_HOST,
    AdapterBase,
    HttpClient,
    HttpRequest,
    Record,
    StatsBatch,
    chunks,
    graph_meta,
    insight_values,
    ms_to_seconds,
    put_present,
    stats_id,
    to_int,
)

VIDEO_METRICS: tuple[str, ...] = (
    "blue_reels_play_count",
    "fb_reels_total_plays",
    "fb_reels_replay_count",
    "post_video_avg_time_watched",
    "post_video_view_time",
    "post_video_followers",
    "post_video_likes_by_reaction_type",
    "post_video_social_actions",
)
REACH_METRIC = "post_total_media_view_unique"
IDS_PER_REQUEST = 50
THROTTLE_CODES = {"80001", "4", "17", "32", "613"}


def _ids(values: list[str]) -> str:
    return ",".join(quote(v, safe="_") for v in values)


def _total(value: Any) -> int | None:
    """A number, or the sum of a ``{key: number}`` breakdown."""
    if isinstance(value, dict):
        numbers = [to_int(v) for v in value.values()]
        return sum(n for n in numbers if n is not None)
    return to_int(value)


def _reactions(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, int] = {}
    for key, count in value.items():
        number = to_int(count)
        if number is None:
            continue
        name = str(key).lower().removeprefix("reaction_")
        out[name] = number
    return out


class FacebookAdapter(AdapterBase):
    platform = "facebook"
    label = "Facebook"

    def insights_request(self, video_ids: list[str], token: str) -> HttpRequest:
        url = (
            f"{GRAPH_HOST}/{self.graph_api_version}/?ids={_ids(video_ids)}"
            f"&fields=video_insights.metric({','.join(VIDEO_METRICS)})"
        )
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def reach_request(self, post_ids: list[str], token: str) -> HttpRequest:
        url = f"{GRAPH_HOST}/{self.graph_api_version}/?ids={_ids(post_ids)}&fields=insights.metric({REACH_METRIC})"
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        usable = [p for p in posts if stats_id(p)]
        self.missing(batch, [p for p in posts if not stats_id(p)], "This Reel has no Facebook id yet.")
        for chunk in chunks(usable, IDS_PER_REQUEST):
            part = self._chunk(chunk, token, http)
            batch.merge(part)
            if part.meta.error_code in THROTTLE_CODES:
                break  # never retry a Meta throttle: it extends the block
        self.missing(batch, posts, "Facebook is busy. We will try again later.")
        return batch

    def _chunk(self, chunk: list[Record], token: str, http: HttpClient) -> StatsBatch:
        by_video = {stats_id(p): p for p in chunk}
        resp = http(self.insights_request([i for i in by_video if i], token))
        batch = StatsBatch(meta=graph_meta(resp), requests=1)
        body = resp.json()
        if batch.meta.error_code is not None or not isinstance(body, dict):
            self.missing(batch, chunk, "Facebook did not answer. We will try again soon.")
            return batch
        for video_id, post in by_video.items():
            node = body.get(video_id)
            if not isinstance(node, dict):
                continue
            values = insight_values(node.get("video_insights"))
            post_id = str(post["postId"])
            extra: dict[str, Any] = {}
            put_present(extra, "initialPlays", to_int(values.get("blue_reels_play_count")))
            put_present(extra, "replays", to_int(values.get("fb_reels_replay_count")))
            put_present(extra, "reactions", _reactions(values.get("post_video_likes_by_reaction_type")))
            put_present(extra, "commentsAndShares", _total(values.get("post_video_social_actions")))
            put_present(extra, "avgWatchSeconds", ms_to_seconds(values.get("post_video_avg_time_watched")))
            put_present(extra, "totalWatchSeconds", ms_to_seconds(values.get("post_video_view_time")))
            put_present(extra, "followsGained", to_int(values.get("post_video_followers")))
            slow: dict[str, Any] = {"extra": extra}
            put_present(slow, "views", to_int(values.get("fb_reels_total_plays")))
            if "post_video_likes_by_reaction_type" in values:
                put_present(slow, "likes", _total(values["post_video_likes_by_reaction_type"]))
            batch.results[post_id] = {"comments": None, "shares": None}
            batch.insights[post_id] = slow
        self.missing(batch, chunk, "Facebook could not find this Reel. It may be deleted.")
        if batch.insights:
            self._reach(batch, chunk, token, http)
        return batch

    def _reach(self, batch: StatsBatch, chunk: list[Record], token: str, http: HttpClient) -> None:
        by_post = {str(p["platformPostId"]): str(p["postId"]) for p in chunk if p.get("platformPostId")}
        by_post = {k: v for k, v in by_post.items() if v in batch.insights}
        if not by_post:
            return
        resp = http(self.reach_request(list(by_post), token))
        batch.requests += 1
        meta = graph_meta(resp)
        if meta.error_code is not None:
            if meta.error_code in THROTTLE_CODES:
                batch.meta = meta
            return  # guarded: reachUnique stays absent
        batch.meta = meta  # the newest usage header
        body = resp.json()
        if not isinstance(body, dict):
            return
        for fb_post_id, post_id in by_post.items():
            node = body.get(fb_post_id)
            if isinstance(node, dict):
                reach = to_int(insight_values(node.get("insights")).get(REACH_METRIC))
                put_present(batch.insights[post_id]["extra"], "reachUnique", reach)
