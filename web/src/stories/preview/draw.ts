// Draws the engine's output on a 2D canvas (docs/CONTRACTS.md §45.10): the browser half of "one engine, two places".
// Lamo Stories' agent's numpy rasterizer (stories/agent/src/lamostories_agent/raster.py) follows the same rules,
// written down in engine/README.md: painter's order, source-over blending, round caps and joins, non-zero fill, output
// pixels of the script's own size (any of the six, CONTRACTS §45.34); `scale` is canvas pixels per output pixel. A
// `glow` is a radial gradient in the ellipse's own frame, so its alpha fades along the same stops as raster.py's.
// A dithered `grad` or `glow` (night drive's sky and vignette) is worked out pixel by pixel here, with raster.py's own
// float32 steps and the same seeded threshold (`ditherAt`), so the preview has the very same dither as the video.
// Owned by builder D (engine).
import type { Prim, TextEvent } from "../engine/types.ts";

export type ImageLookup = (asset: string) => CanvasImageSource | null;

type Grad = Extract<Prim, { k: "grad" }>;
type Glow = Extract<Prim, { k: "glow" }>;
const f32 = Math.fround;

/** The dither's threshold (0 ≤ T ≤ 1 − 2^-16) at pixel column `x`, row `y` for `seed` (engine README, Dither): a 32-bit
 * integer hash, its top 16 bits over 2^16. raster.py's `dither_thresholds` is the same function, bit for bit. */
export function ditherAt(x: number, y: number, seed: number): number {
  return ditherK(x, y, seed) / 65536;
}

/** The threshold's 16 bits (T × 2^16). */
function ditherK(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x9e3779b1) + Math.imul(y, 0x85ebca77) + Math.imul(seed >>> 0, 0xc2b2ae3d)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 16;
}

/** `np.interp(x, xp, fp)` exactly (float64): the end values past the ends, the later stop where two share an offset. */
function interp(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const n = xp.length;
  if (x < xp[0]!) return fp[0]!;
  if (x > xp[n - 1]!) return fp[n - 1]!;
  let j = n - 1;
  while (j > 0 && xp[j]! > x) j -= 1;
  if (j === n - 1 || xp[j] === x) return fp[j]!;
  return ((fp[j + 1]! - fp[j]!) / (xp[j + 1]! - xp[j]!)) * (x - xp[j]!) + fp[j]!;
}

const rgbOf = (color: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];

/** The thresholds' 16 bits for a whole canvas (row by row), kept for the last few sizes and seeds: every frame of a
 * story uses the same pattern. */
const THRESHOLDS = new Map<string, Uint16Array>();
function thresholds(seed: number, w: number, h: number): Uint16Array {
  const key = `${seed} ${w} ${h}`;
  let t = THRESHOLDS.get(key);
  if (!t) {
    t = new Uint16Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) t[y * w + x] = ditherK(x, y, seed);
    if (THRESHOLDS.size >= 4) THRESHOLDS.delete(THRESHOLDS.keys().next().value!);
    THRESHOLDS.set(key, t);
  }
  return t;
}

/** floor(float32(c + T)) for every T as one compare: the level under `c` (a float32), and the smallest threshold (in
 * 16ths of 2^16) that takes it to the level above. */
function stepOf(c: number): [number, number] {
  const base = Math.floor(c);
  let k = Math.min(65536, Math.max(0, Math.ceil((base + 1 - c) * 65536)));
  while (k > 0 && Math.floor(f32(c + (k - 1) / 65536)) > base) k -= 1;
  while (k < 65536 && Math.floor(f32(c + k / 65536)) === base) k += 1;
  return [base, k];
}

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const rgba = (r: number, g: number, b: number): number => (LITTLE ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0);

/** A dithered grad's pixels (RGBA, w × h canvas px at `scale` canvas px per output px): raster.py's `grad` with its
 * float32 steps, then floor(value + T). */
export function gradPixels(p: Grad, w: number, h: number, scale: number): Uint8ClampedArray<ArrayBuffer> {
  const buf = new ArrayBuffer(w * h * 4);
  const out32 = new Uint32Array(buf);
  const stops = p.stops.map(([o, c]) => [f32(Math.min(1, Math.max(0, o))), rgbOf(c)] as const).sort((a, b) => a[0] - b[0]);
  const offs = stops.map((s) => s[0]);
  const chans = [0, 1, 2].map((ch) => stops.map((s) => s[1][ch]!));
  const T = thresholds(p.dither ?? 0, w, h);
  const dx = p.x1 - p.x0;
  const dy = p.y1 - p.y0;
  const d2 = dx * dx + dy * dy;
  const kx = f32(dx / d2);
  const ky = f32(dy / d2);
  const x0 = f32(p.x0);
  const y0 = f32(p.y0);
  const flat = stops.length === 1 || d2 < 1e-9;
  const flatC = d2 < 1e-9 ? stops[stops.length - 1]![1] : stops[0]![1];
  const colourAt = (x: number, y: number): number[] => {
    if (flat) return [...flatC];
    const ty = f32(f32(f32((y + 0.5) / scale) - y0) * ky);
    const tx = f32(f32(f32((x + 0.5) / scale) - x0) * kx);
    const t = Math.min(1, Math.max(0, Math.abs(dx) < 1e-9 ? ty : Math.abs(dy) < 1e-9 ? tx : f32(ty + tx)));
    return chans.map((fp) => f32(interp(t, offs, fp)));
  };
  // a vertical fade (night drive's skies) has one colour a row: each channel is its level or the one above, by one
  // compare of the threshold
  const byRow = Math.abs(dx) < 1e-9;
  for (let y = 0; y < h; y += 1) {
    if (byRow || flat) {
      const [[r0, rk], [g0, gk], [b0, bk]] = colourAt(0, y).map(stepOf) as [[number, number], [number, number], [number, number]];
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const k = T[row + x]!;
        out32[row + x] = rgba(r0 + (k >= rk ? 1 : 0), g0 + (k >= gk ? 1 : 0), b0 + (k >= bk ? 1 : 0));
      }
      continue;
    }
    for (let x = 0; x < w; x += 1) {
      const t = T[y * w + x]! / 65536;
      const [r, g, b] = colourAt(x, y).map((c) => Math.floor(f32(c + t))) as [number, number, number];
      out32[y * w + x] = rgba(r, g, b);
    }
  }
  return new Uint8ClampedArray(buf);
}

/** A glow's coverage on the canvas (raster.py's `glow` with its float32 steps), × its alpha: one number a pixel of its
 * box, −1 outside the ellipse. The last few are kept (the vignette is the same every frame). */
const COVERS = new Map<string, Float32Array>();
function glowCover(p: Glow, bx: number, by: number, bw: number, bh: number, scale: number): Float32Array {
  const key = `${p.x} ${p.y} ${p.rx} ${p.ry} ${p.rot} ${p.a ?? 1} ${JSON.stringify(p.fade)} ${bx} ${by} ${bw} ${bh} ${scale}`;
  const hit = COVERS.get(key);
  if (hit) return hit;
  const out = new Float32Array(bw * bh);
  const th = p.rot * (Math.PI / 180); // math.radians
  const c = f32(Math.cos(th));
  const s = f32(Math.sin(th));
  const cx = f32(p.x);
  const cy = f32(p.y);
  const rx = f32(Math.abs(p.rx));
  const ry = f32(Math.abs(p.ry));
  const offs = p.fade.map(([o]) => Math.min(1, Math.max(0, o)));
  const alps = p.fade.map(([, a]) => Math.min(1, Math.max(0, a)));
  const alpha = typeof p.a === "number" ? Math.min(1, Math.max(0, p.a)) : 1;
  const a32 = f32(alpha);
  for (let j = 0; j < bh; j += 1) {
    const ddy = f32(f32((by + j + 0.5) / scale) - cy);
    for (let i = 0; i < bw; i += 1) {
      const ddx = f32(f32((bx + i + 0.5) / scale) - cx);
      const u = f32(f32(f32(ddx * c) + f32(ddy * s)) / rx);
      const v = f32(f32(f32(ddy * c) - f32(ddx * s)) / ry);
      const rho = f32(Math.sqrt(f32(f32(u * u) + f32(v * v))));
      if (rho >= 1) {
        out[j * bw + i] = -1;
        continue;
      }
      const cov = f32(interp(rho, offs, alps));
      out[j * bw + i] = alpha >= 1 ? cov : f32(cov * a32);
    }
  }
  if (COVERS.size >= 16) COVERS.delete(COVERS.keys().next().value!);
  COVERS.set(key, out);
  return out;
}

/** A dithered glow over `data`, the RGBA of the canvas box at (ox, oy), `stride` px wide, on a canvas `cw` × `ch` px
 * at `scale`: raster.py's `glow` and its source-over with their float32 steps, the threshold added to the step, then
 * floored (inside the ellipse; outside, a canvas pixel already holds its nearest level). */
export function glowPixels(p: Glow, data: Uint8ClampedArray, ox: number, oy: number, stride: number, cw: number, ch: number, scale: number): void {
  if (p.rx <= 0 || p.ry <= 0 || !p.fade.length || (typeof p.a === "number" && p.a <= 0)) return;
  const box = glowBox(p, cw, ch, scale);
  if (!box) return;
  const [bx, by, bw, bh] = box;
  const k = glowCover(p, bx, by, bw, bh, scale);
  const T = thresholds(p.dither ?? 0, cw, ch);
  const [cr, cg, cb] = rgbOf(p.color);
  for (let j = 0; j < bh; j += 1) {
    for (let i = 0; i < bw; i += 1) {
      const kk = k[j * bw + i]!;
      if (kk < 0) continue;
      const t = T[(by + j) * cw + bx + i]! / 65536;
      const at = ((by + j - oy) * stride + (bx + i - ox)) * 4;
      // raster.py's order: step = (colour − d) · k, step += T, d += step, floor
      const r = data[at]!;
      const g = data[at + 1]!;
      const b = data[at + 2]!;
      data[at] = Math.floor(f32(r + f32(f32(f32(cr - r) * kk) + t)));
      data[at + 1] = Math.floor(f32(g + f32(f32(f32(cg - g) * kk) + t)));
      data[at + 2] = Math.floor(f32(b + f32(f32(f32(cb - b) * kk) + t)));
    }
  }
}

/** The canvas box (whole px) a glow's ellipse touches, as raster.py's `glow` spans it, or null when it is off canvas. */
export function glowBox(p: Glow, w: number, h: number, scale: number): [number, number, number, number] | null {
  const th = p.rot * (Math.PI / 180); // math.radians
  const rx = Math.abs(p.rx);
  const ry = Math.abs(p.ry);
  const ex = Math.hypot(rx * Math.cos(th), ry * Math.sin(th));
  const ey = Math.hypot(rx * Math.sin(th), ry * Math.cos(th));
  const x0 = Math.max(0, Math.floor((p.x - ex) * scale));
  const x1 = Math.min(w, Math.ceil((p.x + ex) * scale));
  const y0 = Math.max(0, Math.floor((p.y - ey) * scale));
  const y1 = Math.min(h, Math.ceil((p.y + ey) * scale));
  return x0 < x1 && y0 < y1 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** The last dithered sky (most stay still from frame to frame): its prim, its canvas size, its pixels. */
let lastSky: { key: string; img: ImageData } | null = null;

function drawDitheredGrad(ctx: CanvasRenderingContext2D, p: Grad, w: number, h: number, scale: number): void {
  const key = `${p.x0} ${p.y0} ${p.x1} ${p.y1} ${JSON.stringify(p.stops)} ${p.dither} ${w} ${h} ${scale}`;
  if (lastSky?.key !== key) lastSky = { key, img: new ImageData(gradPixels(p, w, h, scale), w, h) };
  ctx.putImageData(lastSky.img, 0, 0);
}

/** A run of dithered glows (the vignette's four corners) with one read of the canvas and one write back. */
function drawDitheredGlows(ctx: CanvasRenderingContext2D, glows: Glow[], w: number, h: number, scale: number): void {
  const boxes = glows.map((p) => glowBox(p, w, h, scale)).filter((b) => b !== null);
  if (!boxes.length) return;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  for (const p of glows) glowPixels(p, img.data, x0, y0, x1 - x0, w, h, scale);
  ctx.putImageData(img, x0, y0);
}

export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], scale: number, images?: ImageLookup): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  for (let n = 0; n < prims.length; n += 1) {
    const p = prims[n]!;
    ctx.globalAlpha = "a" in p && typeof p.a === "number" ? p.a : 1;
    switch (p.k) {
      case "fill":
        ctx.fillStyle = p.color;
        ctx.fillRect(0, 0, w, h);
        break;
      case "grad": {
        if (typeof p.dither === "number") {
          drawDitheredGrad(ctx, p, w, h, scale);
          break;
        }
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
      case "glow": {
        // the ellipse's own unit circle, so the radial gradient's offset is how far out a point is (0 the centre, 1 the
        // edge); one colour, so the alpha stops interpolate the same premultiplied or not
        if (p.rx <= 0 || p.ry <= 0 || !p.fade.length) break;
        if (typeof p.dither === "number") {
          const run: Glow[] = [p];
          while (n + 1 < prims.length) {
            const q = prims[n + 1]!;
            if (q.k !== "glow" || typeof q.dither !== "number") break;
            run.push(q);
            n += 1;
          }
          drawDitheredGlows(ctx, run, w, h, scale);
          break;
        }
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16));
        ctx.save();
        ctx.translate(p.x * scale, p.y * scale);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.scale(p.rx * scale, p.ry * scale);
        const fade = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        for (const [offset, alpha] of p.fade) fade.addColorStop(Math.min(1, Math.max(0, offset)), `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`);
        ctx.fillStyle = fade;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
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
