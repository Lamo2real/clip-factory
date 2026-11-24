// Lamo Stories engine: the video's size and shape (CONTRACTS §45.34). A script is one of six sizes: 9:16, 1:1 or
// 16:9, each at 1080 or 720 on its short side. The engine lays every frame out in design pixels, where the short side
// is always 1080 (1080 × 1920, 1080 × 1080 or 1920 × 1080), so a character, a car, a line or a letter is the same size
// against the short side in every shape. The pen then scales the draw list to the script's own size (2/3 for the 720
// sizes), so 720-wide output is the 1080-wide output scaled down. Positions stay 0..1 of the frame in every shape.
//
// `F` is the frame being drawn now. Every entry point that lays a script out (drawFrame, prepare, textTrack,
// audioTrack) runs inside `inFrame(script, …)`, which sets it from the script's width and height and puts it back
// afterwards; everything else reads it. The engine is synchronous, so two previews never see each other's frame.
// `F` also carries the drawing style (`script.art`, §45.45) and the light the part being drawn now stands in
// (art.ts): inFrame sets the style from the script and the studio light; scene.ts sets the light per place and part.

import type { Light } from "./art.ts";
import type { ArtStyle, FrameHeight, FrameWidth, VideoAspect, VideoFormat, VideoResolution } from "./types.ts";

/** The light that changes nothing (art.ts LIGHTS.studio): the editors' previews keep the owner's own colours. It lives
 * here so frame.ts needs nothing from art.ts but its types (art.ts reads F). */
export const STUDIO_LIGHT: Readonly<Light> = Object.freeze({ ambient: "#ffffff", amount: 0, desat: 0, dark: 0, warm: 0, rim: "#fff6e5", rimA: 0.25, night: false });

/** The short side of the design space (px): everything's size is measured against it. */
export const SHORT = 1080;

type Safe = VideoFormat["safe"];

/** Where text may go in each shape, in design px (the short side 1080). 9:16 is the safe area of TikTok, Reels and
 * Shorts that the agent's caption writer already keeps to (stories/agent ass.py): 80 px in from the left, 170 px clear
 * of the right-hand buttons, 260 px under the top tabs and 480 px above the bottom bar of names and captions. 1:1 and
 * 16:9 use a centred band 5% in from each edge. */
const SAFE: Record<VideoAspect, Safe> = {
  "9:16": { left: 80, top: 260, right: 910, bottom: 1440 },
  "1:1": { left: 54, top: 54, right: 1026, bottom: 1026 },
  "16:9": { left: 96, top: 54, right: 1824, bottom: 1026 },
};

const DESIGN: Record<VideoAspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

function format(aspect: VideoAspect, width: FrameWidth, height: FrameHeight, label: string): VideoFormat {
  const k = Math.min(width, height) / SHORT;
  const s = SAFE[aspect];
  const px = (v: number) => Math.round(v * k);
  return { aspect, resolution: `${width}x${height}` as VideoResolution, width, height, label, safe: { left: px(s.left), top: px(s.top), right: px(s.right), bottom: px(s.bottom) } };
}

/** Every size a video can have: 9:16 first (the default), then 1:1 and 16:9, the bigger size of each first. */
export const FORMATS: readonly VideoFormat[] = [
  format("9:16", 1080, 1920, "Tall 9:16, 1080 × 1920 (Shorts, Reels and TikTok)"),
  format("9:16", 720, 1280, "Tall 9:16, 720 × 1280 (smaller file)"),
  format("1:1", 1080, 1080, "Square 1:1, 1080 × 1080"),
  format("1:1", 720, 720, "Square 1:1, 720 × 720 (smaller file)"),
  format("16:9", 1920, 1080, "Wide 16:9, 1920 × 1080 (like a TV)"),
  format("16:9", 1280, 720, "Wide 16:9, 1280 × 720 (smaller file)"),
];

export const DEFAULT_FORMAT: VideoFormat = FORMATS[0]!;

/** The width and height of a shape at a resolution (the bigger size when no resolution is given), or null when the
 * resolution is not one of that shape's (a 16:9 shape is never 1080 × 1920). */
export function sizeFor(aspect: VideoAspect, resolution?: VideoResolution): { width: FrameWidth; height: FrameHeight } | null {
  const f = FORMATS.find((x) => x.aspect === aspect && (resolution === undefined || x.resolution === resolution));
  return f ? { width: f.width, height: f.height } : null;
}

/** The format of a width and height, or null for any other pair. */
export function formatOf(width: unknown, height: unknown): VideoFormat | null {
  return FORMATS.find((f) => f.width === width && f.height === height) ?? null;
}

/** "1080 × 1920 or 720 × 1280 (9:16), 1080 × 1080 or 720 × 720 (1:1), 1920 × 1080 or 1280 × 720 (16:9)" */
export function formatsSentence(): string {
  const parts = (["9:16", "1:1", "16:9"] as VideoAspect[]).map((a) => {
    const sizes = FORMATS.filter((f) => f.aspect === a).map((f) => `${f.width} × ${f.height}`);
    return `${sizes.join(" or ")} (${a})`;
  });
  return parts.join(", ");
}

export interface Frame {
  aspect: VideoAspect;
  /** the frame in design px (the short side is 1080) */
  w: number;
  h: number;
  /** output px per design px: 1, or 2/3 for the 720 sizes */
  k: number;
  /** w / 1080 and h / 1920: places what was laid out for the 1080 × 1920 frame in this one */
  sx: number;
  sy: number;
  /** 1080 / w and 1080 / h: a distance of 1080 design px as a part of the frame's width and height */
  ux: number;
  uy: number;
  /** where text may go, design px */
  safe: Safe;
  /** the drawing style of the script being drawn (§45.45): "classic" unless the script says "night_drive" */
  art: ArtStyle;
  /** the light the part being drawn now stands in (art.ts): studio (no change) outside a scene */
  light: Light;
}

/** The frame being drawn now (the 1080 × 1920 default between calls). */
export const F: Frame = frameFor(DEFAULT_FORMAT);

function frameFor(f: VideoFormat): Frame {
  const d = DESIGN[f.aspect];
  return { aspect: f.aspect, w: d.w, h: d.h, k: Math.min(f.width, f.height) / SHORT, sx: d.w / 1080, sy: d.h / 1920, ux: 1080 / d.w, uy: 1080 / d.h, safe: SAFE[f.aspect], art: "classic", light: STUDIO_LIGHT };
}

/** A script's drawing style: only "night_drive" draws in night drive; anything else (missing, older scripts) is
 * classic. */
export const artOf = (art: unknown): ArtStyle => (art === "night_drive" ? "night_drive" : "classic");

/** Runs `fn` with `F` set to the script's size (a size that is not one of the six draws as 1080 × 1920), its drawing
 * style and the studio light, then puts the frame that was there back. */
export function inFrame<T>(size: { width?: unknown; height?: unknown; art?: unknown }, fn: () => T): T {
  const saved: Frame = { ...F };
  Object.assign(F, frameFor(formatOf(size.width, size.height) ?? DEFAULT_FORMAT));
  F.art = artOf(size.art);
  F.light = STUDIO_LIGHT;
  try {
    return fn();
  } finally {
    Object.assign(F, saved);
  }
}

/** Runs `fn` in a drawing style with the studio light (the editors' previews, which have no script), then puts the
 * style and light that were there back. */
export function withArt<T>(art: ArtStyle | undefined, fn: () => T): T {
  const was = { art: F.art, light: F.light };
  F.art = artOf(art);
  F.light = STUDIO_LIGHT;
  try {
    return fn();
  } finally {
    F.art = was.art;
    F.light = was.light;
  }
}

/** An x laid out for the 1080-wide 9:16 frame, placed in this frame (the same part of its width). */
export const X = (v: number): number => v * F.sx;
/** A y laid out for the 1920-tall 9:16 frame, placed in this frame (the same part of its height). */
export const Y = (v: number): number => v * F.sy;
