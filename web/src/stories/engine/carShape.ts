// Clips Funded engine: the detailed vehicle's shape (CONTRACTS §45.48 section 2). From the measured profile (35 whole
// numbers, `detail.profile`, or the body's preset) it builds, for the side view, the top view and the two end views:
// the outline with its arches cut out, the wheel wells, the daylight opening and its panes, the seats the riders sit in,
// the lamps' centres and the plan from above. It only makes shapes (numbers); `carSide2.ts`, `carTop2.ts` and
// `carView2.ts` paint them. Pure and deterministic: the same look always gives the same numbers.
//
// Frame (side): facing +x, ground at y = 0, up is negative, nose at +hl, as the classic drawing. `X(p)` and `y(h)` here
// take PERCENT (of the length from the nose tip, of the height from the ground): they are the detailed shape's own,
// not the classic `Side.X` / `Side.y` (which take a part of the half length and a level). Everything the scene reads
// (`hl`, `seats`, `tall`, `wr`, `ax`, `sill`, `lowH`, `cabH`, `front`, `frontLeft`, `frontRight`) keeps its meaning.

import type { Resolved } from "./carDetail.ts";
import { PRESET, resolveDetail } from "./carDetail.ts";
import { carSide, carSpec, carTop, classicLook, outlined, type Side, type Top } from "./car.ts";
import { clamp, lerp, TAU } from "./math.ts";
import { arcPts, clipConvex, quadPts } from "./pen.ts";
import type { CarLook, CarProfile } from "./types.ts";

type Pt = [number, number];

/** A control point of an outline: where it is, and how far its corner is rounded. */
export interface CP {
  x: number;
  y: number;
  r: number;
}

export interface Side2 extends Side {
  R: Resolved;
  p: CarProfile;
  len: number;
  open: boolean;
  axRear: number;
  wrRear: number;
  wells: number[][];
  top: [number, number][];
  panes: number[][];
  frame: number[] | null;
  mask: number[];
  roofT: number;
  beltY: (x: number) => number;
  arch: { x: number; cy: number; ra: number; wr: number }[];
  pts: Record<string, [number, number]>;
  /** where the lamps are (shape and height), read by `lampAt` and the lamp parts */
  lamp: { front: { shape: string; h: number | undefined }; rear: { shape: string; h: number | undefined } };
  /** the toon amount (0..100) the box was made with */
  toon: number;
  /** square arches (`detail.arches === "square"`) */
  square: boolean;
}

/** The detailed top view's plan: today's fields, plus the plan outline, the wheels and the landmarks from the profile. */
export interface Top2 extends Top {
  p: CarProfile;
  open: boolean;
  /** half width of the body and of the roof */
  hw: number;
  rw: number;
  /** a station (percent of the length from the nose) to its y, nose up */
  yT: (q: number) => number;
  /** the plan's outline (closed) and its right half's control points, nose to tail */
  outline: number[];
  half: CP[];
  /** the four wheels: centre, width (across) and length (along) */
  wheels: { x: number; y: number; w: number; l: number; front: boolean }[];
  /** the glass: windscreen, roof span, rear glass */
  screen: number[];
  roofSpan: [number, number];
  rearGlass: number[] | null;
  /** the two seats' centres (open: side by side in the tub) */
  seats: { x: number; y: number }[];
}

/** The detailed front or back view's body box, in the pen's units. */
export interface End2 {
  /** the width asked for (the pen's unit, as the classic view's `o.w`) */
  w: number;
  /** the body's width and height, and the frame's: y(h) is minus H * h / 100 */
  W: number;
  H: number;
  y: (h: number) => number;
  p: CarProfile;
  open: boolean;
  hip: number;
  rw: number;
  bw: number;
  tyreW: number;
  lowH: number;
  faceH: number;
  footH: number;
  topH: number;
  /** the right half's control points (bottom to top), the closed outline and the glass */
  half: CP[];
  outline: number[];
  glass: number[];
}

// ---- the profile -------------------------------------------------------------------------------------------------

/** The measured outline a look uses: its own `detail.profile` while that was measured for this body, else the body's preset. */
export function profileOf(car: CarLook): CarProfile {
  const own = car.detail?.profile;
  if (own && own.body === car.body) return own;
  return PRESET[car.body] ?? PRESET.compact;
}

/** An open top (no roof over the cabin): `open` and `targa` (a targa's bar and rear glass are parts, not the outline). */
export function isOpen(car: CarLook): boolean {
  const t = car.detail?.roof?.type;
  return t === "open" || t === "targa";
}

/** Any in-range profile becomes drawable: the order of the stations and the heights are repaired here, nowhere else. */
export function fitProfile(p: CarProfile, open: boolean): CarProfile {
  const q = { ...p };
  q.axF = clamp(q.axF, 8, 40);
  q.axR = clamp(q.axR, Math.max(q.axF + 30, 55), 94);
  q.noseX = clamp(q.noseX, 0, 14);
  q.cowlX = clamp(q.cowlX, q.noseX + 1, 55);
  q.headX = clamp(q.headX, q.cowlX + 2, 72);
  q.roofX = clamp(q.roofX, q.headX + (open ? 10 : 6), 100);
  q.peakX = clamp(q.peakX, q.headX, q.roofX);
  q.deckX = clamp(q.deckX, q.roofX, 100);
  q.tailX = clamp(q.tailX, Math.max(q.deckX, 86), 100);
  q.chinH = clamp(q.chinH, 3, 40);
  q.sillH = clamp(q.sillH, 4, 40);
  q.rumpH = clamp(q.rumpH, 3, 45);
  q.tipH = clamp(q.tipH, q.chinH + 4, 85);
  q.noseH = clamp(q.noseH, q.tipH, 92);
  q.cowlH = clamp(q.cowlH, Math.max(30, q.sillH + 18), 90);
  q.headH = clamp(q.headH, q.cowlH + 8, 100);
  q.roofH = clamp(q.roofH, Math.max(q.sillH + 20, 40), 100);
  q.deckH = clamp(q.deckH, q.rumpH + 12, Math.min(q.roofH, 98));
  q.tailH = clamp(q.tailH, q.rumpH + 10, 98);
  q.beltH = clamp(q.beltH, q.sillH + 16, q.headH - (open ? 6 : 14));
  // the body keeps some depth: the bottom edges stay under a third to 60% of the heights above them
  q.sillH = clamp(Math.min(q.sillH, Math.max(4, q.beltH * 0.36)), 4, 40);
  q.rumpH = clamp(Math.min(q.rumpH, Math.max(3, q.tailH * 0.6)), 3, 45);
  q.chinH = clamp(Math.min(q.chinH, Math.max(3, q.noseH * 0.6)), 3, 40);
  q.deckH = clamp(q.deckH, q.rumpH + 12, Math.min(q.roofH, 98));
  q.tailH = clamp(q.tailH, q.rumpH + 10, 98);
  // the wheels must fit under the top line where they stand: lower the tyre (never the arch's air first) until they do
  q.noseH = clamp(Math.max(q.noseH, 28), q.tipH, 92);
  q.tailH = clamp(Math.max(q.tailH, 28), q.rumpH + 10, 98);
  q.deckH = clamp(Math.max(q.deckH, 28), q.rumpH + 12, Math.min(q.roofH, 98));
  const line: [number, number][] = open
    ? [[q.noseX, q.noseH], [q.cowlX, Math.min(q.cowlH, q.beltH)], [q.roofX, q.beltH], [q.deckX, q.deckH], [q.tailX, q.tailH]]
    : [[q.noseX, q.noseH], [q.cowlX, q.cowlH], [q.headX, q.headH], [q.roofX, q.roofH], [q.deckX, q.deckH], [q.tailX, q.tailH]];
  const at = (x: number): number => {
    if (x <= line[0]![0]) return line[0]![1];
    for (let i = 1; i < line.length; i += 1) {
      const [x1, h1] = line[i]!;
      const [x0, h0] = line[i - 1]!;
      if (x <= x1) return x1 === x0 ? h1 : lerp(h0, h1, (x - x0) / (x1 - x0));
    }
    return line[line.length - 1]![1];
  };
  const room = Math.min(at(q.axF), at(q.axR)) + 4.5;
  if (q.wheelD * (1 + q.archGap / 100) > room) {
    q.archGap = Math.min(q.archGap, 10);
    q.wheelD = clamp(Math.min(q.wheelD, room / (1 + q.archGap / 100)), 20, 72);
  }
  q.glassX = clamp(q.glassX, q.headX + 8, 99);
  q.pillarX = clamp(q.pillarX, q.headX + 6, q.glassX);
  q.panes = clamp(Math.round(q.panes), 1, 5);
  q.lh = clamp(q.lh, 150, 520);
  q.wh = clamp(q.wh, 60, 220);
  q.wheelD = clamp(q.wheelD, 20, 72);
  q.archGap = clamp(q.archGap, 0, 45);
  q.soft = clamp(q.soft, 0, 100);
  q.noseR = clamp(q.noseR, 0, 100);
  q.bonnet = clamp(q.bonnet, 0, 100);
  q.roofW = clamp(q.roofW, 40, 100);
  q.taperF = clamp(q.taperF, 0, 40);
  q.taperR = clamp(q.taperR, 0, 40);
  q.beltRise = clamp(q.beltRise, -10, 20);
  return q;
}

// ---- the box -----------------------------------------------------------------------------------------------------

export interface Sizes {
  hl: number;
  len: number;
  tall: number;
  tall0: number;
  wrF: number;
  wrR: number;
  X: (p: number) => number;
  y: (h: number) => number;
}

/** The editor's box: half the longest a vehicle may be. */
export const MAX_HL = 505;

/**
 * The box: the classic body's visual mass (the same area), stretched towards the real length / height by `toon`
 * (0 real proportions .. 100 as chunky as the classic drawing). A detailed vehicle is at most 20% longer and 17% lower
 * than its classic body; the length, height and wheel-size sliders multiply on top.
 */
export function sizeOf(car: CarLook, p: CarProfile = fitProfile(profileOf(car), isOpen(car)), toon: number = car.detail?.toon ?? 30): Sizes {
  const B = carSpec(car.body);
  const L = clamp(car.length, 0.85, 1.15);
  const Hs = clamp(car.height, 0.85, 1.15);
  const Ws = clamp(car.wheels.size, 0.85, 1.2);
  const len0c = 584 * B.len;
  const tall0c = 266 * B.hgt + 32.4 + B.lift;
  const c = len0c / tall0c;
  const r = clamp((p.lh / 100) * (1 - (0.34 * toon) / 100), 0.9 * c, 1.44 * c);
  const gm = Math.sqrt(len0c * tall0c);
  const len = Math.min(gm * Math.sqrt(r) * L, MAX_HL * 2);
  const tall0 = gm / Math.sqrt(r);
  const tall = tall0 * Hs;
  const k = (0.5 * (1 + (0.25 * toon) / 100) * Ws * tall0) / 100;
  const wrF = clamp(p.wheelD * k, 26, 0.46 * tall);
  const rearD = clamp(car.detail?.wheels?.rearD ?? p.wheelD, 20, 72);
  const wrR = clamp(rearD * k, 26, 0.46 * tall);
  const hl = len / 2;
  // an arch stays inside the body: not past the nose or the tail, and not into the other wheel's arch
  const g1 = 1 + p.archGap / 100;
  const room = (Math.min(p.axF, 100 - p.axR) * len) / 100 - 4;
  const between = (((p.axR - p.axF) * len) / 100 - 8) / 2;
  const cap = (v: number): number => Math.max(12, Math.min(v, (room - 3) / g1, (between - 3) / g1));
  return { hl, len, tall, tall0, wrF: cap(wrF), wrR: cap(wrR), X: (q) => hl - (len * q) / 100, y: (h) => -(tall * h) / 100 };
}

// ---- outlines ----------------------------------------------------------------------------------------------------

/** A closed polygon with each corner rounded by up to its own radius (the engine's rounded(), a radius per corner). */
export function roundPath(pts: CP[]): number[] {
  const out: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const p = pts[i]!;
    const a = pts[(i + n - 1) % n]!;
    const b = pts[(i + 1) % n]!;
    const da = Math.hypot(a.x - p.x, a.y - p.y) || 1;
    const db = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const d = Math.min(p.r, da * 0.45, db * 0.45);
    if (d < 0.6) {
      out.push(p.x, p.y);
      continue;
    }
    out.push(...quadPts(p.x + ((a.x - p.x) / da) * d, p.y + ((a.y - p.y) / da) * d, p.x, p.y, p.x + ((b.x - p.x) / db) * d, p.y + ((b.y - p.y) / db) * d, clamp(Math.ceil(d / 5), 3, 9)));
  }
  return out;
}

const cp = (x: number, y: number, r = 0): CP => ({ x, y, r });

/** Every y at which the vertical line at x crosses the polygons (a pane's top is the smallest). */
function crossings(polys: number[][], x: number): number[] {
  const ys: number[] = [];
  for (const q of polys) {
    for (let i = 0; i < q.length; i += 2) {
      const j = (i + 2) % q.length;
      const x0 = q[i]!;
      const x1 = q[j]!;
      if ((x0 - x) * (x1 - x) <= 0 && x0 !== x1) ys.push(lerp(q[i + 1]!, q[j + 1]!, (x - x0) / (x1 - x0)));
    }
  }
  return ys;
}

/** Every x at which the horizontal line at y crosses a polygon. */
function crossingsAtY(poly: number[], yy: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    const y0 = poly[i + 1]!;
    const y1 = poly[j + 1]!;
    if ((y0 - yy) * (y1 - yy) <= 0 && y0 !== y1) xs.push(lerp(poly[i]!, poly[j]!, (yy - y0) / (y1 - y0)));
  }
  return xs;
}

/** An arch cut out of the body's underside round a wheel: from its rear foot over the top to its front foot. */
export function archPts(cx: number, cy: number, ra: number, yb0: number, yb1: number, square: boolean): CP[] {
  if (square) {
    const t = cy - ra;
    const k = 0.62;
    return [cp(cx - ra, yb0, 5), cp(cx - ra, cy - ra * 0.25, 0), cp(cx - ra * k, t, ra * 0.22), cp(cx + ra * k, t, ra * 0.22), cp(cx + ra, cy - ra * 0.25, 0), cp(cx + ra, yb1, 5)];
  }
  const a0 = Math.asin(clamp((yb0 - cy) / ra, -0.95, 0.95));
  const a1 = Math.asin(clamp((yb1 - cy) / ra, -0.95, 0.95));
  const out: CP[] = [];
  const n = 14;
  for (let i = 0; i <= n; i += 1) {
    const a = lerp(Math.PI - a0, TAU + a1, i / n); // the rear foot, over the top (270 degrees), the front foot
    out.push(cp(cx + Math.cos(a) * ra, cy + Math.sin(a) * ra, i === 0 || i === n ? 5 : 0));
  }
  return out;
}

// ---- the side shapes ---------------------------------------------------------------------------------------------

/** Bikes, planes and boats keep today's shape (design-final 1.4): the stub path below. */
function classicForm(car: CarLook): boolean {
  return carSpec(car.body).form !== undefined;
}

/** The side view's shapes of a detailed look. */
export function sideShape(car: CarLook): Side2 {
  if (classicForm(car)) return classicSide2(car);
  const D = car.detail ?? { v: 1 as const };
  const open = isOpen(car);
  const p = fitProfile(profileOf(car), open);
  const toon = D.toon ?? 30;
  const s = sizeOf(car, p, toon);
  const { X, y, tall, len, hl } = s;
  const u = tall / 250; // radii grow with the car
  const R = (base: number) => (4 + (base * p.soft) / 100) * u;
  const square = D.arches === "square";
  const P: Record<string, Pt> = {
    chin: [X(p.noseX * 0.5 + 1.2), y(p.chinH)],
    tip: [X(0), y(p.tipH)],
    nose: [X(p.noseX), y(p.noseH)],
    cowl: [X(p.cowlX), y(p.cowlH)],
    head: [X(p.headX), y(p.headH)],
    roof: [X(p.roofX), y(p.roofH)],
    deck: [X(p.deckX), y(p.deckH)],
    tail: [X(p.tailX), y(p.tailH)],
    butt: [X(100), y(p.rumpH + (p.tailH - p.rumpH) * 0.58)],
    rump: [X(98.2 - (100 - p.tailX) * 0.3), y(p.rumpH)],
  };
  const noseR = (6 + 0.5 * p.noseR) * u;
  const topC: CP[] = [cp(P.tip![0], P.tip![1], noseR * 1.2), cp(P.nose![0], P.nose![1], noseR * 1.6)];
  if (p.bonnet > 4) {
    const span = Math.hypot(P.cowl![0] - P.nose![0], P.cowl![1] - P.nose![1]);
    topC.push(cp(lerp(P.nose![0], P.cowl![0], 0.42), lerp(P.nose![1], P.cowl![1], 0.42) - (p.bonnet / 100) * 0.16 * span, 999));
  }
  const belt0 = y(p.beltH);
  const hoops = D.roof?.hoops ?? "none";
  if (open) {
    // the cockpit: the cowl, the door top (the belt) back to the hoops or the tonneau, then the deck
    topC.push(cp(P.cowl![0], Math.min(P.cowl![1], belt0), 8 * u));
    const hx = X(p.roofX);
    topC.push(cp(hx + 0.035 * len, y(p.beltH + p.beltRise * 0.5), 6 * u));
    if (hoops !== "none") topC.push(cp(hx + 0.012 * len, y(p.roofH), 10 * u), cp(hx - 0.02 * len, y(p.roofH), 16 * u));
    else topC.push(cp(hx, y(Math.max(p.deckH, p.beltH)), 10 * u));
  } else {
    topC.push(cp(P.cowl![0], P.cowl![1], 9 * u), cp(P.head![0], P.head![1], R(36)));
    if (!(p.headH >= 99 && p.roofH >= 99)) topC.push(cp(X(lerp(p.headX, p.peakX, 0.55)), y(100), R(70)), cp(X(lerp(p.peakX, p.roofX, 0.45)), y(100), R(70)));
    topC.push(cp(P.roof![0], P.roof![1], R(40)));
  }
  if (p.deckX - p.roofX > 1.5 || open) topC.push(cp(P.deck![0], P.deck![1], open ? R(60) : R(22)));
  topC.push(cp(P.tail![0], P.tail![1], R(22)), cp(P.butt![0], P.butt![1], R(26)));
  // the underside, tail to nose, with the arches cut out
  const cxR = X(p.axR);
  const cxF = X(p.axF);
  const raR = s.wrR * (1 + p.archGap / 100) + 3;
  const raF = s.wrF * (1 + p.archGap / 100) + 3;
  const ySill = y(p.sillH);
  const yRump = y(p.rumpH);
  const yChin = y(p.chinH);
  const under: CP[] = [cp(P.rump![0], P.rump![1], R(14)), ...archPts(cxR, -s.wrR, raR, yRump, ySill, square), ...archPts(cxF, -s.wrF, raF, ySill, yChin, square), cp(P.chin![0], P.chin![1], R(10))];
  const sil = roundPath([...topC, ...under]);
  // the wheel wells: the dark inside of each arch, a line's width inside the cut, never below the body's own edge
  const well = (cx: number, wr: number, ra: number, yb: number): number[] => {
    const r = ra - 3;
    const shape = square
      ? roundPath([cp(cx - r, -wr + r), cp(cx - r, -wr - r * 0.25), cp(cx - r * 0.62, -wr - r, r * 0.22), cp(cx + r * 0.62, -wr - r, r * 0.22), cp(cx + r, -wr - r * 0.25), cp(cx + r, -wr + r)])
      : arcPts(cx, -wr, r, r, 0, 360, 24).slice(0, -2);
    return clipConvex(shape, [cx - 2 * ra, -9999, cx + 2 * ra, -9999, cx + 2 * ra, yb - 2, cx - 2 * ra, yb - 2]);
  };
  const wells = [well(cxR, s.wrR, raR, Math.max(yRump, ySill)), well(cxF, s.wrF, raF, Math.max(ySill, yChin))];
  // the belt and the side glass
  const gx = X(p.glassX);
  const beltY = (x: number) => lerp(belt0, y(p.beltH + p.beltRise), clamp((P.cowl![0] - x) / Math.max(1, P.cowl![0] - gx), 0, 1));
  const roofT = Math.max(9, 0.055 * tall);
  const aT = 0.03 * len;
  const cT = 0.045 * len;
  const panes: number[][] = [];
  let frame: number[] | null = null;
  let cabin: number[];
  const seats: Side["seats"] = [];
  const rows = D.cabin?.rows ?? (car.body === "pickup" || car.body === "sports" ? 1 : car.body === "bus" ? 3 : 2);
  if (!open) {
    const fl: Pt = [P.cowl![0] - aT * 1.5, beltY(P.cowl![0] - aT * 1.5)];
    const slope = (P.head![0] - P.cowl![0]) / (P.head![1] - P.cowl![1] || -1); // dx per dy along the windscreen
    const ft: Pt = [P.cowl![0] - aT + slope * (P.head![1] + roofT - P.cowl![1]), P.head![1] + roofT];
    const flat = p.headH >= 99 && p.roofH >= 99;
    const mid: CP[] = flat ? [] : [cp(X(lerp(p.headX, p.peakX, 0.6)), y(100) + roofT, 30 * u), cp(X(lerp(p.peakX, p.roofX, 0.4)), y(100) + roofT, 30 * u)];
    const rt: Pt = [Math.max(P.roof![0] + cT, gx), P.roof![1] + roofT];
    const rs = (P.deck![0] - P.roof![0]) / (P.deck![1] - P.roof![1] || 1);
    const rbY = beltY(gx);
    const rb: Pt = [clamp(rt[0] + rs * (rbY - rt[1]) * 0.6, gx, rt[0] + 0.14 * len), rbY];
    const dlo = roundPath([cp(fl[0], fl[1], 10 * u), cp(ft[0], ft[1], 12 * u), ...mid, cp(rt[0], rt[1], 12 * u), cp(rb[0], rb[1], 10 * u)]);
    cabin = dlo;
    const x0 = Math.min(rb[0], rt[0]) - 4;
    const x1 = fl[0] + 4;
    const cuts: number[] = [x1];
    if (p.panes >= 2) {
      const px = X(p.pillarX);
      cuts.push(px);
      for (let i = 2; i < p.panes; i += 1) cuts.push(lerp(px, x0, (i - 1) / (p.panes - 1)));
    }
    cuts.push(x0);
    const gap = Math.max(7, 0.012 * len);
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const a = cuts[i]! - (i === 0 ? 0 : gap / 2);
      const b = cuts[i + 1]! + (i + 2 === cuts.length ? 0 : gap / 2);
      const pane = clipConvex(dlo, [b, -9999, a, -9999, a, 9999, b, 9999]);
      if (pane.length >= 6) panes.push(pane);
    }
    const at = (x: number, dy = 0) => ({ x, beltY: beltY(x), topY: Math.min(...crossings(panes, x), beltY(x) - 46) + dy });
    if (rows >= 2 && cuts.length > 2) seats.push(at(lerp(cuts[1]!, cuts[0]!, 0.5)), at(lerp(cuts[2]!, cuts[1]!, 0.55), 6));
    else seats.push(at(lerp(cuts[0]!, cuts[1]!, 0.34)), at(lerp(cuts[0]!, cuts[1]!, 0.7), 6));
  } else {
    // an open cockpit: the windscreen stands on the cowl, very low and strongly raked. From the side it is a thin dark
    // sliver of glass under a tiny frame; the A-pillar and the header curve into the body
    const fw = Math.max(7, 0.012 * len);
    const hx = P.head![0];
    const hy = P.head![1];
    const bx = P.cowl![0] - fw * 0.1;
    const rake = Math.hypot(hx - bx, hy - belt0);
    const back = clamp(0.2 * rake, 0.045 * len, 0.085 * len);
    // the pane is a thin raked sliver of dark glass; the frame is the pane grown into a visible A-pillar and header, so the
    // screen is one solid raked unit that stands on the cowl and runs back into the body
    const pane = [bx + fw * 0.1, belt0 + 1, hx - fw * 0.1, hy + 5, hx - 0.026 * len, hy + 7, bx - back, belt0 + 1];
    panes.push(pane);
    frame = outlined([bx + fw * 0.25, belt0 + 6, hx - fw * 0.1, hy + 5, hx - 0.026 * len, hy + 7, bx - back * 0.85, belt0 + 6], Math.max(5, 0.0065 * len));
    cabin = [...(panes[0] as number[])];
    const x0 = P.head![0] - 0.02 * len;
    const x1 = X(p.roofX) + 0.05 * len;
    for (const k of [0.4, 0.74]) seats.push({ x: lerp(x0, x1, k), beltY: belt0 + 4, topY: y(p.headH) - 0.06 * tall + (k > 0.5 ? 6 : 0) });
  }
  for (const st of seats) st.topY = Math.min(st.topY, st.beltY - 46);
  // the door skin under the belt, painted again after the riders so only their heads and shoulders show
  const creaseH = Math.max(p.sillH + 14, p.beltH * 0.58);
  const m0 = P.cowl![0] - aT * 0.5;
  const m1 = open ? X(p.roofX) + 0.03 * len : gx;
  const mask = [m1, beltY(m1), m0, beltY(m0), m0, y(creaseH), m1, y(creaseH)];
  // the classic Side's own fields, from the new geometry
  const frontPane = panes[0] ?? [];
  let frontLeft = P.cowl![0] - 40;
  let frontRight = P.cowl![0];
  if (frontPane.length >= 6) {
    const ys = frontPane.filter((_, i) => i % 2 === 1);
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const xs = crossingsAtY(frontPane, cy);
    if (xs.length >= 2) {
      frontLeft = Math.min(...xs);
      frontRight = Math.max(...xs);
    }
  }
  const lowHpx = (tall * p.beltH) / 100;
  const lf = D.lights?.front;
  const lr = D.lights?.rear;
  return {
    spec: carSpec(car.body),
    hl,
    sill: y(p.sillH),
    lowH: lowHpx,
    cabH: tall - lowHpx,
    wr: s.wrF,
    ax: cxF,
    y,
    X,
    ws: (lv: number) => lerp(P.cowl![0], P.head![0], clamp(lv - 1, 0, 1)),
    sil,
    cabin,
    front: panes[0] ?? [],
    rear: panes[1] ?? null,
    frontLeft,
    frontRight,
    seats,
    tall,
    R: resolveDetail(car),
    p,
    len,
    open,
    axRear: cxR,
    wrRear: s.wrR,
    wells,
    top: topC.map((c) => [c.x, c.y] as [number, number]),
    panes,
    frame,
    mask,
    roofT,
    beltY,
    arch: [
      { x: cxR, cy: -s.wrR, ra: raR, wr: s.wrR },
      { x: cxF, cy: -s.wrF, ra: raF, wr: s.wrF },
    ],
    pts: P,
    lamp: { front: { shape: lf?.shape ?? car.lights.front, h: lf?.h }, rear: { shape: lr?.shape ?? car.lights.rear, h: lr?.h } },
    toon,
    square,
  };
}

/** A motorbike, a plane or a boat: today's shape under the detailed drawer (design-final 1.4), neutral extras. */
function classicSide2(car: CarLook): Side2 {
  const g = carSide(classicLook(car));
  const p = fitProfile(profileOf(car), false);
  return {
    ...g,
    R: resolveDetail(car),
    p,
    len: g.hl * 2,
    open: false,
    axRear: -g.ax,
    wrRear: g.wr,
    wells: [],
    top: g.spec.top.map(([fx, lv]) => [g.X(fx), g.y(lv)] as [number, number]),
    panes: g.rear ? [g.front, g.rear] : [g.front],
    frame: null,
    mask: g.sil,
    roofT: 0,
    beltY: () => g.y(1.06),
    arch: [],
    pts: {},
    lamp: { front: { shape: car.lights.front, h: undefined }, rear: { shape: car.lights.rear, h: undefined } },
    toon: 0,
    square: false,
  };
}

/** The swept headlamp: a leaf that runs back along the wing from the nose, tucked a little under the outline's top. */
export function sweptLamp(g: Side2): { xa: number; xb: number; inset: number; thick: (t: number) => number } {
  const tall = g.tall;
  return { xa: g.hl - 0.02 * g.len, xb: lerp(g.pts.nose![0], g.pts.cowl![0], 0.4), inset: 0.012 * tall + 2, thick: (t) => 0.075 * tall * (1 - 0.6 * t) };
}

/** The lit core of the swept lamp (a small lens near its front end): the lamp's centre for the beam and the glows. */
export function sweptCore(g: Side2): [number, number] {
  const w = sweptLamp(g);
  const x = lerp(w.xa, w.xb, 0.2);
  const ys = crossings([g.sil], x);
  const top = ys.length > 0 ? Math.min(...ys) : g.pts.nose![1];
  return [x, top + w.inset + w.thick(0.2) * 0.5];
}

/**
 * The centre of the front or rear lamp's lens on the detailed side shape, without drawing anything (the beam is drawn
 * before the body; the lamp parts return the same point: one function, never two copies of the maths).
 */
export function lampAt(g: Side2, which: "front" | "rear"): [number, number] {
  if (g.arch.length === 0) return which === "front" ? [g.hl * 0.94, g.y(0.5)] : [-g.hl * 0.94, g.y(0.55)];
  const { p, hl, tall, len } = g;
  const y = g.y;
  if (which === "front") {
    const L = g.lamp.front;
    const lens = y(L.h ?? lerp(p.tipH, p.noseH, 0.62));
    if (L.shape === "round" || L.shape === "twin_round") {
      const r = 0.062 * tall;
      return [hl - r - 0.004 * len, lens];
    }
    if (L.shape === "swept") {
      const [bx, by] = sweptCore(g);
      return [bx, by];
    }
    if (L.shape === "square" || L.shape === "rect") return [hl - 0.0175 * len - 1, y(p.noseH) + 0.03 * tall + 0.0425 * tall];
    return [hl - 0.029 * len, y(p.noseH) + 0.025 * tall + 0.0175 * tall];
  }
  const L = g.lamp.rear;
  if (L.shape === "round" || L.shape === "twin_round") {
    // a lamp set into the tail panel: its centre is a lens and a half inside the panel's surface at its height
    const r = 0.05 * tall;
    const ly = L.h === undefined ? y(lerp(p.rumpH, p.tailH, 0.62)) : y(L.h);
    const xs = crossingsAtY(g.sil, ly);
    const edge = xs.length > 0 ? Math.min(...xs) : -hl;
    return [edge + r * 1.45, ly];
  }
  if (L.shape === "tall") return [-hl + 1 + 0.008 * len, y(L.h ?? lerp(p.rumpH, p.tailH, 0.5)) + 0.05 * tall];
  if (L.shape === "bar" || L.shape === "slim" || L.shape === "split_bar") return [-hl + 1 + 0.015 * len, y(L.h ?? p.tailH) + 0.05 * tall];
  return [-hl + 1 + 0.011 * len, (L.h === undefined ? y(p.tailH) + 0.04 * tall : y(L.h)) + 0.0375 * tall];
}

// ---- the top view ------------------------------------------------------------------------------------------------

/** The top view's plan of a detailed look, from the same numbers (nose up; origin at the vehicle's centre). */
export function topShape2(car: CarLook): Top2 {
  if (classicForm(car)) {
    const t = carTop(classicLook(car));
    const p = fitProfile(profileOf(car), false);
    const half: CP[] = [];
    return { ...t, p, open: false, hw: t.Wd / 2, rw: t.Wd / 2, yT: (q) => -t.L / 2 + (t.L * q) / 100, outline: [], half, wheels: [], screen: [], roofSpan: [t.wsTop, t.roofBack], rearGlass: null, seats: [] };
  }
  const D = car.detail ?? { v: 1 as const };
  const open = isOpen(car);
  const p = fitProfile(profileOf(car), open);
  const sz = sizeOf(car, p, D.toon ?? 30);
  const B = carSpec(car.body);
  const L = (sz.len * 350) / 584;
  const Wd = 196 * B.wide * clamp(p.wh / (B.wide * 128), 0.86, 1.14);
  const yT = (q: number) => -L / 2 + (L * q) / 100;
  const u = Wd / 196;
  const soft = p.soft / 100;
  const hw = Wd / 2;
  const half: CP[] = [
    cp(hw * (1 - p.taperF / 100) * 0.55, -L / 2, (20 + 0.6 * p.noseR) * u),
    cp(hw * (1 - (p.taperF / 100) * 0.5), yT(Math.max(3, p.axF * 0.35)), (30 + 30 * soft) * u),
    cp(hw, yT(p.axF + 2), 60 * u),
    cp(hw * (open && D.side?.crease === "wedge" ? 0.86 : 0.97), yT(50), 80 * u),
    cp(hw, yT(p.axR - 2), 60 * u),
    cp(hw * (1 - (p.taperR / 100) * 0.6), yT(97), (16 + 40 * soft) * u),
    cp(hw * (1 - p.taperR / 100) * 0.7, L / 2, (16 + 40 * soft) * u),
  ];
  const outline = roundPath([...half, ...half.slice().reverse().map((c) => cp(-c.x, c.y, c.r))]);
  const ww = 30 * (0.8 + (0.2 * p.wheelD) / 40);
  const wheels = (
    [
      [-1, p.axF, sz.wrF, true],
      [1, p.axF, sz.wrF, true],
      [-1, p.axR, sz.wrR, false],
      [1, p.axR, sz.wrR, false],
    ] as [number, number, number, boolean][]
  ).map(([sx, q, wr, front]) => ({ x: sx * (hw - 2), y: yT(q), w: ww, l: 2 * wr * 0.6 * 1.05, front }));
  const rw = hw * (p.roofW / 100) * 1.06;
  // from above an open car's screen is a thin raked strip across the cowl (the glass is seen almost edge on), not a pane
  const wsTopY = open ? yT(p.cowlX + (p.headX - p.cowlX) * 0.42) : yT(p.headX);
  const screen = open ? [-hw * 0.8, yT(p.cowlX), hw * 0.8, yT(p.cowlX), hw * 0.74, wsTopY, -hw * 0.74, wsTopY] : [-hw * 0.82, yT(p.cowlX), hw * 0.82, yT(p.cowlX), rw, yT(p.headX), -rw, yT(p.headX)];
  const rearGlass = !open && p.deckX - p.roofX > 3 ? [-rw * 0.96, yT(p.roofX) + 2, rw * 0.96, yT(p.roofX) + 2, hw * 0.74, yT(p.deckX), -hw * 0.74, yT(p.deckX)] : null;
  const rows = D.cabin?.rows ?? (car.body === "pickup" || car.body === "sports" ? 1 : 2);
  const span = yT(p.roofX) - yT(p.headX);
  const seats: { x: number; y: number }[] = open || rows === 1 ? [{ x: -0.2 * Wd, y: yT(p.headX) + 0.55 * span }, { x: 0.2 * Wd, y: yT(p.headX) + 0.55 * span }] : [{ x: 0, y: yT(p.headX) + 0.28 * span }, { x: 0, y: yT(p.headX) + 0.76 * span }];
  return {
    spec: B,
    L,
    Wd,
    wsBase: yT(p.cowlX),
    wsTop: yT(p.headX),
    roofBack: yT(p.roofX),
    backFoot: yT(p.deckX),
    p,
    open,
    hw,
    rw,
    yT,
    outline,
    half,
    wheels,
    screen,
    roofSpan: [yT(p.headX), yT(p.roofX)],
    rearGlass,
    seats,
  };
}

// ---- the front and the back view ---------------------------------------------------------------------------------

/** The front or back view's body box of a detailed look at width `w`: one frame, built once (design-parametric 2.8). */
export function endShape(car: CarLook, view: "front" | "back", w: number): End2 {
  const open = isOpen(car);
  const p = fitProfile(profileOf(car), open);
  const B = carSpec(car.body);
  const W = w * B.wide;
  const H = clamp((W * 100) / p.wh, 0.45 * W, 1.45 * W) * clamp(car.height, 0.85, 1.15) * (open ? 0.93 : 1);
  const y = (h: number) => -(H * h) / 100;
  const u = W / 400;
  const soft = p.soft / 100;
  const front = view === "front";
  const lowH = front ? p.chinH : p.rumpH;
  const faceH = front ? p.noseH : p.tailH;
  const footH = front ? p.cowlH : p.deckH;
  const topH = front ? p.headH : p.roofH;
  const rw = (W / 2) * (p.roofW / 100);
  const bw = W * 0.47;
  const hip = W / 2;
  const tyreW = (0.2 + 0.1 * (p.wheelD / 57)) * 0.5 * W;
  // an open car's shoulder (the fender's crown) is lower than its door top head on: a low wide tub, the screen narrower above
  const shoulder = open && front ? Math.min(p.beltH, lerp(faceH, footH, car.detail?.side?.crease === "wedge" ? 0.95 : 0.62)) : p.beltH;
  const half: CP[] = [cp(hip * 0.94, y(lowH), 14 * u), cp(hip, y(lerp(lowH, shoulder, 0.45)), (10 + 40 * soft) * u), cp(hip * 0.965, y(shoulder), (8 + 20 * soft) * u)];
  if (!open) half.push(cp(bw, y(p.beltH), 4 * u), cp(rw * 1.04, y(topH - 3), (10 + 40 * soft) * u), cp(rw * 0.86, y(100), (10 + 50 * soft) * u));
  else if (front) half.push(cp(hip * 0.9, y(shoulder + 3), 26 * u), cp(bw * 0.86, y(Math.max(footH, shoulder) + 1), 14 * u));
  else half.push(cp(hip * 0.8, y(Math.max(footH, p.beltH) + 1), 20 * u), cp(hip * 0.34, y(Math.max(footH, p.beltH) - 4), 34 * u));
  const outline = roundPath([...half, ...half.slice().reverse().map((c) => cp(-c.x, c.y, c.r))]);
  const gy0 = y(footH - 1);
  // head on, an open car's screen is a thin low slot: the raked glass is seen almost edge on, so only the lower part of its
  // height shows above the bonnet
  const gy1 = open && front ? y(footH + (topH - footH) * 0.5) : y(topH - (open ? 1 : 5));
  const gw0 = open ? (front ? bw * 0.8 : bw * 0.86) : bw * 0.92;
  const gw1 = open ? (front ? bw * 0.64 : bw * 0.74) : rw * 0.92;
  const glass = roundPath([cp(gw0, gy0, 8 * u), cp(gw1, gy1, 10 * u), cp(-gw1, gy1, 10 * u), cp(-gw0, gy0, 8 * u)]);
  return { w, W, H, y, p, open, hip, rw, bw, tyreW, lowH, faceH, footH, topH, half, outline, glass };
}
