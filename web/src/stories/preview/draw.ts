// Draws the engine's output on a 2D canvas (docs/CONTRACTS.md §45.10): the browser half of "one engine, two places".
// The agent's numpy rasterizer (agent/src/clipfactory_agent/stories/raster.py) follows the same rules, written down in
// engine/README.md: painter's order, source-over blending, round caps and joins, non-zero fill, output pixels.
// Owned by builder D (engine).
import type { Prim, TextEvent } from "../engine/types.ts";

export type ImageLookup = (asset: string) => CanvasImageSource | null;

export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], scale: number, images?: ImageLookup): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  for (const p of prims) {
    ctx.globalAlpha = "a" in p && typeof p.a === "number" ? p.a : 1;
    switch (p.k) {
      case "fill":
        ctx.fillStyle = p.color;
        ctx.fillRect(0, 0, w, h);
        break;
      case "grad": {
        const g = ctx.createLinearGradient(p.x0 * scale, p.y0 * scale, p.x1 * scale, p.y1 * scale);
        for (const [offset, color] of p.stops) g.addColorStop(Math.min(1, Math.max(0, offset)), color);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        break;
      }
      case "rect": {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        const rw = p.w * scale;
        const rh = p.h * scale;
        const r = Math.max(0, Math.min(p.r * scale, rw / 2, rh / 2));
        if (r > 0 && typeof ctx.roundRect === "function") ctx.roundRect(p.x * scale, p.y * scale, rw, rh, r);
        else ctx.rect(p.x * scale, p.y * scale, rw, rh);
        ctx.fill();
        break;
      }
      case "circle":
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x * scale, p.y * scale, Math.max(0, p.r * scale), 0, Math.PI * 2);
        ctx.fill();
        break;
      case "ellipse":
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x * scale, p.y * scale, Math.max(0, p.rx * scale), Math.max(0, p.ry * scale), (p.rot * Math.PI) / 180, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "poly":
        if (p.pts.length < 6) break;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.pts[0]! * scale, p.pts[1]! * scale);
        for (let i = 2; i + 1 < p.pts.length; i += 2) ctx.lineTo(p.pts[i]! * scale, p.pts[i + 1]! * scale);
        ctx.closePath();
        ctx.fill("nonzero");
        break;
      case "line":
        if (p.pts.length < 4) break;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.w * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(p.pts[0]! * scale, p.pts[1]! * scale);
        for (let i = 2; i + 1 < p.pts.length; i += 2) ctx.lineTo(p.pts[i]! * scale, p.pts[i + 1]! * scale);
        ctx.stroke();
        break;
      case "image": {
        const img = images?.(p.asset);
        if (img) ctx.drawImage(img, p.x * scale, p.y * scale, p.w * scale, p.h * scale);
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** Line height of text events, as a multiple of their size (engine/README.md). */
export const LINE_HEIGHT = 1.18;
const PANEL = "rgba(28, 24, 66, 0.72)";

/** The text track at `time` (seconds): captions and the end card on a rounded panel, bubble symbols plain. */
export function drawText(ctx: CanvasRenderingContext2D, events: TextEvent[], time: number, scale: number): void {
  ctx.globalAlpha = 1;
  for (const e of events) {
    if (time < e.start || time >= e.end) continue;
    const size = e.size * scale;
    const lines = e.text.split("\n");
    const lh = size * LINE_HEIGHT;
    ctx.font = `800 ${Math.max(1, Math.round(size))}px Inter, ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cx = e.x * scale;
    const cy = e.y * scale;
    const top = cy - ((lines.length - 1) * lh) / 2;
    if (e.kind !== "bubble") {
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const padX = size * 0.5;
      const padY = size * 0.28;
      ctx.fillStyle = PANEL;
      ctx.beginPath();
      const x = cx - widest / 2 - padX;
      const y = top - lh / 2 - padY;
      const bw = widest + padX * 2;
      const bh = lines.length * lh + padY * 2;
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, bw, bh, size * 0.42);
      else ctx.rect(x, y, bw, bh);
      ctx.fill();
    }
    ctx.fillStyle = e.color;
    lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lh));
  }
}
