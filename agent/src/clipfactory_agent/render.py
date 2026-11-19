"""Cutting one clip with ffmpeg: 1080×1920 at 30 fps, facecam on top (or a blurred fill), dead pauses cut, an
optional payoff tease first, the hook and word-by-word captions burned in with libass inside every platform's safe
area, a smooth punch-in on the face at the peak, loudness normalised to -14 LUFS, a cover at the peak."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import loudness, proc
from .bedrock import Facecam, FrameLayout
from .moments import Moment

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
CAP_BOTTOM = SAFE[3] - 60  # the captions' last line ends here and longer captions grow up
TEXT_MARGIN_L, TEXT_MARGIN_R = SAFE[0], W - SAFE[2] + 10  # libass wraps text between these
# The punch-in on the face at the peak: up to 120%, eased in over 0.4 s, held, eased out over 0.6 s. It zooms toward a
# point a little above the middle of the camera picture, where a webcam's face sits, so the face is never cut off.
PUNCH_ZOOM = 1.2
PUNCH_IN, PUNCH_HOLD, PUNCH_OUT = 0.4, 1.2, 0.6
PUNCH_ANCHOR = (0.5, 0.4)
_SAFE_PATH = re.compile(r"^[A-Za-z0-9/_.-]+$")
_SILENCE = re.compile(r"silence_(start|end): (-?[\d.]+)")
_TRAILING = re.compile(r"[.,!?;:\"“”]+$")
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


def build_ass(hook: str, caps: Sequence[Phrase], total: float) -> str:
    """The subtitle file: the hook for the whole clip, then each phrase with the word being said in yellow. Both sit
    inside SAFE: the hook hangs from HOOK_TOP (alignment 8), the captions stand on CAP_BOTTOM (alignment 2), and libass
    wraps them between the left margin and the buttons on the right."""
    ml, mr = TEXT_MARGIN_L, TEXT_MARGIN_R
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Inter,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,7,3,8,{ml},{mr},{HOOK_TOP},1
Style: Caption,Inter,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,9,4,2,{ml},{mr},{H - CAP_BOTTOM},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [f"Dialogue: 1,{ass_time(0)},{ass_time(total)},Hook,,0,0,0,,{hook_markup(hook)}"]
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
    fc: Facecam | None, src_w: int, src_h: int, *, peak: float | None = None, face_fill: bool = False
) -> list[str]:
    """Filter chains from ``[vin]`` to ``[lay]``. ``peak`` (clip seconds) adds the punch-in on the face: on the
    facecam, or on the whole picture when ``face_fill`` (a camera shot with no facecam box)."""
    blur = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:2,eq=brightness=-0.18"
    if fc:
        # Facecam under the hook band, gameplay below (the layout the skills assume), over a blurred copy.
        game_y = BAND + CAM_H
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
            f"[bg][cam]overlay=0:{BAND}[l1]",
            f"[l1][game]overlay=0:{game_y}[lay]",
        ]
    # No facecam: the whole frame, a little zoomed, under the hook band, over a blurred copy of itself.
    fg_h, fg_y = FILL_H, BAND
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


def filter_graph(segs: Sequence[Segment], parts: Sequence[str], ass_file: Path, has_audio: bool) -> str:
    """One graph: trim each segment (section seconds), concat, normalise to 30 fps, lay out, burn the subtitles."""
    if not _SAFE_PATH.match(str(ass_file)):
        raise ValueError(f"unsafe subtitle path: {ass_file}")
    chains: list[str] = []
    for i, (a, b) in enumerate(segs):
        chains.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            fade_out = max(0.0, b - a - 0.03)
            chains.append(
                f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d=0.02,afade=t=out:st={fade_out:.3f}:d=0.03[a{i}]"
            )
    n = len(segs)
    if has_audio:
        chains.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vcat][aout]")
    else:
        chains.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vcat]")
    chains.append(f"[vcat]fps={FPS},setsar=1[vin]")
    chains += parts
    chains.append(f"[lay]ass=filename={ass_file}[subs]")
    chains.append("[subs]format=yuv420p[vout]")
    return ";".join(chains)


def encode_args(total: float, has_audio: bool) -> list[str]:
    audio = ["-map", "[aout]"] if has_audio else ["-map", "1:a"]
    return [
        "-map",
        "[vout]",
        *audio,
        "-t",
        f"{total:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(FPS),
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


async def render_clip(
    m: Moment,
    *,
    words: Sequence[Sequence[Any]],
    workdir: Path,
    fetch_section: SectionFetcher,
    detect_layout: LayoutDetector | None,
    known_layout: FrameLayout | None = None,
) -> RenderResult:
    """Cuts ``m`` into ``workdir/clip.mp4`` and ``workdir/cover.jpg``."""
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
    segs = [(a, b) for a, b in segs if b - a > 0.1]
    if not segs:
        raise ValueError("nothing left to show after cutting the pauses")
    total = sum(b - a for a, b in segs)

    source_segs = [(a + src_from, b + src_from) for a, b in segs]
    caps = phrases(retime(words, source_segs))
    peak = peak_time(segs, t(m.peak_at), bool(tease))
    face_fill = layout.scene == "camera_only"
    parts = layout_parts(fc, info.width, info.height, peak=peak if fc or face_fill else None, face_fill=face_fill)
    ass_file = workdir / "captions.ass"
    ass_file.write_text(build_ass(m.hook, caps, total), "utf-8")

    out = workdir / "clip.mp4"
    inputs = ["-i", str(section)]
    if not info.has_audio:
        inputs += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    await proc.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            *inputs,
            "-filter_complex",
            filter_graph(segs, parts, ass_file, info.has_audio),
            *encode_args(total, info.has_audio),
            str(out),
        ],
        time_limit=30 * 60,
    )
    level = await loudness.normalize(out, workdir / "clip.loud.mp4") if info.has_audio else None
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
    )
