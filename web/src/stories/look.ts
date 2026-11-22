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
// The veils: the least smoky tint that keeps every word at 4.5:1 over the lightest pixel each look can show. Over a
// desktop or a picture that is white (the worst case of any photo or busy desktop), so the measured numbers hold
// (tiles 0.74, tinted tiles 0.80 with the colour cut to 0.12, hero 0.76, rail 0.78, Frosted 0.30 + 0.89). Over the
// colours they are worked out here from exactly what the stage draws (meshSpots), the way Clip Factory's
// lib/background.ts does for its own. StoriesApp calls useStoriesBackground(root, active) once: it puts the result on
// .stories-app (data-look, data-strength, data-glass, the --st-veil-* numbers and the stage colours), and
// glass.css paints .stories-app::before from them. Stories depends on nothing of Clip Factory's here: the two small
// readers below are Stories' own copies.
import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
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
export const EMBER: readonly string[] = ["#1c130e", "#e0763a", "#ffa852"];
export const PRESETS: readonly { id: string; name: string; colours: readonly string[] }[] = [
  { id: "ember", name: "Ember", colours: EMBER },
  { id: "rose", name: "Rose", colours: ["#21121a", "#c8546a", "#ffae86"] },
  { id: "lagoon", name: "Lagoon", colours: ["#0d1a1b", "#2c8a86", "#f0b064"] },
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

/** How strong the stage's two soft lights are (glass-tokens.css --st-stage-a2, --st-stage-a3). */
export const GLOW_ALPHA = { second: 0.3, third: 0.3 } as const;
/** What a bar's backdrop-filter can do to the colours under it (none, and the bar's saturate). */
export const SATURATIONS: readonly number[] = [1, 1.35];

/**
 * Every colour the colours stage can show (glass.css .st-backdrop__colours): the base, each light over it, and both
 * lights over each other (they can meet in the middle of a small window), each through every saturation.
 */
export function meshSpots(colours: readonly string[], saturations: readonly number[] = [1]): Rgb[] {
  const [c1, c2 = c1, c3 = c2] = colours.map(hexToRgb) as Rgb[];
  const base = c1!;
  const two = mix(c2!, base, GLOW_ALPHA.second);
  const spots = [base, two, mix(c3!, base, GLOW_ALPHA.third), mix(c3!, two, GLOW_ALPHA.third)];
  return spots.flatMap((s) => saturations.map((k) => saturateRgb(s, k)));
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

/** Measured over a white desktop or photo (revise-notes, 22 Nov): the floor of See-through in the app and Picture. */
export const MEASURED: Veils = { page: 0, card: 0.74, tinted: 0.8, hero: 0.76, rail: 0.78, bar: 0.78, float: 0.8, plate: 0.78 };
/** Frosted in the app: a 0.30 frost over the desktop and the panels at 0.89. */
export const FROSTED: Veils = { page: 0.3, card: 0.89, tinted: 0.89, hero: 0.89, rail: 0.89, bar: 0.89, float: 0.89, plate: 0.89 };
/** The least each glass gets over the colours, whatever they are (the look of glass, not only the maths). */
export const COLOUR_FLOORS: Veils = { page: 0, card: 0.58, tinted: 0.66, hero: 0.6, rail: 0.62, bar: 0.72, float: 0.76, plate: 0 };
/** Frosted outside the app: the colours under a 0.30 frost. */
export const FROST_PAGE = 0.3;
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

/** The veils for this look, worked out so every word stays at 4.5:1 over the lightest pixel it can sit on. */
export function veilsFor(look: StoriesLook, glass: string = nativeGlass()): Veils {
  const kind = lookKind(look, glass);
  if (kind === "window") return look.strength === "frosted" ? { ...FROSTED } : { ...MEASURED };
  if (kind === "picture") return { ...MEASURED };
  const colours = stageColours(look);
  // Loose words on the page: the page veil keeps them readable over the lightest spot (Frosted adds its frost).
  const loose = minVeil(lightest(meshSpots(colours)));
  const page = Math.max(loose, look.mode === "see-through" && look.strength === "frosted" ? FROST_PAGE : 0);
  // Under the glass: the page veil, then each glass over the lightest spot a bar's saturate can make.
  const under = mix(VEIL, lightest(meshSpots(colours, SATURATIONS)), page);
  const need = minVeil(under);
  const out = { ...COLOUR_FLOORS, page };
  for (const k of ["card", "tinted", "hero", "rail", "bar", "float"] as const) out[k] = Math.max(COLOUR_FLOORS[k], need);
  return out;
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

export function readGlassEnv(): GlassEnv {
  if (typeof window === "undefined" || typeof document === "undefined") return { refract: false, reducedTransparency: false, backdrop: true, lowPower: true };
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const supports = typeof CSS !== "undefined" && typeof CSS.supports === "function";
  return {
    refract: document.documentElement.classList.contains("refract"),
    reducedTransparency: typeof matchMedia === "function" && matchMedia("(prefers-reduced-transparency: reduce)").matches,
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

/** At most this many liquid rims on one screen (WebView2's budget); the rest keep the plain CSS light. */
export const LENS_BUDGET = 3;

// ---------- Putting it on the page ----------

const rgbOf = (hex: string) => hexToRgb(hex).join(" ");

/** The attributes and custom properties for .stories-app. */
export function lookProps(value: StoriesLook, glass: string = nativeGlass(), tier: GlassTier = "simple"): { attrs: Record<string, string>; style: Record<string, string> } {
  const kind = lookKind(value, glass);
  const v = veilsFor(value, glass);
  const style: Record<string, string> = {};
  for (const k of Object.keys(v) as (keyof Veils)[]) style[`--st-veil-${k}`] = String(v[k]);
  const [c1, c2 = c1, c3 = c2] = stageColours(value);
  style["--st-stage-c1"] = c1!;
  style["--st-stage-c2-rgb"] = rgbOf(c2!);
  style["--st-stage-c3-rgb"] = rgbOf(c3!);
  return { attrs: { "data-look": kind, "data-strength": value.strength, "data-glass": tier }, style };
}

/**
 * See-through in the app: the page must be transparent while Stories is on screen (html.see-through, the class Clip
 * Factory's own see-through uses). Stories adds it only when it was not there and takes away only what it added, so
 * Clip Factory's own look is exactly as Clip Factory's settings left it when Stories goes off screen.
 */
const HELD = "stSeeThrough";
export function holdWindowGlass(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) {
    if (!root.classList.contains("see-through")) {
      root.classList.add("see-through");
      root.dataset[HELD] = "1";
    }
    return;
  }
  if (root.dataset[HELD] !== "1") return;
  delete root.dataset[HELD];
  root.classList.remove("see-through");
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

/**
 * The background hook: StoriesApp's one call. Follows Stories' own Look (here or from Settings › Look on another
 * screen) and puts it on `root`; while Stories is on screen (`active`) in See-through in the app, the page itself is
 * transparent so the window's glass shows the desktop.
 */
export function useStoriesBackground(root: RefObject<HTMLElement | null>, active: boolean): StoriesLook {
  const value = useStoriesLook();
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const kind = applyStoriesLook(el, value);
    holdWindowGlass(active && kind === "window");
  }, [root, value, active]);
  useLayoutEffect(() => () => holdWindowGlass(false), []);
  return value;
}
