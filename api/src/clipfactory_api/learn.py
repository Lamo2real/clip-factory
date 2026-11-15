"""Learnings: what the owner's measured posts teach the clip-picking agent (docs/CONTRACTS.md §13, §14.5).

The clip-flow's ``distil`` step calls ``distil`` once a clip's posts have their 48-hour metrics. Claude Fable 5.1
reads the owner's recent measured posts and answers with one short, concrete learning. A Learning is only written
when the model finished its answer (``end_turn``) and there is text: ``max_tokens``, ``refusal``,
``content_filtered`` and an empty answer write nothing, so a cut-off sentence never steers the agent.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from . import db, posts
from .clock import Clock, iso, utcnow
from .ids import ulid
from .log import log

Item = dict[str, Any]

RECENT_POSTS = 20
MAX_LEARNING_CHARS = 280
# Claude Fable 5.1 always thinks and thinking tokens count against maxTokens, so the cap leaves room for the
# reasoning as well as the one-sentence answer; low effort keeps this small task short. Fable rejects temperature,
# top_p and top_k together with these settings, so none of them is sent.
MAX_TOKENS = 4000
EFFORT = "low"
STOP_OUTCOMES = frozenset({"max_tokens", "refusal", "content_filtered"})
LEARNING_FIELDS = ("learningId", "text", "createdAt", "postIds")

SYSTEM_PROMPT = (
    "You help a creator learn what makes their short vertical clips perform. You get recent posts with their "
    "platform, hook, moment type and 48-hour metrics. Reply with ONE short, concrete, actionable learning "
    "(one sentence, at most 200 characters) that the clip-picking agent should apply to the next videos. "
    "Base it only on the numbers given. Plain text only: no preamble, no quotes, no lists."
)


def public_learning(item: Mapping[str, Any]) -> Item:
    """The Learning shape of §5 (used by GET /v1/insights and the live updates)."""
    return {k: item[k] for k in LEARNING_FIELDS if k in item}


def distil(store: db.Store, bedrock: Any, model_id: str, user_id: str, *, clock: Clock = utcnow) -> str:
    """Distils one Learning from the owner's measured posts; returns the outcome (``learning``, ``no_metrics``,
    ``no_learning``, ``max_tokens``, ``refusal`` or ``content_filtered``)."""
    return distil_learning(store, bedrock, model_id, user_id, clock=clock)[0]


def distil_learning(
    store: db.Store, bedrock: Any, model_id: str, user_id: str, *, clock: Clock = utcnow
) -> tuple[str, str | None]:
    """Like ``distil``, plus the new Learning's id when one was written."""
    measured = [p for p in posts.all_posts(store, user_id) if p.get("metrics")][:RECENT_POSTS]
    if not measured:
        return "no_metrics", None
    pk = db.user_pk(user_id)
    clip_ids = list(dict.fromkeys(str(p["clipId"]) for p in measured))
    clips = {c.get("clipId"): c for c in store.batch_get((pk, db.clip_sk(c)) for c in clip_ids)}
    rows = []
    for p in measured:
        clip = clips.get(p["clipId"]) or {}
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
    stop_reason, text = _ask_model(bedrock, model_id, rows)
    if stop_reason != "end_turn":
        log("warning", "learn.model_stopped", stopReason=stop_reason, posts=len(measured))
        return (stop_reason if stop_reason in STOP_OUTCOMES else "no_learning"), None
    if not text:
        return "no_learning", None
    learning_id = ulid()
    store.put(
        {
            "pk": pk,
            "sk": db.learning_sk(learning_id),
            "type": "learning",
            "userId": user_id,
            "learningId": learning_id,
            "text": text,
            "createdAt": iso(clock()),
            "postIds": [p["postId"] for p in measured],
        }
    )
    log("info", "learn.learning", learningId=learning_id, posts=len(measured))
    return "learning", learning_id


def _ask_model(bedrock: Any, model_id: str, rows: list[dict[str, Any]]) -> tuple[str, str]:
    """Returns (stopReason, answer text). Reasoning blocks (``reasoningContent``) are not part of the answer."""
    out = bedrock.converse(
        modelId=model_id,
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
