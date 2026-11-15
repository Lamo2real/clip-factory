"""UTC timestamps as ISO-8601 strings with millisecond precision and a ``Z`` suffix."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

Clock = Callable[[], datetime]


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
