"""Chat hype (docs/CONTRACTS.md §37, docs/DECISIONS.md ADR-61): when the stream's chat suddenly goes much faster than
usual, or floods with the same word ("KEKW", "W", "?????", "CLIP IT"), the crowd is saying something just happened.

Pure functions, no I/O. ``chatfetch`` gets the messages (Twitch, Kick or YouTube chat replay) and ``chatscreen``
measures a chat box shown in the picture; both end here as a per-second rate, from which this module finds the
spikes, shifts them back by the chat's lag, names the spam and the mood, and flags the bursts that are not about the
video (raids, giveaways, subscription trains, bots).

Chat is always optional: with none, nothing the finder reads changes by one byte. No chatter names, message bodies
or ids are ever stored or logged: ``Collector`` keeps a salted hash of each name in memory only, and ``chat.json``
holds numbers and at most one cleaned spam word per spike."""

from __future__ import annotations

import bisect
import hashlib
import hmac
import math
import os
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .util import hms

VERSION = 1
SOURCES = ("twitch", "kick", "youtube", "screen")
TECH = {
    "twitch": "Twitch chat replay",
    "youtube": "YouTube chat replay",
    "kick": "Kick chat",
    "screen": "chat on screen",
}
RATE_SECONDS = 5  # the rate is a rolling sum over this many seconds, centred
BASELINE_SECONDS = 300  # the baseline is the median of the rate this far either side
BASELINE_STEP = 15  # the baseline is worked out every this many seconds, and filled in between
MIN_Z = 3.0
MIN_LIFT = 1.8
MIN_RATE = 6  # messages in RATE_SECONDS: a remote chat this slow is never a spike
MIN_RATE_SCREEN = 2.0  # lines in RATE_SECONDS for a chat box in the picture
MERGE_SECONDS = 20
ONSET_LOOKBACK = 15
MAX_SPIKES = 60
MAX_HINTS = 10  # chat spikes shown per window the finder reads
LAG_DEFAULT = 5
LAG_RANGE = range(2, 11)
LAG_MATCH = 2.0
LAG_MIN_MATCHES = 4
WINDOW_BEFORE, WINDOW_AFTER = 10, 2  # the moment is probably in [onset - 10, onset - 2]
SPAM_SHARE = 0.3
SPAM_MIN_COPIES = 5
SPAM_MIN_USERS = 4
SPAM_MAX_CHARS = 24
MOOD_SHARE = 0.2
FLAG_KEEP = 0.3  # a flagged spike keeps this much of its strength
STRONG = 1.5  # a spike at least this strong makes a quiet window worth reading
NEW_CHATTER_SHARE = 0.4
NEW_CHATTER_AFTER = 600.0  # "first-time chatters" only means something once chat has run this long
GIVEAWAY_SHARE = 0.3
SUBS_NOTICES = 10
BOTS_USERS, BOTS_SHARE = 4, 0.6
BURST_AFTER = 5  # a burst's messages run from its onset to this long after its peak

BOTS = frozenset(
    {"nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "sery_bot", "botrix", "kicbot", "wizebot"}
)
FLAG_WORDS = {"raid": "maybe a raid", "giveaway": "giveaway", "subs": "subs", "bots": "bots"}
MOOD_WORDS = {
    "laugh": "chat laughing",
    "hype": "chat hyped",
    "shock": "chat shocked",
    "clip": "chat says clip it",
    "fail": "chat says L",
}
_RAID_WORDS = ("raid", "raiders", "raided")
_GIVEAWAY_WORDS = ("giveaway", "giveaways", "raffle", "ticket", "tickets")  # not "drop" or "join": a game says those
RAID_SHARE, RAID_USERS = 0.3, 5
LAG_CONTROL_GAP = 2  # lags this close to the best one are its neighbours, not a chance control
LAG_MARGIN = 2  # the best lag must beat the chance control by this many matches, and 1.5 times over

_LINK = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_AT = re.compile(r"@\w+")
_RUNS = re.compile(r"(.)\1+", re.DOTALL)
_LONG_RUNS = re.compile(r"(.)\1{2,}", re.DOTALL)
_SPACES = re.compile(r"\s+")
_QUOTES = re.compile(r"[\"'`\\]")


def clean_text(text: str, *, soft: bool = False) -> str:
    """One message as the text spam is counted by: lowercase, no links or @names, runs of one character squashed
    ("LMAOOOO" → "lmao", "?????" → "?", "WWWW" → "w", "💀💀" → "💀") and the same word repeated said once
    ("KEKW KEKW" → "kekw", "W W W" → "w"). Emoji stay. ``soft`` only shortens runs of three or more to two
    ("goood" → "good", "poggers" stays), for the word shown to the finder."""
    t = _LINK.sub(" ", str(text).lower())
    t = _AT.sub(" ", t)
    t = _LONG_RUNS.sub(r"\1\1", t) if soft else _RUNS.sub(r"\1", t)
    words = _SPACES.split(t.strip())
    if not words or words == [""]:
        return ""
    out: list[str] = []
    for w in words:
        if not out or out[-1] != w:
            out.append(w)
    if len(set(out)) == 1:
        out = out[:1]
    return " ".join(out)


def _mood_table() -> dict[str, frozenset[str]]:
    raw = {
        "laugh": ("lul", "lol", "lmao", "kekw", "omegalul", "icant", "😂", "🤣", "💀", "xd"),
        "hype": ("w", "pog", "poggers", "letsgo", "lets go", "🔥", "goat", "insane"),
        "shock": ("?", "what", "no way", "wtf", "monkas", "😱", "holy"),
        "clip": ("clip it", "clip that", "clip", "+clip"),
        "fail": ("l", "f", "rip", "🤡"),
    }
    return {k: frozenset(clean_text(w) for w in v) for k, v in raw.items()}


MOODS = _mood_table()


_MOOD_ORDER = ("clip", "laugh", "shock", "hype", "fail")
_PUNCT = ".,!?:;~"


def mood_of(text: str) -> str | None:
    """The mood one cleaned message says, or None. The whole message counts first, then its words and phrases
    ("fail" only as the whole message: a lone "l" or "f" inside a sentence means nothing)."""
    for mood in _MOOD_ORDER:
        if text in MOODS[mood]:
            return mood
    tokens = {w.strip(_PUNCT) or w for w in text.split()}
    for mood in _MOOD_ORDER[:-1]:
        words = MOODS[mood]
        if any(t in words for t in tokens) or any(" " in p and p in text for p in words):
            return mood
    return None


_LEET = str.maketrans("@$0134!5", "asoieiis")
_BLOCKED_WORDS = [
    "fuck",
    "fucking",
    "fucker",
    "fucked",
    "shit",
    "shitty",
    "bitch",
    "bitches",
    "ass",
    "asshole",
    "dick",
    "cock",
    "pussy",
    "cunt",
    "bastard",
    "piss",
    "slut",
    "whore",
    "nigga",
    "nigger",
    "niggas",
    "fag",
    "faggot",
    "retard",
    "retarded",
    "tard",
    "kys",
    "rape",
    "rapist",
    "nazi",
    "porn",
    "sex",
    "cum",
    "tits",
    "boobs",
    "dildo",
]
_BLOCKED = frozenset(_BLOCKED_WORDS)
_SQUASHED = frozenset(q for q in (_RUNS.sub(r"\1", w) for w in _BLOCKED_WORDS) if len(q) >= 3)  # "fuuuck" is "fuck"


def profane(text: str) -> bool:
    """True when a word of ``text`` is one a kid-proof app does not show (whole words only, so "class" is fine;
    letter swaps like "sh1t" and "f*ck" and stretched ones like "fuuuck" count)."""
    t = text.lower().translate(_LEET)
    for token in t.split():
        w = token.strip(_PUNCT)
        starred = [w.replace("*", v) for v in "aeiou"] if "*" in w else [w]
        for cand in starred:
            x = re.sub(r"(?<=\w)[#_.-](?=\w)", "", cand)
            if x in _BLOCKED or _RUNS.sub(r"\1", x) in _SQUASHED:
                return True
    return False


def safe_spam(text: str) -> str | None:
    """The spam text as the finder may read it: no quotes or backslashes, at most SPAM_MAX_CHARS characters, and
    never a word a kid-proof app does not show."""
    t = _QUOTES.sub("", _SPACES.sub(" ", text)).strip()[:SPAM_MAX_CHARS].strip()
    return None if not t or profane(t) else t


# --- collecting messages -------------------------------------------------------------------------------------------


@dataclass
class Message:
    t: float
    user: str  # a salted hash, never the name
    text: str  # cleaned (clean_text): kept in memory only
    shown: str = ""  # the softly cleaned form, what the finder may read as the spam ("good", not "god")


class Collector:
    """Messages as a fetcher reads them. Commands ("!uptime"), known bots and system notices (subs, gifts, raids,
    announcements) are not counted as chat; the notices are counted per second for the "subs" flag. Names are
    hashed with a salt that lives only as long as this object."""

    def __init__(self) -> None:
        self._salt = os.urandom(16)
        self.messages: list[Message] = []
        self.notices: list[float] = []
        self.seen_ids: set[str] = set()
        self.dropped = 0

    def _user(self, name: str) -> str:
        return hmac.new(self._salt, name.lower().encode(), hashlib.sha256).hexdigest()[:16]

    def add(self, t: float, name: str, text: str, *, system: bool = False, msg_id: str | None = None) -> bool:
        """True when the message counts as chat."""
        if msg_id is not None:
            if msg_id in self.seen_ids:
                return False
            self.seen_ids.add(msg_id)
        if t < 0 or not math.isfinite(t):
            return False
        if system:
            self.notices.append(float(t))
            return False
        raw = str(text or "").strip()
        if not raw or raw.startswith("!") or name.lower().strip() in BOTS:
            self.dropped += 1
            return False
        cleaned = clean_text(raw)
        if not cleaned:
            return False
        self.messages.append(
            Message(float(t), self._user(name or "?"), cleaned, clean_text(raw, soft=True)[: SPAM_MAX_CHARS * 2])
        )
        return True

    def __len__(self) -> int:
        return len(self.messages)


@dataclass
class RawChat:
    """What a fetcher got: where in the video it has chat for (``covered``, [start, end] seconds) and the messages."""

    source: str
    covered: list[list[float]]
    collector: Collector = field(default_factory=Collector)

    @property
    def count(self) -> int:
        return len(self.collector)


# --- the signal ----------------------------------------------------------------------------------------------------


@dataclass
class ChatSpike:
    t: float  # the moment, estimated: onset - lag
    onset: float
    peak: float
    z: float
    lift: float
    strength: float
    window: tuple[float, float]
    spam: str | None = None
    share: float = 0.0
    mood: str | None = None
    flag: str | None = None

    @property
    def counts(self) -> bool:
        """A reason for a clip and a hot-spot point: only when nothing flags it as being about something else."""
        return self.flag is None

    def to_json(self) -> dict[str, Any]:
        return {
            "t": self.t,
            "onset": self.onset,
            "peak": self.peak,
            "z": self.z,
            "lift": self.lift,
            "strength": self.strength,
            "window": list(self.window),
            "spam": self.spam,
            "share": self.share,
            "mood": self.mood,
            "flag": self.flag,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> ChatSpike:
        w = d.get("window") or [0, 0]
        mood = d.get("mood")
        flag = d.get("flag")
        return cls(
            t=float(d.get("t") or 0),
            onset=float(d.get("onset") or 0),
            peak=float(d.get("peak") or 0),
            z=float(d.get("z") or 0),
            lift=float(d.get("lift") or 0),
            strength=float(d.get("strength") or 0),
            window=(float(w[0]), float(w[1])),
            spam=safe_spam(str(d["spam"])) if d.get("spam") else None,
            share=float(d.get("share") or 0),
            mood=mood if mood in MOOD_WORDS else None,
            flag=flag if flag in FLAG_WORDS else None,
        )


@dataclass
class ChatSignal:
    """``chat.json`` (docs/CONTRACTS.md §37.4)."""

    source: str
    coverage: float
    messages: int
    lag: float
    rate: list[float | None]
    spikes: list[ChatSpike] = field(default_factory=list)
    box: dict[str, int] | None = None

    @property
    def coverage_percent(self) -> int:
        return round(100 * max(0.0, min(1.0, self.coverage)))

    def spikes_in(self, start: float, end: float) -> list[ChatSpike]:
        """Spikes whose moment lies in ``start..end``."""
        return [s for s in self.spikes if start <= s.t < end]

    def strong_in(self, start: float, end: float) -> bool:
        return any(s.counts and s.strength >= STRONG for s in self.spikes_in(start, end))

    def hint_line(self, start: float, end: float) -> str:
        """``Chat spikes: 1:02:07 (x6, chat laughing, spam "kekw", moment ~1:01:57–1:02:05), …`` or ""."""
        found = self.spikes_in(start, end)
        if not found:
            return ""
        shown = sorted(sorted(found, key=lambda s: -s.strength)[:MAX_HINTS], key=lambda s: s.t)
        text = ", ".join(spike_words(s) for s in shown)
        if len(found) > len(shown):
            text += f" (+{len(found) - len(shown)} weaker ones)"
        return "Chat spikes: " + text

    def to_json(self) -> dict[str, Any]:
        return {
            "version": VERSION,
            "source": self.source,
            "coverage": round(self.coverage, 4),
            "messages": self.messages,
            "lagSeconds": self.lag,
            "rate": [None if v is None else round(v, 2) for v in self.rate],
            "box": self.box,
            "spikes": [s.to_json() for s in self.spikes],
        }

    @classmethod
    def from_json(cls, d: Any) -> ChatSignal | None:
        """A saved ``chat.json``, or None when it is from another version or not one at all."""
        if not isinstance(d, dict) or d.get("version") != VERSION or d.get("source") not in SOURCES:
            return None
        try:
            box = d.get("box")
            return cls(
                source=str(d["source"]),
                coverage=float(d.get("coverage") or 0),
                messages=int(d.get("messages") or 0),
                lag=float(d.get("lagSeconds") or LAG_DEFAULT),
                rate=[None if v is None else float(v) for v in d.get("rate") or []],
                spikes=[ChatSpike.from_json(s) for s in d.get("spikes") or [] if isinstance(s, dict)],
                box={k: int(box[k]) for k in ("x", "y", "w", "h")} if isinstance(box, dict) else None,
            )
        except (KeyError, TypeError, ValueError):
            return None


def spike_words(s: ChatSpike) -> str:
    """``1:02:07 (x6, chat laughing, spam "kekw", moment ~1:01:57–1:02:05)``; a flagged one: ``(x3, maybe a raid)``."""
    parts = [f"x{max(1, round(s.lift))}"]
    if s.flag:
        parts.append(FLAG_WORDS[s.flag])
        return f"{hms(s.onset)} ({', '.join(parts)})"
    if s.mood:
        parts.append(MOOD_WORDS[s.mood])
    if s.spam:
        parts.append(f'spam "{s.spam}"')
    parts.append(f"moment ~{hms(s.window[0])}–{hms(s.window[1])}")
    return f"{hms(s.onset)} ({', '.join(parts)})"


CHAT_NOTE = """Chat: "Chat spikes" are moments when the stream's chat went much faster than usual or flooded with one
word. Chat reacts a few seconds late, so the moment is in the "moment ~" range, before the burst. Treat it like a
loudness spike: strong evidence when it lands with sound or picture, never enough alone. Ignore spikes marked "maybe a
raid", "giveaway", "subs" or "bots"."""


# --- the maths -----------------------------------------------------------------------------------------------------


def per_second(times: Iterable[float], seconds: int, covered: Sequence[Sequence[float]]) -> list[float | None]:
    """Messages in each second; None for seconds with no chat to count (not covered)."""
    n = max(0, int(seconds))
    on = [False] * n
    for a, b in covered:
        for t in range(max(0, math.floor(a)), min(n, math.ceil(b))):
            on[t] = True
    out: list[float | None] = [0.0 if c else None for c in on]
    for when in times:
        i = int(when)
        v = out[i] if 0 <= i < n else None
        if v is not None:
            out[i] = v + 1.0
    return out


def rolling_sum(counts: Sequence[float | None], width: int = RATE_SECONDS) -> list[float | None]:
    """The sum of the ``width`` seconds centred on each covered second (uncovered seconds count as 0). Centred, so a
    burst's onset is not pushed late by the sum."""
    vals = np.array([0.0 if v is None else float(v) for v in counts])
    if vals.size == 0:
        return []
    half = width // 2
    csum = np.concatenate([[0.0], np.cumsum(vals)])
    idx = np.arange(vals.size)
    lo = np.clip(idx - half, 0, vals.size)
    hi = np.clip(idx + width - half, 0, vals.size)
    sums = csum[hi] - csum[lo]
    return [None if v is None else round(float(x), 6) for v, x in zip(counts, sums, strict=True)]


def baseline(rate: Sequence[float | None]) -> tuple[np.ndarray, np.ndarray]:
    """``(median, sd)`` per second: the median rate of the covered seconds within BASELINE_SECONDS, and a spread that
    is never below sqrt(median) (a small chat's natural jitter) or 1. Uncovered seconds are left out."""
    n = len(rate)
    vals = np.array([np.nan if v is None else float(v) for v in rate], dtype=float)
    med = np.zeros(n)
    sd = np.ones(n)
    if n == 0:
        return med, sd
    anchors = list(range(0, n, BASELINE_STEP))
    if anchors[-1] != n - 1:
        anchors.append(n - 1)
    am, ad = [], []
    for a in anchors:
        win = vals[max(0, a - BASELINE_SECONDS) : a + BASELINE_SECONDS + 1]
        win = win[~np.isnan(win)]
        if win.size == 0:
            am.append(np.nan)
            ad.append(np.nan)
            continue
        m = float(np.median(win))
        am.append(m)
        ad.append(float(np.median(np.abs(win - m))))
    am_a, ad_a = np.array(am), np.array(ad)
    ok = ~np.isnan(am_a)
    if not ok.any():
        return med, sd
    xs = np.array(anchors, dtype=float)
    med = np.interp(np.arange(n), xs[ok], am_a[ok])
    mad = np.interp(np.arange(n), xs[ok], ad_a[ok])
    sd = np.maximum.reduce([1.4826 * mad, np.sqrt(np.maximum(med, 0.0)), np.ones(n)])
    return med, sd


@dataclass
class Peak:
    onset: int
    peak: int
    z: float
    lift: float


def find_peaks(rate: Sequence[float | None], *, min_rate: float = MIN_RATE) -> list[Peak]:
    """Bursts: seconds with z ≥ MIN_Z, lift ≥ MIN_LIFT and at least ``min_rate``; peaks within MERGE_SECONDS are one;
    the onset is the first second within ONSET_LOOKBACK before the peak halfway up from the baseline."""
    med, sd = baseline(rate)
    hot: list[tuple[int, float, float]] = []
    for t, v in enumerate(rate):
        if v is None or v < min_rate:
            continue
        z = (v - med[t]) / sd[t]
        lift = v / max(float(med[t]), 1.0)
        if z >= MIN_Z and lift >= MIN_LIFT:
            hot.append((t, float(z), float(lift)))
    peaks: list[tuple[int, float, float]] = []
    last_hot = -(10**9)
    for t, z, lift in hot:
        if peaks and t - last_hot <= MERGE_SECONDS:
            if (rate[t] or 0) > (rate[peaks[-1][0]] or 0):
                peaks[-1] = (t, z, lift)
        else:
            peaks.append((t, z, lift))
        last_hot = t
    out: list[Peak] = []
    for t, z, lift in peaks:
        top = float(rate[t] or 0)
        half = med[t] + 0.5 * (top - med[t])
        onset = t
        for u in range(max(0, t - ONSET_LOOKBACK), t + 1):
            v = rate[u]
            if v is not None and v >= half:
                onset = u
                break
        out.append(Peak(onset, t, round(z, 2), round(lift, 2)))
    return out


def calibrate_lag(onsets: Sequence[float], loud_times: Sequence[float]) -> int:
    """How late the chat reacts: the lag in 2..10 s that puts the most chat onsets within LAG_MATCH seconds of a
    loudness spike. It counts only when it beats chance: at least LAG_MIN_MATCHES, and clearly more matches than the
    typical lag that is not its neighbour (a loud stream has a spike every few seconds, so any lag matches some).
    Otherwise LAG_DEFAULT."""
    if not onsets or not loud_times:
        return LAG_DEFAULT
    louds = np.array(sorted(loud_times), dtype=float)
    ons = np.array(onsets, dtype=float)
    hits: dict[int, int] = {}
    close: dict[int, float] = {}
    for lag in LAG_RANGE:
        shifted = ons - lag
        i = np.clip(np.searchsorted(louds, shifted), 1, max(1, louds.size - 1)) if louds.size > 1 else None
        if i is None:
            gaps = np.abs(louds[0] - shifted)
        else:
            gaps = np.minimum(np.abs(louds[i] - shifted), np.abs(louds[i - 1] - shifted))
        ok = gaps <= LAG_MATCH
        hits[lag] = int(ok.sum())
        close[lag] = float(gaps[ok].sum())
    best = max(hits, key=lambda k: (hits[k], -close[k]))
    control = [h for k, h in hits.items() if abs(k - best) > LAG_CONTROL_GAP]
    chance = float(np.median(control)) if control else 0.0
    n = float(len(ons))
    spread = math.sqrt(max(0.0, chance * (1.0 - chance / n)))  # how far luck alone reaches (binomial), 3 sigma
    needed = max(LAG_MIN_MATCHES, 1.5 * chance, chance + max(LAG_MARGIN, 3.0 * spread))
    if hits[best] >= needed:
        return best
    return LAG_DEFAULT


def spam_of(burst: Sequence[Message]) -> tuple[str | None, float]:
    """The text a burst floods with, and its share: the most common cleaned text when it is at least SPAM_SHARE of the
    burst, SPAM_MIN_COPIES copies, from SPAM_MIN_USERS different people. Else (None, its share)."""
    if not burst:
        return None, 0.0
    text, copies = Counter(m.text for m in burst).most_common(1)[0]
    share = copies / len(burst)
    users = len({m.user for m in burst if m.text == text})
    if share >= SPAM_SHARE and copies >= SPAM_MIN_COPIES and users >= SPAM_MIN_USERS:
        shows = Counter(m.shown for m in burst if m.text == text and m.shown)
        return safe_spam(shows.most_common(1)[0][0] if shows else text), round(share, 2)
    return None, round(share, 2)


def burst_mood(burst: Sequence[Message], spam: str | None) -> str | None:
    """The spam's mood, else the mood at least MOOD_SHARE of the burst says."""
    if spam:
        m = mood_of(spam)
        if m:
            return m
    if not burst:
        return None
    moods = Counter(m for m in (mood_of(x.text) for x in burst) if m)
    if not moods:
        return None
    mood, n = moods.most_common(1)[0]
    return mood if n >= MOOD_SHARE * len(burst) else None


def flag_of(
    burst: Sequence[Message], notices: int, first_seen: dict[str, float], t0: float, chat_start: float
) -> str | None:
    """Why a burst is probably not about the video: a raid, a giveaway, a subscription train or bots. ``first_seen``
    and ``chat_start`` are of the one stretch of chat with no gap in it that holds the burst."""
    if notices >= SUBS_NOTICES:
        return "subs"
    if not burst:
        return None
    n = len(burst)
    said_raid = [m for m in burst if any(w.strip(_PUNCT) in _RAID_WORDS for w in m.text.split())]
    if len(said_raid) >= RAID_SHARE * n and len({m.user for m in said_raid}) >= RAID_USERS:
        return "raid"
    top_text, top_copies = Counter(m.text for m in burst).most_common(1)[0]
    if len(top_text) >= 40 and top_copies >= max(SPAM_MIN_COPIES, 0.3 * n):
        return "raid"  # one long copy-paste from many people: a raid message
    if t0 - chat_start >= NEW_CHATTER_AFTER:
        users = {m.user for m in burst}
        new = sum(1 for u in users if first_seen.get(u, 0.0) >= t0)
        if users and new / len(users) >= NEW_CHATTER_SHARE and len(users) >= 10:
            return "raid"
    if sum(1 for m in burst if any(w.strip(_PUNCT) in _GIVEAWAY_WORDS for w in m.text.split())) >= GIVEAWAY_SHARE * n:
        return "giveaway"
    by_user = Counter(m.user for m in burst)
    top = sum(c for _, c in by_user.most_common(BOTS_USERS - 1))
    if len(by_user) < BOTS_USERS or top >= BOTS_SHARE * n:
        return "bots"
    return None


def strength_of(z: float, spam: str | None, mood: str | None, flag: str | None) -> float:
    s = min(2.0, z / 3) + (0.4 if spam else 0.0) + (0.3 if mood == "clip" else 0.0)
    return round(s * (FLAG_KEEP if flag else 1.0), 2)


def _top(spikes: list[ChatSpike]) -> list[ChatSpike]:
    return sorted(sorted(spikes, key=lambda s: -s.strength)[:MAX_SPIKES], key=lambda s: s.onset)


def _spike(p: Peak, lag: int, **kw: Any) -> ChatSpike:
    return ChatSpike(
        t=float(max(0, p.onset - lag)),
        onset=float(p.onset),
        peak=float(p.peak),
        z=p.z,
        lift=p.lift,
        strength=strength_of(p.z, kw.get("spam"), kw.get("mood"), kw.get("flag")),
        window=(float(max(0, p.onset - WINDOW_BEFORE)), float(max(0, p.onset - WINDOW_AFTER))),
        **kw,
    )


def _coverage(covered: Sequence[Sequence[float]], duration: float) -> float:
    total = 0.0
    last = 0.0
    for s, e in sorted((max(0.0, float(a)), min(duration, float(b))) for a, b in covered):
        begin = max(s, last)
        if e > begin:
            total += e - begin
            last = e
    return min(1.0, total / duration) if duration > 0 else 0.0


def _stretches(covered: Sequence[Sequence[float]], duration: float) -> list[tuple[float, float]]:
    """The covered ranges merged into stretches with no gap, in order."""
    out: list[list[float]] = []
    for a, b in sorted((max(0.0, float(a)), min(duration, float(b))) for a, b in covered):
        if b <= a:
            continue
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _stretch_of(stretches: Sequence[tuple[float, float]], t: float) -> int | None:
    for k, (a, b) in enumerate(stretches):
        if a <= t < b:
            return k
    return None


def analyze(raw: RawChat, duration: float, loud_times: Sequence[float]) -> ChatSignal | None:
    """The chat signal from fetched messages, or None when there is no chat to count."""
    msgs = sorted(raw.collector.messages, key=lambda m: m.t)
    seconds = math.ceil(duration)
    if not msgs or seconds <= 0:
        return None
    counts = per_second((m.t for m in msgs), seconds, raw.covered)
    if all(v is None for v in counts):
        return None
    rate = rolling_sum(counts)
    peaks = find_peaks(rate, min_rate=MIN_RATE)
    stretches = _stretches(raw.covered, duration)
    firsts: list[dict[str, float]] = [{} for _ in stretches]
    for m in msgs:
        k = _stretch_of(stretches, m.t)
        if k is not None:
            firsts[k].setdefault(m.user, m.t)
    times = [m.t for m in msgs]
    notices = sorted(raw.collector.notices)
    found: list[tuple[Peak, str | None, float, str | None, str | None]] = []
    for p in peaks:
        lo, hi = p.onset - RATE_SECONDS, p.peak + BURST_AFTER
        burst = msgs[_index(times, lo) : _index(times, hi)]
        spam, share = spam_of(burst)
        mood = burst_mood(burst, spam)
        n_notices = _index(notices, hi) - _index(notices, lo - 10)
        k = _stretch_of(stretches, float(lo))
        # "first-time chatters" only means something inside one stretch of chat with no gap (a gap makes everyone new)
        seen, begin = (firsts[k], stretches[k][0]) if k is not None else ({}, float(lo))
        flag = flag_of(burst, n_notices, seen, float(lo), begin)
        found.append((p, spam, share, mood, flag))
    # the lag is learned from ordinary bursts only: a raid or a sub train says nothing about the video's sound
    lag = calibrate_lag([p.onset for p, _, _, _, flag in found if flag is None], loud_times)
    spikes = [_spike(p, lag, spam=spam, share=share, mood=mood, flag=flag) for p, spam, share, mood, flag in found]
    return ChatSignal(
        source=raw.source,
        coverage=round(_coverage(raw.covered, duration), 4),
        messages=len(msgs),
        lag=float(lag),
        rate=[None if v is None else float(v) for v in counts],
        spikes=_top(spikes),
    )


def from_screen(
    lines: Sequence[float | None],
    *,
    box: dict[str, int],
    loud_times: Sequence[float],
    words: Sequence[tuple[float, str]] = (),
) -> ChatSignal | None:
    """The chat signal from a chat box's scroll speed (lines per second; None where it could not be measured) and
    the words the watcher read in that box (``(t, "kekw")``)."""
    covered = sum(1 for v in lines if v is not None)
    if not lines or covered == 0:
        return None
    rate = rolling_sum(lines)
    peaks = find_peaks(rate, min_rate=MIN_RATE_SCREEN)
    lag = calibrate_lag([p.onset for p in peaks], loud_times)
    spikes = []
    for p in peaks:
        near = [clean_text(w) for t, w in words if p.onset - WINDOW_BEFORE <= t <= p.peak + BURST_AFTER]
        near = [w for w in near if w]
        spam = safe_spam(Counter(near).most_common(1)[0][0]) if near else None
        spikes.append(_spike(p, lag, spam=spam, share=1.0 if spam else 0.0, mood=mood_of(spam) if spam else None))
    total = sum(v for v in lines if v is not None)
    return ChatSignal(
        source="screen",
        coverage=round(covered / len(lines), 4),
        messages=round(total),
        lag=float(lag),
        rate=[None if v is None else round(v * 10) / 10 for v in lines],
        spikes=_top(spikes),
        box=box,
    )


def _index(times: Sequence[float], t: float) -> int:
    return bisect.bisect_left(times, t)


def summary(sig: ChatSignal | None) -> int:
    """How many times chat went wild (unflagged spikes), for the analyze step's message."""
    return sum(1 for s in sig.spikes if s.counts) if sig else 0
