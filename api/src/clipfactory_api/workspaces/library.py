"""Library lists and filtered pages (docs/CONTRACTS.md §45.12).

The Library lists only ``ASSET#`` items of its workspace (never S3 listings), newest first, filtered by kind, story or
character, with presigned links; "Design with AI" pictures (``design_ref``) are left out unless asked for by kind. ``filtered_page`` pages through one sort-key prefix keeping only the items a filter
accepts; its cursor is the key of the last item returned, checked by ``db.decode_cursor`` to be the caller's own.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .. import db
from . import guard, shapes
from . import types as ws

Item = dict[str, Any]
SCAN_PAGE = 100


def filtered_page(
    store: db.Store,
    pk: str,
    prefix: str,
    keep: Callable[[Item], bool],
    *,
    limit: int,
    cursor: str | None,
) -> tuple[list[Item], str | None]:
    start: Mapping[str, Any] | None = db.decode_cursor(cursor, pk, prefix)
    found: list[Item] = []
    while True:
        page = store.query_page(pk, prefix, newest_first=True, limit=max(limit, SCAN_PAGE), start_key=start)
        for item in page.items:
            if keep(item):
                found.append(item)
                if len(found) == limit:
                    return found, db.encode_cursor({"pk": item["pk"], "sk": item["sk"]})
        if not page.last_key:
            return found, None
        start = page.last_key


def titles(store: db.Store, user_id: str, workspace_id: str, items: list[Item]) -> dict[str, str]:
    """``storyId``/``characterId`` → the story's current title or the character's name (only this workspace's)."""
    pk = ws.workspace_pk(user_id, workspace_id)
    keys: list[tuple[str, str]] = []
    for item in items:
        if item.get("storyId"):
            keys.append((pk, f"{ws.STORY_SK}{item['storyId']}"))
        if item.get("characterId"):
            keys.append((pk, f"{ws.CHAR_SK}{item['characterId']}"))
    out: dict[str, str] = {}
    for found in store.batch_get(keys) if keys else []:
        if not guard.owned(found, user_id, workspace_id):
            continue
        if found.get("type") == ws.TYPE_STORY:
            out[f"story:{found['storyId']}"] = str(found.get("title") or "")
        elif found.get("type") == ws.TYPE_CHARACTER:
            out[f"character:{found['characterId']}"] = str(found.get("name") or "")
    return out


def title_for(item: Mapping[str, Any], names: Mapping[str, str]) -> str:
    if item.get("storyId") and f"story:{item['storyId']}" in names:
        return names[f"story:{item['storyId']}"]
    if item.get("characterId") and f"character:{item['characterId']}" in names:
        return names[f"character:{item['characterId']}"]
    return ""


def asset_filter(
    user_id: str, workspace_id: str, *, kind: str | None, story_id: str | None, character_id: str | None
) -> Callable[[Item], bool]:
    def keep(item: Item) -> bool:
        if item.get("type") != ws.TYPE_ASSET or not guard.owned(item, user_id, workspace_id):
            return False
        if kind and item.get("kind") != kind:
            return False
        if not kind and item.get("kind") in shapes.LIBRARY_HIDDEN:
            return False  # "Design with AI" pictures are not Library files (§45.6)
        if story_id and item.get("storyId") != story_id:
            return False
        return not (character_id and item.get("characterId") != character_id)

    return keep


def library_items(
    store: db.Store, presign: shapes.Presign, user_id: str, workspace_id: str, items: list[Item]
) -> list[dict[str, Any]]:
    names = titles(store, user_id, workspace_id, items)
    out = []
    for item in items:
        public = shapes.public_asset(item, presign, user_id, title=title_for(item, names))
        if public is not None:
            out.append(public)
    return out
