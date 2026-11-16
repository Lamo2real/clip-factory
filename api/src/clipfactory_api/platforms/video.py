"""The kept clip's MP4 as a ``VideoSource`` (docs/CONTRACTS.md §17.6): ranged S3 GETs, so the publishers send it in
chunks without holding two copies in memory."""

from __future__ import annotations

from typing import Any


class S3Video:
    def __init__(self, client: Any, bucket: str, key: str) -> None:
        self._s3 = client
        self.bucket = bucket
        self.key = key
        self._size: int | None = None

    @property
    def size(self) -> int:
        if self._size is None:
            out = self._s3.head_object(Bucket=self.bucket, Key=self.key)
            self._size = int(out["ContentLength"])
        return self._size

    def read(self, start: int, end: int) -> bytes:
        """Bytes ``[start, end)``."""
        if end <= start:
            return b""
        out = self._s3.get_object(Bucket=self.bucket, Key=self.key, Range=f"bytes={start}-{end - 1}")
        body = out["Body"]
        try:
            data: bytes = body.read()
        finally:
            body.close()
        return data

    def presigned_url(self, seconds: int = 3600) -> str:
        url: str = self._s3.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": self.key}, ExpiresIn=seconds
        )
        return url
