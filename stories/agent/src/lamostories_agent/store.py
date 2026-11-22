"""The table and the media bucket, through boto3 (Lamo Stories' own thin client, §45.24).

The runtime's role can write only ``USER#*#WS#*`` and ``USER#*#WSREG`` and touch S3 only under ``ws/`` (§45.15);
the code keeps to the same rule on its own (``data.StoryData`` checks every key it builds). Clients are made on first
use, so building the app calls nothing. The async methods run boto3 in a worker thread and retry transient errors;
the ``*_sync`` ones are for the model client, which itself runs in a worker thread (§45.33)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Iterable
from decimal import Decimal
from pathlib import Path
from typing import Any

from .retry import retry, retry_sync


def from_ddb(value: Any) -> Any:
    """A DynamoDB value as plain Python (Decimals become ints or floats)."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: from_ddb(v) for k, v in value.items()}
    if isinstance(value, list | set):
        return [from_ddb(v) for v in value]
    return value


class Store:
    def __init__(self, table_name: str, bucket: str, region: str, session: Any = None) -> None:
        self.table_name = table_name
        self.bucket = bucket
        self.region = region
        self._session = session
        self._table: Any = None
        self._s3: Any = None

    def _boto(self) -> Any:
        if self._session is None:
            import boto3

            self._session = boto3.session.Session(region_name=self.region)
        return self._session

    @property
    def table(self) -> Any:
        if self._table is None:
            from botocore.config import Config

            cfg = Config(retries={"max_attempts": 4, "mode": "standard"})
            self._table = self._boto().resource("dynamodb", config=cfg).Table(self.table_name)
        return self._table

    @property
    def s3(self) -> Any:
        if self._s3 is None:
            from botocore.config import Config

            cfg = Config(retries={"max_attempts": 4, "mode": "standard"}, signature_version="s3v4")
            self._s3 = self._boto().client("s3", config=cfg)
        return self._s3

    async def _call(self, what: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return await retry(lambda: asyncio.to_thread(fn, *args, **kwargs), what=what)

    async def get_bytes(self, key: str) -> bytes:
        r = await self._call("s3.get", self.s3.get_object, Bucket=self.bucket, Key=key)
        data: bytes = await asyncio.to_thread(r["Body"].read)
        return data

    async def get_json(self, key: str) -> Any:
        return json.loads(await self.get_bytes(key))

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await self._call("s3.put", self.s3.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        await self._call(
            "s3.upload", self.s3.upload_file, str(path), self.bucket, key, ExtraArgs={"ContentType": content_type}
        )

    async def download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        await self._call("s3.download", self.s3.download_file, self.bucket, key, str(path))

    async def delete_keys(self, keys: Iterable[str]) -> None:
        batch = [{"Key": k} for k in keys]
        for i in range(0, len(batch), 1000):
            await self._call(
                "s3.delete", self.s3.delete_objects, Bucket=self.bucket, Delete={"Objects": batch[i : i + 1000]}
            )

    async def list_keys(self, prefix: str) -> list[dict[str, Any]]:
        """Every object under ``prefix``: ``{key, size, modified}`` (``modified`` an aware datetime)."""

        def walk() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                for o in page.get("Contents") or []:
                    out.append({"key": o["Key"], "size": int(o.get("Size") or 0), "modified": o.get("LastModified")})
            return out

        found: list[dict[str, Any]] = await retry(lambda: asyncio.to_thread(walk), what="s3.list")
        return found

    # --- for the model client (already in a worker thread) -----------------------------------------------------

    def get_bytes_sync(self, key: str) -> bytes:
        r = retry_sync(lambda: self.s3.get_object(Bucket=self.bucket, Key=key), what="s3.get")
        data: bytes = r["Body"].read()
        return data
