"""Files and images added to a job's notes (docs/CONTRACTS.md §52, ADR-104).

They upload like a video (``POST /v1/uploads`` with ``purpose: "attachment"``) under ``uploads/{userId}/``, so the
14-day ``uploads/`` lifecycle removes them; a job keeps ``{key, name, type, size}`` rows only. Nothing here deletes
them."""

from __future__ import annotations

from typing import Any

from . import s3, validate
from .errors import ApiError, bad_request

PURPOSE = "attachment"
MAX_FILES = 6
MAX_BYTES = 20 * 1024 * 1024
MAX_NAME = 255
FIELDS = frozenset({"key", "name", "type", "size"})

# What may be added. Videos are not attachments: they go in "Pick a video".
ALLOWED_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/rtf",
        "text/rtf",
        "application/vnd.oasis.opendocument.text",
    }
)

KIND_REFUSED = "That kind of file can't be added."
TOO_BIG = "That file is bigger than 20 MB."
# The web app's own words for the same refusals (web/src/lib/attachments.ts REFUSE, web/src/api/mock/index.ts).
TOO_MANY = "Up to 6 files per job."
NOT_YOURS = "That file does not belong to you."
TWICE = "That file was added twice."


def too_big() -> ApiError:
    return ApiError(413, "too_large", TOO_BIG)


def check_upload(content_type: str, size: Any) -> int:
    """The size of an attachment upload that may go ahead; raises the owner's sentence otherwise."""
    if content_type not in ALLOWED_TYPES:
        raise bad_request(KIND_REFUSED)
    number = validate.whole_number(size)
    if number is not None and number > MAX_BYTES:
        raise too_big()
    return validate.integer(size, "size", lo=1, hi=MAX_BYTES)


def parse(media: Any, user_id: str, value: Any) -> list[dict[str, Any]]:
    """``POST /v1/jobs``' ``attachments``: each one the caller's own upload, there, allowed and small enough."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise bad_request("attachments must be a list.")
    if len(value) > MAX_FILES:
        raise bad_request(TOO_MANY)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in value:
        item = validate.obj(raw, "Each attachment")
        validate.only_keys(item, FIELDS)
        key = validate.required_string(item, "key", max_len=1024)
        if not key.startswith(s3.upload_prefix(user_id)) or not s3.is_safe_key(key):
            raise bad_request(NOT_YOURS)
        if key in seen:
            raise bad_request(TWICE)
        seen.add(key)
        name = validate.required_string(item, "name", max_len=MAX_NAME)
        kind = validate.required_string(item, "type", max_len=120).lower()
        if kind not in ALLOWED_TYPES:
            raise bad_request(KIND_REFUSED)
        size = validate.whole_number(item.get("size"))
        if size is not None and size > MAX_BYTES:
            raise too_big()
        validate.integer(item.get("size"), "size", lo=1, hi=MAX_BYTES)
        head = media.head(key)
        if head is None:
            raise bad_request(f"We could not find {name}. Add it again.")
        stored = validate.whole_number(head.get("ContentLength"))
        if stored is not None and stored > MAX_BYTES:
            raise too_big()
        out.append({"key": key, "name": name, "type": kind, "size": stored if stored is not None else size})
    return out
