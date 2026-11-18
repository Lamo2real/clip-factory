// What sits behind the glass (docs/CONTRACTS.md §22): see-through (the default), the owner's picture, or 1 to 3
// colours. Pure functions, so the choice and the contrast maths can be tested without a browser.

export type BackgroundMode = "see-through" | "picture" | "colours";
export type GlassStrength = "clear" | "frosted";
/**
 * The native window glass the desktop app draws behind the page (`window.__CF_GLASS__`, set by desktop/):
 * `liquid` is macOS 26+ Liquid Glass, `vibrancy` the under-window material of macOS 15 and older, `acrylic` Windows 11
 * 22H2+, `blur` Windows 10 1809 to Windows 11 21H2. `mica` is understood but never sent (§22.2).
 */
export type NativeGlass = "liquid" | "vibrancy" | "mica" | "acrylic" | "blur" | "none";
/** Every glass that really shows the desktop. An unknown name (a newer desktop app, an older web bundle) is "none". */
const REAL_GLASSES: readonly string[] = ["liquid", "vibrancy", "mica", "acrylic", "blur"] satisfies NativeGlass[];
export type Scheme = "light" | "dark";
export type Rgb = readonly [number, number, number];

export const BACKGROUND_MODES: readonly BackgroundMode[] = ["see-through", "picture", "colours"];
export const GLASS_STRENGTHS: readonly GlassStrength[] = ["clear", "frosted"];
export const DEFAULT_MODE: BackgroundMode = "see-through";
export const DEFAULT_STRENGTH: GlassStrength = "clear";
export const MAX_COLOURS = 3;

/**
 * Kid-friendly swatches, in the order they are shown. The first three are the Clip Factory colours; Sage and Cream
 * follow so a colour picked before the bottle-green look still shows its name.
 */
export const SWATCHES: readonly { hex: string; name: string }[] = [
  { hex: "#0f372b", name: "Bottle green" },
  { hex: "#efe7da", name: "Bone" },
  { hex: "#e8392b", name: "Vermilion" },
  { hex: "#9caf88", name: "Sage" },
  { hex: "#f7f5ef", name: "Cream" },
  { hex: "#f6c945", name: "Sunny" },
  { hex: "#7fd8be", name: "Mint" },
  { hex: "#7cc4f2", name: "Sky" },
  { hex: "#2b6cb0", name: "Ocean" },
  { hex: "#8e6cc9", name: "Grape" },
  { hex: "#f49ac1", name: "Bubblegum" },
  { hex: "#1f2937", name: "Night" },
];
export const DEFAULT_COLOURS: readonly string[] = ["#0f372b", "#efe7da", "#e8392b"];

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
  return typeof g === "string" && REAL_GLASSES.includes(g) ? (g as NativeGlass) : "none";
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

/**
 * The text colour tokens (`:root` in styles/tokens.css): every colour that words are written in on glass. All are
 * light (bone or lighter): the glass is bottle green. test/background.test.ts reads tokens.css and every
 * stylesheet, so this list, the tokens and the `color:` declarations stay in step.
 */
export const TEXT_TOKENS = {
  "--ink": "#efe7da",
  "--ink-2": "#e9e0d0",
  "--ink-3": "#e4dac9",
  "--vermilion-ink": "#ffd2ca",
  "--green-ink": "#d2e8c4",
  "--green-text": "#d6ebc8",
} as const;
export type TextToken = keyof typeof TEXT_TOKENS;
/**
 * The window look (`html.see-through` in tokens.css): the softer ones go to bone or lighter there, so the panels need
 * the least green over the lightest the window can be and more of the desktop shows through them (§22.3). Each has a
 * relative luminance of 0.806 or more.
 */
export const WINDOW_TEXT_TOKENS: Record<TextToken, string> = {
  ...TEXT_TOKENS,
  "--ink-2": "#efe7da",
  "--ink-3": "#efe7da",
  "--vermilion-ink": "#ffe2dc",
  "--green-ink": "#e4f2da",
  "--green-text": "#e4f2da",
};

/** Every text colour that can sit on the glass outside the window look. */
export const TEXT_COLOURS: readonly Rgb[] = Object.values(TEXT_TOKENS).map(hexToRgb);
/** Every text colour of the window look. All see-through maths uses this set. */
export const TEXT_COLOURS_WINDOW: readonly Rgb[] = Object.values(WINDOW_TEXT_TOKENS).map(hexToRgb);
/** The veil and the glass are Clip Factory bottle green. */
export const VEIL: Rgb = hexToRgb("#0f372b");
/** Bone: the selected pill, rings and hairlines. */
export const BONE: Rgb = hexToRgb("#efe7da");
/** Words on a bone fill (`--on-bone`). */
export const ON_BONE: Rgb = hexToRgb("#0f372b");
/** How solid the selected pill's bone is (`--selected` in tokens.css). */
export const SELECTED_ALPHA = 0.92;

/**
 * The bottle-green tint the desktop app lays into its window glass, as alpha 0..1: `GLASS_TINT` in
 * desktop/src-tauri/src/main.rs is `Color(15, 55, 43, 140)`, the same green as `VEIL`. Keep the two in step.
 */
export const GLASS_TINT_ALPHA = 140 / 255;
/** What that tint gives over a black wallpaper. Worked out, never rounded by hand. */
export const TINTED_FLOOR: Rgb = mix(VEIL, [0, 0, 0], GLASS_TINT_ALPHA);
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/**
 * macOS Liquid Glass as it really draws, measured on 2026-11-16 on macOS 27.2 (system in dark mode, the window
 * forced to the light theme, Tauri 2.12.5 / window-vibrancy 0.8.1, `LiquidGlassRegular` with the light tint the
 * app used then, page transparent): a helper window put pure black, then pure white, straight behind the real window
 * and the screen was captured. These are records. With bone text the lightest the glass can be decides, and that is
 * planned as white (`glassCeiling`), which no tint can make lighter, so the records stay valid bounds.
 */
export const LIQUID_MEASURED = {
  /** The window is in use. */
  active: { overBlack: [180, 171, 148], overWhite: [249, 248, 245] },
  /** The window shows, but another app is in use: the darkest Liquid Glass gets. */
  inactive: { overBlack: [118, 118, 118], overWhite: [225, 225, 225] },
} as const satisfies Record<string, { overBlack: Rgb; overWhite: Rgb }>;
/** How much darker than measured the page assumes Liquid Glass can get (another Mac, another macOS update). */
export const LIQUID_SAFETY = 0.1;
/** The darkest Liquid Glass the page plans for: the inactive glass over black, a tenth darker, rgb(106.2, 106.2, 106.2). */
export const LIQUID_FLOOR: Rgb = mix(BLACK, LIQUID_MEASURED.inactive.overBlack, LIQUID_SAFETY);
/** The darkest Liquid Glass while the window is in use, exactly as measured. */
export const LIQUID_ACTIVE_FLOOR: Rgb = LIQUID_MEASURED.active.overBlack;

/**
 * The darkest the native window glass can be behind the page (docs/CONTRACTS.md §22.3). With bone text a dark glass
 * only helps; the floor is still checked so words on bone fills are covered at both ends.
 */
export function glassFloor(glass: NativeGlass, scheme: Scheme): Rgb {
  if (scheme === "dark") return BLACK;
  if (glass === "liquid") return LIQUID_FLOOR;
  if (glass === "blur") return TINTED_FLOOR;
  return BLACK;
}

/**
 * The lightest the native window glass can be behind the page: this is what decides the panel tint for bone text.
 * White for every glass and setting (the lightest Liquid Glass was measured at rgb(249, 248, 245), effectively
 * white), so nothing here depends on a measurement.
 */
export function glassCeiling(_glass: NativeGlass, _scheme: Scheme): Rgb {
  return WHITE;
}

/**
 * Everything the page's text is checked against for this glass: the ceiling it plans for (white), the floor, and
 * for Liquid Glass in the light setting every measured point as well.
 */
export function glassChecks(glass: NativeGlass, scheme: Scheme): { name: string; behind: Rgb }[] {
  const checks: { name: string; behind: Rgb }[] = [
    { name: "ceiling", behind: glassCeiling(glass, scheme) },
    { name: "floor", behind: glassFloor(glass, scheme) },
  ];
  if (glass === "liquid" && scheme === "light")
    checks.push(
      { name: "active floor", behind: LIQUID_ACTIVE_FLOOR },
      { name: "inactive floor as measured", behind: LIQUID_MEASURED.inactive.overBlack },
      { name: "active over white as measured", behind: LIQUID_MEASURED.active.overWhite },
      { name: "inactive over white as measured", behind: LIQUID_MEASURED.inactive.overWhite },
    );
  return checks;
}

/**
 * See-through keeps the wallpaper visible between the panels and puts the readability tint only where there is text
 * (§22.3). Clear: nothing over the window's own glass in the gaps. Frosted: a green frost over the whole window too.
 */
const PAGE_VEIL: Record<GlassStrength, number> = { clear: 0, frosted: 0.3 };
/** A panel never carries less than this: it must still read as a pane. Also the panel tint where the page owns the backdrop. */
export const PANEL_VEIL_FLOOR = 0.45;
/** How much heavier a Frosted panel is than a Clear one. */
export const FROSTED_EXTRA = 0.15;
/** A Frosted panel never goes fully solid. */
export const MAX_FROSTED_PANEL_VEIL = 0.95;
/** The picture look: a green veil over the owner's picture, and the panels on it (together 1 - 0.65 × 0.35 = 0.7725 over a white photo). */
export const PICTURE_PAGE_VEIL = 0.35;
export const PICTURE_PANEL_VEIL = 0.65;

// Three numbers styles/glass.css uses; test/background.test.ts reads them out of the CSS and works out the contrast
// for every glass, so they are not guesses either.
/** Pick-one tracks (`.segmented`, `.tabs`, the Background tiles) lay this lift of bone over their tint. */
export const TRACK_LIFT = 0.08;
/** So a track carries this much more tint than a panel, and the labels on its lift stay at AA. */
export const TRACK_EXTRA_VEIL = 0.1;
/**
 * Tinted chips on a panel (the vermilion pill, the success tint, the sound tags: `--tint-vermilion` and `--tint-leaf`
 * in tokens.css) lay this much deep green (`--green-deep`) under their tint, so a vermilion or leaf chip is never
 * lighter than the panel it sits on and its words keep AA.
 */
export const CHIP_DEEPEN = 0.35;
/** The deep green under a tinted chip. */
export const GREEN_DEEP: Rgb = hexToRgb("#0a2820");

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
  /** Over every panel and every piece of text that sits straight on the window: enough for AA on the lightest glass. */
  panel: number;
}

/**
 * The two tints in see-through for this glass, setting and strength, worked out for the window look's text colours.
 * Clear: nothing between the panels; a panel carries the least green that keeps every text colour at AA on the
 * lightest glass (never less than `PANEL_VEIL_FLOOR`). Frosted: a green frost everywhere and heavier panels, so it
 * always shows less than Clear.
 */
export function seeThroughVeils(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): SeeThroughVeils {
  const clear = Math.max(PANEL_VEIL_FLOOR, minVeil(glassCeiling(glass, scheme), TEXT_COLOURS_WINDOW));
  if (strength === "clear") return { page: PAGE_VEIL.clear, panel: clear };
  return { page: PAGE_VEIL.frosted, panel: Math.max(clear, Math.min(MAX_FROSTED_PANEL_VEIL, round2(clear + FROSTED_EXTRA))) };
}

/**
 * What text on a panel actually sits on in see-through: the page tint, then the panel tint, over `behind` (the
 * lightest the glass can be unless another colour is given).
 */
export function seeThroughWorstBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassCeiling(glass, scheme)): Rgb {
  const v = seeThroughVeils(glass, scheme, strength);
  return mix(VEIL, mix(VEIL, behind, v.page), v.panel);
}

/** What a label on a pick-one track sits on when the track is straight on the window: its tint, then its bone lift. */
export function seeThroughTrackBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassCeiling(glass, scheme)): Rgb {
  const v = seeThroughVeils(glass, scheme, strength);
  const tinted = mix(VEIL, mix(VEIL, behind, v.page), Math.min(1, v.panel + TRACK_EXTRA_VEIL));
  return mix(BONE, tinted, TRACK_LIFT);
}

/** What words on a tinted chip sit on: the panel, the deep green under the tint, then the chip's own tint (`tint` at `alpha`). */
export function seeThroughChipBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, tint: Rgb, alpha: number, behind: Rgb = glassCeiling(glass, scheme)): Rgb {
  return mix(tint, mix(GREEN_DEEP, seeThroughWorstBackground(glass, scheme, strength, behind), CHIP_DEEPEN), alpha);
}

/** What words on the selected (bone) pill sit on, on a panel over `behind`. */
export function seeThroughSelectedBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassCeiling(glass, scheme)): Rgb {
  return mix(BONE, seeThroughWorstBackground(glass, scheme, strength, behind), SELECTED_ALPHA);
}

/**
 * The veil over a colours backdrop. With bone text the lightest colour decides; a half-and-half sRGB blend of two
 * colours is never lighter than both of them, so only the colours themselves are checked.
 */
export function coloursVeil(colours: readonly string[]): number {
  return Math.max(0, ...normaliseColours(colours).map((c) => minVeil(hexToRgb(c))));
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
  | { kind: "picture"; url: string; pageVeil: number; panelVeil: number }
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
      return i.picture ? { kind: "picture", url: i.picture, pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL } : { kind: "brand" };
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

/** Above this veil a colour shows clearly softer (greener) than its swatch, so the Colours card says why. */
export const SOFT_COLOURS_VEIL = 0.5;
export const SOFT_COLOURS_NOTE = "Light colours show soft, so words stay easy to read.";
