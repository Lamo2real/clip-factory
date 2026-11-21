"""Small shared helpers of the CR package."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

KEYS = ("pk", "sk")


def obj(value: Any) -> dict[str, Any]:
    """``value`` as a dict when it is a mapping, else an empty one (CR's alpha answers and old items vary)."""
    return dict(value) if isinstance(value, Mapping) else {}


class Loaded(dict[str, Any]):
    """An item as it was read, with a deep copy of that read (``before``): a save writes only what the caller changed,
    so a write made meanwhile by someone else (a rules read, a cleared hold, a seen celebration, the owner's answer
    on another request) is never undone by a whole-item put of an older copy."""

    before: dict[str, Any]

    def __init__(self, item: Mapping[str, Any]) -> None:
        super().__init__(item)
        self.before = copy.deepcopy(dict(item))


def _norm(value: Any) -> Any:
    """``value`` as DynamoDB keeps it (None inside a map is not stored), to compare a stored copy with a new one."""
    if isinstance(value, Mapping):
        return {k: _norm(v) for k, v in value.items() if v is not None}
    if isinstance(value, list | tuple):
        return [_norm(v) for v in value]
    return value


def changes(before: Mapping[str, Any], after: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``(set, remove)``: the top-level attributes ``after`` changed from ``before`` (a None value is a removal)."""
    sets = {
        k: v
        for k, v in after.items()
        if k not in KEYS and v is not None and (k not in before or _norm(before[k]) != _norm(v))
    }
    remove = [k for k in before if k not in KEYS and before[k] is not None and after.get(k) is None]
    return sets, remove


def update_parts(sets: Mapping[str, Any], remove: list[str]) -> tuple[str, dict[str, str], dict[str, Any]]:
    """``(update expression, names, values)`` for ``Store.update_expr``."""
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    parts = []
    for i, (name, value) in enumerate(sets.items()):
        names[f"#s{i}"] = name
        values[f":s{i}"] = value
        parts.append(f"#s{i} = :s{i}")
    expression = "SET " + ", ".join(parts) if parts else ""
    if remove:
        for i, name in enumerate(remove):
            names[f"#r{i}"] = name
        expression += (" " if expression else "") + "REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove)))
    return expression, names, values
