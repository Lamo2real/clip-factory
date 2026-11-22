"""Lamo Stories' memory (docs/CONTRACTS.md §45.3 ``MEM#``, §45.5, §45.6 ``MemoryItem``, §45.27, ADR-78).

Short facts and preferences ("Lamo likes slapstick endings", ≤ 300 characters each) that the creative director saves
with ``remember`` and the owner adds, edits or deletes in Lamo Stories › Settings › Memory. Every Lamo Stories agent
gets the newest 50 after its skills; Clip Factory has no access to it (its own partition, its own items).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..ids import is_ulid, ulid
from . import ai_config as cfg
from . import guard
from . import types as ws

TEXT_MAX: Final = 300
SHOWN: Final = 50
NOT_FOUND: Final = "We could not find that note."
FULL: Final = f"Memory is full ({SHOWN} notes). Delete one first."


def mem_sk(mem_id: str) -> str:
    return f"{ws.MEM_SK}{mem_id}"


def public(item: Mapping[str, Any]) -> dict[str, Any]:
    created = str(item.get("createdAt") or "")
    return {
        "memId": str(item.get("memId")),
        "text": str(item.get("text") or ""),
        "source": "chat" if item.get("source") == "chat" else "owner",
        "createdAt": created,
        "updatedAt": str(item.get("updatedAt") or created),
    }


def clean_text(body: Mapping[str, Any]) -> str:
    validate.only_keys(body, ("text",))
    raw = body.get("text")
    if not isinstance(raw, str):
        raise bad_request("Write the note.", "text")
    text = " ".join(raw.split())
    if not text:
        raise bad_request("Write the note.", "text")
    if len(text) > TEXT_MAX:
        raise bad_request(f"A note can be at most {TEXT_MAX} characters.", "text")
    return text


def newest(store: db.Store, user_id: str, workspace_id: str, limit: int = SHOWN) -> list[dict[str, Any]]:
    """The newest notes first (their ids are ULIDs, so the sort key order is the order they were made)."""
    page = store.query_page(cfg.pk(user_id, workspace_id), ws.MEM_SK, newest_first=True, limit=limit, consistent=True)
    items = [i for i in page.items if guard.owned(i, user_id, workspace_id)]
    return items[:limit]


def list_items(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    return [public(i) for i in newest(store, user_id, workspace_id)]


def add(store: db.Store, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime) -> dict[str, Any]:
    text = clean_text(body)
    if len(newest(store, user_id, workspace_id, SHOWN + 1)) >= SHOWN:
        raise conflict(FULL)
    mem_id = ulid()
    at = iso(now)
    item = {
        **cfg.base_item(user_id, workspace_id, mem_sk(mem_id), ws.TYPE_MEM),
        "memId": mem_id,
        "text": text,
        "source": "owner",
        "createdAt": at,
        "updatedAt": at,
    }
    store.put(item, if_absent=True)
    return public(item)


def _owned(store: db.Store, user_id: str, workspace_id: str, mem_id: str) -> dict[str, Any]:
    if not is_ulid(mem_id):
        raise not_found(NOT_FOUND)
    item = cfg.get_owned(store, user_id, workspace_id, mem_sk(mem_id))
    if item is None:
        raise not_found(NOT_FOUND)
    return item


def edit(
    store: db.Store, user_id: str, workspace_id: str, mem_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    text = clean_text(body)
    item = _owned(store, user_id, workspace_id, mem_id)
    try:
        updated = store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"text": text, "updatedAt": iso(now)},
            expect_in={"userId": [user_id], "workspaceId": [workspace_id]},
        )
    except db.ConditionFailed as e:
        raise not_found(NOT_FOUND) from e
    return public(updated)


def remove(store: db.Store, user_id: str, workspace_id: str, mem_id: str) -> None:
    item = _owned(store, user_id, workspace_id, mem_id)
    if not store.delete_if(str(item["pk"]), str(item["sk"]), {"userId": [user_id], "workspaceId": [workspace_id]}):
        raise not_found(NOT_FOUND)
