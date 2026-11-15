from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from clipfactory_agent.bedrock import Facecam, FrameLayout
from clipfactory_agent.render import (
    BAND,
    CAM_H,
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
    ass = build_ass("chat could not believe this one", caps, 12.0, 1120)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass
    assert "Style: Caption,Inter," in ass
    dialogue = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
    assert dialogue[0].startswith("Dialogue: 1,0:00:00.00,0:00:12.00,Hook")
    assert len(dialogue) == 3  # the hook, then one event per word
    assert "{\\c&H0000D4FF&}NO{\\c&H00FFFFFF&} WAY" in dialogue[1]
    assert "NO {\\c&H0000D4FF&}WAY" in dialogue[2]
    assert "\\pos(540,1260)" in dialogue[1]


def test_layout_parts_facecam_top() -> None:
    parts, cap_y = layout_parts(Facecam(0.75, 0.7, 0.2, 0.25), 1920, 1080)
    graph = ";".join(parts)
    assert parts[0] == "[vin]split=3[bgs][cams][games]"
    assert "crop=384:270:1440:756" in graph
    assert f"overlay=0:{BAND}[l1]" in graph
    assert graph.endswith("[lay]")
    assert cap_y == BAND + CAM_H + 260


def test_layout_parts_blur_fill() -> None:
    parts, cap_y = layout_parts(None, 1920, 1080)
    assert parts[0] == "[vin]split=2[bgs][fgs]"
    assert "boxblur" in parts[1]
    assert "crop=min(iw\\,1080):1000" in parts[2]
    assert cap_y < H


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


def _ffmpeg_has(*filters: str) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, check=False).stdout
    return all(f" {f} " in out for f in filters)


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
