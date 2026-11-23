"""Download links for finished Lamo Stories videos (docs/CONTRACTS.md §45.4).

``s3.Media`` has no presign with ``ResponseContentDisposition`` and stays unchanged, so this helper signs one with
an S3 client made exactly like ``s3.make_client`` (tests pass a fake through ``WsDeps.s3``).
"""

from __future__ import annotations

import os
import re
import unicodedata
from typing import Any

from .. import s3

DOWNLOAD_SECONDS = 3600


def slug(title: str, fallback: str = "funded-clip") -> str:
    """A safe file name stem: ASCII letters, digits and dashes, at most 60 characters."""
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:60].strip("-") or fallback


def client(holder: Any) -> Any:
    """``holder.s3`` (installed in tests), else a client made once like ``s3.make_client`` and kept on ``holder``."""
    found = getattr(holder, "s3", None)
    if found is None:
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-north-1"
        found = s3.make_client(region)
        holder.s3 = found
    return found


def presign_download(s3_client: Any, bucket: str, key: str, filename: str, seconds: int = DOWNLOAD_SECONDS) -> str:
    url: str = s3_client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": bucket,
            "Key": key,
            "ResponseContentDisposition": f'attachment; filename="{filename}"',
        },
        ExpiresIn=seconds,
    )
    return url
