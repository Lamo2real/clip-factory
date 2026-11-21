// Lamo Stories engine: the character rig (CONTRACTS §45.8). A character is a small set of look choices; this file
// turns them into the same shapes every time, so a character looks identical in every video by construction.
// Local units: about 90 tall, feet at (0, 0), facing +x (the caller mirrors for facing left), y down.

import { DEG, clamp, hex, noise, shade, smoothstep } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, clipConvex, inflate, quadPts, superellipse } from "./pen.ts";
import { drawFace, type FaceParams } from "./face.ts";
import type { CharacterLook } from "./types.ts";

export type Hand = "open" | "fist" | "thumb" | "point";

/** Angles in degrees: 0 = straight down, +90 = forward (towards the facing side), 180 = up, -90 = back. */
export interface Pose {
  dx: number;
  dy: number;
  /** whole-body rotation about the feet (falling over) */
  rot: number;
  /** upper body lean about the hips (+ forward) */
  lean: number;
  sx: number;
  sy: number;
  /** head tilt (+ towards the facing side) */
  head: number;
  /** a nod: the face features move down (0..1) */
  nod: number;
  /** face turn -1..1 (+ towards the facing side) */
  turn: number;
  lookX: number;
  lookY: number;
  /** back arm: shoulder angle, elbow bend */
  aB: number;
  eB: number;
  /** front arm */
  aF: number;
  eF: number;
  /** arm length (rubber-hose stretch for arms up high), 1 = normal */
  lenB: number;
  lenF: number;
  /** back leg: hip angle, knee bend (negative bends the shin back) */
  hB: number;
  kB: number;
  hF: number;
  kF: number;
  handB: Hand;
  handF: Hand;
  /** 0..1: sitting on a seat (a stool appears when not in a car) */
  seat: number;
  /** 0..1: holding a steering wheel in front */
  wheel: number;
  wheelRot: number;
  /** 0..1: the front arm is drawn over the face (facepalm, gasp) */
  overFace: number;
  /** 0..1: both arms in front of the body (driving, bracing) */
  armsFront: number;
  tremble: number;
}

export const REST: Pose = {
  dx: 0,
  dy: 0,
  rot: 0,
  lean: 0,
  sx: 1,
  sy: 1,
  head: 0,
  nod: 0,
  turn: 0.28,
  lookX: 0.15,
  lookY: 0,
  aB: -16,
  eB: -6,
  aF: 14,
  eF: 8,
  lenB: 1,
  lenF: 1,
  hB: -4,
  kB: 0,
  hF: 4,
  kF: 0,
  handB: "fist",
  handF: "fist",
  seat: 0,
  wheel: 0,
  wheelRot: 0,
  overFace: 0,
  armsFront: 0,
  tremble: 0,
};

const NUMERIC = Object.keys(REST).filter((k) => typeof REST[k as keyof Pose] === "number") as (keyof Pose)[];

/** Blends two poses (w may overshoot 1 for bouncy moves). */
export function blendPose(a: Pose, b: Pose, w: number): Pose {
  const out = { ...a };
  const o = out as unknown as Record<string, number>;
  const pa = a as unknown as Record<string, number>;
  const pb = b as unknown as Record<string, number>;
  for (const k of NUMERIC) o[k] = pa[k]! + (pb[k]! - pa[k]!) * w;
  out.handB = w > 0.5 ? b.handB : a.handB;
  out.handF = w > 0.5 ? b.handF : a.handF;
  out.seat = clamp(out.seat, 0, 1);
  out.wheel = clamp(out.wheel, 0, 1);
  out.overFace = clamp(out.overFace, 0, 1);
  out.armsFront = clamp(out.armsFront, 0, 1);
  out.tremble = Math.max(0, out.tremble);
  return out;
}

export interface Geo {
  thigh: number;
  shin: number;
  hipY: number;
  hipX: number;
  cx: number;
  cy: number;
  a: number;
  b: number;
  n: number;
  taper: number;
  waistY: number;
  shoulderY: number;
  shoulderX: number;
  upper: number;
  fore: number;
  armW: number;
  legW: number;
  handR: number;
  headY: number;
  headRX: number;
  headRY: number;
  headN: number;
  /** the top of the head and hair (negative) */
  top: number;
}

const BODY = {
  bean: { a: 16, b: 15, n: 2.4, taper: 0.16, thigh: 9.5, shin: 9.5, hx: 24, hy: 23, hn: 2, upper: 10, fore: 9.5, waist: 0.4 },
  round: { a: 22, b: 16, n: 2.0, taper: 0.05, thigh: 8, shin: 8, hx: 23, hy: 22, hn: 2, upper: 9.5, fore: 9, waist: 0.46 },
  tall: { a: 13, b: 19.5, n: 2.8, taper: 0.02, thigh: 12, shin: 12, hx: 21, hy: 24, hn: 2, upper: 12.5, fore: 11.5, waist: 0.36 },
  square: { a: 18, b: 15, n: 4.6, taper: 0, thigh: 9, shin: 9, hx: 24, hy: 22.5, hn: 3.2, upper: 10.5, fore: 9.5, waist: 0.4 },
} as const;

function halfWidth(g: { cx: number; cy: number; a: number; b: number; n: number; taper: number }, y: number): number {
  const v = clamp((y - g.cy) / g.b, -1, 1);
  return g.a * (1 + g.taper * v) * Math.pow(1 - Math.pow(Math.abs(v), g.n), 1 / g.n);
}

export function geometry(look: CharacterLook): Geo {
  const B = BODY[look.body] ?? BODY.bean;
  const hk = clamp(look.height || 1, 0.8, 1.2);
  const wk = clamp(look.width || 1, 0.8, 1.2);
  const thigh = B.thigh * hk;
  const shin = B.shin * hk;
  const hipY = -(thigh + shin);
  const b = B.b * hk;
  const a = B.a * wk;
  const cy = hipY + 4 - b;
  const top = cy - b;
  const t = { cx: 0, cy, a, b, n: B.n, taper: B.taper };
  const shoulderY = cy - b * 0.5;
  const headRX = B.hx * (0.85 + 0.15 * wk);
  const headRY = B.hy;
  const headY = top - headRY * 0.6;
  return {
    thigh,
    shin,
    hipY,
    hipX: a * 0.42,
    ...t,
    waistY: cy + b * B.waist,
    shoulderY,
    shoulderX: halfWidth(t, shoulderY) - 1.4,
    upper: B.upper * hk,
    fore: B.fore * hk,
    armW: 6.4,
    legW: 7.8,
    handR: 4.5,
    headY,
    headRX,
    headRY,
    headN: B.hn,
    top: headY - headRY - 5,
  };
}

/** The unit vector of a limb angle. */
function dir(deg: number): [number, number] {
  return [Math.sin(deg * DEG), Math.cos(deg * DEG)];
}

/** Two-bone IK: the shoulder and elbow angles that put the hand on (tx, ty). `out` picks the elbow side. */
export function reach(sx: number, sy: number, tx: number, ty: number, l1: number, l2: number, out: 1 | -1): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const d = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.01);
  const base = Math.atan2(dx, dy);
  const alpha = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const upper = base + out * alpha;
  const ex = sx + Math.sin(upper) * l1;
  const ey = sy + Math.cos(upper) * l1;
  const fore = Math.atan2(tx - ex, ty - ey);
  let bend = (fore - upper) / DEG;
  while (bend > 180) bend -= 360;
  while (bend < -180) bend += 360;
  return [upper / DEG, bend];
}

export interface DrawOpts {
  t: number;
  seed: number;
  face: FaceParams;
  /** the lower body is hidden by a car door */
  inCar: boolean;
}

/** The head-top shape (used by the top-down car view). */
export function hairTopColor(look: CharacterLook): string {
  return look.hair.style === "none" ? hex(look.skin, "#f2c9a0") : look.hair.style === "cap" ? hex(look.outfit.accent) : hex(look.hair.color, "#3b2a1a");
}

export function drawCharacter(pen: Pen, look: CharacterLook, g: Geo, pose: Pose, o: DrawOpts): void {
  const O = hex(look.outline, "#1c1842");
  const skin = hex(look.skin, "#f2c9a0");
  const top = hex(look.outfit.top, "#ff6f61");
  const bottom = hex(look.outfit.bottom, "#1c1842");
  const accent = hex(look.outfit.accent, "#ffc94a");
  const ow = 1.7;

  if (pose.seat > 0.3 && !o.inCar) drawStool(pen, g, smoothstep(0.3, 0.9, pose.seat));

  pen.save();
  const jitter = pose.tremble > 0 ? noise(o.seed + 11, o.t * 28) * 0.9 * pose.tremble : 0;
  pen.translate(pose.dx + jitter, pose.dy);
  pen.rotate(pose.rot);
  pen.scale(pose.sx, pose.sy);

  // Joints.
  const hipL: [number, number] = [-g.hipX, g.hipY];
  const hipR: [number, number] = [g.hipX, g.hipY];
  const leg = (hip: [number, number], h: number, k: number) => {
    const [ux, uy] = dir(h);
    const knee: [number, number] = [hip[0] + ux * g.thigh, hip[1] + uy * g.thigh];
    const [vx, vy] = dir(h + k);
    const foot: [number, number] = [knee[0] + vx * g.shin, knee[1] + vy * g.shin];
    return { knee, foot, shinAngle: h + k };
  };
  const legB = leg(hipL, pose.hB, pose.kB);
  const legF = leg(hipR, pose.hF, pose.kF);

  if (look.hair.style === "long") {
    pen.save();
    leanFrame(pen, g, pose);
    headFrame(pen, g, pose);
    drawLongHairBack(pen, g, hex(look.hair.color, "#3b2a1a"), O, ow);
    pen.restore();
  }

  const armsInFront = pose.armsFront > 0.5 || pose.wheel > 0.5;
  if (!armsInFront) {
    pen.save();
    leanFrame(pen, g, pose);
    drawArm(pen, g, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, shade(top, -0.12), shade(skin, -0.06), O, ow);
    pen.restore();
  }

  if (!o.inCar) {
    drawLeg(pen, g, hipL, legB.knee, legB.foot, legB.shinAngle, shade(bottom, -0.1), shade(accent, -0.1), O, ow);
    drawLeg(pen, g, hipR, legF.knee, legF.foot, legF.shinAngle, bottom, accent, O, ow);
  }

  pen.save();
  leanFrame(pen, g, pose);
  drawTorso(pen, g, look, top, bottom, accent, O, ow);
  if (look.accessory === "scarf") drawScarf(pen, g, accent, O, ow, o.t);
  if (look.accessory === "bowtie") drawBowtie(pen, g, accent, O);
  if (pose.wheel > 0.02) drawWheel(pen, g, pose, O);
  if (armsInFront) drawArm(pen, g, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, shade(top, -0.12), shade(skin, -0.06), O, ow);
  if (pose.overFace < 0.5) drawArm(pen, g, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, top, skin, O, ow);

  pen.save();
  headFrame(pen, g, pose);
  drawHead(pen, g, look, skin, O, ow);
  drawHairFront(pen, g, look, O, ow);
  drawFace(pen, g.headRX, g.headRY, look, o.face, pose, o.t, o.seed);
  drawHeadAccessory(pen, g, look, accent, O, ow, pose);
  pen.restore();

  if (pose.overFace >= 0.5) drawArm(pen, g, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, top, skin, O, ow);
  pen.restore();
  pen.restore();
}

/** The upper body turns about the hips. */
export function leanFrame(pen: Pen, g: Geo, pose: Pose): void {
  if (pose.lean === 0) return;
  pen.translate(0, g.hipY);
  pen.rotate(pose.lean);
  pen.translate(0, -g.hipY);
}

/** The head tilts about the neck; the origin moves to the head's centre. */
export function headFrame(pen: Pen, g: Geo, pose: Pose): void {
  const neckY = g.headY + g.headRY * 0.78;
  pen.translate(0, neckY);
  pen.rotate(pose.head);
  pen.translate(0, g.headY - neckY);
}

function drawStool(pen: Pen, g: Geo, k: number): void {
  const y = -g.shin + 3.5;
  pen.line([-10, y + 3, -12, 0], 2.6, "#7a4a2a", k);
  pen.line([10, y + 3, 12, 0], 2.6, "#7a4a2a", k);
  pen.rect(-15, y - 1, 30, 5.5, 2.5, "#a8683a", k);
}

function drawLeg(pen: Pen, g: Geo, hip: [number, number], knee: [number, number], foot: [number, number], shinAngle: number, pants: string, shoe: string, O: string, ow: number): void {
  const pts = [hip[0], hip[1], knee[0], knee[1], foot[0], foot[1]];
  pen.line(pts, g.legW + ow * 2, O);
  pen.line(pts, g.legW, pants);
  const rot = clamp(-shinAngle * 0.6, -60, 60);
  const cx = foot[0] + Math.cos(rot * DEG) * 2.4;
  const cy = foot[1] - 1.2 + Math.sin(rot * DEG) * 2.4;
  pen.ellipse(cx, cy, 6.6 + ow, 3.9 + ow, rot, O);
  pen.ellipse(cx, cy, 6.6, 3.9, rot, shoe);
}

function drawArm(pen: Pen, g: Geo, sx: number, a: number, e: number, len: number, hand: Hand, sleeve: string, skin: string, O: string, ow: number): void {
  const sy = g.shoulderY;
  const k = clamp(len || 1, 0.6, 1.6);
  const [ux, uy] = dir(a);
  const ex = sx + ux * g.upper * k;
  const ey = sy + uy * g.upper * k;
  const [vx, vy] = dir(a + e);
  const hx = ex + vx * g.fore * k;
  const hy = ey + vy * g.fore * k;
  const pts = [sx, sy, ex, ey, hx, hy];
  pen.line(pts, g.armW + ow * 2, O);
  pen.line(pts, g.armW, sleeve);
  if (hand === "thumb" || hand === "point") {
    // the thumb points up the screen; the finger points along the forearm
    const [px, py] = hand === "thumb" ? [0, -1] : [vx, vy];
    const fx = hx + px * (g.handR + 3.6);
    const fy = hy + py * (g.handR + 3.6);
    pen.line([hx, hy, fx, fy], 3.2 + ow * 2, O);
    pen.line([hx, hy, fx, fy], 3.2, skin);
  }
  const r = hand === "open" ? g.handR * 1.12 : g.handR;
  pen.circle(hx, hy, r + ow, O);
  pen.circle(hx, hy, r, skin);
  if (hand === "open") {
    // three little finger bumps make an open hand
    for (let i = -1; i <= 1; i += 1) {
      const ang = Math.atan2(vy, vx) + i * 0.55;
      pen.circle(hx + Math.cos(ang) * r * 0.95, hy + Math.sin(ang) * r * 0.95, 1.7, skin);
    }
  }
}

function drawTorso(pen: Pen, g: Geo, look: CharacterLook, top: string, bottom: string, accent: string, O: string, ow: number): void {
  const pts = superellipse(0, g.cy, g.a, g.b, g.n, g.taper, 30);
  pen.poly(inflate(pts, ow), O);
  pen.poly(pts, bottom);
  const upperBox = [-g.a * 2, g.cy - g.b * 2, g.a * 2, g.cy - g.b * 2, g.a * 2, g.waistY, -g.a * 2, g.waistY];
  const shirt = clipConvex(pts, upperBox);
  pen.poly(shirt, top);
  const topY = g.cy - g.b;
  if (look.outfit.pattern === "stripes") {
    const span = g.waistY - topY;
    for (let k = 0; k < 3; k += 1) {
      const y0 = topY + span * (0.3 + k * 0.24);
      const band = [-g.a * 2, y0, g.a * 2, y0, g.a * 2, y0 + span * 0.1, -g.a * 2, y0 + span * 0.1];
      pen.poly(clipConvex(band, shirt), accent, 0.9);
    }
  } else if (look.outfit.pattern === "dots") {
    const span = g.waistY - topY;
    const spots: [number, number][] = [
      [-0.45, 0.38],
      [0.4, 0.33],
      [0.05, 0.62],
      [-0.3, 0.86],
      [0.5, 0.8],
    ];
    for (const [fx, fy] of spots) {
      const y = topY + span * fy;
      const w = halfWidth(g, y);
      pen.circle(fx * w * 0.85, y, Math.min(2.3, span * 0.09), accent, 0.95);
    }
  }
  // collar and a belt line give the outfit some shape
  pen.ellipse(0, topY + 1.6, g.a * 0.36, 2.4, 0, shade(top, -0.18));
  pen.line([-halfWidth(g, g.waistY) + 1.5, g.waistY, halfWidth(g, g.waistY) - 1.5, g.waistY], 1.4, shade(bottom, -0.25), 0.7);
}

function drawScarf(pen: Pen, g: Geo, accent: string, O: string, ow: number, t: number): void {
  const y = g.cy - g.b + 2;
  const w = halfWidth(g, y + 3) + 2;
  pen.rect(-w - ow, y - 2.5 - ow, (w + ow) * 2, 6 + ow * 2, 3 + ow, O);
  pen.rect(-w, y - 2.5, w * 2, 6, 3, accent);
  const sway = Math.sin(t * 3.2) * 1.6;
  const tail = [w * 0.35, y + 2, w * 0.35 + 6, y + 2, w * 0.35 + 7 + sway, y + 15, w * 0.35 + 1 + sway, y + 15];
  pen.poly(inflate(tail, ow), O);
  pen.poly(tail, shade(accent, -0.12));
}

function drawBowtie(pen: Pen, g: Geo, accent: string, O: string): void {
  const y = g.cy - g.b + 3.5;
  pen.poly([0, y, -7, y - 4, -7, y + 4], accent);
  pen.poly([0, y, 7, y - 4, 7, y + 4], accent);
  pen.circle(0, y, 2.2, shade(accent, -0.2));
  pen.line([-7, y - 4, -7, y + 4, 0, y, 7, y - 4, 7, y + 4], 1, O, 0.6);
}

function drawWheel(pen: Pen, g: Geo, pose: Pose, O: string): void {
  const k = smoothstep(0, 0.6, pose.wheel);
  const cx = g.shoulderX + 7;
  const cy = g.shoulderY + 9;
  const r = 8.5;
  const ring = arcPts(cx, cy, r, r * 0.9, 0, 360, 18);
  pen.line(ring, 4.4, O, k);
  pen.line(ring, 2.6, "#3d4458", k);
  const sp = pose.wheelRot * DEG;
  for (const off of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    pen.line([cx, cy, cx + Math.sin(sp + off) * r * 0.9, cy - Math.cos(sp + off) * r * 0.8], 1.8, "#3d4458", k);
  }
  pen.circle(cx, cy, 2.2, "#ffc94a", k);
}

/** Where the hands hold the wheel (local, lean frame): driving poses reach for these. */
export function wheelGrips(g: Geo, rot: number): { b: [number, number]; f: [number, number] } {
  const cx = g.shoulderX + 7;
  const cy = g.shoulderY + 9;
  const r = 8.5;
  const at = (deg: number): [number, number] => [cx + Math.sin((deg + rot) * DEG) * r, cy - Math.cos((deg + rot) * DEG) * r * 0.9];
  return { b: at(-62), f: at(62) };
}

function headShape(g: Geo): number[] {
  return g.headN > 2.2 ? superellipse(0, 0, g.headRX, g.headRY, g.headN, 0, 28) : [];
}

function drawHead(pen: Pen, g: Geo, look: CharacterLook, skin: string, O: string, ow: number): void {
  const earsHidden = look.hair.style === "long" || look.accessory === "headphones" || look.accessory === "helmet";
  if (!earsHidden) {
    for (const s of [-1, 1]) {
      pen.circle(s * g.headRX * 0.97, 2, 5 + ow, O);
      pen.circle(s * g.headRX * 0.97, 2, 5, shade(skin, -0.05));
    }
  }
  const sq = headShape(g);
  if (sq.length) {
    pen.poly(inflate(sq, ow), O);
    pen.poly(sq, skin);
  } else {
    pen.ellipse(0, 0, g.headRX + ow, g.headRY + ow, 0, O);
    pen.ellipse(0, 0, g.headRX, g.headRY, 0, skin);
  }
  if (look.hair.style === "none" && look.accessory !== "helmet") pen.ellipse(-g.headRX * 0.35, -g.headRY * 0.62, 5, 2.6, -20, "#ffffff", 0.28);
}

/** A hair cap over the top of the head, with a wavy fringe or spikes. */
function capPts(g: Geo, spikes: number, fringeY: number, lift: number): number[] {
  const rx = g.headRX + 1.2;
  const ry = g.headRY + 1.2;
  const pts: number[] = [];
  const steps = spikes > 0 ? spikes * 2 : 16;
  for (let i = 0; i <= steps; i += 1) {
    const a = (186 + (168 * i) / steps) * DEG;
    const out = spikes > 0 && i % 2 === 1 ? lift : 0;
    pts.push(Math.cos(a) * (rx + out), Math.sin(a) * (ry + out));
  }
  // the fringe: a gentle wave across the forehead
  const right = pts[pts.length - 2]!;
  const left = pts[0]!;
  for (let i = 1; i < 6; i += 1) {
    const x = right + ((left - right) * i) / 6;
    pts.push(x, fringeY + (i % 2 === 0 ? 1.8 : -0.6));
  }
  return pts;
}

function drawHairFront(pen: Pen, g: Geo, look: CharacterLook, O: string, ow: number): void {
  const style = look.hair.style;
  const c = hex(look.hair.color, "#3b2a1a");
  const fringe = -g.headRY * 0.56;
  if (style === "none") return;
  if (style === "short" || style === "long" || style === "bun") {
    const pts = capPts(g, 0, fringe, 0);
    pen.poly(inflate(pts, ow), O);
    pen.poly(pts, c);
    pen.ellipse(-g.headRX * 0.3, -g.headRY * 0.72, 5.5, 2.2, -15, "#ffffff", 0.18);
    if (style === "bun") {
      const by = -g.headRY - 4;
      pen.circle(0, by, 7.5 + ow, O);
      pen.circle(0, by, 7.5, c);
      pen.ellipse(0, by + 6, 4.2, 1.8, 0, hex(look.outfit.accent));
    }
    return;
  }
  if (style === "spiky") {
    const pts = capPts(g, 5, fringe, 7);
    pen.poly(inflate(pts, ow), O);
    pen.poly(pts, c);
    return;
  }
  if (style === "curly") {
    const pts: number[] = [];
    const rx = g.headRX + 2;
    const ry = g.headRY + 2;
    const bumps = 7;
    for (let i = 0; i <= bumps * 4; i += 1) {
      const a = (182 + (176 * i) / (bumps * 4)) * DEG;
      const bump = Math.abs(Math.sin((i / 4) * Math.PI)) * 4.2;
      pts.push(Math.cos(a) * (rx + bump), Math.sin(a) * (ry + bump));
    }
    pts.push(g.headRX * 0.7, fringe + 1, 0, fringe + 3, -g.headRX * 0.7, fringe + 1);
    pen.poly(inflate(pts, ow), O);
    pen.poly(pts, c);
    return;
  }
  if (style === "cap") {
    const accent = hex(look.outfit.accent, "#ffc94a");
    // hair peeks out at the sides, the cap's dome and a brim towards the facing side
    pen.ellipse(-g.headRX * 0.86, -g.headRY * 0.15, 4, 6, 0, c);
    pen.ellipse(g.headRX * 0.86, -g.headRY * 0.15, 4, 6, 0, c);
    const dome = arcPts(0, -g.headRY * 0.28, g.headRX + 1.5, g.headRY * 0.82, 180, 360, 14);
    pen.poly(inflate(dome, ow), O);
    pen.poly(dome, accent);
    const brim = [g.headRX * 0.1, -g.headRY * 0.3, g.headRX + 12, -g.headRY * 0.22, g.headRX + 11, -g.headRY * 0.08, g.headRX * 0.1, -g.headRY * 0.14];
    pen.poly(inflate(brim, ow), O);
    pen.poly(brim, shade(accent, -0.15));
    pen.circle(0, -g.headRY * 1.08, 2, shade(accent, -0.2));
  }
}

function drawLongHairBack(pen: Pen, g: Geo, c: string, O: string, ow: number): void {
  const pts = [
    ...arcPts(0, 0, g.headRX + 3, g.headRY + 3, 180, 360, 12),
    g.headRX + 4,
    g.headRY * 1.25,
    g.headRX * 0.6,
    g.headRY * 1.55,
    -g.headRX * 0.6,
    g.headRY * 1.55,
    -g.headRX - 4,
    g.headRY * 1.25,
  ];
  pen.poly(inflate(pts, ow), O);
  pen.poly(pts, shade(c, -0.08));
}

function drawHeadAccessory(pen: Pen, g: Geo, look: CharacterLook, accent: string, O: string, ow: number, pose: Pose): void {
  const acc = look.accessory;
  if (acc === "glasses") {
    const fx = pose.turn * g.headRX * 0.3;
    const sp = g.headRX * 0.37;
    const ey = -g.headRY * 0.06 + pose.nod * 3;
    const r = 6.6;
    for (const s of [-1, 1]) {
      const ex = fx + s * sp * (1 - 0.2 * Math.max(0, -s * pose.turn));
      pen.line(arcPts(ex, ey, r, r * 0.92, 0, 360, 16), 1.7, O);
    }
    pen.line(quadPts(fx - sp + r, ey - 1, fx, ey - 3, fx + sp - r, ey - 1, 4), 1.5, O);
    return;
  }
  if (acc === "helmet") {
    const dome = arcPts(0, -g.headRY * 0.18, g.headRX + 3.5, g.headRY * 0.98, 180, 360, 16);
    pen.poly(inflate(dome, ow), O);
    pen.poly(dome, accent);
    pen.line(arcPts(0, -g.headRY * 0.18, g.headRX * 0.6, g.headRY * 0.8, 230, 310, 6), 2.6, "#ffffff", 0.7);
    pen.rect(-g.headRX - 3.5, -g.headRY * 0.24, (g.headRX + 3.5) * 2, 3.5, 1.7, shade(accent, -0.25));
    return;
  }
  if (acc === "headphones") {
    pen.line(arcPts(0, -2, g.headRX + 2.5, g.headRY + 3.5, 190, 350, 12), 3.4, O);
    for (const s of [-1, 1]) {
      pen.ellipse(s * (g.headRX + 0.5), 1, 4.8 + ow, 7 + ow, 0, O);
      pen.ellipse(s * (g.headRX + 0.5), 1, 4.8, 7, 0, accent);
    }
  }
}

/** A tiny standalone mark the top-down car view uses for each occupant: the top of the head. */
export function headTop(pen: Pen, look: CharacterLook, x: number, y: number, r: number): void {
  const O = hex(look.outline, "#1c1842");
  pen.circle(x, y, r + 1.4, O);
  pen.circle(x, y, r, hairTopColor(look));
  if (look.accessory === "helmet") pen.circle(x, y, r * 0.92, hex(look.outfit.accent));
  pen.circle(x - r * 0.3, y - r * 0.3, r * 0.3, "#ffffff", 0.25);
}
