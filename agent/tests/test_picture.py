"""The picture for the deep analysis (ADR-40): which rendition is downloaded and whether it fits the disk, the one
ffmpeg decode, the per-second scores, motion spikes, frames by time, and the part that is too big."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import picture, proc, sources
from clipfactory_agent.picture import Frames, Part, Picture, motion_spikes, parse_scores, prepare_args

GB = 1024**3


def fmt(format_id: str, height: int, **kw: Any) -> dict[str, Any]:
    return {"format_id": format_id, "height": height, "vcodec": "avc1.4d401e", "acodec": "none", "fps": 30, **kw}


YOUTUBE = {
    "formats": [
        {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 30_000_000},
        fmt("160", 144, filesize=20_000_000),
        fmt("134", 360, filesize=200_000_000),
        fmt("135", 480, filesize=400_000_000),
        fmt("244", 480, vcodec="vp09.00.30.08", filesize=300_000_000),
        fmt("299", 1080, fps=60, filesize=4_000_000_000),
        fmt("18", 360, acodec="mp4a.40.2", filesize=250_000_000),
        fmt("sb0", 0, vcodec="none"),
    ]
}


def test_ladder_prefers_480p_h264_video_only() -> None:
    assert sources.picture_format(YOUTUBE, 7200, 20 * GB) == {
        "formatId": "135",
        "height": 480,
        "fps": 30,
        "estBytes": 400_000_000,
    }


def test_ladder_steps_down_when_the_disk_is_small() -> None:
    reserve = picture.DISK_RESERVE
    assert reserve == 3 * GB
    assert sources.picture_format(YOUTUBE, 7200, reserve + 300_000_000)["formatId"] == "134"  # type: ignore[index]
    assert sources.picture_format(YOUTUBE, 7200, reserve + 50_000_000)["formatId"] == "160"  # type: ignore[index]
    assert sources.picture_format(YOUTUBE, 7200, reserve + 1_000) is None  # nothing fits: no picture, no failure
    assert sources.picture_format(YOUTUBE, 7200, 0) is None


def test_ladder_skips_60_fps_and_other_codecs() -> None:
    info = {
        "formats": [
            fmt("a", 480, fps=60, filesize=1),
            fmt("b", 480, vcodec="av01.0", filesize=1),
            fmt("c", 360, filesize=5),
        ]
    }
    assert sources.picture_format(info, 100, 20 * GB)["formatId"] == "c"  # type: ignore[index]


def test_twitch_and_kick_get_their_480p_rendition_with_sound_when_the_disk_allows() -> None:
    twitch = {
        "formats": [
            {"format_id": "Audio_Only", "vcodec": "none", "acodec": "mp4a.40.2", "tbr": 160},
            fmt("160p", 160, acodec="mp4a.40.2", tbr=230),
            fmt("360p", 360, acodec="mp4a.40.2", tbr=630),
            fmt("480p", 480, acodec="mp4a.40.2", tbr=1400),
            fmt("720p60", 720, acodec="mp4a.40.2", fps=60, tbr=3000),
            fmt("1080p60", 1080, acodec="mp4a.40.2", fps=60, tbr=6000),
        ]
    }
    got = sources.picture_format(twitch, 4 * 3600, 50 * GB)
    assert got == {"formatId": "480p", "height": 480, "fps": 30, "estBytes": 1400 * 1000 * 4 * 3600 // 8}
    # The disk rule still steps down: 360p, then the smallest.
    assert sources.picture_format(twitch, 4 * 3600, 3 * GB + 1400 * 450 * 3600)["formatId"] == "360p"  # type: ignore[index]
    small = sources.picture_format(twitch, 3600, 3 * GB + 230 * 1000 * 3600 // 8)
    assert small == {"formatId": "160p", "height": 160, "fps": 30, "estBytes": 230 * 1000 * 3600 // 8}


def test_a_video_only_rendition_beats_one_with_sound_at_the_same_height() -> None:
    info = {"formats": [fmt("mux", 480, acodec="mp4a.40.2", tbr=900), fmt("vo", 480, tbr=800)]}
    assert sources.picture_format(info, 600, 20 * GB)["formatId"] == "vo"  # type: ignore[index]
    assert sources.picture_format({"formats": []}, 10, 20 * GB) is None
    assert sources.picture_format({"formats": []}, 10, 20 * GB) is None
    assert sources.picture_format({}, 10, 20 * GB) is None


def test_size_estimate_falls_back_step_by_step() -> None:
    def est(**kw: Any) -> int:
        return sources.picture_format({"formats": [fmt("x", 480, **kw)]}, 1000, 100 * GB)["estBytes"]  # type: ignore[index]

    assert est(filesize=111, filesize_approx=222, tbr=500) == 111
    assert est(filesize_approx=222, tbr=500) == 222
    assert est(tbr=500) == 500 * 1000 * 1000 // 8
    assert est() == 800_000 * 1000 // 8  # 0.8 Mbit/s


async def test_download_picture_arguments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[list[str], float]] = []

    async def fake_run(args: list[str], **kw: Any) -> proc.Result:
        seen.append((list(args), kw["time_limit"]))
        (tmp_path / "picture.mp4").write_bytes(b"video")
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", fake_run)
    out = await sources.download_picture(
        "https://youtu.be/x", "135", tmp_path / "picture.mp4", est_bytes=1000, max_seconds=None
    )
    assert out == tmp_path / "picture.mp4"
    args, limit = seen[0]
    assert limit == 2 * 3600
    assert args[args.index("-f") + 1] == "135"
    assert args[args.index("--concurrent-fragments") + 1] == "8"
    assert args[args.index("--max-filesize") + 1] == "1500"
    assert "--download-sections" not in args and "--downloader" not in args and "-x" not in args
    await sources.download_picture("u", "135", tmp_path / "picture.mp4", est_bytes=1000, max_seconds=21600)
    assert seen[1][0][seen[1][0].index("--download-sections") + 1] == "*0-21600"


async def test_download_picture_that_leaves_no_file_is_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_run(args: list[str], **kw: Any) -> proc.Result:
        return proc.Result(b"", "")  # yt-dlp skipped it (larger than --max-filesize)

    monkeypatch.setattr(proc, "run", fake_run)
    with pytest.raises(Exception, match="did not download"):
        await sources.download_picture("u", "135", tmp_path / "picture.mp4", est_bytes=1, max_seconds=None)


def test_ffmpeg_arguments() -> None:
    args = prepare_args("in.mp4", keyframes=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "fps=2,scale=768:432" in graph and "pad=768:432" in graph
    assert "fps=4,scale=320:180,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=scores.txt" in graph
    assert args.count("-i") == 1  # one decode, two outputs
    for flag, value in (
        ("-preset", "veryfast"),
        ("-crf", "28"),
        ("-g", "2"),
        ("-segment_time", "300"),
        ("-c:v", "libx264"),
    ):
        assert args[args.index(flag) + 1] == value
    assert "-an" in args and "part-%04d.mp4" in args and "-skip_frame" not in args and "-t" not in args
    keyed = prepare_args("in.mp4", keyframes=True, seconds=21600)
    assert keyed[keyed.index("-skip_frame") + 1] == "nokey" and keyed.index("-skip_frame") < keyed.index("-i")
    assert keyed[keyed.index("-t") + 1] == "21600"
    assert keyed.index("-t") < keyed.index("-i")  # before the input, so the cap holds for the parts and the scores


def test_keyframe_plan_and_time_limit() -> None:
    assert picture.keyframes_only(1080, 2 * 3600) is True
    assert picture.keyframes_only(720, 2 * 3600) is False  # not taller than 720
    assert picture.keyframes_only(1080, 30 * 60) is False  # not longer than 45 min
    assert picture.time_limit(600) == 20 * 60
    assert picture.time_limit(4 * 3600) == 4 * 3600 / 3
    assert (picture.PART_SECONDS, picture.PART_MAX_BYTES, picture.GRAB_CONCURRENCY) == (300, 18 * 1024 * 1024, 2)


def test_score_parsing() -> None:
    text = "\n".join(
        [
            "frame:0    pts:0       pts_time:0",
            "lavfi.scene_score=0.000000",
            "frame:1    pts:1       pts_time:0.25",
            "lavfi.scene_score=0.020000",
            "frame:2    pts:2       pts_time:0.5",
            "lavfi.scene_score=0.400000",
            "frame:3    pts:3       pts_time:0.75",
            "lavfi.scene_score=0.020000",
            "frame:4    pts:8       pts_time:2.0",
            "lavfi.scene_score=0.100000",
            "garbage",
        ]
    )
    motion, scene = parse_scores(text)
    assert motion == [0.11, 0.0, 0.1] and scene == [0.4, 0.0, 0.1]  # mean and max per second; a gap is 0
    assert parse_scores("") == ([], [])


def test_motion_spikes_mirror_loudness_spikes() -> None:
    motion = [0.01] * 600
    motion[200] = 0.03  # x3
    motion[202] = 0.05  # x5, merged with 200 (the stronger wins)
    motion[400] = 0.024  # x2.4: not enough
    motion[500] = 0.2
    spikes = motion_spikes(motion)
    assert [(s.t, s.lift) for s in spikes] == [(202, 5.0), (500, 20.0)]
    assert motion_spikes(motion, 450, 600) == [picture.MotionSpike(500, 20.0)]
    assert [s.t for s in motion_spikes(motion, limit=1)] == [500]
    assert motion_spikes([]) == [] and motion_spikes([0.0] * 600) == []
    tiny = [0.001] * 600
    tiny[300] = 0.01  # ten times the median but still a still picture
    assert motion_spikes(tiny) == []
    keyframes = [0.0, 0.0, 0.02] * 200  # a keyframe-only decode: most seconds are empty
    keyframes[302] = 0.2
    assert [s.t for s in motion_spikes(keyframes)] == [302]


def test_picture_json_roundtrip() -> None:
    pic = Picture(600.0, [Part(0, 0, 300, "k0", 10), Part(1, 300, 600, "k1", 20)], [0.1, 0.2], [0.3, 0.4], "keyframes")
    j = pic.to_json()
    assert {k: j[k] for k in ("version", "fps", "width", "height", "partSeconds", "decode")} == {
        "version": 1,
        "fps": 2,
        "width": 768,
        "height": 432,
        "partSeconds": 300,
        "decode": "keyframes",
    }
    assert j["parts"][1] == {"i": 1, "start": 300, "end": 600, "key": "k1", "bytes": 20}
    assert Picture.from_json(j) == pic
    assert Picture.from_json({}).parts == []


async def test_frames_come_from_disk_or_are_fetched_and_span_parts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pic = Picture(600.0, [Part(0, 0, 300, "k0", 1), Part(1, 300, 600, "k1", 1)])
    (tmp_path / "part-0000.mp4").write_bytes(b"local")
    fetched: list[str] = []
    grabbed: list[tuple[str, float, float]] = []

    async def fetch(key: str, path: Path) -> None:
        fetched.append(key)
        path.write_bytes(b"from s3")

    async def fake_grab(part: Path, t0: float, t1: float, out_dir: Path) -> list[tuple[float, bytes]]:
        grabbed.append((part.name, t0, t1))
        return [(t0, b"a"), (t0 + 0.5, b"b")]

    monkeypatch.setattr(picture, "grab_frames", fake_grab)
    frames = Frames(pic, tmp_path, fetch)
    got = await frames.between(294, 306)
    assert grabbed == [("part-0000.mp4", 294, 300), ("part-0001.mp4", 0, 6)]
    assert [t for t, _ in got] == [294, 294.5, 300, 300.5]  # part times shifted to source times
    assert fetched == ["k1"]  # only the part that was not on disk
    await frames.between(301, 302)
    assert fetched == ["k1"]
    frames.forget_local()
    assert not tmp_path.exists()
    await frames.between(10, 11)
    assert fetched == ["k1", "k0"]  # after the disk was freed, a later look fetches from S3 again
    assert await frames.between(700, 800) == []


async def test_shrink_arguments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    part = tmp_path / "part-0000.mp4"
    part.write_bytes(b"x" * 100)
    seen: list[list[str]] = []

    async def fake_run(args: list[str], **kw: Any) -> proc.Result:
        seen.append(list(args))
        Path(args[-1]).write_bytes(b"small")
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", fake_run)
    assert await picture.shrink(part) == part and part.read_bytes() == b"small"
    assert seen[0][seen[0].index("-vf") + 1] == "scale=640:360" and seen[0][seen[0].index("-crf") + 1] == "34"
    assert not list(tmp_path.glob("*.small.mp4"))


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg is not installed")
async def test_real_ffmpeg_makes_parts_scores_and_frames(tmp_path: Path) -> None:
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
            "testsrc2=size=640x360:rate=30:duration=8",
            "-g",
            "60",
            str(src),
        ],
        check=True,
    )
    out = tmp_path / "picture"
    parts, motion, scene = await picture.prepare(str(src), out, seconds=8, keyframes=False)
    assert [p.name for p in parts] == ["part-0000.mp4"] and not (out / "scores.txt").exists()
    info = await proc.probe(str(parts[0]))
    assert (info.width, info.height, info.has_audio) == (768, 432, False) and info.duration == pytest.approx(8, abs=0.6)
    assert info.fps == 2
    assert len(motion) == 8 and len(scene) == 8 and all(0 <= m <= s <= 1 for m, s in zip(motion, scene, strict=True))
    frames = await picture.grab_frames(parts[0], 2.2, 5.0, out / "frames" / "x")
    assert [t for t, _ in frames] == [2.0, 2.5, 3.0, 3.5, 4.0, 4.5]
    assert all(jpeg[:3] == b"\xff\xd8\xff" for _, jpeg in frames)
    assert not (out / "frames" / "x").exists()  # the frame files are removed once read
    keyed, km, _ = await picture.prepare(str(src), tmp_path / "keyed", seconds=8, keyframes=True)
    assert keyed and len(km) >= 4


async def test_prepare_runs_ffmpeg_under_the_time_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    async def run(args: list[str], **kw: Any) -> proc.Result:
        seen.append({"args": args, **kw})
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", run)
    await picture.prepare("in.mp4", tmp_path / "out", seconds=4 * 3600, keyframes=False)
    assert seen[0]["time_limit"] == picture.time_limit(4 * 3600) == 4800 and seen[0]["cwd"] == tmp_path / "out"


async def test_decode_speed_is_measured_and_a_failed_probe_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    async def run(args: list[str], **kw: Any) -> proc.Result:
        seen.append(args)
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", run)
    assert await picture.decode_speed("in.mp4") > 0
    assert seen[0][:5] == ["ffmpeg", "-v", "error", "-t", "60"] and "null" in seen[0]

    async def boom(args: list[str], **kw: Any) -> proc.Result:
        raise proc.CommandError("ffmpeg", 1, "broken")

    monkeypatch.setattr(proc, "run", boom)
    assert await picture.decode_speed("in.mp4") == 0.0
