"""Post and Account items (docs/CONTRACTS.md §5, §6): one Post per platform when a clip is confirmed."""

from __future__ import annotations

from collections.abc import Iterable
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


def create_posts(store: db.Store, user_id: str, clip_id: str, platforms: Iterable[str]) -> list[Item]:
    connected = {a["platform"] for a in accounts(store, user_id) if a["status"] == "connected"}
    out = []
    for platform in platforms:
        post_id = ulid()
        post = {
            "postId": post_id,
            "clipId": clip_id,
            "platform": platform,
            "status": "queued" if platform in connected else "pending_integration",
        }
        store.put(
            {
                "pk": db.user_pk(user_id),
                "sk": db.post_sk(post_id),
                "gsi1pk": f"CLIP#{clip_id}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": user_id,
                **post,
            }
        )
        out.append(post)
    return out


def posts_for_clip(store: db.Store, user_id: str, clip_id: str, *, consistent: bool = False) -> list[Item]:
    """A clip's posts. ``consistent`` reads the owner's partition with a strongly consistent query instead of the
    eventually consistent gsi1, for callers (the publisher) that must see posts written moments earlier."""
    if consistent:
        items = store.query_all(db.user_pk(user_id), "POST#", consistent=True)
        return [i for i in items if i.get("clipId") == clip_id and i.get("type") == "post"]
    # gsi1 is not partitioned by owner, so every result is checked against the caller.
    items = store.query_all(f"CLIP#{clip_id}", "POST#", index="gsi1")
    return [i for i in items if i.get("userId") == user_id and i.get("type") == "post"]


def all_posts(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "POST#", newest_first=True)
