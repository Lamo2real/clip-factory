// Clips Funded engine: a car character of the cast (CONTRACTS §45.42, ADR-91). A car of the cast is a car prop whose
// `castId` names it: it is drawn from its own CarLook, in the side and the top view, in the same frame as the plain
// car of props.ts (origin on the ground at its centre, facing +x, px × k; top view: its centre, nose up). Cartoon
// style: bold friendly shapes with the same outline weight as people. A plate is always one plain light rectangle and
// no badge is ever drawn: the engine has no text shapes. Its movement style changes the drawing, never the timing.

import { CATALOG } from "./catalog.ts";
import { blink as blinkAt, FACES, type FaceParams, type Mouth } from "./face.ts";
import { F } from "./frame.ts";
import { DEG, TAU, clamp, clamp01, ease, hex, isHex, lerp, noise, rand, shade, smoothstep } from "./math.ts";
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
}

// ---- geometry ----------------------------------------------------------------------------------------------------

export interface CarDraw {
  car: CarLook;
  style: MovementStyle;
  seed: number;
}

interface Spec {
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
};

/** The side windows sit between these levels. */
const LV_B = 1.06;
const LV_T = 1.88;
const INSET = 16;
const GAP = 9;
const GLASS: Record<CarLook["windows"], { glass: string; tint: string; a: number; roof: string }> = {
  clear: { glass: "#bfe3f2", tint: "#bfe9ff", a: 0.22, roof: "#2d3a55" },
  tinted: { glass: "#5f7a8c", tint: "#5f7a8c", a: 0.25, roof: "#26323f" },
  dark: { glass: "#2b3440", tint: "#2b3440", a: 0.4, roof: "#1b222b" },
};
const PLATE = "#f4f1ea";
const GRILLE = "#2a2d36";
const TRIM = "#3d4250";
const MOUTH_DARK = "#4a1830";
const TYRE = "#2b2b36";
/** How a face's mouth bends the grille: + a smile, - a frown. */
const MOUTH_CURVE: Record<Mouth, number> = { smile: 1, grin: 1.15, laugh: 1.3, o: 0, bigo: 0, flat: 0, frown: -1, wavy: -0.35, smirk: 0.6, grit: 0, pout: -0.3, hum: 0.4 };

type Pt = [number, number];

/** The x part along a chain of `top` points (from → to) at a level, held at its ends. */
function chainX(top: Pt[], from: number, to: number, lv: number): number {
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
function rounded(pts: Pt[], r: number): number[] {
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
function outlined(pts: number[], d: number): number[] {
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

interface Side {
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
  const spec = BODIES[car.body] ?? BODIES.hatchback;
  const hl = 292 * spec.len * clamp(car.length, 0.85, 1.15);
  const H = spec.hgt * clamp(car.height, 0.85, 1.15);
  const wr = 54 * clamp(car.wheels.size, 0.85, 1.2) * (car.wheels.style === "offroad" ? 1.06 : 1);
  const sill = -(wr * 0.6) - spec.lift - (car.wheels.style === "offroad" ? 6 : 0);
  const lowH = 136 * H;
  const cabH = 130 * H;
  const y = (lv: number) => (lv <= 1 ? sill - lv * lowH : sill - lowH - (lv - 1) * cabH);
  const X = (fx: number) => fx * hl;
  const top = spec.top;
  const ws = (lv: number) => X(chainX(top, spec.ws[0], spec.ws[1], lv));
  const bk = (lv: number) => X(chainX(top, spec.back[0], spec.back[1], lv));
  const raw: Pt[] = top.map(([fx, lv]) => [X(fx), y(lv)]);
  raw.push([X(-1), y(0.14)], [X(-0.95), sill], [X(0.95), sill], [X(1), y(0.14)]);
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

// ---- effects shared with the plain car (props.ts) ---------------------------------------------------------------

/** A tyre bursting: a star flash and bits flying off. */
export function burst(pen: Pen, x: number, y: number, age: number, k: number, seed: number, gravity: boolean): void {
  if (age < 0 || age > 0.9) return;
  if (age < 0.45) {
    const g = ease.outBack(Math.min(1, age / 0.12));
    const a = 1 - smoothstep(0.25, 0.45, age);
    pen.poly(starPts(x, y, 95 * k * g, 42 * k * g, 10, age * 60), "#ff6f61", a);
    pen.poly(starPts(x, y, 66 * k * g, 30 * k * g, 10, age * 60 + 18), "#ffc94a", a);
    pen.circle(x, y, 18 * k * g, "#ffffff", a);
  }
  for (let i = 0; i < 4; i += 1) {
    const ang = (-150 + i * 40 + rand(seed, i + 40) * 20) * DEG;
    const v = (380 + rand(seed, i + 50) * 260) * k;
    const bx = x + Math.cos(ang) * v * age;
    const by = y + Math.sin(ang) * v * age + (gravity ? 900 * k * age * age : 0);
    pen.save();
    pen.translate(bx, by);
    pen.rotate(age * 720 + i * 40);
    pen.poly([-10 * k, -5 * k, 9 * k, -7 * k, 11 * k, 6 * k, -8 * k, 5 * k], "#2b2b36", 1 - smoothstep(0.6, 0.9, age));
    pen.restore();
  }
}

/** A bump: a short star flash. */
export function impact(pen: Pen, x: number, y: number, age: number, k: number): void {
  if (age < 0 || age > 0.4) return;
  const g = ease.outBack(Math.min(1, age / 0.1));
  const a = 1 - smoothstep(0.2, 0.4, age);
  pen.poly(starPts(x, y, 70 * k * g, 30 * k * g, 8, 10), "#ffffff", a);
  pen.poly(starPts(x, y, 46 * k * g, 20 * k * g, 8, 10), "#ffc94a", a);
}

/** A honk: three sound-wave arcs spreading from the nose. `dir` is the way the nose points, in degrees on screen
 * (0 = +x, clockwise). */
export function honkWaves(pen: Pen, x: number, y: number, age: number, k: number, dir: number): void {
  if (age < 0) return;
  for (let i = 0; i < 3; i += 1) {
    const ph = (age / 0.6 + i / 3) % 1;
    const r = (26 + ph * 120) * k;
    pen.line(arcPts(x, y, r, r * 1.1, dir - 38, dir + 38, 8), 8 * k, "#ffc94a", 0.9 * (1 - ph));
  }
}

/** Exhaust from the back: two pale puffs when it speeds up, one dark puff when it stalls. (dx, dy): the way the puffs
 * drift, away from the car (and up, in a side view). */
export function exhaust(pen: Pen, x: number, y: number, puffAge: number, stallAge: number, k: number, dx: number, dy: number): void {
  if (puffAge >= 0 && puffAge < 0.75) {
    for (let i = 0; i < 2; i += 1) {
      const p = clamp01((puffAge - i * 0.15) / 0.6);
      if (p <= 0 || p >= 1) continue;
      pen.circle(x + dx * (p * 80 + i * 14) * k, y + dy * (p * 80 + i * 14) * k, (14 + p * 26) * k, "#d9dde3", 0.8 * (1 - p));
    }
  }
  if (stallAge >= 0 && stallAge < 0.8) {
    const p = stallAge / 0.8;
    pen.circle(x + dx * p * 70 * k, y + dy * p * 70 * k, (20 + p * 34) * k, "#55586a", 0.75 * (1 - p));
  }
}

/** The headlights flashing (`blink`): a glow at a light. */
export function lightGlow(pen: Pen, x: number, y: number, blink: number, k: number): void {
  if (blink > 0.04) pen.circle(x, y, 46 * k, "#fff3b0", 0.55 * blink);
}

// ---- the face ----------------------------------------------------------------------------------------------------

/** How much a movement style changes the drawing (never the timing). */
function styleOf(style: MovementStyle): { bob: number; sway: number; wobble: number; lines: number } {
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

function faceOf(st: PropState, car: CarLook): FaceParams | null {
  if (!carHasFace(car)) return null;
  return FACES[(st.face ?? "neutral") as Expression] ?? FACES.neutral;
}

/** One eye: an outlined white, a pupil and a glint, or a closed or happy arc; the face.ts parameters drive it. */
function carEye(pen: Pen, x: number, y: number, rx: number, ry: number, f: FaceParams, closedBy: number, iris: string, ink: string, white: string, lidColour: string, t: number, s: number): void {
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
  pen.circle(ix - ir * 0.32, iy - ir * 0.38, Math.max(0.6, ir * 0.34), "#ffffff");
}

/** Brows over two eyes side by side (xs: the back eye, then the front one), only on a face that uses them. */
function carBrows(pen: Pen, xs: [number, number], y: number, rx: number, ry: number, f: FaceParams, ink: string): void {
  if (Math.abs(f.brow) < 4 && f.browUp < 1 && f.browAsym < 1) return;
  for (const s of [-1, 1]) {
    const ex = s < 0 ? xs[0] : xs[1];
    const by = y - ry * Math.max(f.open, 0.85) - rx * 0.4 - f.browUp * ry * 0.1 - (s > 0 ? f.browAsym * ry * 0.1 : 0);
    const half = rx * 0.8;
    const tilt = Math.tan(clamp(f.brow, -40, 40) * DEG) * half;
    pen.line([ex - s * half, by - tilt, ex, by - Math.abs(tilt) * 0.2 - 1, ex + s * half, by + tilt * 0.6], rx * 0.22, ink);
  }
}

// ---- side view ---------------------------------------------------------------------------------------------------

function wheelSide(pen: Pen, x: number, y: number, r: number, spin: number, flat: boolean, car: CarLook, ink: string): void {
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

function frontLight(pen: Pen, g: Side, car: CarLook, colour: string): [number, number] {
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

function rearLight(pen: Pen, g: Side, car: CarLook, colour: string): [number, number] {
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

function extraSide(pen: Pen, g: Side, car: CarLook, ink: string): void {
  const spec = g.spec;
  const roofY = g.y(2);
  const r0 = g.X(spec.top[spec.ws[1]]![0]);
  const r1 = g.X(spec.top[spec.back[0]]![0]);
  if (car.extra === "roof_rack") {
    const a = r0 - 24;
    const b = r1 + 22;
    pen.line([a, roofY + 2, a + 6, roofY - 16, b - 6, roofY - 16, b, roofY + 2], 8, TRIM);
  } else if (car.extra === "roof_box") {
    const w = (r0 - r1) * 0.72;
    const x = (r0 + r1) / 2 - w / 2 - 10;
    pen.rect(x - 6, roofY - 44, w + 12, 46, 20, ink);
    pen.rect(x, roofY - 38, w, 36, 16, "#454b58");
  } else if (car.extra === "spoiler") {
    const x = g.X(spec.spoiler[0]);
    const y = g.y(spec.spoiler[1]);
    pen.line([x + 8, y + 2, x + 4, y - 20, x - 54, y - 26, x + 22, y - 22], 10, shade(hex(car.paint), -0.35));
  }
}

/** Side view car of the cast, facing +x before the facing mirror; origin on the ground between the wheels. */
export function drawCarLookSide(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
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
  pen.poly(g.front, glass.glass);
  if (g.rear) pen.poly(g.rear, glass.glass);
  occ.side?.(pen, g.seats);
  pen.poly(g.front, glass.tint, glass.a);
  if (g.rear) pen.poly(g.rear, glass.tint, glass.a);
  // a glint near the window's front edge, clear of the faces
  pen.line([g.frontRight - 26, g.y(1.72), g.frontRight - 12, g.y(1.3)], 7, "#ffffff", car.windows === "clear" ? 0.55 : 0.3);
  if (g.spec.rear) pen.line([g.X(g.spec.pillar), g.y(1.02), g.X(g.spec.pillar), g.y(0.2)], 3, shade(paint, -0.28), 0.8);
  pen.ellipse(g.ws(LV_B) - 6, g.y(1.12), 15, 11, 0, accent);
  extraSide(pen, g, car, ink);
  // the grille (a smile or a frown with a grille mouth), bumpers and plain plates
  const mouth = face && car.face.mouth === "grille" ? face.mouth : null;
  if (mouth === null) pen.rect(g.hl - 30, g.y(0.52), 26, g.lowH * 0.22, 8, GRILLE);
  else if (mouth === "o" || mouth === "bigo") pen.ellipse(g.hl - 28, g.y(0.42), 18, 8 + 7 * clamp(face!.mouthOpen, 0.3, 1.3), 0, MOUTH_DARK);
  else {
    const c = MOUTH_CURVE[mouth] ?? 0;
    const yy = g.y(0.44);
    pen.line(quadPts(g.hl - 64, yy - c * 10, g.hl - 34, yy + c * 13, g.hl - 6, yy - c * 4, 8), g.lowH * 0.09, GRILLE);
  }
  pen.rect(g.hl - 34, g.y(0.3), 40, g.lowH * 0.18, 10, TRIM);
  pen.rect(-g.hl - 6, g.y(0.3), 40, g.lowH * 0.18, 10, TRIM);
  pen.rect(g.hl - 2, g.y(0.36), 9, g.lowH * 0.12, 3, PLATE);
  pen.rect(-g.hl - 7, g.y(0.36), 9, g.lowH * 0.12, 3, PLATE);
  // lights
  const headEyes = face !== null && car.face.eyes === "headlights";
  const front: [number, number] = headEyes ? [g.hl - clamp(g.lowH * 0.2, 14, 34) * 1.45, g.y(0.7)] : frontLight(pen, g, car, lit ? "#fff3b0" : "#ffe08a");
  const back = rearLight(pen, g, car, st.braking > 0.1 ? "#ff2d2d" : "#b3262d");
  pen.restore();
  // wheel arches and wheels
  pen.ellipse(-g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, shade(paint, -0.45));
  pen.ellipse(g.ax, -g.wr + 2 + dy * 0.5, g.wr * 1.37, g.wr * 1.19, 0, shade(paint, -0.45));
  wheelSide(pen, -g.ax, -g.wr, g.wr, spin, false, car, ink);
  wheelSide(pen, g.ax, -g.wr, g.wr, spin, st.flat, car, ink);
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

interface Top {
  spec: Spec;
  L: number;
  Wd: number;
  wsBase: number;
  wsTop: number;
  roofBack: number;
  backFoot: number;
}

function carTop(car: CarLook): Top {
  const spec = BODIES[car.body] ?? BODIES.hatchback;
  const L = 350 * spec.len * clamp(car.length, 0.85, 1.15);
  const at = (i: number) => -spec.top[i]![0] * (L / 2);
  return { spec, L, Wd: 196 * spec.wide, wsBase: at(spec.ws[0]), wsTop: at(spec.ws[1]), roofBack: at(spec.back[0]), backFoot: at(spec.back[1]) };
}

/** Top-down car of the cast: nose up before its heading; origin at its centre. */
export function drawCarLookTop(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  const car = d.car;
  const g = carTop(car);
  const { L, Wd } = g;
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
  pen.ellipse(10, 14, Wd / 2 + 16, L / 2 + 10, 0, "#000000", 0.2);
  // wheels peek out at the corners; the front pair turns with the steering
  const wy = (L / 2) * g.spec.axle * 0.94;
  const ww = (car.wheels.style === "offroad" ? 42 : 34) * car.wheels.size;
  const wl = 72 * car.wheels.size;
  for (const [wx, wyy, front] of [
    [-Wd / 2 + 2, -wy, true],
    [Wd / 2 - 2, -wy, true],
    [-Wd / 2 + 2, wy, false],
    [Wd / 2 - 2, wy, false],
  ] as [number, number, boolean][]) {
    pen.save();
    pen.translate(wx, wyy);
    if (front) pen.rotate(clamp(st.wheelTurn, -40, 40));
    pen.rect(-ww / 2, -wl / 2, ww, wl, 10, st.flat && front && wx > 0 ? "#55556a" : "#24242e");
    pen.restore();
  }
  pen.scale(grow, grow);
  const shape = roundRectPts(-Wd / 2, -L / 2, Wd, L, Math.min(g.spec.round, Wd / 2 - 1));
  pen.poly(outlined(shape, 8), ink);
  pen.poly(shape, paint);
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
  if (car.extra === "roof_rack") {
    for (const p of [0.22, 0.78]) pen.line([-0.44 * Wd, lerp(r0, r1, p), 0.44 * Wd, lerp(r0, r1, p)], 9, TRIM);
  } else if (car.extra === "roof_box") {
    const y0 = lerp(r0, r1, 0.45);
    pen.rect(-0.3 * Wd - 6, y0 - 6, 0.6 * Wd + 12, r1 - y0 + 6, 20, ink);
    pen.rect(-0.3 * Wd, y0, 0.6 * Wd, r1 - y0 - 6, 16, "#454b58");
  } else if (car.extra === "spoiler") pen.rect(-Wd / 2 - 6, L / 2 - 34, Wd + 12, 16, 7, shade(paint, -0.35));
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
  pen.rect(-26, -L / 2 - 4, 52, 8, 3, PLATE);
  pen.rect(-26, L / 2 - 4, 52, 8, 3, PLATE);
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
function topEye(pen: Pen, x: number, y: number, r: number, f: FaceParams, closedBy: number, iris: string, ink: string): void {
  const open = f.open * (1 - closedBy);
  if (f.eyes === "happy" || f.eyes === "closed" || open < 0.16) {
    pen.line(arcPts(x, y, r, r * 0.6, f.eyes === "happy" ? 200 : 20, f.eyes === "happy" ? 340 : 160, 6), Math.max(2, r * 0.3), ink);
    return;
  }
  pen.ellipse(x, y, r, r * Math.min(1.3, open), 0, "#ffffff");
  pen.circle(x, y - r * 0.3 * Math.min(1, open), r * 0.5 * f.pupil, iris);
}
