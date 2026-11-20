"""The viral clip editing skill's clip check (section 8) on every clip: measured checks plus Claude's judgement, one
automatic fix pass, and spare moments replacing clips that still fail."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from . import proc
from .moments import Moment, word_count
from .render import RenderResult

HEAR_DB = -40.0
MOTION = 1.2
_MEAN = re.compile(r"mean_volume:\s*(-?[\d.]+)")

REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "zero_context",
        "zero_context_note",
        "pays_off",
        "pays_off_note",
        "hook_ok",
        "hook_note",
        "new_hook",
        "move_start_by",
        "move_end_by",
        "verdict",
    ],
    "properties": {
        "zero_context": {"type": "boolean", "description": "A stranger understands it within 2 seconds."},
        "zero_context_note": {"type": "string"},
        "pays_off": {
            "type": "boolean",
            "description": "The ending delivers what the opening promised, right on the payoff.",
        },
        "pays_off_note": {"type": "string"},
        "hook_ok": {
            "type": "boolean",
            "description": "Hook is 6–8 words, opens a question, is not a label, is honest.",
        },
        "hook_note": {"type": "string"},
        "new_hook": {
            "type": ["string", "null"],
            "description": "A better 6–8 word hook when hook_ok is false, else null.",
        },
        "move_start_by": {
            "type": "number",
            "description": "Seconds to move the start (positive = later). -5..8, 0 = fine.",
        },
        "move_end_by": {
            "type": "number",
            "description": "Seconds to move the end (negative = sooner). -10..6, 0 = fine. If the clip runs past the "
            "payoff, the negative number that makes the payoff the last thing heard.",
        },
        "verdict": {"type": "string", "enum": ["keep", "fix", "drop"]},
    },
}


@dataclass
class Item:
    key: str
    label: str
    passed: bool
    note: str = ""
    critical: bool = False

    def public(self) -> dict[str, Any]:
        """The ChecklistItem shape (docs/CONTRACTS.md §5)."""
        return {"key": self.key, "label": self.label, "pass": self.passed, "note": self.note}


@dataclass
class Measured:
    first_second_db: float
    motion: float


@dataclass
class Candidate:
    moment: Moment
    render: RenderResult
    items: list[Item] = field(default_factory=list)
    fixes: list[str] = field(default_factory=list)
    index: int = 0  # its folder under clips/; at or past the number of chosen moments means a spare


def measured_items(
    m: Moment, r: RenderResult, x: Measured, length: tuple[float, float], *, has_speech: bool = True
) -> list[Item]:
    """The measured checks. ``has_speech`` is False when no word of the source lies inside the clip (a moment that
    is all picture): then there is nothing to caption, and the captions check passes."""
    lo, hi = length
    hook_words = word_count(m.hook)
    length_ok = lo - 3 <= r.duration <= hi + 4
    return [
        Item(
            "hear",
            "What do they hear in the first second?",
            x.first_second_db > HEAR_DB,
            f"Sound from the first second ({x.first_second_db:.0f} dB)."
            if x.first_second_db > HEAR_DB
            else f"Nearly silent first second ({x.first_second_db:.0f} dB).",
            critical=True,
        ),
        Item(
            "read",
            "What do they read in the first second?",
            6 <= hook_words <= 8,
            f'Hook "{m.hook}" ({hook_words} words).',
        ),
        Item(
            "moving",
            "Is something moving in the first frame?",
            x.motion > MOTION,
            "The opening frame moves." if x.motion > MOTION else "The opening looks still.",
            critical=True,
        ),
        Item("length", f"Clip is {lo:.0f}–{hi:.0f} seconds", length_ok, f"{r.duration:.1f} s."),
        Item(
            "captions",
            "Captions on",
            bool(r.captions) or not has_speech,
            f"{len(r.captions)} caption lines." if r.captions else "No speech to caption.",
        ),
    ]


def judged_items(review: dict[str, Any]) -> list[Item]:
    return [
        Item(
            "zero_context",
            "Makes sense with zero prior context?",
            bool(review.get("zero_context")),
            str(review.get("zero_context_note") or ""),
            critical=True,
        ),
        Item(
            "payoff",
            "Does the ending pay off the opening?",
            bool(review.get("pays_off")),
            str(review.get("pays_off_note") or ""),
            critical=True,
        ),
        Item(
            "hook",
            "Hook opens a question (not a label)?",
            bool(review.get("hook_ok")),
            str(review.get("hook_note") or ""),
        ),
    ]


def plan_fix(
    m: Moment,
    items: list[Item],
    review: dict[str, Any],
    *,
    length: tuple[float, float],
    first_loud: Callable[[float], float],
) -> tuple[Moment, list[str]]:
    """The one fix pass: a later start to open on sound and motion, the reviewer's start/end moves, a new hook.
    Returns the adjusted moment and the fixes in plain words (empty when nothing can be fixed)."""
    failing = {i.key for i in items if not i.passed}
    start, end, hook = m.start, m.end, m.hook
    fixes: list[str] = []
    if failing & {"hear", "moving"}:
        s = first_loud(m.start)
        start = s if s > m.start + 0.1 else m.start + 1.5
        fixes.append(f"Moved the start {start - m.start:.1f} s later to open on action and sound.")
    elif abs(float(review.get("move_start_by") or 0)) >= 0.5:
        d = max(-5.0, min(8.0, float(review["move_start_by"])))
        start = max(0.0, m.start + d)
        fixes.append(f"Moved the start {'later' if d > 0 else 'earlier'} by {abs(d):.1f} s.")
    if abs(float(review.get("move_end_by") or 0)) >= 0.5:
        d = max(-10.0, min(6.0, float(review["move_end_by"])))
        end = m.end + d
        fixes.append(f"Moved the end {'later' if d > 0 else 'sooner'} by {abs(d):.1f} s to land on the payoff.")
    new_hook = " ".join(str(review.get("new_hook") or "").split())
    if failing & {"read", "hook"} and new_hook and 5 <= word_count(new_hook) <= 9:
        hook = new_hook
        fixes.append(f'New hook: "{new_hook}".')
    lo, hi = length
    if end - start > hi:
        end = start + hi
    if end - start < lo - 3:
        end = start + lo
    if not fixes:
        return m, []
    tease = m.tease if m.tease and start <= m.tease[0] and m.tease[1] <= end else None
    peak = min(max(m.peak_at, start), end)
    return replace(m, start=round(start, 2), end=round(end, 2), hook=hook, tease=tease, peak_at=peak), fixes


def critical_failure(items: list[Item]) -> Item | None:
    return next((i for i in items if i.critical and not i.passed), None)


def parse_mean_volume(stderr: str) -> float:
    m = _MEAN.search(stderr)
    return float(m.group(1)) if m else -90.0


def frame_difference(a: bytes, b: bytes) -> float:
    n = min(len(a), len(b))
    return sum(abs(a[i] - b[i]) for i in range(n)) / n if n else 0.0


async def measure(video: Path) -> Measured:
    r = await proc.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-t",
            "1",
            "-i",
            str(video),
            "-vn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        time_limit=120,
    )

    async def gray(at: float) -> bytes:
        g = await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                f"{at}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-vf",
                "scale=72:128,format=gray",
                "-f",
                "rawvideo",
                "-",
            ],
            time_limit=120,
        )
        return g.stdout

    return Measured(parse_mean_volume(r.stderr), frame_difference(await gray(0), await gray(0.4)))


def review_prompt(m: Moment, r: RenderResult, notes: str, seen: str = "") -> str:
    """``seen`` is the picture events inside the clip (signals.seen_block); the block is left out when empty."""
    seen_part = f"\n\nSeen (machine-made picture notes, seconds from the clip's start):\n{seen}" if seen else ""
    said = "\n".join(f"[{c['t0']:.1f}s] {c['text']}" for c in r.captions) or "(no speech)"
    return (
        f"""Run the clip check (the viral clip editing skill's section 8, plus sections 1 and 3) on this finished clip. You can't watch it;
judge from the plan and the timed transcript of the edited clip. Be strict but fair: only ask for a fix that clearly
helps.

<owner_notes>{notes or "(none)"}</owner_notes>

<clip>
moment type: {m.moment_type}
what happens: {m.summary}
why it works: {m.why}
text hook on screen: "{m.hook}"
starts with a payoff tease: {"yes" if r.tease else "no"}
length: {r.duration:.1f} s
payoff at: {m.payoff_at - m.start:.1f} s after the start
</clip>

<edited_clip_transcript>
{said}
</edited_clip_transcript>"""
        + seen_part
    )


@dataclass
class Outcome:
    ok: bool
    candidate: Candidate
    reason: str = ""


async def check_all(
    queue: list[Candidate],
    spares: list[Moment],
    *,
    check: Callable[[Candidate], Awaitable[Outcome]],
    cut: Callable[[Moment], Awaitable[Candidate | None]],
    want: int,
    on_progress: Callable[[int, int], None] | None = None,
    on_swap: Callable[[int], None] | None = None,
    limit: int = 1,
) -> tuple[list[Candidate], list[Outcome]]:
    """Checks every clip, up to ``limit`` at once; each failure brings in the next spare (cut and checked in turn)
    while fewer than ``want`` clips could still pass. Returns the passing clips in order (the clips first, then the
    spares in the order they came in) and every failed outcome. ``on_swap`` gets how many spares are being cut so
    far; ``on_progress`` how many clips are checked out of how many there are now."""
    order = list(queue)
    spare_list = list(spares)
    outcomes: dict[int, Outcome] = {}
    sem = asyncio.Semaphore(max(1, limit))
    swap_lock = asyncio.Lock()  # one spare is cut at a time
    tasks: list[asyncio.Task[None]] = []
    swaps = 0

    def could_pass() -> int:
        return sum(1 for o in outcomes.values() if o.ok) + len(order) - len(outcomes)

    async def run(pos: int) -> None:
        nonlocal swaps
        async with sem:
            out = await check(order[pos])
        outcomes[pos] = out
        if not out.ok:
            async with swap_lock:
                while spare_list and could_pass() < want:
                    swaps += 1
                    if on_swap:
                        on_swap(swaps)
                    replacement = await cut(spare_list.pop(0))
                    if replacement is not None:
                        order.append(replacement)
                        tasks.append(asyncio.create_task(run(len(order) - 1)))
                        break
        if on_progress:
            on_progress(len(outcomes), len(order))

    tasks.extend(asyncio.create_task(run(i)) for i in range(len(order)))
    try:
        i = 0
        while i < len(tasks):  # a spare's check joins the list while earlier ones run
            await tasks[i]
            i += 1
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    ranked = [outcomes[p] for p in range(len(order)) if p in outcomes]
    return [o.candidate for o in ranked if o.ok], [o for o in ranked if not o.ok]
