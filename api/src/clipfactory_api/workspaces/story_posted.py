"""A post on the story (docs/CONTRACTS.md §45.14): what the story gets when one of its publishing jobs is posted.

The story's ``posted`` list gets ``{platform, url}`` once, ``publishedAt`` is set if absent, and ``status`` becomes
``published`` (only from ``approved`` or ``published``), in one UpdateItem on the story's own attributes (``version``
+ 1, ``updatedAt``), compare-and-swap on ``version``; plus an ``ACT#`` "posted" item. The story flow
(``posted-{platform}``) and the owner's Mac (``workspaces.mac``: its done and It's on TikTok, §47.10) both use it. It
lives apart from the flow, whose module loads the durable SDK at its top, so the API never imports the flow.

Pure: it builds the requests; the callers write them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso
from . import types as ws

Item = dict[str, Any]
ACT_TTL: Final = timedelta(days=90)


@dataclass(frozen=True)
class StoryWrite:
    """One conditional UpdateItem on the story: for ``Store.update_expr`` or, as ``request``, a transaction."""

    expression: str
    condition: str
    names: dict[str, str] = field(default_factory=dict)
    values: Item = field(default_factory=dict)

    def request(self, pk: str, sk: str) -> Item:
        return {
            "Key": {"pk": pk, "sk": sk},
            "UpdateExpression": self.expression,
            "ConditionExpression": self.condition,
            "ExpressionAttributeNames": dict(self.names),
            "ExpressionAttributeValues": {k: db.to_dynamo(v) for k, v in self.values.items()},
        }


def story_write(story: Mapping[str, Any], platform: str, url: str, posted_at: str, now: datetime) -> StoryWrite | None:
    """The write that records one post on the story; None when the story has it already (a replay adds nothing)."""
    current = [dict(p) for p in story.get("posted") or [] if isinstance(p, Mapping)]
    entry = {"platform": platform, "url": url}
    status = story.get("status")
    promote = status in ("approved", "published") and status != "published"
    if entry in current and story.get("publishedAt") and not promote:
        return None
    sets: Item = {"posted": current if entry in current else [*current, entry], "updatedAt": iso(now)}
    if not story.get("publishedAt"):
        sets["publishedAt"] = posted_at
    if status in ("approved", "published"):
        sets["status"] = "published"
    names = {f"#f{i}": k for i, k in enumerate(sets)}
    values: Item = {f":f{i}": v for i, v in enumerate(sets.values())}
    names["#v"] = "version"
    values[":one"] = 1
    values[":zero"] = 0
    expression = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(sets)))
    expression += ", #v = if_not_exists(#v, :zero) + :one"
    version = story.get("version")
    if isinstance(version, int) and not isinstance(version, bool):
        condition = "attribute_exists(pk) AND #v = :ver"
        values[":ver"] = version
    else:
        condition = "attribute_exists(pk) AND attribute_not_exists(#v)"
    return StoryWrite(expression, condition, names, values)


def activity(
    pk: str,
    job: Mapping[str, Any],
    kind: str,
    *,
    user_id: str,
    workspace_id: str,
    story_id: str,
    at: str,
    title: str,
    now: datetime,
) -> Item:
    """The ``ACT#{at}#{publishingJobId}`` item of one job (``posted`` or ``failed``), kept 90 days."""
    return {
        "pk": pk,
        "sk": f"{ws.ACT_SK}{at}#{job['publishingJobId']}",
        "type": ws.TYPE_ACTIVITY,
        "userId": user_id,
        "workspaceId": workspace_id,
        "at": at,
        "kind": kind,
        "storyId": story_id,
        "title": title,
        "platform": str(job.get("platform") or ""),
        "ttl": int((now + ACT_TTL).timestamp()),
    }
