// The picture markup editor's model (docs/CONTRACTS.md §27.8): red marks drawn over a picture before it goes to Ask,
// so Claude sees exactly what the owner means. Strokes are vectors over the picture's own pixels (≤ 1568 px), kept
// in memory only. Saving draws the picture and the marks into one JPEG (≤ 600 KB, metadata stripped) that replaces
// the tray picture; the original never leaves the device.
import { fitJpeg, PICTURE_BYTES_MAX, stripJpeg } from "./pictures.ts";

/** The ink: pure red, a content colour (not the vermilion action colour), with a white halo under it. */
export const INK = "#E8231B";
export const HALO = "#FFFFFF";
export const MIN_WIDTH = 4;
/** Ink width as a share of the picture's long edge. */
export const WIDTH_SHARE = 0.006;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** Saving tries these qualities first (the §26 ladder carries on below them). */
export const SAVE_QUALITIES = [0.9, 0.82] as const;

export type Tool = "pen" | "box" | "arrow";
export interface Point {
  x: number;
  y: number;
}
export type Stroke =
  | { tool: "pen"; points: Point[]; width: number }
  | { tool: "box"; from: Point; to: Point; width: number }
  | { tool: "arrow"; from: Point; to: Point; width: number };

/** Every change is a step that can be undone: one mark added, or Clear (which keeps what it cleared). */
export interface Marks {
  strokes: Stroke[];
  undo: Stroke[][];
  redo: Stroke[][];
}

export const emptyMarks = (strokes: Stroke[] = []): Marks => ({ strokes, undo: [], redo: [] });

export function addStroke(m: Marks, s: Stroke): Marks {
  return { strokes: [...m.strokes, s], undo: [...m.undo, m.strokes], redo: [] };
}

export function clearMarks(m: Marks): Marks {
  if (!m.strokes.length) return m;
  return { strokes: [], undo: [...m.undo, m.strokes], redo: [] };
}

export function undoMarks(m: Marks): Marks {
  const prev = m.undo[m.undo.length - 1];
  if (!prev) return m;
  return { strokes: prev, undo: m.undo.slice(0, -1), redo: [...m.redo, m.strokes] };
}

export function redoMarks(m: Marks): Marks {
  const next = m.redo[m.redo.length - 1];
  if (!next) return m;
  return { strokes: next, undo: [...m.undo, m.strokes], redo: m.redo.slice(0, -1) };
}

/** Ink width for a picture: 0.6 % of its long edge (at least 4 px); a pen's pressure scales it 0.6× to 1.4×. */
export function inkWidth(width: number, height: number, pointerType = "mouse", pressure = 0.5): number {
  const base = Math.max(MIN_WIDTH, Math.max(width, height) * WIDTH_SHARE);
  if (pointerType !== "pen") return base;
  const p = Math.min(1, Math.max(0, pressure || 0.5));
  return base * (0.6 + 0.8 * p);
}

/** Smooths a pen stroke: a quadratic curve through the midpoints of its points (drawn by `trace`). */
export function smoothPath(points: readonly Point[]): { move: Point; curves: { c: Point; to: Point }[]; end: Point | null } {
  if (!points.length) return { move: { x: 0, y: 0 }, curves: [], end: null };
  const curves: { c: Point; to: Point }[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    curves.push({ c: a, to: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }
  return { move: points[0]!, curves, end: points.length > 1 ? points[points.length - 1]! : null };
}

/** Drops points closer than `min` px to the last kept one (pointer events come faster than they move). */
export function addPoint(points: readonly Point[], p: Point, min = 1.5): Point[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < min) return points as Point[];
  return [...points, p];
}

/** The two short lines of an arrow's head at `to`. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = Math.max(width * 4, 16);
  const spread = Math.PI / 7;
  return [
    { x: to.x - len * Math.cos(angle - spread), y: to.y - len * Math.sin(angle - spread) },
    { x: to.x - len * Math.cos(angle + spread), y: to.y - len * Math.sin(angle + spread) },
  ];
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "stroke" | "strokeRect" | "arc" | "fill" | "save" | "restore"
> & { lineWidth: number; strokeStyle: string | CanvasGradient | CanvasPattern; fillStyle: string | CanvasGradient | CanvasPattern; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin };

function trace(ctx: Ctx, s: Stroke) {
  ctx.beginPath();
  if (s.tool === "pen") {
    const path = smoothPath(s.points);
    ctx.moveTo(path.move.x, path.move.y);
    if (!path.end) {
      ctx.lineTo(path.move.x + 0.01, path.move.y); // a dot
    } else {
      for (const c of path.curves) ctx.quadraticCurveTo(c.c.x, c.c.y, c.to.x, c.to.y);
      ctx.lineTo(path.end.x, path.end.y);
    }
    ctx.stroke();
    return;
  }
  if (s.tool === "box") {
    const x = Math.min(s.from.x, s.to.x);
    const y = Math.min(s.from.y, s.to.y);
    ctx.strokeRect(x, y, Math.abs(s.to.x - s.from.x), Math.abs(s.to.y - s.from.y));
    return;
  }
  const [a, b] = arrowHead(s.from, s.to, s.width);
  ctx.moveTo(s.from.x, s.from.y);
  ctx.lineTo(s.to.x, s.to.y);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(s.to.x, s.to.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** Draws the marks: a white halo first (so red reads on any picture), then the red ink on top. */
export function drawMarks(ctx: Ctx, strokes: readonly Stroke[]): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.strokeStyle = HALO;
    ctx.lineWidth = s.width + 4;
    trace(ctx, s);
  }
  for (const s of strokes) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = s.width;
    trace(ctx, s);
  }
  ctx.restore();
}

// ---------- Zoom and pan ----------

export interface View {
  zoom: number;
  /** The picture's offset in screen px at this zoom. */
  x: number;
  y: number;
}

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Zooms by `factor` around a screen point, keeping that point still. */
export function zoomAt(v: View, factor: number, at: Point): View {
  const zoom = clampZoom(v.zoom * factor);
  const k = zoom / v.zoom;
  return { zoom, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
}

/** A screen point (relative to the picture's box at zoom 1) → picture pixels. */
export function toPicture(p: Point, v: View, scale: number): Point {
  return { x: (p.x - v.x) / (v.zoom * scale), y: (p.y - v.y) / (v.zoom * scale) };
}

/** Two fingers on the picture zoom and pan it; they never draw. One pen or mouse draws; a finger while a pen is in
 * use pans (palm rejection). */
export function pointerRole(pointerType: string, touches: number, penSeen: boolean): "draw" | "pan" | "pinch" {
  if (pointerType === "touch" && touches >= 2) return "pinch";
  if (pointerType === "touch" && penSeen) return "pan";
  return "draw";
}

// ---------- The keyboard ----------

export const KEY_STEP = 8;
export const KEY_STEP_FAST = 40;

/** Moves the keyboard crosshair (arrow keys, Shift for bigger steps), kept on the picture. */
export function moveCursor(p: Point, key: string, shift: boolean, width: number, height: number): Point | null {
  const step = (shift ? KEY_STEP_FAST : KEY_STEP) * Math.max(1, Math.max(width, height) / 800);
  const d: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
  const m = d[key];
  if (!m) return null;
  return { x: Math.min(width, Math.max(0, p.x + m.x)), y: Math.min(height, Math.max(0, p.y + m.y)) };
}

/** What a screen reader hears. */
export const TOOL_HELP: Record<Tool, string> = {
  pen: "Pen. Drag on the picture to mark it red.",
  box: "Box. Drag on the picture to draw a red box.",
  arrow: "Arrow. Drag on the picture to draw a red arrow.",
};
export const marksText = (n: number) => `Mark added. ${n} ${n === 1 ? "mark" : "marks"}.`;

// ---------- Saving (browser only) ----------

/** The picture with its marks as one clean JPEG (≤ 600 KB, APP1..15 stripped), or null when it would not fit. */
export async function flatten(image: CanvasImageSource, width: number, height: number, strokes: readonly Stroke[]): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  const encode = (w: number, h: number, q: number) => {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    ctx.save();
    ctx.scale(w / width, h / height);
    drawMarks(ctx, strokes);
    ctx.restore();
    return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
  };
  for (const q of SAVE_QUALITIES) {
    const blob = await encode(width, height, q);
    if (blob && blob.size <= PICTURE_BYTES_MAX) return clean(blob);
  }
  const fitted = await fitJpeg(width, height, encode);
  return fitted ? clean(fitted.blob) : null;
}

async function clean(blob: Blob): Promise<Blob> {
  const stripped = stripJpeg(new Uint8Array(await blob.arrayBuffer()));
  return stripped ? new Blob([stripped as BlobPart], { type: "image/jpeg" }) : blob;
}
