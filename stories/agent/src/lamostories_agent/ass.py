"""The engine's text track as an ASS subtitle file, burned into the video by libass (docs/CONTRACTS.md §45.11.3).

``textTrack`` gives every caption, bubble symbol and the safety end card with its time, centre, size and colour in
output pixels. Here each becomes one ``Dialogue`` line in Inter, kept inside the platforms' safe area (their buttons
and captions cover the right edge, the top and the bottom of a 9:16 video; a square or wide video has narrower
margins), long captions wrapped on word breaks. The file is laid out for the script's own size (any of the engine's
six, §45.34). Nothing a model wrote can reach libass as an override: braces and backslashes are replaced."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

WIDTH = 1080
HEIGHT = 1920
FONT = "Inter"
# The safe area of TikTok, Reels and Shorts: what their own buttons and text leave free on a 1080 × 1920 video.
SAFE_LEFT = 80
SAFE_RIGHT = WIDTH - 170
SAFE_TOP = 260
SAFE_BOTTOM = HEIGHT - 480
MAX_LINE = 22  # characters per caption line before a wrap
DEFAULT_COLOR = "#fff6e5"
OUTLINE = "&H00421C1C"  # the stage's night indigo (#1C1842), as ASS's &HAABBGGRR
KINDS = ("caption", "bubble", "endcard")


@dataclass(frozen=True)
class Frame:
    """One video shape's text layout in its own pixels: the safe area, how much a 1080-wide layout is scaled, and how
    many characters fit on one caption line."""

    width: int
    height: int
    left: int
    right: int
    top: int
    bottom: int
    scale: float
    line: int


def frame(width: int = WIDTH, height: int = HEIGHT) -> Frame:
    """The safe area of a ``width`` × ``height`` video: 9:16 keeps clear of TikTok's, Reels' and Shorts' buttons and
    texts (the right column, the top tabs, the bottom bar); 1:1 and 16:9 have only thin margins with a little more at
    the bottom (the players' bars)."""
    w, h = max(1, int(width)), max(1, int(height))
    ratio = w / h
    if ratio < 0.8:  # 9:16
        left, right, top, bottom, line = 80 / 1080 * w, 170 / 1080 * w, 260 / 1920 * h, 480 / 1920 * h, MAX_LINE
    elif ratio < 1.3:  # 1:1
        left, right, top, bottom, line = 0.06 * w, 0.06 * w, 0.06 * h, 0.12 * h, 26
    else:  # 16:9
        left, right, top, bottom, line = 0.05 * w, 0.05 * w, 0.07 * h, 0.14 * h, 40
    return Frame(w, h, round(left), w - round(right), round(top), h - round(bottom), min(w, h) / 1080, line)


HEADER = """[Script Info]
; Lamo Stories captions (docs/CONTRACTS.md §45.11.3)
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font},64,&H00E5F6FF,&H000000FF,{outline},&H96000000,-1,0,0,0,100,100,0,0,1,7,3,5,{ml},{mr},0,1
Style: Bubble,{font},72,&H00421C1C,&H000000FF,&H00E5F6FF,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,5,0,0,0,1
Style: EndCard,{font},54,&H00E5F6FF,&H000000FF,&H00421C1C,&H00421C1C,-1,0,0,0,100,100,0,0,3,24,0,5,{ml},{mr},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_color(hex_color: str) -> str:
    """``#rrggbb`` as ASS's ``&HBBGGRR&``; anything else is the cream caption colour."""
    c = hex_color if isinstance(hex_color, str) and len(hex_color) == 7 and hex_color[0] == "#" else DEFAULT_COLOR
    try:
        int(c[1:], 16)
    except ValueError:
        c = DEFAULT_COLOR
    return f"&H{c[5:7].upper()}{c[3:5].upper()}{c[1:3].upper()}&"


def ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def clean(text: str) -> str:
    """Plain text for a Dialogue line: no override blocks, no escapes, one line per ``\\N``."""
    t = str(text or "").replace("\r", " ").replace("\\", "/").replace("{", "(").replace("}", ")")
    return " ".join(t.replace("\n", " ").split())


def wrap(text: str, width: int = MAX_LINE) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines or [""]


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def dialogue(e: dict[str, Any], f: Frame | None = None) -> str | None:
    f = f or frame()
    kind = str(e.get("kind") or "caption")
    if kind not in KINDS:
        return None
    raw = str(e.get("text") or "")
    text = clean(raw)
    if not text:
        return None
    start, end = float(e.get("start") or 0), float(e.get("end") or 0)
    if end <= start:
        return None
    size = round(_clamp(float(e.get("size") or 64 * f.scale), 28 * f.scale, 140 * f.scale))
    x, y = float(e.get("x") or f.width / 2), float(e.get("y") or f.height * 0.78)
    if kind == "bubble":
        style = "Bubble"
        edge = 40 * f.scale
        x, y = _clamp(x, edge, f.width - edge), _clamp(y, edge, f.height - edge)
        body = text
    else:
        style = "Caption" if kind == "caption" else "EndCard"
        # The engine lays the text out itself (its lines joined by "\n", x/y the centre of the block, §45.10): its
        # breaks are kept as they are, so the video shows what the preview shows; unbroken text is wrapped here.
        given = [clean(part) for part in raw.split("\n")]
        given = [part for part in given if part]
        lines = given if len(given) > 1 else wrap(text, f.line if kind == "caption" else f.line + 6)
        half_h = size * 0.62 * len(lines)
        inset = min(200 * f.scale, (f.right - f.left) / 2)
        x = _clamp(x, f.left + inset, f.right - inset)
        y = _clamp(y, f.top + half_h, f.bottom - half_h)
        body = "\\N".join(lines)
    color = ass_color(str(e.get("color") or DEFAULT_COLOR))
    tags = f"{{\\an5\\pos({round(x)},{round(y)})\\fs{size}\\1c{color}\\fad(120,120)}}"
    layer = 2 if kind == "endcard" else 1 if kind == "bubble" else 0
    return f"Dialogue: {layer},{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{tags}{body}"


def needs_file(events: Sequence[dict[str, Any]], captions_on: bool) -> bool:
    """Whether the captions step has anything to draw: captions when they are on, or any bubble or end card."""
    for e in events:
        kind = e.get("kind")
        if kind in ("bubble", "endcard") or (kind == "caption" and captions_on):
            return True
    return False


def build(
    events: Sequence[dict[str, Any]], *, captions_on: bool = True, width: int = WIDTH, height: int = HEIGHT
) -> str:
    """The whole ASS file for a ``width`` × ``height`` video; captions are left out when the story's captions are off
    (bubbles and the end card stay)."""
    f = frame(width, height)
    head = HEADER.format(w=f.width, h=f.height, font=FONT, outline=OUTLINE, ml=f.left, mr=f.width - f.right)
    lines = []
    for e in sorted(events, key=lambda e: (float(e.get("start") or 0), str(e.get("kind")))):
        if e.get("kind") == "caption" and not captions_on:
            continue
        line = dialogue(e, f)
        if line:
            lines.append(line)
    return head + "\n".join(lines) + ("\n" if lines else "")
