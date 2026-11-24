// Lamo Stories engine: faces. Every Expression is a set of eye, brow and mouth choices plus a few extras (sweat drops,
// dizzy stars, an angry mark), so a face reads clearly on a phone. Blinks are seeded per character.

import { cel, grade, inkPx, lineUnits, ND, nightDrive } from "./art.ts";
import { F } from "./frame.ts";
import { DEG, clamp, hex, mix, rand, shade } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, clipConvex, dropPts, inflate, quadPts, starPts } from "./pen.ts";
import type { CharacterLook, Expression, NoiseId } from "./types.ts";

export type Mouth = "smile" | "grin" | "laugh" | "o" | "bigo" | "flat" | "frown" | "wavy" | "smirk" | "grit" | "pout" | "hum";
export type Eyes = "normal" | "happy" | "closed" | "spiral" | "lidded";
export type Extra = "sweat" | "sweat2" | "tear" | "stars" | "vein" | "shock" | "sparkle" | "puff";

export interface FaceParams {
  eyes: Eyes;
  /** eye openness (1 normal, up to 1.35 wide) */
  open: number;
  /** iris size (small = frightened) */
  pupil: number;
  lookX: number;
  lookY: number;
  /** inner-end tilt of the brows in degrees: + worried, - angry */
  brow: number;
  browUp: number;
  browAsym: number;
  mouth: Mouth;
  /** how open an open mouth is (0..1.3) */
  mouthOpen: number;
  blush: number;
  red: number;
  /** eyelid cover for "lidded" (0..1) */
  lid: number;
  extras: Extra[];
}

const base: FaceParams = {
  eyes: "normal",
  open: 1,
  pupil: 1,
  lookX: 0,
  lookY: 0,
  brow: 0,
  browUp: 0,
  browAsym: 0,
  mouth: "smile",
  mouthOpen: 0.7,
  blush: 0.15,
  red: 0,
  lid: 0,
  extras: [],
};

const f = (p: Partial<FaceParams>): FaceParams => ({ ...base, ...p });

export const FACES: Record<Expression, FaceParams> = {
  neutral: f({}),
  happy: f({ open: 0.95, browUp: 1.2, mouth: "grin", mouthOpen: 0.75, blush: 0.55 }),
  laughing: f({ eyes: "happy", browUp: 2.2, mouth: "laugh", mouthOpen: 1.1, blush: 0.7 }),
  surprised: f({ open: 1.2, pupil: 0.62, browUp: 3.6, brow: 6, mouth: "o", mouthOpen: 0.9, blush: 0.1 }),
  shocked: f({ open: 1.35, pupil: 0.42, browUp: 5, brow: 10, mouth: "bigo", mouthOpen: 1.1, blush: 0, extras: ["shock"] }),
  scared: f({ open: 1.2, pupil: 0.5, browUp: 3, brow: 22, mouth: "wavy", blush: 0, extras: ["sweat2"] }),
  worried: f({ open: 1, pupil: 0.85, lookX: -0.35, browUp: 1.4, brow: 20, mouth: "wavy", blush: 0.05, extras: ["sweat"] }),
  angry: f({ open: 0.78, pupil: 0.8, browUp: -1.6, brow: -26, mouth: "grit", blush: 0, red: 1, extras: ["vein"] }),
  determined: f({ open: 0.86, pupil: 0.92, browUp: -0.8, brow: -14, mouth: "flat", blush: 0.1 }),
  thinking: f({ open: 0.9, lookX: 0.65, lookY: -0.8, browUp: 1, browAsym: 2.6, mouth: "pout", blush: 0.1 }),
  sad: f({ open: 0.82, lookY: 0.55, browUp: 1, brow: 24, mouth: "frown", blush: 0.05, extras: ["tear"] }),
  proud: f({ eyes: "lidded", lid: 0.5, lookY: -0.3, browUp: 1.6, brow: -4, mouth: "smirk", blush: 0.35, extras: ["sparkle"] }),
  dizzy: f({ eyes: "spiral", browUp: 1, brow: 15, mouth: "wavy", blush: 0.1, extras: ["stars"] }),
  relieved: f({ eyes: "closed", browUp: 1, brow: 12, mouth: "smile", blush: 0.3, extras: ["puff"] }),
};

/** How a noise moves the mouth while it plays (seconds). */
export const NOISE_MOUTH: Record<NoiseId, { mouth: Mouth; dur: number; flap: number }> = {
  gasp: { mouth: "bigo", dur: 0.55, flap: 0 },
  whoa: { mouth: "o", dur: 0.7, flap: 0 },
  hmm: { mouth: "pout", dur: 0.8, flap: 0 },
  yay: { mouth: "grin", dur: 0.6, flap: 0 },
  oops: { mouth: "o", dur: 0.5, flap: 0 },
  laugh: { mouth: "laugh", dur: 1, flap: 7 },
  giggle: { mouth: "grin", dur: 0.8, flap: 9 },
  sigh: { mouth: "o", dur: 0.9, flap: 0 },
  yelp: { mouth: "bigo", dur: 0.4, flap: 0 },
  phew: { mouth: "o", dur: 0.7, flap: 0 },
  babble: { mouth: "grin", dur: 1.1, flap: 8 },
};

/** 0..1: how closed the eyes are from a blink right now (seeded per character). */
export function blink(seed: number, t: number): number {
  const period = 2.6 + rand(seed, 3) * 1.8;
  const phase = rand(seed, 4) * period;
  const x = (t + phase) % period;
  if (x > 0.16) return 0;
  return Math.sin((x / 0.16) * Math.PI);
}

const MOUTH_DARK = "#4a1830";
const TONGUE = "#ff8a9b";

interface PoseLike {
  turn: number;
  lookX: number;
  lookY: number;
  nod: number;
}

/** Draws the face in the head frame (origin at the head's centre, local units). */
export function drawFace(pen: Pen, rx: number, ry: number, look: CharacterLook, face: FaceParams, pose: PoseLike, t: number, seed: number): void {
  if (nightDrive()) {
    drawFaceNight(pen, rx, ry, look, face, pose, t, seed);
    return;
  }
  const skin = hex(look.skin, "#f2c9a0");
  const O = hex(look.outline, "#1c1842");
  const ink = shade(O, -0.2);
  const turn = clamp(pose.turn, -1, 1);
  const fx = turn * rx * 0.3;
  const sp = rx * 0.37;
  const ey = -ry * 0.06 + pose.nod * 3;
  const lookX = clamp(face.lookX * 0.7 + pose.lookX + turn * 0.25, -1, 1);
  const lookY = clamp(face.lookY + pose.lookY, -1, 1);

  // cheeks first (under the eyes)
  if (face.blush > 0.02) {
    for (const s of [-1, 1]) pen.ellipse(fx + s * rx * 0.58, ey + 6.6, 3.8, 2.3, 0, "#ff7a8a", 0.38 * face.blush);
  }
  if (face.red > 0.02) pen.ellipse(fx, -ry * 0.38, rx * 0.78, ry * 0.42, 0, "#ff3b30", 0.17 * face.red);

  // eyes
  const shape = look.eyes.shape;
  const erx = shape === "oval" ? 4.2 : 4.9;
  const ery = shape === "oval" ? 5.9 : 4.9;
  const iris = hex(look.eyes.color, "#1c1842");
  const closedBy = face.eyes === "normal" || face.eyes === "lidded" ? blink(seed, t) : 0;
  const open = face.open * (1 - closedBy);
  const sleepyLid = shape === "sleepy" ? clamp(0.42 - (face.open - 1) * 1.2, 0, 0.5) : 0;
  const lid = Math.max(face.eyes === "lidded" ? face.lid : 0, sleepyLid);
  for (const s of [-1, 1]) {
    const far = s * turn < 0 ? Math.abs(turn) : 0;
    const ex = fx + s * sp * (1 - 0.22 * far);
    const wk = 1 - 0.22 * far;
    const ew = erx * wk;
    if (face.eyes === "happy") {
      pen.line(arcPts(ex, ey + ery * 0.45, ew * 1.05, ery * 0.85, 200, 340, 6), 2.2, ink);
      continue;
    }
    if (face.eyes === "closed" || open < 0.16) {
      pen.line(arcPts(ex, ey - ery * 0.35, ew * 1.05, ery * 0.6, 20, 160, 6), 2, ink);
      continue;
    }
    const eh = ery * open;
    pen.ellipse(ex, ey, ew * (1 + 0.06 * (face.open - 1)), eh, 0, "#ffffff");
    if (face.eyes === "spiral") {
      const pts: number[] = [];
      const spin = t * 400 * s;
      for (let i = 0; i <= 16; i += 1) {
        const a = (spin + i * 40) * DEG;
        const r = 0.5 + (i / 16) * Math.min(ew, eh) * 0.95;
        pts.push(ex + Math.cos(a) * r, ey + Math.sin(a) * r);
      }
      pen.line(pts, 1.3, ink);
      continue;
    }
    const ir = Math.min(ew * 0.6 * face.pupil, eh * 0.92);
    const ix = ex + lookX * (ew - ir) * 0.85;
    const iy = ey + lookY * Math.max(0, eh - ir) * 0.85;
    pen.circle(ix, iy, ir, iris);
    if (ir > 1.6) pen.circle(ix, iy, ir * 0.5, shade(iris, -0.55));
    pen.circle(ix - ir * 0.32, iy - ir * 0.38, Math.max(0.6, ir * 0.34), "#ffffff");
    if (lid > 0.02) {
      // the eyelid covers the top of the eye down to a gently curved edge
      const edge = ey - eh + 2 * eh * Math.min(0.85, lid);
      const eye = arcPts(ex, ey, ew * 1.08, eh * 1.08, 0, 360, 18);
      const cover = clipConvex(eye, [ex - ew * 2, ey - eh * 2, ex + ew * 2, ey - eh * 2, ex + ew * 2, edge + 0.8, ex - ew * 2, edge - 0.8]);
      pen.poly(cover, shade(skin, -0.08));
      pen.line([ex - ew * 1.02, edge - 0.4, ex, edge + 0.5, ex + ew * 1.02, edge - 0.4], 1.4, ink);
    }
  }

  // brows
  const hairC = look.hair.style === "none" ? shade(skin, -0.55) : shade(hex(look.hair.color, "#3b2a1a"), -0.45);
  const bw = look.brows === "thick" ? 3.4 : 2.1;
  for (const s of [-1, 1]) {
    const far = s * turn < 0 ? Math.abs(turn) : 0;
    const ex = fx + s * sp * (1 - 0.22 * far);
    const by = ey - ery * Math.max(face.open, 0.85) - 3.6 - face.browUp - (s > 0 ? face.browAsym : 0);
    const half = erx * 0.75 * (1 - 0.2 * far);
    const tilt = Math.tan(clamp(face.brow, -40, 40) * DEG) * half;
    const inX = ex - s * half;
    const outX = ex + s * half;
    pen.line([inX, by - tilt, ex, by - Math.abs(tilt) * 0.2 - 0.8, outX, by + tilt * 0.6], bw, hairC);
  }

  // nose
  const nx = fx * 1.25 + turn * 1.5;
  const ny = ey + 5.6 + pose.nod;
  if (look.nose === "dot") pen.circle(nx, ny, 1.5, shade(skin, -0.3));
  else if (look.nose === "button") {
    pen.circle(nx, ny, 2.7, shade(skin, -0.12));
    pen.circle(nx - 0.8, ny - 0.9, 0.9, "#ffffff", 0.45);
  } else if (look.nose === "long") pen.ellipse(nx + turn * 2.6, ny + 0.6, 2.6 + Math.abs(turn) * 2, 2.2, 0, shade(skin, -0.16));

  // mouth
  drawMouth(pen, face.mouth, face.mouthOpen, fx * 1.15, ey + 11.6 + pose.nod * 1.2, look.mouth === "wide" ? 6.2 : 4.5, ink);

  // extras
  for (const x of face.extras) drawExtra(pen, x, rx, ry, t, seed, fx);
}

function drawMouth(pen: Pen, m: Mouth, open: number, x: number, y: number, mw: number, ink: string): void {
  switch (m) {
    case "smile":
      pen.line(quadPts(x - mw, y, x, y + mw * 0.55, x + mw, y, 6), 2, ink);
      return;
    case "flat":
      pen.line([x - mw * 0.8, y + 1, x + mw * 0.8, y + 1.3], 2.1, ink);
      return;
    case "frown":
      pen.line(quadPts(x - mw, y + 2.4, x, y - 2.2, x + mw, y + 2.4, 6), 2, ink);
      return;
    case "smirk":
      pen.line(quadPts(x - mw * 0.8, y + 0.8, x + mw * 0.15, y + 2.2, x + mw, y - 1.6, 6), 2, ink);
      return;
    case "pout":
      pen.line([x - mw * 0.3 + 1.6, y + 1.2, x + mw * 0.45 + 1.6, y + 0.3], 2.1, ink);
      return;
    case "wavy": {
      const pts: number[] = [];
      for (let i = 0; i <= 6; i += 1) pts.push(x - mw + (2 * mw * i) / 6, y + 1 + (i % 2 === 0 ? -0.9 : 0.9));
      pen.line(pts, 1.8, ink);
      return;
    }
    case "grin":
    case "laugh": {
      const h = mw * (m === "laugh" ? 1.05 : 0.72) * clamp(open, 0.3, 1.3);
      const pts = [x - mw, y - 0.6, x + mw, y - 0.6, ...arcPts(x, y - 0.6, mw, h, 0, 180, 8).slice(2)];
      pen.poly(pts, MOUTH_DARK);
      pen.ellipse(x, y - 0.6 + h * 0.62, mw * 0.5, h * 0.3, 0, TONGUE);
      if (m === "laugh") pen.rect(x - mw * 0.7, y - 0.6, mw * 1.4, Math.min(1.6, h * 0.25), 0.6, "#ffffff");
      return;
    }
    case "o":
      pen.ellipse(x, y + 1, 2.2, 2.7 * clamp(open, 0.5, 1.3), 0, MOUTH_DARK);
      return;
    case "bigo": {
      const h = 5 * clamp(open, 0.5, 1.3);
      pen.ellipse(x, y + 2, 3.5, h, 0, MOUTH_DARK);
      pen.ellipse(x, y + 2 + h * 0.55, 2.2, h * 0.3, 0, TONGUE);
      return;
    }
    case "hum": {
      // closed lips, humming: a soft curve that hums up and down, never open
      const w = mw * 0.62;
      const lift = 0.9 * clamp(open, 0, 1);
      pen.line(quadPts(x - w, y + 1, x, y + 1.6 + lift, x + w, y + 1, 6), 2.3, ink);
      pen.line([x - w - 0.8, y + 0.2 - lift * 0.3, x - w, y + 1], 1.4, ink, 0.7);
      pen.line([x + w, y + 1, x + w + 0.8, y + 0.2 - lift * 0.3], 1.4, ink, 0.7);
      return;
    }
    case "grit":
      pen.rect(x - mw - 1, y - 2.8, mw * 2 + 2, 5.6, 2.2, ink);
      pen.rect(x - mw, y - 1.8, mw * 2, 3.6, 1.4, "#ffffff");
      pen.line([x - mw * 0.9, y, x + mw * 0.9, y], 0.8, ink, 0.6);
      return;
  }
}

function drawExtra(pen: Pen, x: Extra, rx: number, ry: number, t: number, seed: number, fx: number): void {
  switch (x) {
    case "sweat":
    case "sweat2": {
      const n = x === "sweat2" ? 2 : 1;
      for (let i = 0; i < n; i += 1) {
        const slide = ((t * 0.8 + i * 0.45 + rand(seed, 20 + i)) % 1) * 7;
        const dx = (i === 0 ? -1 : 1) * rx * 0.92;
        const dy = -ry * 0.45 + slide;
        pen.poly(dropPts(dx, dy, 2.6, 5.4), "#2d7fd1", 0.9);
        pen.poly(dropPts(dx, dy, 2, 4.4), "#8fd8ff");
        pen.circle(dx - 0.7, dy - 0.4, 0.7, "#ffffff", 0.8);
      }
      return;
    }
    case "tear": {
      const slide = ((t * 0.6 + rand(seed, 30)) % 1) * 8;
      const ex = fx + rx * 0.37;
      pen.line([ex - 1, 4, ex - 1.5, 4 + slide], 1.6, "#8fd8ff", 0.75);
      pen.poly(dropPts(ex - 1.5, 7 + slide, 1.8, 3.6), "#8fd8ff");
      return;
    }
    case "stars": {
      for (let i = 0; i < 3; i += 1) {
        const a = (t * 160 + i * 120) * DEG;
        const sx = Math.cos(a) * rx * 0.95;
        const sy = -ry - 5 + Math.sin(a) * 3.5;
        pen.poly(starPts(sx, sy, 4.4, 1.9, 5, t * 90), "#c98a00");
        pen.poly(starPts(sx, sy, 3.4, 1.4, 5, t * 90), "#ffc94a");
      }
      return;
    }
    case "vein": {
      const k = 1 + 0.15 * Math.sin(t * 9);
      const vx = rx * 0.52;
      const vy = -ry * 0.6;
      const arm = 2.6 * k;
      pen.line([vx - arm, vy - arm * 0.3, vx - arm * 0.3, vy - arm * 0.3, vx - arm * 0.3, vy - arm], 1.7, "#e53935");
      pen.line([vx + arm, vy + arm * 0.3, vx + arm * 0.3, vy + arm * 0.3, vx + arm * 0.3, vy + arm], 1.7, "#e53935");
      pen.line([vx + arm, vy - arm * 0.3, vx + arm * 0.3, vy - arm * 0.3, vx + arm * 0.3, vy - arm], 1.7, "#e53935");
      return;
    }
    case "shock": {
      for (const a of [-130, -90, -50]) {
        const c = Math.cos(a * DEG);
        const s = Math.sin(a * DEG);
        const r0 = ry + 6;
        const r1 = ry + 11 + Math.sin(t * 14) * 0.8;
        pen.line([c * r0 * (rx / ry), s * r0, c * r1 * (rx / ry), s * r1], 1.8, "#1c1842");
      }
      return;
    }
    case "sparkle": {
      const k = 0.6 + 0.4 * Math.abs(Math.sin(t * 3.4));
      pen.poly(starPts(rx * 1.05, -ry * 0.65, 4.6 * k, 1.2 * k, 4, 0), "#ffc94a");
      return;
    }
    case "puff": {
      const p = (t % 2.2) / 2.2;
      const px = fx + 9 + p * 10;
      pen.circle(px, 11 - p * 3, 2.2 + p * 2, "#ffffff", 0.75 * (1 - p));
      pen.circle(px + 3, 9.5 - p * 4, 1.6 + p * 1.6, "#ffffff", 0.6 * (1 - p));
      return;
    }
  }
}

// ---- night drive (CONTRACTS §45.45 §5): tiny dot eyes, short thick brows that carry the feeling, a small nose bump
// and a simple mouth (a line, a wobbly line, or an open shape with a dark red inside). The FACES data, blinks, the
// hum and the noise mouths are the same as classic's; only the drawing changes.

/** Draws a night drive face in the head frame (origin at the head's centre, local units). */
function drawFaceNight(pen: Pen, rx: number, ry: number, look: CharacterLook, face: FaceParams, pose: PoseLike, t: number, seed: number): void {
  const u = pen.unit() / (F.k || 1);
  const ow = lineUnits(pen, inkPx(u));
  const skin = grade(hex(look.skin, "#f2c9a0"));
  const turn = clamp(pose.turn, -1, 1);
  const fx = turn * rx * 0.3;
  const ey = -ry * 0.06 + pose.nod * 3;
  const lookX = clamp(face.lookX * 0.7 + pose.lookX + turn * 0.25, -1, 1);
  const lookY = clamp(face.lookY + pose.lookY, -1, 1);
  const eyeX = (s: number) => fx + s * rx * 0.44 * (1 - 0.22 * (s * turn < 0 ? Math.abs(turn) : 0));

  // cheeks: a faint blush, the angry flush
  if (face.blush > 0.02) {
    for (const s of [-1, 1]) pen.ellipse(fx + s * rx * 0.58, ey + 6.6, 3.8, 2.3, 0, ND.blush, 0.12 * face.blush);
  }
  if (face.red > 0.02) pen.ellipse(fx, -ry * 0.38, rx * 0.78, ry * 0.42, 0, ND.flush, 0.1 * face.red);

  // eyes: tiny dots, no white
  const shape = look.eyes.shape;
  const [sw, sh] = shape === "oval" ? [0.88, 1.18] : [1, 1];
  const closedBy = face.eyes === "normal" || face.eyes === "lidded" ? blink(seed, t) : 0;
  const sleepyLid = shape === "sleepy" ? clamp(0.42 - (face.open - 1) * 1.2, 0, 0.5) : 0;
  const lid = Math.max(face.eyes === "lidded" ? face.lid : 0, sleepyLid);
  const dot = (0.85 + 0.15 * face.open) * Math.sqrt(Math.max(0.05, face.pupil));
  const arcW = 0.9;
  for (const s of [-1, 1]) {
    const far = s * turn < 0 ? Math.abs(turn) : 0;
    const ex = eyeX(s);
    const erx = 1.25 * sw * dot * (1 - 0.15 * far);
    const ery = 1.55 * sh * dot;
    if (face.eyes === "happy") {
      pen.line(arcPts(ex, ey + 1.3, 2.3, 2, 200, 340, 6), arcW, ND.eye);
      continue;
    }
    if (face.eyes === "closed") {
      pen.line(arcPts(ex, ey - 1, 2.1, 1.6, 20, 160, 6), arcW, ND.eye);
      continue;
    }
    if (face.eyes === "spiral") {
      const pts: number[] = [];
      const spin = t * 400 * s;
      for (let i = 0; i <= 14; i += 1) {
        const a = (spin + i * 44) * DEG;
        const r = 0.3 + (i / 14) * 2.1;
        pts.push(ex + Math.cos(a) * r, ey + Math.sin(a) * r);
      }
      pen.line(pts, 0.55, ND.eye);
      continue;
    }
    const x = ex + lookX * rx * 0.06;
    const y = ey + lookY * ry * 0.05;
    if (closedBy > 0.55) {
      // a blink squashes the dot to a short line
      pen.line([x - erx * 1.2, y + 0.3, x + erx * 1.2, y + 0.3], 0.75, ND.eye);
      continue;
    }
    const h = ery * (1 - closedBy * 0.8);
    if (lid > 0.02) {
      // half-lidded: the dot under a flat lid line
      const edge = y - h + 2 * h * Math.min(0.85, lid);
      const eye = arcPts(x, y, erx, h, 0, 360, 14).slice(0, -2);
      pen.poly(clipConvex(eye, [x - 9, edge, x + 9, edge, x + 9, y + 9, x - 9, y + 9]), ND.eye);
      pen.line([x - erx * 1.55, edge, x + erx * 1.55, edge], 0.6, ND.eye);
      continue;
    }
    pen.ellipse(x, y, erx, h, 0, ND.eye);
    if (u >= 8) pen.circle(x - erx * 0.32, y - h * 0.36, 0.4, ND.glint);
  }

  // brows: short, thick, tapered strokes; their tilt and arch carry the feeling
  const hairBase = look.hair.style === "none" ? cel(skin, 0.55) : grade(hex(look.hair.color, "#3b2a1a"));
  const browC = mix(hairBase, ND.eye, 0.6);
  const W = look.brows === "thick" ? 2.6 : 1.7;
  const len = 0.3 * rx;
  // proud's one brow a little up, dizzy's uneven brows
  const smug = face.mouth === "smirk" ? 0.8 : face.eyes === "spiral" ? 1.2 : 0;
  // the highest a brow goes: just under the fringe (the cap's edge, or high on a bare head)
  const ceiling = look.hair.style === "cap" ? -0.3 * ry : look.hair.style === "none" ? -0.75 * ry : -0.47 * ry;
  for (const s of [-1, 1]) {
    const far = s * turn < 0 ? Math.abs(turn) : 0;
    const ex = eyeX(s);
    const half = (len / 2) * (1 - 0.2 * far);
    const tilt = Math.tan(clamp(face.brow, -40, 40) * DEG) * half;
    const arch = clamp(0.12 * face.browUp, -0.2, 0.6) * len;
    const want = ey - 0.22 * ry - face.browUp * 0.9 - (s > 0 ? face.browAsym + smug : 0);
    const by = Math.max(want, ceiling + W * 0.6 + Math.max(0, arch) + Math.max(0, tilt));
    pen.poly(browPts(ex - s * half, by - tilt, ex + s * half, by + tilt * 0.6, arch, W * (1 - 0.15 * far)), browC);
  }

  // nose: a small rounded bump with a thin line under it
  if (look.nose !== "none") {
    const [nrx, nry] = look.nose === "dot" ? [2, 1.4] : look.nose === "button" ? [2.8, 2.2] : [3.2, 2];
    const long = look.nose === "long" ? 1 : 0;
    const nx = fx * 1.25 + turn * 1.5 + long * turn * 2.6;
    const ny = ey + 5.6 + pose.nod;
    const w = nrx * (1 + long * Math.abs(turn) * 0.4);
    pen.ellipse(nx, ny, w, nry, 0, mix(skin, cel(skin), 0.12));
    pen.line(arcPts(nx, ny, w, nry, 15, 165, 8), ow * 0.8, ND.mouthLine, 0.7);
  }

  // mouth
  mouthNight(pen, face.mouth, face.mouthOpen, fx * 1.15, ey + 11.6 + pose.nod * 1.2, look.mouth === "wide" ? 6.2 : 4.5, ow);

  // extras, in night colours
  for (const x of face.extras) extraNight(pen, x, rx, ry, t, seed, fx);
}

/** A brow: a tapered lens of 9 points along a gentle curve from the inner end (x0, y0) to the outer end (x1, y1), its
 * middle raised by `arch`, widest (w) at 35% from the inner end. */
function browPts(x0: number, y0: number, x1: number, y1: number, arch: number, w: number): number[] {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2 - arch * 2;
  const at = (u: number): [number, number, number, number] => {
    const v = 1 - u;
    const px = v * v * x0 + 2 * v * u * cx + u * u * x1;
    const py = v * v * y0 + 2 * v * u * cy + u * u * y1;
    const dx = 2 * v * (cx - x0) + 2 * u * (x1 - cx);
    const dy = 2 * v * (cy - y0) + 2 * u * (y1 - cy);
    const l = Math.hypot(dx, dy) || 1;
    let nx = dy / l;
    let ny = -dx / l;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    return [px, py, nx, ny];
  };
  const width = (u: number) => w * (u < 0.35 ? Math.pow(Math.sin(((u / 0.35) * Math.PI) / 2), 0.6) : Math.pow(Math.cos((((u - 0.35) / 0.65) * Math.PI) / 2), 0.8));
  const pts: number[] = [];
  const side = (u: number, k: number) => {
    const [px, py, nx, ny] = at(u);
    const h = (width(u) / 2) * k;
    pts.push(px + nx * h, py + ny * h);
  };
  side(0, 0);
  for (const u of [0.12, 0.35, 0.6, 0.85]) side(u, 1);
  side(1, 0);
  for (const u of [0.72, 0.42, 0.16]) side(u, -1);
  return pts;
}

/** An open mouth: an egg (a flatter top, a rounder bottom) in the dark red inside, a thin dark outline, a tongue for the
 * lower lip and, when laughing, a band of top teeth. */
function openMouth(pen: Pen, x: number, y: number, hw: number, top: number, bottom: number, ow: number, teeth: boolean): void {
  const pts = [...arcPts(x, y, hw, bottom, 0, 180, 10), ...arcPts(x, y, hw, top, 180, 360, 8).slice(2, -2)];
  pen.poly(inflate(pts, ow), ND.mouthLine);
  pen.poly(pts, ND.mouthInside);
  if (teeth) pen.poly(clipConvex([x - hw * 2, y - top - 2, x + hw * 2, y - top - 2, x + hw * 2, y + bottom * 0.2, x - hw * 2, y + bottom * 0.2], pts), ND.teeth);
  pen.poly(clipConvex(arcPts(x, y + bottom * 0.88, hw * 0.62, bottom * 0.4, 0, 360, 14).slice(0, -2), pts), ND.tongue);
}

function mouthNight(pen: Pen, m: Mouth, open: number, x: number, y: number, mw: number, ow: number): void {
  const lw = 1.1;
  const c = ND.mouthLine;
  switch (m) {
    case "smile":
      pen.line(quadPts(x - mw * 0.72, y + 0.2, x, y + mw * 0.36, x + mw * 0.72, y + 0.2, 6), lw, c);
      return;
    case "flat":
      pen.line([x - mw * 0.7, y + 1, x + mw * 0.7, y + 1.15], lw, c);
      return;
    case "frown":
      pen.line(quadPts(x - mw * 0.8, y + 2.2, x, y - 1.6, x + mw * 0.8, y + 2.2, 6), lw, c);
      return;
    case "smirk":
      pen.line(quadPts(x - mw * 0.7, y + 0.8, x + mw * 0.1, y + 1.9, x + mw * 0.9, y - 1.3, 6), lw, c);
      return;
    case "pout":
      pen.line([x - mw * 0.25 + 1.4, y + 1.1, x + mw * 0.35 + 1.4, y + 0.4], lw, c);
      return;
    case "wavy": {
      // the worried look: a soft wobbly line through 7 crests and dips (amplitude 0.7)
      const pts: number[] = [];
      for (let i = 0; i <= 18; i += 1) pts.push(x - mw * 0.85 + (1.7 * mw * i) / 18, y + 1 - 0.7 * Math.cos((Math.PI * i) / 3));
      pen.line(pts, lw, c);
      return;
    }
    case "grin":
    case "laugh": {
      const laugh = m === "laugh";
      const h = mw * (laugh ? 1.0 : 0.66) * clamp(open, 0.3, 1.3);
      openMouth(pen, x, y - 0.4, mw * (laugh ? 0.98 : 0.82), h * 0.12, h, ow, laugh);
      return;
    }
    case "o": {
      const k = clamp(open, 0.5, 1.3);
      openMouth(pen, x, y + 1, 1.9, 1.9 * k, 2.5 * k, ow, false);
      return;
    }
    case "bigo": {
      const k = clamp(open, 0.5, 1.3);
      openMouth(pen, x, y + 1.5, 3.2, 3.4 * k, 5 * k, ow, false);
      return;
    }
    case "hum": {
      const w = mw * 0.62;
      const up = 0.9 * clamp(open, 0, 1);
      pen.line(quadPts(x - w, y + 1, x, y + 1.6 + up, x + w, y + 1, 6), lw, c);
      pen.line([x - w - 0.8, y + 0.2 - up * 0.3, x - w, y + 1], lw * 0.6, c, 0.7);
      pen.line([x + w, y + 1, x + w + 0.8, y + 0.2 - up * 0.3], lw * 0.6, c, 0.7);
      return;
    }
    case "grit":
      // gritted teeth: a band of teeth rimmed in the dark red, the bite line and a gap
      pen.rect(x - mw - 0.8, y - 2.3, mw * 2 + 1.6, 4.6, 1.8, ND.mouthInside);
      pen.rect(x - mw, y - 1.5, mw * 2, 3, 1.1, ND.teeth);
      pen.line([x - mw * 0.92, y, x + mw * 0.92, y], Math.max(0.35, ow * 0.6), ND.mouthInside, 0.85);
      pen.line([x + mw * 0.1, y - 1.4, x + mw * 0.1, y + 1.4], Math.max(0.3, ow * 0.5), ND.mouthInside, 0.6);
      return;
  }
}

function extraNight(pen: Pen, x: Extra, rx: number, ry: number, t: number, seed: number, fx: number): void {
  const sweat = "#7fb2d9";
  switch (x) {
    case "sweat":
    case "sweat2": {
      const n = x === "sweat2" ? 2 : 1;
      for (let i = 0; i < n; i += 1) {
        const slide = ((t * 0.8 + i * 0.45 + rand(seed, 20 + i)) % 1) * 7;
        const dx = (i === 0 ? -1 : 1) * rx * 0.92;
        const dy = -ry * 0.45 + slide;
        pen.poly(dropPts(dx, dy, 2.5, 5.2), cel(sweat, 0.35), 0.9);
        pen.poly(dropPts(dx, dy, 2, 4.4), sweat);
        pen.circle(dx - 0.7, dy - 0.4, 0.6, ND.glint, 0.7);
      }
      return;
    }
    case "tear": {
      const slide = ((t * 0.6 + rand(seed, 30)) % 1) * 8;
      const ex = fx + rx * 0.44;
      pen.line([ex - 0.6, 2, ex - 1, 2 + slide], 1.2, sweat, 0.7);
      pen.poly(dropPts(ex - 1, 5 + slide, 1.6, 3.2), sweat);
      return;
    }
    case "stars": {
      for (let i = 0; i < 3; i += 1) {
        const a = (t * 160 + i * 120) * DEG;
        const sx = Math.cos(a) * rx * 0.95;
        const sy = -ry - 5 + Math.sin(a) * 3.5;
        pen.poly(starPts(sx, sy, 4.2, 1.8, 5, t * 90), cel("#d9a441", 0.35));
        pen.poly(starPts(sx, sy, 3.3, 1.4, 5, t * 90), "#d9a441");
      }
      return;
    }
    case "vein": {
      const k = 1 + 0.15 * Math.sin(t * 9);
      const vx = rx * 0.52;
      const vy = -ry * 0.6;
      const arm = 2.4 * k;
      const v = "#c0392b";
      pen.line([vx - arm, vy - arm * 0.3, vx - arm * 0.3, vy - arm * 0.3, vx - arm * 0.3, vy - arm], 1.3, v);
      pen.line([vx + arm, vy + arm * 0.3, vx + arm * 0.3, vy + arm * 0.3, vx + arm * 0.3, vy + arm], 1.3, v);
      pen.line([vx + arm, vy - arm * 0.3, vx + arm * 0.3, vy - arm * 0.3, vx + arm * 0.3, vy - arm], 1.3, v);
      return;
    }
    case "shock": {
      for (const a of [-130, -90, -50]) {
        const c = Math.cos(a * DEG);
        const s = Math.sin(a * DEG);
        const r0 = ry + 6;
        const r1 = ry + 11 + Math.sin(t * 14) * 0.8;
        pen.line([c * r0 * (rx / ry), s * r0, c * r1 * (rx / ry), s * r1], 1.4, ND.ink);
      }
      return;
    }
    case "sparkle": {
      const k = 0.6 + 0.4 * Math.abs(Math.sin(t * 3.4));
      pen.poly(starPts(rx * 1.05, -ry * 0.65, 4.4 * k, 1.1 * k, 4, 0), ND.halo1, 0.9);
      return;
    }
    case "puff": {
      const p = (t % 2.2) / 2.2;
      const px = fx + 9 + p * 10;
      pen.circle(px, 11 - p * 3, 2.2 + p * 2, ND.glint, 0.55 * (1 - p));
      pen.circle(px + 3, 9.5 - p * 4, 1.6 + p * 1.6, ND.glint, 0.45 * (1 - p));
      return;
    }
  }
}
