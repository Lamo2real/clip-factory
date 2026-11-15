"""Post and Account items (docs/CONTRACTS.md §5, §6): one Post per platform when a clip is confirmed."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from . import db
from .ids import ulid
from .settings import PLATFORMS

Item = dict[str, Any]
POST_FIELDS = ("postId", "clipId", "platform", "status", "url", "postedAt", "perfCheckAt", "metrics", "error")


def public_post(item: Item) -> Item:
    return {k: item[k] for k in POST_FIELDS if k in item}


def account_items(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "ACCOUNT#")


def connected_account(store: db.Store, user_id: str, platform: str) -> Item | None:
    for item in account_items(store, user_id):
        if item.get("platform") == platform and item.get("status") == "connected":
            return item
    return None


def accounts(store: db.Store, user_id: str) -> list[Item]:
    """One Account per platform; a connected one wins over a stale one."""
    rank = {"connected": 0, "needs_reconnect": 1}
    best: dict[str, Item] = {}
    for item in account_items(store, user_id):
        platform = item.get("platform")
        if platform not in PLATFORMS:
            continue
        current = best.get(platform)
        if current is None or rank.get(item.get("status", ""), 9) < rank.get(current.get("status", ""), 9):
            best[platform] = item
    out = []
    for platform in PLATFORMS:
        found = best.get(platform)
        if found is None or found.get("status") not in rank:
            out.append({"platform": platform, "status": "not_connected"})
            continue
        account = {"platform": platform, "status": found["status"]}
        if found.get("handle"):
            account["handle"] = found["handle"]
        out.append(account)
    return out


def create_for_clip(
    store: db.Store,
    user_id: str,
    clip: Mapping[str, Any],
    settings: Mapping[str, Any],
    now: str,
    *,
    clip_fields: Mapping[str, Any] | None = None,
    expect_status: Iterable[str] | None = None,
) -> list[Item]:
    """Creates the clip's Posts, one per enabled platform, and returns all its posts (public shape).

    One transaction writes the missing posts together with ``postsCreated: true`` (plus ``clip_fields``) on the
    clip, conditional on the flag not being set yet (and on the clip's status being in ``expect_status``), so the
    posts are created exactly once even when Confirm and the clip-flow's ``ensure-posts`` step race or repeat.
    When the flag is already set nothing is written. Raises ``db.ConditionFailed`` if the condition fails.
    """
    clip_id = str(clip["clipId"])
    if clip.get("postsCreated"):
        return [public_post(p) for p in posts_for_clip(store, user_id, clip_id, consistent=True)]
    # Clips confirmed before the flag existed may already have some posts: never create a second one per platform.
    existing = [public_post(p) for p in posts_for_clip(store, user_id, clip_id, consistent=True)]
    have = {p["platform"] for p in existing}
    connected = {a["platform"] for a in accounts(store, user_id) if a["status"] == "connected"}
    created: list[Item] = []
    items: list[Item] = []
    for platform in settings.get("platforms", PLATFORMS):
        if platform in have or platform not in PLATFORMS:
            continue
        post_id = ulid()
        post = {
            "postId": post_id,
            "clipId": clip_id,
            "platform": platform,
            "status": "queued" if platform in connected else "pending_integration",
        }
        created.append(post)
        items.append(
            {
                "pk": db.user_pk(user_id),
                "sk": db.post_sk(post_id),
                "gsi1pk": f"CLIP#{clip_id}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": user_id,
                "createdAt": now,
                **post,
            }
        )
    update = db.update_request(
        db.user_pk(user_id),
        db.clip_sk(clip_id),
        {"postsCreated": True, **(clip_fields or {})},
        expect_in={"status": list(expect_status)} if expect_status is not None else None,
        expect_absent=["postsCreated"],
    )
    store.transact(puts=items, updates=[update])
    return existing + created


def posts_for_clip(store: db.Store, user_id: str, clip_id: str, *, consistent: bool = False) -> list[Item]:
    """A clip's posts. ``consistent`` reads the owner's partition with a strongly consistent query instead of the
    eventually consistent gsi1, for callers (Confirm, the clip-flow) that must see posts written moments earlier."""
    if consistent:
        items = store.query_all(db.user_pk(user_id), "POST#", consistent=True)
        return [i for i in items if i.get("clipId") == clip_id and i.get("type") == "post"]
    # gsi1 is not partitioned by owner, so every result is checked against the caller.
    items = store.query_all(f"CLIP#{clip_id}", "POST#", index="gsi1")
    return [i for i in items if i.get("userId") == user_id and i.get("type") == "post"]


def all_posts(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "POST#", newest_first=True)
