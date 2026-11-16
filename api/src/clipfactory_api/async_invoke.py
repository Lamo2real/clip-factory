"""Asynchronous Invokes of ``cf-prod-stats`` (manual refresh) and ``cf-prod-learn`` (weekly best), §16.2.

Both are plain functions (not durable), invoked on their unqualified ARN with ``InvocationType="Event"``: Lambda
queues the event and answers 202 at once, so the API request never waits for a platform or for Bedrock.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FUNCTION_ARN = re.compile(r"^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+$")


class InvokeError(Exception):
    """Lambda refused or failed the Invoke."""


class AsyncInvoker:
    def __init__(self, client: Any, stats_arn: str, learn_arn: str) -> None:
        self._client = client
        self.stats_arn = stats_arn
        self.learn_arn = learn_arn

    def refresh_stats(self, user_id: str, clip_id: str, post_ids: list[str]) -> None:
        self._invoke(self.stats_arn, {"action": "refresh", "userId": user_id, "clipId": clip_id, "postIds": post_ids})

    def forget(self, user_id: str, platform: str) -> None:
        """``cf-prod-stats`` drops the numbers it read from a disconnected platform (YouTube policy, §17.6)."""
        self._invoke(self.stats_arn, {"action": "forget", "userId": user_id, "platform": platform})

    def learn_week(self, user_id: str, week: str, revision: int) -> None:
        self._invoke(self.learn_arn, {"userId": user_id, "week": week, "revision": revision})

    def _invoke(self, arn: str, payload: dict[str, Any]) -> None:
        if not _FUNCTION_ARN.match(arn or ""):
            raise InvokeError("the function ARN is missing or not an unqualified function ARN")
        try:
            out = self._client.invoke(
                FunctionName=arn, InvocationType="Event", Payload=json.dumps(payload, sort_keys=True).encode()
            )
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            raise InvokeError(f"invoke failed: {code or type(e).__name__}") from e
        status = int(out.get("StatusCode") or 0)
        if status and status >= 300:
            raise InvokeError(f"invoke answered {status}")
