"""One caption per platform (docs/CONTRACTS.md §5 Captions). Claude writes them; code guarantees the required tags
and each platform's hard limits, and a plain template stands in if Claude fails."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any

from .bedrock import Bedrock, ModelError
from .moments import Moment
from .skills import SkillsBlock
from .util import log

FIELDS = ["youtubeTitle", "youtubeDescription", "instagram", "facebook", "tiktok", "x"]
YOUTUBE_TITLE_MAX = 100
X_MAX = 280
_TAG = re.compile(r"(?<![\w@#])[@#]\w+(?:\.\w+)*")
_REQUIRED_LINE = re.compile(r"(?im)^.*\brequired\s+(?:tags?|hashtags?|mentions?|handles?)\b.*$")

CAPTIONS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["clips"],
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", *FIELDS],
                "properties": {
                    "id": {"type": "string"},
                    "youtubeTitle": {
                        "type": "string",
                        "description": "Shorts title under 60 characters, curiosity first, no hashtags.",
                    },
                    "youtubeDescription": {
                        "type": "string",
                        "description": "1–3 short lines of context, then #shorts and a few relevant hashtags.",
                    },
                    "instagram": {
                        "type": "string",
                        "description": "Reels caption: a curiosity line, 1–2 short lines, then a few hashtags.",
                    },
                    "facebook": {
                        "type": "string",
                        "description": "Reels caption for Facebook: conversational, 1–2 lines, at most 3 hashtags.",
                    },
                    "tiktok": {"type": "string", "description": "Short punchy caption, then a few relevant hashtags."},
                    "x": {
                        "type": "string",
                        "description": "One short line for X, at most 200 characters, at most 2 hashtags.",
                    },
                },
            },
        }
    },
}


@dataclass
class ClipText:
    id: str
    moment: Moment
    said: str


def _tags(text: str) -> list[str]:
    return [m.group(0) for m in _TAG.finditer(text)]


def required_tags(notes: str, skills_text: str = "") -> list[str]:
    """Every @handle and #hashtag in the owner's notes, plus those on "required tags/hashtags" lines of the skills."""
    found = _tags(notes or "")
    for line in _REQUIRED_LINE.findall(skills_text or ""):
        found += _tags(line)
    out: list[str] = []
    for t in found:
        if t.lower() not in (o.lower() for o in out):
            out.append(t)
    return out


def ensure(text: str, required: list[str]) -> str:
    """``text`` with any missing required tag appended (case-insensitive, whole tags only)."""
    out = text.strip()
    have = {t.lower() for t in _tags(out)}
    missing = [r for r in required if r.lower() not in have]
    return f"{out}\n\n{' '.join(missing)}".strip() if missing else out


def fit(text: str, required: list[str], limit: int) -> str:
    """Within ``limit`` characters with every required tag kept: the free text is shortened, never the tags."""
    full = ensure(text, required)
    if len(full) <= limit:
        return full
    tags = " ".join(r for r in required)
    room = max(0, limit - len(tags) - 2)
    body = " ".join(t for t in text.split() if t.lower() not in {r.lower() for r in required})
    body = body if len(body) <= room else body[: max(0, room - 1)].rstrip() + "…"
    return f"{body}\n{tags}".strip()[:limit] if tags else body[:limit]


def title(text: str) -> str:
    t = " ".join(re.sub(r"#\S+", "", text).split())
    return t if len(t) <= YOUTUBE_TITLE_MAX else t[: YOUTUBE_TITLE_MAX - 1].rstrip() + "…"


def finish(raw: dict[str, Any], required: list[str]) -> dict[str, str]:
    desc = str(raw.get("youtubeDescription") or "")
    if not re.search(r"(?i)#shorts\b", desc):
        desc = f"{desc.strip()} #shorts".strip()
    return {
        "youtubeTitle": title(str(raw.get("youtubeTitle") or "")),
        "youtubeDescription": ensure(desc, required)[:5000],
        "instagram": ensure(str(raw.get("instagram") or ""), required)[:2200],
        "facebook": ensure(str(raw.get("facebook") or ""), required)[:5000],
        "tiktok": ensure(str(raw.get("tiktok") or ""), required)[:2200],
        "x": fit(str(raw.get("x") or ""), required, X_MAX),
    }


def template(m: Moment, required: list[str]) -> dict[str, str]:
    """A plain caption from the hook and summary, used when Claude's captions are unavailable."""
    hook = m.hook[:1].upper() + m.hook[1:]
    line = m.summary.strip()
    return finish(
        {
            "youtubeTitle": hook,
            "youtubeDescription": f"{line}\n#shorts",
            "instagram": f"{hook}\n{line}",
            "facebook": f"{hook}. {line}",
            "tiktok": hook,
            "x": hook,
        },
        required,
    )


def prompt(clips: list[ClipText], notes: str) -> str:
    blocks = "\n".join(
        f'<clip id="{c.id}">\nmoment: {c.moment.moment_type} – {c.moment.summary}\nhook on screen: "{c.moment.hook}"\n'
        f"people: {', '.join(c.moment.people) or 'n/a'}\nwhat is said: {c.said[:900]}\n</clip>"
        for c in clips
    )
    return f"""Write platform captions for these short clips: YouTube Shorts (title and description), Instagram Reels,
Facebook Reels, TikTok and X. Follow the owner's skills (curiosity beats description, titles under 60 characters, no
income promises) and any caption rules in the owner's notes. Each platform gets its own wording. Never invent
@handles: only use the ones the owner's notes or skills give. Do not misrepresent what happens. The app adds required
tags itself, but you may place them naturally. Write in the language of the clip.

<owner_notes>{notes or "(none)"}</owner_notes>

{blocks}"""


async def write_captions(
    bedrock: Bedrock,
    clips: list[ClipText],
    *,
    notes: str,
    skills: SkillsBlock,
    skills_text: str,
    system: str,
    answer_seconds: float | None = None,
) -> dict[str, dict[str, str]]:
    """Captions per clip id. Clips Claude leaves out (or all, if it fails or gives no answer within ``answer_seconds``
    seconds) get the template. ``skills`` goes first in the system prompt; ``skills_text`` is every skill's full
    (uncut) text, read for required tags."""
    required = required_tags(notes, skills_text)
    by_id: dict[str, dict[str, Any]] = {}
    if clips:
        try:
            r = await asyncio.wait_for(
                bedrock.structured(
                    system=system,
                    skills=skills,
                    content=[{"text": prompt(clips, notes)}],
                    tool="submit_captions",
                    description="Submit the captions for every clip.",
                    schema=CAPTIONS_SCHEMA,
                ),
                answer_seconds,
            )
            by_id = {str(c["id"]): c for c in r.get("clips") or []}
        except (ModelError, TimeoutError) as e:
            log("warn", "captions.fallback", error=str(e)[:200])
    return {c.id: finish(by_id[c.id], required) if c.id in by_id else template(c.moment, required) for c in clips}
