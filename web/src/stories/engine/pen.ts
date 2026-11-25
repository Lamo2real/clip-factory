// Lamo Stories engine: the pen. Everything is drawn through it in local coordinates; it applies the current affine
// transform (camera, character, prop) and emits only the Prim types of types.ts, in output pixels. A transformed
// circle stays a circle (or becomes an ellipse), a rotated rectangle becomes a polygon, line widths scale.
// Coordinates are rounded to 0.1 px and alphas to 0.001 so the draw lists are small and identical everywhere.

import { DEG, clamp01 } from "./math.ts";
import type { Prim } from "./types.ts";

/** x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

// "+ 0" turns -0 into 0, so a list survives a JSON round trip unchanged
const r1 = (v: number) => Math.round(v * 10) / 10 + 0;
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** The visible area plus a margin: prims wholly outside it are dropped (they would draw nothing). */
export interface ViewBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const FRAME: ViewBox = { x0: -60, y0: -60, x1: 1140, y1: 1980 };

/** The output frame of a width × height video plus the 60 px margin (scaled with the video: 40 px at 720). */
export function frameView(width: number, height: number, k = 1): ViewBox {
  return { x0: -60 * k, y0: -60 * k, x1: width + 60 * k, y1: height + 60 * k };
}

export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** A script's seed as the dither's seed (engine README, Dither): a whole number 0 .. 2^31 − 2. */
export function ditherSeed(seed: number): number {
  const n = Math.abs(Math.trunc(seed));
  return Number.isFinite(n) ? n % 2147483647 : 0;
}

export class Pen {
  out: Prim[] = [];
  m: Mat = [...IDENTITY];
  alpha = 1;
  /** Night drive: the seed of the 1-level dither on the sky's gradients and the vignette (engine README), null for no
   * dither (Bright, and every preview without a scene) */
  dither: number | null = null;
  private stack: { m: Mat; alpha: number }[] = [];
  private view: ViewBox;
  /** output px per drawing px (CONTRACTS §45.34): 1, or 2/3 for a 720 video, so it is the 1080 one scaled down */
  private k: number;

  constructor(view: ViewBox = FRAME, k = 1) {
    this.view = view;
    this.k = k;
    if (k !== 1) this.m = [k, 0, 0, k, 0, 0];
  }

  save(): void {
    this.stack.push({ m: [...this.m], alpha: this.alpha });
  }

  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.m = s.m;
      this.alpha = s.alpha;
    }
  }

  /** Sets the transform from drawing px (the output scale is applied on top). */
  setMatrix(m: Mat): void {
    const k = this.k;
    this.m = k === 1 ? [...m] : [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k];
  }

  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
  }

  rotate(deg: number): void {
    if (deg === 0) return;
    const r = deg * DEG;
    const cs = Math.cos(r);
    const sn = Math.sin(r);
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * cs + c * sn, b * cs + d * sn, -a * sn + c * cs, -b * sn + d * cs, e, f];
  }

  scale(sx: number, sy = sx): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * sx, b * sx, c * sy, d * sy, e, f];
  }

  fade(k: number): void {
    this.alpha *= clamp01(k);
  }

  /** The current transform's uniform scale (√|det|). */
  unit(): number {
    const [a, b, c, d] = this.m;
    return Math.sqrt(Math.abs(a * d - b * c));
  }

  /** Where a local point lands in output pixels. */
  at(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  private a(a: number): number | null {
    const v = clamp01(a * this.alpha);
    return v < 0.004 ? null : v;
  }

  private push(p: Prim, alpha: number): void {
    if (alpha < 0.999) (p as { a?: number }).a = r3(alpha);
    this.out.push(p);
  }

  /** Screen-space fills (backgrounds): no transform. */
  fill(color: string): void {
    this.out.push({ k: "fill", color });
  }

  grad(x0: number, y0: number, x1: number, y1: number, stops: [number, string][]): void {
    const k = this.k;
    const p: Extract<Prim, { k: "grad" }> = { k: "grad", x0: r1(x0 * k), y0: r1(y0 * k), x1: r1(x1 * k), y1: r1(y1 * k), stops: stops.map(([o, c]) => [r3(o), c]) };
    if (this.dither !== null) p.dither = this.dither;
    this.out.push(p);
  }

  circle(x: number, y: number, r: number, color: string, a = 1): void {
    const al = this.a(a);
    if (al === null || r <= 0) return;
    const [m0, m1, m2, m3] = this.m;
    const [px, py] = this.at(x, y);
    const uniform = (Math.abs(m0 - m3) < 1e-6 && Math.abs(m1 + m2) < 1e-6) || (Math.abs(m0 + m3) < 1e-6 && Math.abs(m1 - m2) < 1e-6);
    if (uniform) {
      const rr = r * Math.hypot(m0, m1);
      if (px + rr < this.view.x0 || px - rr > this.view.x1 || py + rr < this.view.y0 || py - rr > this.view.y1) return;
      this.push({ k: "circle", x: r1(px), y: r1(py), r: r1(Math.max(0.1, rr)), color }, al);
      return;
    }
    this.ellipse(x, y, r, r, 0, color, a);
  }

  ellipse(x: number, y: number, rx: number, ry: number, rot: number, color: string, a = 1): void {
    const al = this.a(a);
    if (al === null || rx <= 0 || ry <= 0) return;
    const e = this.onScreen(x, y, rx, ry, rot);
    if (e) this.push({ k: "ellipse", ...e, color }, al);
  }

  /** A soft light (night drive): the ellipse in `color`, its alpha fading from the centre out along `fade` ([offset,
   * alpha] stops, offset 0 the centre and 1 the edge, alpha × a); it ends at alpha 0, so its edge never shows. */
  glow(x: number, y: number, rx: number, ry: number, color: string, fade: readonly (readonly [number, number])[], a = 1, dither = false): void {
    const al = this.a(a);
    if (al === null || rx <= 0 || ry <= 0 || fade.length === 0) return;
    const e = this.onScreen(x, y, rx, ry, 0);
    if (!e) return;
    const p: Extract<Prim, { k: "glow" }> = { k: "glow", ...e, color, fade: fade.map(([o, v]) => [r3(o), r3(v)]) };
    if (dither && this.dither !== null) p.dither = this.dither;
    this.push(p, al);
  }

  /** An ellipse (local centre, radii and rotation) on screen, rounded, or null when it is wholly outside the view. */
  private onScreen(x: number, y: number, rx: number, ry: number, rot: number): { x: number; y: number; rx: number; ry: number; rot: number } | null {
    const [m0, m1, m2, m3] = this.m;
    const cr = Math.cos(rot * DEG);
    const sr = Math.sin(rot * DEG);
    // M = L · R(rot) · diag(rx, ry), then the closed-form 2×2 SVD gives the image ellipse.
    const n00 = (m0 * cr + m2 * sr) * rx;
    const n01 = (-m0 * sr + m2 * cr) * ry;
    const n10 = (m1 * cr + m3 * sr) * rx;
    const n11 = (-m1 * sr + m3 * cr) * ry;
    const E = (n00 + n11) / 2;
    const F = (n00 - n11) / 2;
    const G = (n10 + n01) / 2;
    const H = (n10 - n01) / 2;
    const Q = Math.hypot(E, H);
    const R = Math.hypot(F, G);
    const s1 = Q + R;
    const s2 = Math.abs(Q - R);
    const theta = (Math.atan2(G, F) + Math.atan2(H, E)) / 2;
    const [px, py] = this.at(x, y);
    if (px + s1 < this.view.x0 || px - s1 > this.view.x1 || py + s1 < this.view.y0 || py - s1 > this.view.y1) return null;
    // round first, then wrap into [0, 180): an angle a hair below 180 and one a hair above 0 are the same ellipse
    let deg = r1(theta / DEG) % 180;
    if (deg < 0) deg += 180;
    const major = r1(Math.max(0.1, s1));
    const minor = r1(Math.max(0.1, s2));
    return { x: r1(px), y: r1(py), rx: major, ry: minor, rot: major - minor < 0.15 ? 0 : r1(deg) % 180 };
  }

  rect(x: number, y: number, w: number, h: number, r: number, color: string, a = 1): void {
    const al = this.a(a);
    if (al === null || w <= 0 || h <= 0) return;
    const [m0, m1, m2, m3] = this.m;
    if (Math.abs(m1) < 1e-9 && Math.abs(m2) < 1e-9) {
      const [ax, ay] = this.at(x, y);
      const [bx, by] = this.at(x + w, y + h);
      const X = Math.min(ax, bx);
      const Y = Math.min(ay, by);
      const W = Math.abs(bx - ax);
      const Hh = Math.abs(by - ay);
      if (X + W < this.view.x0 || X > this.view.x1 || Y + Hh < this.view.y0 || Y > this.view.y1) return;
      const rr = Math.min(r * Math.min(Math.abs(m0), Math.abs(m3)), W / 2, Hh / 2);
      this.push({ k: "rect", x: r1(X), y: r1(Y), w: r1(W), h: r1(Hh), r: r1(Math.max(0, rr)), color }, al);
      return;
    }
    this.poly(roundRectPts(x, y, w, h, Math.min(r, w / 2, h / 2)), color, a);
  }

  poly(pts: number[], color: string, a = 1): void {
    const al = this.a(a);
    if (al === null || pts.length < 6) return;
    const [m0, m1, m2, m3, m4, m5] = this.m;
    const out: number[] = new Array(pts.length);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      const px = m0 * x + m2 * y + m4;
      const py = m1 * x + m3 * y + m5;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      out[i] = r1(px);
      out[i + 1] = r1(py);
    }
    if (x1 < this.view.x0 || x0 > this.view.x1 || y1 < this.view.y0 || y0 > this.view.y1) return;
    this.push({ k: "poly", pts: out, color }, al);
  }

  line(pts: number[], w: number, color: string, a = 1): void {
    const al = this.a(a);
    if (al === null || pts.length < 4 || w <= 0) return;
    const [m0, m1, m2, m3, m4, m5] = this.m;
    const ww = w * Math.sqrt(Math.abs(m0 * m3 - m1 * m2));
    const out: number[] = new Array(pts.length);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      const px = m0 * x + m2 * y + m4;
      const py = m1 * x + m3 * y + m5;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      out[i] = r1(px);
      out[i + 1] = r1(py);
    }
    if (x1 + ww < this.view.x0 || x0 - ww > this.view.x1 || y1 + ww < this.view.y0 || y0 - ww > this.view.y1) return;
    this.push({ k: "line", pts: out, w: r1(Math.max(0.2, ww)), color }, al);
  }
}

// ---- shape generators (local coordinates, flat lists x0, y0, x1, y1, …) ---------------------------------------

export function roundRectPts(x: number, y: number, w: number, h: number, r: number): number[] {
  if (r <= 0.01) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const pts: number[] = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= 3; k += 1) {
      const a = (a0 + k * 30) * DEG;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }
  return pts;
}

/** Points on an ellipse, angles in degrees (0 = +x, clockwise on screen). */
export function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, segs: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const a = (a0 + ((a1 - a0) * i) / segs) * DEG;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return pts;
}

/** A rounded blob: |x/a|^n + |y/b|^n = 1, wider at the bottom by `taper`. Convex for n ≥ 2. */
export function superellipse(cx: number, cy: number, a: number, b: number, n: number, taper: number, segs = 28): number[] {
  const pts: number[] = [];
  for (let i = 0; i < segs; i += 1) {
    const t = (i / segs) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const y = b * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    const wide = a * (1 + (taper * y) / b);
    pts.push(cx + wide * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), cy + y);
  }
  return pts;
}

export function starPts(cx: number, cy: number, ro: number, ri: number, points: number, rot = -90): number[] {
  const pts: number[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const a = (rot + (i * 180) / points) * DEG;
    const r = i % 2 === 0 ? ro : ri;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/** A heart of width ≈ 2·s centred on (cx, cy). */
export function heartPts(cx: number, cy: number, s: number, segs = 24): number[] {
  const pts: number[] = [];
  for (let i = 0; i < segs; i += 1) {
    const t = (i / segs) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push(cx + (x / 16) * s, cy - (y / 16) * s);
  }
  return pts;
}

export function quadPts(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, segs = 8): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
  return pts;
}

/** A teardrop pointing up, tip at (cx, cy - h). */
export function dropPts(cx: number, cy: number, r: number, h: number): number[] {
  const pts: number[] = [cx, cy - h];
  for (let i = 0; i <= 10; i += 1) {
    const a = (-20 + (220 * i) / 10) * DEG;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

function signedArea(p: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i]! * p[j + 1]! - p[j]! * p[i + 1]!;
  }
  return s / 2;
}

/** Many closed shapes as one polygon (non-zero winding): each walked round clockwise on screen and back to its start,
 * the next one reached by a bridge from there, and every bridge walked back at the end, so the bridges add nothing and
 * shapes that overlap fill once. Lights that share a colour and an alpha (the far street lamps' glow rings, a car's
 * two headlights) draw as one shape instead of one each. */
export function joinShapes(shapes: number[][]): number[] {
  const pts: number[] = [];
  const starts: number[] = [];
  for (const s of shapes) {
    if (s.length < 6) continue;
    let loop = s;
    if (signedArea(s) < 0) {
      loop = [];
      for (let i = s.length - 2; i >= 0; i -= 2) loop.push(s[i]!, s[i + 1]!);
    }
    pts.push(...loop, loop[0]!, loop[1]!);
    starts.push(loop[0]!, loop[1]!);
  }
  for (let i = starts.length - 4; i >= 0; i -= 2) pts.push(starts[i]!, starts[i + 1]!);
  return pts;
}

/** Sutherland–Hodgman: the part of `subject` inside the convex polygon `clip`. */
export function clipConvex(subject: number[], clip: number[]): number[] {
  let out = subject;
  const dir = signedArea(clip) >= 0 ? 1 : -1;
  for (let i = 0; i < clip.length && out.length >= 6; i += 2) {
    const j = (i + 2) % clip.length;
    const ax = clip[i]!;
    const ay = clip[i + 1]!;
    const bx = clip[j]!;
    const by = clip[j + 1]!;
    const inside = (x: number, y: number) => dir * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) >= 0;
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k += 2) {
      const l = (k + input.length - 2) % input.length;
      const cx = input[k]!;
      const cy = input[k + 1]!;
      const px = input[l]!;
      const py = input[l + 1]!;
      const cin = inside(cx, cy);
      const pin = inside(px, py);
      if (cin !== pin) {
        const dx = cx - px;
        const dy = cy - py;
        const den = (bx - ax) * dy - (by - ay) * dx;
        const t = den === 0 ? 0 : ((bx - ax) * (ay - py) - (by - ay) * (ax - px)) / den;
        out.push(px + dx * t, py + dy * t);
      }
      if (cin) out.push(cx, cy);
    }
  }
  return out;
}

/** Scales a point list about (cx, cy): outlines are the same shape, a little bigger, behind. */
export function grow(pts: number[], cx: number, cy: number, k: number): number[] {
  return pts.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * k : cy + (v - cy) * k));
}

/** Offsets a convex-ish point list outwards from its centroid by `d` units. */
export function inflate(pts: number[], d: number): number[] {
  let cx = 0;
  let cy = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) {
    cx += pts[i]!;
    cy += pts[i + 1]!;
  }
  cx /= n;
  cy /= n;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i]! - cx;
    const dy = pts[i + 1]! - cy;
    const len = Math.hypot(dx, dy) || 1;
    out.push(pts[i]! + (dx / len) * d, pts[i + 1]! + (dy / len) * d);
  }
  return out;
}

// ---- more shape generators (night drive's people, rig.ts and face.ts) --------------------------------------------

/** A whole ellipse as a closed polygon of `segs` points (arcPts without its repeated end point), turned `rot`
 * degrees clockwise on screen. */
export function ellipsePts(cx: number, cy: number, rx: number, ry: number, segs = 16, rot = 0): number[] {
  const pts: number[] = [];
  const cr = Math.cos(rot * DEG);
  const sr = Math.sin(rot * DEG);
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    pts.push(cx + x * cr - y * sr, cy + x * sr + y * cr);
  }
  return pts;
}

/** A tapered capsule: the convex shape round a circle of radius r0 at (x0, y0) and one of radius r1 at (x1, y1), each
 * end cap `segs` steps (a limb's bone, a finger, a thick stroke that narrows). */
export function capsulePts(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number, segs = 6): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  // one circle inside the other: the bigger one alone
  if (d + r1 <= r0 + 1e-6) return ellipsePts(x0, y0, r0, r0, segs * 2);
  if (d + r0 <= r1 + 1e-6) return ellipsePts(x1, y1, r1, r1, segs * 2);
  const th = Math.atan2(dy, dx);
  const phi = Math.acos(Math.max(-1, Math.min(1, (r0 - r1) / d)));
  const pts: number[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const a = th + phi + ((2 * Math.PI - 2 * phi) * i) / segs;
    pts.push(x0 + Math.cos(a) * r0, y0 + Math.sin(a) * r0);
  }
  for (let i = 0; i <= segs; i += 1) {
    const a = th - phi + (2 * phi * i) / segs;
    pts.push(x1 + Math.cos(a) * r1, y1 + Math.sin(a) * r1);
  }
  return pts;
}

/** A smooth curve through the points `p` (x, y pairs): a Catmull-Rom spline by chord length, `segs` steps between two
 * points, closed (back to the first point) or open. The points listed in `sharp` (their indexes) are corners: the
 * curve arrives and leaves straight along its chords there. A few well placed points give a clean bold outline. */
export function smoothPts(p: number[], closed = true, segs = 4, sharp: readonly number[] = []): number[] {
  const n = p.length >> 1;
  if (n < 3) return p.slice();
  const at = (i: number): [number, number] => {
    const k = ((i % n) + n) % n;
    return [p[k * 2]!, p[k * 2 + 1]!];
  };
  const corner = (i: number): boolean => (!closed && (i <= 0 || i >= n - 1)) || sharp.includes(((i % n) + n) % n);
  // the curve's direction at point i per unit of chord: `side` 1 leaving it, -1 arriving at it
  const tangent = (i: number, side: 1 | -1): [number, number] => {
    const [x, y] = at(i);
    const [px, py] = at(i - 1);
    const [nx, ny] = at(i + 1);
    const da = Math.hypot(x - px, y - py) || 1;
    const db = Math.hypot(nx - x, ny - y) || 1;
    if (corner(i)) return side > 0 ? [(nx - x) / db, (ny - y) / db] : [(x - px) / da, (y - py) / da];
    return [(((x - px) / da) * db + ((nx - x) / db) * da) / (da + db), (((y - py) / da) * db + ((ny - y) / db) * da) / (da + db)];
  };
  const out: number[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const [x0, y0] = at(i);
    const [x1, y1] = at(i + 1);
    const d = Math.hypot(x1 - x0, y1 - y0);
    const [ax, ay] = tangent(i, 1);
    const [bx, by] = tangent(i + 1, -1);
    for (let s = 0; s < segs; s += 1) {
      const t = s / segs;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = (t3 - 2 * t2 + t) * d;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = (t3 - t2) * d;
      out.push(h00 * x0 + h10 * ax + h01 * x1 + h11 * bx, h00 * y0 + h10 * ay + h01 * y1 + h11 * by);
    }
  }
  if (!closed) out.push(p[n * 2 - 2]!, p[n * 2 - 1]!);
  return out;
}

/** A band along the centre line `c` (x, y pairs) as a closed polygon: `w` is its width, one for the whole line or one
 * per point (a 0 at an end tapers it to a tip). `cap` > 0 rounds each end that has a width with that many points. */
export function ribbonPts(c: number[], w: number | readonly number[], cap = 0): number[] {
  const n = c.length >> 1;
  if (n < 2) return [];
  const half = (i: number): number => (typeof w === "number" ? w : (w[Math.min(i, w.length - 1)] ?? 0)) / 2;
  const left: number[] = [];
  const right: number[] = [];
  const dirs: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const dx = c[i1 * 2]! - c[i0 * 2]!;
    const dy = c[i1 * 2 + 1]! - c[i0 * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    dirs.push([ux, uy]);
    const h = half(i);
    left.push(c[i * 2]! + uy * h, c[i * 2 + 1]! - ux * h);
    right.push(c[i * 2]! - uy * h, c[i * 2 + 1]! + ux * h);
  }
  const out = [...left];
  const round = (i: number, sign: 1 | -1): void => {
    const h = half(i);
    if (cap <= 0 || h <= 0) return;
    const [ux, uy] = dirs[i]!;
    for (let k = 1; k <= cap; k += 1) {
      const a = (Math.PI * k) / (cap + 1);
      // from the left side round the tip to the right side (the end), or from the right back to the left (the start)
      const across = Math.cos(a) * h * sign;
      const along = Math.sin(a) * h * sign;
      out.push(c[i * 2]! + uy * across + ux * along, c[i * 2 + 1]! - ux * across + uy * along);
    }
  };
  round(n - 1, 1);
  for (let i = n - 1; i >= 0; i -= 1) out.push(right[i * 2]!, right[i * 2 + 1]!);
  round(0, -1);
  return out;
}

/** A point list turned `rot` degrees clockwise on screen about the origin, then moved to (x, y): a part built in its
 * own frame, placed in another's (so both can be one shape). */
export function placePts(pts: number[], x: number, y: number, rot = 0): number[] {
  const cr = Math.cos(rot * DEG);
  const sr = Math.sin(rot * DEG);
  const out: number[] = new Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    out[i] = x + pts[i]! * cr - pts[i + 1]! * sr;
    out[i + 1] = y + pts[i]! * sr + pts[i + 1]! * cr;
  }
  return out;
}
