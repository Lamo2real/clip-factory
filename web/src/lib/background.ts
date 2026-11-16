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
 * The text colour tokens (`:root` in styles/tokens.css): every colour that words are written in on glass.
 * test/background.test.ts reads tokens.css and every stylesheet, so this list, the tokens and the `color:`
 * declarations stay in step.
 */
export const TEXT_TOKENS = {
  "--ink": "#1e2a1b",
  "--ink-2": "#2f3b2c",
  "--ink-3": "#46523f",
  "--tomato-ink": "#962414",
  "--sage-ink": "#4f6340",
  "--sage-text": "#3d4f31",
} as const;
export type TextToken = keyof typeof TEXT_TOKENS;
/**
 * The window look (`html.see-through` in tokens.css): the lightest four go deeper there, each still clearly its own
 * colour (grey-green, tomato, sage), so the panels need much less tint and more of the desktop shows through them
 * (§22.3). Each has a relative luminance of 0.047 or less; the darker two stay as they are.
 */
export const WINDOW_TEXT_TOKENS: Record<TextToken, string> = {
  ...TEXT_TOKENS,
  "--ink-3": "#344031",
  "--tomato-ink": "#74190e",
  "--sage-ink": "#2c421c",
  "--sage-text": "#2c421c",
};

/** Every text colour that can sit straight on the backdrop outside the window look: ink, ink-2, ink-3, tomato-ink. */
export const TEXT_COLOURS: readonly Rgb[] = (["--ink", "--ink-2", "--ink-3", "--tomato-ink"] as const).map((t) => hexToRgb(TEXT_TOKENS[t]));
/** Every text colour of the window look. All see-through maths uses this set. */
export const TEXT_COLOURS_WINDOW: readonly Rgb[] = Object.values(WINDOW_TEXT_TOKENS).map(hexToRgb);
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
const WHITE: Rgb = [255, 255, 255];

/**
 * macOS Liquid Glass as it really draws, measured on 2026-11-16 on macOS 27.2 (system in dark mode, the window
 * forced to the light theme, Tauri 2.12.5 / window-vibrancy 0.8.1, `LiquidGlassRegular` with the tint above, page
 * transparent): a helper window put pure black, then pure white, straight behind the real window and the screen was
 * captured. While the window is in use the system honours the app's tint (it behaves like the tint at about 62-73%
 * over the blurred desktop); while another app is in use it drops the tint for a neutral light grey at about 58%.
 * A panel then composites as `mix(VEIL, glass, veil)`, within about 3 levels of what was measured.
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
 * The darkest the native window glass can be behind the page (docs/CONTRACTS.md §22.3).
 * - `liquid` (macOS 26+): measured, see `LIQUID_MEASURED`. The floor is the inactive glass over black, a tenth darker.
 * - `blur` (Windows 10 1809 to Windows 11 21H2): the system honours the app's tint, so the glass is never darker than
 *   the tint over black, `TINTED_FLOOR`. Worked out, not measured.
 * - `acrylic` (Windows 11 22H2+), `mica` and `vibrancy` (macOS 15 and older): not measured. The system draws its own
 *   material and drops the app's tint (Windows 11 acrylic ignores it; the macOS vibrancy material takes none), so
 *   nothing is promised: assume black.
 * - A dark setting inside the window (the desktop app forces light, so this should never happen) could give a dark
 *   material on any of them: assume black.
 */
export function glassFloor(glass: NativeGlass, scheme: Scheme): Rgb {
  if (scheme === "dark") return BLACK;
  if (glass === "liquid") return LIQUID_FLOOR;
  if (glass === "blur") return TINTED_FLOOR;
  return BLACK;
}

/**
 * Everything the page's text is checked against for this glass: the floor it plans for, the lightest the glass can
 * be (white) and, for Liquid Glass in the light setting, both measured floors as well (in use it is khaki, not grey).
 */
export function glassChecks(glass: NativeGlass, scheme: Scheme): { name: string; behind: Rgb }[] {
  const checks: { name: string; behind: Rgb }[] = [
    { name: "floor", behind: glassFloor(glass, scheme) },
    { name: "white", behind: WHITE },
  ];
  if (glass === "liquid" && scheme === "light")
    checks.push({ name: "active floor", behind: LIQUID_ACTIVE_FLOOR }, { name: "inactive floor as measured", behind: LIQUID_MEASURED.inactive.overBlack });
  return checks;
}

/**
 * See-through keeps the wallpaper visible between the panels and puts the readability tint only where there is text
 * (§22.3). Clear: nothing over the window's own glass in the gaps. Frosted: a light frost over the whole window too.
 */
const PAGE_VEIL: Record<GlassStrength, number> = { clear: 0, frosted: 0.3 };
/** A panel never carries less than this, however light the glass behind it: it must still read as a pane. */
export const MIN_PANEL_VEIL = 0.35;
/** How much heavier a Frosted panel is than a Clear one. */
export const FROSTED_EXTRA = 0.15;
/** A Frosted panel never goes fully solid. */
export const MAX_FROSTED_PANEL_VEIL = 0.95;

// Three numbers styles/glass.css uses in the window look; test/background.test.ts reads them out of the CSS and
// works out the contrast for every glass, so they are not guesses either.
/** Pick-one tracks (`.segmented`, `.tabs`, the Background tiles) lay this shade of ink over their tint. */
export const TRACK_SHADE = 0.08;
/** So a track carries this much more tint than a panel, and the labels on its shade stay at AA. */
export const TRACK_EXTRA_VEIL = 0.1;
/**
 * Tinted chips on a panel (the tomato pill, the sound tags, "If you need it") get this much white over their
 * tint, so over the darkest glass an ink or tomato chip is never darker than the panel it sits on and its words
 * keep AA. (Over a lighter glass a chip can be darker than its panel; the words then have contrast to spare.)
 */
export const CHIP_LIFT = 0.2;

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

/**
 * The two tints in see-through for this glass, setting and strength, worked out for the window look's text colours.
 * Clear: nothing between the panels; a panel carries the least that keeps every text colour at AA on the darkest
 * glass (never less than `MIN_PANEL_VEIL`). Frosted: a light frost everywhere and heavier panels, so it always shows
 * less than Clear.
 */
export function seeThroughVeils(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): SeeThroughVeils {
  const clear = Math.max(MIN_PANEL_VEIL, minVeil(glassFloor(glass, scheme), TEXT_COLOURS_WINDOW));
  if (strength === "clear") return { page: PAGE_VEIL.clear, panel: clear };
  return { page: PAGE_VEIL.frosted, panel: Math.max(clear, Math.min(MAX_FROSTED_PANEL_VEIL, round2(clear + FROSTED_EXTRA))) };
}

/**
 * What text on a panel actually sits on in see-through: the page tint, then the panel tint, over `behind` (the
 * darkest the glass can be unless another colour is given).
 */
export function seeThroughWorstBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassFloor(glass, scheme)): Rgb {
  const v = seeThroughVeils(glass, scheme, strength);
  return mix(VEIL, mix(VEIL, behind, v.page), v.panel);
}

/** What a label on a pick-one track sits on when the track is straight on the window: its tint, then its shade. */
export function seeThroughTrackBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassFloor(glass, scheme)): Rgb {
  const v = seeThroughVeils(glass, scheme, strength);
  const tinted = mix(VEIL, mix(VEIL, behind, v.page), Math.min(1, v.panel + TRACK_EXTRA_VEIL));
  return mix(hexToRgb(TEXT_TOKENS["--ink"]), tinted, TRACK_SHADE);
}

/** What words on a tinted chip sit on: the panel, the chip's own tint (`tint` at `alpha`), then the white wash. */
export function seeThroughChipBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, tint: Rgb, alpha: number, behind: Rgb = glassFloor(glass, scheme)): Rgb {
  return mix(WHITE, mix(tint, seeThroughWorstBackground(glass, scheme, strength, behind), alpha), CHIP_LIFT);
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
