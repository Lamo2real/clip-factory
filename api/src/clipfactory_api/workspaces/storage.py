"""How much Lamo Stories keeps, and where (docs/CONTRACTS.md §45.5, §45.6 ``StorageSummary``, §45.29 Storage and
production, §45.34 "Keeping and clearing files").

Summed from the workspace's own items, never from an S3 listing: every file a job or an upload makes is an
``ASSET#`` with its ``bytes`` (§45.12), every reference video a ``REFVID#`` with its size, every skill revision a
line on its ``SKILL#``. Only this workspace's partition is read. Storyboards and captions count under ``scenes``
("Scenes and storyboards"); a reference video whose file the keep setting cleared holds nothing any more. ``location``
names Lamo Stories' own folder in Clip Factory's media storage (the bucket's Region and ``s3://{bucket}/ws/{u}/{ws}/``).
"""

from __future__ import annotations

from typing import Any, Final

from .. import db
from ..app import region
from . import ai_config as cfg
from . import types as ws

VIDEOS: Final = ("final_video", "cover", "video")
SCENES: Final = ("scene_clip", "scene_still", "storyboard", "captions")
AUDIO: Final = ("audio",)
STORED_REFS: Final = ("ready", "analyzing", "analyzed", "failed")  # an upload still going holds nothing yet
LOCATION_LINE: Final = "Lamo Stories' own folder in Clip Factory's media storage"


def _bytes(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0


def location(bucket: str, user_id: str, workspace_id: str) -> dict[str, str]:
    """``StorageSummary.location``: the media bucket's Region and this workspace's own folder in it."""
    return {"region": region(), "folder": f"s3://{bucket}/{ws.s3_prefix(user_id, workspace_id)}"}


def summary(store: db.Store, user_id: str, workspace_id: str, *, bucket: str = "") -> dict[str, Any]:
    out = {"videos": 0, "scenes": 0, "audio": 0, "references": 0, "skills": 0, "other": 0}
    files = 0
    for asset in cfg.query_owned(store, user_id, workspace_id, ws.ASSET_SK):
        kind = asset.get("kind")
        bucket_name = (
            "videos" if kind in VIDEOS else "scenes" if kind in SCENES else "audio" if kind in AUDIO else "other"
        )
        out[bucket_name] += _bytes(asset.get("bytes"))
        files += 1
    for ref in cfg.query_owned(store, user_id, workspace_id, ws.REFVID_SK):
        if ref.get("status") in STORED_REFS and not ref.get("fileRemovedAt"):
            out["references"] += _bytes(ref.get("bytes"))
            files += 1
    for skill in cfg.query_owned(store, user_id, workspace_id, ws.SKILL_SK):
        if skill.get("builtin"):
            continue
        for revision in skill.get("revisions") or []:
            if isinstance(revision, dict):
                out["skills"] += _bytes(revision.get("size"))
                files += 1
    return {"bytes": out, "files": files, "location": location(bucket, user_id, workspace_id)}
