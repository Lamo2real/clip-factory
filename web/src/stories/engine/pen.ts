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

export class Pen {
  out: Prim[] = [];
  m: Mat = [...IDENTITY];
  alpha = 1;
  private stack: { m: Mat; alpha: number }[] = [];
  private view: ViewBox;

  constructor(view: ViewBox = FRAME) {
    this.view = view;
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

  setMatrix(m: Mat): void {
    this.m = [...m];
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
    this.out.push({ k: "grad", x0: r1(x0), y0: r1(y0), x1: r1(x1), y1: r1(y1), stops: stops.map(([o, c]) => [r3(o), c]) });
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
    if (px + s1 < this.view.x0 || px - s1 > this.view.x1 || py + s1 < this.view.y0 || py - s1 > this.view.y1) return;
    // round first, then wrap into [0, 180): an angle a hair below 180 and one a hair above 0 are the same ellipse
    let deg = r1(theta / DEG) % 180;
    if (deg < 0) deg += 180;
    const major = r1(Math.max(0.1, s1));
    const minor = r1(Math.max(0.1, s2));
    this.push({ k: "ellipse", x: r1(px), y: r1(py), rx: major, ry: minor, rot: major - minor < 0.15 ? 0 : r1(deg) % 180, color }, al);
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
