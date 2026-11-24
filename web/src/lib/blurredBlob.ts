// The living backdrop's blobs, blurred once (docs/CONTRACTS.md §11.1). Under a phone's status bar Clip Factory draws
// its backdrop once more over the page, in the status bar alone (components/Backdrop.tsx, glass.css .backdrop-cover).
// Each blob of the page's backdrop is a soft round glow, blurred 56 px by the compositor on every frame it drifts;
// drawn that way twice, a phone (and a machine that draws without a GPU) blurred every glow twice on every frame. The
// cover's blobs are the same glows as pictures instead: each blob's own shape (glass.css .blob--a to --e, the Colours
// look's), blurred here once into a small picture the size of the blur's reach, which the compositor only scales and
// moves with the blob's own drift. A blur is applied before the blob's transform, so the picture scaled and moved is
// exactly the blurred blob scaled and moved. test/edgeToEdge.test.ts holds BLOB_SHAPES to glass.css.
import { hexToRgb, type Rgb } from "./background.ts";

/** One blob's glow: CSS `radial-gradient(circle at <at>, rgb / alpha, rgb / 0 <stop>)` in a round box (50 %). */
export interface BlobShape {
  /** The gradient's centre, as a share of the box (CSS `circle at 40% 40%`). */
  readonly at: readonly [number, number];
  /** Where it ends: a share of the distance from its centre to the box's farthest corner (CSS `68%`). */
  readonly stop: number;
  readonly rgb: Rgb;
  /** Its strength at the centre. */
  readonly alpha: number;
}

const VERMILION: Rgb = [232, 57, 43];
const LEAF: Rgb = [95, 165, 133];
const BONE: Rgb = [239, 231, 218];

/** The living backdrop's blobs (Clear and Frosted), as glass.css draws them. */
export const BLOB_SHAPES: Readonly<Record<"a" | "b" | "c" | "d" | "e", BlobShape>> = {
  a: { at: [0.4, 0.4], stop: 0.68, rgb: [22, 89, 77], alpha: 0.9 },
  b: { at: [0.5, 0.5], stop: 0.66, rgb: VERMILION, alpha: 0.62 },
  c: { at: [0.5, 0.5], stop: 0.66, rgb: LEAF, alpha: 0.3 },
  d: { at: [0.5, 0.5], stop: 0.7, rgb: BONE, alpha: 0.06 },
  e: { at: [0.5, 0.5], stop: 0.66, rgb: [196, 42, 30], alpha: 0.55 },
};

/** The Colours look's blobs (glass.css .backdrop--colours): the first colour, the second at 30 %, the third at 45 %. */
export function colourBlobShapes(colours: readonly string[]): Partial<Record<"a" | "b" | "c", BlobShape>> {
  const [c1, c2 = c1, c3 = c2] = colours;
  if (!c1) return {};
  return {
    a: { at: [0.4, 0.4], stop: 0.68, rgb: hexToRgb(c1), alpha: 1 },
    b: { at: [0.5, 0.5], stop: 0.66, rgb: hexToRgb(c2!), alpha: 0.3 },
    c: { at: [0.5, 0.5], stop: 0.66, rgb: hexToRgb(c3!), alpha: 0.45 },
  };
}

/** A blurred blob's strength, cell by cell, over its box and the blur's reach on every side. */
export interface BlobField {
  /** Cells on a side. */
  readonly n: number;
  /** How far the picture runs past the blob's box on every side (CSS px): three blur radii, where the glow is gone. */
  readonly reach: number;
  /** The picture's side (CSS px): the box and its reach on both sides. */
  readonly side: number;
  /** n * n strengths, row by row, each at its cell's centre. */
  readonly alpha: Float32Array;
}

/** How big a cell of the picture is (CSS px): a blur of 56 px leaves nothing finer, so the picture stays small. */
export const BLOB_CELL = 8;

/**
 * The blob of `size` px (its box, square) with `shape`, blurred `sigma` px (CSS blur(): a Gaussian of that standard
 * deviation), as strengths over its box and the blur's reach. Each cell holds the mean of the drawn glow over it (3 x 3
 * samples, so the round edge is smooth), and the blur is a true Gaussian, row by row and then column by column.
 */
export function blurredBlobField(size: number, shape: BlobShape, sigma: number, cell = BLOB_CELL): BlobField {
  const reach = Math.ceil(3 * sigma);
  const side = size + 2 * reach;
  const n = Math.max(2, Math.ceil(side / cell));
  const step = side / n;
  const [fx, fy] = shape.at;
  const cx = fx * size;
  const cy = fy * size;
  // CSS: `circle` is sized to the farthest corner, and the glow is gone at `stop` of that.
  const end = shape.stop * Math.hypot(Math.max(fx, 1 - fx) * size, Math.max(fy, 1 - fy) * size);
  const r = size / 2;
  const src = new Float32Array(n * n);
  const sub = 3;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let sj = 0; sj < sub; sj++)
        for (let si = 0; si < sub; si++) {
          // The sample, in the blob's own box (0..size), the picture starting `reach` before it.
          const x = (i + (si + 0.5) / sub) * step - reach;
          const y = (j + (sj + 0.5) / sub) * step - reach;
          if (Math.hypot(x - r, y - r) > r) continue;
          const t = Math.hypot(x - cx, y - cy) / end;
          if (t < 1) sum += shape.alpha * (1 - t);
        }
      src[j * n + i] = sum / (sub * sub);
    }
  if (sigma <= 0) return { n, reach, side, alpha: src };
  const half = Math.ceil((3 * sigma) / step);
  const kernel = new Float32Array(2 * half + 1);
  let total = 0;
  for (let k = -half; k <= half; k++) total += kernel[k + half] = Math.exp(-((k * step) ** 2) / (2 * sigma * sigma));
  for (let k = 0; k < kernel.length; k++) kernel[k]! /= total;
  const pass = (from: Float32Array, horizontal: boolean) => {
    const to = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -half; k <= half; k++) {
          const a = horizontal ? i + k : j + k;
          if (a < 0 || a >= n) continue;
          sum += kernel[k + half]! * from[horizontal ? j * n + a : a * n + i]!;
        }
        to[j * n + i] = sum;
      }
    return to;
  };
  return { n, reach, side, alpha: pass(pass(src, true), false) };
}

/** The blurred blob as a picture (a PNG data URL) in its own colour, or null where nothing can draw one. */
export function blobPicture(field: BlobField, rgb: Rgb, doc: Document = document): string | null {
  const canvas = doc.createElement("canvas");
  canvas.width = field.n;
  canvas.height = field.n;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(field.n, field.n);
  for (let p = 0; p < field.alpha.length; p++) {
    img.data[p * 4] = rgb[0];
    img.data[p * 4 + 1] = rgb[1];
    img.data[p * 4 + 2] = rgb[2];
    img.data[p * 4 + 3] = Math.round(Math.min(1, Math.max(0, field.alpha[p]!)) * 255);
  }
  ctx.putImageData(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** A cover blob: its picture and where it lies in the backdrop's box (CSS px), the blob's box and the blur's reach. */
export interface CoverBlob {
  readonly src: string;
  readonly left: number;
  readonly top: number;
  readonly side: number;
}

/** The cover's blobs and the box of the page's backdrop they lie in. */
export interface CoverBlobs {
  readonly w: number;
  readonly h: number;
  readonly blobs: Readonly<Partial<Record<string, CoverBlob>>>;
}

const pictures = new Map<string, string | null>();

/**
 * The cover's blobs, read from the page's own backdrop (`backdrop`, components/Backdrop.tsx): each blob where it lies
 * (its box before its drift), as big as it is drawn and blurred as much (its own computed filter), in the look's
 * colours (`shapes`). Null where nothing can be read or drawn (no layout, no canvas): the cover then draws its blobs as
 * the backdrop does.
 */
export function coverBlobs(backdrop: HTMLElement, shapes: Partial<Record<string, BlobShape>>): CoverBlobs | null {
  const w = backdrop.offsetWidth;
  const h = backdrop.offsetHeight;
  if (!w || !h) return null;
  const view = backdrop.ownerDocument.defaultView;
  const blobs: Record<string, CoverBlob> = {};
  for (const el of backdrop.querySelectorAll<HTMLElement>(":scope > .blob")) {
    const name = /\bblob--([a-e])\b/.exec(el.className)?.[1];
    const shape = name ? shapes[name] : undefined;
    if (!name || !shape || !el.offsetParent) continue;
    // Its box before its drift (the computed box, not rounded to whole pixels as offsetWidth is).
    const cs = view?.getComputedStyle(el);
    const px = (v: string | undefined, or: number) => (v && /px$/.test(v) ? parseFloat(v) : or);
    const size = px(cs?.width, el.offsetWidth);
    if (!size || Math.abs(px(cs?.height, el.offsetHeight) - size) > 0.5) return null;
    const left = px(cs?.left, el.offsetLeft);
    const top = px(cs?.top, el.offsetTop);
    const blur = /blur\(([\d.]+)px\)/.exec(cs?.filter ?? "");
    const sigma = blur ? Number(blur[1]) : 0;
    const key = `${size}|${sigma}|${shape.at}|${shape.stop}|${shape.rgb}|${shape.alpha}`;
    let src = pictures.get(key);
    let reach = Math.ceil(3 * sigma);
    if (src === undefined) {
      const field = blurredBlobField(size, shape, sigma);
      reach = field.reach;
      src = blobPicture(field, shape.rgb, backdrop.ownerDocument);
      if (pictures.size > 32) pictures.clear();
      pictures.set(key, src);
    }
    if (!src) return null;
    blobs[name] = { src, left: left - reach, top: top - reach, side: size + 2 * reach };
  }
  return { w, h, blobs };
}
