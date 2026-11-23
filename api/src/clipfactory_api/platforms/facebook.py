"""Facebook Reels: ``video_insights`` of the Reel's video id (docs/CONTRACTS.md §16.3).

One Reel per request: ``GET /{v}/{video id}?fields=video_insights.metric(...)``. Graph API v26.0 removed the multi-id
``?ids=`` lookup (every such request gets error 100, "The ids query parameter is deprecated in v26.0+"), so it is never
used. Every Reels metric is lifetime only; times are milliseconds and stored in seconds. ``fb_reels_total_plays`` is
the views number; likes are the sum of the reactions breakdown; comments and shares come only combined
(``post_video_social_actions``), so ``comments``/``shares`` stay ``null``.

Impressions and unique-views metrics (``post_impressions_unique``, ``total_video_impressions*``,
``total_video_views_unique``) stop working when Graph API v26.0 ships and are never asked for. Reach comes from the
guarded ``post_total_media_view_unique`` on the Reel's post id (``GET /{v}/{post id}?fields=insights.metric(...)``):
any error there just leaves ``reachUnique`` out.

A Graph error marks only its own Reel and is logged as ``stats.read_failed`` (Meta's code and message, with ids cut
out; never a token). A throttle or a dead token (190) stops the rest of the batch: every other Reel would get the same
answer, and a retry makes a Meta block longer.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import quote

from ..log import log
from .base import (
    GRAPH_HOST,
    AdapterBase,
    HttpClient,
    HttpRequest,
    HttpResponse,
    Record,
    ResponseMeta,
    StatsBatch,
    graph_error_message,
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
THROTTLE_CODES = {"80001", "4", "17", "32", "613"}
STOP_CODES = THROTTLE_CODES | {"190"}  # the same answer for every other Reel: stop asking
GONE_SUBCODE = "33"  # "Object with ID ... does not exist, cannot be loaded due to missing permissions"
NOT_ANSWERED = "Facebook did not answer. We will try again soon."
GONE = "Facebook could not find this Reel. It may be deleted."
_LONG_NUMBER = re.compile(r"\d{5,}")  # Reel, post and Page ids in Meta's messages
_TOKEN = re.compile(r"\bEA[A-Za-z0-9]{20,}")


def _node(value: str) -> str:
    return quote(value, safe="_")


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


def _subcode(resp: HttpResponse) -> str | None:
    body = resp.json()
    error = body.get("error") if isinstance(body, dict) else None
    sub = error.get("error_subcode") if isinstance(error, dict) else None
    return str(sub) if sub is not None else None


def _log_failure(meta: ResponseMeta, resp: HttpResponse) -> None:
    """The read that failed, so the logs say why (read-logs keeps the line by its ``error`` field). No ids, no token."""
    message = _TOKEN.sub("<token>", _LONG_NUMBER.sub("<id>", graph_error_message(resp)))
    sub = _subcode(resp)
    code = meta.error_code or "no_body"
    log(
        "warning",
        "stats.read_failed",
        platform="facebook",
        status=meta.status,
        code=f"{code}/{sub}" if sub else code,
        error=message[:200],
    )


class FacebookAdapter(AdapterBase):
    platform = "facebook"
    label = "Facebook"

    def insights_request(self, video_id: str, token: str) -> HttpRequest:
        url = (
            f"{GRAPH_HOST}/{self.graph_api_version}/{_node(video_id)}"
            f"?fields=video_insights.metric({','.join(VIDEO_METRICS)})"
        )
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def reach_request(self, post_id: str, token: str) -> HttpRequest:
        url = f"{GRAPH_HOST}/{self.graph_api_version}/{_node(post_id)}?fields=insights.metric({REACH_METRIC})"
        return HttpRequest("GET", url, {"Authorization": f"Bearer {token}"})

    def fetch_stats(
        self, posts: list[Record], account: Record | None, *, now: datetime, want_insights: bool, http: HttpClient
    ) -> StatsBatch:
        token = self.token(account)
        batch = StatsBatch()
        self.missing(batch, [p for p in posts if not stats_id(p)], "This Reel has no Facebook id yet.")
        for post in posts:
            if not stats_id(post):
                continue
            part = self._read(post, token, http)
            batch.merge(part)
            if part.meta.error_code in STOP_CODES:
                break  # never retry a Meta throttle: it extends the block; a dead token fails every Reel
        self.missing(batch, posts, "Facebook is busy. We will try again later.")
        return batch

    def _read(self, post: Record, token: str, http: HttpClient) -> StatsBatch:
        post_id = str(post["postId"])
        resp = http(self.insights_request(str(stats_id(post)), token))
        batch = StatsBatch(meta=graph_meta(resp), requests=1)
        body = resp.json()
        if batch.meta.error_code is not None or not isinstance(body, dict):
            _log_failure(batch.meta, resp)
            gone = batch.meta.error_code == "100" and _subcode(resp) == GONE_SUBCODE
            batch.errors[post_id] = GONE if gone else NOT_ANSWERED
            return batch
        values = insight_values(body.get("video_insights"))
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
        self._reach(batch, post, token, http)
        return batch

    def _reach(self, batch: StatsBatch, post: Record, token: str, http: HttpClient) -> None:
        fb_post_id = post.get("platformPostId")
        if not fb_post_id:
            return
        resp = http(self.reach_request(str(fb_post_id), token))
        batch.requests += 1
        meta = graph_meta(resp)
        if meta.error_code is not None:
            if meta.error_code in THROTTLE_CODES:
                batch.meta = meta
            return  # guarded: reachUnique stays absent
        batch.meta = meta  # the newest usage header
        body = resp.json()
        if isinstance(body, dict):
            reach = to_int(insight_values(body.get("insights")).get(REACH_METRIC))
            put_present(batch.insights[str(post["postId"])]["extra"], "reachUnique", reach)
