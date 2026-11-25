// Clips Funded engine: the detailed vehicle's side view, both styles (CONTRACTS §45.48 section 3). car.ts calls it for
// a look with `detail`. One drawer for Bright and Night drive: the same parts, painted through the palette object of
// carParts.ts (`styleOf`), the wheels through carWheels.ts. It owns the draw order, the body frame (the springs and the
// honk pulse move the body, never the wheels), the riders and the door skin painted again over them, the glows, the face
// and the effects. The shapes come from carShape.ts (`sideShape`, `lampAt`): this file only paints them.
//
// Level of detail is an alpha fade (`Sty.fade`): a part's alpha is multiplied by smoothstep(lo, hi, size), so a zooming
// camera never pops a part in, and the pen already drops a prim under alpha 0.004. Bright never calls `glow` and never
// reads `F.light`; Night drive keeps graded colours, the amber marker, the lens cores and a constant 2.6 px outline.
// No logo, badge or lettering is ever drawn: a plate is two plain rectangles.

import { beamGlow, bikeSide, bloom, boatSide, burst, carBrows, carEye, exhaust, faceOf, GRILLE, honkWaves, impact, LENS_OFF, lightGlow, MOUTH_CURVE, MOUTH_DARK, outlined, styleOf as moveStyle, tailGlow, TAIL_OFF, waterSide, wingSide, type CarDraw, type Side } from "./car.ts";
import { ink as softInk, lineUnits, ND, nightDrive } from "./art.ts";
import { wheelSide2 } from "./carWheels.ts";
import * as P from "./carParts.ts";
import { partCtx, styleOf, type PartCtx, type Sty } from "./carParts.ts";
import { lampAt, sideShape, type Side2 } from "./carShape.ts";
import { blink as blinkAt } from "./face.ts";
import { F } from "./frame.ts";
import { clamp, clamp01, hex, lerp, noise, TAU } from "./math.ts";
import { clipConvex, joinShapes, quadPts } from "./pen.ts";
import type { Pen } from "./pen.ts";
import type { Occupants, PropState } from "./props.ts";
import type { CarLook } from "./types.ts";

type Pt = [number, number];

const GLASS_BRIGHT: Record<CarLook["windows"], { glass: string; tint: string; a: number }> = {
  clear: { glass: "#bfe3f2", tint: "#bfe9ff", a: 0.22 },
  tinted: { glass: "#5f7a8c", tint: "#5f7a8c", a: 0.25 },
  dark: { glass: "#2b3440", tint: "#2b3440", a: 0.4 },
};
const GLASS_NIGHT: Record<CarLook["windows"], string> = { clear: "#3e6e7f", tinted: "#2c4a57", dark: "#1c2830" };
const GLOSS = { gloss: 1, metallic: 1.15, satin: 0.55, matte: 0.25 } as const;
const DARK = "#17181d";

/** The x range of a polygon at a height (the widest crossing), or null. */
function xSpan(poly: number[], yy: number): [number, number] | null {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    const y0 = poly[i + 1]!;
    const y1 = poly[j + 1]!;
    if ((y0 <= yy && y1 > yy) || (y1 <= yy && y0 > yy)) xs.push(lerp(poly[i]!, poly[j]!, (yy - y0) / (y1 - y0)));
  }
  return xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null;
}

/** Side view car of the cast with a `detail`, facing +x before the facing mirror; origin on the ground between the wheels. */
export function drawCarLookSide2(pen: Pen, st: PropState, k: number, t: number, d: CarDraw, occ: Occupants, night: boolean): void {
  const car = d.car;
  const g = sideShape(car);
  const R = g.R;
  const nd = nightDrive();
  const form = g.arch.length === 0 ? g.spec.form : undefined;
  const ms = moveStyle(d.style);
  // the on-screen size of one design px of the car (the level of detail), taken before the car's own scale
  const size = (k * pen.unit()) / (F.k || 1);
  const S = styleOf(pen, k, car, R, size);
  const gloss = GLOSS[R.finish] ?? 1;
  // the line weights in the car's own px, taken before the facing mirror, so a spin's squeeze never thickens them
  const ow = nd ? lineUnits(pen, 2.6) / k : 7;
  const fine = nd ? Math.max(ow * 0.35, 0.9) : 2.4;
  const med = S.fade(0.2, 0.42);
  const fin = S.fade(0.42, 0.7);
  const faded = (a: number, fn: () => void): void => {
    if (a < 0.004) return;
    if (a >= 0.999) {
      fn();
      return;
    }
    pen.save();
    pen.fade(a);
    fn();
    pen.restore();
  };
  const face = faceOf(st, car);
  const moving = st.speed > 0.02 || st.rolled > 0;
  const bob = (moving ? Math.sin(t * TAU * 3.1) * 1.6 * ms.bob : 0) + (!moving && ms.sway ? Math.sin(t * TAU * 0.7) * ms.sway : 0);
  const dy = bob - st.bounce * 0.06 * g.tall;
  const spinF = (st.rolled / g.wr) % TAU;
  const spinR = (st.rolled / (g.wrRear || g.wr)) % TAU;
  const dark = nd ? night || F.light.night : night;
  const lit = st.lights || dark || st.blink > 0.3;
  const beam = st.lights || night;
  const tailOn = st.lights || dark;
  const braking = st.braking > 0.1;
  const pulse = st.honkAge >= 0 ? 1 + 0.035 * Math.sin(Math.PI * Math.min(1, st.honkAge / 0.3)) : 1;
  const wob = ms.wobble ? ms.wobble * noise(d.seed + 17, t * 1.6) : 0;
  const glassCol = (GLASS_BRIGHT[car.windows] ?? GLASS_BRIGHT.clear);
  const glass = nd ? S.t(GLASS_NIGHT[car.windows] ?? GLASS_NIGHT.clear) : glassCol.glass;
  const paint = S.t(hex(car.paint, "#d8352a"));
  const accent = S.t(hex(car.accent, "#f4f1ea"));
  const inkC = nd ? softInk(hex(car.outline, "#1c1842")) : hex(car.outline, "#1c1842");
  const trim = S.t(R.trim);
  const chrome = S.t("#d9dde3");
  const dk = S.t(DARK);
  const headEyes = face !== null && car.face.eyes === "headlights";
  const screenEyes = face !== null && car.face.eyes === "windscreen";
  // where the lamps' lenses are: one function, never two copies of the maths (the beam is drawn before the body)
  const hasFront = form === undefined ? R.fits.frontLight : true;
  const fl: Pt = form === undefined ? lampAt(g, "front") : formFront(g, form);
  const rl: Pt = form === undefined ? lampAt(g, "rear") : [-g.hl + 8, g.y(0.95)];
  const eyeRx = clamp(0.09 * g.tall, 14, 34);
  const eyeAt: Pt = headEyes ? [g.hl - eyeRx * 1.45, form === undefined ? fl[1] : g.y(0.7)] : fl;
  pen.save();
  pen.rotate(st.rot + wob);
  pen.scale(k * st.facing * st.spinX, k);
  // the headlights' beam (night drive), under the car's shadow and body so it never lights its own car
  if (nd && beam) beamGlow(pen, eyeAt[0], eyeAt[1] + dy, g.hl + 540 - eyeAt[0], 100, night ? 0.08 : 0.05);
  // the ground shadow, skid marks and skid smoke
  if (nd) {
    pen.ellipse(0, 7, g.hl + 30, 22, 0, ND.ao, 0.16);
    pen.ellipse(0, 3, g.hl - 10, 10, 0, ND.ao, 0.38);
  } else pen.ellipse(0, 4, g.hl + 8, 18, 0, "#000000", 0.18);
  const wheelXs = form === "boat" ? [] : [g.axRear, g.ax];
  if (st.skidFrom !== null) {
    const from = (st.skidFrom * st.facing) / k;
    for (const wx of wheelXs) pen.line([wx + from, -2, wx, -2], 16, S.t("#1d1d26"), 0.4);
  }
  if (st.skidding > 0.05) {
    for (let i = 0; i < 4; i += 1) {
      const ph = (t * 1.6 + i / 4) % 1;
      pen.circle(g.axRear - 15 - ph * 160, -20 - ph * 40, 26 + ph * 30, S.t("#e9eef5"), 0.55 * st.skidding * (1 - ph));
    }
  }
  // ---- the body moves on its springs; the wheels stay on the ground ----
  pen.save();
  pen.translate(0, dy + (form === undefined ? g.y(g.p.beltH) : g.y(1)));
  pen.scale(pulse, pulse);
  pen.translate(0, -(form === undefined ? g.y(g.p.beltH) : g.y(1)));
  const ctx: Ctx = { pen, g, R, S, nd, ow, fine, med, fin, faded, gloss, paint, accent, trim, chrome, dk, inkC, glass, glassCol, car, lit, st, occ };
  const pc = form === undefined ? bodyOfCar(ctx, { screenEyes }) : null;
  if (form !== undefined) bodyOfForm(ctx, form);
  // the lamps (the lens colours: a lit lens, an unlit one, a brake lens; nothing stays a tail lens while braking)
  const lensF = nd ? (lit ? ND.headCore : S.t(LENS_OFF)) : lit ? "#fff3b0" : "#ffe08a";
  const lensFOff = R.lights.front.lens === "yellow" ? S.t("#f2c94c") : R.lights.front.lens === "smoked" ? S.t("#4a4650") : lensF;
  const lensRBase = R.lights.rear.lens === "clear" ? S.t("#efe9e4") : R.lights.rear.lens === "smoked" ? S.t("#5a2a30") : S.t(TAIL_OFF);
  const lensR = nd ? (braking ? ND.brakeCore : tailOn ? ND.tailCore : lensRBase) : braking ? "#ff2d2d" : lensRBase;
  if (pc !== null) {
    const mouth = face !== null && car.face.mouth === "grille" ? face : null;
    P.noseTail(pc, mouth !== null);
    if (mouth !== null) faceMouth(ctx, mouth);
    else P.bonnetVent(pc);
    P.lamps(pc, { lit, tailOn, braking, front: hasFront && !headEyes, rear: R.fits.rearLight });
    P.tailPieces(pc);
    P.extras(pc);
  } else if (form !== undefined) {
    formLamps(ctx, form, lit ? lensF : lensFOff, lensR);
  }
  pen.restore();
  // ---- the wheels (the ground frame), rear then front ----
  if (form === "boat") waterSide(pen, g as unknown as Side, moving);
  else if (form === "plane") {
    const wr = g.wr * 0.5;
    wheelSide2(pen, g.axRear, -wr, wr, spinR, false, car, S.ink, ow);
    wheelSide2(pen, g.ax, -wr, wr, spinF, st.flat, car, S.ink, ow);
  } else {
    wheelSide2(pen, g.axRear, -(g.wrRear || g.wr), g.wrRear || g.wr, spinR, false, car, S.ink, ow);
    wheelSide2(pen, g.ax, -g.wr, g.wr, spinF, st.flat, car, S.ink, ow);
  }
  // ---- glows and the face, on the springs ----
  pen.save();
  pen.translate(0, dy);
  if (beam && !nd) pen.poly([eyeAt[0] + 10, eyeAt[1] - 6, g.hl + 540, eyeAt[1] - 90, g.hl + 540, eyeAt[1] + 130], "#fff3b0", 0.16);
  const gs = 0.06 * g.tall;
  if (nd) {
    if (lit && hasFront) bloom(pen, eyeAt[0], eyeAt[1], gs, (dark ? 1 : 0.5) * (headEyes ? 0.6 : 1));
    const tailA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * st.braking : 0);
    if (tailA > 0 && (form === undefined ? R.fits.rearLight : form === "bike")) tailGlow(pen, rl[0], rl[1], 0.05 * g.tall, tailA);
  } else if (braking && (form === undefined ? R.fits.rearLight : form === "bike")) pen.circle(rl[0], rl[1], 40, "#ff3b30", 0.35 * st.braking);
  lightGlow(pen, eyeAt[0], eyeAt[1], st.blink, 1);
  if (face) drawFace(ctx, face, d, t, headEyes, eyeAt, eyeRx, form);
  pen.restore();
  pen.restore();
  // ---- effects in the car's world frame (not mirrored twice) ----
  const f = st.facing;
  const yAt = (p: number): number => (form === undefined ? g.y(p) : g.y((p / 100) * 1.5));
  burst(pen, f * g.ax * k, -g.wr * k, st.burstAge, k, 7, true);
  impact(pen, f * (g.hl + 8) * k, (form === undefined ? g.y(g.p.tipH) : g.y(0.6)) * k, st.bumpAge, k);
  honkWaves(pen, f * (g.hl + 16) * k, ((form === undefined ? g.y(g.p.tipH) : g.y(0.7)) + dy) * k, st.honkAge, k, f > 0 ? 0 : 180);
  const exY = form !== undefined ? g.y(0.2) : R.rear.exhaust === "high" ? g.y(lerp(g.p.rumpH, g.p.tailH, 0.45)) : R.rear.exhaust === "stack" ? g.y(100) : g.y(g.p.rumpH + 3);
  exhaust(pen, -f * (g.hl + 12) * k, exY * k, st.puffAge, st.stallAge, k, -f * 0.9, -0.45);
  if (st.speed > 0.08 * ms.lines) {
    const streak = S.t("#ffffff");
    for (let i = 0; i < 3; i += 1) {
      const yy = lerp(yAt(75), yAt(25), i / 2) * k;
      const len = (120 + i * 40) * k * clamp01(st.speed * 2.5);
      const x0 = -f * (g.hl + 18) * k;
      pen.line([x0, yy, x0 - f * len, yy], 8 * k, streak, 0.55);
    }
  }
}

interface Ctx {
  pen: Pen;
  g: Side2;
  R: Side2["R"];
  S: Sty;
  nd: boolean;
  ow: number;
  fine: number;
  med: number;
  fin: number;
  faded: (a: number, fn: () => void) => void;
  gloss: number;
  paint: string;
  accent: string;
  trim: string;
  chrome: string;
  dk: string;
  inkC: string;
  glass: string;
  glassCol: { glass: string; tint: string; a: number };
  car: CarLook;
  lit: boolean;
  st: PropState;
  occ: Occupants;
}

/** Where the front lamp's lens is on a bike, a plane or a boat. */
function formFront(g: Side2, form: string): Pt {
  if (form === "plane") return [g.hl - 14, g.y(0.5)];
  if (form === "boat") return [g.hl * 0.8, g.y(0.62)];
  const [x, y] = frontLightPos(g);
  return [x, y];
}
function frontLightPos(g: Side2): Pt {
  const s = g.lowH / 136;
  return [g.hl - 20 * s, g.y(0.72)];
}

// ---------------------------------------------------------------------------------------------------------------------
// the car's body frame (section 3's draw order)
// ---------------------------------------------------------------------------------------------------------------------

function bodyOfCar(c: Ctx, o: { screenEyes: boolean }): PartCtx {
  const { pen, g, S, occ, glass } = c;
  const pc = partCtx(pen, g, S);
  P.bodyPaint(pc);
  P.stripes(pc);
  P.nightTop(pc);
  P.glassBack(pc);
  if (g.open && o.screenEyes) {
    // an open car with windscreen eyes draws its door glass up (a frameless pane from the screen to the door's end), so
    // the eyes have their glass; without eyes the windows are down
    const x0 = g.pts.cowl![0] - Math.max(7, 0.012 * g.len) * 1.6;
    const x1 = g.X(g.p.roofX) + 0.03 * g.len;
    pen.poly([x0, g.beltY(x0), x0 - 0.05 * g.len, g.beltY(x0) - 0.2 * g.tall, x1, g.beltY(x1) - 0.17 * g.tall, x1, g.beltY(x1)], glass, 0.9);
  }
  // the riders, then the door skin painted again so only their heads and shoulders show
  occ.side?.(pen, g.seats);
  P.glassFront(pc);
  P.bodyLines(pc);
  P.sidePieces(pc);
  P.nightEdge(pc);
  return pc;
}

/** The face's grille mouth: it replaces the grille and the intake at the nose. */
function faceMouth(c: Ctx, face: NonNullable<ReturnType<typeof faceOf>>): void {
  const { pen, g, S } = c;
  const { p, hl, tall } = g;
  const yy = g.y(lerp(p.chinH, p.tipH, 0.6));
  if (face.mouth === "o" || face.mouth === "bigo") pen.ellipse(hl - 28, yy, 18, 8 + 7 * clamp(face.mouthOpen, 0.3, 1.3), 0, S.t(MOUTH_DARK));
  else {
    const cv = MOUTH_CURVE[face.mouth] ?? 0;
    pen.line(quadPts(hl - 64, yy - cv * 10, hl - 34, yy + cv * 13, hl - 6, yy - cv * 4, 8), 0.06 * tall, S.t(GRILLE));
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// the face
// ---------------------------------------------------------------------------------------------------------------------

function drawFace(c: Ctx, face: NonNullable<ReturnType<typeof faceOf>>, d: CarDraw, t: number, headEyes: boolean, eyeAt: Pt, eyeRx: number, form: string | undefined): void {
  const { pen, g, S, st, car, glass, inkC, paint } = c;
  const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(d.seed, t) : 0, st.blink);
  const iris = S.t(hex(car.face.color, "#1c1842"));
  const white = c.nd ? S.t("#ffffff") : "#ffffff";
  const glint = c.nd ? ND.glint : "#ffffff";
  if (headEyes) {
    const rx = eyeRx;
    const far2 = g.hl - rx * 0.55;
    const lens = c.nd ? (c.lit ? ND.headCore : white) : c.lit ? "#fffbe6" : "#ffffff";
    carEye(pen, far2, eyeAt[1] - rx * 0.35, rx * 0.72, rx * 0.8, face, closedBy, iris, inkC, lens, paint, t, -1, glint);
    carEye(pen, eyeAt[0], eyeAt[1], rx, rx * 1.05, face, closedBy, iris, inkC, lens, paint, t, 1, glint);
    carBrows(pen, [eyeAt[0], far2], eyeAt[1], rx, rx * 1.05, face, inkC);
    return;
  }
  // windscreen eyes: on the front pane (an open car's door glass drawn up for them)
  let pane: number[] = g.panes[0] ?? [];
  if (g.open) {
    const x0 = g.pts.cowl![0] - Math.max(7, 0.012 * g.len) * 1.6;
    const x1 = g.X(g.p.roofX) + 0.03 * g.len;
    pane = [x0, g.beltY(x0), x0 - 0.05 * g.len, g.beltY(x0) - 0.2 * g.tall, x1, g.beltY(x1) - 0.17 * g.tall, x1, g.beltY(x1)];
  }
  if (form !== undefined || pane.length < 6) {
    // a bike, a plane or a boat: the eyes sit on the body at the front
    const rx = clamp(g.tall * 0.07, 11, 26);
    const x1 = g.hl * 0.5;
    const cy = g.y(form === "boat" ? 1.2 : 1.0);
    carEye(pen, x1 - rx * 2.4, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, -1, glint);
    carEye(pen, x1, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, 1, glint);
    return;
  }
  const ys = pane.filter((_, i) => i % 2 === 1);
  const top = Math.min(...ys);
  const bot = Math.max(...ys);
  const winH = bot - top;
  const rx = clamp(winH * 0.27, 11, 36);
  const cy = (top + bot) / 2;
  const span = xSpan(pane, cy) ?? [g.frontLeft, g.frontRight];
  const x1 = span[1] - rx * 1.3;
  const x0 = Math.max(span[0] + rx * 1.2, x1 - rx * 2.3);
  carEye(pen, x0, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, -1, glint);
  carEye(pen, x1, cy, rx, rx * 1.15, face, closedBy, iris, inkC, white, glass, t, 1, glint);
  carBrows(pen, [x0, x1], cy, rx, rx * 1.15, face, inkC);
}

// ---------------------------------------------------------------------------------------------------------------------
// a motorbike, a plane or a boat: today's shape under the shared shading and the real wheels (design-final 1.4). The
// classic drawing's defects (the boat's overhanging shade and lamp, the bike's floating tail light) are fixed here, for
// detailed looks only.
// ---------------------------------------------------------------------------------------------------------------------

function bodyOfForm(c: Ctx, form: string): void {
  const { pen, g, R, S, nd, ow, fin, faded, paint, accent, glass, glassCol, car, occ } = c;
  const gs = g as unknown as Side2 & Side;
  pen.poly(outlined(g.sil, ow), S.ink);
  pen.poly(g.sil, paint);
  // the lower body in shade, clipped to the outline (never past it)
  const far = g.hl + 60;
  const low = g.y(0.46);
  pen.poly(clipConvex(g.sil, [-far, low, far, low, far, 80, -far, 80]), S.dk(paint, 0.16));
  const stripe = R.stripe;
  const sc = S.t(stripe.color ?? accent);
  if (stripe.layout === "side" || stripe.layout === "centre" || stripe.layout === "twin" || stripe.layout === "offset" || stripe.layout === "sill" || stripe.layout === "pin") {
    pen.poly(clipConvex(g.sil, [-far, g.y(0.78), far, g.y(0.78), far, g.y(0.66), -far, g.y(0.66)]), sc);
  }
  if (form === "plane") pen.poly(wingSide(gs), S.dk(paint, 0.22));
  else if (form === "bike") bikeSide(pen, gs, paint, S.t("#2b2b36"), S.t("#c9ccd2"));
  else if (form === "boat") boatSide(pen, gs, accent, S.dk(paint, 0.45), glass, S.t("#c9ccd2"));
  if (form !== "bike" && g.panes.length) {
    pen.poly(joinShapes(g.panes), glass);
  }
  occ.side?.(pen, g.seats);
  if (form !== "bike" && g.panes.length) {
    pen.poly(joinShapes(g.panes), nd ? glass : glassCol.tint, glassCol.a);
    faded(fin, () => pen.line([g.frontRight - 26, g.y(1.72), g.frontRight - 12, g.y(1.3)], 7, "#ffffff", car.windows === "clear" ? 0.55 : 0.3));
  }
  // a shoulder highlight along the body
  faded(c.med, () => pen.line([-g.hl * 0.6, g.y(0.98), g.hl * 0.7, g.y(0.98)], 4, "#ffffff", (nd ? 0.1 : 0.16) * c.gloss));
}

/** The lamps of a bike, a plane or a boat, kept on the body. */
function formLamps(c: Ctx, form: string, front: string, rear: string): void {
  const { pen, g, S, car } = c;
  if (form === "bike") {
    const [fx, fy] = frontLightPos(g);
    pen.ellipse(fx, fy, 13, 12, 0, S.dk(S.t(hex(car.paint, "#d8352a")), 0.3));
    pen.ellipse(fx, fy, 10, 9, 0, front);
    pen.rect(-g.hl + 4, g.y(0.9), 10, 12, 4, rear);
  } else if (form === "plane") pen.circle(g.hl - 14, g.y(0.5), 7, front);
  else pen.circle(g.hl * 0.8, g.y(0.62), 7, front);
}
