"""Typed helpers over the single DynamoDB table ``cf-prod-data`` (docs/CONTRACTS.md §6).

``Store`` wraps a boto3 ``Table`` resource. It converts numbers both ways (DynamoDB needs ``Decimal``; JSON
needs ``int``/``float``) and turns a failed condition into ``ConditionFailed`` so callers never see botocore
errors. Every expression it builds has one of a few fixed shapes, which keeps the test fake small.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

from .errors import bad_request

Item = dict[str, Any]
KEY_FIELDS = ("pk", "sk", "gsi1pk", "gsi1sk")


class ConditionFailed(Exception):
    """The item is missing or did not match the expected values."""


class TableLike(Protocol):
    def get_item(self, **kwargs: Any) -> Any: ...
    def put_item(self, **kwargs: Any) -> Any: ...
    def update_item(self, **kwargs: Any) -> Any: ...
    def delete_item(self, **kwargs: Any) -> Any: ...
    def query(self, **kwargs: Any) -> Any: ...
    def scan(self, **kwargs: Any) -> Any: ...


# --- key builders ---------------------------------------------------------------------------------------------


def user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


SETTINGS_SK = "SETTINGS"


def job_sk(job_id: str) -> str:
    return f"JOB#{job_id}"


def clip_sk(clip_id: str) -> str:
    return f"CLIP#{clip_id}"


def skill_sk(skill_id: str) -> str:
    return f"SKILL#{skill_id}"


def post_sk(post_id: str) -> str:
    return f"POST#{post_id}"


def learning_sk(learning_id: str) -> str:
    return f"LEARNING#{learning_id}"


# --- number conversion ----------------------------------------------------------------------------------------


def to_dynamo(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, str | int | Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, Mapping):
        return {k: to_dynamo(v) for k, v in value.items() if v is not None}
    if isinstance(value, list | tuple):
        return [to_dynamo(v) for v in value]
    raise TypeError(f"cannot store {type(value).__name__} in DynamoDB")


def from_dynamo(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [from_dynamo(v) for v in value]
    return value


def strip_keys(item: Mapping[str, Any], extra: Iterable[str] = ()) -> Item:
    """The public shape of an item: no table keys, no internal fields."""
    hidden = {*KEY_FIELDS, "type", "userId", "ttl", *extra}
    return {k: v for k, v in item.items() if k not in hidden}


# --- cursors --------------------------------------------------------------------------------------------------


def encode_cursor(last_key: Mapping[str, Any] | None) -> str | None:
    if not last_key:
        return None
    raw = json.dumps(from_dynamo(last_key), separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, expected_pk: str, sk_prefix: str) -> Item | None:
    """Opaque to the client; it must belong to the caller so nobody can page through another owner's items.

    The key must be exactly a table key (``pk``, ``sk``) inside the range being queried (``sk`` starts with
    ``sk_prefix``): DynamoDB rejects any other ExclusiveStartKey with a ValidationException, which would surface
    as a 500 instead of this 400.
    """
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        key = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, binascii.Error) as e:
        raise bad_request("The page cursor is not valid. Reload the list.") from e
    if (
        not isinstance(key, dict)
        or set(key) != {"pk", "sk"}
        or key["pk"] != expected_pk
        or not isinstance(key["sk"], str)
        or not key["sk"].startswith(sk_prefix)
    ):
        raise bad_request("The page cursor is not valid. Reload the list.")
    return key


# --- the store ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Page:
    items: list[Item]
    last_key: Item | None


class Store:
    def __init__(self, table: TableLike) -> None:
        self._table = table

    def get(self, pk: str, sk: str) -> Item | None:
        out = self._table.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True)
        item = out.get("Item")
        return from_dynamo(item) if item else None

    def put(self, item: Mapping[str, Any], *, if_absent: bool = False) -> None:
        kwargs: dict[str, Any] = {"Item": to_dynamo(item)}
        if if_absent:
            kwargs["ConditionExpression"] = "attribute_not_exists(pk)"
        self._call(self._table.put_item, **kwargs)

    def delete(self, pk: str, sk: str) -> None:
        self._table.delete_item(Key={"pk": pk, "sk": sk})

    def update(
        self,
        pk: str,
        sk: str,
        set_fields: Mapping[str, Any],
        *,
        remove: Iterable[str] = (),
        expect_in: Mapping[str, Iterable[Any]] | None = None,
    ) -> Item:
        """Sets and removes top-level fields on an existing item and returns the new item.

        ``expect_in`` makes the write conditional: each named field must hold one of the given values.
        """
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        sets = []
        for i, (field, value) in enumerate(set_fields.items()):
            names[f"#s{i}"] = field
            values[f":s{i}"] = to_dynamo(value)
            sets.append(f"#s{i} = :s{i}")
        removes = []
        for i, field in enumerate(remove):
            names[f"#r{i}"] = field
            removes.append(f"#r{i}")
        expression = ""
        if sets:
            expression += "SET " + ", ".join(sets)
        if removes:
            expression += (" " if expression else "") + "REMOVE " + ", ".join(removes)
        if not expression:
            raise ValueError("update needs at least one field")
        conditions = ["attribute_exists(pk)"]
        for i, (field, allowed) in enumerate((expect_in or {}).items()):
            names[f"#c{i}"] = field
            placeholders = []
            for j, value in enumerate(allowed):
                values[f":c{i}_{j}"] = to_dynamo(value)
                placeholders.append(f":c{i}_{j}")
            conditions.append(f"#c{i} IN ({', '.join(placeholders)})")
        kwargs: dict[str, Any] = {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": expression,
            "ConditionExpression": " AND ".join(conditions),
            "ExpressionAttributeNames": names,
            "ReturnValues": "ALL_NEW",
        }
        if values:
            kwargs["ExpressionAttributeValues"] = values
        out = self._call(self._table.update_item, **kwargs)
        return dict(from_dynamo(out.get("Attributes", {})))

    def query_page(
        self,
        pk: str,
        sk_prefix: str,
        *,
        index: str | None = None,
        newest_first: bool = False,
        limit: int | None = None,
        start_key: Mapping[str, Any] | None = None,
        consistent: bool = False,
    ) -> Page:
        if consistent and index:
            raise ValueError("a global secondary index cannot be read consistently")
        pk_name, sk_name = ("gsi1pk", "gsi1sk") if index else ("pk", "sk")
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": f"{pk_name} = :pk AND begins_with({sk_name}, :prefix)",
            "ExpressionAttributeValues": {":pk": pk, ":prefix": sk_prefix},
            "ScanIndexForward": not newest_first,
        }
        if index:
            kwargs["IndexName"] = index
        if limit:
            kwargs["Limit"] = limit
        if start_key:
            kwargs["ExclusiveStartKey"] = dict(start_key)
        if consistent:
            kwargs["ConsistentRead"] = True
        out = self._table.query(**kwargs)
        items = [from_dynamo(i) for i in out.get("Items", [])]
        last = out.get("LastEvaluatedKey")
        return Page(items, from_dynamo(last) if last else None)

    def query_all(
        self,
        pk: str,
        sk_prefix: str,
        *,
        index: str | None = None,
        newest_first: bool = False,
        cap: int = 5000,
        consistent: bool = False,
    ) -> list[Item]:
        """Every matching item, following pages, up to ``cap`` (a safety stop, far above one owner's data)."""
        items: list[Item] = []
        start: Item | None = None
        while len(items) < cap:
            page = self.query_page(
                pk, sk_prefix, index=index, newest_first=newest_first, start_key=start, consistent=consistent
            )
            items.extend(page.items)
            if not page.last_key:
                break
            start = page.last_key
        return items[:cap]

    def scan_jobs(self, statuses: Iterable[str]) -> list[Item]:
        """Jobs in the given states across all owners (the watchdog's view)."""
        return self.scan_type("job", "status", statuses)

    def scan_type(self, item_type: str, field: str, allowed: Iterable[str]) -> list[Item]:
        """Items of one type whose ``field`` holds one of ``allowed``, across all owners."""
        values: dict[str, Any] = {":type": item_type}
        placeholders = []
        for i, value in enumerate(allowed):
            values[f":v{i}"] = value
            placeholders.append(f":v{i}")
        kwargs: dict[str, Any] = {
            "FilterExpression": f"#type = :type AND #field IN ({', '.join(placeholders)})",
            "ExpressionAttributeNames": {"#type": "type", "#field": field},
            "ExpressionAttributeValues": values,
        }
        items: list[Item] = []
        while True:
            out = self._table.scan(**kwargs)
            items.extend(from_dynamo(i) for i in out.get("Items", []))
            last = out.get("LastEvaluatedKey")
            if not last:
                return items
            kwargs["ExclusiveStartKey"] = last

    @staticmethod
    def _call(fn: Any, **kwargs: Any) -> Any:
        try:
            return fn(**kwargs)
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                raise ConditionFailed(str(e)) from e
            raise
