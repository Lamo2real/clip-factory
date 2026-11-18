from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from clipfactory_agent import loudness
from clipfactory_agent.loudness import QUIETEST_LUFS, TARGET_LUFS, loudnorm_filter, normalize, parse_loudnorm

STDERR = """[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-27.61",
	"input_tp" : "-14.20",
	"input_lra" : "3.40",
	"input_thresh" : "-37.80",
	"output_i" : "-14.02",
	"output_tp" : "-1.50",
	"output_lra" : "3.10",
	"output_thresh" : "-24.20",
	"normalization_type" : "linear",
	"target_offset" : "0.02"
}
"""


def test_parse_loudnorm_reads_the_json_block() -> None:
    got = parse_loudnorm("noise before\n" + STDERR)
    assert got == {
        "input_i": -27.61,
        "input_tp": -14.2,
        "input_lra": 3.4,
        "input_thresh": -37.8,
        "target_offset": 0.02,
    }
    assert parse_loudnorm("no json here") is None
    assert parse_loudnorm(STDERR.replace('"-27.61"', '"-inf"')) is None  # silence


def test_loudnorm_filter_two_passes() -> None:
    first = loudnorm_filter(None)
    assert first == "loudnorm=I=-14.0:TP=-1.5:LRA=11.0:print_format=json"
    second = loudnorm_filter(parse_loudnorm(STDERR))
    assert "measured_I=-27.61:measured_TP=-14.2:measured_LRA=3.4:measured_thresh=-37.8:offset=0.02" in second
    assert "linear=true" in second


async def test_silence_is_left_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def quiet(media: Path) -> dict[str, float]:
        return {"input_i": QUIETEST_LUFS - 5, "input_tp": -40, "input_lra": 0, "input_thresh": -70, "target_offset": 0}

    monkeypatch.setattr(loudness, "measure_loudness", quiet)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"v")
    assert await normalize(video, tmp_path / "tmp.mp4") is None
    assert video.read_bytes() == b"v"


def _ffmpeg_has_loudnorm() -> bool:
    if not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, check=False).stdout
    return " loudnorm " in out


@pytest.mark.skipif(not _ffmpeg_has_loudnorm(), reason="ffmpeg is not installed")
@pytest.mark.parametrize("volume", [0.15, 0.9])  # a quiet voice turned up, a loud one turned down
async def test_normalize_lands_on_minus_14_lufs_under_minus_1_dbtp(tmp_path: Path, volume: float) -> None:
    video = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x240:r=30:d=8",
            "-f",
            "lavfi",
            "-i",
            f"sine=f=330:d=8,apulsator=hz=2,volume={volume}",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            str(video),
        ],
        check=True,
    )
    picture = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames,codec_name",
            str(video),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    level = await normalize(video, tmp_path / "tmp.mp4")
    assert level is not None
    assert abs(level["lufs"] - TARGET_LUFS) <= 1.0, level
    assert level["true_peak"] <= -1.0, level
    measured = await loudness.measure_loudness(video)  # measured again on the file that is kept
    assert measured is not None and abs(measured["input_i"] - TARGET_LUFS) <= 1.0
    same = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames,codec_name",
            str(video),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert same == picture  # the picture is copied, not encoded again
    assert not (tmp_path / "tmp.mp4").exists()
