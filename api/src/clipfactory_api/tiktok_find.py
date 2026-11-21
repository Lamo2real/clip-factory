"""Find the clip the owner just posted on TikTok himself (docs/CONTRACTS.md §42.2), so he needs no link.

TikTok's Display API ``POST /v2/video/list/`` (scope ``video.list``, already granted for the numbers, §16.3) lists the
connected account's public posts, newest first. A post made after the sheet opened whose description starts like the
clip's TikTok caption is the one; with no such match, the only post made since then is. Anything TikTok does not
answer, or more than one candidate without a match, finds nothing: the owner can still paste the link.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from . import db
from .log import log
from .oauth import OAuthEnv, providers
from .oauth.tokens import ReconnectNeededError, SecretsTokenProvider
from .platforms.base import HttpRequest, NotConnectedError, RetryablePublishError
from .tiktok_link import LinkError, TikTokVideo, find

LIST_URL = "https://open.tiktokapis.com/v2/video/list/?fields=id,share_url,create_time,video_description,title"
MAX_COUNT = 20
EARLY_SECONDS = 600  # a post a little older than the sheet still counts (clocks, a sheet reopened)
MATCH_CHARS = 24


def _norm(text: Any) -> str:
    plain = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9#]+", " ", plain).strip()


def pick(videos: list[Mapping[str, Any]], *, since: datetime, caption: str) -> Mapping[str, Any] | None:
    cutoff = since.timestamp() - EARLY_SECONDS
    fresh = []
    for video in videos:
        try:
            made = int(video.get("create_time") or 0)
        except (TypeError, ValueError):
            continue
        if made >= cutoff and str(video.get("id") or "").isdigit():
            fresh.append(video)
    fresh.sort(key=lambda v: int(v.get("create_time") or 0), reverse=True)
    key = _norm(caption)[:MATCH_CHARS]
    if key:
        for video in fresh:
            said = _norm(video.get("video_description") or video.get("title"))
            if said.startswith(key) or key.startswith(said[:MATCH_CHARS] or "\0"):
                return video
    return fresh[0] if len(fresh) == 1 else None


def find_recent(
    env: OAuthEnv, store: db.Store, account: Mapping[str, Any], *, since: datetime, caption: str
) -> TikTokVideo | None:
    tokens = SecretsTokenProvider(store, env)
    try:
        creds = tokens.credentials("tiktok", dict(account))
        headers = {
            "Authorization": f"Bearer {creds.access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        resp = providers.call(
            env, HttpRequest("POST", LIST_URL, headers, json.dumps({"max_count": MAX_COUNT}).encode())
        )
    except (ReconnectNeededError, NotConnectedError, RetryablePublishError, providers.Fail) as e:
        log("warning", "tiktok_find.failed", error=type(e).__name__)
        return None
    body = providers.body(resp)
    error = body.get("error") if isinstance(body.get("error"), Mapping) else {}
    if resp.status != 200 or str((error or {}).get("code") or "ok") != "ok":
        log("warning", "tiktok_find.refused", status=resp.status, code=str((error or {}).get("code") or ""))
        return None
    data = body.get("data") if isinstance(body.get("data"), Mapping) else {}
    videos = [v for v in (data or {}).get("videos") or [] if isinstance(v, Mapping)]
    video = pick(videos, since=since, caption=caption)
    if video is None:
        return None
    try:
        found = find(str(video.get("share_url") or "")).video
    except LinkError:
        found = None
    if found is not None and found.video_id == str(video["id"]):
        return found
    return TikTokVideo(video_id=str(video["id"]))
