"""A reference video ("Edit like these", docs/CONTRACTS.md §57, ADR-114): what the owner's example video looks like,
measured and described as an EditStyle the renderer and the moment finder can follow.

The API asks for ``{"action": "reference", userId, refId, rev}`` and gets "accepted" at once. This module then reads
the ``REFVID#{refId}`` item, downloads its file (``refs/{userId}/{refId}.{ext}``) and looks at the first
``ANALYZE_SECONDS`` only: ffprobe (size, length, frame rate), ffmpeg scene detection (the cuts), about eight frames and
a thumbnail, and the spoken words when Amazon Transcribe can hear any (best effort: no words is not a failure). Then
ONE structured model call (tool ``edit_style``, the job's default model) describes the style; code clamps every field,
puts the measured numbers in, and fills ``unsupported`` from the renderer's support table (§57). The thumbnail goes to
``refs/{userId}/{refId}-thumb.jpg`` and ONE conditional write (``Store.finish_reference``) makes the item ``ready``:
only while it is still ``analyzing`` with ``analyzeRev == rev``. A failure never raises out of here: it removes what
this run left behind and writes one plain sentence in ``error`` (``Store.fail_reference``, conditional on the rev too).

A reference is not a job: it never touches a Job item, the job fence, the heartbeat or a callback, and it runs in its
own runner (``ReferenceRunner``) so a job's cancel can never reach it; ``busy`` counts it (HealthyBusy).

The model call gets an empty skills block on purpose: the owner's skills say how *his* clips should look, and they
must not colour the description of what someone else's video does."""

from __future__ import annotations

import asyncio
import contextlib
import math
import re
import shutil
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from . import proc
from . import watch as watch_mod
from .bedrock import Bedrock
from .skills import skills_block
from .transcribe import Transcriber, Word, job_name, parse_items
from .util import log, now_iso

ANALYZE_SECONDS = 120.0  # only the first two minutes are looked at
RENDER_LIMIT = 10 * 60  # seconds one ffmpeg run may take
WORDS_LIMIT = 5 * 60  # seconds Transcribe may take before the words are given up on
HOOK_WORDS_SECONDS = 30.0  # the transcript the model sees
SCENE_THRESHOLD = 0.3
FRAME_WIDTH = 768
THUMB_SIDE = 1080
THUMB_AT = 1.0
FIXED_FRAMES = (0.0, 0.5, 1.0, 2.0, 3.0)
SHARE_FRAMES = (0.25, 0.5, 0.9)
MAX_SUMMARY, MIN_SUMMARY, SUMMARY_CHARS = 7, 3, 90
MAX_BYTES = 500 * 1024 * 1024
EXTS = ("mp4", "mov", "webm", "m4v")

FAILED = "We could not read this video. Try again."
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

ASPECTS = ("9:16", "1:1", "16:9", "4:5")
LAYOUTS = ("split_facecam_top", "split_facecam_bottom", "full_frame", "blur_fill", "camera_only")
POSITIONS3 = ("top", "middle", "bottom")
HOOK_POSITIONS = (*POSITIONS3, "none")
SIZES = ("small", "medium", "large")
WEIGHTS = ("regular", "bold", "black")
CASINGS = ("upper", "lower", "sentence", "title")
HIGHLIGHT_MODES = ("word", "none")
LOGO_SPOTS = ("none", "top_left", "top_right", "bottom_left", "bottom_right", "center")
ZOOMS = ("none", "some", "many")
ENDINGS = ("loop", "punchline", "call_to_action", "hard_cut", "fade")


class ReferenceFailed(Exception):
    """A failure with the one plain sentence the owner sees in ``error``."""


# --- the model's answer ---------------------------------------------------------------------------------------------


def _s(desc: str) -> dict[str, Any]:
    return {"type": "string", "description": desc}


def _e(values: Sequence[str], desc: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"type": "string", "enum": list(values)}
    if desc:
        out["description"] = desc
    return out


def _obj(props: dict[str, Any], required: Sequence[str] = ()) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(required)}


# Lengths are told in the descriptions and enforced by ``normalize_style`` (a too-long line is cut, not sent back).
EDIT_STYLE_SCHEMA: dict[str, Any] = _obj(
    {
        "format": _obj(
            {
                "aspect": _e(ASPECTS, "The shape of the video."),
                "layout": _e(
                    LAYOUTS,
                    "split_facecam_*: a webcam band and the game/screen in another band. full_frame: one picture "
                    "fills the screen. blur_fill: a smaller picture over a blurred copy of itself. camera_only: "
                    "just a person on camera.",
                ),
                "notes": _s("Anything else about the frame, up to 120 characters."),
            },
            ["aspect", "layout"],
        ),
        "hook": _obj(
            {
                "seconds": {"type": "number", "minimum": 0, "maximum": 5, "description": "How long the hook lasts."},
                "onScreenText": _s("The hook text on screen, word for word if readable, up to 80 characters."),
                "spoken": _s("What is said in the hook, up to 160 characters; empty when nothing is said."),
                "visual": _s("What is shown in the hook, up to 160 characters."),
                "textPosition": _e(HOOK_POSITIONS, "Where the hook text sits; none when there is none."),
                "pattern": _s("The reusable trick, up to 120 characters, e.g. 'starts on the payoff, then rewinds'."),
            },
            ["textPosition", "pattern"],
        ),
        "captions": _obj(
            {
                "present": {"type": "boolean", "description": "Burned-in captions of the spoken words."},
                "wordsPerLine": {"type": "integer", "minimum": 1, "maximum": 6},
                "size": _e(SIZES),
                "weight": _e(WEIGHTS),
                "casing": _e(CASINGS),
                "color": _s("The caption text colour as #RRGGBB."),
                "highlightColor": {
                    "type": ["string", "null"],
                    "description": "The colour of the word being said as #RRGGBB, or null.",
                },
                "highlightMode": _e(HIGHLIGHT_MODES),
                "outline": {"type": "boolean"},
                "box": {"type": "boolean", "description": "A solid box behind the words."},
                "position": _e(POSITIONS3),
                "emoji": {"type": "boolean"},
            },
            ["present"],
        ),
        "placement": _obj(
            {
                "logo": _e(LOGO_SPOTS, "A logo or watermark that stays on screen."),
                "extraText": _s("Other on-screen text such as a title bar or channel tag, up to 120 characters."),
            }
        ),
        "pacing": _obj(
            {
                "zooms": _e(ZOOMS, "Punch-in zooms."),
                "jumpCuts": {"type": "boolean", "description": "Pauses and silences are cut out."},
                "speedRamps": {"type": "boolean"},
            }
        ),
        "audio": _obj(
            {
                "music": {"type": "boolean", "description": "Added background music."},
                "musicMood": _s("The music's mood in a few words, up to 60 characters."),
                "soundEffects": {"type": "boolean"},
                "voiceover": {"type": "boolean"},
            }
        ),
        "ending": _obj({"type": _e(ENDINGS), "notes": _s("Up to 120 characters.")}),
        "summary": {
            "type": "array",
            "minItems": MIN_SUMMARY,
            "maxItems": MAX_SUMMARY,
            "items": _s("One short plain line a child understands, up to 90 characters."),
            "description": "3 to 7 short plain lines on how this video is edited, most important first.",
        },
    },
    ["format", "hook", "captions", "pacing", "summary"],
)

SYSTEM = (
    "You are a short-form video editor. You study one example video (a reference) and describe exactly how it is "
    "edited, so the same edit can be repeated on other clips: the frame layout, the hook, the captions, where things "
    "sit, the pacing, the audio and the ending. Describe only what you see and hear in this video; never guess at "
    "what is not shown. The measured numbers are exact: trust them over your own impression. Write the summary for "
    "a child of 7: short plain lines like 'Facecam on top, game below' or 'Big yellow captions, 2 words a line'. "
    "No jargon, no hex codes and no numbers with decimals in the summary."
)


# --- clamping ---------------------------------------------------------------------------------------------------------


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    out = " ".join(value.split())
    if len(out) > limit:
        cut = out[:limit]
        out = (cut.rsplit(" ", 1)[0] if " " in cut[limit // 2 :] else cut).rstrip(" ,;:-")
    return out or None


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _clamp(value: Any, lo: float, hi: float) -> float | None:
    n = _num(value)
    return None if n is None else min(hi, max(lo, n))


def _enum(value: Any, allowed: Sequence[str]) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if v in allowed else None


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _color(value: Any) -> str | None:
    return value.upper() if isinstance(value, str) and COLOR_RE.match(value.strip()) else None


def _section(raw: Any) -> Mapping[str, Any]:
    return raw if isinstance(raw, Mapping) else {}


def _pack(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def nearest_aspect(width: int, height: int) -> str | None:
    """The closest of the four shapes to the file's own size."""
    if width <= 0 or height <= 0:
        return None
    ratio = width / height
    shapes = {"9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1.0, "16:9": 16 / 9}
    return min(shapes, key=lambda k: abs(math.log(ratio / shapes[k])))


def summary_lines(raw: Any) -> list[str]:
    """Up to seven short, distinct, plain lines."""
    out: list[str] = []
    for line in raw if isinstance(raw, list) else []:
        t = _text(line, SUMMARY_CHARS)
        if t and t.lower() not in {o.lower() for o in out}:
            out.append(t)
    return out[:MAX_SUMMARY]


LAYOUT_LINES = {
    "split_facecam_top": "Facecam on top, game below",
    "split_facecam_bottom": "Game on top, facecam below",
    "full_frame": "The whole picture fills the screen",
    "blur_fill": "The picture sits on a blurred copy of itself",
    "camera_only": "Just the camera, full screen",
}


def fallback_lines(style: Mapping[str, Any]) -> list[str]:
    """Plain lines made from the style itself, for when the model gave too few."""
    out: list[str] = []
    layout = _section(style.get("format")).get("layout")
    if isinstance(layout, str) and layout in LAYOUT_LINES:
        out.append(LAYOUT_LINES[layout])
    cap = _section(style.get("captions"))
    if cap.get("present") is False:
        out.append("No captions")
    elif cap.get("present"):
        size = {"small": "Small", "medium": "Medium", "large": "Big"}.get(str(cap.get("size")), "")
        n = cap.get("wordsPerLine")
        words = f", {n} word{'s' if n != 1 else ''} a line" if isinstance(n, int) else ""
        out.append(f"{size} captions{words}".strip().capitalize())
    hook = _section(style.get("hook"))
    if hook.get("onScreenText"):
        out.append(_text(f"Hook text at the start: {hook['onScreenText']}", SUMMARY_CHARS) or "")
    pace = _section(style.get("pacing"))
    if pace.get("jumpCuts"):
        out.append("Pauses are cut out")
    avg = pace.get("avgShotSeconds")
    if isinstance(avg, int | float) and avg > 0:
        out.append("Fast cuts" if avg < 2.5 else "Long shots, few cuts")
    return [line for line in out if line]


def normalize_style(raw: Mapping[str, Any], measured: Mapping[str, Any]) -> dict[str, Any]:
    """The EditStyle that is stored: only known fields, every enum lower-case and allowed, every number in range,
    every text cut to its length, the measured numbers (shape, cuts, length) over the model's, and ``summary``
    3 to 7 plain lines. ``unsupported`` is added by ``unsupported_lines``."""
    f, h, c = _section(raw.get("format")), _section(raw.get("hook")), _section(raw.get("captions"))
    p, pl, a, e = (
        _section(raw.get("pacing")),
        _section(raw.get("placement")),
        _section(raw.get("audio")),
        _section(raw.get("ending")),
    )
    words = _clamp(c.get("wordsPerLine"), 1, 6)
    highlight = _color(c.get("highlightColor"))
    mode = _enum(c.get("highlightMode"), HIGHLIGHT_MODES)
    if highlight is None and mode == "word":
        mode = None  # a highlight with no colour is no highlight we can draw; leave it to the default
    style: dict[str, Any] = {
        "format": _pack(
            {
                "aspect": measured.get("aspect") or _enum(f.get("aspect"), ASPECTS),
                "layout": _enum(f.get("layout"), LAYOUTS),
                "notes": _text(f.get("notes"), 120),
            }
        ),
        "hook": _pack(
            {
                "seconds": _clamp(h.get("seconds"), 0, 5),
                "onScreenText": _text(h.get("onScreenText"), 80),
                "spoken": _text(h.get("spoken"), 160) if measured.get("heard") else None,
                "visual": _text(h.get("visual"), 160),
                "textPosition": _enum(h.get("textPosition"), HOOK_POSITIONS),
                "pattern": _text(h.get("pattern"), 120),
            }
        ),
        "captions": _pack(
            {
                "present": _bool(c.get("present")),
                "wordsPerLine": round(words) if words is not None else None,
                "size": _enum(c.get("size"), SIZES),
                "weight": _enum(c.get("weight"), WEIGHTS),
                "casing": _enum(c.get("casing"), CASINGS),
                "color": _color(c.get("color")),
                "highlightColor": highlight,
                "highlightMode": mode,
                "outline": _bool(c.get("outline")),
                "box": _bool(c.get("box")),
                "position": _enum(c.get("position"), POSITIONS3),
                "emoji": _bool(c.get("emoji")),
            }
        ),
        "placement": _pack({"logo": _enum(pl.get("logo"), LOGO_SPOTS), "extraText": _text(pl.get("extraText"), 120)}),
        "pacing": _pack(
            {
                "cutsPer10s": measured.get("cutsPer10s"),
                "avgShotSeconds": measured.get("avgShotSeconds"),
                "zooms": _enum(p.get("zooms"), ZOOMS),
                "jumpCuts": _bool(p.get("jumpCuts")),
                "lengthSeconds": measured.get("lengthSeconds"),
                "speedRamps": _bool(p.get("speedRamps")),
            }
        ),
        "audio": _pack(
            {
                "music": _bool(a.get("music")),
                "musicMood": _text(a.get("musicMood"), 60),
                "soundEffects": _bool(a.get("soundEffects")),
                "voiceover": _bool(a.get("voiceover")),
            }
        ),
        "ending": _pack({"type": _enum(e.get("type"), ENDINGS), "notes": _text(e.get("notes"), 120)}),
    }
    style = {k: v for k, v in style.items() if v}
    lines = summary_lines(raw.get("summary"))
    if len(lines) < MIN_SUMMARY:
        for extra in fallback_lines(style):
            if len(lines) >= MIN_SUMMARY:
                break
            if extra.lower() not in {x.lower() for x in lines}:
                lines.append(extra)
    style["summary"] = lines[:MAX_SUMMARY]
    return style


def unsupported_lines(style: Mapping[str, Any]) -> list[str]:
    """What the renderer cannot copy yet (§57's support table), in plain words; empty when it can copy everything."""
    f, h, c = _section(style.get("format")), _section(style.get("hook")), _section(style.get("captions"))
    p, pl, a, e = (
        _section(style.get("pacing")),
        _section(style.get("placement")),
        _section(style.get("audio")),
        _section(style.get("ending")),
    )
    out: list[str] = []
    if f.get("layout") == "split_facecam_bottom":
        out.append("Facecam at the bottom")
    if f.get("aspect") not in (None, "9:16"):
        out.append("Square or wide videos")
    if h.get("textPosition") == "middle":
        out.append("Hook text in the middle")
    elif h.get("textPosition") == "bottom":
        out.append("Hook text at the bottom")
    if c.get("present") is not False and c.get("position") == "top":
        out.append("Captions at the top")
    if c.get("present") is not False and c.get("emoji") is True:
        out.append("Emoji in captions")
    if p.get("zooms") == "many":
        out.append("Many zooms")
    if p.get("speedRamps") is True:
        out.append("Speed ramps")
    if pl.get("logo") not in (None, "none"):
        out.append("A logo on every clip")
    if a.get("music") is True:
        out.append("Added music")
    if a.get("soundEffects") is True:
        out.append("Sound effects")
    if e.get("type") == "fade":
        out.append("A fade at the end")
    elif e.get("type") == "call_to_action":
        out.append("A call to action at the end")
    return out


# --- measuring ----------------------------------------------------------------------------------------------------


_PTS = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")


def parse_cuts(text: str, window: float) -> list[float]:
    """Scene-change times from ffmpeg's ``metadata=print`` lines, inside the window, a cut at 0 left out."""
    out: list[float] = []
    for m in _PTS.finditer(text):
        t = float(m.group(1))
        if 0.05 < t < window and (not out or t - out[-1] >= 0.05):
            out.append(round(t, 2))
    return out


def pacing_numbers(cuts: Sequence[float], window: float) -> tuple[float, float]:
    """(cuts per 10 s, average shot length in seconds) over the window looked at."""
    if window <= 0:
        return 0.0, 0.0
    return round(len(cuts) / window * 10, 2), round(window / (len(cuts) + 1), 2)


def frame_times(window: float) -> list[float]:
    """About eight moments to show the model: the first seconds (the hook), then a quarter, half and 90%."""
    last = max(0.0, window - 0.1)
    raw = [t for t in FIXED_FRAMES if t <= last] + [round(window * s, 1) for s in SHARE_FRAMES]
    out: list[float] = []
    for t in sorted(min(t, last) for t in raw):
        if not out or t - out[-1] >= 0.2:
            out.append(round(t, 2))
    return out


def scene_args(src: Path, window: float) -> list[str]:
    return [
        "ffmpeg",
        "-v",
        "error",
        "-nostats",
        "-t",
        f"{window:.3f}",
        "-i",
        str(src),
        "-an",
        "-vf",
        f"scale=320:-2,select='gt(scene,{SCENE_THRESHOLD})',metadata=print:file=-",
        "-f",
        "null",
        "-",
    ]


def frame_args(src: Path, at: float, dest: Path, scale: str) -> list[str]:
    return [
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
        scale,
        "-q:v",
        "4",
        str(dest),
    ]


FRAME_SCALE = f"scale={FRAME_WIDTH}:-2"
THUMB_SCALE = (
    f"scale='min({THUMB_SIDE},iw)':'min({THUMB_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
)


def audio_args(src: Path, window: float, dest: Path) -> list[str]:
    return [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-t",
        f"{window:.3f}",
        "-i",
        str(src),
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        str(dest),
    ]


def transcript_text(words: Sequence[Word], until: float = HOOK_WORDS_SECONDS) -> str:
    """The first seconds of speech as short timed lines: ``[0.4] what they say``."""
    lines: list[str] = []
    cur: list[str] = []
    start = 0.0
    for w_start, _, word in words:
        if w_start > until:
            break
        if not cur:
            start = w_start
        cur.append(word)
        if len(cur) >= 8 or word.endswith((".", "?", "!")):
            lines.append(f"[{start:.1f}] {' '.join(cur)}")
            cur = []
    if cur:
        lines.append(f"[{start:.1f}] {' '.join(cur)}")
    return "\n".join(lines)


# --- the run --------------------------------------------------------------------------------------------------------


class ReferenceStore(Protocol):
    async def get_ref(self, user_id: str, ref_id: str) -> dict[str, Any] | None: ...

    async def download(self, key: str, path: Path) -> None: ...

    async def upload(self, path: Path, key: str, content_type: str) -> None: ...

    async def get_json(self, key: str) -> Any: ...

    async def delete_keys(self, keys: Any) -> None: ...

    async def finish_reference(self, user_id: str, ref_id: str, rev: int, fields: dict[str, Any]) -> bool: ...

    async def fail_reference(self, user_id: str, ref_id: str, rev: int, message: str) -> bool: ...


def thumb_key(user_id: str, ref_id: str) -> str:
    return f"refs/{user_id}/{ref_id}-thumb.jpg"


def own_video_key(user_id: str, ref_id: str, key: Any) -> bool:
    """Only the owner's own ``refs/{userId}/{refId}.{ext}`` is ever downloaded."""
    if not isinstance(key, str):
        return False
    prefix = f"refs/{user_id}/{ref_id}."
    return key.startswith(prefix) and key[len(prefix) :].lower() in EXTS


def _same_rev(item: Mapping[str, Any], rev: int) -> bool:
    got = item.get("analyzeRev")
    return isinstance(got, int | float) and not isinstance(got, bool) and got == rev


async def _hear(
    store: ReferenceStore,
    transcriber: Transcriber | None,
    src: Path,
    info: proc.MediaInfo,
    window: float,
    workdir: Path,
    user_id: str,
    ref_id: str,
    rev: int,
) -> list[Word]:
    """The spoken words of the window, best effort: any failure (no speech, Transcribe busy or slow) is no words."""
    if transcriber is None or not info.has_audio:
        return []
    audio_key = f"refs/{user_id}/{ref_id}-work-{rev}.m4a"
    out_key = f"refs/{user_id}/{ref_id}-work-{rev}.json"
    name = job_name(f"ref-{ref_id}", 0, f"{rev}-{int(time.time())}")
    uploaded = False
    try:
        audio = workdir / "audio.m4a"
        await proc.run(audio_args(src, window, audio), time_limit=RENDER_LIMIT)
        await store.upload(audio, audio_key, "audio/mp4")
        uploaded = True

        async def no_cancel() -> None:
            return None

        await asyncio.wait_for(
            transcriber.run(
                name,
                audio_key,
                out_key,
                expected_seconds=window,
                check_cancel=no_cancel,
                on_progress=lambda _: None,
                poll=5.0,
                speakers=False,
            ),
            WORDS_LIMIT,
        )
        words = parse_items(await store.get_json(out_key))
        log("info", "reference.words", ref=ref_id, rev=rev, words=len(words))
        return words
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await asyncio.shield(transcriber.stop(name))
        raise
    except Exception as e:
        log("warn", "reference.no_words", ref=ref_id, rev=rev, error=type(e).__name__, detail=str(e)[:300])
        with contextlib.suppress(Exception):
            await transcriber.stop(name)
        return []
    finally:
        if uploaded:
            await _delete(store, audio_key, out_key)


async def _describe(bedrock: Bedrock, text: str, frames: Sequence[tuple[float, bytes]]) -> dict[str, Any]:
    """The ONE model call; when Bedrock refuses the pictures, the same call once more with half of them."""
    shown = list(frames)
    if bedrock.image_limit is not None:
        shown = shown[: max(1, bedrock.image_limit)]
    while True:
        content: list[dict[str, Any]] = [{"text": text}]
        for at, jpeg in shown:
            content.append({"text": f"Frame at {at:.1f} s:"})
            content.append({"image": {"format": "jpeg", "source": {"bytes": jpeg}}})
        try:
            return await bedrock.structured(
                system=SYSTEM,
                skills=skills_block([], where="agent.reference"),
                content=content,
                tool="edit_style",
                description="Describe how the reference video is edited.",
                schema=EDIT_STYLE_SCHEMA,
                max_tokens=8000,
            )
        except Exception as e:
            if not watch_mod.too_big(e) or len(shown) <= 1:
                raise
            shown = shown[: len(shown) // 2]
            log("warn", "reference.fewer_frames", frames=len(shown), detail=str(e)[:200])


def prompt_text(measured: Mapping[str, Any], info: proc.MediaInfo, cuts: Sequence[float], words: str) -> str:
    cut_list = ", ".join(f"{t:.1f}" for t in cuts[:40]) or "none"
    heard = (
        f"The spoken words of the first {HOOK_WORDS_SECONDS:.0f} s (time in seconds):\n{words}"
        if words
        else ("No spoken words could be heard. Leave hook.spoken empty.")
    )
    return (
        "This is a reference video: the owner wants his clips edited exactly like it. Describe its edit with the "
        "edit_style tool.\n\n"
        f"Measured: {info.width}x{info.height} pixels, {measured['lengthSeconds']:.1f} s long, "
        f"{info.fps or 0:.0f} frames a second. Looked at: the first {measured['window']:.0f} s. "
        f"Scene cuts at (s): {cut_list}. That is {measured['cutsPer10s']} cuts per 10 s, a shot lasts "
        f"{measured['avgShotSeconds']} s on average.\n\n{heard}\n\n"
        "The frames below are in time order; the first ones are the hook."
    )


async def run_reference(
    store: ReferenceStore,
    bedrock: Bedrock,
    work_root: Path,
    user_id: str,
    ref_id: str,
    rev: int,
    transcriber: Transcriber | None = None,
) -> str:
    """One reference analysis. Returns ``ready``, ``failed`` or ``stale`` (the item moved on: nothing is written).
    Never raises (a cancel, from the container shutting down, marks it failed and is passed on)."""
    workdir = work_root / f"reference-{ref_id}-{rev}"
    thumb = thumb_key(user_id, ref_id)
    uploaded = False
    try:
        item = await store.get_ref(user_id, ref_id)
        if not item or item.get("status") != "analyzing" or not _same_rev(item, rev):
            log("info", "reference.stale", ref=ref_id, rev=rev)
            return "stale"
        key = item.get("key")
        if not own_video_key(user_id, ref_id, key):
            raise ReferenceFailed(FAILED)
        size = _num(item.get("size"))
        if size is not None and size > MAX_BYTES:
            raise ReferenceFailed(FAILED)
        workdir.mkdir(parents=True, exist_ok=True)
        src = workdir / f"source.{str(key).rsplit('.', 1)[-1].lower()}"
        await store.download(str(key), src)
        info = await proc.probe(str(src))
        if not info.has_video or info.width <= 0 or info.height <= 0 or info.duration <= 0:
            raise ReferenceFailed(FAILED)
        window = min(info.duration, ANALYZE_SECONDS)

        scene = await proc.run(scene_args(src, window), time_limit=RENDER_LIMIT)
        cuts = parse_cuts(scene.stdout.decode("utf-8", "replace"), window)
        cuts_per_10s, avg_shot = pacing_numbers(cuts, window)

        frames: list[tuple[float, bytes]] = []
        for i, at in enumerate(frame_times(window)):
            dest = workdir / f"frame-{i}.jpg"
            with contextlib.suppress(proc.CommandError):  # a frame ffmpeg cannot find is left out
                await proc.run(frame_args(src, at, dest, FRAME_SCALE), time_limit=120)
            if dest.is_file() and dest.stat().st_size > 0:
                frames.append((at, dest.read_bytes()))
        if not frames:
            raise ReferenceFailed(FAILED)
        thumb_file = workdir / "thumb.jpg"
        await proc.run(frame_args(src, min(THUMB_AT, max(0.0, window - 0.1)), thumb_file, THUMB_SCALE), time_limit=120)
        if not thumb_file.is_file() or thumb_file.stat().st_size == 0:
            raise ReferenceFailed(FAILED)

        words = await _hear(store, transcriber, src, info, window, workdir, user_id, ref_id, rev)
        measured: dict[str, Any] = {
            "aspect": nearest_aspect(info.width, info.height),
            "cutsPer10s": cuts_per_10s,
            "avgShotSeconds": avg_shot,
            "lengthSeconds": round(info.duration, 1),
            "window": window,
            "heard": bool(words),
        }
        raw = await _describe(bedrock, prompt_text(measured, info, cuts, transcript_text(words)), frames)
        style = normalize_style(raw, measured)
        unsupported = unsupported_lines(style)
        style["unsupported"] = unsupported

        await store.upload(thumb_file, thumb, "image/jpeg")
        uploaded = True
        fields: dict[str, Any] = {
            "status": "ready",
            "style": style,
            "summary": style["summary"],
            "unsupported": unsupported,
            "thumbKey": thumb,
            "duration": round(info.duration, 2),
            "width": info.width,
            "height": info.height,
            "analyzedAt": now_iso(),
        }
        if await store.finish_reference(user_id, ref_id, rev, fields):
            log(
                "info",
                "reference.ready",
                ref=ref_id,
                rev=rev,
                cuts=len(cuts),
                words=len(words),
                unsupported=len(unsupported),
            )
            return "ready"
        await _forget_if_gone(store, user_id, ref_id, thumb)
        log("info", "reference.stale", ref=ref_id, rev=rev, at="write")
        return "stale"
    except asyncio.CancelledError:
        await asyncio.shield(_give_up(store, user_id, ref_id, rev, thumb, uploaded, FAILED))
        raise
    except Exception as e:
        message = str(e) if isinstance(e, ReferenceFailed) else FAILED
        log("error", "reference.failed", ref=ref_id, rev=rev, error=type(e).__name__, detail=str(e)[:600])
        await _give_up(store, user_id, ref_id, rev, thumb, uploaded, message)
        return "failed"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def _delete(store: ReferenceStore, *keys: str) -> None:
    with contextlib.suppress(Exception):
        await store.delete_keys(list(keys))


async def _forget_if_gone(store: ReferenceStore, user_id: str, ref_id: str, thumb: str) -> None:
    """The owner deleted the video while it was being looked at: the thumbnail this run wrote goes too."""
    try:
        gone = await store.get_ref(user_id, ref_id) is None
    except Exception:
        return
    if gone:
        await _delete(store, thumb)


async def _give_up(
    store: ReferenceStore, user_id: str, ref_id: str, rev: int, thumb: str, uploaded: bool, message: str
) -> None:
    """Says why it failed (only while the item still wants this ``rev``). Never raises."""
    try:
        await store.fail_reference(user_id, ref_id, rev, message)
    except Exception as e:
        log("error", "reference.fail_write_failed", ref=ref_id, rev=rev, error=type(e).__name__)
    if uploaded:
        await _forget_if_gone(store, user_id, ref_id, thumb)


ReferenceFactory = Callable[[str, str, int], Awaitable[str]]
"""``(user_id, ref_id, rev)`` → ``ready`` | ``failed`` | ``stale``."""


def make_reference_run(
    store: ReferenceStore, bedrock: Bedrock, work_root: Path, transcriber: Transcriber | None = None
) -> ReferenceFactory:
    async def run(user_id: str, ref_id: str, rev: int) -> str:
        return await run_reference(store, bedrock, work_root, user_id, ref_id, rev, transcriber)

    return run


class ReferenceRunner:
    """Reference analyses running in this container, as background tasks of their own (never a job's task).
    ``busy`` keeps the runtime alive while one runs."""

    def __init__(self, run: ReferenceFactory, limit: int = 2) -> None:
        self._run = run
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self._slots = asyncio.Semaphore(limit)

    @property
    def busy(self) -> bool:
        return any(not t.done() for t in self.tasks.values())

    def submit(self, user_id: str, ref_id: str, rev: int) -> bool:
        """Starts the analysis unless this very ``rev`` of this video is already being looked at here."""
        key = f"{user_id}:{ref_id}:{rev}"
        running = self.tasks.get(key)
        if running and not running.done():
            return False

        async def go() -> None:
            try:
                async with self._slots:
                    await self._run(user_id, ref_id, rev)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log("error", "reference.crashed", ref=ref_id, rev=rev, error=type(e).__name__, detail=str(e)[:600])

        task = asyncio.create_task(go(), name=f"reference-{ref_id}-{rev}")
        self.tasks[key] = task

        def forget(t: asyncio.Task[Any]) -> None:
            if self.tasks.get(key) is t:
                self.tasks.pop(key, None)

        task.add_done_callback(forget)
        return True

    async def shutdown(self, within: float = 20.0) -> None:
        """The container is stopping: every running analysis is canceled (each marks itself failed first)."""
        running = [t for t in self.tasks.values() if not t.done()]
        if not running:
            return
        for t in running:
            t.cancel()
        await asyncio.wait(running, timeout=within)
