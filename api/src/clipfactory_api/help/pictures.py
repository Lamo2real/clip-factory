"""Pictures in Ask: checking the owner's pictures before the model sees them (docs/CONTRACTS.md §26).

A picture arrives as base64 JPEG inside the question body. It is read once, never stored and never logged. Every
check here is cheap and runs before any model call:

* exactly ``{type, data}``, ``type == "image/jpeg"``, strict base64;
* 100 bytes .. 600 KB decoded, starts ``FF D8 FF`` and ends ``FF D9``;
* a small segment walker finds a baseline, extended or progressive frame (SOF0/1/2) with both edges 16..1600 px;
* every ``APP1``..``APP15`` and ``COM`` segment is dropped (EXIF, GPS, XMP, comments), ``APP0`` (JFIF) is kept. The
  browser already re-encodes through a canvas, so this is belt and braces for direct API calls.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

PICTURES_MAX = 4
# A flat picture (a blank screen) re-encodes to a few hundred bytes, so the floor only rules out scraps.
PICTURE_BYTES_MIN = 100
PICTURE_BYTES_MAX = 600_000
EDGE_MIN = 16
EDGE_MAX = 1600
PICTURE_KEYS = frozenset({"type", "data"})

TOO_MANY = "You can send 4 pictures at a time."
TOO_BIG = "That picture is too big. Try a screenshot."
CANT_OPEN = "I can't open that picture. Try a screenshot or a photo."

_SOF = frozenset({0xC0, 0xC1, 0xC2})
_SOS = 0xDA
_EOI = 0xD9
_STANDALONE = frozenset({0x01, *range(0xD0, 0xD8)})  # TEM and RST0..7 carry no length
_DROP = frozenset({*range(0xE1, 0xF0), 0xFE})  # APP1..APP15 and COM


class PictureError(Exception):
    """A picture failed a check; ``message`` is the owner-facing text of the 400."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Picture:
    jpeg: bytes  # the cleaned bytes (no APP1..15 or COM) that the look call sends
    width: int
    height: int
    size: int  # decoded bytes as sent, before cleaning


@dataclass(frozen=True)
class JpegInfo:
    width: int
    height: int
    clean: bytes
    dropped: int  # how many APPn/COM segments were taken out


def _u16(data: bytes, at: int) -> int:
    return (data[at] << 8) | data[at + 1]


_NOT_A_MARKER = frozenset({0x00, 0xFF, *range(0xD0, 0xD8)})


def _scan_entropy(data: bytes, i: int) -> int:
    """Entropy-coded data runs to the next marker that is not a stuffed 00, fill or a restart marker."""
    n = len(data)
    while i + 1 < n and not (data[i] == 0xFF and data[i + 1] not in _NOT_A_MARKER):
        i += 1
    if i + 1 >= n:
        raise PictureError(CANT_OPEN)
    return i


def walk(data: bytes) -> JpegInfo:
    """Walks the JPEG markers, keeps everything but APP1..15 and COM, and reads the frame size.

    Raises ``PictureError(CANT_OPEN)`` for anything that is not a well formed baseline/progressive JPEG."""
    n = len(data)
    if n < 4 or data[0] != 0xFF or data[1] != 0xD8 or data[2] != 0xFF or data[-2] != 0xFF or data[-1] != _EOI:
        raise PictureError(CANT_OPEN)
    out = bytearray(b"\xff\xd8")
    i = 2
    width = height = 0
    dropped = 0
    while i < n:
        if data[i] != 0xFF:
            raise PictureError(CANT_OPEN)
        while i < n and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= n:
            raise PictureError(CANT_OPEN)
        marker = data[i]
        i += 1
        if marker == _EOI:
            out += b"\xff\xd9"  # anything after EOI is dropped
            break
        if marker in _STANDALONE:
            out += bytes((0xFF, marker))
            continue
        if i + 2 > n:
            raise PictureError(CANT_OPEN)
        length = _u16(data, i)
        if length < 2 or i + length > n:
            raise PictureError(CANT_OPEN)
        segment = data[i : i + length]
        if marker in _SOF:
            if length < 8:
                raise PictureError(CANT_OPEN)
            height, width = _u16(segment, 3), _u16(segment, 5)
        elif 0xC3 <= marker <= 0xCF and marker not in {0xC4, 0xC8, 0xCC}:
            raise PictureError(CANT_OPEN)  # lossless or arithmetic frames: not something a browser sends
        i += length
        if marker in _DROP:
            dropped += 1
        else:
            out += bytes((0xFF, marker)) + segment
        if marker == _SOS:
            end = _scan_entropy(data, i)
            out += data[i:end]
            i = end
    else:
        raise PictureError(CANT_OPEN)
    if not width or not height:
        raise PictureError(CANT_OPEN)
    if not (EDGE_MIN <= width <= EDGE_MAX and EDGE_MIN <= height <= EDGE_MAX):
        raise PictureError(TOO_BIG if max(width, height) > EDGE_MAX else CANT_OPEN)
    return JpegInfo(width, height, bytes(out), dropped)


def parse_one(raw: Any) -> Picture:
    if not isinstance(raw, dict) or set(raw) != PICTURE_KEYS:
        raise PictureError(CANT_OPEN)
    if raw.get("type") != "image/jpeg" or not isinstance(raw.get("data"), str):
        raise PictureError(CANT_OPEN)
    text: str = raw["data"]
    # base64 of 600 KB is 800 000 characters: refuse anything far bigger before decoding it.
    if len(text) > (PICTURE_BYTES_MAX * 4) // 3 + 8:
        raise PictureError(TOO_BIG)
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise PictureError(CANT_OPEN) from None
    if len(data) > PICTURE_BYTES_MAX:
        raise PictureError(TOO_BIG)
    if len(data) < PICTURE_BYTES_MIN:
        raise PictureError(CANT_OPEN)
    info = walk(data)
    return Picture(info.clean, info.width, info.height, len(data))


def parse(raw: Any) -> list[Picture]:
    """The body's ``pictures`` value (absent → []); raises ``PictureError`` with the owner-facing message."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PictureError(CANT_OPEN)
    if len(raw) > PICTURES_MAX:
        raise PictureError(TOO_MANY)
    return [parse_one(p) for p in raw]


def total_kb(pictures: Sequence[Picture]) -> int:
    return round(sum(p.size for p in pictures) / 1024)
