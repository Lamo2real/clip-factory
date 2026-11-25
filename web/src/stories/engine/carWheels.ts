// Clips Funded engine: the detailed vehicle's wheels, tyres and brakes in the side view (CONTRACTS §45.48 section 3.1).
// One function draws one wheel in both palettes (Bright and Night drive) from the resolved look: the tyre (Bright adds an
// ink ring, Night drive a lighter sidewall disc), the rim's lip, the dark barrel, the brake disc, the caliper, the spokes
// and the hub as ONE polygon, an optional flat hub disc (never a mark), and the rim shine (Bright) or the inner rim shadow
// (Night drive). Eleven shapes: steel, cap, straight, split, y, star, mesh, turbine, dish, wire, block.
//
// What turns and what does not: the spokes, the holes of a steel wheel and the tread blocks turn with `spin`; the disc,
// the caliper (fixed: behind the axle on the front wheel at 200 degrees, ahead of it on the rear at -20) and the shine do
// not. A flat tyre squashes the whole wheel to 0.72 of its height with its bottom on the ground, spokes and all.
// Level of detail: the tyre, barrel and spokes always show; the lip, the disc, the caliper and the Night drive shadow fade
// in at MEDIUM sizes; the disc's holes and the Bright shine at FINE ones (Sty.fade, an alpha fade, so nothing pops).

import { ND } from "./art.ts";
import { resolveDetail, type Resolved } from "./carDetail.ts";
import { SIDEWALL_ND } from "./car.ts";
import { styleOf, type Sty } from "./carParts.ts";
import { clamp, hex, TAU } from "./math.ts";
import { arcPts, joinShapes, type Pen } from "./pen.ts";
import type { CarLook } from "./types.ts";

/** The two alpha-fade tiers of a wheel's parts, in on-screen size (design-final section 3). */
export const WHEEL_MEDIUM: [number, number] = [0.2, 0.42];
export const WHEEL_FINE: [number, number] = [0.42, 0.7];

const rev = (pts: number[]): number[] => {
  const o: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) o.push(pts[i]!, pts[i + 1]!);
  return o;
};

/** A spoke: a quad from radius `ra` at angle `a0` to radius `rb` at angle `a1`, `w0` wide at the start and `w1` at the end. */
function spokeQuad(a0: number, a1: number, w0: number, w1: number, ra: number, rb: number): number[] {
  const c0 = Math.cos(a0);
  const s0 = Math.sin(a0);
  const c1 = Math.cos(a1);
  const s1 = Math.sin(a1);
  return [c0 * ra - s0 * w0, s0 * ra + c0 * w0, c1 * rb - s1 * w1, s1 * rb + c1 * w1, c1 * rb + s1 * w1, s1 * rb - c1 * w1, c0 * ra + s0 * w0, s0 * ra - c0 * w0];
}

/** The spokes of one shape as closed shapes round the origin (`r0` the hub's edge, `r1` the rim's, `n` the count, `spin` in
 * radians), the hub included. The caller joins them into one polygon. */
export function spokeShapes(r0: number, r1: number, n: number, shape: string, spin: number): number[][] {
  const out: number[][] = [];
  const w = (r1 * Math.PI) / n;
  for (let i = 0; i < n; i += 1) {
    const a = spin + (i / n) * TAU;
    switch (shape) {
      case "split": {
        // the forged twin-spoke star: each of the n arms is ONE bold stem from the hub that forks into two prongs near the
        // rim, a dark gap between the arms (five chunky arms, not ten blades). Wide at the root, the prongs flare apart.
        const rm = r0 + (r1 - r0) * 0.5;
        const k = 5 / Math.max(3, n); // fewer arms are broader, more arms slimmer (the width is set for five)
        const at = (rad: number, o: number): [number, number] => [Math.cos(a) * rad - Math.sin(a) * o, Math.sin(a) * rad + Math.cos(a) * o];
        const hs = w * 0.42 * Math.min(1, k + 0.15); // the stem's half width
        const s0 = at(r0, -hs);
        const s1 = at(r0, hs);
        const m0 = at(rm, -hs * 0.95);
        const m1 = at(rm, hs * 0.95);
        // the two prongs: from the stem's two edges out to the rim, their tips wide apart
        const tipO = w * 0.52;
        const tw = w * 0.2;
        const nL = at(rm - (r1 - r0) * 0.07, 0); // the notch where the prongs part
        const l0 = at(r1, -tipO - tw);
        const l1 = at(r1, -tipO + tw);
        const r_0 = at(r1, tipO - tw);
        const r_1 = at(r1, tipO + tw);
        out.push([s0[0], s0[1], m0[0], m0[1], l0[0], l0[1], l1[0], l1[1], nL[0], nL[1], r_0[0], r_0[1], r_1[0], r_1[1], m1[0], m1[1], s1[0], s1[1]]);
        break;
      }
      case "y": {
        const d = (0.5 * Math.PI) / n;
        out.push(spokeQuad(a, a, w * 0.22, w * 0.17, r0, r1 * 0.56), spokeQuad(a, a - d, w * 0.14, w * 0.1, r1 * 0.5, r1), spokeQuad(a, a + d, w * 0.14, w * 0.1, r1 * 0.5, r1));
        break;
      }
      case "turbine":
        out.push(spokeQuad(a, a + (0.95 * Math.PI) / n, w * 0.34, w * 0.1, r0, r1));
        break;
      case "mesh": {
        const d = Math.PI / n;
        out.push(spokeQuad(a, a + d, w * 0.1, w * 0.08, r0, r1), spokeQuad(a, a - d, w * 0.1, w * 0.08, r0, r1));
        break;
      }
      case "star":
        out.push(spokeQuad(a, a, w * 0.46, w * 0.09, r0 * 0.6, r1));
        break;
      case "wire": {
        // laced hair-thin spokes: each leaves the hub tangentially and crosses its neighbour
        const d = 0.9 * Math.PI * (2 / n);
        out.push(spokeQuad(a, a + d, w * 0.045, w * 0.045, r0, r1), spokeQuad(a, a - d, w * 0.045, w * 0.045, r0, r1));
        break;
      }
      case "dish":
        // a deep plain dish: one wide round web (slots are drawn apart, so the dish itself is one shape)
        if (i === 0) out.push(arcPts(0, 0, r1 * 0.97, r1 * 0.97, 0, 360, 24).slice(0, -2));
        break;
      case "block":
        out.push(spokeQuad(a, a + 0.12 / Math.max(1, n / 6), w * 0.42, w * 0.3, r0, r1 * 0.96));
        break;
      default:
        // straight: a tapered spoke, wider at the hub
        out.push(spokeQuad(a, a, w * 0.25, w * 0.17, r0, r1));
    }
  }
  const hubR = shape === "wire" ? r0 * 1.05 : shape === "dish" ? r0 * 1.1 : r0 * 1.28;
  out.push(arcPts(0, 0, hubR, hubR, 0, 360, 12).slice(0, -2));
  return out;
}

/** The slots of a dish wheel: n small rounded cuts round the web (they turn). */
function dishSlots(rr: number, n: number, spin: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const a = spin + (i / n) * TAU;
    out.push(spokeQuad(a, a, rr * 0.075, rr * 0.075, rr * 0.34, rr * 0.6));
  }
  return out;
}

/** The ring of the tyre's tread, a 28-point polygon with blocks (the off-road wheel), turning with `spin`. */
function blockTyre(r: number, spin: number, pad: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 28; i += 1) {
    const a = spin + (i / 28) * TAU;
    const rr = (i % 2 === 0 ? r : r * 0.9) + pad;
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return pts;
}

/**
 * One wheel of a detailed vehicle in the side view, drawn round (x, cy) with radius `r` (the tyre's), turned `spin`
 * radians. `front` picks the caliper's place. `rimRaw` is the look's own rim colour (the classic `wheels.rim`). Returns how
 * many shapes it drew. Bright draws no glow and reads no light; Night drive draws graded colours only.
 */
export function wheelPart(pen: Pen, S: Sty, R: Resolved, x: number, cy: number, r: number, spin: number, flat: boolean, front: boolean, rimRaw: string): number {
  const n0 = pen.out.length;
  const W = R.wheels;
  const B = R.brakes;
  const shape = W.shape;
  const sq = flat ? 0.72 : 1;
  const rr = r * (1 - clamp(W.tyre, 12, 60) / 100);
  const rim = S.t(hex(rimRaw, "#c9ccd2"));
  const med = S.fade(WHEEL_MEDIUM[0], WHEEL_MEDIUM[1]);
  const fine = S.fade(WHEEL_FINE[0], WHEEL_FINE[1]);
  const n = Math.round(clamp(W.spokes, 3, 24));
  pen.save();
  pen.translate(x, flat ? cy + r * (1 - sq) : cy);
  if (flat) pen.scale(1, sq);
  // the tyre
  const block = shape === "block";
  if (S.nd) {
    if (block) pen.poly(blockTyre(r, spin, S.ow), S.tyre);
    else pen.circle(0, 0, r + S.ow, S.tyre);
    pen.circle(0, 0, (r + rr) / 2 + 1, SIDEWALL_ND);
  } else {
    pen.circle(0, 0, r + 4.5, S.ink);
    if (block) pen.poly(blockTyre(r, spin, 0), S.tyre);
    else pen.circle(0, 0, r, S.tyre);
  }
  if (W.wall === "white") pen.line(arcPts(0, 0, (r + rr) / 2 + 1, (r + rr) / 2 + 1, 0, 360, 24), (r - rr) * 0.42, S.t("#efece4"));
  if (shape === "steel" || shape === "cap") {
    pen.circle(0, 0, rr, shape === "cap" ? S.dk(rim, 0.2) : rim);
    if (shape === "cap") {
      pen.circle(0, 0, rr * 0.62, S.t(W.hub ?? "#dfe3e8"));
      if (fine > 0.004) {
        pen.save();
        pen.fade(fine);
        pen.line(arcPts(0, 0, rr * 0.45, rr * 0.45, 200, 300, 6), rr * 0.09, "#ffffff", S.nd ? 0.3 : 0.7);
        pen.restore();
      }
    } else {
      const holes: number[][] = [];
      for (let i = 0; i < 8; i += 1) {
        const a = spin + (i / 8) * TAU;
        holes.push(arcPts(Math.cos(a) * rr * 0.62, Math.sin(a) * rr * 0.62, rr * 0.1, rr * 0.1, 0, 300, 6));
      }
      holes.push(arcPts(0, 0, rr * 0.3, rr * 0.3, 0, 360, 10).slice(0, -2));
      pen.poly(joinShapes(holes), S.dk(rim, 0.5));
    }
    pen.restore();
    return pen.out.length - n0;
  }
  // the rim: its lip, then the dark barrel (a dish wheel has a deep, wide polished lip)
  const lip = (shape === "dish" ? Math.max(W.lip, 70) : clamp(W.lip, 0, 100)) / 100;
  const lipRing = (shape === "dish" ? 0.26 : 0.07 + 0.1 * lip) * rr;
  pen.save();
  pen.fade(med);
  pen.circle(0, 0, rr, lip > 0.5 ? S.lt(rim, 0.35) : rim);
  pen.restore();
  pen.circle(0, 0, rr - lipRing * med, S.dk(rim, 0.5 + 0.0012 * clamp(W.dish, 0, 100) + 0.1));
  // the brake disc and its caliper, seen through the spokes (a deep dish hides them)
  if (B.disc !== "none" && shape !== "dish" && med > 0.004) {
    pen.save();
    pen.fade(med);
    pen.circle(0, 0, rr * 0.74, S.t(B.disc === "ceramic" ? "#34322f" : "#8f949c"));
    if (B.disc === "drilled" && fine > 0.004) {
      const holes: number[][] = [];
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * TAU;
        for (const k of [0.5, 0.64]) if ((i + (k > 0.55 ? 1 : 0)) % 2 === 0) holes.push(arcPts(Math.cos(a) * rr * k, Math.sin(a) * rr * k, rr * 0.028, rr * 0.028, 0, 300, 5));
      }
      pen.save();
      pen.fade(fine);
      pen.poly(joinShapes(holes), S.dk(S.t("#8f949c"), 0.6));
      pen.restore();
    }
    // the caliper: behind the axle and low on a front wheel, ahead of it and high on a rear one (it never turns)
    const a = front ? 152 : -28;
    pen.poly([...arcPts(0, 0, rr * 0.82, rr * 0.82, a - 34, a + 34, 7), ...rev(arcPts(0, 0, rr * 0.4, rr * 0.4, a - 30, a + 30, 5))], S.t(B.caliper));
    pen.restore();
  }
  // the spokes and the hub, one polygon
  const shapes = spokeShapes(rr * 0.16, rr * 0.9, n, shape, spin);
  pen.poly(joinShapes(shapes), rim);
  if (shape === "dish") {
    pen.poly(joinShapes(dishSlots(rr, n, spin)), S.dk(rim, 0.6));
  }
  if (W.hub !== null && shape !== "dish") pen.circle(0, 0, rr * 0.11, S.t(W.hub));
  if (shape === "wire") pen.circle(0, 0, rr * 0.13, S.t("#d9dde3"));
  // the shine (Bright) or the shadow under the arch (Night drive)
  if (S.nd) {
    pen.save();
    pen.fade(med);
    pen.line(arcPts(0, 0, rr * 0.86, rr * 0.86, 200, 340, 6), rr * 0.16, ND.ao, 0.35);
    pen.restore();
  } else if (fine > 0.004) {
    pen.save();
    pen.fade(fine);
    pen.line(arcPts(0, 0, rr * 0.97, rr * 0.97, 205, 290, 8), Math.max(1.5, rr * 0.05), "#ffffff", 0.35);
    pen.restore();
  }
  pen.restore();
  return pen.out.length - n0;
}

/**
 * One wheel of a detailed vehicle in the side view (centre x, y; radius r; spin in radians, as the classic's). The entry
 * point `carSide2.ts` calls: it reads the look's own resolved parts and draws in the style being drawn now (the line
 * weight comes from `ow`, the outline colour from `ink`). Pass the vehicle's `Sty` (from `styleOf`) as `S` so the wheel's
 * parts fade in with the on-screen size; without it everything is on (the editor's size). The wheel at x > 0 is the front
 * one (its caliper sits behind the axle).
 */
export function wheelSide2(pen: Pen, x: number, y: number, r: number, spin: number, flat: boolean, car: CarLook, ink: string, ow: number, S?: Sty): void {
  const R = resolveDetail(car.detail === undefined ? { ...car, detail: { v: 1 } } : car);
  const sty: Sty = S !== undefined ? { ...S, ink, ow } : { ...styleOf(pen, 1, car, R, 9), ink, ow };
  wheelPart(pen, sty, R, x, y, r, spin, flat, x > 0, hex(car.wheels.rim, "#c9ccd2"));
}
