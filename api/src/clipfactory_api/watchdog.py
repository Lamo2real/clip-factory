"""EventBridge rate(10 minutes) → fail jobs whose agent stopped responding (docs/CONTRACTS.md §9).

A ``running`` job with no heartbeat for 15 minutes is marked failed. A ``queued`` job the agent never picked up
within 30 minutes is treated the same way, so a lost invocation cannot leave a job queued forever. The write is
conditional on the heartbeat the watchdog saw, so a job that just came back to life is left alone.

When it can reach the publish queue (``PUBLISH_QUEUE_URL``), it also resumes Confirms that stopped before the clip
was queued for publishing (a timeout or an SQS error): missing posts are created and the message is sent again.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from . import clips, db
from .clock import Clock, iso, parse, utcnow
from .log import log

STALE_RUNNING = timedelta(minutes=15)
STALE_QUEUED = timedelta(minutes=30)
STOPPED_MESSAGE = "The agent stopped responding. Press Retry."


@dataclass
class Watchdog:
    store: db.Store
    clock: Clock = utcnow
    # (user id, clip id) → send the publish message. None when the queue is not configured for this Lambda.
    enqueue: Callable[[str, str], None] | None = None

    def sweep(self) -> dict[str, int]:
        now = self.clock()
        failed = 0
        jobs = self.store.scan_jobs(["queued", "running"])
        for job in jobs:
            status = job.get("status")
            last = parse(job.get("heartbeatAt")) or parse(job.get("updatedAt")) or parse(job.get("createdAt"))
            limit = STALE_RUNNING if status == "running" else STALE_QUEUED
            if last is not None and now - last < limit:
                continue
            if self._fail(job, iso(now)):
                failed += 1
        result = {"checked": len(jobs), "failed": failed}
        if self.enqueue is not None:
            result["resumed"] = self._resume_publishes(self.enqueue)
        return result

    def _resume_publishes(self, enqueue: Callable[[str, str], None]) -> int:
        resumed = 0
        for clip in self.store.scan_type("clip", "publishState", [clips.PUBLISH_PENDING]):
            claimed = clips.claim_resume(self.store, clip, self.clock())
            if claimed is None:
                continue
            try:
                clips.publish(self.store, enqueue, claimed["userId"], claimed)
            except Exception as e:  # one owner's bad data must not stop the sweep; the next sweep tries again
                log("error", "watchdog.resume_failed", clipId=claimed.get("clipId"), error=type(e).__name__)
                continue
            log("warning", "watchdog.resumed_publish", clipId=claimed.get("clipId"))
            resumed += 1
        return resumed

    def _fail(self, job: dict[str, Any], now: str) -> bool:
        steps = [
            {**s, "status": "failed", "message": STOPPED_MESSAGE, "finishedAt": now}
            if s.get("status") == "running"
            else s
            for s in job.get("steps", [])
        ]
        expect: dict[str, list[Any]] = {"status": [job["status"]]}
        if job.get("heartbeatAt"):
            expect["heartbeatAt"] = [job["heartbeatAt"]]
        try:
            self.store.update(
                job["pk"],
                job["sk"],
                {"status": "failed", "error": STOPPED_MESSAGE, "steps": steps, "updatedAt": now},
                expect_in=expect,
            )
        except db.ConditionFailed:
            return False  # it moved on (heartbeat, cancel or finish) since the scan
        log("warning", "watchdog.failed_job", jobId=job.get("jobId"), previous=job.get("status"))
        return True


_watchdog: Watchdog | None = None


def handler(_event: dict[str, Any] | None = None, _context: Any = None) -> dict[str, int]:
    global _watchdog
    if _watchdog is None:
        from .app import region, sqs_client, table

        queue_url = os.environ.get("PUBLISH_QUEUE_URL", "")
        enqueue = None
        if queue_url:
            queue = sqs_client(region())

            def enqueue(user_id: str, clip_id: str) -> None:
                queue.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"userId": user_id, "clipId": clip_id}))

        _watchdog = Watchdog(db.Store(table(os.environ["TABLE_NAME"])), enqueue=enqueue)
    result = _watchdog.sweep()
    log("info", "watchdog.done", **result)
    return result
