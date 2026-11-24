// Lamo Stories engine: speech and thought bubbles. They hold symbols only, never words (no voice-over, no spoken
// lines). The balloon is drawn in the frames; the symbol inside it is a TextEvent (textTrack), placed at the same
// screen spot, so the balloon and its symbol always line up. Bubbles are fixed to the screen while they show.

import { nightDrive } from "./art.ts";
import { DEG, clamp01, ease } from "./math.ts";
import type { Pen } from "./pen.ts";
import { dropPts, inflate, starPts } from "./pen.ts";
import type { BubbleId } from "./types.ts";

export interface Bubble {
  kind: BubbleId;
  /** absolute seconds (the text track) */
  start: number;
  end: number;
  /** the scene it shows in, when in that scene it starts (s), and how long it shows (s): frames use these only */
  scene: number;
  at: number;
  span: number;
  /** balloon centre, screen px */
  x: number;
  y: number;
  /** the speaker's head, screen px (the tail points at it) */
  hx: number;
  hy: number;
}

/** The symbol each bubble shows (Inter or a common fallback font has each of these). */
export const BUBBLE_SYMBOL: Record<BubbleId, { text: string; size: number; color: string } | null> = {
  question: { text: "?", size: 112, color: "#1c1842" },
  exclaim: { text: "!", size: 116, color: "#1c1842" },
  idea: { text: "!", size: 96, color: "#1c1842" },
  music: { text: "♫", size: 100, color: "#1c1842" },
  dots: { text: "• • •", size: 60, color: "#1c1842" },
  heart: { text: "♥", size: 104, color: "#ff4f6d" },
  angry: { text: "#@!", size: 64, color: "#fff6e5" },
  sweat: null,
  zzz: { text: "Zzz", size: 66, color: "#1c1842" },
};

export const BUBBLE_R = 104;
const CLASSIC_INK = "#1c1842";
/** Night drive's balloon: a warm off-white (never the brightest thing in a night frame, the lamps are) inside a thin,
 * muted warm grey-brown outline, not the heavy navy; its shine a warm white, never pink. */
const NIGHT_FILL = "#e9e0cf";
const NIGHT_INK = "#5a4c4a";
const NIGHT_SHINE = "#fbf3e6";

/** How long a bubble shows for a beat of this length. */
export function bubbleSpan(dur: number): number {
  return Math.min(2.6, Math.max(1.2, dur));
}

/** Pop-in and pop-out scale `t` seconds after the bubble starts. */
export function bubbleScale(b: Bubble, t: number): number {
  if (t < 0 || t >= b.span) return 0;
  const inK = ease.outBack(clamp01(t / 0.2));
  const outK = 1 - ease.inBack(clamp01((t - (b.span - 0.16)) / 0.16));
  return Math.max(0, Math.min(inK, outK));
}

/** Where the bubble's symbol shows (start, end) so it appears once the balloon has popped in. */
export function symbolSpan(b: Bubble): [number, number] {
  return [b.start + 0.12, Math.max(b.start + 0.2, b.end - 0.14)];
}

/** Draws a bubble `t` seconds after it starts: scene time only, so a scene draws the same whatever the scenes
 * before it last (only an edited scene needs animating again). */
export function drawBubble(pen: Pen, b: Bubble, t: number): void {
  const k = bubbleScale(b, t);
  if (k <= 0.01) return;
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  if (b.kind === "sweat") {
    // nervous sweat: big drops fly off the head instead of a balloon
    for (let i = 0; i < 3; i += 1) {
      const a = (-140 + i * 50) * DEG;
      const d = 120 + 40 * ((t * 1.4 + i * 0.3) % 1);
      const x = b.hx + Math.cos(a) * d;
      const y = b.hy - 40 + Math.sin(a) * d;
      pen.poly(dropPts(x, y, 22 * k, 46 * k), "#2d7fd1");
      pen.poly(dropPts(x, y, 17 * k, 38 * k), "#8fd8ff");
      pen.circle(x - 6 * k, y - 4 * k, 5 * k, "#ffffff", 0.8);
    }
    return;
  }
  pen.translate(b.x, b.y);
  pen.scale(k);
  const nd = nightDrive();
  const INK = nd ? NIGHT_INK : CLASSIC_INK;
  // the outline's width round the balloon (classic 8, night drive 3.5) and round the thought cloud's lobes (7, 3)
  const ow = nd ? 3.5 : 8;
  const lw = nd ? 3 : 7;
  const wide = b.kind === "dots" || b.kind === "angry" || b.kind === "zzz";
  const rx = wide ? BUBBLE_R * 1.3 : BUBBLE_R;
  const ry = wide ? BUBBLE_R * 0.92 : BUBBLE_R;
  const tx = (b.hx - b.x) / k;
  const ty = (b.hy - b.y) / k;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const thought = b.kind === "dots" || b.kind === "zzz" || b.kind === "question";
  const fill = b.kind === "angry" ? "#ff4f4f" : b.kind === "idea" ? "#ffd54a" : nd ? NIGHT_FILL : "#ffffff";
  if (b.kind === "idea") {
    // a glowing light bulb: the classic "I've got an idea"
    const glow = 0.18 + 0.1 * Math.sin(t * 8);
    pen.circle(0, -6, rx * 1.35, "#fff3b0", glow);
    for (let i = 0; i < 7; i += 1) {
      const a = (-180 + i * 30) * DEG;
      pen.line([Math.cos(a) * rx * 1.12, -6 + Math.sin(a) * rx * 1.12, Math.cos(a) * rx * 1.4, -6 + Math.sin(a) * rx * 1.4], 12, "#ffc94a");
    }
    pen.circle(0, -6, rx + ow, INK);
    pen.rect(-rx * 0.42 - ow, rx * 0.62, rx * 0.84 + 2 * ow, rx * 0.62 + ow, 14, INK);
    pen.circle(0, -6, rx, fill);
    pen.rect(-rx * 0.42, rx * 0.66, rx * 0.84, rx * 0.5, 10, "#c9d3de");
    pen.line([-rx * 0.36, rx * 0.84, rx * 0.36, rx * 0.84], 6, "#8b97a8");
    pen.ellipse(-rx * 0.4, -rx * 0.42, rx * 0.2, rx * 0.12, -35, "#ffffff", 0.8);
    return;
  }
  if (thought) {
    // a thought cloud with little puffs leading to the head
    for (let i = 2; i >= 1; i -= 1) {
      const d = len * (i === 2 ? 0.72 : 0.5);
      const r = i === 2 ? 14 : 22;
      pen.circle(ux * d, uy * d, r + (nd ? lw : ow - 2), INK);
      pen.circle(ux * d, uy * d, r, fill);
    }
    const lobes: [number, number, number][] = [
      [0, 0, 1],
      [-0.62, 0.12, 0.62],
      [0.62, 0.1, 0.62],
      [-0.32, -0.42, 0.6],
      [0.34, -0.42, 0.6],
      [0, 0.42, 0.62],
    ];
    for (const [lx, ly, lr] of lobes) pen.ellipse(lx * rx, ly * ry, lr * rx * 0.72 + lw, lr * ry * 0.72 + lw, 0, INK);
    for (const [lx, ly, lr] of lobes) pen.ellipse(lx * rx, ly * ry, lr * rx * 0.72, lr * ry * 0.72, 0, fill);
    return;
  }
  // a speech balloon (round) or a shout (spiky) with a tail pointing at the speaker
  const px = -uy;
  const py = ux;
  const base = 0.62;
  const tail = [px * rx * 0.32 + ux * rx * base, py * ry * 0.32 + uy * ry * base, -px * rx * 0.32 + ux * rx * base, -py * ry * 0.32 + uy * ry * base, ux * Math.min(len * 0.62, rx * 1.9), uy * Math.min(len * 0.62, ry * 1.9)];
  const spiky = b.kind === "exclaim" || b.kind === "angry";
  if (spiky) {
    const pts = starPts(0, 0, rx * 1.12, rx * 0.86, 11, t * 20);
    pen.poly(inflate(tail, ow), INK);
    pen.poly(inflate(pts, ow), INK);
    pen.poly(tail, fill);
    pen.poly(pts, fill);
    return;
  }
  pen.poly(inflate(tail, ow), INK);
  pen.ellipse(0, 0, rx + ow, ry + ow, 0, INK);
  pen.poly(tail, fill);
  pen.ellipse(0, 0, rx, ry, 0, fill);
  if (b.kind === "heart") pen.ellipse(-rx * 0.45, -ry * 0.5, rx * 0.2, ry * 0.12, -30, nd ? NIGHT_SHINE : "#ffe0e7", nd ? 0.75 : 0.9);
}
