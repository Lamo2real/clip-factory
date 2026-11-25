// Clips Funded engine: a car seen from the back or the front (CONTRACTS §45.45 §6), for the shots inside a scene
// (shots.ts): the cars ahead from their backs, the cars coming the other way and the car in the mirror from their
// fronts, and the cast's own car from behind. A boxy, slightly 3D car: a lower box and a cabin, with one side showing
// as a skewed quad towards the vanishing point. It is drawn in the night drive way (soft thin lines, graded paint in
// three tones, glass reflections, rim light, a soft shadow and glowing lights) from the same CarLook as the side and
// top views, so a car of the cast is the same car in every shot. A plain car is a sedan made from its colour; a plain
// truck has its own box back and cab front. Plates are one plain light rectangle and no badge is ever drawn.

import { cel, grade, haloStops, ink, lineUnits, ND, nightDrive, type Light } from "./art.ts";
import { carBrows, carEye, carFace, carSpec, DEFAULT_CAR, GLASS_ND, GRILLE, LENS_OFF, MOUTH_CURVE, MOUTH_DARK, outlined, PLATE, rounded, TAIL_OFF, TRIM, TYRE_ND, type CarDraw } from "./car.ts";
import { drawCarView2 } from "./carView2.ts";
import { blink as blinkAt, type FaceParams } from "./face.ts";
import { clamp, hex, mix } from "./math.ts";
import type { Pen } from "./pen.ts";
import { clipConvex, quadPts, roundRectPts } from "./pen.ts";
import { BOX_ND, plainColor, type PropState } from "./props.ts";
import type { CarBody, CarLook, Expression } from "./types.ts";

export interface CarViewOpts {
  /** the ground under the car's centre, in the pen's units */
  x: number;
  y: number;
  /** the car's width on screen, in the pen's units */
  w: number;
  /** -1..1: how much of one side shows, as a skewed quad towards the vanishing point (+: the side on the right) */
  side: number;
  /** the light the car stands in: its own colours pass through it */
  light: Readonly<Light>;
  /** 0..1 */
  braking: number;
  /** the headlights are on (at night every light is) */
  lights: boolean;
  /** the headlights flashing, 0..1 */
  blink: number;
  /** the face a car of the cast with eyes shows now */
  face: Expression | null;
  t: number;
  seed: number;
  /** a plain truck: a box back and a cab front, painted in `car.paint` */
  truck?: boolean;
  /** the headlights' bloom × this (the mirror's flare); default 1 */
  bloom?: number;
}

/** Each body from behind and in front: the cabin's top width (a part of the width) and the lower box's height (a
 * part of the body's height). */
const VIEW: Record<CarBody, { topW: number; belt: number }> = {
  hatchback: { topW: 0.72, belt: 0.55 },
  sedan: { topW: 0.7, belt: 0.58 },
  estate: { topW: 0.76, belt: 0.55 },
  suv: { topW: 0.8, belt: 0.55 },
  pickup: { topW: 0.76, belt: 0.6 },
  van: { topW: 0.9, belt: 0.48 },
  sports: { topW: 0.6, belt: 0.6 },
  compact: { topW: 0.72, belt: 0.54 },
  // §45.47: a bus's tall glass box, a bike's slim screen, a plane's nose, a boat's cabin
  bus: { topW: 0.94, belt: 0.4 },
  motorbike: { topW: 0.62, belt: 0.55 },
  plane: { topW: 0.6, belt: 0.55 },
  boat: { topW: 0.66, belt: 0.5 },
};

/** The look a plain car is drawn with in a front or back view: a sedan in its colour, steel wheels, no face. */
export function plainCarLook(color: string): CarLook {
  return { ...DEFAULT_CAR, body: "sedan", paint: color, accent: color, wheels: { style: "steel", rim: "#9aa3af", size: 1 }, lights: { front: "square", rear: "square" } };
}

type Pt = [number, number];

/** A car of the cast, or a plain car or truck, from the back or the front; origin on the ground under its centre. */
export function drawCarView(pen: Pen, car: CarLook, view: "back" | "front", o: CarViewOpts): void {
  pen.save();
  pen.translate(o.x, o.y);
  if (o.truck) truckView(pen, car, view, o);
  else carView(pen, car, view, o);
  pen.restore();
}

/** A car or truck prop of a scene in a front or back view: its car of the cast's look, or one made from its colour;
 * its braking, lights, flashing and face come from its state. */
export function drawPropView(pen: Pen, st: PropState, view: "back" | "front", o: Omit<CarViewOpts, "braking" | "lights" | "blink" | "face" | "truck">, car?: CarDraw | null): void {
  const truck = st.prop.kind === "truck";
  const look = car && !truck ? car.car : plainCarLook(plainColor(st.prop, true));
  drawCarView(pen, look, view, { ...o, braking: st.braking, lights: st.lights, blink: st.blink, face: car && !truck ? st.face : null, truck, seed: car?.seed ?? o.seed });
}

export function carView(pen: Pen, car: CarLook, view: "back" | "front", o: CarViewOpts): void {
  if (car.detail !== undefined) return drawCarView2(pen, car, view, o);
  const L = o.light;
  const g = (c: string) => grade(c, L);
  const up = (c: string, k: number) => mix(mix(c, "#ffffff", k), "#ffcf8a", L.warm * 0.12);
  const spec = carSpec(car.body);
  const vs = VIEW[car.body] ?? VIEW.hatchback;
  const W = o.w * spec.wide;
  const H = o.w * 0.78 * spec.hgt * clamp(car.height, 0.85, 1.15);
  const raise = spec.lift * (o.w / 196);
  const roof = -(H + raise);
  const sill = -(0.12 * H + raise);
  const belt = sill + (roof - sill) * vs.belt;
  const lowH = sill - belt;
  const cabH = belt - roof;
  const tw = W * vs.topW;
  const bw = W * 0.94;
  const ow = lineUnits(pen, 2.6);
  const inkC = ink(hex(car.outline, "#1c1842"));
  const paint = g(hex(car.paint, "#d8352a"));
  const accent = g(hex(car.accent, "#f4f1ea"));
  const cabin = car.pattern === "two_tone" ? accent : paint;
  const glass = g(GLASS_ND[car.windows] ?? GLASS_ND.clear);
  const face = carFace(o.face, car);
  const s = clamp(o.side, -1, 1);
  const sd = s < 0 ? -1 : 1;
  const showSide = Math.abs(s) > 0.06;
  const depth = Math.abs(s) * 0.16 * W;
  const horizon = -0.83 * (H + raise);
  const shrink = 1 - 0.18 * Math.abs(s);
  /** a point of the near face carried to the far end of the side, towards the vanishing point */
  const far = (x: number, y: number): Pt => [x + sd * depth, horizon + (y - horizon) * shrink];
  // the soft shadow under it
  const aoX = showSide ? (sd * depth) / 2 : 0;
  pen.ellipse(aoX, 0, W / 2 + 0.12 * W, 0.07 * W, 0, ND.ao, 0.16);
  pen.ellipse(aoX, -0.004 * W, W / 2 - 0.02 * W, 0.035 * W, 0, ND.ao, 0.38);
  // tyres at the bottom corners, under the body (a bike's one in the middle; a plane's wings and a boat's water instead)
  const form = spec.form;
  if (form === "plane") pen.rect(-0.98 * o.w, sill - 0.5 * (sill - belt) - 0.03 * o.w, 1.96 * o.w, 0.06 * o.w, 0.03 * o.w, cel(paint, 0.3));
  else if (form === "boat") pen.rect(-W / 2 - 0.06 * W, -0.03 * W, W * 1.12, 0.045 * W, 0.02 * W, g("#e9f6ff"), 0.75);
  else for (const x of form === "bike" ? [0] : [-1, 1]) pen.rect(x * (W / 2 - 0.12 * W) - 0.085 * W, sill - 0.08 * H, 0.17 * W, -(sill - 0.08 * H), 0.03 * W, TYRE_ND);
  // the outline round the whole car, then the body: a lower box and a cabin
  const near: Pt[] = [
    [W / 2, sill],
    [W / 2, belt],
    [bw / 2, belt],
    [tw / 2, roof],
    [-tw / 2, roof],
    [-bw / 2, belt],
    [-W / 2, belt],
    [-W / 2, sill],
  ];
  // with a side showing, its far edge replaces the near edge on that side: points 0..3 are the right, 4..7 the left
  const sil: Pt[] = [];
  for (const [i, p] of near.entries()) {
    if (!showSide || (i <= 3) !== sd > 0) sil.push(p);
    else if (i === 0 || i === 4) sil.push(p, far(p[0], p[1]));
    else if (i === 3 || i === 7) sil.push(far(p[0], p[1]), p);
    else sil.push(far(p[0], p[1]));
  }
  const r = 0.05 * W;
  pen.poly(outlined(rounded(sil, r), ow), inkC);
  const body = rounded(near, r);
  pen.poly(body, paint);
  if (showSide) {
    const e = sd * (W / 2);
    const ce = sd * (bw / 2);
    const te = sd * (tw / 2);
    pen.poly([e, sill, ...far(e, sill), ...far(e, belt), e, belt], cel(paint, 0.35));
    pen.poly([ce, belt, ...far(ce, belt), ...far(te, roof), te, roof], cel(cabin, 0.35));
    // the side windows, inset in the cabin's side
    const a0 = far(ce, belt);
    const a1 = far(te, roof);
    const ins = (p: Pt, q: Pt, k: number): number[] => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
    const nb: Pt = [ce, belt - 0.06 * cabH];
    const nt: Pt = [te, roof + 0.12 * cabH];
    const fb: Pt = [a0[0], a0[1] - 0.06 * cabH * shrink];
    const ft: Pt = [a1[0], a1[1] + 0.12 * cabH * shrink];
    pen.poly([...ins(nb, fb, 0.18), ...ins(nb, fb, 0.9), ...ins(nt, ft, 0.9), ...ins(nt, ft, 0.18)], mix(glass, ND.celDark, 0.25));
  }
  // three tones: the lower body in the cel shadow, the body, and a lit top
  const lowY = sill - 0.42 * lowH;
  pen.poly(clipConvex(roundRectPts(-W / 2, belt, W, lowH, r), [-W, lowY, W, lowY, W, 0, -W, 0]), cel(paint));
  if (car.pattern === "two_tone") pen.poly(rounded([[bw / 2, belt], [tw / 2, roof], [-tw / 2, roof], [-bw / 2, belt]], r), accent);
  // the glass: the rear window, or the windscreen
  const gi = view === "front" ? { b: 0.05, t: 0.03, yb: 0.03, yt: 0.1 } : { b: 0.07, t: 0.05, yb: 0.06, yt: 0.12 };
  const glassPts = rounded(
    [
      [bw / 2 - gi.b * W, belt - gi.yb * cabH],
      [tw / 2 - gi.t * W, roof + gi.yt * cabH],
      [-tw / 2 + gi.t * W, roof + gi.yt * cabH],
      [-bw / 2 + gi.b * W, belt - gi.yb * cabH],
    ],
    0.03 * W,
  );
  pen.poly(glassPts, glass);
  const eyesOnGlass = face !== null && car.face.eyes === "windscreen" && view === "front";
  // reflections: diagonal bands across the glass (one when eyes look out through it)
  const gy0 = roof + gi.yt * cabH;
  const gy1 = belt - gi.yb * cabH;
  const bandAt = (x: number, wd: number): number[] => [x, gy0, x + wd, gy0, x + wd - 0.16 * W, gy1, x - 0.16 * W, gy1];
  pen.poly(clipConvex(bandAt(-0.12 * W, 0.1 * W), glassPts), "#ffffff", 0.12);
  if (!eyesOnGlass) pen.poly(clipConvex(bandAt(0.08 * W, 0.04 * W), glassPts), "#ffffff", 0.07);
  if (view === "back") {
    // a lit roof and the rim light from the lamps along it and down one pillar
    pen.poly([-tw / 2 + 0.01 * W, roof + ow * 0.5, tw / 2 - 0.01 * W, roof + ow * 0.5, tw / 2 - 0.03 * W, roof + 0.07 * cabH, -tw / 2 + 0.03 * W, roof + 0.07 * cabH], up(cabin, 0.18));
    // the boot's shut line (a van's two doors split down the middle) and a rear wiper on a hatch
    const fine = ow * 0.35;
    if (car.body === "van") pen.line([0, roof + 0.1 * cabH, 0, sill - 0.2 * lowH], fine, inkC, 0.8);
    else pen.line([-0.43 * W, belt + 0.02 * lowH, -0.43 * W, sill - 0.27 * lowH, 0.43 * W, sill - 0.27 * lowH, 0.43 * W, belt + 0.02 * lowH], fine, inkC, 0.75);
    if (car.body === "hatchback" || car.body === "estate" || car.body === "suv" || car.body === "compact") {
      pen.line([0.02 * W, belt - 0.1 * cabH, -0.2 * W, belt - 0.42 * cabH], Math.max(fine, 0.012 * W), g("#1b1a1d"), 0.85);
    }
  } else {
    // the bonnet, lit from above
    pen.poly([-bw / 2, belt + ow * 0.5, bw / 2, belt + ow * 0.5, W / 2 - 0.02 * W, belt + 0.2 * lowH, -W / 2 + 0.02 * W, belt + 0.2 * lowH], up(paint, 0.14));
  }
  pen.line([-sd * (bw / 2 - 0.02 * W), belt - 0.04 * cabH, -sd * (tw / 2 - 0.01 * W), roof + ow * 0.6, sd * (tw / 2 - 0.01 * W), roof + ow * 0.6], ow, L.rim, L.rimA);
  // the pattern
  if (car.pattern === "stripe") pen.rect(-W / 2 + 0.02 * W, sill - 0.56 * lowH, W - 0.04 * W, 0.09 * lowH, 0.01 * W, accent);
  else if (car.pattern === "racing_stripes") {
    // two stripes over the middle, one shape: two quads joined by a bridge that goes there and back (no area)
    const y0 = sill - 0.22 * lowH;
    const y1 = belt + 0.01 * lowH;
    const q = (x: number): number[] => [x - 0.03 * W, y0, x + 0.03 * W, y0, x + 0.03 * W, y1, x - 0.03 * W, y1, x - 0.03 * W, y0];
    pen.poly([...q(-0.07 * W), ...q(0.07 * W)], accent);
  }
  // the extras on the roof or the boot
  if (car.extra === "roof_rack") pen.line([-0.42 * tw, roof, -0.42 * tw, roof - 0.06 * H, 0.42 * tw, roof - 0.06 * H, 0.42 * tw, roof], 0.025 * W, g(TRIM));
  else if (car.extra === "roof_box") pen.rect(-0.32 * tw, roof - 0.16 * H, 0.64 * tw, 0.16 * H + ow, 0.05 * W, g("#454b58"));
  else if (car.extra === "spoiler" && view === "back") {
    if (spec.spoiler[1] >= 1.8) pen.rect(-tw / 2 - 0.03 * W, roof + 0.02 * cabH, tw + 0.06 * W, 0.07 * cabH, 0.02 * W, cel(paint, 0.3));
    else pen.rect(-0.46 * W, belt - 0.03 * lowH, 0.92 * W, 0.08 * lowH, 0.02 * W, cel(paint, 0.3));
  }
  // the bumper
  pen.rect(-W / 2 - 0.01 * W, sill - 0.22 * lowH, W + 0.02 * W, 0.24 * lowH, 0.04 * W, g(TRIM));
  const dark = L.night;
  const lit = o.lights || dark || o.blink > 0.3;
  if (view === "back") {
    pen.rect(-0.15 * W, sill - 0.42 * lowH, 0.3 * W, 0.075 * W, 0.012 * W, g(PLATE));
    pen.ellipse(0.3 * W, sill + 0.01 * H, 0.045 * W, 0.022 * W, 0, TYRE_ND);
    const braking = o.braking > 0.1;
    const tailOn = o.lights || dark;
    const tail = braking ? ND.brakeCore : tailOn ? ND.tailCore : g(TAIL_OFF);
    const glowA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * o.braking : 0);
    const ty = sill - 0.68 * lowH;
    const rr = 0.07 * o.w;
    const glowR = (car.lights.rear === "round" ? rr : 0.045 * o.w) * 2.5;
    // a lens shows a lighter strip along its top
    const shine = mix(tail, "#ffffff", 0.3);
    // night drive: the glow under the lens, soft rings that fade out (Bright: one oval over it)
    const soft = glowA > 0 && nightDrive();
    if (car.lights.rear === "bar") {
      if (soft) softBar(pen, ty, 0.42 * W, 0.03 * o.w, 0.03 * o.w * 1.6, glowA / 0.45);
      pen.rect(-0.42 * W, ty - 0.03 * o.w, 0.84 * W, 0.06 * o.w, 0.03 * o.w, tail);
      pen.rect(-0.4 * W, ty - 0.022 * o.w, 0.8 * W, 0.014 * o.w, 0.007 * o.w, shine, 0.7);
      if (glowA > 0 && !soft) pen.ellipse(0, ty, 0.42 * W + 0.03 * o.w * 1.5, 0.03 * o.w * 2.5, 0, ND.tailGlow, glowA);
    } else {
      if (soft) softPair(pen, [-0.36 * o.w, 0.36 * o.w], ty, glowR / 2.5, glowR * 0.6, ND.tailGlow, glowA / 0.45);
      for (const x of [-1, 1]) {
        const cx = x * 0.36 * o.w;
        if (car.lights.rear === "round") {
          pen.circle(cx, ty, rr, tail);
          pen.ellipse(cx, ty - rr * 0.45, rr * 0.55, rr * 0.22, 0, shine, 0.7);
        } else {
          pen.rect(cx - 0.065 * o.w, ty - 0.035 * o.w, 0.13 * o.w, 0.07 * o.w, 0.015 * o.w, tail);
          pen.rect(cx - 0.055 * o.w, ty - 0.027 * o.w, 0.11 * o.w, 0.016 * o.w, 0.008 * o.w, shine, 0.7);
        }
      }
      if (glowA > 0 && !soft) for (const x of [-1, 1]) pen.circle(x * 0.36 * o.w, ty, glowR, ND.tailGlow, glowA);
    }
    // the third brake light at the top of the rear glass, and the red reflectors at the bumper's corners
    pen.rect(-0.1 * W, roof + 0.07 * cabH, 0.2 * W, 0.022 * W, 0.01 * W, braking ? ND.brakeCore : g(TAIL_OFF));
    for (const x of [-1, 1]) pen.rect(x * 0.4 * W - 0.04 * W, sill - 0.13 * lowH, 0.08 * W, 0.05 * lowH, 0.01 * W, g("#8a2a26"));
    return;
  }
  // the front: the grille (it bends into the face's mouth with a grille mouth), the door mirrors and the headlights
  const gy = sill - 0.44 * lowH;
  const mouth = face && car.face.mouth === "grille" ? face.mouth : null;
  if (mouth === null) pen.rect(-0.24 * W, gy - 0.1 * lowH, 0.48 * W, 0.2 * lowH, 0.03 * W, g(GRILLE));
  else if (mouth === "o" || mouth === "bigo") pen.ellipse(0, gy, 0.12 * W, 0.06 * W + 0.05 * W * clamp(face!.mouthOpen, 0.3, 1.3), 0, g(MOUTH_DARK));
  else {
    const c = MOUTH_CURVE[mouth] ?? 0;
    pen.line(quadPts(-0.24 * W, gy - c * 0.04 * W, 0, gy + c * 0.06 * W, 0.24 * W, gy - c * 0.04 * W, 8), 0.07 * lowH, g(GRILLE));
  }
  for (const x of [-1, 1]) {
    const mx = x * (bw / 2 + 0.05 * W) + (showSide && x === sd ? sd * depth * 0.3 : 0);
    pen.ellipse(mx, belt - 0.08 * cabH, 0.055 * W, 0.04 * W, 0, accent);
  }
  const hy = sill - 0.66 * lowH;
  const hx = 0.34 * W;
  const headEyes = face !== null && car.face.eyes === "headlights";
  const lensR = car.lights.front === "slim" ? 0.035 * o.w : 0.05 * o.w;
  const flare = (o.bloom ?? 1) * ((lit ? (dark ? 1 : 0.5) : 0) + 0.8 * o.blink) * (headEyes ? 0.6 : 1);
  if (flare > 0.02 && nightDrive()) headBloom(pen, hx, hy, lensR, flare);
  else if (flare > 0.02) {
    // the two wider halos are shared by both lights (they meet in the middle); the nearest is each light's own
    pen.ellipse(0, hy, hx + lensR * 5, lensR * 4, 0, ND.headBloom, Math.min(1, 0.06 * flare));
    pen.ellipse(0, hy, hx + lensR * 3, lensR * 2.6, 0, ND.headBloom, Math.min(1, 0.16 * flare));
    for (const x of [-1, 1]) pen.circle(x * hx, hy, lensR * 1.6, ND.headBloom, Math.min(1, 0.45 * flare));
  }
  const lens = lit || o.blink > 0.3 ? ND.headCore : g(LENS_OFF);
  if (!headEyes) {
    for (const x of [-1, 1]) {
      const cx = x * hx;
      if (car.lights.front === "round") pen.circle(cx, hy, 0.055 * o.w, lens);
      else if (car.lights.front === "square") pen.rect(cx - 0.07 * o.w, hy - 0.045 * o.w, 0.14 * o.w, 0.09 * o.w, 0.015 * o.w, lens);
      else pen.rect(cx - 0.1 * o.w, hy - 0.0225 * o.w, 0.2 * o.w, 0.045 * o.w, 0.02 * o.w, lens);
    }
  }
  if (!face) return;
  // a car with eyes looks out at the camera: windscreen eyes on the glass, or its headlights are its eyes
  const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(o.seed, o.t) : 0, o.blink);
  const iris = g(hex(car.face.color, "#1c1842"));
  const straight = { ...face, lookX: face.lookX - 0.36 };
  if (headEyes) {
    const rx = 0.085 * W;
    for (const x of [-1, 1]) eyeLite(pen, x * hx, hy, rx, rx * 1.05, straight, closedBy, iris, inkC, lens, paint, o.t, x);
    carBrows(pen, [-hx, hx], hy, rx, rx * 1.05, face, inkC);
    return;
  }
  const rx = 0.1 * W;
  const ey = (gy0 + gy1) / 2;
  for (const x of [-1, 1]) eyeLite(pen, x * 0.2 * W, ey, rx, rx * 1.15, straight, closedBy, iris, inkC, g("#ffffff"), glass, o.t, x);
  carBrows(pen, [-0.2 * W, 0.2 * W], ey, rx, rx * 1.15, face, inkC);
}

/** carEye without the glint (three shapes): the eyes of a front view, which shows many small cars. */
function eyeLite(pen: Pen, x: number, y: number, rx: number, ry: number, f: FaceParams, closedBy: number, iris: string, inkC: string, white: string, lid: string, t: number, s: number): void {
  if (f.eyes === "happy" || f.eyes === "closed" || f.open * (1 - closedBy) < 0.16 || f.eyes === "spiral" || f.eyes === "lidded") {
    carEye(pen, x, y, rx, ry, f, closedBy, iris, inkC, white, lid, t, s, white);
    return;
  }
  const eh = ry * Math.min(1.35, f.open * (1 - closedBy));
  const ew = rx * (1 + 0.06 * (f.open - 1));
  const lw = Math.max(2, rx * 0.24);
  pen.ellipse(x, y, ew + lw * 0.6, eh + lw * 0.6, 0, inkC);
  pen.ellipse(x, y, ew, eh, 0, white);
  const ir = Math.min(ew * 0.56 * f.pupil, eh * 0.9);
  pen.circle(x + clamp(f.lookX * 0.7 + 0.25, -1, 1) * (ew - ir) * 0.8, y + clamp(f.lookY, -1, 1) * Math.max(0, eh - ir) * 0.8, ir, iris);
}

/** A plain truck: from behind a tall box with a roller door and two low red lights, from the front a cab with a big
 * windscreen and the box's top showing over it. */
function truckView(pen: Pen, car: CarLook, view: "back" | "front", o: CarViewOpts): void {
  const L = o.light;
  const g = (c: string) => grade(c, L);
  const W = o.w * 1.1;
  const ow = lineUnits(pen, 2.6);
  const inkC = ink("#1c1842");
  const paint = g(hex(car.paint, "#47d6a0"));
  const box = g(BOX_ND);
  const sill = -0.16 * o.w;
  const top = -1.45 * o.w;
  const s = clamp(o.side, -1, 1);
  const sd = s < 0 ? -1 : 1;
  const showSide = Math.abs(s) > 0.06;
  const depth = Math.abs(s) * 0.22 * W;
  const horizon = -0.7 * o.w;
  const shrink = 1 - 0.16 * Math.abs(s);
  const far = (x: number, y: number): Pt => [x + sd * depth, horizon + (y - horizon) * shrink];
  const dark = L.night;
  pen.ellipse(showSide ? (sd * depth) / 2 : 0, 0, W / 2 + 0.12 * W, 0.07 * W, 0, ND.ao, 0.16);
  pen.ellipse(0, -0.004 * W, W / 2 - 0.02 * W, 0.035 * W, 0, ND.ao, 0.38);
  for (const x of [-1, 1]) pen.rect(x * (W / 2 - 0.14 * W) - 0.11 * W, sill - 0.04 * o.w, 0.22 * W, -(sill - 0.04 * o.w), 0.03 * W, TYRE_ND);
  const e = sd * (W / 2);
  const sliver = showSide ? [e, sill, ...far(e, sill), ...far(e, top), e, top] : [];
  if (view === "back") {
    const sil: Pt[] = [[-W / 2, sill], [-W / 2, top], [W / 2, top], [W / 2, sill]];
    pen.poly(outlined(rounded(sil, 0.02 * W), ow), inkC);
    if (showSide) pen.poly(outlined(sliver, ow), inkC);
    pen.poly(rounded(sil, 0.02 * W), box);
    if (showSide) pen.poly(sliver, cel(box, 0.3));
    // the roller door and its lines
    const dx = 0.42 * W;
    const d0 = top + 0.08 * o.w;
    const d1 = sill - 0.06 * o.w;
    pen.rect(-dx, d0, 2 * dx, d1 - d0, 0.01 * W, cel(box, 0.12));
    for (let i = 1; i <= 4; i += 1) {
      const y = d0 + ((d1 - d0) * i) / 5;
      pen.line([-dx + 0.02 * W, y, dx - 0.02 * W, y], ow * 0.5, cel(box, 0.4), 0.8);
    }
    pen.line([-W / 2 + ow, top + ow * 0.7, W / 2 - ow, top + ow * 0.7], ow, L.rim, L.rimA);
    pen.rect(-W / 2 - 0.01 * W, sill - 0.05 * o.w, W + 0.02 * W, 0.07 * o.w, 0.02 * W, g(TRIM));
    pen.rect(-0.13 * W, sill - 0.04 * o.w, 0.26 * W, 0.055 * W, 0.01 * W, g(PLATE));
    const braking = o.braking > 0.1;
    const tailOn = o.lights || dark;
    const tail = braking ? ND.brakeCore : tailOn ? ND.tailCore : g(TAIL_OFF);
    const glowA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * o.braking : 0);
    const ty = sill - 0.11 * o.w;
    const soft = glowA > 0 && nightDrive();
    if (soft) softPair(pen, [-0.4 * W, 0.4 * W], ty, 0.04 * W, 0.08 * W, ND.tailGlow, glowA / 0.45);
    for (const x of [-1, 1]) {
      pen.rect(x * 0.4 * W - 0.05 * W, ty - 0.03 * W, 0.1 * W, 0.06 * W, 0.01 * W, tail);
      if (glowA > 0 && !soft) pen.circle(x * 0.4 * W, ty, 0.12 * W, ND.tailGlow, glowA);
    }
    return;
  }
  // the front: the box's top over a cab with a big windscreen
  const cabTop = -1.0 * o.w;
  const cw = W * 0.96;
  const sil: Pt[] = [[-cw / 2, sill], [-cw / 2, cabTop], [-W / 2, cabTop], [-W / 2, top], [W / 2, top], [W / 2, cabTop], [cw / 2, cabTop], [cw / 2, sill]];
  pen.poly(outlined(rounded(sil, 0.02 * W), ow), inkC);
  if (showSide) pen.poly(outlined(sliver, ow), inkC);
  pen.rect(-W / 2, top, W, cabTop - top + 0.02 * o.w, 0.02 * W, cel(box, 0.18));
  if (showSide) pen.poly(sliver, cel(box, 0.35));
  pen.rect(-cw / 2, cabTop, cw, sill - cabTop, 0.04 * W, paint);
  pen.poly(clipConvex(roundRectPts(-cw / 2, cabTop, cw, sill - cabTop, 0.04 * W), [-W, -0.4 * o.w, W, -0.4 * o.w, W, 0, -W, 0]), cel(paint));
  const glass = g(GLASS_ND.clear);
  const gp = roundRectPts(-cw / 2 + 0.06 * W, cabTop + 0.06 * o.w, cw - 0.12 * W, 0.34 * o.w, 0.02 * W);
  pen.poly(gp, glass);
  pen.poly(clipConvex([-0.16 * W, cabTop, -0.06 * W, cabTop, -0.2 * W, -0.5 * o.w, -0.3 * W, -0.5 * o.w], gp), "#ffffff", 0.12);
  pen.poly(clipConvex([0.08 * W, cabTop, 0.12 * W, cabTop, -0.02 * W, -0.5 * o.w, -0.06 * W, -0.5 * o.w], gp), "#ffffff", 0.07);
  pen.line([-W / 2 + ow, top + ow * 0.7, W / 2 - ow, top + ow * 0.7], ow, L.rim, L.rimA);
  pen.rect(-0.3 * W, -0.42 * o.w, 0.6 * W, 0.12 * o.w, 0.02 * W, g(GRILLE));
  pen.rect(-cw / 2 - 0.01 * W, sill - 0.08 * o.w, cw + 0.02 * W, 0.1 * o.w, 0.02 * W, g(TRIM));
  // big mirrors on arms
  for (const x of [-1, 1]) {
    const mx = x * (cw / 2 + 0.08 * W) + (showSide && x === sd ? sd * depth * 0.3 : 0);
    pen.line([x * (cw / 2), cabTop + 0.12 * o.w, mx, cabTop + 0.1 * o.w], ow * 1.2, g(TRIM));
    pen.rect(mx - 0.035 * W, cabTop + 0.04 * o.w, 0.07 * W, 0.16 * o.w, 0.015 * W, g(TRIM));
  }
  const lit = o.lights || dark || o.blink > 0.3;
  const hy = -0.3 * o.w;
  const hx = 0.36 * W;
  const lensR = 0.06 * o.w;
  const flare = (o.bloom ?? 1) * ((lit ? (dark ? 1 : 0.5) : 0) + 0.8 * o.blink);
  if (flare > 0.02 && nightDrive()) headBloom(pen, hx, hy, lensR, flare);
  else if (flare > 0.02) {
    pen.ellipse(0, hy, hx + lensR * 5, lensR * 4, 0, ND.headBloom, Math.min(1, 0.06 * flare));
    pen.ellipse(0, hy, hx + lensR * 3, lensR * 2.6, 0, ND.headBloom, Math.min(1, 0.16 * flare));
    for (const x of [-1, 1]) pen.circle(x * hx, hy, lensR * 1.6, ND.headBloom, Math.min(1, 0.45 * flare));
  }
  const lens = lit ? ND.headCore : g(LENS_OFF);
  for (const x of [-1, 1]) pen.rect(x * hx - 0.07 * o.w, hy - 0.045 * o.w, 0.14 * o.w, 0.09 * o.w, 0.015 * o.w, lens);
}

// ---- night drive's soft lights -------------------------------------------------------------------------------------

/** A pair of lights' soft bloom (night drive): one soft glow (the `glow` prim, art.ts haloStops) round each lens of
 * radius `r` at (x, y) for each x of `xs`, flat over the lens and fading to clear `reach` past it, a little flatter
 * than round; `k` scales its light (at most 1). No ring edge, and no flat oval round the two. */
function softPair(pen: Pen, xs: number[], y: number, r: number, reach: number, color: string, k: number): void {
  const R = r + reach;
  const fade = haloStops(1, r / R);
  for (const x of xs) pen.glow(x, y, R, R * 0.86, color, fade, Math.min(1, 0.8 * k));
}

/** Night drive's headlights: a soft white bloom round each lens that fades to clear, reaching further and stronger
 * with `flare` (lit at night 1, the mirror's 1.8, a blink 0.8 more). */
function headBloom(pen: Pen, hx: number, hy: number, lensR: number, flare: number): void {
  const f = Math.min(flare, 2.2);
  softPair(pen, [-hx, hx], hy, lensR, lensR * (1.3 + 1.2 * f), ND.headBloom, Math.min(1.3, 0.55 + 0.45 * f));
}

/** Night drive's bar tail light's glow (half sizes hw × hh): one soft glow along the bar, flat over its middle and
 * fading to clear 0.7 × `reach` past it above and below and 2.5 × `reach` past its ends. */
function softBar(pen: Pen, y: number, hw: number, hh: number, reach: number, k: number): void {
  pen.glow(0, y, hw + 2.5 * reach, hh + 0.7 * reach, ND.tailGlow, haloStops(1, 0.5, 2), Math.min(1, 0.8 * k));
}
