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
MAX_TRANSACT_ITEMS = 100
MAX_BATCH_GET = 100


class ConditionFailed(Exception):
    """The item is missing or did not match the expected values."""


class TableLike(Protocol):
    def get_item(self, **kwargs: Any) -> Any: ...
    def put_item(self, **kwargs: Any) -> Any: ...
    def update_item(self, **kwargs: Any) -> Any: ...
    def delete_item(self, **kwargs: Any) -> Any: ...
    def query(self, **kwargs: Any) -> Any: ...

    @property
    def name(self) -> str: ...
    @property
    def meta(self) -> Any: ...


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


def conn_sk(connection_id: str) -> str:
    return f"CONN#{connection_id}"


def stat_sk(post_id: str, at: str) -> str:
    """A stats snapshot of one post (docs/CONTRACTS.md §16.3)."""
    return f"STAT#{post_id}#{at}"


def stat_prefix(post_id: str) -> str:
    return f"STAT#{post_id}#"


def week_sk(week: str) -> str:
    return f"WEEK#{week}"


LESSON_PREFIX = "LESSON#"
LEARN_STATE_SK = "LEARNSTATE"


def lesson_sk(lesson_id: str) -> str:
    """A creator lesson learned from day-7 numbers (a Learning with ``kind "creator"``, docs/CONTRACTS.md §16.12).

    A prefix of its own (not ``LEARNING#``) so the agent's and Insights' reads of the older learnings never page
    through lessons and the other way round. Additive: no existing item changes."""
    return f"{LESSON_PREFIX}{lesson_id}"


def rate_pk(platform: str) -> str:
    """The app-wide rate budget of one platform (single-owner app, §16.3)."""
    return f"RATE#{platform}"


RATE_SK = "BUDGET"
STATS_GSI_PK = "STATS"

# Content Rewards (docs/CONTRACTS.md §38.11): additive sort keys under the owner, and the poller's owner list.
CRCONN_SK = "CRCONN"
CRMONEY_SK = "CRMONEY"
CAMPAIGN_PREFIX = "CAMPAIGN#"
CRSUB_PREFIX = "CRSUB#"
CROWNERS_PK = "CROWNERS"


def crstate_sk(nonce: str) -> str:
    """One Connect Content Rewards attempt (single use, 5 minutes)."""
    return f"CRSTATE#{nonce}"


def campaign_sk(uuid: str) -> str:
    return f"{CAMPAIGN_PREFIX}{uuid}"


def crsub_sk(post_id: str) -> str:
    """What was sent to Content Rewards for one campaign post."""
    return f"{CRSUB_PREFIX}{post_id}"


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
    if isinstance(value, set | frozenset):
        return {to_dynamo(v) for v in value}
    raise TypeError(f"cannot store {type(value).__name__} in DynamoDB")


def from_dynamo(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, set | frozenset):
        return sorted(from_dynamo(v) for v in value)
    if isinstance(value, list | tuple):
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


# --- update requests ------------------------------------------------------------------------------------------


def update_request(
    pk: str,
    sk: str,
    set_fields: Mapping[str, Any],
    *,
    remove: Iterable[str] = (),
    expect_in: Mapping[str, Iterable[Any]] | None = None,
    expect_absent: Iterable[str] = (),
    expect_present: Iterable[str] = (),
) -> dict[str, Any]:
    """The UpdateItem parameters (also usable inside a transaction). The item must exist; ``expect_in``,
    ``expect_absent`` and ``expect_present`` add conditions."""
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
    for i, field in enumerate(expect_absent):
        names[f"#a{i}"] = field
        conditions.append(f"attribute_not_exists(#a{i})")
    for i, field in enumerate(expect_present):
        names[f"#p{i}"] = field
        conditions.append(f"attribute_exists(#p{i})")
    kwargs: dict[str, Any] = {
        "Key": {"pk": pk, "sk": sk},
        "UpdateExpression": expression,
        "ConditionExpression": " AND ".join(conditions),
        "ExpressionAttributeNames": names,
    }
    if values:
        kwargs["ExpressionAttributeValues"] = values
    return kwargs


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

    def put_when(
        self,
        item: Mapping[str, Any],
        condition: str,
        *,
        names: Mapping[str, str] | None = None,
        values: Mapping[str, Any] | None = None,
    ) -> None:
        """A PutItem with its own condition expression. A failed condition raises ``ConditionFailed``."""
        self._call(self._table.put_item, **self.put_if(item, condition, names=names, values=values))

    def delete(self, pk: str, sk: str) -> None:
        self._table.delete_item(Key={"pk": pk, "sk": sk})

    def delete_if(self, pk: str, sk: str, expect_in: Mapping[str, Iterable[Any]]) -> bool:
        """Deletes the item only while each named field holds one of the given values; False when it did not (the
        item is gone, or changed meanwhile: a clip kept on another device while its job was being deleted)."""
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        conditions = ["attribute_exists(pk)"]
        for i, (field, allowed) in enumerate(expect_in.items()):
            names[f"#c{i}"] = field
            placeholders = []
            for j, value in enumerate(allowed):
                values[f":c{i}_{j}"] = to_dynamo(value)
                placeholders.append(f":c{i}_{j}")
            conditions.append(f"#c{i} IN ({', '.join(placeholders)})")
        kwargs: dict[str, Any] = {"Key": {"pk": pk, "sk": sk}, "ConditionExpression": " AND ".join(conditions)}
        if names:
            kwargs["ExpressionAttributeNames"] = names
            kwargs["ExpressionAttributeValues"] = values
        try:
            self._call(self._table.delete_item, **kwargs)
        except ConditionFailed:
            return False
        return True

    def delete_once(self, pk: str, sk: str) -> Item | None:
        """Deletes an existing item and returns it; None when it was already gone (single-use tokens, §17.5)."""
        try:
            out = self._call(
                self._table.delete_item,
                Key={"pk": pk, "sk": sk},
                ConditionExpression="attribute_exists(pk)",
                ReturnValues="ALL_OLD",
            )
        except ConditionFailed:
            return None
        old = out.get("Attributes") if isinstance(out, Mapping) else None
        return dict(from_dynamo(old)) if old else None

    def update(
        self,
        pk: str,
        sk: str,
        set_fields: Mapping[str, Any],
        *,
        remove: Iterable[str] = (),
        expect_in: Mapping[str, Iterable[Any]] | None = None,
        expect_absent: Iterable[str] = (),
        expect_present: Iterable[str] = (),
    ) -> Item:
        """Sets and removes top-level fields on an existing item and returns the new item.

        ``expect_in`` makes the write conditional: each named field must hold one of the given values.
        ``expect_absent`` names fields that must not exist yet; ``expect_present`` names fields that must exist.
        """
        kwargs = update_request(
            pk,
            sk,
            set_fields,
            remove=remove,
            expect_in=expect_in,
            expect_absent=expect_absent,
            expect_present=expect_present,
        )
        kwargs["ReturnValues"] = "ALL_NEW"
        out = self._call(self._table.update_item, **kwargs)
        return dict(from_dynamo(out.get("Attributes", {})))

    def update_expr(
        self,
        pk: str,
        sk: str,
        update: str,
        *,
        condition: str | None = None,
        names: Mapping[str, str] | None = None,
        values: Mapping[str, Any] | None = None,
    ) -> Item:
        """A raw UpdateItem (any update and condition expression) that returns the new item. Unlike ``update``
        it creates a missing item unless the condition says otherwise. A failed condition raises
        ``ConditionFailed``."""
        kwargs: dict[str, Any] = {"Key": {"pk": pk, "sk": sk}, "UpdateExpression": update, "ReturnValues": "ALL_NEW"}
        if condition:
            kwargs["ConditionExpression"] = condition
        if names:
            kwargs["ExpressionAttributeNames"] = dict(names)
        if values:
            kwargs["ExpressionAttributeValues"] = {k: to_dynamo(v) for k, v in values.items()}
        out = self._call(self._table.update_item, **kwargs)
        return dict(from_dynamo(out.get("Attributes", {})))

    @staticmethod
    def put_if(
        item: Mapping[str, Any],
        condition: str,
        *,
        names: Mapping[str, str] | None = None,
        values: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """A Put request with its own condition, for ``transact(raw_puts=...)``."""
        request: dict[str, Any] = {"Item": to_dynamo(item), "ConditionExpression": condition}
        if names:
            request["ExpressionAttributeNames"] = dict(names)
        if values:
            request["ExpressionAttributeValues"] = {k: to_dynamo(v) for k, v in values.items()}
        return request

    def transact(
        self,
        *,
        puts: Iterable[Mapping[str, Any]] = (),
        updates: Iterable[Mapping[str, Any]] = (),
        raw_puts: Iterable[Mapping[str, Any]] = (),
    ) -> None:
        """All-or-nothing TransactWriteItems. ``puts`` are new items (each must not exist yet); ``updates`` are
        requests built by ``update_request``; ``raw_puts`` are built by ``put_if``. A failed condition anywhere
        raises ``ConditionFailed``."""
        name = self._table.name
        actions: list[dict[str, Any]] = [{"Put": {"TableName": name, **p}} for p in raw_puts]
        actions += [{"Update": {"TableName": name, **u}} for u in updates]
        actions += [
            {"Put": {"TableName": name, "Item": to_dynamo(p), "ConditionExpression": "attribute_not_exists(pk)"}}
            for p in puts
        ]
        if not actions:
            return
        if len(actions) > MAX_TRANSACT_ITEMS:
            raise ValueError("too many items for one transaction")
        self._call(self._table.meta.client.transact_write_items, TransactItems=actions)

    def batch_get(self, keys: Iterable[tuple[str, str]]) -> list[Item]:
        """The items that exist among ``keys`` (BatchGetItem, at most 100 keys per call), in no particular order."""
        wanted = [{"pk": pk, "sk": sk} for pk, sk in dict.fromkeys(keys)]
        found: list[Item] = []
        client = self._table.meta.client
        name = self._table.name
        for start in range(0, len(wanted), MAX_BATCH_GET):
            request: dict[str, Any] = {name: {"Keys": wanted[start : start + MAX_BATCH_GET], "ConsistentRead": True}}
            for _ in range(5):  # unprocessed keys come back under throttling; a few rounds always clear them
                out = client.batch_get_item(RequestItems=request)
                found.extend(from_dynamo(i) for i in out.get("Responses", {}).get(name, []))
                request = out.get("UnprocessedKeys") or {}
                if not request:
                    break
        return found

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
        # DynamoDB refuses an empty string in a key condition, so an empty prefix means "the whole partition".
        if sk_prefix:
            condition = f"{pk_name} = :pk AND begins_with({sk_name}, :prefix)"
            values: dict[str, Any] = {":pk": pk, ":prefix": sk_prefix}
        else:
            condition = f"{pk_name} = :pk"
            values = {":pk": pk}
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": condition,
            "ExpressionAttributeValues": values,
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
        cap: int | None = None,
        consistent: bool = False,
    ) -> list[Item]:
        """Every matching item, following every page. ``cap`` stops early (after that many items, in the requested
        order) only when a caller asks for it: there is no silent default limit, so owner-wide reads never drop
        the newest (or oldest) items once an owner has a lot of data."""
        items: list[Item] = []
        start: Item | None = None
        while cap is None or len(items) < cap:
            page = self.query_page(
                pk, sk_prefix, index=index, newest_first=newest_first, start_key=start, consistent=consistent
            )
            items.extend(page.items)
            if not page.last_key:
                break
            start = page.last_key
        return items if cap is None else items[:cap]

    def query_stats_due(self, max_sk: str, *, cap: int = 2000) -> list[Item]:
        """Posts due for a stats poll: sparse gsi2 ``gsi2pk = "STATS" AND gsi2sk <= max_sk``, oldest due first."""
        items: list[Item] = []
        start: Any = None
        while len(items) < cap:
            kwargs: dict[str, Any] = {
                "IndexName": "gsi2",
                "KeyConditionExpression": "gsi2pk = :pk AND gsi2sk <= :max",
                "ExpressionAttributeValues": {":pk": STATS_GSI_PK, ":max": max_sk},
                "ScanIndexForward": True,
            }
            if start:
                kwargs["ExclusiveStartKey"] = start
            out = self._table.query(**kwargs)
            items.extend(from_dynamo(i) for i in out.get("Items", []))
            start = out.get("LastEvaluatedKey")
            if not start:
                break
        return items[:cap]

    @staticmethod
    def _call(fn: Any, **kwargs: Any) -> Any:
        try:
            return fn(**kwargs)
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise ConditionFailed(str(e)) from e
            raise
