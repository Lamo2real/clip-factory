"""The engine's draw lists as pixels (docs/CONTRACTS.md §45.10, §45.11.3): numpy only, no drawing library.

One frame is a list of primitives in output pixels (0..width × 0..height, 1080 × 1920 for a video), drawn in painter's
order with source-over blending in sRGB (no linear-light conversion, exactly like a browser canvas), colours
``"#rrggbb"`` and an optional alpha ``a`` (0..1, default 1). Edges are anti-aliased by coverage:

* ``fill`` and ``grad`` paint the whole frame (a linear gradient between two points, clamped at both ends);
* ``rect`` (corner radius ``r``), ``circle`` and ``ellipse`` (``rot`` in degrees, clockwise on screen) use the exact
  area of straight edges and a half-pixel distance ramp on curves;
* ``glow`` is an ellipse (as ``ellipse``) in one colour whose alpha fades from its centre to its edge along ``fade``,
  ``[offset, alpha]`` stops (offset 0 the centre, 1 the edge, linear between stops and the end stops' alphas past
  them), the browser's radial gradient in the ellipse's own frame; nothing past the edge (the engine ends every fade
  at alpha 0, so the edge needs no anti-aliasing);
* ``poly`` is a closed polygon of flattened curves with the non-zero winding rule: exact horizontal coverage and
  ``POLY_SAMPLES`` sample rows per pixel row, the winding summed per pixel and capped at 1 (exact inside, and on
  every edge pixel except where two opposite windings meet inside one pixel);
* ``line`` is a polyline of width ``w`` with round caps and round joins (the union of its segments' capsules, so a
  join is never drawn twice);
* ``image`` places a decoded asset (RGBA) scaled to ``w`` × ``h``; an asset that is not given is skipped.

The browser draws the same lists with ``web/src/stories/preview/draw.ts``; ``web/src/stories/engine/README.md`` is the
one description of the semantics. Everything here is deterministic: the same list gives the same bytes."""

from __future__ import annotations

import math
import struct
import zlib
from collections.abc import Callable, Iterable, Mapping
from typing import Any

import numpy as np

WIDTH = 1080
HEIGHT = 1920
POLY_SAMPLES = 16  # sample rows per pixel row in a polygon (horizontal coverage is exact)
KINDS = ("fill", "grad", "rect", "circle", "ellipse", "glow", "poly", "line", "image")
_HEX: dict[str, np.ndarray] = {}

# What each primitive must carry (CONTRACTS §45.10): the numbers, the colour, and the optional alpha.
PRIM_FIELDS: dict[str, tuple[str, ...]] = {
    "fill": ("color",),
    "grad": ("x0", "y0", "x1", "y1", "stops"),
    "rect": ("x", "y", "w", "h", "r", "color"),
    "circle": ("x", "y", "r", "color"),
    "ellipse": ("x", "y", "rx", "ry", "rot", "color"),
    "glow": ("x", "y", "rx", "ry", "rot", "color", "fade"),
    "poly": ("pts", "color"),
    "line": ("pts", "w", "color"),
    "image": ("asset", "x", "y", "w", "h"),
}


class PrimError(ValueError):
    """A primitive that does not match the contract's shape."""


def _is_num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _is_hex(v: Any) -> bool:
    return isinstance(v, str) and len(v) == 7 and v[0] == "#" and all(c in "0123456789abcdefABCDEF" for c in v[1:])


def prim_problems(p: Any) -> list[str]:
    """Why ``p`` is not a primitive of §45.10 (empty when it is one)."""
    if not isinstance(p, dict):
        return ["a primitive is not an object"]
    k = p.get("k")
    if k not in PRIM_FIELDS:
        return [f"unknown primitive kind {k!r}"]
    out: list[str] = []
    allowed = {"k", "a", *PRIM_FIELDS[k]}
    out += [f"{k}: unknown field {f!r}" for f in p if f not in allowed]
    for f in PRIM_FIELDS[k]:
        if f not in p:
            out.append(f"{k}: {f} is missing")
            continue
        v = p[f]
        if f == "color" and not _is_hex(v):
            out.append(f"{k}: color must be #rrggbb")
        elif f == "asset" and not (isinstance(v, str) and v):
            out.append(f"{k}: asset must be a name")
        elif f == "stops":
            ok = isinstance(v, list) and len(v) >= 1
            ok = ok and all(isinstance(s, list) and len(s) == 2 and _is_num(s[0]) and _is_hex(s[1]) for s in v)
            if not ok:
                out.append(f"{k}: stops must be [offset, #rrggbb] pairs")
        elif f == "fade":
            pairs = v if isinstance(v, list) else []
            ok = len(pairs) >= 1 and all(
                isinstance(s, list) and len(s) == 2 and all(_is_num(n) and 0 <= n <= 1 for n in s) for s in pairs
            )
            ok = ok and all(pairs[i - 1][0] <= pairs[i][0] for i in range(1, len(pairs)))
            if not ok:
                out.append(f"{k}: fade must be [offset, alpha] pairs, offsets 0..1 in order and alphas 0..1")
        elif f == "pts":
            if not (isinstance(v, list) and len(v) % 2 == 0 and all(_is_num(x) for x in v)):
                out.append(f"{k}: pts must be an even list of numbers")
        elif f not in ("color", "asset", "stops", "fade", "pts") and not _is_num(v):
            out.append(f"{k}: {f} must be a number")
    if "a" in p and not (_is_num(p["a"]) and 0 <= p["a"] <= 1):
        out.append(f"{k}: a must be 0..1")
    return out


def rgb(color: str) -> np.ndarray:
    c = _HEX.get(color)
    if c is None:
        if not _is_hex(color):
            raise PrimError(f"bad colour {color!r}")
        c = np.array([int(color[i : i + 2], 16) for i in (1, 3, 5)], np.float32)
        _HEX[color] = c
    return c


def _alpha(p: Mapping[str, Any]) -> float:
    a = p.get("a", 1.0)
    return 1.0 if a is None else min(1.0, max(0.0, float(a)))


def _span(lo: float, hi: float, size: int) -> tuple[int, int]:
    """The whole pixels a [lo, hi) extent touches, clipped to 0..size."""
    a = max(0, math.floor(lo))
    b = min(size, math.ceil(hi))
    return a, b


def _edge_cov(lo: float, hi: float, a: int, b: int) -> np.ndarray:
    """Per pixel of [a, b): how much of it lies inside [lo, hi] (the exact area of a straight edge)."""
    i = np.arange(a, b, dtype=np.float32)
    return np.clip(np.minimum(i + 1, hi) - np.maximum(i, lo), 0.0, 1.0)


class Canvas:
    """One frame being drawn. ``buf`` is float32 RGB in 0..255, row 0 at the top."""

    def __init__(
        self,
        width: int = WIDTH,
        height: int = HEIGHT,
        images: Callable[[str, int, int], np.ndarray | None] | None = None,
    ) -> None:
        self.width = width
        self.height = height
        self.buf = np.zeros((height, width, 3), np.float32)
        self.images = images
        self._ys = (np.arange(height, dtype=np.float32) + 0.5)[:, None]
        self._xs = (np.arange(width, dtype=np.float32) + 0.5)[None, :]

    # --- compositing --------------------------------------------------------------------------------------------

    def _blend(self, y0: int, x0: int, cov: np.ndarray, color: np.ndarray, alpha: float) -> None:
        """Source-over of ``color`` at ``cov × alpha`` onto the rows/columns starting at (y0, x0)."""
        if cov.size == 0 or alpha <= 0:
            return
        h, w = cov.shape
        region = self.buf[y0 : y0 + h, x0 : x0 + w]
        k = cov[..., None] if alpha >= 1 else (cov * np.float32(alpha))[..., None]
        step = np.subtract(color, region)
        step *= k
        region += step

    # --- primitives ---------------------------------------------------------------------------------------------

    def fill(self, p: Mapping[str, Any]) -> None:
        self.buf[:] = rgb(p["color"])

    def grad(self, p: Mapping[str, Any]) -> None:
        stops = sorted(((min(1.0, max(0.0, float(o))), rgb(c)) for o, c in p["stops"]), key=lambda s: s[0])
        offs = np.array([s[0] for s in stops], np.float32)
        cols = np.stack([s[1] for s in stops])
        dx, dy = float(p["x1"]) - float(p["x0"]), float(p["y1"]) - float(p["y0"])
        d2 = dx * dx + dy * dy
        if len(stops) == 1 or d2 < 1e-9:
            self.buf[:] = cols[-1] if d2 < 1e-9 else cols[0]
            return

        def colours(t: np.ndarray) -> np.ndarray:
            t = np.clip(t, 0.0, 1.0)
            return np.stack([np.interp(t, offs, cols[:, ch]) for ch in range(3)], axis=-1).astype(np.float32)

        tx = (self._xs[0] - float(p["x0"])) * (dx / d2)
        ty = (self._ys[:, 0] - float(p["y0"])) * (dy / d2)
        if abs(dx) < 1e-9:  # vertical: one colour per row
            self.buf[:] = colours(ty)[:, None, :]
        elif abs(dy) < 1e-9:  # horizontal: one colour per column
            self.buf[:] = colours(tx)[None, :, :]
        else:
            self.buf[:] = colours(ty[:, None] + tx[None, :])

    def rect(self, p: Mapping[str, Any]) -> None:
        x, y, w, h = (float(p[k]) for k in ("x", "y", "w", "h"))
        if w < 0:
            x, w = x + w, -w
        if h < 0:
            y, h = y + h, -h
        if w <= 0 or h <= 0:
            return
        r = max(0.0, min(float(p.get("r") or 0), w / 2, h / 2))
        xa, xb = _span(x, x + w, self.width)
        ya, yb = _span(y, y + h, self.height)
        if xa >= xb or ya >= yb:
            return
        cov = np.outer(_edge_cov(y, y + h, ya, yb), _edge_cov(x, x + w, xa, xb))
        if r > 0.5:
            # The corners: a quarter circle each, by distance (the straight edges keep their exact area).
            cx = (x + r, x + w - r)
            cy = (y + r, y + h - r)
            for qx, (lo_x, hi_x) in ((cx[0], (x, x + r)), (cx[1], (x + w - r, x + w))):
                for qy, (lo_y, hi_y) in ((cy[0], (y, y + r)), (cy[1], (y + h - r, y + h))):
                    ia, ib = _span(lo_x, hi_x, self.width)
                    ja, jb = _span(lo_y, hi_y, self.height)
                    ia, ib, ja, jb = max(ia, xa), min(ib, xb), max(ja, ya), min(jb, yb)
                    if ia >= ib or ja >= jb:
                        continue
                    ddx = self._xs[0, ia:ib] - qx
                    ddy = self._ys[ja:jb, 0] - qy
                    d = np.sqrt(ddy[:, None] ** 2 + ddx[None, :] ** 2) - r
                    corner = np.clip(0.5 - d, 0.0, 1.0)
                    sub = cov[ja - ya : jb - ya, ia - xa : ib - xa]
                    np.minimum(sub, corner, out=sub)
        self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def circle(self, p: Mapping[str, Any]) -> None:
        cx, cy, r = float(p["x"]), float(p["y"]), float(p["r"])
        if r <= 0:
            return
        xa, xb = _span(cx - r - 1, cx + r + 1, self.width)
        ya, yb = _span(cy - r - 1, cy + r + 1, self.height)
        if xa >= xb or ya >= yb:
            return
        ddx = self._xs[0, xa:xb] - cx
        ddy = self._ys[ya:yb, 0] - cy
        d = np.sqrt(ddy[:, None] ** 2 + ddx[None, :] ** 2)
        cov = np.clip(r + 0.5 - d, 0.0, 1.0)
        if r < 0.5:
            cov *= np.float32(r / 0.5)
        self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def ellipse(self, p: Mapping[str, Any]) -> None:
        cx, cy = float(p["x"]), float(p["y"])
        rx, ry = abs(float(p["rx"])), abs(float(p["ry"]))
        if rx <= 0 or ry <= 0:
            return
        th = math.radians(float(p.get("rot") or 0))
        c, s = math.cos(th), math.sin(th)
        ex = math.hypot(rx * c, ry * s)
        ey = math.hypot(rx * s, ry * c)
        xa, xb = _span(cx - ex - 1, cx + ex + 1, self.width)
        ya, yb = _span(cy - ey - 1, cy + ey + 1, self.height)
        if xa >= xb or ya >= yb:
            return
        ddx = (self._xs[0, xa:xb] - cx)[None, :]
        ddy = (self._ys[ya:yb, 0] - cy)[:, None]
        u = ddx * c + ddy * s  # along the rx axis
        v = ddy * c - ddx * s  # along the ry axis
        f = (u / rx) ** 2 + (v / ry) ** 2 - 1.0
        g = 2.0 * np.sqrt((u / (rx * rx)) ** 2 + (v / (ry * ry)) ** 2)
        sd = f / np.maximum(g, 1e-6)
        cov = np.clip(0.5 - sd, 0.0, 1.0).astype(np.float32)
        small = min(rx, ry)
        if small < 0.5:
            cov *= np.float32(small / 0.5)
        self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def glow(self, p: Mapping[str, Any]) -> None:
        cx, cy = float(p["x"]), float(p["y"])
        rx, ry = abs(float(p["rx"])), abs(float(p["ry"]))
        fade = p["fade"]
        if rx <= 0 or ry <= 0 or not fade:
            return
        th = math.radians(float(p.get("rot") or 0))
        c, s = math.cos(th), math.sin(th)
        ex = math.hypot(rx * c, ry * s)
        ey = math.hypot(rx * s, ry * c)
        xa, xb = _span(cx - ex, cx + ex, self.width)
        ya, yb = _span(cy - ey, cy + ey, self.height)
        if xa >= xb or ya >= yb:
            return
        ddx = (self._xs[0, xa:xb] - cx)[None, :]
        ddy = (self._ys[ya:yb, 0] - cy)[:, None]
        u = (ddx * c + ddy * s) / rx  # along the rx axis, in radii
        v = (ddy * c - ddx * s) / ry
        rho = np.sqrt(u * u + v * v)
        offs = np.array([min(1.0, max(0.0, float(o))) for o, _ in fade], np.float64)
        alps = np.array([min(1.0, max(0.0, float(a))) for _, a in fade], np.float64)
        cov = np.interp(rho, offs, alps).astype(np.float32)
        cov[rho >= 1.0] = 0.0
        self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def poly(self, p: Mapping[str, Any]) -> None:
        pts = np.asarray(p["pts"], np.float64)
        if pts.size < 6:
            return
        xs, ys = pts[0::2], pts[1::2]
        xa, xb = _span(float(xs.min()), float(xs.max()), self.width)
        ya, yb = _span(float(ys.min()), float(ys.max()), self.height)
        if xa >= xb or ya >= yb:
            return
        cov = poly_coverage(xs, ys, xa, ya, xb - xa, yb - ya)
        if cov is not None:
            self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def line(self, p: Mapping[str, Any]) -> None:
        pts = np.asarray(p["pts"], np.float64)
        if pts.size < 2:
            return
        width = float(p["w"])
        if width <= 0:
            return
        half = max(width / 2, 0.5)
        thin = min(width, 1.0)  # a line thinner than a pixel is drawn as a fainter one-pixel line
        xs, ys = pts[0::2], pts[1::2]
        xa, xb = _span(float(xs.min()) - half - 1, float(xs.max()) + half + 1, self.width)
        ya, yb = _span(float(ys.min()) - half - 1, float(ys.max()) + half + 1, self.height)
        if xa >= xb or ya >= yb:
            return
        cov = np.zeros((yb - ya, xb - xa), np.float32)
        n = len(xs)
        segs = [(i, i + 1) for i in range(n - 1)] or [(0, 0)]
        for i, j in segs:
            ax, ay, bx, by = xs[i], ys[i], xs[j], ys[j]
            ia, ib = _span(min(ax, bx) - half - 1, max(ax, bx) + half + 1, self.width)
            ja, jb = _span(min(ay, by) - half - 1, max(ay, by) + half + 1, self.height)
            if ia >= ib or ja >= jb:
                continue
            px = (self._xs[0, ia:ib] - ax)[None, :]
            py = (self._ys[ja:jb, 0] - ay)[:, None]
            vx, vy = bx - ax, by - ay
            ll = vx * vx + vy * vy
            if ll < 1e-12:
                d = np.sqrt(px * px + py * py)
            else:
                t = np.clip((px * vx + py * vy) / ll, 0.0, 1.0)
                d = np.sqrt((px - t * vx) ** 2 + (py - t * vy) ** 2)
            seg = np.clip(half + 0.5 - d, 0.0, 1.0).astype(np.float32)
            sub = cov[ja - ya : jb - ya, ia - xa : ib - xa]
            np.maximum(sub, seg, out=sub)
        if thin < 1:
            cov *= np.float32(thin)
        self._blend(ya, xa, cov, rgb(p["color"]), _alpha(p))

    def image(self, p: Mapping[str, Any]) -> None:
        if self.images is None:
            return
        w, h = round(float(p["w"])), round(float(p["h"]))
        if w <= 0 or h <= 0:
            return
        pixels = self.images(str(p["asset"]), w, h)
        if pixels is None:
            return
        x0, y0 = round(float(p["x"])), round(float(p["y"]))
        xa, xb = max(0, x0), min(self.width, x0 + w)
        ya, yb = max(0, y0), min(self.height, y0 + h)
        if xa >= xb or ya >= yb:
            return
        part = pixels[ya - y0 : yb - y0, xa - x0 : xb - x0].astype(np.float32)
        alpha = _alpha(p)
        k = (part[..., 3:4] / 255.0) * np.float32(alpha)
        region = self.buf[ya:yb, xa:xb]
        region += (part[..., :3] - region) * k

    # --- frames -------------------------------------------------------------------------------------------------

    def reset(self) -> None:
        """Black again, for the next frame (one canvas is reused for a whole scene)."""
        self.buf.fill(0.0)

    def draw(self, prims: Iterable[Mapping[str, Any]]) -> None:
        for p in prims:
            kind = p.get("k")
            fn = _DISPATCH.get(str(kind))
            if fn is None:
                raise PrimError(f"unknown primitive kind {kind!r}")
            fn(self, p)

    def rgb8(self) -> np.ndarray:
        return np.clip(self.buf + 0.5, 0, 255).astype(np.uint8)

    def tobytes(self) -> bytes:
        return self.rgb8().tobytes()


_DISPATCH: dict[str, Callable[[Canvas, Mapping[str, Any]], None]] = {
    "fill": Canvas.fill,
    "grad": Canvas.grad,
    "rect": Canvas.rect,
    "circle": Canvas.circle,
    "ellipse": Canvas.ellipse,
    "glow": Canvas.glow,
    "poly": Canvas.poly,
    "line": Canvas.line,
    "image": Canvas.image,
}


def poly_coverage(
    xs: np.ndarray, ys: np.ndarray, x0: int, y0: int, w: int, h: int, samples: int = POLY_SAMPLES
) -> np.ndarray | None:
    """Coverage (h × w, 0..1) of the closed polygon (xs, ys) in the box at (x0, y0), non-zero winding.

    Each pixel row has ``samples`` sample rows; on each, every edge crossing adds its direction (+1 down, -1 up),
    divided by ``samples``, to the pixel row's running sum, split between the two pixels the crossing falls between
    (so the horizontal coverage is exact). The running sum is the pixel's mean winding; its size capped at 1 is the
    coverage: exact for every pixel inside or outside, and for edge pixels except where two opposite windings meet
    inside the same pixel."""
    xa, ya = xs, ys
    xb, yb = np.roll(xs, -1), np.roll(ys, -1)
    keep = ya != yb
    if not keep.any():
        return None
    xa, ya, xb, yb = xa[keep], ya[keep], xb[keep], yb[keep]
    direction = np.where(yb > ya, 1.0, -1.0) / samples
    rows = h * samples
    lo = np.minimum(ya, yb)
    hi = np.maximum(ya, yb)
    # Sample row j sits at y0 + (j + 0.5) / samples; an edge holds the rows with lo <= y < hi.
    j0 = np.clip(np.ceil((lo - y0) * samples - 0.5), 0, rows).astype(np.int64)
    j1 = np.clip(np.ceil((hi - y0) * samples - 0.5), 0, rows).astype(np.int64)
    counts = j1 - j0
    total = int(counts.sum())
    if total == 0:
        return None
    edge = np.repeat(np.arange(len(counts)), counts)
    starts = np.cumsum(counts) - counts
    j = np.repeat(j0, counts) + (np.arange(total) - np.repeat(starts, counts))
    sy = y0 + (j + 0.5) / samples
    t = (sy - ya[edge]) / (yb[edge] - ya[edge])
    sx = xa[edge] + t * (xb[edge] - xa[edge]) - x0
    sx = np.clip(sx, 0.0, float(w))
    ix = np.floor(sx).astype(np.int64)
    fx = sx - ix
    d = direction[edge]
    stride = w + 2
    cell = (j // samples) * stride + ix
    size = h * stride
    acc = np.bincount(cell, weights=d * (1.0 - fx), minlength=size)
    acc += np.bincount(cell + 1, weights=d * fx, minlength=size)
    wind = np.cumsum(acc.astype(np.float32).reshape(h, stride), axis=1)[:, :w]
    return np.minimum(np.abs(wind), 1.0)


def render(
    prims: Iterable[Mapping[str, Any]],
    width: int = WIDTH,
    height: int = HEIGHT,
    images: Callable[[str, int, int], np.ndarray | None] | None = None,
) -> np.ndarray:
    """One frame (height × width × 3, uint8) from a draw list."""
    c = Canvas(width, height, images)
    c.draw(prims)
    return c.rgb8()


# --- PNG (8-bit RGB, written without a library: portraits of the built-in rig and the raster goldens) ----------


def png_bytes(pixels: np.ndarray) -> bytes:
    """A PNG of an (h, w, 3) or (h, w, 4) uint8 array (filter 0 on every row, zlib level 9)."""
    if pixels.dtype != np.uint8 or pixels.ndim != 3 or pixels.shape[2] not in (3, 4):
        raise ValueError("png_bytes takes an (h, w, 3|4) uint8 array")
    h, w, ch = pixels.shape
    raw = np.concatenate([np.zeros((h, 1), np.uint8), pixels.reshape(h, w * ch)], axis=1).tobytes()

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    color_type = 2 if ch == 3 else 6
    header = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
