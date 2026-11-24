"""The rasterizer (stories/raster.py) against committed draw lists and golden pictures, plus the exact properties of
each primitive type: area, painter's order, source-over in sRGB, round caps and joins, the non-zero rule.

The goldens come from ``fixtures/prims-*.jsonl`` (this folder's own draw lists, so engine drawing changes
never move them). To make them again after a deliberate change: ``CF_STORIES_GOLDEN=write uv run pytest
tests/test_stories_raster.py``, then look at every picture before committing it."""

from __future__ import annotations

import json
import math
import os
import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from lamostories_agent import raster
from lamostories_agent.raster import Canvas, png_bytes, prim_problems, render
from lamostories_agent.scene_render import image_loader
from ls_fakes import FIXTURES, REPO, needs_ffmpeg

# "keyhole": the night drive vignette's frame with an ellipse hole wound the other way (§45.45)
KINDS_WITHOUT_ASSETS = ["fill", "grad", "rect", "circle", "ellipse", "poly", "line", "mixed", "keyhole"]
TOLERANCE_MAX = 3  # per channel, out of 255 (another CPU's floating point)
TOLERANCE_MEAN = 0.05


def read_png(data: bytes) -> np.ndarray:
    """The goldens' own format: 8-bit RGB or RGBA, filter 0 on every row (raster.png_bytes)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", 0
    h = ch = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            w, h, _, color_type = struct.unpack(">IIBB", body[:10])
            ch = 3 if color_type == 2 else 4
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, 1 + w * ch)
    assert (raw[:, 0] == 0).all(), "only filter 0 is used by the goldens"
    return raw[:, 1:].reshape(h, w, ch)


def fixture(name: str) -> dict[str, Any]:
    line: dict[str, Any] = json.loads((FIXTURES / f"prims-{name}.jsonl").read_text().splitlines()[0])
    return line


def draw(name: str, images: Any = None) -> np.ndarray:
    f = fixture(name)
    return render(f["p"], int(f["w"]), int(f["h"]), images)


def compare(name: str, got: np.ndarray) -> None:
    golden = FIXTURES / f"prims-{name}.png"
    if os.environ.get("CF_STORIES_GOLDEN") == "write":
        golden.write_bytes(png_bytes(got))
    want = read_png(golden.read_bytes())
    assert want.shape == got.shape
    diff = np.abs(want.astype(np.int16) - got.astype(np.int16))
    assert int(diff.max()) <= TOLERANCE_MAX, f"{name}: a pixel differs by {int(diff.max())}"
    assert float(diff.mean()) <= TOLERANCE_MEAN, f"{name}: the picture differs on average by {float(diff.mean()):.3f}"


@pytest.mark.parametrize("name", KINDS_WITHOUT_ASSETS)
def test_every_primitive_type_matches_its_golden(name: str) -> None:
    for p in fixture(name)["p"]:
        assert prim_problems(p) == []
    compare(name, draw(name))


@needs_ffmpeg
def test_images_match_their_golden(tmp_path: Path) -> None:
    badge = FIXTURES / "badge.png"
    if os.environ.get("CF_STORIES_GOLDEN") == "write":
        px = np.zeros((16, 16, 4), np.uint8)
        px[..., 0], px[..., 1], px[..., 2] = 255, 201, 74
        px[..., 3] = 255
        px[4:12, 4:12] = (28, 24, 66, 255)
        px[:, :2, 3] = 0
        badge.write_bytes(png_bytes(px))
    got = draw("image", image_loader({"badge": str(badge)}))
    compare("image", got)
    # a missing asset is skipped: the corners keep the background
    assert tuple(got[95, 0]) == (28, 24, 66)


def test_the_drawing_is_deterministic() -> None:
    f = fixture("mixed")
    assert render(f["p"], 96, 96).tobytes() == render(json.loads(json.dumps(f["p"])), 96, 96).tobytes()


def coverage(prim: dict[str, Any], w: int = 120, h: int = 120) -> np.ndarray:
    """How much of each pixel ``prim`` covers: white drawn on black, read back as 0..1."""
    c = Canvas(w, h)
    c.draw([{"k": "fill", "color": "#000000"}, {**prim, "color": "#ffffff"}])
    return c.buf[..., 0] / 255.0


def test_a_rect_with_fractional_edges_covers_its_exact_area() -> None:
    cov = coverage({"k": "rect", "x": 10.25, "y": 20.5, "w": 33.3, "h": 17.75, "r": 0})
    assert cov.sum() == pytest.approx(33.3 * 17.75, rel=1e-4)
    assert cov[30, 20] == 1.0 and cov[0, 0] == 0.0
    assert cov[25, 10] == pytest.approx(0.75, abs=1e-4)  # the left edge column: 0.75 of it is inside


def test_a_rounded_rect_loses_its_four_corners() -> None:
    w, h, r = 60.0, 40.0, 12.0
    cov = coverage({"k": "rect", "x": 20, "y": 30, "w": w, "h": h, "r": r})
    assert cov.sum() == pytest.approx(w * h - (4 - math.pi) * r * r, rel=4e-3)
    assert cov[31, 21] < 0.05  # deep in a corner: outside the rounding


def test_circles_and_ellipses_cover_their_area() -> None:
    assert coverage({"k": "circle", "x": 60.3, "y": 59.7, "r": 31.5}).sum() == pytest.approx(
        math.pi * 31.5**2, rel=2e-3
    )
    cov = coverage({"k": "ellipse", "x": 60, "y": 60, "rx": 40, "ry": 15, "rot": 35})
    assert cov.sum() == pytest.approx(math.pi * 40 * 15, rel=4e-3)
    # rotated clockwise on screen (y down): the far end of the long axis is down and to the right
    end = (60 + 36 * math.sin(math.radians(35)), 60 + 36 * math.cos(math.radians(35)))
    assert cov[round(end[0]), round(end[1])] > 0.9


def test_a_polygon_covers_its_area_with_the_non_zero_rule() -> None:
    tri = coverage({"k": "poly", "pts": [10, 100, 60, 10, 110, 100]})
    assert tri.sum() == pytest.approx(0.5 * 100 * 90, rel=3e-3)
    star = [60 + 50 * math.cos(-math.pi / 2 + i * 4 * math.pi / 5) for i in range(5)]
    star_pts: list[float] = []
    for i, x in enumerate(star):
        star_pts += [x, 60 + 50 * math.sin(-math.pi / 2 + i * 4 * math.pi / 5)]
    pent = coverage({"k": "poly", "pts": star_pts})
    assert pent[62, 60] == 1.0  # the centre winds twice: filled (even-odd would leave it empty)
    ring_reverse = [10, 10, 110, 10, 110, 110, 10, 110, 10, 10, 30, 30, 30, 90, 90, 90, 90, 30, 30, 30]
    assert coverage({"k": "poly", "pts": ring_reverse})[60, 60] == 0.0  # an inner square wound back: a hole
    same_way = [10, 10, 110, 10, 110, 110, 10, 110, 10, 10, 30, 30, 90, 30, 90, 90, 30, 90, 30, 30]
    assert coverage({"k": "poly", "pts": same_way})[60, 60] == 1.0  # wound the same way: winding 2, filled


def test_a_keyhole_polygon_leaves_its_hole_empty() -> None:
    """The night drive vignette (§45.45): the frame clockwise, a bridge in, an ellipse anticlockwise and the bridge out;
    the non-zero rule fills the frame's corners and leaves the hole (and the bridge's zero width) empty."""
    f = fixture("keyhole")
    hole = f["p"][4]
    cov = coverage({"k": "poly", "pts": hole["pts"]}, int(f["w"]), int(f["h"]))
    assert cov[80, 48] == 0.0  # the hole's centre
    assert cov[2, 2] == 1.0 and cov[157, 93] == 1.0  # the frame's corners
    assert cov[60:100, 36:60].sum() == pytest.approx(0.0, abs=1e-3)  # well inside the hole
    # the hole's area, roughly that of its ellipse
    w, h = int(f["w"]), int(f["h"])
    assert float((1 - cov).sum()) == pytest.approx(math.pi * (w / 2 * 0.6) * (h / 2 * 0.5), rel=0.03)


# Night drive's four frames pinned prim by prim by the web's storiesEngineNight.test.ts (§45.45 §12): raster.py
# draws them without a problem, and seven places in them average within 6 of the palette's tokens, so the agent's
# final video shows the colours the preview paints.
NIGHT_GOLDEN = REPO / "web" / "test" / "fixtures" / "stories-engine-night.json"
NIGHT_REGIONS: list[tuple[str, tuple[int, int, int, int], str, str]] = [
    ("scene", (500, 10, 580, 40), "#141f3d", "the top of the night sky (ND.skyTop)"),
    ("scene", (950, 950, 1000, 990), "#1d3339", "the far mountains (ND.mtnFar)"),
    ("scene", (238, 870, 268, 874), "#fff6d8", "a street lamp's lens, a bright warm white bar (ND.lampLens)"),
    ("scene", (238, 865, 268, 869), "#34373e", "the lamp's slim dark grey head over it (ND.lampHousing)"),
    ("driver_view", (450, 1000, 650, 1040), "#2e2a20", "the road through the windscreen (ND.asphalt)"),
    ("driver_view", (900, 1150, 1000, 1200), "#46454b", "the dashboard's top (ND.dashTop)"),
    ("face", (350, 940, 600, 990), "#9c8270", "the sample's skin #f2c9a0 in the cabin light (art.ts grade)"),
]


def test_night_drive_goldens_draw_in_their_palette() -> None:
    golden = json.loads(NIGHT_GOLDEN.read_text())
    assert sorted(golden["full"]) == ["driver_view", "face", "mirror", "scene"]
    pictures: dict[str, np.ndarray] = {}
    for name, prims in golden["full"].items():
        assert [p for p in prims if prim_problems(p)] == [], name
        pictures[name] = render(prims, 1080, 1920)
        assert pictures[name].shape == (1920, 1080, 3)
    for name, (x0, y0, x1, y1), token, what in NIGHT_REGIONS:
        mean = pictures[name][y0:y1, x0:x1].reshape(-1, 3).astype(np.float64).mean(axis=0)
        off = float(np.abs(mean - raster.rgb(token)).max())
        assert off <= 6, f"{what}: averages {mean.round().astype(int).tolist()}, {off:.1f} away from {token}"


def test_lines_have_round_caps_and_joins_drawn_once() -> None:
    cov = coverage({"k": "line", "pts": [20, 60, 100, 60], "w": 10})
    assert cov[60, 17] > 0.9  # past the end point, inside the round cap
    assert cov[55, 15] < 0.1  # where a square cap would have its corner: outside the round one
    assert cov.sum() == pytest.approx(80 * 10 + math.pi * 25, rel=1e-2)
    c = Canvas(120, 120)
    c.draw(
        [
            {"k": "fill", "color": "#000000"},
            {"k": "line", "pts": [20, 20, 60, 60, 100, 20], "w": 12, "color": "#ffffff", "a": 0.5},
        ]
    )
    joint = c.buf[60, 60, 0]
    middle = c.buf[40, 40, 0]
    assert joint == pytest.approx(middle, abs=0.6) and joint == pytest.approx(127.5, abs=0.6)  # never 191 (twice)
    dot = coverage({"k": "line", "pts": [60, 60], "w": 20})
    assert dot.sum() == pytest.approx(math.pi * 100, rel=1e-2)


def test_source_over_in_srgb_and_painters_order() -> None:
    c = Canvas(10, 10)
    c.draw(
        [
            {"k": "fill", "color": "#ffffff"},
            {"k": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "r": 0, "color": "#000000", "a": 0.5},
        ]
    )
    assert tuple(c.rgb8()[5, 5]) == (128, 128, 128)  # in sRGB values, not linear light (which would give 188)
    c.draw(
        [
            {"k": "circle", "x": 5, "y": 5, "r": 3, "color": "#ff0000"},
            {"k": "circle", "x": 5, "y": 5, "r": 3, "color": "#0000ff"},
        ]
    )
    assert tuple(c.rgb8()[5, 5]) == (0, 0, 255)


def test_gradients_clamp_at_both_ends() -> None:
    c = Canvas(20, 40)
    c.draw([{"k": "grad", "x0": 0, "y0": 10, "x1": 0, "y1": 30, "stops": [[0, "#000000"], [1, "#ffffff"]]}])
    px = c.rgb8()
    assert tuple(px[0, 5]) == (0, 0, 0) and tuple(px[39, 5]) == (255, 255, 255)
    assert 120 <= px[20, 5, 0] <= 135


def test_off_frame_and_empty_primitives_draw_nothing() -> None:
    c = Canvas(20, 20)
    c.draw(
        [
            {"k": "rect", "x": -50, "y": -50, "w": 10, "h": 10, "r": 0, "color": "#ffffff"},
            {"k": "circle", "x": 5, "y": 5, "r": 0, "color": "#ffffff"},
            {"k": "poly", "pts": [1, 1, 5, 5], "color": "#ffffff"},
            {"k": "line", "pts": [], "w": 4, "color": "#ffffff"},
            {"k": "ellipse", "x": 200, "y": 200, "rx": 10, "ry": 5, "rot": 0, "color": "#ffffff"},
        ]
    )
    assert c.rgb8().max() == 0


@pytest.mark.parametrize(
    ("prim", "why"),
    [
        ({"k": "blob"}, "unknown primitive kind"),
        ({"k": "rect", "x": 0, "y": 0, "w": 1, "h": 1, "color": "#fff"}, "r is missing"),
        ({"k": "circle", "x": 0, "y": 0, "r": 1, "color": "red"}, "color must be"),
        ({"k": "poly", "pts": [1, 2, 3], "color": "#ffffff"}, "even list"),
        ({"k": "line", "pts": [1, 2], "w": 1, "color": "#ffffff", "a": 2}, "a must be"),
        ({"k": "grad", "x0": 0, "y0": 0, "x1": 1, "y1": 1, "stops": [[0, "nope"]]}, "stops"),
        ({"k": "fill", "color": "#ffffff", "extra": 1}, "unknown field"),
    ],
)
def test_prim_problems_names_what_is_wrong(prim: dict[str, Any], why: str) -> None:
    assert any(why in p for p in prim_problems(prim))


def test_png_bytes_round_trips() -> None:
    px = (np.arange(4 * 5 * 3, dtype=np.uint8) * 3).reshape(4, 5, 3)
    assert (read_png(png_bytes(px)) == px).all()
    assert tuple(raster.PRIM_FIELDS) == raster.KINDS
