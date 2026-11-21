"""Small shared helpers of the CR package."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def obj(value: Any) -> dict[str, Any]:
    """``value`` as a dict when it is a mapping, else an empty one (CR's alpha answers and old items vary)."""
    return dict(value) if isinstance(value, Mapping) else {}
