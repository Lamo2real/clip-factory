"""DynamoDB for the creative agents (docs/CONTRACTS.md §45.3, §45.9.1, §45.11.1).

Only the workspace's own partition is written, and only with update expressions that set the agent's own attributes
(never a whole-item put over something that exists). Every write made for a task, a chat turn or a reference job is
fenced on that item's ``sessionId`` and live statuses; a write for another item on its behalf (an idea's concept, a
memory, a reference's analysis) is a transaction with a ConditionCheck or the fenced item's own update. A refused
condition returns ``False``: the caller stops and writes nothing more.

The expressions use only top-level attribute names (``#n0``) and values (``:v0``); the tests' fake table reads
exactly this grammar.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Any

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from .common import plain

_SER = TypeSerializer()
_DES = TypeDeserializer()
_TOKEN = re.compile(r"#n\d+|:v\d+")


def to_ddb(value: Any) -> Any:
    """A value as DynamoDB takes it: floats as Decimals (NaN and infinity as null), empty sets never made."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return Decimal(str(round(value, 6))) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): to_ddb(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [to_ddb(v) for v in value]
    return value


def serialize(value: Any) -> dict[str, Any]:
    return dict(_SER.serialize(to_ddb(value)))


def deserialize_item(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if not raw:
        return None
    return {k: plain(_DES.deserialize(v)) for k, v in raw.items()}


class Expr:
    """One update (SET, REMOVE, ADD) with its condition, built from plain attribute names."""

    def __init__(self) -> None:
        self.names: dict[str, str] = {}
        self.values: dict[str, Any] = {}
        self._set: list[str] = []
        self._remove: list[str] = []
        self._add: list[str] = []
        self._cond: list[str] = []

    def _name(self, field: str) -> str:
        if not field or "." in field or "#" in field:
            raise ValueError(f"not a plain attribute name: {field!r}")
        for token, name in self.names.items():
            if name == field:
                return token
        token = f"#n{len(self.names)}"
        self.names[token] = field
        return token

    def _value(self, value: Any) -> str:
        token = f":v{len(self.values)}"
        self.values[token] = value
        return token

    def set(self, fields: dict[str, Any]) -> Expr:
        for k, v in fields.items():
            self._set.append(f"{self._name(k)} = {self._value(v)}")
        return self

    def remove(self, fields: Iterable[str]) -> Expr:
        self._remove += [self._name(k) for k in fields]
        return self

    def add(self, field: str, n: int) -> Expr:
        self._add.append(f"{self._name(field)} {self._value(n)}")
        return self

    def exists(self) -> Expr:
        self._cond.append(f"attribute_exists({self._name('pk')})")
        return self

    def missing(self) -> Expr:
        self._cond.append(f"attribute_not_exists({self._name('pk')})")
        return self

    def eq(self, field: str, value: Any) -> Expr:
        self._cond.append(f"{self._name(field)} = {self._value(value)}")
        return self

    def ne(self, field: str, value: Any) -> Expr:
        self._cond.append(f"{self._name(field)} <> {self._value(value)}")
        return self

    def is_in(self, field: str, values: Sequence[Any]) -> Expr:
        tokens = ", ".join(self._value(v) for v in values)
        self._cond.append(f"{self._name(field)} IN ({tokens})")
        return self

    @property
    def update(self) -> str:
        parts = []
        if self._set:
            parts.append("SET " + ", ".join(self._set))
        if self._remove:
            parts.append("REMOVE " + ", ".join(self._remove))
        if self._add:
            parts.append("ADD " + ", ".join(self._add))
        return " ".join(parts)

    @property
    def condition(self) -> str:
        return " AND ".join(self._cond)

    def params(self, *, with_update: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if with_update and self.update:
            out["UpdateExpression"] = self.update
        if self._cond:
            out["ConditionExpression"] = self.condition
        # A ConditionCheck may carry only the names and values its condition uses.
        used = set(_TOKEN.findall(self.condition)) if not with_update else None
        names = {t: n for t, n in self.names.items() if used is None or t in used}
        if names:
            out["ExpressionAttributeNames"] = names
        values = {t: v for t, v in self.values.items() if used is None or t in used}
        if values:
            out["ExpressionAttributeValues"] = {t: serialize(v) for t, v in values.items()}
        return out


def _code(e: BaseException) -> str:
    response = getattr(e, "response", None)
    return str(((response or {}).get("Error") or {}).get("Code") or "") if isinstance(response, dict) else ""


def _refused(e: BaseException) -> bool:
    code = _code(e)
    if code == "ConditionalCheckFailedException":
        return True
    if code == "TransactionCanceledException":
        reasons = getattr(e, "response", {}).get("CancellationReasons") or []
        return any((r or {}).get("Code") == "ConditionalCheckFailed" for r in reasons)
    return False


def _refused_at(e: BaseException, n: int) -> list[int]:
    if _code(e) != "TransactionCanceledException":
        return list(range(n))
    reasons = getattr(e, "response", {}).get("CancellationReasons") or []
    found = [i for i, r in enumerate(reasons) if (r or {}).get("Code") == "ConditionalCheckFailed"]
    return found if len(reasons) == n and found else list(range(n))


class Store:
    """The table (``CF_STORIES_TABLE``) through the low-level client, so transactions and single writes look alike."""

    def __init__(self, client: Any, table: str) -> None:
        self.client = client
        self.table = table

    @staticmethod
    def key(pk: str, sk: str) -> dict[str, Any]:
        return {"pk": {"S": pk}, "sk": {"S": sk}}

    def get(self, pk: str, sk: str) -> dict[str, Any] | None:
        raw = self.client.get_item(TableName=self.table, Key=self.key(pk, sk), ConsistentRead=True)
        return deserialize_item(raw.get("Item"))

    def query(
        self, pk: str, prefix: str, *, newest_first: bool = False, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Every item of the partition whose sort key starts with ``prefix`` (all pages, or the first ``limit``)."""
        out: list[dict[str, Any]] = []
        start: dict[str, Any] | None = None
        while True:
            params: dict[str, Any] = {
                "TableName": self.table,
                "KeyConditionExpression": "pk = :pk AND begins_with(sk, :prefix)",
                "ExpressionAttributeValues": {":pk": {"S": pk}, ":prefix": {"S": prefix}},
                "ScanIndexForward": not newest_first,
                "ConsistentRead": True,
            }
            if limit is not None:
                params["Limit"] = max(1, limit - len(out))
            if start:
                params["ExclusiveStartKey"] = start
            page = self.client.query(**params)
            for raw in page.get("Items") or []:
                item = deserialize_item(raw)
                if item is not None:
                    out.append(item)
            start = page.get("LastEvaluatedKey")
            if not start or (limit is not None and len(out) >= limit):
                return out[:limit] if limit is not None else out

    def update(self, pk: str, sk: str, expr: Expr) -> bool:
        try:
            self.client.update_item(TableName=self.table, Key=self.key(pk, sk), **expr.params())
        except Exception as e:
            if _refused(e):
                return False
            raise
        return True

    def put_new(self, item: dict[str, Any]) -> bool:
        """A brand-new item (``attribute_not_exists``): never overwrites one."""
        try:
            self.client.put_item(
                TableName=self.table,
                Item={k: serialize(v) for k, v in item.items()},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except Exception as e:
            if _refused(e):
                return False
            raise
        return True

    def transact(self, ops: Sequence[tuple[str, str, str, Any]]) -> bool:
        """``ops``: ``("update", pk, sk, Expr)``, ``("check", pk, sk, Expr)`` or ``("put", pk, sk, item)`` (a new item).
        All or nothing; ``False`` when any condition refused."""
        return not self.try_transact(ops)

    def try_transact(self, ops: Sequence[tuple[str, str, str, Any]]) -> list[int]:
        """Like ``transact``; the positions of the ops whose condition refused (empty when it was written). When
        DynamoDB does not say which, every position is returned."""
        items: list[dict[str, Any]] = []
        for kind, pk, sk, body in ops:
            if kind == "update":
                items.append({"Update": {"TableName": self.table, "Key": self.key(pk, sk), **body.params()}})
            elif kind == "check":
                items.append(
                    {
                        "ConditionCheck": {
                            "TableName": self.table,
                            "Key": self.key(pk, sk),
                            **body.params(with_update=False),
                        }
                    }
                )
            elif kind == "put":
                item = {"pk": pk, "sk": sk, **body}
                items.append(
                    {
                        "Put": {
                            "TableName": self.table,
                            "Item": {k: serialize(v) for k, v in item.items()},
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    }
                )
            else:
                raise ValueError(f"unknown transaction op: {kind}")
        try:
            self.client.transact_write_items(TransactItems=items)
        except Exception as e:
            if _refused(e):
                return _refused_at(e, len(items))
            raise
        return []
