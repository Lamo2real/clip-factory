"""Every picture sent to a model goes through here (docs/CONTRACTS.md §45.33): chat attachments, design references,
reference-video frames, the final review's frames and portraits.

The picture is scaled so its long edge is at most 1568 px, re-encoded to JPEG at about quality 85 (which also drops
EXIF and GPS), and stepped down until it is at most 3.5 MB. A picture ffmpeg cannot open fails with the owner's
sentence."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .util import UserFacingError, log

LONG_EDGE = 1568
MAX_BYTES = int(3.5 * 1024 * 1024)
CANNOT_OPEN = "I can't open that picture. Try a screenshot or a photo."
# ffmpeg's JPEG scale: 2 is the best; 4 is about quality 85. Then smaller sizes if the file is still too big.
_STEPS: tuple[tuple[int, int], ...] = ((LONG_EDGE, 4), (LONG_EDGE, 7), (1200, 7), (900, 9), (640, 12), (480, 16))


def _encode(path: Path, edge: int, q: int) -> bytes:
    vf = (
        f"scale=w='min(iw,{edge})':h='min(ih,{edge})':force_original_aspect_ratio=decrease,"
        "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuvj420p"
    )
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map_metadata", "-1", "-frames:v", "1",
         "-vf", vf, "-q:v", str(q), "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
        capture_output=True,
        timeout=120,
        check=False,
    )  # fmt: skip
    if r.returncode != 0 or not r.stdout.startswith(b"\xff\xd8"):
        raise ValueError(r.stderr.decode("utf-8", "replace")[-300:])
    return r.stdout


def to_model_image(path: Path) -> bytes:
    """The picture as a JPEG a model may take (≤ 1568 px long edge, ≤ 3.5 MB, no EXIF). Synchronous: call it from
    a worker thread. Raises ``UserFacingError(CANNOT_OPEN)`` when it cannot be read."""
    data = b""
    for edge, q in _STEPS:
        try:
            data = _encode(path, edge, q)
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            log("warn", "stories.picture_unreadable", detail=str(e)[:300])
            raise UserFacingError(CANNOT_OPEN) from e
        if len(data) <= MAX_BYTES:
            return data
    raise UserFacingError(CANNOT_OPEN)


def image_block(jpeg: bytes) -> dict[str, Any]:
    """A Converse content block for a picture made by ``to_model_image``."""
    return {"image": {"format": "jpeg", "source": {"bytes": jpeg}}}
