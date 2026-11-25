// Clips Funded engine: a car character of the cast (CONTRACTS §45.42, ADR-91). A car of the cast is a car prop whose
// `castId` names it: it is drawn from its own CarLook, in the side and the top view, in the same frame as the plain
// car of props.ts (origin on the ground at its centre, facing +x, px × k; top view: its centre, nose up). Cartoon
// style: bold friendly shapes with the same outline weight as people. A plate is always one plain light rectangle and
// no badge is ever drawn: the engine has no text shapes. Its movement style changes the drawing, never the timing.
// In the night drive style (§45.45, art.ts) the same shapes are drawn with soft thin lines, graded paint in three
// tones, door lines, handles, a mirror on a stalk, glass reflections, rim light, soft shadows and glowing lights; the
// front and back views of the shots are carView.ts. A script without `art` draws exactly as before.

import { cel, fadeStops, grade, haloStops, ink, lift, lineUnits, ND, nightDrive } from "./art.ts";
import { carShapes, carViewShapes } from "./carBudget.ts";
import { checkCarDetail } from "./carDetail.ts";
import { sideShape } from "./carShape.ts";
import { drawCarLookSide2 } from "./carSide2.ts";
import { drawCarLookTop2 } from "./carTop2.ts";
import { CATALOG } from "./catalog.ts";
import { blink as blinkAt, FACES, type FaceParams, type Mouth } from "./face.ts";
import { F } from "./frame.ts";
import { DEG, TAU, clamp, clamp01, ease, hex, isHex, lerp, mix, noise, rand, shade, smoothstep } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, clipConvex, quadPts, roundRectPts, starPts } from "./pen.ts";
import type { Occupants, PropState } from "./props.ts";
import type { CarBody, CarLook, Expression, MovementStyle } from "./types.ts";

export const DEFAULT_CAR: CarLook = {
  body: "hatchback",
  length: 1,
  height: 1,
  paint: "#d8352a",
  accent: "#f4f1ea",
  pattern: "plain",
  windows: "clear",
  wheels: { style: "alloy", rim: "#c9ccd2", size: 1 },
  lights: { front: "round", rear: "bar" },
  extra: "none",
  face: { eyes: "none", color: "#1c1842", mouth: "none" },
  outline: "#1c1842",
};

/** A car of the cast seats a driver and one passenger (the first rider drives). */
export const CAR_SEATS = 2;
/** The busiest measured frame of a car of the cast with eyes on, in prims (every look choice, every prop action, both
 * views; web/test/storiesEngineCars.test.ts measures it): script.ts counts it for a scene's shape budget. */
export const CAR_CAST_SHAPES = 56;
/** The same in the night drive style (softer lines, three tones, door detail, reflections and glowing lights),
 * measured the same way by web/test/storiesNightCars.test.ts. */
export const CAR_CAST_SHAPES_ND = 72;
/** The busiest front or back view of any car (carView.ts: a car of the cast with eyes, a plain car or a truck, at
 * night with its lights on), measured by web/test/storiesNightCars.test.ts: the shots count it per car they show. */
export const CAR_VIEW_SHAPES = 34;
/** §45.48: the budget of a detailed look is measured by carBudget.ts (a look without `detail` is exactly the three
 * numbers above); re-exported so old imports keep working. */
export { carShapes, carViewShapes };

/** The same look without its `detail`: what the classic drawer draws (the detailed drawers' stand-ins use it until they
 * draw for themselves). */
export function classicLook(car: CarLook): CarLook {
  if (car.detail === undefined) return car;
  const { detail: _detail, ...rest } = car;
  return rest;
}

export function carHasFace(car: CarLook): boolean {
  return car.face.eyes !== "none";
}

// ---- the check (one rule set with the API's characters.car_look and the agent's check_car) ----------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const show = (v: unknown): string => {
  const s = v === undefined ? "nothing" : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};
const ids = (list: { id: string }[]): string[] => list.map((e) => e.id);
const CL = CATALOG.carLooks;
const ENUMS: Record<"body" | "pattern" | "windows" | "extra", string[]> = { body: ids(CL.body), pattern: ids(CL.pattern), windows: ids(CL.windows), extra: ids(CL.extra) };

/** Checks a CarLook: catalog choices, #rrggbb colours and numbers in range, each problem one sentence. */
export function checkCarLook(look: unknown, where: string, err: (m: string) => void): void {
  if (!isObj(look)) {
    err(`${where}: car is missing. Copy the car's saved look into cars.`);
    return;
  }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (typeof look[k] !== "string" || !allowed.includes(look[k] as string)) err(`${where}: car.${k} is ${show(look[k])}; use one of ${allowed.join(", ")}.`);
  }
  for (const k of ["paint", "accent", "outline"]) {
    if (!isHex(look[k])) err(`${where}: car.${k} must be a colour like "#d8352a".`);
  }
  for (const k of ["length", "height"]) {
    if (!isNum(look[k]) || (look[k] as number) < 0.85 || (look[k] as number) > 1.15) err(`${where}: car.${k} is ${show(look[k])}; use a number from 0.85 to 1.15.`);
  }
  const w = look.wheels;
  if (!isObj(w) || !ids(CL.wheels).includes(w.style as string) || !isHex(w.rim) || !isNum(w.size) || w.size < 0.85 || w.size > 1.2) {
    err(`${where}: car.wheels needs a style (${ids(CL.wheels).join(", ")}), a rim colour and a size from 0.85 to 1.2.`);
  }
  const l = look.lights;
  if (!isObj(l) || !ids(CL.frontLights).includes(l.front as string) || !ids(CL.rearLights).includes(l.rear as string)) {
    err(`${where}: car.lights needs front (${ids(CL.frontLights).join(", ")}) and rear (${ids(CL.rearLights).join(", ")}) lights.`);
  }
  const f = look.face;
  if (!isObj(f) || !ids(CL.eyes).includes(f.eyes as string) || !isHex(f.color) || !ids(CL.mouth).includes(f.mouth as string)) {
    err(`${where}: car.face needs eyes (${ids(CL.eyes).join(", ")}), a colour and a mouth (${ids(CL.mouth).join(", ")}).`);
  }
  // §45.47: the inside colours from the inside photos; left out, the cabin keeps its usual colours
  const inside = look.interior;
  if (inside !== undefined && (!isObj(inside) || !isHex(inside.seat) || !isHex(inside.dash) || (inside.trim !== undefined && !isHex(inside.trim)))) {
    err(`${where}: car.interior needs a seat and a dash colour like "#2d2d2f" (and a trim colour, if any).`);
  }
  // §45.48: the optional measured outline and parts; a look without it is checked exactly as before
  if (look.detail !== undefined) checkCarDetail(look.detail, where, err);
}

// ---- geometry ----------------------------------------------------------------------------------------------------

export interface CarDraw {
  car: CarLook;
  style: MovementStyle;
  seed: number;
}

export interface Spec {
  /** length and height against today's plain car (1 / 1) */
  len: number;
  hgt: number;
  /** the top line, front to back: [x as a part of the half length (front = 1), level (0 sill, 1 belt, 2 roof)] */
  top: [number, number][];
  /** the windscreen (its foot, then its top) and the rear glass line (the roof's end, then its foot): indexes of `top` */
  ws: [number, number];
  back: [number, number];
  /** the B pillar between the side windows, a part of the half length */
  pillar: number;
  /** a rear side window (a pickup has only its cab's) */
  rear: boolean;
  /** ride height over today's car, px */
  lift: number;
  /** the wheels' x, a part of the half length */
  axle: number;
  /** top view width against today's car */
  wide: number;
  /** where a spoiler sits: [x part, level] */
  spoiler: [number, number];
  /** top view corner radius */
  round: number;
  bed?: boolean;
  /** §45.47: a vehicle that is not a car or truck. A bike has no glass (its riders sit in the open) and two wheels in
   * line; a plane has wings, a tail fin and small wheels under it; a boat has a hull and floats (no wheels). */
  form?: "bike" | "plane" | "boat";
}

const BODIES: Record<CarBody, Spec> = {
  hatchback: { len: 1, hgt: 1, top: [[1, 0.78], [0.96, 0.98], [0.56, 1.04], [0.17, 2], [-0.56, 2], [-0.7, 1.82], [-0.8, 1.04], [-1, 0.9]], ws: [2, 3], back: [4, 6], pillar: -0.08, rear: true, lift: 0, axle: 0.64, wide: 1, spoiler: [-0.62, 2], round: 56 },
  sedan: { len: 1.12, hgt: 0.95, top: [[1, 0.72], [0.96, 0.95], [0.5, 1.04], [0.16, 2], [-0.34, 2], [-0.62, 1.12], [-0.95, 1.06], [-1, 0.86]], ws: [2, 3], back: [4, 5], pillar: -0.08, rear: true, lift: 0, axle: 0.64, wide: 1, spoiler: [-0.9, 1.06], round: 52 },
  estate: { len: 1.14, hgt: 1, top: [[1, 0.78], [0.96, 0.98], [0.52, 1.04], [0.16, 2], [-0.86, 2], [-0.96, 1.86], [-1, 1]], ws: [2, 3], back: [4, 6], pillar: -0.08, rear: true, lift: 0, axle: 0.64, wide: 1, spoiler: [-0.9, 2], round: 46 },
  suv: { len: 1.08, hgt: 1.18, top: [[1, 0.86], [0.96, 1], [0.54, 1.06], [0.26, 2], [-0.82, 2], [-0.96, 1.86], [-1, 1]], ws: [2, 3], back: [4, 6], pillar: 0, rear: true, lift: 16, axle: 0.64, wide: 1.08, spoiler: [-0.86, 2], round: 44 },
  pickup: { len: 1.2, hgt: 1.1, top: [[1, 0.8], [0.96, 1], [0.5, 1.04], [0.28, 2], [-0.1, 2], [-0.18, 1.86], [-0.2, 1.06], [-1, 1.06]], ws: [2, 3], back: [4, 6], pillar: 0.1, rear: false, lift: 12, axle: 0.66, wide: 1.06, spoiler: [-0.95, 1.06], round: 40, bed: true },
  van: { len: 1.15, hgt: 1.3, top: [[1, 0.92], [0.96, 1.08], [0.78, 1.2], [0.56, 2], [-0.96, 2], [-1, 1.9]], ws: [2, 3], back: [4, 5], pillar: 0.4, rear: true, lift: 6, axle: 0.68, wide: 1.1, spoiler: [-0.9, 2], round: 34 },
  sports: { len: 1.08, hgt: 0.82, top: [[1, 0.58], [0.96, 0.8], [0.44, 0.96], [0.08, 1.86], [-0.24, 1.92], [-0.74, 1.22], [-0.98, 1.02], [-1, 0.72]], ws: [2, 3], back: [4, 5], pillar: -0.14, rear: true, lift: -4, axle: 0.64, wide: 1.02, spoiler: [-0.9, 1], round: 70 },
  compact: { len: 0.82, hgt: 0.95, top: [[1, 0.8], [0.94, 1], [0.62, 1.06], [0.3, 2], [-0.52, 2.02], [-0.78, 1.84], [-0.88, 1.04], [-1, 0.86]], ws: [2, 3], back: [4, 6], pillar: -0.08, rear: true, lift: 0, axle: 0.66, wide: 0.92, spoiler: [-0.66, 2], round: 60 },
  // §45.47: more vehicles, drawn by the same rig (a long tall box; a bike; a plane's fuselage, tail fin and wing; a hull)
  bus: { len: 1.3, hgt: 1.38, top: [[1, 0.9], [0.98, 1.06], [0.95, 2], [-0.97, 2], [-1, 1.9]], ws: [1, 2], back: [3, 4], pillar: 0.3, rear: true, lift: 6, axle: 0.7, wide: 1.14, spoiler: [-0.9, 2], round: 30 },
  motorbike: { len: 0.72, hgt: 0.62, top: [[1, 0.72], [0.88, 1.02], [0.64, 1.9], [0.5, 1.12], [-0.55, 1.08], [-0.8, 1.22], [-1, 0.92]], ws: [1, 2], back: [4, 5], pillar: -0.1, rear: true, lift: 30, axle: 0.78, wide: 0.42, spoiler: [-0.8, 1.22], round: 40, form: "bike" },
  plane: { len: 1.3, hgt: 0.86, top: [[1, 0.62], [0.9, 1.12], [0.62, 2], [-0.6, 2], [-0.84, 2.62], [-1, 2.62], [-1, 1.2]], ws: [1, 2], back: [3, 4], pillar: 0.3, rear: true, lift: 10, axle: 0.5, wide: 0.9, spoiler: [-0.9, 2.62], round: 80, form: "plane" },
  boat: { len: 1.15, hgt: 0.95, top: [[1.02, 1.38], [0.8, 1.06], [0.46, 1.1], [0.22, 2], [-0.46, 2], [-0.56, 1.1], [-1, 1.06]], ws: [2, 3], back: [4, 5], pillar: -0.12, rear: true, lift: 0, axle: 0.6, wide: 0.95, spoiler: [-0.9, 1.06], round: 70, form: "boat" },
};

/** A body's shape numbers (the side view's, which the front and back views of carView.ts read too). */
export function carSpec(body: CarBody): Spec {
  return BODIES[body] ?? BODIES.hatchback;
}

/** The side windows sit between these levels. */
const LV_B = 1.06;
const LV_T = 1.88;
const INSET = 16;
const GAP = 9;
export const GLASS: Record<CarLook["windows"], { glass: string; tint: string; a: number; roof: string }> = {
  clear: { glass: "#bfe3f2", tint: "#bfe9ff", a: 0.22, roof: "#2d3a55" },
  tinted: { glass: "#5f7a8c", tint: "#5f7a8c", a: 0.25, roof: "#26323f" },
  dark: { glass: "#2b3440", tint: "#2b3440", a: 0.4, roof: "#1b222b" },
};
export const PLATE = "#f4f1ea";
export const GRILLE = "#2a2d36";
export const TRIM = "#3d4250";
export const MOUTH_DARK = "#4a1830";
export const TYRE = "#2b2b36";
/** Night drive's glass (graded in the light), tyre and sidewall (§45.45 §6). */
export const GLASS_ND: Record<CarLook["windows"], string> = { clear: "#3e6e7f", tinted: "#2c4a57", dark: "#1c2830" };
export const TYRE_ND = "#1b1a1d";
export const SIDEWALL_ND = "#2b2a2e";
/** A lens that is off (by day), before the light grades it. */
export const LENS_OFF = "#ece6d2";
export const TAIL_OFF = "#b3262d";
/** How a face's mouth bends the grille: + a smile, - a frown. */
export const MOUTH_CURVE: Record<Mouth, number> = { smile: 1, grin: 1.15, laugh: 1.3, o: 0, bigo: 0, flat: 0, frown: -1, wavy: -0.35, smirk: 0.6, grit: 0, pout: -0.3, hum: 0.4 };

type Pt = [number, number];

/** Night drive: an own colour in the light it stands in now (art.ts `grade`); classic: unchanged. */
export function tone(c: string): string {
  return nightDrive() ? grade(c) : c;
}

/** The x part along a chain of `top` points (from → to) at a level, held at its ends. */
export function chainX(top: Pt[], from: number, to: number, lv: number): number {
  const chain: Pt[] = [];
  const step = to >= from ? 1 : -1;
  for (let i = from; i !== to + step; i += step) chain.push(top[i]!);
  chain.sort((a, b) => a[1] - b[1]);
  const first = chain[0]!;
  if (lv <= first[1]) return first[0];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const [x0, l0] = chain[i]!;
    const [x1, l1] = chain[i + 1]!;
    if (lv <= l1) return l1 - l0 < 1e-9 ? x1 : lerp(x0, x1, (lv - l0) / (l1 - l0));
  }
  return chain[chain.length - 1]![0];
}

/** A closed polygon with every corner rounded by up to r (a short quadratic curve). */
export function rounded(pts: Pt[], r: number): number[] {
  const out: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const p = pts[i]!;
    const a = pts[(i + n - 1) % n]!;
    const b = pts[(i + 1) % n]!;
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1;
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const d = Math.min(r, da * 0.45, db * 0.45);
    const q = quadPts(p[0] + ((a[0] - p[0]) / da) * d, p[1] + ((a[1] - p[1]) / da) * d, p[0], p[1], p[0] + ((b[0] - p[0]) / db) * d, p[1] + ((b[1] - p[1]) / db) * d, 3);
    out.push(...q);
  }
  return out;
}

/** The polygon pushed out by d along its corners' normals: an outline of even weight, even where it is not convex. */
export function outlined(pts: number[], d: number): number[] {
  const n = pts.length / 2;
  let area = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    area += pts[i * 2]! * pts[j * 2 + 1]! - pts[j * 2]! * pts[i * 2 + 1]!;
  }
  const s = area >= 0 ? 1 : -1;
  const normal = (i: number, j: number): Pt | null => {
    const dx = pts[j * 2]! - pts[i * 2]!;
    const dy = pts[j * 2 + 1]! - pts[i * 2 + 1]!;
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? null : [(s * dy) / len, (-s * dx) / len];
  };
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = normal((i + n - 1) % n, i);
    const b = normal(i, (i + 1) % n);
    const na = a ?? b ?? [0, 0];
    const nb = b ?? a ?? [0, 0];
    let mx = na[0] + nb[0];
    let my = na[1] + nb[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const k = d / Math.max(0.4, mx * na[0] + my * na[1]);
    out.push(pts[i * 2]! + mx * k, pts[i * 2 + 1]! + my * k);
  }
  return out;
}

export interface Side {
  spec: Spec;
  hl: number;
  sill: number;
  lowH: number;
  cabH: number;
  wr: number;
  ax: number;
  y: (lv: number) => number;
  X: (fx: number) => number;
  ws: (lv: number) => number;
  sil: number[];
  cabin: number[];
  front: number[];
  rear: number[] | null;
  /** the front window's edges at its middle height, for the windscreen eyes */
  frontLeft: number;
  frontRight: number;
  seats: { x: number; beltY: number; topY: number }[];
  /** ground to roof, px */
  tall: number;
}

/** The side view's shapes of a car look (px at k = 1, facing +x). */
export function carSide(car: CarLook): Side {
  if (car.detail !== undefined) return sideShape(car);
  const spec = BODIES[car.body] ?? BODIES.hatchback;
  const hl = 292 * spec.len * clamp(car.length, 0.85, 1.15);
  const H = spec.hgt * clamp(car.height, 0.85, 1.15);
  const wr = 54 * clamp(car.wheels.size, 0.85, 1.2) * (car.wheels.style === "offroad" ? 1.06 : 1);
  // a boat's hull sits a little in the water: its keel under the ground line
  const sill = spec.form === "boat" ? 12 : -(wr * 0.6) - spec.lift - (car.wheels.style === "offroad" ? 6 : 0);
  const lowH = 136 * H;
  const cabH = 130 * H;
  const y = (lv: number) => (lv <= 1 ? sill - lv * lowH : sill - lowH - (lv - 1) * cabH);
  const X = (fx: number) => fx * hl;
  const top = spec.top;
  const ws = (lv: number) => X(chainX(top, spec.ws[0], spec.ws[1], lv));
  const bk = (lv: number) => X(chainX(top, spec.back[0], spec.back[1], lv));
  const raw: Pt[] = top.map(([fx, lv]) => [X(fx), y(lv)]);
  if (spec.form === "boat") raw.push([X(-1), y(0.34)], [X(-0.92), sill], [X(0.42), sill]);
  else raw.push([X(-1), y(0.14)], [X(-0.95), sill], [X(0.95), sill], [X(1), y(0.14)]);
  const sil = rounded(raw, 24);
  const cab: Pt[] = [[X(top[spec.ws[0]]![0]), y(1)]];
  for (let i = spec.ws[0]; i <= spec.back[1]; i += 1) cab.push([X(top[i]![0]), y(top[i]![1])]);
  cab.push([X(top[spec.back[1]]![0]), y(1)]);
  const yb = y(LV_B);
  const yt = y(LV_T);
  const px = X(spec.pillar);
  const right = (lv: number) => ws(lv) - INSET;
  let left = spec.rear ? px + GAP : bk(LV_B) + INSET;
  let leftTop = spec.rear ? px + GAP : bk(LV_T) + INSET;
  leftTop = Math.min(leftTop, right(LV_T) - 12);
  left = Math.min(left, right(LV_B) - 12);
  const front = rounded([[left, yb], [leftTop, yt], [right(LV_T), yt], [right(LV_B), yb]], 10);
  let rear: number[] | null = null;
  const lvM = (LV_B + LV_T) / 2;
  const seats: Side["seats"] = [];
  const mid = (right(LV_T) + right(LV_B)) / 2;
  if (spec.rear) {
    const r0 = Math.min(bk(LV_B) + INSET, px - GAP - 12);
    const r1 = Math.min(bk(LV_T) + INSET, px - GAP - 8);
    rear = rounded([[r0, yb], [r1, yt], [px - GAP, yt], [px - GAP, yb]], 10);
    seats.push({ x: lerp(left, mid, 0.5), beltY: yb, topY: yt });
    seats.push({ x: lerp((r0 + r1) / 2, px - GAP, 0.5), beltY: yb, topY: yt + 6 });
  } else {
    seats.push({ x: lerp((left + leftTop) / 2, mid, 0.68), beltY: yb, topY: yt });
    seats.push({ x: lerp((left + leftTop) / 2, mid, 0.26), beltY: yb, topY: yt + 6 });
  }
  return {
    spec,
    hl,
    sill,
    lowH,
    cabH,
    wr,
    ax: hl * spec.axle,
    y,
    X,
    ws,
    sil,
    cabin: rounded(cab, 14),
    front,
    rear,
    frontLeft: lerp(left, leftTop, 0.5),
    frontRight: right(lvM),
    seats,
    tall: -y(2),
  };
}

// ---- effects shared with the plain car (props.ts); in night drive their colours stand in the light ------------

/** A tyre bursting: a star flash and bits flying off. */
export function burst(pen: Pen, x: number, y: number, age: number, k: number, seed: number, gravity: boolean): void {
  if (age < 0 || age > 0.9) return;
  if (age < 0.45) {
    const g = ease.outBack(Math.min(1, age / 0.12));
    const a = 1 - smoothstep(0.25, 0.45, age);
    pen.poly(starPts(x, y, 95 * k * g, 42 * k * g, 10, age * 60), tone("#ff6f61"), a);
    pen.poly(starPts(x, y, 66 * k * g, 30 * k * g, 10, age * 60 + 18), tone("#ffc94a"), a);
    pen.circle(x, y, 18 * k * g, tone("#ffffff"), a);
  }
  for (let i = 0; i < 4; i += 1) {
    const ang = (-150 + i * 40 + rand(seed, i + 40) * 20) * DEG;
    const v = (380 + rand(seed, i + 50) * 260) * k;
    const bx = x + Math.cos(ang) * v * age;
    const by = y + Math.sin(ang) * v * age + (gravity ? 900 * k * age * age : 0);
    pen.save();
    pen.translate(bx, by);
    pen.rotate(age * 720 + i * 40);
    pen.poly([-10 * k, -5 * k, 9 * k, -7 * k, 11 * k, 6 * k, -8 * k, 5 * k], tone("#2b2b36"), 1 - smoothstep(0.6, 0.9, age));
    pen.restore();
  }
}

/** A bump: a short star flash. */
export function impact(pen: Pen, x: number, y: number, age: number, k: number): void {
  if (age < 0 || age > 0.4) return;
  const g = ease.outBack(Math.min(1, age / 0.1));
  const a = 1 - smoothstep(0.2, 0.4, age);
  pen.poly(starPts(x, y, 70 * k * g, 30 * k * g, 8, 10), tone("#ffffff"), a);
  pen.poly(starPts(x, y, 46 * k * g, 20 * k * g, 8, 10), tone("#ffc94a"), a);
}

/** A honk: three sound-wave arcs spreading from the nose. `dir` is the way the nose points, in degrees on screen
 * (0 = +x, clockwise). */
export function honkWaves(pen: Pen, x: number, y: number, age: number, k: number, dir: number): void {
  if (age < 0) return;
  const c = tone("#ffc94a");
  for (let i = 0; i < 3; i += 1) {
    const ph = (age / 0.6 + i / 3) % 1;
    const r = (26 + ph * 120) * k;
    pen.line(arcPts(x, y, r, r * 1.1, dir - 38, dir + 38, 8), 8 * k, c, 0.9 * (1 - ph));
  }
}

/** Exhaust from the back: two pale puffs when it speeds up, one dark puff when it stalls. (dx, dy): the way the puffs
 * drift, away from the car (and up, in a side view). */
export function exhaust(pen: Pen, x: number, y: number, puffAge: number, stallAge: number, k: number, dx: number, dy: number): void {
  if (puffAge >= 0 && puffAge < 0.75) {
    for (let i = 0; i < 2; i += 1) {
      const p = clamp01((puffAge - i * 0.15) / 0.6);
      if (p <= 0 || p >= 1) continue;
      pen.circle(x + dx * (p * 80 + i * 14) * k, y + dy * (p * 80 + i * 14) * k, (14 + p * 26) * k, tone("#d9dde3"), 0.8 * (1 - p));
    }
  }
  if (stallAge >= 0 && stallAge < 0.8) {
    const p = stallAge / 0.8;
    pen.circle(x + dx * p * 70 * k, y + dy * p * 70 * k, (20 + p * 34) * k, tone("#55586a"), 0.75 * (1 - p));
  }
}

/** The headlights flashing (`blink`): a glow at a light. Night drive: one soft glow (the `glow` prim) in the
 * headlights' own bloom colour, bright at the lens and fading to clear half as far again as Bright's flat disc. */
export function lightGlow(pen: Pen, x: number, y: number, blink: number, k: number): void {
  if (blink <= 0.04) return;
  if (nightDrive()) pen.glow(x, y, 69 * k, 69 * k, ND.headBloom, haloStops(0.85, 0.25, 2), blink);
  else pen.circle(x, y, 46 * k, "#fff3b0", 0.55 * blink);
}

/** Night drive: a tail light's glow in the side view, over its lens: one soft glow (art.ts haloStops) as bright as
 * the lens's own light over it, fading to clear 1.5 × the lens's radius `r` past it; `a` is Bright's flat disc's alpha
 * (0.25 lit, up to 0.45 on the brakes). */
export function tailGlow(pen: Pen, x: number, y: number, r: number, a: number): void {
  pen.glow(x, y, r * 2.5, r * 2.5, ND.tailGlow, haloStops(1, 0.4), Math.min(1, a * 1.05));
}

/** Night drive: a headlight's bloom, the halo only (the lens is the core): one soft glow (art.ts haloStops) flat over
 * the lens and fading to clear at 3.7 × its radius, × k, so it falls off softly like the street lamps. */
export function bloom(pen: Pen, x: number, y: number, r: number, k: number): void {
  if (k <= 0.02) return;
  pen.glow(x, y, r * 3.7, r * 3.7, ND.headBloom, haloStops(1, 0.3), Math.min(1, 0.55 * k));
}

/** Night drive: the headlights' beam from the lens at (x, y), reaching `reach` ahead along +x in the pen's frame
 * (`up`: along -y, the top view's nose) and `spread` either side of its middle at its far end: two soft glows (art.ts
 * fadeStops) that add up smoothly, a bright narrow one from the lens and a wide faint one further out, so the light is
 * strongest at the lens, widens as it goes and fades to clear at its far end, a little lower than the lens in the side
 * view (it falls towards the road). The bright one starts a little behind the lens, so the beam is drawn before the
 * car's body, which covers that end: it never lights its own car. `a` is the flat cone's alpha it replaces (0.08 at
 * night, 0.05 with the lights on by day). */
export function beamGlow(pen: Pen, x: number, y: number, reach: number, spread: number, a: number, up = false): void {
  const glows: [number, number, number, number, number][] = [
    // [ahead of the lens, half length, half width, alpha × a, fade power]
    [0.22, 0.36, 0.55, 3, 1.6],
    [0.55, 0.47, 1.1, 1.9, 1.4],
  ];
  for (const [at, len, wide, k, power] of glows) {
    const al = Math.min(1, a * k);
    if (up) pen.glow(x, y - reach * at, spread * wide, reach * len, ND.beam, fadeStops(1, power), al);
    else pen.glow(x + reach * at, y + reach * at * 0.05, reach * len, spread * wide, ND.beam, fadeStops(1, power), al);
  }
}

/** Where frontLight puts a headlight's lens (the point its glows centre on), without drawing it. */
export function frontLightAt(g: Side, car: CarLook): [number, number] {
  const s = g.lowH / 136;
  return [g.hl - (car.lights.front === "square" ? 19 : car.lights.front === "slim" ? 24 : 20) * s, g.y(0.72)];
}

// ---- the face ----------------------------------------------------------------------------------------------------

/** How much a movement style changes the drawing (never the timing). */
export function styleOf(style: MovementStyle): { bob: number; sway: number; wobble: number; lines: number } {
  switch (style) {
    case "bouncy":
      return { bob: 1.6, sway: 1.4, wobble: 0, lines: 1 };
    case "calm":
      return { bob: 0.6, sway: 0, wobble: 0, lines: 1 };
    case "clumsy":
      return { bob: 1, sway: 0, wobble: 2, lines: 1 };
    case "zippy":
      return { bob: 1, sway: 0, wobble: 0, lines: 0.5 };
    case "heavy":
      return { bob: 1, sway: 0, wobble: 0, lines: 1 };
  }
  return { bob: 1, sway: 0, wobble: 0, lines: 1 };
}

/** A car's face now (null for a car with no eyes). */
export function carFace(face: Expression | null, car: CarLook): FaceParams | null {
  if (!carHasFace(car)) return null;
  return FACES[(face ?? "neutral") as Expression] ?? FACES.neutral;
}

export function faceOf(st: PropState, car: CarLook): FaceParams | null {
  return carFace(st.face, car);
}

/** One eye: an outlined white, a pupil and a glint, or a closed or happy arc; the face.ts parameters drive it. */
export function carEye(pen: Pen, x: number, y: number, rx: number, ry: number, f: FaceParams, closedBy: number, iris: string, ink: string, white: string, lidColour: string, t: number, s: number, glint = "#ffffff"): void {
  const lw = Math.max(2, rx * 0.24);
  if (f.eyes === "happy") {
    pen.line(arcPts(x, y + ry * 0.35, rx, ry * 0.75, 200, 340, 6), lw, ink);
    return;
  }
  const open = f.open * (1 - closedBy);
  if (f.eyes === "closed" || open < 0.16) {
    pen.line(arcPts(x, y - ry * 0.25, rx, ry * 0.55, 20, 160, 6), lw, ink);
    return;
  }
  const eh = ry * Math.min(1.35, open);
  const ew = rx * (1 + 0.06 * (f.open - 1));
  pen.ellipse(x, y, ew + lw * 0.6, eh + lw * 0.6, 0, ink);
  pen.ellipse(x, y, ew, eh, 0, white);
  if (f.eyes === "spiral") {
    const pts: number[] = [];
    const spin = t * 400 * s;
    for (let i = 0; i <= 16; i += 1) {
      const a = (spin + i * 40) * DEG;
      const r = 0.5 + (i / 16) * Math.min(ew, eh) * 0.9;
      pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    pen.line(pts, lw * 0.55, ink);
    return;
  }
  const ir = Math.min(ew * 0.56 * f.pupil, eh * 0.9);
  // a car looks a little ahead, the way it goes
  const ix = x + clamp(f.lookX * 0.7 + 0.25, -1, 1) * (ew - ir) * 0.8;
  const iy = y + clamp(f.lookY, -1, 1) * Math.max(0, eh - ir) * 0.8;
  pen.circle(ix, iy, ir, iris);
  if (f.eyes === "lidded" && f.lid > 0.02) {
    const edge = y - eh + 2 * eh * Math.min(0.85, f.lid);
    const eye = arcPts(x, y, ew * 1.04, eh * 1.04, 0, 360, 18);
    pen.poly(clipConvex(eye, [x - ew * 2, y - eh * 2, x + ew * 2, y - eh * 2, x + ew * 2, edge, x - ew * 2, edge]), lidColour);
    return;
  }
  pen.circle(ix - ir * 0.32, iy - ir * 0.38, Math.max(0.6, ir * 0.34), glint);
}

/** Brows over two eyes side by side (xs: the back eye, then the front one), only on a face that uses them. */
export function carBrows(pen: Pen, xs: [number, number], y: number, rx: number, ry: number, f: FaceParams, ink: string): void {
  if (Math.abs(f.brow) < 4 && f.browUp < 1 && f.browAsym < 1) return;
  for (const s of [-1, 1]) {
    const ex = s < 0 ? xs[0] : xs[1];
    const by = y - ry * Math.max(f.open, 0.85) - rx * 0.4 - f.browUp * ry * 0.1 - (s > 0 ? f.browAsym * ry * 0.1 : 0);
    const half = rx * 0.8;
    const tilt = Math.tan(clamp(f.brow, -40, 40) * DEG) * half;
    pen.line([ex - s * half, by - tilt, ex, by - Math.abs(tilt) * 0.2 - 1, ex + s * half, by + tilt * 0.6], rx * 0.22, ink);
  }
}

// ---- the other vehicles' parts (§45.47) --------------------------------------------------------------------------

/** A plane's wing in the side view: a swept slab across the fuselage's lower half. */
export function wingSide(g: Side): number[] {
  return [g.X(0.34), g.y(0.8), g.X(0.04), g.y(0.8), g.X(-0.32), g.y(0.2), g.X(-0.12), g.y(0.2)];
}

/** A boat on the water: the waterline along its hull, and foam at the bow while it moves. */
export function waterSide(pen: Pen, g: Side, moving: boolean): void {
  pen.line([-g.hl - 24, -4, g.X(0.42) + 34, -4], 9, tone("#e9f6ff"), 0.75);
  if (moving) pen.ellipse(g.X(0.42) + 14, -8, 38, 11, 0, tone("#ffffff"), 0.7);
}

/** The wheels a vehicle shows from above: a car's four, a bike's two in line, none on a plane or a boat. */
export function topWheels(spec: Spec, Wd: number, wy: number): [number, number, boolean][] {
  if (spec.form === "bike") return [[0, -wy, true], [0, wy, false]];
  if (spec.form) return [];
  return [[-Wd / 2 + 2, -wy, true], [Wd / 2 - 2, -wy, true], [-Wd / 2 + 2, wy, false], [Wd / 2 - 2, wy, false]];
}

/** The body seen from above: a rounded box, or a boat's hull with a pointed bow. */
export function topShape(spec: Spec, L: number, Wd: number): number[] {
  if (spec.form === "boat") return rounded([[0, -L / 2], [Wd / 2, -L / 5], [Wd / 2, L / 2], [-Wd / 2, L / 2], [-Wd / 2, -L / 5]], 40);
  return roundRectPts(-Wd / 2, -L / 2, Wd, L, Math.min(spec.round, Wd / 2 - 1));
}

/** A bike's parts in the side view: the fork, the handlebar, the seat, the engine, the exhaust and the rear mudguard. */
export function bikeSide(pen: Pen, g: Side, paint: string, dark: string, chrome: string): void {
  pen.line([g.ax, -g.wr, g.X(0.8), g.y(1.5)], 10, chrome);
  pen.line([g.X(0.8) - 10, g.y(1.5), g.X(0.7), g.y(1.75)], 9, dark);
  pen.rect(g.X(-0.6), g.y(1.08) - 16, g.X(0.6), 18, 9, dark);
  pen.rect(g.X(-0.2), g.sill - 10, g.X(0.45), 40, 10, dark);
  pen.line([g.X(-0.1), g.sill + 16, g.X(-1.05), g.sill - 4], 12, chrome);
  pen.line(arcPts(-g.ax, -g.wr, g.wr * 1.15, g.wr * 1.15, 200, 320, 6), 10, paint);
}

/** A boat's parts in the side view: a stripe along the hull, three portholes, a lifebuoy, the deck rail and a flag. */
export function boatSide(pen: Pen, g: Side, accent: string, dark: string, glass: string, chrome: string): void {
  pen.line([g.X(-1) + 6, g.y(0.3), g.X(0.5), g.y(0.3)], 8, dark);
  for (const fx of [-0.6, -0.3, 0]) pen.circle(g.X(fx), g.y(0.66), 10, glass);
  pen.circle(g.X(-0.8), g.y(0.72), 16, tone("#ff6f61"));
  pen.circle(g.X(-0.8), g.y(0.72), 8, dark);
  pen.line([g.X(-0.98), g.y(1.06) - 24, g.X(0.8), g.y(1.06) - 24, g.X(0.98), g.y(1.3) - 24], 4, chrome, 0.9);
  pen.line([g.X(-0.95), g.y(1.06), g.X(-0.95), g.y(1.06) - 90], 4, chrome);
  pen.poly([g.X(-0.95), g.y(1.06) - 90, g.X(-0.95) - 46, g.y(1.06) - 76, g.X(-0.95), g.y(1.06) - 62], accent);
}

/** The other vehicles' parts from above (§45.47): a plane's engines and tail fin, a boat's rails and swim platform, a
 * bike's handlebar, front mudguard and exhaust. */
export function formTop(pen: Pen, spec: Spec, L: number, Wd: number, dark: string, chrome: string): void {
  if (spec.form === "plane") {
    for (const s of [-1, 1]) pen.ellipse(s * Wd * 0.95, -0.02 * L, 22, 46, 0, dark);
    pen.line([0, L * 0.3, 0, L / 2 - 6], 14, dark);
  } else if (spec.form === "boat") {
    for (const s of [-1, 1]) pen.line([s * (Wd / 2 - 10), -L / 5 + 20, s * (Wd / 2 - 10), L / 2 - 14], 4, chrome, 0.9);
    pen.rect(-Wd * 0.4, L / 2 - 4, Wd * 0.8, 22, 6, dark);
  } else if (spec.form === "bike") {
    pen.line([-Wd * 0.95, -L * 0.3, Wd * 0.95, -L * 0.3], 10, dark);
    pen.rect(-Wd * 0.18, -L / 2 - 10, Wd * 0.36, L * 0.18, 10, dark);
    pen.line([Wd * 0.4, 0, Wd * 0.5, L / 2], 10, chrome);
  }
}

/** A boat's wake from above: two foam lines spreading out behind it. */
export function wakeTop(pen: Pen, L: number, Wd: number): void {
  for (const s of [-1, 1]) pen.line([s * Wd * 0.3, L / 2 - 10, s * Wd * 0.85, L / 2 + 150], 12, tone("#ffffff"), 0.5);
}

/** A plane's wings and tailplane from above, under its fuselage. */
export function wingsTop(pen: Pen, L: number, Wd: number, colour: string): void {
  pen.rect(-1.55 * Wd, -0.05 * L, 3.1 * Wd, 0.16 * L, 22, colour);
  pen.rect(-0.75 * Wd, 0.34 * L, 1.5 * Wd, 0.1 * L, 14, colour);
}

// ---- side view ---------------------------------------------------------------------------------------------------

export function wheelSide(pen: Pen, x: number, y: number, r: number, spin: number, flat: boolean, car: CarLook, ink: string): void {
  const style = car.wheels.style;
  const rim = hex(car.wheels.rim, "#c9ccd2");
  const sq = flat ? 0.72 : 1;
  const cy = flat ? y + r * (1 - sq) : y;
  pen.ellipse(x, cy, r + 5, r * sq + 5, 0, ink);
  if (style === "offroad") {
    // a thick tyre with tread blocks
    const pts: number[] = [];
    for (let i = 0; i < 28; i += 1) {
      const a = spin + (i / 28) * TAU;
      const rr = i % 2 === 0 ? r : r * 0.9;
      pts.push(x + Math.cos(a) * rr, cy + Math.sin(a) * rr * sq);
    }
    pen.poly(pts, TYRE);
  } else pen.ellipse(x, cy, r, r * sq, 0, TYRE);
  const rr = r * (style === "offroad" ? 0.48 : style === "sport" ? 0.66 : 0.58);
  const spokes = (n: number, w: number, colour: string, len: number) => {
    const pts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const a = spin + (i / n) * TAU;
      pts.push(x, cy, x + Math.cos(a) * rr * len, cy + Math.sin(a) * rr * len * sq);
    }
    pen.line(pts, w, colour);
  };
  switch (style) {
    case "steel": {
      pen.ellipse(x, cy, rr, rr * sq, 0, "#9aa3af");
      for (let i = 0; i < 4; i += 1) {
        const a = spin + (i / 4) * TAU;
        pen.circle(x + Math.cos(a) * rr * 0.55, cy + Math.sin(a) * rr * 0.55 * sq, rr * 0.13, "#4a505c");
      }
      return;
    }
    case "hubcap":
      pen.ellipse(x, cy, rr, rr * sq, 0, rim);
      pen.line(arcPts(x, cy, rr * 0.68, rr * 0.68 * sq, 0, 360, 20), rr * 0.1, shade(rim, -0.3));
      pen.circle(x, cy, rr * 0.2, shade(rim, -0.15));
      return;
    case "alloy":
      pen.ellipse(x, cy, rr, rr * sq, 0, shade(rim, -0.45));
      spokes(5, rr * 0.26, rim, 0.92);
      pen.circle(x, cy, rr * 0.24, rim);
      return;
    case "sport":
      pen.ellipse(x, cy, rr, rr * sq, 0, shade(rim, -0.55));
      spokes(10, rr * 0.11, rim, 0.95);
      pen.circle(x, cy, rr * 0.2, rim);
      return;
    case "offroad":
      pen.ellipse(x, cy, rr, rr * sq, 0, rim);
      pen.circle(x, cy, rr * 0.32, shade(rim, -0.35));
      return;
  }
}

export function frontLight(pen: Pen, g: Side, car: CarLook, colour: string): [number, number] {
  const s = g.lowH / 136;
  const x = g.hl;
  const y = g.y(0.72);
  switch (car.lights.front) {
    case "square":
      pen.rect(x - 34 * s, y - 13 * s, 30 * s, 26 * s, 5, colour);
      return [x - 19 * s, y];
    case "slim":
      pen.rect(x - 46 * s, y - 7 * s, 44 * s, 14 * s, 7, colour);
      return [x - 24 * s, y];
    default:
      pen.ellipse(x - 20 * s, y, 16 * s, 14 * s, 0, colour);
      return [x - 20 * s, y];
  }
}

export function rearLight(pen: Pen, g: Side, car: CarLook, colour: string): [number, number] {
  const s = g.lowH / 136;
  const x = -g.hl;
  const y = g.y(0.72);
  switch (car.lights.rear) {
    case "round":
      pen.ellipse(x + 14 * s, y, 12 * s, 14 * s, 0, colour);
      return [x + 14 * s, y];
    case "square":
      pen.rect(x - 2, y - 11 * s, 20 * s, 22 * s, 4, colour);
      return [x + 8 * s, y];
    default:
      pen.rect(x - 2, y - g.lowH * 0.14, 14 * s, g.lowH * 0.28, 6, colour);
      return [x + 5 * s, y];
  }
}

export function extraSide(pen: Pen, g: Side, car: CarLook, ink: string): void {
  const spec = g.spec;
  const roofY = g.y(2);
  const r0 = g.X(spec.top[spec.ws[1]]![0]);
  const r1 = g.X(spec.top[spec.back[0]]![0]);
  if (car.extra === "roof_rack") {
    const a = r0 - 24;
    const b = r1 + 22;
    pen.line([a, roofY + 2, a + 6, roofY - 16, b - 6, roofY - 16, b, roofY + 2], 8, tone(TRIM));
  } else if (car.extra === "roof_box") {
    const w = (r0 - r1) * 0.72;
    const x = (r0 + r1) / 2 - w / 2 - 10;
    pen.rect(x - 6, roofY - 44, w + 12, 46, 20, ink);
    pen.rect(x, roofY - 38, w, 36, 16, tone("#454b58"));
  } else if (car.extra === "spoiler") {
    const x = g.X(spec.spoiler[0]);
    const y = g.y(spec.spoiler[1]);
    pen.line([x + 8, y + 2, x + 4, y - 20, x - 54, y - 26, x + 22, y - 22], 10, tone(shade(hex(car.paint), -0.35)));
  }
}

/** Side view car of the cast, facing +x before the facing mirror; origin on the ground between the wheels. */
export function drawCarLookSide(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  if (d.car.detail !== undefined) return drawCarLookSide2(pen, st, k, t, d, occ, night);
  if (nightDrive()) return drawCarLookSideND(pen, st, k, t, d, occ, night);
  const car = d.car;
  const g = carSide(car);
  const ms = styleOf(d.style);
  const ink = hex(car.outline, "#1c1842");
  const paint = hex(car.paint, "#d8352a");
  const accent = hex(car.accent, "#f4f1ea");
  const glass = GLASS[car.windows] ?? GLASS.clear;
  const face = faceOf(st, car);
  const moving = st.speed > 0.02 || st.rolled > 0;
  const bob = (moving ? Math.sin(t * TAU * 3.1) * 1.6 * ms.bob : 0) + (!moving && ms.sway ? Math.sin(t * TAU * 0.7) * ms.sway : 0);
  const lift = -st.bounce * 0.06 * g.tall;
  const dy = bob + lift;
  const spin = (st.rolled / g.wr) % TAU;
  const lit = st.lights || night || st.blink > 0.3;
  const beam = st.lights || night;
  const pulse = st.honkAge >= 0 ? 1 + 0.035 * Math.sin(Math.PI * Math.min(1, st.honkAge / 0.3)) : 1;
  const wob = ms.wobble ? ms.wobble * noise(d.seed + 17, t * 1.6) : 0;
  pen.save();
  pen.rotate(st.rot + wob);
  pen.scale(k * st.facing * st.spinX, k);
  // ground shadow, skid marks and skid smoke
  pen.ellipse(0, 4, g.hl + 8, 18, 0, "#000000", 0.18);
  if (st.skidFrom !== null) {
    const from = (st.skidFrom * st.facing) / k;
    for (const wx of [-g.ax, g.ax]) pen.line([wx + from, -2, wx, -2], 16, "#1d1d26", 0.4);
  }
  if (st.skidding > 0.05) {
    for (let i = 0; i < 4; i += 1) {
      const ph = (t * 1.6 + i / 4) % 1;
      pen.circle(-g.ax - 15 - ph * 160, -20 - ph * 40, 26 + ph * 30, "#e9eef5", 0.55 * st.skidding * (1 - ph));
    }
  }
  // the body moves on its springs; the wheels stay on the ground
  pen.save();
  pen.translate(0, dy + g.y(1));
  pen.scale(pulse, pulse);
  pen.translate(0, -g.y(1));
  pen.poly(outlined(g.sil, 8), ink);
  pen.poly(g.sil, paint);
  pen.rect(-g.hl + 6, g.y(0.46), 2 * g.hl - 12, g.sill - g.y(0.46) - 2, 22, shade(paint, -0.16));
  if (car.pattern === "two_tone") pen.poly(g.cabin, accent);
  else if (car.pattern === "stripe") pen.rect(-g.hl + 14, g.y(0.7), 2 * g.hl - 28, g.lowH * 0.13, 5, accent);
  else if (car.pattern === "racing_stripes") {
    const pts: number[] = [];
    for (const [fx, lv] of g.spec.top) pts.push(g.X(fx) * 0.97, g.y(lv) + 9);
    pen.line(pts, 10, accent);
  }
  if (g.spec.bed) pen.line([g.X(-0.25), g.y(1.02), g.X(-0.95), g.y(1.02)], 7, shade(paint, -0.4));
  const form = g.spec.form;
  if (form === "plane") pen.poly(wingSide(g), shade(paint, -0.22));
  else if (form === "bike") bikeSide(pen, g, paint, "#2b2b36", "#c9ccd2");
  else if (form === "boat") boatSide(pen, g, accent, shade(paint, -0.45), glass.glass, "#c9ccd2");
  // a bike's riders sit in the open: no glass
  const glazed = form !== "bike";
  if (glazed) {
    pen.poly(g.front, glass.glass);
    if (g.rear) pen.poly(g.rear, glass.glass);
  }
  occ.side?.(pen, g.seats);
  if (glazed) {
    pen.poly(g.front, glass.tint, glass.a);
    if (g.rear) pen.poly(g.rear, glass.tint, glass.a);
    // a glint near the window's front edge, clear of the faces
    pen.line([g.frontRight - 26, g.y(1.72), g.frontRight - 12, g.y(1.3)], 7, "#ffffff", car.windows === "clear" ? 0.55 : 0.3);
    if (g.spec.rear) pen.line([g.X(g.spec.pillar), g.y(1.02), g.X(g.spec.pillar), g.y(0.2)], 3, shade(paint, -0.28), 0.8);
  }
  if (!form) {
    pen.ellipse(g.ws(LV_B) - 6, g.y(1.12), 15, 11, 0, accent);
    extraSide(pen, g, car, ink);
  }
  // the grille (a smile or a frown with a grille mouth), bumpers and plain plates (a car's, a truck's, a bus's)
  const mouth = face && car.face.mouth === "grille" ? face.mouth : null;
  if (mouth === null) {
    if (!form) pen.rect(g.hl - 30, g.y(0.52), 26, g.lowH * 0.22, 8, GRILLE);
  }
  else if (mouth === "o" || mouth === "bigo") pen.ellipse(g.hl - 28, g.y(0.42), 18, 8 + 7 * clamp(face!.mouthOpen, 0.3, 1.3), 0, MOUTH_DARK);
  else {
    const c = MOUTH_CURVE[mouth] ?? 0;
    const yy = g.y(0.44);
    pen.line(quadPts(g.hl - 64, yy - c * 10, g.hl - 34, yy + c * 13, g.hl - 6, yy - c * 4, 8), g.lowH * 0.09, GRILLE);
  }
  if (!form) {
    pen.rect(g.hl - 34, g.y(0.3), 40, g.lowH * 0.18, 10, TRIM);
    pen.rect(-g.hl - 6, g.y(0.3), 40, g.lowH * 0.18, 10, TRIM);
    pen.rect(g.hl - 2, g.y(0.36), 9, g.lowH * 0.12, 3, PLATE);
    pen.rect(-g.hl - 7, g.y(0.36), 9, g.lowH * 0.12, 3, PLATE);
  }
  // lights
  const headEyes = face !== null && car.face.eyes === "headlights";
  const front: [number, number] = headEyes ? [g.hl - clamp(g.lowH * 0.2, 14, 34) * 1.45, g.y(0.7)] : frontLight(pen, g, car, lit ? "#fff3b0" : "#ffe08a");
  const back = rearLight(pen, g, car, st.braking > 0.1 ? "#ff2d2d" : "#b3262d");
  pen.restore();
  // wheel arches and wheels (a bike's in the open, a plane's small ones under it); a boat floats
  if (!form) {
    pen.ellipse(-g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, shade(paint, -0.45));
    pen.ellipse(g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, shade(paint, -0.45));
  }
  if (form === "boat") waterSide(pen, g, moving);
  else {
    const wr = form === "plane" ? g.wr * 0.5 : g.wr;
    wheelSide(pen, -g.ax, -wr, wr, spin, false, car, ink);
    wheelSide(pen, g.ax, -wr, wr, spin, st.flat, car, ink);
  }
  pen.save();
  pen.translate(0, dy);
  if (beam) pen.poly([front[0] + 10, front[1] - 6, g.hl + 540, front[1] - 90, g.hl + 540, front[1] + 130], "#fff3b0", 0.16);
  if (st.braking > 0.1) pen.circle(back[0], back[1], 40, "#ff3b30", 0.35 * st.braking);
  lightGlow(pen, front[0], front[1], st.blink, 1);
  if (face) {
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
    const iris = hex(car.face.color, "#1c1842");
    if (headEyes) {
      const rx = clamp(g.lowH * 0.2, 14, 34);
      const far = g.hl - rx * 0.55;
      carEye(pen, far, front[1] - rx * 0.35, rx * 0.72, rx * 0.8, face, closedBy, iris, ink, lit ? "#fffbe6" : "#ffffff", paint, t, -1);
      carEye(pen, front[0], front[1], rx, rx * 1.05, face, closedBy, iris, ink, lit ? "#fffbe6" : "#ffffff", paint, t, 1);
      carBrows(pen, [front[0], far], front[1], rx, rx * 1.05, face, ink);
    } else {
      const winH = g.y(LV_B) - g.y(LV_T);
      const rx = clamp(winH * 0.27, 11, 36);
      const cy = g.y((LV_B + LV_T) / 2);
      const x1 = g.frontRight - rx * 1.3;
      const x0 = Math.max(g.frontLeft + rx * 1.2, x1 - rx * 2.3);
      carEye(pen, x0, cy, rx, rx * 1.15, face, closedBy, iris, ink, "#ffffff", glass.glass, t, -1);
      carEye(pen, x1, cy, rx, rx * 1.15, face, closedBy, iris, ink, "#ffffff", glass.glass, t, 1);
      carBrows(pen, [x0, x1], cy, rx, rx * 1.15, face, ink);
    }
  }
  pen.restore();
  pen.restore();
  // effects in the car's world frame (not mirrored twice)
  const f = st.facing;
  burst(pen, f * g.ax * k, -g.wr * k, st.burstAge, k, 7, true);
  impact(pen, f * (g.hl + 8) * k, g.y(0.6) * k, st.bumpAge, k);
  honkWaves(pen, f * (g.hl + 16) * k, (g.y(0.7) + dy) * k, st.honkAge, k, f > 0 ? 0 : 180);
  exhaust(pen, -f * (g.hl + 12) * k, g.y(0.2) * k, st.puffAge, st.stallAge, k, -f * 0.9, -0.45);
  if (st.speed > 0.08 * ms.lines) {
    for (let i = 0; i < 3; i += 1) {
      const yy = lerp(g.y(1.5), g.y(0.5), i / 2) * k;
      const len = (120 + i * 40) * k * clamp01(st.speed * 2.5);
      const x0 = -f * (g.hl + 18) * k;
      pen.line([x0, yy, x0 - f * len, yy], 8 * k, "#ffffff", 0.55);
    }
  }
}

// ---- top view ----------------------------------------------------------------------------------------------------

export interface Top {
  spec: Spec;
  L: number;
  Wd: number;
  wsBase: number;
  wsTop: number;
  roofBack: number;
  backFoot: number;
}

export function carTop(car: CarLook): Top {
  const spec = BODIES[car.body] ?? BODIES.hatchback;
  const L = 350 * spec.len * clamp(car.length, 0.85, 1.15);
  const at = (i: number) => -spec.top[i]![0] * (L / 2);
  return { spec, L, Wd: 196 * spec.wide, wsBase: at(spec.ws[0]), wsTop: at(spec.ws[1]), roofBack: at(spec.back[0]), backFoot: at(spec.back[1]) };
}

/** Top-down car of the cast: nose up before its heading; origin at its centre. */
export function drawCarLookTop(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  if (d.car.detail !== undefined) return drawCarLookTop2(pen, st, k, t, d, occ, night);
  if (nightDrive()) return drawCarLookTopND(pen, st, k, t, d, occ, night);
  const car = d.car;
  const g = carTop(car);
  const { L, Wd } = g;
  // a bike, a plane or a boat carries no roof extras
  const extra = g.spec.form ? "none" : car.extra;
  const ms = styleOf(d.style);
  const ink = hex(car.outline, "#1c1842");
  const paint = hex(car.paint, "#d8352a");
  const accent = hex(car.accent, "#f4f1ea");
  const glass = GLASS[car.windows] ?? GLASS.clear;
  const face = faceOf(st, car);
  const lit = st.lights || night || st.blink > 0.3;
  const beam = st.lights || night;
  // skid marks first (world frame, under the car)
  for (const m of st.marks) {
    if (m.length < 8) continue;
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i + 3 < m.length; i += 4) {
      left.push(m[i]! - st.x * F.w, m[i + 1]! - st.y * F.h);
      right.push(m[i + 2]! - st.x * F.w, m[i + 3]! - st.y * F.h);
    }
    pen.line(left, 20 * k, "#1d1d26", 0.42);
    pen.line(right, 20 * k, "#1d1d26", 0.42);
  }
  const wob = ms.wobble ? ms.wobble * noise(d.seed + 17, t * 1.6) : 0;
  const grow = (1 + st.bounce * 0.04) * (st.honkAge >= 0 ? 1 + 0.03 * Math.sin(Math.PI * Math.min(1, st.honkAge / 0.3)) : 1);
  pen.save();
  pen.rotate(st.rot + wob);
  pen.scale(k, k);
  if (st.speed > 0.06 * ms.lines) {
    for (let i = -1; i <= 1; i += 1) {
      const len = 160 * clamp01(st.speed * 2.5);
      pen.line([i * 60, L / 2 + 40, i * 60, L / 2 + 40 + len], 10, "#ffffff", 0.5);
    }
  }
  if (beam) pen.poly([-70, -L / 2, 70, -L / 2, 200, -L / 2 - 520, -200, -L / 2 - 520], "#fff3b0", 0.18);
  if (g.spec.form === "boat") wakeTop(pen, L, Wd);
  pen.ellipse(10, 14, Wd / 2 + 16, L / 2 + 10, 0, "#000000", 0.2);
  // wheels peek out at the corners; the front pair turns with the steering
  const wy = (L / 2) * g.spec.axle * 0.94;
  const ww = (car.wheels.style === "offroad" ? 42 : 34) * car.wheels.size;
  const wl = 72 * car.wheels.size;
  for (const [wx, wyy, front] of topWheels(g.spec, Wd, wy)) {
    pen.save();
    pen.translate(wx, wyy);
    if (front) pen.rotate(clamp(st.wheelTurn, -40, 40));
    pen.rect(-ww / 2, -wl / 2, ww, wl, 10, st.flat && front && wx > 0 ? "#55556a" : "#24242e");
    pen.restore();
  }
  pen.scale(grow, grow);
  if (g.spec.form === "plane") wingsTop(pen, L, Wd, shade(paint, -0.22));
  const shape = topShape(g.spec, L, Wd);
  pen.poly(outlined(shape, 8), ink);
  pen.poly(shape, paint);
  formTop(pen, g.spec, L, Wd, shade(paint, -0.45), "#c9ccd2");
  if (car.pattern === "racing_stripes") {
    for (const s of [-1, 1]) pen.line([s * Wd * 0.12, -L / 2 + 12, s * Wd * 0.12, L / 2 - 12], Wd * 0.1, accent);
  } else pen.line([0, -L / 2 + 14, 0, g.wsBase - 10], 18, shade(paint, 0.3), 0.7);
  pen.ellipse(-Wd / 2 - 6, g.wsBase + 18, 12, 18, 0, accent);
  pen.ellipse(Wd / 2 + 6, g.wsBase + 18, 12, 18, 0, accent);
  pen.poly([-0.33 * Wd, g.wsBase, 0.33 * Wd, g.wsBase, 0.4 * Wd, g.wsTop, -0.4 * Wd, g.wsTop], glass.glass);
  if (car.pattern === "two_tone") pen.rect(-0.43 * Wd, g.wsTop - 2, 0.86 * Wd, g.roofBack - g.wsTop + 4, 30, accent);
  pen.rect(-0.38 * Wd, g.wsTop + 4, 0.76 * Wd, g.roofBack - g.wsTop - 8, 34, glass.roof);
  const r0 = g.wsTop + 4;
  const r1 = g.roofBack - 4;
  occ.top?.(
    pen,
    g.spec.bed
      ? [
          { x: -0.2 * Wd, y: (r0 + r1) / 2, r: 30 },
          { x: 0.2 * Wd, y: (r0 + r1) / 2, r: 28 },
        ]
      : [
          { x: 0, y: lerp(r0, r1, 0.28), r: 34 },
          { x: 0, y: lerp(r0, r1, 0.76), r: 30 },
        ],
  );
  pen.rect(-0.38 * Wd, g.wsTop + 4, 0.76 * Wd, g.roofBack - g.wsTop - 8, 34, glass.tint, car.windows === "clear" ? 0.12 : glass.a);
  pen.line([-0.24 * Wd, r0 + 14, -0.14 * Wd, Math.min(r1 - 10, r0 + 130)], 8, "#ffffff", 0.3);
  if (g.spec.bed) pen.rect(-Wd / 2 + 14, g.backFoot + 10, Wd - 28, L / 2 - 16 - (g.backFoot + 10), 10, shade(paint, -0.38));
  else if (g.backFoot - g.roofBack > 14) pen.poly([-0.36 * Wd, g.roofBack + 4, 0.36 * Wd, g.roofBack + 4, 0.3 * Wd, g.backFoot, -0.3 * Wd, g.backFoot], glass.glass);
  if (extra === "roof_rack") {
    for (const p of [0.22, 0.78]) pen.line([-0.44 * Wd, lerp(r0, r1, p), 0.44 * Wd, lerp(r0, r1, p)], 9, TRIM);
  } else if (extra === "roof_box") {
    const y0 = lerp(r0, r1, 0.45);
    pen.rect(-0.3 * Wd - 6, y0 - 6, 0.6 * Wd + 12, r1 - y0 + 6, 20, ink);
    pen.rect(-0.3 * Wd, y0, 0.6 * Wd, r1 - y0 - 6, 16, "#454b58");
  } else if (extra === "spoiler") pen.rect(-Wd / 2 - 6, L / 2 - 34, Wd + 12, 16, 7, shade(paint, -0.35));
  // lights and plain plates
  const head = lit ? "#fff3b0" : "#ffe08a";
  for (const s of [-1, 1]) {
    const x = s * 0.32 * Wd;
    if (car.lights.front === "round") pen.ellipse(x, -L / 2 + 14, 20, 12, 0, head);
    else if (car.lights.front === "square") pen.rect(x - 18, -L / 2 + 6, 36, 18, 5, head);
    else pen.rect(x - 26, -L / 2 + 8, 52, 10, 5, head);
  }
  const tail = st.braking > 0.1 ? "#ff2d2d" : "#b3262d";
  if (car.lights.rear === "bar") pen.rect(-0.43 * Wd, L / 2 - 16, 0.86 * Wd, 12, 5, tail);
  else {
    for (const s of [-1, 1]) {
      if (car.lights.rear === "round") pen.circle(s * 0.33 * Wd, L / 2 - 12, 10, tail);
      else pen.rect(s * 0.33 * Wd - 18, L / 2 - 16, 36, 12, 5, tail);
    }
  }
  if (st.braking > 0.1) {
    pen.circle(-0.33 * Wd, L / 2 - 6, 40, "#ff3b30", 0.32 * st.braking);
    pen.circle(0.33 * Wd, L / 2 - 6, 40, "#ff3b30", 0.32 * st.braking);
  }
  lightGlow(pen, -0.32 * Wd, -L / 2 + 14, st.blink, 0.8);
  lightGlow(pen, 0.32 * Wd, -L / 2 + 14, st.blink, 0.8);
  if (!g.spec.form) {
    pen.rect(-26, -L / 2 - 4, 52, 8, 3, PLATE);
    pen.rect(-26, L / 2 - 4, 52, 8, 3, PLATE);
  }
  // the top view shows the windscreen eyes only, small
  if (face && car.face.eyes === "windscreen") {
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
    const cy = (g.wsBase + g.wsTop) / 2;
    const rx = clamp(Math.abs(g.wsTop - g.wsBase) * 0.26, 9, 20);
    const iris = hex(car.face.color, "#1c1842");
    const top: FaceParams = { ...face, lookX: 0, lookY: -0.6 };
    for (const s of [-1, 1]) topEye(pen, s * 0.17 * Wd, cy, rx, top, closedBy, iris, ink);
  }
  honkWaves(pen, 0, -L / 2 - 18, st.honkAge, 1, -90);
  exhaust(pen, 0, L / 2 + 18, st.puffAge, st.stallAge, 1, 0, 1);
  pen.restore();
  // effects at the front-right wheel (burst) and the nose (bump), in the car's heading
  const h = st.rot * DEG;
  const at = (lx: number, ly: number): [number, number] => [(lx * Math.cos(h) - ly * Math.sin(h)) * k, (lx * Math.sin(h) + ly * Math.cos(h)) * k];
  const [bx, by] = at(Wd / 2, -wy);
  burst(pen, bx, by, st.burstAge, k, 9, false);
  const [ix, iy] = at(0, -L / 2 - 20);
  impact(pen, ix, iy, st.bumpAge, k);
}

/** A small eye seen from above on the windscreen: a white and a pupil, or an arc. */
export function topEye(pen: Pen, x: number, y: number, r: number, f: FaceParams, closedBy: number, iris: string, ink: string, white = "#ffffff"): void {
  const open = f.open * (1 - closedBy);
  if (f.eyes === "happy" || f.eyes === "closed" || open < 0.16) {
    pen.line(arcPts(x, y, r, r * 0.6, f.eyes === "happy" ? 200 : 20, f.eyes === "happy" ? 340 : 160, 6), Math.max(2, r * 0.3), ink);
    return;
  }
  pen.ellipse(x, y, r, r * Math.min(1.3, open), 0, white);
  pen.circle(x, y - r * 0.3 * Math.min(1, open), r * 0.5 * f.pupil, iris);
}

// ---- night drive (§45.45 §6): the same shapes, drawn softer, lit and in more detail ----------------------------

/** A wheel in night drive: the tyre (its own dark edge is the outline), a sidewall ring, the rim in its own style and
 * colour (graded) and an inner rim shadow under the arch. */
export function wheelSideND(pen: Pen, x: number, y: number, r: number, spin: number, flat: boolean, car: CarLook, ow: number): void {
  const style = car.wheels.style;
  const rim = grade(hex(car.wheels.rim, "#c9ccd2"));
  const sq = flat ? 0.72 : 1;
  const cy = flat ? y + r * (1 - sq) : y;
  if (style === "offroad") {
    const pts: number[] = [];
    for (let i = 0; i < 28; i += 1) {
      const a = spin + (i / 28) * TAU;
      const rr = (i % 2 === 0 ? r : r * 0.9) + ow;
      pts.push(x + Math.cos(a) * rr, cy + Math.sin(a) * rr * sq);
    }
    pen.poly(pts, TYRE_ND);
  } else pen.ellipse(x, cy, r + ow, r * sq + ow, 0, TYRE_ND);
  pen.ellipse(x, cy, r * 0.8, r * 0.8 * sq, 0, SIDEWALL_ND);
  const rr = r * (style === "offroad" ? 0.48 : style === "sport" ? 0.66 : 0.58);
  const spokes = (n: number, w: number, colour: string, len: number) => {
    const pts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const a = spin + (i / n) * TAU;
      pts.push(x, cy, x + Math.cos(a) * rr * len, cy + Math.sin(a) * rr * len * sq);
    }
    pen.line(pts, w, colour);
  };
  switch (style) {
    case "steel": {
      pen.ellipse(x, cy, rr, rr * sq, 0, grade("#9aa3af"));
      for (let i = 0; i < 4; i += 1) {
        const a = spin + (i / 4) * TAU;
        pen.circle(x + Math.cos(a) * rr * 0.55, cy + Math.sin(a) * rr * 0.55 * sq, rr * 0.13, grade("#4a505c"));
      }
      break;
    }
    case "hubcap":
      pen.ellipse(x, cy, rr, rr * sq, 0, rim);
      pen.line(arcPts(x, cy, rr * 0.68, rr * 0.68 * sq, 0, 360, 20), rr * 0.1, cel(rim, 0.35));
      pen.circle(x, cy, rr * 0.2, cel(rim, 0.18));
      break;
    case "alloy":
      pen.ellipse(x, cy, rr, rr * sq, 0, cel(rim, 0.55));
      spokes(5, rr * 0.26, rim, 0.92);
      pen.circle(x, cy, rr * 0.24, rim);
      break;
    case "sport":
      pen.ellipse(x, cy, rr, rr * sq, 0, cel(rim, 0.62));
      spokes(10, rr * 0.11, rim, 0.95);
      pen.circle(x, cy, rr * 0.2, rim);
      break;
    case "offroad":
      pen.ellipse(x, cy, rr, rr * sq, 0, rim);
      pen.circle(x, cy, rr * 0.32, cel(rim, 0.4));
      break;
  }
  pen.line(arcPts(x, cy, rr * 0.86, rr * 0.86 * sq, 200, 340, 6), rr * 0.16, ND.ao, 0.35);
}

/** The night drive side view of a car of the cast: the same body, seats and moves as drawCarLookSide. */
function drawCarLookSideND(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  const car = d.car;
  const g = carSide(car);
  const ms = styleOf(d.style);
  const light = F.light;
  const inkC = ink(hex(car.outline, "#1c1842"));
  const paint = grade(hex(car.paint, "#d8352a"));
  const accent = grade(hex(car.accent, "#f4f1ea"));
  const glass = grade(GLASS_ND[car.windows] ?? GLASS_ND.clear);
  const tintA = (GLASS[car.windows] ?? GLASS.clear).a;
  const face = faceOf(st, car);
  const moving = st.speed > 0.02 || st.rolled > 0;
  const bob = (moving ? Math.sin(t * TAU * 3.1) * 1.6 * ms.bob : 0) + (!moving && ms.sway ? Math.sin(t * TAU * 0.7) * ms.sway : 0);
  const dy = bob - st.bounce * 0.06 * g.tall;
  const spin = (st.rolled / g.wr) % TAU;
  const dark = night || light.night;
  const lit = st.lights || dark || st.blink > 0.3;
  const beam = st.lights || night;
  const tailOn = st.lights || dark;
  const braking = st.braking > 0.1;
  const pulse = st.honkAge >= 0 ? 1 + 0.035 * Math.sin(Math.PI * Math.min(1, st.honkAge / 0.3)) : 1;
  const wob = ms.wobble ? ms.wobble * noise(d.seed + 17, t * 1.6) : 0;
  pen.save();
  pen.rotate(st.rot + wob);
  // the line weights in the car's own px, taken before the facing mirror, so a spin's squeeze never thickens them
  const ow = lineUnits(pen, 2.6) / k;
  const fine = ow * 0.35;
  pen.scale(k * st.facing * st.spinX, k);
  // the headlights' beam, under the car's shadow and body so it never lights its own car
  const headEyes = face !== null && car.face.eyes === "headlights";
  if (beam) {
    const [lx, ly] = headEyes ? [g.hl - clamp(g.lowH * 0.2, 14, 34) * 1.45, g.y(0.7)] : frontLightAt(g, car);
    beamGlow(pen, lx, ly + dy, g.hl + 540 - lx, 100, night ? 0.08 : 0.05);
  }
  // soft shadows under the car (ambient occlusion), skid marks and skid smoke
  pen.ellipse(0, 7, g.hl + 30, 22, 0, ND.ao, 0.16);
  pen.ellipse(0, 3, g.hl - 10, 10, 0, ND.ao, 0.38);
  if (st.skidFrom !== null) {
    const from = (st.skidFrom * st.facing) / k;
    for (const wx of [-g.ax, g.ax]) pen.line([wx + from, -2, wx, -2], 16, grade("#1d1d26"), 0.4);
  }
  if (st.skidding > 0.05) {
    for (let i = 0; i < 4; i += 1) {
      const ph = (t * 1.6 + i / 4) % 1;
      pen.circle(-g.ax - 15 - ph * 160, -20 - ph * 40, 26 + ph * 30, grade("#e9eef5"), 0.55 * st.skidding * (1 - ph));
    }
  }
  // the body moves on its springs; the wheels stay on the ground
  pen.save();
  pen.translate(0, dy + g.y(1));
  pen.scale(pulse, pulse);
  pen.translate(0, -g.y(1));
  pen.poly(outlined(g.sil, ow), inkC);
  pen.poly(g.sil, paint);
  // three tones: the lower body in the cel shadow, the body, and a lit top along the bonnet and the roof line
  const low = g.y(0.42);
  const far = g.hl * 2 + 200;
  pen.poly(clipConvex(g.sil, [-far, low, far, low, far, 400, -far, 400]), cel(paint));
  if (car.pattern === "two_tone") pen.poly(g.cabin, accent);
  else if (car.pattern === "stripe") pen.rect(-g.hl + 14, g.y(0.7), 2 * g.hl - 28, g.lowH * 0.13, 5, accent);
  else if (car.pattern === "racing_stripes") {
    const pts: number[] = [];
    for (const [fx, lv] of g.spec.top) pts.push(g.X(fx) * 0.97, g.y(lv) + 9);
    pen.line(pts, 10, accent);
  }
  if (g.spec.bed) pen.line([g.X(-0.25), g.y(1.02), g.X(-0.95), g.y(1.02)], 7, cel(paint, 0.4));
  const form = g.spec.form;
  const topLine: number[] = [];
  for (const [fx, lv] of g.spec.top) topLine.push(g.X(fx) * 0.98, g.y(lv) + ow * 2);
  pen.line(topLine, ow * 2.2, lift(car.pattern === "two_tone" ? accent : paint, 0.16), 0.8);
  if (form === "plane") pen.poly(wingSide(g), cel(paint, 0.3));
  else if (form === "bike") bikeSide(pen, g, paint, tone("#2b2b36"), tone("#c9ccd2"));
  else if (form === "boat") boatSide(pen, g, accent, cel(paint, 0.5), glass, tone("#c9ccd2"));
  // a bike's riders sit in the open: no glass
  const glazed = form !== "bike";
  if (glazed) {
    pen.poly(g.front, glass);
    if (g.rear) pen.poly(g.rear, glass);
  }
  occ.side?.(pen, g.seats);
  if (glazed) {
    pen.poly(g.front, glass, tintA);
    if (g.rear) pen.poly(g.rear, glass, tintA);
    // two reflection bands in the window's low front corner, clear of the faces
    const edge = (lv: number) => g.ws(lv) - INSET;
    const band = (i0: number, i1: number): number[] => [edge(1.4) - i0, g.y(1.4), edge(1.4) - i1, g.y(1.4), edge(1) - i1 - 12, g.y(1), edge(1) - i0 - 12, g.y(1)];
    pen.poly(clipConvex(band(4, 22), g.front), "#ffffff", 0.12);
    pen.poly(clipConvex(band(30, 38), g.front), "#ffffff", 0.07);
  }
  if (!form) {
    // door lines (the front door's front edge, the B pillar), handles, the mirror on its stalk and the side marker
    const pillar = g.X(g.spec.pillar);
    const doorFront = Math.min(g.ws(LV_B) - 8, g.ax - g.wr * 1.37 + 4);
    pen.line([doorFront, g.y(1.02), doorFront, g.y(0.16)], fine, inkC, 0.8);
    pen.line([pillar, g.y(1.02), pillar, g.y(0.16)], fine, inkC, 0.8);
    const handleY = g.y(0.86) - 2.5;
    pen.rect(pillar + 8, handleY, 18, 5, 2.5, cel(paint, 0.3));
    if (g.spec.rear) pen.rect(Math.min(pillar - 44, -g.ax + g.wr * 1.37 + 10), handleY, 18, 5, 2.5, cel(paint, 0.3));
    const mx = g.ws(LV_B) - 6;
    const my = g.y(1.12);
    pen.line([mx - 14, g.y(1.0), mx - 4, my + 4], 5, tone(TRIM));
    pen.ellipse(mx, my, 15 + ow, 11 + ow, 0, inkC);
    pen.ellipse(mx, my, 15, 11, 0, accent);
  }
  pen.rect(g.hl - 44, g.y(0.56) - 4, 14, 8, 3, ND.marker);
  // rim light from the street lamps along the roof line and the rear pillar
  const rim: number[] = [];
  for (let i = g.spec.ws[1]; i <= g.spec.back[1]; i += 1) rim.push(g.X(g.spec.top[i]![0]) * 0.99, g.y(g.spec.top[i]![1]) + ow * 0.7);
  pen.line(rim, ow, light.rim, light.rimA);
  if (!form) extraSide(pen, g, car, inkC);
  // the grille (a smile or a frown with a grille mouth), bumpers and plain plates (a car's, a truck's, a bus's)
  const mouth = face && car.face.mouth === "grille" ? face.mouth : null;
  if (mouth === null) {
    if (!form) pen.rect(g.hl - 30, g.y(0.52), 26, g.lowH * 0.22, 8, tone(GRILLE));
  }
  else if (mouth === "o" || mouth === "bigo") pen.ellipse(g.hl - 28, g.y(0.42), 18, 8 + 7 * clamp(face!.mouthOpen, 0.3, 1.3), 0, tone(MOUTH_DARK));
  else {
    const c = MOUTH_CURVE[mouth] ?? 0;
    const yy = g.y(0.44);
    pen.line(quadPts(g.hl - 64, yy - c * 10, g.hl - 34, yy + c * 13, g.hl - 6, yy - c * 4, 8), g.lowH * 0.09, tone(GRILLE));
  }
  if (!form) {
    pen.rect(g.hl - 34, g.y(0.3), 40, g.lowH * 0.18, 10, tone(TRIM));
    pen.rect(-g.hl - 6, g.y(0.3), 40, g.lowH * 0.18, 10, tone(TRIM));
    pen.rect(g.hl - 2, g.y(0.36), 9, g.lowH * 0.12, 3, tone(PLATE));
    pen.rect(-g.hl - 7, g.y(0.36), 9, g.lowH * 0.12, 3, tone(PLATE));
  }
  // lights: the lenses glow when they are on
  const front: [number, number] = headEyes ? [g.hl - clamp(g.lowH * 0.2, 14, 34) * 1.45, g.y(0.7)] : frontLight(pen, g, car, lit ? ND.headCore : grade(LENS_OFF));
  const back = rearLight(pen, g, car, braking ? ND.brakeCore : tailOn ? ND.tailCore : grade(TAIL_OFF));
  pen.restore();
  // wheel arches and wheels
  if (!form) {
    const arch = mix(paint, ND.ao, 0.6);
    pen.ellipse(-g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, arch);
    pen.ellipse(g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, arch);
  }
  if (form === "boat") waterSide(pen, g, moving);
  else {
    const wr = form === "plane" ? g.wr * 0.5 : g.wr;
    wheelSideND(pen, -g.ax, -wr, wr, spin, false, car, ow);
    wheelSideND(pen, g.ax, -wr, wr, spin, st.flat, car, ow);
  }
  pen.save();
  pen.translate(0, dy);
  const s = g.lowH / 136;
  if (lit) bloom(pen, front[0], front[1], (car.lights.front === "slim" ? 11 : 15) * s, (dark ? 1 : 0.5) * (headEyes ? 0.6 : 1));
  const tailA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * st.braking : 0);
  if (tailA > 0) tailGlow(pen, back[0], back[1], 13 * s, tailA);
  lightGlow(pen, front[0], front[1], st.blink, 1);
  if (face) {
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
    const iris = grade(hex(car.face.color, "#1c1842"));
    const white = grade("#ffffff");
    if (headEyes) {
      const rx = clamp(g.lowH * 0.2, 14, 34);
      const far2 = g.hl - rx * 0.55;
      const lens = lit ? ND.headCore : white;
      carEye(pen, far2, front[1] - rx * 0.35, rx * 0.72, rx * 0.8, face, closedBy, iris, inkC, lens, paint, t, -1, ND.glint);
      carEye(pen, front[0], front[1], rx, rx * 1.05, face, closedBy, iris, inkC, lens, paint, t, 1, ND.glint);
      carBrows(pen, [front[0], far2], front[1], rx, rx * 1.05, face, inkC);
    } else {
      const winH = g.y(LV_B) - g.y(LV_T);
      const rx = clamp(winH * 0.27, 11, 36);
      const cy = g.y((LV_B + LV_T) / 2);
      const x1 = g.frontRight - rx * 1.3;
      const x0 = Math.max(g.frontLeft + rx * 1.2, x1 - rx * 2.3);
      carEye(pen, x0, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, -1, ND.glint);
      carEye(pen, x1, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, 1, ND.glint);
      carBrows(pen, [x0, x1], cy, rx, rx * 1.15, face, inkC);
    }
  }
  pen.restore();
  pen.restore();
  // effects in the car's world frame (not mirrored twice)
  const f = st.facing;
  burst(pen, f * g.ax * k, -g.wr * k, st.burstAge, k, 7, true);
  impact(pen, f * (g.hl + 8) * k, g.y(0.6) * k, st.bumpAge, k);
  honkWaves(pen, f * (g.hl + 16) * k, (g.y(0.7) + dy) * k, st.honkAge, k, f > 0 ? 0 : 180);
  exhaust(pen, -f * (g.hl + 12) * k, g.y(0.2) * k, st.puffAge, st.stallAge, k, -f * 0.9, -0.45);
  if (st.speed > 0.08 * ms.lines) {
    const streak = grade("#ffffff");
    for (let i = 0; i < 3; i += 1) {
      const yy = lerp(g.y(1.5), g.y(0.5), i / 2) * k;
      const len = (120 + i * 40) * k * clamp01(st.speed * 2.5);
      const x0 = -f * (g.hl + 18) * k;
      pen.line([x0, yy, x0 - f * len, yy], 8 * k, streak, 0.55);
    }
  }
}

/** The night drive top view of a car of the cast: the same body, seats and moves as drawCarLookTop. */
function drawCarLookTopND(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  const car = d.car;
  const g = carTop(car);
  const { L, Wd } = g;
  // a bike, a plane or a boat carries no roof extras
  const extra = g.spec.form ? "none" : car.extra;
  const ms = styleOf(d.style);
  const light = F.light;
  const inkC = ink(hex(car.outline, "#1c1842"));
  const paint = grade(hex(car.paint, "#d8352a"));
  const accent = grade(hex(car.accent, "#f4f1ea"));
  const glass = grade(GLASS_ND[car.windows] ?? GLASS_ND.clear);
  const tintA = (GLASS[car.windows] ?? GLASS.clear).a;
  const face = faceOf(st, car);
  const dark = night || light.night;
  const lit = st.lights || dark || st.blink > 0.3;
  const beam = st.lights || night;
  const tailOn = st.lights || dark;
  const braking = st.braking > 0.1;
  const mark = grade("#1d1d26");
  for (const m of st.marks) {
    if (m.length < 8) continue;
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i + 3 < m.length; i += 4) {
      left.push(m[i]! - st.x * F.w, m[i + 1]! - st.y * F.h);
      right.push(m[i + 2]! - st.x * F.w, m[i + 3]! - st.y * F.h);
    }
    pen.line(left, 20 * k, mark, 0.42);
    pen.line(right, 20 * k, mark, 0.42);
  }
  const wob = ms.wobble ? ms.wobble * noise(d.seed + 17, t * 1.6) : 0;
  const grow = (1 + st.bounce * 0.04) * (st.honkAge >= 0 ? 1 + 0.03 * Math.sin(Math.PI * Math.min(1, st.honkAge / 0.3)) : 1);
  pen.save();
  pen.rotate(st.rot + wob);
  const ow = lineUnits(pen, 2.6) / k;
  pen.scale(k, k);
  if (st.speed > 0.06 * ms.lines) {
    const streak = grade("#ffffff");
    for (let i = -1; i <= 1; i += 1) {
      const len = 160 * clamp01(st.speed * 2.5);
      pen.line([i * 60, L / 2 + 40, i * 60, L / 2 + 40 + len], 10, streak, 0.5);
    }
  }
  if (beam) beamGlow(pen, 0, -L / 2, 520, 230, night ? 0.08 : 0.05, true);
  if (g.spec.form === "boat") wakeTop(pen, L, Wd);
  pen.ellipse(8, 12, Wd / 2 + 30, L / 2 + 24, 0, ND.ao, 0.16);
  pen.ellipse(4, 6, Wd / 2 + 4, L / 2 + 2, 0, ND.ao, 0.38);
  const wy = (L / 2) * g.spec.axle * 0.94;
  const ww = (car.wheels.style === "offroad" ? 42 : 34) * car.wheels.size;
  const wl = 72 * car.wheels.size;
  for (const [wx, wyy, front] of topWheels(g.spec, Wd, wy)) {
    pen.save();
    pen.translate(wx, wyy);
    if (front) pen.rotate(clamp(st.wheelTurn, -40, 40));
    pen.rect(-ww / 2, -wl / 2, ww, wl, 10, st.flat && front && wx > 0 ? grade("#55556a") : TYRE_ND);
    pen.restore();
  }
  pen.scale(grow, grow);
  if (g.spec.form === "plane") wingsTop(pen, L, Wd, cel(paint, 0.3));
  const shape = topShape(g.spec, L, Wd);
  pen.poly(outlined(shape, ow), inkC);
  pen.poly(shape, paint);
  formTop(pen, g.spec, L, Wd, cel(paint, 0.5), tone("#c9ccd2"));
  // the side away from the lamps in the cel shadow, a lit line down the bonnet
  pen.poly(clipConvex(shape, [Wd * 0.22, -L, Wd, -L, Wd, L, Wd * 0.22, L]), cel(paint));
  if (car.pattern === "racing_stripes") {
    for (const s of [-1, 1]) pen.line([s * Wd * 0.12, -L / 2 + 12, s * Wd * 0.12, L / 2 - 12], Wd * 0.1, accent);
  } else pen.line([0, -L / 2 + 14, 0, g.wsBase - 10], 18, lift(paint, 0.2), 0.8);
  pen.ellipse(-Wd / 2 - 6, g.wsBase + 18, 12, 18, 0, accent);
  pen.ellipse(Wd / 2 + 6, g.wsBase + 18, 12, 18, 0, accent);
  pen.poly([-0.33 * Wd, g.wsBase, 0.33 * Wd, g.wsBase, 0.4 * Wd, g.wsTop, -0.4 * Wd, g.wsTop], glass);
  if (car.pattern === "two_tone") pen.rect(-0.43 * Wd, g.wsTop - 2, 0.86 * Wd, g.roofBack - g.wsTop + 4, 30, accent);
  pen.rect(-0.38 * Wd, g.wsTop + 4, 0.76 * Wd, g.roofBack - g.wsTop - 8, 34, mix(glass, ND.celDark, 0.45));
  const r0 = g.wsTop + 4;
  const r1 = g.roofBack - 4;
  occ.top?.(
    pen,
    g.spec.bed
      ? [
          { x: -0.2 * Wd, y: (r0 + r1) / 2, r: 30 },
          { x: 0.2 * Wd, y: (r0 + r1) / 2, r: 28 },
        ]
      : [
          { x: 0, y: lerp(r0, r1, 0.28), r: 34 },
          { x: 0, y: lerp(r0, r1, 0.76), r: 30 },
        ],
  );
  pen.rect(-0.38 * Wd, g.wsTop + 4, 0.76 * Wd, g.roofBack - g.wsTop - 8, 34, glass, car.windows === "clear" ? 0.12 : tintA);
  pen.line([-0.24 * Wd, r0 + 14, -0.14 * Wd, Math.min(r1 - 10, r0 + 130)], 8, "#ffffff", 0.12);
  pen.line([0.2 * Wd, r0 + 30, 0.26 * Wd, Math.min(r1 - 10, r0 + 90)], 5, "#ffffff", 0.07);
  // rim light along the lit side of the roof
  pen.line([-0.38 * Wd + ow, r0 + 18, -0.38 * Wd + ow, r1 - 18], ow, light.rim, light.rimA);
  if (g.spec.bed) pen.rect(-Wd / 2 + 14, g.backFoot + 10, Wd - 28, L / 2 - 16 - (g.backFoot + 10), 10, cel(paint, 0.4));
  else if (g.backFoot - g.roofBack > 14) pen.poly([-0.36 * Wd, g.roofBack + 4, 0.36 * Wd, g.roofBack + 4, 0.3 * Wd, g.backFoot, -0.3 * Wd, g.backFoot], glass);
  if (extra === "roof_rack") {
    for (const p of [0.22, 0.78]) pen.line([-0.44 * Wd, lerp(r0, r1, p), 0.44 * Wd, lerp(r0, r1, p)], 9, tone(TRIM));
  } else if (extra === "roof_box") {
    const y0 = lerp(r0, r1, 0.45);
    pen.rect(-0.3 * Wd - ow, y0 - ow, 0.6 * Wd + 2 * ow, r1 - y0 - 6 + 2 * ow, 16 + ow, inkC);
    pen.rect(-0.3 * Wd, y0, 0.6 * Wd, r1 - y0 - 6, 16, tone("#454b58"));
  } else if (extra === "spoiler") pen.rect(-Wd / 2 - 6, L / 2 - 34, Wd + 12, 16, 7, cel(paint, 0.35));
  // lights (glowing when on) and plain plates
  const head = lit ? ND.headCore : grade(LENS_OFF);
  for (const s of [-1, 1]) {
    const x = s * 0.32 * Wd;
    if (car.lights.front === "round") pen.ellipse(x, -L / 2 + 14, 20, 12, 0, head);
    else if (car.lights.front === "square") pen.rect(x - 18, -L / 2 + 6, 36, 18, 5, head);
    else pen.rect(x - 26, -L / 2 + 8, 52, 10, 5, head);
    if (lit) pen.glow(x, -L / 2 + 14, 45, 45, ND.headBloom, haloStops(1, 0.3, 1.6), dark ? 0.5 : 0.25);
  }
  const tail = braking ? ND.brakeCore : tailOn ? ND.tailCore : grade(TAIL_OFF);
  if (car.lights.rear === "bar") pen.rect(-0.43 * Wd, L / 2 - 16, 0.86 * Wd, 12, 5, tail);
  else {
    for (const s of [-1, 1]) {
      if (car.lights.rear === "round") pen.circle(s * 0.33 * Wd, L / 2 - 12, 10, tail);
      else pen.rect(s * 0.33 * Wd - 18, L / 2 - 16, 36, 12, 5, tail);
    }
  }
  const tailA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * st.braking : 0);
  if (tailA > 0) for (const s of [-1, 1]) pen.glow(s * 0.33 * Wd, L / 2 - 8, 54, 54, ND.tailGlow, haloStops(1, 0.3, 1.6), Math.min(1, tailA * 1.5));
  lightGlow(pen, -0.32 * Wd, -L / 2 + 14, st.blink, 0.8);
  lightGlow(pen, 0.32 * Wd, -L / 2 + 14, st.blink, 0.8);
  if (!g.spec.form) {
    pen.rect(-26, -L / 2 - 4, 52, 8, 3, tone(PLATE));
    pen.rect(-26, L / 2 - 4, 52, 8, 3, tone(PLATE));
  }
  if (face && car.face.eyes === "windscreen") {
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
    const cy = (g.wsBase + g.wsTop) / 2;
    const rx = clamp(Math.abs(g.wsTop - g.wsBase) * 0.26, 9, 20);
    const iris = grade(hex(car.face.color, "#1c1842"));
    const top: FaceParams = { ...face, lookX: 0, lookY: -0.6 };
    for (const s of [-1, 1]) topEye(pen, s * 0.17 * Wd, cy, rx, top, closedBy, iris, inkC, grade("#ffffff"));
  }
  honkWaves(pen, 0, -L / 2 - 18, st.honkAge, 1, -90);
  exhaust(pen, 0, L / 2 + 18, st.puffAge, st.stallAge, 1, 0, 1);
  pen.restore();
  const h = st.rot * DEG;
  const at = (lx: number, ly: number): [number, number] => [(lx * Math.cos(h) - ly * Math.sin(h)) * k, (lx * Math.sin(h) + ly * Math.cos(h)) * k];
  const [bx, by] = at(Wd / 2, -wy);
  burst(pen, bx, by, st.burstAge, k, 9, false);
  const [ix, iy] = at(0, -L / 2 - 20);
  impact(pen, ix, iy, st.bumpAge, k);
}
