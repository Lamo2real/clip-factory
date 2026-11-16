"""Learnings: what the owner's measured posts teach the clip-picking agent (docs/CONTRACTS.md §13, §14.5).

The clip-flow's ``distil`` step calls ``distil`` once a clip's posts have their 48-hour metrics. Claude Fable 5.1
reads the owner's recent measured posts and answers with one short, concrete learning. A Learning is only written
when the model finished its answer (``end_turn``) and there is text: ``max_tokens``, ``refusal``,
``content_filtered`` and an empty answer write nothing, so a cut-off sentence never steers the agent.

Every model call goes through ``converse_text``, which puts the owner's skills block first in the system prompt
(§18.6): it is the only place in this package that calls ``.converse(``.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from . import db, posts, s3
from . import skills as skill_files
from .clock import Clock, iso, utcnow
from .ids import ulid
from .log import log
from .skill_prompt import SkillsBlock, compose_system, is_cache_point_error, load_block, turn_cache_points_off

Item = dict[str, Any]

RECENT_POSTS = 20
MAX_LEARNING_CHARS = 280
# Claude Fable 5.1 always thinks and thinking tokens count against maxTokens, so the cap leaves room for the
# reasoning as well as the one-sentence answer; low effort keeps this small task short. Fable rejects temperature,
# top_p and top_k together with these settings, so none of them is sent.
MAX_TOKENS = 4000
EFFORT = "low"
STOP_OUTCOMES = frozenset({"max_tokens", "refusal", "content_filtered"})
LEARNING_FIELDS = ("learningId", "text", "createdAt", "postIds", "kind", "week", "title", "clipIds")
MAX_WEEK_LEARNING_CHARS = 500
CAPTION_CHARS = 200
WEEK_PLATFORMS = ("youtube", "tiktok", "instagram", "facebook", "x")

WEEK_SYSTEM_PROMPT = (
    "You help a creator learn what makes their short vertical gaming clips work. You get every clip they kept this "
    "week: whether the owner picked it as one of the week's best (picked), its hook, moment type, length in "
    "seconds, layout, the agent's score, the YouTube title, the start of the TikTok caption and the numbers per "
    "platform. Compare the owner's picks with the rest of the week (hooks, moment types, length, captions, numbers) "
    "and reply with ONE plain-text learning of 1 to 3 short sentences (at most 500 characters) that the "
    "clip-picking agent should apply when it cuts the next videos. The owner's picks matter more than raw views. "
    "Plain text only: no preamble, no quotes, no lists."
)

SYSTEM_PROMPT = (
    "You help a creator learn what makes their short vertical clips perform. You get recent posts with their "
    "platform, hook, moment type and 48-hour metrics. Reply with ONE short, concrete, actionable learning "
    "(one sentence, at most 200 characters) that the clip-picking agent should apply to the next videos. "
    "Base it only on the numbers given. Plain text only: no preamble, no quotes, no lists."
)


def public_learning(item: Mapping[str, Any]) -> Item:
    """The Learning shape of §5 (used by GET /v1/insights and the live updates)."""
    return {k: item[k] for k in LEARNING_FIELDS if k in item}


BuiltinsLoader = Callable[[], Sequence[skill_files.BuiltinSkill]]


def distil(
    store: db.Store,
    bedrock: Any,
    model_id: str,
    user_id: str,
    *,
    media: s3.Media,
    clock: Clock = utcnow,
    builtins: BuiltinsLoader = skill_files.load_builtins,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Distils one Learning from the owner's measured posts; returns the outcome (``learning``, ``no_metrics``,
    ``no_learning``, ``max_tokens``, ``refusal`` or ``content_filtered``)."""
    return distil_learning(store, bedrock, model_id, user_id, media=media, clock=clock, builtins=builtins, sleep=sleep)[
        0
    ]


def distil_learning(
    store: db.Store,
    bedrock: Any,
    model_id: str,
    user_id: str,
    *,
    media: s3.Media,
    clock: Clock = utcnow,
    builtins: BuiltinsLoader = skill_files.load_builtins,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[str, str | None]:
    """Like ``distil``, plus the new Learning's id when one was written. The owner's skills are loaded just before
    the model call (§18.6)."""
    measured = [p for p in posts.all_posts(store, user_id) if isinstance(p.get("metrics"), dict)][:RECENT_POSTS]
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
                "metrics": {k: p["metrics"].get(k) or 0 for k in ("views", "likes", "comments", "shares")},
            }
        )
    block = load_block(store, media, user_id, where="api.distil", builtins=builtins, sleep=sleep)
    stop_reason, text = _ask_model(bedrock, model_id, rows, block)
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


def converse_text(
    bedrock: Any, model_id: str, system: str, user_text: str, *, max_chars: int, skills: SkillsBlock
) -> tuple[str, str]:
    """One Converse call with the shared Fable 5.1 settings (maxTokens 4000, effort low, no sampling parameters)
    and the owner's skills block first in the system prompt. Returns (stopReason, answer text). Reasoning blocks
    (``reasoningContent``) are not part of the answer. When Bedrock refuses the cache point, cache points are
    turned off for this process and the call is sent again without it."""

    def send() -> Any:
        return bedrock.converse(
            modelId=model_id,
            system=compose_system(skills, system),
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": MAX_TOKENS},
            additionalModelRequestFields={"output_config": {"effort": EFFORT}},
        )

    try:
        out = send()
    except Exception as e:
        if not is_cache_point_error(e):
            raise
        turn_cache_points_off()
        out = send()
    stop_reason = str(out.get("stopReason") or "")
    blocks = out.get("output", {}).get("message", {}).get("content", [])
    text = " ".join(b["text"] for b in blocks if isinstance(b, dict) and isinstance(b.get("text"), str))
    text = " ".join(text.split()).strip().strip('"')
    return stop_reason, text[:max_chars]


def _ask_model(bedrock: Any, model_id: str, rows: list[dict[str, Any]], block: SkillsBlock) -> tuple[str, str]:
    return converse_text(
        bedrock,
        model_id,
        SYSTEM_PROMPT,
        "Recent posts:\n" + json.dumps(rows, indent=1),
        max_chars=MAX_LEARNING_CHARS,
        skills=block,
    )


def _count(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def week_rows(entries: Sequence[tuple[Mapping[str, Any], Sequence[Mapping[str, Any]], bool]]) -> list[dict[str, Any]]:
    """One prompt row per kept clip of the week: (Clip item, its posts, picked by the owner)."""
    rows = []
    for clip, clip_posts, picked in entries:
        raw_captions = clip.get("captions")
        captions: Mapping[str, Any] = raw_captions if isinstance(raw_captions, Mapping) else {}
        numbers: dict[str, Any] = {}
        total = 0
        for post in clip_posts:
            platform = post.get("platform")
            metrics = post.get("metrics")
            if post.get("status") != "posted" or platform not in WEEK_PLATFORMS or not isinstance(metrics, Mapping):
                continue
            numbers[str(platform)] = {k: _count(metrics.get(k)) for k in ("views", "likes", "comments", "shares")}
            total += _count(metrics.get("views")) or 0
        rows.append(
            {
                "picked": bool(picked),
                "hook": str(clip.get("hook") or ""),
                "momentType": str(clip.get("momentType") or ""),
                "durationSec": clip.get("durationSec"),
                "layout": str(clip.get("layout") or ""),
                "score": clip.get("score"),
                "youtubeTitle": str(captions.get("youtubeTitle") or ""),
                "tiktokCaption": str(captions.get("tiktok") or "")[:CAPTION_CHARS],
                "platforms": {p: numbers[p] for p in WEEK_PLATFORMS if p in numbers},
                "totalViews": total,
            }
        )
    return rows


def ask_week(bedrock: Any, model_id: str, rows: list[dict[str, Any]], *, skills: SkillsBlock) -> tuple[str, str]:
    """(stopReason, the one "Best of week" learning) for the week's prompt rows."""
    picked = sum(1 for r in rows if r.get("picked"))
    user_text = f"This week's kept clips ({picked} picked by the owner):\n" + json.dumps(rows, indent=1)
    return converse_text(
        bedrock, model_id, WEEK_SYSTEM_PROMPT, user_text, max_chars=MAX_WEEK_LEARNING_CHARS, skills=skills
    )
