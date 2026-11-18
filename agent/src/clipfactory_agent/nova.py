"""The second, independent watcher: Amazon Nova 2 Lite on real video (docs/DECISIONS.md ADR-40).

Nova gets each 300-second part as a video (it samples one frame a second itself) through the EU inference profile,
on its own ``Bedrock`` client. It fills the gaps where Fable refuses or is throttled, and where both saw the same
thing the hot spot is stronger. It is optional twice over: with no watch model configured the track is skipped, and
if the model is denied or missing the track stops at the first such answer and nothing else changes."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from .bedrock import Bedrock
from .guard import CallBudget, Deadline
from .picture import PART_MAX_BYTES, Part
from .skills import SkillsBlock
from .util import hms
from .watch import SCENES_SCHEMA, TOOL, TOOL_DESCRIPTION, WATCH_SYSTEM, Pacer, TrackResult, Unit, clean, run_track

NOVA_CONCURRENCY = 4
# Nova's limit for video sent inside the request is 25 MB. boto3 sends the bytes base64-encoded (4/3 larger), and
# the guide does not say which size counts, so parts are kept to what fits even when encoded (picture.PART_MAX_BYTES).
NOVA_MAX_BYTES = 25 * 1024 * 1024
_STOP_CODES = {
    "AccessDeniedException": "denied",
    "ResourceNotFoundException": "not_found",
    "UnrecognizedClientException": "denied",
}
MAX_INVALID = 3  # this many requests in a row refused as invalid, with none accepted: the model does not take them

NOVA_SYSTEM = (
    WATCH_SYSTEM
    + """

This time you get the part as one video, without sound and without time stamps. Give start and end in seconds from
the start of THIS video clip (0 is its first frame)."""
)


class TooBig(Exception):
    """The part is larger than Nova takes in one request."""


def units(parts: Sequence[Part]) -> list[Unit]:
    return [Unit(p.i, p.start, p.end, p.start) for p in parts]


def part_text(part: Part) -> str:
    return (
        f"This video clip is {part.end - part.start:.0f} seconds long. It is the part of a longer video that starts at "
        f"{hms(part.start)}. Report what is seen, with start and end in seconds from the start of this clip "
        f"(0 to {part.end - part.start:.0f})."
    )


async def watch_parts(
    parts: Sequence[Part],
    *,
    bedrock: Bedrock | None,
    skills: SkillsBlock,
    read: Callable[[Part], Awaitable[bytes]],
    budget: CallBudget,
    deadline: Deadline,
    check_cancel: Callable[[], Awaitable[None]],
    load: Callable[[Unit], Awaitable[dict[str, Any] | None]] | None = None,
    save: Callable[[Unit, dict[str, Any]], Awaitable[None]] | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> TrackResult:
    """Nova watches every part. With no client (no watch model configured) nothing is called at all."""
    if bedrock is None:
        return TrackResult("nova", [], stopped="no watch model")
    by_index = {p.i: p for p in parts}
    state = {"invalid": 0, "ok": 0}
    pacer = Pacer(NOVA_CONCURRENCY)

    def fatal(e: BaseException) -> str | None:
        response = getattr(e, "response", None)
        code = str((response.get("Error") or {}).get("Code") or "") if isinstance(response, dict) else ""
        if code in _STOP_CODES:
            return _STOP_CODES[code]
        if code == "ValidationException":
            state["invalid"] += 1
            if state["invalid"] >= MAX_INVALID and not state["ok"]:
                return "invalid"
        return None

    async def look(u: Unit) -> dict[str, Any]:
        part = by_index[u.i]
        video = await read(part)
        if len(video) > NOVA_MAX_BYTES:
            raise TooBig(f"part {part.i} is {len(video)} bytes (the part target is {PART_MAX_BYTES})")
        raw = await pacer.call(
            lambda: bedrock.structured(
                system=NOVA_SYSTEM,
                skills=skills,
                content=[{"video": {"format": "mp4", "source": {"bytes": video}}}, {"text": part_text(part)}],
                tool=TOOL,
                description=TOOL_DESCRIPTION,
                schema=SCENES_SCHEMA,
                max_tokens=8000,
            ),
            budget,
        )
        state["ok"] += 1
        return clean(raw, part.start, part.end, offset=part.start)

    return await run_track(
        "nova",
        units(parts),
        look,
        concurrency=NOVA_CONCURRENCY,
        deadline=deadline,
        check_cancel=check_cancel,
        load=load,
        save=save,
        on_progress=on_progress,
        fatal=fatal,
    )
