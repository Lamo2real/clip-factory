// What sits behind the glass (docs/CONTRACTS.md §22): see-through (the default), the owner's picture, or 1 to 3
// colours. Pure functions, so the choice and the contrast maths can be tested without a browser.

export type BackgroundMode = "see-through" | "picture" | "colours";
export type GlassStrength = "clear" | "frosted";
/** The native window glass the desktop app draws behind the page (`window.__CF_GLASS__`, set by desktop/). */
export type NativeGlass = "vibrancy" | "mica" | "acrylic" | "blur" | "none";
export type Scheme = "light" | "dark";
export type Rgb = readonly [number, number, number];

export const BACKGROUND_MODES: readonly BackgroundMode[] = ["see-through", "picture", "colours"];
export const GLASS_STRENGTHS: readonly GlassStrength[] = ["clear", "frosted"];
export const DEFAULT_MODE: BackgroundMode = "see-through";
export const DEFAULT_STRENGTH: GlassStrength = "clear";
export const MAX_COLOURS = 3;

/** Kid-friendly swatches, in the order they are shown. The first three are the Clip Factory colours. */
export const SWATCHES: readonly { hex: string; name: string }[] = [
  { hex: "#9caf88", name: "Sage" },
  { hex: "#f7f5ef", name: "Cream" },
  { hex: "#e8412c", name: "Tomato" },
  { hex: "#f6c945", name: "Sunny" },
  { hex: "#7fd8be", name: "Mint" },
  { hex: "#7cc4f2", name: "Sky" },
  { hex: "#2b6cb0", name: "Ocean" },
  { hex: "#8e6cc9", name: "Grape" },
  { hex: "#f49ac1", name: "Bubblegum" },
  { hex: "#1f2937", name: "Night" },
];
export const DEFAULT_COLOURS: readonly string[] = ["#9caf88", "#f7f5ef", "#e8412c"];

export function isBackgroundMode(v: unknown): v is BackgroundMode {
  return typeof v === "string" && (BACKGROUND_MODES as readonly string[]).includes(v);
}
export function isGlassStrength(v: unknown): v is GlassStrength {
  return typeof v === "string" && (GLASS_STRENGTHS as readonly string[]).includes(v);
}

const HEX = /^#[0-9a-f]{6}$/;
export function isHexColour(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v.toLowerCase());
}

/** 1 to 3 distinct lower-case `#rrggbb` colours; anything unusable falls back to the Clip Factory colours. */
export function normaliseColours(v: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const c of v) {
      if (!isHexColour(c)) continue;
      const hex = c.toLowerCase();
      if (!out.includes(hex)) out.push(hex);
      if (out.length === MAX_COLOURS) break;
    }
  }
  return out.length ? out : [...DEFAULT_COLOURS];
}

/** The name of a swatch, or "Your colour" for one picked with the colour picker. */
export function colourName(hex: string): string {
  return SWATCHES.find((s) => s.hex === hex.toLowerCase())?.name ?? "Your colour";
}

/** Only the desktop wrapper can say there is real window glass; anything else (or an unknown value) is "none". */
export function readNativeGlass(w: { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown } | undefined): NativeGlass {
  if (!w || w.__CF_DESKTOP__ !== true) return "none";
  const g = w.__CF_GLASS__;
  return g === "vibrancy" || g === "mica" || g === "acrylic" || g === "blur" ? g : "none";
}

// ---------- Contrast (WCAG 2.x) ----------

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** `over` at `alpha` on top of `under`, the way browsers composite (in sRGB). */
export function mix(over: Rgb, under: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => over[i]! * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;
}

/** WCAG AA for body text. */
export const AA = 4.5;

/** Every text colour that can sit straight on the backdrop: ink, ink-2, ink-3 and tomato-ink (tokens.css). */
export const TEXT_COLOURS: readonly Rgb[] = ["#1e2a1b", "#2f3b2c", "#46523f", "#a92b1b"].map(hexToRgb);
/** The veil and the glass are Clip Factory off-white. */
export const VEIL: Rgb = hexToRgb("#f7f5ef");

/**
 * The off-white tint the desktop app lays into its window glass, as alpha 0..1: `GLASS_TINT` in
 * desktop/src-tauri/src/main.rs is `Color(247, 245, 239, 140)`, the same off-white as `VEIL`. Keep the two in step.
 */
export const GLASS_TINT_ALPHA = 140 / 255;
/** What that tint gives over a black wallpaper: about rgb(135.6, 134.5, 131.2). Worked out, never rounded by hand. */
export const TINTED_FLOOR: Rgb = mix(VEIL, [0, 0, 0], GLASS_TINT_ALPHA);
const BLACK: Rgb = [0, 0, 0];

/**
 * The darkest the native window glass can be behind the page (docs/CONTRACTS.md §22.3).
 * - `blur` (Windows 10 1809 to Windows 11 21H2): the system honours the app's tint, so the glass is never darker than
 *   the tint over black, `TINTED_FLOOR`.
 * - `acrylic` (Windows 11 22H2+) and `vibrancy` (macOS): the system draws its own light material and drops the app's
 *   tint (Windows 11 acrylic ignores it; macOS 11-15 vibrancy takes none; macOS 26 Liquid Glass is unproven), so
 *   nothing is promised: assume black.
 * - A dark system setting could give a dark material on any of them: assume black.
 */
export function glassFloor(glass: NativeGlass, scheme: Scheme): Rgb {
  return glass === "blur" && scheme === "light" ? TINTED_FLOOR : BLACK;
}

/**
 * See-through keeps the wallpaper visible between the panels and puts the readability tint only where there is text
 * (§22.3). Clear: nothing over the window's own glass in the gaps. Frosted: a light frost over the whole window too.
 */
const PAGE_VEIL: Record<GlassStrength, number> = { clear: 0, frosted: 0.3 };
/** How much heavier a Frosted panel is than the least that keeps text readable. */
const FROSTED_EXTRA = 0.1;

/**
 * The smallest veil strength (0..1, rounded up to 0.01) at which every text colour reaches `target` contrast on the
 * veil laid over `under`.
 */
export function minVeil(under: Rgb, texts: readonly Rgb[] = TEXT_COLOURS, veil: Rgb = VEIL, target = AA): number {
  for (let step = 0; step <= 100; step++) {
    const alpha = step / 100;
    const bg = mix(veil, under, alpha);
    if (texts.every((t) => contrast(t, bg) >= target)) return alpha;
  }
  return 1;
}

export interface SeeThroughVeils {
  /** Over the whole window, between the panels: what the wallpaper shows through. */
  page: number;
  /** Over every panel and every piece of text that sits straight on the window: enough for AA on the darkest glass. */
  panel: number;
}

/** The two tints in see-through for this glass, system setting and strength. */
export function seeThroughVeils(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): SeeThroughVeils {
  const page = PAGE_VEIL[strength];
  const base = minVeil(mix(VEIL, glassFloor(glass, scheme), page));
  const panel = strength === "frosted" ? Math.min(0.95, round2(base + FROSTED_EXTRA)) : base;
  return { page, panel };
}

/** What text actually sits on in see-through, over the darkest glass: the page tint, then the panel tint. */
export function seeThroughWorstBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): Rgb {
  const v = seeThroughVeils(glass, scheme, strength);
  return mix(VEIL, mix(VEIL, glassFloor(glass, scheme), v.page), v.panel);
}

/**
 * The veil over a colours backdrop. The blend between two colours can be darker than either (sRGB mixing), so each
 * colour and each half-and-half pair is checked, and the veil is strong enough for the darkest of them.
 */
export function coloursVeil(colours: readonly string[]): number {
  const rgbs = normaliseColours(colours).map(hexToRgb);
  const samples: Rgb[] = [...rgbs];
  for (let i = 0; i < rgbs.length; i++) for (let j = i + 1; j < rgbs.length; j++) samples.push(mix(rgbs[i]!, rgbs[j]!, 0.5));
  return Math.max(0, ...samples.map((s) => minVeil(s)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- What to draw ----------

export type Look =
  /** Desktop app with real window glass: the page is transparent; the panels carry the tint that keeps text readable. */
  | { kind: "window"; glass: NativeGlass; strength: GlassStrength; pageVeil: number; panelVeil: number }
  /** See-through where the page cannot see behind itself: frosted Clip Factory colours that still move. */
  | { kind: "frosted"; strength: GlassStrength }
  | { kind: "picture"; url: string }
  /** Picture chosen but none on this device yet: the Clip Factory colours. */
  | { kind: "brand" }
  | { kind: "colours"; colours: string[]; veil: number };

export interface LookInput {
  mode: BackgroundMode;
  picture: string | null;
  colours: readonly string[];
  strength: GlassStrength;
  glass: NativeGlass;
  scheme: Scheme;
}

export function resolveLook(i: LookInput): Look {
  switch (i.mode) {
    case "see-through":
      if (i.glass === "none") return { kind: "frosted", strength: i.strength };
      {
        const v = seeThroughVeils(i.glass, i.scheme, i.strength);
        return { kind: "window", glass: i.glass, strength: i.strength, pageVeil: v.page, panelVeil: v.panel };
      }
    case "picture":
      return i.picture ? { kind: "picture", url: i.picture } : { kind: "brand" };
    case "colours": {
      const colours = normaliseColours(i.colours);
      return { kind: "colours", colours, veil: coloursVeil(colours) };
    }
  }
}

/** The one plain line under the choice, so nobody wonders why see-through looks different here. */
export function seeThroughNote(glass: NativeGlass, desktopApp: boolean, phone = false): string | null {
  if (glass !== "none") return null;
  if (desktopApp) return "This computer can't show see-through, so here you get the Clip Factory colours.";
  if (phone) return "See-through works in the Mac and Windows app on a computer. Phones don't let apps look behind them, so here you get the Clip Factory colours.";
  return "See-through works in the Mac and Windows app. Browsers don't let apps look behind them, so here you get the Clip Factory colours.";
}

/** Above this veil a colour shows clearly softer than its swatch, so the Colours card says why. */
export const SOFT_COLOURS_VEIL = 0.5;
export const SOFT_COLOURS_NOTE = "Dark colours show soft, so words stay easy to read.";
