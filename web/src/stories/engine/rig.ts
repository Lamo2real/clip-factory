// Lamo Stories engine: the character rig (CONTRACTS §45.8). A character is a small set of look choices; this file
// turns them into the same shapes every time, so a character looks identical in every video by construction.
// Local units: about 90 tall, feet at (0, 0), facing +x (the caller mirrors for facing left), y down.

import { cel, grade, ink, inkPx, lift, lineUnits, ND, nightDrive } from "./art.ts";
import { F } from "./frame.ts";
import { DEG, clamp, clamp01, hex, luminance, mix, noise, shade, smoothstep } from "./math.ts";
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
  /** night drive (§45.45): the scene time the face last changed (ActorState.faceSince); the brows overshoot by 20%
   * and settle over 0.12 s after it. Left out, no overshoot. */
  faceSince?: number;
}

/** The head-top shape (used by the top-down car view). */
export function hairTopColor(look: CharacterLook): string {
  return look.hair.style === "none" ? hex(look.skin, "#f2c9a0") : look.hair.style === "cap" ? hex(look.outfit.accent) : hex(look.hair.color, "#3b2a1a");
}

export function drawCharacter(pen: Pen, look: CharacterLook, g: Geo, pose: Pose, o: DrawOpts): void {
  if (nightDrive()) {
    drawCharacterNight(pen, look, g, pose, o);
    return;
  }
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
  if (nightDrive()) {
    // night drive: the soft ink line, the hair in the place's light and a warm lit crown instead of the white shine
    pen.circle(x, y, r + lineUnits(pen, 2.3), ink(hex(look.outline, "#1c1842")));
    const c = grade(hairTopColor(look));
    pen.circle(x, y, r, c);
    if (look.accessory === "helmet") pen.circle(x, y, r * 0.92, grade(hex(look.outfit.accent)));
    pen.circle(x - r * 0.3, y - r * 0.3, r * 0.34, lift(look.accessory === "helmet" ? grade(hex(look.outfit.accent)) : c, 0.3), 0.6);
    return;
  }
  const O = hex(look.outline, "#1c1842");
  pen.circle(x, y, r + 1.4, O);
  pen.circle(x, y, r, hairTopColor(look));
  if (look.accessory === "helmet") pen.circle(x, y, r * 0.92, hex(look.outfit.accent));
  pen.circle(x - r * 0.3, y - r * 0.3, r * 0.3, "#ffffff", 0.25);
}


// ---- night drive (CONTRACTS §45.45): the same parts and proportions, drawn with soft thin lines and cel shading ----
// Nothing here changes a character's geometry (the BODY table, the joints, the head shape stay), so layout, seats and
// bubbles are the same in both styles. Own colours pass through the scene's light (art.ts grade); the outline is the
// owner's pick half way to a soft brown ink and about 2.3 px wide on a standing character. The lamps light the back
// of the character (-x in rig units, which the caller mirrors for facing left) with the rim light, and a key light
// from the upper front leaves a cel shadow on the lower back of each part.

/** The colours and line widths one person is drawn with: night drive's, or classic's for the shots' close-ups. */
interface Paint {
  nd: boolean;
  O: string;
  skin: string;
  top: string;
  bottom: string;
  accent: string;
  hair: string;
  /** the outline width in the pen's local units */
  ow: number;
  /** inner detail lines (folds, strands): 0.35 × the outline */
  thin: number;
  /** design px per local unit */
  u: number;
  /** the side the lamps light: -1 is -x (the back of a character facing +x) */
  ls: 1 | -1;
  /** turns geometry written for "the lamps light -x" to this lamp side (1 or -1) */
  mx: number;
  rim: string;
  rimA: number;
}

/** The paint for a person drawn by `pen` now. `u` overrides the design px per rig unit (hands and feet, drawn in the
 * shot's own units, say how big a rig unit would be). Classic keeps the owner's colours and its 1.7-unit outline, at
 * most 8 px. */
function paintOf(pen: Pen, look: CharacterLook, ls: 1 | -1, u = pen.unit() / (F.k || 1), unit = 1): Paint {
  const nd = nightDrive();
  const own = (c: string | undefined, fb: string) => (nd ? grade(hex(c, fb)) : hex(c, fb));
  const ow = nd ? lineUnits(pen, inkPx(u)) : Math.min(1.7 * unit, lineUnits(pen, 8));
  return {
    nd,
    O: nd ? ink(hex(look.outline, "#1c1842")) : hex(look.outline, "#1c1842"),
    skin: own(look.skin, "#f2c9a0"),
    top: own(look.outfit.top, "#ff6f61"),
    bottom: own(look.outfit.bottom, "#1c1842"),
    accent: own(look.outfit.accent, "#ffc94a"),
    hair: look.hair.style === "none" ? own(look.skin, "#f2c9a0") : own(look.hair.color, "#3b2a1a"),
    ow,
    thin: ow * 0.35,
    u,
    ls,
    mx: -ls,
    rim: F.light.rim,
    rimA: F.light.rimA,
  };
}

/** A shadow tone: night drive's cel (k of the way to ND.celDark), classic's shade. */
const dk = (P: Paint, c: string, k = 0.22): string => (P.nd ? cel(c, k) : shade(c, -k));
/** A lit tone: night drive's lift (warmed by the lamps), classic's shade. */
const lt = (P: Paint, c: string, k = 0.1): string => (P.nd ? lift(c, k) : shade(c, k));

/** The side of the line through A and B that S is on, as a big convex quad (a half-plane for clipConvex). */
function halfPlane(ax: number, ay: number, bx: number, by: number, sx: number, sy: number): number[] {
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  let nx = -uy;
  let ny = ux;
  if ((sx - ax) * nx + (sy - ay) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const L = 4000;
  return [ax - ux * L, ay - uy * L, bx + ux * L, by + uy * L, bx + ux * L + nx * L, by + uy * L + ny * L, ax - ux * L + nx * L, ay - uy * L + ny * L];
}

/** A convex clip for a curved cel shadow: the big circle through A and B on S's side, its arc bulging `sag` past the
 * chord AB away from S, so the shadow's edge is a soft curve, not a straight cut. */
function lensClip(ax: number, ay: number, bx: number, by: number, sx: number, sy: number, sag: number): number[] {
  const c = Math.hypot(bx - ax, by - ay) || 1;
  let nx = -(by - ay) / c;
  let ny = (bx - ax) / c;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  if ((sx - mx) * nx + (sy - my) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const s = Math.max(0.01, sag);
  const R = (c * c) / 4 / (2 * s) + s / 2;
  return arcPts(mx + nx * (R - s), my + ny * (R - s), R, R, 0, 360, 48).slice(0, -2);
}

/** The cel shade along a limb: a narrower line on its lower back side, inside the limb's own line. */
function celLine(pen: Pen, pts: number[], w: number, color: string, mx: number): void {
  const sx = -0.6 * mx;
  const sy = 0.8;
  const n = pts.length / 2;
  const normals: [number, number][] = [];
  for (let i = 0; i + 1 < n; i += 1) {
    const dx = pts[(i + 1) * 2]! - pts[i * 2]!;
    const dy = pts[(i + 1) * 2 + 1]! - pts[i * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * sx + ny * sy < 0) {
      nx = -nx;
      ny = -ny;
    }
    normals.push([nx, ny]);
  }
  if (!normals.length) return;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = normals[Math.max(0, i - 1)]!;
    const b = normals[Math.min(normals.length - 1, i)]!;
    const nx = a[0] + b[0];
    const ny = a[1] + b[1];
    const len = Math.hypot(nx, ny) || 1;
    out.push(pts[i * 2]! + (nx / len) * w * 0.26, pts[i * 2 + 1]! + (ny / len) * w * 0.26);
  }
  pen.line(out, w * 0.42, color);
}

/** Night drive's brows overshoot by 20% just after a face change and settle over 0.12 s (§45.45 §9). */
function overshoot(face: FaceParams, t: number, since: number | undefined): FaceParams {
  if (since === undefined) return face;
  const dt = t - since;
  if (!(dt >= 0 && dt < 0.12)) return face;
  const k = 1 + 0.2 * (1 - smoothstep(0, 0.12, dt));
  return { ...face, brow: face.brow * k, browUp: face.browUp * k, browAsym: face.browAsym * k };
}

/** Soft ambient occlusion under the feet, on the ground (local units, before the pose moves the body). */
function footShadow(pen: Pen, pose: Pose): void {
  const up = Math.max(0, -pose.dy);
  const k = 1 - Math.min(0.5, up / 40);
  const lie = smoothstep(30, 70, -pose.rot);
  const x = pose.dx - 40 * lie;
  pen.ellipse(x, 1.5, (38 + 34 * lie) * k, 8 * k, 0, ND.ao, 0.12 * k);
  pen.ellipse(x, 1, (26 + 30 * lie) * k, 5 * k, 0, ND.ao, 0.32 * k);
}

function drawCharacterNight(pen: Pen, look: CharacterLook, g: Geo, pose: Pose, o: DrawOpts): void {
  if (!o.inCar) footShadow(pen, pose);
  if (pose.seat > 0.3 && !o.inCar) {
    const k = smoothstep(0.3, 0.9, pose.seat);
    const y = -g.shin + 3.5;
    pen.line([-10, y + 3, -12, 0], 2.6, grade("#7a4a2a"), k);
    pen.line([10, y + 3, 12, 0], 2.6, grade("#7a4a2a"), k);
    pen.rect(-15, y - 1, 30, 5.5, 2.5, grade("#a8683a"), k);
    pen.rect(-15, y - 1, 30, 1.6, 0.8, lift(grade("#a8683a"), 0.15), k);
  }

  pen.save();
  const jitter = pose.tremble > 0 ? noise(o.seed + 11, o.t * 28) * 0.9 * pose.tremble : 0;
  pen.translate(pose.dx + jitter, pose.dy);
  pen.rotate(pose.rot);
  pen.scale(pose.sx, pose.sy);
  const P = paintOf(pen, look, -1);
  const face = overshoot(o.face, o.t, o.faceSince);

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
    longHairBackNight(pen, g, P);
    pen.restore();
  }

  const sleeveB = dk(P, P.top, 0.12);
  const skinB = dk(P, P.skin, 0.06);
  const armsInFront = pose.armsFront > 0.5 || pose.wheel > 0.5;
  if (!armsInFront) {
    pen.save();
    leanFrame(pen, g, pose);
    armNight(pen, g, P, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, sleeveB, skinB);
    pen.restore();
  }

  if (!o.inCar) {
    legNight(pen, g, P, hipL, legB.knee, legB.foot, legB.shinAngle, dk(P, P.bottom, 0.1), dk(P, P.accent, 0.1));
    legNight(pen, g, P, hipR, legF.knee, legF.foot, legF.shinAngle, P.bottom, P.accent);
  }

  pen.save();
  leanFrame(pen, g, pose);
  torsoNight(pen, g, look, P);
  if (look.accessory === "scarf") drawScarf(pen, g, P.accent, P.O, P.ow, o.t);
  if (look.accessory === "bowtie") drawBowtie(pen, g, P.accent, P.O);
  if (pose.wheel > 0.02) wheelNight(pen, g, pose, P);
  if (armsInFront) armNight(pen, g, P, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, sleeveB, skinB);
  if (pose.overFace < 0.5) armNight(pen, g, P, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, P.top, P.skin);

  pen.save();
  headFrame(pen, g, pose);
  headNight(pen, g, look, P, face, pose, o.t, o.seed);
  pen.restore();

  if (pose.overFace >= 0.5) armNight(pen, g, P, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, P.top, P.skin);
  pen.restore();
  pen.restore();
}

/** The head in its frame (origin at its centre): ears, head, hair, face, the head accessory and the rim light. */
function headNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, face: FaceParams, pose: { turn: number; lookX: number; lookY: number; nod: number }, t: number, seed: number, farEar = 0): void {
  headShapeNight(pen, g, look, P, farEar);
  hairNight(pen, g, look, P);
  drawFace(pen, g.headRX, g.headRY, look, face, pose, t, seed);
  accessoryNight(pen, g, look, P, pose);
  rimNight(pen, g, look, P);
}

function legNight(pen: Pen, g: Geo, P: Paint, hip: [number, number], knee: [number, number], foot: [number, number], shinAngle: number, pants: string, shoe: string): void {
  const pts = [hip[0], hip[1], knee[0], knee[1], foot[0], foot[1]];
  pen.line(pts, g.legW + P.ow * 2, P.O);
  pen.line(pts, g.legW, pants);
  celLine(pen, pts, g.legW, cel(pants), P.mx);
  const rot = clamp(-shinAngle * 0.6, -60, 60);
  const cx = foot[0] + Math.cos(rot * DEG) * 2.4;
  const cy = foot[1] - 1.2 + Math.sin(rot * DEG) * 2.4;
  pen.ellipse(cx, cy, 6.6 + P.ow, 3.9 + P.ow, rot, P.O);
  pen.ellipse(cx, cy, 6.6, 3.9, rot, shoe);
  // a small highlight on the toe cap
  pen.ellipse(cx + Math.cos(rot * DEG) * 2.6 + Math.sin(rot * DEG) * 1.3, cy + Math.sin(rot * DEG) * 2.6 - Math.cos(rot * DEG) * 1.3, 2.2, 0.9, rot, lift(shoe, 0.3), 0.7);
}

function armNight(pen: Pen, g: Geo, P: Paint, sx: number, a: number, e: number, len: number, hand: Hand, sleeve: string, skin: string): void {
  const sy = g.shoulderY;
  const k = clamp(len || 1, 0.6, 1.6);
  const [ux, uy] = dir(a);
  const ex = sx + ux * g.upper * k;
  const ey = sy + uy * g.upper * k;
  const [vx, vy] = dir(a + e);
  const hx = ex + vx * g.fore * k;
  const hy = ey + vy * g.fore * k;
  const pts = [sx, sy, ex, ey, hx, hy];
  pen.line(pts, g.armW + P.ow * 2, P.O);
  pen.line(pts, g.armW, sleeve);
  celLine(pen, pts, g.armW, cel(sleeve), P.mx);
  if (hand === "thumb" || hand === "point") {
    const [px, py] = hand === "thumb" ? [0, -1] : [vx, vy];
    const fx = hx + px * (g.handR + 3.6);
    const fy = hy + py * (g.handR + 3.6);
    pen.line([hx, hy, fx, fy], 3.2 + P.ow * 2, P.O);
    pen.line([hx, hy, fx, fy], 3.2, skin);
  }
  const r = hand === "open" ? g.handR * 1.12 : g.handR;
  pen.circle(hx, hy, r + P.ow, P.O);
  pen.circle(hx, hy, r, skin);
  if (hand === "open") {
    for (let i = -1; i <= 1; i += 1) {
      const ang = Math.atan2(vy, vx) + i * 0.55;
      pen.circle(hx + Math.cos(ang) * r * 0.95, hy + Math.sin(ang) * r * 0.95, 1.7, skin);
    }
  } else {
    // the knuckles' soft shade on the fist's lower side
    pen.ellipse(hx - P.mx * r * 0.2, hy + r * 0.38, r * 0.7, r * 0.42, 0, cel(skin, 0.14));
  }
}

function torsoNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint): void {
  const pts = superellipse(0, g.cy, g.a, g.b, g.n, g.taper, 30);
  pen.poly(inflate(pts, P.ow), P.O);
  pen.poly(pts, P.bottom);
  const upperBox = [-g.a * 2, g.cy - g.b * 2, g.a * 2, g.cy - g.b * 2, g.a * 2, g.waistY, -g.a * 2, g.waistY];
  const shirt = clipConvex(pts, upperBox);
  pen.poly(shirt, P.top);
  const topY = g.cy - g.b;
  const span = g.waistY - topY;
  if (look.outfit.pattern === "stripes") {
    for (let k = 0; k < 3; k += 1) {
      const y0 = topY + span * (0.3 + k * 0.24);
      const band = [-g.a * 2, y0, g.a * 2, y0, g.a * 2, y0 + span * 0.1, -g.a * 2, y0 + span * 0.1];
      pen.poly(clipConvex(band, shirt), P.accent, 0.9);
    }
  } else if (look.outfit.pattern === "dots") {
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
      pen.circle(fx * w * 0.85, y, Math.min(2.3, span * 0.09), P.accent, 0.95);
    }
  }
  // the belt line, then the cel shadow over the back third (shirt, pattern and trousers alike)
  const wy = halfWidth(g, g.waistY);
  pen.line([-wy + 1.5, g.waistY, wy - 1.5, g.waistY], 1.4, cel(P.bottom, 0.3), 0.7);
  const back = lensClip(-g.a * 0.3 * P.mx, topY - 2, -g.a * 0.42 * P.mx, g.cy + g.b + 2, -g.a * 3 * P.mx, g.cy, g.b * 0.16);
  pen.poly(clipConvex(pts, back), ND.celDark, 0.22);
  // two fabric folds: under the front arm and above the waist
  const fold = cel(P.top, 0.3);
  const sY = g.shoulderY;
  pen.line(quadPts(g.a * 0.58 * P.mx, sY + 2.5, g.a * 0.62 * P.mx, sY + 7, g.a * 0.36 * P.mx, sY + 9.5, 5), P.thin, fold, 0.75);
  pen.line(quadPts(-g.a * 0.5 * P.mx, g.waistY - 4.5, -g.a * 0.05 * P.mx, g.waistY - 1.8, g.a * 0.34 * P.mx, g.waistY - 4, 5), P.thin, fold, 0.75);
  // the chin's soft shadow on the shirt top (instead of the classic collar)
  const chin = arcPts(0, g.headY + g.headRY * 0.97, g.headRX * 0.55, g.headRY * 0.12, 0, 360, 16);
  pen.poly(clipConvex(chin.slice(0, -2), shirt), ND.ao, 0.4);
  // the rim light along the back shoulder
  const n = g.n;
  const arc: number[] = [];
  const ia = g.a - P.ow * 0.6;
  const ib = g.b - P.ow * 0.6;
  for (let i = 0; i <= 6; i += 1) {
    const t = (198 + (42 * i) / 6) * DEG;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const y = ib * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
    const x = ia * (1 + (g.taper * y) / ib) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    arc.push(x * P.mx, g.cy + y);
  }
  pen.line(arc, P.ow, P.rim, P.rimA);
}

function wheelNight(pen: Pen, g: Geo, pose: Pose, P: Paint): void {
  const k = smoothstep(0, 0.6, pose.wheel);
  const cx = g.shoulderX + 7;
  const cy = g.shoulderY + 9;
  const r = 8.5;
  const ring = arcPts(cx, cy, r, r * 0.9, 0, 360, 18);
  pen.line(ring, 2.6 + P.ow * 2, P.O, k);
  pen.line(ring, 2.6, ND.wheel, k);
  pen.line(arcPts(cx, cy, r, r * 0.9, 205, 335, 8), 1.1, ND.wheelLit, k);
  const sp = pose.wheelRot * DEG;
  for (const off of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    pen.line([cx, cy, cx + Math.sin(sp + off) * r * 0.9, cy - Math.cos(sp + off) * r * 0.8], 1.8, ND.wheel, k);
  }
  pen.circle(cx, cy, 2.2, ND.wheelHub, k);
}

/** The head's points: its superellipse, or the ellipse as a polygon. */
function headPts(g: Geo): number[] {
  return g.headN > 2.2 ? superellipse(0, 0, g.headRX, g.headRY, g.headN, 0, 28) : arcPts(0, 0, g.headRX, g.headRY, 0, 360, 32).slice(0, -2);
}

function headShapeNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, farEar = 0): void {
  const rx = g.headRX;
  const ry = g.headRY;
  const earsHidden = look.hair.style === "long" || look.accessory === "headphones" || look.accessory === "helmet";
  if (!earsHidden) {
    for (const s of [-1, 1]) {
      if (s === farEar) continue;
      const ex = s * rx * 0.97;
      pen.circle(ex, 2, 5 + P.ow, P.O);
      pen.circle(ex, 2, 5, mix(P.skin, dk(P, P.skin), 0.3));
      pen.line(arcPts(ex + s * 0.5, 2.2, 2.3, 2.8, s > 0 ? -75 : 105, s > 0 ? 75 : 255, 6), P.ow * 0.7, dk(P, P.skin, 0.4), 0.8);
    }
  }
  const pts = headPts(g);
  if (g.headN > 2.2) pen.poly(inflate(pts, P.ow), P.O);
  else pen.ellipse(0, 0, rx + P.ow, ry + P.ow, 0, P.O);
  if (g.headN > 2.2) pen.poly(pts, P.skin);
  else pen.ellipse(0, 0, rx, ry, 0, P.skin);
  // the cel shadow on the lower back quarter, away from the key light
  const m = P.mx;
  const ax = Math.cos(190 * DEG) * rx * m;
  const ay = Math.sin(190 * DEG) * ry;
  const bx = Math.cos(112 * DEG) * rx * m;
  const by = Math.sin(112 * DEG) * ry;
  pen.poly(clipConvex(pts, lensClip(ax, ay, bx, by, -rx * m, ry, Math.hypot(bx - ax, by - ay) * 0.12)), dk(P, P.skin));
  if (look.hair.style === "none" && look.accessory !== "helmet") pen.ellipse(rx * 0.3 * m, -ry * 0.64, 6, 2.8, 20 * m, lt(P, P.skin, 0.16), 0.8);
}

/** The scalloped fringe cap (short, long and bun): the top of the head and a soft edge of 7 scallops across the
 * forehead at -0.50 × headRY, a little lower at the temples. */
function scallopCapPts(g: Geo): number[] {
  const rx = g.headRX + 1.2;
  const ry = g.headRY + 1.2;
  const pts: number[] = [];
  for (let i = 0; i <= 16; i += 1) {
    const a = (186 + (168 * i) / 16) * DEG;
    pts.push(Math.cos(a) * rx, Math.sin(a) * ry);
  }
  const x0 = g.headRX * 0.86;
  const base = (x: number) => -g.headRY * 0.5 + 0.1 * g.headRY * (x / g.headRX) ** 2;
  const per = 4;
  const steps = 7 * per;
  for (let k = 0; k <= steps; k += 1) {
    const x = x0 - (2 * x0 * k) / steps;
    pts.push(x, base(x) + 1.6 * Math.sin((Math.PI * (k % per)) / per));
  }
  return pts;
}

function hairNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint): void {
  const style = look.hair.style;
  if (style === "none") return;
  const c = P.hair;
  // the strand groups: a lighter tone on dark hair (a darker one would not show), a darker one on light hair
  const strand = luminance(c) < 0.3 ? lift(c, 0.18) : mix(c, "#0f0b0a", 0.35);
  const rx = g.headRX;
  const ry = g.headRY;
  const m = P.mx;
  const fringe = -ry * 0.56;
  const lw = Math.max(P.thin, P.ow * 0.5);
  if (style === "short" || style === "long" || style === "bun") {
    const pts = scallopCapPts(g);
    pen.poly(inflate(pts, P.ow), P.O);
    pen.poly(pts, c);
    // three strand groups sweeping from the crown to the fringe, and a highlight on the lit side
    for (const i of [-1, 0, 1]) {
      const x = i * 0.36 * rx;
      pen.line(quadPts(x - 0.12 * rx, -ry * 0.98, x + 0.16 * rx, -ry * 0.86, x + 0.24 * rx, -ry * 0.62, 5), lw, strand, 0.75);
    }
    pen.line(arcPts(0, 0, (rx + 1.2) * 0.8, (ry + 1.2) * 0.86, m > 0 ? 284 : 216, m > 0 ? 324 : 256, 6), P.ow * 2, mix(c, "#c9b8a0", 0.25), 0.35);
    if (style === "bun") {
      const by = -ry - 4;
      pen.circle(0, by, 7.5 + P.ow, P.O);
      pen.circle(0, by, 7.5, c);
      pen.line(arcPts(0, by, 5.2, 4.2, 200, 340, 6), lw, strand, 0.8);
      pen.ellipse(0, by + 6, 4.2, 1.8, 0, P.accent);
    }
    return;
  }
  if (style === "spiky") {
    const pts = capPts(g, 5, fringe, 7);
    pen.poly(inflate(pts, P.ow), P.O);
    pen.poly(pts, c);
    // one line per spike, from its tip in towards the crown
    for (let i = 1; i < 11; i += 2) {
      const a = (186 + (168 * i) / 10) * DEG;
      const tx = Math.cos(a) * (rx + 1.2 + 7);
      const ty = Math.sin(a) * (ry + 1.2 + 7);
      pen.line([tx * 0.86, ty * 0.86, tx * 0.6, ty * 0.6 + 1], lw, strand, 0.75);
    }
    pen.line(arcPts(0, 0, (rx + 1.2) * 0.82, (ry + 1.2) * 0.84, m > 0 ? 288 : 212, m > 0 ? 326 : 252, 6), P.ow * 2, mix(c, "#c9b8a0", 0.25), 0.35);
    return;
  }
  if (style === "curly") {
    const pts: number[] = [];
    const crx = rx + 2;
    const cry = ry + 2;
    const bumps = 7;
    for (let i = 0; i <= bumps * 8; i += 1) {
      const a = (182 + (176 * i) / (bumps * 8)) * DEG;
      const bump = Math.sqrt(Math.abs(Math.sin((i / 8) * Math.PI))) * 4.2;
      pts.push(Math.cos(a) * (crx + bump), Math.sin(a) * (cry + bump));
    }
    // a soft fringe of small curls, joined to each temple by a rounded curve (not a straight cut)
    const fy = (x: number) => fringe + 2 + 0.12 * ry * (x / rx) ** 2;
    const ty = pts[pts.length - 1]!;
    pts.push(...quadPts(crx, ty, rx * 0.86, ty, rx * 0.86, fy(rx * 0.86), 5).slice(2, -2));
    for (let k = 1; k < 20; k += 1) {
      const x = rx * 0.86 - (rx * 1.72 * k) / 20;
      pts.push(x, fy(x) + 1.4 * Math.sin((Math.PI * (k % 4)) / 4));
    }
    pts.push(...quadPts(-rx * 0.86, fy(-rx * 0.86), -rx * 0.86, pts[1]!, pts[0]!, pts[1]!, 5).slice(2, -2));
    pen.poly(inflate(pts, P.ow), P.O);
    pen.poly(pts, c);
    // four small curls
    const curls: [number, number][] = [
      [-0.5, -0.78],
      [-0.12, -0.95],
      [0.28, -0.84],
      [0.6, -0.62],
    ];
    for (const [fx, fy] of curls) pen.line(arcPts(fx * rx, fy * ry, 2.6, 2.2, 140, 400, 7), lw, strand, 0.75);
    return;
  }
  if (style === "cap") {
    pen.ellipse(-rx * 0.9, -ry * 0.22, 3, 4.4, 0, c);
    pen.ellipse(rx * 0.9, -ry * 0.22, 3, 4.4, 0, c);
    const dome = arcPts(0, -ry * 0.28, rx + 1.5, ry * 0.82, 180, 360, 14);
    pen.poly(inflate(dome, P.ow), P.O);
    pen.poly(dome, P.accent);
    // the seam over the dome, and the brim's shadow on the forehead
    pen.line(arcPts(0, -ry * 0.28, rx * 0.35, ry * 0.8, 200, 270, 6), lw, cel(P.accent, 0.35), 0.8);
    pen.ellipse(rx * 0.45, -ry * 0.1, rx * 0.5, 2.4, 4, ND.ao, 0.3);
    const brim = [rx * 0.1, -ry * 0.3, rx + 12, -ry * 0.22, rx + 11, -ry * 0.08, rx * 0.1, -ry * 0.14];
    pen.poly(inflate(brim, P.ow), P.O);
    pen.poly(brim, cel(P.accent, 0.15));
    pen.circle(0, -ry * 1.08, 2, cel(P.accent, 0.3));
  }
}

function longHairBackNight(pen: Pen, g: Geo, P: Paint): void {
  const rx = g.headRX;
  const ry = g.headRY;
  const pts = [...arcPts(0, 0, rx + 3, ry + 3, 180, 360, 12), rx + 4, ry * 1.25, rx * 0.6, ry * 1.55, -rx * 0.6, ry * 1.55, -rx - 4, ry * 1.25];
  const c = mix(P.hair, cel(P.hair), 0.4);
  pen.poly(inflate(pts, P.ow), P.O);
  pen.poly(pts, c);
  const strand = mix(P.hair, "#0f0b0a", 0.35);
  const lw = Math.max(P.thin, P.ow * 0.5);
  for (const s of [-1, 1]) pen.line(quadPts(s * (rx + 1), ry * 0.2, s * (rx + 2.5), ry * 0.85, s * rx * 0.7, ry * 1.45, 5), lw, strand, 0.75);
}

function accessoryNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, pose: { turn: number; nod: number }): void {
  const acc = look.accessory;
  const rx = g.headRX;
  const ry = g.headRY;
  if (acc === "glasses") {
    const turn = clamp(pose.turn, -1, 1);
    const fx = turn * rx * 0.3;
    const sp = rx * 0.44;
    const ey = -ry * 0.06 + pose.nod * 3;
    const r = 4.6;
    const lw = P.ow * 1.4;
    // round rims (28 points, smooth up close), and the bridge from one rim's inner edge to the other's
    const ex = (s: number) => fx + s * sp * (1 - 0.22 * Math.max(0, -s * turn));
    for (const s of [-1, 1]) {
      pen.line(arcPts(ex(s), ey, r, r * 0.86, 0, 360, 28), lw, P.O);
      pen.line(arcPts(ex(s), ey, r * 0.7, r * 0.6, 200, 250, 3), lw * 0.7, "#ffffff", 0.35);
    }
    const bl = ex(-1) + r;
    const br = ex(1) - r;
    pen.line(quadPts(bl, ey - 1, (bl + br) / 2, ey - 2.4, br, ey - 1, 4), lw, P.O);
    return;
  }
  if (acc === "helmet") {
    const dome = arcPts(0, -ry * 0.18, rx + 3.5, ry * 0.98, 180, 360, 16);
    pen.poly(inflate(dome, P.ow), P.O);
    pen.poly(dome, P.accent);
    pen.poly(clipConvex(dome, halfPlane(-rx * 0.2 * P.mx, -ry, -rx * 0.9 * P.mx, -ry * 0.2, -rx * 2 * P.mx, 0)), ND.celDark, 0.2);
    pen.line(arcPts(0, -ry * 0.18, rx * 0.6, ry * 0.8, P.mx > 0 ? 250 : 230, P.mx > 0 ? 310 : 290, 6), 2.2, lift(P.accent, 0.4), 0.6);
    pen.rect(-rx - 3.5, -ry * 0.24, (rx + 3.5) * 2, 3.5, 1.7, cel(P.accent, 0.25));
    return;
  }
  if (acc === "headphones") {
    pen.line(arcPts(0, -2, rx + 2.5, ry + 3.5, 190, 350, 12), 2 + P.ow * 2, P.O);
    pen.line(arcPts(0, -2, rx + 2.5, ry + 3.5, 190, 350, 12), 2, cel(P.accent, 0.2));
    for (const s of [-1, 1]) {
      pen.ellipse(s * (rx + 0.5), 1, 4.8 + P.ow, 7 + P.ow, 0, P.O);
      pen.ellipse(s * (rx + 0.5), 1, 4.8, 7, 0, P.accent);
      pen.ellipse(s * (rx + 0.5) - P.mx * 1.2, 2, 2.6, 5, 0, cel(P.accent, 0.25));
    }
  }
}

/** The rim light along the top back of the head's silhouette (its hair, cap or helmet). */
function rimNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint): void {
  const style = look.hair.style;
  const acc = look.accessory;
  let ex = 0;
  let cy = 0;
  let ry = g.headRY;
  if (acc === "helmet") {
    ex = 3.5;
    cy = -g.headRY * 0.18;
    ry = g.headRY * 0.98;
  } else if (style === "curly") ex = 3.6;
  else if (style === "cap") {
    ex = 1.5;
    cy = -g.headRY * 0.28;
    ry = g.headRY * 0.82;
  } else if (style !== "none") ex = 1.2;
  const inset = P.ow * 0.55;
  const a0 = P.mx > 0 ? 200 : -110;
  const a1 = P.mx > 0 ? 290 : -20;
  if (style === "curly" && acc !== "helmet") {
    // along the curls' own outer edge (hairNight's 7 bumps from 182° to 358°), never across them
    const pts: number[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const deg = a0 + ((a1 - a0) * i) / 24;
      const along = ((((deg - 182) % 360) + 360) % 360) / 176;
      const bump = Math.sqrt(Math.abs(Math.sin(along * 7 * Math.PI))) * 4.2;
      const a = deg * DEG;
      pts.push(Math.cos(a) * (g.headRX + 2 + bump - inset), Math.sin(a) * (g.headRY + 2 + bump - inset));
    }
    pen.line(pts, P.ow, P.rim, P.rimA);
    return;
  }
  pen.line(arcPts(0, cy, g.headRX + ex - inset, ry + (acc === "helmet" || style === "cap" ? 0 : ex) - inset, a0, a1, 10), P.ow, P.rim, P.rimA);
}

// ---- the shots' close-ups (§45.45): busts, hands on the wheel and a foot on a pedal -------------------------------

/** How a bust is seen: front-on (Face up close) or at three quarters (Side window). */
export type BustView = "front" | "three_quarter";

/** A bust's options: `view`, and `lampSide`, the side the street lamps light it from (the rim light and the cel shadow
 * are on that side, the key light on the other). Left out, front lights from -x and three_quarter from +x. */
export type BustOpts = DrawOpts & { view: BustView; lampSide?: 1 | -1 };

/** A character from the chest up, for the shots (§45.45 §5). The origin is the head's centre, in rig units (the caller
 * translates and scales: Face up close draws headRX at about 0.30 of the short side). The shoulders are 2.6 × headRX
 * wide, from 0.85 × headRY below the head's centre down past the frame (to 6 × headRY), with the upper arms reaching
 * down towards a wheel below the frame. `pose.turn` is the face's turn on top of the view: 0 looks at the camera
 * (front) and three_quarter turns it a further -0.45 (towards -x); nod, lookX, lookY and head (a tilt) count as in
 * drawCharacter. Faces, blinks, the hum and the noise mouths are the character's own, through the same code as
 * drawCharacter. Night drive and classic both draw it. */
export function drawBust(pen: Pen, look: CharacterLook, g: Geo, pose: Pose, o: BustOpts): void {
  const q = o.view === "three_quarter";
  const ls: 1 | -1 = o.lampSide ?? (q ? 1 : -1);
  const P = paintOf(pen, look, ls);
  const rx = g.headRX;
  const ry = g.headRY;
  const m = P.mx;
  const turn = clamp(pose.turn + (q ? -0.45 : 0), -1, 1);
  const face = P.nd ? overshoot(o.face, o.t, o.faceSince) : o.face;
  // at three quarters the far shoulder (the way the face turns, -x) is narrower and the chest moves over a little
  const X = (x: number) => (q ? (x < 0 ? x * 0.74 : x * 1.06) - rx * 0.08 : x);
  const tilt = (fn: () => void) => {
    pen.save();
    pen.translate(0, ry * 0.78);
    pen.rotate(pose.head);
    pen.translate(0, -ry * 0.78);
    fn();
    pen.restore();
  };

  if (look.hair.style === "long") tilt(() => (P.nd ? longHairBackNight(pen, g, P) : drawLongHairBack(pen, g, P.hair, P.O, P.ow)));

  // the shirt: rounded shoulders sloping from the neck, the upper arms down the sides past the frame
  const top = ry * 0.85;
  const bottom = ry * 6;
  const right = [...quadPts(rx * 0.46, top, rx * 1.12, top + ry * 0.05, rx * 1.3, top + ry * 0.75, 6), rx * 1.37, top + ry * 2.2, rx * 1.42, bottom];
  const left: number[] = [];
  for (let i = right.length - 2; i >= 0; i -= 2) left.push(-right[i]!, right[i + 1]!);
  const raw = [...right, ...left];
  const shirt = raw.map((v, i) => (i % 2 === 0 ? X(v) : v));
  pen.poly(inflate(shirt, P.ow), P.O);
  pen.poly(shirt, P.top);
  // the outfit's own pattern, so the character is the same up close
  if (look.outfit.pattern === "stripes") {
    for (const k of [1.35, 2.35, 3.35, 4.35]) {
      const y0 = top + ry * k;
      pen.poly(clipConvex([-rx * 3, y0, rx * 3, y0, rx * 3, y0 + ry * 0.36, -rx * 3, y0 + ry * 0.36], shirt), P.accent, 0.9);
    }
  } else if (look.outfit.pattern === "dots") {
    const spots: [number, number][] = [
      [-0.78, 1.5],
      [0.62, 1.35],
      [-0.15, 2.3],
      [0.95, 2.6],
      [-1.0, 3.1],
      [0.35, 3.4],
    ];
    for (const [fx, fy] of spots) pen.circle(X(fx * rx), top + fy * ry, rx * 0.11, P.accent, 0.95);
  }
  // the lit shoulder on the key side, the cel shadow on the lamp side
  const slope = [...quadPts(rx * 0.5, top, rx * 1.12, top + ry * 0.05, rx * 1.3, top + ry * 0.75, 6), rx * 1.33, top + ry * 1.1];
  const band: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i < slope.length; i += 2) {
    const x = slope[i]!;
    const y = slope[i + 1]!;
    const k = Math.min(1, i / 6);
    const dx = rx * 0.25 - x;
    const dy = top + ry * 2.4 - y;
    const l = Math.hypot(dx, dy) || 1;
    const w = ry * 0.24 * k * (i >= slope.length - 2 ? 0.2 : 1);
    band.push(X(-m * -x), y);
    inner.push(X(-m * -(x + (dx / l) * w)), y + (dy / l) * w);
  }
  for (let i = inner.length - 2; i >= 0; i -= 2) band.push(inner[i]!, inner[i + 1]!);
  pen.poly(band, lt(P, P.top, 0.08));
  const shadow = clipConvex(shirt, halfPlane(X(-rx * 0.52 * m), top, X(-rx * 0.74 * m), bottom, X(-rx * 3 * m), top));
  if (P.nd) pen.poly(shadow, ND.celDark, 0.22);
  else pen.poly(shadow, shade(P.top, -0.12));
  // folds: where each upper arm meets the chest, and a crease from each armpit
  const fold = dk(P, P.top, 0.3);
  for (const s of [-1, 1]) {
    pen.line(quadPts(X(s * rx * 1.02), top + ry * 1.1, X(s * rx * 0.88), top + ry * 1.9, X(s * rx * 0.97), top + ry * 3, 6), P.thin, fold, 0.78);
    pen.line(quadPts(X(s * rx * 0.9), top + ry * 1.45, X(s * rx * 0.72), top + ry * 1.55, X(s * rx * 0.56), top + ry * 1.95, 4), P.thin, fold, 0.72);
  }
  // the neckline, the chin's shadow on the shirt and the rim light along the lamp-side shoulder
  pen.line(quadPts(X(-rx * 0.42), top + ry * 0.02, X(0), top + ry * 0.55, X(rx * 0.42), top + ry * 0.02, 8), P.ow, dk(P, P.top, 0.35));
  if (look.accessory === "scarf") {
    // the scarf round the neck, its end hanging down the key side
    const band = [X(-rx * 0.66), ry * 0.9, X(rx * 0.66), ry * 0.9, X(rx * 0.7), ry * 1.26, X(-rx * 0.7), ry * 1.26];
    pen.poly(inflate(band, P.ow), P.O);
    pen.poly(band, P.accent);
    const tail = [X(rx * 0.22 * m), ry * 1.15, X(rx * 0.5 * m), ry * 1.15, X(rx * 0.56 * m + rx * 0.04 * Math.sin(o.t * 3.2)), ry * 2.1, X(rx * 0.26 * m + rx * 0.04 * Math.sin(o.t * 3.2)), ry * 2.1];
    pen.poly(inflate(tail, P.ow), P.O);
    pen.poly(tail, dk(P, P.accent, 0.12));
    pen.line([X(-rx * 0.6), ry * 1.08, X(rx * 0.6), ry * 1.1], P.thin, dk(P, P.accent, 0.3), 0.75);
  } else if (look.accessory === "bowtie") {
    const by = ry * 1.16;
    const w = rx * 0.3;
    pen.poly([X(0), by, X(-w), by - w * 0.55, X(-w), by + w * 0.55], P.accent);
    pen.poly([X(0), by, X(w), by - w * 0.55, X(w), by + w * 0.55], P.accent);
    pen.circle(X(0), by, w * 0.3, dk(P, P.accent, 0.2));
    pen.line([X(-w), by - w * 0.55, X(-w), by + w * 0.55, X(0), by, X(w), by - w * 0.55, X(w), by + w * 0.55], P.ow, P.O, 0.7);
  }
  const chin = arcPts(turn * rx * 0.12, ry * 0.99, rx * 0.55, ry * 0.12, 0, 360, 16).slice(0, -2);
  if (P.nd) pen.poly(clipConvex(chin, shirt), ND.ao, 0.4);
  else pen.poly(clipConvex(chin, shirt), shade(P.top, -0.18));
  const rimPts = quadPts(rx * 0.5, top + P.ow, rx * 1.1, top + ry * 0.06 + P.ow, rx * 1.26, top + ry * 0.75, 6);
  pen.line(rimPts.map((v, i) => (i % 2 === 0 ? X(-m * v) : v)), P.ow, P.rim, P.rimA);

  // the head, through the same parts as drawCharacter
  const headPose = { turn, lookX: pose.lookX, lookY: pose.lookY, nod: pose.nod };
  tilt(() => {
    // at three quarters the ear on the side the face turns to is hidden behind the cheek
    if (P.nd) headNight(pen, g, look, P, face, headPose, o.t, o.seed, q && turn <= -0.35 ? -1 : q && turn >= 0.35 ? 1 : 0);
    else {
      drawHead(pen, g, look, P.skin, P.O, P.ow);
      drawHairFront(pen, g, look, P.O, P.ow);
      drawFace(pen, rx, ry, look, face, headPose, o.t, o.seed);
      drawHeadAccessory(pen, g, look, P.accent, P.O, P.ow, { ...pose, turn });
    }
  });
}

/** Mitt hands on a steering wheel's rim (§45.45 §5): at each grip (pen units) a hand of radius `r` (pen units) with the
 * thumb wrapped over the rim, and a sleeve cuff coming in from below (down and outwards, long enough to leave the
 * frame from a wheel near its bottom edge). `centre` is the wheel's centre, which turns each hand along the rim; left
 * out, it is worked out from two grips at 10 and 2 o'clock. */
export function drawWheelHands(pen: Pen, look: CharacterLook, grips: [number, number][], r: number, centre?: [number, number]): void {
  if (!grips.length || !(r > 0)) return;
  // a rig hand is 4.5 units: the outline is the one a person drawn at this size would have
  const P = paintOf(pen, look, -1, (r * pen.unit()) / (F.k || 1) / 4.5, r / 4.5);
  let cx: number;
  let cy: number;
  if (centre) [cx, cy] = centre;
  else if (grips.length >= 2) {
    const xs = grips.map((p) => p[0]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const R = (x1 - x0) / 2 / 0.866 || r * 6;
    cx = (x0 + x1) / 2;
    cy = grips.reduce((a, p) => a + p[1], 0) / grips.length + R * 0.5;
  } else [cx, cy] = [grips[0]![0], grips[0]![1] + r * 6];
  const side = (x: number) => (x < cx - 1e-6 ? -1 : x > cx + 1e-6 ? 1 : 0);
  // the sleeves first, under the hands
  for (const [gx, gy] of grips) {
    const s = side(gx);
    const sl = [gx + s * 0.2 * r, gy + 0.4 * r, gx + s * 1.1 * r, gy + 4 * r, gx + s * 2 * r, gy + 11 * r];
    const w = 1.75 * r;
    pen.line(sl, w + P.ow * 2, P.O);
    pen.line(sl, w, P.top);
    celLine(pen, sl, w, dk(P, P.top), s >= 0 ? -1 : 1);
    pen.line([gx + s * 0.3 * r, gy + 1.2 * r, gx + s * 0.55 * r, gy + 2.2 * r], w * 0.98, dk(P, P.top, 0.12));
  }
  for (const [gx, gy] of grips) {
    const s = side(gx);
    const d = Math.hypot(gx - cx, gy - cy) || 1;
    const ux = (gx - cx) / d;
    const uy = (gy - cy) / d;
    const rot = (Math.atan2(uy, ux) / DEG + 90) % 180;
    const hx = gx + ux * 0.1 * r;
    const hy = gy + uy * 0.1 * r;
    pen.ellipse(hx, hy, 1.05 * r + P.ow, 0.8 * r + P.ow, rot, P.O);
    pen.ellipse(hx, hy, 1.05 * r, 0.8 * r, rot, P.skin);
    // the outer side of the fist in shadow, and the fingers wrapped round the rim
    const mitt = arcPts(hx, hy, 1.05 * r, 0.8 * r, 0, 360, 18).slice(0, -2);
    const turned: number[] = [];
    const cr = Math.cos(rot * DEG);
    const sr = Math.sin(rot * DEG);
    for (let i = 0; i < mitt.length; i += 2) {
      const lx = mitt[i]! - hx;
      const ly = mitt[i + 1]! - hy;
      turned.push(hx + lx * cr - ly * sr, hy + lx * sr + ly * cr);
    }
    pen.poly(clipConvex(turned, halfPlane(hx + ux * 0.2 * r, hy + uy * 0.2 * r, hx + ux * 0.2 * r - uy, hy + uy * 0.2 * r + ux, hx + ux * 3 * r, hy + uy * 3 * r)), dk(P, P.skin, 0.16));
    const tx = -uy;
    const ty = ux;
    for (const f of [-0.32, 0.3]) pen.line([hx + tx * f * r + ux * 0.05 * r, hy + ty * f * r + uy * 0.05 * r, hx + tx * f * r + ux * 0.7 * r, hy + ty * f * r + uy * 0.7 * r], P.thin * 1.4, dk(P, P.skin, 0.4), 0.7);
    // the thumb over the rim on its inner side
    const thx = hx - ux * 0.55 * r - tx * s * 0.25 * r;
    const thy = hy - uy * 0.55 * r - ty * s * 0.25 * r;
    pen.ellipse(thx, thy, 0.52 * r + P.ow, 0.28 * r + P.ow, rot, P.O);
    pen.ellipse(thx, thy, 0.52 * r, 0.28 * r, rot, P.skin);
  }
}

/** A foot on a pedal (§45.45 §5): the ball of the shoe at (x, y) in pen units, the shoe about 300 pen units long (design
 * px when the pen is the frame's), turned `angle` degrees: 0 points the toe down the frame with the trouser leg coming
 * in from above, + turns it clockwise (about +25 brings the leg in from the top right). `press` (0..1) pushes the toe
 * down and forward onto the pedal. The shoe is the rig's shoe colour (the outfit's accent). */
export function drawFoot(pen: Pen, look: CharacterLook, x: number, y: number, angle: number, press: number): void {
  const p = clamp01(press);
  const L = 310;
  const W = 140;
  pen.save();
  pen.translate(x, y);
  pen.rotate(angle);
  pen.translate(0, 18 * p);
  pen.scale(1, 1 - 0.07 * p);
  // the rig's shoe is 13.2 units long: the outline a person drawn at this size would have
  const unit = L / 13.2;
  const P = paintOf(pen, look, -1, (unit * pen.unit()) / (F.k || 1), unit);
  // the trouser leg from off the frame down to the ankle, with its hem and the lamps' rim along one side
  const lw = W * 1.15;
  const leg = [0, -0.3 * L, 22, -1.2 * L, 64, -3.2 * L];
  pen.line(leg, lw + P.ow * 2, P.O);
  pen.line(leg, lw, P.bottom);
  celLine(pen, leg, lw, dk(P, P.bottom), P.mx);
  pen.line([-lw * 0.4, -0.5 * L, -lw * 0.4 + 42, -1.4 * L, -lw * 0.4 + 84, -3.2 * L], P.ow, P.rim, P.rimA);
  // the shoe: a rounded upper, widest towards the toe, on a sole that shows along its outer edge
  const shoe = superellipse(0, 0.06 * L, W / 2, L / 2, 2.5, 0.1, 32);
  const sole = shoe.map((v, i) => (i % 2 === 0 ? v * 1.06 + W * 0.09 : v * 1.02 + 6));
  pen.poly(inflate(sole, P.ow), P.O);
  pen.poly(sole, P.nd ? mix(P.accent, ND.ink, 0.6) : shade(P.accent, -0.4));
  pen.poly(shoe, P.accent);
  const side = clipConvex(shoe, lensClip(W * 0.2, -L, W * 0.26, L, W * 2, 0, W * 0.05));
  if (P.nd) pen.poly(side, ND.celDark, 0.22);
  else pen.poly(side, shade(P.accent, -0.12));
  // the sole line, the toe cap's seam, the laces and a shine on the toe
  pen.line(arcPts(W * 0.03, 0.06 * L, W * 0.5, L * 0.49, -60, 80, 10), P.ow * 0.9, P.O, 0.8);
  pen.line(quadPts(-W * 0.42, 0.3 * L, 0, 0.36 * L, W * 0.42, 0.3 * L, 5), P.ow * 0.8, dk(P, P.accent, 0.35), 0.8);
  for (const k of [-0.2, -0.1, 0, 0.1]) pen.line([-W * 0.18, k * L, W * 0.16, k * L + 5], P.ow * 1.2, lt(P, P.accent, 0.35), 0.85);
  pen.ellipse(-W * 0.14, 0.44 * L, W * 0.17, 0.06 * L, 0, lt(P, P.accent, 0.25), 0.6);
  pen.restore();
}
