// Lamo Stories engine: props. Each PropKind has a side view and a top-down view (a road seen from above, for showing
// how a car moves). Prop actions (move, skid, spin, stop, bump, tyre_burst, appear, vanish, wobble, flash, and the car
// moves speed_up, bounce, honk, blink and stall) change a prop's state over time; cars leave skid marks and motion
// lines so a phone viewer can follow what happened. A car of the cast (a car prop with a castId, CONTRACTS §45.42) is
// drawn by car.ts from its own look; given no CarDraw, everything draws exactly as before.

import { burst, drawCarLookSide, drawCarLookTop, exhaust, honkWaves, impact, lightGlow, type CarDraw } from "./car.ts";
import { F } from "./frame.ts";
import { DEG, TAU, clamp, clamp01, ease, hex, lerp, rand, shade, smoothstep } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, heartPts, inflate, quadPts, roundRectPts, starPts } from "./pen.ts";
import type { Beat, Expression, PropAction, PropKind, SceneProp } from "./types.ts";

export const CARS: Set<PropKind> = new Set(["car", "truck"]);
/** Flat things on the ground: drawn before anything that stands. */
export const DECALS: Set<PropKind> = new Set(["ice_patch", "puddle"]);
/** Signs and symbols over the scene: drawn after everything that stands. */
export const OVERLAYS: Set<PropKind> = new Set(["arrow", "check", "cross", "exclamation", "question", "heart", "sparkles", "dust"]);
export const WEATHER: Set<PropKind> = new Set(["snow", "rain", "fog"]);

/** The prop actions that move a prop to their `to` (a stall without `to` happens in place). */
const MOVERS: Set<PropAction> = new Set(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);
/** Side view: the prop actions whose `dir` turns the prop to face that way. */
const FACERS: Set<PropAction> = new Set(["move", "stop", "bump", "appear"]);

export interface PropState {
  prop: SceneProp;
  /** 0..1 of the frame */
  x: number;
  y: number;
  /** side view: tilt in degrees; top view: heading (0 = nose up, clockwise) */
  rot: number;
  scale: number;
  alpha: number;
  visible: boolean;
  /** side view: -1 or 1 */
  facing: number;
  /** side view spin: the mirror scale while turning round (-1..1) */
  spinX: number;
  /** normalized units per second */
  speed: number;
  braking: number;
  flat: boolean;
  burstAge: number;
  bumpAge: number;
  appearAge: number;
  vanishAge: number;
  flash: number;
  skidding: number;
  /** front wheels' steer angle (top view) */
  wheelTurn: number;
  /** distance rolled (px) for wheel spokes */
  rolled: number;
  /** where the rear wheels have been during skids, world px pairs (top view) */
  marks: number[][];
  /** side view: x of the wheels when the current skid started (world px) */
  skidFrom: number | null;
  lights: boolean;
  /** the newest beat of this prop at or before t that has a face (a car of the cast with eyes shows it) */
  face: Expression | null;
  /** seconds since a honk started, while it sounds; -1 otherwise */
  honkAge: number;
  /** the headlights flashing (blink): 0..1 */
  blink: number;
  /** a suspension hop (bounce): 1 at the top, a little below 0 as it settles */
  bounce: number;
  /** seconds since the newest stall started; -1 before any */
  stallAge: number;
  /** seconds since the newest speed_up started (its exhaust puffs); -1 before any */
  puffAge: number;
}

/** A stall's stop: like a stop, with a judder in it. */
const stallEase = (p: number): number => clamp01(ease.outCubic(p) - 0.04 * Math.sin(p * Math.PI * 5) * (1 - p));

function moveEase(a: PropAction): (t: number) => number {
  if (a === "speed_up") return ease.inQuad;
  if (a === "stall") return stallEase;
  if (a === "skid") return ease.outQuad;
  if (a === "spin") return ease.outCubic;
  if (a === "stop") return ease.outCubic;
  if (a === "bump") return ease.outBack;
  return ease.inOutSine;
}

/** How far a skid swings the car's rear out (top view, degrees) at progress p of the skid: positive is the car's
 * right. `side` is the skid's `dir` (+1 right, -1 left): "rear slides right" swings the rear to the car's right, so
 * the nose turns left of where the car travels (the body turns by minus this). It swings out, peaks at 40% of the
 * skid and comes back straight by its end; a swing back the other way is a second skid with the other `dir`, so
 * what the picture shows always matches what the script (and its caption) says. */
export function rearSwing(p: number, side: number): number {
  const q = clamp01(p);
  const u = q < 0.4 ? (q / 0.4) * 0.5 : 0.5 + ((q - 0.4) / 0.6) * 0.5;
  return side * 34 * Math.sin(Math.PI * u);
}

interface PathOut {
  x: number;
  y: number;
  heading: number;
  facing: number;
  speed: number;
  /** px travelled so far (wheels roll by it) */
  dist: number;
}

/** Position and heading at time t from the move-like beats. */
function propPath(prop: SceneProp, beats: Beat[], view: "side" | "top", t: number): PathOut {
  let x = prop.x;
  let y = prop.y;
  let heading = prop.rot;
  let facing = 1;
  let speed = 0;
  let dist = 0;
  for (const b of beats) {
    if (b.at > t) break;
    const a = b.do as PropAction;
    // in a side view `dir` says which way a car drives; a skid's, spin's or burst's `dir` is the side it slides to
    if (b.dir && view === "side" && FACERS.has(a)) facing = b.dir === "left" ? -1 : 1;
    if (!MOVERS.has(a)) continue;
    let to = b.to;
    if (!to && (a === "skid" || a === "spin") && view === "top") {
      // a part of 1080 design px, the same distance in every shape
      const d = a === "skid" ? 0.12 : 0.08;
      to = { x: x + Math.sin(heading * DEG) * (d * F.ux), y: y - Math.cos(heading * DEG) * d * F.uy };
    }
    if (!to) continue;
    // otherwise the way it travels is the way it faces (a skid with a dir still goes nose first)
    if (view === "side" && !(b.dir && FACERS.has(a)) && Math.abs(to.x - x) > 0.005) facing = to.x < x ? -1 : 1;
    const dx = to.x - x;
    const dy = (to.y - y) * (F.h / F.w);
    if (view === "top" && Math.hypot(dx, dy) > 0.01) {
      // the car turns to its new direction over a moment instead of snapping round
      const target = Math.atan2(dx, -dy) / DEG;
      const turn = Math.min(0.35, b.dur * 0.3);
      const diff = ((((target - heading) % 360) + 540) % 360) - 180;
      heading += diff * (turn > 0 ? ease.inOutSine(clamp01((t - b.at) / turn)) : 1);
    }
    const p = b.dur > 0 ? clamp01((t - b.at) / b.dur) : 1;
    const e = moveEase(a);
    const k = a === "bump" ? Math.min(1, Math.sin(Math.PI * Math.min(1, p * 1.6)) * 0.25 + (p > 0.6 ? e((p - 0.6) / 0.4) : 0)) : e(p);
    const nx = lerp(x, to.x, k);
    const ny = lerp(y, to.y, k);
    if (p < 1) {
      const dk = (e(Math.min(1, p + 0.02)) - e(Math.max(0, p - 0.02))) / 0.04;
      speed = (Math.hypot(dx, dy) * dk) / Math.max(0.05, b.dur);
    } else speed = 0;
    dist += Math.hypot(nx - x, (ny - y) * (F.h / F.w)) * F.w;
    x = nx;
    y = ny;
  }
  return { x, y, heading, facing, speed, dist };
}

/** What a driver does to the car: braking 0..1, steering -1..1 (screen side), and the road rolling by (px). */
export interface DriverInput {
  braking: number;
  steer: number;
  rolled: number;
}

/** The suspension hop of a bounce at progress p: up about 6% of the car's height, then a small settle. */
function hop(p: number): number {
  if (p < 0.55) return Math.sin((Math.PI * p) / 0.55);
  return -0.22 * Math.sin((Math.PI * (p - 0.55)) / 0.45);
}

/** Everything about one prop at scene time t. `car`: a car of the cast (its movement style changes the drawing). */
export function propState(prop: SceneProp, beats: Beat[], view: "side" | "top", t: number, driver: DriverInput, car?: CarDraw | null): PropState {
  const path = propPath(prop, beats, view, t);
  const firstAppear = beats.find((b) => b.do === "appear");
  const state = prop.state ?? "";
  const st: PropState = {
    prop,
    x: path.x,
    y: path.y,
    rot: view === "top" ? path.heading : prop.rot,
    scale: 1,
    alpha: 1,
    visible: !firstAppear || firstAppear.at <= t,
    facing: path.facing,
    spinX: 1,
    speed: path.speed,
    braking: Math.max(driver.braking, state.includes("brakes") ? 1 : 0),
    flat: state.includes("flat"),
    burstAge: -1,
    bumpAge: -1,
    appearAge: -1,
    vanishAge: -1,
    flash: 0,
    skidding: 0,
    wheelTurn: driver.steer * 28,
    rolled: path.dist + driver.rolled,
    marks: [],
    skidFrom: null,
    lights: /lights|night/.test(state),
    face: null,
    honkAge: -1,
    blink: 0,
    bounce: 0,
    stallAge: -1,
    puffAge: -1,
  };
  const dip = car?.style === "heavy" ? 1.5 : 1;
  let stalledAt: number | null = null;
  let movedAt = -Infinity;
  for (const b of beats) {
    if (b.at > t) break;
    const a = b.do as PropAction;
    const tau = t - b.at;
    const p = b.dur > 0 ? clamp01(tau / b.dur) : 1;
    const on = tau < b.dur;
    const side = b.dir === "left" ? -1 : 1;
    const marked = view === "top" && st.marks.length < 3;
    if (b.face) st.face = b.face;
    if (MOVERS.has(a) && b.to) movedAt = b.at;
    switch (a) {
      case "skid":
        if (on) {
          st.skidding = Math.sin(Math.PI * Math.min(1, p * 1.3));
          // the front wheels point back along the travel line (steering into the skid); a driver who steers turns
          // them their way, so the wheels, the hands and the steering arrow always agree
          const swing = rearSwing(p, side);
          st.wheelTurn = driver.steer !== 0 ? Math.sign(driver.steer) * Math.max(Math.abs(swing) * 0.9, Math.abs(driver.steer) * 28) : swing * 0.9;
        }
        if (view === "top") {
          if (on) st.rot -= rearSwing(p, side);
          if (marked) st.marks.push(skidMarks(prop, beats, b, Math.min(t, b.at + b.dur)));
        } else {
          if (on) st.rot += -1.2 * Math.sin(Math.PI * p) * Math.sin(tau * 24);
          if (b.to) st.skidFrom = (propPath(prop, beats, view, b.at).x - path.x) * F.w;
        }
        break;
      case "spin": {
        const k = ease.outCubic(p);
        const ang = side * 360 * k;
        if (view === "top") {
          st.rot += ang;
          if (marked) st.marks.push(skidMarks(prop, beats, b, Math.min(t, b.at + b.dur)));
        } else st.spinX = on ? Math.cos(TAU * k) : 1;
        if (on) st.skidding = 1 - p;
        break;
      }
      case "stop":
        if (on) st.braking = Math.max(st.braking, 1 - smoothstep(0.85, 1, p) * 0.5);
        if (view === "side" && on) st.rot += 3.5 * dip * Math.sin(Math.PI * smoothstep(0.55, 1, p)) * Math.exp(-2 * Math.max(0, p - 0.8));
        if (marked && b.to && propPath(prop, beats, view, b.at + Math.min(0.05, b.dur / 4)).speed > 0.12) {
          st.marks.push(skidMarks(prop, beats, b, Math.min(t, b.at + b.dur * 0.7)));
        }
        break;
      case "bump":
        st.bumpAge = tau;
        if (on) st.rot += (view === "side" ? 4 : 6) * Math.sin(tau * 30) * Math.exp(-tau * 6);
        break;
      case "tyre_burst":
        st.burstAge = tau;
        st.flat = true;
        if (on) st.rot += (view === "side" ? 3.2 : 7) * Math.sin(tau * 16) * Math.exp(-tau * 2.2) * side;
        break;
      case "appear":
        st.visible = true;
        st.appearAge = tau;
        if (on) st.scale *= ease.outBack(Math.min(1, tau / Math.min(0.45, Math.max(0.05, b.dur))));
        break;
      case "vanish":
        st.vanishAge = tau;
        if (on) {
          st.scale *= 1 - ease.inBack(p);
          st.alpha *= 1 - smoothstep(0.7, 1, p);
        } else st.visible = false;
        break;
      case "wobble":
        if (on) st.rot += 9 * Math.sin(TAU * 3 * tau) * (1 - p);
        break;
      case "flash":
        if (on) st.flash = 0.5 + 0.5 * Math.sin(TAU * 3.5 * tau - Math.PI / 2);
        break;
      case "speed_up":
        st.puffAge = tau;
        break;
      case "bounce":
        st.bounce = on ? hop(p) : 0;
        break;
      case "honk":
        st.honkAge = tau < Math.max(b.dur, 0.6) ? tau : -1;
        break;
      case "blink": {
        // two flashes over the beat
        const ph = (p * 2) % 1;
        st.blink = on && ph < 0.6 ? Math.sin((Math.PI * ph) / 0.6) : 0;
        break;
      }
      case "stall":
        st.stallAge = tau;
        stalledAt = b.at;
        if (on && b.to) st.braking = Math.max(st.braking, 1 - smoothstep(0.85, 1, p) * 0.5);
        if (tau < 0.4) st.rot += (view === "side" ? 2.2 : 3) * Math.sin(tau * 55) * (1 - tau / 0.4);
        break;
      case "move":
        break;
    }
  }
  // a stall in place brings the speed down to 0 over its shudder, until the next move
  if (stalledAt !== null && movedAt < stalledAt) st.speed *= 1 - smoothstep(0, 0.4, t - stalledAt);
  st.scale = Math.max(0, st.scale);
  return st;
}

/** The rear wheels' tracks during one skid, spin or hard stop: world px, [left x, left y, right x, right y] per step. */
function skidMarks(prop: SceneProp, beats: Beat[], beat: Beat, until: number): number[] {
  const pts: number[] = [];
  const steps = Math.max(2, Math.min(16, Math.ceil((until - beat.at) / 0.08)));
  const k = prop.scale || 1;
  const side = beat.dir === "left" ? -1 : 1;
  for (let i = 0; i <= steps; i += 1) {
    const time = beat.at + ((until - beat.at) * i) / steps;
    const path = propPath(prop, beats, "top", time);
    const p = beat.dur > 0 ? clamp01((time - beat.at) / beat.dur) : 1;
    let heading = path.heading;
    if (beat.do === "skid") heading -= rearSwing(p, side);
    if (beat.do === "spin") heading += side * 360 * ease.outCubic(p);
    const hx = Math.sin(heading * DEG);
    const hy = -Math.cos(heading * DEG);
    const bx = path.x * F.w - hx * 108 * k;
    const by = path.y * F.h - hy * 108 * k;
    const ox = -hy * 72 * k;
    const oy = hx * 72 * k;
    pts.push(bx - ox, by - oy, bx + ox, by + oy);
  }
  return pts;
}

// ---- drawing ------------------------------------------------------------------------------------------------

export interface Occupants {
  /** draws the people in a car, in the car's own frame (origin at the ground centre, facing +x, px) */
  side?: (pen: Pen, seats: { x: number; beltY: number; topY: number }[]) => void;
  /** draws the tops of their heads (top view, origin at the car's centre, nose up) */
  top?: (pen: Pen, seats: { x: number; y: number; r: number }[]) => void;
}

const INK = "#1c1842";

/** Small things are drawn a little bigger at scale 1, so they read on a phone. */
const BASE: Partial<Record<PropKind, number>> = { tyre: 1.6, warning_triangle: 1.5, phone: 1.6, cone: 1.5, steering_wheel: 1.2, stop_sign: 1.2, ice_sign: 1.2, deer: 1.15 };

export function propBaseScale(st: PropState, view: "side" | "top"): number {
  const depth = view === "side" ? clamp(1 + (st.y - 0.72) * 0.8, 0.8, 1.2) : 1;
  return (st.prop.scale || 1) * depth * st.scale * (BASE[st.prop.kind] ?? 1);
}

/** Draws one prop at its state; the pen is in world pixels (camera applied). `car`: a car prop of the cast, drawn as
 * that car (its `color` is ignored). */
export function drawProp(pen: Pen, st: PropState, view: "side" | "top", t: number, seed: number, occ: Occupants, night: boolean, car?: CarDraw | null): void {
  if (!st.visible || st.alpha <= 0.01 || st.scale <= 0.01) return;
  const kind = st.prop.kind;
  const k = propBaseScale(st, view);
  pen.save();
  pen.fade(st.alpha);
  const x = st.x * F.w;
  const y = st.y * F.h;
  if (st.flash > 0.02) {
    pen.circle(x, y - (view === "side" && !OVERLAYS.has(kind) && !DECALS.has(kind) ? 120 * k : 0), 190 * k, "#ffc94a", 0.28 * st.flash);
  }
  pen.translate(x, y);
  if (kind === "car" && car) {
    if (view === "top") drawCarLookTop(pen, st, k, t, car, occ, night);
    else drawCarLookSide(pen, st, k, t, car, occ, night);
  } else if (kind === "car" || kind === "truck") {
    const truck = kind === "truck";
    // the car moves (bounce, honk, blink, speed_up, stall) on a plain car or truck
    if (st.bounce !== 0) pen.translate(0, -st.bounce * (view === "top" ? 0 : 18) * k);
    if (view === "top") drawCarTop(pen, st, k, t, truck, occ, night);
    else drawCarSide(pen, st, k, t, truck, occ, night);
    plainCarMoves(pen, st, view, k, truck);
  } else {
    pen.rotate(st.rot);
    pen.scale(k * (view === "side" ? st.facing : 1), k);
    drawThing(pen, kind, st, view, t, seed);
  }
  pen.restore();
  // pops and puffs draw in world space so they don't spin with the prop
  if (st.appearAge >= 0 && st.appearAge < 0.6) puff(pen, x, y - (view === "side" && !OVERLAYS.has(kind) ? 60 * k : 0), st.appearAge / 0.6, 90 * k, seed);
  if (st.vanishAge >= 0 && st.vanishAge < 0.7) puff(pen, x, y - (view === "side" && !OVERLAYS.has(kind) ? 60 * k : 0), st.vanishAge / 0.7, 110 * k, seed + 1);
}

/** The new car moves on a plain car or truck (they draw nothing in a script that does not use them). */
function plainCarMoves(pen: Pen, st: PropState, view: "side" | "top", k: number, truck: boolean): void {
  if (st.honkAge < 0 && st.blink <= 0.04 && st.puffAge < 0 && st.stallAge < 0) return;
  const nose = truck ? 430 : 300;
  const tail = truck ? 440 : 300;
  if (view === "side") {
    const f = st.facing;
    honkWaves(pen, f * (nose + 16) * k, -134 * k, st.honkAge, k, f > 0 ? 0 : 180);
    lightGlow(pen, f * (nose - 30) * k, -134 * k, st.blink, k);
    exhaust(pen, -f * (tail + 12) * k, -40 * k, st.puffAge, st.stallAge, k, -f * 0.9, -0.45);
    return;
  }
  const L = truck ? 560 : 350;
  const h = st.rot * DEG;
  const at = (lx: number, ly: number): [number, number] => [(lx * Math.cos(h) - ly * Math.sin(h)) * k, (lx * Math.sin(h) + ly * Math.cos(h)) * k];
  const [hx, hy] = at(0, -L / 2 - 18);
  honkWaves(pen, hx, hy, st.honkAge, k, st.rot - 90);
  for (const s of [-1, 1]) {
    const [lx, ly] = at(s * 62, -L / 2 + 14);
    lightGlow(pen, lx, ly, st.blink, k * 0.8);
  }
  const [ex, ey] = at(0, L / 2 + 18);
  exhaust(pen, ex, ey, st.puffAge, st.stallAge, k, -Math.sin(h) * 1, Math.cos(h) * 1);
}

export function puff(pen: Pen, x: number, y: number, p: number, r: number, seed: number): void {
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * TAU + rand(seed, i) * 0.6;
    const d = r * (0.4 + p * 0.9);
    pen.circle(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, r * 0.22 * (1 - p * 0.6), "#ffffff", 0.85 * (1 - p));
  }
}

function wheel(pen: Pen, x: number, y: number, r: number, spin: number, flat: boolean): void {
  const ry = flat ? r * 0.72 : r;
  const cy = flat ? y + (r - ry) : y;
  pen.ellipse(x, cy, r + 5, ry + 5, 0, INK);
  pen.ellipse(x, cy, r, ry, 0, "#2b2b36");
  pen.circle(x, cy, r * 0.5, "#c9d3de");
  for (let i = 0; i < 2; i += 1) {
    const a = spin + (i * Math.PI) / 2;
    pen.line([x - Math.cos(a) * r * 0.42, cy - Math.sin(a) * r * 0.42, x + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42], r * 0.12, "#8b97a8");
  }
  pen.circle(x, cy, r * 0.14, "#5b6478");
}

/** Side view car or truck, facing +x before the facing mirror; origin on the ground between the wheels. */
function drawCarSide(pen: Pen, st: PropState, k: number, t: number, truck: boolean, occ: Occupants, night: boolean): void {
  const body = hex(st.prop.color, truck ? "#47d6a0" : "#ff6f61");
  const dark = shade(body, -0.22);
  const light = shade(body, 0.25);
  const glass = "#cdeeff";
  const moving = st.speed > 0.02 || st.rolled > 0;
  const bob = moving ? Math.sin(t * TAU * 3.1) * 1.6 : 0;
  const spin = (st.rolled / 54) % TAU;
  pen.save();
  pen.rotate(st.rot);
  pen.scale(k * st.facing * st.spinX, k);
  // ground shadow, skid marks and skid smoke
  pen.ellipse(0, 4, truck ? 430 : 300, 18, 0, "#000000", 0.18);
  if (st.skidFrom !== null) {
    const from = (st.skidFrom * st.facing) / k;
    for (const wx of truck ? [-300, 300] : [-185, 185]) pen.line([wx + from, -2, wx, -2], 16, "#1d1d26", 0.4);
  }
  if (st.skidding > 0.05) {
    for (let i = 0; i < 4; i += 1) {
      const ph = (t * 1.6 + i / 4) % 1;
      pen.circle(-200 - ph * 160, -20 - ph * 40, 26 + ph * 30, "#e9eef5", 0.55 * st.skidding * (1 - ph));
    }
  }
  if (truck) {
    // box trailer, cab, three wheels
    pen.rect(-430, -350, 620, 300, 24, INK);
    pen.rect(-422, -342, 604, 284, 18, shade(body, 0.12));
    pen.rect(-400, -320, 560, 18, 9, "#ffffff", 0.35);
    pen.poly(inflate([200, -50, 200, -300, 330, -300, 420, -190, 420, -50], 8), INK);
    pen.poly([200, -50, 200, -300, 330, -300, 420, -190, 420, -50], body);
    const win = [232, -190, 232, -282, 322, -282, 392, -190];
    pen.poly(win, glass);
    occ.side?.(pen, [{ x: 300, beltY: -190, topY: -282 }]);
    pen.poly(win, "#bfe9ff", 0.22);
    pen.line([250, -270, 290, -205], 6, "#ffffff", 0.5);
    for (const wx of [-300, -120, 300]) wheel(pen, wx, -56 + bob * 0.3, 56, spin, st.flat && wx === 300);
    pen.rect(400, -120, 26, 30, 8, "#ffe9a8");
    pen.rect(-436, -120, 14, 40, 6, st.braking > 0.1 ? "#ff3b30" : "#b3262d");
  } else {
    const cabin = [-218, -158, -186, -268, -158, -292, 44, -294, 78, -284, 168, -158];
    pen.poly(inflate(cabin, 8), INK);
    pen.poly(cabin, body);
    const front = [-8, -168, -8, -276, 50, -278, 140, -168];
    const rear = [-192, -168, -168, -266, -40, -276, -40, -168];
    pen.poly(front, glass);
    pen.poly(rear, glass);
    occ.side?.(pen, [
      { x: 52, beltY: -168, topY: -276 },
      { x: -112, beltY: -168, topY: -270 },
    ]);
    pen.poly(front, "#bfe9ff", 0.22);
    pen.poly(rear, "#bfe9ff", 0.22);
    // glints near the window edges, clear of the faces
    pen.line([104, -228, 124, -196], 7, "#ffffff", 0.55);
    pen.line([-178, -240, -170, -212], 6, "#ffffff", 0.45);
    // lower body
    pen.rect(-292, -178 + bob, 584, 146, 46, INK);
    pen.rect(-284, -170 + bob, 568, 130, 40, body);
    pen.rect(-270, -120 + bob, 540, 14, 7, light, 0.6);
    pen.line([-40, -160 + bob, -40, -58 + bob], 3, dark, 0.8);
    pen.rect(-20, -140 + bob, 34, 9, 4, dark);
    pen.rect(-300, -84 + bob, 44, 30, 12, "#c9d3de");
    pen.rect(256, -84 + bob, 44, 30, 12, "#c9d3de");
    // wheel arches, wheels, lights
    pen.ellipse(-185, -52, 74, 64, 0, shade(body, -0.45));
    pen.ellipse(185, -52, 74, 64, 0, shade(body, -0.45));
    wheel(pen, -185, -54, 54, spin, false);
    wheel(pen, 185, -54, 54, spin, st.flat);
    pen.ellipse(268, -134 + bob, 16, 13, 0, st.lights || night ? "#fff3b0" : "#ffe08a");
    pen.rect(-286, -150 + bob, 14, 30, 6, st.braking > 0.1 ? "#ff2d2d" : "#b3262d");
  }
  if (st.lights || night) {
    pen.poly([truck ? 420 : 280, -140, 820, -230, 820, -10], "#fff3b0", 0.16);
  }
  if (st.braking > 0.1) pen.circle(truck ? -436 : -284, truck ? -100 : -135, 40, "#ff3b30", 0.35 * st.braking);
  pen.restore();
  // effects in the car's world frame (not mirrored twice)
  const fx = st.facing * (truck ? 300 : 185) * k;
  burst(pen, fx, -54 * k, st.burstAge, k, 7, true);
  impact(pen, st.facing * 300 * k, -110 * k, st.bumpAge, k);
  if (st.speed > 0.08) {
    for (let i = 0; i < 3; i += 1) {
      const yy = (-230 + i * 70) * k;
      const len = (120 + i * 40) * k * clamp01(st.speed * 2.5);
      const x0 = -st.facing * (truck ? 450 : 310) * k;
      pen.line([x0, yy, x0 - st.facing * len, yy], 8 * k, "#ffffff", 0.55);
    }
  }
}

/** Top-down car or truck: nose up before its heading; origin at its centre. */
function drawCarTop(pen: Pen, st: PropState, k: number, t: number, truck: boolean, occ: Occupants, night: boolean): void {
  const body = hex(st.prop.color, truck ? "#47d6a0" : "#ff6f61");
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
  pen.save();
  pen.rotate(st.rot);
  pen.scale(k, k);
  const L = truck ? 560 : 350;
  const Wd = truck ? 232 : 196;
  if (st.speed > 0.06) {
    for (let i = -1; i <= 1; i += 1) {
      const len = 160 * clamp01(st.speed * 2.5);
      pen.line([i * 60, L / 2 + 40, i * 60, L / 2 + 40 + len], 10, "#ffffff", 0.5);
    }
  }
  if (st.lights || night) {
    pen.poly([-70, -L / 2, 70, -L / 2, 200, -L / 2 - 520, -200, -L / 2 - 520], "#fff3b0", 0.18);
  }
  pen.ellipse(10, 14, Wd / 2 + 16, L / 2 + 10, 0, "#000000", 0.2);
  // wheels peek out at the corners; the front pair turns with the steering
  const wy = L / 2 - (truck ? 80 : 70);
  for (const [wx, wyy, front] of [
    [-Wd / 2 + 2, -wy, true],
    [Wd / 2 - 2, -wy, true],
    [-Wd / 2 + 2, wy, false],
    [Wd / 2 - 2, wy, false],
  ] as [number, number, boolean][]) {
    pen.save();
    pen.translate(wx, wyy);
    if (front) pen.rotate(clamp(st.wheelTurn, -40, 40));
    const isFlat = st.flat && front && wx > 0;
    pen.rect(-17, -36, 34, 72, 10, isFlat ? "#55556a" : "#24242e");
    pen.restore();
  }
  if (truck) {
    pen.rect(-Wd / 2 - 8, -L / 2 - 8, Wd + 16, 170, 30, INK);
    pen.rect(-Wd / 2, -L / 2, Wd, 154, 24, body);
    pen.rect(-Wd / 2 + 18, -L / 2 + 30, Wd - 36, 56, 16, "#9fd8ff");
    occ.top?.(pen, [{ x: 0, y: -L / 2 + 110, r: 30 }]);
    pen.rect(-Wd / 2 - 8, -L / 2 + 166, Wd + 16, L - 166 + 8, 18, INK);
    pen.rect(-Wd / 2, -L / 2 + 174, Wd, L - 174, 12, shade(body, 0.15));
    pen.line([-Wd / 2 + 24, -L / 2 + 200, -Wd / 2 + 24, L / 2 - 30], 10, "#ffffff", 0.3);
  } else {
    const shape = roundRectPts(-Wd / 2, -L / 2, Wd, L, 56);
    pen.poly(inflate(shape, 8), INK);
    pen.poly(shape, body);
    pen.line([0, -L / 2 + 14, 0, -L / 2 + 70], 18, shade(body, 0.3), 0.7);
    pen.ellipse(-Wd / 2 - 6, -48, 12, 18, 0, shade(body, -0.25));
    pen.ellipse(Wd / 2 + 6, -48, 12, 18, 0, shade(body, -0.25));
    pen.poly([-74, -74, 74, -74, 62, -122, -62, -122], "#9fd8ff");
    pen.rect(-76, -74, 152, 180, 40, "#2d3a55");
    occ.top?.(pen, [
      { x: 0, y: -24, r: 34 },
      { x: 0, y: 62, r: 30 },
    ]);
    pen.rect(-76, -74, 152, 180, 40, "#bfe9ff", 0.12);
    pen.line([-50, -60, -30, 60], 8, "#ffffff", 0.3);
    pen.poly([-64, 112, 64, 112, 56, 142, -56, 142], "#9fd8ff");
    pen.ellipse(-62, -L / 2 + 14, 20, 12, 0, st.lights || night ? "#fff3b0" : "#ffe08a");
    pen.ellipse(62, -L / 2 + 14, 20, 12, 0, st.lights || night ? "#fff3b0" : "#ffe08a");
    const tail = st.braking > 0.1 ? "#ff2d2d" : "#b3262d";
    pen.rect(-84, L / 2 - 16, 36, 12, 5, tail);
    pen.rect(48, L / 2 - 16, 36, 12, 5, tail);
    if (st.braking > 0.1) {
      pen.circle(-66, L / 2 - 6, 40, "#ff3b30", 0.32 * st.braking);
      pen.circle(66, L / 2 - 6, 40, "#ff3b30", 0.32 * st.braking);
    }
  }
  pen.restore();
  // effects at the front-right wheel (burst) and the nose (bump), in the car's heading
  const h = st.rot * DEG;
  const at = (lx: number, ly: number): [number, number] => [(lx * Math.cos(h) - ly * Math.sin(h)) * k, (lx * Math.sin(h) + ly * Math.cos(h)) * k];
  const [bx, by] = at(Wd / 2, -(L / 2 - 70));
  burst(pen, bx, by, st.burstAge, k, 9, false);
  const [ix, iy] = at(0, -L / 2 - 20);
  impact(pen, ix, iy, st.bumpAge, k);
}

/** The steering arrow drawn over a top-view car while its driver steers (local to the car's centre). */
export function steerArrow(pen: Pen, st: PropState, side: number, strength: number): void {
  const k = propBaseScale(st, "top");
  pen.save();
  pen.translate(st.x * F.w, st.y * F.h);
  pen.rotate(st.rot);
  pen.scale(k);
  const a = clamp01(strength);
  const pts = quadPts(0, -230, side * 20, -360, side * 150, -400, 10);
  pen.line(pts, 40, INK, a);
  pen.line(pts, 26, "#ffc94a", a);
  pen.poly(inflate([side * 150, -440, side * 215, -398, side * 150, -356], 7), INK, a);
  pen.poly([side * 150, -440, side * 215, -398, side * 150, -356], "#ffc94a", a);
  pen.restore();
}

/** Every other prop, in its own frame scaled to its size (origin: bottom centre for things that stand). */
function drawThing(pen: Pen, kind: PropKind, st: PropState, view: "side" | "top", t: number, seed: number): void {
  const c = (fallback: string) => hex(st.prop.color, fallback);
  const top = view === "top";
  switch (kind) {
    case "tyre": {
      const spin = st.rolled / 70;
      if (top) {
        pen.rect(-40, -75, 80, 150, 22, INK);
        pen.rect(-32, -67, 64, 134, 18, "#2b2b36");
        return;
      }
      wheel(pen, 0, -70, 64, spin + t * (st.speed > 0.02 ? 8 : 0), st.flat);
      return;
    }
    case "ice_patch": {
      if (top) {
        const pts: number[] = [];
        for (let i = 0; i < 14; i += 1) {
          const a = (i / 14) * TAU;
          const r = 170 * (0.78 + 0.3 * rand(seed + 3, i));
          pts.push(Math.cos(a) * r, Math.sin(a) * r * 0.8);
        }
        pen.poly(inflate(pts, 6), "#ffffff", 0.5);
        pen.poly(pts, c("#bfe9ff"), 0.75);
      } else {
        pen.ellipse(0, 0, 170, 22, 0, "#ffffff", 0.45);
        pen.ellipse(0, 0, 160, 18, 0, c("#bfe9ff"), 0.8);
      }
      for (let i = 0; i < 3; i += 1) {
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 2.4 + i * 1.7));
        const gx = -80 + i * 70;
        const gy = top ? -40 + i * 35 : -4 + (i % 2) * 6;
        pen.line([gx, gy, gx + 40, gy - (top ? 20 : 6)], 6, "#ffffff", 0.8 * tw);
        pen.poly(starPts(gx + 46, gy - (top ? 24 : 8), 16 * tw, 4 * tw, 4, 0), "#ffffff", tw);
      }
      return;
    }
    case "puddle": {
      if (top) pen.ellipse(0, 0, 150, 110, 0, c("#7aa7c7"), 0.75);
      else pen.ellipse(0, 0, 140, 18, 0, c("#7aa7c7"), 0.8);
      const p = (t * 0.7) % 1;
      pen.line(arcPts(0, 0, 40 + p * 80, (top ? 30 : 5) + p * (top ? 60 : 10), 0, 360, 16), 4, "#ffffff", 0.5 * (1 - p));
      return;
    }
    case "warning_triangle": {
      const tri = [0, -150, 76, -14, -76, -14];
      if (top) {
        pen.poly(inflate([0, -60, 52, 30, -52, 30], 6), INK);
        pen.poly([0, -60, 52, 30, -52, 30], "#ff3b30");
        return;
      }
      pen.line([-40, -14, -60, 0], 6, "#5b6478");
      pen.line([40, -14, 60, 0], 6, "#5b6478");
      pen.poly(inflate(tri, 7), INK);
      pen.poly(tri, "#ff3b30");
      pen.poly([0, -112, 44, -34, -44, -34], "#ffffff");
      pen.poly([0, -96, 30, -44, -30, -44], "#ff6f61", 0.35 + 0.35 * Math.abs(Math.sin(t * 4)));
      return;
    }
    case "phone": {
      const ring = /ring/.test(st.prop.state ?? "");
      const shake = ring ? Math.sin(t * 60) * 4 : 0;
      pen.save();
      pen.translate(shake, 0);
      pen.rect(-50, -170, 100, 170, 18, INK);
      pen.rect(-42, -160, 84, 146, 12, ring || /on/.test(st.prop.state ?? "") ? "#62c6ff" : "#2d3a55");
      pen.circle(0, -10, 5, "#5b6478");
      pen.restore();
      if (ring) {
        for (const s of [-1, 1]) for (let i = 1; i <= 2; i += 1) pen.line(arcPts(0, -90, 60 + i * 24, 70 + i * 24, s > 0 ? -40 : 140, s > 0 ? 40 : 220, 6), 7, "#ffc94a", 0.8);
      }
      return;
    }
    case "steering_wheel": {
      pen.translate(0, top ? 0 : -110);
      const ring = arcPts(0, 0, 100, 100, 0, 360, 24);
      pen.line(ring, 34, INK);
      pen.line(ring, 22, "#3d4458");
      for (const a of [90, 210, 330]) pen.line([0, 0, Math.cos(a * DEG) * 96, Math.sin(a * DEG) * 96], 16, "#3d4458");
      pen.circle(0, 0, 26, "#ffc94a");
      return;
    }
    case "stop_sign": {
      if (top) {
        pen.poly(starPts(0, 0, 60, 60, 4, 22.5), "#e53935");
        return;
      }
      pen.rect(-8, -300, 16, 300, 6, "#8b97a8");
      const oct: number[] = [];
      for (let i = 0; i < 8; i += 1) oct.push(Math.cos((22.5 + i * 45) * DEG) * 82, -380 + Math.sin((22.5 + i * 45) * DEG) * 82);
      pen.poly(inflate(oct, 6), INK);
      pen.poly(oct, "#ffffff");
      pen.poly(inflate(oct, -9), "#e53935");
      pen.rect(-46, -392, 92, 24, 8, "#ffffff");
      return;
    }
    case "ice_sign": {
      if (top) {
        pen.poly([0, -60, 52, 30, -52, 30], "#ffffff");
        return;
      }
      pen.rect(-8, -300, 16, 300, 6, "#8b97a8");
      const tri = [0, -500, 104, -310, -104, -310];
      pen.poly(inflate(tri, 6), INK);
      pen.poly(tri, "#e53935");
      pen.poly([0, -462, 74, -330, -74, -330], "#ffffff");
      // a snowflake: three crossed strokes
      for (let i = 0; i < 3; i += 1) {
        const a = (i * 60 + 90) * DEG;
        pen.line([Math.cos(a) * -30, -372 + Math.sin(a) * -30, Math.cos(a) * 30, -372 + Math.sin(a) * 30], 7, "#1c1842");
      }
      return;
    }
    case "tree": {
      const snowy = /snow/.test(st.prop.state ?? "");
      if (top) {
        pen.circle(10, 12, 150, "#000000", 0.18);
        pen.circle(0, 0, 150, INK);
        pen.circle(0, 0, 142, c("#3fa55b"));
        pen.circle(-40, -40, 70, shade(c("#3fa55b"), 0.18));
        if (snowy) pen.circle(20, -10, 80, "#ffffff", 0.7);
        return;
      }
      pen.rect(-26, -200, 52, 200, 14, "#7a4a2a");
      if (/pine/.test(st.prop.state ?? "") || snowy) {
        for (let i = 0; i < 3; i += 1) {
          const yy = -200 - i * 110;
          const wd = 170 - i * 40;
          pen.poly(inflate([0, yy - 170, wd, yy, -wd, yy], 6), INK);
          pen.poly([0, yy - 170, wd, yy, -wd, yy], c("#2f8f57"));
          if (snowy) pen.poly([0, yy - 170, wd * 0.45, yy - 95, -wd * 0.45, yy - 95], "#ffffff");
        }
        return;
      }
      pen.circle(0, -330, 170, INK);
      pen.circle(-90, -260, 120, INK);
      pen.circle(90, -260, 120, INK);
      const leaf = c("#3fa55b");
      pen.circle(0, -330, 162, leaf);
      pen.circle(-90, -260, 112, leaf);
      pen.circle(90, -260, 112, leaf);
      pen.circle(-50, -380, 60, shade(leaf, 0.2), 0.8);
      return;
    }
    case "cone": {
      if (top) {
        pen.circle(0, 0, 50, INK);
        pen.circle(0, 0, 44, "#ff8a3d");
        pen.circle(0, 0, 18, "#ffffff");
        return;
      }
      pen.rect(-70, -18, 140, 18, 6, "#c4561d");
      pen.poly(inflate([-52, -18, 52, -18, 14, -150, -14, -150], 5), INK);
      pen.poly([-52, -18, 52, -18, 14, -150, -14, -150], "#ff8a3d");
      pen.poly([-36, -62, 36, -62, 28, -92, -28, -92], "#ffffff");
      return;
    }
    case "deer":
      drawDeer(pen, st, view, t);
      return;
    case "arrow": {
      // a chunky arrow pointing up (rotate it to point anywhere); "curve_left"/"curve_right" bend it
      const s = st.prop.state ?? "";
      const col = c("#ffc94a");
      const pulse = 1 + 0.06 * Math.sin(t * 6);
      pen.scale(pulse);
      if (/curve_(left|right)|turn_(left|right)/.test(s)) {
        const side = /left/.test(s) ? -1 : 1;
        const pts = quadPts(0, 110, 0, -40, side * 120, -80, 10);
        pen.line(pts, 64, INK);
        pen.line(pts, 44, col);
        const tip = [side * 120, -150, side * 210, -80, side * 120, -10];
        pen.poly(inflate(tip, 8), INK);
        pen.poly(tip, col);
        return;
      }
      const pts = [-34, 110, 34, 110, 34, -20, 90, -20, 0, -120, -90, -20, -34, -20];
      pen.poly(inflate(pts, 9), INK);
      pen.poly(pts, col);
      pen.line([-12, 80, -12, -10], 10, "#ffffff", 0.45);
      return;
    }
    case "check":
    case "cross":
    case "exclamation":
    case "question": {
      const fill = kind === "check" ? "#47d6a0" : kind === "cross" ? "#ff4f4f" : kind === "exclamation" ? "#ffc94a" : "#62c6ff";
      const pop = 1 + 0.05 * Math.sin(t * 5);
      pen.scale(pop);
      pen.circle(0, 0, 92, INK);
      pen.circle(0, 0, 84, c(fill));
      const mark = kind === "exclamation" ? INK : "#ffffff";
      if (kind === "check") pen.line([-40, 2, -10, 34, 44, -30], 22, mark);
      if (kind === "cross") {
        pen.line([-34, -34, 34, 34], 22, mark);
        pen.line([34, -34, -34, 34], 22, mark);
      }
      if (kind === "exclamation") {
        pen.line([0, -48, 0, 14], 22, mark);
        pen.circle(0, 46, 13, mark);
      }
      if (kind === "question") {
        pen.line([...arcPts(0, -20, 30, 28, 200, 400, 10), 0, 18], 20, mark);
        pen.circle(0, 50, 12, mark);
      }
      return;
    }
    case "heart": {
      const beat = 1 + 0.1 * Math.max(0, Math.sin(t * 7));
      pen.scale(beat);
      pen.poly(inflate(heartPts(0, 0, 86), 8), INK);
      pen.poly(heartPts(0, 0, 86), c("#ff6f8f"));
      pen.ellipse(-36, -30, 18, 11, -30, "#ffffff", 0.45);
      return;
    }
    case "sparkles": {
      for (let i = 0; i < 4; i += 1) {
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 3 + i * 1.9));
        const sx = [-80, 60, -10, 100][i]!;
        const sy = [-40, -90, 70, 40][i]!;
        pen.poly(starPts(sx, sy, 42 * tw, 10 * tw, 4, 0), c("#ffc94a"));
        pen.poly(starPts(sx, sy, 22 * tw, 6 * tw, 4, 0), "#ffffff");
      }
      return;
    }
    case "dust": {
      for (let i = 0; i < 5; i += 1) {
        const p = (t * 0.9 + i / 5) % 1;
        const a = (i / 5) * TAU;
        pen.circle(Math.cos(a) * 60 * (0.4 + p), -30 - p * 60 + Math.sin(a) * 20, 30 + p * 40, c("#d8c3a0"), 0.6 * (1 - p));
      }
      return;
    }
    case "snow":
    case "rain":
    case "fog":
    case "car":
    case "truck":
      return;
  }
}

function drawDeer(pen: Pen, st: PropState, view: "side" | "top", t: number): void {
  const fur = hex(st.prop.color, "#b9773f");
  const belly = "#f3d9b8";
  if (view === "top") {
    pen.ellipse(0, 0, 60, 120, 0, INK);
    pen.ellipse(0, 0, 54, 114, 0, fur);
    pen.circle(0, -128, 36, INK);
    pen.circle(0, -128, 30, fur);
    pen.line([-14, -150, -46, -190, -60, -172], 8, "#7a4a2a");
    pen.line([14, -150, 46, -190, 60, -172], 8, "#7a4a2a");
    return;
  }
  const run = st.speed > 0.02;
  const ph = t * (run ? 9 : 0);
  const legs: [number, number][] = [
    [-80, 1],
    [-50, -1],
    [60, -1],
    [90, 1],
  ];
  for (const [lx, s] of legs) {
    const a = run ? Math.sin(ph) * 28 * s : 0;
    const fx = lx + Math.sin(a * DEG) * 150;
    const fy = -150 + Math.cos(a * DEG) * 150;
    pen.line([lx, -150, fx, fy], 22, INK);
    pen.line([lx, -150, fx, fy], 14, shade(fur, -0.1));
  }
  pen.ellipse(0, -190, 150, 70, 0, INK);
  pen.ellipse(0, -190, 142, 62, 0, fur);
  pen.ellipse(10, -165, 90, 28, 0, belly, 0.8);
  pen.poly(inflate([90, -230, 140, -330, 175, -320, 135, -210], 6), INK);
  pen.poly([90, -230, 140, -330, 175, -320, 135, -210], fur);
  pen.ellipse(172, -348, 52, 38, 15, INK);
  pen.ellipse(172, -348, 45, 31, 15, fur);
  pen.ellipse(214, -334, 14, 11, 0, "#1c1842");
  pen.ellipse(150, -384, 14, 26, -30, fur);
  pen.circle(174, -356, 9, "#ffffff");
  pen.circle(177, -356, 5.5, "#1c1842");
  pen.line([160, -380, 150, -450, 120, -480], 9, "#7a4a2a");
  pen.line([150, -450, 180, -478], 8, "#7a4a2a");
  pen.line([184, -382, 200, -450, 230, -470], 9, "#7a4a2a");
  pen.ellipse(-150, -210, 22, 16, -20, "#ffffff");
}

/** Full-screen weather in screen space: snow flakes, rain streaks and fog bands, split into a back and a front layer.
 * The 1080 × 1920 counts cover any shape (they all have about the same area or less). */
export function drawWeather(pen: Pen, kind: "snow" | "rain" | "fog", t: number, seed: number, layer: "back" | "front", amount: number): void {
  const W = F.w;
  const H = F.h;
  const n = Math.round(amount * (layer === "back" ? 22 : 14));
  if (kind === "snow") {
    for (let i = 0; i < n; i += 1) {
      const s = seed + (layer === "back" ? 100 : 200);
      const r = (layer === "back" ? 5 : 9) + rand(s, i) * (layer === "back" ? 5 : 8);
      const v = (layer === "back" ? 110 : 190) + rand(s, i + 70) * 90;
      const x0 = rand(s, i + 140) * (W + 200) - 100;
      const y = ((rand(s, i + 210) * (H + 100) + v * t) % (H + 100)) - 50;
      const x = x0 + Math.sin(t * 1.3 + i) * 26 + t * 18;
      pen.circle(((x % (W + 200)) + W + 200) % (W + 200) - 100, y, r, "#ffffff", layer === "back" ? 0.75 : 0.92);
    }
    return;
  }
  if (kind === "rain") {
    for (let i = 0; i < n + 4; i += 1) {
      const s = seed + (layer === "back" ? 300 : 400);
      const len = (layer === "back" ? 60 : 100) + rand(s, i) * 40;
      const v = 1700 + rand(s, i + 70) * 500;
      const x = rand(s, i + 140) * (W + 300) - 150;
      const y = ((rand(s, i + 210) * (H + 200) + v * t) % (H + 200)) - 100;
      pen.line([x, y, x - len * 0.22, y + len], layer === "back" ? 3 : 5, "#dbe9ff", layer === "back" ? 0.4 : 0.55);
    }
    return;
  }
  const bands = layer === "back" ? 3 : 1;
  for (let i = 0; i < bands; i += 1) {
    const s = seed + 500;
    const yy = (layer === "back" ? 700 + i * 260 + rand(s, i) * 80 : 1500) * F.sy;
    const drift = ((t * (30 + i * 14) + rand(s, i + 9) * W) % (W * 2)) - W * 0.5;
    pen.ellipse(drift, yy, 900, 170, 0, "#f2f5f8", (layer === "back" ? 0.32 : 0.2) * amount);
    pen.ellipse(drift - W, yy + 60, 900, 150, 0, "#f2f5f8", (layer === "back" ? 0.26 : 0.16) * amount);
  }
}
