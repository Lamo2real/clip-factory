"""Lamo Stories' memory: facts and preferences the creative director saves with ``remember`` and the owner adds,
edits or deletes in Settings › Memory (docs/CONTRACTS.md §45.3 ``MEM#``, §45.27, ADR-78).

``MEM#{memId}`` items in the workspace's own partition: ``text`` (≤ 300 characters), ``source`` (``chat`` or
``owner``), ``createdAt``, ``updatedAt``. Every Lamo Stories agent gets the list (at most 50, newest first) after its
skills: ``for_prompt`` and ``prompt_block`` give it to the model client. Clip Factory has no access to any of it.
"""

from __future__ import annotations

import re
from typing import Any

from lamostories_agent.tasks.common import now_iso, owned, public, ulid, ws_pk
from lamostories_agent.tasks.store import Store

TEXT_MAX = 300
PROMPT_LIMIT = 50
CHAT_LIMIT = 50  # the API's limit (workspaces/memory.py SHOWN): every note stays visible in Settings › Memory
FULL = f"Memory is full ({CHAT_LIMIT} notes). Delete one first."  # the API's own sentence (§45.34)
TYPE = "ws_mem"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def items(store: Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    """Every memory of the workspace, newest first (``memId`` is a ULID, so the sort key orders by time)."""
    found = store.query(ws_pk(user_id, workspace_id), "MEM#", newest_first=True)
    out = [m for m in found if owned(m, user_id, workspace_id) and isinstance(m.get("text"), str)]
    out.sort(key=lambda m: str(m.get("createdAt") or ""), reverse=True)
    return out


def for_prompt(store: Store, user_id: str, workspace_id: str, limit: int = PROMPT_LIMIT) -> list[str]:
    """The texts every agent gets after its skills: at most ``limit``, newest first."""
    return [_norm(str(m["text"]))[:TEXT_MAX] for m in items(store, user_id, workspace_id)[:limit]]


def prompt_block(texts: list[str]) -> str:
    """The memory as one system block ("" when there is none)."""
    if not texts:
        return ""
    lines = "\n".join(f"- {t}" for t in texts)
    return (
        "What Lamo Stories remembers about the owner and the studio (newest first; the owner can edit these in "
        "Settings › Memory):\n" + lines
    )


def new_item(user_id: str, workspace_id: str, text: str, *, source: str = "chat") -> dict[str, Any]:
    clean = _norm(text)
    if not clean:
        raise ValueError("a memory needs some text")
    if len(clean) > TEXT_MAX:
        raise ValueError(f"a memory is at most {TEXT_MAX} characters")
    at = now_iso()
    mem_id = ulid()
    return {
        "pk": ws_pk(user_id, workspace_id),
        "sk": f"MEM#{mem_id}",
        "type": TYPE,
        "userId": user_id,
        "workspaceId": workspace_id,
        "memId": mem_id,
        "text": clean,
        "source": source,
        "createdAt": at,
        "updatedAt": at,
    }


def already(store: Store, user_id: str, workspace_id: str, text: str) -> dict[str, Any] | None:
    """The memory that already says this (case and spaces ignored), if any."""
    want = _norm(text).lower()
    return next((m for m in items(store, user_id, workspace_id) if _norm(str(m["text"])).lower() == want), None)


def remember(store: Store, user_id: str, workspace_id: str, text: str, *, source: str = "chat") -> dict[str, Any]:
    """Saves one memory (or returns the one that already says it) as its public shape. Raises ``ValueError`` with a
    plain sentence when the text is empty, too long, or the chat's memory is full."""
    found = already(store, user_id, workspace_id, text)
    if found is not None:
        return public(found)
    if source == "chat" and len(items(store, user_id, workspace_id)) >= CHAT_LIMIT:
        raise ValueError(FULL)
    item = new_item(user_id, workspace_id, text, source=source)
    store.put_new(item)
    return public(item)


def register(actions: Any, runner: Any) -> None:
    """Memory has no actions of its own: the chat's ``remember`` tool and the model client use the helpers above."""
