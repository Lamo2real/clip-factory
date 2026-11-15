"""Clip items: the public shape (with short-lived media links) and caption edits."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db, posts, s3, settings
from .clock import iso, parse
from .errors import bad_request
from .log import log

Item = dict[str, Any]

CAPTION_LIMITS: dict[str, int] = {
    "youtubeTitle": 100,
    "youtubeDescription": 5000,
    "instagram": 2200,
    "facebook": 5000,
    "tiktok": 2200,
    "x": 280,
}
STATUS_GROUPS: dict[str, frozenset[str] | None] = {
    "review": frozenset({"review"}),
    # Confirmed clips are on their way out: still queued, publishing, or a publish that failed.
    "confirmed": frozenset({"confirmed", "publishing", "failed"}),
    "posted": frozenset({"posted"}),
    "declined": frozenset({"declined"}),
    "all": None,
}
# publishState: "pending" from Confirm until the publish message is on the queue, then "enqueued".
# publishClaimAt: when Confirm (or a later resume) last started that work; it fences concurrent resumes.
INTERNAL_FIELDS = ("videoKey", "coverKey", "publishState", "publishClaimAt")
PUBLISH_PENDING = "pending"
PUBLISH_ENQUEUED = "enqueued"
# The API Lambda stops at 29 s, so a Confirm older than this is no longer running and its unfinished work may be
# resumed (by a second Confirm or by the watchdog).
RESUME_AFTER = timedelta(seconds=60)


def public_clip(item: Item, media: s3.Media) -> Item:
    clip = db.strip_keys(item, INTERNAL_FIELDS)
    if item.get("status") != "declined":
        if item.get("videoKey"):
            clip["videoUrl"] = media.presign_get(item["videoKey"])
        if item.get("coverKey"):
            clip["coverUrl"] = media.presign_get(item["coverKey"])
    return clip


def caption_patch(value: Any) -> dict[str, str]:
    """Validates ``Partial<Captions>``. Empty text is allowed: the owner may clear a caption."""
    if not isinstance(value, dict):
        raise bad_request("captions must be an object.")
    out: dict[str, str] = {}
    for field, text in value.items():
        limit = CAPTION_LIMITS.get(field)
        if limit is None:
            raise bad_request(f"Unknown caption: {field}.")
        if not isinstance(text, str):
            raise bad_request(f"The {field} caption must be text.")
        if len(text) > limit:
            raise bad_request(f"The {field} caption is too long (at most {limit} characters).")
        out[field] = text
    return out


def merged_captions(current: Mapping[str, Any] | None, patch: Mapping[str, str]) -> dict[str, str]:
    base = {k: str((current or {}).get(k, "")) for k in CAPTION_LIMITS}
    base.update(patch)
    return base


def clips_for_job(store: db.Store, user_id: str, job_id: str) -> list[Item]:
    # gsi1 is not partitioned by owner, so every result is checked against the caller.
    items = store.query_all(f"JOB#{job_id}", "CLIP#", index="gsi1")
    return [i for i in items if i.get("userId") == user_id and i.get("type") == "clip"]


def all_clips(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "CLIP#", newest_first=True)


# --- after Confirm: posts and the publish message -------------------------------------------------------------


def publish(store: db.Store, enqueue: Callable[[str, str], None], user_id: str, clip: Item) -> list[Item]:
    """Creates the confirmed clip's missing posts and queues it for the publisher. Safe to repeat: platforms that
    already have a post are skipped, and the publisher never sends a post twice. Returns all the clip's posts.

    If the message cannot be queued the clip stays ``publishState: pending``; a second Confirm or the watchdog
    resumes it (``claim_resume``).
    """
    existing = [posts.public_post(p) for p in posts.posts_for_clip(store, user_id, clip["clipId"], consistent=True)]
    have = {p["platform"] for p in existing}
    wanted = settings.load(store, user_id)["platforms"]
    created = posts.create_posts(store, user_id, clip["clipId"], [p for p in wanted if p not in have])
    try:
        enqueue(user_id, clip["clipId"])
        store.update(clip["pk"], clip["sk"], {"publishState": PUBLISH_ENQUEUED})
    except Exception as e:
        log("error", "clip.enqueue_failed", clipId=clip["clipId"], error=type(e).__name__)
    return existing + created


def claim_resume(store: db.Store, clip: Item, now: datetime) -> Item | None:
    """The clip, claimed for resuming, if a Confirm stopped before its publish message was queued; else None.

    The claim is a conditional write on ``publishClaimAt``, so two resumes never run at once.
    """
    if clip.get("status") != "confirmed" or clip.get("publishState") != PUBLISH_PENDING:
        return None
    last = parse(clip.get("publishClaimAt"))
    if last is None or now - last < RESUME_AFTER:
        return None
    try:
        return store.update(
            clip["pk"],
            clip["sk"],
            {"publishClaimAt": iso(now)},
            expect_in={
                "status": ["confirmed"],
                "publishState": [PUBLISH_PENDING],
                "publishClaimAt": [clip["publishClaimAt"]],
            },
        )
    except db.ConditionFailed:
        return None
