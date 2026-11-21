"""Asynchronous Invokes of ``cf-prod-stats`` (manual refresh), ``cf-prod-learn`` (weekly best), §16.2,
``cf-prod-money`` (Check now, §25.5) and, for Content Rewards (§38), ``cf-prod-campaigns`` (rules read, logo link,
brand picture) and ``cf-prod-stats`` (``{"action": "contentrewards"}``).

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
    def __init__(
        self, client: Any, stats_arn: str, learn_arn: str, money_arn: str = "", campaigns_arn: str = ""
    ) -> None:
        self._client = client
        self.stats_arn = stats_arn
        self.learn_arn = learn_arn
        self.money_arn = money_arn
        self.campaigns_arn = campaigns_arn

    def refresh_stats(self, user_id: str, clip_id: str, post_ids: list[str]) -> None:
        self._invoke(self.stats_arn, {"action": "refresh", "userId": user_id, "clipId": clip_id, "postIds": post_ids})

    def forget(self, user_id: str, platform: str) -> None:
        """``cf-prod-stats`` drops the numbers it read from a disconnected platform (YouTube policy, §17.6)."""
        self._invoke(self.stats_arn, {"action": "forget", "userId": user_id, "platform": platform})

    def refresh_money(self, user_id: str) -> None:
        """``cf-prod-money`` reads every connected platform for this owner now (§25.5 Check now)."""
        self._invoke(self.money_arn, {"action": "refresh", "userId": user_id})

    def read_campaign(self, user_id: str, campaign_id: str) -> None:
        """``cf-prod-campaigns`` reads the campaign's rules from the item (§38.10)."""
        self._invoke(self.campaigns_arn, {"action": "read", "userId": user_id, "campaignId": campaign_id})

    def fetch_logo(self, user_id: str, campaign_id: str, url: str) -> None:
        """``cf-prod-campaigns`` fetches a Google Drive or Dropbox logo link (§38.10)."""
        self._invoke(self.campaigns_arn, {"action": "logo", "userId": user_id, "campaignId": campaign_id, "url": url})

    def brand_picture(self, user_id: str, campaign_id: str) -> None:
        """``cf-prod-campaigns`` copies the brand's picture into the media bucket (§38.10)."""
        self._invoke(self.campaigns_arn, {"action": "brand_picture", "userId": user_id, "campaignId": campaign_id})

    def cr_check(self, user_id: str, what: str) -> None:
        """``cf-prod-stats`` checks one owner's Content Rewards campaigns, money or all of it now (§38.12)."""
        self._invoke(self.stats_arn, {"action": "contentrewards", "userId": user_id, "what": what})

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
