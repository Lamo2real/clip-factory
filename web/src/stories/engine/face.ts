// Lamo Stories engine: faces. Every Expression is a set of eye, brow and mouth choices plus a few extras (sweat drops,
// dizzy stars, an angry mark), so a face reads clearly on a phone. Blinks are seeded per character.

import { cel, grade, inkPx, lift, lineUnits, lit, ND, nightDrive } from "./art.ts";
import { F } from "./frame.ts";
import { DEG, clamp, hex, luminance, mix, rand, shade } from "./math.ts";
import type { Pen } from "./pen.ts";
import { arcPts, capsulePts, clipConvex, dropPts, ellipsePts, joinShapes, quadPts, ribbonPts, starPts } from "./pen.ts";
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

// ---- night drive (CONTRACTS §45.45 §5), the chunky look: big glossy eyes (a warm white, an iris in the picked
// colour, a dark pupil and two sparkles under a thick lid line), short thick blocks for brows, a tiny nose, round
// cheeks and a big friendly mouth. The FACES data, blinks, the hum and the noise mouths are the same as classic's;
// only the drawing changes. Shapes that share a colour are one polygon (pen.ts joinShapes): both whites, both irises,
// both lids and pupils, all four sparkles, both brows, both cheeks; so a face is 8 to 14 prims.

/** Where a night face's parts sit in the head frame: the face's middle `fx` (it slides with the turn), the eye line
 * `ey` (it drops with a nod), how far a turned-away eye is squeezed (`far`, 0..1) and each eye's x (`s` -1 the back
 * eye, 1 the front one). The glasses (rig.ts) sit on the same spots. */
export function faceSpots(rx: number, ry: number, pose: { turn: number; nod: number }): { turn: number; fx: number; ey: number; far: (s: number) => number; eyeX: (s: number) => number } {
  const turn = clamp(pose.turn, -1, 1);
  const fx = turn * rx * 0.3;
  const far = (s: number): number => (s * turn < 0 ? Math.abs(turn) : 0);
  return { turn, fx, ey: ry * 0.02 + pose.nod * 3, far, eyeX: (s) => fx + s * rx * 0.4 * (1 - 0.22 * far(s)) };
}

/** A night eye's half width and half height wide open (rig units): round, oval (narrow and tall) or sleepy. */
export function eyeSize(shape: CharacterLook["eyes"]["shape"]): [number, number] {
  return shape === "oval" ? [3.05, 4.9] : shape === "sleepy" ? [3.6, 4.1] : [3.6, 4.4];
}

/** The highest a night brow's top may go, in head radii (up is negative): just under the hair's edge where the quiff
 * lifts off the forehead, the cap's band, or high on a bare head. */
function browCeiling(look: CharacterLook): number {
  if (look.accessory === "helmet") return -0.26;
  switch (look.hair.style) {
    case "none":
      return -0.74;
    case "cap":
      return -0.27;
    case "spiky":
      return -0.4;
    case "curly":
      return -0.42;
    case "short":
      return -0.47;
    default:
      return -0.44;
  }
}

/** Draws a night drive face in the head frame (origin at the head's centre, local units). */
function drawFaceNight(pen: Pen, rx: number, ry: number, look: CharacterLook, face: FaceParams, pose: PoseLike, t: number, seed: number): void {
  const u = pen.unit() / (F.k || 1);
  const ow = lineUnits(pen, inkPx(u));
  // twice the points up close (the shots' busts), where a short straight edge would show
  const fk = u >= 9 ? 2 : 1;
  const skin = grade(hex(look.skin, "#f2c9a0"));
  const { turn, fx, ey, far, eyeX } = faceSpots(rx, ry, pose);
  const lookX = clamp(face.lookX * 0.7 + pose.lookX + turn * 0.25, -1, 1);
  const lookY = clamp(face.lookY + pose.lookY, -1, 1);

  // cheeks: two round discs, stronger the happier; the angry flush lies across the cheeks and the nose
  if (face.blush > 0.02) {
    for (const s of [-1, 1]) pen.ellipse(fx + s * rx * 0.61 * (1 - 0.2 * far(s)), ey + 7.4, 3.5 * (1 - 0.25 * far(s)), 3.2, 0, ND.cheek, 0.13 + 0.25 * face.blush);
  }
  if (face.red > 0.02) pen.ellipse(fx, ey + 3.5, rx * 0.8, ry * 0.36, 0, ND.flush, 0.16 * face.red);

  // eyes: the white, the iris in the picked colour, the pupil and the lid line (one dark shape), the sparkles
  const [bw, bh] = eyeSize(look.eyes.shape);
  const closedBy = face.eyes === "normal" || face.eyes === "lidded" ? blink(seed, t) : 0;
  // a sleepy eye's lid rests on the top third of the eye, no more (a friendly drowsy look, never a grumpy one); only
  // the proud face lowers a lid further, and even that one leaves a clear slice of eye
  const sleepyLid = look.eyes.shape === "sleepy" ? clamp(0.22 - (face.open - 1) * 1, 0, 0.25) : 0;
  const proudLid = face.eyes === "lidded" ? face.lid * 0.62 : 0;
  const lid = Math.max(proudLid, sleepyLid);
  // a sleepy lid is a soft arc that droops at its outer end; a proud one is nearly straight
  const soft = sleepyLid >= proudLid;
  const sag = soft ? 1.1 : 0.3;
  const droop = soft ? 0.45 : 0;
  const open = clamp(face.open, 0.6, 1.4);
  const whites: number[][] = [];
  const irises: number[][] = [];
  const darks: number[][] = [];
  const sparks: number[][] = [];
  const spirals: number[][] = [];
  for (const s of [-1, 1]) {
    const ex = eyeX(s);
    const ew = bw * (1 - 0.2 * far(s)) * (1 + 0.1 * (open - 1));
    const eh = bh * Math.pow(open, 0.9);
    if (face.eyes === "happy") {
      // a happy eye: a thick arch, thinner at its ends
      darks.push(ribbonPts(arcPts(ex, ey + eh * 0.5, ew * 1.16, eh * 0.86, 204, 336, 6 * fk), taper(6 * fk + 1, 1.75), 2));
      continue;
    }
    if (face.eyes === "closed" || closedBy > 0.6) {
      // a closed eye (resting, or the middle of a blink): the lid's line, curving down
      darks.push(ribbonPts(arcPts(ex, ey - eh * 0.12, ew * 1.12, eh * 0.6, 22, 158, 6 * fk), taper(6 * fk + 1, 1.85), 2));
      continue;
    }
    const h = eh * (1 - 0.85 * closedBy);
    const white = ellipsePts(ex, ey, ew, h, 12 * fk);
    if (face.eyes === "spiral") {
      whites.push(white);
      const pts: number[] = [];
      const spin = t * 400 * s;
      for (let i = 0; i <= 16; i += 1) {
        const a = (spin + i * 42) * DEG;
        const r = 0.25 + (i / 16) * Math.min(ew, h) * 0.8;
        pts.push(ex + Math.cos(a) * r, ey + Math.sin(a) * r);
      }
      spirals.push(pts);
      continue;
    }
    // a lowered lid (proud, sleepy eyes) hides everything of the eye above its edge
    const edge = lid > 0.02 ? ey - h + 2 * h * Math.min(0.85, lid) : ey - h * 2;
    const lidY = (tt: number): number => edge + sag * (tt * tt - 0.3) + droop * s * tt;
    const below: number[] = [];
    for (let i = -4; i <= 4; i += 1) below.push(ex + (i / 4) * 1.5 * ew, lidY((i / 4) * 1.5));
    below.push(ex + 1.5 * ew, ey + 30, ex - 1.5 * ew, ey + 30);
    const shown = (pts: number[]): number[] => (lid > 0.02 ? clipConvex(pts, below) : pts);
    whites.push(shown(white));
    // (a frightened eye's iris is clearly smaller in its white)
    const ir = ew * (0.2 + 0.6 * clamp(face.pupil, 0.3, 1)) * (look.eyes.shape === "sleepy" ? 1.1 : 1);
    const iry = Math.min(ir * 1.16, h * 0.97);
    const ix = ex + lookX * ew * 0.4;
    // under a lowered lid the iris sits low enough that most of it shows
    const iy = Math.max(ey + h * 0.05 + lookY * h * 0.3, lid > 0.02 ? edge + iry * 0.3 : -1e9);
    irises.push(shown(clipConvex(ellipsePts(ix, iy, ir, iry, 10 * fk), white)));
    darks.push(shown(clipConvex(ellipsePts(ix + lookX * ir * 0.1, iy + lookY * ir * 0.08, ir * 0.52, iry * 0.52, 8 * fk), white)));
    if (lid > 0.02) {
      // the lid's edge: a thick line across the eye, a little past it each side
      const tw = Math.sqrt(Math.max(0.05, 1 - ((edge - ey) / h) ** 2)) + 0.7 / ew;
      const c: number[] = [];
      for (let i = -3; i <= 3; i += 1) c.push(ex + (i / 3) * tw * ew, lidY((i / 3) * tw));
      darks.push(ribbonPts(c, soft ? 0.7 : 1.15, 2));
    } else {
      // the upper lid: a dark crescent along the top of the white, thickest in the middle
      const out = arcPts(ex, ey - 0.05, ew + 0.3, h + 0.75, 198, 342, 6 * fk);
      const back = arcPts(ex, ey, ew, h, 342, 198, 6 * fk);
      darks.push([...out, ...back]);
    }
    const sr = Math.max(0.62, ir * 0.36);
    sparks.push(shown(ellipsePts(ix - ir * 0.4, iy - iry * 0.42, sr, sr, 8 * fk)));
    // the small second sparkle only shows from a bust's size up
    if (u >= 6 && ir > 1.5) sparks.push(shown(ellipsePts(ix + ir * 0.42, iy + iry * 0.46, ir * 0.18, ir * 0.18, 6)));
  }
  pen.poly(joinShapes(whites), lit(ND.eyeWhite, 0.5));
  // a very dark eye colour is lifted a step, so a ring of colour shows round the pupil
  const irisC = grade(hex(look.eyes.color, "#1c1842"));
  pen.poly(joinShapes(irises), luminance(irisC) < 0.1 ? lift(irisC, 0.09) : irisC);
  for (const sp of spirals) pen.line(sp, 0.8, ND.eye);
  pen.poly(joinShapes(darks), ND.eye);
  pen.poly(joinShapes(sparks), ND.glint);

  // brows: short thick rounded blocks; their tilt and height carry the feeling
  const hairBase = look.hair.style === "none" ? cel(skin, 0.55) : grade(hex(look.hair.color, "#3b2a1a"));
  const specs = look.accessory === "glasses";
  const W = (look.brows === "thick" ? 2.7 : 1.4) * (specs ? 0.85 : 1);
  const len = 0.27 * rx;
  // proud's one brow a little up, dizzy's uneven brows
  const smug = face.mouth === "smirk" ? 1.6 : face.eyes === "spiral" ? 1.2 : 0;
  // (determined's flat-mouth frown is kept clearly milder than angry's)
  const brow0 = face.mouth === "flat" && face.brow < 0 ? face.brow * 0.7 : face.brow;
  const brows = [-1, 1].map((s) => {
    const ex = eyeX(s);
    const half = (len / 2) * (1 - 0.2 * far(s));
    // (a strong tilt is pushed further, so angry is clearly more than determined)
    const kind = look.eyes.shape === "sleepy" ? 6 : 0;
    const tilt = Math.tan(clamp(brow0 * (1 + 0.012 * Math.abs(brow0)) + kind, -42, 42) * DEG) * half;
    const arch = clamp(0.1 * face.browUp, -0.12, 0.45) * len * 0.5;
    const rest = ey - bh * Math.pow(Math.max(open, 0.85), 0.9) - 2.5 - face.browUp * 0.85 - (s > 0 ? face.browAsym + smug : 0);
    // glasses: the brow stays clear above the frame's top rim
    const want = specs ? Math.min(rest, ey - bh - 2.3 - 2.7 - W * 0.5) : rest;
    // never up into the hair: the brow's highest point stays under the fringe
    const by = Math.max(want, browCeiling(look) * ry + W * 0.55 + Math.max(0, arch) + Math.max(tilt, -0.6 * tilt, 0));
    const c = quadPts(ex - s * half, by - tilt, ex, by + tilt * -0.2 - arch * 2, ex + s * half, by + tilt * 0.6, 4);
    return ribbonPts(c, [W * 0.92, W, W, W * 0.88, W * 0.66].map((v) => v * (1 - 0.15 * far(s))), 2);
  });
  pen.poly(joinShapes(brows), mix(hairBase, ND.eye, 0.5));

  // nose: a tiny soft bump, a little darker than the skin
  if (look.nose !== "none") {
    const long = look.nose === "long" ? 1 : 0;
    const [nrx, nry] = look.nose === "dot" ? [1.45, 1.1] : look.nose === "button" ? [1.9, 1.4] : [2.3, 1.6];
    pen.ellipse(fx * 1.25 + turn * 1.5 + long * turn * 2.2, ey + 6.4 + pose.nod, nrx * (1 + long * Math.abs(turn) * 0.4), nry, 0, cel(skin, look.nose === "dot" ? 0.32 : 0.2));
  }

  // mouth
  // (a wavy mouth under frightened eyes is the scared face: its mouth trembles open; worried keeps the closed line)
  mouthNight(pen, face.mouth, face.mouthOpen, fx * 1.15, ey + 11.6 + pose.nod * 1.2, look.mouth === "wide" ? 6.4 : 4.7, ow, fk, face.pupil < 0.6 && face.open > 1.05);

  // extras, in night colours
  for (const x of face.extras) extraNight(pen, x, rx, ry, t, seed, fx, ey);
}

/** A stroke's widths along `n` points: `w` in the middle, a third of it at both ends. */
function taper(n: number, w: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(w * (0.34 + 0.66 * Math.max(0, Math.sin((Math.PI * i) / (n - 1))) ** 0.7));
  return out;
}

/** An open mouth: a half moon (its top edge sagging by `sag`, its round bottom `bottom` deep) in the dark red inside
 * with a dark rim, a tongue across the bottom and, when laughing, a band of top teeth. */
function openMouth(pen: Pen, x: number, y: number, hw: number, sag: number, bottom: number, lw: number, teeth: boolean, fk: number): void {
  const bowl = arcPts(x, y, hw, bottom, 0, 180, 8 * fk);
  const top = quadPts(x - hw, y, x, y + sag * 2, x + hw, y, 4 * fk);
  const pts = [...bowl, ...top.slice(2, -2)];
  pen.line([...pts, pts[0]!, pts[1]!], lw * 2, ND.mouthLine);
  pen.poly(pts, ND.mouthInside);
  // the bowl with a flat top is convex: the teeth and the tongue are cut to it
  if (teeth) {
    const th = Math.min(1.9, bottom * 0.3);
    const band = [...top];
    for (let i = top.length - 2; i >= 0; i -= 2) band.push(top[i]!, top[i + 1]! + th);
    pen.poly(clipConvex(band, bowl), ND.teeth);
  }
  pen.poly(clipConvex(ellipsePts(x, y + bottom * 0.92, hw * 0.6, bottom * 0.42, 10 * fk), bowl), ND.tongue);
}

function mouthNight(pen: Pen, m: Mouth, open: number, x: number, y: number, mw: number, ow: number, fk: number, fear = false): void {
  const lw = 1.45;
  const c = ND.mouthLine;
  switch (m) {
    case "smile": {
      // a wide curve with a small curl up at each corner
      const w = mw * 0.8;
      pen.line([x - w - 1, y - 1.5, x - w - 0.55, y - 0.55, ...quadPts(x - w, y - 0.1, x, y + mw * 0.62, x + w, y - 0.1, 8 * fk), x + w + 0.55, y - 0.55, x + w + 1, y - 1.5], lw, c);
      return;
    }
    case "flat":
      pen.line([x - mw * 0.72, y + 0.9, x + mw * 0.72, y + 1.05], lw, c);
      return;
    case "frown":
      pen.line(quadPts(x - mw * 0.78, y + 2.7, x, y - 1.9, x + mw * 0.78, y + 2.7, 8 * fk), lw, c);
      return;
    case "smirk": {
      // a lopsided smile, well off to the front side
      const hx = x + mw * 1.18;
      pen.line([...quadPts(x - mw * 0.44, y + 1, x + mw * 0.45, y + 2.7, hx, y - 1.3, 8 * fk), hx + 0.6, y - 1.9, hx + 0.9, y - 2.8], lw, c);
      return;
    }
    case "pout":
      // pushed to one side: a small pursed bump
      pen.line(quadPts(x + 0.2, y + 1.5, x + 1.9, y - 0.4, x + 3.6, y + 1.1, 5 * fk), lw, c);
      return;
    case "wavy": {
      // the worried look: a soft wobbly line through 3 waves, bold enough for a phone
      const pts: number[] = [];
      const hw = mw * (fear ? 0.8 : 0.98);
      for (let i = 0; i <= 18; i += 1) pts.push(x - hw + (2 * hw * i) / 18, y + 1 - 0.9 * Math.cos((Math.PI * i) / 3));
      if (fear) {
        // scared: a wide open mouth, dark inside, with just two bars of teeth (top and bottom), clear at phone size
        const w = mw * 0.62;
        pen.rect(x - w - 0.8, y - 3.6, w * 2 + 1.6, 7.6, 2.8, c);
        pen.rect(x - w, y - 2.8, w * 2, 6, 2.2, ND.mouthInside);
        pen.rect(x - w + 0.5, y - 2.8, w * 2 - 1, 1.9, 0.7, ND.teeth);
        pen.rect(x - w + 0.5, y + 1.4, w * 2 - 1, 1.8, 0.7, ND.teeth);
        return;
      }
      pen.line(pts, lw * 1.25, c);
      return;
    }
    case "grin":
    case "laugh": {
      const laugh = m === "laugh";
      const h = mw * (laugh ? 1.08 : 0.74) * clamp(open, 0.3, 1.3);
      openMouth(pen, x, y - 0.5, mw * (laugh ? 1.02 : 0.9), h * 0.13, h, Math.max(0.55, ow), laugh, fk);
      return;
    }
    case "o": {
      const k = clamp(open, 0.5, 1.3);
      pen.ellipse(x, y + 1, 2.3 + 0.6, 2.9 * k + 0.6, 0, c);
      pen.ellipse(x, y + 1, 2.3, 2.9 * k, 0, ND.mouthInside);
      return;
    }
    case "bigo": {
      const k = clamp(open, 0.5, 1.3);
      const oval = ellipsePts(x, y + 1.6, 3.7, 5.3 * k, 18 * fk);
      pen.ellipse(x, y + 1.6, 3.7 + 0.65, 5.3 * k + 0.65, 0, c);
      pen.poly(oval, ND.mouthInside);
      pen.poly(clipConvex(ellipsePts(x, y + 1.6 + 5.3 * k * 0.86, 2.6, 5.3 * k * 0.42, 12 * fk), oval), ND.tongue);
      return;
    }
    case "hum": {
      // closed lips, humming: a soft curve that hums up and down, never open, with a tick at each corner
      const w = mw * 0.62;
      const up = 0.9 * clamp(open, 0, 1);
      pen.line([x - w - 0.8, y + 0.1 - up * 0.3, ...quadPts(x - w, y + 1, x, y + 1.7 + up, x + w, y + 1, 6 * fk), x + w + 0.8, y + 0.1 - up * 0.3], lw, c);
      return;
    }
    case "grit": {
      // gritted teeth: a band of teeth in a dark rim, the bite line with two gaps as one stroke
      const gw = mw * 1.22;
      pen.rect(x - gw - 0.8, y - 3.1, gw * 2 + 1.6, 6.2, 2.4, c);
      pen.rect(x - gw, y - 2.3, gw * 2, 4.6, 1.6, ND.teeth);
      pen.line([x - gw * 0.94, y, x + gw * 0.94, y], Math.max(0.5, ow * 0.8), ND.mouthInside, 0.85);
      return;
    }
  }
}

function extraNight(pen: Pen, x: Extra, rx: number, ry: number, t: number, seed: number, fx: number, ey: number): void {
  const sweat = "#7fb2d9";
  switch (x) {
    case "sweat":
    case "sweat2": {
      // one or two big drops sliding down beside the forehead: their rims, the drops and a glint are a shape each
      const rims: number[][] = [];
      const drops: number[][] = [];
      const glints: number[][] = [];
      for (let i = 0; i < (x === "sweat2" ? 2 : 1); i += 1) {
        const slide = ((t * 0.8 + i * 0.45 + rand(seed, 20 + i)) % 1) * 7;
        const dx = (i === 0 ? -1 : 1) * rx * 0.95;
        const dy = -ry * 0.42 + slide;
        rims.push(dropPts(dx, dy, 4, 8.2));
        drops.push(dropPts(dx, dy, 3.3, 7));
        glints.push(ellipsePts(dx - 1.1, dy - 0.2, 0.9, 1.3, 6, 20));
      }
      pen.poly(joinShapes(rims), cel(sweat, 0.4));
      pen.poly(joinShapes(drops), sweat);
      pen.poly(joinShapes(glints), ND.glint, 0.85);
      return;
    }
    case "tear": {
      // a tear from the front eye: its track down the cheek and the drop, one shape
      const slide = ((t * 0.6 + rand(seed, 30)) % 1) * 7;
      const ex = fx + rx * 0.4;
      pen.poly(joinShapes([ribbonPts([ex - 0.4, ey + 3.6, ex - 0.9, ey + 5 + slide], 1.3, 1), dropPts(ex - 0.9, ey + 7.2 + slide, 2, 4)]), sweat, 0.92);
      return;
    }
    case "stars": {
      const rims: number[][] = [];
      const stars: number[][] = [];
      for (let i = 0; i < 3; i += 1) {
        const a = (t * 160 + i * 120) * DEG;
        const sx = Math.cos(a) * rx * 0.95;
        const sy = -ry - 9 + Math.sin(a) * 3.5;
        rims.push(starPts(sx, sy, 4.9, 2.3, 5, t * 90));
        stars.push(starPts(sx, sy, 3.8, 1.7, 5, t * 90));
      }
      pen.poly(joinShapes(rims), cel("#d9a441", 0.4));
      pen.poly(joinShapes(stars), "#e6b24a");
      return;
    }
    case "vein": {
      // the angry mark: four bent strokes round a gap, beating
      const k = 1 + 0.15 * Math.sin(t * 9);
      const vx = rx * 0.72;
      const vy = -ry * 0.58;
      const a = 4.3 * k;
      const b = a * 0.34;
      const marks = [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ].map(([sx, sy]) => ribbonPts([vx + sx! * a, vy + sy! * b, vx + sx! * b, vy + sy! * b, vx + sx! * b, vy + sy! * a], 1.5, 2));
      pen.poly(joinShapes(marks), "#d24a38");
      return;
    }
    case "shock": {
      // three short thick rays above the head
      const rays = [-128, -90, -52].map((deg) => {
        const c = Math.cos(deg * DEG);
        const s = Math.sin(deg * DEG);
        const r0 = ry + 9;
        const r1 = ry + 14 + Math.sin(t * 14) * 0.8;
        return capsulePts(c * r0 * (rx / ry), s * r0, 0.95, c * r1 * (rx / ry), s * r1, 0.7, 3);
      });
      pen.poly(joinShapes(rays), ND.ink);
      return;
    }
    case "sparkle": {
      const k = 0.6 + 0.4 * Math.abs(Math.sin(t * 3.4));
      pen.poly(starPts(rx * 1.08, -ry * 0.7, 7.8 * k, 2.1 * k, 4, 0), ND.halo1, 0.95);
      return;
    }
    case "puff":
      // relief: one clear sweat drop at the temple (the same drop as a worried face's)
      extraNight(pen, "sweat", rx, ry, t, seed, fx, ey);
      return;
  }
}
