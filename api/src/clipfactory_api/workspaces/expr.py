"""Update expressions for workspace items (docs/CONTRACTS.md §45.3, §45.9.1).

Every write to ``STORY#`` or ``PJOB#`` after creation is an UpdateItem that sets only its own attributes; on
``STORY#`` it also adds 1 to ``version``. ``db.update_request`` has no ``ADD`` clause, so this module builds the same
fixed expression shapes plus ``ADD`` and ``DELETE``, usable alone (``run``) or in ``Store.transact(updates=...)``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .. import db


@dataclass
class Update:
    """One UpdateItem on an existing item. Conditions are ANDed after ``attribute_exists(pk)``."""

    pk: str
    sk: str
    sets: dict[str, Any] = field(default_factory=dict)
    removes: list[str] = field(default_factory=list)
    adds: dict[str, Any] = field(default_factory=dict)
    deletes: dict[str, Any] = field(default_factory=dict)  # DELETE from a string set
    conditions: list[tuple[str, str, Any]] = field(default_factory=list)  # (kind, attribute, value)

    def bump(self) -> Update:
        """ADD version 1 (every STORY# write, §45.3)."""
        self.adds["version"] = 1
        return self

    def equals(self, attr: str, value: Any) -> Update:
        self.conditions.append(("eq", attr, value))
        return self

    def one_of(self, attr: str, values: Iterable[Any]) -> Update:
        self.conditions.append(("in", attr, list(values)))
        return self

    def absent_or_null(self, attr: str) -> Update:
        """The attribute is missing or holds NULL (``currentJobId`` cleared by REMOVE or set to null)."""
        self.conditions.append(("none", attr, None))
        return self

    def missing_or_equals(self, attr: str, value: Any) -> Update:
        """The attribute is missing or holds ``value`` (a counter that starts at nothing)."""
        self.conditions.append(("opt", attr, value))
        return self

    def request(self) -> dict[str, Any]:
        """UpdateItem parameters (also a ``Store.transact`` update)."""
        names: dict[str, str] = {}
        values: dict[str, Any] = {}

        def name(attr: str) -> str:
            for placeholder, known in names.items():
                if known == attr:
                    return placeholder
            placeholder = f"#n{len(names)}"
            names[placeholder] = attr
            return placeholder

        def value(v: Any) -> str:
            placeholder = f":v{len(values)}"
            values[placeholder] = db.to_dynamo(v)
            return placeholder

        parts: list[str] = []
        if self.sets:
            parts.append("SET " + ", ".join(f"{name(k)} = {value(v)}" for k, v in self.sets.items()))
        if self.removes:
            parts.append("REMOVE " + ", ".join(name(k) for k in self.removes))
        if self.adds:
            parts.append("ADD " + ", ".join(f"{name(k)} {value(v)}" for k, v in self.adds.items()))
        if self.deletes:
            parts.append("DELETE " + ", ".join(f"{name(k)} {value(v)}" for k, v in self.deletes.items()))
        if not parts:
            raise ValueError("an update needs at least one change")
        conditions = ["attribute_exists(pk)"]
        for kind, attr, expected in self.conditions:
            n = name(attr)
            if kind == "eq":
                conditions.append(f"{n} = {value(expected)}")
            elif kind == "in":
                conditions.append(f"{n} IN ({', '.join(value(v) for v in expected)})")
            elif kind == "opt":
                conditions.append(f"(attribute_not_exists({n}) OR {n} = {value(expected)})")
            else:
                conditions.append(f"(attribute_not_exists({n}) OR {n} = {value(None)})")
        kwargs: dict[str, Any] = {
            "Key": {"pk": self.pk, "sk": self.sk},
            "UpdateExpression": " ".join(parts),
            "ConditionExpression": " AND ".join(conditions),
            "ExpressionAttributeNames": names,
        }
        if values:
            kwargs["ExpressionAttributeValues"] = values
        return kwargs

    def run(self, store: db.Store) -> db.Item:
        """Applies the update and returns the new item; a failed condition raises ``db.ConditionFailed``."""
        kwargs = self.request()
        return store.update_expr(
            self.pk,
            self.sk,
            kwargs["UpdateExpression"],
            condition=kwargs["ConditionExpression"],
            names=kwargs["ExpressionAttributeNames"],
            values=kwargs.get("ExpressionAttributeValues"),
        )
