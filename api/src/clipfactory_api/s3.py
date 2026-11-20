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


SKILL_FILES = {"md": "SKILL.md", "zip": "skill.zip"}
_ULID = r"[0-7][0-9A-HJKMNP-TV-Z]{25}"


def skill_prefix(user_id: str, skill_id: str) -> str:
    """Every saved file of one skill lives under this prefix (§18.1)."""
    return f"skills/{user_id}/{skill_id}/"


def skill_key(user_id: str, skill_id: str, revision_id: str, fmt: str) -> str:
    """One saved revision: ``skills/{userId}/{skillId}/{revisionId}/SKILL.md|skill.zip``. A key never changes
    content, so readers may cache by key."""
    return f"{skill_prefix(user_id, skill_id)}{revision_id}/{SKILL_FILES['zip' if fmt == 'zip' else 'md']}"


def legacy_skill_key(user_id: str, skill_id: str, fmt: str) -> str:
    """The key used before §18 (no revision folder)."""
    return f"{skill_prefix(user_id, skill_id)}{SKILL_FILES['zip' if fmt == 'zip' else 'md']}"


def skill_key_format(key: str, user_id: str, skill_id: str, *, legacy: bool = False) -> str | None:
    """``"md"``/``"zip"`` when ``key`` is a revision key of this caller's skill (or, with ``legacy``, the old
    key), else None."""
    prefix = re.escape(skill_prefix(user_id, skill_id))
    revision = f"(?:{_ULID}/)" + ("?" if legacy else "")
    m = re.fullmatch(f"{prefix}{revision}(SKILL\\.md|skill\\.zip)", key)
    if m is None:
        return None
    return "zip" if m.group(1) == "skill.zip" else "md"


def is_revision_key(key: str) -> bool:
    return re.fullmatch(f"skills/[^/]+/[^/]+/{_ULID}/(SKILL\\.md|skill\\.zip)", key) is not None


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

    def presign_put_sized(self, key: str, content_type: str, size: int, seconds: int = PRESIGN_SECONDS) -> str:
        """A PUT URL that signs the type and the exact length too (Ask files, §28.7)."""
        url: str = self._s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type, "ContentLength": size},
            ExpiresIn=seconds,
        )
        return url

    def presign_get(self, key: str, seconds: int = PRESIGN_SECONDS) -> str:
        url: str = self._s3.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=seconds
        )
        return url

    # --- multipart: the Mac's video (docs/CONTRACTS.md §35.3) -------------------------------------------------------

    def create_multipart(self, key: str, content_type: str) -> str:
        out = self._s3.create_multipart_upload(Bucket=self.bucket, Key=key, ContentType=content_type)
        return str(out["UploadId"])

    def presign_part(self, key: str, upload_id: str, part: int, seconds: int) -> str:
        url: str = self._s3.generate_presigned_url(
            "upload_part",
            Params={"Bucket": self.bucket, "Key": key, "UploadId": upload_id, "PartNumber": part},
            ExpiresIn=seconds,
        )
        return url

    def complete_multipart(self, key: str, upload_id: str, parts: list[dict[str, Any]]) -> None:
        self._s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": [{"PartNumber": p["n"], "ETag": p["etag"]} for p in parts]},
        )

    def abort_multipart(self, key: str, upload_id: str) -> None:
        """Best effort: an upload already completed or aborted is fine (the bucket's lifecycle rule is the backstop)."""
        try:
            self._s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
        except Exception as e:
            if _code(e) not in {"NoSuchUpload", "404"} and _status(e) != 404:
                raise

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

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

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

    def delete_prefix_except(self, prefix: str, keep: tuple[str, ...] = ()) -> int:
        """Deletes every object under ``prefix`` except those that start with one of ``keep`` (a deleted job's
        files without the files of the clips it keeps, §34.4); returns how many."""
        if not prefix.endswith("/") or not is_safe_key(prefix.rstrip("/")):
            raise ValueError("refusing to delete an unsafe prefix")
        deleted = 0
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            out = self._s3.list_objects_v2(**kwargs)
            keys = [{"Key": o["Key"]} for o in out.get("Contents", []) if not str(o["Key"]).startswith(keep)]
            if keys:  # a listing page holds at most 1000 keys, as many as DeleteObjects takes
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
