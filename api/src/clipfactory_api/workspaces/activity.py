"""Recent activity (``ACT#{at}#{id}``, docs/CONTRACTS.md §45.3, §45.16.3): kept 90 days, the dashboard shows the last 10.

The API writes approve, reject and changes; the agent writes made and failed; the story flow posted and failed.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso
from ..ids import ulid
from . import types as ws

KINDS: Final = ("made", "approved", "rejected", "changes", "posted", "failed")
KEEP = timedelta(days=90)


def item(
    user_id: str, workspace_id: str, kind: str, story: Mapping[str, Any], *, now: datetime, platform: str | None = None
) -> dict[str, Any]:
    at = iso(now)
    out: dict[str, Any] = {
        "pk": ws.workspace_pk(user_id, workspace_id),
        "sk": f"{ws.ACT_SK}{at}#{ulid()}",
        "type": ws.TYPE_ACTIVITY,
        "userId": user_id,
        "workspaceId": workspace_id,
        "at": at,
        "kind": kind,
        "storyId": str(story["storyId"]),
        "title": str(story.get("title") or ""),
        "ttl": int((now + KEEP).timestamp()),
    }
    if platform:
        out["platform"] = platform
    return out


def record(
    store: db.Store, user_id: str, workspace_id: str, kind: str, story: Mapping[str, Any], *, now: datetime
) -> None:
    store.put(item(user_id, workspace_id, kind, story, now=now), if_absent=True)


def public(entry: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "at": str(entry.get("at") or ""),
        "kind": str(entry.get("kind") or ""),
        "storyId": str(entry.get("storyId") or ""),
        "title": str(entry.get("title") or ""),
    }
    if entry.get("platform"):
        out["platform"] = entry["platform"]
    return out
