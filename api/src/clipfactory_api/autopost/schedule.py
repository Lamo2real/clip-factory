"""When auto-posting runs (docs/CONTRACTS.md §46.4): even gaps of ``everyHours``, across midnight.

The EventBridge rule ``cf-prod-autopost-hourly`` fires every hour at :00 UTC. Every time here is a UTC instant on a
whole hour (a "slot"); the web shows it in the owner's local time. A tick's slot is the hour of the event's own time,
never "now", so a retried delivery of one event is the same slot. Pure: no clock, no store.

``due_at = max(next_full_hour(onAt), lastRunAt + everyHours)`` (the first term alone before the first run). A slot runs
when ``slot >= due_at``, so runs fall exactly ``everyHours`` apart (5 h: 00, 05, 10, 15, 20, 01, 06 …); a changed
``everyHours`` counts from the last run; switching on runs at the next full hour, never sooner than ``everyHours`` after
the last run. A run that finds nothing still counts (``lastRunAt`` moves), so the gaps stay even.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from ..clock import parse

HOUR = timedelta(hours=1)


def floor_hour(moment: datetime) -> datetime:
    """The whole hour ``moment`` is in (its slot)."""
    return moment.replace(minute=0, second=0, microsecond=0)


def next_full_hour(moment: datetime) -> datetime:
    """The first whole hour strictly after ``moment``."""
    return floor_hour(moment) + HOUR


def every(auto: Mapping[str, Any]) -> timedelta:
    return HOUR * int(auto.get("everyHours") or 5)


def due_at(auto: Mapping[str, Any], state: Mapping[str, Any] | None) -> datetime | None:
    """The first slot that may run (None while off, or when nothing holds a run back)."""
    if not auto.get("on"):
        return None
    on_at = parse(auto.get("onAt"))
    last = parse((state or {}).get("lastRunAt"))
    terms = [t for t in (next_full_hour(on_at) if on_at else None, last + every(auto) if last else None) if t]
    return max(terms) if terms else None


def is_due(auto: Mapping[str, Any], state: Mapping[str, Any] | None, slot: datetime) -> bool:
    """Whether the tick of ``slot`` runs (only while on)."""
    if not auto.get("on"):
        return False
    due = due_at(auto, state)
    return due is None or slot >= due


def next_run_at(auto: Mapping[str, Any], state: Mapping[str, Any] | None, now: datetime) -> datetime | None:
    """The next run as the owner sees it (None while off): ``due_at``, or the next full hour when that is already
    past (a tick that was lost is caught up by the next one)."""
    if not auto.get("on"):
        return None
    due = due_at(auto, state)
    upcoming = next_full_hour(now)
    if due is None or due <= now:
        return upcoming
    return due


def per_day(auto: Mapping[str, Any]) -> float | int:
    """``perRun * 24 / everyHours``, not rounded (a whole number stays whole)."""
    value = int(auto.get("perRun") or 1) * 24 / int(auto.get("everyHours") or 5)
    return int(value) if value.is_integer() else value
