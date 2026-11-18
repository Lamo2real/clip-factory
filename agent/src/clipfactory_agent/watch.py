"""Watching the whole picture with Claude Fable (docs/DECISIONS.md ADR-40).

The source is cut into chunks of 150 seconds (each starts 6 seconds early, so nothing is lost on a boundary). For
every chunk Fable gets one frame per two seconds, every frame around the loudest and fastest seconds, and that
chunk's words, and reports what is seen as events. Each answer is saved at once (``watch/chunk-NNNN.json``), so a
retried job only watches what is missing.

``run_track`` is the one loop both watchers use (Nova in nova.py): a few units at a time, a call budget and a deadline
(guard.py), and never an error that fails the job. A busy service is waited out, not given up on: a unit it turned
away is tried again after a growing pause (up to MAX_TRIES times, inside the deadline), and every call goes through a
``Pacer`` that halves the calls in flight when the service throttles and adds them back as calls succeed.

Bedrock may refuse a request for carrying too many images. Then the chunk is split, again and again if needed, and
the number the model took is remembered on the client (``Bedrock.image_limit``), so every later chunk and the second
look are sent at that size from the start."""

from __future__ import annotations

import asyncio
import math
import random
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from . import loudness, picture, transcript
from .bedrock import Bedrock, ModelError
from .guard import CallBudget, Deadline, GuardTripped, chunk_count
from .retry import is_transient
from .skills import SkillsBlock
from .util import JobCanceled, gather_all, hms, log

CHUNK_SECONDS = 150
CHUNK_OVERLAP = 6
WATCH_CONCURRENCY = 8
FRAME_EVERY = 2.0  # seconds between the regular frames
BURST_SPIKES = 5
BURST_AROUND = 3.0  # every frame this close to a spike
BURST_MAX = 30
MAX_FRAMES = math.ceil((CHUNK_SECONDS + CHUNK_OVERLAP) / FRAME_EVERY) + BURST_MAX  # the most one chunk shows: 108
MAX_TRIES = 6  # a unit a busy service turned away is tried this often in all, with growing pauses
RETRY_BASE = 5.0  # seconds before the second try; doubled each time
RETRY_CAP = 60.0
MAX_EVENTS = 12
MAX_WHAT_WORDS = 25
KINDS = [
    "crash",
    "explosion",
    "chase",
    "stunt",
    "fight",
    "fail",
    "win",
    "glitch",
    "jump_scare",
    "death_screen",
    "funny_visual",
    "face_reaction",
    "on_screen_text",
    "menu_or_loading",
    "calm",
    "other",
]
FACES = ["none", "calm", "laughing", "shocked", "angry", "scared"]
TOOL = "report_scenes"
TOOL_DESCRIPTION = "Report what is seen in this part of the video."

SCENES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["scene", "events"],
    "properties": {
        "scene": {"type": "string", "description": "One line: what this part of the video shows overall."},
        "events": {
            "type": "array",
            "maxItems": MAX_EVENTS,
            "description": "The things worth knowing about, strongest first. Empty when nothing happens.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["start", "end", "kind", "what", "intensity", "silent", "face", "text_on_screen"],
                "properties": {
                    "start": {"type": "number", "description": "When it starts, in seconds, as stamped on the frames."},
                    "end": {"type": "number", "description": "When it ends, in seconds."},
                    "kind": {"type": "string", "enum": KINDS},
                    "what": {"type": "string", "description": "What is seen, in at most 25 plain words."},
                    "intensity": {
                        "type": "number",
                        "description": "1-10: how strong it is to watch. Most are 3-5; only the best are 8+.",
                    },
                    "silent": {"type": "boolean", "description": "True when nobody is talking while it happens."},
                    "face": {
                        "type": "string",
                        "enum": FACES,
                        "description": "The streamer's face in the facecam during it; none when there is no face.",
                    },
                    "text_on_screen": {
                        "type": "string",
                        "description": 'Big text shown by the game or stream ("WASTED", "VICTORY"), else empty.',
                    },
                },
            },
        },
    },
}

WATCH_SYSTEM = """You watch one part of a long video (a stream or a recording, often gameplay with a small facecam)
for Clip Factory's clip finder. The finder reads the words; you are its eyes. Report what is SEEN that a short
vertical clip could be built on, following the owner's skills above for what makes a good moment.

Rules:
- Report events, not a frame-by-frame description: a crash, an explosion, a chase, a stunt, a fight, a fail, a win, a
  glitch, a jump scare, a death screen, something funny to look at, a strong face in the facecam, big text on screen.
- Moments with nobody talking matter most: the finder cannot find those from the words. Set silent=true for them.
- start and end are seconds from the start of the whole video, exactly as stamped before each frame. Keep an event
  as short as what happens (usually 2-20 seconds).
- intensity 1-10 is how strong it is to WATCH. Be honest: driving around is 2, a near miss is 5, a huge crash or a
  perfect stunt is 9. Calm stretches, menus and loading screens are 1-3 (or leave them out).
- face is the streamer's face in the facecam during the event; "none" when there is no facecam or no face.
- Say only what the frames show. Never guess what happens between or after them, and never name real people.
- Words lines may start with "S1:", "S2:": who talks, as guessed from the sound (the numbers are not names).
- At most 12 events, strongest first. An empty list is a fine answer for a part where nothing happens."""


@dataclass(frozen=True)
class Unit:
    """One piece of the source a watcher looks at in one call: frames from ``lead``, events for ``start..end``."""

    i: int
    start: float
    end: float
    lead: float = 0.0


def plan(seconds: float) -> list[Unit]:
    """The chunks covering ``seconds``. Computed before the first call; never more than guard.MAX_CHUNKS."""
    out: list[Unit] = []
    for i in range(chunk_count(seconds, CHUNK_SECONDS)):
        start = float(i * CHUNK_SECONDS)
        out.append(Unit(i, start, min(seconds, start + CHUNK_SECONDS), max(0.0, start - CHUNK_OVERLAP)))
    return out


def spike_times(loud: list[float], motion: list[float], lo: float, hi: float) -> list[float]:
    """The up to BURST_SPIKES loudest or fastest seconds in ``lo..hi``, strongest first."""
    found = [(min(s.jump / 7, 2.0), float(s.t)) for s in loudness.spikes(loud, lo, hi, limit=BURST_SPIKES)]
    found += [(min(s.lift / 2.5, 2.0), float(s.t)) for s in picture.motion_spikes(motion, lo, hi, limit=BURST_SPIKES)]
    out: list[float] = []
    for _, t in sorted(found, reverse=True):
        if all(abs(t - o) > BURST_AROUND for o in out):
            out.append(t)
    return out[:BURST_SPIKES]


def frame_times(lo: float, hi: float, spikes: Sequence[float]) -> list[float]:
    """Which frames of ``lo..hi`` to send: one per FRAME_EVERY seconds, plus every half-second frame within
    BURST_AROUND seconds of each spike, at most BURST_MAX extra (the ones nearest their spike first)."""
    base: list[float] = []
    t = picture.grid(lo)
    while t < hi:
        base.append(t)
        t += FRAME_EVERY
    have = set(base)
    extra: list[tuple[float, float]] = []
    for s in list(spikes)[:BURST_SPIKES]:
        t = max(picture.grid(lo), picture.grid(s - BURST_AROUND))
        while t <= s + BURST_AROUND and t < hi:
            if t not in have:
                have.add(t)
                extra.append((abs(t - s), t))
            t += 1 / picture.FPS
    return sorted(base + [t for _, t in sorted(extra)[:BURST_MAX]])


def pick_frames(frames: Sequence[tuple[float, bytes]], wanted: Sequence[float]) -> list[tuple[float, bytes]]:
    by_time = {picture.grid(t): jpeg for t, jpeg in frames}
    return [(t, by_time[t]) for t in wanted if t in by_time]


def stamp(t: float) -> str:
    """``[1:02:11] 3731 s``: the clock time to read, and the seconds to answer with."""
    return f"[{hms(int(t))}] {t:g} s"


def frame_blocks(frames: Sequence[tuple[float, bytes]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t, jpeg in frames:
        out.append({"text": stamp(t)})
        out.append({"image": {"format": "jpeg", "source": {"bytes": jpeg}}})
    return out


def chunk_text(
    lo: float,
    hi: float,
    *,
    words: Sequence[Sequence[Any]],
    speakers: Sequence[Sequence[Any]] | None,
    loud: list[float],
    motion: list[float],
) -> str:
    said = transcript.lines(words, lo, hi, speakers) or "(nobody talks in this part)"
    sp = loudness.spikes(loud, lo, hi)
    fast = picture.motion_spikes(motion, lo, hi)
    return (
        f"Those were the frames of {hms(lo)}–{hms(hi)} ({lo:g} s to {hi:g} s), each after its time stamp.\n\n"
        f"<words>\n{said}\n</words>\n"
        f"Loud seconds: {', '.join(f'{s.t} s (+{s.jump:.0f} dB)' for s in sp) or 'none'}\n"
        f"Fast picture: {', '.join(f'{s.t} s (x{s.lift:.0f})' for s in fast) or 'none'}\n\n"
        f"Report what is seen. Every start and end must lie between {lo:g} and {hi:g} seconds."
    )


def clean(raw: dict[str, Any], lo: float, hi: float, offset: float = 0.0) -> dict[str, Any]:
    """The model's answer as checkpoint content: times shifted by ``offset`` and clamped to ``lo..hi``, at most
    MAX_EVENTS events, and calm or menu events below intensity 4 dropped."""
    events: list[dict[str, Any]] = []
    for e in (raw.get("events") or [])[:MAX_EVENTS]:
        if not isinstance(e, dict):
            continue
        try:
            t0, t1 = float(e.get("start", 0)) + offset, float(e.get("end", 0)) + offset
            intensity = max(1, min(10, round(float(e.get("intensity", 1)))))
        except (TypeError, ValueError):
            continue
        t0 = min(max(t0, lo), hi)
        t1 = min(max(t1, t0), hi)
        kind = str(e.get("kind"))
        kind = kind if kind in KINDS else "other"
        if kind in ("calm", "menu_or_loading") and intensity < 4:
            continue
        face = str(e.get("face"))
        events.append(
            {
                "t0": round(t0, 1),
                "t1": round(t1, 1),
                "kind": kind,
                "what": " ".join(str(e.get("what") or "").split()[:MAX_WHAT_WORDS]),
                "intensity": intensity,
                "silent": bool(e.get("silent")),
                "face": face if face in FACES else "none",
                "text": " ".join(str(e.get("text_on_screen") or "").split())[:120],
            }
        )
    return {"scene": " ".join(str(raw.get("scene") or "").split())[:300], "events": events}


# --- the loop both watchers share ----------------------------------------------------------------------------------

_THROTTLE_CODES = {
    "ThrottlingException",
    "Throttling",
    "TooManyRequestsException",
    "ServiceQuotaExceededException",
}


def throttled(e: BaseException) -> bool:
    """The service turned the call away because the account is over its rate (after retry.py's own tries)."""
    response = getattr(e, "response", None)
    if not isinstance(response, dict):
        return False
    code = str((response.get("Error") or {}).get("Code") or "")
    status = int((response.get("ResponseMetadata") or {}).get("HTTPStatusCode") or 0)
    return code in _THROTTLE_CODES or status == 429


class Pacer:
    """How many model calls one track keeps in flight. It starts at ``most``. A throttle that outlasted the retries
    halves it (never below 1); after as many successes in a row as calls in flight, one more is allowed again (never
    above ``most``). So a busy account is met with fewer calls at once instead of lost chunks."""

    def __init__(self, most: int) -> None:
        self.most = max(1, most)
        self.limit = self.most
        self.busy = 0
        self._streak = 0
        self._wake = asyncio.Event()

    async def call[T](self, fn: Callable[[], Awaitable[T]], budget: CallBudget | None = None) -> T:
        """Runs ``fn`` when a slot is free. ``budget`` is spent first and refunded if the call was throttled."""
        if budget is not None:
            budget.spend()
        while self.busy >= self.limit:
            self._wake.clear()
            await self._wake.wait()
        self.busy += 1
        try:
            out = await fn()
        except Exception as e:
            if throttled(e):
                if budget is not None:
                    budget.refund()
                self.slow_down()
            raise
        finally:
            self.busy -= 1
            self._wake.set()
        self._streak += 1
        if self._streak >= self.limit and self.limit < self.most:
            self.limit += 1
            self._streak = 0
        return out

    def slow_down(self) -> None:
        old, self.limit, self._streak = self.limit, max(1, self.limit // 2), 0
        if self.limit != old:
            log("warn", "deep.slow_down", calls_in_flight=self.limit)


@dataclass
class TrackResult:
    name: str
    units: list[Unit]
    done: dict[int, dict[str, Any]] = field(default_factory=dict)  # unit index -> checkpoint
    failed: dict[int, str] = field(default_factory=dict)  # unit index -> reason
    stopped: str | None = None  # the whole track stopped early: "guard", "denied", ...
    reused: int = 0

    @property
    def ok(self) -> list[dict[str, Any]]:
        return [self.done[i] for i in sorted(self.done)]

    def failures(self) -> list[dict[str, Any]]:
        by = {u.i: u for u in self.units}
        return [
            {"start": by[i].start, "end": by[i].end, "src": self.name, "reason": why}
            for i, why in sorted(self.failed.items())
        ]

    @property
    def status(self) -> dict[str, Any]:
        if not self.units:
            return {"status": "skipped", "reason": self.stopped or "nothing to watch"}
        if len(self.done) == len(self.units):
            return {"status": "ok"}
        reasons = sorted(set(self.failed.values())) or [self.stopped or "unknown"]
        if not self.done:
            return {"status": "skipped", "reason": ", ".join(reasons)}
        return {"status": "partial", "reason": ", ".join(reasons), "done": len(self.done), "of": len(self.units)}


def too_big(e: BaseException) -> bool:
    """Bedrock refused the request for its images or its size (not for anything a retry would fix)."""
    response = getattr(e, "response", None)
    if not isinstance(response, dict) or (response.get("Error") or {}).get("Code") != "ValidationException":
        return False
    msg = str(e).lower()
    return any(w in msg for w in ("image", "too large", "too long", "too many", "size", "exceed"))


def learn_image_limit(bedrock: Bedrock, e: BaseException, sent: int) -> int:
    """After a refusal of ``sent`` images: the number the error names ("up to 20 images"), else half of ``sent``.
    Kept on the client (only ever lowered) and returned; always below ``sent``, so splitting always ends."""
    named = [int(n) for n in re.findall(r"(\d+)\s*images?", str(e), flags=re.IGNORECASE)]
    fit = [n for n in named if 0 < n < sent]
    new = max(fit) if fit else max(1, sent // 2)
    if bedrock.image_limit is None or new < bedrock.image_limit:
        bedrock.image_limit = new
        log("warn", "bedrock.image_limit", model=bedrock.model_id, images=new, refused=sent)
    return min(bedrock.image_limit, new)


def split_frames[F](frames: Sequence[F], limit: int) -> list[list[F]]:
    """``frames`` in order, as the fewest near-equal groups of at most ``limit``."""
    n = math.ceil(len(frames) / max(1, limit))
    size, extra = divmod(len(frames), max(1, n))
    out: list[list[F]] = []
    at = 0
    for k in range(n):
        take = size + (1 if k < extra else 0)
        out.append(list(frames[at : at + take]))
        at += take
    return [g for g in out if g]


def thin_frames[F](frames: Sequence[F], limit: int) -> list[F]:
    """At most ``limit`` of ``frames``, evenly spread, the first and last kept."""
    if len(frames) <= limit:
        return list(frames)
    if limit <= 1:
        return [frames[len(frames) // 2]]
    return [frames[round(k * (len(frames) - 1) / (limit - 1))] for k in range(limit)]


def checkpoint(u: Unit, body: dict[str, Any]) -> dict[str, Any]:
    return {"i": u.i, "start": u.start, "end": u.end, "ok": True, **body}


async def run_track(
    name: str,
    units: Sequence[Unit],
    work: Callable[[Unit], Awaitable[dict[str, Any]]],
    *,
    concurrency: int,
    deadline: Deadline,
    check_cancel: Callable[[], Awaitable[None]],
    load: Callable[[Unit], Awaitable[dict[str, Any] | None]] | None = None,
    save: Callable[[Unit, dict[str, Any]], Awaitable[None]] | None = None,
    on_progress: Callable[[float], None] | None = None,
    fatal: Callable[[BaseException], str | None] | None = None,
) -> TrackResult:
    """Runs ``work`` for every unit, ``concurrency`` units at a time, and never raises anything but a cancel.

    A unit already saved by an earlier run is reused. A failure that is the service being busy (after retry.py gave
    up) is tried again after a growing pause, up to MAX_TRIES times in all, while the deadline allows; the unit gives
    its place to others while it waits. A refusal or a wrong answer (ModelError) is not tried again. ``fatal`` names
    failures that stop the whole track (the model is not allowed here). A tripped guard stops the track too.
    Whatever is done by then is kept."""
    res = TrackResult(name, list(units))
    sem = asyncio.Semaphore(max(1, concurrency))
    total = max(1, len(res.units))

    def tick() -> None:
        if on_progress:
            on_progress((len(res.done) + len(res.failed)) / total)

    async def attempt(u: Unit, tries: int) -> float | None:
        """One try of ``u``. Returns the pause before the next try, or None when the unit is settled."""
        async with sem:
            await check_cancel()
            if res.stopped:
                res.failed[u.i] = res.stopped
                return None
            if deadline.expired:
                res.failed[u.i] = "deadline"
                return None
            try:
                body = checkpoint(u, await work(u))
            except (JobCanceled, asyncio.CancelledError):
                raise
            except GuardTripped:
                res.stopped = res.failed[u.i] = "guard"
                return None
            except ModelError as e:
                res.failed[u.i] = "refused" if "declined" in str(e) else "bad_answer"
                log("warn", f"{name}.unit_failed", i=u.i, error="ModelError", detail=str(e)[:200])
                return None
            except Exception as e:
                why = fatal(e) if fatal else None
                if why:
                    res.stopped = res.failed[u.i] = why
                    log("warn", f"{name}.stopped", reason=why, error=type(e).__name__, detail=str(e)[:300])
                    return None
                busy = is_transient(e)
                if busy and tries < MAX_TRIES:
                    pause = min(RETRY_CAP, RETRY_BASE * 2 ** (tries - 1)) * (0.5 + random.random() / 2)  # noqa: S311
                    if pause < deadline.left:
                        log("info", f"{name}.try_again", i=u.i, tries=tries, wait=round(pause, 1))
                        return pause
                res.failed[u.i] = "busy" if busy else "error"
                log("warn", f"{name}.unit_failed", i=u.i, error=type(e).__name__, detail=str(e)[:300])
                return None
            res.done[u.i] = body
            res.failed.pop(u.i, None)
            if save is not None:
                try:
                    await save(u, body)
                except (JobCanceled, asyncio.CancelledError):
                    raise
                except Exception as e:
                    log("warn", f"{name}.checkpoint_failed", i=u.i, error=type(e).__name__)
            return None

    async def one(u: Unit) -> None:
        if load is not None:
            try:
                saved = await load(u)
            except Exception:
                saved = None
            if saved and saved.get("ok"):
                res.done[u.i] = saved
                res.reused += 1
                tick()
                return
        tries = 0
        while True:
            tries += 1
            pause = await attempt(u, tries)
            if pause is None:
                break
            await asyncio.sleep(pause)
        tick()

    if res.units and not deadline.expired:
        try:
            await asyncio.wait_for(gather_all(*(one(u) for u in res.units)), deadline.left)
        except TimeoutError:
            log("warn", "deep.deadline", what=name, seconds=round(deadline.seconds))
    for u in res.units:
        if u.i not in res.done and u.i not in res.failed:
            res.failed[u.i] = "deadline"
    tick()
    return res


# --- Fable ---------------------------------------------------------------------------------------------------------


class NoFrames(Exception):
    """The part files had no frame for this stretch (the picture is shorter than the sound, or a part is missing)."""


async def watch_chunks(
    units: Sequence[Unit],
    *,
    bedrock: Bedrock,
    skills: SkillsBlock,
    frames: picture.Frames,
    words: Sequence[Sequence[Any]],
    speakers: Sequence[Sequence[Any]] | None,
    loud: list[float],
    motion: list[float],
    budget: CallBudget,
    deadline: Deadline,
    check_cancel: Callable[[], Awaitable[None]],
    load: Callable[[Unit], Awaitable[dict[str, Any] | None]] | None = None,
    save: Callable[[Unit, dict[str, Any]], Awaitable[None]] | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> TrackResult:
    """Fable watches every chunk. Returns what it saw and what it could not watch; never raises but for a cancel."""
    pacer = Pacer(WATCH_CONCURRENCY)
    seen: dict[tuple[float, float], dict[str, Any]] = {}  # pieces already answered, kept across a unit's tries

    def grow_budget(limit: int) -> None:
        budget.allow(3 * len(units) * math.ceil(MAX_FRAMES / max(1, limit)) + 8)

    async def one_call(lo: float, hi: float, shown: list[tuple[float, bytes]]) -> dict[str, Any]:
        """One request; a refusal for size splits it (again and again, until the model takes it)."""
        if (lo, hi) in seen:
            return seen[(lo, hi)]
        try:
            raw = await pacer.call(
                lambda: bedrock.structured(
                    system=WATCH_SYSTEM,
                    skills=skills,
                    content=[
                        *frame_blocks(shown),
                        {"text": chunk_text(lo, hi, words=words, speakers=speakers, loud=loud, motion=motion)},
                    ],
                    tool=TOOL,
                    description=TOOL_DESCRIPTION,
                    schema=SCENES_SCHEMA,
                    max_tokens=8000,
                ),
                budget,
            )
        except Exception as e:
            if not too_big(e) or len(shown) <= 1:
                raise
            limit = learn_image_limit(bedrock, e, len(shown))
            grow_budget(limit)
            log("info", "watch.split", start=lo, end=hi, images=len(shown), limit=limit, detail=str(e)[:200])
            return await pieces(lo, hi, split_frames(shown, limit))
        seen[(lo, hi)] = out = clean(raw, lo, hi)
        return out

    async def pieces(lo: float, hi: float, groups: list[list[tuple[float, bytes]]]) -> dict[str, Any]:
        """Each group of frames as its own request over its own stretch of time; the answers joined. Every piece is
        tried even when another fails; a piece the service was too busy for sends the whole unit round again (the
        answered pieces are kept), and pieces refused for good leave a gap only when some other piece was seen."""
        if len(groups) == 1:
            return await one_call(lo, hi, groups[0])
        spans = [
            (lo if k == 0 else g[0][0], hi if k == len(groups) - 1 else groups[k + 1][0][0])
            for k, g in enumerate(groups)
        ]
        got = await asyncio.gather(
            *(one_call(a, b, g) for (a, b), g in zip(spans, groups, strict=True)), return_exceptions=True
        )
        errors = [r for r in got if isinstance(r, BaseException)]
        for err in errors:
            if isinstance(err, (JobCanceled, asyncio.CancelledError, GuardTripped)):
                raise err
        answers = [r for r in got if isinstance(r, dict)]
        if errors:
            busy = next((err for err in errors if is_transient(err)), None)
            if busy is not None or not answers:
                raise busy or errors[0]
            log("warn", "watch.piece_failed", start=lo, end=hi, failed=len(errors), of=len(groups))
        return {
            "scene": next((a["scene"] for a in answers if a.get("scene")), ""),
            "events": [e for a in answers for e in a["events"]],
        }

    async def look(u: Unit) -> dict[str, Any]:
        lo, hi = u.lead, u.end
        shown = pick_frames(await frames.between(lo, hi), frame_times(lo, hi, spike_times(loud, motion, lo, hi)))
        if not shown:
            raise NoFrames(f"no frames for {lo:g}-{hi:g} s")
        limit = bedrock.image_limit
        return await pieces(lo, hi, split_frames(shown, limit) if limit else [shown])

    if bedrock.image_limit:
        grow_budget(bedrock.image_limit)
    return await run_track(
        "fable",
        units,
        look,
        concurrency=WATCH_CONCURRENCY,
        deadline=deadline,
        check_cancel=check_cancel,
        load=load,
        save=save,
        on_progress=on_progress,
    )
