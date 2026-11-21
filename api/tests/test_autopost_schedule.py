"""Auto-posting's schedule (docs/CONTRACTS.md §46.4): even gaps of everyHours, across midnight and month ends.

Pure: the hourly tick is simulated hour by hour, each run moving ``lastRunAt`` to its slot as the claim does."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from clipfactory_api.autopost import schedule
from clipfactory_api.clock import iso

HOUR = timedelta(hours=1)


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def auto(every: int = 5, *, on: bool = True, on_at: str | None = "2026-11-15T12:00:00", **more: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"on": on, "everyHours": every, "perRun": 1, "practice": False, **more}
    if on_at is not None:
        out["onAt"] = iso(at(on_at))
    return out


def ticks(settings: dict[str, Any], start: datetime, hours: int, state: dict[str, Any] | None = None) -> list[datetime]:
    """Every hourly tick from ``start`` for ``hours`` hours; the slots that ran."""
    state = state if state is not None else {}
    ran: list[datetime] = []
    slot = schedule.floor_hour(start)
    for _ in range(hours):
        if schedule.is_due(settings, state, slot):
            ran.append(slot)
            state["lastRunAt"] = iso(slot)
        slot += HOUR
    return ran


ON_AT_MINUTES = ("2026-11-28T00:00:00", "2026-11-28T07:17:42", "2026-11-30T23:59:59", "2026-12-30T21:30:00")


@pytest.mark.parametrize("on_at", ON_AT_MINUTES)
@pytest.mark.parametrize("every", range(1, 25))
def test_every_gap_is_exactly_every_hours_for_ten_days(every: int, on_at: str) -> None:
    settings = auto(every, on_at=on_at)
    start = at(on_at)
    ran = ticks(settings, start, 24 * 10 + 2)
    assert ran[0] == schedule.next_full_hour(start)  # switching on runs at the next full hour
    assert all(b - a == every * HOUR for a, b in itertools.pairwise(ran))
    assert len(ran) == (24 * 10 + 2 - 1) // every + (1 if (24 * 10 + 2 - 1) % every else 0)
    # Across midnight (and the month end): some run lands on a later day than the one before it.
    assert any(b.date() > a.date() for a, b in itertools.pairwise(ran))
    assert ran[-1].date() > start.date() + timedelta(days=8)


def test_the_five_hour_example_crosses_midnight_evenly() -> None:
    ran = ticks(auto(5, on_at="2026-11-14T23:10:00"), at("2026-11-14T23:10:00"), 30)
    assert [r.hour for r in ran] == [0, 5, 10, 15, 20, 1]


def test_switching_on_runs_at_the_next_full_hour_even_on_the_hour() -> None:
    assert schedule.next_full_hour(at("2026-11-15T10:00:00")) == at("2026-11-15T11:00:00")
    assert schedule.next_full_hour(at("2026-11-15T10:59:59")) == at("2026-11-15T11:00:00")
    assert schedule.due_at(auto(5, on_at="2026-11-15T10:20:00"), {}) == at("2026-11-15T11:00:00")


def test_switching_on_is_never_sooner_than_every_hours_after_the_last_run() -> None:
    state = {"lastRunAt": iso(at("2026-11-15T10:00:00"))}
    # Off at 11:00, on again at 12:30: the next full hour is 13:00, but the last run was at 10:00.
    assert schedule.due_at(auto(5, on_at="2026-11-15T12:30:00"), state) == at("2026-11-15T15:00:00")
    # On again at 16:10: the next full hour wins.
    assert schedule.due_at(auto(5, on_at="2026-11-15T16:10:00"), state) == at("2026-11-15T17:00:00")


def test_a_changed_every_hours_counts_from_the_last_run() -> None:
    state = {"lastRunAt": iso(at("2026-11-15T10:00:00"))}
    on_at = "2026-11-15T08:30:00"
    assert schedule.due_at(auto(8, on_at=on_at), state) == at("2026-11-15T18:00:00")  # up
    assert schedule.due_at(auto(2, on_at=on_at), state) == at("2026-11-15T12:00:00")  # down
    # Down to 2 at 14:30: 12:00 has passed, so the next full hour runs, then every 2 hours from it.
    now = at("2026-11-15T14:30:00")
    assert schedule.next_run_at(auto(2, on_at=on_at), state, now) == at("2026-11-15T15:00:00")
    assert ticks(auto(2, on_at=on_at), at("2026-11-15T15:00:00"), 6, dict(state)) == [
        at("2026-11-15T15:00:00"),
        at("2026-11-15T17:00:00"),
        at("2026-11-15T19:00:00"),
    ]


def test_off_never_runs_and_shows_no_next_run() -> None:
    off = auto(1, on=False)
    assert ticks(off, at("2026-11-15T12:00:00"), 48) == []
    assert schedule.due_at(off, {}) is None
    assert schedule.next_run_at(off, {}, at("2026-11-15T12:30:00")) is None


def test_off_and_on_again_keeps_even_gaps_from_the_last_run() -> None:
    state: dict[str, Any] = {}
    first = ticks(auto(5, on_at="2026-11-15T09:30:00"), at("2026-11-15T09:30:00"), 11, state)
    assert first == [at("2026-11-15T10:00:00"), at("2026-11-15T15:00:00")]
    assert ticks(auto(5, on=False), at("2026-11-15T21:00:00"), 3, state) == []
    again = ticks(auto(5, on_at="2026-11-15T23:05:00"), at("2026-11-16T00:00:00"), 12, state)
    assert again == [at("2026-11-16T00:00:00"), at("2026-11-16T05:00:00"), at("2026-11-16T10:00:00")]


def test_practice_keeps_the_same_times() -> None:
    plain = ticks(auto(3), at("2026-11-15T12:00:00"), 48)
    practice = ticks(auto(3, practice=True), at("2026-11-15T12:00:00"), 48)
    assert plain == practice


def test_a_late_tick_has_its_own_slot() -> None:
    late = at("2026-11-15T15:00:43")
    assert schedule.floor_hour(late) == at("2026-11-15T15:00:00")
    state = {"lastRunAt": iso(at("2026-11-15T10:00:00"))}
    assert schedule.is_due(auto(5), state, schedule.floor_hour(late))


def test_a_lost_tick_is_caught_up_by_the_next_one_once() -> None:
    settings = auto(5)
    state = {"lastRunAt": iso(at("2026-11-15T10:00:00"))}
    # The 15:00 tick never came: 16:00 runs, and the gaps count from it.
    ran = ticks(settings, at("2026-11-15T16:00:00"), 10, state)
    assert ran == [at("2026-11-15T16:00:00"), at("2026-11-15T21:00:00")]


def test_next_run_shown() -> None:
    state = {"lastRunAt": iso(at("2026-11-15T10:00:00"))}
    assert schedule.next_run_at(auto(5), state, at("2026-11-15T12:30:00")) == at("2026-11-15T15:00:00")
    # Already past (a lost tick): the next full hour, which runs it.
    assert schedule.next_run_at(auto(5), state, at("2026-11-15T15:20:00")) == at("2026-11-15T16:00:00")
    # Just switched on: the next full hour.
    assert schedule.next_run_at(auto(5, on_at="2026-11-15T12:10:00"), {}, at("2026-11-15T12:10:00")) == at(
        "2026-11-15T13:00:00"
    )


@pytest.mark.parametrize(
    ("per_run", "every", "per_day"), [(1, 5, 4.8), (1, 24, 1), (2, 7, 48 / 7), (5, 1, 120), (3, 6, 12)]
)
def test_per_day_is_not_rounded(per_run: int, every: int, per_day: float) -> None:
    value = schedule.per_day({"perRun": per_run, "everyHours": every})
    assert value == pytest.approx(per_day)
    assert isinstance(value, int) == float(per_day).is_integer()
