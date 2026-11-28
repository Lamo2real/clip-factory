"""The owner's reference videos, "Edit like these" (docs/CONTRACTS.md §57): videos kept to show how clips are edited.

A reference video is the item ``REFVID#{refId}`` under the owner and one file in the media bucket at
``refs/{userId}/{refId}.{mp4|mov|webm|m4v}`` (no expiry, unlike ``uploads/``), plus the thumbnail the agent writes at
``refs/{userId}/{refId}-thumb.jpg``. Only MP4, MOV, WebM and M4V, 1 byte to 500 MB, at most 10 videos. Uploads not
finished within an hour are stale and cleared away (like logos). Stored shapes change by adding fields only.

``status`` goes ``uploading`` → ``analyzing`` → ``ready`` or ``failed``. Every start of an analysis (the first
complete, or "Try again") adds one to ``analyzeRev``; the agent's finishing write is conditional on it, so an old run
can never overwrite a newer one.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from . import db, s3
from .clock import iso, parse

Item = dict[str, Any]

PREFIX = "REFVID#"
MAX_BYTES = 500 * 1024 * 1024  # 500 MB
MAX_REFS = 10
UPLOAD_FRESH = timedelta(hours=1)  # an upload not finished after this long is abandoned (the presigned URL is dead)
STUCK_AFTER = timedelta(minutes=20)  # an analysis still running after this long may be started again
PRESIGN_PUT_SECONDS = 3600  # a 500 MB upload on a slow line needs longer than a logo's 15 minutes
NAME_MAX = 60

WRONG_FILE = "That file is not a video we can use. Use MP4, MOV or WebM up to 500 MB."
FULL = "You have 10 reference videos. Delete one first."
NOT_FOUND = "We could not find that video."
COULD_NOT_START = "We could not look at this video. Try again."
STILL_LOOKING = "We are still looking at this video."

TYPES = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v"}

_REF_ID = re.compile(r"^[0-9A-Za-z]{1,40}$")


def sk(ref_id: str) -> str:
    return f"{PREFIX}{ref_id}"


def is_ref_id(value: object) -> bool:
    return isinstance(value, str) and _REF_ID.match(value) is not None


def object_key(user_id: str, ref_id: str, ext: str) -> str:
    return f"refs/{user_id}/{ref_id}.{ext}"


def thumb_key(user_id: str, ref_id: str) -> str:
    return f"refs/{user_id}/{ref_id}-thumb.jpg"


def own_key(item: Mapping[str, Any], key: object) -> bool:
    """True for a key straight under the owner's own ``refs/{userId}/`` folder (never another owner's, never deeper)."""
    return isinstance(key, str) and key.startswith(f"refs/{item.get('userId')}/") and key.count("/") == 2


def display_name(filename: str) -> str:
    """A short readable name from the file's name: no folder, no extension."""
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base else base
    return s3.safe_filename(stem, "video")[:NAME_MAX]


def all_items(store: db.Store, user_id: str) -> list[Item]:
    return [i for i in store.query_all(db.user_pk(user_id), PREFIX, consistent=True) if i.get("type") == "refvideo"]


def get_item(store: db.Store, user_id: str, ref_id: str) -> Item | None:
    if not is_ref_id(ref_id):
        return None
    found = store.get(db.user_pk(user_id), sk(ref_id))
    return found if found is not None and found.get("type") == "refvideo" else None


def stale(item: Mapping[str, Any], now: datetime) -> bool:
    """An ``uploading`` item whose upload was never finished."""
    if item.get("status") != "uploading":
        return False
    made = parse(item.get("createdAt"))
    return made is None or now - made > UPLOAD_FRESH


def can_start(item: Mapping[str, Any], now: datetime) -> bool:
    """True when complete may (re)start the analysis: just uploaded, failed, or analyzing for over 20 minutes."""
    status = item.get("status")
    if status in {"uploading", "failed"}:
        return True
    if status == "analyzing":
        started = parse(item.get("analyzeStartedAt"))
        return started is None or now - started > STUCK_AFTER
    return False


def _number(value: object) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        return None
    number = float(value)
    return int(number) if number.is_integer() else round(number, 2)


def _lines(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [str(v) for v in value if isinstance(v, str) and v.strip()]


def public(item: Mapping[str, Any], media: s3.Media) -> Item:
    """``{refId, name, status, createdAt, videoUrl?, thumbUrl?, summary?, unsupported?, error?, duration?}``.
    Links are presigned GETs of one hour."""
    out: Item = {
        "refId": str(item["refId"]),
        "name": str(item.get("name") or "video"),
        "status": str(item.get("status") or "uploading"),
        "createdAt": str(item.get("createdAt") or ""),
    }
    if out["status"] != "uploading" and own_key(item, item.get("key")):
        out["videoUrl"] = media.presign_get(str(item["key"]))
    if own_key(item, item.get("thumbKey")):
        out["thumbUrl"] = media.presign_get(str(item["thumbKey"]))
    for field in ("summary", "unsupported"):
        lines = _lines(item.get(field))
        if lines is not None:
            out[field] = lines
    if out["status"] == "failed" and item.get("error"):
        out["error"] = str(item["error"])
    duration = _number(item.get("duration"))
    if duration is not None:
        out["duration"] = duration
    return out


def new_item(user_id: str, ref_id: str, key: str, *, name: str, content_type: str, size: int, now: datetime) -> Item:
    return {
        "pk": db.user_pk(user_id),
        "sk": sk(ref_id),
        "type": "refvideo",
        "userId": user_id,
        "refId": ref_id,
        "name": name,
        "key": key,
        "contentType": content_type,
        "size": size,
        "status": "uploading",
        "analyzeRev": 0,
        "createdAt": iso(now),
    }
