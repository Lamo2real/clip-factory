// Lamo Stories engine: the shots' perspective (CONTRACTS §45.45 §8.1). A shot looks along the road from inside the
// driver's car, from behind it or from the roadside: a point X metres across (the own lane's centre is 0, the other
// lane is on its left), Y up and Z ahead lands at x = vpX + f·(X − camX)/Z, y = horizon + f·(camH − Y)/Z. The lane
// dashes, posts and lamps stream by with the road's metres (light.ts), so the streaming matches the side view's speed
// and carries on across cuts. Everything is screen px of the frame being drawn, through the pen's matrix (the shot's
// camera); only prims of types.ts, no gradients but the sky's.

import { bellStops, fadeStops, ND, nightDrive, POOL_GROW, POOL_LIFT } from "./art.ts";
import { F } from "./frame.ts";
import { ellipsePts, LAMP_GAP, lampPhase } from "./light.ts";
import { mix, rand, smoothstep } from "./math.ts";
import { clipConvex, joinShapes, type Pen } from "./pen.ts";
import { LAMP_GLOW, lampGlow, lampRing, ridgeFacets, ridgeTop, type RoadLook } from "./sets.ts";

/** The focal length, design px: 0.9 of the short side. */
export const FOCAL = 0.9 * 1080;
/** A lane is 3.6 m wide; the own lane's centre is X = 0 and the other lane's is -3.6 (on the left). */
export const LANE_W = 3.6;
/** Street lamps: 10 m high, 1.5 m off the road's edge, with a 2 m arm over the road. */
export const LAMP_H = 10;
const LAMP_OUT = 1.5;
const LAMP_ARM = 2;
/** The furthest anything is drawn (metres); the far lamps merge into a dotted line towards the vanishing point. */
const Z_FAR = 900;
const LAMP_NEAR = 130;
const LAMP_LAST = 300;
/** Night drive: a far lamp's glow is never smaller than this (px), so the rows of far lamps run together into a warm
 * glowing line where they meet at the vanishing point. */
const FAR_GLOW = 6.5;
/** Night drive: a lamp whose glow reaches this far (px on screen) or more is drawn on its own, in soft rings by its
 * size; the smaller ones share the far lamps' few polygons. */
const NEAR_GLOW = 13.5;
/** Night drive's guard rail (metres up): two slim bars with a gap between them, and its thin highlight along the top. */
const RAIL_BARS: readonly (readonly [number, number])[] = [
  [0.35, 0.49],
  [0.59, 0.76],
];
const RAIL_GLINT: readonly [number, number] = [0.735, 0.765];
/** Night drive: the far lamps' poles and arms fade into the horizon's haze with their depth, all but gone at the
 * last ([nearer than this many m, how far towards the haze's colour], fainter by as much); the vanishing point is the
 * warm line of their lights. */
const POLE_FADE: readonly (readonly [number, number])[] = [
  [120, 0.3],
  [180, 0.55],
  [280, 0.75],
  [450, 0.88],
  [Infinity, 0.95],
];

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** A shot's camera in the world: the vanishing point (screen px), the focal length and where the eye is. */
export interface Cam3 {
  vpX: number;
  hor: number;
  f: number;
  /** across (m) */
  camX: number;
  /** height (m) */
  camH: number;
}

export function project(c: Cam3, X: number, Y: number, Z: number): [number, number] {
  const z = Math.max(0.05, Z);
  return [c.vpX + (c.f * (X - c.camX)) / z, c.hor + (c.f * (c.camH - Y)) / z];
}

/** Screen px per metre at depth Z. */
export const pxPerM = (c: Cam3, Z: number): number => c.f / Math.max(0.05, Z);

/** The depth at which the ground meets screen row y (below the horizon). */
export const depthAtRow = (c: Cam3, y: number): number => (c.f * c.camH) / Math.max(1e-3, y - c.hor);

/** A flat strip on the ground, x0..x1 across and z0..z1 ahead, as a polygon. */
export function groundQuad(c: Cam3, x0: number, x1: number, z0: number, z1: number): number[] {
  return [...project(c, x0, 0, z0), ...project(c, x0, 0, z1), ...project(c, x1, 0, z1), ...project(c, x1, 0, z0)];
}

/** A strip standing at X, from height y0 to y1, z0..z1 ahead. */
export function wallQuad(c: Cam3, X: number, y0: number, y1: number, z0: number, z1: number): number[] {
  return [...project(c, X, y0, z0), ...project(c, X, y1, z0), ...project(c, X, y1, z1), ...project(c, X, y0, z1)];
}

/** Things every `gap` metres along the road, streaming with the metres rolled: their depths in (zMin, zMax]. Ahead
 * they come closer as the road rolls (z = k·gap − (m mod gap)); `back` (a mirror, looking behind) they move away. */
export function streamed(m: number, gap: number, zMin: number, zMax: number, back = false, offset = 0): number[] {
  const out: number[] = [];
  const first = back ? mod(m + offset, gap) : gap - mod(m + offset, gap);
  for (let z = first; z <= zMax && out.length < 64; z += gap) if (z > zMin) out.push(z);
  return out;
}

/** The road across (metres): its edges, the dashed line between the lanes, the rails and the lamps. */
export interface RoadPlan {
  left: number;
  right: number;
  dash: number;
  rails: number[];
  lamps: { x: number; arm: number }[];
  posts: number[];
}

export function roadPlan(look: RoadLook): RoadPlan {
  const left = -LANE_W * 1.5;
  const right = LANE_W / 2;
  const lamps: RoadPlan["lamps"] = [];
  if (look.lamps !== "none") lamps.push({ x: left - LAMP_OUT, arm: 1 });
  if (look.lamps === "both") lamps.push({ x: right + LAMP_OUT, arm: -1 });
  return {
    left,
    right,
    dash: -LANE_W / 2,
    rails: look.rail ? [left - 0.9, right + 0.9] : [],
    lamps,
    posts: look.reflectors || look.posts ? [left - 1.1, right + 1.1] : [],
  };
}

export interface OutsideOpts {
  look: RoadLook;
  plan: RoadPlan;
  /** the road's metres (light.ts) */
  m: number;
  t: number;
  seed: number;
  /** the ridges' sideways shift (px): they move with steering and sway only */
  sway: number;
  /** what the outside covers on screen (px) */
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** the nearest depth drawn (m) */
  zNear: number;
  /** looking behind (a mirror): things move away as the road rolls */
  back?: boolean;
  /** fewer things (a mirror's glass, a far window): no stars or posts, and in Bright no far lamps (night drive keeps
   * its lamp rows to the horizon, so their warm V shows under the mirror too) */
  simple?: boolean;
  /** the warm pulse (0..1) lights the lamps' pools a little more */
  warm?: number;
}

/** The ridge of mountains or hills along the horizon, low where the road meets it and high at the sides. */
function ridge(pen: Pen, c: Cam3, o: OutsideOpts, height: number, color: string, lit: string | null, rim: string | null, valley: number, seed: number): void {
  const x0 = o.x0 - 120;
  const x1 = o.x1 + 120;
  const base = c.hor + 3;
  const top = ridgeTop(x0, x1, base, height, o.sway + seed * 37, seed, 22, o.look.ridge);
  const span = (x1 - x0) * 0.42;
  for (let i = 0; i < top.length; i += 2) {
    const k = 1 - valley + valley * smoothstep(0, span, Math.abs(top[i]! - c.vpX));
    top[i + 1] = base - (base - top[i + 1]!) * k;
  }
  pen.poly([...top, x1, base + 8, x0, base + 8], color);
  if (lit) for (const f of ridgeFacets(top, base, 2)) pen.poly(f, lit);
  if (rim) pen.line(top, 2.4, rim, 0.5);
}

/** The sky, the ridges, the town's glow and the road with its lines, rails, posts and lamps, as seen from `c`. Cars
 * are drawn by the shot after this. */
export function drawOutside(pen: Pen, c: Cam3, o: OutsideOpts): void {
  const { look, plan, m } = o;
  const S = 1080;
  // the sky's grad follows the pen's matrix (the shot's camera) so its horizon stays on the ridges
  const [, gTop] = pen.at(0, o.top);
  const [, gHor] = pen.at(0, c.hor);
  pen.grad(0, gTop / F.k, 0, gHor / F.k, look.sky);
  if (look.stars && !o.simple) {
    for (let i = 0; i < 8; i += 1) {
      const a = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(o.t * (0.7 + rand(o.seed, i + 300) * 1.5) + i * 1.7));
      const x = o.x0 + rand(o.seed, i + 310) * (o.x1 - o.x0);
      const y = o.top + rand(o.seed, i + 320) * (c.hor - o.top) * 0.62;
      pen.circle(x, y, 2 + rand(o.seed, i + 330) * 1.3, ND.star, a);
    }
  }
  const mountains = look.ridge === "mountains";
  ridge(pen, c, o, (mountains ? 0.26 : 0.09) * S, look.far, mountains ? look.farLit : null, null, mountains ? 0.6 : 0.3, o.seed);
  if (look.city && !o.simple) {
    const cx = c.vpX + 0.1 * (o.x1 - o.x0);
    // night drive: one soft glow (art.ts fadeStops) as bright as Bright's three stacked ovals, with no ring edges
    if (nightDrive()) pen.glow(cx, c.hor, 0.23 * S, 0.0575 * S, ND.cityGlow, fadeStops(0.24, 1.5));
    else {
      pen.ellipse(cx, c.hor, 0.2 * S, 0.05 * S, 0, ND.cityGlow, 0.05);
      pen.ellipse(cx, c.hor, 0.13 * S, 0.03 * S, 0, ND.cityGlow, 0.07);
      pen.ellipse(cx, c.hor, 0.07 * S, 0.016 * S, 0, ND.cityGlow, 0.1);
    }
    for (let i = 0; i < 6; i += 1) pen.circle(cx + (rand(o.seed, i + 340) - 0.5) * 0.3 * S, c.hor - 2 - rand(o.seed, i + 350) * 0.02 * S, 1.6, ND.cityDot, 0.6);
  }
  ridge(pen, c, o, (mountains ? 0.17 : 0.06) * S, look.near, mountains ? look.nearLit : null, look.rim, 0.85, o.seed + 5);
  // the ground: verges everywhere below the horizon, the road on them
  const zn = o.zNear;
  const back = !!o.back;
  pen.rect(o.x0 - 120, c.hor - 1, o.x1 - o.x0 + 240, Math.max(0, o.bottom - c.hor) + 40, 0, look.verge);
  // §45.47: the sky and the sea have no road (no asphalt, no lanes)
  const road = !look.open;
  if (road) {
    pen.poly(groundQuad(c, plan.left, plan.right, zn, Z_FAR), look.asphalt);
    pen.poly(groundQuad(c, plan.left, plan.right, 110, Z_FAR), look.asphaltFar);
  }
  // pools of lamp light on the road under each lamp
  // (not the nearest ones: a pool right under the camera would cover the frame and is faint anyway)
  const lampZs = look.lit && plan.lamps.length ? streamed(m, LAMP_GAP, Math.max(zn + 1, 9), LAMP_NEAR, back) : [];
  for (const L of plan.lamps) {
    for (const z of lampZs) {
      const px = L.x + L.arm * LAMP_ARM;
      const [x, y] = project(c, px, 0, z);
      const rx = pxPerM(c, z) * 3.2;
      const ry = Math.max(1, (rx * c.camH) / z);
      const a = 0.07 + 0.03 * (o.warm ?? 0);
      // night drive: a soft pool (art.ts bellStops) as much light as the flat one, so two that overlap add up smoothly
      if (nightDrive()) pen.glow(x, y, rx * POOL_GROW, ry * POOL_GROW, ND.pool, bellStops(1), a * POOL_LIFT);
      else pen.ellipse(x, y, rx, ry, 0, ND.pool, a);
    }
  }
  // night drive: the lamps' poles before the rails and posts, so a lamp stands behind its rail on its own foot
  const nd = nightDrive();
  const lamps = nd ? lampsAt(pen, c, o) : [];
  if (nd) lampPoles(pen, o, lamps);
  // the edge lines and the rails in a few lengths, so each is rasterized over a small box
  const spans = [zn, Math.max(zn + 1, 8), 30, Z_FAR];
  if (look.edge) {
    for (const ex of [plan.left + 0.25, plan.right - 0.25]) for (let k = 0; k + 1 < spans.length; k += 1) pen.poly(groundQuad(c, ex - 0.08, ex + 0.08, spans[k]!, spans[k + 1]!), look.edge, 0.9);
  }
  // the dashed line between the lanes: 3 m dashes every 12 m
  for (const z of road ? streamed(m, 12, zn, 170, back) : []) {
    const z1 = back ? z - 3 : z + 3;
    if (Math.min(z, z1) <= zn) continue;
    pen.poly(groundQuad(c, plan.dash - 0.08, plan.dash + 0.08, z, z1), z > 60 ? look.laneFar : look.lane);
  }
  // guard rails: a lit top line, the rail and its shadow, with posts every 4 m streaming by
  for (const rx of plan.rails) {
    if (!o.simple) {
      for (const z of streamed(m, 6, zn, 36, back)) {
        const [x, y0] = project(c, rx, 0, z);
        // night drive: the post's round top stays inside the upper bar
        const [, y1] = project(c, rx, nd ? 0.7 : 0.75, z);
        pen.line([x, y0, x, y1], Math.max(1, pxPerM(c, z) * 0.12), ND.railPost);
      }
    }
    if (nd) {
      // night drive: two slim blue-grey bars (RAIL_BARS) with the dark verge showing through the gap between them,
      // and a thin cool highlight along the top; each length reaches a little into the next, and all the bars before
      // all the highlight, so no hairline seam shows (a pole behind the rail, or a bar under its highlight)
      const z1 = (k: number) => (k + 2 < spans.length ? spans[k + 1]! * 1.04 : spans[k + 1]!);
      for (let k = 0; k + 1 < spans.length; k += 1) pen.poly(joinShapes(RAIL_BARS.map(([y0, y1]) => wallQuad(c, rx, y0, y1, spans[k]!, z1(k)))), ND.railBar);
      for (let k = 0; k + 1 < spans.length; k += 1) pen.poly(wallQuad(c, rx, RAIL_GLINT[0], RAIL_GLINT[1], spans[k]!, z1(k)), ND.railGlint);
      continue;
    }
    for (let k = 0; k + 1 < spans.length; k += 1) {
      pen.poly(wallQuad(c, rx, 0.38, 0.72, spans[k]!, spans[k + 1]!), ND.rail);
      pen.poly(wallQuad(c, rx, 0.66, 0.78, spans[k]!, spans[k + 1]!), ND.railLit);
    }
  }
  // reflector posts (white with an amber dot) or white roadside posts with a red band, every 25 m
  if (!o.simple) {
    for (const px of plan.posts) {
      for (const z of streamed(m, 25, zn, 150, back, px * 7)) {
        const [x, y0] = project(c, px, 0, z);
        const u = pxPerM(c, z);
        pen.rect(x - 0.06 * u, y0 - 1 * u, 0.12 * u, 1 * u, 0.03 * u, look.reflectors ? ND.lane : look.lane);
        pen.rect(x - 0.05 * u, y0 - 0.86 * u, 0.1 * u, 0.12 * u, 0.02 * u, look.reflectors ? ND.marker : "#e0533d");
      }
    }
  }
  if (nd) {
    lampLights(pen, o, lamps);
    return;
  }
  // street lamps: near ones in full (pole, arm, cobra head, the soft bloom), far ones as a dotted line of glows
  for (const L of plan.lamps) {
    const zs = streamed(m, LAMP_GAP, zn + 1, o.simple ? LAMP_NEAR : LAMP_LAST, back);
    for (let i = zs.length - 1; i >= 0; i -= 1) {
      const z = zs[i]!;
      const u = pxPerM(c, z);
      const hx = L.x + L.arm * LAMP_ARM;
      const [hX, hY] = project(c, hx, LAMP_H, z);
      if (z > LAMP_NEAR) {
        if (look.lit) {
          if (z < 240) pen.circle(hX, hY, Math.max(2.2, 0.5 * u) * 3, ND.halo1, 0.28);
          pen.circle(hX, hY, Math.max(1.3, 0.3 * u), ND.lampHead);
        }
        continue;
      }
      const [bx, by] = project(c, L.x, 0, z);
      const [tx, ty] = project(c, L.x, LAMP_H, z);
      const w = Math.max(1.2, 0.22 * u);
      pen.line([bx, by, tx, ty], w, look.pole);
      if (z < 60) pen.line([bx + w * 0.3 * L.arm, by, tx + w * 0.3 * L.arm, ty], w * 0.4, look.poleDark);
      pen.line([tx, ty, hX, hY], Math.max(1, 0.14 * u), look.pole);
      const r = Math.max(1.6, 0.42 * u);
      if (look.lit) {
        // the soft bloom and the pool on the road; no cone of light under it (that read as a spotlight)
        lampGlow(pen, hX, hY, r, r * 1.3, Math.max(0.8, r * 0.38), 1, look.pole);
      } else pen.ellipse(hX, hY, r * 1.3, Math.max(0.8, r * 0.38), 0, "#e6ecf3");
    }
  }
}

// ---- night drive's street lamps (§45.45 §8.1) ---------------------------------------------------------------------

/** One street lamp as a camera sees it: its foot, the top of its pole and its head (screen px), its lens's half
 * sizes, its glow's radius and whether it is near (drawn on its own, soft rings by its size) or far (one of the few
 * polygons all the far lamps share). */
interface LampView {
  z: number;
  u: number;
  arm: number;
  bx: number;
  by: number;
  tx: number;
  ty: number;
  hX: number;
  hY: number;
  rx: number;
  ry: number;
  glow: number;
  near: boolean;
}

/** Every lamp the camera sees, far to near: on poles all the way to the horizon (to Z_FAR), in every shot. Each lamp is
 * smaller than the one before it, its glow too, down to FAR_GLOW. */
function lampsAt(pen: Pen, c: Cam3, o: OutsideOpts): LampView[] {
  const out: LampView[] = [];
  if (!o.plan.lamps.length) return out;
  const zs = streamed(o.m, LAMP_GAP, o.zNear + 1, Z_FAR, !!o.back);
  const zoom = pen.unit() / F.k;
  for (const L of o.plan.lamps) {
    for (const z of zs) {
      const u = pxPerM(c, z);
      const [bx, by] = project(c, L.x, 0, z);
      const [tx, ty] = project(c, L.x, LAMP_H, z);
      const [hX, hY] = project(c, L.x + L.arm * LAMP_ARM, LAMP_H, z);
      const r = 0.42 * u;
      const rx = Math.max(1.4, r * 1.3);
      const glow = Math.max(FAR_GLOW, LAMP_GLOW * rx);
      out.push({ z, u, arm: L.arm, bx, by, tx, ty, hX, hY, rx, ry: Math.max(0.9, r * 0.38), glow, near: glow * zoom >= NEAR_GLOW });
    }
  }
  return out.sort((a, b) => b.z - a.z);
}

/** A stick from (x0, y0) to (x1, y1), `w` wide, as a quad. */
function stick(x0: number, y0: number, x1: number, y1: number, w: number): number[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
}

/** The lamps' poles and arms (before the rails): a near lamp's soft shadow on the verge, its pole standing on the
 * ground on a flat darker base, its shaded side and its arm; every far lamp's pole and arm in one polygon, thinner
 * the further it is. */
function lampPoles(pen: Pen, o: OutsideOpts, lamps: LampView[]): void {
  const pole = o.look.night ? ND.lampPole : o.look.pole;
  const dark = o.look.night ? ND.lampPoleDark : o.look.poleDark;
  const haze = o.look.sky[o.look.sky.length - 1]![1];
  const far: number[][][] = POLE_FADE.map(() => []);
  for (const l of lamps) {
    if (!l.near) {
      if (!o.look.lit) continue;
      far[POLE_FADE.findIndex(([z]) => l.z < z)]!.push(stick(l.bx, l.by, l.tx, l.ty, Math.max(0.6, 0.22 * l.u)), stick(l.tx, l.ty, l.hX, l.hY, Math.max(0.5, 0.14 * l.u)));
      continue;
    }
    const w = Math.max(1.2, 0.22 * l.u);
    // flat at the foot (a round end read as a stub floating over the verge), round where the arm joins at the top
    if (l.z < 60) pen.ellipse(l.bx, l.by, w * 2.4, Math.max(0.8, 0.09 * l.u), 0, ND.ao, 0.4);
    pen.poly(stick(l.bx, l.by, l.tx, l.ty, w), pole);
    if (l.z < 60) pen.poly(stick(l.bx + w * 0.3 * l.arm, l.by, l.tx + w * 0.3 * l.arm, l.ty, w * 0.4), dark);
    pen.line([l.tx, l.ty, l.hX, l.hY], Math.max(1, 0.14 * l.u), pole);
    pen.poly(stick(l.bx, l.by, l.bx, l.by - 0.5 * l.u, w * 1.7), dark);
  }
  // the far ones in a few depths, each further one more of the horizon's haze and fainter, so the rows never bunch
  // into a fence where they meet
  POLE_FADE.forEach(([, k], i) => {
    if (far[i]!.length) pen.poly(joinShapes(far[i]!), mix(pole, haze, k), 1 - 0.85 * k);
  });
}

/** The lamps' light (after the rails): the far lamps first, each one soft gold glow and all their lenses one polygon
 * (so the far rows glow and meet in a warm line), then each near lamp from far to near, a bright warm emitter under
 * its thin head (sets.ts lampGlow). Every glow is a `glow` prim, so no ring shows. Unlit (by day) a near lamp shows a
 * plain pale lens. */
function lampLights(pen: Pen, o: OutsideOpts, lamps: LampView[]): void {
  const far = o.look.lit ? lamps.filter((l) => !l.near) : [];
  if (far.length) {
    // each far lamp one soft gold glow (no ring edge, however close it comes), a little lower than its lens; where the
    // rows close up towards the vanishing point the glows add up into a warm line
    for (const l of far) {
      const [gx, gy, grx, gry] = lampRing(l.hX, l.hY, l.rx, l.ry, l.glow, 1);
      pen.glow(gx, gy, grx, gry, ND.lampGlowIn, fadeStops(0.85, 1.7));
    }
    pen.poly(joinShapes(far.map((l) => ellipsePts(l.hX, l.hY, l.rx, l.ry, 8))), ND.lampLens);
  }
  for (const l of lamps) {
    if (!l.near) continue;
    if (o.look.lit) lampGlow(pen, l.hX, l.hY, 0.42 * l.u, l.rx, l.ry, 1, ND.lampHousing);
    else pen.ellipse(l.hX, l.hY, l.rx, l.ry, 0, "#e6ecf3");
  }
}

// ---- night drive's lamps through the car's windows (§45.45 §8) ------------------------------------------------------

/** One street lamp seen through a window (night drive): its pole from the foot (bx, by) up to (tx, ty), the arm out to
 * its head at (hX, hY), then its light and thin head (sets.ts lampGlow) with lens half sizes rx × ry. The window's
 * frame, drawn after it, hides whatever of it falls outside the glass. */
export function windowLamp(pen: Pen, bx: number, by: number, tx: number, ty: number, hX: number, hY: number, rx: number, ry: number): void {
  const w = Math.max(1.2, rx * 0.36);
  pen.poly(stick(bx, by, tx, ty, w), ND.lampPole);
  pen.line([tx, ty, hX, hY], Math.max(1, w * 0.62), ND.lampPole);
  lampGlow(pen, hX, hY, rx / 1.3, rx, ry, 1, ND.lampHousing);
}

/** The street lamps behind the car through its rear window (night drive's Face up close): the road's lamps looking
 * back from `c` (left and right swap), moving away as the road rolls, the nearest `most` whose heads show in the
 * window (x0, y0)-(x1, y1) and not behind `hide` (the head in front of the window, an ellipse), far to near. The
 * near ones glow at the window's top edge, the further ones above or beside the head, as through a real rear window
 * at night, their poles down behind the window's lower edge. */
export function lampsBehind(pen: Pen, c: Cam3, plan: RoadPlan, m: number, x0: number, y0: number, x1: number, y1: number, hide: { x: number; y: number; rx: number; ry: number } | null, most = 2): void {
  const seen: { z: number; draw: () => void }[] = [];
  for (const L of plan.lamps) {
    for (const z of streamed(m, LAMP_GAP, 5, 240, true)) {
      const u = pxPerM(c, z);
      const [hX, hY] = project(c, -(L.x + L.arm * LAMP_ARM), LAMP_H, z);
      const rx = Math.max(2, 0.55 * u);
      // its glow reaching into the glass: a near one shows at the top edge, its head under the roof
      if (hX + rx * 3 < x0 || hX - rx * 3 > x1 || hY + rx * 2 < y0 || hY > y1) continue;
      if (hide && ((hX - hide.x) / hide.rx) ** 2 + ((hY - hide.y) / hide.ry) ** 2 < 1) continue;
      // the pole runs down behind the window's lower edge (the car's own boot hides the road behind), so its foot
      // never ends in the air over the hills
      const [bx, by] = project(c, -L.x, 0, z);
      const [tx, ty] = project(c, -L.x, LAMP_H, z);
      const foot = Math.max(by, y1 + 4);
      seen.push({ z, draw: () => windowLamp(pen, bx, foot, tx, ty, hX, hY, rx, Math.max(0.9, rx * 0.29)) });
    }
  }
  seen.sort((a, b) => a.z - b.z);
  for (const s of seen.slice(0, most).reverse()) s.draw();
}

/** The street lamps through a side window (night drive's Side window), (wx0, wy0)-(wx1, wy0 + wh), the road's metres
 * `m` streaming them by the way the scenery goes (`dir`): a row of small lamps on the far side of the road along the
 * horizon, about one a window apart and slow (far away), so one or two always show, and the near lamp passing fast
 * (`span` px a lamp gap, at the lamp pulse) on its pole, its head out over the road (`back`, the side the scenery goes
 * to). The far row's poles run down behind the guard rail, to `railY` (the rail and the verge under it, drawn after,
 * hide their feet), so none ends in the air over the hills. */
export function sideLamps(pen: Pen, wx0: number, wx1: number, wy0: number, wh: number, m: number, dir: number, back: number, span: number, railY: number): void {
  const ww = wx1 - wx0;
  const gap = ww * 0.92;
  const foot = railY + 2;
  const top = wy0 + wh * 0.5;
  const rx = ww * 0.024;
  const shift = ((((-m * (gap / LAMP_GAP) * dir) % gap) + gap) % gap);
  for (let x = wx0 - 90 + shift; x < wx1 + 90; x += gap) {
    if (x < wx0 - 90) continue;
    windowLamp(pen, x, foot, x, top, x + rx * 2.2 * back, top + rx * 0.12, rx, rx * 0.3);
  }
  const lx = (wx0 + wx1) / 2 - lampPhase(m) * span * dir;
  if (lx > wx0 - 120 && lx < wx1 + 120) {
    const hy = wy0 + wh * 0.1;
    const nrx = ww * 0.068;
    windowLamp(pen, lx, wy0 + wh + 20, lx, hy - nrx * 0.3, lx + nrx * 1.4 * back, hy, nrx, nrx * 0.29);
  }
}

/** The poles and arms of the street lamps in a mirror's glass (night drive), seen from `c`: each lamp `arm` m out
 * over the road from its pole at x, z m away, standing on the verge; one shape of every pole clipped to the glass
 * (convex), drawn before their lights (glassLamp). */
export function glassPoles(pen: Pen, c: Cam3, lamps: { x: number; arm: number; z: number }[], glass: number[]): void {
  const parts: number[][] = [];
  for (const l of lamps) {
    const u = pxPerM(c, l.z);
    const [bx, by] = project(c, l.x, 0, l.z);
    const [tx, ty] = project(c, l.x, LAMP_H, l.z);
    const [hX, hY] = project(c, l.x + l.arm * LAMP_ARM, LAMP_H, l.z);
    parts.push(clipConvex(stick(bx, by, tx, ty, Math.max(0.8, 0.22 * u)), glass), clipConvex(stick(tx, ty, hX, hY, Math.max(0.6, 0.14 * u)), glass));
  }
  const shape = joinShapes(parts.filter((p) => p.length >= 6));
  if (shape.length) pen.poly(shape, ND.lampPole);
}

/** A far street lamp in a mirror's glass (night drive): a small warm glow, a little under the lamp (its light falls),
 * round a tiny bright lens; `r` the radius Bright's flat dot has there. */
export function glassLamp(pen: Pen, x: number, y: number, r: number): void {
  pen.glow(x, y + r * 0.5, r * 3.4, r * 2.6, ND.lampGlowIn, fadeStops(0.75, 2));
  pen.ellipse(x, y, r * 1.1, Math.max(0.6, r * 0.4), 0, ND.lampLens);
}
