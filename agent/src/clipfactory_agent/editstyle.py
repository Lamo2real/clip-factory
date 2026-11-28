"""Reference videos, "Edit like these" (owner request 2026-11-28, docs/CONTRACTS.md §57): the edit style the agent
measured in each of the owner's reference videos, merged into one.

Two things come out of the ready reference rows (``REFVID#``, status ``"ready"``, a ``style`` dict):

- ``RenderStyle``: what the renderer can copy (render.py). Its defaults are exactly today's render, so a job with no
  ready reference renders byte for byte as before.
- ``section_text``: the "Reference videos: edit like these" section that goes after every skill in the skills block,
  so the moment finder, the hook and the captions are told about the style too. A task's own limits always win.

Merging: per field the most common value wins and a tie goes to the newest video (``createdAt``); numbers use the
median. A field no reference has keeps today's default. Every field is checked: a missing or broken one is ignored,
never an error."""

from __future__ import annotations

import math
import re
import statistics
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from html import escape
from typing import Any

SECTION_TITLE = "Reference videos: edit like these"
LIMIT_WINS = "When a task gives a limit, that limit wins."
MAX_REFS = 10
CAPTION_SIZES = {"small": 64, "medium": 82, "large": 100}
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")

LAYOUTS = {"split_facecam_top", "split_facecam_bottom", "full_frame", "blur_fill", "camera_only"}
ASPECTS = {"9:16", "1:1", "16:9", "4:5"}
TEXT_POSITIONS = {"top", "middle", "bottom", "none"}
POSITIONS = {"top", "middle", "bottom"}
SIZES = set(CAPTION_SIZES)
WEIGHTS = {"regular", "bold", "black"}
CASINGS = {"upper", "lower", "sentence", "title"}
HIGHLIGHT_MODES = {"word", "none"}
LOGO_SPOTS = {"none", "top_left", "top_right", "bottom_left", "bottom_right", "center"}
ZOOMS = {"none", "some", "many"}
ENDINGS = {"loop", "punchline", "call_to_action", "hard_cut", "fade"}


@dataclass(frozen=True)
class RenderStyle:
    """What render_clip copies from the reference videos. The defaults are today's render exactly."""

    fill: bool = False  # the whole frame over its blurred copy even when a facecam is found (full_frame / blur_fill)
    hook: bool = True  # the hook is burned in at the top
    captions: bool = True  # word-by-word captions are burned in
    words_per_line: int = 3  # 1..4
    caption_size: int = 82  # 64 / 82 / 100
    caption_bold: bool = True
    caption_color: str = "#FFFFFF"
    highlight_color: str | None = "#FFD400"  # the word being said; None: no highlight
    casing: str = "upper"  # upper | lower | sentence (as said) | title
    box: bool = False  # captions in a dark box (ASS BorderStyle 3)
    caption_middle: bool = False  # captions stand on y=1180 instead of the bottom of the safe area
    cut_silences: bool = True  # dead pauses in talk are cut
    punch_in: bool = True  # the punch-in on the face at the peak

    @property
    def is_default(self) -> bool:
        return self == DEFAULT


DEFAULT = RenderStyle()


@dataclass(frozen=True)
class Ref:
    """One ready reference video: its id, display name, when it was added and its measured style."""

    ref_id: str
    name: str
    created_at: str
    style: dict[str, Any]


# --- reading the rows ------------------------------------------------------------------------------------------------


def ready_refs(rows: Sequence[Any]) -> list[Ref]:
    """The ready reference rows with a ``style`` dict, newest first (at most MAX_REFS). Anything else is skipped."""
    out: list[Ref] = []
    for r in rows or []:
        if not isinstance(r, dict) or r.get("status") != "ready" or not isinstance(r.get("style"), dict):
            continue
        ref_id = r.get("refId") or str(r.get("sk", "")).removeprefix("REFVID#")
        out.append(Ref(str(ref_id or ""), _plain(r.get("name"), 60), str(r.get("createdAt") or ""), r["style"]))
    out.sort(key=lambda x: (x.created_at, x.ref_id), reverse=True)
    return out[:MAX_REFS]


def _get(style: dict[str, Any], path: str) -> Any:
    group, _, name = path.partition(".")
    part = style.get(group)
    return part.get(name) if isinstance(part, dict) else None


def _enum(allowed: set[str]) -> Callable[[Any], Any]:
    def check(v: Any) -> Any:
        if isinstance(v, str) and v.strip().lower() in allowed:
            return v.strip().lower()
        return None

    return check


def _bool(v: Any) -> Any:
    return v if isinstance(v, bool) else None


def _number(lo: float, hi: float) -> Callable[[Any], Any]:
    def check(v: Any) -> Any:
        if isinstance(v, bool) or not isinstance(v, int | float):
            return None
        f = float(v)
        if not math.isfinite(f):
            return None
        return max(lo, min(hi, f))

    return check


def _hex(v: Any) -> Any:
    return v.upper() if isinstance(v, str) and _HEX.match(v) else None


FIELDS: dict[str, Callable[[Any], Any]] = {
    "format.aspect": _enum(ASPECTS),
    "format.layout": _enum(LAYOUTS),
    "hook.seconds": _number(0, 5),
    "hook.textPosition": _enum(TEXT_POSITIONS),
    "captions.present": _bool,
    "captions.wordsPerLine": _number(1, 6),
    "captions.size": _enum(SIZES),
    "captions.weight": _enum(WEIGHTS),
    "captions.casing": _enum(CASINGS),
    "captions.color": _hex,
    "captions.highlightColor": _hex,
    "captions.highlightMode": _enum(HIGHLIGHT_MODES),
    "captions.outline": _bool,
    "captions.box": _bool,
    "captions.position": _enum(POSITIONS),
    "captions.emoji": _bool,
    "placement.logo": _enum(LOGO_SPOTS),
    "pacing.cutsPer10s": _number(0, 100),
    "pacing.avgShotSeconds": _number(0, 600),
    "pacing.zooms": _enum(ZOOMS),
    "pacing.jumpCuts": _bool,
    "pacing.lengthSeconds": _number(1, 600),
    "pacing.speedRamps": _bool,
    "audio.music": _bool,
    "audio.soundEffects": _bool,
    "audio.voiceover": _bool,
    "ending.type": _enum(ENDINGS),
}
NUMBERS = {
    "hook.seconds",
    "captions.wordsPerLine",
    "pacing.cutsPer10s",
    "pacing.avgShotSeconds",
    "pacing.lengthSeconds",
}


def merge(refs: Sequence[Ref]) -> dict[str, Any]:
    """The merged style, flat by path (``"captions.size"``). ``refs`` are newest first (as ``ready_refs`` gives them):
    the most common value wins, a tie goes to the newest; numbers use the median. A field no reference has is left
    out."""
    out: dict[str, Any] = {}
    for path, check in FIELDS.items():
        values = [v for v in (check(_get(r.style, path)) for r in refs) if v is not None]
        if not values:
            continue
        if path in NUMBERS:
            out[path] = float(statistics.median(values))
            continue
        counts = Counter(values)
        best = max(counts.values())
        out[path] = next(v for v in values if counts[v] == best)  # values are newest first: the newest of the tie
    return out


def render_style(refs: Sequence[Ref]) -> RenderStyle:
    """What the renderer copies from the merged style (the support table in §57). Anything not set stays today's."""
    m = merge(refs)
    if not m:
        return DEFAULT
    wpl = m.get("captions.wordsPerLine")
    highlight: str | None = DEFAULT.highlight_color
    if m.get("captions.highlightMode") == "none":
        highlight = None
    elif "captions.highlightColor" in m:
        highlight = m["captions.highlightColor"]
    return RenderStyle(
        fill=m.get("format.layout") in ("full_frame", "blur_fill"),
        hook=m.get("hook.textPosition") != "none",
        captions=m.get("captions.present") is not False,
        words_per_line=DEFAULT.words_per_line if wpl is None else max(1, min(4, round(wpl))),
        caption_size=CAPTION_SIZES.get(m.get("captions.size", ""), DEFAULT.caption_size),
        caption_bold=m.get("captions.weight") != "regular",
        caption_color=m.get("captions.color", DEFAULT.caption_color),
        highlight_color=highlight,
        casing=m.get("captions.casing", DEFAULT.casing),
        box=m.get("captions.box") is True,
        caption_middle=m.get("captions.position") == "middle",
        cut_silences=m.get("pacing.jumpCuts") is not False,
        punch_in=m.get("pacing.zooms") != "none",
    )


def unsupported(style: dict[str, Any]) -> list[str]:
    """The short plain lines of what the renderer cannot copy yet from one reference's style (the support table)."""
    if not isinstance(style, dict):
        return []
    m = merge([Ref("", "", "", style)])
    out: list[str] = []
    if m.get("format.layout") == "split_facecam_bottom":
        out.append("Facecam at the bottom")
    if m.get("format.aspect") not in (None, "9:16"):
        out.append("Square or wide videos")
    if m.get("hook.textPosition") == "middle":
        out.append("Hook text in the middle")
    elif m.get("hook.textPosition") == "bottom":
        out.append("Hook text at the bottom")
    if m.get("captions.position") == "top":
        out.append("Captions at the top")
    if m.get("captions.emoji") is True:
        out.append("Emoji in captions")
    if m.get("pacing.zooms") == "many":
        out.append("Many zooms")
    if m.get("pacing.speedRamps") is True:
        out.append("Speed ramps")
    if m.get("placement.logo") not in (None, "none"):
        out.append("A logo on every clip")
    if m.get("audio.music") is True:
        out.append("Added music")
    if m.get("audio.soundEffects") is True:
        out.append("Sound effects")
    return out


# --- the skills-block section ----------------------------------------------------------------------------------------


def _plain(v: Any, limit: int) -> str:
    """Text from a stored row for the prompt: one line, cut to ``limit``, no tags."""
    if not isinstance(v, str):
        return ""
    return escape(" ".join(v.split())[:limit], quote=False)


def _secs(v: float) -> str:
    return f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"


LAYOUT_TEXT = {
    "split_facecam_top": "facecam on top, the game below",
    "split_facecam_bottom": "game on top, facecam below",
    "full_frame": "the whole frame, no split",
    "blur_fill": "the whole frame over a blurred copy",
    "camera_only": "the camera only",
}


def _style_lines(m: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    fmt = [x for x in (m.get("format.aspect"), LAYOUT_TEXT.get(m.get("format.layout", ""))) if x]
    if fmt:
        lines.append("- Format: " + ", ".join(fmt) + ".")
    hook: list[str] = []
    if "hook.seconds" in m:
        hook.append(f"lands in the first {_secs(m['hook.seconds'])} s")
    pos = m.get("hook.textPosition")
    if pos == "none":
        hook.append("no hook text on screen")
    elif pos:
        hook.append(f"hook text at the {pos}")
    if hook:
        lines.append("- Hook: " + ", ".join(hook) + ".")
    if m.get("captions.present") is False:
        lines.append("- Captions: none.")
    else:
        cap: list[str] = []
        if "captions.wordsPerLine" in m:
            n = max(1, round(m["captions.wordsPerLine"]))
            cap.append(f"{n} word{'s' if n != 1 else ''} a line")
        cap += [m[k] for k in ("captions.size", "captions.weight") if k in m]
        if "captions.casing" in m:
            cap.append(f"{m['captions.casing']} case")
        if "captions.color" in m:
            cap.append(f"colour {m['captions.color']}")
        if m.get("captions.highlightMode") == "none":
            cap.append("no highlight")
        elif "captions.highlightColor" in m:
            cap.append(f"the said word in {m['captions.highlightColor']}")
        if m.get("captions.box") is True:
            cap.append("in a box")
        if "captions.position" in m:
            cap.append(f"at the {m['captions.position']}")
        if m.get("captions.emoji") is True:
            cap.append("with emoji")
        if cap:
            lines.append("- Captions: " + ", ".join(cap) + ".")
    pace: list[str] = []
    if "pacing.cutsPer10s" in m:
        pace.append(f"about {_secs(m['pacing.cutsPer10s'])} cuts per 10 s")
    if "pacing.avgShotSeconds" in m:
        pace.append(f"shots of about {_secs(m['pacing.avgShotSeconds'])} s")
    if "pacing.jumpCuts" in m:
        pace.append("pauses cut" if m["pacing.jumpCuts"] else "pauses kept")
    if "pacing.zooms" in m:
        pace.append(f"{m['pacing.zooms']} zooms" if m["pacing.zooms"] != "none" else "no zooms")
    if m.get("pacing.speedRamps") is True:
        pace.append("speed ramps")
    if pace:
        lines.append("- Pacing: " + ", ".join(pace) + ".")
    if "pacing.lengthSeconds" in m:
        lines.append(f"- Length: about {_secs(m['pacing.lengthSeconds'])} s.")
    if "ending.type" in m:
        lines.append(f"- Ending: {m['ending.type'].replace('_', ' ')}.")
    return lines


def _hook_line(i: int, r: Ref) -> str:
    found = r.style.get("hook")
    hook: dict[str, Any] = found if isinstance(found, dict) else {}
    bits: list[str] = []
    pattern = _plain(hook.get("pattern"), 120)
    if pattern:
        bits.append(pattern)
    for label, key, limit in (("on screen", "onScreenText", 80), ("said", "spoken", 160), ("shown", "visual", 160)):
        text = _plain(hook.get(key), limit)
        if text:
            bits.append(f'{label}: "{text}"')
    ending = r.style.get("ending")
    if isinstance(ending, dict):
        notes = _plain(ending.get("notes"), 120)
        if notes:
            bits.append(f"ends: {notes}")
    name = r.name or f"Video {i}"
    return f'{i}. "{name}": ' + ("; ".join(bits) if bits else "no hook noted") + "."


def section_text(refs: Sequence[Ref]) -> str:
    """The "Reference videos: edit like these" section for the skills block (after every skill). Empty when there is
    no ready reference."""
    if not refs:
        return ""
    lines = [
        f'<reference_videos count="{len(refs)}">',
        SECTION_TITLE,
        "The owner's reference videos show how every clip should be edited: format, hook, captions, placement and "
        "pacing. Make the clips like them, together with the skills above.",
        "Most of them:",
        *_style_lines(merge(refs)),
        "Each reference's hook:",
        *(_hook_line(i, r) for i, r in enumerate(refs, start=1)),
        LIMIT_WINS,
        "</reference_videos>",
    ]
    return "\n".join(lines)


def build(rows: Sequence[Any]) -> tuple[RenderStyle | None, str]:
    """``(render style, section text)`` from the owner's reference rows; ``(None, "")`` with no ready reference."""
    refs = ready_refs(rows)
    if not refs:
        return None, ""
    return render_style(refs), section_text(refs)
