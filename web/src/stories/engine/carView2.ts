// Clips Funded engine: the detailed vehicle's front and back views (CONTRACTS §45.48 section 2.8). carView.ts calls
// `drawCarView2` for a look with `detail`, with the pen already at the car's ground point. One frame (`endShape`: the
// width, the height and y(h) from the profile's own numbers) draws a wide, low or tall body from head on or from behind:
// the bonnet or the deck is the lit band between the face and the screen's foot (a low nose gives a long band and a low
// face: the wedge, head on), the lamps are shaped by the look and sized in the BODY's width (never the shot's `o.w`),
// and every fine part fades in with the car's size on screen (alpha tiers, so a far car costs what it always cost).
//
// Two light paths: night drive's soft glows (the `glow` prim) and Bright's flat discs. A vehicle that is not a wheeled
// car (a bike, a plane, a boat) has no outline of its own and draws its classic view. No badge, logo or lettering is ever
// drawn; the plate is two plain rectangles.

import { grade, haloStops, ink, lineUnits, ND, nightDrive } from "./art.ts";
import { carBrows, carEye, carFace, classicLook, GLASS_ND, GRILLE, LENS_OFF, MOUTH_CURVE, MOUTH_DARK, outlined, PLATE, TAIL_OFF, TYRE_ND } from "./car.ts";
import { resolveDetail, type Resolved } from "./carDetail.ts";
import { endShape, type CP, type End2, roundPath } from "./carShape.ts";
import type { CarViewOpts } from "./carView.ts";
import { carView } from "./carView.ts";
import { blink as blinkAt, type FaceParams } from "./face.ts";
import { clamp, hex, lerp, mix, smoothstep } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, clipConvex, joinShapes, quadPts, roundRectPts } from "./pen.ts";
import type { CarLook } from "./types.ts";

type Pt = [number, number];

/** The size (the car's width on screen, in design px) where the medium tier starts to show and where it is whole. */
export const END_MEDIUM: [number, number] = [110, 260];
/** The same for the fine tier. */
export const END_FINE: [number, number] = [260, 400];

/** A lamp (or a pair, or a bar): its lens shapes, its centre on the right and a radius for its glow. */
export interface EndLamps {
  /** every lens as a closed polygon (the drawer joins them into one shape) */
  polys: number[][];
  /** the centre of the right lamp (the left one is its mirror), and a radius for the glow */
  cx: number;
  cy: number;
  r: number;
  /** one bar across the whole width: the glow is one bar's */
  bar: boolean;
}

const circ = (cx: number, cy: number, r: number, n = 12): number[] => arcPts(cx, cy, r, r, 0, 360, n);
const cp = (x: number, y: number, r: number): CP => ({ x, y, r });
const rr = (x: number, y: number, w: number, h: number, r: number): number[] => roundRectPts(x, y, w, h, Math.min(r, w / 2, h / 2));
const mirror = (f: (s: number) => number[][]): number[][] => [...f(-1), ...f(1)];

/** The front lamps of a detailed look at body width `W`: where they stand on the face and what shape they are. */
function frontLamps(R: Resolved, E: End2, lit: boolean): EndLamps {
  const { W, y, p } = E;
  const L = R.lights.front;
  const u = W / 400;
  const sweptY = y(L.h ?? lerp(p.tipH, p.noseH, 0.8));
  const ly = y(L.h ?? lerp(p.tipH, p.noseH, 0.62));
  const out = (polys: number[][], cx: number, cy: number, r: number, bar = false): EndLamps => ({ polys, cx, cy, r, bar });
  switch (L.shape) {
    case "twin_round":
      return out(mirror((s) => [circ(s * 0.3 * W, ly, 0.045 * W), circ(s * 0.42 * W, ly, 0.045 * W)]), 0.36 * W, ly, 0.05 * W);
    case "oval":
      return out(mirror((s) => [arcPts(s * 0.36 * W, ly, 0.08 * W, 0.05 * W, 0, 360, 14)]), 0.36 * W, ly, 0.06 * W);
    case "square":
      return out(mirror((s) => [rr(s * 0.39 * W - 0.05 * W, ly - 0.05 * W, 0.1 * W, 0.1 * W, 0.015 * W)]), 0.39 * W, ly, 0.06 * W);
    case "rect":
      return out(mirror((s) => [rr(s * 0.38 * W - 0.08 * W, ly - 0.03 * W, 0.16 * W, 0.06 * W, 0.012 * W)]), 0.38 * W, ly, 0.055 * W);
    case "slim":
      return out(mirror((s) => [rr(s * 0.29 * W - 0.15 * W, ly - 0.014 * W, 0.3 * W, 0.028 * W, 0.012 * W)]), 0.29 * W, ly, 0.04 * W);
    case "swept": {
      // a teardrop on each wing: wide and high at the outer end, running in and down along the bonnet's edge
      const c = 0.35 * W;
      return out(
        mirror((s) => [roundPath([cp(s * (c + 0.1 * W), sweptY - 0.02 * W, 4 * u), cp(s * (c + 0.01 * W), sweptY - 0.036 * W, 5 * u), cp(s * (c - 0.12 * W), sweptY + 0.02 * W, 3 * u), cp(s * (c - 0.02 * W), sweptY + 0.022 * W, 5 * u)])]),
        c,
        sweptY,
        0.055 * W,
      );
    }
    case "angled": {
      const c = 0.34 * W;
      return out(mirror((s) => [roundPath([cp(s * (c + 0.12 * W), ly - 0.05 * W, 5 * u), cp(s * (c - 0.12 * W), ly + 0.005 * W, 4 * u), cp(s * (c - 0.1 * W), ly + 0.05 * W, 4 * u), cp(s * (c + 0.12 * W), ly + 0.028 * W, 5 * u)])]), c, ly, 0.055 * W);
    }
    case "stacked":
      return out(mirror((s) => [rr(s * 0.37 * W - 0.045 * W, ly - 0.07 * W, 0.09 * W, 0.045 * W, 0.01 * W), rr(s * 0.37 * W - 0.045 * W, ly + 0.015 * W, 0.09 * W, 0.045 * W, 0.01 * W)]), 0.37 * W, ly, 0.05 * W);
    case "pop_up":
      // shut by day: a flap line; lit: a raised block
      return out(mirror((s) => [lit ? rr(s * 0.34 * W - 0.07 * W, ly - 0.06 * W, 0.14 * W, 0.075 * W, 0.012 * W) : rr(s * 0.34 * W - 0.07 * W, ly - 0.008 * W, 0.14 * W, 0.016 * W, 0.006 * W)]), 0.34 * W, lit ? ly - 0.02 * W : ly, 0.055 * W);
    case "strip":
      return out([rr(-0.42 * W, ly - 0.014 * W, 0.84 * W, 0.028 * W, 0.012 * W)], 0.3 * W, ly, 0.04 * W, false);
    default:
      return out(mirror((s) => [circ(s * 0.36 * W, ly, 0.062 * W)]), 0.36 * W, ly, 0.062 * W);
  }
}

/** The tail lamps of a detailed look at body width `W`. */
function rearLamps(R: Resolved, E: End2): EndLamps {
  const { W, H, y, p } = E;
  const L = R.lights.rear;
  const ly = L.h !== null ? y(L.h) : y(lerp(p.rumpH, p.tailH, 0.5));
  const u = W / 400;
  const out = (polys: number[][], cx: number, cy: number, r: number, bar = false): EndLamps => ({ polys, cx, cy, r, bar });
  switch (L.shape) {
    case "twin_round":
      return out(mirror((s) => [circ(s * 0.38 * W, ly - 0.045 * W, 0.04 * W), circ(s * 0.38 * W, ly + 0.045 * W, 0.04 * W)]), 0.38 * W, ly, 0.05 * W);
    case "square":
      return out(mirror((s) => [rr(s * 0.38 * W - 0.05 * W, ly - 0.05 * W, 0.1 * W, 0.1 * W, 0.014 * W)]), 0.38 * W, ly, 0.055 * W);
    case "rect":
      return out(mirror((s) => [rr(s * 0.37 * W - 0.075 * W, ly - 0.032 * W, 0.15 * W, 0.064 * W, 0.014 * W)]), 0.37 * W, ly, 0.055 * W);
    case "tall": {
      const h = Math.min(0.16 * H, 0.11 * W);
      return out(mirror((s) => [rr(s * 0.44 * W - 0.028 * W, ly - h / 2, 0.056 * W, h, 0.01 * W)]), 0.44 * W, ly, 0.045 * W);
    }
    case "slim":
      return out(mirror((s) => [rr(s * 0.34 * W - 0.16 * W, ly - 0.014 * W, 0.32 * W, 0.028 * W, 0.012 * W)]), 0.34 * W, ly, 0.04 * W);
    case "bar":
      return out([rr(-0.43 * W, ly - 0.02 * W, 0.86 * W, 0.04 * W, 0.016 * W)], 0.3 * W, ly, 0.04 * W, true);
    case "split_bar":
      return out(mirror((s) => [rr(s * 0.3 * W - 0.13 * W, ly - 0.02 * W, 0.26 * W, 0.04 * W, 0.016 * W)]), 0.3 * W, ly, 0.045 * W);
    case "wedge":
      // wraps the corner of the tail: tall at the outer edge, narrowing towards the middle
      return out(mirror((s) => [roundPath([cp(s * 0.485 * W, ly - 0.06 * W, 5 * u), cp(s * 0.3 * W, ly - 0.028 * W, 4 * u), cp(s * 0.3 * W, ly + 0.028 * W, 4 * u), cp(s * 0.47 * W, ly + 0.065 * W, 5 * u)])]), 0.39 * W, ly, 0.06 * W);
    case "c_shape":
      return out(mirror((s) => [[s * 0.28 * W, ly - 0.06 * W, s * 0.45 * W, ly - 0.06 * W, s * 0.45 * W, ly + 0.06 * W, s * 0.28 * W, ly + 0.06 * W, s * 0.28 * W, ly + 0.035 * W, s * 0.41 * W, ly + 0.035 * W, s * 0.41 * W, ly - 0.035 * W, s * 0.28 * W, ly - 0.035 * W]]), 0.37 * W, ly, 0.06 * W);
    default:
      return out(mirror((s) => [circ(s * 0.37 * W, ly, 0.05 * W)]), 0.37 * W, ly, 0.05 * W);
  }
}

/** The lamps of a detailed look's front or back view at width `w` (for the tests and the editor's callouts). */
export function endLamps(car: CarLook, view: "back" | "front", w: number, lit = false): EndLamps {
  const R = resolveDetail(car);
  const E = endShape(car, view, w);
  return view === "front" ? frontLamps(R, E, lit) : rearLamps(R, E);
}

/** The box of a polygon: [x0, y0, x1, y1]. */
function boxOf(pts: number[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  return [x0, y0, x1, y1];
}

export function drawCarView2(pen: Pen, car: CarLook, view: "back" | "front", o: CarViewOpts): void {
  const R = resolveDetail(car);
  if (!R.fits.profile) {
    // a bike, a plane or a boat: no outline of its own, its classic view
    carView(pen, classicLook(car), view, o);
    return;
  }
  const E = endShape(car, view, o.w);
  const { W, H, y, p, open, hip, rw, bw, tyreW, lowH, faceH, footH, topH } = E;
  const front = view === "front";
  // sculpted flanks (a `wedge` crease on an open car): the fender crowns, the hood between them and the big side intakes
  const sculpt = open && R.side.crease === "wedge";
  const L = o.light;
  const g = (c: string) => grade(c, L);
  const up = (c: string, k: number) => mix(mix(c, "#ffffff", k), "#ffcf8a", L.warm * 0.12);
  const sheen = { gloss: 1, metallic: 1.15, satin: 0.55, matte: 0.25 }[R.finish] ?? 1;
  const medK = smoothstep(END_MEDIUM[0], END_MEDIUM[1], o.w);
  const fineK = smoothstep(END_FINE[0], END_FINE[1], o.w);
  /** a part of a tier: drawn at that tier's alpha, dropped by the pen when it is nearly clear */
  const tier = (k: number, draw: () => void): void => {
    if (k < 0.004) return;
    pen.save();
    pen.fade(k);
    draw();
    pen.restore();
  };
  // the outline weighs what the side view's does: Night drive a fixed 2.6 px line, Bright a heavy 1.85% of the width
  const ow = nightDrive() ? lineUnits(pen, 2.6) : Math.max(lineUnits(pen, 2.6), 0.0185 * W);
  const inkC = ink(hex(car.outline, "#1c1842"));
  const paint = g(hex(car.paint, "#d8352a"));
  const accent = g(hex(car.accent, "#f4f1ea"));
  const trim = g(hex(R.trim, "#23252b"));
  const dark = g("#15161a");
  const metal = g("#d9dde3");
  const glass = g(GLASS_ND[car.windows] ?? GLASS_ND.clear);
  const mirrorCol = g(hex(R.mirrorColor, hex(car.accent, "#f4f1ea")));
  const stripeCol = g(hex(R.stripe.color, hex(car.accent, "#f4f1ea")));
  const roofCol = R.roof.type === "soft_top" ? g(hex(R.roof.color ?? "#3a3d46")) : g(hex(R.roof.color ?? car.accent, "#f4f1ea"));
  const hasRoofCol = !open && (R.twoTone === "roof" || R.roof.type === "soft_top" || R.roof.color !== null);
  const face: FaceParams | null = front ? carFace(o.face, car) : null;
  const night = L.night;
  const lit = o.lights || night || o.blink > 0.3;
  const braking = o.braking > 0.1;
  const tailOn = o.lights || night;

  // ---- one side showing: its far edge, towards the vanishing point (the same maths as the classic view) ----------------
  const s = clamp(o.side, -1, 1);
  const sd = s < 0 ? -1 : 1;
  const showSide = Math.abs(s) > 0.06;
  const depth = Math.abs(s) * 0.16 * W;
  const horizon = -0.83 * H;
  const shrink = 1 - 0.18 * Math.abs(s);
  const far = (x: number, yy: number): Pt => [x + sd * depth, horizon + (yy - horizon) * shrink];
  let sliver: number[] = [];
  if (showSide) {
    const run: Pt[] = [];
    for (let i = 0; i < E.outline.length; i += 2) if (sd * E.outline[i]! >= 0) run.push([E.outline[i]!, E.outline[i + 1]!]);
    const twins = run.map(([x, yy]) => far(x, yy));
    sliver = [...run.flat(), ...twins.reverse().flat()];
  }

  // ---- the soft shadow and the tyres (as wide as the look says) ----------------------------------------------------------
  const aoX = showSide ? (sd * depth) / 2 : 0;
  pen.ellipse(aoX, 0, W * 0.62, 0.07 * W, 0, ND.ao, 0.16);
  pen.ellipse(aoX, -0.004 * W, W * 0.48, 0.035 * W, 0, ND.ao, 0.38);
  const tyreTop = y(Math.max(p.sillH + 9, Math.min(p.wheelD * 0.6, p.chinH + 30)));
  pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * (W / 2 - tyreW * 0.62) - tyreW / 2, tyreTop, tyreW, -tyreTop, 0.03 * W))), TYRE_ND);
  tier(medK, () => {
    // the light on each tyre's shoulder
    pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * (W / 2 - tyreW * 0.62) - tyreW * 0.4, tyreTop + 0.006 * H, tyreW * 0.8, 0.012 * H + 1, 0.004 * W))), mix(TYRE_ND, "#ffffff", 0.2), 0.7);
  });

  // ---- the body: ink, paint, the far side, two-tone, the shade under the crease ------------------------------------------
  pen.poly(joinShapes(showSide ? [outlined(E.outline, ow), outlined(sliver, ow)] : [outlined(E.outline, ow)]), inkC);
  pen.poly(E.outline, paint);
  if (showSide) pen.poly(sliver, mix(paint, ND.celDark, 0.35));
  const above = (hh: number): number[] => [-W, -9999, W, -9999, W, y(hh), -W, y(hh)];
  const below = (hh: number): number[] => [-W, y(hh), W, y(hh), W, 0, -W, 0];
  if (hasRoofCol) pen.poly(clipConvex(E.outline, above(R.roof.type === "soft_top" ? p.beltH : topH - 3)), roofCol);
  else if (R.twoTone === "split" || R.twoTone === "lower") pen.poly(clipConvex(E.outline, below(R.twoTone === "split" ? p.beltH : lerp(lowH, p.beltH, 0.4))), accent);
  const shadeAt = lerp(lowH, p.beltH, 0.42);
  pen.poly(clipConvex(E.outline, below(shadeAt)), mix(paint, ND.celDark, 0.22));
  if (open) {
    // the wheels show at the lower corners: a dark arch over each tyre, the tyre drawn again over the body's edge
    const ax = (sx: number): number => sx * (W / 2 - tyreW * 0.62);
    pen.poly(joinShapes([-1, 1].map((sx) => arcPts(ax(sx), tyreTop, tyreW * 0.68, 0.05 * H, 180, 360, 10))), mix(paint, "#0c0b10", 0.82));
    pen.poly(joinShapes([-1, 1].map((sx) => rr(ax(sx) - tyreW / 2, tyreTop, tyreW, -tyreTop, 0.03 * W))), TYRE_ND);
  }

  // ---- the bonnet or the deck: the lit band between the face and the screen's foot (the wedge, head on) --------------------
  const faceW = hip * (1 - ((front ? p.taperF : p.taperR) / 100) * 0.5);
  const bandTop = sculpt && front ? lerp(faceH, Math.min(footH, p.beltH + 12), 0.8) : Math.min(footH, p.beltH + 12);
  const bandCol = R.twoTone === "bonnet" ? up(accent, 0.1) : up(paint, clamp((sculpt ? 0.24 : 0.14) * sheen, 0.04, 0.26));
  const hasBand = bandTop - faceH > 2;
  const bandW = open && front ? bw * 0.84 : bw * 0.96;
  if (hasBand) pen.poly([-faceW * 0.98, y(faceH), faceW * 0.98, y(faceH), bandW, y(bandTop), -bandW, y(bandTop)], bandCol);
  if (!open) {
    // a closed roof's lit top
    pen.poly(clipConvex(E.outline, [-W, -9999, W, -9999, W, y(100) + 0.05 * H, -W, y(100) + 0.05 * H]), up(hasRoofCol ? roofCol : paint, 0.16 * sheen));
  }

  // ---- the glass ------------------------------------------------------------------------------------------------------------
  let glassPts = E.glass;
  if (open && !front) {
    // from behind an open car the screen stands beyond the cockpit: darker, narrower, and above the deck
    const sy0 = y(footH - 1);
    const sy1 = y(Math.max(topH, 99) - 1);
    glassPts = roundPath([cp(bw * 0.84, sy0, 8 * (W / 400)), cp(bw * 0.72, sy1, 10 * (W / 400)), cp(-bw * 0.72, sy1, 10 * (W / 400)), cp(-bw * 0.84, sy0, 8 * (W / 400))]);
  }
  const frame = open ? Math.max(ow, 0.009 * W) : Math.max(2 * ow, 0.014 * W);
  const hoopsOn = open && !front && R.roof.hoops !== "none";
  if (open) {
    pen.poly(outlined(glassPts, frame + ow), inkC);
    pen.poly(outlined(glassPts, frame), front ? trim : mix(trim, ND.celDark, 0.2));
  }
  pen.poly(glassPts, sculpt ? mix(glass, "#0a0f16", 0.7) : front || !open ? glass : mix(glass, ND.celDark, 0.3));
  const eyesOnGlass = face !== null && car.face.eyes === "windscreen";
  const gBox = boxOf(glassPts);
  const gyA = gBox[1];
  const gyB = gBox[3];
  const gxMax = gBox[2];
  const bandAt = (x: number, wd: number): number[] => [x, gyA, x + wd, gyA, x + wd - 0.1 * W, gyB, x - 0.1 * W, gyB];
  tier(medK, () => pen.poly(clipConvex(bandAt(-0.12 * W, 0.08 * W), glassPts), "#ffffff", 0.12));
  tier(fineK, () => {
    if (!eyesOnGlass) pen.poly(clipConvex(bandAt(0.1 * W, 0.035 * W), glassPts), "#ffffff", 0.07);
  });
  if (!open && (R.roof.type === "glass" || R.roof.type === "sunroof") && 100 - topH > 2) {
    const wide = R.roof.type === "glass" ? 0.78 : 0.4;
    tier(medK, () => pen.poly(roundRectPts(-rw * wide * 0.86, y(98.5), rw * wide * 1.72, Math.max(1, (H * (98.5 - topH + 4)) / 100 - 2), 0.01 * W), mix(glass, ND.celDark, 0.45), 0.9));
  }
  if (hoopsOn) {
    // two hoops and the seats' headrests behind an open cockpit
    const u = W / 400;
    pen.poly(joinShapes([-1, 1].map((sx) => roundPath([cp(sx * W * 0.32, y(footH - 2), 0), cp(sx * W * 0.31, y(p.roofH), 18 * u), cp(sx * W * 0.1, y(p.roofH), 18 * u), cp(sx * W * 0.08, y(footH - 2), 0)]))), mix(paint, ND.celDark, 0.12));
  }
  if (open && !front) {
    const u = W / 400;
    const seat = g(hex(R.cabin.seat ?? "#2a2a30"));
    const top = Math.max(footH + 5, p.roofH - 6);
    pen.poly(joinShapes([-1, 1].map((sx) => roundPath([cp(sx * W * 0.27, y(footH - 2), 0), cp(sx * W * 0.26, y(top), 10 * u), cp(sx * W * 0.14, y(top), 10 * u), cp(sx * W * 0.13, y(footH - 2), 0)]))), seat);
  }

  // ---- the stripe over the middle: the bonnet or deck, and over the roof when it is closed ---------------------------------
  const lay = R.stripe.layout;
  if (lay === "centre" || lay === "twin" || lay === "offset") {
    // head on, an open car's stripe is one wide band: from the nose up over the bonnet and into the screen's foot
    const wide = open && front ? 1.45 : 1;
    const sw = (0.045 + 0.05 * (R.stripe.width / 100)) * W * wide;
    const topW = (k: number) => Math.min(sw * k * 0.86, rw * 0.8);
    const quad = (cx: number, k: number, y0: number, y1: number, w1: number): number[] => [cx - sw * k, y(y0), cx + sw * k, y(y0), cx + w1, y(y1), cx - w1, y(y1)];
    const pieces: number[][] = [];
    const plateTop = lerp(lowH, faceH, 0.45) + (100 * 0.0325 * W) / H + 1.5;
    const lowPart = (cx: number, k: number) => (open && front ? quad(cx, k * 0.9, faceH - 1, footH + 1.5, sw * k * 1.05) : quad(cx, k, Math.min(footH - 1, front ? faceH + 1 : plateTop), footH - 1, sw * k * 0.86));
    const roofPart = (cx: number, k: number) => [cx - sw * k, y(topH - 4), cx + sw * k, y(topH - 4), cx + topW(k), y(100) + 1.5 * ow, cx - topW(k), y(100) + 1.5 * ow];
    const at = lay === "twin" ? [-sw * 0.9, sw * 0.9] : lay === "offset" ? [0.14 * W] : [0];
    const k = lay === "twin" ? 0.5 : 1;
    for (const cx of at) {
      pieces.push(lowPart(cx, k));
      if (!open) pieces.push(roofPart(cx, k));
    }
    pen.poly(joinShapes(pieces), stripeCol);
  }

  // ---- the lights' state -----------------------------------------------------------------------------------------------------
  const flat = !nightDrive();

  // the lit rim along the top of the glass and the pillars
  tier(medK, () => {
    if (open) pen.line([-gxMax * 0.8, gyA + ow, gxMax * 0.8, gyA + ow], ow, L.rim, L.rimA);
    else pen.line([-sd * bw * 0.97, y(p.beltH + 2), -sd * rw * 1.02, y(topH - 3), sd * rw * 0.82, y(100) + 1.2 * ow], ow, L.rim, L.rimA);
  });
  // the extras that stand on the roof (and a classic roof rack or box)
  drawRoofExtras();
  drawShoulders();

  /** the shoulder's lit line over each hip, a metallic car's second one under it */
  if (front) {
    drawFront();
  } else {
    drawBack();
  }

  function drawShoulders(): void {
    if (front) return;
    tier(medK, () => {
      const hy = y(lerp(lowH, p.beltH, 0.66));
      pen.line([-hip * 0.93, hy, hip * 0.93, hy], Math.max(ow * 0.7, 0.012 * H), up(paint, 0.3 * sheen), 0.5);
    });
  }

  function drawRoofExtras(): void {
    const ex = R.extras;
    if (open) {
      if (ex.includes("antenna")) tier(fineK, () => pen.line([0.3 * W, y(footH), 0.3 * W, y(100) - 0.1 * H], ow * 0.7, trim));
      return;
    }
    const topY = y(100);
    if (ex.includes("light_bar")) tier(medK, () => pen.rect(-rw * 0.72, topY - 0.045 * H, rw * 1.44, 0.04 * H, 0.012 * W, trim));
    if (ex.includes("roof_rails") || R.roof.rails) tier(fineK, () => pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * rw * 0.8 - 0.008 * W, topY - 0.03 * H, 0.016 * W, 0.04 * H, 0.004 * W))), trim));
    if (ex.includes("antenna")) tier(fineK, () => pen.line([0.28 * rw, topY + 0.01 * H, 0.28 * rw, topY - 0.12 * H], ow * 0.7, trim));
    if (ex.includes("roof_scoop")) tier(medK, () => pen.rect(-rw * 0.3, topY - 0.02 * H, rw * 0.6, 0.03 * H, 0.01 * W, dark));
    if (car.extra === "roof_rack") tier(medK, () => pen.line([-0.42 * rw * 1.7, topY, -0.42 * rw * 1.7, topY - 0.06 * H, 0.42 * rw * 1.7, topY - 0.06 * H, 0.42 * rw * 1.7, topY], 0.025 * W, g("#3d4250")));
    else if (car.extra === "roof_box") tier(medK, () => pen.rect(-0.32 * rw * 1.7, topY - 0.16 * H, 0.64 * rw * 1.7, 0.16 * H + ow, 0.05 * W, g("#454b58")));
  }

  /** An open sculpted car, head on: the hood is a lit panel between two fender crowns whose ridges run from the screen's
   * corners down to the nose, and big S-shaped intakes sit under the lamps either side of the wide mouth. */
  function frontSculpt(u: number): void {
    const ridge = mirror((sx) => [[sx * bw * 0.86, y(footH - 1), sx * 0.31 * W, y(lerp(faceH, footH, 0.56)), sx * 0.19 * W, y(faceH + 1), sx * 0.19 * W + sx * 0.012 * W, y(faceH + 1), sx * 0.31 * W + sx * 0.016 * W, y(lerp(faceH, footH, 0.56)) + 0.012 * H, sx * bw * 0.86 + sx * 0.02 * W, y(footH - 1) + 0.016 * H]]);
    tier(medK, () => {
      pen.poly(joinShapes(ridge), up(paint, 0.4 * sheen), 0.8);
      // the fender crowns: a lit crescent over each wheel, high and wide, so the nose is low between two humps
      pen.poly(joinShapes(mirror((sx) => [[sx * hip * 0.99, y(lerp(lowH, p.beltH, 0.72)), sx * hip * 0.9, y(p.beltH - 1), sx * 0.4 * W, y(footH - 5), sx * 0.34 * W, y(footH - 5) + 0.02 * H, sx * 0.42 * W, y(p.beltH - 6), sx * hip * 0.97, y(lerp(lowH, p.beltH, 0.5))]])), up(paint, 0.22 * sheen), 0.5);
    });
    // the S-shaped intakes: a dark blade each side of the mouth, curling out under the lamp, with a lit rim
    const ys0 = y(p.chinH + 3);
    const ys1 = y(lerp(p.chinH, faceH, 0.98));
    const sShape = (sx: number): number[] => roundPath([cp(sx * 0.3 * W, ys0, 4 * u), cp(sx * 0.31 * W, lerp(ys0, ys1, 0.5), 10 * u), cp(sx * 0.44 * W, lerp(ys0, ys1, 0.6), 6 * u), cp(sx * 0.485 * W, ys1, 5 * u), cp(sx * 0.36 * W, lerp(ys0, ys1, 0.42), 14 * u), cp(sx * 0.37 * W, ys0, 4 * u)]);
    pen.poly(joinShapes(mirror((sx) => [outlined(sShape(sx), 0.011 * W)])), up(paint, 0.3 * sheen), 0.8);
    pen.poly(joinShapes(mirror((sx) => [sShape(sx)])), g("#0d0e12"));
  }

  // ===========================================================================================================================
  function drawFront(): void {
    const lamps = frontLamps(R, E, lit);
    const mouth = face && car.face.mouth === "grille" ? face.mouth : null;
    const headEyes = face !== null && car.face.eyes === "headlights";
    const u = W / 400;

    if (sculpt) frontSculpt(u);
    // the bonnet's own parts
    if (hasBand) {
      const by0 = y(faceH);
      const by1 = y(bandTop);
      const v = R.bonnet.vent;
      tier(medK, () => {
        if (v === "scoop") pen.poly([-0.12 * W, lerp(by0, by1, 0.7), 0.12 * W, lerp(by0, by1, 0.7), 0.09 * W, lerp(by0, by1, 0.25), -0.09 * W, lerp(by0, by1, 0.25)], dark);
        else if (v === "vents") pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * 0.15 * W - 0.07 * W, lerp(by0, by1, 0.4), 0.14 * W, Math.max(1.5, 0.012 * H), 0.004 * W))), dark);
        else if (v === "duct") pen.rect(-0.3 * W, lerp(by0, by1, 0.78), 0.6 * W, Math.max(2, (by0 - by1) * 0.12 * 1), 0.01 * W, dark);
        else if (v === "bulge") pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * 0.12 * W - 0.012 * W, by1 + 1, 0.024 * W, Math.max(2, by0 - by1 - 2), 0.006 * W))), up(paint, 0.3), 0.45);
      });
    }

    // the low mouth, the grille's box: one dark shape (the mouth's parts joined)
    const openings: number[][] = [];
    const iy0 = y(p.chinH + 3);
    const iy1 = y(lerp(p.chinH, Math.max(p.tipH, faceH - 4), open ? 0.95 : 0.82));
    const part = (x0: number, x1: number): number[] => roundPath([cp(x0, iy0, 5 * u), cp(x0 + (x0 < 0 ? -0.02 : 0) * W, iy1, 6 * u), cp(x1 + (x1 > 0 ? 0.02 : 0) * W, iy1, 6 * u), cp(x1, iy0, 5 * u)]);
    const itk = R.front.intake;
    if (itk === "split3") openings.push(part(-0.37 * W, -0.15 * W), part(-0.12 * W, 0.12 * W), part(0.15 * W, 0.37 * W));
    else if (itk === "wide") openings.push(part(-0.36 * W, 0.36 * W));
    else if (itk === "twin") openings.push(part(-0.4 * W, -0.2 * W), part(0.2 * W, 0.4 * W));
    else if (itk === "smile") openings.push(roundPath([cp(-0.34 * W, y(lerp(p.chinH, p.tipH, 0.7)), 8 * u), cp(0, y(p.chinH + 3), 14 * u), cp(0.34 * W, y(lerp(p.chinH, p.tipH, 0.7)), 8 * u), cp(0, y(lerp(p.chinH, p.tipH, 0.72)), 12 * u)]));
    const gk = R.front.grille;
    const gcy = y(lerp(p.tipH, p.noseH, 0.45));
    const gh = (H * (p.noseH - p.chinH)) / 100;
    if (mouth === null && gk !== "none") {
      if (gk === "slot") openings.push(rr(-0.2 * W, gcy - 0.012 * W, 0.4 * W, 0.024 * W, 0.01 * W));
      else if (gk === "oval") openings.push(arcPts(0, gcy, 0.22 * W, Math.max(0.03 * W, gh * 0.2), 0, 360, 16));
      else if (gk === "tall") openings.push(rr(-0.14 * W, y(p.noseH - 2), 0.28 * W, Math.max(0.05 * W, y(p.tipH) - y(p.noseH - 2)), 0.015 * W));
      else if (gk === "twin") openings.push(rr(-0.22 * W, gcy - gh * 0.12, 0.17 * W, gh * 0.24, 0.015 * W), rr(0.05 * W, gcy - gh * 0.12, 0.17 * W, gh * 0.24, 0.015 * W));
      else openings.push(rr(-0.2 * W, gcy - gh * 0.15, 0.4 * W, gh * 0.3, 0.02 * W));
    }
    if (openings.length > 0) pen.poly(joinShapes(openings), g(GRILLE));
    if (sculpt && itk === "wide") {
      // the wide mouth is mesh: a lattice of fine lit diagonals inside the dark opening
      tier(medK, () => {
        const xa = -0.33 * W;
        const xb = 0.33 * W;
        const ya = iy0 - 0.012 * H;
        const yb = iy1 + 0.012 * H;
        const h = Math.abs(ya - yb);
        const st = Math.max(5, 0.028 * W);
        const t = Math.max(1, 0.0045 * W);
        const ln: number[][] = [];
        for (let x = xa; x + h <= xb; x += st) {
          ln.push([x, ya, x + h, yb, x + h + t, yb, x + t, ya]);
          ln.push([x + h, ya, x, yb, x + t, yb, x + h + t, ya]);
        }
        pen.poly(joinShapes(ln), up(g("#3a3d46"), 0.2), 0.8);
      });
    }
    if (mouth === null && gk !== "none" && gk !== "slot" && gk !== "oval") {
      tier(medK, () => {
        const bars: number[][] = [];
        const n = gk === "slats" || gk === "mesh" ? 5 : 1;
        for (let i = 0; i < n; i += 1) {
          const yy = n === 1 ? gcy : lerp(gcy - gh * 0.11, gcy + gh * 0.11, i / (n - 1));
          bars.push(rr(-0.17 * W, yy - 0.004 * W, 0.34 * W, 0.008 * W, 0.003 * W));
        }
        pen.poly(joinShapes(bars), metal, 0.7);
      });
    }
    if (mouth !== null) {
      // a grille mouth in the face: it takes the place of the grille and bends with the expression
      const gy = gcy;
      if (mouth === "o" || mouth === "bigo") pen.ellipse(0, gy, 0.12 * W, 0.06 * W + 0.05 * W * clamp(face!.mouthOpen, 0.3, 1.3), 0, g(MOUTH_DARK));
      else {
        const c = MOUTH_CURVE[mouth] ?? 0;
        pen.line(quadPts(-0.24 * W, gy - c * 0.04 * W, 0, gy + c * 0.06 * W, 0.24 * W, gy - c * 0.04 * W, 8), Math.max(2, 0.07 * H * 0.5), g(GRILLE));
      }
    }

    // the splitter, the bumper, the fog lamps
    const sp = R.front.splitter;
    if (sp !== "none") tier(medK, () => pen.rect(-hip * (sp === "blade" ? 1.03 : 0.96), y(p.chinH + 1.5), hip * (sp === "blade" ? 2.06 : 1.92), Math.max(2, (H * (sp === "blade" ? 2.6 : 1.4)) / 100), 2, g("#17181d")));
    if (R.front.bumper !== "body") tier(medK, () => pen.rect(-hip * 1.01, y(p.chinH + 10), hip * 2.02, Math.max(3, 0.05 * H), 0.02 * W, R.front.bumper === "chrome" ? metal : trim));
    if (R.front.fog) tier(fineK, () => pen.poly(joinShapes([-1, 1].map((sx) => circ(sx * 0.3 * W, y(p.chinH + 11), 0.026 * W))), lit ? ND.headCore : g("#cfd3da"), 0.9));
    if (R.extras.includes("bull_bar")) tier(medK, () => pen.line([-0.26 * W, y(p.chinH + 4), -0.26 * W, y(faceH - 18), 0.26 * W, y(faceH - 18), 0.26 * W, y(p.chinH + 4)], 0.02 * W, metal));
    if (R.extras.includes("tow_hook")) tier(fineK, () => pen.circle(0.2 * W, y(p.chinH + 6), 0.016 * W, g("#c5352f")));
    if (R.extras.includes("snorkel")) tier(fineK, () => pen.line([bw * 0.97, y(footH), bw * 0.92, y(topH - 3)], 0.016 * W, trim));

    // the mirrors on the screen's sides
    if (R.side.mirror !== "none") {
      const mh = open ? y(footH + 1) : y(Math.max(footH, p.beltH) + 3);
      tier(medK, () =>
        pen.poly(
          joinShapes([-1, 1].map((sx) => arcPts(sx * ((open ? bw * 0.9 : hip * 0.965) + (R.side.mirror === "square" ? 0.06 : 0.035) * W + (showSide && sx === sd ? sd * depth * 0.3 : 0)), mh, R.side.mirror === "square" ? 0.026 * W : 0.05 * W, R.side.mirror === "square" ? 0.055 * W : 0.034 * W, 0, 360, 10))),
          mirrorCol,
        ),
      );
    }

    // the lamps: bloom behind, then the lens, its bezel, its shine and the daytime line
    const dkLens = R.lights.front.lens;
    const lensOff = dkLens === "yellow" ? g("#f1d36a") : dkLens === "smoked" ? g("#2d3038") : g(LENS_OFF);
    const lensOn = dkLens === "yellow" ? mix(ND.headCore, "#ffd54a", 0.45) : dkLens === "smoked" ? mix(ND.headCore, "#9aa3b0", 0.35) : ND.headCore;
    const lens = lit || o.blink > 0.3 ? lensOn : lensOff;
    const lensR = lamps.r;
    const flare = (o.bloom ?? 1) * ((lit ? (night ? 1 : 0.5) : 0) + 0.8 * o.blink) * (headEyes ? 0.6 : 1);
    if (flare > 0.02) {
      if (!flat) headBloom(pen, lamps.cx, lamps.cy, lensR, flare);
      else {
        pen.ellipse(0, lamps.cy, lamps.cx + lensR * 3, lensR * 2.6, 0, ND.headBloom, Math.min(1, 0.14 * flare));
        pen.poly(joinShapes([-1, 1].map((sx) => circ(sx * lamps.cx, lamps.cy, lensR * 1.6))), ND.headBloom, Math.min(1, 0.45 * flare));
      }
    }
    if (!headEyes) {
      if (lamps.polys.length > 0) {
        tier(medK, () => pen.poly(joinShapes(lamps.polys.map((q) => outlined(q, Math.max(1, 0.008 * W)))), g("#2a2c33")));
        if (R.lights.front.shape === "swept") {
          // dark glass with a small lit core at the inner end (the projector)
          pen.poly(joinShapes(lamps.polys), g("#171a20"));
          // and a lit strip along the lamp's top edge, from the outer corner in and down
          const tw = Math.max(1.4, 0.011 * W) / 2;
          const seg = (x0: number, y0: number, x1: number, y1: number): number[] => {
            const dx = x1 - x0;
            const dy = y1 - y0;
            const d = Math.hypot(dx, dy) || 1;
            const nx = (-dy / d) * tw;
            const ny = (dx / d) * tw;
            return [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
          };
          pen.poly(joinShapes([-1, 1].flatMap((sx) => [seg(sx * (lamps.cx + 0.09 * W), lamps.cy - 0.014 * W, sx * (lamps.cx + 0.01 * W), lamps.cy - 0.03 * W), seg(sx * (lamps.cx + 0.01 * W), lamps.cy - 0.03 * W, sx * (lamps.cx - 0.1 * W), lamps.cy + 0.016 * W)])), lens);
        } else pen.poly(joinShapes(lamps.polys), lens);
        tier(medK, () => {
          pen.poly(
            joinShapes(
              lamps.polys.map((q) => {
                const [x0, y0, x1, y1] = boxOf(q);
                return [x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.12, x1 - (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.12, x1 - (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.3, x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.3];
              }),
            ),
            "#ffffff",
            lit ? 0.18 : 0.5,
          );
        });
      }
      drlLine(lamps);
    }

    if (face === null) return;
    // a car with eyes looks out at the camera: headlight eyes or windscreen eyes
    const closedBy = Math.max(face.eyes === "normal" || face.eyes === "lidded" ? blinkAt(o.seed, o.t) : 0, o.blink);
    const iris = g(hex(car.face.color, "#1c1842"));
    const straight = { ...face, lookX: face.lookX - 0.36 };
    if (headEyes) {
      const rx = Math.min(0.085 * W, lamps.r * 1.45);
      for (const x of [-1, 1]) eyeLite(pen, x * lamps.cx, lamps.cy, rx, rx * 1.05, straight, closedBy, iris, inkC, lens, paint, o.t, x);
      carBrows(pen, [-lamps.cx, lamps.cx], lamps.cy, rx, rx * 1.05, face, inkC);
      return;
    }
    const gh2 = Math.abs(gyB - gyA);
    const rx = Math.min(0.1 * W, (gh2 * 0.4) / 1.15);
    const ey = (gyA + gyB) / 2;
    for (const x of [-1, 1]) eyeLite(pen, x * 0.2 * W, ey, rx, rx * 1.15, straight, closedBy, iris, inkC, g("#ffffff"), glass, o.t, x);
    carBrows(pen, [-0.2 * W, 0.2 * W], ey, rx, rx * 1.15, face, inkC);
  }

  /** the daytime running light by its style, along the lamp (lit when the lights are on) */
  function drlLine(lamps: EndLamps): void {
    const dl = R.lights.front.drl;
    if (dl === "none" || lamps.polys.length === 0) return;
    const col = lit ? ND.headCore : g("#d9dde3");
    tier(medK, () => {
      const t = Math.max(1.2, 0.009 * W);
      if (dl === "ring") {
        for (const sx of [-1, 1]) pen.line(arcPts(sx * lamps.cx, lamps.cy, lamps.r * 1.22, lamps.r * 1.22, 0, 360, 14), t, col, 0.9);
        return;
      }
      const strips: number[][] = [];
      for (const q of lamps.polys) {
        const [x0, y0, x1, y1] = boxOf(q);
        if (dl === "line") strips.push([x0, y1 + t, x1, y1 + t, x1, y1 + 2.2 * t, x0, y1 + 2.2 * t]);
        else if (dl === "brow") strips.push([x0, y0 - 2.2 * t, x1, y0 - 2.2 * t, x1, y0 - t, x0, y0 - t]);
        else if (dl === "hook") {
          const sx = (x0 + x1) / 2 < 0 ? x0 : x1;
          strips.push([x0, y1 + t, x1, y1 + t, x1, y1 + 2.2 * t, x0, y1 + 2.2 * t]);
          strips.push([sx < 0 ? sx - 2.2 * t : sx + t, y0, sx < 0 ? sx - t : sx + 2.2 * t, y0, sx < 0 ? sx - t : sx + 2.2 * t, y1 + 2.2 * t, sx < 0 ? sx - 2.2 * t : sx + t, y1 + 2.2 * t]);
        } else for (let i = 0; i < 3; i += 1) strips.push(circ(x0 + ((x1 - x0) * (i + 0.5)) / 3, y1 + 2.4 * t, 0.9 * t, 6));
      }
      pen.poly(joinShapes(strips), col, 0.9);
    });
  }

  /** An open sculpted car, from behind: the engine cover is a flat panel between two high haunches, with louvres. */
  function backSculpt(): void {
    const hi = y(footH + 1);
    const lo = y(faceH - 6);
    tier(medK, () => {
      pen.poly(joinShapes(mirror((sx) => [[sx * 0.45 * W, lo, sx * 0.33 * W, hi, sx * 0.1 * W, hi, sx * 0.1 * W, lo]])), up(paint, 0.2 * sheen), 0.55);
      pen.poly(joinShapes(mirror((sx) => [[sx * hip * 0.99, y(lerp(lowH, p.beltH, 0.8)), sx * hip * 0.96, lo, sx * 0.44 * W, lo + 0.012 * H, sx * 0.47 * W, y(lerp(lowH, p.beltH, 0.74))]])), up(paint, 0.3 * sheen), 0.6);
    });
    tier(fineK, () => {
      const lv: number[][] = [];
      for (let i = 0; i < 4; i += 1) {
        const yy = lerp(lo + 0.02 * H, hi + 0.03 * H, i / 3);
        for (const sx of [-1, 1]) lv.push(rr(sx * 0.2 * W - 0.09 * W, yy, 0.18 * W, Math.max(1.5, 0.008 * H), 0.003 * W));
      }
      pen.poly(joinShapes(lv), g("#101115"), 0.8);
    });
  }

  // ===========================================================================================================================
  function drawBack(): void {
    const lamps = rearLamps(R, E);
    const u = W / 400;
    if (sculpt) backSculpt();
    // the tail's rim: a spoiler, the deck's edge
    const spoil = R.rear.spoiler;
    const faceTop = y(faceH);

    // the diffuser: dark, with its fins
    if (R.rear.diffuser !== "none") {
      const deep = R.rear.diffuser === "deep";
      const dy0 = y(lowH + 0.5);
      const dy1 = y(lowH + (deep ? 16 : 11));
      pen.poly(roundPath([cp(-0.31 * W, dy0, 3 * u), cp(-0.27 * W, dy1, 6 * u), cp(0.27 * W, dy1, 6 * u), cp(0.31 * W, dy0, 3 * u)]), g("#15161a"));
      tier(medK, () => {
        const fins: number[][] = [];
        for (const fx of [-0.2, -0.1, 0, 0.1, 0.2]) fins.push([fx * W - 0.004 * W, dy0, fx * W + 0.004 * W, dy0, fx * W + 0.004 * W, dy1 + 1, fx * W - 0.004 * W, dy1 + 1]);
        pen.poly(joinShapes(fins), g("#4a4e57"));
      });
    }

    // the plate: two plain rectangles (the plate, and a paler strip of its writing area)
    const plateY = y(lerp(lowH, faceH, 0.45));
    const spareOn = R.extras.includes("spare_wheel");
    const plateH = 0.065 * W;
    pen.rect(-0.13 * W, plateY - plateH / 2, 0.26 * W, plateH, 0.01 * W, g(PLATE));
    pen.rect(-0.1 * W, plateY - plateH * 0.22, 0.2 * W, plateH * 0.44, 0.006 * W, mix(g(PLATE), "#8f949c", 0.45));

    // exhausts by their layout: a ring and a dark mouth each
    const ex = R.rear.exhaust;
    const tips: [number, number][] = [];
    const yLow = y(lowH + 4);
    if (ex === "single") tips.push([0.3 * W, yLow]);
    else if (ex === "twin") tips.push([-0.2 * W, yLow], [0.2 * W, yLow]);
    else if (ex === "quad") tips.push([-0.32 * W, yLow], [-0.17 * W, yLow], [0.17 * W, yLow], [0.32 * W, yLow]);
    else if (ex === "centre") tips.push([0, yLow]);
    else if (ex === "high") for (const sx of [-1, 1]) tips.push([sx * 0.2 * W, plateY]);
    else if (ex === "side") tips.push([0.42 * W, yLow]);
    if (tips.length > 0 && ex !== "stack") {
      tier(medK, () => {
        pen.poly(joinShapes(tips.map(([x, yy]) => circ(x, yy, 0.036 * W, 10))), g("#8f949c"));
        pen.poly(joinShapes(tips.map(([x, yy]) => circ(x, yy, 0.024 * W, 10))), "#0c0b10");
      });
    }
    if (ex === "stack") tier(medK, () => pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * 0.47 * W - 0.012 * W, y(p.beltH), 0.024 * W, y(lowH + 4) - y(p.beltH), 0.008 * W))), metal, 0.9));
    if (R.rear.bumper !== "body") tier(medK, () => pen.rect(-hip * 1.01, y(lowH + 12), hip * 2.02, Math.max(3, 0.05 * H), 0.02 * W, R.rear.bumper === "chrome" ? metal : trim));

    // a spare wheel on the tail, above the plate
    if (spareOn) {
      const room = plateY - plateH / 2 - faceTop;
      const r = Math.min(0.15 * W, room * 0.46);
      if (r > 0.04 * W) {
        const cy = plateY - plateH / 2 - r - 0.012 * W;
        tier(medK, () => {
          pen.circle(0, cy, r, TYRE_ND);
          pen.circle(0, cy, r * 0.58, g("#c9ccd2"));
        });
      }
    }

    // spoilers: a lip or a ducktail on the deck's edge, a wing on stalks, a bar on the roof
    const deckY = y(Math.max(faceH, Math.min(footH, faceH + 3)));
    if (spoil === "lip" || spoil === "ducktail") {
      const tall = spoil === "ducktail" ? 0.03 : 0.022;
      pen.rect(-hip * 0.78, deckY - tall * H, hip * 1.56, tall * H + 2, 0.012 * W, spoil === "lip" ? trim : mix(paint, ND.celDark, 0.3));
    } else if (spoil === "wing" || spoil === "big_wing") {
      const wy = deckY - (spoil === "big_wing" ? 0.1 : 0.07) * H;
      const wide = spoil === "big_wing" ? 0.49 : 0.43;
      tier(medK, () => pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * 0.3 * W - 0.008 * W, wy, 0.016 * W, deckY - wy, 0.004 * W))), trim));
      pen.poly(joinShapes([rr(-wide * W, wy - 0.012 * H, 2 * wide * W, 0.03 * H + 1, 0.01 * W), ...[-1, 1].map((sx) => rr(sx * wide * W - 0.008 * W, wy - 0.04 * H, 0.016 * W, 0.075 * H, 0.004 * W))]), mix(paint, ND.celDark, 0.3));
    } else if (spoil === "roof" && !open) {
      tier(medK, () => pen.rect(-rw * 0.9, y(topH + 0.5), rw * 1.8, 0.04 * H, 0.01 * W, mix(paint, ND.celDark, 0.3)));
    }
    if (R.extras.includes("ladder")) tier(fineK, () => pen.poly(joinShapes([-1, 1].map((sx) => rr(sx * 0.47 * W - 0.008 * W, y(topH - 4), 0.016 * W, y(lowH + 8) - y(topH - 4), 0.004 * W))), trim));

    // the third lamp, on a closed roof only
    if (!open) {
      const col = braking ? ND.brakeCore : g(TAIL_OFF);
      tier(medK, () => pen.rect(-0.1 * W, y(topH - 7), 0.2 * W, 0.022 * W, 0.01 * W, col));
    }

    // the tail lamps: glow behind, the lens, its shine
    const lensKind = R.lights.rear.lens;
    const off = lensKind === "clear" ? mix(g(TAIL_OFF), "#ffffff", 0.55) : lensKind === "smoked" ? mix(g(TAIL_OFF), "#14101a", 0.6) : g(TAIL_OFF);
    const tailOnLens = lensKind === "smoked" ? mix(ND.tailCore, "#14101a", 0.25) : ND.tailCore;
    const lensCol = braking ? ND.brakeCore : tailOn ? tailOnLens : off;
    const glowA = Math.max(tailOn ? 0.25 : 0, braking ? 0.45 * o.braking : 0);
    if (glowA > 0) {
      if (!flat) {
        if (lamps.bar) softBar(pen, lamps.cy, lamps.polys.length > 0 ? boxOf(lamps.polys[0]!)[2] : 0.4 * W, 0.02 * W, 0.05 * W, glowA / 0.45);
        else softPair(pen, [-lamps.cx, lamps.cx], lamps.cy, lamps.r, lamps.r * 1.5, ND.tailGlow, glowA / 0.45);
      } else if (lamps.bar) pen.ellipse(0, lamps.cy, 0.43 * W + 0.04 * W, 0.05 * W, 0, ND.tailGlow, glowA);
      else pen.poly(joinShapes([-1, 1].map((sx) => circ(sx * lamps.cx, lamps.cy, lamps.r * 1.9, 18))), ND.tailGlow, glowA * 0.8);
    }
    pen.poly(joinShapes(lamps.polys), lensCol);
    if (sculpt && R.lights.rear.shape === "round") pen.poly(joinShapes([-1, 1].map((sx) => circ(sx * lamps.cx, lamps.cy, lamps.r * 0.52))), g("#16171c"));
    tier(medK, () => {
      pen.poly(
        joinShapes(
          lamps.polys.map((q) => {
            const [x0, y0, x1, y1] = boxOf(q);
            return [x0 + (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.14, x1 - (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.14, x1 - (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.32, x0 + (x1 - x0) * 0.1, y0 + (y1 - y0) * 0.32];
          }),
        ),
        mix(lensCol, "#ffffff", 0.3),
        0.7,
      );
    });
    // the shut line of a boot or a hatch
    tier(fineK, () => {
      if (open) return;
      if (car.body === "van") pen.line([0, y(topH - 3), 0, y(lowH + 6)], ow * 0.35, inkC, 0.8);
    });
  }
}

// ---- night drive's soft lights (the same glows the classic views draw) ---------------------------------------------------

/** A pair of lights' soft bloom (night drive): one soft glow round each lens of radius `r`, fading to clear `reach` past it. */
function softPair(pen: Pen, xs: number[], yy: number, r: number, reach: number, color: string, k: number): void {
  const Rr = r + reach;
  const fade = haloStops(1, r / Rr);
  for (const x of xs) pen.glow(x, yy, Rr, Rr * 0.86, color, fade, Math.min(1, 0.8 * k));
}

/** Night drive's headlights: a soft white bloom round each lens, further and stronger with `flare`. */
function headBloom(pen: Pen, hx: number, hy: number, lensR: number, flare: number): void {
  const f = Math.min(flare, 2.2);
  softPair(pen, [-hx, hx], hy, lensR, lensR * (1.3 + 1.2 * f), ND.headBloom, Math.min(1.3, 0.55 + 0.45 * f));
}

/** Night drive's bar tail light's glow (half width `hw`, half height `hh`): one soft glow along the bar. */
function softBar(pen: Pen, yy: number, hw: number, hh: number, reach: number, k: number): void {
  pen.glow(0, yy, hw + 2.5 * reach, hh + 0.7 * reach, ND.tailGlow, haloStops(1, 0.5, 2), Math.min(1, 0.8 * k));
}

/** carEye without the glint (three shapes): the eyes of a front view, which shows many small cars. */
function eyeLite(pen: Pen, x: number, yy: number, rx: number, ry: number, f: FaceParams, closedBy: number, iris: string, inkC: string, white: string, lid: string, t: number, sgn: number): void {
  if (f.eyes === "happy" || f.eyes === "closed" || f.open * (1 - closedBy) < 0.16 || f.eyes === "spiral" || f.eyes === "lidded") {
    carEye(pen, x, yy, rx, ry, f, closedBy, iris, inkC, white, lid, t, sgn, white);
    return;
  }
  const eh = ry * Math.min(1.35, f.open * (1 - closedBy));
  const ew = rx * (1 + 0.06 * (f.open - 1));
  const lw = Math.max(2, rx * 0.24);
  pen.ellipse(x, yy, ew + lw * 0.6, eh + lw * 0.6, 0, inkC);
  pen.ellipse(x, yy, ew, eh, 0, white);
  const ir = Math.min(ew * 0.56 * f.pupil, eh * 0.9);
  pen.circle(x + clamp(f.lookX * 0.7 + 0.25, -1, 1) * (ew - ir) * 0.8, yy + clamp(f.lookY, -1, 1) * Math.max(0, eh - ir) * 0.8, ir, iris);
}
