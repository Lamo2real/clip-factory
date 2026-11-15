"""The media bucket (docs/CONTRACTS.md §7): key layout, safe filenames and presigned URLs.

Presigned URLs use SigV4 on the regional virtual-hosted endpoint (``<bucket>.s3.<region>.amazonaws.com``): a
global-endpoint URL would redirect, and browsers drop a CORS PUT that redirects.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

PRESIGN_SECONDS = 3600
MAX_FILENAME = 120


def safe_filename(name: str, fallback: str = "file") -> str:
    """Keeps a readable name but only ASCII letters, digits, dot, dash and underscore; never a path."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode()
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-.")
    base = re.sub(r"-{2,}", "-", base)
    base = re.sub(r"-\.", ".", base)
    if not base:
        return fallback
    if len(base) > MAX_FILENAME:
        stem, dot, ext = base.rpartition(".")
        base = stem[: MAX_FILENAME - len(ext) - 1] + "." + ext if dot and 0 < len(ext) <= 10 else base[:MAX_FILENAME]
    return base


def upload_key(user_id: str, upload_id: str, filename: str) -> str:
    return f"uploads/{user_id}/{upload_id}/{safe_filename(filename, 'video')}"


def upload_prefix(user_id: str) -> str:
    return f"uploads/{user_id}/"


def clip_prefix(job_id: str, clip_id: str) -> str:
    return f"jobs/{job_id}/clips/{clip_id}/"


def skill_key(user_id: str, skill_id: str, fmt: str) -> str:
    return f"skills/{user_id}/{skill_id}/" + ("skill.zip" if fmt == "zip" else "SKILL.md")


def cookies_key(user_id: str) -> str:
    return f"private/{user_id}/youtube-cookies.txt"


def is_safe_key(key: str) -> bool:
    parts = key.split("/")
    return bool(key) and not key.startswith("/") and all(p not in {"", ".", ".."} for p in parts)


def make_client(region: str) -> Any:
    import boto3
    from botocore.config import Config

    config = Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"},
        retries={"mode": "standard", "max_attempts": 4},
        connect_timeout=3,
        read_timeout=20,
    )
    return boto3.client("s3", region_name=region, config=config)


class Media:
    """The operations the Lambdas need on one bucket. ``client`` is a boto3 S3 client (or a test fake)."""

    def __init__(self, client: Any, bucket: str) -> None:
        self._s3 = client
        self.bucket = bucket

    def presign_put(self, key: str, content_type: str, seconds: int = PRESIGN_SECONDS) -> str:
        url: str = self._s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=seconds,
        )
        return url

    def presign_get(self, key: str, seconds: int = PRESIGN_SECONDS) -> str:
        url: str = self._s3.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=seconds
        )
        return url

    def head(self, key: str) -> dict[str, Any] | None:
        """The object's metadata, or None when it does not exist."""
        try:
            out: dict[str, Any] = self._s3.head_object(Bucket=self.bucket, Key=key)
        except Exception as e:
            if _status(e) in {403, 404} or _code(e) in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise
        return out

    def read(self, key: str, max_bytes: int) -> bytes:
        out = self._s3.get_object(Bucket=self.bucket, Key=key)
        body = out["Body"]
        try:
            data: bytes = body.read(max_bytes + 1)
        finally:
            body.close()
        if len(data) > max_bytes:
            raise ValueError("object is larger than allowed")
        return data

    def delete(self, key: str) -> None:
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def delete_prefix(self, prefix: str) -> int:
        """Deletes every object under ``prefix``; returns how many."""
        if not prefix.endswith("/") or not is_safe_key(prefix.rstrip("/")):
            raise ValueError("refusing to delete an unsafe prefix")
        deleted = 0
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            out = self._s3.list_objects_v2(**kwargs)
            keys = [{"Key": o["Key"]} for o in out.get("Contents", [])]
            if keys:
                self._s3.delete_objects(Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True})
                deleted += len(keys)
            if not out.get("IsTruncated"):
                return deleted
            token = out.get("NextContinuationToken")


def _code(e: Exception) -> str | None:
    response = getattr(e, "response", None) or {}
    code: str | None = response.get("Error", {}).get("Code")
    return code


def _status(e: Exception) -> int | None:
    response = getattr(e, "response", None) or {}
    status: int | None = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return status
