"""The chat box in the picture (docs/CONTRACTS.md §37.5), on a synthetic 3-minute 2 fps video."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from clipfactory_agent import chat, chatscreen

from . import chat_video

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")


def iou(a: dict[str, int], b: tuple[int, int, int, int]) -> float:
    bx, by, bw, bh = b
    x0, y0 = max(a["x"], bx), max(a["y"], by)
    x1, y1 = min(a["x"] + a["w"], bx + bw), min(a["y"] + a["h"], by + bh)
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / (a["w"] * a["h"] + bw * bh - inter)


@pytest.fixture(scope="module")
def video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return chat_video.make(tmp_path_factory.mktemp("chat") / "part-0000.mp4", cut_at=130)


async def test_the_box_is_found_and_the_fast_stretch_is_a_spike(video: Path) -> None:
    r = await chatscreen.measure([(0.0, video)], 180)
    assert r is not None
    assert iou(r.box.picture_box(), chat_video.STRIP) >= 0.6
    slow = [v for v in r.lines[10:55] if v is not None]
    fast = [v for v in r.lines[62:88] if v is not None]
    assert sum(fast) / len(fast) > 4 * sum(slow) / len(slow)
    sig = chat.from_screen(r.lines, box=r.box.picture_box(), loud_times=[])
    assert sig is not None and sig.source == "screen" and sig.box == r.box.picture_box()
    assert [abs(s.onset - 60) <= 4 for s in sig.spikes] == [True]


async def test_a_cut_of_the_whole_frame_is_not_chat(video: Path) -> None:
    r = await chatscreen.measure([(0.0, video)], 180)
    assert r is not None and r.lines[130] is None
    sig = chat.from_screen(r.lines, box=r.box.picture_box(), loud_times=[])
    assert sig is not None and not any(120 <= s.onset <= 140 for s in sig.spikes)


async def test_a_cut_from_the_scene_scores_is_left_out(video: Path) -> None:
    scene = [0.0] * 180
    scene[100] = 0.9
    r = await chatscreen.measure([(0.0, video)], 180, scene)
    assert r is not None and r.lines[100] is None and r.lines[99] is not None


async def test_a_video_without_a_chat_box_gives_none(tmp_path: Path) -> None:
    plain = chat_video.make(tmp_path / "plain.mp4", seconds=60, strip=False)
    assert await chatscreen.measure([(0.0, plain)], 60) is None


async def test_a_broken_part_gives_none(tmp_path: Path) -> None:
    broken = tmp_path / "part.mp4"
    broken.write_bytes(b"not a video")
    assert await chatscreen.measure([(0.0, broken)], 60) is None
