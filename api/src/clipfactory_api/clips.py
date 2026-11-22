"""Clip items: the public shape (with short-lived media links) and caption edits."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db, s3
from .clock import iso
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
# Public on purpose (§39.3): ``remakes`` (campaignId → {jobId, at}, the campaign copies made of this clip) and
# ``remakeOf`` ({clipId, jobId}, on a copy: the clip it was made from).
INTERNAL_FIELDS = (
    "videoKey",
    "coverKey",
    "publishState",
    "postsCreated",
    "postIds",
    "flowRun",
    "flowExecutionArn",
    "publishClaimAt",
    # §16.12: what the clip says (for the daily second look) and every key of its creator stay server side.
    "spokenText",
    "creatorKeys",
    # §46.10: the auto-posting run that uploaded the clip (public as ``auto``), and the hold a Throw away puts on it.
    "autoRun",
    "autoAt",
    "autoTest",
    "holdUntil",
)
PUBLISH_PENDING = "pending"
PUBLISH_STARTED = "started"
# Uploaded clips whose flow start Confirm finishes when it is still pending (§14.5): the public ``startPending``.
STARTABLE = ("confirmed", "publishing", "posted")
# §46.2: Throw away holds the clip on the server the moment it is tapped (internal ``holdUntil``), so auto-posting never
# sends it while Undo's 8 s toast is up; the decline itself goes when the toast ends, and Undo lifts the hold.
HOLD_FOR = timedelta(seconds=60)


def is_held(item: Mapping[str, Any], now: datetime) -> bool:
    """A Throw away's hold is still on (``holdUntil`` in the future). Compared as ISO strings, as the run's
    conditional write compares them (§46.7)."""
    until = item.get("holdUntil")
    return isinstance(until, str) and until > iso(now)


def public_clip(
    item: Item,
    media: s3.Media | None = None,
    *,
    posts: list[Item] | None = None,
    video: bool = True,
) -> Item:
    """The Clip shape of §5. With ``media`` it carries 1-hour ``coverUrl`` (and, unless ``video=False``,
    ``videoUrl``) links; without (the live WebSocket events) it carries none, and the web keeps the links it already
    has. With the clip's ``posts`` it carries ``totalViews`` (absent when nothing was measured). ``startPending: true``
    when the clip was uploaded but its flow has not started (``publishState: pending``, §14.5). ``auto`` when an
    auto-posting run uploaded it (§46.9)."""
    clip = db.strip_keys(item, INTERNAL_FIELDS)
    clip.pop("totalViews", None)
    if item.get("publishState") == PUBLISH_PENDING and item.get("status") in STARTABLE:
        clip["startPending"] = True  # uploaded, but its flow has not started yet: the Library offers Try again
    auto = public_auto(item)
    if auto is not None:
        clip["auto"] = auto
    if media is not None and item.get("status") != "declined":
        if video and item.get("videoKey"):
            clip["videoUrl"] = media.presign_get(item["videoKey"])
        if item.get("coverKey"):
            clip["coverUrl"] = media.presign_get(item["coverKey"])
    if posts is not None:
        total = total_views(posts)
        if total is not None:
            clip["totalViews"] = total
    return clip


def public_auto(item: Item) -> Item | None:
    """``Clip.auto`` (§46.9): the auto-posting run that uploaded the clip, ``test: "private"`` for a Private test run;
    None for a clip the owner uploaded himself (or one still in Review)."""
    run = item.get("autoRun")
    if not isinstance(run, str) or not run:
        return None
    auto: Item = {"runId": run, "at": str(item.get("autoAt") or "")}
    if item.get("autoTest") == "private":
        auto["test"] = "private"
    return auto


def total_views(posts: list[Item]) -> int | None:
    """Sum of ``metrics.views`` over the posted posts; ``None`` when none has a views number yet."""
    views = [
        p["metrics"].get("views") for p in posts if p.get("status") == "posted" and isinstance(p.get("metrics"), dict)
    ]
    numbers = [int(v) for v in views if isinstance(v, int | float) and not isinstance(v, bool)]
    return sum(numbers) if numbers else None


def posts_by_clip(posts: list[Item]) -> dict[str, list[Item]]:
    out: dict[str, list[Item]] = {}
    for post in posts:
        out.setdefault(str(post.get("clipId")), []).append(post)
    return out


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
