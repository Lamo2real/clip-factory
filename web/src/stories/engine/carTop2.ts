// Clips Funded engine: the detailed vehicle's top view, both styles (CONTRACTS §45.48 section 2.7). car.ts calls it for
// a look with `detail`. The plan comes from `topShape2` (the same numbers as the side view: the wheels at the real axles,
// the screen, roof and deck at the profile's landmarks); this file paints it. Bright never calls `glow` and never reads
// the light; Night drive keeps graded colours, the soft ink, a constant 2.6 px outline, and the lamps' cores and glows.
// A bike, a plane or a boat has no detailed plan: it draws as its classic self.

import { ND, grade, haloStops, lineUnits, nightDrive } from "./art.ts";
import {
  PLATE,
  GLASS,
  GLASS_ND,
  LENS_OFF,
  TAIL_OFF,
  beamGlow,
  burst,
  carFace,
  classicLook,
  drawCarLookTop,
  exhaust,
  honkWaves,
  impact,
  lightGlow,
  outlined,
  carSpec,
  styleOf as moveStyle,
  topEye,
  type CarDraw,
} from "./car.ts";
import { resolveDetail, type Resolved } from "./carDetail.ts";
import { styleOf, type Sty } from "./carParts.ts";
import { roundPath, topShape2, type CP, type Top2 } from "./carShape.ts";
import { blink as blinkAt, type FaceParams } from "./face.ts";
import { F } from "./frame.ts";
import { DEG, clamp, clamp01, hex, lerp, mix, noise } from "./math.ts";
import { arcPts, clipConvex, joinShapes, type Pen } from "./pen.ts";
import type { Occupants, PropState } from "./props.ts";

const cp = (x: number, y: number, r = 0): CP => ({ x, y, r });
const DARK = "#15161a";

/** The body's half width at plan height `y` (nose up), read off the right half's control points. */
function halfWidthAt(g: Top2, y: number): number {
  const h = g.half;
  if (h.length === 0) return g.hw;
  if (y <= h[0]!.y) return h[0]!.x;
  for (let i = 1; i < h.length; i += 1) {
    const a = h[i - 1]!;
    const b = h[i]!;
    if (y <= b.y) return lerp(a.x, b.x, b.y === a.y ? 1 : (y - a.y) / (b.y - a.y));
  }
  return h[h.length - 1]!.x;
}

/** Where the exhaust tips sit across the tail (fractions of the half width), by layout. */
export function exhaustTips(layout: Resolved["rear"]["exhaust"]): number[] {
  switch (layout) {
    case "single":
      return [0.3];
    case "twin":
      return [-0.22, 0.22];
    case "quad":
      return [-0.34, -0.14, 0.14, 0.34];
    case "centre":
      return [0];
    case "high":
      return [-0.2, 0.2];
    default:
      return [];
  }
}

/** A tier of detail: its parts are drawn at alpha `a` (dropped by the pen when nearly clear). */
function tier(pen: Pen, a: number, fn: () => void): void {
  if (a < 0.02) return;
  pen.save();
  pen.fade(a);
  fn();
  pen.restore();
}

/** Top-down detailed car of the cast: nose up before its heading; origin at its centre. */
export function drawCarLookTop2(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  const car = d.car;
  if (car.detail === undefined || carSpec(car.body).form !== undefined) {
    drawCarLookTop(pen, st, k, t, { ...d, car: classicLook(car) }, occ, night);
    return;
  }
  const R = resolveDetail(car);
  const g = topShape2(car);
  const { L, Wd, hw, rw, p } = g;
  const open = g.open;
  const ms = moveStyle(d.style);
  const nd = nightDrive();
  const light = F.light;
  const size = (k * pen.unit()) / F.k;
  const S: Sty = styleOf(pen, k, car, R, size);
  const med = S.fade(0.2, 0.42);
  const fine = S.fade(0.42, 0.7);
  const u = Wd / 196;

  const paint = S.t(hex(car.paint, "#d8352a"));
  const accent = S.t(hex(car.accent, "#f4f1ea"));
  const trim = S.t(R.trim);
  const tyre = S.tyre;
  const glass = nd ? grade(GLASS_ND[car.windows] ?? GLASS_ND.clear) : (GLASS[car.windows] ?? GLASS.clear).glass;
  const roofGlass = nd ? mix(glass, ND.celDark, 0.45) : (GLASS[car.windows] ?? GLASS.clear).roof;
  const tintA = car.windows === "clear" ? 0.12 : (GLASS[car.windows] ?? GLASS.clear).a;
  const face = carFace(st.face, car);
  const dark = night || (nd && light.night);
  const lit = st.lights || dark || st.blink > 0.3;
  const beam = st.lights || night;
  const braking = st.braking > 0.1;
  const tailOn = st.lights || dark;

  // skid marks first (world frame, under the car)
  const mark = nd ? grade("#1d1d26") : "#1d1d26";
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
  // the outline's width in the scaled frame: Night drive's is a fixed 2.6 output px, Bright's scales with the car
  const ow = nd ? lineUnits(pen, 2.6) / k : 7;
  pen.scale(k, k);
  if (st.speed > 0.06 * ms.lines) {
    const streak = nd ? grade("#ffffff") : "#ffffff";
    for (let i = -1; i <= 1; i += 1) {
      const len = 160 * clamp01(st.speed * 2.5);
      pen.line([i * 60, L / 2 + 40, i * 60, L / 2 + 40 + len], 10, streak, 0.5);
    }
  }
  // the beam goes under the body
  if (beam) {
    if (nd) beamGlow(pen, 0, -L / 2, 520, 230, night ? 0.08 : 0.05, true);
    else pen.poly([-70, -L / 2, 70, -L / 2, 200, -L / 2 - 520, -200, -L / 2 - 520], "#fff3b0", 0.18);
  }
  // ground shadow
  if (nd) {
    pen.ellipse(8, 12, Wd / 2 + 30, L / 2 + 24, 0, ND.ao, 0.16);
    pen.ellipse(4, 6, Wd / 2 + 4, L / 2 + 2, 0, ND.ao, 0.38);
  } else pen.ellipse(10, 14, Wd / 2 + 16, L / 2 + 10, 0, "#000000", 0.2);

  // ---- the four wheels, the front pair turned with the steering ----
  const turn = clamp(st.wheelTurn, -40, 40);
  const flatTyre = nd ? grade("#55556a") : "#55556a";
  for (const w of g.wheels) {
    const isFlat = st.flat && w.front && w.x > 0;
    pen.save();
    pen.translate(w.x, w.y);
    if (w.front) pen.rotate(turn);
    const wl = isFlat ? w.l * 0.86 : w.l;
    pen.rect(-w.w / 2, -wl / 2, w.w, wl, 9 * u, isFlat ? flatTyre : tyre);
    tier(pen, med, () => {
      // the tread's lit shoulder on the outer side, and the sidewall's dark inner edge
      const o = Math.sign(w.x);
      pen.rect(o * (w.w / 2 - 6 * u) - 2.5 * u, -wl / 2 + 7 * u, 5 * u, wl - 14 * u, 2.5 * u, S.lt(tyre, 0.14));
    });
    pen.restore();
  }
  pen.scale(grow, grow);

  // ---- the body: outline, paint, the shade side or the lit top ----
  const shape = g.outline;
  pen.poly(outlined(shape, ow), S.ink);
  pen.poly(shape, paint);
  if (nd) pen.poly(clipConvex(shape, [Wd * 0.22, -L, Wd, -L, Wd, L, Wd * 0.22, L]), S.dk(paint, 0.22));
  const cowlY = g.yT(p.cowlX);
  const headY = g.yT(p.headX);
  const roofY = g.yT(p.roofX);
  const deckY = g.yT(p.deckX);
  const tipY = -L / 2;
  const tailY = L / 2;
  // a bonnet in the accent colour (a two tone), clipped to the plan
  if (R.twoTone === "bonnet") pen.poly(clipConvex(shape, [-Wd, tipY - 4, Wd, tipY - 4, Wd, cowlY, -Wd, cowlY]), accent);
  // the lit line down the bonnet (Bright: a light band; Night drive: a lifted one)
  const shine = 0.45 + 0.25 * S.gloss;
  pen.line([-hw * 0.34, tipY + 16, -hw * 0.42, cowlY - 8], 13 * u, nd ? S.lt(paint, 0.2) : S.lt(paint, 0.3), shine);

  // ---- bonnet parts and the nose ----
  const noseW = halfWidthAt(g, tipY + 8);
  tier(pen, med, () => {
    const v = R.bonnet.vent;
    const mid = lerp(tipY, cowlY, 0.55);
    if (v === "scoop") {
      pen.rect(-hw * 0.22, mid - 12 * u, hw * 0.44, 26 * u, 8 * u, S.dk(paint, 0.35));
      pen.rect(-hw * 0.18, mid - 12 * u, hw * 0.36, 7 * u, 3 * u, DARK);
    } else if (v === "bulge") pen.line([0, tipY + 24, 0, cowlY - 6], 22 * u, S.dk(paint, 0.12), 0.8);
    else if (v === "vents") for (const s of [-1, 1]) pen.rect(s * hw * 0.3 - 3 * u, mid - 14 * u, 6 * u, 30 * u, 3 * u, DARK);
    else if (v === "duct") {
      pen.rect(-hw * 0.5, cowlY - 24 * u, hw, 14 * u, 6 * u, DARK);
      pen.line([-hw * 0.32, cowlY - 17 * u, hw * 0.32, cowlY - 17 * u], 2 * u, S.lt(DARK, 0.25));
    }
    // the mouth in the nose's edge and the splitter standing proud of it
    if (R.front.intake !== "none" || R.front.grille !== "none") pen.rect(-noseW * 0.62, tipY + 1, noseW * 1.24, 7 * u, 3 * u, DARK);
    if (R.front.splitter === "blade") pen.rect(-noseW * 0.95, tipY - 5 * u, noseW * 1.9, 6 * u, 3 * u, DARK);
    else if (R.front.splitter === "lip") pen.rect(-noseW * 0.85, tipY - 2 * u, noseW * 1.7, 3.5 * u, 1.7 * u, DARK);
    if (R.front.bumper !== "body") pen.rect(-noseW * 0.9, tipY + 9 * u, noseW * 1.8, 4 * u, 2 * u, R.front.bumper === "chrome" ? S.t("#d9dde3") : DARK);
  });

  // ---- the stripe over the bonnet (the cockpit is skipped, the stripe runs on over the deck) ----
  const sc = S.t(R.stripe.color);
  const sw = clamp(R.stripe.width / 50, 0.35, 1.7);
  const lay = R.stripe.layout;
  const bands: [number, number][] = [];
  if (lay === "centre") bands.push([0, Wd * 0.17 * sw]);
  else if (lay === "twin")
    for (const s of [-1, 1]) bands.push([s * Wd * 0.11, Wd * 0.07 * sw]);
  else if (lay === "offset") bands.push([Wd * 0.14, Wd * 0.15 * sw]);
  const segment = (y0: number, y1: number): void => {
    if (y1 - y0 < 3) return;
    for (const [bx, bw] of bands) pen.rect(bx - bw / 2, y0, bw, y1 - y0, Math.min(4 * u, bw / 2), sc);
  };
  segment(tipY + 5, cowlY - 1);
  const hoopsEnd = lerp(roofY, deckY, 0.9);
  segment(open ? (R.roof.hoops !== "none" ? hoopsEnd : roofY + 2) : deckY, tailY - 6);

  // ---- mirrors on the screen's foot ----
  if (R.side.mirror !== "none") {
    const mc = S.t(R.mirrorColor);
    for (const s of [-1, 1]) {
      if (R.side.mirror === "square") pen.rect(s * (hw + 8) - 6 * u, cowlY + 4 * u, 12 * u, 22 * u, 4 * u, mc);
      else pen.ellipse(s * (hw + 6), cowlY + 14 * u, (R.side.mirror === "ear" ? 9 : 11) * u, 16 * u, 0, mc);
      if (R.side.mirror === "stalk") tier(pen, med, () => pen.line([s * (hw - 4), cowlY + 10 * u, s * (hw + 4), cowlY + 14 * u], 4 * u, trim));
    }
  }

  // ---- the windscreen: a frame and the glass ----
  pen.poly(outlined(g.screen, 5 * u), trim);
  pen.poly(g.screen, g.open ? mix(glass, "#0c1722", nd ? 0.62 : 0.7) : glass);
  tier(pen, fine, () => {
    pen.line([-hw * 0.5, cowlY + 6 * u, -hw * 0.38, headY - 5 * u], 6 * u, "#ffffff", nd ? 0.12 : 0.3);
  });

  // ---- the cockpit or the roof ----
  const seatsAt = g.seats;
  const heads = (): { x: number; y: number; r: number }[] => {
    const span = Math.max(8, roofY - headY);
    if (seatsAt.length === 2 && seatsAt[0]!.x !== 0) return seatsAt.map((s, i) => ({ x: s.x, y: s.y, r: Math.min(i === 0 ? 30 : 28, span * 0.34, rw * 0.42) }));
    return seatsAt.map((s, i) => ({ x: 0, y: s.y, r: Math.min(i === 0 ? 34 : 30, span * 0.3) }));
  };
  const rails = R.roof.rails || R.extras.includes("roof_rails");
  if (open) {
    // the tub, the two seats side by side, the hoops behind them, the heads
    const span = roofY - headY;
    pen.rect(-rw, headY + 3 * u, 2 * rw, span + 6 * u, 16 * u, S.t("#0c0c0e"));
    const seatCol = S.t(R.cabin.seat ?? "#2a2a30");
    const sy0 = headY + 0.2 * span;
    const sy1 = headY + 0.96 * span;
    const seatW = rw * 0.4;
    pen.poly(joinShapes(seatsAt.map((s) => roundPath([cp(s.x - seatW, sy0, 9 * u), cp(s.x + seatW, sy0, 9 * u), cp(s.x + seatW, sy1, 7 * u), cp(s.x - seatW, sy1, 7 * u)]))), seatCol);
    tier(pen, med, () => {
      // the dash across the screen's foot of the tub and a lit seat edge
      pen.rect(-rw + 3 * u, headY + 4 * u, 2 * rw - 6 * u, 0.15 * span + 2, 4 * u, S.lt("#0c0c0e", 0.12));
      for (const s of seatsAt) pen.line([s.x - seatW + 5 * u, sy0 + 3 * u, s.x - seatW + 5 * u, sy1 - 8 * u], 3 * u, S.lt(seatCol, 0.18), 0.7);
    });
    occ.top?.(pen, heads());
    if (R.side.crease === "wedge") {
      // sculpted flanks: two raised humps down the engine cover with a flat panel between, a big dark intake blade on each
      // shoulder behind the door, and a lit crown over each front wheel
      const hump0 = roofY + 0.3 * (deckY - roofY);
      tier(pen, med, () => {
        for (const s of [-1, 1]) {
          pen.line([s * hw * 0.5, hump0, s * hw * 0.46, tailY - 26 * u], 15 * u, S.lt(paint, 0.12), 0.75);
          pen.line([s * hw * 0.74, lerp(roofY, deckY, 0.15), s * hw * 0.7, tailY - 30 * u], 8 * u, S.dk(paint, 0.12), 0.6);
          pen.line([s * hw * 0.7, tipY + 40 * u, s * hw * 0.78, cowlY - 6 * u], 11 * u, S.lt(paint, 0.28), 0.7);
        }
      });
      const ix0 = roofY + 0.05 * (deckY - roofY);
      const ix1 = lerp(roofY, deckY, 0.9);
      pen.poly(joinShapes([-1, 1].map((s) => roundPath([cp(s * hw * 0.98, ix0, 5 * u), cp(s * hw * 0.78, ix0 + 6 * u, 8 * u), cp(s * hw * 0.7, ix1, 6 * u), cp(s * hw * 0.9, ix1 - 12 * u, 8 * u)]))), DARK);
    }
    if (R.roof.hoops === "twin") {
      const hy = lerp(roofY, deckY, 0.9);
      pen.poly(joinShapes([-1, 1].map((s) => roundPath([cp(s * rw * 0.1, roofY, 6 * u), cp(s * rw * 0.95, roofY, 6 * u), cp(s * rw * 0.7, hy, 14 * u), cp(s * rw * 0.25, hy, 14 * u)]))), S.dk(paint, 0.22));
      tier(pen, med, () => { for (const s of [-1, 1]) pen.line([s * rw * 0.5, roofY + 6 * u, s * rw * 0.5, hy - 8 * u], 3 * u, S.lt(paint, 0.12), 0.8); });
    } else if (R.roof.hoops === "bar") pen.rect(-rw, roofY - 2 * u, 2 * rw, 12 * u, 5 * u, S.dk(paint, 0.1));
    tier(pen, med, () => pen.line([-hw * 0.78, deckY - 2 * u, hw * 0.78, deckY - 2 * u], 2.4 * u, S.dk(paint, 0.3), 0.8));
  } else {
    const roofSpan = Math.max(6, roofY - headY - 6 * u);
    const painted = R.roof.type === "closed" || R.roof.type === "soft_top" || R.roof.type === "sunroof";
    const fabric = R.roof.type === "soft_top";
    const roofFill = R.roof.type === "glass" ? roofGlass : fabric ? S.t(R.roof.color ?? "#2a2a30") : R.twoTone === "roof" || R.roof.color ? S.t(R.roof.color ?? hex(car.accent)) : S.lt(paint, 0.1);
    if (R.twoTone === "roof") pen.rect(-rw - 4 * u, headY - 2 * u, 2 * rw + 8 * u, roofY - headY + 4 * u, 26 * u, accent);
    pen.rect(-rw, headY + 3 * u, 2 * rw, roofSpan, 26 * u, roofFill);
    if (R.roof.type === "sunroof") pen.rect(-rw * 0.62, headY + 12 * u, rw * 1.24, Math.max(6, roofSpan - 18 * u), 14 * u, roofGlass);
    // the riders: seen through a glass roof, faintly through a painted one
    if (painted && R.roof.type !== "sunroof") tier(pen, 0.55, () => occ.top?.(pen, heads()));
    else occ.top?.(pen, heads());
    if (R.roof.type === "glass" || R.roof.type === "sunroof") pen.rect(-rw * (R.roof.type === "glass" ? 1 : 0.62), headY + 3 * u, 2 * rw * (R.roof.type === "glass" ? 1 : 0.62), roofSpan, 22 * u, glass, tintA);
    // the roof's lit edge and its seam lines
    tier(pen, fine, () => {
      pen.line([-rw + 5 * u, headY + 18 * u, -rw + 5 * u, roofY - 16 * u], 5 * u, "#ffffff", nd ? 0.1 : 0.25);
    });
    if (rails) tier(pen, med, () => { for (const s of [-1, 1]) pen.line([s * rw * 0.84, headY + 10 * u, s * rw * 0.84, roofY - 10 * u], 4 * u, S.t("#c9ccd2")); });
    if (R.stripe.layout !== "none" && lay !== "side" && lay !== "sill" && lay !== "pin") segment(headY + 3 * u, roofY - 3 * u);
    // the rear glass, or a pickup's bed
    if (car.body === "pickup") pen.rect(-Wd / 2 + 14 * u, deckY + 10 * u, Wd - 28 * u, tailY - 16 * u - (deckY + 10 * u), 10 * u, S.dk(paint, 0.38));
    else if (g.rearGlass) pen.poly(g.rearGlass, glass);
  }

  // ---- roof and tail extras ----
  const ex = R.extras;
  tier(pen, med, () => {
    if (!open && ex.includes("light_bar")) {
      pen.rect(-rw * 0.7, headY + 5 * u, rw * 1.4, 9 * u, 4 * u, DARK);
      pen.rect(-rw * 0.6, headY + 7 * u, rw * 1.2, 4 * u, 2 * u, S.t("#fff3b0"));
    }
    if (!open && ex.includes("roof_scoop")) pen.rect(-rw * 0.3, headY + 0.5 * (roofY - headY), rw * 0.6, 12 * u, 5 * u, DARK);
    if (ex.includes("wing_lamps")) for (const s of [-1, 1]) pen.circle(s * hw * 0.8, cowlY - 14 * u, 7 * u, S.t("#fff3b0"));
    if (ex.includes("bull_bar")) pen.line([-hw * 0.4, tipY - 8 * u, hw * 0.4, tipY - 8 * u], 7 * u, S.t("#d9dde3"));
    if (ex.includes("tow_hook")) pen.rect(-5 * u, tailY - 2, 10 * u, 9 * u, 3 * u, DARK);
    if (ex.includes("snorkel")) pen.line([hw * 0.86, cowlY - 6 * u, hw * 0.86, headY], 5 * u, DARK);
  });
  tier(pen, fine, () => {
    if (ex.includes("antenna")) pen.circle(rw * 0.7, roofY - 10 * u, 3 * u, DARK);
    if (ex.includes("shark_fin") && !open) pen.ellipse(0, roofY - 12 * u, 5 * u, 11 * u, 0, S.dk(paint, 0.3));
  });
  if (ex.includes("spare_wheel")) pen.rect(-hw * 0.4, tailY - 2, hw * 0.8, 16 * u, 6 * u, tyre);
  // the spoiler across the tail
  const sp = R.rear.spoiler;
  if (sp === "wing" || sp === "big_wing") {
    const wy = tailY - (sp === "big_wing" ? 36 : 30) * u;
    for (const s of [-1, 1]) pen.line([s * hw * 0.55, wy + 10 * u, s * hw * 0.55, tailY - 14 * u], 4 * u, S.dk(paint, 0.4));
    pen.rect(-Wd / 2 - (sp === "big_wing" ? 6 : 0) * u, wy, Wd + (sp === "big_wing" ? 12 : 0) * u, (sp === "big_wing" ? 17 : 13) * u, 6 * u, S.dk(paint, 0.35));
  } else if (sp === "ducktail" || sp === "lip") {
    const tw = halfWidthAt(g, tailY - 14 * u) * 0.9;
    pen.rect(-tw, tailY - (sp === "ducktail" ? 15 : 9) * u, 2 * tw, (sp === "ducktail" ? 12 : 6) * u, 4 * u, S.dk(paint, 0.28));
  } else if (sp === "roof" && !open) pen.rect(-rw * 0.9, roofY - 4 * u, rw * 1.8, 7 * u, 3 * u, S.dk(paint, 0.3));

  // ---- exhaust tips and the diffuser's dark rake at the tail ----
  const tips = exhaustTips(R.rear.exhaust);
  tier(pen, med, () => {
    for (const f of tips) pen.ellipse(f * hw, tailY - 2, 7 * u, 4.5 * u, 0, DARK);
    if (R.rear.diffuser !== "none") pen.rect(-hw * 0.42, tailY - 7 * u, hw * 0.84, 6 * u, 2 * u, DARK, 0.9);
    if (R.rear.bumper !== "body") pen.rect(-halfWidthAt(g, tailY - 10) * 0.9, tailY - 12 * u, halfWidthAt(g, tailY - 10) * 1.8, 4 * u, 2 * u, R.rear.bumper === "chrome" ? S.t("#d9dde3") : DARK);
  });

  // ---- lamps: front pair, rear pair, plain plates ----
  const frontCol = nd ? (lit ? ND.headCore : grade(LENS_OFF)) : lit ? "#fff3b0" : "#ffe08a";
  const lens = R.lights.front.lens;
  const headCol = lit ? frontCol : lens === "yellow" ? S.t("#ffd34d") : lens === "smoked" ? S.t("#a79a6a") : frontCol;
  const fy = tipY + 13 * u;
  const fx = Math.min(hw * (0.62 - p.taperF / 250), halfWidthAt(g, fy) - 14 * u);
  const frontLamp = (s: number): void => {
    const x = s * fx;
    switch (R.lights.front.shape) {
      case "round":
        pen.ellipse(x, fy, 18 * u, 11 * u, 0, headCol);
        break;
      case "twin_round":
        for (const o of [-1, 1]) pen.ellipse(x + o * 9 * u, fy, 9 * u, 8 * u, 0, headCol);
        break;
      case "oval":
        pen.ellipse(x, fy, 22 * u, 9 * u, 0, headCol);
        break;
      case "square":
        pen.rect(x - 17 * u, fy - 9 * u, 34 * u, 18 * u, 5 * u, headCol);
        break;
      case "rect":
        pen.rect(x - 22 * u, fy - 7 * u, 44 * u, 14 * u, 4 * u, headCol);
        break;
      case "slim":
        pen.rect(x - 26 * u, fy - 5 * u, 52 * u, 10 * u, 5 * u, headCol);
        break;
      case "swept":
        // a slim lamp swept back along the wing: its outer end lower down the plan
        pen.poly([x - s * 16 * u, fy - 5 * u, x + s * 14 * u, fy + 2 * u, x + s * 14 * u, fy + 8 * u, x - s * 16 * u, fy + 1 * u], S.t("#14161b"));
        pen.ellipse(x - s * 9 * u, fy - 0.5 * u, 4.5 * u, 3.2 * u, 0, headCol);
        break;
      case "angled":
        pen.poly([x - 24 * u, fy - 6 * u, x + 24 * u, fy - 6 * u, x + 20 * u, fy + 7 * u, x - 20 * u, fy + 2 * u], headCol);
        break;
      case "stacked":
        pen.rect(x - 16 * u, fy - 10 * u, 32 * u, 8 * u, 3 * u, headCol);
        pen.rect(x - 16 * u, fy + 1 * u, 32 * u, 8 * u, 3 * u, headCol);
        break;
      case "pop_up":
        pen.rect(x - 15 * u, fy - 8 * u, 30 * u, 16 * u, 5 * u, headCol);
        pen.line([x - 15 * u, fy, x + 15 * u, fy], 2 * u, S.dk(headCol, 0.3));
        break;
      default:
        pen.rect(x - 34 * u, fy - 3.5 * u, 68 * u, 7 * u, 3.5 * u, headCol);
    }
    if (nd && lit) pen.glow(x, fy, 45, 45, ND.headBloom, haloStops(1, 0.3, 1.6), dark ? 0.5 : 0.25);
  };
  for (const s of [-1, 1]) frontLamp(s);

  const ry = tailY - 12 * u;
  const rx = Math.min(0.33 * Wd, halfWidthAt(g, ry) - 14 * u);
  const rl = R.lights.rear.lens;
  const tailCol = nd ? (braking ? ND.brakeCore : tailOn ? ND.tailCore : grade(rl === "smoked" ? "#4a2226" : rl === "clear" ? "#e9d8d6" : TAIL_OFF)) : braking ? "#ff2d2d" : tailOn ? "#e0303a" : rl === "smoked" ? "#6a2a30" : rl === "clear" ? "#e9d8d6" : "#b3262d";
  const rearLamp = (s: number): void => {
    const x = s * rx;
    switch (R.lights.rear.shape) {
      case "round":
        pen.ellipse(x, ry, 11 * u, 4.5 * u, 0, tailCol);
        break;
      case "twin_round":
        for (const o of [-1, 1]) pen.ellipse(x + o * 9 * u, ry, 7 * u, 4 * u, 0, tailCol);
        break;
      case "square":
        pen.rect(x - 15 * u, ry - 7 * u, 30 * u, 13 * u, 4 * u, tailCol);
        break;
      case "rect":
        pen.rect(x - 18 * u, ry - 6 * u, 36 * u, 12 * u, 5 * u, tailCol);
        break;
      case "tall":
        pen.rect(x - 7 * u, ry - 12 * u, 14 * u, 22 * u, 4 * u, tailCol);
        break;
      case "slim":
        pen.rect(x - 20 * u, ry - 4 * u, 40 * u, 8 * u, 4 * u, tailCol);
        break;
      case "wedge":
        pen.poly([x - s * 18 * u, ry - 7 * u, x + s * 18 * u, ry - 3 * u, x + s * 18 * u, ry + 7 * u, x - s * 18 * u, ry + 5 * u], tailCol);
        break;
      default:
        pen.line(arcPts(x, ry, 11 * u, 8 * u, s > 0 ? -70 : 110, s > 0 ? 70 : 250, 6), 5 * u, tailCol);
    }
    if (nd && (tailOn || braking)) pen.glow(x, ry + 4, 54, 54, ND.tailGlow, haloStops(1, 0.3, 1.6), Math.min(1, Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * st.braking : 0) * 1.5));
    else if (braking) pen.circle(x, ry + 6, 40, "#ff3b30", 0.32 * st.braking);
  };
  if (R.lights.rear.shape === "bar" || R.lights.rear.shape === "split_bar") {
    // one bar across the tail (split: a gap in the middle), kept inside the plan
    const bw = halfWidthAt(g, ry) - 12 * u;
    if (R.lights.rear.shape === "bar") pen.rect(-bw, ry - 6 * u, 2 * bw, 12 * u, 5 * u, tailCol);
    else for (const s of [-1, 1]) pen.rect(s > 0 ? 6 * u : -bw, ry - 6 * u, bw - 6 * u, 12 * u, 5 * u, tailCol);
    if (nd && (tailOn || braking)) for (const s of [-1, 1]) pen.glow(s * bw * 0.55, ry + 4, 54, 54, ND.tailGlow, haloStops(1, 0.3, 1.6), Math.min(1, Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * st.braking : 0) * 1.5));
    else if (braking) for (const s of [-1, 1]) pen.circle(s * bw * 0.55, ry + 6, 40, "#ff3b30", 0.32 * st.braking);
  } else for (const s of [-1, 1]) rearLamp(s);
  lightGlow(pen, -fx, fy, st.blink, 0.8);
  lightGlow(pen, fx, fy, st.blink, 0.8);
  // a plate seen from above is edge on: a thin sliver across the end, not a bar
  const plateTop = nd ? grade(PLATE) : PLATE;
  pen.rect(-24 * u, tipY - 1.5, 48 * u, 3, 1, plateTop);
  pen.rect(-24 * u, tailY - 1.5, 48 * u, 3, 1, plateTop);

  // ---- the face: eyes on the windscreen, small ----
  if (face && car.face.eyes === "windscreen") {
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
    const cy = (cowlY + headY) / 2;
    const er = clamp(Math.abs(headY - cowlY) * 0.26, 9, 20);
    const iris = nd ? grade(hex(car.face.color, "#1c1842")) : hex(car.face.color, "#1c1842");
    const eyeFace: FaceParams = { ...face, lookX: 0, lookY: -0.6 };
    for (const s of [-1, 1]) topEye(pen, s * 0.17 * Wd, cy, er, eyeFace, closedBy, iris, S.ink, nd ? grade("#ffffff") : "#ffffff");
  }
  honkWaves(pen, 0, tipY - 18, st.honkAge, 1, -90);
  const puffX = tips.length > 0 ? (tips.reduce((a, b) => a + b, 0) / tips.length) * hw : 0;
  exhaust(pen, puffX, tailY + 18, st.puffAge, st.stallAge, 1, 0, 1);
  pen.restore();

  // effects at the front-right wheel (burst) and the nose (bump), in the car's heading
  const h = st.rot * DEG;
  const at = (lx: number, ly: number): [number, number] => [(lx * Math.cos(h) - ly * Math.sin(h)) * k, (lx * Math.sin(h) + ly * Math.cos(h)) * k];
  const fw = g.wheels.find((w) => w.front && w.x > 0) ?? g.wheels[0]!;
  const [bx, by] = at(fw.x, fw.y);
  burst(pen, bx, by, st.burstAge, k, 9, false);
  const [ix, iy] = at(0, tipY - 20);
  impact(pen, ix, iy, st.bumpAge, k);
}
