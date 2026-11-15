"""EventBridge Scheduler ``perf-{postId}`` → read the post's metrics and distil one Learning (docs/CONTRACTS.md §9).

The schedule is one-time and deletes itself, so this handler never raises: missing posts, missing metrics or a
model failure are logged and the run ends cleanly. A Learning is only written when there are measured posts to
learn from.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import db, posts
from .clock import Clock, iso, utcnow
from .ids import ulid
from .log import log
from .platforms import NotConnectedError, PlatformAdapter, PublishError, adapter_for

RECENT_POSTS = 20
MAX_LEARNING_CHARS = 280
# Claude Fable 5.1 always thinks, and thinking tokens count against maxTokens, so the cap must leave room for
# the reasoning as well as the one-sentence answer. Low effort keeps this small task from thinking at length.
# Fable rejects temperature, top_p and a thinking budget (400), so none of those are sent.
MAX_TOKENS = 6000
EFFORT = "low"

SYSTEM_PROMPT = (
    "You help a creator learn what makes their short vertical clips perform. You get recent posts with their "
    "platform, hook, moment type and 48-hour metrics. Reply with ONE short, concrete, actionable learning "
    "(one sentence, at most 200 characters) that the clip-picking agent should apply to the next videos. "
    "Base it only on the numbers given. Plain text only: no preamble, no quotes, no lists."
)


@dataclass
class PerfCheck:
    store: db.Store
    bedrock: Any
    model_id: str
    clock: Clock = utcnow
    adapters: Callable[[str], PlatformAdapter] = field(default=adapter_for)

    def run(self, user_id: str, post_id: str) -> str:
        pk = db.user_pk(user_id)
        post = self.store.get(pk, db.post_sk(post_id))
        if post is None:
            return "post_missing"
        if not self._refresh_metrics(user_id, post):
            return "no_metrics"  # nothing new to learn from; older posts were already distilled
        return self._distil(user_id)

    def _refresh_metrics(self, user_id: str, post: dict[str, Any]) -> bool:
        account = posts.connected_account(self.store, user_id, post["platform"])
        try:
            m = self.adapters(post["platform"]).metrics(post, account)
        except (NotConnectedError, PublishError) as e:
            log("info", "perf.no_metrics", postId=post["postId"], reason=type(e).__name__)
            return False
        metrics = {
            "views": m.views,
            "likes": m.likes,
            "comments": m.comments,
            "shares": m.shares,
            "checkedAt": iso(self.clock()),
        }
        self.store.update(post["pk"], post["sk"], {"metrics": metrics})
        return True

    def _distil(self, user_id: str) -> str:
        measured = [p for p in posts.all_posts(self.store, user_id) if p.get("metrics")][:RECENT_POSTS]
        if not measured:
            return "no_metrics"
        pk = db.user_pk(user_id)
        rows = []
        for p in measured:
            clip = self.store.get(pk, db.clip_sk(p["clipId"])) or {}
            rows.append(
                {
                    "platform": p["platform"],
                    "hook": clip.get("hook", ""),
                    "momentType": clip.get("momentType", ""),
                    "durationSec": clip.get("durationSec"),
                    "score": clip.get("score"),
                    "metrics": {k: p["metrics"].get(k, 0) for k in ("views", "likes", "comments", "shares")},
                }
            )
        stop_reason, text = self._ask_model(rows)
        if stop_reason != "end_turn":
            # max_tokens: the answer was cut off (or never written); refusal/content_filtered: nothing usable.
            # A partial sentence must never become a Learning the agent then follows.
            log("warning", "perf.model_stopped", stopReason=stop_reason, posts=len(measured))
            return stop_reason if stop_reason in {"max_tokens", "refusal", "content_filtered"} else "no_learning"
        if not text:
            return "no_learning"
        learning_id = ulid()
        self.store.put(
            {
                "pk": pk,
                "sk": db.learning_sk(learning_id),
                "type": "learning",
                "userId": user_id,
                "learningId": learning_id,
                "text": text,
                "createdAt": iso(self.clock()),
                "postIds": [p["postId"] for p in measured],
            }
        )
        log("info", "perf.learning", learningId=learning_id, posts=len(measured))
        return "learning"

    def _ask_model(self, rows: list[dict[str, Any]]) -> tuple[str, str]:
        """Returns (stopReason, answer text). Reasoning blocks (``reasoningContent``) are not part of the answer."""
        out = self.bedrock.converse(
            modelId=self.model_id,
            system=[{"text": SYSTEM_PROMPT}],
            messages=[{"role": "user", "content": [{"text": "Recent posts:\n" + json.dumps(rows, indent=1)}]}],
            inferenceConfig={"maxTokens": MAX_TOKENS},
            additionalModelRequestFields={"output_config": {"effort": EFFORT}},
        )
        stop_reason = str(out.get("stopReason") or "")
        blocks = out.get("output", {}).get("message", {}).get("content", [])
        text = " ".join(b["text"] for b in blocks if isinstance(b, dict) and isinstance(b.get("text"), str))
        text = " ".join(text.split()).strip().strip('"')
        return stop_reason, text[:MAX_LEARNING_CHARS]


def run_event(event: dict[str, Any], check: PerfCheck | Callable[[], PerfCheck]) -> dict[str, Any]:
    user_id, post_id = event.get("userId"), event.get("postId")
    if not isinstance(user_id, str) or not isinstance(post_id, str):
        log("error", "perf.bad_event")
        return {"ok": False, "outcome": "bad_event"}
    try:
        runner = check if isinstance(check, PerfCheck) else check()
        outcome = runner.run(user_id, post_id)
    except Exception as e:
        log("error", "perf.failed", postId=post_id, error=type(e).__name__)
        return {"ok": False, "outcome": "error"}
    log("info", "perf.done", postId=post_id, outcome=outcome)
    return {"ok": True, "outcome": outcome}


_check: PerfCheck | None = None


def _from_env() -> PerfCheck:
    global _check
    if _check is None:
        import boto3
        from botocore.config import Config

        from .app import region, table

        env = os.environ
        _check = PerfCheck(
            store=db.Store(table(env["TABLE_NAME"])),
            bedrock=boto3.client(
                "bedrock-runtime", region_name=region(), config=Config(read_timeout=120, retries={"mode": "adaptive"})
            ),
            model_id=env["MODEL_ID"],
        )
    return _check


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    return run_event(event, _from_env)
