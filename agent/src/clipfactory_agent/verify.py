"""The second look (docs/DECISIONS.md ADR-40): each picked moment, and each spare, is checked against the picture.

The finder picks from words, sound and picture notes; before anything is cut, Claude sees every 2 fps frame of the
moment (3 seconds before to 3 seconds after) with its words (evenly thinned to what one request may carry, when the
model has refused more: ``Bedrock.image_limit``, shared with the watcher), and may nudge the timing (at most 5 seconds), fix the
hook, or say the moment does not hold up. A moment that does not hold up is swapped for the best spare that does.
Any failure keeps the moment exactly as it was picked."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from typing import Any

from . import picture, transcript
from .bedrock import Bedrock
from .guard import Deadline, GuardTripped, second_look_budget
from .learnings import with_prior
from .moments import Moment, validate
from .skills import SkillsBlock
from .util import JobCanceled, gather_all, hms, log
from .watch import frame_blocks, learn_image_limit, thin_frames, too_big

VERIFY_CONCURRENCY = 4
VERIFY_DEADLINE = 15 * 60
AROUND = 3.0  # seconds of picture shown before and after the moment
MAX_MOVE = 5.0  # a timing change larger than this is ignored

VERIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["keep", "start", "end", "payoff_at", "peak_at", "hook_ok", "new_hook", "picture_score", "seen"],
    "properties": {
        "keep": {"type": "boolean", "description": "False only when the picture shows the moment does not work."},
        "start": {"type": "number", "description": "Clip start in seconds; move it at most 5 s, or repeat it."},
        "end": {"type": "number", "description": "Clip end in seconds, right on the payoff; at most 5 s moved."},
        "payoff_at": {"type": "number", "description": "When the payoff is seen or heard, in seconds."},
        "peak_at": {"type": "number", "description": "The best-looking second (used for the cover image)."},
        "hook_ok": {"type": "boolean", "description": "The hook is honest about what is seen."},
        "new_hook": {"type": ["string", "null"], "description": "A better 6–8 word hook when hook_ok is false."},
        "picture_score": {"type": "number", "description": "1-10: how strong the moment is to watch."},
        "seen": {"type": "string", "description": "One line: what the frames show during the moment."},
    },
}

VERIFY_SYSTEM = """You check one picked clip moment against the picture before it is cut, for Clip Factory. Follow the
owner's skills above (the viral clip editing skill: a stranger gets it in 2 seconds, it pays off, the hook is honest).

You get the frames (up to two per second) from 3 seconds before the moment to 3 seconds after it, each after its time
stamp, then the plan and the words. Decide:
- keep: false only when the picture clearly shows the moment does not work (nothing happens on screen and the words
  do not carry it, a menu or loading screen for most of it, the promised thing is never seen). When unsure, keep.
- start and end: repeat them, or move each by at most 5 seconds so the clip opens on something moving and ends
  right on the payoff. Times are seconds from the start of the video, as stamped.
- payoff_at and peak_at: when the payoff lands, and the best-looking second.
- hook_ok and new_hook: the hook must match what is really seen. If it does not, give a better 6–8 word hook.
- picture_score and seen: how strong it is to watch, and one line on what the frames show.
Words lines may start with "S1:", "S2:": who talks, as guessed from the sound (the numbers are not names)."""


def to_raw(m: Moment) -> dict[str, Any]:
    """A Moment as the dict ``moments.validate`` takes."""
    return {
        "start": m.start,
        "end": m.end,
        "moment_type": m.moment_type,
        "hook": m.hook,
        "first_words": m.first_words,
        "tease_start": m.tease[0] if m.tease else None,
        "tease_end": m.tease[1] if m.tease else None,
        "payoff_at": m.payoff_at,
        "peak_at": m.peak_at,
        "why": m.why,
        "needs_context": False,
        "score": m.score,
        "people": list(m.people),
        "summary": m.summary,
    }


def _near(value: Any, old: float) -> float:
    try:
        new = float(value)
    except (TypeError, ValueError):
        return old
    return new if abs(new - old) <= MAX_MOVE else old


def apply(m: Moment, answer: dict[str, Any], *, duration: float, length: tuple[float, float]) -> Moment:
    """``m`` with the second look's changes: times moved by at most MAX_MOVE seconds, a new hook when the old one
    was not honest. The result goes through ``moments.validate`` again; if that refuses it, ``m`` is returned
    unchanged."""
    raw = to_raw(m)
    raw["start"], raw["end"] = _near(answer.get("start"), m.start), _near(answer.get("end"), m.end)
    for k in ("payoff_at", "peak_at"):
        try:
            v = float(answer.get(k))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if raw["start"] <= v <= raw["end"] + 0.5:
            raw[k] = v
    if not raw["start"] <= raw["payoff_at"] <= raw["end"] + 0.5:
        raw["payoff_at"] = min(max(m.payoff_at, raw["start"]), raw["end"])
    hook = " ".join(str(answer.get("new_hook") or "").split())
    if answer.get("hook_ok") is False and hook:
        raw["hook"] = hook
    fixed, _ = validate(raw, duration=duration, length=length)
    if fixed is None and raw["hook"] != m.hook:
        raw["hook"] = m.hook
        fixed, _ = validate(raw, duration=duration, length=length)
    if fixed is None:
        return m
    return replace(fixed, picked_for=m.picked_for)


def look_text(
    m: Moment, words: Sequence[Sequence[Any]], speakers: Sequence[Sequence[Any]] | None, lo: float, hi: float
) -> str:
    said = transcript.lines(words, lo, hi, speakers) or "(nobody talks here)"
    return f"""Those were the frames of {hms(lo)}–{hms(hi)} ({lo:g} s to {hi:g} s).

<moment>
type: {m.moment_type}
what happens: {m.summary}
why it was picked: {m.why}
text hook on screen: "{m.hook}"
start: {m.start:g} s
end: {m.end:g} s
payoff at: {m.payoff_at:g} s
</moment>

<words>
{said}
</words>"""


def settle(
    chosen: Sequence[Moment],
    spares: Sequence[Moment],
    answers: Sequence[dict[str, Any] | None],
    *,
    duration: float,
    length: tuple[float, float],
    clip_min: int,
) -> tuple[list[Moment], list[Moment], list[dict[str, Any]]]:
    """The final ``(chosen, spares, report)`` from the looks (``answers`` lines up with chosen then spares; None is
    a look that failed). A chosen moment that does not hold up is swapped for the best spare that passed its own
    look; with no such spare it is dropped only while at least ``clip_min`` moments remain."""
    n = len(chosen)
    report: list[dict[str, Any]] = []

    def note(m: Moment, a: dict[str, Any] | None, role: str, result: str, after: Moment | None = None) -> None:
        row: dict[str, Any] = {"start": m.start, "end": m.end, "role": role, "result": result}
        if a is not None:
            row.update(keep=bool(a.get("keep")), pictureScore=a.get("picture_score"), seen=str(a.get("seen") or ""))
        if after is not None and (after.start, after.end, after.hook) != (m.start, m.end, m.hook):
            row["changed"] = {"start": after.start, "end": after.end, "hook": after.hook}
        report.append(row)

    good: list[Moment] = []  # spares that passed their look, best first (the order they came in)
    unseen: list[Moment] = []  # spares whose look failed: still spares, never used for a swap
    for m, a in zip(spares, answers[n:], strict=False):
        if a is None:
            unseen.append(m)
            note(m, a, "spare", "not checked")
        elif a.get("keep") is False:
            note(m, a, "spare", "dropped")
        else:
            fixed = apply(m, a, duration=duration, length=length)
            good.append(fixed)
            note(m, a, "spare", "kept", fixed)

    out: list[Moment] = []
    weak = sum(1 for a in answers[:n] if a is not None and a.get("keep") is False)
    remaining = n
    for m, a in zip(chosen, answers[:n], strict=False):
        if a is None:
            out.append(m)
            note(m, a, "chosen", "not checked")
        elif a.get("keep") is not False:
            fixed = apply(m, a, duration=duration, length=length)
            out.append(fixed)
            note(m, a, "chosen", "kept", fixed)
        elif good:
            out.append(good.pop(0))
            note(m, a, "chosen", "swapped for a spare")
        elif remaining - 1 >= clip_min:
            remaining -= 1
            note(m, a, "chosen", "dropped")
        else:
            out.append(m)  # never fewer than the minimum: a weak clip the owner can decline beats a missing one
            note(m, a, "chosen", "kept (no spare left)")
    if weak:
        log("info", "verify.swapped", weak=weak, chosen=len(out))
    return out, good + unseen, report


async def second_look(
    chosen: Sequence[Moment],
    spares: Sequence[Moment],
    *,
    bedrock: Bedrock,
    skills: SkillsBlock,
    frames: picture.Frames,
    words: Sequence[Sequence[Any]],
    speakers: Sequence[Sequence[Any]] | None,
    duration: float,
    length: tuple[float, float],
    clip_min: int,
    check_cancel: Callable[[], Awaitable[None]],
    on_progress: Callable[[float], None] | None = None,
    deadline_seconds: float = VERIFY_DEADLINE,
    prior: Sequence[str] = (),
) -> tuple[list[Moment], list[Moment], list[dict[str, Any]]]:
    """Looks at every chosen moment and spare, a few at a time. Never raises but for a cancel. It keeps, drops or
    swaps moments and can write a new hook, so it gets "Prior learnings" (``prior``) too (§16.12)."""
    system = with_prior(list(prior), VERIFY_SYSTEM)
    moments = [*chosen, *spares]
    answers: list[dict[str, Any] | None] = [None] * len(moments)
    budget = second_look_budget(len(moments))
    deadline = Deadline(deadline_seconds)
    sem = asyncio.Semaphore(VERIFY_CONCURRENCY)
    done = 0

    async def one(i: int, m: Moment) -> None:
        nonlocal done
        async with sem:
            await check_cancel()
            if deadline.expired:
                return
            lo, hi = max(0.0, m.start - AROUND), min(duration or m.end + AROUND, m.end + AROUND)
            try:
                shown = await frames.between(lo, hi)
                if not shown:
                    raise ValueError("no frames for this moment")
                if bedrock.image_limit and len(shown) > bedrock.image_limit:
                    shown = thin_frames(shown, bedrock.image_limit)
                while True:
                    budget.spend()
                    try:
                        answers[i] = await bedrock.structured(
                            system=system,
                            skills=skills,
                            content=[*frame_blocks(shown), {"text": look_text(m, words, speakers, lo, hi)}],
                            tool="check_moment",
                            description="Report the check of this moment against the picture.",
                            schema=VERIFY_SCHEMA,
                            max_tokens=4000,
                        )
                        break
                    except Exception as e:
                        # Too many images for one request: fewer, evenly spread, and again (each try sends fewer,
                        # so this ends; the budget bounds it too).
                        if not too_big(e) or len(shown) <= 1:
                            raise
                        shown = thin_frames(shown, learn_image_limit(bedrock, e, len(shown)))
            except (JobCanceled, asyncio.CancelledError):
                raise
            except GuardTripped:
                log("warn", "verify.look_failed", start=m.start, error="GuardTripped")
                return
            except Exception as e:
                # Any failure keeps the moment as it was picked.
                log("warn", "verify.look_failed", start=m.start, error=type(e).__name__, detail=str(e)[:300])
        done += 1
        if on_progress:
            on_progress(done / max(1, len(moments)))

    if moments and not deadline.expired:
        try:
            await asyncio.wait_for(gather_all(*(one(i, m) for i, m in enumerate(moments))), deadline.left)
        except TimeoutError:
            log("warn", "deep.deadline", what="second_look", seconds=round(deadline_seconds))
    return settle(chosen, spares, answers, duration=duration, length=length, clip_min=clip_min)
