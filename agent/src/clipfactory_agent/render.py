"""Cutting one clip with ffmpeg: 1080×1920 at 30 fps, facecam on top (or a blurred fill), dead pauses cut, an
optional payoff tease first, the hook and word-by-word captions burned in with libass inside every platform's safe
area, a smooth punch-in on the face at the peak, loudness normalised to -14 LUFS, a cover at the peak.

A Content Rewards campaign clip (docs/CONTRACTS.md §38.13) also carries a mark row at the top of the safe area: the
brand's logo on the right for the whole clip and "Paid partnership" on the left for the first 3 seconds. The band
above the picture grows by 80 px to hold it, so neither ever covers a face, the game or a caption.

"Your take" (owner request 2026-11-27): a clip that is not a campaign clip may carry one sentence that is the
channel's own comment. It shows in a dark see-through box right above the caption band, starting just after the tease,
and a voice may read it out loud over the clip's own sound, which is turned down while the voice talks."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import livestatus, loudness, proc
from .bedrock import Facecam, FrameLayout
from .moments import Moment
from .util import log
from .voice import Spoken

W, H = 1080, 1920
FPS = 30
# The parts of the picture the apps cover with their own buttons and text (TikTok, Shorts, Reels, Facebook, X): the
# top 10% (tabs), the bottom 25% (name, caption, sound) and the right 15% (like, comment, share). No word and no face
# goes there. SAFE is (left, top, right, bottom) in pixels; the left edge is only a margin.
SAFE = (60, round(H * 0.10), round(W * 0.85), round(H * 0.75))  # (60, 192, 918, 1440)
BAND = 400  # the band above the facecam (or the picture) that holds the hook
CAM_H = 560
FILL_H = 880  # the picture's height in blur_fill
HOOK_TOP = SAFE[1] + 20  # the hook's first line starts here and the hook grows down
# The mark row of a campaign clip (§38.13): y = 192…272, inside the band, above every face and picture. The band
# grows by its 80 px (the facecam or picture starts 80 px lower) and the hook moves down under it.
CAMPAIGN_BAND = 480
MARK_TOP, MARK_H = SAFE[1], 80
CAMPAIGN_HOOK_TOP = 288
LOGO_W = 380  # the logo fits 380 × 80, right-aligned on the safe area's right edge
DISCLOSURE_SECONDS = 3.0
DISCLOSURE_SIZE = 46
DISCLOSURE_FADE_MS = 300
DISCLOSURE_FIT = 16  # characters that fit at full size beside the widest logo; longer words are set smaller
CAP_BOTTOM = SAFE[3] - 60  # the captions' last line ends here and longer captions grow up
TEXT_MARGIN_L, TEXT_MARGIN_R = SAFE[0], W - SAFE[2] + 10  # libass wraps text between these
# The areas a Review overlay (logo or text, §53 C3) is warned about, as (left, top, right, bottom) in the 1080 × 1920
# frame; the web copies them in web/src/lib/overlayAreas.ts and a test pins both. The captions (82 px, up to two
# lines of about 100 px each) stand on CAP_BOTTOM and grow up; the facecam picture of a ``facecam_top`` clip fills the
# full width between the hook band and the gameplay.
CAPTION_LINE_H, CAPTION_LINES = 100, 2
CAPTION_BAND = (TEXT_MARGIN_L, CAP_BOTTOM - CAPTION_LINES * CAPTION_LINE_H, W - TEXT_MARGIN_R, CAP_BOTTOM)
FACECAM_BAND = (0, BAND, W, BAND + CAM_H)
# "Your take": at most two lines between x = 60 and x = 908, in a dark see-through box whose bottom edge stands on
# y = 1168, just above the caption band (1180…1380) and below the facecam. It comes in TAKE_DELAY seconds after the
# tease and stays TAKE_SECONDS, or as long as the voice talks plus TAKE_VOICE_TAIL, and is gone TAKE_END_GAP before
# the clip ends.
TAKE_SIZE = 46
TAKE_MIN_SIZE = 30
TAKE_FIT = 54  # characters that fit in two lines at full size; a longer take is set smaller
TAKE_PAD = 12  # the box reaches this far around the words
TAKE_LEFT, TAKE_RIGHT = SAFE[0], W - TEXT_MARGIN_R
TAKE_BOTTOM = CAPTION_BAND[1] - 12
TAKE_BOX = "&H66000000"  # black, 60% solid (ASS alpha runs the other way: 00 is solid)
TAKE_DELAY = 0.4
TAKE_SECONDS = 4.0
TAKE_VOICE_TAIL = 0.8
TAKE_END_GAP = 0.2
TAKE_SHORTEST = 1.5  # with less room than this the take is left out
TAKE_FADE_MS = (150, 200)
# While the voice reads the take the clip's own sound plays at DUCK of its level, eased down and up over DUCK_FADE.
DUCK = 0.3
DUCK_FADE = 0.15
# The punch-in on the face at the peak: up to 120%, eased in over 0.4 s, held, eased out over 0.6 s. It zooms toward a
# point a little above the middle of the camera picture, where a webcam's face sits, so the face is never cut off.
PUNCH_ZOOM = 1.2
PUNCH_IN, PUNCH_HOLD, PUNCH_OUT = 0.4, 1.2, 0.6
PUNCH_ANCHOR = (0.5, 0.4)
_SAFE_PATH = re.compile(r"^[A-Za-z0-9/_.-]+$")
_SILENCE = re.compile(r"silence_(start|end): (-?[\d.]+)")
_TRAILING = re.compile(r"[.,!?;:\"“”]+$")
_CROP = re.compile(r"crop=(-?\d+):(-?\d+):(-?\d+):(-?\d+)")
LOGO_MAX = 2000  # a larger logo is scaled down before it is used
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
LOGO_BYTES_MAX = 20 * 1024 * 1024  # the API takes up to 10 MB (§38.8); anything bigger is not read at all
LOGO_PIXELS_MAX = 40_000_000  # a picture that would take more memory than this once decoded is refused unread
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
YELLOW = "&H0000D4FF&"  # #FFD400 in ASS's &HBBGGRR& order

Segment = tuple[float, float]


@dataclass
class TimedWord:
    t0: float
    t1: float
    text: str


@dataclass
class Phrase:
    t0: float
    t1: float
    words: list[TimedWord]

    @property
    def text(self) -> str:
        return clean_caption(" ".join(w.text for w in self.words))


@dataclass(frozen=True)
class Marks:
    """What a campaign clip shows in its mark row (§38.13): the prepared logo (``logo.png``) and the on-screen
    disclosure words ("Paid partnership"). Each may be missing."""

    logo: Path | None = None
    disclosure: str | None = None

    @property
    def any(self) -> bool:
        return self.logo is not None or bool(self.disclosure)


@dataclass(frozen=True)
class TakeShown:
    """A take on screen: its words and when it shows, in clip seconds."""

    text: str
    start: float
    end: float


@dataclass(frozen=True)
class VoiceMix:
    """The take's voice in the filter graph: its input index (``voice_input``), when it starts and how long it talks
    (clip seconds). ``silent`` is the silence's input index when the clip has no sound of its own."""

    input: int
    start: float
    seconds: float
    silent: int | None = None


@dataclass
class RenderResult:
    video: Path
    cover: Path
    duration: float
    segments: list[Segment]  # in source seconds
    captions: list[dict[str, Any]]
    layout: str
    tease: bool
    frame_layout: FrameLayout | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    logo: bool = False  # the campaign's logo is on screen the whole clip
    disclosure: bool = False  # the on-screen disclosure shows at the start
    take: str = ""  # "Your take" as it shows on screen; empty when the clip has none
    take_spoken: bool = False  # a voice reads the take out loud


def even(n: float) -> int:
    return max(2, round(n / 2) * 2)


def parse_silences(stderr: str, offset: float, end: float) -> list[Segment]:
    """``silencedetect`` output as ``[start, end]`` pairs, shifted by ``offset`` (the ``-ss`` used)."""
    out: list[Segment] = []
    start: float | None = None
    for kind, value in _SILENCE.findall(stderr):
        t = float(value) + offset
        if kind == "start":
            start = t
        elif start is not None:
            out.append((start, t))
            start = None
    if start is not None:
        out.append((start, end))
    return out


def keep_segments(
    a: float, b: float, quiet: Sequence[Segment], pad: float = 0.15, min_cut: float = 0.4
) -> list[Segment]:
    """``[a, b]`` with the silent stretches removed, leaving ``pad`` seconds of breathing room on each side."""
    segs: list[Segment] = [(a, b)]
    for s, e in quiet:
        cs, ce = s + pad, e - pad
        if ce - cs < min_cut:
            continue
        nxt: list[Segment] = []
        for x, y in segs:
            if ce <= x or cs >= y:
                nxt.append((x, y))
            else:
                nxt += [(p, q) for p, q in ((x, cs), (ce, y)) if q - p > 0.3]
        segs = nxt
    return segs


def retime(words: Sequence[Sequence[Any]], segs: Sequence[Segment]) -> list[TimedWord]:
    """Source-timed words mapped onto the edited clip's timeline (segments in source seconds, played in order)."""
    out: list[TimedWord] = []
    offset = 0.0
    for a, b in segs:
        for w in words:
            s, e = float(w[0]), float(w[1])
            if a - 0.05 <= s < b:
                t0 = offset + max(0.0, s - a)
                out.append(TimedWord(round(t0, 3), round(max(t0 + 0.05, offset + min(b, e) - a), 3), str(w[2])))
        offset += b - a
    return out


def phrases(words: Sequence[TimedWord], max_words: int = 3, gap: float = 0.45) -> list[Phrase]:
    """Short on-screen phrases: at most ``max_words`` words, broken at pauses and punctuation."""
    out: list[Phrase] = []
    cur: Phrase | None = None
    for w in words:
        if (
            cur is None
            or len(cur.words) >= max_words
            or w.t0 - cur.t1 > gap
            or re.search(r"[.?!,]$", cur.words[-1].text)
        ):
            cur = Phrase(w.t0, w.t1, [w])
            out.append(cur)
        else:
            cur.words.append(w)
            cur.t1 = w.t1
    return out


def clean_caption(text: str) -> str:
    return _TRAILING.sub("", text).lstrip('"“').upper()


def ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(text: str) -> str:
    """Plain text for an ASS event: no override blocks, no line breaks, no hard spaces from the model."""
    return " ".join(text.replace("\\", "/").replace("{", "(").replace("}", ")").split())


def hook_markup(hook: str) -> str:
    """The hook with its last one or two words in yellow (the curiosity gap)."""
    words = ass_escape(hook).split()
    if len(words) < 2:
        return " ".join(words)
    cut = max(1, len(words) - (2 if len(words) > 6 else 1))
    return " ".join(words[:cut]) + " {\\c" + YELLOW + "}" + " ".join(words[cut:])


def disclosure_event(text: str) -> str:
    """The on-screen disclosure (§38.13): left in the mark row, from 0 to DISCLOSURE_SECONDS, fading out. The words are
    escaped like every text from outside (no override blocks, no line breaks); words too long to sit beside the logo
    are set smaller."""
    words = ass_escape(text)
    size = DISCLOSURE_SIZE if len(words) <= DISCLOSURE_FIT else max(28, DISCLOSURE_SIZE * DISCLOSURE_FIT // len(words))
    fs = "" if size == DISCLOSURE_SIZE else f"\\fs{size}"
    pos = f"\\an4\\pos({SAFE[0]},{MARK_TOP + MARK_H // 2})"
    return (
        f"Dialogue: 2,{ass_time(0)},{ass_time(DISCLOSURE_SECONDS)},Disclosure,,0,0,0,,"
        f"{{{pos}{fs}\\fad(0,{DISCLOSURE_FADE_MS})}}{words}"
    )


def take_window(total: float, tease: float = 0.0, voice: float = 0.0) -> tuple[float, float] | None:
    """When the take shows, in clip seconds: from TAKE_DELAY after the tease (``tease`` is its length, 0 without one)
    for TAKE_SECONDS, or for as long as the voice talks (``voice`` seconds) plus TAKE_VOICE_TAIL when that is longer;
    never past TAKE_END_GAP before the end. None when the clip has no room for it."""
    start = max(0.0, tease) + TAKE_DELAY
    end = min(start + max(TAKE_SECONDS, voice + TAKE_VOICE_TAIL), total - TAKE_END_GAP)
    if end - start < TAKE_SHORTEST:
        return None
    return round(start, 3), round(end, 3)


def take_size(text: str) -> int:
    """The take's font size: TAKE_SIZE, smaller for a long take so it still fits in two lines."""
    n = len(text)
    return TAKE_SIZE if n <= TAKE_FIT else max(TAKE_MIN_SIZE, TAKE_SIZE * TAKE_FIT // n)


def take_event(take: TakeShown) -> str:
    """The take's one event: white words in the Take style's dark see-through box, standing on TAKE_BOTTOM, fading in
    and out. The words are escaped like every text from outside (no override blocks, no line breaks)."""
    words = ass_escape(take.text)
    size = take_size(words)
    fs = "" if size == TAKE_SIZE else f"\\fs{size}"
    fade_in, fade_out = TAKE_FADE_MS
    return (
        f"Dialogue: 3,{ass_time(take.start)},{ass_time(take.end)},Take,,0,0,0,,"
        f"{{\\fad({fade_in},{fade_out}){fs}}}{words}"
    )


def take_style() -> str:
    """The Take style: Inter Bold, white, in an opaque box (BorderStyle 3, whose colour is the outline's) that reaches
    TAKE_PAD around the words. The margins keep the box between TAKE_LEFT and TAKE_RIGHT with its bottom on
    TAKE_BOTTOM (alignment 2, like the captions)."""
    ml, mr = TAKE_LEFT + TAKE_PAD, W - TAKE_RIGHT + TAKE_PAD
    return (
        f"Style: Take,Inter,{TAKE_SIZE},&H00FFFFFF,&H00FFFFFF,{TAKE_BOX},&H00000000,-1,0,0,0,100,100,0,0,3,{TAKE_PAD},0,2,"
        f"{ml},{mr},{H - TAKE_BOTTOM + TAKE_PAD},1\n"
    )


def build_ass(
    hook: str,
    caps: Sequence[Phrase],
    total: float,
    *,
    hook_top: int = HOOK_TOP,
    disclosure: str | None = None,
    take: TakeShown | None = None,
) -> str:
    """The subtitle file: the hook for the whole clip, then each phrase with the word being said in yellow. Both sit
    inside SAFE: the hook hangs from ``hook_top`` (alignment 8), the captions stand on CAP_BOTTOM (alignment 2), and
    libass wraps them between the left margin and the buttons on the right. A campaign clip passes CAMPAIGN_HOOK_TOP
    and its ``disclosure`` words, which get their own style and event in the mark row. ``take`` adds the Take style
    and its one event; without it the file is exactly what it was."""
    ml, mr = TEXT_MARGIN_L, TEXT_MARGIN_R
    disclosure_style = (
        f"Style: Disclosure,Inter,{DISCLOSURE_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,5,2,4,"
        f"{ml},{mr},0,1\n"
        if disclosure
        else ""
    ) + (take_style() if take else "")
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Inter,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,7,3,8,{ml},{mr},{hook_top},1
Style: Caption,Inter,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,9,4,2,{ml},{mr},{H - CAP_BOTTOM},1
{disclosure_style}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [f"Dialogue: 1,{ass_time(0)},{ass_time(total)},Hook,,0,0,0,,{hook_markup(hook)}"]
    if disclosure:
        events.append(disclosure_event(disclosure))
    if take:
        events.append(take_event(take))
    for i, p in enumerate(caps):
        nxt = caps[i + 1].t0 if i + 1 < len(caps) else total
        end = min(total, max(p.t1, p.t0 + 0.25), nxt)
        words = [clean_caption(ass_escape(w.text)) for w in p.words]
        for j, w in enumerate(p.words):
            start = p.t0 if j == 0 else w.t0
            stop = p.words[j + 1].t0 if j + 1 < len(p.words) else end
            if stop - start < 0.02:
                continue
            text = " ".join(f"{{\\c{YELLOW}}}{t}{{\\c&H00FFFFFF&}}" if k == j else t for k, t in enumerate(words))
            events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(stop)},Caption,,0,0,0,,{text}")
    return head + "\n".join(events) + "\n"


def punch_zoom(peak: float) -> str:
    """zoompan's zoom for each frame: 1 until just before ``peak`` (clip seconds), eased up to PUNCH_ZOOM, held, then
    eased back to 1 (smoothstep both ways, so the picture never jumps)."""
    t = f"(in/{FPS})"
    a, b = peak - PUNCH_IN, peak + PUNCH_HOLD + PUNCH_OUT
    u = f"clip(min(({t}-{a:.3f})/{PUNCH_IN}\\,({b:.3f}-{t})/{PUNCH_OUT})\\,0\\,1)"
    return f"1+{PUNCH_ZOOM - 1:.2f}*{u}*{u}*(3-2*{u})"


def punch_in(peak: float, w: int, h: int) -> str:
    """Filters that turn a picture already scaled to ``2w × 2h`` into ``w × h`` with the punch-in at ``peak``. Working
    at twice the size keeps zoompan's whole-pixel steps at half a pixel of the result, so the zoom is smooth."""
    ax, ay = PUNCH_ANCHOR
    return f"zoompan=z={punch_zoom(peak)}:x=(iw-iw/zoom)*{ax}:y=(ih-ih/zoom)*{ay}:d=1:s={w}x{h}:fps={FPS}"


def layout_parts(
    fc: Facecam | None,
    src_w: int,
    src_h: int,
    *,
    peak: float | None = None,
    face_fill: bool = False,
    band: int = BAND,
) -> list[str]:
    """Filter chains from ``[vin]`` to ``[lay]``. ``peak`` (clip seconds) adds the punch-in on the face: on the
    facecam, or on the whole picture when ``face_fill`` (a camera shot with no facecam box). ``band`` is the height
    above the facecam or picture: CAMPAIGN_BAND for a campaign clip's mark row (the gameplay below gets 80 px less)."""
    blur = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:2,eq=brightness=-0.18"
    if fc:
        # Facecam under the hook band, gameplay below (the layout the skills assume), over a blurred copy.
        game_y = band + CAM_H
        game_h = H - game_y
        cx, cy, cw, ch = even(fc.x * src_w), even(fc.y * src_h), even(fc.w * src_w), even(fc.h * src_h)
        cw, ch = min(cw, src_w - cx), min(ch, src_h - cy)
        gh = src_h
        gw = min(src_w, even(gh * W / game_h))
        gx = even((src_w - gw) / 2)
        if peak is None:
            cam = f"scale={W}:{CAM_H}:force_original_aspect_ratio=increase,crop={W}:{CAM_H}"
        else:
            cam = (
                f"scale={2 * W}:{2 * CAM_H}:force_original_aspect_ratio=increase,crop={2 * W}:{2 * CAM_H},"
                + punch_in(peak, W, CAM_H)
            )
        return [
            "[vin]split=3[bgs][cams][games]",
            f"[bgs]{blur}[bg]",
            f"[cams]crop={cw}:{ch}:{cx}:{cy},{cam}[cam]",
            f"[games]crop={gw}:{gh}:{gx}:0,scale={W}:{game_h}:force_original_aspect_ratio=increase,crop={W}:{game_h}[game]",
            f"[bg][cam]overlay=0:{band}[l1]",
            f"[l1][game]overlay=0:{game_y}[lay]",
        ]
    # No facecam: the whole frame, a little zoomed, under the hook band, over a blurred copy of itself.
    fg_h, fg_y = FILL_H, band
    if peak is not None and face_fill:
        fw = min(W, even(src_w * fg_h / max(1, src_h)))
        fg = f"scale=-2:{2 * fg_h},crop=min(iw\\,{2 * fw}):{2 * fg_h}," + punch_in(peak, fw, fg_h)
    else:
        fg = f"scale=-2:{fg_h},crop=min(iw\\,{W}):{fg_h}"
    return [
        "[vin]split=2[bgs][fgs]",
        f"[bgs]{blur}[bg]",
        f"[fgs]{fg}[fg]",
        f"[bg][fg]overlay=(W-w)/2:{fg_y}[lay]",
    ]


def silent_input(tease: bool) -> int:
    """The silence's input index (a clip with no sound of its own): right after the section and the tease's input."""
    return 2 if tease else 1


def voice_input(tease: bool, has_audio: bool) -> int:
    """The take's voice's input index: after the section, the tease's own input and the silence."""
    return 1 + (1 if tease else 0) + (0 if has_audio else 1)


def logo_input(tease: bool, has_audio: bool, voice: bool = False) -> int:
    """The logo's input index: it is the last input, after the section, the tease's own input, the silence and the
    take's voice."""
    return voice_input(tease, has_audio) + (1 if voice else 0)


def duck_volume(start: float, seconds: float) -> str:
    """The ``volume`` filter that turns the clip's own sound down to DUCK while the voice talks (``start`` for
    ``seconds``, clip seconds), eased down and back up over DUCK_FADE so nothing jumps."""
    a, b = max(0.0, start - DUCK_FADE), start + seconds + DUCK_FADE
    u = f"clip(min((t-{a:.3f})/{DUCK_FADE}\\,({b:.3f}-t)/{DUCK_FADE})\\,0\\,1)"
    return f"volume=volume=1-{1 - DUCK:.2f}*{u}:eval=frame"


def voice_chains(v: VoiceMix, has_audio: bool) -> list[str]:
    """The chains that mix the take's voice into the clip's sound and end in ``[aout]``. With sound the clip's own
    (``[aclip]``, what ``concat`` made) is ducked under the voice; without, the voice plays over the silence. The
    voice is brought to 48 kHz stereo, faded in and out by a hair and delayed to its start. ``amix`` keeps both at
    their own level (``normalize=0``) and lasts as long as the clip's sound; the loudness pass levels the result."""
    fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    fade_out = max(0.0, v.seconds - 0.05)
    voice = (
        f"[{v.input}:a]{fmt},afade=t=in:d=0.03,afade=t=out:st={fade_out:.3f}:d=0.05,"
        f"adelay=delays={round(v.start * 1000)}:all=1[tvoice]"
    )
    mix = "amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
    if has_audio:
        return [f"[aclip]{fmt},{duck_volume(v.start, v.seconds)}[aduck]", voice, f"[aduck][tvoice]{mix}"]
    if v.silent is None:
        raise ValueError("a clip with no sound needs the silence's input to carry the voice")
    return [voice, f"[{v.silent}:a][tvoice]{mix}"]


def filter_graph(
    segs: Sequence[Segment],
    parts: Sequence[str],
    ass_file: Path,
    has_audio: bool,
    *,
    tease: bool = False,
    logo: int | None = None,
    voice: VoiceMix | None = None,
) -> str:
    """One graph: trim each segment (section seconds), concat, normalise to 30 fps, lay out, burn the subtitles.

    With ``tease`` the first segment is the payoff tease, which plays first but sits later in the section. It comes
    from its own input (``[1:v]``/``[1:a]``, the section opened again at the tease), so ``concat`` never has to hold
    every frame of the body in memory while it waits for the tease (that is gigabytes for a 1080p60 source, §30.4).

    ``logo`` is the input index of a campaign's logo (``logo_input``): fitted into 380 × 80 and overlaid after the
    subtitles for the whole clip, right-aligned on the safe area's right edge and centred in the mark row.

    ``voice`` is the take's voice (``voice_chains``): the graph's sound then always ends in ``[aout]``, also for a
    clip with no sound of its own. Without it the graph is exactly what it was."""
    if not _SAFE_PATH.match(str(ass_file)):
        raise ValueError(f"unsafe subtitle path: {ass_file}")
    chains: list[str] = []
    for i, (a, b) in enumerate(segs):
        fade_out = max(0.0, b - a - 0.03)
        if tease and i == 0:
            chains.append("[1:v]setpts=PTS-STARTPTS[v0]")
            if has_audio:
                chains.append(f"[1:a]asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st={fade_out:.3f}:d=0.03[a0]")
            continue
        chains.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            chains.append(
                f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d=0.02,afade=t=out:st={fade_out:.3f}:d=0.03[a{i}]"
            )
    n = len(segs)
    if has_audio:
        sound = "[aclip]" if voice is not None else "[aout]"
        chains.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vcat]{sound}")
    else:
        chains.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vcat]")
    if voice is not None:
        chains += voice_chains(voice, has_audio)
    chains.append(f"[vcat]fps={FPS},setsar=1[vin]")
    chains += parts
    chains.append(f"[lay]ass=filename={ass_file}[subs]")
    if logo is not None:
        chains.append(f"[{logo}:v]scale={LOGO_W}:{MARK_H}:force_original_aspect_ratio=decrease,format=rgba[logo]")
        chains.append(f"[subs][logo]overlay=x={SAFE[2]}-w:y={MARK_TOP}+({MARK_H}-h)/2[marked]")
        chains.append("[marked]format=yuv420p[vout]")
    else:
        chains.append("[subs]format=yuv420p[vout]")
    return ";".join(chains)


def video_encode_args() -> list[str]:
    """The video encoder settings every clip uses (``encode_args``); a Review overlay edit (overlay.py, §53) re-encodes
    with exactly these, so it adds no extra loss."""
    return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-threads",
        "2",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(FPS),
    ]


def encode_args(total: float, has_audio: bool, *, silent_input: int = 1) -> list[str]:
    """The output options. Without sound the clip takes its silence from input ``silent_input`` (``anullsrc``)."""
    audio = ["-map", "[aout]"] if has_audio else ["-map", f"{silent_input}:a"]
    return [
        "-map",
        "[vout]",
        *audio,
        "-t",
        f"{total:.3f}",
        *video_encode_args(),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
    ]


def peak_time(segs: Sequence[Segment], peak: float, tease: bool) -> float | None:
    """Where the peak (section seconds) lands in the finished clip, or None when it was cut out with a pause; the first
    segment is the tease if there is one."""
    body = segs[1:] if tease else segs
    acc = segs[0][1] - segs[0][0] if tease and segs else 0.0
    for a, b in body:
        if a <= peak <= b:
            return acc + peak - a
        acc += b - a
    return None


def cover_time(segs: Sequence[Segment], peak: float, tease: bool, total: float) -> float:
    """The cover's second: the peak in the finished clip, or 2 s in when the peak was cut out."""
    at = peak_time(segs, peak, tease)
    return max(0.0, min(total - 0.5, 2.0 if at is None else at))


# --- the campaign's logo (§38.13), prepared once at resolve ---------------------------------------------------------


def logo_trim_args(src: Path) -> list[str]:
    """ffmpeg finds the box around everything in the logo that is not transparent (``cropdetect`` on its alpha). The
    picture is looped for a few frames because cropdetect skips the first ones."""
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-loop",
        "1",
        "-t",
        "0.2",
        "-i",
        str(src),
        "-vf",
        "alphaextract,cropdetect=limit=0.02:round=2:reset=0",
        "-f",
        "null",
        "-",
    ]


def parse_crop(stderr: str) -> tuple[int, int, int, int] | None:
    """cropdetect's last ``crop=w:h:x:y`` (it grows over the frames with ``reset=0``); None when there is none (no
    transparency to trim). Raises when nothing in the logo is visible (cropdetect's box is empty)."""
    found = _CROP.findall(stderr)
    if not found:
        return None
    w, h, x, y = (int(v) for v in found[-1])
    if w <= 0 or h <= 0:
        raise ValueError("the logo is see-through")
    return w, h, x, y


def logo_filters(crop: tuple[int, int, int, int] | None, width: int, height: int) -> str:
    """The trim (when there is one), a scale down to LOGO_MAX on the long side, the fit into the mark row's
    LOGO_W × MARK_H (done once here, so the render's own fit of the looped picture costs nothing per frame), and RGBA
    for the PNG."""
    parts: list[str] = []
    if crop:
        w, h, x, y = crop
        parts.append(f"crop={w}:{h}:{x}:{y}")
        width, height = w, h
    if max(width, height) > LOGO_MAX:
        parts.append(f"scale={LOGO_MAX}:-2" if width >= height else f"scale=-2:{LOGO_MAX}")
    parts.append(f"scale={LOGO_W}:{MARK_H}:force_original_aspect_ratio=decrease")
    parts.append("format=rgba")
    return ",".join(parts)


def _big(b: bytes) -> int:
    return int.from_bytes(b, "big")


def image_size(data: bytes) -> tuple[str, int, int] | None:
    """``(kind, width, height)`` read from a PNG, JPEG or WebP file's own header, without decoding it; None for
    anything else (or a header that can't be read)."""
    if data[:8] == PNG_MAGIC and data[12:16] == b"IHDR" and len(data) >= 24:
        return "png", _big(data[16:20]), _big(data[20:24])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            return "webp", 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if chunk == b"VP8L" and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return "webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            return (
                "webp",
                int.from_bytes(data[26:28], "little") & 0x3FFF,
                int.from_bytes(data[28:30], "little") & 0x3FFF,
            )
        return None
    if data[:3] == JPEG_MAGIC:
        i = 2
        while i + 4 <= len(data) and data[i] == 0xFF:
            marker = data[i + 1]
            if marker == 0xFF:  # fill byte
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # markers without a length
                i += 2
                continue
            if marker in _SOF and i + 9 <= len(data):
                return "jpeg", _big(data[i + 7 : i + 9]), _big(data[i + 5 : i + 7])
            i += 2 + _big(data[i + 2 : i + 4])
    return None


async def prepare_logo(src: Path, dest: Path) -> Path:
    """The job's copy of the logo (PNG, JPEG or WebP) as ``dest`` (a PNG): transparent edges trimmed, at most
    LOGO_W × MARK_H. A JPEG has no transparency and is used as it is. Raises when it is not a PNG, JPEG or WebP
    picture ffmpeg can read, when it is too big to decode safely (its size is read from its header first, so a huge
    picture is never decoded) and when nothing in it is visible."""
    if src.stat().st_size > LOGO_BYTES_MAX:
        raise ValueError("the logo file is too big")
    found = image_size(src.read_bytes())
    if found is None:
        raise ValueError("the logo is not a PNG, JPEG or WebP picture")
    kind, width, height = found
    if width <= 0 or height <= 0 or width * height > LOGO_PIXELS_MAX:
        raise ValueError("the logo picture is too big")
    jpeg = kind == "jpeg"
    info = await proc.probe(str(src))
    if not info.has_video or info.width <= 0 or info.height <= 0:
        raise ValueError("the logo is not a picture")
    crop = None
    if not jpeg:
        try:
            crop = parse_crop((await proc.run(logo_trim_args(src), time_limit=60)).stderr)
        except proc.CommandError:
            crop = None  # no alpha channel: nothing to trim
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(src),
            "-frames:v",
            "1",
            "-vf",
            logo_filters(crop, info.width, info.height),
            str(dest),
        ],
        time_limit=60,
    )
    if not dest.is_file() or dest.stat().st_size == 0:
        raise ValueError("the logo could not be read")
    return dest


SectionFetcher = Callable[[float, float, Path], Awaitable[Path]]
# (jpeg, width, height) -> layout. The pipeline binds the job's skills block into it
# (``functools.partial(bedrock.detect_layout, skills=...)``, docs/CONTRACTS.md §18.6), so the vision call gets it too.
LayoutDetector = Callable[[bytes, int, int], Awaitable[FrameLayout]]


async def detect_silences(section: Path, start: float, end: float) -> list[Segment]:
    r = await proc.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-ss",
            f"{start:.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            str(section),
            "-vn",
            "-af",
            "silencedetect=noise=-38dB:d=0.7",
            "-f",
            "null",
            "-",
        ],
        time_limit=600,
    )
    return parse_silences(r.stderr, start, end)


async def grab_frame(src: Path, at: float, dest: Path, width: int = 1280) -> Path:
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            f"{max(0.0, at):.2f}",
            "-i",
            str(src),
            "-frames:v",
            "1",
            "-vf",
            f"scale={width}:-2",
            "-q:v",
            "4",
            str(dest),
        ],
        time_limit=120,
    )
    return dest


def _cut_progress(line: str, total: float, index: int | None = None) -> None:
    at = livestatus.parse_ffmpeg_progress(line)
    if at is not None:
        livestatus.emit("cut_progress", i=index, at=at, length=total, w=W, h=H, fps=FPS)


async def render_clip(
    m: Moment,
    *,
    words: Sequence[Sequence[Any]],
    workdir: Path,
    fetch_section: SectionFetcher,
    detect_layout: LayoutDetector | None,
    known_layout: FrameLayout | None = None,
    live_index: int | None = None,
    marks: Marks | None = None,
    take: str = "",
    voice: Spoken | None = None,
) -> RenderResult:
    """Cuts ``m`` into ``workdir/clip.mp4`` and ``workdir/cover.jpg``. ``marks`` (a campaign clip, §38.13) adds the
    mark row with the logo and the on-screen disclosure. ``take`` is the clip's "Your take" sentence (shown when the
    clip has room for it, never on a campaign clip) and ``voice`` the same sentence as speech, mixed in while the take
    shows; a voice that does not fit, or that ffmpeg cannot mix, is left out and the take stays as text."""
    workdir.mkdir(parents=True, exist_ok=True)
    tease = m.tease
    src_from = max(0.0, min(m.start, tease[0] if tease else m.start) - 2)
    src_to = max(m.end, tease[1] if tease else 0) + 1.5
    section = await fetch_section(src_from, src_to, workdir / "section.mp4")
    info = await proc.probe(str(section))
    if not info.has_video or info.duration <= 0:
        raise ValueError("the video section has no picture")

    def t(s: float) -> float:
        return max(0.0, s - src_from)

    layout = known_layout
    if layout is None and detect_layout is not None:
        frame = await grab_frame(section, min(info.duration - 0.2, t(m.peak_at)), workdir / "frame.jpg")
        frame_h = even(1280 * info.height / max(1, info.width))
        try:
            layout = await detect_layout(frame.read_bytes(), 1280, frame_h)
        except Exception:
            layout = FrameLayout(None, "other")
    layout = layout or FrameLayout(None, "other")
    fc = layout.facecam if layout.scene != "camera_only" else None

    end = min(t(m.end), info.duration - 0.05)
    # Pauses are cut out of talk. A moment with no words in it is all picture (a crash, a chase): cutting its quiet
    # stretches would cut the moment itself, so it plays whole.
    speech = any(m.start <= float(w[0]) < m.end for w in words)
    quiet = await detect_silences(section, t(m.start), end) if info.has_audio and speech else []
    segs: list[Segment] = []
    if tease:
        segs.append((t(tease[0]), min(t(tease[1]), info.duration - 0.05)))
    segs += keep_segments(t(m.start), end, quiet)
    if tease and segs[0][1] - segs[0][0] <= 0.1:
        tease = None  # too short to show: the clip plays without it
    segs = [(a, b) for a, b in segs if b - a > 0.1]
    if not segs:
        raise ValueError("nothing left to show after cutting the pauses")
    total = sum(b - a for a, b in segs)

    source_segs = [(a + src_from, b + src_from) for a, b in segs]
    caps = phrases(retime(words, source_segs))
    peak = peak_time(segs, t(m.peak_at), bool(tease))
    face_fill = layout.scene == "camera_only"
    marked = marks is not None and marks.any
    logo = marks.logo if marks is not None else None
    disclosure = (marks.disclosure or None) if marks is not None else None
    parts = layout_parts(
        fc,
        info.width,
        info.height,
        peak=peak if fc or face_fill else None,
        face_fill=face_fill,
        band=CAMPAIGN_BAND if marked else BAND,
    )
    # "Your take": never on a campaign clip (its layout stays as it is), and only when the clip has room for it.
    words_shown = "" if marked else ass_escape(take)
    tease_len = segs[0][1] - segs[0][0] if tease else 0.0
    window = take_window(total, tease_len, voice.duration if voice is not None else 0.0) if words_shown else None
    shown = TakeShown(words_shown, *window) if window is not None else None
    spoken = voice if shown is not None and voice is not None and shown.start + voice.duration <= shown.end else None
    ass_file = workdir / "captions.ass"
    if marked:
        ass = build_ass(m.hook, caps, total, hook_top=CAMPAIGN_HOOK_TOP, disclosure=disclosure)
    elif shown is not None:
        ass = build_ass(m.hook, caps, total, take=shown)
    else:
        ass = build_ass(m.hook, caps, total)
    ass_file.write_text(ass, "utf-8")

    out = workdir / "clip.mp4"

    async def encode(said: Spoken | None) -> None:
        inputs = ["-i", str(section)]
        if tease:
            a, b = segs[0]
            inputs += ["-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", str(section)]  # the tease's own input
        if not info.has_audio:
            inputs += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]  # silent_input
        mix: VoiceMix | None = None
        if said is not None and shown is not None:
            inputs += ["-i", str(said.path)]  # voice_input
            mix = VoiceMix(
                voice_input(bool(tease), info.has_audio),
                shown.start,
                said.duration,
                silent=None if info.has_audio else silent_input(bool(tease)),
            )
        if logo is not None:
            inputs += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(logo)]  # always the last input (logo_input)
        await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-filter_complex_threads",
                "1",
                *inputs,
                "-filter_complex",
                filter_graph(
                    segs,
                    parts,
                    ass_file,
                    info.has_audio,
                    tease=bool(tease),
                    logo=logo_input(bool(tease), info.has_audio, mix is not None) if logo is not None else None,
                    voice=mix,
                ),
                *encode_args(total, info.has_audio or mix is not None, silent_input=silent_input(bool(tease))),
                # Where the encode is, once a second on stdout, for the live status line ("0:41 of 0:58", §31).
                "-progress",
                "pipe:1",
                "-nostats",
                str(out),
            ],
            time_limit=30 * 60,
            on_out_line=lambda line: _cut_progress(line, total, live_index),
        )

    try:
        await encode(spoken)
    except proc.CommandError as e:
        if spoken is None or proc.was_killed(e):
            raise
        # The voice is an extra: when ffmpeg can't mix it in, the clip is made without it (the take stays as text).
        log("warn", "render.voice_failed", index=live_index, detail=str(e)[:300])
        spoken = None
        await encode(None)
    level = await loudness.normalize(out, workdir / "clip.loud.mp4") if info.has_audio or spoken is not None else None
    cover = workdir / "cover.jpg"
    at = cover_time(segs, t(m.peak_at), bool(tease), total)
    try:
        await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{at:.2f}",
                "-i",
                str(out),
                "-frames:v",
                "1",
                "-q:v",
                "3",
                str(cover),
            ],
            time_limit=120,
        )
    except proc.CommandError:
        await proc.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(out), "-frames:v", "1", "-q:v", "3", str(cover)], time_limit=120
        )
    return RenderResult(
        video=out,
        cover=cover,
        duration=round(total, 2),
        segments=[(round(a, 2), round(b, 2)) for a, b in source_segs],
        captions=[{"t0": round(p.t0, 2), "t1": round(p.t1, 2), "text": p.text} for p in caps],
        layout="facecam_top" if fc else "blur_fill",
        tease=bool(tease),
        frame_layout=layout,
        extra={"loudness": level} if level else {},
        logo=logo is not None,
        disclosure=bool(disclosure),
        take=" ".join(take.split()) if shown is not None else "",
        take_spoken=spoken is not None,
    )
