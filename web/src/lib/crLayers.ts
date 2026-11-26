// CR active, more than one picture (docs/CONTRACTS.md §54): the pictures of an edit are a list of layers. Pure helpers the
// editor, the Review card and the tests share: the cap, the words, reading an edit as layers (a §53 edit has one `logo` and
// no `logos`: it reads as one layer), the layer ids, the "when" of a picture or of the text, and where a layer sits until
// it is moved.
import type { ClipOverlay, OverlayLayer, OverlayTiming } from "../api/types.ts";
import { cornerCentre, keepInside, logoBox, overlaps, type Box, type Corner } from "./overlayAreas.ts";

/** The soft cap (L1). One constant, raised by editing it (ADR-107). */
export const MAX_LAYERS = 4;

export const L = {
  add: "Add a picture",
  cap: `That's ${MAX_LAYERS} pictures. Remove one to add another.`,
  remove: "Remove picture",
  removeText: "Remove text",
  tooMany: `Up to ${MAX_LAYERS} pictures.`,
} as const;

export interface Pos {
  x: number;
  y: number;
}

/** "When" of one picture or of the text: the whole clip, or From and To as typed (seconds). */
export interface When {
  part: boolean;
  from: string;
  to: string;
}

/** One picture on the clip as the editor holds it. `pos` null: it has not been moved, so it sits where `layerBoxes` puts it. */
export interface Layer {
  layerId: string;
  logoId: string;
  pos: Pos | null;
  size: number;
  when: When;
}

/** Seconds as typed ("12", "12.5"): a number, or NaN. */
export const secs = (v: string) => (v.trim() === "" ? Number.NaN : Number(v.replace(",", ".")));

export function whenOf(timing: OverlayTiming | undefined, durationSec: number): When {
  return timing ? { part: true, from: String(timing.startSec), to: String(timing.endSec) } : { part: false, from: "0", to: String(Math.floor(durationSec)) };
}

/** The timing a "When" stands for: absent for the whole clip, else the typed numbers (a bad number stays NaN, so Make it says so). */
export function timingOf(when: When): OverlayTiming | undefined {
  return when.part ? { startSec: secs(when.from), endSec: secs(when.to) } : undefined;
}

let counter = 0;
/** A short id for a new layer, unique in `taken` (the list it joins). */
export function newLayerId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    counter += 1;
    const id = `l${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!used.has(id)) return id;
  }
}

/** The pictures of a stored edit as one list: its `logos`, else its one `logo` (a §53 edit) as a one-layer list. A layer with no id yet gets one. */
export function overlayLayers(overlay: Pick<ClipOverlay, "logo" | "logos" | "timing"> | undefined): OverlayLayer[] {
  if (!overlay) return [];
  if (overlay.logos?.length) return overlay.logos;
  if (overlay.logo) return [{ ...overlay.logo, layerId: "logo", ...(overlay.timing ? { timing: overlay.timing } : {}) }];
  return [];
}

/** The editor's layers for a stored edit (a layer's own time; the one picture of a §53 edit takes the edit's time). */
export function layersOf(overlay: Pick<ClipOverlay, "logo" | "logos" | "timing"> | undefined, durationSec: number): Layer[] {
  const out: Layer[] = [];
  for (const l of overlayLayers(overlay)) {
    out.push({ layerId: l.layerId && !out.some((o) => o.layerId === l.layerId) ? l.layerId : newLayerId(out.map((o) => o.layerId)), logoId: l.logoId, pos: { x: l.x, y: l.y }, size: l.size, when: whenOf(l.timing, durationSec) });
  }
  return out.slice(0, MAX_LAYERS);
}

/** How many pictures a stored edit has (a card's tag). */
export const pictureCount = (overlay: Pick<ClipOverlay, "logo" | "logos"> | undefined) => (overlay?.logos?.length ? overlay.logos.length : overlay?.logo ? 1 : 0);

/**
 * A box of `sized`'s shape at `corner`, moved down under any earlier box it would cover (so two pictures that have not
 * been moved do not sit on top of each other). Stays inside the frame.
 */
export function settle(sized: Box, corner: Corner, others: readonly Box[]): Box {
  let at: Pos = cornerCentre(corner, sized.w, sized.h);
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => overlaps({ ...sized, ...at }, o));
    if (!hit) break;
    at = keepInside(at.x, hit.y + hit.h / 2 + sized.h / 2 + 0.01, sized.w, sized.h);
  }
  return { ...sized, ...at };
}

/** The first two pictures start at the top right and the top left; later ones go under whatever is there. */
const START: readonly Corner[] = ["tr", "tl"];

/** The boxes of the pictures, in list order: a moved one stays where it was put, the others start in a free place. Fractions of the frame. */
export function layerBoxes(items: readonly { pos: Pos | null; size: number; width: number; height: number }[]): Box[] {
  const out: Box[] = [];
  items.forEach((it, i) => {
    const sized = logoBox(0.5, 0.5, it.size, it.width, it.height);
    if (it.pos) out.push({ ...sized, ...keepInside(it.pos.x, it.pos.y, sized.w, sized.h) });
    else out.push(settle(sized, START[i % START.length]!, out));
  });
  return out;
}
