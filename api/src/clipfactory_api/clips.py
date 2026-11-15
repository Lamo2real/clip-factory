"""Clip items: the public shape (with short-lived media links) and caption edits."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import db, s3
from .errors import bad_request

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
# Internal fields never leave the API (docs/CONTRACTS.md §13, §14.5). publishState is "pending" from Confirm until
# the durable cf-prod-clip-flow has started, then "started". publishClaimAt is gone but may linger on old items.
INTERNAL_FIELDS = (
    "videoKey",
    "coverKey",
    "publishState",
    "postsCreated",
    "flowRun",
    "flowExecutionArn",
    "publishClaimAt",
)
PUBLISH_PENDING = "pending"
PUBLISH_STARTED = "started"


def public_clip(item: Item, media: s3.Media | None = None) -> Item:
    """The Clip shape of §5. With ``media`` it carries 1-hour ``videoUrl``/``coverUrl`` links; without (the live
    WebSocket events) it carries none, and the web keeps the links it already has."""
    clip = db.strip_keys(item, INTERNAL_FIELDS)
    if media is not None and item.get("status") != "declined":
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
