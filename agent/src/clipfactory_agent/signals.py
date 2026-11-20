"""Everything known about the source besides its words, merged for the clip finder (docs/DECISIONS.md ADR-40):
what the two watchers saw (picture events), where the picture changes fast, where the sound jumps, what people
replay, and who is talking. From these: the hot spots, the picture lines shown between the transcript lines, and the
few plain words on a clip that say why it was picked.

Every track is optional. With none of them the finder gets exactly what it got before this module existed."""

from __future__ import annotations

import bisect
import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import loudness, picture, transcript
from .chat import ChatSignal
from .moments import Moment
from .util import hms

MERGE_SECONDS = 3  # the same kind of event from both watchers this close together is one event
NEAR_SECONDS = 4  # sources this close together add up into one hot spot
HOTSPOT_MERGE_SECONDS = 8
SILENT_SECONDS = 5  # "nobody talking": no word this close
MIN_HOTSPOT = 1.0
STRONG = 6  # an event this intense can carry a clip without any talking
MAX_EVENT_LINES = 120
MAX_HOTSPOTS = 25
MAX_PICKED_FOR = 40
FABLE_WEIGHT, NOVA_WEIGHT = 3.0, 2.0
QUIET_KINDS = ("calm", "menu_or_loading")
SOURCE_WORDS = {
    "fable": "seen",
    "nova": "seen",
    "loud": "loud",
    "motion": "fast picture",
    "replayed": "rewatched",
    "chat": "chat went wild",
}

# Why a clip was picked, in words an 8-year-old can read (docs/CONTRACTS.md §5 `pickedFor`).
KIND_WORDS = {
    "crash": "Big crash",
    "explosion": "Big boom",
    "chase": "Wild chase",
    "stunt": "Cool stunt",
    "fight": "Big fight",
    "fail": "Big fail",
    "death_screen": "Big fail",
    "win": "Big win",
    "glitch": "Weird glitch",
    "jump_scare": "Jump scare",
    "face_reaction": "Big reaction",
}
REACTION, LOUD_LAUGH, LOUD, FAST, REWATCH, TALK, CHAT = (
    "Big reaction",
    "Loud laugh",
    "Loud moment",
    "Fast action",
    "People rewatch this",
    "Back and forth",
    "Chat went wild",
)


@dataclass
class Event:
    """One thing a watcher saw (``visual_log.json`` events)."""

    t0: float
    t1: float
    kind: str
    what: str
    intensity: int
    silent: bool = False
    face: str = "none"
    text: str = ""
    src: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "t0": self.t0,
            "t1": self.t1,
            "kind": self.kind,
            "what": self.what,
            "intensity": self.intensity,
            "silent": self.silent,
            "face": self.face,
            "text": self.text,
            "src": self.src,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any], src: str | None = None) -> Event:
        return cls(
            t0=float(d.get("t0") or 0),
            t1=float(d.get("t1") or d.get("t0") or 0),
            kind=str(d.get("kind") or "other"),
            what=str(d.get("what") or ""),
            intensity=max(1, min(10, int(d.get("intensity") or 1))),
            silent=bool(d.get("silent")),
            face=str(d.get("face") or "none"),
            text=str(d.get("text") or ""),
            src=[src] if src else [str(s) for s in d.get("src") or []],
        )


@dataclass
class HotSpot:
    t: float
    score: float
    silent: bool
    sources: list[str]
    reasons: list[str]

    def to_json(self) -> dict[str, Any]:
        return {
            "t": self.t,
            "score": self.score,
            "silent": self.silent,
            "sources": self.sources,
            "reasons": self.reasons,
        }


@dataclass
class Signals:
    duration: float
    events: list[Event] = field(default_factory=list)
    hotspots: list[HotSpot] = field(default_factory=list)
    motion: list[float] = field(default_factory=list)
    coverage: dict[str, float] = field(default_factory=dict)  # picture, fable, nova, speakers: 0..1 of the source

    def events_in(self, start: float, end: float) -> list[Event]:
        return [e for e in self.events if start <= e.t0 < end]

    def hotspots_in(self, start: float, end: float) -> list[HotSpot]:
        return [h for h in self.hotspots if start <= h.t < end]

    @property
    def watched(self) -> bool:
        """A watcher (not only the motion score) saw at least part of the picture."""
        return self.coverage.get("picture", 0.0) > 0

    @property
    def coverage_percent(self) -> int:
        return round(100 * min(1.0, self.coverage.get("picture", 0.0)))

    def strong_in(self, start: float, end: float) -> bool:
        """This stretch is worth reading even with nobody talking: a strong picture event or a silent hot spot."""
        return any(e.intensity >= STRONG for e in self.events_in(start, end)) or any(
            h.silent for h in self.hotspots_in(start, end)
        )

    def to_json(self) -> dict[str, Any]:
        return {"version": 1, "coverage": self.coverage, "hotspots": [h.to_json() for h in self.hotspots]}


# --- the visual log ------------------------------------------------------------------------------------------------


def merge_events(fable: Sequence[dict[str, Any]], nova: Sequence[dict[str, Any]]) -> list[Event]:
    """Both watchers' events in time order. The same kind of event seen within MERGE_SECONDS by either (two chunks
    overlap by a few seconds, and the two watchers see the same picture) becomes one, keeping the higher intensity's
    words and both sources."""
    incoming = [Event.from_json(e, "fable") for e in fable] + [Event.from_json(e, "nova") for e in nova]
    out: list[Event] = []
    for e in sorted(incoming, key=lambda e: (e.t0, -e.intensity)):
        twin = next(
            (
                o
                for o in reversed(out[-40:])
                if o.kind == e.kind and e.t0 <= o.t1 + MERGE_SECONDS and o.t0 <= e.t1 + MERGE_SECONDS
            ),
            None,
        )
        if twin is None:
            out.append(e)
            continue
        if e.intensity > twin.intensity:
            twin.what, twin.intensity, twin.face = e.what, e.intensity, e.face if e.face != "none" else twin.face
            twin.silent = e.silent
        elif twin.face == "none":
            twin.face = e.face
        twin.text = twin.text or e.text
        twin.t0, twin.t1 = min(twin.t0, e.t0), max(twin.t1, e.t1)
        twin.src = sorted(set(twin.src) | set(e.src))
    return sorted(out, key=lambda e: e.t0)


def union(spans: Sequence[Sequence[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for s, e in sorted((float(a), float(b)) for a, b in spans):
        if out and s <= out[-1][1] + 0.01:
            out[-1][1] = max(out[-1][1], e)
        elif e > s:
            out.append([s, e])
    return out


def covered(spans: Sequence[Sequence[float]]) -> float:
    return sum(e - s for s, e in union(spans))


def covered_span(spans: Sequence[Sequence[float]], start: float, end: float, share: float = 0.95) -> bool:
    """``start..end`` lies (nearly all of it) inside the watched spans."""
    inside = sum(max(0.0, min(e, end) - max(s, start)) for s, e in union(spans))
    return end > start and inside >= share * (end - start)


def make_visual_log(
    fable_ok: Sequence[dict[str, Any]],
    nova_ok: Sequence[dict[str, Any]],
    failed: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """``visual_log.json``: what was watched (``coverage``), what was not and why (``failed``) and the merged
    events. ``fable_ok`` and ``nova_ok`` are the chunk and part checkpoints that succeeded."""
    events = merge_events(
        [e for c in fable_ok for e in c.get("events") or []], [e for c in nova_ok for e in c.get("events") or []]
    )
    return {
        "version": 1,
        "coverage": union([(c["start"], c["end"]) for c in (*fable_ok, *nova_ok)]),
        "fable": union([(c["start"], c["end"]) for c in fable_ok]),
        "nova": union([(c["start"], c["end"]) for c in nova_ok]),
        "failed": list(failed),
        "events": [e.to_json() for e in events],
    }


WATCH_AGAIN = {"busy", "deadline"}  # Fable lost these chunks to time or a busy service: a new run may see them


def log_covers(visual_log: dict[str, Any] | None, seconds: float, share: float = 0.95) -> bool:
    """A visual log from an earlier run is reused when it covers nearly all of the source, and Fable lost no chunk
    to a busy service or the deadline. (When Nova covered for those, a Try again watches them once more: the
    saved chunks and parts are reused, so only what Fable missed is sent.)"""
    if not visual_log or seconds <= 0:
        return False
    if covered(visual_log.get("coverage") or []) < share * seconds:
        return False
    return not any(
        f.get("src") == "fable" and f.get("reason") in WATCH_AGAIN
        for f in visual_log.get("failed") or []
        if isinstance(f, dict)
    )


# --- hot spots -----------------------------------------------------------------------------------------------------


def _is_silent(words: Sequence[Sequence[Any]], starts: list[float], t0: float, t1: float | None = None) -> bool:
    """No word within SILENT_SECONDS of ``t0`` (through ``t1``)."""
    lo, hi = t0 - SILENT_SECONDS, (t0 if t1 is None else t1) + SILENT_SECONDS
    i = bisect.bisect_left(starts, lo)
    return not (i < len(starts) and starts[i] <= hi)


def _peaks(heatmap: Sequence[dict[str, float]], limit: int = 20) -> list[dict[str, float]]:
    """The most-replayed stretches worth naming: the highest ones, at least 60% of the best."""
    if not heatmap:
        return []
    top = max(h["value"] for h in heatmap)
    if top <= 0:
        return []
    return sorted((h for h in heatmap if h["value"] >= 0.6 * top), key=lambda h: -h["value"])[:limit]


def hot_spots(
    events: Sequence[Event],
    *,
    words: Sequence[Sequence[Any]],
    loud: list[float],
    motion: list[float],
    heatmap: Sequence[dict[str, float]],
    chat: ChatSignal | None = None,
) -> list[HotSpot]:
    """Moments where several independent signals agree. Each source's strongest point within NEAR_SECONDS adds its
    weight; two or more independent sources add 1; hot spots within HOTSPOT_MERGE_SECONDS become one. A chat spike
    counts at the moment it points to (its time minus the chat's lag), and only when nothing flags it."""
    points: list[tuple[float, float, str]] = []  # (time, weight, source)
    for e in events:
        if e.kind in QUIET_KINDS:
            continue
        for src in e.src:
            points.append((e.t0, e.intensity / 10 * (FABLE_WEIGHT if src == "fable" else NOVA_WEIGHT), src))
    points += [(float(s.t), min(s.jump / 7, 2.0), "loud") for s in loudness.spikes(loud, limit=10_000)]
    points += [(float(s.t), min(s.lift / 2.5, 2.0), "motion") for s in picture.motion_spikes(motion, limit=10_000)]
    points += [(float(h["start"]), 1.0, "replayed") for h in _peaks(heatmap)]
    if chat is not None:
        points += [(s.t, min(s.strength, 2.0), "chat") for s in chat.spikes if s.counts]
    points.sort()

    starts = [float(w[0]) for w in words]
    clusters: list[list[tuple[float, float, str]]] = []
    for p in points:
        if clusters and p[0] - clusters[-1][-1][0] <= NEAR_SECONDS and p[0] - clusters[-1][0][0] <= 2 * NEAR_SECONDS:
            clusters[-1].append(p)
        else:
            clusters.append([p])

    found: list[HotSpot] = []
    for c in clusters:
        best: dict[str, float] = {}
        for _, weight, src in c:
            best[src] = max(best.get(src, 0.0), weight)
        score = sum(best.values()) + (1.0 if len(best) >= 2 else 0.0)
        if score < MIN_HOTSPOT:
            continue
        t = max(c, key=lambda p: p[1])[0]
        sources = sorted(best, key=lambda s: -best[s])
        found.append(HotSpot(round(t, 1), round(score, 2), _is_silent(words, starts, t), sources, _reasons(sources)))

    merged: list[HotSpot] = []
    for h in found:
        if merged and h.t - merged[-1].t <= HOTSPOT_MERGE_SECONDS:
            last = merged[-1]
            sources = list(dict.fromkeys([*last.sources, *h.sources]))
            keep = h if h.score > last.score else last
            merged[-1] = HotSpot(keep.t, keep.score, last.silent and h.silent, sources, _reasons(sources))
        else:
            merged.append(h)
    return merged


def _reasons(sources: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(SOURCE_WORDS.get(s, s) for s in sources))


def build(
    *,
    duration: float,
    words: Sequence[Sequence[Any]],
    loud: list[float],
    heatmap: Sequence[dict[str, float]],
    speakers: Sequence[Sequence[Any]] | None,
    visual_log: dict[str, Any] | None,
    motion: list[float] | None,
    chat: ChatSignal | None = None,
) -> Signals | None:
    """The merged signals, or None when there is no picture data at all (then the finder works as it always did)."""
    raw = (visual_log or {}).get("events") or []
    motion = list(motion or [])
    if not raw and not any(motion) and not (visual_log or {}).get("coverage"):
        return None
    starts = [float(w[0]) for w in words]
    events = [Event.from_json(e) for e in raw]
    for e in events:
        # "Nobody talking" is decided by the words, not by a model that never heard the sound.
        e.silent = _is_silent(words, starts, e.t0, min(e.t1, e.t0 + 10)) if words else True
    total = max(duration, 1.0)
    log = visual_log or {}
    coverage = {
        "picture": round(min(1.0, covered(log.get("coverage") or []) / total), 4),
        "fable": round(min(1.0, covered(log.get("fable") or []) / total), 4),
        "nova": round(min(1.0, covered(log.get("nova") or []) / total), 4),
        "motion": round(min(1.0, len(motion) / total), 4),
        "speakers": 1.0 if speakers else 0.0,
    }
    spots = hot_spots(events, words=words, loud=loud, motion=motion, heatmap=heatmap, chat=chat)
    return Signals(duration=duration, events=events, hotspots=spots, motion=motion, coverage=coverage)


# --- what the finder reads -----------------------------------------------------------------------------------------


class Readable(Protocol):
    """What ``timeline`` and ``extra_hints`` need of a Brief (agent.py), without importing it."""

    words: list[list[Any]]
    speakers: list[list[Any]] | None
    signals: Signals | None


def event_line(e: Event) -> str:
    """``(seen) crash 9/10, nobody talking: car flips off the bridge | face: shocked``"""
    text = f"(seen) {e.kind.replace('_', ' ')} {e.intensity}/10"
    if e.silent:
        text += ", nobody talking"
    text += f": {e.what}" if e.what else ""
    if e.face not in ("none", "calm"):
        text += f" | face: {e.face}"
    if e.text:
        text += f' | on screen: "{e.text}"'
    return text


def timeline(b: Readable, start: float, end: float) -> str:
    """The transcript lines of ``start..end`` with the picture notes between them, in time order. Only the strongest
    MAX_EVENT_LINES notes are shown; the rest are counted. Without signals: the transcript lines alone."""
    spoken = transcript.timed_lines(b.words, start, end, b.speakers)
    if b.signals is None:
        return "\n".join(f"[{hms(t)}] {text}" for t, text in spoken)
    events = b.signals.events_in(start, end)
    shown = sorted(events, key=lambda e: -e.intensity)[:MAX_EVENT_LINES]
    rows = [(t, 1, text) for t, text in spoken] + [(e.t0, 0, event_line(e)) for e in shown]
    out = [f"[{hms(t)}] {text}" for t, _, text in sorted(rows, key=lambda r: (r[0], r[1]))]
    if len(events) > len(shown):
        out.append(f"(+{len(events) - len(shown)} weaker picture notes not shown)")
    return "\n".join(out)


def extra_hints(b: Readable, start: float, end: float) -> str:
    """The lines ``hints`` adds when signals exist: where the picture moves fast, and the hot spots."""
    s = b.signals
    if s is None:
        return ""
    out: list[str] = []
    fast = picture.motion_spikes(s.motion, start, end)
    if fast:
        out.append("Fast picture: " + ", ".join(f"{hms(m.t)} (x{m.lift:.0f})" for m in fast))
    spots = s.hotspots_in(start, end)
    if spots:
        shown = sorted(sorted(spots, key=lambda h: -h.score)[:MAX_HOTSPOTS], key=lambda h: h.t)
        text = ", ".join(f"{hms(h.t)} ({' + '.join(h.reasons)}{', nobody talking' if h.silent else ''})" for h in shown)
        if len(spots) > len(shown):
            text += f" (+{len(spots) - len(shown)} weaker ones)"
        out.append("Hot spots: " + text)
    return "\n".join(out)


def seen_block(signals: Signals | None, start: float, end: float, limit: int = 12) -> str:
    """The picture events inside a clip, for the checklist review ("Seen:"). Empty without any."""
    if signals is None:
        return ""
    events = sorted(signals.events_in(start, end), key=lambda e: -e.intensity)[:limit]
    return "\n".join(f"[{e.t0 - start:.1f}s] {event_line(e)}" for e in sorted(events, key=lambda e: e.t0))


# --- why a clip was picked -----------------------------------------------------------------------------------------


def _trading_lines(speakers: Sequence[Sequence[Any]] | None, start: float, end: float) -> bool:
    """Two people going back and forth: at least three changes of speaker inside the clip."""
    turns = [str(t[2]) for t in speakers or [] if float(t[0]) < end and float(t[1]) > start]
    return len(set(turns)) >= 2 and sum(1 for a, b in itertools.pairwise(turns) if a != b) >= 3


def picked_for(
    m: Moment,
    *,
    signals: Signals | None,
    loud: list[float],
    heatmap: Sequence[dict[str, float]],
    speakers: Sequence[Sequence[Any]] | None,
    chat: ChatSignal | None = None,
) -> str | None:
    """The top two reasons joined with " + " ("Loud laugh + Fast action"), built by code from the evidence inside
    the clip, never by a model. None when nothing matches. Chat counts when the moment a spike points to is inside
    the clip, even when the burst itself comes after the clip ends."""
    found: dict[str, float] = {}

    def add(label: str, strength: float) -> None:
        found[label] = max(found.get(label, 0.0), strength)

    events = signals.events_in(m.start, m.end) if signals else []
    laughing = [e for e in events if e.face == "laughing"]
    spikes = loudness.spikes(loud, m.start, m.end)
    loud_laugh = False
    for s in spikes:
        laugh = any(abs(e.t0 - s.t) <= 3 or e.t0 <= s.t <= e.t1 for e in laughing)
        loud_laugh = loud_laugh or laugh
        add(LOUD_LAUGH if laugh else LOUD, min(s.jump / 7, 2.0))
    for e in events:
        if e.intensity < 4:
            continue
        weight = sum(FABLE_WEIGHT if s == "fable" else NOVA_WEIGHT for s in e.src) or NOVA_WEIGHT
        strength = e.intensity / 10 * weight
        if e.kind in KIND_WORDS:
            add(KIND_WORDS[e.kind], strength)
        if e.face not in ("none", "calm") and not (loud_laugh and e.face == "laughing"):
            add(REACTION, strength * 0.8)
    if signals:
        for fast in picture.motion_spikes(signals.motion, m.start, m.end):
            add(FAST, min(fast.lift / 2.5, 2.0))
    if any(h["start"] < m.end and h["end"] > m.start for h in _peaks(heatmap)):
        add(REWATCH, 1.0)
    if _trading_lines(speakers, m.start, m.end):
        add(TALK, 0.9)
    if chat is not None:
        for c in chat.spikes_in(m.start, m.end):
            if c.counts:
                add(CHAT, min(c.strength, 2.0))
    if loud_laugh:
        found.pop(LOUD, None)
    top = sorted(found, key=lambda k: -found[k])[:2]
    if not top:
        return None
    text = " + ".join(top)
    return text if len(text) <= MAX_PICKED_FOR else top[0][:MAX_PICKED_FOR]
