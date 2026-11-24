// Lamo Stories engine: cameras. A camera is a centre, a zoom, a little roll and a shake, applied as one transform to
// every prim of a layer. Layers further away (depth < 1) move and zoom less: light parallax. Everything is in the
// frame's design px (frame.ts), so each shape frames its shots the same way: a close shot's face is about 40% of
// the short side in every shape. The shots inside a scene (CONTRACTS §45.45 §8.2) have their own framing: the scene's
// camera only zooms into the shot's focus, sways it, pushes in or shakes it, and each cut gets the same settle.

import { F } from "./frame.ts";
import { clamp, clamp01, ease, lerp, noise } from "./math.ts";
import type { Mat } from "./pen.ts";
import type { CameraId } from "./types.ts";

export interface Cam {
  cx: number;
  cy: number;
  zoom: number;
  rot: number;
  shakeX: number;
  shakeY: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Focus {
  /** the box around what the shot is about (world px) */
  box: Box | null;
  /** the main character's face (world px) and its radius, for close shots */
  face: { x: number; y: number; r: number } | null;
}

/** Clamp the centre so the view stays on the drawn world. */
function keep(c: number, half: number, lo: number, hi: number): number {
  const a = lo + half;
  const b = hi - half;
  return a > b ? (lo + hi) / 2 : clamp(c, a, b);
}

/** The scene's camera at scene time t. `since` is the time since the shot began (a cut back to the whole scene settles
 * again); a scene without cuts leaves it out, so its camera is exactly as before. */
export function cameraAt(id: CameraId, t: number, dur: number, focus: Focus, seed: number, impacts: number[], since: number = t): Cam {
  const W = F.w;
  const H = F.h;
  const box = focus.box ?? { x0: W * 0.3, y0: H * 0.45, x1: W * 0.7, y1: H * 0.75 };
  const bx = (box.x0 + box.x1) / 2;
  const by = (box.y0 + box.y1) / 2;
  const bw = Math.max(120, box.x1 - box.x0);
  const bh = Math.max(160, box.y1 - box.y0);
  const fit = clamp(Math.min((W * 0.78) / bw, (H * 0.5) / bh), 1.22, 1.6);
  const p = dur > 0 ? clamp01(t / dur) : 0;
  let cx = W / 2;
  let cy = H / 2;
  let zoom = 1;
  let shake = 0;
  switch (id) {
    case "wide":
      break;
    case "medium":
      zoom = fit;
      cx = bx;
      cy = by + (0.5 - 0.45) * (H / zoom);
      break;
    case "close": {
      // the face fills about 40% of the short side
      const f = focus.face ?? { x: bx, y: box.y0 + bh * 0.25, r: 110 };
      zoom = clamp(225 / Math.max(20, f.r), 1.6, 3.4);
      cx = f.x;
      cy = f.y + (0.5 - 0.4) * (H / zoom);
      break;
    }
    case "pan_left":
    case "pan_right": {
      zoom = 1.22;
      const k = ease.inOutSine(p);
      const from = id === "pan_left" ? W * 0.68 : W * 0.32;
      const to = id === "pan_left" ? W * 0.32 : W * 0.68;
      cx = lerp(from, to, k);
      cy = lerp(H / 2, by, 0.35);
      break;
    }
    case "shake":
      zoom = 1.1;
      cx = lerp(W / 2, bx, 0.5);
      cy = lerp(H / 2, by, 0.4);
      shake = 11;
      break;
    case "push_in": {
      const k = ease.inOutSine(p);
      zoom = lerp(1, Math.max(1.5, fit), k);
      cx = lerp(W / 2, bx, k);
      cy = lerp(H / 2, by + (0.5 - 0.45) * (H / zoom), k);
      break;
    }
  }
  // a tiny settle after each cut keeps the cuts lively
  zoom *= 1 + 0.035 * (1 - ease.outCubic(since / 0.4));
  for (const at of impacts) {
    const since = t - at;
    if (since >= 0 && since < 0.7) shake += 20 * Math.exp(-since * 7);
  }
  const halfW = W / (2 * zoom);
  const halfH = H / (2 * zoom);
  cx = keep(cx, halfW, -320, W + 320);
  cy = keep(cy, halfH, -60, H + 160);
  return {
    cx,
    cy,
    zoom,
    rot: shake > 0 ? noise(seed + 41, t * 9) * shake * 0.04 : 0,
    shakeX: shake > 0 ? noise(seed + 42, t * 24) * shake : 0,
    shakeY: shake > 0 ? noise(seed + 43, t * 24) * shake : 0,
  };
}

/** A shot's camera (§45.45 §8.2), from `from` to `until` (scene seconds), on the shot's focus (screen px of the frame):
 * the shot's own framing is "wide"; medium zooms 1.08 and close 1.25 into the focus, pan_left and pan_right sway 0.04 of
 * the width over the shot, push_in zooms 1 → 1.12 and shake shakes 11 px. Zooming keeps the focus where it is, so the
 * frame never shows past the shot's edges. Every cut settles (1.035 → 1 over 0.4 s), impacts shake as in the whole
 * scene, and while the road rolls there is a 1.2 px hum. */
export function shotCamera(id: CameraId, t: number, from: number, until: number, focus: [number, number], seed: number, impacts: number[], rolling: boolean): Cam {
  const W = F.w;
  const H = F.h;
  const p = clamp01((t - from) / Math.max(0.1, until - from));
  let zoom = 1;
  let sway = 0;
  let shake = 0;
  switch (id) {
    case "medium":
      zoom = 1.08;
      break;
    case "close":
      zoom = 1.25;
      break;
    case "pan_left":
    case "pan_right":
      zoom = 1.05;
      sway = (id === "pan_left" ? -1 : 1) * 0.04 * W * (ease.inOutSine(p) - 0.5);
      break;
    case "push_in":
      zoom = lerp(1, 1.12, ease.inOutSine(p));
      break;
    case "shake":
      zoom = 1.04;
      shake = 11;
      break;
    case "wide":
      break;
  }
  zoom *= 1 + 0.035 * (1 - ease.outCubic((t - from) / 0.4));
  for (const at of impacts) {
    const since = t - at;
    if (since >= 0 && since < 0.7) shake += 20 * Math.exp(-since * 7);
  }
  const hum = rolling ? 1.2 : 0;
  const [fx, fy] = focus;
  return {
    cx: fx - (fx - W / 2) / zoom + sway,
    cy: fy - (fy - H / 2) / zoom,
    zoom,
    rot: shake > 0 ? noise(seed + 41, t * 9) * shake * 0.04 : 0,
    shakeX: (shake > 0 ? noise(seed + 42, t * 24) * shake : 0) + hum * noise(seed + 44, t * 17),
    shakeY: (shake > 0 ? noise(seed + 43, t * 24) * shake : 0) + hum * noise(seed + 45, t * 19),
  };
}

/** The transform for a layer at `depth` (0 = fixed to the screen, 1 = the ground the actors stand on). */
export function layerMatrix(c: Cam, depth: number): Mat {
  const W = F.w;
  const H = F.h;
  const z = 1 + (c.zoom - 1) * depth;
  const cx = W / 2 + (c.cx - W / 2) * depth;
  const cy = H / 2 + (c.cy - H / 2) * depth;
  const r = (c.rot * depth * Math.PI) / 180;
  const cs = Math.cos(r) * z;
  const sn = Math.sin(r) * z;
  const ox = W / 2 + c.shakeX;
  const oy = H / 2 + c.shakeY;
  // translate(o) · rotate(r) · scale(z) · translate(-c)
  return [cs, sn, -sn, cs, ox - cs * cx + sn * cy, oy - sn * cx - cs * cy];
}

/** The world rectangle the camera sees at depth 1 (a little generous for the roll and shake). */
export function visibleBox(c: Cam): Box {
  const halfW = F.w / (2 * c.zoom) + 60;
  const halfH = F.h / (2 * c.zoom) + 60;
  return { x0: c.cx - halfW, x1: c.cx + halfW, y0: c.cy - halfH, y1: c.cy + halfH };
}

/** Where a world point (depth 1) lands on screen. */
export function toScreen(c: Cam, x: number, y: number): [number, number] {
  const m = layerMatrix(c, 1);
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
