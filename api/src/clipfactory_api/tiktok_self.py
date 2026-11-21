"""Post it on TikTok yourself (docs/CONTRACTS.md §42): the owner hands the clip to TikTok, posts it there for
Everyone, and tells Clip Factory it is out.

The clip's TikTok post (one per clip, as everywhere) becomes ``posted`` with the public ``by: "you"``. When that post
was Clip Factory's own (waiting, failed, or uploaded privately) its earlier fields are kept in the internal
``beforeYou`` so Undo can put them back; a post made here carries the internal ``madeByYou`` and Undo deletes it. A
pasted link gives the video's id: the post joins the stats poller (``statsId`` + ``gsi2``) like any public post.
Nothing here calls TikTok's posting API, so TikTok's API rules for unaudited apps do not apply to it.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from . import day7, db
from .clock import iso, parse
from .ids import ulid
from .posts import PERF_CHECK_DELAY, posts_for_clip
from .tiktok_link import TikTokVideo

Item = dict[str, Any]

DECIDED = ("confirmed", "publishing", "posted", "failed")
NOT_UPLOADED = "Upload this clip first. Then you can post it on TikTok yourself."
STILL_UPLOADING = "This clip is still uploading to TikTok. Wait until it is done, then try again."
STILL_STARTING = "This clip is still starting to upload. Try again in a minute."
ALREADY_PUBLIC = "This clip is already on TikTok for everyone."
NOT_YOURS = "This clip was not marked as posted by you, so there is nothing to undo."

# The fields a Clip Factory TikTok post may hold that "posted by you" replaces (kept in ``beforeYou`` for Undo).
REPLACED = (
    "status",
    "url",
    "postedAt",
    "perfCheckAt",
    "privacy",
    "error",
    "platformPostId",
    "statsId",
    "statsDueAt",
    "gsi2pk",
    "gsi2sk",
    "metrics",
    "statsError",
    "nextRefreshAt",
    # What was learned from the earlier video: day-7 views (§16.12) and the snapshot/insights bookkeeping. A post by
    # him is another video, so it starts fresh and Undo puts these back.
    *day7.FIELDS,
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
)
STATS_FIELDS = ("statsId", "statsDueAt", "gsi2pk", "gsi2sk")
LEARNED = (
    "metrics",
    "statsError",
    "nextRefreshAt",
    *day7.FIELDS,
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
)
# On the clip while a TikTok post made by I posted it exists: two taps at once can never make two TikTok posts.
MADE_MARK = "tiktokByYou"


class Refused(Exception):
    """A plain sentence for the owner, with the HTTP status that goes with it (409 or 400)."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def tiktok_row(rows: list[Item]) -> Item | None:
    return next((p for p in rows if p.get("platform") == "tiktok" and p.get("type") == "post"), None)


def _stats_fields(post_id: str, video: TikTokVideo, now: datetime, min_interval: int) -> Item:
    due = iso(now + timedelta(minutes=min_interval))
    return {"statsId": video.video_id, "statsDueAt": due, "gsi2pk": db.STATS_GSI_PK, "gsi2sk": f"{due}#{post_id}"}


def mark_posted(
    store: db.Store,
    clip: Mapping[str, Any],
    video: TikTokVideo | None,
    now: datetime,
    *,
    min_interval: int,
    count_views: bool = True,
) -> None:
    """Writes the clip's TikTok post as posted by the owner (creating it when the clip has none). With ``video``
    the post gets its link and, when ``count_views``, joins the poller. Marking again only adds or changes the link.
    Raises ``Refused``."""
    status = clip.get("status")
    if status not in DECIDED:
        raise Refused(NOT_UPLOADED)
    if not clip.get("postsCreated"):
        raise Refused(STILL_STARTING)
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    rows = posts_for_clip(store, user_id, clip_id, consistent=True)
    row = tiktok_row(rows)
    if row is not None and row.get("status") == "queued":
        raise Refused(STILL_UPLOADING)
    if row is not None and row.get("by") != "you" and row.get("status") == "posted" and row.get("privacy") == "public":
        raise Refused(ALREADY_PUBLIC)

    if row is None:
        post_id = ulid()
        posted_at = now
        item: Item = {
            "pk": db.user_pk(user_id),
            "sk": db.post_sk(post_id),
            "gsi1pk": f"CLIP#{clip_id}",
            "gsi1sk": "POST#tiktok",
            "type": "post",
            "userId": user_id,
            "createdAt": iso(now),
            "flowRun": int(clip.get("flowRun") or 1),
            "postId": post_id,
            "clipId": clip_id,
            "platform": "tiktok",
            "status": "posted",
            "by": "you",
            "madeByYou": True,
            "privacy": "public",
            "postedAt": iso(posted_at),
            "perfCheckAt": iso(posted_at + PERF_CHECK_DELAY),
            **({"campaignId": clip["campaignId"]} if clip.get("campaignId") else {}),
        }
        if video is not None:
            item["url"] = video.url
            if count_views:
                item.update(_stats_fields(post_id, video, now, min_interval))
        update = db.update_request(
            db.user_pk(user_id),
            db.clip_sk(clip_id),
            {
                "postIds": [*_post_ids(clip, rows), post_id],
                MADE_MARK: post_id,
                **_clip_status(status, rows, now_posted=True),
            },
            expect_in={"status": [status]},
            expect_absent=[MADE_MARK],
        )
        store.transact(puts=[item], updates=[update])
        return

    post_id = str(row["postId"])
    fields: Item = {"status": "posted", "by": "you", "privacy": "public"}
    remove: list[str] = []
    if row.get("by") != "you":
        # Clip Factory's own post (waiting, failed or private): keep what it was, for Undo.
        fields["beforeYou"] = {k: row[k] for k in REPLACED if k in row}
        posted_at = now
        fields["postedAt"] = iso(posted_at)
        fields["perfCheckAt"] = iso(posted_at + PERF_CHECK_DELAY)
        remove += [k for k in ("error", "platformPostId", "url", *LEARNED) if k in row]
        remove += [k for k in STATS_FIELDS if k in row]
    if video is not None:
        fields["url"] = video.url
        remove = [k for k in remove if k != "url"]
        same = row.get("by") == "you" and row.get("statsId") == video.video_id
        if row.get("by") == "you" and not same:
            # Another video than the one he linked before: its numbers and what was learned from it go.
            remove += [k for k in LEARNED if k in row and k not in remove]
        if count_views and not same:
            fields.update(_stats_fields(post_id, video, now, min_interval))
            remove = [k for k in remove if k not in STATS_FIELDS]
        elif not count_views:
            remove += [k for k in STATS_FIELDS if k in row and k not in remove]
    updates = [
        db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            fields,
            remove=remove,
            expect_in={"status": [str(row.get("status"))]},
        )
    ]
    clip_fields = _clip_status(status, [r for r in rows if r is not row], now_posted=True)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    store.transact(updates=updates)


def undo(store: db.Store, clip: Mapping[str, Any]) -> None:
    """Takes back "I posted it": a post made here is deleted, Clip Factory's own post gets its fields back."""
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    rows = posts_for_clip(store, user_id, clip_id, consistent=True)
    row = tiktok_row(rows)
    if row is None or row.get("by") != "you":
        raise Refused(NOT_YOURS)
    others = [r for r in rows if r is not row]
    status = str(clip.get("status"))
    if row.get("madeByYou"):
        ids = [i for i in _post_ids(clip, rows) if i != str(row["postId"])]
        clip_fields: Item = {"postIds": ids, **_clip_status(status, others, now_posted=False)}
        store.transact(
            updates=[
                db.update_request(
                    db.user_pk(user_id),
                    db.clip_sk(clip_id),
                    clip_fields,
                    remove=[MADE_MARK],
                    expect_in={"status": [status]},
                )
            ]
        )
        store.delete_if(str(row["pk"]), str(row["sk"]), {"by": ["you"]})
        return
    kept = row.get("beforeYou")
    before: Mapping[str, Any] = kept if isinstance(kept, Mapping) else {}
    back = {k: v for k, v in before.items() if k in REPLACED}
    back.setdefault("status", "failed")
    remove = ["by", "beforeYou", *[k for k in REPLACED if k in row and k not in back]]
    updates = [db.update_request(str(row["pk"]), str(row["sk"]), back, remove=remove, expect_in={"by": ["you"]})]
    restored = {**row, **back}
    clip_fields = _clip_status(status, [*others, restored], now_posted=False)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    store.transact(updates=updates)


def _post_ids(clip: Mapping[str, Any], rows: list[Item]) -> list[str]:
    """The clip's ``postIds``. Clips uploaded before that list existed have none; their posts were all read by the
    full fallback query (``posts_for_clip``), so the list starts from those, or later reads would see only the new one."""
    kept = clip.get("postIds")
    if isinstance(kept, list):
        return [str(i) for i in kept]
    return [str(r["postId"]) for r in rows if r.get("postId")]


def _clip_status(status: Any, others: list[Item], *, now_posted: bool) -> Item:
    """The clip's new status, when it changes: what the clip flow's settle would say (§14.5), never while its own
    upload is still running (``publishing``, or a ``confirmed`` clip with posts on their way)."""
    if status not in ("confirmed", "posted", "failed"):
        return {}
    statuses = {r.get("status") for r in others}
    if "queued" in statuses:
        return {}
    if now_posted or "posted" in statuses:
        new = "posted"
    elif "failed" in statuses:
        new = "failed"
    else:
        new = "confirmed"
    return {"status": new} if new != status else {}


def posted_at(row: Mapping[str, Any]) -> datetime | None:
    return parse(row.get("postedAt"))
