from __future__ import annotations

import itertools
import shutil
import subprocess
from pathlib import Path

import pytest

from clipfactory_agent.bedrock import Facecam, FrameLayout
from clipfactory_agent.render import (
    BAND,
    CAM_H,
    FILL_H,
    FPS,
    PUNCH_ANCHOR,
    PUNCH_ZOOM,
    SAFE,
    H,
    TimedWord,
    W,
    ass_escape,
    ass_time,
    build_ass,
    cover_time,
    encode_args,
    filter_graph,
    hook_markup,
    keep_segments,
    layout_parts,
    parse_silences,
    phrases,
    punch_zoom,
    render_clip,
    retime,
)

from .conftest import make_moment


def test_keep_segments_cuts_long_silences_with_padding() -> None:
    assert keep_segments(0, 30, []) == [(0, 30)]
    assert keep_segments(0, 30, [(10, 12)]) == [(0, 10.15), (11.85, 30)]
    # Too short to cut once padded.
    assert keep_segments(0, 30, [(10, 10.6)]) == [(0, 30)]
    # Silence at the very start leaves no sliver behind.
    assert keep_segments(0, 30, [(-1, 2), (28, 31)]) == [(1.85, 28.15)]


def test_parse_silences_with_offset_and_open_end() -> None:
    stderr = (
        "[silencedetect @ 0x1] silence_start: 3.5\n"
        "[silencedetect @ 0x1] silence_end: 5.25 | silence_duration: 1.75\n"
        "[silencedetect @ 0x1] silence_start: 20\n"
    )
    assert parse_silences(stderr, 10, 40) == [(13.5, 15.25), (30.0, 40)]


def test_retime_maps_words_through_segments() -> None:
    words = [[100.0, 100.4, "one"], [101.0, 101.3, "two"], [105.0, 105.5, "three"], [110.0, 110.3, "four"]]
    # A tease (105–106) first, then 100–102 and 109–111.
    timed = retime(words, [(105, 106), (100, 102), (109, 111)])
    assert [(w.text, w.t0) for w in timed] == [("three", 0.0), ("one", 1.0), ("two", 2.0), ("four", 4.0)]
    assert all(w.t1 > w.t0 for w in timed)


def test_phrases_break_at_three_words_pauses_and_punctuation() -> None:
    ws = [
        TimedWord(0.0, 0.2, "wait"),
        TimedWord(0.2, 0.4, "what"),
        TimedWord(0.4, 0.6, "is"),
        TimedWord(0.6, 0.8, "that?"),
        TimedWord(0.8, 1.0, "no"),
        TimedWord(2.0, 2.2, "way"),
    ]
    ps = phrases(ws)
    assert [p.text for p in ps] == ["WAIT WHAT IS", "THAT", "NO", "WAY"]


def test_ass_helpers() -> None:
    assert ass_time(0) == "0:00:00.00"
    assert ass_time(3723.456) == "1:02:03.46"
    assert ass_escape("a {\\b1} b\nc") == "a (/b1) b c"
    assert hook_markup("he thought he got away with it") == "he thought he got away {\\c&H0000D4FF&}with it"
    assert hook_markup("wow") == "wow"


def test_build_ass_has_hook_and_word_highlights() -> None:
    caps = phrases([TimedWord(0.5, 0.8, "no"), TimedWord(0.8, 1.1, "way")])
    ass = build_ass("chat could not believe this one", caps, 12.0)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass
    assert "Style: Caption,Inter," in ass
    dialogue = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
    assert dialogue[0].startswith("Dialogue: 1,0:00:00.00,0:00:12.00,Hook")
    assert len(dialogue) == 3  # the hook, then one event per word
    assert "{\\c&H0000D4FF&}NO{\\c&H00FFFFFF&} WAY" in dialogue[1]
    assert "NO {\\c&H0000D4FF&}WAY" in dialogue[2]
    assert "\\pos" not in ass  # placed by the styles' margins, so libass wraps them inside the safe area


def test_layout_parts_facecam_top() -> None:
    parts = layout_parts(Facecam(0.75, 0.7, 0.2, 0.25), 1920, 1080)
    graph = ";".join(parts)
    assert parts[0] == "[vin]split=3[bgs][cams][games]"
    assert "crop=384:270:1440:756" in graph
    assert f"overlay=0:{BAND}[l1]" in graph
    assert f"overlay=0:{BAND + CAM_H}[lay]" in graph
    assert "zoompan" not in graph  # no peak, no punch-in


def test_layout_parts_blur_fill() -> None:
    parts = layout_parts(None, 1920, 1080)
    assert parts[0] == "[vin]split=2[bgs][fgs]"
    assert "boxblur" in parts[1]
    assert f"crop=min(iw\\,1080):{FILL_H}" in parts[2]
    assert parts[3].endswith(f":{BAND}[lay]")
    # gameplay with no facecam has no face to punch in on; a camera shot does
    assert "zoompan" not in ";".join(layout_parts(None, 1920, 1080, peak=5.0))
    cam = ";".join(layout_parts(None, 1920, 1080, peak=5.0, face_fill=True))
    assert "zoompan" in cam and f"s=1080x{FILL_H}" in cam and f"crop=min(iw\\,2160):{2 * FILL_H}" in cam


def test_punch_in_is_smooth_stays_in_range_and_never_crops_the_face() -> None:
    """The zoom expression evaluated the way ffmpeg does, frame by frame: 1 far from the peak, PUNCH_ZOOM at it, no
    jump between frames, and at full zoom the middle of the camera picture (where a webcam's face is) still shows."""
    peak = 4.0
    expr = punch_zoom(peak).replace("\\,", ",").replace("in/", "n/")

    def clip(x: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, x))

    zooms = [eval(expr, {"clip": clip, "min": min, "n": n}) for n in range(10 * FPS)]  # noqa: S307
    assert zooms[0] == 1 and zooms[-1] == 1
    assert max(zooms) == pytest.approx(PUNCH_ZOOM)
    assert zooms[round(peak * FPS)] == pytest.approx(PUNCH_ZOOM)
    assert 1.1 <= PUNCH_ZOOM <= 1.3
    steps = [abs(b - a) for a, b in itertools.pairwise(zooms)]
    assert max(steps) < 0.03  # under 3% a frame at its fastest: a quick punch, never a cut
    moving = [d for d in steps if d > 0]
    assert moving[0] < 0.005 and moving[-1] < 0.005  # eased: it starts and stops slowly
    # the window still visible at full zoom, as fractions of the camera picture
    ax, ay = PUNCH_ANCHOR
    span = 1 / PUNCH_ZOOM
    left, top = (1 - span) * ax, (1 - span) * ay
    face = (0.25, 0.15, 0.75, 0.80)  # a webcam's face: the middle half across, most of the height
    assert left <= face[0] and left + span >= face[2] and top <= face[1] and top + span >= face[3]
    graph = ";".join(layout_parts(Facecam(0.7, 0.05, 0.25, 0.25), 1920, 1080, peak=peak))
    assert f"crop={2 * W}:{2 * CAM_H}," in graph and f"d=1:s={W}x{CAM_H}:fps={FPS}" in graph


def test_text_and_faces_stay_out_of_what_the_apps_cover() -> None:
    """The geometry the safe area rests on: TikTok's tabs (top 10%), every app's name, caption and sound line (bottom
    25%) and its buttons (right 15%)."""
    left, top, right, bottom = SAFE
    assert (top, right, bottom) == (192, 918, 1440)
    ass = build_ass("he thought he got away with it", phrases([TimedWord(0.5, 0.8, "no")]), 5.0)
    styles = {ln.split(",")[0][7:]: ln.split(",") for ln in ass.splitlines() if ln.startswith("Style:")}
    for style in styles.values():
        assert int(style[19]) >= left and W - int(style[20]) <= right
    assert styles["Hook"][18] == "8" and int(styles["Hook"][21]) >= top  # hangs from its top edge
    assert styles["Caption"][18] == "2" and H - int(styles["Caption"][21]) <= bottom - 40  # stands on its bottom
    # the face: the camera picture (or a camera shot filling the picture) starts below the tabs, and its face area
    # (the middle half across, the top 80%) ends above the bottom bar and left of the buttons
    assert top <= BAND and bottom >= BAND + CAM_H * 0.8 and bottom >= BAND + FILL_H * 0.8 and right >= W * 0.75


def lit_box(gray: bytes, w: int, h: int, level: int = 60) -> tuple[int, int, int, int] | None:
    """The smallest box around every pixel brighter than ``level`` in a ``w × h`` gray frame."""
    table = bytes(255 if v > level else 0 for v in range(256))
    xs: list[int] = []
    ys: list[int] = []
    for y in range(h):
        row = gray[y * w : (y + 1) * w].translate(table)
        first = row.find(255)
        if first >= 0:
            ys.append(y)
            xs += [first, row.rfind(255)]
    return (min(xs), min(ys), max(xs), max(ys)) if ys else None


def _ffmpeg_has(*filters: str) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, check=False).stdout
    return all(f" {f} " in out for f in filters)


@pytest.mark.skipif(not _ffmpeg_has("ass"), reason="ffmpeg with libass is not installed")
@pytest.mark.parametrize(
    ("hook", "said"),
    [
        ("nobody in the whole lobby expected what happened next", ["unbelievable", "absolutely", "ridiculous"]),
        ("wait for it", ["no"]),
    ],
)
def test_rendered_hook_and_captions_land_inside_the_safe_area(tmp_path: Path, hook: str, said: list[str]) -> None:
    """Burns a hook and a caption onto a black frame and measures where the letters really are."""
    caps = phrases([TimedWord(0.1 + i * 0.3, 0.4 + i * 0.3, w) for i, w in enumerate(said)])
    ass = tmp_path / "t.ass"
    ass.write_text(build_ass(hook, caps, 3.0), "utf-8")
    raw = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=black:s={W}x{H}:d=2",
            "-vf",
            f"ass=filename={ass},format=gray",
            "-ss",
            "1",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    assert len(raw) == W * H
    box = lit_box(raw, W, H)
    assert box is not None
    x0, y0, x1, y1 = box
    left, top, right, bottom = SAFE
    assert x0 >= left - 10 and y0 >= top and x1 <= right and y1 <= bottom, box


def test_filter_graph_trims_concats_and_burns_subtitles(tmp_path: Path) -> None:
    ass = Path("/tmp/cf-work/JOB/clips/00/captions.ass")
    graph = filter_graph([(1, 2.5), (4, 9)], ["[vin]null[lay]"], ass, has_audio=True)
    assert "[0:v]trim=start=1.000:end=2.500,setpts=PTS-STARTPTS[v0]" in graph
    assert "afade=t=out:st=1.470:d=0.03[a0]" in graph
    assert "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][aout]" in graph
    assert f"[lay]ass=filename={ass}[subs]" in graph
    assert graph.endswith("[subs]format=yuv420p[vout]")
    silent = filter_graph([(0, 3)], ["[vin]null[lay]"], ass, has_audio=False)
    assert "atrim" not in silent and "concat=n=1:v=1:a=0[vcat]" in silent
    with pytest.raises(ValueError):
        filter_graph([(0, 1)], [], tmp_path / "it's.ass", has_audio=True)


def test_encode_args() -> None:
    args = encode_args(31.5, True)
    joined = " ".join(args)
    assert "-map [vout] -map [aout]" in joined
    assert "-c:v libx264" in joined and "-crf 20" in joined and "-profile:v high" in joined
    assert "-movflags +faststart" in joined and "-r 30" in joined and "-c:a aac" in joined
    assert "-map 1:a" in " ".join(encode_args(3, False))


def test_cover_time() -> None:
    segs = [(20.0, 21.5), (2.0, 10.0), (12.0, 30.0)]
    assert cover_time(segs, 14.0, True, 27.5) == pytest.approx(1.5 + 8 + 2)
    assert cover_time(segs[1:], 5.0, False, 26) == 3.0
    assert cover_time(segs[1:], 11.0, False, 26) == 2.0  # the peak was cut out with a pause


@pytest.mark.skipif(not _ffmpeg_has("ass", "silencedetect", "boxblur"), reason="ffmpeg with libass is not installed")
async def test_render_clip_end_to_end(tmp_path: Path) -> None:
    src = tmp_path / "src.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=1280x720:r=30:d=40",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=40",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            str(src),
        ],
        check=True,
    )

    async def fetch(start: float, end: float, dest: Path) -> Path:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-to", str(end), "-i", str(src), str(dest)], check=True
        )
        return dest

    m = make_moment(start=5, end=30, payoff_at=29, peak_at=20, tease=(25.0, 26.5))
    words = [[6.0, 6.4, "no"], [6.4, 6.8, "way"], [25.2, 25.6, "boom"]]
    r = await render_clip(
        m,
        words=words,
        workdir=tmp_path / "clip",
        fetch_section=fetch,
        detect_layout=None,
        known_layout=FrameLayout(Facecam(0.7, 0.05, 0.25, 0.3), "gameplay"),
    )
    assert r.layout == "facecam_top" and r.tease
    assert r.video.is_file() and r.cover.is_file()
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
            str(r.video),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert probe == f"{W},{H}"


@pytest.mark.parametrize(
    ("words", "trimmed"),
    [
        ([[6.0, 6.4, "no"], [6.4, 6.8, "way"]], True),  # talk: its pauses are cut, as before
        ([[1.0, 1.4, "before"], [40.0, 40.4, "after"]], False),  # nothing said inside: a picture moment plays whole
    ],
)
async def test_a_moment_without_words_keeps_its_quiet_stretches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, words: list[list[object]], trimmed: bool
) -> None:
    from clipfactory_agent import proc
    from clipfactory_agent import render as render_mod

    asked: list[tuple[float, float]] = []
    shown: list[list[tuple[float, float]]] = []

    async def probe(src: str) -> proc.MediaInfo:
        return proc.MediaInfo(30.0, 1280, 720, True, True, 30.0)

    async def detect_silences(section: Path, start: float, end: float) -> list[tuple[float, float]]:
        asked.append((start, end))
        return [(10.0, 20.0)]  # a long quiet stretch in the middle

    class Stop(Exception):
        pass

    def retime(ws: object, segs: list[tuple[float, float]]) -> list[object]:
        shown.append(segs)
        raise Stop

    async def fetch(start: float, end: float, dest: Path) -> Path:
        dest.write_bytes(b"section")
        return dest

    monkeypatch.setattr(proc, "probe", probe)
    monkeypatch.setattr(render_mod, "detect_silences", detect_silences)
    monkeypatch.setattr(render_mod, "retime", retime)
    m = make_moment(start=5, end=30, payoff_at=29, peak_at=20)
    with pytest.raises(Stop):
        await render_clip(
            m,
            words=words,
            workdir=tmp_path / "clip",
            fetch_section=fetch,
            detect_layout=None,
            known_layout=FrameLayout(None, "gameplay"),
        )
    if trimmed:
        assert asked and len(shown[0]) == 2  # cut around the quiet stretch
    else:
        assert asked == [] and len(shown[0]) == 1  # one whole segment: nothing cut
        assert shown[0][0][1] - shown[0][0][0] > 24
