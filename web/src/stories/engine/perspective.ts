// Lamo Stories engine: the shots' perspective (CONTRACTS §45.45 §8.1). A shot looks along the road from inside the
// driver's car, from behind it or from the roadside: a point X metres across (the own lane's centre is 0, the other
// lane is on its left), Y up and Z ahead lands at x = vpX + f·(X − camX)/Z, y = horizon + f·(camH − Y)/Z. The lane
// dashes, posts and lamps stream by with the road's metres (light.ts), so the streaming matches the side view's speed
// and carries on across cuts. Everything is screen px of the frame being drawn, through the pen's matrix (the shot's
// camera); only prims of types.ts, no gradients but the sky's.

import { ND } from "./art.ts";
import { F } from "./frame.ts";
import { LAMP_GAP } from "./light.ts";
import { rand, smoothstep } from "./math.ts";
import type { Pen } from "./pen.ts";
import { lampGlow, ridgeFacets, ridgeTop, type RoadLook } from "./sets.ts";

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
  /** fewer things (a mirror's glass, a far window): no stars, posts or far lamps */
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
    pen.ellipse(cx, c.hor, 0.2 * S, 0.05 * S, 0, ND.cityGlow, 0.05);
    pen.ellipse(cx, c.hor, 0.13 * S, 0.03 * S, 0, ND.cityGlow, 0.07);
    pen.ellipse(cx, c.hor, 0.07 * S, 0.016 * S, 0, ND.cityGlow, 0.1);
    for (let i = 0; i < 6; i += 1) pen.circle(cx + (rand(o.seed, i + 340) - 0.5) * 0.3 * S, c.hor - 2 - rand(o.seed, i + 350) * 0.02 * S, 1.6, ND.cityDot, 0.6);
  }
  ridge(pen, c, o, (mountains ? 0.17 : 0.06) * S, look.near, mountains ? look.nearLit : null, look.rim, 0.85, o.seed + 5);
  // the ground: verges everywhere below the horizon, the road on them
  const zn = o.zNear;
  const back = !!o.back;
  pen.rect(o.x0 - 120, c.hor - 1, o.x1 - o.x0 + 240, Math.max(0, o.bottom - c.hor) + 40, 0, look.verge);
  pen.poly(groundQuad(c, plan.left, plan.right, zn, Z_FAR), look.asphalt);
  pen.poly(groundQuad(c, plan.left, plan.right, 110, Z_FAR), look.asphaltFar);
  // pools of lamp light on the road under each lamp
  // (not the nearest ones: a pool right under the camera would cover the frame and is faint anyway)
  const lampZs = look.lit && plan.lamps.length ? streamed(m, LAMP_GAP, Math.max(zn + 1, 9), LAMP_NEAR, back) : [];
  for (const L of plan.lamps) {
    for (const z of lampZs) {
      const px = L.x + L.arm * LAMP_ARM;
      const [x, y] = project(c, px, 0, z);
      const rx = pxPerM(c, z) * 3.2;
      pen.ellipse(x, y, rx, Math.max(1, (rx * c.camH) / z), 0, ND.pool, 0.07 + 0.03 * (o.warm ?? 0));
    }
  }
  // the edge lines and the rails in a few lengths, so each is rasterized over a small box
  const spans = [zn, Math.max(zn + 1, 8), 30, Z_FAR];
  if (look.edge) {
    for (const ex of [plan.left + 0.25, plan.right - 0.25]) for (let k = 0; k + 1 < spans.length; k += 1) pen.poly(groundQuad(c, ex - 0.08, ex + 0.08, spans[k]!, spans[k + 1]!), look.edge, 0.9);
  }
  // the dashed line between the lanes: 3 m dashes every 12 m
  for (const z of streamed(m, 12, zn, 170, back)) {
    const z1 = back ? z - 3 : z + 3;
    if (Math.min(z, z1) <= zn) continue;
    pen.poly(groundQuad(c, plan.dash - 0.08, plan.dash + 0.08, z, z1), z > 60 ? look.laneFar : look.lane);
  }
  // guard rails: a lit top line, the rail and its shadow, with posts every 4 m streaming by
  for (const rx of plan.rails) {
    if (!o.simple) {
      for (const z of streamed(m, 6, zn, 36, back)) {
        const [x, y0] = project(c, rx, 0, z);
        const [, y1] = project(c, rx, 0.75, z);
        pen.line([x, y0, x, y1], Math.max(1, pxPerM(c, z) * 0.12), ND.railPost);
      }
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
