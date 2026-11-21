"""Lamo Stories' memory (``MEM#``): remember, the list every agent gets, and its limits (docs/CONTRACTS.md §45.27)."""

from __future__ import annotations

import pytest

from lamostories_agent import memory
from lamostories_agent.tasks.store import Store
from test_tasks_support import PK, USER, WS, FakeDynamo


def _store() -> tuple[Store, FakeDynamo]:
    db = FakeDynamo()
    return Store(db, "t"), db


def test_remember_saves_one_item_in_the_workspace_partition_only() -> None:
    store, db = _store()
    item = memory.remember(store, USER, WS, "  Lamo likes   slapstick endings ")
    assert item["text"] == "Lamo likes slapstick endings" and item["source"] == "chat"
    assert set(item) == {"workspaceId", "memId", "text", "source", "createdAt", "updatedAt"}
    saved = db.prefixed(PK, "MEM#")
    assert len(saved) == 1 and saved[0]["type"] == "ws_mem" and saved[0]["userId"] == USER
    assert all(pk == PK for _, pk, _ in db.writes)


def test_remember_does_not_repeat_itself() -> None:
    store, db = _store()
    first = memory.remember(store, USER, WS, "Lamo likes slapstick endings")
    again = memory.remember(store, USER, WS, "lamo likes SLAPSTICK endings")
    assert again["memId"] == first["memId"] and len(db.prefixed(PK, "MEM#")) == 1


def test_remember_refuses_empty_long_and_full() -> None:
    store, db = _store()
    with pytest.raises(ValueError):
        memory.remember(store, USER, WS, "   ")
    with pytest.raises(ValueError):
        memory.remember(store, USER, WS, "x" * 301)
    for n in range(memory.CHAT_LIMIT):
        db.seed(
            {
                "pk": PK,
                "sk": f"MEM#{n:04d}",
                "userId": USER,
                "workspaceId": WS,
                "memId": f"{n:04d}",
                "text": f"fact {n}",
                "createdAt": f"2026-11-21T10:{n // 60:02d}:{n % 60:02d}.000Z",
            }
        )
    with pytest.raises(ValueError, match="Memory is full"):
        memory.remember(store, USER, WS, "one more")
    assert memory.remember(store, USER, WS, "the owner's own", source="owner")["source"] == "owner"


def test_the_prompt_list_is_at_most_50_newest_first_and_ignores_other_owners() -> None:
    store, db = _store()
    for n in range(60):
        db.seed(
            {
                "pk": PK,
                "sk": f"MEM#{n:04d}",
                "userId": USER,
                "workspaceId": WS,
                "memId": f"{n:04d}",
                "text": f"fact {n}",
                "createdAt": f"2026-11-21T10:00:{n:02d}.000Z",
            }
        )
    db.seed(
        {
            "pk": PK,
            "sk": "MEM#9999",
            "userId": "intruder",
            "workspaceId": WS,
            "text": "not mine",
            "createdAt": "2026-11-21T11:00:00.000Z",
        }
    )
    texts = memory.for_prompt(store, USER, WS)
    assert len(texts) == 50 and texts[0] == "fact 59" and texts[-1] == "fact 10" and "not mine" not in texts
    block = memory.prompt_block(texts[:2])
    assert block.splitlines()[1:] == ["- fact 59", "- fact 58"] and "Settings › Memory" in block
    assert memory.prompt_block([]) == ""


def test_lamo_clips_has_no_memory_partition() -> None:
    store, _ = _store()
    with pytest.raises(ValueError):
        memory.for_prompt(store, USER, "clips")
