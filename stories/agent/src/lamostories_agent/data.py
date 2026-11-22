"""DynamoDB and S3 for the story pipeline (docs/CONTRACTS.md §45.3, §45.4, §45.9.1, §45.11.1, §45.12).

Only the workspace's own partition ``USER#{userId}#WS#{workspaceId}`` is written, only with update expressions that
set the agent's own attributes (§45.9.1), and every write is fenced on the job's run:

* a ``PJOB#`` write is conditional on ``sessionId = :sid AND status <> canceled``;
* a ``STORY#``, ``ASSET#``, ``ACT#`` or ``PROVIDER#`` write is a transaction with a ConditionCheck on the job (the
  same condition; the job's own update takes its place when the job is written in the same transaction), and the
  story's update also needs ``currentJobId`` to still be this job.

A refused condition raises ``JobSuperseded``: the run stops and writes nothing more (a cancel, the API's stale
heartbeat fence, or a newer run). S3 files go under ``ws/{userId}/{workspaceId}/`` only. Nothing here reads Clip
Factory's partition, its skills or its prefixes (§45.24, §45.26)."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import keys
from .retry import is_transient, retry
from .store import Store, from_ddb
from .util import JobSuperseded, log, now_iso, ulid


@dataclass(frozen=True)
class JobFence:
    """The run a write belongs to: the job item must still carry this ``sessionId`` and not be canceled."""

    user_id: str
    workspace_id: str
    job_id: str
    session_id: str

    @property
    def pk(self) -> str:
        return keys.ws_pk(self.user_id, self.workspace_id)

    @property
    def job_key(self) -> dict[str, str]:
        return {"pk": self.pk, "sk": keys.job_sk(self.job_id)}


def _reasons(e: BaseException) -> list[str]:
    response = getattr(e, "response", None)
    if not isinstance(response, dict) or (response.get("Error") or {}).get("Code") != "TransactionCanceledException":
        return []
    return [str((r or {}).get("Code") or "None") for r in response.get("CancellationReasons") or []]


def _txn_transient(e: BaseException) -> bool:
    return is_transient(e) or "TransactionConflict" in _reasons(e)


def _code(e: BaseException) -> str:
    response = getattr(e, "response", None)
    return str(((response or {}).get("Error") or {}).get("Code") or "") if isinstance(response, dict) else ""


def to_ddb(value: Any) -> Any:
    """A value as DynamoDB takes it: floats as Decimals (NaN and infinity become null), and, unlike the clip store's
    helper, a ``None`` inside a map is kept as null, so a shape's ``x: string | null`` reads back as null."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return Decimal(str(round(value, 6))) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: to_ddb(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [to_ddb(v) for v in value]
    return value


class Expr:
    """An update expression built from plain field names (``a.b`` is a path into a map)."""

    def __init__(self) -> None:
        self.names: dict[str, str] = {}
        self.values: dict[str, Any] = {}
        self._sets: list[str] = []
        self._removes: list[str] = []
        self._adds: list[str] = []
        self._conds: list[str] = []

    def _path(self, field: str) -> str:
        parts = []
        for part in field.split("."):
            token = f"#n{len(self.names)}"
            existing = next((k for k, v in self.names.items() if v == part), None)
            if existing is None:
                self.names[token] = part
            else:
                token = existing
            parts.append(token)
        return ".".join(parts)

    def _value(self, value: Any) -> str:
        token = f":v{len(self.values)}"
        self.values[token] = to_ddb(value)
        return token

    def set(self, fields: dict[str, Any]) -> Expr:
        for k, v in fields.items():
            self._sets.append(f"{self._path(k)} = {self._value(v)}")
        return self

    def remove(self, fields: Sequence[str]) -> Expr:
        self._removes += [self._path(k) for k in fields]
        return self

    def add(self, field: str, n: int) -> Expr:
        self._adds.append(f"{self._path(field)} {self._value(n)}")
        return self

    def exists(self) -> Expr:
        self._conds.append("attribute_exists(pk)")
        return self

    def not_exists(self) -> Expr:
        self._conds.append("attribute_not_exists(pk)")
        return self

    def equals(self, field: str, value: Any) -> Expr:
        self._conds.append(f"{self._path(field)} = {self._value(value)}")
        return self

    def differs(self, field: str, value: Any) -> Expr:
        self._conds.append(f"{self._path(field)} <> {self._value(value)}")
        return self

    @property
    def update(self) -> str:
        out = []
        if self._sets:
            out.append("SET " + ", ".join(self._sets))
        if self._removes:
            out.append("REMOVE " + ", ".join(self._removes))
        if self._adds:
            out.append("ADD " + ", ".join(self._adds))
        return " ".join(out)

    @property
    def condition(self) -> str:
        return " AND ".join(self._conds)

    def params(self, *, update: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if update and self.update:
            out["UpdateExpression"] = self.update
        if self._conds:
            out["ConditionExpression"] = self.condition
        if self.names:
            out["ExpressionAttributeNames"] = dict(self.names)
        if self.values:
            out["ExpressionAttributeValues"] = dict(self.values)
        return out


def job_condition(e: Expr, fence: JobFence) -> Expr:
    return e.exists().equals("sessionId", fence.session_id).differs("status", "canceled")


@dataclass
class AssetPut:
    """One file the job made, as its ``ASSET#`` item (§45.12)."""

    kind: str
    key: str
    content_type: str
    bytes: int
    version: int | None
    story_id: str | None = None
    character_id: str | None = None
    meta: dict[str, str | int | float] | None = None
    asset_id: str = ""

    def item(self, fence: JobFence, created_at: str) -> dict[str, Any]:
        if not self.asset_id:
            self.asset_id = ulid()
        return {
            "pk": fence.pk,
            "sk": keys.asset_sk(self.asset_id),
            "type": keys.TYPE_ASSET,
            "userId": fence.user_id,
            "workspaceId": fence.workspace_id,
            "assetId": self.asset_id,
            "kind": self.kind,
            "storyId": self.story_id,
            "characterId": self.character_id,
            "key": self.key,
            "contentType": self.content_type,
            "bytes": int(self.bytes),
            "version": self.version,
            "meta": {"current": 1, **(self.meta or {})},
            "createdAt": created_at,
        }


class StoryData:
    """The workspace partition and the ``ws/`` files, over the agent's ``Store`` (its table and its S3 client)."""

    def __init__(self, store: Store) -> None:
        self.store = store

    @property
    def table(self) -> Any:
        return self.store.table

    async def _call(self, what: str, fn: Callable[..., Any], **kwargs: Any) -> Any:
        return await retry(lambda: asyncio.to_thread(fn, **kwargs), what=what)

    # --- reads --------------------------------------------------------------------------------------------------

    async def get(self, pk: str, sk: str, *, consistent: bool = False) -> dict[str, Any] | None:
        r = await self._call("ddb.ws_get", self.table.get_item, Key={"pk": pk, "sk": sk}, ConsistentRead=consistent)
        item = r.get("Item")
        return from_ddb(item) if item else None

    async def query_prefix(self, pk: str, prefix: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "pk = :pk AND begins_with(sk, :sk)",
            "ExpressionAttributeValues": {":pk": pk, ":sk": prefix},
        }
        while True:
            r = await self._call("ddb.ws_query", self.table.query, **kwargs)
            items += [from_ddb(i) for i in r.get("Items") or []]
            if not r.get("LastEvaluatedKey"):
                return items
            kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]

    @staticmethod
    def _owned(item: dict[str, Any] | None, user_id: str, workspace_id: str) -> dict[str, Any] | None:
        """The second, independent ownership check (§45.3): the item's own ``userId`` and ``workspaceId``."""
        if item is None:
            return None
        if item.get("userId") not in (None, user_id) or item.get("workspaceId") not in (None, workspace_id):
            log("error", "story.foreign_item", sk=item.get("sk"))
            return None
        return item

    async def workspace(self, user_id: str, workspace_id: str) -> dict[str, Any] | None:
        item = await self.get(keys.registry_pk(user_id), keys.workspace_sk(workspace_id))
        return self._owned(item, user_id, workspace_id)

    async def job(
        self, user_id: str, workspace_id: str, job_id: str, *, consistent: bool = True
    ) -> dict[str, Any] | None:
        item = await self.get(keys.ws_pk(user_id, workspace_id), keys.job_sk(job_id), consistent=consistent)
        return self._owned(item, user_id, workspace_id)

    async def story(self, user_id: str, workspace_id: str, story_id: str) -> dict[str, Any] | None:
        item = await self.get(keys.ws_pk(user_id, workspace_id), keys.story_sk(story_id), consistent=True)
        return self._owned(item, user_id, workspace_id)

    async def character(self, user_id: str, workspace_id: str, character_id: str) -> dict[str, Any] | None:
        item = await self.get(keys.ws_pk(user_id, workspace_id), keys.char_sk(character_id))
        return self._owned(item, user_id, workspace_id)

    async def idea(self, user_id: str, workspace_id: str, idea_id: str) -> dict[str, Any] | None:
        item = await self.get(keys.ws_pk(user_id, workspace_id), keys.idea_sk(idea_id))
        return self._owned(item, user_id, workspace_id)

    async def assets(
        self, user_id: str, workspace_id: str, *, story_id: str | None = None, character_id: str | None = None
    ) -> list[dict[str, Any]]:
        rows = await self.query_prefix(keys.ws_pk(user_id, workspace_id), "ASSET#")
        out = []
        for r in rows:
            if self._owned(r, user_id, workspace_id) is None:
                continue
            if story_id is not None and r.get("storyId") != story_id:
                continue
            if character_id is not None and r.get("characterId") != character_id:
                continue
            out.append(r)
        return out

    async def reference(self, user_id: str, workspace_id: str, ref_id: str) -> dict[str, Any] | None:
        item = await self.get(keys.ws_pk(user_id, workspace_id), keys.refvid_sk(ref_id), consistent=True)
        return self._owned(item, user_id, workspace_id)

    # --- fenced writes ------------------------------------------------------------------------------------------

    async def update_job(self, fence: JobFence, fields: dict[str, Any], *, remove: Sequence[str] = ()) -> None:
        """Sets the agent's job attributes (plus ``updatedAt``), fenced on the run; JobSuperseded when refused."""
        from botocore.exceptions import ClientError

        e = Expr().set({**fields, "updatedAt": now_iso()}).remove(remove)
        job_condition(e, fence)
        try:
            await self._call("ddb.pjob_update", self.table.update_item, Key=fence.job_key, **e.params())
        except ClientError as err:
            if _code(err) == "ConditionalCheckFailedException":
                raise JobSuperseded() from err
            raise

    async def write(
        self,
        fence: JobFence,
        *,
        story_id: str | None = None,
        story_set: dict[str, Any] | None = None,
        story_remove: Sequence[str] = (),
        assets: Sequence[AssetPut] = (),
        retire: Sequence[str] = (),
        puts: Sequence[dict[str, Any]] = (),
        job_fields: dict[str, Any] | None = None,
        other_set: tuple[str, dict[str, Any], dict[str, Any]] | None = None,
        other_remove: Sequence[str] = (),
        delete_assets: Sequence[str] = (),
    ) -> None:
        """One transaction: the job's check (or its update), the story's update (``version`` + 1, ``updatedAt``),
        new ``ASSET#`` items, older assets marked ``meta.current = 0`` (``retire``: asset ids) and other new items
        (``puts``: an activity, a provider state), one update of another item of the workspace (``other_set``:
        ``(sk, fields, conditions)``, e.g. a reference video's analysis, each condition an equality; ``other_remove``:
        its attributes to REMOVE, e.g. ``currentJobId``, cleared the same way as on a story), and deleted
        ``ASSET#`` items (``delete_assets``, old versions). Nothing is written unless the run still owns the job."""
        from botocore.exceptions import ClientError

        now = now_iso()
        name = self.table.name
        ops: list[dict[str, Any]] = []
        if job_fields is not None:
            je = job_condition(Expr().set({**job_fields, "updatedAt": now}), fence)
            ops.append({"Update": {"TableName": name, "Key": fence.job_key, **je.params()}})
        else:
            ce = job_condition(Expr(), fence)
            ops.append({"ConditionCheck": {"TableName": name, "Key": fence.job_key, **ce.params(update=False)}})
        if story_id is not None and (story_set or story_remove):
            se = Expr().set({**(story_set or {}), "updatedAt": now}).remove(story_remove).add("version", 1)
            se.exists().equals("currentJobId", fence.job_id)
            key = {"pk": fence.pk, "sk": keys.story_sk(story_id)}
            ops.append({"Update": {"TableName": name, "Key": key, **se.params()}})
        for a in assets:
            item = to_ddb(a.item(fence, now))
            ops.append({"Put": {"TableName": name, "Item": item, "ConditionExpression": "attribute_not_exists(pk)"}})
        for asset_id in retire:
            re_ = Expr().set({"meta.current": 0}).exists()
            key = {"pk": fence.pk, "sk": keys.asset_sk(asset_id)}
            ops.append({"Update": {"TableName": name, "Key": key, **re_.params()}})
        for item in puts:
            if item.get("pk") != fence.pk:
                raise ValueError("a story write outside the workspace partition")
            ops.append({"Put": {"TableName": name, "Item": to_ddb(item)}})
        if other_set is not None:
            sk, fields, conds = other_set
            oe = Expr().set({**fields, "updatedAt": now}).remove(other_remove).exists()
            for k, v in conds.items():
                oe.equals(k, v)
            ops.append({"Update": {"TableName": name, "Key": {"pk": fence.pk, "sk": sk}, **oe.params()}})
        for asset_id in delete_assets:
            key = {"pk": fence.pk, "sk": keys.asset_sk(asset_id)}
            ops.append({"Delete": {"TableName": name, "Key": key}})
        if len(ops) == 1 and job_fields is None:
            return
        client = self.table.meta.client
        try:
            await retry(
                lambda: asyncio.to_thread(client.transact_write_items, TransactItems=ops),
                what="ddb.ws_txn",
                transient=_txn_transient,
            )
        except ClientError as err:
            reasons = _reasons(err)
            if reasons and "ConditionalCheckFailed" in reasons[:2]:
                raise JobSuperseded() from err
            log("error", "ddb.ws_txn_failed", job=fence.job_id, reasons=reasons)
            raise

    # --- S3 (ws/ only) ------------------------------------------------------------------------------------------

    @staticmethod
    def _check_key(fence: JobFence, key: str) -> None:
        if not key.startswith(keys.ws_prefix(fence.user_id, fence.workspace_id)):
            raise ValueError("a story file outside the workspace's ws/ prefix")

    async def upload(self, fence: JobFence, path: Path, key: str, content_type: str) -> int:
        self._check_key(fence, key)
        await self.store.upload(path, key, content_type)
        return path.stat().st_size

    async def put_bytes(self, fence: JobFence, key: str, data: bytes, content_type: str) -> int:
        self._check_key(fence, key)
        await self.store.put_bytes(key, data, content_type)
        return len(data)

    async def get_json(self, fence: JobFence, key: str) -> Any:
        self._check_key(fence, key)
        return await self.store.get_json(key)

    async def download(self, fence: JobFence, key: str, path: Path) -> Path:
        self._check_key(fence, key)
        await self.store.download(key, path)
        return path

    async def delete_files(self, fence: JobFence, keys_: Sequence[str]) -> None:
        for key in keys_:
            self._check_key(fence, key)
        if keys_:
            await self.store.delete_keys(list(keys_))
