"""The owner's logo library (docs/CONTRACTS.md §53 C4): pictures kept for reuse in Review's "Edit for campaign".

A logo is the item ``LOGO#{logoId}`` under the owner and one file in the media bucket at
``logos/{userId}/{logoId}.{png|jpg|webp}`` (no expiry, unlike ``uploads/``). Only PNG, JPEG and WebP, told apart by their
first bytes (never the name or the type the browser said), at most 10 MB, at most 60 logos. Deleting a logo never
changes a clip that was edited with it: the render copied the picture.
"""

from __future__ import annotations

import re
import struct
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db, s3
from .clock import iso, parse
from .contentrewards import config as cr_config
from .contentrewards.logo import CONTENT_TYPES, kind_of

Item = dict[str, Any]

MAX_BYTES = cr_config.LOGO_MAX_BYTES  # 10 MB, the same limit as a campaign's logo (§38.4)
MAX_LOGOS = 60
MAX_SIDE = 10_000  # pixels: a logo is never a photo wall; keeps ffmpeg's memory small
UPLOAD_FRESH = timedelta(hours=1)  # an upload not finished after this long is abandoned (the presigned URL is dead)
PRESIGN_PUT_SECONDS = 900
NAME_MAX = 60

WRONG_FILE = "Use a PNG, JPG or WebP picture under 10 MB."
FULL = "You have 60 logos. Delete one to add another."
NO_CAMPAIGN_LOGO = "That campaign has no logo yet."
TYPES = {content_type: ext for ext, content_type in CONTENT_TYPES.items()}  # image/png → png

_LOGO_ID = re.compile(r"^[0-9A-Za-z]{1,40}$")


def is_logo_id(value: object) -> bool:
    return isinstance(value, str) and _LOGO_ID.match(value) is not None


def object_key(user_id: str, logo_id: str, ext: str) -> str:
    return f"logos/{user_id}/{logo_id}.{ext}"


def campaign_logo_id(campaign_uuid: str) -> str:
    """The id of a campaign's copy (C6): the same campaign always gives the same one, so asking twice gives one logo."""
    return "cr" + campaign_uuid.lower().replace("-", "")


def display_name(filename: str) -> str:
    """A short readable name from the file's name: no folder, no extension."""
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base else base
    return s3.safe_filename(stem, "logo")[:NAME_MAX]


def image_size(data: bytes, kind: str) -> tuple[int, int] | None:
    """``(width, height)`` in pixels read from the picture's own header; None when it can't be read or is empty."""
    try:
        found = {"png": _png_size, "jpg": _jpeg_size, "webp": _webp_size}[kind](data)
    except (struct.error, IndexError, KeyError):
        return None
    if found is None or not (0 < found[0] <= MAX_SIDE and 0 < found[1] <= MAX_SIDE):
        return None
    return found


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return width, height


_SOF = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # no length
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        if marker in _SOF:
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        if marker == 0xDA:  # start of scan: no size before it
            return None
        i += 2 + length
    return None


def _webp_size(data: bytes) -> tuple[int, int] | None:
    chunk = data[12:16]
    if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and data[20:21] == b"\x2f":
        (bits,) = struct.unpack("<I", data[21:25])
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    return None


def check_picture(data: bytes) -> tuple[str, int, int] | None:
    """``(kind, width, height)`` of an acceptable picture, else None (the owner's one sentence is ``WRONG_FILE``)."""
    if len(data) > MAX_BYTES:
        return None
    kind = kind_of(data[:16])
    if kind is None:
        return None
    size = image_size(data, kind)
    return (kind, size[0], size[1]) if size else None


def all_items(store: db.Store, user_id: str) -> list[Item]:
    return [i for i in store.query_all(db.user_pk(user_id), db.LOGO_PREFIX, consistent=True) if i.get("type") == "logo"]


def get_item(store: db.Store, user_id: str, logo_id: str) -> Item | None:
    if not is_logo_id(logo_id):
        return None
    found = store.get(db.user_pk(user_id), db.logo_sk(logo_id))
    return found if found is not None and found.get("type") == "logo" else None


def stale(item: Mapping[str, Any], now: datetime) -> bool:
    """An ``uploading`` item whose upload was never finished (the presigned PUT lasts 15 minutes)."""
    if item.get("status") != "uploading":
        return False
    made = parse(item.get("createdAt"))
    return made is None or now - made > UPLOAD_FRESH


def public(item: Mapping[str, Any], media: s3.Media) -> Item:
    """``{logoId, name, url, width, height, campaignId?, createdAt}`` with a presigned link of one hour."""
    out: Item = {
        "logoId": str(item["logoId"]),
        "name": str(item.get("name") or "logo"),
        "url": media.presign_get(str(item["key"])),
        "width": int(item.get("width") or 0),
        "height": int(item.get("height") or 0),
        "createdAt": str(item.get("createdAt") or ""),
    }
    if item.get("campaignId"):
        out["campaignId"] = str(item["campaignId"])
    return out


def new_item(user_id: str, logo_id: str, key: str, *, name: str, content_type: str, size: int, now: datetime) -> Item:
    return {
        "pk": db.user_pk(user_id),
        "sk": db.logo_sk(logo_id),
        "type": "logo",
        "userId": user_id,
        "logoId": logo_id,
        "name": name,
        "key": key,
        "contentType": content_type,
        "size": size,
        "status": "uploading",
        "createdAt": iso(now),
    }
