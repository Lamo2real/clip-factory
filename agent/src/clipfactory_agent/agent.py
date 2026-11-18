"""The clip agent: finds the moments worth clipping.

Main path: the Claude Agent SDK on Bedrock (``CLAUDE_CODE_USE_BEDROCK=1``), with the skills block first in its system
prompt file (docs/CONTRACTS.md §18.6), every skill in ``<workdir>/.claude/skills`` and in-process tools to read the transcript window by window, see the loudness spikes,
read the brief and submit validated moments. Fallback, when the SDK path fails or finds too little: direct Bedrock
Converse over each transcript window with a strict tool schema."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from . import loudness, transcript
from . import signals as signals_mod
from .bedrock import Bedrock, ModelError
from .learnings import Learnings, with_prior
from .learnings import prompt_section as learnings_section
from .moments import CANDIDATES_SCHEMA, MOMENT_SCHEMA, MOMENT_TYPES, Moment, choose, dedupe, spare_count, validate
from .skills import SkillsBlock, compose_system_text
from .util import JobCanceled, UserFacingError, gather_all, hms, log
from .vectors import Hit, prompt_section

SERVER = "clips"
MAX_READ = 35 * 60
SDK_TIMEOUT = 45 * 60  # at least this long, however short the video
# A read turn and a submit turn per 30-minute window, with a growing context; the picture notes make each read longer.
SDK_TIMEOUT_PER_WINDOW = 8 * 60
SDK_EFFORT: Final = "high"  # pinned rather than left to the model default; long-horizon tool use wants at least high
FALLBACK_CONCURRENCY = 3


@dataclass
class Brief:
    title: str
    channel: str
    platform: str
    duration: float
    notes: str
    clip_min: int
    clip_max: int
    length: tuple[float, float]
    words: list[list[Any]]
    loud: list[float]
    heatmap: list[dict[str, float]] = field(default_factory=list)
    prior: list[str] = field(default_factory=list)  # "Prior learnings": active creator lessons (§16.12)
    language: str | None = None
    similar: list[Hit] = field(default_factory=list)  # "what worked before" (S3 Vectors, §14.6)
    week_learnings: list[str] = field(default_factory=list)  # the latest four "Best of week" learnings (§16.7)
    # The deep analysis (docs/DECISIONS.md ADR-40). Both are optional: None means that signal is not there, and
    # with neither every prompt is exactly what it was before the picture was watched.
    signals: signals_mod.Signals | None = None  # picture events, motion and hot spots
    speakers: list[list[Any]] | None = None  # [start, end, "S1"] turns from Transcribe's speaker labels

    @property
    def wanted(self) -> int:
        return self.clip_max + spare_count(self.clip_max)


OPEN_RULE = "- Never open on silence or mumbling: the first words heard must grab attention."
OPEN_RULE_PICTURE = (
    "- Never open on a still, quiet picture: the first second must grab attention, by what is heard or what is seen."
)
PICTURE_RULES = """Picture notes: lines marked (seen) between the transcript lines say what was seen on screen at that
time, with how strong it is to watch (1–10); "Fast picture" lists seconds where the picture changes a lot, and "Hot
spots" are moments where several signals agree. They are machine-made evidence like the loudness spikes, not proof.
A moment may have no talking at all (a crash, a stunt, a glitch, a chase): pick it when the picture carries it. Then
first_words describes the sound heard in the first second, and the hook must match what is seen."""


SPEAKER_NOTE = """Speakers: a transcript line starting "S1:", "S2:" names who talks, as Transcribe guessed it. The
numbers restart every few hours in a long video (so a later S1 may be someone else), and one voice is sometimes split
in two: use them to see back-and-forth, never as names."""


def system_prompt(b: Brief) -> str:
    """The task's own system prompt: "Prior learnings" first (right after the skills block, which every call puts
    first, §18.6, §16.12), then the stable rules, then the owner's best-of-week learnings and similar past clips, so
    prompt caching can reuse the prefix. The picture paragraph (and the opening rule that allows a moment without
    talking) is only there when picture signals are."""
    taught = learnings_section(Learnings(week=b.week_learnings))
    similar = prompt_section(b.similar)
    seen = PICTURE_RULES if b.signals is not None else ""
    who = SPEAKER_NOTE if b.speakers else ""
    return with_prior(b.prior, _rules(b) + "".join(f"\n\n{part}" for part in (seen, who, taught, similar) if part))


def _rules(b: Brief) -> str:
    return f"""You are the clip finder of Clip Factory. You read the transcript of one long video (a stream or a video)
and pick the moments that will make the best vertical short clips (TikTok, Reels, Shorts). Follow the owner's skills
above; the short-form video playbook is the core: section A2 (self-sufficient, built on a feeling, pays off), the six
moment types in A3, the hook rules in A5 and the editing rules in A6.

Rules for every moment:
- moment_type is one of: {", ".join(MOMENT_TYPES)}.
- A stranger understands it within 2 seconds with zero earlier context. If not, do not submit it.
- Start right before the moment (never a minute earlier); end exactly on the payoff.
- Clip length {b.length[0]:.0f}–{b.length[1]:.0f} seconds, not counting the optional payoff tease.
- hook: 6–8 words of on-screen text that open a question ("he thought he got away with it"), never a label
  ("funny moment"). Honest: it must match what happens.
- Payoff tease (optional): 1–2 seconds of the best line from inside the clip, played first (tease_start/tease_end).
{OPEN_RULE_PICTURE if b.signals is not None else OPEN_RULE}
- score 1–10: how likely it is to do well. Be honest; most moments are 4–6, only the best are 8+.
- Respect the owner's notes and skills (required tags, banned topics, brand rules). Never pick content they rule out.
- Times are seconds from the start of the video. Transcript lines are stamped [h:mm:ss].
Loudness spikes (shouting, laughing) and YouTube's "most replayed" peaks are strong hints, not proof."""


def brief_json(b: Brief) -> dict[str, Any]:
    wins = transcript.windows(b.duration)
    out: dict[str, Any] = {
        "video": {"title": b.title, "channel": b.channel, "platform": b.platform, "length": hms(b.duration)},
        "language": b.language,
        "ownerNotes": b.notes or "(none)",
        "clips": {"min": b.clip_min, "max": b.clip_max, "candidatesWanted": b.wanted},
        "clipLengthSeconds": {"min": b.length[0], "max": b.length[1]},
        "transcriptWindows": [{"start": round(s), "end": round(e), "label": f"{hms(s)}–{hms(e)}"} for s, e in wins],
        "wordCount": len(b.words),
    }
    if b.signals is not None:
        out["picture"] = {"watched": b.signals.watched, "coveragePercent": b.signals.coverage_percent}
    return out


def hints(b: Brief, start: float, end: float) -> str:
    sp = loudness.spikes(b.loud, start, end)
    spikes = ", ".join(f"{hms(s.t)} (+{s.jump:.0f} dB)" for s in sp) or "none"
    peaks = sorted((h for h in b.heatmap if start <= h["start"] < end), key=lambda h: -h["value"])[:5]
    text = f"Loudness spikes: {spikes}"
    if peaks:
        text += "\nMost replayed: " + ", ".join(f"{hms(h['start'])}–{hms(h['end'])}" for h in peaks)
    more = signals_mod.extra_hints(b, start, end)
    return f"{text}\n{more}" if more else text


def worth_reading(b: Brief, start: float, end: float, text: str) -> bool:
    """The Converse gate: a window is read when it has enough words, or (new) when the picture alone could carry a
    clip there: a strong picture event or a hot spot with nobody talking."""
    return len(text) >= 400 or (b.signals is not None and b.signals.strong_in(start, end))


class MomentTools:
    """The agent's tools, kept free of the SDK so they can be tested directly."""

    def __init__(self, brief: Brief, on_coverage: Callable[[float], None] | None = None) -> None:
        self.brief = brief
        self.on_coverage = on_coverage
        self.read: list[tuple[float, float]] = []
        self.moments: list[Moment] = []

    def unread(self, windows: list[tuple[float, float]], min_share: float = 0.9) -> list[tuple[float, float]]:
        """The windows the agent did not read (less than ``min_share`` of each was covered by its reads)."""
        out = []
        for ws, we in windows:
            covered, last = 0.0, ws
            for s, e in sorted(self.read):
                begin, end = max(s, last), min(e, we)
                if end > begin:
                    covered += end - begin
                    last = end
            if we > ws and covered < min_share * (we - ws):
                out.append((ws, we))
        return out

    def coverage(self) -> float:
        if self.brief.duration <= 0:
            return 1.0
        covered, last = 0.0, 0.0
        for s, e in sorted(self.read):
            begin = max(s, last)
            if e > begin:
                covered += e - begin
                last = e
        return min(1.0, covered / self.brief.duration)

    def get_brief(self, _: dict[str, Any]) -> tuple[str, bool]:
        return json.dumps(brief_json(self.brief)), False

    def _span(self, args: dict[str, Any]) -> tuple[float, float] | str:
        try:
            start = max(0.0, float(args.get("start", 0)))
            end = min(self.brief.duration, float(args.get("end", start + 1800)))
        except (TypeError, ValueError):
            return "start and end must be numbers of seconds."
        if end <= start:
            return "end must be after start."
        if end - start > MAX_READ:
            return f"Read at most {MAX_READ // 60} minutes at a time."
        return start, end

    def read_transcript(self, args: dict[str, Any]) -> tuple[str, bool]:
        span = self._span(args)
        if isinstance(span, str):
            return span, True
        start, end = span
        self.read.append(span)
        if self.on_coverage:
            self.on_coverage(self.coverage())
        text = signals_mod.timeline(self.brief, start, end) or "(no speech in this part)"
        return f"Transcript {hms(start)}–{hms(end)}\n{hints(self.brief, start, end)}\n\n{text}", False

    def list_spikes(self, args: dict[str, Any]) -> tuple[str, bool]:
        span = self._span({"start": args.get("start", 0), "end": args.get("end", self.brief.duration)})
        if isinstance(span, str):
            start, end = 0.0, self.brief.duration
        else:
            start, end = span
        return hints(self.brief, start, end), False

    def submit_moments(self, args: dict[str, Any]) -> tuple[str, bool]:
        raw = args.get("moments")
        if not isinstance(raw, list):
            return "moments must be a list.", True
        accepted, problems = 0, []
        for i, item in enumerate(raw[:20]):
            m, why = validate(
                item if isinstance(item, dict) else {}, duration=self.brief.duration, length=self.brief.length
            )
            if m is None:
                problems.append(f"#{i}: {'; '.join(why[:4])}")
                continue
            # A corrected resubmission replaces the overlapping earlier one.
            self.moments = [o for o in self.moments if not (o.start < m.end and m.start < o.end)] + [m]
            accepted += 1
        reply = f"Accepted {accepted} of {len(raw)}. You have {len(self.moments)} moments so far."
        if problems:
            reply += " Rejected: " + " | ".join(problems) + ". Fix and resubmit those if they are worth it."
        return reply, accepted == 0 and bool(problems)


TOOL_SPECS: list[tuple[str, str, dict[str, Any]]] = [
    (
        "get_brief",
        "The video, the owner's notes, how many clips to find and the transcript windows to read.",
        {"type": "object", "properties": {}},
    ),
    (
        "read_transcript",
        "Read the transcript between two times (seconds, at most 35 minutes), with loudness spikes and most-replayed peaks.",
        {
            "type": "object",
            "properties": {"start": {"type": "number"}, "end": {"type": "number"}},
            "required": ["start", "end"],
        },
    ),
    (
        "list_spikes",
        "Loudness spikes (shouting, laughing) and most-replayed peaks between two times, or for the whole video.",
        {"type": "object", "properties": {"start": {"type": "number"}, "end": {"type": "number"}}},
    ),
    (
        "submit_moments",
        "Submit candidate moments (validated; the reply says which were accepted and why others were not). "
        "Call it after each window with that window's best 0–6 moments.",
        {
            "type": "object",
            "properties": {"moments": {"type": "array", "items": MOMENT_SCHEMA, "maxItems": 20}},
            "required": ["moments"],
        },
    ),
]


def sdk_timeout(b: Brief) -> float:
    """How long the agent run may take: it reads every window, so it scales with the video's length."""
    return float(max(SDK_TIMEOUT, SDK_TIMEOUT_PER_WINDOW * len(transcript.windows(b.duration))))


def task_prompt(b: Brief) -> str:
    wins = transcript.windows(b.duration)
    return (
        f"Find the best clip moments in this video. Call get_brief first. Then read the transcript window by window "
        f"(all {len(wins)} windows, in order) with read_transcript, and after each window call submit_moments with "
        f"that window's best 0–6 moments. Quality beats quantity, but try to end with at least {b.wanted} good "
        "candidates across the whole video if it has them, in varied moment types. When every window is read and "
        "submitted, reply with one line saying how many moments you submitted."
    )


def sdk_options(
    b: Brief,
    tools: MomentTools,
    *,
    model_id: str,
    region: str,
    workdir: Path,
    skill_names: list[str],
    skills: SkillsBlock,
    on_stderr: Callable[[str], None] | None = None,
) -> Any:
    """The Agent SDK options: our four tools in-process, the skills block first in the system prompt, the skills
    from ``<workdir>/.claude/skills``, nothing else."""
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        PermissionResultAllow,
        PermissionResultDeny,
        create_sdk_mcp_server,
        tool,
    )

    handlers: dict[str, Callable[[dict[str, Any]], tuple[str, bool]]] = {
        "get_brief": tools.get_brief,
        "read_transcript": tools.read_transcript,
        "list_spikes": tools.list_spikes,
        "submit_moments": tools.submit_moments,
    }

    def make(name: str, description: str, schema: dict[str, Any]) -> Any:
        @tool(name, description, schema)
        async def run(args: dict[str, Any]) -> dict[str, Any]:
            text, is_error = handlers[name](args)
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if is_error:
                out["is_error"] = True
            return out

        return run

    server = create_sdk_mcp_server(name=SERVER, version="1.0.0", tools=[make(*spec) for spec in TOOL_SPECS])
    ours = [f"mcp__{SERVER}__{name}" for name, _, _ in TOOL_SPECS]
    home = workdir / "home"
    home.mkdir(parents=True, exist_ok=True)
    # The prompt holds every skill in full and can pass Linux's 128 KiB limit for one argument, so the CLI reads
    # it from a file instead of from argv.
    prompt_file = workdir / "system-prompt.md"
    prompt_file.write_text(compose_system_text(skills, system_prompt(b)), encoding="utf-8")
    env = {
        **os.environ,
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "ANTHROPIC_MODEL": model_id,
        "AWS_REGION": os.environ.get("AWS_REGION") or region,
        "HOME": str(home),  # an empty home: nothing under ~/.claude adds skills or settings
        "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS": "1",
        "CLAUDE_CODE_DISABLE_POLICY_SKILLS": "1",
    }

    async def can_use_tool(name: str, _input: dict[str, Any], _ctx: Any) -> Any:
        # Only our tools and the owner's skills; never shell, files or the web.
        if name in ours or name == "Skill":
            return PermissionResultAllow()
        return PermissionResultDeny(message=f"{name} is not available here. Use the clip tools.")

    return ClaudeAgentOptions(
        model=model_id,
        system_prompt={"type": "file", "path": str(prompt_file)},
        effort=SDK_EFFORT,
        mcp_servers={SERVER: server},
        tools=["Skill"] if skill_names else [],
        allowed_tools=ours,
        skills=skill_names,
        setting_sources=["project"],  # loads <workdir>/.claude/skills; the workdir has no settings files
        cwd=str(workdir),
        env=env,
        can_use_tool=can_use_tool,
        max_turns=120,
        stderr=on_stderr,
    )


async def find_with_sdk(
    b: Brief,
    tools: MomentTools,
    *,
    model_id: str,
    region: str,
    workdir: Path,
    skill_names: list[str],
    skills: SkillsBlock,
) -> list[Moment]:
    from claude_agent_sdk import ResultMessage, query

    stderr_tail: list[str] = []

    def on_stderr(line: str) -> None:
        stderr_tail.append(line.rstrip()[:400])
        del stderr_tail[:-20]

    options = sdk_options(
        b,
        tools,
        model_id=model_id,
        region=region,
        workdir=workdir,
        skill_names=skill_names,
        skills=skills,
        on_stderr=on_stderr,
    )

    # can_use_tool needs streaming input: the prompt goes in as one user message on a stream.
    async def prompt() -> AsyncIterator[dict[str, Any]]:
        yield {"type": "user", "message": {"role": "user", "content": task_prompt(b)}}

    try:
        async for msg in query(prompt=prompt(), options=options):
            if isinstance(msg, ResultMessage) and (msg.subtype != "success" or getattr(msg, "is_error", False)):
                raise ModelError(f"agent run ended with {msg.subtype}: {str(msg.result or '')[:300]}")
    except Exception as e:
        tail = " | ".join(stderr_tail[-8:])
        raise ModelError(f"{type(e).__name__}: {e}" + (f" (CLI: {tail})" if tail else "")) from e
    return tools.moments


async def find_with_converse(
    b: Brief,
    bedrock: Bedrock,
    on_progress: Callable[[float], None] | None = None,
    windows: list[tuple[float, float]] | None = None,
    *,
    skills: SkillsBlock,
) -> list[Moment]:
    """The fallback: one strict structured call per transcript window (all of them, or just ``windows``), a few at
    a time."""
    system = system_prompt(b)
    wins = transcript.windows(b.duration) if windows is None else windows
    if not wins:
        return []
    sem = asyncio.Semaphore(FALLBACK_CONCURRENCY)
    done = 0
    found: list[Moment] = []
    answered = 0
    errors: list[Exception] = []

    async def one(start: float, end: float) -> None:
        nonlocal done, answered
        text = signals_mod.timeline(b, start, end)
        if worth_reading(b, start, end, transcript.lines(b.words, start, end, b.speakers)):
            async with sem:
                prompt = (
                    f"Video: {b.title!r} by {b.channel or 'unknown'} ({b.platform}). This part covers "
                    f"{hms(start)}–{hms(end)} of {hms(b.duration)}.\nOwner's notes: {b.notes or '(none)'}\n"
                    f"{hints(b, start, end)}\n\nReturn the best 0–6 moments in this part; quality beats quantity."
                    f"\n\n<transcript>\n{text}\n</transcript>"
                )
                r: dict[str, Any] | None = None
                try:
                    r = await bedrock.structured(
                        system=system,
                        skills=skills,
                        content=[{"text": prompt}],
                        tool="submit_moments",
                        description="Submit the best clip moments in this part of the video.",
                        schema=CANDIDATES_SCHEMA,
                    )
                except JobCanceled:
                    raise
                except ModelError as e:
                    # A bad answer is still an answer: this window just has no moments.
                    log("warn", "moments.window_failed", start=start, error=type(e).__name__, detail=str(e)[:200])
                    r = {"candidates": []}
                except Exception as e:
                    # A busy or failing service (max_tokens, throttling that outlasted the retries) loses only this
                    # window; it never stops the other windows or re-runs the whole search on its own.
                    log("warn", "moments.window_failed", start=start, error=type(e).__name__, detail=str(e)[:200])
                    errors.append(e)
                if r is not None:
                    answered += 1
                    for c in r.get("candidates") or []:
                        m, _ = validate(c, duration=b.duration, length=b.length)
                        if m:
                            found.append(m)
        done += 1
        if on_progress:
            on_progress(done / len(wins))

    # Anything that still escapes (a cancel) stops the other windows instead of leaving them running.
    await gather_all(*(one(s, e) for s, e in wins))
    if errors and not answered:
        # Every window failed with a service error: the model is down or busy, not the video. Raising lets the step
        # retry and then say "a service was busy", instead of blaming the video with "no clip-worthy moments".
        raise errors[0]
    return found


async def find_moments(
    b: Brief,
    *,
    bedrock: Bedrock,
    model_id: str,
    region: str,
    workdir: Path,
    skill_names: list[str],
    skills: SkillsBlock,
    on_progress: Callable[[float], None],
    use_sdk: bool = True,
) -> tuple[list[Moment], list[Moment]]:
    """``(chosen, spares)``. The SDK agent first; Converse covers the windows it did not read (it failed, ran out of
    time, or ended early with a success result), and the whole video when that still leaves fewer than the minimum."""

    async def converse_more(have: list[Moment], *, windows: list[tuple[float, float]]) -> list[Moment]:
        """Converse over ``windows``. When every window fails (the model is down) and moments are already in hand,
        those still make clips; with none in hand the error is raised so the step retries."""
        try:
            return await find_with_converse(
                b, bedrock, on_progress=lambda f: on_progress(0.9 * f), windows=windows, skills=skills
            )
        except JobCanceled:
            raise
        except Exception as e:
            if not have:
                raise
            log("warn", "agent.converse_failed", error=type(e).__name__, kept=len(have))
            return []

    moments: list[Moment] = []
    wins = transcript.windows(b.duration)
    todo = wins
    if use_sdk:
        tools = MomentTools(b, on_coverage=lambda c: on_progress(0.9 * c))
        try:
            moments = await asyncio.wait_for(
                find_with_sdk(
                    b,
                    tools,
                    model_id=model_id,
                    region=region,
                    workdir=workdir,
                    skill_names=skill_names,
                    skills=skills,
                ),
                sdk_timeout(b),
            )
        except (Exception, TimeoutError) as e:
            moments = list(tools.moments)  # whatever it submitted before failing still counts
            log("warn", "agent.sdk_failed", error=type(e).__name__, detail=str(e)[:800], kept=len(moments))
        # Whether the run failed, ran out of time or simply decided it was done, the windows it never read are
        # still to be read.
        unread = tools.unread(wins)
        if unread:
            # A run that stopped partway never leaves the rest of the video unseen: those windows go through Converse.
            log("info", "agent.converse_unread", windows=len(unread), of=len(wins), have=len(moments))
            moments += await converse_more(moments, windows=unread)
        todo = [w for w in wins if w not in unread]
    if len(dedupe(moments)) < b.clip_min and todo:
        log("info", "agent.converse_fallback", have=len(moments))
        moments += await converse_more(moments, windows=todo)
    chosen, spares = choose(moments, b.clip_min, b.clip_max)
    if not chosen:
        raise UserFacingError(
            "No clip-worthy moments were found in this video. Try a video with more talking and reactions, "
            "or add notes about what to look for."
        )
    on_progress(1.0)
    return chosen, spares
