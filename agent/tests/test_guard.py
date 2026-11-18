"""The runaway guard (ADR-40): a bug must never call a service forever; a tripped guard is not retried."""

from __future__ import annotations

import pytest

from clipfactory_agent import guard
from clipfactory_agent.guard import CallBudget, Deadline, GuardTripped
from clipfactory_agent.retry import is_transient


def test_budget_allows_its_limit_then_trips(capsys: pytest.CaptureFixture[str]) -> None:
    b = CallBudget("fable", 3)
    for _ in range(3):
        b.spend()
    assert b.left == 0
    with pytest.raises(GuardTripped) as info:
        b.spend()
    assert b.used == 3  # the refused call is not counted, and nothing can go below zero
    assert not is_transient(info.value)  # so no retry loop ever picks it up again
    assert '"deep.guard_tripped"' in capsys.readouterr().out


def test_budgets_follow_the_plan() -> None:
    assert guard.fable_budget(48).limit == 3 * 48 + 8
    assert guard.fable_budget(48, 6).limit == 3 * 48 * 6 + 8
    assert guard.nova_budget(24).limit == 3 * 24 + 8
    assert guard.second_look_budget(13).limit == 3 * 13 + 4


def test_a_refund_and_a_raise() -> None:
    b = guard.CallBudget("x", 1)
    b.spend()
    b.refund()
    b.spend()
    b.allow(3)
    b.allow(2)  # never lowered
    assert b.limit == 3
    b.spend()
    b.spend()
    with pytest.raises(guard.GuardTripped):
        b.spend()
    assert CallBudget("x", -5).limit == 0


def test_deadline_with_a_clock() -> None:
    now = [100.0]
    d = Deadline(60, clock=lambda: now[0])
    assert not d.expired and d.left == 60
    now[0] = 159.0
    assert d.left == pytest.approx(1.0)
    d.check("watch")
    now[0] = 160.0
    assert d.expired and d.left == 0
    with pytest.raises(GuardTripped):
        d.check("watch")


def test_chunk_count_never_passes_max_chunks(capsys: pytest.CaptureFixture[str]) -> None:
    assert guard.chunk_count(0, 150) == 0
    assert guard.chunk_count(1, 150) == 1
    assert guard.chunk_count(1800, 150) == 12
    assert guard.chunk_count(4 * 3600, 150) == 96
    assert guard.chunk_count(12 * 3600, 150) == 288  # a 12-hour source is still watched whole
    assert capsys.readouterr().out == ""
    assert guard.chunk_count(100 * 3600, 150) == guard.MAX_CHUNKS == 400
    assert '"deep.guard_tripped"' in capsys.readouterr().out
