"""The text track as ASS (stories/ass.py): Inter, inside the platforms' safe area, nothing a model wrote can reach
libass as an override, and captions left out when they are off (bubbles and the end card stay)."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from lamostories_agent import ass
from ls_fakes import needs_libass

EVENTS = [
    {
        "start": 0.5,
        "end": 2.5,
        "kind": "caption",
        "text": "Ease off the accelerator",
        "x": 540,
        "y": 1497.6,
        "size": 64,
        "color": "#fff6e5",
    },
    {"start": 1.0, "end": 2.0, "kind": "bubble", "text": "?", "x": 700, "y": 900, "size": 90, "color": "#1c1842"},
    {
        "start": 5.0,
        "end": 6.0,
        "kind": "endcard",
        "text": "Based on The Highway Code advice. Check your local road rules.",
        "x": 540,
        "y": 960,
        "size": 54,
        "color": "#fff6e5",
    },
]


def dialogue(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("Dialogue:")]


def test_each_event_is_one_line_in_inter_at_its_time() -> None:
    out = ass.build(EVENTS)
    assert "PlayResX: 1080" in out and "PlayResY: 1920" in out
    assert out.count(",Inter,") == 3
    lines = dialogue(out)
    assert len(lines) == 3
    assert lines[0].startswith("Dialogue: 0,0:00:00.50,0:00:02.50,Caption,")
    y = int(re.search(r"\\pos\(540,(\d+)\)", lines[0]).group(1))  # type: ignore[union-attr]
    assert y + 2 * 64 * 0.6 <= ass.SAFE_BOTTOM  # both lines held above the platforms' bottom bar (1497 asked)
    assert "Ease off the\\Naccelerator" in lines[0]
    assert "\\1c&HE5F6FF&" in lines[0]
    assert ",Bubble," in lines[1] and lines[1].endswith("}?")
    assert ",EndCard," in lines[2] and "\\N" in lines[2]


def test_the_safe_area_holds_every_caption() -> None:
    far = [{"start": 0, "end": 1, "kind": "caption", "text": "Hi", "x": 1070, "y": 30, "size": 64}]
    pos = re.search(r"\\pos\((\d+),(\d+)\)", dialogue(ass.build(far))[0])
    assert pos
    x, y = int(pos.group(1)), int(pos.group(2))
    assert ass.SAFE_LEFT < x < ass.SAFE_RIGHT and ass.SAFE_TOP < y < ass.SAFE_BOTTOM


def test_a_model_cannot_inject_overrides() -> None:
    bad = [{"start": 0, "end": 1, "kind": "caption", "text": "{\\fs400\\pos(0,0)}Hi\\N there\nyou", "size": 64}]
    line = dialogue(ass.build(bad))[0]
    body = line.split("}", 1)[1]  # after our own override block
    assert "{" not in body and "\\fs400" not in body and "\\N there" not in body


def test_captions_off_keeps_the_bubbles_and_the_end_card() -> None:
    out = ass.build(EVENTS, captions_on=False)
    assert [ln.split(",")[3] for ln in dialogue(out)] == ["Bubble", "EndCard"]
    assert ass.needs_file(EVENTS, False) and not ass.needs_file(EVENTS[:1], False) and ass.needs_file(EVENTS[:1], True)
    assert dialogue(ass.build([{"start": 2, "end": 1, "kind": "caption", "text": "x"}])) == []


def test_times_and_colours() -> None:
    assert ass.ass_time(3725.456) == "1:02:05.46"
    assert ass.ass_color("#1c1842") == "&H42181C&"
    assert ass.ass_color("nope") == ass.ass_color(ass.DEFAULT_COLOR)
    assert ass.wrap("one two three four five six seven", 10) == ["one two", "three four", "five six", "seven"]


@needs_libass
def test_libass_burns_the_file(tmp_path: Path) -> None:
    (tmp_path / "c.ass").write_text(ass.build(EVENTS), "utf-8")
    out = tmp_path / "o.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1c1842:s=1080x1920:d=3", "-ss", "1.5",
         "-vf", "ass=c.ass", "-frames:v", "1", str(out)],
        cwd=tmp_path, check=True, timeout=120,
    )  # fmt: skip
    assert out.stat().st_size > 1000
