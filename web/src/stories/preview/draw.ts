// Draws the engine's output on a 2D canvas (docs/CONTRACTS.md §45.10): the browser half of "one engine, two places".
// The agent's numpy rasterizer (agent/src/clipfactory_agent/stories/raster.py) follows the same rules: painter's order,
// source-over blending, round caps and joins, non-zero fill. Owned by builder D (engine).
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
        for (const [offset, color] of p.stops) g.addColorStop(offset, color);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        break;
      }
      case "rect":
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.roundRect(p.x * scale, p.y * scale, p.w * scale, p.h * scale, p.r * scale);
        ctx.fill();
        break;
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

export function drawText(ctx: CanvasRenderingContext2D, events: TextEvent[], time: number, scale: number): void {
  for (const e of events) {
    if (time < e.start || time >= e.end) continue;
    ctx.fillStyle = e.color;
    ctx.font = `800 ${Math.round(e.size * scale)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(e.text, e.x * scale, e.y * scale);
  }
}
