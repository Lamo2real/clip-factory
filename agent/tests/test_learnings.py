"""The learnings brief (docs/CONTRACTS.md §16.7): best-of-week learnings first, then the others."""

from __future__ import annotations

from typing import Any

from clipfactory_agent import learnings
from clipfactory_agent.agent import Brief, system_prompt


def week(i: int, text: str | None = None) -> dict[str, Any]:
    return {
        "learningId": f"01W{i:02d}",
        "kind": "week",
        "week": f"2026-W{i:02d}",
        "createdAt": f"2026-01-{i:02d}T10:00:00Z",
        "text": text or f"week {i}",
    }


def other(i: int) -> dict[str, Any]:
    return {"learningId": f"01C{i:02d}", "kind": "clip", "createdAt": f"2026-02-{i:02d}T10:00:00Z", "text": f"clip {i}"}


class Store:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.asked: list[int] = []

    async def latest_learnings(self, user_id: str, n: int = 10) -> list[dict[str, Any]]:
        self.asked.append(n)
        return self.rows[:n]


async def test_load_reads_fifty_and_keeps_four_week_and_ten_other_learnings() -> None:
    rows = [other(i) for i in range(1, 15)] + [week(i) for i in range(1, 8)]
    store = Store(rows)
    got = await learnings.load(store, "U")
    assert store.asked == [50]
    assert got.week == ["week 7", "week 6", "week 5", "week 4"]
    assert got.other == [f"clip {i}" for i in range(14, 4, -1)]
    assert len(got) == 14


def test_split_treats_a_missing_kind_as_other_and_drops_empty_texts() -> None:
    rows = [{"learningId": "01A", "text": "plain"}, week(1, "  "), week(2, " short   hooks win ")]
    got = learnings.split(rows)
    assert got.week == ["short hooks win"] and got.other == ["plain"]


def test_a_relearned_week_counts_as_new_by_created_at() -> None:
    old_id_new_text = {**week(1, "re-learned"), "createdAt": "2026-03-01T00:00:00Z"}
    assert learnings.split([week(5), old_id_new_text]).week == ["re-learned", "week 5"]


def test_prompt_section_puts_week_learnings_first_and_leaves_out_empty_groups() -> None:
    both = learnings.prompt_section(learnings.Learnings(week=["w"], other=["o"]))
    assert both.index("The owner's best-of-week picks taught") < both.index("Learnings from earlier clips")
    assert "- w" in both and "- o" in both
    only_other = learnings.prompt_section(learnings.Learnings(other=["o"]))
    assert "best-of-week" not in only_other and only_other.startswith("Learnings")
    only_week = learnings.prompt_section(learnings.Learnings(week=["w"]))
    assert only_week.startswith("The owner's best-of-week picks taught") and "Learnings from" not in only_week
    assert learnings.prompt_section(learnings.Learnings()) == ""


def brief(**kw: Any) -> Brief:
    base: dict[str, Any] = {
        "title": "T",
        "channel": "C",
        "platform": "youtube",
        "duration": 600.0,
        "notes": "",
        "clip_min": 1,
        "clip_max": 3,
        "length": (20.0, 45.0),
        "words": [],
        "loud": [],
    }
    return Brief(**{**base, **kw})


def test_system_prompt_carries_both_groups_in_order() -> None:
    s = system_prompt(brief(learnings=["Rage clips win"], week_learnings=["Picks open on a scream"]))
    assert s.index("Picks open on a scream") < s.index("Rage clips win")
    assert s.index("Loudness spikes") < s.index("The owner's best-of-week picks taught")
    s = system_prompt(brief())
    assert "best-of-week picks taught" not in s and "Learnings from" not in s
    assert s.rstrip().endswith("strong hints, not proof.")
