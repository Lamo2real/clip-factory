// Lamo Stories engine: the light of a place and the finish of a frame in the night drive style (CONTRACTS §45.45
// §4.2, §4.5). Which light each part stands in (the place outside, the inside of a car), the street lamps' warm pulse
// that rolls with the road, the vignette and the warm sweep of a lamp passing over the dashboard and the face. Pure
// functions of the place, the road's distance and the frame (frame.ts): no Date, no Math.random.

import { LIGHTS, ND, withWarm, type Light } from "./art.ts";
import { F } from "./frame.ts";
import { clamp01 } from "./math.ts";
import type { Pen } from "./pen.ts";
import { setInfo } from "./sets.ts";
import type { SetId } from "./types.ts";

/** Design px per metre: 1080 px is 20 m, in the side view and in every shot. */
export const PX_PER_M = 54;
/** The street lamps are this many metres apart (a lamp passes about every 1.9 s at full speed). */
export const LAMP_GAP = 40;
/** The lamps' warm pulse on a night place where nothing drives: a steady glow. */
const STILL_WARM = 0.35;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** How far the road has rolled, in metres, from the side view's scroll (design px). */
export const metres = (scroll: number): number => scroll / PX_PER_M;

/** Where the nearest lamp is: -0.5..0.5 of the lamp gap, 0 right overhead (the warm pulse's peak). */
export function lampPhase(m: number): number {
  return mod(m / LAMP_GAP + 0.5, 1) - 0.5;
}

/** The street lamps' warm pulse (0..1) on a place: max(0, cos(2π · (m mod 40) / 40))^4 while the road rolls on a night
 * place, a steady 0.35 when nothing drives there, and 0 by day. */
export function lampWarm(set: SetId, scroll: number, rolling: boolean): number {
  if (!setInfo(set).night) return 0;
  if (!rolling) return STILL_WARM;
  const c = Math.cos(2 * Math.PI * (mod(metres(scroll), LAMP_GAP) / LAMP_GAP));
  return Math.max(0, c) ** 4;
}

/** The part of a frame a light is for: the place outside, or the inside of a car. */
export type LightPart = "out" | "cabin";

/** The light a part of a place stands in (§4.2): night places use night (cabin inside a car), outdoor day places and
 * the park use day (a little darker inside a car), the kitchen, living room and office use indoor, and the studio
 * changes nothing. `warm` is the lamps' pulse (lampWarm). */
export function lightFor(set: SetId, part: LightPart, warm: number): Light {
  const info = setInfo(set);
  if (info.night) return withWarm(part === "cabin" ? LIGHTS.cabin : LIGHTS.night, warm);
  if (info.outdoor) return part === "cabin" ? { ...LIGHTS.day, dark: 0.1 } : { ...LIGHTS.day };
  if (set === "studio") return { ...LIGHTS.studio };
  return { ...LIGHTS.indoor };
}

/** The vignette's rings: the frame outside an ellipse (rx, ry as parts of half the frame) darkened by `a` at night.
 * Four soft steps of 0.05, close together, in the corners only: steps of 0.10 showed as oval rings in a flat night
 * sky, and rings across the whole frame cost a full frame of rasterizing each; these darken the corners by about 0.19
 * with a gentle falloff and leave the middle of each edge alone. */
const RINGS: [number, number, number][] = [
  [1.27, 1.17, 0.05],
  [1.21, 1.12, 0.05],
  [1.15, 1.08, 0.05],
  [1.1, 1.04, 0.05],
];
const RING_SEGS = 36;

/** A keyhole polygon (screen px): the rectangle (x0, y0)-(x1, y1) clockwise, a bridge into the hole, the hole
 * anticlockwise and back along the bridge. Non-zero winding leaves the hole empty in both drawers. `hole` is a closed
 * point list (clockwise on screen); it is walked backwards. */
export function keyhole(x0: number, y0: number, x1: number, y1: number, hole: number[]): number[] {
  return keyholes(x0, y0, x1, y1, [hole]);
}

/** A keyhole polygon with several holes, each reached by its own bridge from the rectangle's top-left corner (the
 * bridges are walked out and back, so they add nothing). */
export function keyholes(x0: number, y0: number, x1: number, y1: number, holes: number[][]): number[] {
  const pts = [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  for (const hole of holes) {
    const n = hole.length / 2;
    if (n < 3) continue;
    let area = 0;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      area += hole[i * 2]! * hole[j * 2 + 1]! - hole[j * 2]! * hole[i * 2 + 1]!;
    }
    // into the hole from the top-left corner, round it the other way to the rectangle, and back out
    pts.push(hole[0]!, hole[1]!);
    if (area > 0) for (let i = n - 1; i >= 0; i -= 1) pts.push(hole[i * 2]!, hole[i * 2 + 1]!);
    else for (let i = 1; i <= n; i += 1) pts.push(hole[(i % n) * 2]!, hole[(i % n) * 2 + 1]!);
    pts.push(x0, y0);
  }
  return pts;
}

/** An ellipse's points, clockwise on screen, starting at its top-left (so a keyhole's bridge is short). */
export function ellipsePts(cx: number, cy: number, rx: number, ry: number, segs = RING_SEGS): number[] {
  const out: number[] = [];
  for (let i = 0; i < segs; i += 1) {
    const a = Math.PI * 1.25 + (i / segs) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return out;
}

/** The vignette (§4.5): rings in ND.vignette over the whole picture, before the bubbles, darker towards the corners on
 * a night place and half as dark by day. Each ring is drawn as four corner pieces (the frame's corner outside the
 * ring's ellipse), so only the corners are rasterized. Fixed to the screen. */
export function drawVignette(pen: Pen, night: boolean): void {
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  const hw = F.w / 2;
  const hh = F.h / 2;
  const out = 1.02;
  for (const [a, b, alpha] of RINGS) {
    // where the ellipse meets the frame's side (u = 1) and its top or bottom (v = 1), in parts of half the frame
    const v1 = a > 1 ? b * Math.sqrt(1 - 1 / (a * a)) : 0;
    const t0 = Math.atan2(v1 / b, Math.min(1, 1 / a));
    const t1 = b > 1 ? Math.atan2(1 / b, Math.sqrt(1 - 1 / (b * b))) : Math.PI / 2;
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const pts: number[] = [hw + sx * hw * out, hh + sy * hh * out, hw + sx * hw * out, hh + sy * hh * v1];
      for (let i = 0; i <= 6; i += 1) {
        const t = t0 + ((t1 - t0) * i) / 6;
        pts.push(hw + sx * hw * a * Math.cos(t), hh + sy * hh * b * Math.sin(t));
      }
      // back along the top or bottom edge, just outside the frame, to the corner
      pts.push(hw + sx * hw * (b > 1 ? a * Math.cos(t1) : 0), hh + sy * hh * out);
      pen.poly(pts, ND.vignette, night ? alpha : alpha / 2);
    }
  }
}

/** The warm sweep of a lamp passing (§4.5): while the pulse is over 0.05, a translucent warm band (ND.halo2 at 0.10 ×
 * warm) moves down from `y0` to `y1` (screen px) across x0..x1 as the lamp goes over. `m` is the road's metres. */
export function drawLightSweep(pen: Pen, warm: number, m: number, x0: number, x1: number, y0: number, y1: number): void {
  if (warm <= 0.05) return;
  const p = clamp01((lampPhase(m) + 0.2) / 0.4);
  const band = (y1 - y0) * 0.38;
  const y = y0 - band + (y1 - y0 + band) * p;
  const lean = (x1 - x0) * 0.08;
  pen.poly([x0, y + lean, x1, y - lean, x1, y - lean + band, x0, y + lean + band], ND.halo2, 0.1 * warm);
}
