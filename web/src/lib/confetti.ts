import { prefersReducedMotion } from "./prefs.ts";
import { clipsHidden } from "../app/shell.ts";

/**
 * Vermilion, bone and leaf for the green glass, plus one raised green (#1B4A3B) that shows when the glass is light
 * (see-through over a light desktop), where the bone and cream pieces fade. Each backdrop keeps at least three
 * colours that show.
 */
const COLORS = ["#E8392B", "#EFE7DA", "#F07A6C", "#5FA585", "#FFF8EE", "#1B4A3B"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  spin: number;
  w: number;
  h: number;
  color: string;
}

/**
 * A short vermilion-and-bone burst from a point (a Confirm button, a finished job). Pointer-transparent, removed when
 * done, skipped entirely when motion is reduced.
 */
export function burst(origin?: { x: number; y: number }, amount = 90): void {
  // Never over Lamo Stories (a Clip Factory page kept behind it finished something, §45.35 D17); always false while
  // Lamo Stories is switched off.
  if (clipsHidden()) return;
  if (prefersReducedMotion() || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);

  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H / 3;
  const pieces: Piece[] = Array.from({ length: amount }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = 6 + Math.random() * 9;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    };
  });

  const start = performance.now();
  const LIFE = 1700;
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    const fade = Math.max(0, 1 - Math.max(0, t - LIFE * 0.6) / (LIFE * 0.4));
    for (const p of pieces) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.spin;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < LIFE) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** The centre of an element, for bursting from a button. */
export function centerOf(el: Element | null): { x: number; y: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
