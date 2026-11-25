// Lamo Stories engine: the character rig (CONTRACTS §45.8). A character is a small set of look choices; this file
// turns them into the same shapes every time, so a character looks identical in every video by construction.
// Local units: about 90 tall, feet at (0, 0), facing +x (the caller mirrors for facing left), y down.

import { cel, fadeStops, grade, ink, inkPx, lift, lineUnits, lit, ND, nightDrive } from "./art.ts";
import { F } from "./frame.ts";
import { DEG, channels, clamp, clamp01, hex, luminance, mix, noise, shade, smoothstep, toHex } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, capsulePts, clipConvex, ellipsePts, inflate, joinShapes, placePts, quadPts, ribbonPts, roundRectPts, smoothPts, superellipse } from "./pen.ts";
import { drawFace, eyeSize, faceSpots, type FaceParams } from "./face.ts";
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


// ---- night drive (CONTRACTS §45.45), the chunky look: bold toy-like shapes on the same rig ------------------------
// Nothing here changes a character's geometry (the BODY table, the joints, the head's radii stay), so layout, seats
// and bubbles are the same in both styles. What changes is what is drawn on the joints: a rounded-square head with one
// sculpted hairdo, thick tapered arms and legs, big mitts, big shoes on a thick pale sole, a jumper with rounded-box shoulders,
// a thick roll collar and a ribbed hem band. Own colours pass through the scene's light (art.ts grade); the outline is the owner's
// pick half way to a soft brown ink and about 2.3 px wide on a standing character. The lamps light the back of the
// character (-x in rig units, which the caller mirrors for facing left) with the rim light, and a key light from the
// upper front leaves one crisp cel shadow on the lower back of each part. Shapes of one colour at one depth are one
// polygon (pen.ts joinShapes), so the new detail fits the same shape budget (script.ts SHAPES_ND.actor).

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
function lensClip(ax: number, ay: number, bx: number, by: number, sx: number, sy: number, sag: number, segs = 48): number[] {
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
  return arcPts(mx + nx * (R - s), my + ny * (R - s), R, R, 0, 360, segs).slice(0, -2);
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

type Pt = [number, number];

/** The sizes a chunky person is drawn with (rig units): thick tapered limbs, big mitts and big shoes. The joints stay
 * geometry()'s; a slimmer or a wider body (its BODY row, the width slider) has slimmer or thicker limbs. */
interface Chunk {
  /** the arm's width at the shoulder, the elbow and the wrist */
  arm: readonly [number, number, number];
  /** the leg's width at the hip, the knee and the ankle */
  leg: readonly [number, number, number];
  /** the mitt's radius */
  hand: number;
  /** the shoe's size against the bean body's */
  shoe: number;
}

function chunkOf(g: Geo): Chunk {
  const k = clamp(g.a / 16, 0.86, 1.14);
  // a clear taper: a round shoulder down to a slim wrist, a thick thigh down to a slim ankle (the cuff and the hem flare)
  return { arm: [9.6 * k, 8.3 * k, 6.6 * k], leg: [10.8 * k, 9.5 * k, 7.8 * k], hand: 4.6 + 0.7 * k, shoe: 0.86 + 0.12 * k };
}

/** How many times the usual points a night person's curves are drawn with: 1 at a standing character's size, 2 from
 * 6 design px per rig unit and 3 from 10 (the shots' close-ups, where a few long straight edges show). */
function fine(P: Paint): number {
  return P.u >= 10 ? 3 : P.u >= 6 ? 2 : 1;
}

/** A limb's tube: two tapered capsules that share the joint's circle (shoulder, elbow, wrist; hip, knee, ankle), each
 * `grow` wider all round (its outline). Joined they are one shape with a round elbow or knee at any bend. */
function tube(a: Pt, b: Pt, c: Pt, w: readonly [number, number, number], grow: number, segs: number): number[][] {
  return [capsulePts(a[0], a[1], w[0] / 2 + grow, b[0], b[1], w[1] / 2 + grow, segs), capsulePts(b[0], b[1], w[1] / 2 + grow, c[0], c[1], w[2] / 2 + grow, segs)];
}

/** A band across a limb (a cuff, a turned-up hem): a rounded rectangle centred on (cx, cy), `len` along the limb's
 * unit direction (vx, vy) and `wid` across it. */
function bandPts(cx: number, cy: number, vx: number, vy: number, len: number, wid: number, r: number): number[] {
  const pts = roundRectPts(-len / 2, -wid / 2, len, wid, Math.min(r, len / 2, wid / 2));
  for (let i = 0; i < pts.length; i += 2) {
    const along = pts[i]!;
    const across = pts[i + 1]!;
    pts[i] = cx + along * vx - across * vy;
    pts[i + 1] = cy + along * vy + across * vx;
  }
  return pts;
}

/** Soft ambient occlusion under the feet, on the ground (local units, before the pose moves the body): one glow. */
function footShadow(pen: Pen, pose: Pose): void {
  const up = Math.max(0, -pose.dy);
  const k = 1 - Math.min(0.5, up / 40);
  const lie = smoothstep(30, 70, -pose.rot);
  const x = pose.dx - 40 * lie + 1.5;
  // a wide soft glow, and a flat darker core that shows past the big shoes on light ground and on the dark road
  pen.glow(x, 1.8, (42 + 34 * lie) * k, 8.5 * k, ND.ao, fadeStops(0.5 * k, 1));
  pen.ellipse(x, 1.3, (25 + 30 * lie) * k, 4.6 * k, 0, ND.ao, 0.34 * k);
}

/** The rim light down the back edge of a limb: a thin lit strip just inside its outline on the lamps' side. `c` is the
 * limb's joints (x, y pairs), `w` its width at each. */
function rimLimb(pen: Pen, P: Paint, c: number[], w: readonly number[]): void {
  const n = c.length >> 1;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const dx = c[i1 * 2]! - c[i0 * 2]!;
    const dy = c[i1 * 2 + 1]! - c[i0 * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    // the normal that faces the lamps (-x × mx)
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * -P.mx + ny * -0.2 < 0) {
      nx = -nx;
      ny = -ny;
    }
    const h = Math.max(0, w[i]! / 2 - P.ow * 0.6);
    out.push(c[i * 2]! + nx * h, c[i * 2 + 1]! + ny * h);
  }
  pen.line(out, P.ow * 1.1, P.rim, P.rimA * 0.85);
}

/** The stool a sitting character sits on outside a car: its two legs (one shape), the seat and the seat's lit top. */
function stoolNight(pen: Pen, g: Geo, k: number): void {
  const y = -g.shin + 3.5;
  const wood = grade("#7a4a2a");
  pen.poly(joinShapes([capsulePts(-10, y + 3, 1.4, -12, 0, 1.3, 3), capsulePts(10, y + 3, 1.4, 12, 0, 1.3, 3)]), wood, k);
  pen.rect(-15, y - 1, 30, 5.5, 2.5, grade("#a8683a"), k);
  pen.rect(-15, y - 1, 30, 1.8, 0.9, lift(grade("#a8683a"), 0.16), k);
}

function drawCharacterNight(pen: Pen, look: CharacterLook, g: Geo, pose: Pose, o: DrawOpts): void {
  if (!o.inCar) footShadow(pen, pose);
  if (pose.seat > 0.3 && !o.inCar) stoolNight(pen, g, smoothstep(0.3, 0.9, pose.seat));

  pen.save();
  const jitter = pose.tremble > 0 ? noise(o.seed + 11, o.t * 28) * 0.9 * pose.tremble : 0;
  pen.translate(pose.dx + jitter, pose.dy);
  pen.rotate(pose.rot);
  pen.scale(pose.sx, pose.sy);
  const P = paintOf(pen, look, -1);
  const C = chunkOf(g);
  const face = overshoot(o.face, o.t, o.faceSince);

  const hipL: Pt = [-g.hipX, g.hipY];
  const hipR: Pt = [g.hipX, g.hipY];
  const leg = (hip: Pt, h: number, k: number) => {
    const [ux, uy] = dir(h);
    const knee: Pt = [hip[0] + ux * g.thigh, hip[1] + uy * g.thigh];
    const [vx, vy] = dir(h + k);
    const foot: Pt = [knee[0] + vx * g.shin, knee[1] + vy * g.shin];
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

  // the back arm and leg are a tone darker: they are further from the key light
  const sleeveB = cel(P.top, 0.12);
  const skinB = cel(P.skin, 0.06);
  const armsInFront = pose.armsFront > 0.5 || pose.wheel > 0.5;
  // hands that hold the wheel close round it (a little smaller); hands up at the face (a gasp) rest on the cheeks
  const grip = pose.wheel > 0.5 ? 0.86 : 1;
  const cheeks = pose.overFace > 0.5;
  if (!armsInFront) {
    pen.save();
    leanFrame(pen, g, pose);
    armNight(pen, g, P, C, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, sleeveB, skinB, 1, cheeks);
    pen.restore();
  }

  if (!o.inCar) {
    const sole = soleOf(P);
    legNight(pen, g, P, C, hipL, legB.knee, legB.foot, legB.shinAngle, cel(P.bottom, 0.1), cel(P.accent, 0.1), cel(sole, 0.1), false);
    legNight(pen, g, P, C, hipR, legF.knee, legF.foot, legF.shinAngle, P.bottom, P.accent, sole, true);
  }

  pen.save();
  leanFrame(pen, g, pose);
  torsoNight(pen, g, look, P);
  if (look.accessory === "scarf") scarfNight(pen, g, P, o.t);
  if (look.accessory === "bowtie") bowtieNight(pen, g, P);
  if (pose.wheel > 0.02) wheelNight(pen, g, pose, P);
  if (armsInFront) armNight(pen, g, P, C, -g.shoulderX, pose.aB, pose.eB, pose.lenB, pose.handB, sleeveB, skinB, grip, cheeks);
  if (pose.overFace < 0.5) armNight(pen, g, P, C, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, P.top, P.skin, grip, false);

  pen.save();
  headFrame(pen, g, pose);
  headNight(pen, g, look, P, face, pose, o.t, o.seed);
  pen.restore();

  if (pose.overFace >= 0.5) armNight(pen, g, P, C, g.shoulderX, pose.aF, pose.eF, pose.lenF, pose.handF, P.top, P.skin, grip, true);
  pen.restore();
  pen.restore();
}

/** The head in its frame (origin at its centre): ears, head, hair, face, the head accessory and the rim light. `hs` -1
 * mirrors the hairdo (a three-quarter bust looks the other way, and its quiff with it). */
function headNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, face: FaceParams, pose: { turn: number; lookX: number; lookY: number; nod: number }, t: number, seed: number, farEar = 0, hs: 1 | -1 = 1): void {
  headShapeNight(pen, g, look, P, farEar);
  const top = hairNight(pen, g, look, P, hs);
  drawFace(pen, g.headRX, g.headRY, look, face, pose, t, seed);
  const over = accessoryNight(pen, g, look, P, pose, top);
  // (curls under a headphone band get no rim light: it would cross the band)
  if (!(look.accessory === "headphones" && look.hair.style === "curly")) rimNight(pen, g, P, over ?? top, hs);
}

// ---- the body ------------------------------------------------------------------------------------------------------

/** A fist's thumb: one fat oval on the side the arm's front faces (forward when the arm hangs, up when it is held
 * out), a third of it over the mitt: its centre, its radii along and across the forearm and its turn in degrees. */
function thumbOf(H: Pt, vx: number, vy: number, r: number): { x: number; y: number; rx: number; ry: number; rot: number } {
  return { x: H[0] + (vx * 0.2 + vy * 0.74) * r, y: H[1] + (vy * 0.2 - vx * 0.74) * r, rx: r * 0.5, ry: r * 0.34, rot: Math.atan2(vy, vx) / DEG };
}

/** A mitt's shapes, each `grow` bigger all round (its outline): one clean round mitt at H and, by `hand`, a fist's
 * thumb oval (fist, point), three equal fat finger lobes in an even fan with the thumb set lower and apart (open), the
 * thumb standing up the screen (thumb) or a finger out along the arm (point). (vx, vy) is the forearm's unit
 * direction. */
function mittShapes(H: Pt, vx: number, vy: number, r: number, hand: Hand, grow: number, n: number): number[][] {
  const at = (along: number, across: number): Pt => [H[0] + (vx * along + vy * across) * r, H[1] + (vy * along - vx * across) * r];
  const palm = hand === "open" ? r * 0.94 : r;
  const out = [ellipsePts(H[0], H[1], palm + grow, palm + grow, n > 1 ? 12 * n : 10)];
  if (hand === "open") {
    // three fat fingers in an even fan, and the thumb: shorter, set back towards the wrist and well apart from them
    const ray = (ang: number, d0: number, d1: number, r0: number, r1: number): number[] => {
      const a = at(d0 * Math.cos(ang), d0 * Math.sin(ang));
      const b = at(d1 * Math.cos(ang), d1 * Math.sin(ang));
      return capsulePts(a[0], a[1], r * r0 + grow, b[0], b[1], r * r1 + grow, 3 * n);
    };
    for (const i of [-1, 0, 1]) out.push(ray(i * 0.6 - 0.12, 0.5, 1.1, 0.4, 0.36));
    out.push(ray(2.05, 0.3, 0.98, 0.4, 0.34));
  } else if (hand === "thumb") {
    out.push(capsulePts(H[0], H[1] - r * 0.4, r * 0.46 + grow, H[0], H[1] - r - 3.4, r * 0.38 + grow, 2 * n + 1));
  } else {
    if (hand === "point") {
      const tip = at(1 + 4.4 / r, 0);
      const root = at(0.4, 0);
      out.push(capsulePts(root[0], root[1], r * 0.4 + grow, tip[0], tip[1], r * 0.33 + grow, 2 * n + 1));
    }
    const th = thumbOf(H, vx, vy, r);
    out.push(ellipsePts(th.x, th.y, th.rx + grow, th.ry + grow, n > 1 ? 8 * n : 6, th.rot));
  }
  return out;
}

/** An arm on its joints: the tapered sleeve, its flared cuff and the mitt. `rk` scales the mitt (0.86 round a wheel);
 * `cheeks` rests a hand that is up beside the head on the head's edge (a gasp), so it never hovers next to it. */
function armNight(pen: Pen, g: Geo, P: Paint, C: Chunk, sx: number, a: number, e: number, len: number, hand: Hand, sleeve: string, skin: string, rk = 1, cheeks = false): void {
  const k = clamp(len || 1, 0.6, 1.6);
  const [ux, uy] = dir(a);
  const S: Pt = [sx, g.shoulderY];
  const E: Pt = [sx + ux * g.upper * k, g.shoulderY + uy * g.upper * k];
  let [vx, vy] = dir(a + e);
  const H: Pt = [E[0] + vx * g.fore * k, E[1] + vy * g.fore * k];
  const r = C.hand * rk;
  const n = fine(P);
  // the tubes' round ends: 3 steps at a standing character's size (a facet there is under a phone pixel), more up close
  const ts = n > 1 ? 4 * n : 3;
  if (cheeks) {
    // the head's half width at the hand's height (the head upright): the hand's centre comes in to just outside it
    const v = (H[1] - g.headY) / g.headRY;
    if (Math.abs(v) < 0.92) {
      const f = headForm(g);
      const edge = g.headRX * (1 + f.taper * v) * Math.pow(1 - Math.pow(Math.abs(v), f.n), 1 / f.n);
      const lim = edge + r * 0.35;
      if (Math.abs(H[0]) > lim) {
        H[0] = Math.sign(H[0]) * Math.max(lim, Math.abs(H[0]) - 4.5);
        const d = Math.hypot(H[0] - E[0], H[1] - E[1]) || 1;
        vx = (H[0] - E[0]) / d;
        vy = (H[1] - E[1]) / d;
      }
    }
  }
  // the sleeve ends in a ribbed cuff at the wrist, a little wider than the wrist, its end inside the mitt
  const W: Pt = [H[0] - vx * r * 0.6, H[1] - vy * r * 0.6];
  const cuff = (grow: number): number[] => bandPts(W[0] - vx * 1.6, W[1] - vy * 1.6, vx, vy, 2.9 + grow * 2, C.arm[2] + 2.3 + grow * 2, n > 1 ? 1 + grow : 0);
  pen.poly(joinShapes([...tube(S, E, W, C.arm, P.ow, ts), cuff(P.ow), ...mittShapes(H, vx, vy, r, hand, P.ow, n)]), P.O);
  pen.poly(joinShapes(tube(S, E, W, C.arm, 0, ts)), sleeve);
  celLine(pen, [S[0], S[1], E[0], E[1], W[0], W[1]], C.arm[2], cel(sleeve), P.mx);
  pen.poly(cuff(0), lift(sleeve, 0.24));
  pen.poly(joinShapes(mittShapes(H, vx, vy, r, hand, 0, n)), skin);
  // the mitt's lower back in shadow: one crescent along its edge
  const sa = Math.atan2(0.8, -0.6 * P.mx) / DEG;
  pen.poly(streak(arcPts(H[0], H[1], r * 0.7, r * 0.7, sa - 78, sa + 78, 4 * n), r * 0.62), cel(skin, 0.14));
  if (hand === "fist" || hand === "point") {
    // a short ink arc where the thumb lies over the mitt
    const th = thumbOf(H, vx, vy, r);
    pen.line(placePts(arcPts(0, 0, th.rx, th.ry, 12, 168, 5 * n), th.x, th.y, th.rot), P.ow * 1.3, P.O, 0.85);
  }
}

/** A shoe's sole and toe cap: pale rubber in the place's light, or a darker gum sole under a pale shoe (so a white
 * shoe still has a sole). */
function soleOf(P: Paint): string {
  return luminance(P.accent) > 0.5 ? lit(ND.soleGum) : lit(ND.sole);
}

/** The chunky shoe, side on, in its own frame: the foot joint at the origin, the toe towards +x, the ground 3.5
 * below (× q). `all` is the whole shoe (drawn in the sole's rubber), `upper` the part in the shoe's colour (above the
 * thick sole, behind the rounded toe cap), `heel` its back third (the cel shadow) and `gloss` a streak on the instep. */
interface Shoe {
  all: number[];
  upper: number[];
  heel: number[];
  gloss: number[];
}

const SHOE = [-4.9, 3.5, -5.9, 1.1, -5.5, -2.6, -3.4, -5.4, 0.8, -5.6, 3.9, -4.3, 6.6, -3.2, 9, -2.2, 10.2, 0.4, 9.6, 2.8, 8.2, 3.5] as const;
const SHOES = new Map<string, Shoe>();

function shoeOf(q: number, n: number): Shoe {
  const key = `${q.toFixed(3)} ${n}`;
  const hit = SHOES.get(key);
  if (hit) return hit;
  const all = smoothPts(SHOE.map((v) => v * q), true, 2 * n, [0, 10]);
  const overSole = clipConvex(all, [-30 * q, -30 * q, 30 * q, -30 * q, 30 * q, 1.1 * q, -30 * q, 1.1 * q]);
  const upper = clipConvex(overSole, halfPlane(7.1 * q, -4 * q, 7.8 * q, 1.2 * q, -5 * q, 0));
  const heel = clipConvex(upper, lensClip(-1.2 * q, -9 * q, -3.4 * q, 4 * q, -30 * q, -2 * q, 1.1 * q, 32));
  const gloss = ribbonPts([1.9 * q, -3.85 * q, 4.1 * q, -2.95 * q, 6.1 * q, -2.15 * q], [0.45 * q, 1.15 * q, 0.45 * q], 1);
  const shoe = { all, upper, heel, gloss };
  SHOES.set(key, shoe);
  return shoe;
}

function legNight(pen: Pen, g: Geo, P: Paint, C: Chunk, hip: Pt, knee: Pt, foot: Pt, shinAngle: number, pants: string, shoe: string, sole: string, front: boolean): void {
  const [vx, vy] = dir(shinAngle);
  const q = C.shoe;
  const n = fine(P);
  const ts = n > 1 ? 4 * n : 3;
  // the trouser leg ends at the ankle, inside the shoe's collar; its turned-up hem lies over the shoe's top
  const A: Pt = [foot[0] - vx * 3 * q, foot[1] - vy * 3 * q];
  const S = shoeOf(q, n);
  const rot = clamp(-shinAngle * 0.6, -60, 60);
  const put = (pts: number[]): number[] => placePts(pts, foot[0], foot[1], rot);
  const hem = (grow: number): number[] => bandPts(A[0] - vx * 1.7 * q, A[1] - vy * 1.7 * q, vx, vy, 3 * q + grow * 2, C.leg[2] + 2.4 + grow * 2, n > 1 ? 1 + grow : 0);
  pen.poly(joinShapes([...tube(hip, knee, A, C.leg, P.ow, ts), put(inflate(S.all, P.ow)), hem(P.ow)]), P.O);
  pen.poly(joinShapes(tube(hip, knee, A, C.leg, 0, ts)), pants);
  celLine(pen, [hip[0], hip[1], knee[0], knee[1], A[0], A[1]], C.leg[2], cel(pants), P.mx);
  // the back leg's outer edge catches the lamps, so dark trousers still end somewhere on a dark road
  if (!front) rimLimb(pen, P, [knee[0] - (knee[0] - hip[0]) * 0.45, knee[1] - (knee[1] - hip[1]) * 0.45, knee[0], knee[1], A[0], A[1]], [C.leg[0] * 0.55 + C.leg[1] * 0.45, C.leg[1], C.leg[2]]);
  pen.poly(put(S.all), sole);
  pen.poly(put(S.upper), shoe);
  pen.poly(put(S.heel), ND.celDark, 0.2);
  pen.poly(hem(0), lift(pants, 0.14));
  if (front) pen.poly(put(S.gloss), lift(shoe, 0.45));
}

/** A convex clip that keeps what is above a line across the body at `y` that sags `sag` in the middle (a hem that
 * wraps round a rounded body): `w` each side of the middle. */
function aboveSag(y: number, sag: number, w: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const x = -w + (2 * w * i) / 8;
    pts.push(x, y + sag * (1 - (x / w) ** 2));
  }
  pts.push(w, y - 400, -w, y - 400);
  return pts;
}

/** The point of the chunky torso's outline at `deg` (0 the front at the waistline, 90 the bottom, 270 the top), `inset`
 * in from it: geometry()'s superellipse below its middle; above it a squarer one that hardly narrows, so the jumper
 * has rounded-box shoulders beside the head instead of a dome under it. */
function torsoAt(g: Geo, deg: number, inset = 0): Pt {
  const c = Math.cos(deg * DEG);
  const sn = Math.sin(deg * DEG);
  const up = sn < 0;
  const n = up ? g.n + 1.5 : g.n;
  const y = (g.b - inset) * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
  const x = (g.a - inset) * (1 + ((up ? g.taper * 0.3 : g.taper) * y) / g.b) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
  return [x, g.cy + y];
}

function torsoNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint): void {
  const n = fine(P);
  const pts: number[] = [];
  for (let i = 0; i < 26 * n; i += 1) pts.push(...torsoAt(g, (360 * i) / (26 * n)));
  pen.poly(inflate(pts, P.ow), P.O);
  pen.poly(pts, P.bottom);
  const topY = g.cy - g.b;
  const chinY = g.headY + g.headRY;
  // the jumper down to the waist, its last 2.2 units a ribbed hem band (the cuffs' tone) that wraps round the body
  const hemH = 2.2;
  const wide = g.a * 1.4;
  const trim = lift(P.top, 0.24);
  const jumper = clipConvex(pts, aboveSag(g.waistY, 1.3, wide));
  const body = clipConvex(pts, aboveSag(g.waistY - hemH, 1.3, wide));
  pen.poly(jumper, trim);
  pen.poly(body, P.top);
  // what shows of the jumper: from under the collar to the hem
  const y0 = chinY + 0.8;
  const y1 = g.waistY - hemH;
  const span = y1 - y0;
  if (look.outfit.pattern === "stripes") {
    // two or three bold stripes, one shape
    const count = span > 11 ? 3 : 2;
    const h = (span / (count * 2 + 0.6)) * 1.1;
    const bands: number[][] = [];
    for (let k = 0; k < count; k += 1) {
      const ys = y0 + (span * (k + 0.38)) / count;
      bands.push(clipConvex([-g.a * 2, ys, g.a * 2, ys, g.a * 2, ys + h, -g.a * 2, ys + h], body));
    }
    pen.poly(joinShapes(bands), P.accent, 0.92);
  } else if (look.outfit.pattern === "dots") {
    // five fat dots, one shape
    const spots: [number, number][] = [
      [-0.5, 0.2],
      [0.38, 0.12],
      [-0.02, 0.5],
      [-0.58, 0.82],
      [0.56, 0.74],
    ];
    const r = clamp(span * 0.13, 1.5, 2.4);
    pen.poly(joinShapes(spots.map(([fx, fy]) => ellipsePts(fx * halfWidth(g, y0 + span * fy) * 0.9, y0 + span * fy, r, r, 8 * n))), P.accent, 0.95);
  }
  // (a plain jumper stays plain: the little of it that shows between the collar and the hem reads as one clean shape)
  // the thick roll collar the head sits in: a filled ring in the trim's lit tone, tucked under the chin so only its
  // front half shows
  const cw = Math.min(g.a * 0.6, g.headRX * 0.4);
  pen.ellipse(0, chinY + 0.3, cw + P.ow, 4.3 + P.ow, 0, P.O);
  pen.ellipse(0, chinY + 0.3, cw, 4.3, 0, trim);
  // the chin's shadow on the collar
  pen.ellipse(0, chinY + 0.5, cw * 0.86, 1.5, 0, cel(trim, 0.2));
  // the cel shadow over the back third (jumper, pattern and trousers alike)
  const back = lensClip(-g.a * 0.3 * P.mx, topY - 2, -g.a * 0.42 * P.mx, g.cy + g.b + 2, -g.a * 3 * P.mx, g.cy, g.b * 0.16);
  pen.poly(clipConvex(pts, back), ND.celDark, 0.22);
  // the rim light down the back edge of the jumper
  const arc: number[] = [];
  for (let i = 0; i <= 6; i += 1) {
    const p = torsoAt(g, 164 + (36 * i) / 6, P.ow * 0.6);
    arc.push((p[0] - 0) * P.mx, p[1]);
  }
  pen.line(arc, P.ow, P.rim, P.rimA);
}

/** A chunky scarf: a fat band round the collar and one end hanging down the front, swaying. */
function scarfNight(pen: Pen, g: Geo, P: Paint, t: number): void {
  const y = g.headY + g.headRY + 1.6;
  const w = Math.min(halfWidth(g, y + 2) - 0.5, g.headRX * 0.56);
  const sway = Math.sin(t * 3.2) * 1.5;
  const band = (grow: number): number[] => capsulePts(-w, y, 3.1 + grow, w, y, 3.1 + grow, 5);
  const tail = (grow: number): number[] => capsulePts(w * 0.5, y + 2, 2.9 + grow, w * 0.5 + 0.8 + sway, y + 12.5, 3.2 + grow, 4);
  pen.poly(joinShapes([band(P.ow), tail(P.ow)]), P.O);
  pen.poly(tail(0), cel(P.accent, 0.16));
  pen.poly(band(0), P.accent);
  pen.line([-w * 0.9, y + 1.4, w * 0.9, y + 1.4], P.ow, cel(P.accent, 0.3), 0.6);
}

/** A chunky bow tie on the collar: two rounded wings (one shape) and the knot. */
function bowtieNight(pen: Pen, g: Geo, P: Paint): void {
  const y = g.headY + g.headRY + 3.6;
  const wing = (s: number, grow: number): number[] => capsulePts(s * 1.2, y, 1.5 + grow, s * 6.6, y, 3.5 + grow, 5);
  pen.poly(joinShapes([wing(-1, P.ow), wing(1, P.ow)]), P.O);
  pen.poly(joinShapes([wing(-1, 0), wing(1, 0)]), P.accent);
  pen.circle(0, y, 2.3, cel(P.accent, 0.24));
}

function wheelNight(pen: Pen, g: Geo, pose: Pose, P: Paint): void {
  const k = smoothstep(0, 0.6, pose.wheel);
  const cx = g.shoulderX + 7;
  const cy = g.shoulderY + 9;
  const r = 8.5;
  // drawn a tenth bigger than the grips' circle, with a lit upper arc, so a clear ring shows either side of the hands
  const ring = arcPts(cx, cy, r * 1.1, r * 0.99, 0, 360, 18);
  pen.line(ring, 2.8 + P.ow * 2, P.O, k);
  pen.line(ring, 2.8, ND.wheelLit, k);
  pen.line(arcPts(cx, cy, r * 1.1 + 0.5, r * 0.99 + 0.5, 195, 345, 8), 1, lift(ND.wheelLit, 0.3), k);
  // the three spokes are one stroke out and back from the hub
  const sp = pose.wheelRot * DEG;
  const spokes: number[] = [];
  for (const off of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) spokes.push(cx, cy, cx + Math.sin(sp + off) * r * 0.9, cy - Math.cos(sp + off) * r * 0.8);
  spokes.push(cx, cy);
  pen.line(spokes, 1.9, ND.wheel, k);
  pen.circle(cx, cy, 2.3, ND.wheelHub, k);
}

// ---- the head ------------------------------------------------------------------------------------------------------

/** The head's rounded square ("gumdrop"): a superellipse inside the head's radii, flatter on top and at the sides than
 * an ellipse, its jaw a little wider than its crown. The square body's head is squarer still. */
function headForm(g: Geo): { n: number; taper: number } {
  return { n: g.headN > 2.2 ? 3.7 : 2.75, taper: 0.045 };
}

/** The head's points (k times the usual points, `fine`). */
function headPts(g: Geo, k = 1): number[] {
  const f = headForm(g);
  return superellipse(0, 0, g.headRX, g.headRY, f.n, f.taper, 36 * k);
}

/** The point of the head's outline at `deg` (its superellipse's own angle: 180 the back of the head at -x, 270 the
 * crown, 360 the front), `out` units further from the head's centre. Hair, hats and the rim light are built on it, so
 * they fit every head shape. */
function skull(g: Geo, deg: number, out = 0): Pt {
  const f = headForm(g);
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const y = g.headRY * Math.sign(s) * Math.pow(Math.abs(s), 2 / f.n);
  const x = g.headRX * (1 + (f.taper * y) / g.headRY) * Math.sign(c) * Math.pow(Math.abs(c), 2 / f.n);
  const k = 1 + out / (Math.hypot(x, y) || 1);
  return [x * k, y * k];
}

/** A smooth curve through a table of [angle, value] rows, flat before the first and after the last: how far a hairdo
 * stands off the head round its top. */
function profile(rows: readonly (readonly [number, number])[]): (deg: number) => number {
  const n = rows.length;
  const slope = (i: number): number => {
    const a = rows[Math.max(0, i - 1)]!;
    const b = rows[Math.min(n - 1, i + 1)]!;
    return (b[1] - a[1]) / (b[0] - a[0] || 1);
  };
  return (deg) => {
    if (deg <= rows[0]![0]) return rows[0]![1];
    if (deg >= rows[n - 1]![0]) return rows[n - 1]![1];
    let i = 0;
    while (i < n - 2 && deg > rows[i + 1]![0]) i += 1;
    const [x0, y0] = rows[i]!;
    const [x1, y1] = rows[i + 1]!;
    const h = x1 - x0;
    const t = (deg - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * slope(i) + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * slope(i + 1);
  };
}

/** The edge that stands `out(deg) - inset` off the head, from `from` to `to` degrees, a point every `step` degrees. */
function crest(g: Geo, out: (deg: number) => number, from: number, to: number, step: number, inset = 0): number[] {
  const pts: number[] = [];
  const n = Math.max(1, Math.round(Math.abs(to - from) / step));
  for (let i = 0; i <= n; i += 1) {
    const d = from + ((to - from) * i) / n;
    const p = skull(g, d, out(d) - inset);
    pts.push(p[0], p[1]);
  }
  return pts;
}

/** A stroke that is `w` wide in its middle and comes to a soft point at both ends (a glossy streak), along `c`. */
function streak(c: number[], w: number): number[] {
  const n = c.length >> 1;
  const widths: number[] = [];
  for (let i = 0; i < n; i += 1) widths.push(w * (0.16 + 0.84 * Math.max(0, Math.sin((Math.PI * i) / (n - 1))) ** 0.8));
  return ribbonPts(c, widths, 1);
}

function headShapeNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, farEar = 0): void {
  const rx = g.headRX;
  const ry = g.headRY;
  const earsHidden = look.hair.style === "long" || look.accessory === "headphones" || look.accessory === "helmet";
  const n = fine(P);
  if (!earsHidden) {
    // small round ears, low on the head, each with a darker hollow (plain ellipses: they cost the drawers least)
    const ey = ry * 0.22;
    for (const s of [-1, 1]) {
      if (s === farEar) continue;
      pen.ellipse(s * rx * 0.985, ey, 4.1 + P.ow, 4.4 + P.ow, 0, P.O);
      pen.ellipse(s * rx * 0.985, ey, 4.1, 4.4, 0, mix(P.skin, cel(P.skin), 0.3));
      pen.ellipse(s * (rx * 0.985 + 1), ey + 0.3, 1.7, 2.3, 0, cel(P.skin, 0.36));
    }
  }
  const pts = headPts(g, n);
  pen.poly(inflate(pts, P.ow), P.O);
  pen.poly(pts, P.skin);
  // the cel shadow on the lower back of the head, away from the key light: it stops well short of the near eye
  const m = P.mx;
  const a = skull(g, 186);
  const b = skull(g, 126);
  pen.poly(clipConvex(pts, lensClip(a[0] * m, a[1], b[0] * m, b[1], -rx * m, ry, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.04, 40 * n)), cel(P.skin));
}

/** What sits on top of a head, for what comes after it: how far its top edge stands off the skull at each angle (the
 * rim light runs along it, the headphones' band goes over it), or the rim light's own path when the edge is not that
 * simple (spikes, a bun). Both in the hairdo's own frame, before `hs` mirrors it. */
interface Top {
  out: (deg: number) => number;
  rim?: (lamps: number, inset: number) => number[];
}

const BARE: Top = { out: () => 0 };

/** The quiff's height off the head: low at the back, rising to its peak over the front of the crown, then down the
 * front temple to a short sideburn. */
const QUIFF = [[190, 1.2], [208, 1.8], [232, 2.3], [252, 2.6], [268, 3.4], [284, 4.6], [300, 5.3], [316, 5.1], [330, 4.4], [340, 3.4], [348, 1.6]] as const;
/** Long hair's cap and a bun's: close to the head, a little fuller on top. */
const SLEEK = [[186, 3], [220, 4.2], [250, 5], [280, 5.4], [310, 4.8], [340, 3.6], [354, 2.6]] as const;
const TIDY = [[186, 1.2], [215, 1.9], [250, 2.4], [285, 2.6], [320, 2.2], [345, 1.5], [354, 1]] as const;
/** Spiky hair's valleys and tips: five big spikes that lean forward. */
const SPIKES = [[188, 1.4], [203, 7], [219, 2], [243, 9.2], [259, 2.6], [281, 10.4], [297, 2.8], [318, 9], [333, 2.4], [347, 5.2], [356, 0.6]] as const;
/** The cap's dome. */
const DOME = [[188, 2.6], [230, 3.2], [270, 3.6], [310, 3.4], [352, 2.8]] as const;

/** The hair, in the head's frame: one bold sculpted mass per style (its outline one closed line under it), a darker
 * plane, and a glossy streak on the side the key light comes from. Under a helmet every style lies flat. Returns what
 * the rim light and the headphones need to know about its top. */
function hairNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, hs: 1 | -1): Top {
  const style = look.hair.style;
  const rx = g.headRX;
  const ry = g.headRY;
  const n = fine(P);
  const flat = look.accessory === "helmet";
  // under a headphone band tall hair (spikes, curls) is pressed lower, so the band sits on it
  const pressed = look.accessory === "headphones";
  // the lamps' side in the hairdo's own frame: 1 when they light its back (-x), the usual
  const lamps = P.mx * hs;
  const put = (pts: number[]): number[] => (hs < 0 ? pts.map((v, i) => (i % 2 === 0 ? -v : v)) : pts);
  const at = (fx: number, fy: number): Pt => [fx * rx, fy * ry];
  const outline = (pts: number[]): void => pen.line(put([...pts, pts[0]!, pts[1]!]), P.ow * 2, P.O);
  // a glossy streak along the top edge on the key light's side, `inset` in from it
  const shine = (out: (deg: number) => number, a0: number, a1: number, inset: number, w: number): number[] => streak(crest(g, out, lamps > 0 ? a0 : 540 - a0, lamps > 0 ? a1 : 540 - a1, 10 / n, inset), w);
  if (style === "none") {
    // a bare head: a glossy streak on the top of the head
    if (!flat) pen.poly(put(shine(BARE.out, 286, 322, 3.4, 2.6)), lift(P.skin, 0.16));
    return BARE;
  }
  const c = P.hair;
  // two planes (the picked colour, and a darker one behind it) and a glossy streak in the hair's own hue
  const under = cel(c, luminance(c) < 0.1 ? 0.36 : 0.27);
  const gloss = glossOf(c);
  // the plane on the lamps' side of a hairdo that has none of its own: its back third
  const backThird = (pts: number[]): number[] => clipConvex(pts, lensClip(-rx * 0.2 * lamps, -ry * 1.5, -rx * 0.46 * lamps, ry, -rx * 4 * lamps, 0, ry * 0.2, 48 * n));

  if (style === "short") {
    // a kid's quiff: one mass that rises over the front of the crown, a fringe of three big uneven tufts across the
    // forehead (the deepest notch is the side parting), a short rounded sideburn each side that ends at brow height,
    // and one loose cowlick at the crown
    const out = profile(flat ? QUIFF.map(([d, v]) => [d, Math.min(v, 2.3)] as const) : QUIFF);
    const k = 2 * n;
    const d0 = 194;
    const d1 = 345;
    const step = n > 1 ? 7 / n : 10;
    // (no cowlick: the quiff's own peak is the one lift on top, so the silhouette has no stray tuft)
    const flick: number[] = [];
    const rear = crest(g, out, d0, 266, step);
    const fore = crest(g, out, 266, d1, step);
    const top = [...rear, ...flick.slice(2, -2), ...fore];
    // the hairline from the front temple round to the back one, in three runs: the front sideburn, the two big tufts,
    // and the small tuft behind the parting with the back sideburn
    const burnF = smoothPts([...skull(g, d1, out(d1)), ...at(0.985, -0.3), ...at(0.9, -0.36), ...at(0.8, -0.5), ...at(0.73, -0.67)], false, k);
    const tufts = smoothPts([...at(0.73, -0.67), ...at(0.58, -0.53), ...at(0.4, -0.48), ...at(0.2, -0.56), ...at(0.12, -0.7), ...at(0, -0.52), ...at(-0.2, -0.46), ...at(-0.38, -0.56), ...at(-0.44, -0.76)], false, k, [4]);
    const burnB = smoothPts([...at(-0.44, -0.76), ...at(-0.55, -0.56), ...at(-0.7, -0.5), ...at(-0.82, -0.54), ...at(-0.9, -0.4), ...at(-0.975, -0.3), ...skull(g, d0, out(d0))], false, k, [3]);
    const line = [...burnF, ...tufts.slice(2), ...burnB.slice(2)];
    const pts = [...top, ...line.slice(2, -2)];
    // the hair's soft shadow on the forehead, under the fringe
    pen.line(put(tufts.map((v, i) => (i % 2 === 0 ? v : v + 1.1))), 2.6, cel(P.skin, 0.17));
    outline(pts);
    pen.poly(put(pts), c);
    // the darker plane: the side hair behind the parting (up to the cowlick), and the sideburn under the quiff's front
    const cut = rear.length + Math.max(0, flick.length - 4);
    const sweep = smoothPts([top[cut]!, top[cut + 1]!, ...at(-0.5, -1.0), ...at(-0.42, -0.88), ...at(-0.44, -0.76)], false, k);
    const side = [...burnB, ...top.slice(0, cut + 2), ...sweep.slice(2, -2)];
    const f0 = Math.round((fore.length / 2) * 0.86) * 2;
    const front = [...fore.slice(f0), ...burnF.slice(2)];
    pen.poly(joinShapes([put(side), put(front)]), under);
    // one glossy streak along the quiff, and a short one on the front tuft
    if (!flat) pen.poly(joinShapes([put(shine(out, 268, 320, 2.9, 2)), put(streak([...at(0.5, -0.62), ...at(0.34, -0.6), ...at(0.2, -0.64)], 1.2))]), gloss);
    return { out };
  }

  if (style === "spiky") {
    // five big chunky spikes with straight edges, and a zigzag fringe
    const rows = flat || pressed ? SPIKES.map(([d, v]) => [d, Math.min(v, flat ? 2.2 : 4.4)] as const) : SPIKES;
    const tips = rows.map(([d, v]) => skull(g, d, v));
    const fringe = [at(0.6, -0.5), at(0.42, -0.3), at(0.16, -0.56), at(-0.02, -0.33), at(-0.3, -0.54), at(-0.5, -0.28), at(-0.74, -0.42), at(-0.95, 0.04)];
    // each spike's edges bulge a little, so it is a chunky tuft, not a thorn
    const edges: number[] = [];
    tips.forEach((p, i) => {
      edges.push(p[0], p[1]);
      const q = tips[i + 1];
      if (!q) return;
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      let nx = (q[1] - p[1]) / len;
      let ny = -(q[0] - p[0]) / len;
      if (nx * mx + ny * my < 0) {
        nx = -nx;
        ny = -ny;
      }
      edges.push(mx + nx * 0.9, my + ny * 0.9);
    });
    const even = tips.map((_, i) => i * 2);
    const pts = [...smoothPts(edges, false, 2 * n, even), ...fringe.flat()];
    outline(pts);
    pen.poly(put(pts), c);
    // each spike's face away from the key light is a darker facet (one shape), and the tallest two get a streak
    const facets: number[][] = [];
    const shines: number[][] = [];
    for (let i = 1; i < tips.length - 1; i += 2) {
      const tip = tips[i]!;
      const dark = tips[lamps > 0 ? i - 1 : i + 1]!;
      const lit0 = tips[lamps > 0 ? i + 1 : i - 1]!;
      const root = skull(g, rows[i]![0], -2.6);
      facets.push([dark[0], dark[1], tip[0], tip[1], root[0], root[1]]);
      if (!flat && (i === 3 || i === 5)) {
        const on = (k: number): Pt => [tip[0] + (lit0[0] - tip[0]) * k + (root[0] - tip[0]) * 0.2, tip[1] + (lit0[1] - tip[1]) * k + (root[1] - tip[1]) * 0.2];
        shines.push(put(streak([...on(0.16), ...on(0.42), ...on(0.7)], 1.5)));
      }
    }
    pen.poly(joinShapes(facets.map(put)), under);
    pen.poly(joinShapes(shines), gloss);
    // the rim light runs up the back edge of the spikes on the lamps' side
    const rim = (side: number, inset: number): number[] => {
      const edge = side > 0 ? tips.slice(0, 6) : tips.slice(5).reverse();
      return edge.flatMap((p) => {
        const k = 1 - inset / (Math.hypot(p[0], p[1]) || 1);
        return [p[0] * k, p[1] * k];
      });
    };
    return { out: profile(rows), rim };
  }

  if (style === "curly") {
    // a cloud of big round curls of mixed sizes (never a matching pair on top): seven round the top of the head, a
    // small one over each ear, and five across the forehead; their outer arcs are one round outline
    const low = flat ? 0 : pressed ? 0.45 : 1;
    const top7: readonly (readonly [number, number, number])[] = [[186, 0.4, 5], [212, 1, 6.4], [240, 1.6, 8.4], [268, 1, 6.8], [298, 2, 8.8], [328, 1.2, 6.6], [354, 0.4, 5]];
    const rings: [number, number, number][] = top7.map(([d, o, r], i) => {
      const small = i === 0 || i === 6;
      const p = skull(g, d, small ? o : o * low);
      return [p[0], p[1], small ? (flat ? 3.8 : r) : 4.2 + (r - 4.2) * low];
    });
    const top = rings.length;
    for (const [fx, fy, r] of [[0.78, -0.44, 4.6], [0.42, -0.68, 5.8], [-0.04, -0.74, 6.2], [-0.48, -0.66, 5.4], [-0.8, -0.42, 4.4]] as const) rings.push([fx * rx, fy * ry, r]);
    const count = rings.length;
    // where a curl's arc meets the next one's: their crossing on the outside (the far side from the head's centre for
    // the top curls, the near side for the fringe), or the points that face each other when they do not touch
    const meet = (i: number): [Pt, Pt] => {
      const a = rings[i]!;
      const b = rings[(i + 1) % count]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const d = Math.hypot(dx, dy) || 1;
      if (d >= a[2] + b[2]) return [[a[0] + (dx / d) * a[2], a[1] + (dy / d) * a[2]], [b[0] - (dx / d) * b[2], b[1] - (dy / d) * b[2]]];
      const along = (a[2] * a[2] - b[2] * b[2] + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, a[2] * a[2] - along * along));
      const px = a[0] + (dx / d) * along;
      const py = a[1] + (dy / d) * along;
      const c1: Pt = [px - (dy / d) * h, py + (dx / d) * h];
      const c2: Pt = [px + (dy / d) * h, py - (dx / d) * h];
      const far = Math.hypot(c1[0], c1[1]) > Math.hypot(c2[0], c2[1]);
      const outer = i < top - 1 === far ? c1 : c2;
      return [outer, outer];
    };
    const joins = rings.map((_, i) => meet(i));
    const arc = (i: number, shrink = 0): number[] => {
      const o = rings[i]!;
      const from = joins[(i + count - 1) % count]![1];
      const to = joins[i]![0];
      const a0 = Math.atan2(from[1] - o[1], from[0] - o[0]) / DEG;
      let a1 = Math.atan2(to[1] - o[1], to[0] - o[0]) / DEG;
      while (a1 <= a0) a1 += 360;
      // a point every 22 degrees or so: a round curl, not a faceted one
      return arcPts(o[0], o[1], o[2] - shrink, o[2] - shrink, a0, a1, Math.max(3, Math.round(((a1 - a0) / 22) * n)));
    };
    const pts = rings.flatMap((_, i) => arc(i));
    outline(pts);
    pen.poly(put(pts), c);
    // the back third a plane darker, and a fat glossy crescent on each of the three biggest curls the key light reaches
    pen.poly(put(backThird(pts)), under);
    const lit3 = lamps > 0 ? [2, 4, 5] : [4, 2, 1];
    if (!flat) pen.poly(joinShapes(lit3.map((i) => put(streak(arcPts(rings[i]![0], rings[i]![1], rings[i]![2] - 2.6, rings[i]![2] - 2.6, lamps > 0 ? 250 : 215, lamps > 0 ? 325 : 290, 5 * n), 2.1)))), gloss);
    // the rim light runs along the curls' own arcs on the lamps' side
    const rim = (side: number, inset: number): number[] => (side > 0 ? [1, 2, 3] : [3, 4, 5]).flatMap((i) => arc(i, inset));
    return { out: () => (flat ? 4 : pressed ? 7.2 : 10.4), rim };
  }

  if (style === "long") {
    // long hair: one heavy mass, wider than the skull: a full cap, a fringe of three big scallops, and a fat solid lock
    // down each side of the face that ends in a round tip (the heavy back is drawn behind)
    const out = profile(SLEEK);
    const top = crest(g, out, 186, 354, 6 / n);
    const rest = smoothPts(
      [...skull(g, 354, out(354)), ...at(1.1, 0.1), ...at(1.19, 0.5), ...at(1.15, 0.93), ...at(1.0, 1.04), ...at(0.92, 0.82), ...at(0.92, 0.3), ...at(0.88, -0.1), ...at(0.8, -0.34), ...at(0.55, -0.42), ...at(0.28, -0.68), ...at(0.02, -0.44), ...at(-0.26, -0.66), ...at(-0.54, -0.42), ...at(-0.8, -0.34), ...at(-0.88, -0.1), ...at(-0.92, 0.3), ...at(-0.92, 0.82), ...at(-1.0, 1.04), ...at(-1.15, 0.93), ...at(-1.19, 0.5), ...at(-1.1, 0.1)],
      false,
      2 * n,
    );
    const pts = [...top, ...rest.slice(2)];
    outline(pts);
    pen.poly(put(pts), c);
    // the lamps' third a plane darker, one gloss streak along the crown and one down the key side's lock
    pen.poly(put(backThird(pts)), under);
    const sd = lamps > 0 ? 1 : -1;
    pen.poly(joinShapes([put(shine(out, 268, 326, 1.8, 1.9)), put(streak(smoothPts([sd * rx * 1.05, ry * 0.22, sd * rx * 1.1, ry * 0.52, sd * rx * 1.06, ry * 0.8], false, 3), 2))]), gloss);
    return { out };
  }

  if (style === "bun") {
    // a tidy cap with a middle parting, and a big bun high on the back of the head
    const out = profile(TIDY);
    const top = crest(g, out, 186, 354, 6 / n);
    const rest = smoothPts([...skull(g, 354, out(354)), ...at(0.95, -0.02), ...at(0.84, -0.2), ...at(0.62, -0.44), ...at(0.3, -0.56), ...at(0.06, -0.66), ...at(-0.22, -0.56), ...at(-0.56, -0.42), ...at(-0.82, -0.18), ...at(-0.955, 0.03)], false, 3 * n, [1, 5]);
    const pts = [...top, ...rest.slice(2)];
    const B = skull(g, 256, 5.4);
    const br = 8.2;
    if (!flat) {
      pen.circle(hs * B[0], B[1], br + P.ow, P.O);
      pen.circle(hs * B[0], B[1], br, c);
    }
    outline(pts);
    pen.poly(put(pts), c);
    const shade = [put(backThird(pts))];
    const shines = [put(shine(out, 274, 326, 1.4, 1.6))];
    if (!flat) {
      // the bun's shadow side, its band in the outfit's accent and its own small shine
      const disc = ellipsePts(B[0], B[1], br, br, 16 * n);
      shade.push(put(clipConvex(disc, lensClip(B[0] - 2 * lamps, B[1] - br, B[0] - 5 * lamps, B[1] + br, B[0] - 40 * lamps, B[1], 1.6, 32))));
      shines.push(put(streak(arcPts(B[0], B[1], br - 2.6, br - 2.6, lamps > 0 ? 285 : 255, lamps > 0 ? 330 : 210, 4 * n), 1.4)));
    }
    pen.poly(joinShapes(shade), under);
    if (!flat) {
      const root = skull(g, 256, out(256) + 0.4);
      pen.ellipse(hs * root[0], root[1], 4.6, 1.9, hs * -12, P.accent);
    }
    pen.poly(joinShapes(shines), gloss);
    const rim = (side: number, inset: number): number[] => {
      if (flat) return crest(g, out, side > 0 ? 198 : 342, side > 0 ? 272 : 268, 6 / n, inset);
      // up the cap to the bun, then round the bun's own edge on the lamps' side
      return side > 0 ? [...crest(g, out, 198, 226, 7 / n, inset), ...arcPts(B[0], B[1], br - inset, br - inset, 168, 262, 6 * n)] : [...arcPts(B[0], B[1], br - inset, br - inset, 278, 372, 6 * n), ...crest(g, out, 300, 342, 7 / n, inset)];
    };
    return { out, rim };
  }

  // a cap in the outfit's accent: a chunky dome with a button on top and a thick rounded brim to the front, the hair
  // showing as a tuft in front of each ear
  const out = profile(DOME);
  const tuft = (s: number, grow: number): number[] => ellipsePts(s * rx * 0.93, -ry * 0.08, 3 + grow, 5.4 + grow, 10 * n);
  pen.poly(joinShapes([put(tuft(-1, P.ow)), put(tuft(1, P.ow))]), P.O);
  pen.poly(joinShapes([put(tuft(-1, 0)), put(tuft(1, 0))]), c);
  const top = crest(g, out, 188, 352, 6 / n);
  // the dome's lower edge wraps round the forehead
  const edge = quadPts(top[top.length - 2]!, top[top.length - 1]!, 0, -ry * 0.21, top[0]!, top[1]!, 6 * n);
  const dome = [...top, ...edge.slice(2, -2)];
  const peak = skull(g, 270, out(270) + 0.7);
  const brim = (grow: number): number[] => capsulePts(rx * 0.16, -ry * 0.25 - 1.5, 2.5 + grow, rx + 7, -ry * 0.17 - 1.5, 2 + grow, 4 * n);
  const button = (grow: number): number[] => ellipsePts(peak[0], peak[1], 2.2 + grow, 1.7 + grow, 8 * n);
  const trim = cel(P.accent, 0.17);
  // (under a helmet the cap has no brim to stick out)
  pen.poly(joinShapes(flat ? [put(inflate(dome, P.ow)), put(button(P.ow))] : [put(inflate(dome, P.ow)), put(brim(P.ow)), put(button(P.ow))]), P.O);
  pen.poly(put(dome), P.accent);
  pen.poly(put(backThird(dome)), ND.celDark, 0.2);
  // the brim's shadow on the forehead, then the brim and the button (one shape)
  if (!flat) pen.ellipse(hs * rx * 0.44, -ry * 0.1 - 1.2, rx * 0.5, 2.6, hs * 3, ND.ao, 0.28);
  pen.poly(joinShapes(flat ? [put(button(0))] : [put(brim(0)), put(button(0))]), trim);
  if (!flat) pen.poly(put(shine(out, 274, 328, 2.2, 1.9)), lift(P.accent, 0.42));
  return { out };
}

/** Long hair's heavy back, behind the body: one rounded bell from the crown down past the shoulders. */
function longHairBackNight(pen: Pen, g: Geo, P: Paint): void {
  const rx = g.headRX;
  const ry = g.headRY;
  const n = fine(P);
  const out = profile(SLEEK);
  const top = crest(g, (d) => out(d) - 0.5, 196, 344, 8 / n);
  // each side lock ends in a rounded curl that turns in at the shoulder
  const rest = smoothPts([top[top.length - 2]!, top[top.length - 1]!, rx * 1.17, ry * 0.3, rx * 1.24, ry * 1.02, rx * 1.1, ry * 1.5, rx * 0.8, ry * 1.6, rx * 0.56, ry * 1.4, rx * 0.3, ry * 1.34, -rx * 0.3, ry * 1.34, -rx * 0.56, ry * 1.4, -rx * 0.8, ry * 1.6, -rx * 1.1, ry * 1.5, -rx * 1.24, ry * 1.02, -rx * 1.17, ry * 0.3, top[0]!, top[1]!], false, 2 * n);
  const pts = [...top, ...rest.slice(2, -2)];
  // the hair's own lit tone (so it never melts into a dark place), the lamps' side of it a plane darker
  const c = P.hair;
  pen.line([...pts, pts[0]!, pts[1]!], P.ow * 2, P.O);
  pen.poly(pts, c);
  pen.poly(clipConvex(pts, lensClip(-rx * 0.5 * P.mx, -ry * 1.4, -rx * 0.66 * P.mx, ry * 1.8, -rx * 4 * P.mx, 0, ry * 0.2, 48 * n)), cel(c, luminance(c) < 0.1 ? 0.36 : 0.27));
  // one long glossy streak down each side lock
  const lock = (sd: number): number[] => streak(smoothPts([sd * rx * 1.1, ry * 0.36, sd * rx * 1.15, ry * 0.8, sd * rx * 1.09, ry * 1.2, sd * rx * 0.94, ry * 1.44], false, 2), 2.2);
  pen.poly(joinShapes([lock(-1), lock(1)]), glossOf(c));
}

/** A glossy streak's colour on hair of colour `c`: brighter, in the hair's own hue. */
function glossOf(c: string): string {
  const [hr, hg, hb] = channels(c);
  return lift(toHex(hr * 1.7 + 34, hg * 1.7 + 30, hb * 1.7 + 26), 0.06);
}

/** The head's accessory: glasses, a helmet or headphones (the scarf and the bow tie are on the body). Returns the top
 * of a helmet, which the rim light then runs along. */
function accessoryNight(pen: Pen, g: Geo, look: CharacterLook, P: Paint, pose: { turn: number; nod: number }, top: Top): Top | null {
  const acc = look.accessory;
  const rx = g.headRX;
  const ry = g.headRY;
  const n = fine(P);
  if (acc === "glasses") {
    // big round frames round the eyes: both rims and the bridge are one stroke, the two glints one shape
    const { ey, far, eyeX } = faceSpots(rx, ry, pose);
    const [bw, bh] = eyeSize(look.eyes.shape);
    const rim = (s: number, a0: number): number[] => arcPts(eyeX(s), ey - 0.2, (bw + 2.5) * (1 - 0.2 * far(s)), bh + 2.1, a0, a0 + 360, 20 * n);
    const left = rim(-1, 0);
    const right = rim(1, 180);
    const bridge = quadPts(left[0]!, left[1]!, (left[0]! + right[0]!) / 2, ey - 2, right[0]!, right[1]!, 4);
    pen.line([...left, ...bridge.slice(2, -2), ...right], Math.max(P.ow * 1.8, 0.8), P.O);
    const glint = (s: number): number[] => streak(arcPts(eyeX(s), ey - 0.2, (bw + 1.1) * (1 - 0.2 * far(s)), bh + 0.8, 205, 250, 4 * n), 0.9);
    pen.poly(joinShapes([glint(-1), glint(1)]), ND.glint, 0.5);
    return null;
  }
  if (acc === "helmet") {
    // a chunky dome down to the brow line, a thick band round its edge and a glossy streak
    const out = (): number => 4.2;
    const dome = crest(g, out, 187, 353, 6 / n);
    const y = dome[1]!;
    pen.poly(inflate(dome, P.ow), P.O);
    pen.poly(dome, P.accent);
    pen.poly(clipConvex(dome, lensClip(-rx * 0.2 * P.mx, -ry * 1.5, -rx * 0.5 * P.mx, ry, -rx * 4 * P.mx, 0, ry * 0.2, 48 * n)), ND.celDark, 0.2);
    const hw = 0.9 - dome[0]!;
    pen.rect(-hw, y - 2.2, hw * 2, 4.2, 2, P.O);
    pen.rect(-hw + P.ow, y - 2.2 + P.ow, (hw - P.ow) * 2, 4.2 - P.ow * 2, 1.6, cel(P.accent, 0.26));
    pen.poly(streak(crest(g, out, P.mx > 0 ? 280 : 260, P.mx > 0 ? 328 : 212, 7 / n, 2.8), 2), lift(P.accent, 0.45));
    // a strap down each side in front of the ear, so it reads as a helmet and not a beanie
    for (const sd of [-1, 1]) {
      const sx = sd * (rx * 0.9) - 1.7;
      pen.rect(sx - P.ow, y + 1.5, 3.4 + P.ow * 2, 8 + P.ow, 1.6, P.O);
      pen.rect(sx, y + 1.5, 3.4, 8, 1.4, cel(P.accent, 0.26));
    }
    return { out };
  }
  if (acc === "headphones") {
    // a thick band over whatever is on the head, and a big padded cup on each ear
    let lift0 = 2.2;
    for (let d = 210; d <= 330; d += 5) lift0 = Math.max(lift0, top.out(d) + 1);
    const band = arcPts(0, 1.5, rx + 3.6, ry + lift0 + 1.5, 192, 348, 12 * n);
    pen.line(band, 3 + P.ow * 2, P.O);
    pen.line(band, 3, cel(P.accent, 0.2));
    const cup = (s: number, grow: number): number[] => superellipse(s * (rx + 1), ry * 0.16, 5.4 + grow, 7.6 + grow, 2.8, 0, 14 * n);
    pen.poly(joinShapes([cup(-1, P.ow), cup(1, P.ow)]), P.O);
    pen.poly(joinShapes([cup(-1, 0), cup(1, 0)]), P.accent);
    pen.poly(joinShapes([-1, 1].map((s) => ellipsePts(s * (rx + 1) - P.mx * 1.3, ry * 0.16 + 0.9, 2.8, 5.2, 10 * n))), ND.celDark, 0.24);
  }
  return null;
}

/** The rim light along the top back of the head's silhouette (its hair, cap or helmet), on the lamps' side. */
function rimNight(pen: Pen, g: Geo, P: Paint, top: Top, hs: 1 | -1): void {
  // a helmet covers a mirrored hairdo too: it is the same either way round
  const side = P.mx * hs;
  const inset = P.ow * 0.6;
  const pts = top.rim ? top.rim(side, inset) : crest(g, top.out, side > 0 ? 198 : 342, side > 0 ? 272 : 268, 9 / fine(P), inset);
  pen.line(hs < 0 ? pts.map((v, i) => (i % 2 === 0 ? -v : v)) : pts, P.ow * 1.25, P.rim, Math.min(1, P.rimA * 1.15));
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
  // night drive: the chest and each upper arm a shape of their own (bustBodyNight)
  if (P.nd) bustBodyNight(pen, look, P, rx, ry, top, bottom, X);
  else {
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
    pen.poly(clipConvex(shirt, halfPlane(X(-rx * 0.52 * m), top, X(-rx * 0.74 * m), bottom, X(-rx * 3 * m), top)), shade(P.top, -0.12));
    // folds: where each upper arm meets the chest, and a crease from each armpit
    const fold = dk(P, P.top, 0.3);
    for (const s of [-1, 1]) {
      pen.line(quadPts(X(s * rx * 1.02), top + ry * 1.1, X(s * rx * 0.88), top + ry * 1.9, X(s * rx * 0.97), top + ry * 3, 6), P.thin, fold, 0.78);
      pen.line(quadPts(X(s * rx * 0.9), top + ry * 1.45, X(s * rx * 0.72), top + ry * 1.55, X(s * rx * 0.56), top + ry * 1.95, 4), P.thin, fold, 0.72);
    }
  }
  // the neckline, the chin's shadow on the shirt and the rim light along the lamp-side shoulder
  if (P.nd) {
    // night drive: the thick collar ring the head sits in
    pen.ellipse(X(0), top + ry * 0.16, rx * 0.58 + P.ow, ry * 0.34 + P.ow, 0, P.O);
    pen.ellipse(X(0), top + ry * 0.16, rx * 0.58, ry * 0.34, 0, lift(P.top, 0.24));
  } else pen.line(quadPts(X(-rx * 0.42), top + ry * 0.02, X(0), top + ry * 0.55, X(rx * 0.42), top + ry * 0.02, 8), P.ow, dk(P, P.top, 0.35));
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
  // (night drive's rim light is on the lamp side's sleeve, drawn with it)
  if (P.nd) pen.poly(clipConvex(chin, shirt), ND.ao, 0.4);
  else {
    pen.poly(clipConvex(chin, shirt), shade(P.top, -0.18));
    const rimPts = quadPts(rx * 0.5, top + P.ow, rx * 1.1, top + ry * 0.06 + P.ow, rx * 1.26, top + ry * 0.75, 6);
    pen.line(rimPts.map((v, i) => (i % 2 === 0 ? X(-m * v) : v)), P.ow, P.rim, P.rimA);
  }

  // the head, through the same parts as drawCharacter
  const headPose = { turn, lookX: pose.lookX, lookY: pose.lookY, nod: pose.nod };
  tilt(() => {
    // at three quarters the ear on the side the face turns to is hidden behind the cheek
    // ... and the hairdo turns with the head: its quiff and parting face the way the face does
    // (the dark close-up grade muddies skin: lift it a step so the face stays warm)
    if (P.nd) headNight(pen, g, look, { ...P, skin: lift(P.skin, 0.1) }, face, headPose, o.t, o.seed, q && turn <= -0.35 ? -1 : q && turn >= 0.35 ? 1 : 0, q && turn < -0.3 ? -1 : 1);
    else {
      drawHead(pen, g, look, P.skin, P.O, P.ow);
      drawHairFront(pen, g, look, P.O, P.ow);
      drawFace(pen, rx, ry, look, face, headPose, o.t, o.seed);
      drawHeadAccessory(pen, g, look, P.accent, P.O, P.ow, { ...pose, turn });
    }
  });
}

/** A quadratic Bézier's points from parameter ta to tb, `segs` steps (quadPts is the whole curve, 0 to 1). */
function quadSpan(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, ta: number, tb: number, segs: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = ta + ((tb - ta) * i) / segs;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
  return pts;
}

/** Night drive's dots on a bust: x in headRX, y in headRY below the shoulders' top, and the part they are on (-1 and 1
 * the sleeves, 0 the chest), each well inside it. */
const BUST_DOTS: readonly (readonly [number, number, -1 | 0 | 1])[] = [
  [0.5, 1.35, 0],
  [-1.13, 1.6, -1],
  [-0.55, 1.9, 0],
  [1.18, 2.3, 1],
  [0.1, 2.6, 0],
  [-0.4, 3.3, 0],
];

/** Night drive's shirt on a bust, in drawBust's rig units (X is its three-quarter squeeze): the chest and each upper arm
 * a shape of its own with its own outline all round. A sleeve starts with a round cap on the shoulder (classic's outer
 * curve) whose front edge bows in round the shoulder to the armpit; below it the sleeve hangs a little away from the
 * chest and tapers towards the elbow, so a narrow gap (the seat behind) opens between them. The outside silhouette is
 * classic's down to the elbow. The far arm (-x) is drawn before the chest, which overlaps it, the near arm after.
 * Each part carries the outfit's pattern and its cel shadow on the lamp side: the chest's back third, the sleeve's
 * outside on the lamp side and its inside on the key side, a fold darting from each sleeve's shadow at the armpit (one
 * shape with it). The key side's cap gets the lit shoulder band, the lamp side's the rim light. */
function bustBodyNight(pen: Pen, look: CharacterLook, P: Paint, rx: number, ry: number, top: number, bottom: number, X: (x: number) => number): void {
  const m = P.mx;
  const Y = (k: number) => top + ry * k;
  // (squarer, a little narrower shoulders than the classic bust, to go with the chunky head)
  const sh = [rx * 0.46, top, rx * 1.2, Y(0.0), rx * 1.27, Y(0.7)] as const;
  // the sleeve's cap: the shoulder's curve from where the cap starts, its front edge bowing in to the armpit
  const cap = quadSpan(...sh, 0.27, 1, 6);
  const pit = Y(1.25);
  const fq = [cap[0]!, cap[1]!, rx * 0.63, Y(0.78), rx * 0.9, pit] as const;
  const front = quadSpan(...fq, 0, 1, 8);
  // straight below the armpit: the sleeve's outside and inside (tapering, hanging away) and the chest's side
  const xo = (y: number) => rx * (1.27 + (0.048 * (y - Y(0.7))) / ry);
  const xi = (y: number) => rx * (0.9 + (0.092 * (y - pit)) / ry);
  const xc = (y: number) => rx * (0.9 - (0.03 * (y - pit)) / ry);
  const arm = [...cap, xo(bottom), bottom, xi(bottom), bottom];
  for (let i = front.length - 2; i >= 2; i -= 2) arm.push(front[i]!, front[i + 1]!);
  const half = [...quadSpan(...sh, 0, 0.27, 3), ...front.slice(2), xc(bottom), bottom];
  const chestRaw = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) chestRaw.push(-half[i]!, half[i + 1]!);
  const at = (s: number, pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? X(s * v) : v));
  const outline = (pts: number[]) => pen.line([...pts, pts[0]!, pts[1]!], P.ow * 2, P.O);
  const pattern = (part: -1 | 0 | 1) => {
    if (look.outfit.pattern === "stripes") {
      // the four stripes as one shape between the part's two straight sides (the steps down one side between them
      // and the way back up it cancel out)
      const a = (y: number) => (part === 0 ? X(-xc(y)) : X(part * xi(y)));
      const b = (y: number) => (part === 0 ? X(xc(y)) : X(part * xo(y)));
      const pts: number[] = [];
      for (const k of [1.35, 2.35, 3.35, 4.35]) {
        const y0 = Y(k);
        const y1 = y0 + ry * 0.36;
        pts.push(a(y0), y0, b(y0), y0, b(y1), y1, a(y1), y1);
      }
      pen.poly(pts, P.accent, 0.9);
    } else if (look.outfit.pattern === "dots") {
      for (const [fx, fy, p] of BUST_DOTS) if (p === part) pen.circle(X(fx * rx), Y(fy), rx * 0.11, P.accent, 0.95);
    }
  };

  // the lamp side's sleeve: its outside in shadow from low on the cap down, a fold darting up from it to the armpit
  const oc = quadSpan(...sh, 0.7, 1, 3);
  const W = rx * 0.13;
  const wo = (y: number) => W * clamp01((y - oc[1]!) / (Y(0.7) - oc[1]!));
  const lo = [xo(Y(1.9)) - W, Y(1.9)] as const;
  const hi = [xo(Y(1.62)) - W, Y(1.62)] as const;
  const tipO = [xi(Y(1.45)) + rx * 0.04, Y(1.45)] as const;
  const outShade = [...oc, xo(Y(1)), Y(1), xo(bottom), bottom, xo(bottom) - W, bottom];
  outShade.push(...quadPts(...lo, rx * 1.08, Y(1.7), ...tipO, 5), ...quadPts(...tipO, rx * 1.08, Y(1.64), ...hi, 5).slice(2), xo(Y(1)) - W, Y(1));
  for (let i = oc.length - 2; i >= 2; i -= 2) outShade.push(oc[i]! - wo(oc[i + 1]!), oc[i + 1]!);
  // the key side's sleeve: its inside in shadow from the cap's front edge down, a fold from the armpit across it
  const ic = quadSpan(...fq, 0.5, 1, 4);
  const W2 = rx * 0.11;
  const iw = (y: number) => W2 * clamp01((y - ic[1]!) / (pit - ic[1]!));
  const lo2 = [xi(Y(1.65)) + W2, Y(1.65)] as const;
  const hi2 = [xi(Y(1.37)) + W2, Y(1.37)] as const;
  const tipI = [rx * 1.2, Y(1.95)] as const;
  const inShade = [...ic, xi(bottom), bottom, xi(bottom) + W2, bottom];
  inShade.push(...quadPts(...lo2, rx * 1.07, Y(1.67), ...tipI, 5), ...quadPts(...tipI, rx * 1.1, Y(1.47), ...hi2, 5).slice(2));
  for (let i = ic.length - 2; i >= 2; i -= 2) inShade.push(ic[i]! + iw(ic[i + 1]!), ic[i + 1]!);
  // the lit band along the key side's cap, widening from its top and fading out down its outside
  const bc = [...cap, xo(Y(1.1)), Y(1.1)];
  const band: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i < bc.length; i += 2) {
    const x = bc[i]!;
    const y = bc[i + 1]!;
    const dx = rx * 0.85 - x;
    const dy = Y(1) - y;
    const l = Math.hypot(dx, dy) || 1;
    const w = ry * 0.24 * Math.min(1, i / 6) * (i >= bc.length - 2 ? 0.2 : 1);
    band.push(x, y);
    inner.push(x + (dx / l) * w, y + (dy / l) * w);
  }
  for (let i = inner.length - 2; i >= 0; i -= 2) band.push(inner[i]!, inner[i + 1]!);
  const rim = quadSpan(rx * 0.5, top + P.ow, rx * 1.18, Y(0.02) + P.ow, rx * 1.23, Y(0.7), 0.3, 1, 5);

  const sleeve = (s: -1 | 1) => {
    const pts = at(s, arm);
    outline(pts);
    pen.poly(pts, P.top);
    pattern(s);
    pen.poly(at(s, s === m ? inShade : outShade), ND.celDark, 0.26);
    if (s === m) pen.poly(at(s, band), lt(P, P.top, 0.08));
    else pen.line(at(s, rim), P.ow, P.rim, P.rimA);
  };
  sleeve(-1);
  const chest = at(1, chestRaw);
  outline(chest);
  pen.poly(chest, P.top);
  pattern(0);
  pen.poly(clipConvex(chest, halfPlane(X(-rx * 0.52 * m), top, X(-rx * 0.74 * m), bottom, X(-rx * 3 * m), top)), ND.celDark, 0.22);
  sleeve(1);
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
    pen.line([gx + s * 0.3 * r, gy + 1.2 * r, gx + s * 0.55 * r, gy + 2.2 * r], w * 0.98, P.nd ? lift(P.top, 0.24) : dk(P, P.top, 0.12));
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
  if (nightDrive()) {
    footNight(pen, look, angle, p, L, W);
    pen.restore();
    return;
  }
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

/** A strip along a centre line `c` (x, y pairs) of width `w` at each point: the part between the signed fractions
 * f0 and f1 of the half width (-1..1, + on the left of the line's direction), grown by `grow` on both sides. A strip
 * from -1 to 1 is the whole tube, which widens, narrows and bends with the line. */
function strip(c: number[], w: number[], f0: number, f1: number, grow = 0): number[] {
  const n = c.length / 2;
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const dx = c[i1 * 2]! - c[i0 * 2]!;
    const dy = c[i1 * 2 + 1]! - c[i0 * 2 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len;
    const ny = -dx / len;
    const h = w[i]! / 2;
    a.push(c[i * 2]! + nx * (f1 * h + grow), c[i * 2 + 1]! + ny * (f1 * h + grow));
    b.push(c[i * 2]! + nx * (f0 * h - grow), c[i * 2 + 1]! + ny * (f0 * h - grow));
  }
  for (let i = n - 1; i >= 0; i -= 1) a.push(b[i * 2]!, b[i * 2 + 1]!);
  return a;
}

/** The line at the signed fraction f of the half width along a strip's centre line (strip's sides). */
function stripLine(c: number[], w: number[], f: number): number[] {
  const s = strip(c, w, f, f);
  return s.slice(0, s.length / 2);
}

/** Night drive's foot on a pedal, in drawFoot's frame (turned `angle`, the ball of the shoe at the origin, the toe
 * towards +y): a sneaker seen from above in the outfit's accent, on the shoe's pale rubber sole (soleOf) that shows along its outer
 * side and round the toe under a lit welt, with a darker heel block at the back, a soft contact shadow under
 * it, a toe cap, a tongue and crossed laces; and the trouser leg from its cuff at the ankle up through a bent knee to
 * the thigh, which leaves the frame at the top right towards the seat, wider the nearer it comes, so the foot always
 * belongs to the driver. */
function footNight(pen: Pen, look: CharacterLook, angle: number, p: number, L0: number, W0: number): void {
  // a little bigger than classic's, so the shoe's parts read on a phone
  const L = L0 * 1.2;
  const W = W0 * 1.2;
  const unit = L / 13.2;
  const P = paintOf(pen, look, -1, (unit * pen.unit()) / (F.k || 1), unit);
  const cy0 = 0.06 * L;
  // the shoe's last: a narrow heel, widest across the ball, a rounded toe, the arch curving in on the inner side (+x)
  const last: number[] = [];
  for (let i = 0; i < 48; i += 1) {
    const t = (i / 48) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const v = Math.sign(s) * Math.abs(s) ** (2 / 2.3);
    const half = 0.5 * W * (0.8 + 0.2 * v + 0.12 * (1 - v * v));
    let lx = half * Math.sign(c) * Math.abs(c) ** (2 / 2.3);
    if (lx > 0) lx -= 0.07 * W * Math.exp(-(((v + 0.12) / 0.3) ** 2)) * Math.sqrt(Math.abs(c));
    last.push(lx, cy0 + 0.5 * L * v);
  }
  pen.save();
  pen.translate(0, 18 * p);
  pen.scale(1, 1 - 0.07 * p);
  // the sole, a dark band along the outer side and round the toe; at the back a darker heel block standing proud of
  // it, its front edge square across the band; and a lit welt where the upper meets the sole. A soft contact shadow
  // under the sole keeps the band apart from the dark floor.
  pen.glow(0.22 * W, cy0 + 0.22 * L, 0.72 * W, 0.46 * L, ND.ao, fadeStops(0.75, 1));
  const sole = inflate(last, 0.065 * W).map((v, i) => v + (i % 2 === 0 ? 0.085 * W : 0.045 * L));
  pen.poly(inflate(sole, P.ow), P.O);
  const rubber = soleOf(P);
  pen.poly(sole, rubber);
  const heel = roundRectPts(-0.2 * W, cy0 - 0.54 * L, 0.8 * W, 0.34 * L, 0.14 * W);
  pen.poly(inflate(heel, P.ow), P.O);
  pen.poly(heel, cel(rubber, 0.3));
  pen.poly(inflate(last, 0.014 * W).map((v, i) => v + (i % 2 === 0 ? 0.02 * W : 0.013 * L)), mix(rubber, P.accent, 0.42));
  // the upper, its heel counter and toe cap in a darker tone of the accent, the shade along its outer side
  pen.poly(last, P.accent);
  pen.poly(clipConvex(last, lensClip(-W, cy0 - 0.27 * L, W, cy0 - 0.27 * L, 0, -L, 0.07 * L)), dk(P, P.accent, 0.2));
  const cap = clipConvex(last, lensClip(-W, cy0 + 0.3 * L, W, cy0 + 0.3 * L, 0, L, 0.09 * L));
  pen.poly(cap, dk(P, P.accent, 0.13));
  pen.poly(clipConvex(last, lensClip(W * 0.22, -L, W * 0.28, L, W * 2, 0, W * 0.06)), ND.celDark, 0.2);
  pen.line([...last, last[0]!, last[1]!], P.ow * 0.8, P.O, 0.75);
  // the toe cap's seam, and a shine on the toe
  pen.line(arcPts(0, cy0 + 0.3 * L + 0.55 * W, 0.5 * W, 0.55 * W + 0.09 * L, 228, 312, 10), P.ow * 0.8, dk(P, P.accent, 0.4), 0.85);
  pen.ellipse(-0.14 * W, cy0 + 0.44 * L, 0.08 * W, 0.025 * L, -12, lt(P, P.accent, 0.4), 0.6);
  // the tongue, and the laces crossing over it from eyelet to eyelet
  pen.poly(superellipse(0, cy0 - 0.12 * L, 0.18 * W, 0.27 * L, 2.6, 0.1, 20), lt(P, P.accent, 0.12));
  const rows = [-0.24, -0.13, -0.02, 0.09].map((k) => cy0 + k * L);
  const laceC = mix(ND.ink, P.accent, 0.3);
  for (const s of [-1, 1]) {
    const zig: number[] = [];
    rows.forEach((ry, i) => zig.push(((i % 2 === 0 ? s : -s) * 0.2 * W), ry));
    pen.line(zig, P.ow * 1.3, laceC, 0.95);
  }
  pen.restore();

  // the trouser leg: up from the ankle (36° right of up on screen), bending at the knee towards the seat (66°)
  const dirAt = (deg: number): [number, number] => [Math.sin((deg - angle) * DEG), -Math.cos((deg - angle) * DEG)];
  const A: [number, number] = [-0.03 * W, -0.3 * L * (1 - 0.07 * p) + 18 * p];
  const sd = dirAt(36);
  const td = dirAt(66);
  const shin = 2.2 * L;
  const K: [number, number] = [A[0] + sd[0] * shin, A[1] + sd[1] * shin];
  const c: number[] = [A[0], A[1], A[0] + sd[0] * shin * 0.5, A[1] + sd[1] * shin * 0.5];
  c.push(...quadPts(K[0] - sd[0] * 0.3 * L, K[1] - sd[1] * 0.3 * L, K[0], K[1], K[0] + td[0] * 0.3 * L, K[1] + td[1] * 0.3 * L, 6));
  for (const k of [2, 9]) c.push(K[0] + td[0] * k * L, K[1] + td[1] * k * L);
  const w: number[] = [];
  let run = 0;
  for (let i = 0; i < c.length; i += 2) {
    if (i > 0) run += Math.hypot(c[i]! - c[i - 2]!, c[i + 1]! - c[i - 1]!);
    w.push(run <= shin ? W * (0.62 + 0.66 * (run / shin)) : W * (1.28 + 2.6 * clamp01((run - shin) / (9 * L))));
  }
  pen.poly(strip(c, w, -1, 1, P.ow), P.O);
  pen.poly(strip(c, w, -1, 1), P.bottom);
  pen.poly(strip(c, w, 0.4, 0.86), lt(P, P.bottom, 0.08), 0.45);
  pen.poly(strip(c, w, -1, -0.4), ND.celDark, 0.28);
  pen.line(stripLine(c, w, 0.9), P.ow, P.rim, P.rimA);
  // a crease on the inside of the knee's bend (the right of the leg as it goes up)
  const kw = 1.28 * W;
  const ns: [number, number] = [sd[1], -sd[0]];
  const nt: [number, number] = [td[1], -td[0]];
  const h = -0.25 * kw;
  const from = [K[0] - sd[0] * 0.42 * L + ns[0] * h, K[1] - sd[1] * 0.42 * L + ns[1] * h];
  const to = [K[0] + td[0] * 0.42 * L + nt[0] * h, K[1] + td[1] * 0.42 * L + nt[1] * h];
  const mid = [K[0] + (ns[0] + nt[0]) * h * 0.62, K[1] + (ns[1] + nt[1]) * h * 0.62];
  pen.line(quadPts(from[0]!, from[1]!, mid[0]!, mid[1]!, to[0]!, to[1]!, 5), P.thin * 1.6, dk(P, P.bottom, 0.4), 0.7);
  // the cuff at the ankle, a little wider, its hem rounded over the shoe, and a fold along its top
  const cl = 0.16 * L;
  const cuff = (grow: number): number[] => {
    const hw = W * 0.35 + grow;
    const top = [A[0] + sd[0] * (cl + grow), A[1] + sd[1] * (cl + grow)];
    const pts = [top[0]! + ns[0] * hw, top[1]! + ns[1] * hw];
    for (let i = 0; i <= 10; i += 1) {
      const a = (Math.PI * i) / 10;
      const across = Math.cos(a) * hw;
      const down = Math.sin(a) * (W * 0.1 + grow);
      pts.push(A[0] + ns[0] * across - sd[0] * down, A[1] + ns[1] * across - sd[1] * down);
    }
    pts.push(top[0]! - ns[0] * hw, top[1]! - ns[1] * hw);
    return pts;
  };
  pen.poly(cuff(P.ow), P.O);
  pen.poly(cuff(0), dk(P, P.bottom, 0.07));
  const fh = W * 0.33;
  const fx = A[0] + sd[0] * cl;
  const fy = A[1] + sd[1] * cl;
  pen.line([fx - ns[0] * fh, fy - ns[1] * fh, fx + ns[0] * fh, fy + ns[1] * fh], P.thin * 1.4, dk(P, P.bottom, 0.4), 0.8);
}
