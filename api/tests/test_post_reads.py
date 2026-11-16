"""F001: reading one clip's posts never depends on how many posts the owner has, and owner-wide reads have no
silent cap (an owner with more than 5000 posts still gets every one, newest included)."""

from __future__ import annotations

from typing import Any

from clipfactory_api import clips, db, posts, settings
from clipfactory_api.ids import ulid
from conftest import USER, seed_clip
from fakes import FakeTable

MANY = 5001


def _post(clip_id: str, platform: str = "youtube") -> dict[str, Any]:
    post_id = ulid()
    return {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip_id}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip_id,
        "platform": platform,
        "status": "posted",
    }


def _fill(table: FakeTable, count: int = MANY) -> None:
    """``count`` older posts under other clips, written straight into the fake table (fast)."""
    for n in range(count):
        item = _post(f"OLD{n // 5}")
        table.items[(item["pk"], item["sk"])] = item
    table.page_size = 1000  # real DynamoDB pages too: make query_all follow several pages


def _owner_post_queries(table: FakeTable) -> list[dict[str, Any]]:
    return [
        kw
        for name, kw in table.calls
        if name == "query"
        and "IndexName" not in kw
        and kw["ExpressionAttributeValues"].get(":prefix") == "POST#"
        and kw["ExpressionAttributeValues"].get(":pk") == db.user_pk(USER)
    ]


def test_query_all_has_no_silent_cap(store: db.Store, table: FakeTable) -> None:
    _fill(table)
    newest = _post("NEW")
    store.put(newest)
    found = store.query_all(db.user_pk(USER), "POST#")
    assert len(found) == MANY + 1
    assert found[-1]["postId"] == newest["postId"]
    assert store.query_all(db.user_pk(USER), "POST#", newest_first=True)[0]["postId"] == newest["postId"]
    assert len(store.query_all(db.user_pk(USER), "POST#", cap=10)) == 10  # an explicit cap still works


def test_new_clip_posts_are_found_after_5000_posts(store: db.Store, table: FakeTable) -> None:
    _fill(table)
    clip = seed_clip(store, status="confirmed")
    created = posts.create_for_clip(store, USER, clip, settings.with_defaults(None), "now")
    assert len(created) == 5
    table.calls.clear()
    found = posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)
    assert sorted(p["postId"] for p in found) == sorted(p["postId"] for p in created)
    # One clip's posts are read by key: no scan of the owner's whole POST# range.
    assert _owner_post_queries(table) == []
    # A repeated Confirm / ensure-posts sees the same posts and creates nothing.
    stored = store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored is not None
    again = posts.create_for_clip(store, USER, stored, settings.with_defaults(None), "now")
    assert sorted(p["postId"] for p in again) == sorted(p["postId"] for p in created)
    assert posts.posts_for_clip(store, USER, clip["clipId"]) != []  # the gsi1 path agrees


def test_first_confirm_does_not_scan_the_owner_partition(store: db.Store, table: FakeTable) -> None:
    _fill(table)
    clip = seed_clip(store, status="confirmed")
    table.calls.clear()
    posts.create_for_clip(store, USER, clip, settings.with_defaults(None), "now")
    assert _owner_post_queries(table) == []


def test_clip_without_post_ids_falls_back_to_a_full_read(store: db.Store, table: FakeTable) -> None:
    """Clips confirmed before ``postIds`` existed: every page of the owner's posts is read, newest included."""
    _fill(table)
    clip = seed_clip(store, status="confirmed", postsCreated=True)
    newest = _post(clip["clipId"])
    store.put(newest)
    found = posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)
    assert [p["postId"] for p in found] == [newest["postId"]]


def test_post_ids_stay_internal(store: db.Store) -> None:
    clip = seed_clip(store, status="confirmed")
    posts.create_for_clip(store, USER, clip, settings.with_defaults(None), "now")
    stored = store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored is not None
    assert len(stored["postIds"]) == 5
    assert "postIds" not in clips.public_clip(stored)
