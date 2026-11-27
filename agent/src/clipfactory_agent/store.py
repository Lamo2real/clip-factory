"""DynamoDB (single table, docs/CONTRACTS.md §6) and S3 (media bucket, §7) access for the agent."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from .retry import is_transient, retry
from .util import JobSuperseded, log, now_iso

SETTINGS_DEFAULTS: dict[str, Any] = {
    "clipMin": 5,
    "clipMax": 10,
    "maxSourceHours": 6,
    "soundEnabled": True,
    "reduceMotion": False,
    "platforms": ["youtube", "instagram", "facebook", "tiktok", "x"],
    # "Your take" (owner request 2026-11-27): one short comment of the channel's own in every clip, read out loud by
    # a voice, in the owner's style (a few words on how they talk).
    "takeOn": True,
    "takeVoice": True,
    "takeStyle": "",
}


def user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


def source_prefix(job_id: str) -> str:
    return f"jobs/{job_id}/source/"


# The media bucket's "job-sources-14-days" lifecycle rule only expires jobs/ objects carrying this tag, because a
# lifecycle filter cannot match jobs/*/source/ (infra/modules/storage: temporary_tag_key / temporary_tag_value).
TEMPORARY_TAG_KEY = "cf-retention"
TEMPORARY_TAG_VALUE = "temporary"
TEMPORARY_TAGGING = f"{TEMPORARY_TAG_KEY}={TEMPORARY_TAG_VALUE}"


def is_temporary(key: str) -> bool:
    """True for jobs/{jobId}/source/* — the copied upload, audio, transcripts and analysis that expire in 14 days."""
    parts = key.split("/", 3)
    return len(parts) == 4 and parts[0] == "jobs" and bool(parts[1]) and parts[2] == "source"


def clip_prefix(job_id: str, clip_id: str) -> str:
    return f"jobs/{job_id}/clips/{clip_id}/"


def cookies_key(user_id: str) -> str:
    return f"private/{user_id}/youtube-cookies.txt"


def kept_video_keys(user_id: str, job_id: str) -> tuple[str, str]:
    """Where a job's whole video may still be kept (docs/CONTRACTS.md §39.3, a campaign copy's ``sourceKey``): the
    job's own copy of an upload, then the file the owner's Mac sent (§35.1). Nothing else is ever read as one."""
    return source_prefix(job_id) + "video.mp4", f"uploads/{user_id}/mac-{job_id}/video.mp4"


# Fields §39.3 adds (additive only): the campaign copy a clip is (``remakeOf {clipId, jobId}``, public, on the Clip
# item) and, on every job, the language Transcribe heard (BCP 47, public) and every name and handle of the video's
# channel inside ``source`` (``source.channelKeys``, public). The API's fit check reads them from the items.
REMAKE_OF = "remakeOf"
SOURCE_LANGUAGE = "sourceLanguage"
CHANNEL_KEYS = "channelKeys"


def job_key(user_id: str, job_id: str) -> dict[str, str]:
    return {"pk": user_pk(user_id), "sk": f"JOB#{job_id}"}


@dataclass(frozen=True)
class Fence:
    """The run a write belongs to: it only goes through while the Job item still carries this ``sessionId``."""

    user_id: str
    job_id: str
    session_id: str


def _txn_reasons(e: BaseException) -> list[str]:
    response = getattr(e, "response", None)
    if not isinstance(response, dict) or (response.get("Error") or {}).get("Code") != "TransactionCanceledException":
        return []
    return [str((r or {}).get("Code") or "None") for r in response.get("CancellationReasons") or []]


def txn_detail(e: BaseException) -> str:
    """Each canceled transaction item's code and DynamoDB's own message, for the log ("0 ValidationError: ...")."""
    response = getattr(e, "response", None)
    rows = response.get("CancellationReasons") if isinstance(response, dict) else None
    return "; ".join(
        f"{i} {(r or {}).get('Code') or 'None'}" + (f": {r['Message']}" if (r or {}).get("Message") else "")
        for i, r in enumerate(rows or [])
    )[:600]


def _txn_transient(e: BaseException) -> bool:
    """A transaction canceled only because another write touched the same items at that moment is worth retrying."""
    return is_transient(e) or "TransactionConflict" in _txn_reasons(e)


def to_ddb(value: Any) -> Any:
    """Floats become Decimals (DynamoDB has no float); NaN and infinity are dropped to None."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return Decimal(str(round(value, 6))) if math.isfinite(value) else None
    if isinstance(value, dict):
        converted = {k: to_ddb(v) for k, v in value.items()}
        return {k: v for k, v in converted.items() if v is not None}
    if isinstance(value, list | tuple):
        return [to_ddb(v) for v in value]
    return value


def from_ddb(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: from_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [from_ddb(v) for v in value]
    if isinstance(value, set):
        return [from_ddb(v) for v in value]
    return value


def _plain(value: Any) -> str:
    """A string attribute as the resource's client returns it: plain, or still typed (``{"S": ...}``)."""
    if isinstance(value, dict):
        value = value.get("S")
    return str(value or "")


class Store:
    """Thin async wrapper over boto3; every call runs in a worker thread and retries transient errors."""

    def __init__(self, table_name: str, bucket: str, region: str, session: Any = None) -> None:
        import boto3
        from botocore.config import Config

        s = session or boto3.session.Session(region_name=region)
        cfg = Config(retries={"max_attempts": 5, "mode": "adaptive"}, connect_timeout=10, read_timeout=60)
        self.table = s.resource("dynamodb", config=cfg).Table(table_name)
        self.s3 = s.client("s3", config=cfg)
        self.transcribe = s.client("transcribe", config=cfg)
        self.bucket = bucket
        self.region = region

    async def _call(self, what: str, fn: Any, *args: Any, **kwargs: Any) -> Any:
        return await retry(lambda: asyncio.to_thread(fn, *args, **kwargs), what=what)

    # --- DynamoDB --------------------------------------------------------------------------------------------

    async def get_job(self, user_id: str, job_id: str) -> dict[str, Any] | None:
        r = await self._call("ddb.get_job", self.table.get_item, Key=job_key(user_id, job_id))
        item = r.get("Item")
        return from_ddb(item) if item else None

    async def update_job(
        self,
        user_id: str,
        job_id: str,
        fields: dict[str, Any],
        *,
        unless_canceled: bool,
        session_id: str | None = None,
        remove: tuple[str, ...] = (),
    ) -> bool:
        """Sets ``fields`` (plus ``updatedAt``). With ``unless_canceled``, returns False instead of writing when the
        owner canceled the job meanwhile, so a running step can never flip a canceled job back.

        With ``session_id`` the write only goes through while the job still belongs to that run; when a retry has
        given the job a new ``sessionId`` meanwhile, nothing is written and JobSuperseded is raised."""
        from botocore.exceptions import ClientError

        fields = {**fields, "updatedAt": now_iso()}
        names = {f"#f{i}": k for i, k in enumerate(fields)}
        values = {f":v{i}": to_ddb(v) for i, v in enumerate(fields.values())}
        expr = "SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(fields)))
        if remove:
            names.update({f"#r{i}": k for i, k in enumerate(remove)})
            expr += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove)))
        conditions = ["attribute_exists(pk)"]
        if unless_canceled:
            names["#st"] = "status"
            values[":canceled"] = "canceled"
            conditions.append("#st <> :canceled")
        if session_id is not None:
            names["#sid"] = "sessionId"
            values[":sid"] = session_id
            conditions.append("#sid = :sid")
        kwargs: dict[str, Any] = {
            "Key": job_key(user_id, job_id),
            "UpdateExpression": expr,
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
            "ConditionExpression": " AND ".join(conditions),
        }
        try:
            await self._call("ddb.update_job", self.table.update_item, **kwargs)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            if session_id is not None:
                await self._raise_if_superseded(user_id, job_id, session_id)
            return False
        return True

    async def put_live(self, user_id: str, item: dict[str, Any]) -> None:
        """The job's live status line (docs/CONTRACTS.md §31): one small ``JOBLIVE#<jobId>`` item, replaced whole on
        every write (no retries: the next write a second later says it again). Not fenced: a stale run's line carries
        its own ``sessionId`` and the web ignores it."""
        row = {"pk": user_pk(user_id), "sk": f"JOBLIVE#{item['jobId']}", "type": "jobLive", **item}
        await asyncio.to_thread(self.table.put_item, Item=to_ddb(row))

    async def _raise_if_superseded(self, user_id: str, job_id: str, session_id: str) -> None:
        """After a refused write: tells "a newer run owns the job" (or the job is gone) from "the owner canceled"."""
        r = await self._call("ddb.get_job", self.table.get_item, Key=job_key(user_id, job_id), ConsistentRead=True)
        item = r.get("Item")
        if not item or item.get("sessionId") != session_id:
            raise JobSuperseded()

    async def _fenced_write(self, what: str, fence: Fence, op: dict[str, Any]) -> None:
        """One write (a transaction Put or Delete) that only goes through while the job still carries the fence's
        ``sessionId``; raises JobSuperseded otherwise and writes nothing.

        Every value here is a plain Python value, never DynamoDB's typed form (``{"S": ...}``): the table resource's
        client serializes them itself. Typed values were serialized a second time into maps, so the Job key became a
        map, DynamoDB refused the check as invalid ("[ValidationError, None]") and no clip was ever written
        (owner report 2026-11-20, job 01M7T90YCMC2767AR0WJ9XWMKY)."""
        from botocore.exceptions import ClientError

        check = {
            "ConditionCheck": {
                "TableName": self.table.name,
                "Key": job_key(fence.user_id, fence.job_id),
                "ConditionExpression": "#sid = :sid",
                "ExpressionAttributeNames": {"#sid": "sessionId"},
                "ExpressionAttributeValues": {":sid": fence.session_id},
            }
        }
        client = self.table.meta.client
        try:
            await retry(
                lambda: asyncio.to_thread(client.transact_write_items, TransactItems=[check, op]),
                what=what,
                transient=_txn_transient,
            )
        except ClientError as e:
            reasons = _txn_reasons(e)
            if reasons and reasons[0] == "ConditionalCheckFailed":
                raise JobSuperseded() from e
            log("error", "ddb.txn_failed", what=what, job=fence.job_id, reasons=reasons, detail=txn_detail(e))
            raise

    async def get_settings(self, user_id: str) -> dict[str, Any]:
        r = await self._call("ddb.get_settings", self.table.get_item, Key={"pk": user_pk(user_id), "sk": "SETTINGS"})
        item = from_ddb(r.get("Item") or {})
        return {**SETTINGS_DEFAULTS, **{k: v for k, v in item.items() if k in SETTINGS_DEFAULTS}}

    async def _query_prefix(
        self, user_id: str, prefix: str, *, newest_first: bool = False, limit: int | None = None
    ) -> list[dict[str, Any]]:
        from boto3.dynamodb.conditions import Key

        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(user_pk(user_id)) & Key("sk").begins_with(prefix),
            "ScanIndexForward": not newest_first,
        }
        while True:
            if limit:
                kwargs["Limit"] = limit - len(items)
            r = await self._call("ddb.query", self.table.query, **kwargs)
            items += [from_ddb(i) for i in r.get("Items", [])]
            if not r.get("LastEvaluatedKey") or (limit and len(items) >= limit):
                return items
            kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]

    async def skill_rows(self, user_id: str) -> list[dict[str, Any]]:
        return await self._query_prefix(user_id, "SKILL#")

    async def latest_learnings(self, user_id: str, n: int = 10) -> list[dict[str, Any]]:
        return await self._query_prefix(user_id, "LEARNING#", newest_first=True, limit=n)

    async def creator_lessons(self, user_id: str) -> list[dict[str, Any]]:
        """Every creator lesson (``LESSON#``, docs/CONTRACTS.md §16.12); the caller keeps only the active ones."""
        return await self._query_prefix(user_id, "LESSON#")

    async def job_clips(self, job_id: str) -> list[dict[str, Any]]:
        from boto3.dynamodb.conditions import Key

        r = await self._call(
            "ddb.job_clips",
            self.table.query,
            IndexName="gsi1",
            KeyConditionExpression=Key("gsi1pk").eq(f"JOB#{job_id}") & Key("gsi1sk").begins_with("CLIP#"),
        )
        return [from_ddb(i) for i in r.get("Items", [])]

    async def clip_statuses(self, user_id: str, clip_ids: Iterable[str]) -> dict[str, str]:
        """``{clipId: status}`` for the owner's Clip items that exist (BatchGetItem; missing clips are absent)."""
        ids = list(dict.fromkeys(i for i in clip_ids if i))
        out: dict[str, str] = {}
        client = self.table.meta.client
        for start in range(0, len(ids), 100):
            request: dict[str, Any] = {
                self.table.name: {
                    "Keys": [{"pk": user_pk(user_id), "sk": f"CLIP#{i}"} for i in ids[start : start + 100]],
                    "ProjectionExpression": "clipId, #s",
                    "ExpressionAttributeNames": {"#s": "status"},
                }
            }
            for _ in range(5):
                r = await self._call("ddb.clip_statuses", client.batch_get_item, RequestItems=request)
                for row in (r.get("Responses") or {}).get(self.table.name, []):
                    out[_plain(row.get("clipId"))] = _plain(row.get("status"))
                request = r.get("UnprocessedKeys") or {}
                if not request:
                    break
                await asyncio.sleep(0.2)
            else:
                raise RuntimeError("DynamoDB left clip keys unprocessed.")
        return out

    async def get_item(self, pk: str, sk: str) -> dict[str, Any] | None:
        r = await self._call("ddb.get_item", self.table.get_item, Key={"pk": pk, "sk": sk}, ConsistentRead=True)
        item = r.get("Item")
        return from_ddb(item) if item else None

    async def get_clip(self, user_id: str, clip_id: str) -> dict[str, Any] | None:
        return await self.get_item(user_pk(user_id), f"CLIP#{clip_id}")

    async def finish_overlay(self, user_id: str, clip_id: str, rev: int, edit_key: str, orig_key: str) -> bool:
        """The one write that ends a Review overlay edit (§53 C5): only while the clip is still in review and its
        ``overlay.rev`` is still ``rev``, it sets ``origVideoKey`` (only when not set yet), ``editKey``, ``videoKey`` (the
        edited file) and ``overlay.status`` ``ready``. False (nothing written) when the condition fails."""
        from botocore.exceptions import ClientError

        kwargs: dict[str, Any] = {
            "Key": {"pk": user_pk(user_id), "sk": f"CLIP#{clip_id}"},
            "UpdateExpression": (
                "SET #ov.#os = :ready, #ek = :edit, #vk = :edit, #ok = if_not_exists(#ok, :orig), #ua = :now "
                "REMOVE #ov.#err"
            ),
            "ConditionExpression": "attribute_exists(pk) AND #st = :review AND #ov.#rev = :rev",
            "ExpressionAttributeNames": {
                "#ov": "overlay",
                "#os": "status",
                "#err": "error",
                "#rev": "rev",
                "#st": "status",
                "#ek": "editKey",
                "#vk": "videoKey",
                "#ok": "origVideoKey",
                "#ua": "updatedAt",
            },
            "ExpressionAttributeValues": {
                ":ready": "ready",
                ":edit": edit_key,
                ":orig": orig_key,
                ":review": "review",
                ":rev": rev,
                ":now": now_iso(),
            },
        }
        try:
            await self._call("ddb.finish_overlay", self.table.update_item, **kwargs)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            return False
        return True

    async def fail_overlay(self, user_id: str, clip_id: str, rev: int, message: str) -> bool:
        """Marks the edit ``rev`` failed with one plain sentence; only while ``overlay.rev`` is still ``rev``."""
        from botocore.exceptions import ClientError

        kwargs: dict[str, Any] = {
            "Key": {"pk": user_pk(user_id), "sk": f"CLIP#{clip_id}"},
            "UpdateExpression": "SET #ov.#os = :failed, #ov.#err = :msg, #ua = :now",
            "ConditionExpression": "attribute_exists(pk) AND #ov.#rev = :rev AND #ov.#os <> :ready",
            "ExpressionAttributeNames": {
                "#ov": "overlay",
                "#os": "status",
                "#err": "error",
                "#rev": "rev",
                "#ua": "updatedAt",
            },
            "ExpressionAttributeValues": {
                ":failed": "failed",
                ":ready": "ready",
                ":msg": message,
                ":rev": rev,
                ":now": now_iso(),
            },
        }
        try:
            await self._call("ddb.fail_overlay", self.table.update_item, **kwargs)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            return False
        return True

    async def put_clip(self, item: dict[str, Any], *, fence: Fence | None = None) -> None:
        if fence is None:
            await self._call("ddb.put_clip", self.table.put_item, Item=to_ddb(item))
            return
        put = {"TableName": self.table.name, "Item": to_ddb(item)}
        await self._fenced_write("ddb.put_clip", fence, {"Put": put})

    async def delete_item(self, pk: str, sk: str, *, fence: Fence | None = None) -> None:
        if fence is None:
            await self._call("ddb.delete", self.table.delete_item, Key={"pk": pk, "sk": sk})
            return
        delete = {"TableName": self.table.name, "Key": {"pk": pk, "sk": sk}}
        await self._fenced_write("ddb.delete", fence, {"Delete": delete})

    # --- S3 --------------------------------------------------------------------------------------------------

    async def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            await self._call("s3.head", self.s3.head_object, Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            if str(e.response.get("Error", {}).get("Code")) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    async def head(self, key: str) -> dict[str, Any]:
        r: dict[str, Any] = await self._call("s3.head", self.s3.head_object, Bucket=self.bucket, Key=key)
        return r

    async def get_bytes(self, key: str) -> bytes:
        r = await self._call("s3.get", self.s3.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(r["Body"].read)

    async def get_json(self, key: str) -> Any:
        return json.loads(await self.get_bytes(key))

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        extra: dict[str, str] = {"Tagging": TEMPORARY_TAGGING} if is_temporary(key) else {}
        await self._call(
            "s3.put", self.s3.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, **extra
        )

    async def put_json(self, key: str, value: Any) -> None:
        await self.put_bytes(key, json.dumps(value, separators=(",", ":")).encode(), "application/json")

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        extra = {"ContentType": content_type}
        if is_temporary(key):
            extra["Tagging"] = TEMPORARY_TAGGING
        await self._call("s3.upload", self.s3.upload_file, str(path), self.bucket, key, ExtraArgs=extra)

    async def download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        await self._call("s3.download", self.s3.download_file, self.bucket, key, str(path))

    async def copy(self, src_key: str, dest_key: str) -> None:
        """Managed copy: multipart for files over 5 GB, which a plain CopyObject refuses.

        A copy into jobs/{jobId}/source/ replaces the source's tags with the 14-day retention tag (for a multipart copy
        s3transfer applies it with PutObjectTagging once the copy completes).
        """
        extra = {"TaggingDirective": "REPLACE", "Tagging": TEMPORARY_TAGGING} if is_temporary(dest_key) else None
        await self._call(
            "s3.copy", self.s3.copy, {"Bucket": self.bucket, "Key": src_key}, self.bucket, dest_key, ExtraArgs=extra
        )

    async def tag_temporary(self, key: str) -> None:
        """Tag an object another service wrote (Amazon Transcribe output) so the 14-day lifecycle rule expires it."""
        tag_set = [{"Key": TEMPORARY_TAG_KEY, "Value": TEMPORARY_TAG_VALUE}]
        await self._call("s3.tag", self.s3.put_object_tagging, Bucket=self.bucket, Key=key, Tagging={"TagSet": tag_set})

    async def delete_keys(self, keys: Iterable[str]) -> None:
        batch = [{"Key": k} for k in keys]
        for i in range(0, len(batch), 1000):
            await self._call(
                "s3.delete", self.s3.delete_objects, Bucket=self.bucket, Delete={"Objects": batch[i : i + 1000]}
            )

    def presign(self, key: str, seconds: int = 3600) -> str:
        """Presign at each use: URLs signed with role credentials stop working when those credentials rotate."""
        url: str = self.s3.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=seconds
        )
        return url

    def s3_uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{key}"
