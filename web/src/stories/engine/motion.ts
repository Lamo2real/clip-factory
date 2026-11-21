// Lamo Stories engine: how characters move. Every ActionId is a pose over time; movement styles change the timing
// curves (bouncy overshoots, calm eases, clumsy wobbles, zippy is quick, heavy settles slowly). Beats layer: each
// active beat is blended over the pose under it, so a walk and a wave can play at once.

import { TAU, clamp, clamp01, ease, lerp, noise, smoothstep, type Ease } from "./math.ts";
import { FACES, NOISE_MOUTH, type FaceParams } from "./face.ts";
import { blendPose, reach, REST, wheelGrips, type Geo, type Pose } from "./rig.ts";
import type { ActionId, Beat, Expression, MovementStyle, NoiseId } from "./types.ts";

export interface Style {
  /** speed of cycles (walks, waves, dances) */
  sp: number;
  /** size of moves */
  am: number;
  /** squash and stretch */
  squash: number;
  rampIn: number;
  rampOut: number;
  /** how a move comes in (may overshoot) */
  enter: Ease;
  /** how a character travels to a `to` point */
  travel: Ease;
  wobble: number;
  idleHz: number;
  hop: number;
}

export const STYLES: Record<MovementStyle, Style> = {
  bouncy: { sp: 1.15, am: 1.15, squash: 1.6, rampIn: 0.22, rampOut: 0.24, enter: ease.outBack, travel: ease.inOutQuad, wobble: 0, idleHz: 1.5, hop: 1 },
  calm: { sp: 0.85, am: 0.82, squash: 0.6, rampIn: 0.38, rampOut: 0.42, enter: ease.inOutSine, travel: ease.inOutSine, wobble: 0, idleHz: 0.8, hop: 0 },
  clumsy: {
    sp: 1,
    am: 1.1,
    squash: 1.1,
    rampIn: 0.26,
    rampOut: 0.3,
    enter: (t) => ease.outBack(t) * 0.7 + ease.outQuad(t) * 0.3,
    travel: ease.inOutQuad,
    wobble: 1,
    idleHz: 1.1,
    hop: 0.25,
  },
  zippy: { sp: 1.45, am: 1, squash: 1, rampIn: 0.1, rampOut: 0.12, enter: ease.outExpo, travel: ease.outExpo, wobble: 0, idleHz: 1.9, hop: 0.2 },
  heavy: { sp: 0.72, am: 0.92, squash: 1.35, rampIn: 0.42, rampOut: 0.5, enter: ease.heavy, travel: ease.inOutCubic, wobble: 0, idleHz: 0.65, hop: 0 },
};

export type RestState = "stand" | "sit" | "lie";

/** Actions that move the whole body and leave the character standing afterwards. */
const STANDING: Set<ActionId> = new Set(["walk", "run", "jump", "celebrate", "dance", "slip", "cower", "get_up"]);
const SELF_BLEND: Set<ActionId> = new Set(["sit", "fall", "get_up"]);
export const DRIVING: Set<ActionId> = new Set(["drive", "steer_left", "steer_right", "brake"]);
const TRAVELLERS: Set<ActionId> = new Set(["walk", "run"]);

/** The face an action shows when its beat names none (only while the beat plays). */
const IMPLIED: Partial<Record<ActionId, Expression>> = {
  gasp: "shocked",
  cower: "scared",
  celebrate: "happy",
  dance: "happy",
  think: "thinking",
  facepalm: "sad",
  slip: "shocked",
  fall: "shocked",
  brace: "scared",
  brake: "determined",
  thumbs_up: "happy",
  wave: "happy",
  shake_head: "worried",
  nod: "happy",
  jump: "happy",
};

export interface Ctx {
  g: Geo;
  st: Style;
  seed: number;
  /** scene time */
  t: number;
  tau: number;
  dur: number;
  /** +1 forward, -1 backwards (local), from the beat's screen direction */
  dirLocal: number;
  /** the side the character faces on screen (-1 left, 1 right): screen-side actions turn it into local */
  facing: number;
  /** units walked since the beat started (keeps feet from sliding) */
  walked: number;
  inCar: boolean;
}

export function restPose(state: RestState, t: number, st: Style, seed: number, g: Geo, inCar: boolean): Pose {
  const p: Pose = { ...REST };
  const breath = Math.sin(TAU * st.idleHz * 0.55 * t + (seed % 7));
  p.sy = 1 + 0.012 * st.squash * breath;
  p.sx = 1 - 0.006 * st.squash * breath;
  p.aB += 2 * Math.sin(TAU * 0.4 * t + 1);
  p.aF -= 2 * Math.sin(TAU * 0.4 * t + 1);
  p.head = 1.6 * Math.sin(TAU * 0.27 * t + (seed % 5));
  p.lookX = 0.15 + 0.3 * noise(seed + 5, t * 0.35);
  p.lookY = 0.12 * noise(seed + 6, t * 0.3);
  if (st.hop > 0.5) p.dy = -0.7 * Math.abs(Math.sin(TAU * st.idleHz * 0.5 * t));
  if (st.wobble > 0) p.rot = 1.8 * noise(seed + 7, t * 0.8);
  if (inCar) return drivePose(p, g, 0, t);
  if (state === "sit") return seated(p, g);
  if (state === "lie") return lying(p, t);
  return p;
}

function seated(p: Pose, g: Geo): Pose {
  return { ...p, dy: g.thigh, hF: 84, kF: -84, hB: 78, kB: -78, aF: 32, eF: 44, aB: 26, eB: 40, seat: 1, sy: 1, sx: 1 };
}

function lying(p: Pose, t: number): Pose {
  const b = 0.01 * Math.sin(TAU * 0.4 * t);
  return { ...p, rot: -90, dy: -15, sx: 1, sy: 1 + b, aF: 128, eF: 20, aB: -128, eB: -20, hF: 18, kF: -26, hB: 8, kB: -12, head: -6, lookY: -0.6 };
}

function drivePose(p: Pose, g: Geo, wheelRot: number, t: number): Pose {
  const grips = wheelGrips(g, wheelRot);
  const [aF, eF] = reach(g.shoulderX, g.shoulderY, grips.f[0], grips.f[1], g.upper, g.fore, -1);
  const [aB, eB] = reach(-g.shoulderX, g.shoulderY, grips.b[0], grips.b[1], g.upper, g.fore, 1);
  return {
    ...seated(p, g),
    aF,
    eF,
    aB,
    eB,
    wheel: 1,
    wheelRot,
    armsFront: 1,
    dy: g.thigh + 0.5 * Math.sin(TAU * 2.7 * t),
    turn: 0.45,
    handF: "fist",
    handB: "fist",
  };
}

/** Hands on a steering wheel: in a car the character sits; a mimed drive keeps the legs as they are. */
function driving(from: Pose, c: Ctx, wheelRot: number): Pose {
  const d = drivePose(from, c.g, wheelRot, c.t);
  if (c.inCar) return d;
  return { ...d, dy: from.dy, seat: from.seat, sx: from.sx, sy: from.sy, hF: from.hF, kF: from.kF, hB: from.hB, kB: from.kB, turn: 0.4 };
}

function walkCycle(p: Pose, c: Ctx, run: boolean): Pose {
  const st = c.st;
  const stride = run ? 30 : 24;
  let phase = c.walked > 0.01 ? c.walked / stride : c.tau * (run ? 2.4 : 1.6) * st.sp;
  if (st.wobble > 0) phase += 0.06 * Math.sin(TAU * 0.7 * c.t);
  const s = Math.sin(TAU * phase);
  const co = Math.cos(TAU * phase);
  const A = (run ? 42 : 26) * st.am;
  const K = run ? 72 : 34;
  const q: Pose = { ...p, seat: 0, rot: 0, sx: 1, sy: 1 };
  q.hF = A * s;
  q.hB = -A * s;
  q.kF = -K * Math.max(0, co) * st.am;
  q.kB = -K * Math.max(0, -co) * st.am;
  q.aF = -(run ? 40 : 24) * s * st.am + (run ? 20 : 6);
  q.aB = (run ? 40 : 24) * s * st.am - (run ? 10 : 6);
  q.eF = run ? 80 : 18;
  q.eB = run ? 80 : 16;
  const L = c.g.thigh + c.g.shin;
  const stance = co > 0 ? q.hB : q.hF;
  q.dy = L * (1 - Math.cos((stance * Math.PI) / 180)) - (run ? 3.2 : 1.4) * Math.abs(co) * st.am;
  if (st.hop > 0) q.dy -= st.hop * (run ? 3 : 2.4) * Math.abs(co);
  q.lean = run ? 11 : 4;
  q.head = (run ? -3 : -1) + 2 * Math.sin(TAU * phase * 2);
  q.turn = 0.5;
  q.lookX = 0.6;
  if (st.wobble > 0) q.rot = 4 * noise(c.seed + 9, c.t * 2.2);
  if (st.squash > 1.3) q.sy = 1 - 0.03 * Math.abs(co);
  return q;
}

/** An arm reaching to (tx, ty), stretching like a rubber hose when the point is out of reach (local units). */
function armTo(g: Geo, side: 1 | -1, tx: number, ty: number, elbowOut: 1 | -1): { a: number; e: number; len: number } {
  const sx = side * g.shoulderX;
  const d = Math.hypot(tx - sx, ty - g.shoulderY);
  const len = clamp((d / (g.upper + g.fore)) * 1.04, 1, 1.5);
  const [a, e] = reach(sx, g.shoulderY, tx, ty, g.upper * len, g.fore * len, elbowOut);
  return { a, e, len };
}

/** Both hands up beside the head (not over the face): cheering, jumping, dancing. */
function armsUp(q: Pose, g: Geo, lift: number, spreadB: number, spreadF: number): Pose {
  const hy = g.headY - g.headRY * 0.15 * lift;
  const f = armTo(g, 1, g.headRX + 5 + spreadF, hy, -1);
  const b = armTo(g, -1, -(g.headRX + 5 + spreadB), hy, 1);
  return { ...q, aF: f.a, eF: f.e, lenF: f.len, aB: b.a, eB: b.e, lenB: b.len, overFace: 1 };
}

function osc(c: Ctx, hz: number, phase = 0): number {
  return Math.sin(TAU * hz * c.st.sp * c.tau + phase);
}

export function actionPose(id: ActionId, from: Pose, c: Ctx, restAfter: () => Pose): Pose {
  const g = c.g;
  const st = c.st;
  const p = c.dur > 0 ? clamp01(c.tau / c.dur) : 1;
  const q: Pose = { ...from };
  switch (id) {
    case "idle":
      return q;
    case "walk":
      return walkCycle(from, c, false);
    case "run":
      return walkCycle(from, c, true);
    case "jump": {
      const T = c.dur;
      const crouch = Math.min(0.22, T * 0.2);
      const land = Math.min(0.3, T * 0.25);
      const air = Math.max(0.1, T - crouch - land);
      if (c.tau < crouch) {
        const k = ease.outQuad(c.tau / crouch);
        return { ...q, seat: 0, dy: 5 * k, sy: 1 - 0.12 * k * st.squash, sx: 1 + 0.06 * k * st.squash, hF: 30 * k, kF: -60 * k, hB: 24 * k, kB: -50 * k, aF: -30 * k, aB: -40 * k, lean: 8 * k };
      }
      if (c.tau < crouch + air) {
        const a = (c.tau - crouch) / air;
        const h = 24 * st.am * 4 * a * (1 - a);
        return { ...armsUp(q, g, 1, 2, 2), seat: 0, dy: -h, sy: 1 + 0.09 * st.squash * (1 - a), sx: 1 - 0.04 * st.squash * (1 - a), hF: 18, kF: -40, hB: -10, kB: -30, lean: -2, lookY: -0.4 };
      }
      const k = (c.tau - crouch - air) / land;
      const squash = (1 - st.enter(k)) * 0.16 * st.squash;
      return blendPose({ ...armsUp(q, g, 1, 2, 2), seat: 0, dy: 3, sy: 1 - squash, sx: 1 + squash * 0.5, hF: 18, kF: -40 }, { ...q, seat: 0, sy: 1 - squash, sx: 1 + squash * 0.5 }, ease.outQuad(k));
    }
    case "wave": {
      const sw = osc(c, 2.6);
      const f = armTo(g, 1, g.headRX + 8 + 5 * sw, g.headY - g.headRY * 0.25 + 2 * Math.abs(sw), -1);
      return { ...q, aF: f.a, eF: f.e, lenF: f.len, handF: "open", overFace: 1, head: q.head + 5, lean: q.lean - 2, turn: 0.45 };
    }
    case "point": {
      const d = c.dirLocal;
      if (d < 0) return { ...q, aB: -92, eB: 0, handB: "point", lean: q.lean - 3, turn: -0.5, lookX: -0.9 };
      return { ...q, aF: 92, eF: 0, handF: "point", lean: q.lean + 4, turn: 0.65, lookX: 0.9 };
    }
    case "shrug": {
      const k = Math.sin(Math.PI * smoothstep(0, 0.35, p)) * 0.3 + 0.7;
      return { ...q, aF: 40, eF: 76 * k, aB: -40, eB: -76 * k, handF: "open", handB: "open", head: 9 * Math.sin(Math.PI * p), sy: q.sy * 0.98, lookY: -0.2 };
    }
    case "facepalm": {
      const f = armTo(g, 1, g.headRX * 0.22, g.headY + g.headRY * 0.05, 1);
      return { ...q, aF: f.a, eF: f.e, lenF: f.len, handF: "open", overFace: 1, head: 12, nod: 0.6, lean: q.lean + 5 };
    }
    case "celebrate": {
      const hop = Math.abs(Math.sin(TAU * 1.7 * st.sp * c.tau));
      const pump = osc(c, 3.4);
      return {
        ...armsUp(q, g, 1.6 + 0.6 * pump, 3 + 2 * pump, 3 + 2 * pump),
        seat: 0,
        dy: -9 * st.am * hop,
        sy: 1 + 0.05 * st.squash * (hop - 0.5),
        hF: 10 * hop,
        kF: -24 * hop,
        hB: -6 * hop,
        kB: -20 * hop,
        handF: "fist",
        handB: "fist",
        lookY: -0.4,
      };
    }
    case "cower": {
      const f = armTo(g, 1, g.headRX * 0.45, g.headY + g.headRY * 0.3, 1);
      const b = armTo(g, -1, -g.headRX * 0.1, g.headY + g.headRY * 0.55, -1);
      return { ...q, seat: 0, dy: 6, hF: 34, kF: -68, hB: 24, kB: -58, lean: -7, aF: f.a, eF: f.e, lenF: f.len, aB: b.a, eB: b.e, lenB: b.len, handF: "open", handB: "open", overFace: 1, tremble: 0.7, head: -4, sy: 0.96 };
    }
    case "sit": {
      const k = st.enter(Math.min(1, c.tau / Math.max(0.2, Math.min(0.7, c.dur * 0.6))));
      return blendPose(from, restAfter(), k);
    }
    case "drive":
      return driving(from, c, 6 * Math.sin(TAU * 0.5 * c.tau));
    case "steer_left":
    case "steer_right": {
      // the wheel turns towards the screen side named by the action
      const k = Math.pow(Math.sin(Math.PI * clamp01(p)), 0.6);
      const side = (id === "steer_left" ? -1 : 1) * c.facing;
      return { ...driving(from, c, 75 * side * k), lean: 7 * side * k, head: 5 * side * k, lookX: side };
    }
    case "brake": {
      const k = Math.pow(Math.sin(Math.PI * clamp01(p * 1.2)), 0.5);
      return { ...driving(from, c, 0), lean: -11 * k, head: -6 * k };
    }
    case "brace":
      return { ...q, aF: 80, eF: 6, aB: 72, eB: 6, handF: "open", handB: "open", armsFront: 1, lean: -9, nod: 0.4, tremble: 0.3, head: -5 };
    case "look_left":
    case "look_right": {
      const side = (id === "look_left" ? -1 : 1) * c.facing;
      return { ...q, turn: 0.85 * side, lookX: side, head: 4 * side, lean: q.lean + 2 * side };
    }
    case "nod":
      return { ...q, nod: 0.55 * (1 - Math.cos(TAU * 2.2 * st.sp * c.tau)), head: q.head + 4 * Math.sin(TAU * 2.2 * st.sp * c.tau) };
    case "shake_head": {
      const s = osc(c, 2.6);
      return { ...q, turn: 0.75 * s, head: 5 * s, lookX: s };
    }
    case "thumbs_up":
      return { ...q, aF: 50, eF: 86, handF: "thumb", lean: q.lean + 3, turn: 0.4, head: 4 };
    case "slip": {
      const w = c.tau * 360 * 2.6 * st.sp;
      return {
        ...q,
        seat: 0,
        hF: 15 + 48 * osc(c, 3.6),
        kF: -10,
        hB: 15 - 48 * osc(c, 3.6),
        kB: -10,
        aF: 140 + 70 * Math.sin((w * Math.PI) / 180),
        eF: 20,
        aB: -140 - 70 * Math.sin(((w + 90) * Math.PI) / 180),
        eB: -20,
        rot: -10 + 10 * osc(c, 2.1),
        lean: -9,
        dy: -2,
        handF: "open",
        handB: "open",
        overFace: 1,
      };
    }
    case "fall": {
      const T = c.dur;
      const tilt = Math.min(0.28, T * 0.3);
      const drop = Math.min(0.32, T * 0.3);
      const after = restAfter();
      if (c.tau < tilt) {
        const k = ease.outQuad(c.tau / tilt);
        return { ...q, seat: 0, rot: -12 * k, lean: -6 * k, aF: lerp(q.aF, 140, k), aB: lerp(q.aB, -140, k), eF: 20, eB: -20, hF: 20 * k, handF: "open", handB: "open", overFace: 1 };
      }
      if (c.tau < tilt + drop) {
        const k = ease.inQuad((c.tau - tilt) / drop);
        return blendPose({ ...q, seat: 0, rot: -12, lean: -6, aF: 140, aB: -140, eF: 20, eB: -20, hF: 20, handF: "open", handB: "open" }, after, k);
      }
      const k = (c.tau - tilt - drop) / Math.max(0.2, T - tilt - drop);
      const bounce = Math.exp(-6 * k) * Math.sin(k * 18) * 6 * st.squash;
      return { ...after, rot: after.rot + bounce, sy: after.sy - 0.05 * Math.exp(-8 * k) * st.squash };
    }
    case "get_up": {
      const after = restAfter();
      if (from.rot > -45) {
        const k = Math.sin(Math.PI * clamp01(p));
        return { ...after, dy: 4 * k, hF: 26 * k, kF: -52 * k, hB: 20 * k, kB: -44 * k, sy: 1 - 0.05 * k };
      }
      const mid: Pose = { ...from, rot: -40, dy: -4, hF: 70, kF: -110, hB: 60, kB: -100, aF: 40, eF: 30, aB: -20, eB: 10, lean: 10 };
      if (p < 0.5) return blendPose(from, mid, st.enter(p / 0.5));
      return blendPose(mid, after, ease.inOutSine((p - 0.5) / 0.5));
    }
    case "dance": {
      const hz = 1.6 * st.sp;
      const s = Math.sin(TAU * hz * c.tau);
      const s2 = Math.abs(Math.sin(TAU * hz * 2 * c.tau));
      const up = armsUp(q, g, 1, 2, 2);
      const down = { ...q, aF: 50, eF: 70, aB: -50, eB: -70 };
      const kf = 0.5 + 0.5 * s;
      return {
        ...q,
        seat: 0,
        dx: 4 * s * st.am,
        rot: 6 * s * st.am,
        dy: -3 * s2 * st.am,
        aF: lerp(down.aF, up.aF, kf),
        eF: lerp(down.eF, up.eF, kf),
        lenF: lerp(1, up.lenF, kf),
        aB: lerp(up.aB, down.aB, kf),
        eB: lerp(up.eB, down.eB, kf),
        lenB: lerp(up.lenB, 1, kf),
        hF: 14 * s,
        kF: -22 * Math.max(0, s),
        hB: -14 * s,
        kB: -22 * Math.max(0, -s),
        head: 8 * Math.sin(TAU * hz * c.tau + 0.6),
        handF: "open",
        handB: "open",
        overFace: 1,
      };
    }
    case "think": {
      const [aF, eF] = reach(g.shoulderX, g.shoulderY, g.headRX * 0.32, g.headY + g.headRY * 0.92, g.upper, g.fore, 1);
      return { ...q, aF, eF, handF: "fist", overFace: 1, head: 8 + 2 * osc(c, 0.5), lookY: -0.8, lookX: 0.5 };
    }
    case "gesture": {
      const k = 0.5 - 0.5 * Math.cos(TAU * 1.1 * st.sp * c.tau);
      return { ...q, aF: 40 + 55 * k, eF: 60 - 45 * k, handF: "open", aB: -18, nod: 0.25 * k, lean: q.lean + 3 * k, turn: 0.4 };
    }
    case "gasp": {
      const k = smoothstep(0, 0.18, c.tau);
      const f = armTo(g, 1, g.headRX + 3, g.headY + g.headRY * 0.35, -1);
      const b = armTo(g, -1, -g.headRX - 3, g.headY + g.headRY * 0.35, 1);
      return { ...q, aF: f.a, eF: f.e, lenF: f.len, aB: b.a, eB: b.e, lenB: b.len, handF: "open", handB: "open", overFace: 1, sy: q.sy * (1 + 0.07 * k * st.squash), dy: q.dy - 2 * k, tremble: 0.2, lean: q.lean - 3 };
    }
  }
  return q;
}

// ---- the actor's timeline -----------------------------------------------------------------------------------

export interface ActorState {
  /** 0..1 of the frame */
  x: number;
  y: number;
  /** -1 or 1, the side the character faces now */
  facing: number;
  /** horizontal mirror scale during a quick turn (from -1 to 1) */
  flip: number;
  pose: Pose;
  face: FaceParams;
  expression: Expression;
  /** normalized units per second */
  speed: number;
  /** extras around the character this frame */
  extras: { confetti: number; notes: number; speed: number; dust: number };
  /** the active beats (for bubbles and car effects) */
  active: Beat[];
}

export interface ActorInput {
  castId: string;
  x: number;
  y: number;
  facing: "left" | "right";
  inCar?: string;
}

const WALK_SPEED = { walk: 0.16, run: 0.34 } as const;

/** Where the actor is (0..1) and which way it faces at time t; walks follow `to`. */
export function actorPath(actor: ActorInput, beats: Beat[], style: Style, t: number): { x: number; y: number; facing: number; flipFrom: number; flipAt: number; speed: number; walked: number } {
  let x = actor.x;
  let y = actor.y;
  let facing = actor.facing === "left" ? -1 : 1;
  let flipFrom = facing;
  let flipAt = -99;
  let speed = 0;
  let walked = 0;
  for (const b of beats) {
    if (b.at > t) break;
    const setFacing = (f: number) => {
      if (f !== facing) {
        flipFrom = facing;
        flipAt = b.at;
        facing = f;
      }
    };
    if (b.dir) setFacing(b.dir === "left" ? -1 : 1);
    let to = b.to;
    if (!to && TRAVELLERS.has(b.do as ActionId) && !actor.inCar) {
      const v = WALK_SPEED[b.do as "walk" | "run"] * style.sp;
      to = { x: clamp(x + facing * v * b.dur, 0.08, 0.92), y };
    }
    if (!to || actor.inCar) continue;
    if (!b.dir && Math.abs(to.x - x) > 0.005) setFacing(to.x < x ? -1 : 1);
    const p = b.dur > 0 ? clamp01((t - b.at) / b.dur) : 1;
    const k = style.travel(p);
    const nx = lerp(x, to.x, k);
    const ny = lerp(y, to.y, k);
    if (p < 1) {
      const dk = (style.travel(Math.min(1, p + 0.02)) - style.travel(Math.max(0, p - 0.02))) / 0.04;
      speed = (Math.hypot(to.x - x, to.y - y) * dk) / Math.max(0.05, b.dur);
      walked = Math.hypot(nx - x, (ny - y) * (16 / 9));
    } else speed = 0;
    x = nx;
    y = ny;
  }
  return { x, y, facing, flipFrom, flipAt, speed, walked };
}

export function restStateAt(beats: Beat[], t: number): RestState {
  let s: RestState = "stand";
  for (const b of beats) {
    if (b.at + b.dur > t) continue;
    const id = b.do as ActionId;
    if (id === "sit") s = "sit";
    else if (id === "fall") s = "lie";
    else if (STANDING.has(id)) s = "stand";
  }
  return s;
}

function restStateBefore(beats: Beat[], beat: Beat): RestState {
  let s: RestState = "stand";
  for (const b of beats) {
    if (b === beat) break;
    if (b.at + b.dur > beat.at) continue;
    const id = b.do as ActionId;
    if (id === "sit") s = "sit";
    else if (id === "fall") s = "lie";
    else if (STANDING.has(id)) s = "stand";
  }
  return s;
}

/** Everything about one character at scene time t. `px` converts local units to output pixels (for walk phases). */
export function actorState(actor: ActorInput, beats: Beat[], style: Style, g: Geo, seed: number, t: number, unitsPerFrameWidth: number): ActorState {
  const path = actorPath(actor, beats, style, t);
  const inCar = !!actor.inCar;
  const restNow = restStateAt(beats, t);
  let pose = restPose(restNow, t, style, seed, g, inCar);
  let expression: Expression = "neutral";
  let implied: Expression | null = null;
  const active: Beat[] = [];
  for (const b of beats) {
    if (b.at > t) break;
    if (b.face) expression = b.face;
    if (t < b.at + b.dur) active.push(b);
  }
  for (const b of active) {
    const id = b.do as ActionId;
    const tau = t - b.at;
    const before = restStateBefore(beats, b);
    const afterState: RestState = id === "sit" ? "sit" : id === "fall" ? "lie" : STANDING.has(id) ? "stand" : before;
    const from = pose;
    const ctx: Ctx = {
      g,
      st: style,
      seed,
      t,
      tau,
      dur: b.dur,
      dirLocal: b.dir ? (b.dir === "left" ? -1 : 1) * path.facing : 1,
      facing: path.facing,
      walked: TRAVELLERS.has(id) ? path.walked * unitsPerFrameWidth : 0,
      inCar,
    };
    const target = actionPose(id, from, ctx, () => restPose(afterState, t, style, seed, g, inCar));
    if (SELF_BLEND.has(id)) {
      pose = target;
    } else {
      const rin = Math.max(0.05, Math.min(style.rampIn, b.dur * 0.35));
      const rout = Math.max(0.05, Math.min(style.rampOut, b.dur * 0.35));
      const wIn = style.enter(tau / rin);
      const wOut = 1 - ease.inOutSine((tau - (b.dur - rout)) / rout);
      pose = blendPose(pose, target, Math.min(wIn, wOut));
    }
    if (!b.face && IMPLIED[id]) implied = IMPLIED[id]!;
    if (id === "fall" && tau > Math.min(0.6, b.dur * 0.6) && !b.face) implied = "dizzy";
  }
  // after a fall, a character lying down looks dizzy unless the story says otherwise
  if (!implied && restNow === "lie" && expression === "neutral") implied = "dizzy";
  const exprShown = implied ?? expression;
  let face: FaceParams = FACES[exprShown] ?? FACES.neutral;
  // talking: a noise moves the mouth while it plays
  for (const b of beats) {
    if (b.at > t || !b.noise) continue;
    const m = NOISE_MOUTH[b.noise as NoiseId];
    if (!m || t >= b.at + m.dur) continue;
    const local = t - b.at;
    const flap = m.flap > 0 ? 0.55 + 0.45 * Math.abs(Math.sin(TAU * m.flap * 0.5 * local)) : 1;
    face = { ...face, mouth: m.mouth, mouthOpen: flap * (1 - smoothstep(m.dur * 0.7, m.dur, local) * 0.6) };
  }
  if (style.wobble > 0 && !inCar) pose = { ...pose, aF: pose.aF + 5 * noise(seed + 2, t * 1.9), aB: pose.aB + 5 * noise(seed + 3, t * 1.7) };
  // a quick cartoon turn when the facing side changes
  const turnDur = 0.18 / style.sp;
  const fp = clamp01((t - path.flipAt) / turnDur);
  const flip = fp >= 1 ? path.facing : path.flipFrom * Math.cos(Math.PI * fp);
  const ids = active.map((b) => b.do);
  const dust = beats.reduce((best, b) => {
    if (b.do !== "fall" && b.do !== "jump") return best;
    const land = b.do === "fall" ? b.at + Math.min(0.6, b.dur * 0.6) : b.at + b.dur - Math.min(0.3, b.dur * 0.25);
    const since = t - land;
    return since >= 0 && since < 0.8 ? since : best;
  }, -1);
  return {
    x: path.x,
    y: path.y,
    facing: path.facing,
    flip: Math.abs(flip) < 0.08 ? 0.08 * Math.sign(flip || path.facing) : flip,
    pose,
    face,
    expression: exprShown,
    speed: path.speed,
    extras: {
      confetti: ids.includes("celebrate") ? 1 : 0,
      notes: ids.includes("dance") ? 1 : 0,
      speed: path.speed > 0.22 || (style.sp > 1.3 && path.speed > 0.08) ? clamp01(path.speed * 3) : 0,
      dust,
    },
    active,
  };
}
