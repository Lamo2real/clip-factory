"""SQS ``cf-prod-publish`` → publish a confirmed clip's queued posts (docs/CONTRACTS.md §9).

Each message is ``{"userId", "clipId"}``. Posts already ``posted`` are never sent again, so a redelivered
message is harmless. The posts are read from the owner's partition with a strongly consistent query (not
through the eventually consistent gsi1), so posts the API wrote just before sending the message are always seen. A retryable platform error fails the message so SQS tries again; any other error is
recorded on the post. After a post goes out, a one-time EventBridge Scheduler schedule runs the perf check
48 hours later.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from . import db, posts
from .clock import Clock, iso, parse, utcnow
from .log import log
from .platforms import NotConnectedError, PlatformAdapter, PublishError, adapter_for

PERF_CHECK_DELAY = timedelta(hours=48)


@dataclass
class Publisher:
    store: db.Store
    scheduler: Any
    perf_check_arn: str
    scheduler_role_arn: str
    schedule_group: str
    clock: Clock = utcnow
    adapters: Callable[[str], PlatformAdapter] = field(default=adapter_for)

    def publish_clip(self, user_id: str, clip_id: str) -> str:
        pk = db.user_pk(user_id)
        clip = self.store.get(pk, db.clip_sk(clip_id))
        if clip is None or clip.get("status") in {"review", "declined"}:
            return "skipped"
        outcomes = []
        for post in posts.posts_for_clip(self.store, user_id, clip_id, consistent=True):
            if post.get("status") == "queued":
                outcomes.append(self._publish_post(user_id, clip, post))
            elif post.get("status") == "posted":
                self._ensure_perf_check(user_id, post)
        self._update_clip_status(user_id, clip)
        return ",".join(outcomes) or "nothing_queued"

    def _publish_post(self, user_id: str, clip: dict[str, Any], post: dict[str, Any]) -> str:
        platform = post["platform"]
        account = posts.connected_account(self.store, user_id, platform)
        try:
            result = self.adapters(platform).publish(clip, account)
        except NotConnectedError:
            self.store.update(post["pk"], post["sk"], {"status": "pending_integration"}, remove=["error"])
            return f"{platform}:pending_integration"
        except PublishError as e:
            if e.retryable:
                raise
            self.store.update(post["pk"], post["sk"], {"status": "failed", "error": str(e)})
            log("warning", "publish.failed", postId=post["postId"], platform=platform)
            return f"{platform}:failed"
        posted_at = parse(result.posted_at) or self.clock()
        check_at = posted_at + PERF_CHECK_DELAY
        self.store.update(
            post["pk"],
            post["sk"],
            {"status": "posted", "url": result.url, "postedAt": iso(posted_at), "perfCheckAt": iso(check_at)},
            remove=["error"],
        )
        self._schedule_perf_check(user_id, post["postId"], check_at)
        log("info", "publish.posted", postId=post["postId"], platform=platform)
        return f"{platform}:posted"

    def _ensure_perf_check(self, user_id: str, post: dict[str, Any]) -> None:
        """A post is marked posted before its schedule is created (so a scheduler error can never make SQS send it
        to the platform twice). If that schedule failed, the redelivered message lands here and creates it."""
        check_at = parse(post.get("perfCheckAt"))
        if check_at is not None and check_at > self.clock():
            self._schedule_perf_check(user_id, post["postId"], check_at)

    def _schedule_perf_check(self, user_id: str, post_id: str, when: Any) -> None:
        try:
            self.scheduler.create_schedule(
                Name=f"perf-{post_id}",
                GroupName=self.schedule_group,
                ScheduleExpression=f"at({when.strftime('%Y-%m-%dT%H:%M:%S')})",
                ScheduleExpressionTimezone="UTC",
                FlexibleTimeWindow={"Mode": "OFF"},
                ActionAfterCompletion="DELETE",
                Target={
                    "Arn": self.perf_check_arn,
                    "RoleArn": self.scheduler_role_arn,
                    "Input": json.dumps({"userId": user_id, "postId": post_id}),
                },
            )
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code != "ConflictException":  # already scheduled by an earlier delivery
                raise

    def _update_clip_status(self, user_id: str, clip: dict[str, Any]) -> None:
        found = posts.posts_for_clip(self.store, user_id, clip["clipId"], consistent=True)
        statuses = {p.get("status") for p in found}
        if "posted" in statuses:
            new = "posted"
        elif "queued" in statuses:
            new = "publishing"
        elif statuses == {"failed"}:
            new = "failed"
        else:
            return  # waiting for integrations: the clip stays confirmed
        if new != clip.get("status"):
            self.store.update(clip["pk"], clip["sk"], {"status": new})


def process(event: dict[str, Any], publisher: Publisher) -> dict[str, list[dict[str, str]]]:
    failures: list[dict[str, str]] = []
    for record in event.get("Records", []):
        message_id = str(record.get("messageId", ""))
        try:
            body = json.loads(record.get("body") or "")
            user_id, clip_id = str(body["userId"]), str(body["clipId"])
        except (ValueError, KeyError, TypeError):
            log("error", "publish.bad_message", messageId=message_id)
            continue  # malformed: retrying cannot help, and it is visible in the logs
        try:
            outcome = publisher.publish_clip(user_id, clip_id)
            log("info", "publish.done", messageId=message_id, clipId=clip_id, outcome=outcome)
        except Exception as e:
            log("error", "publish.error", messageId=message_id, clipId=clip_id, error=type(e).__name__)
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_publisher: Publisher | None = None


def _from_env() -> Publisher:
    import boto3

    from .app import region, table

    env = os.environ
    return Publisher(
        store=db.Store(table(env["TABLE_NAME"])),
        scheduler=boto3.client("scheduler", region_name=region()),
        perf_check_arn=env["PERF_CHECK_FUNCTION_ARN"],
        scheduler_role_arn=env["SCHEDULER_ROLE_ARN"],
        schedule_group=env.get("SCHEDULE_GROUP", "default"),
    )


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, list[dict[str, str]]]:
    global _publisher
    if _publisher is None:
        _publisher = _from_env()
    return process(event, _publisher)
