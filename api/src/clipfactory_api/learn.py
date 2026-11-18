"""Learnings: the shared model helper and the weekly "Best of week" learning (docs/CONTRACTS.md §13, §16.6).

The one-sentence 48-hour learning (the clip flow's old ``distil``) is retired (§16.12, ADR-41): creator lessons from
day-7 numbers (``lessons.py``, ``daily.py``) took its place. Older 48-hour learnings stay readable on Insights.
A weekly learning is only written when the model finished its answer (``end_turn``) and there is text.

Every model call goes through ``converse_text``, which puts the owner's skills block first in the system prompt
(§18.6): it is the only place in this package that calls ``.converse(``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .skill_prompt import SkillsBlock, compose_system, is_cache_point_error, turn_cache_points_off

Item = dict[str, Any]

# Claude Fable 5.1 always thinks and thinking tokens count against maxTokens, so the cap leaves room for the
# reasoning as well as the one-sentence answer; low effort keeps this small task short. Fable rejects temperature,
# top_p and top_k together with these settings, so none of them is sent.
MAX_TOKENS = 4000
EFFORT = "low"
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


def public_learning(item: Mapping[str, Any]) -> Item:
    """The Learning shape of §5 (used by GET /v1/insights and the live updates)."""
    return {k: item[k] for k in LEARNING_FIELDS if k in item}


def converse_text(
    bedrock: Any,
    model_id: str,
    system: str,
    user_text: str,
    *,
    max_chars: int,
    skills: SkillsBlock,
    max_tokens: int = MAX_TOKENS,
    request_fields: Mapping[str, Any] | None = None,
    output_config: Mapping[str, Any] | None = None,
    on_response: Callable[[Mapping[str, Any]], None] | None = None,
) -> tuple[str, str]:
    """One Converse call with the owner's skills block first in the system prompt. Returns (stopReason, answer
    text). Reasoning blocks (``reasoningContent``) are not part of the answer. When Bedrock refuses the cache point,
    cache points are turned off for this process and the call is sent again without it.

    The defaults are the shared Fable 5.1 settings (maxTokens 4000, effort low, no sampling parameters). Ask Clip
    Factory (§19.5) passes its own ``max_tokens``, ``request_fields`` and JSON-schema ``output_config``, and reads
    the token usage through ``on_response``."""
    fields = dict(request_fields) if request_fields is not None else {"output_config": {"effort": EFFORT}}
    extra: dict[str, Any] = {"outputConfig": dict(output_config)} if output_config is not None else {}

    def send() -> Any:
        return bedrock.converse(
            modelId=model_id,
            system=compose_system(skills, system),
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": max_tokens},
            additionalModelRequestFields=fields,
            **extra,
        )

    try:
        out = send()
    except Exception as e:
        if not is_cache_point_error(e):
            raise
        turn_cache_points_off()
        out = send()
    if on_response is not None:
        on_response(out)
    stop_reason = str(out.get("stopReason") or "")
    blocks = out.get("output", {}).get("message", {}).get("content", [])
    text = " ".join(b["text"] for b in blocks if isinstance(b, dict) and isinstance(b.get("text"), str))
    text = " ".join(text.split()).strip().strip('"')
    return stop_reason, text[:max_chars]


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
