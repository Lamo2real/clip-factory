// Clip Factory Stories' own background (Stories › Settings › Look): the same three choices as Clip Factory's
// (BackgroundBranch, CONTRACTS §22.5) with Stories' own colours, numbers and prefs. Never Clip Factory's: the choice
// lives in Stories' own cf.stories.prefs (`look.*` under `more`) and the picture in its own localStorage entry
// (cf.stories.picture), and nothing here writes Clip Factory's settings.
//
//   See-through  the Mac or Windows app: the page is transparent and the window's own glass shows the desktop, Clear
//                or Frosted (a 0.30 frost). Browsers and phones cannot look behind themselves: they show the Stories
//                colours (Ember), frosted when Frosted is picked.
//   Picture      the owner's picture at full strength between the panels (Ember until one is picked).
//   Colours      1 to 3 colours drawn as a base and two soft lights. Ember (the owner's warm reference) is the default
//                choice of the whole Look.
//
// The veils: the least smoky tint that keeps every word at 4.5:1 over the lightest pixel each look can show. Over the
// colours they are worked out here from exactly what the stage draws (stageAt over STAGE_WINDOWS), with floors thin
// enough that the stage shows through (23 Nov, the owner: "more see through in a liquid glassy style"), the way Clip
// Factory's lib/background.ts does for its own. No glass dims what it sees (DIM: in Clips Funded a dim takes away as
// much as the thinner veil gives back). Over a picture or the desktop (See-through in the app) the measured numbers
// hold (tiles 0.74, tinted tiles 0.80 with the colour cut to 0.12, hero 0.76, rail 0.78, Frosted 0.30 + 0.89), and
// the light's order keeps the lower levels a step thicker. StoriesApp calls useStoriesBackground(root, active) once: it puts the result on
// .stories-app (data-look, data-strength, data-glass, the --st-veil-* numbers and the stage colours), and
// glass.css paints .stories-app::before from them. Stories depends on nothing of Clip Factory's here: the two small
// readers below are Stories' own copies, and See-through's transparent page is a wish Stories states to the shell
// (app/shell.ts setPageGlass), which alone writes html.see-through, from the wish of the app on screen.
import { useEffect, useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { setPageGlass } from "../app/shell.ts";
import { LENS_BUDGET, watchLenses } from "./glass/lens.ts";
import { onStoriesPrefs, setStoriesPref, storiesPrefs } from "./workspace.ts";

/** The desktop app's real window glass (its wrapper says which in window.__CF_GLASS__); "none" anywhere else. */
export type NativeGlass = "liquid" | "vibrancy" | "mica" | "acrylic" | "blur" | "none";
const REAL_GLASSES: readonly string[] = ["liquid", "vibrancy", "mica", "acrylic", "blur"];

/** Stories' own copy of the shell's reader (lib/background.ts readNativeGlass): only the desktop wrapper can say so. */
export function readNativeGlass(w: { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown } | undefined): NativeGlass {
  if (!w || w.__CF_DESKTOP__ !== true) return "none";
  const g = w.__CF_GLASS__;
  return typeof g === "string" && REAL_GLASSES.includes(g) ? (g as NativeGlass) : "none";
}
export function nativeGlass(): NativeGlass {
  return typeof window === "undefined" ? "none" : readNativeGlass(window as unknown as { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown });
}

export type LookMode = "see-through" | "picture" | "colours";
export type GlassStrength = "clear" | "frosted";
/** What is drawn behind the glass (data-look on .stories-app). */
export type LookKind = "window" | "picture" | "colours";
/** How the glass is drawn on this device (data-glass): the liquid rim, plain CSS light, or solid. */
export type GlassTier = "liquid" | "simple" | "solid";
export type Rgb = readonly [number, number, number];

export const LOOK_MODES: readonly LookMode[] = ["see-through", "picture", "colours"];
export const GLASS_STRENGTHS: readonly GlassStrength[] = ["clear", "frosted"];
const TIERS: readonly GlassTier[] = ["liquid", "simple", "solid"];

/** The keys in cf.stories.prefs (`more`). `look.glass` is a device override, for checks only (no switch shows it). */
export const LOOK_KEYS = { mode: "look.mode", strength: "look.strength", colours: "look.colours", glass: "look.glass" } as const;
/** The picture's own entry: too big for cf.stories.prefs, and never Clip Factory's cf.background. */
export const PICTURE_KEY = "cf.stories.picture";

/** Ember: the owner's warm reference (espresso, copper light, amber light). The default of the whole Look. */
export const EMBER: readonly string[] = ["#1c130e", "#e2621f", "#ff9a45"];
export const PRESETS: readonly { id: string; name: string; colours: readonly string[] }[] = [
  { id: "ember", name: "Ember", colours: EMBER },
  { id: "rose", name: "Rose", colours: ["#21121a", "#c8546a", "#f59a7a"] },
  { id: "lagoon", name: "Lagoon", colours: ["#0d1a1b", "#2c8a86", "#e8a65a"] },
];
export const DEFAULT_MODE: LookMode = "colours";
export const DEFAULT_STRENGTH: GlassStrength = "clear";
export const MAX_COLOURS = 3;

export interface StoriesLook {
  mode: LookMode;
  strength: GlassStrength;
  colours: string[];
  picture: string | null;
}

// ---------- Colour maths (WCAG 2.x) ----------

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
}
const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
/** `top` at `alpha` over `under`. */
export function mix(top: Rgb, under: Rgb, alpha: number): Rgb {
  return top.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;
}
/** CSS saturate(s) on one colour (the filter matrix, clamped), as backdrop-filter does to what is behind a bar. */
export function saturateRgb([r, g, b]: Rgb, s: number): Rgb {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return [
    clamp((0.2126 + 0.7874 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 - 0.0722 * s) * b),
    clamp((0.2126 - 0.2126 * s) * r + (0.7152 + 0.2848 * s) * g + (0.0722 - 0.0722 * s) * b),
    clamp((0.2126 - 0.2126 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 + 0.9278 * s) * b),
  ];
}

/** The smoky glass tint (--st-veil-rgb, #1C130E). */
export const VEIL: Rgb = [28, 19, 14];
export const WHITE: Rgb = [255, 255, 255];
/** Every word colour that sits on glass or loose on the page (glass-tokens.css: ink, ink-soft and the tone inks). */
export const INKS: Readonly<Record<string, string>> = {
  ink: "#fff6ea",
  "ink-soft": "#f2e5d4",
  "sun-ink": "#ffd9a8",
  "coral-ink": "#ffd6cc",
  "mint-ink": "#c9f2dc",
  "sky-ink": "#d3ecf5",
};
const INK_RGB: readonly Rgb[] = Object.values(INKS).map(hexToRgb);
export const AA = 4.5;

/** The least veil of VEIL over `under` at which every word reaches `target` (in steps of 0.01). */
export function minVeil(under: Rgb, inks: readonly Rgb[] = INK_RGB, target = AA): number {
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const bg = mix(VEIL, under, v);
    if (inks.every((t) => contrast(t, bg) >= target)) return Math.round(v * 100) / 100;
  }
  return 1;
}

// ---------- The logic of light (glass-tokens.css 5a; test/storiesLight.test.ts holds the two together) ----------

/** The cream light each level adds: 0 the backdrop, 1 page panels, 2 cards, 3 raised cards and bars, 4 controls (over
 *  the surface they sit on), 5 menus, popovers, sheets and toasts. */
export const ELEVATION: readonly number[] = [0, 0.025, 0.045, 0.07, 0.12, 0.2];
/** The extra light at the very top of each level (it settles into the fill by --st-elev-settle). */
export const ELEVATION_TOP: readonly number[] = [0, 0.03, 0.04, 0.05, 0.015, 0.06];
/** The cream of the light (--st-cream-rgb). */
export const CREAM: Rgb = [255, 243, 228];
/** The level each kind of glass sits on. */
export const KIND_LEVEL: Readonly<Record<keyof Veils, number>> = { page: 0, rail: 1, plate: 1, card: 2, tinted: 3, hero: 3, bar: 3, float: 5 };
/**
 * A surface of veil `veil` and light `light` over `under`, as glass.css draws it: the light takes its share from what
 * is behind, never from the veil (its veil layer is veil / (1 - light) under the light, clamped at 1), so over white
 * it keeps the veil's own contrast and over anything darker the light shows.
 */
export function lit(under: Rgb, veil: number, light: number): Rgb {
  const v = Math.min(1, veil / (1 - light));
  return mix(CREAM, mix(VEIL, under, v), light);
}
/** The least veil at which every word keeps `target` on a surface with this light over `under`, at its top. */
export function minVeilLit(under: Rgb, light: number, inks: readonly Rgb[] = INK_RGB, target = AA): number {
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const bg = lit(under, v, light);
    if (inks.every((t) => contrast(t, bg) >= target)) return Math.round(v * 100) / 100;
  }
  return 1;
}

/** How strong the stage's two main lights are (glass-tokens.css --st-stage-a2 copper, --st-stage-a3 amber). */
export const GLOW_ALPHA = { second: 0.46, third: 0.3 } as const;
/** What a glass's backdrop-filter can do to the colours under it (none, and the glass's saturate: --st-saturate). */
export const SATURATIONS: readonly number[] = [1, 1.5];

/**
 * How far each glass's own backdrop-filter dims what is behind it (brightness(), glass-tokens.css --st-dim for cards,
 * heroes, tinted tiles and the rail, --st-dim-over for bars, plates and sheets), per look. Dimming is not free
 * see-through: what shows of the backdrop through a glass is (1 - veil - its light) x dim (`showThrough`), so it is
 * used only where it shows more than a veil alone, and in Clips Funded it never does (23 Nov, worked out with every
 * test of the light): the espresso veil is nearly black, so a dim takes away as much as the thinner veil gives back.
 * Over the colours a veil alone shows as much (0.57 of the stage through the rail either way), so the cards, heroes,
 * tinted tiles and the rail draw no filter there at all (the WebView2 budget, as on main) and the bars and sheets only
 * their blur and saturate. Over a picture the sheet is at its floor over a white photo and the light's order holds
 * every level under it: dimmed by 0.5 they showed 4 to 13 % of the photo where main's veils show 6 to 14 %, so a
 * picture keeps main's veils (PICTURE). Over the desktop (window) the page is transparent and the window's own glass
 * shows the desktop, which no web filter can reach. So every dim is 1, and the model keeps the dim for the day one
 * pays (the filters carry brightness(var(--st-dim)) at 1).
 */
export type DimKind = "glass" | "over";
export const DIM: Readonly<Record<LookKind, Readonly<Record<DimKind, number>>>> = {
  colours: { glass: 1, over: 1 },
  picture: { glass: 1, over: 1 },
  window: { glass: 1, over: 1 },
};
/** Which dim each kind of glass's filter has (the page is the backdrop itself: nothing filters it). */
export const KIND_DIM: Readonly<Record<keyof Veils, DimKind | null>> = { page: null, card: "glass", tinted: "glass", hero: "glass", rail: "glass", bar: "over", float: "over", plate: "over" };
/** How much of what is behind shows through a glass of veil `veil` and light `light` (its level's, ELEVATION: the light
 *  takes its share from what is behind, lit) whose filter dims it to `dim`, under the page veil `page`: a black and
 *  white edge behind it reads this much through it (measured on main: the rail 0.075, a card 0.118, a hero 0.14 over a
 *  white desktop). */
export function showThrough(veil: number, light = 0, dim = 1, page = 0): number {
  return (1 - page) * Math.max(0, 1 - veil - light) * dim;
}
/** CSS brightness(b) on one colour (Chromium and WebKit apply the filter shorthands in sRGB, each channel x b). */
export function dimRgb([r, g, b]: Rgb, k: number): Rgb {
  return [r * k, g * k, b * k];
}
/** What a glass's backdrop-filter makes of the pixel behind it: brightness(dim), then saturate(s) (in this order, as
 *  glass-tokens.css writes the filters, so no channel clips before it is dimmed). The blur only ever averages, so the
 *  lightest pixel is the worst case. */
export function filtered(under: Rgb, dim: number, s = 1): Rgb {
  const d = dimRgb(under, dim);
  return s === 1 ? d : saturateRgb(d, s);
}

export type ViewUnit = "vmax" | "vmin" | "vw" | "vh";
/**
 * One soft light of the stage: `radial-gradient(rx ry at x% y%, rgb(tone / alpha), transparent stop)`. glass.css
 * .stories-app::before draws exactly these, in this order (the first on top), over the first colour; the test
 * (storiesGlass.test.tsx) holds the two together. `tone` 2 and 3 are the owner's second and third colours.
 */
export interface StageLight {
  tone: 2 | 3 | "shadow";
  alpha: number;
  rx: number;
  ry: number;
  ux?: ViewUnit;
  uy?: ViewUnit;
  /** where its middle is, in % of the window */
  x: number;
  y: number;
  /** where it has faded to nothing, 0..1 of its size (0.7 when left out) */
  stop?: number;
}
/** The warm room of the owner's reference: a lamp's light strip at the right edge, amber high on the right, copper
 *  low on the left, a darker corner behind the page heads, and a warm haze over everything. */
export const STAGE_LIGHTS: readonly StageLight[] = [
  { tone: 3, alpha: 0.34, rx: 7, ux: "vw", ry: 34, uy: "vh", x: 100, y: 48 },
  { tone: 3, alpha: GLOW_ALPHA.third, rx: 46, ry: 36, x: 92, y: 2 },
  { tone: 2, alpha: GLOW_ALPHA.second, rx: 50, ry: 40, x: 0, y: 104 },
  { tone: "shadow", alpha: 0.5, rx: 56, ry: 40, x: 10, y: 8 },
  { tone: 2, alpha: 0.24, rx: 90, ry: 64, x: 56, y: 46, stop: 1 },
];
const SHADOW: Rgb = [10, 6, 3];
/** The windows the stage is worked out over: phones (short and tall), tablets, laptops, desktops, ultrawide, square. */
export const STAGE_WINDOWS: readonly (readonly [number, number])[] = [
  [320, 568],
  [375, 812],
  [320, 900],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [3440, 900],
  [900, 900],
];

/** The stage of these colours as a function: the colour it draws at (x, y) of a w × h window (CSS's gradients,
 *  composited in sRGB, exactly). */
function stageOf(colours: readonly string[], lights: readonly StageLight[] = STAGE_LIGHTS): (x: number, y: number, w: number, h: number) => Rgb {
  const [c1, c2 = c1, c3 = c2] = colours.map(hexToRgb) as Rgb[];
  const tones = { 2: c2!, 3: c3!, shadow: SHADOW };
  const ls = [...lights].reverse().map((l) => ({ ...l, rgb: tones[l.tone], stop: l.stop ?? 0.7, ux: l.ux ?? "vmax", uy: l.uy ?? "vmax" }));
  return (x, y, w, h) => {
    const unit = { vmax: Math.max(w, h) / 100, vmin: Math.min(w, h) / 100, vw: w / 100, vh: h / 100 };
    let r = c1![0],
      g = c1![1],
      b = c1![2];
    for (const l of ls) {
      const dx = (x - (l.x / 100) * w) / (l.rx * unit[l.ux]);
      const dy = (y - (l.y / 100) * h) / (l.ry * unit[l.uy]);
      const a = l.alpha * (1 - Math.sqrt(dx * dx + dy * dy) / l.stop);
      if (a <= 0) continue;
      r = l.rgb[0] * a + r * (1 - a);
      g = l.rgb[1] * a + g * (1 - a);
      b = l.rgb[2] * a + b * (1 - a);
    }
    return [r, g, b];
  };
}
/** The colour the stage draws at (x, y) of a w × h window. */
export function stageAt(colours: readonly string[], x: number, y: number, w: number, h: number, lights: readonly StageLight[] = STAGE_LIGHTS): Rgb {
  return stageOf(colours, lights)(x, y, w, h);
}

const spotCache = new Map<string, Rgb[]>();
/** 0..w in steps, always ending on the edge itself (where the lights at the edge are brightest). */
const steps = (from: number, to: number, by: number) => {
  const out: number[] = [];
  for (let v = from; v < to; v += by) out.push(v);
  out.push(to);
  return out;
};
/** The lightest pixel of `at` per window of STAGE_WINDOWS and saturation, over x from `inset(w)` to w − inset(w). */
function lightestPixels(at: (x: number, y: number, w: number, h: number) => Rgb, saturations: readonly number[], inset: (w: number) => number): Rgb[] {
  const out: Rgb[] = [];
  for (const [w, h] of STAGE_WINDOWS) {
    const [x0, x1] = [inset(w), w - inset(w)];
    for (const s of saturations) {
      let best = { l: -1, x: 0, y: 0, c: [0, 0, 0] as Rgb };
      const look = (x: number, y: number) => {
        const c = at(x, y, w, h);
        const l = luminance(s === 1 ? c : saturateRgb(c, s));
        if (l > best.l) best = { l, x, y, c };
      };
      for (const y of steps(0, h, 32)) for (const x of steps(x0, x1, 32)) look(x, y);
      const { x: bx, y: by } = best;
      for (const y of steps(Math.max(0, by - 32), Math.min(h, by + 32), 4)) for (const x of steps(Math.max(x0, bx - 32), Math.min(x1, bx + 32), 4)) look(x, y);
      out.push(best.c);
    }
  }
  return out;
}
function cached(key: string, work: () => Rgb[]): Rgb[] {
  const hit = spotCache.get(key);
  if (hit) return hit;
  const out = work();
  if (spotCache.size > 32) spotCache.clear();
  spotCache.set(key, out);
  return out;
}

/**
 * The lightest colours the stage can show, worked out from exactly what it draws over every window in
 * STAGE_WINDOWS: per window and saturation, the lightest pixel (a 32 px grid, then 4 px around the best).
 */
export function stageSpots(colours: readonly string[], saturations: readonly number[] = SATURATIONS): Rgb[] {
  return cached(`${colours.join()}|${saturations.join()}`, () => lightestPixels(stageOf(colours), saturations, () => 0));
}

/**
 * The page's side margin (st-frame.css .st-frame: max(--gutter, the safe area), --gutter clamp(16px, 3.2vw, 36px)):
 * nothing of a Stories page, and so no glass control loose on it, sits closer to the window's side than this.
 */
export function frameGutter(w: number): number {
  return Math.min(36, Math.max(16, 0.032 * w));
}
/**
 * The lightest colours a glass control loose on the page can sit on: as stageSpots, but only where a page can put one,
 * inside the frame's side margins (frameGutter). The lamp's light strip at the very right edge of the window (the
 * stage's brightest column) lies in that margin, so it lights the page there but never under a control.
 */
export function controlSpots(colours: readonly string[]): Rgb[] {
  return cached(`${colours.join()}|controls`, () => lightestPixels(stageOf(colours), [1], frameGutter));
}

/** Every colour the stage can show at its lightest, through each saturation (kept for the old name's readers). */
export function meshSpots(colours: readonly string[], saturations: readonly number[] = [1]): Rgb[] {
  return stageSpots(colours).flatMap((s) => saturations.map((k) => saturateRgb(s, k)));
}
const lightest = (spots: readonly Rgb[]): Rgb => spots.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));

/** The veils of every kind of glass (and the page itself), 0..1 of VEIL. */
export interface Veils {
  page: number;
  card: number;
  tinted: number;
  hero: number;
  rail: number;
  bar: number;
  float: number;
  /** behind words loose on the page; 0 where the page itself keeps them readable */
  plate: number;
}

/** Measured over a white desktop or photo (revise-notes, 22 Nov): the floor of See-through in the app (no filter reaches
 *  the desktop), and what a picture's dimmed glass is never lighter than over a white photo. A sheet's (float) is the
 *  card's: its level-5 light (ELEVATION[5]) covers the rest, 0.94 in all, never thinner than the rail, and over white the
 *  light keeps the veil's own contrast (lit). Worked out again on 23 Nov over a white desktop with the light in (lit):
 *  every word on them 5.0:1 or more, a control's words 5.0:1 or more; the AA floor itself (4.5:1 at a surface's top,
 *  with a hovered control on it) is 0.73 for a sheet and 0.74 for the rest (a card's words alone 0.72); under a 0.30
 *  frost 0.65 to 0.72 (a sheet). */
export const MEASURED: Veils = { page: 0, card: 0.74, tinted: 0.8, hero: 0.76, rail: 0.78, bar: 0.78, float: 0.74, plate: 0.78 };
/** Frosted in the app: a 0.30 frost over the desktop and the panels at 0.89. */
export const FROSTED: Veils = { page: 0.3, card: 0.89, tinted: 0.89, hero: 0.89, rail: 0.89, bar: 0.89, float: 0.89, plate: 0.89 };
/** The light's order over a light backdrop (the owner's rule, Clip Factory's own): from the page panel upward every
 *  level is at least LIGHT_STEP brighter in relative luminance than the one under it, gradually; only the page-to-panel
 *  step may go darker, where AA needs the veil. Over a white desktop or photo the light takes its share from what is
 *  behind (lit), so there the order is the veils' alone: each level's veil is thinner than the one under it. */
export const LIGHT_STEP = 0.015;
/** See-through Clear in the app, as drawn (the desktop: nothing of the page is behind the glass, so no filter dims it).
 *  Each glass at or above its measured floor (MEASURED), in the light's order over white: the sheet at its floor (its
 *  level-5 light covers the rest at its top), then every level under it LIGHT_STEP thicker over a white desktop, with
 *  room to spare as the browser draws it: raised surfaces 0.79 (a hero, a bar; a card inside a card lays only a lift of
 *  light over its card, --st-elev-raised-lift), cards 0.84, panels 0.90 (a tinted tile's tone lights it on its own: its
 *  floor, 0.80), as on main. 0.78 / 0.83 / 0.89 left the sheet 0.0150 above a hero and a card inside a card as
 *  e2e/stories-light.spec.ts reads them from the page (a hair under the step). Over a white desktop the worst word is
 *  then 6.2:1 (a sheet), a control's 5.1:1: the light's order, not AA, is what keeps the lower levels thicker
 *  (test/storiesLight.test.ts). */
export const WINDOW_CLEAR: Veils = { page: 0, card: 0.84, tinted: 0.8, hero: 0.79, rail: 0.9, bar: 0.79, float: 0.74, plate: 0.9 };
/** Frosted in the app, as drawn: the 0.30 frost, then the panels in the same order over the frosted desktop, each frost
 *  and glass together at or above its measured floor: sheets 0.72 (a control's words on one 4.9:1 over a white desktop),
 *  raised 0.76, tinted 0.77, cards 0.82, panels 0.90 (23 Nov: 0.72 / 0.77 / 0.82 / 0.84 / 0.96 before). */
export const WINDOW_FROSTED: Veils = { page: 0.3, card: 0.82, tinted: 0.77, hero: 0.76, rail: 0.9, bar: 0.76, float: 0.72, plate: 0.9 };
/** A picture, as drawn: main's veils, the window's (WINDOW_CLEAR). Over a white photo the sheet is at its floor and
 *  the light's order holds every level under it a step darker, as over a white desktop; a dim (DIM.picture) took away
 *  as much as the thinner veils gave back (23 Nov: 0.67 to 0.86 at half the light showed 4 to 13 % of the photo, main's
 *  6 to 14 %), so the glass does not dim a picture. */
export const PICTURE: Veils = { ...WINDOW_CLEAR };
/** The least each glass gets over the colours, whatever they are (the look of glass, not only the maths): a thin smoky
 *  tint, so the colours show through; the rail's keeps it a step brighter than the stage over the espresso. Everything
 *  above the floors is worked out in veilsFor (a control's words on the glass, hovered too; a cream card or the action
 *  under a bar or a sheet): over Ember the rail 0.41, a card 0.46, a hero 0.53, a tinted tile 0.63, a bar 0.66, a sheet
 *  0.70 (main: 0.62 / 0.58 / 0.6 / 0.66 / 0.72 / 0.72, the old floors). */
export const COLOUR_FLOORS: Veils = { page: 0, card: 0.14, tinted: 0.16, hero: 0.13, rail: 0.16, bar: 0.2, float: 0.3, plate: 0 };
/** The tones a tinted tile can take (glass-tokens.css: the action, amber, coral, mint and sky channels). */
export const TINT_TONES: readonly Rgb[] = [
  [255, 154, 69],
  [255, 176, 84],
  [255, 127, 106],
  [111, 217, 164],
  [124, 198, 230],
];
/** What may be under a bar or a sheet besides the page (things scroll under a bar; a sheet opens over the page): a
 *  cream card, the action, the cream card's lower stop. */
export const UNDERLAYS: readonly Rgb[] = [
  [255, 243, 228],
  [255, 154, 69],
  [246, 230, 210],
];
/** Frosted outside the app: the colours under a 0.30 frost. */
export const FROST_PAGE = 0.3;
/** Solid glass (reduced transparency, or the device's choice): every glass at --st-veil-solid; a desktop or a picture
 *  behind is all but covered too (the colours stay: they are the page, not something seen through it). */
export const SOLID = 0.96;
export const SOLID_PAGE = 0.9;
export function solidVeils(page: number): Veils {
  return { page, card: SOLID, tinted: SOLID, hero: SOLID, rail: SOLID, bar: SOLID, float: SOLID, plate: SOLID };
}
/** How much of a tone a colour-tinted tile shows (--st-tint-cut). */
export const TINT_CUT = 0.12;

/** What is drawn for this choice on this device. */
export function lookKind(look: Pick<StoriesLook, "mode" | "picture">, glass: string = nativeGlass()): LookKind {
  if (look.mode === "see-through") return glass !== "none" ? "window" : "colours";
  if (look.mode === "picture") return look.picture ? "picture" : "colours";
  return "colours";
}

/** The colours the stage shows: the owner's own for Colours, Ember for everything else drawn by the page. */
export function stageColours(look: Pick<StoriesLook, "mode" | "colours">): readonly string[] {
  return look.mode === "colours" ? normaliseColours(look.colours) : EMBER;
}

/** A glass control loose on the page over the colours (glass-tokens.css): --st-fill-control, cream at 0.12, with its
 *  level-4 light at its top (--st-light-4, ELEVATION_TOP[4]); hovered, --st-fill-control-hover (CONTROL_HOVER). */
export const LOOSE_CONTROL_FILL = 0.12;
export const CONTROL_HOVER: { rgb: Rgb; alpha: number } = { rgb: [139, 128, 118], alpha: 0.33 };
/** The words on a loose control (--st-text) keep a little more than AA over the owner's own colours. */
export const CONTROL_TARGET = 4.6;
const CONTROL_INKS: readonly Rgb[] = [hexToRgb(INKS.ink!)];
/** A loose control at rest (its brightest part, the top) and hovered, over `page` of what the page shows there. */
export function looseControl(page: Rgb): { rest: Rgb; hover: Rgb } {
  const fill = 1 - (1 - LOOSE_CONTROL_FILL) * (1 - ELEVATION_TOP[4]!);
  return { rest: mix(CREAM, page, fill), hover: mix(CREAM, mix(CONTROL_HOVER.rgb, page, CONTROL_HOVER.alpha), ELEVATION_TOP[4]!) };
}
/** The least page veil at which a loose control's words keep CONTROL_TARGET over every one of these spots (veilsFor: controlSpots). */
export function minPageForControls(spots: readonly Rgb[]): number {
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const ok = spots.every((s) => {
      const { rest, hover } = looseControl(mix(VEIL, s, v));
      return CONTROL_INKS.every((t) => contrast(t, rest) >= CONTROL_TARGET && contrast(t, hover) >= CONTROL_TARGET);
    });
    if (ok) return Math.round(v * 100) / 100;
  }
  return 1;
}

/** A glass control inside glass over the colours, hovered (its brightest: --st-fill-control-lift, cream 0.16; at rest
 *  --st-fill-control, cream 0.12), with its --st-light-4 at its top. */
export const CONTROL_LIFT = 0.16;
const CONTROL_HOVERED = 1 - (1 - CONTROL_LIFT) * (1 - ELEVATION_TOP[4]!);
const CONTROL_AT_REST = 1 - (1 - LOOSE_CONTROL_FILL) * (1 - ELEVATION_TOP[4]!);
const MUTED: Rgb = [220, 202, 180];
const STRONG: Rgb = [255, 250, 242];
/** The words on a control: its label and its second line. */
const CONTROL_WORDS: readonly Rgb[] = [STRONG, hexToRgb(INKS.ink!), hexToRgb(INKS["ink-soft"]!)];
const GLASS_WORDS: readonly Rgb[] = [STRONG, ...INK_RGB];
const CARD_WORDS: readonly Rgb[] = [...GLASS_WORDS, MUTED];
const readable = (bg: Rgb, inks: readonly Rgb[]) => inks.every((t) => contrast(t, bg) >= AA);
/** Its words, and a control's words on it (hovered: its brightest), at AA. On a sheet (whose own light is the top of the
 *  scale) and on a tinted tile (whose tone is light too) a control is held at rest: its hover lift there is brighter
 *  than a thin veil carries over the stage's brightest spot (it was under 4.5:1 there before too: 3.8:1 on a tinted
 *  tile, now 4.1:1). */
const holds = (bg: Rgb, inks: readonly Rgb[], control = CONTROL_HOVERED) => readable(bg, inks) && readable(mix(CREAM, bg, control), CONTROL_WORDS);
/** The least veil from `floor` up (in steps of 0.01) for which `ok` holds. */
function least(floor: number, ok: (v: number) => boolean): number {
  for (let n = Math.round(floor * 100); n <= 100; n++) if (ok(n / 100)) return n / 100;
  return 1;
}
const topLight = (level: number) => ELEVATION[level]! + ELEVATION_TOP[level]!;
/** A card inside a card over the colours covers this much more of what the hero's veil lets through (glass-tokens.css
 *  --st-raised-cover, --st-shade-raised): its card's light under it never stacks past a sheet's. */
export const RAISED_COVER = 0.6;
export const raisedVeil = (hero: number) => 1 - (1 - hero) * (1 - RAISED_COVER);

const veilCache = new Map<string, Veils>();
/** The veils over these colours (and this page veil): each glass over every lightest spot as its own filter shows it
 *  (filtered: dimmed by DIM.colours, through each saturation), at its top (its brightest part): its words, and a
 *  control's words on it, at AA; a card's hints too; the hero's veil also lays a card inside a card (over its card,
 *  glass.css .st-glass .st-glass, with no filter of its own) and keeps that one's words and its controls' at rest; a
 *  tinted tile with every tone; a bar and a sheet over a cream card or the action too. */
function colourVeils(spots: readonly Rgb[], page: number): Veils {
  const key = `${spots.map((s) => s.map((c) => c.toFixed(1)).join(",")).join("|")}|${page}`;
  const hit = veilCache.get(key);
  if (hit) return { ...hit };
  const seen = (dim: number, extra: readonly Rgb[] = []) => [...spots.map((s) => mix(VEIL, s, page)), ...extra].flatMap((s) => SATURATIONS.map((k) => filtered(s, dim, k)));
  const glass = seen(DIM.colours.glass);
  const over = seen(DIM.colours.over);
  const underlays = UNDERLAYS.flatMap((u) => SATURATIONS.map((k) => filtered(u, DIM.colours.over, k)));
  const out: Veils = { ...COLOUR_FLOORS, page };
  out.rail = least(COLOUR_FLOORS.rail, (v) => glass.every((u) => holds(lit(u, v, topLight(1)), GLASS_WORDS)));
  out.card = least(COLOUR_FLOORS.card, (v) => glass.every((u) => holds(lit(u, v, topLight(2)), CARD_WORDS)));
  // (a plain card inside a sheet, a bar or a tinted tile is that card's veil laid over it: its words hold there too)
  const cardIn = (bg: Rgb) => readable(lit(bg, out.card, topLight(2)), CARD_WORDS);
  out.hero = least(COLOUR_FLOORS.hero, (v) =>
    glass.every((u) => holds(lit(u, v, topLight(3)), GLASS_WORDS) && holds(lit(lit(u, out.card, topLight(2)), raisedVeil(v), topLight(3)), CARD_WORDS, CONTROL_AT_REST)),
  );
  const tile = (u: Rgb, v: number, tone: Rgb) => mix(CREAM, mix(tone, mix(VEIL, u, Math.min(1, v / (1 - topLight(3)))), TINT_CUT), topLight(3));
  out.tinted = least(COLOUR_FLOORS.tinted, (v) => glass.every((u) => TINT_TONES.every((tone) => holds(tile(u, v, tone), GLASS_WORDS, CONTROL_AT_REST) && cardIn(tile(u, v, tone)))));
  for (const [k, level, control] of [["bar", 3, CONTROL_HOVERED], ["float", 5, CONTROL_AT_REST]] as const)
    out[k] = least(
      COLOUR_FLOORS[k],
      (v) => over.every((u) => holds(lit(u, v, topLight(level)), GLASS_WORDS, control) && cardIn(lit(u, v, topLight(level)))) && underlays.every((u) => readable(lit(u, v, topLight(level)), GLASS_WORDS)),
    );
  if (veilCache.size > 64) veilCache.clear();
  veilCache.set(key, out);
  return { ...out };
}

/** The veils for this look, worked out so every word stays at 4.5:1 over the lightest pixel it can sit on. */
export function veilsFor(look: StoriesLook, glass: string = nativeGlass(), tier: GlassTier = "simple"): Veils {
  const kind = lookKind(look, glass);
  if (tier === "solid") return solidVeils(kind === "colours" ? veilsFor(look, glass).page : SOLID_PAGE);
  if (kind === "window") return look.strength === "frosted" ? { ...WINDOW_FROSTED } : { ...WINDOW_CLEAR };
  if (kind === "picture") return { ...PICTURE };
  const colours = stageColours(look);
  const spots = stageSpots(colours);
  // Loose words on the page: the page veil keeps them readable over the lightest spot (Frosted adds its frost). It
  // also keeps a glass control's words loose on the page at CONTROL_TARGET (its cream fill and level-4 light lie over
  // the veil), measured where a page can put a control (controlSpots, inside the frame's side margins): the owner's
  // own bright colours measured 4.47:1 with the words' veil alone, and mid-tones that need no veil for words
  // (#446677, #0066aa, #3355dd) 4.33-4.43:1 with none. Ember, Rose and Lagoon need none: their loose controls measure
  // 4.87:1 or more there, at rest and hovered (only the lamp's strip in the window's very edge column, where no
  // control sits, is brighter). Nothing filters the page itself, so these are worked out over the stage as drawn.
  const words = minVeil(lightest(spots));
  const loose = Math.max(words, minPageForControls(controlSpots(colours)));
  const page = Math.max(loose, look.mode === "see-through" && look.strength === "frosted" ? FROST_PAGE : 0);
  // Under the glass: the page veil, then each glass's own filter (its dim and its saturate), then its veil and its own
  // level's light at its top (the brightest part of it), the light taking its share from what is behind (lit).
  return colourVeils(spots, page);
}

// ---------- The choice (Stories' own prefs) ----------

const HEX = /^#[0-9a-f]{6}$/;
const isMode = (v: unknown): v is LookMode => typeof v === "string" && (LOOK_MODES as readonly string[]).includes(v);
const isStrength = (v: unknown): v is GlassStrength => typeof v === "string" && (GLASS_STRENGTHS as readonly string[]).includes(v);
const isTier = (v: unknown): v is GlassTier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

/** 1 to 3 distinct lower-case #rrggbb colours; anything unusable is Ember. */
export function normaliseColours(v: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(v))
    for (const c of v) {
      if (typeof c !== "string" || !HEX.test(c.toLowerCase())) continue;
      const hex = c.toLowerCase();
      if (!out.includes(hex)) out.push(hex);
      if (out.length === MAX_COLOURS) break;
    }
  return out.length ? out : [...EMBER];
}

/** The preset these colours are, or null for the owner's own. */
export function presetOf(colours: readonly string[]): string | null {
  return PRESETS.find((p) => p.colours.length === colours.length && p.colours.every((c, i) => c === colours[i]))?.id ?? null;
}

function readPicture(): string | null {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(PICTURE_KEY);
    return v && v.startsWith("data:image/") ? v : null;
  } catch {
    return null;
  }
}

let picture: string | null | undefined;
const pictureListeners = new Set<() => void>();

/** Stories' own look on this device (each part unset is its default: Colours › Ember, Clear). */
export function storiesLook(): StoriesLook {
  const more = storiesPrefs().more;
  if (picture === undefined) picture = readPicture();
  const mode = more[LOOK_KEYS.mode];
  const strength = more[LOOK_KEYS.strength];
  return {
    mode: isMode(mode) ? mode : DEFAULT_MODE,
    strength: isStrength(strength) ? strength : DEFAULT_STRENGTH,
    colours: normaliseColours(more[LOOK_KEYS.colours]),
    picture,
  };
}

/** Keeps part of the choice. Picking a strength picks See-through, colours pick Colours, a picture picks Picture. */
export function setStoriesLook(patch: Partial<Pick<StoriesLook, "mode" | "strength" | "colours">>): void {
  if (patch.strength !== undefined && isStrength(patch.strength)) setStoriesPref(LOOK_KEYS.strength, patch.strength);
  if (patch.colours !== undefined) setStoriesPref(LOOK_KEYS.colours, normaliseColours(patch.colours));
  if (patch.mode !== undefined && isMode(patch.mode)) setStoriesPref(LOOK_KEYS.mode, patch.mode);
}

/** Keeps (or with null forgets) the picture; false when it does not fit in this device's storage. */
export function setStoriesPicture(url: string | null): boolean {
  let stored = true;
  try {
    if (url) localStorage.setItem(PICTURE_KEY, url);
    else localStorage.removeItem(PICTURE_KEY);
  } catch {
    stored = false;
  }
  if (stored) {
    picture = url;
    look = null;
    for (const fn of pictureListeners) fn();
  }
  return stored;
}

let look: { more: unknown; picture: string | null | undefined; value: StoriesLook } | null = null;
function snapshot(): StoriesLook {
  const more = storiesPrefs().more;
  if (look && look.more === more && look.picture === picture) return look.value;
  const value = storiesLook();
  look = { more, picture, value };
  return value;
}
const SERVER_LOOK: StoriesLook = { mode: DEFAULT_MODE, strength: DEFAULT_STRENGTH, colours: [...EMBER], picture: null };

/** Re-renders when the look changes, here or on another screen. */
export function useStoriesLook(): StoriesLook {
  return useSyncExternalStore(
    (fn) => {
      const off = onStoriesPrefs(fn);
      pictureListeners.add(fn);
      return () => {
        off();
        pictureListeners.delete(fn);
      };
    },
    snapshot,
    () => SERVER_LOOK,
  );
}

// ---------- The glass on this device ----------

export interface GlassEnv {
  /** Chromium (main.tsx puts html.refract): backdrop-filter can bend with url() */
  refract: boolean;
  reducedTransparency: boolean;
  /** backdrop-filter works at all */
  backdrop: boolean;
  /** 4 cores or fewer, 4 GB or less, or Save-Data: the liquid rim stays off */
  lowPower: boolean;
}

/** Solid glass: the device asks for less transparency, or for more contrast (as glass-tokens.css's @media does). */
const REDUCED_TRANSPARENCY = "(prefers-reduced-transparency: reduce), (prefers-contrast: more)";
export function readGlassEnv(): GlassEnv {
  if (typeof window === "undefined" || typeof document === "undefined") return { refract: false, reducedTransparency: false, backdrop: true, lowPower: true };
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const supports = typeof CSS !== "undefined" && typeof CSS.supports === "function";
  return {
    refract: document.documentElement.classList.contains("refract"),
    // (more contrast too: the style sheet's solid glass, glass-tokens.css, asks for both)
    reducedTransparency: typeof matchMedia === "function" && matchMedia(REDUCED_TRANSPARENCY).matches,
    backdrop: supports ? CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)") : true,
    lowPower: (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4) || nav.connection?.saveData === true,
  };
}

/** Liquid only in Chromium on a capable device; WebKit gets plain CSS light; reduced transparency gets solid glass. */
export function glassTier(env: GlassEnv, chosen: unknown = storiesPrefs().more[LOOK_KEYS.glass]): GlassTier {
  if (env.reducedTransparency || !env.backdrop) return "solid";
  if (isTier(chosen)) return chosen === "liquid" && !env.refract ? "simple" : chosen;
  return env.refract && !env.lowPower ? "liquid" : "simple";
}

/** At most this many liquid rims on one screen (WebView2's budget); the rest keep the plain CSS light (glass/lens.ts). */
export { LENS_BUDGET };

// ---------- Putting it on the page ----------

const rgbOf = (hex: string) => hexToRgb(hex).join(" ");

/** The attributes and custom properties for .stories-app. */
export function lookProps(value: StoriesLook, glass: string = nativeGlass(), tier: GlassTier = "simple"): { attrs: Record<string, string>; style: Record<string, string> } {
  const kind = lookKind(value, glass);
  // Inline, so it beats every rule: solid glass must come from here (glass-tokens.css's @media is only the first paint).
  const v = veilsFor(value, glass, tier);
  const style: Record<string, string> = {};
  for (const k of Object.keys(v) as (keyof Veils)[]) style[`--st-veil-${k}`] = String(v[k]);
  const [c1, c2 = c1, c3 = c2] = stageColours(value);
  style["--st-stage-c1"] = c1!;
  style["--st-stage-c2-rgb"] = rgbOf(c2!);
  style["--st-stage-c3-rgb"] = rgbOf(c3!);
  return { attrs: { "data-look": kind, "data-strength": value.strength, "data-glass": tier }, style };
}

/** The theme colour of the window while Stories is on screen. */
export const THEME_COLOUR = "#1C130E";

const STYLE_KEYS = ["--st-veil-page", "--st-veil-card", "--st-veil-tinted", "--st-veil-hero", "--st-veil-rail", "--st-veil-bar", "--st-veil-float", "--st-veil-plate", "--st-stage-c1", "--st-stage-c2-rgb", "--st-stage-c3-rgb", "--st-picture"];

/** Writes the look onto .stories-app (attributes and custom properties only: React draws neither). */
export function applyStoriesLook(el: HTMLElement, value: StoriesLook, glass: NativeGlass = nativeGlass(), tier: GlassTier = glassTier(readGlassEnv())): LookKind {
  const { attrs, style } = lookProps(value, glass, tier);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of STYLE_KEYS) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  if (attrs["data-look"] === "picture" && value.picture) el.style.setProperty("--st-picture", `url("${value.picture}")`);
  return attrs["data-look"] as LookKind;
}

/** True while the device asks for less transparency (it can change while Stories is open). */
export function useReducedTransparency(): boolean {
  return useSyncExternalStore(
    (fn) => {
      if (typeof matchMedia !== "function") return () => undefined;
      const q = matchMedia(REDUCED_TRANSPARENCY);
      q.addEventListener?.("change", fn);
      return () => q.removeEventListener?.("change", fn);
    },
    () => typeof matchMedia === "function" && matchMedia(REDUCED_TRANSPARENCY).matches,
    () => false,
  );
}

/**
 * The background hook: StoriesApp's one call. Follows Stories' own Look (here or from Settings › Look on another
 * screen) and puts it on `root`; in See-through in the app it asks the shell for a transparent page while Stories is on
 * screen, so the window's glass shows the desktop. `active` (Stories is on screen) turns the liquid rim on.
 */
export function useStoriesBackground(root: RefObject<HTMLElement | null>, active: boolean): StoriesLook {
  const value = useStoriesLook();
  const lessTransparency = useReducedTransparency();
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // See-through in the app: Stories' wish is the page itself transparent (html.see-through) while it is on screen.
    // The shell writes the class from the wish of the app it shows (app/shell.ts), so Stories never reads, keeps or
    // takes away Clip Factory's, and nothing of Clip Factory's is drawn under Stories (the shell draws Clip Factory's
    // backdrop only while Clip Factory is on screen, app/ClipsBackdrop.tsx).
    setPageGlass("stories", applyStoriesLook(el, value) === "window");
  }, [root, value, lessTransparency]);
  useLayoutEffect(() => () => setPageGlass("stories", false), []);
  // The liquid rim (glass/lens.ts): only while Stories is on screen, only where the glass is "liquid" (Chromium on a
  // capable device; the layout effect above has just put data-glass on the root), and never over the window's own
  // glass (See-through in the app: the desktop is not part of the page, so there is nothing to bend, and the hero's
  // veil must not depend on a filter drawing over a see-through page).
  useEffect(() => {
    const el = root.current;
    if (!el || !active || el.dataset.glass !== "liquid" || el.dataset.look === "window") return;
    return watchLenses(el);
  }, [root, value, active, lessTransparency]);
  return value;
}
