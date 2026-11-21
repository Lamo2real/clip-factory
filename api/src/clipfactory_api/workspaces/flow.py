"""Starts the durable ``cf-prod-story-flow`` (docs/CONTRACTS.md §45.14, §45.15).

Like the clip flow's start (``flow_client.py``, unchanged and used only through its public helpers): an asynchronous
Invoke on the function's **alias** ARN (``…:live``) with ``DurableExecutionName = "story-{storyId}-{run}"`` and the
payload ``{userId, workspaceId, storyId, publishingJobIds, run}``. Name and payload are fully determined by the
story and its run (``run`` is raised on the story before each start), so repeating a start is safe and
``DurableExecutionAlreadyStartedException`` is "already started".
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from ..flow_client import ALREADY_STARTED, FlowStartError, Started, make_client

_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ALIAS_ARN = re.compile(r"^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$")

__all__ = ["FlowStartError", "Started", "StoryFlowStarter", "from_env", "story_flow_name"]


def story_flow_name(story_id: str, run: int) -> str:
    name = f"story-{story_id}-{run}"
    if not _NAME.match(name):
        raise ValueError(f"not a valid durable execution name: {name!r}")
    return name


class StoryFlowStarter:
    def __init__(self, client: Any, story_flow_arn: str) -> None:
        self._client = client
        self.story_flow_arn = story_flow_arn

    @property
    def ready(self) -> bool:
        return bool(_ALIAS_ARN.match(self.story_flow_arn or ""))

    def start(self, user_id: str, workspace_id: str, story_id: str, publishing_job_ids: list[str], run: int) -> Started:
        name = story_flow_name(story_id, run)
        payload = {
            "userId": user_id,
            "workspaceId": workspace_id,
            "storyId": story_id,
            "publishingJobIds": list(publishing_job_ids),
            "run": run,
        }
        if not self.ready:
            raise FlowStartError("the story flow ARN is missing or is not an alias ARN")
        try:
            out = self._client.invoke(
                FunctionName=self.story_flow_arn,
                InvocationType="Event",
                DurableExecutionName=name,
                Payload=json.dumps(payload, sort_keys=True).encode(),
            )
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code == ALREADY_STARTED:
                return Started(name, None)
            raise FlowStartError(f"invoke failed: {code or type(e).__name__}") from e
        status = int(out.get("StatusCode") or 0)
        if status and status >= 300:
            raise FlowStartError(f"invoke answered {status}")
        arn_out = out.get("DurableExecutionArn")
        return Started(name, str(arn_out) if arn_out else None)


def from_env(story_flow_arn: str = "") -> StoryFlowStarter | None:
    """The starter of the API Lambda: only when ``STORY_FLOW_ARN`` is set (an empty one means "not switched on")."""
    arn = story_flow_arn or os.environ.get("STORY_FLOW_ARN", "")
    if not arn:
        return None
    from ..app import region

    return StoryFlowStarter(make_client(region()), arn)
