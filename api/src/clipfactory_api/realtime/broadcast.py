"""``cf-prod-broadcast``: DynamoDB Streams on ``cf-prod-data`` → the owner's open WebSockets (docs/CONTRACTS.md §14.2).

The event source mapping only delivers ``JOB#``, ``CLIP#``, ``POST#``, ``LEARNING#`` and ``WEEK#`` items. Per batch the last
record per item wins (job heartbeats coalesce); each becomes one ``LiveEvent``, built by the same public-shape
functions the HTTP API uses, so internal fields never leave. An event over 24 KB is sent as ``partial: true`` (the
web refetches). Closed connections (410 Gone) are deleted; other send errors are logged and skipped. Only a
failed connections query reports records as batch item failures, so Lambda retries just those.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .. import clips, db, jobs, learn, posts, weeks
from ..log import log
from . import MAX_EVENT_BYTES, encode, is_gone, management_client

Item = dict[str, Any]

TYPES = {"JOB#": "job", "CLIP#": "clip", "POST#": "post", "LEARNING#": "learning", "WEEK#": "week"}
ID_FIELDS = {"job": "jobId", "clip": "clipId", "post": "postId", "learning": "learningId", "week": "week"}


def _public(kind: str, item: Item) -> Item:
    if kind == "job":
        return jobs.public_job(item)
    if kind == "clip":
        return clips.public_clip(item)  # no presigned links: the web keeps the ones it has
    if kind == "post":
        return posts.public_post(item)
    if kind == "week":
        return weeks.public_week(item)
    return learn.public_learning(item)


@dataclass
class BroadcastDeps:
    store: db.Store
    management: Any
    deserialize: Callable[[Mapping[str, Any]], Item]


def _deserializer() -> Callable[[Mapping[str, Any]], Item]:
    from boto3.dynamodb.types import TypeDeserializer

    td = TypeDeserializer()

    def deserialize(image: Mapping[str, Any]) -> Item:
        return dict(db.from_dynamo({k: td.deserialize(v) for k, v in image.items()}))

    return deserialize


@dataclass(frozen=True)
class Change:
    user_id: str
    kind: str
    item_id: str
    message: dict[str, Any]
    sequence_numbers: tuple[str, ...]


def _key(record: Mapping[str, Any]) -> tuple[str, str] | None:
    keys = (record.get("dynamodb") or {}).get("Keys") or {}
    pk = (keys.get("pk") or {}).get("S")
    sk = (keys.get("sk") or {}).get("S")
    return (pk, sk) if isinstance(pk, str) and isinstance(sk, str) else None


def _kind(sk: str) -> tuple[str, str] | None:
    for prefix, kind in TYPES.items():
        if sk.startswith(prefix):
            return kind, sk[len(prefix) :]
    return None


def message_for(record: Mapping[str, Any], deserialize: Callable[[Mapping[str, Any]], Item]) -> dict[str, Any] | None:
    """The LiveEvent for one stream record, or None when the record is not an owner's job/clip/post/learning/week."""
    key = _key(record)
    if key is None or not key[0].startswith("USER#"):
        return None
    found = _kind(key[1])
    if found is None:
        return None
    kind, item_id = found
    data = record.get("dynamodb") or {}
    if record.get("eventName") == "REMOVE":
        return {"type": kind, "op": "delete", "id": item_id}
    image = data.get("NewImage")
    if not isinstance(image, Mapping):
        return {"type": kind, "op": "upsert", "id": item_id, "partial": True}
    item = deserialize(image)
    public = _public(kind, item)
    message: dict[str, Any] = {
        "type": kind,
        "op": "upsert",
        "id": str(item.get(ID_FIELDS[kind]) or item_id),
        "item": public,
    }
    if len(encode(message)) > MAX_EVENT_BYTES:
        return {"type": kind, "op": "upsert", "id": message["id"], "partial": True}
    return message


def collect(records: list[Mapping[str, Any]], deserialize: Callable[[Mapping[str, Any]], Item]) -> list[Change]:
    """One Change per item, from its last record in the batch; earlier records of the same item are folded in."""
    latest: dict[tuple[str, str], Mapping[str, Any]] = {}
    sequences: dict[tuple[str, str], list[str]] = {}
    for record in records:
        key = _key(record)
        if key is None:
            continue
        latest.pop(key, None)  # re-insert so the dict order follows each item's last change
        latest[key] = record
        seq = (record.get("dynamodb") or {}).get("SequenceNumber")
        if isinstance(seq, str):
            sequences.setdefault(key, []).append(seq)
    changes = []
    for key, record in latest.items():
        message = message_for(record, deserialize)
        if message is None:
            continue
        changes.append(
            Change(key[0][len("USER#") :], message["type"], message["id"], message, tuple(sequences.get(key, [])))
        )
    return changes


def process(event: Mapping[str, Any], deps: BroadcastDeps) -> dict[str, list[dict[str, str]]]:
    records = [r for r in event.get("Records", []) if isinstance(r, Mapping)]
    by_user: dict[str, list[Change]] = {}
    for change in collect(records, deps.deserialize):
        by_user.setdefault(change.user_id, []).append(change)
    failures: list[dict[str, str]] = []
    sent = gone = 0
    for user_id, changes in by_user.items():
        try:
            connections = deps.store.query_all(db.user_pk(user_id), "CONN#")
        except Exception as e:
            log("error", "broadcast.query_failed", error=type(e).__name__, changes=len(changes))
            failures.extend({"itemIdentifier": seq} for c in changes for seq in c.sequence_numbers)
            continue
        live = [c for c in connections if c.get("type") == "conn" and c.get("connectionId")]
        for conn in live:
            for change in changes:
                try:
                    deps.management.post_to_connection(ConnectionId=conn["connectionId"], Data=encode(change.message))
                    sent += 1
                except Exception as e:
                    if is_gone(e):
                        gone += 1
                        _forget(deps, conn)
                        break  # the connection is closed: nothing more goes to it
                    log("warning", "broadcast.send_failed", connectionId=conn["connectionId"], error=type(e).__name__)
    log("info", "broadcast.done", records=len(records), sent=sent, gone=gone, failed=len(failures))
    return {"batchItemFailures": failures}


def _forget(deps: BroadcastDeps, conn: Item) -> None:
    try:
        deps.store.delete(conn["pk"], conn["sk"])
    except Exception as e:  # its ttl removes it later anyway
        log("warning", "broadcast.forget_failed", connectionId=conn.get("connectionId"), error=type(e).__name__)


_deps: BroadcastDeps | None = None


def _from_env() -> BroadcastDeps:
    from ..app import table

    env = os.environ
    return BroadcastDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        management=management_client(env["WS_ENDPOINT"]),
        deserialize=_deserializer(),
    )


def get_deps(factory: Callable[[], BroadcastDeps] = _from_env) -> BroadcastDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, list[dict[str, str]]]:
    return process(event, get_deps())
