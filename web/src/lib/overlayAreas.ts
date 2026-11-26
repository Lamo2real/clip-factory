// Where the renderer draws the captions and (on a facecam clip) the facecam, so the Review editor can warn when a logo
// or a line of text covers them (docs/CONTRACTS.md §53 C3). These are the numbers of agent/.../render.py
// (CAPTION_BAND, FACECAM_BAND, CAMPAIGN_BAND, the frame's W and H); web/test/overlayAreas.test.ts reads that file and
// fails when a number here drifts from it. HUD areas (the hook, the app buttons) are not known, so no warning for them.

/** The frame every clip is rendered at. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;

/** An area in frame pixels: left, top, right, bottom. */
export type Area = readonly [number, number, number, number];

/** The captions: 82 px, up to two lines of about 100 px, standing on CAP_BOTTOM and growing up (render.py CAPTION_BAND). */
export const CAPTION_AREA: Area = [60, 1180, 908, 1380];
/** The facecam picture of a `facecam_top` clip: full width, between the hook band and the gameplay (render.py FACECAM_BAND). */
export const FACECAM_AREA: Area = [0, 400, 1080, 960];
/** A campaign clip's hook band is taller (its mark row), so its facecam starts lower (render.py CAMPAIGN_BAND). */
export const CAMPAIGN_FACECAM_TOP = 480;
/** The facecam's height (render.py CAM_H). */
export const FACECAM_H = 560;
/** The safe area the apps leave free: left, top, right, bottom (render.py SAFE). */
export const SAFE_AREA: Area = [60, 192, 918, 1440];

/** A box as fractions of the frame: its centre and its size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The areas of a clip as fractions of the frame, for the preview's guides. */
export function areasOf(layout: "facecam_top" | "blur_fill", campaign = false): { captions: Box; facecam: Box | null } {
  return { captions: toBox(CAPTION_AREA), facecam: layout === "facecam_top" ? toBox(facecamArea(campaign)) : null };
}

export function facecamArea(campaign = false): Area {
  const top = campaign ? CAMPAIGN_FACECAM_TOP : FACECAM_AREA[1];
  return [FACECAM_AREA[0], top, FACECAM_AREA[2], top + FACECAM_H];
}

function toBox(a: Area): Box {
  const w = (a[2] - a[0]) / FRAME_W;
  const h = (a[3] - a[1]) / FRAME_H;
  return { x: a[0] / FRAME_W + w / 2, y: a[1] / FRAME_H + h / 2, w, h };
}

/** True when two boxes share some picture (touching edges is not overlapping). */
export function overlaps(a: Box, b: Box): boolean {
  const eps = 1e-6;
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - eps && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - eps;
}

export const UNDER_CAPTIONS = "Under the captions";
export const ON_FACECAM = "On the facecam";

/** The one short line for a box that sits on the captions or the facecam, or null. The captions come first. */
export function overlapWarning(box: Box, layout: "facecam_top" | "blur_fill", campaign = false): string | null {
  const areas = areasOf(layout, campaign);
  if (overlaps(box, areas.captions)) return UNDER_CAPTIONS;
  if (areas.facecam && overlaps(box, areas.facecam)) return ON_FACECAM;
  return null;
}

// ---------- The boxes of a logo and of a line of text ----------

/** The logo: `size` is its width as a fraction of the frame's width; its height follows the picture's own shape. */
export function logoBox(x: number, y: number, size: number, width: number, height: number): Box {
  const w = size;
  const h = (size * FRAME_W * (height > 0 && width > 0 ? height / width : 1)) / FRAME_H;
  return { x, y, w, h };
}

/** The text's three sizes: the font's height in frame pixels (agent/.../overlay.py TEXT_SIZES). */
export const TEXT_PX = { s: 48, m: 68, l: 92 } as const;
/** A bold letter is this many font sizes wide, and the line is never wider than TEXT_EDGE of the frame (overlay.py CHAR_WIDTH, EDGE). */
export const TEXT_CHAR_W = 0.6;
export const TEXT_EDGE = 0.97;
/** The line's own height is 1.4 font sizes (overlay.py: half the height is 0.7 of the size). */
export const TEXT_LINE_H = 1.4;

/** The font height the renderer really uses: a line that would be wider than the frame gets a smaller font (never wrapped). */
export function textPx(text: string, size: "s" | "m" | "l"): number {
  const letters = Math.max(1, Array.from(text).length);
  const px = TEXT_PX[size];
  return letters * TEXT_CHAR_W * px > FRAME_W * TEXT_EDGE ? (FRAME_W * TEXT_EDGE) / (letters * TEXT_CHAR_W) : px;
}

/** The text's box: one line, as wide as its words, as tall as the line. */
export function textBox(x: number, y: number, text: string, size: "s" | "m" | "l"): Box {
  const px = textPx(text, size);
  const letters = Math.max(1, Array.from(text).length);
  return { x, y, w: (letters * TEXT_CHAR_W * px) / FRAME_W, h: (px * TEXT_LINE_H) / FRAME_H };
}

/** Keeps a box inside the frame by moving its centre. */
export function keepInside(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const clamp = (v: number, size: number) => (size >= 1 ? 0.5 : Math.min(1 - size / 2, Math.max(size / 2, v)));
  return { x: clamp(x, w), y: clamp(y, h) };
}

// ---------- The four corner presets ----------

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
export const CORNER_LABEL: Record<Corner, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right" };

/** A box's centre for a corner: the corner of the safe area the apps leave free (so the apps' buttons never hide it). */
export function cornerCentre(corner: Corner, w: number, h: number): { x: number; y: number } {
  const [l, t, r, b] = SAFE_AREA;
  const left = l / FRAME_W;
  const right = r / FRAME_W;
  const top = t / FRAME_H;
  const bottom = b / FRAME_H;
  const x = corner === "tl" || corner === "bl" ? left + w / 2 : right - w / 2;
  const y = corner === "tl" || corner === "tr" ? top + h / 2 : bottom - h / 2;
  return keepInside(x, y, w, h);
}
