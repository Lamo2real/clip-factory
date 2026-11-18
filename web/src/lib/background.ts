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
/**
 * The Clip Factory colours before the bottle-green look (ADR-43). Exactly this trio reads back as today's default,
 * as the API does (settings.py OLD_DEFAULT_COLOURS), so a device that cached it does not show the old palette until
 * /me loads. Any other choice, a reordering or a subset included, is kept as it is.
 */
export const OLD_DEFAULT_COLOURS: readonly string[] = ["#9caf88", "#f7f5ef", "#e8412c"];

/** The stored colours, with the old default trio read as the new one. */
export function currentColours(v: unknown): string[] {
  const colours = normaliseColours(v);
  return colours.length === OLD_DEFAULT_COLOURS.length && colours.every((c, i) => c === OLD_DEFAULT_COLOURS[i]) ? [...DEFAULT_COLOURS] : colours;
}

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
 * The text colour tokens (`:root` in styles/tokens.css): every colour that words are written in on glass. One set
 * everywhere (ADR-45), all bone or lighter (relative luminance 0.806 or more): the glass is bottle green and the
 * hierarchy comes from size, weight and spacing. test/background.test.ts reads tokens.css and every stylesheet, so
 * this list, the tokens and the `color:` declarations stay in step.
 */
export const TEXT_TOKENS = {
  "--ink": "#efe7da",
  "--ink-2": "#efe7da",
  "--ink-3": "#efe7da",
  "--vermilion-ink": "#ffe2dc",
  "--green-ink": "#e4f2da",
  "--green-text": "#e4f2da",
} as const;
export type TextToken = keyof typeof TEXT_TOKENS;
/** The window look's text colours: the same set since ADR-45 (kept as its own name for the window maths). */
export const WINDOW_TEXT_TOKENS: Record<TextToken, string> = { ...TEXT_TOKENS };

/** Every text colour that can sit on the glass. */
export const TEXT_COLOURS: readonly Rgb[] = Object.values(TEXT_TOKENS).map(hexToRgb);
/** Every text colour of the window look (the same set). */
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

// ---------- What backdrop-filter does to the backdrop ----------

/** `saturate()` in every glass's backdrop-filter (`--glass-saturate` in tokens.css). */
export const GLASS_SATURATE = 1.6;
/** The largest `saturate()` anywhere in the CSS (the refracting panels, `.refract .glass--refract`). */
export const GLASS_SATURATE_MAX = 1.75;
/**
 * Every way the backdrop can be seen under words: as it is (the scrims under loose words have no filter), and through
 * each `saturate()` the CSS uses (1.4 under the glass buttons). Saturating can lighten one colour and darken another
 * (a channel clips), so every worst case is the lightest over all of them.
 */
export const SATURATIONS: readonly number[] = [1, 1.4, GLASS_SATURATE, GLASS_SATURATE_MAX];
/** `spot` as seen through each of `SATURATIONS` (or only `s`). */
function seenAs(spot: Rgb, s?: number): Rgb[] {
  return (s === undefined ? SATURATIONS : [s]).map((sat) => saturateRgb(spot, sat));
}
/** The lightest of some spots. */
function lightest(spots: readonly Rgb[]): Rgb {
  return spots.reduce<Rgb>((a, b) => (luminance(b) > luminance(a) ? b : a), [0, 0, 0]);
}
/**
 * The least green veil that keeps AA over every one of these spots. Not simply the lightest spot's: the veil is mixed
 * in sRGB, so a slightly darker spot of another hue can need a little more.
 */
export function minVeilOver(spots: readonly Rgb[]): number {
  return Math.max(0, ...spots.map((spot) => minVeil(spot)));
}

function linearChannel(c: number): number {
  return channel(c);
}
function srgbChannel(l: number): number {
  return 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
}
/**
 * CSS `saturate(s)`: the feColorMatrix saturate matrix. Chromium and WebKit apply the filter shorthands in sRGB, the
 * spec's default for SVG filters is linearRGB; both are worked out and the lighter result is kept, clipped to 0..255.
 * It can lighten a colour (a green-only spot most), so every worst case is taken after it.
 */
export function saturateRgb(c: Rgb, s: number): Rgb {
  const m = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ] as const;
  const clip = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const srgb = m.map((r) => clip(r[0] * c[0] + r[1] * c[1] + r[2] * c[2], 255)) as unknown as Rgb;
  const lin = c.map(linearChannel);
  const linear = m.map((r) => srgbChannel(clip(r[0] * lin[0]! + r[1] * lin[1]! + r[2] * lin[2]!, 1))) as unknown as Rgb;
  return luminance(srgb) >= luminance(linear) ? srgb : linear;
}

/** W3C soft-light of `top` over `bottom`, one channel 0..255. */
function softLight(bottom: number, top: number): number {
  const cb = bottom / 255;
  const cs = top / 255;
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return 255 * (cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb));
}
/** `top` in soft-light at `alpha` over `under`. */
export function softLightOver(under: Rgb, top: Rgb, alpha: number): Rgb {
  return under.map((u, i) => (1 - alpha) * u + alpha * softLight(u, top[i]!)) as unknown as Rgb;
}
/** W3C overlay of `top` over `bottom`, one channel 0..255 (hard-light with the layers swapped). */
function overlay(bottom: number, top: number): number {
  const cb = bottom / 255;
  const cs = top / 255;
  return 255 * (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs));
}
/** `top` in overlay at `alpha` over `under`. */
export function overlayOver(under: Rgb, top: Rgb, alpha: number): Rgb {
  return under.map((u, i) => (1 - alpha) * u + alpha * overlay(u, top[i]!)) as unknown as Rgb;
}

// ---------- The app's own living backdrop (glass.css .backdrop, Backdrop.tsx) ----------

/**
 * Every number of the backdrop the page draws when it owns the backdrop (see-through in a browser or on a phone, and
 * Picture before a picture is chosen). test/background.test.ts reads each one out of glass.css.
 */
export const BRAND_MESH = {
  /** The two ends of the field's gradient (the radial highlight is the lighter one). */
  field: [hexToRgb("#0f3d31"), hexToRgb("#08221b")] as readonly Rgb[],
  /** Each blob's colour and peak alpha, at opacity 1: a deep teal, vermilion, leaf, a breath of bone, deep vermilion. */
  blobs: [
    { name: "a", colour: [22, 89, 77] as Rgb, alpha: 0.9 },
    { name: "b", colour: hexToRgb("#e8392b"), alpha: 0.62 },
    { name: "c", colour: hexToRgb("#5fa585"), alpha: 0.3 },
    { name: "d", colour: hexToRgb("#efe7da"), alpha: 0.06 },
    { name: "e", colour: [196, 42, 30] as Rgb, alpha: 0.55 },
  ],
  /** The two soft lenses' bone glow at its brightest. */
  ring: 0.08,
  /** The Frosted strength's two soft-light bone caustics at their peak. */
  caustic: 0.06,
  /**
   * The grain drawn over everything (`.backdrop__grain`): a fractal noise in this colour (its feColorMatrix), at most
   * `alpha` solid, laid in overlay at `opacity`. Its peak, `opacity * alpha`, is what the maths takes.
   */
  grain: { colour: [0.94 * 255, 0.91 * 255, 0.85 * 255] as Rgb, opacity: 0.1, alpha: 0.55 },
} as const;

/** One spot of the mesh: the field, then these blobs, a lens glow, both caustics and the grain at its peak on top. */
function brandSpot(field: Rgb, blobs: readonly { colour: Rgb; alpha: number }[]): Rgb {
  let spot = field;
  for (const b of blobs) spot = mix(b.colour, spot, b.alpha);
  spot = mix(BONE, spot, BRAND_MESH.ring);
  spot = softLightOver(softLightOver(spot, BONE, BRAND_MESH.caustic), BONE, BRAND_MESH.caustic);
  const { grain } = BRAND_MESH;
  return overlayOver(spot, grain.colour, grain.opacity * grain.alpha);
}

/**
 * The lightest spot of the living backdrop, as the glass sees it: every subset of the blobs (not only all of them
 * stacked: `saturate()` lifts a green-only subset more than a stack with vermilion in it) over both field ends, after
 * `saturate(s)`, or after whichever of `SATURATIONS` makes it lightest.
 */
export function brandMeshWorst(s?: number): Rgb {
  return lightest(brandMeshSpots(s));
}
/**
 * Every corner of the living backdrop as the glass can see it: each subset of the blobs at their peaks over each field
 * end, through each saturation. Luminance is convex in every blob's alpha, so the lightest spot of the whole drifting
 * mesh is one of these corners.
 */
export function brandMeshSpots(s?: number): Rgb[] {
  const out: Rgb[] = [];
  const n = BRAND_MESH.blobs.length;
  for (const field of BRAND_MESH.field)
    for (let m = 0; m < 1 << n; m++)
      out.push(
        ...seenAs(
          brandSpot(
            field,
            BRAND_MESH.blobs.filter((_, i) => m & (1 << i)),
          ),
          s,
        ),
      );
  return out;
}

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
/**
 * A panel never carries less than this. A pane reads as glass by its blur, saturation and shadow, not by its tint
 * (ADR-45; it has no drawn edge either), so the floor only keeps a little green under the words.
 */
export const PANEL_VEIL_FLOOR = 0.3;
/** How much heavier a Frosted panel is than a Clear one. */
export const FROSTED_EXTRA = 0.15;
/** A Frosted panel never goes fully solid. */
export const MAX_FROSTED_PANEL_VEIL = 0.95;
/**
 * The picture look: no veil over the owner's picture, so it shows at full strength between the panels; the panels
 * (and the scrims under loose words) carry what a white photo needs.
 */
export const PICTURE_PAGE_VEIL = 0;
export const PICTURE_PANEL_VEIL = minVeil(WHITE);

// Three numbers styles/glass.css uses; test/background.test.ts reads them out of the CSS and works out the contrast
// for every glass, so they are not guesses either.
/** Pick-one tracks (`.segmented`, `.tabs`, the Background tiles) lay this lift of bone over their tint. */
export const TRACK_LIFT = 0.08;
/**
 * So a track carries this much more tint than a panel, and the labels on its lift stay at AA over every spot of every
 * look (the colours grid included). Not the lightest spot's need alone: mixed in sRGB, a darker spot of another hue
 * (a brown in the living backdrop) can need more.
 */
export const TRACK_EXTRA_VEIL = 0.15;
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

/** A picked swatch's tick: bottle green when it reads better than white on that colour, so it is never under 3:1. */
export function swatchTickIsDark(hex: string): boolean {
  const rgb = hexToRgb(hex);
  return contrast(rgb, ON_BONE) > contrast(rgb, WHITE);
}

/** What words on the selected (bone) pill sit on, on a panel over `behind`. */
export function seeThroughSelectedBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, behind: Rgb = glassCeiling(glass, scheme)): Rgb {
  return mix(BONE, seeThroughWorstBackground(glass, scheme, strength, behind), SELECTED_ALPHA);
}

/**
 * @deprecated Use `coloursVeils`. The combined green over the colours behind a panel, `1 - (1 - page)(1 - panel)`.
 */
export function coloursVeil(colours: readonly string[]): number {
  const v = coloursVeils(colours);
  return round2(1 - (1 - v.pageVeil) * (1 - v.panelVeil));
}

/** The panel tint over the app's own living backdrop: the least that keeps AA over its lightest spot, never under the floor. */
export const BRAND_PANEL_VEIL = Math.max(PANEL_VEIL_FLOOR, minVeilOver(brandMeshSpots()));
/**
 * Layers that page content scrolls under (toasts, the update bar, the setup list and pill, the Ask panel and sheet):
 * a thumbnail can be right under them, so they plan for white.
 */
export const FLOAT_VEIL = minVeil(WHITE);
/** The tab bar holds icons only (WCAG 1.4.11, 3:1), and content scrolls under it too. */
export const TABBAR_VEIL = minVeil(WHITE, TEXT_COLOURS, VEIL, 3);
/** The question sheet's tint (`.sheet.glass` in settings.css), over its own scrim. */
export const SHEET_VEIL = 0.86;

/** The most a colours panel carries; past it the rest goes on the page. */
export const MAX_COLOURS_PANEL_VEIL = 0.6;
/** How the colours look draws its blobs (glass.css): the second colour at 30 %, the third at 45 %, opacity 1. */
export const COLOURS_BLOB_ALPHA = { second: 0.3, third: 0.45 } as const;
/** The field's gradient end: 78 % of the first colour, 22 % of the third. */
export const COLOURS_FIELD_END = 0.22;

/** The lightest spot of the colours mesh as drawn (`coloursMeshSpots`), after `saturate(s)` or any of `SATURATIONS`. */
export function coloursMeshWorst(colours: readonly string[], s?: number): Rgb {
  return lightest(coloursMeshSpots(colours, s));
}
/** Every corner of the colours mesh as drawn (each field end, with and without the blobs), through each saturation. */
export function coloursMeshSpots(colours: readonly string[], s?: number): Rgb[] {
  const [c1, c2 = c1, c3 = c2] = normaliseColours(colours).map(hexToRgb) as [Rgb, Rgb?, Rgb?];
  const out: Rgb[] = [];
  for (const field of [c1, mix(c3!, c1, COLOURS_FIELD_END)])
    for (const second of [0, COLOURS_BLOB_ALPHA.second])
      for (const third of [0, COLOURS_BLOB_ALPHA.third]) out.push(...seenAs(mix(c3!, mix(c2!, field, second), third), s));
  return out;
}

/**
 * The colours look's two tints: the panels carry what the lightest spot needs (never under the floor) and the page
 * nothing, up to `MAX_COLOURS_PANEL_VEIL`; past that the panels stay there and the page takes the rest, so that
 * `1 - (1 - page)(1 - panel)` still covers it.
 */
export function coloursVeils(colours: readonly string[]): { pageVeil: number; panelVeil: number } {
  const need = Math.max(PANEL_VEIL_FLOOR, minVeilOver(coloursMeshSpots(colours)));
  if (need <= MAX_COLOURS_PANEL_VEIL) return { pageVeil: 0, panelVeil: need };
  return { pageVeil: Math.ceil((1 - (1 - need) / (1 - MAX_COLOURS_PANEL_VEIL)) * 100 - 1e-9) / 100, panelVeil: MAX_COLOURS_PANEL_VEIL };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- What to draw ----------

export type Look =
  /** Desktop app with real window glass: the page is transparent; the panels carry the tint that keeps text readable. */
  | { kind: "window"; glass: NativeGlass; strength: GlassStrength; pageVeil: number; panelVeil: number }
  /** See-through where the page cannot see behind itself: the living Clip Factory backdrop, frosted or clear. */
  | { kind: "frosted"; strength: GlassStrength; panelVeil: number }
  | { kind: "picture"; url: string; pageVeil: number; panelVeil: number }
  /** Picture chosen but none on this device yet: the Clip Factory colours. */
  | { kind: "brand"; panelVeil: number }
  | { kind: "colours"; colours: string[]; pageVeil: number; panelVeil: number };

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
      if (i.glass === "none") return { kind: "frosted", strength: i.strength, panelVeil: BRAND_PANEL_VEIL };
      {
        const v = seeThroughVeils(i.glass, i.scheme, i.strength);
        return { kind: "window", glass: i.glass, strength: i.strength, pageVeil: v.page, panelVeil: v.panel };
      }
    case "picture":
      return i.picture ? { kind: "picture", url: i.picture, pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL } : { kind: "brand", panelVeil: BRAND_PANEL_VEIL };
    case "colours": {
      const colours = normaliseColours(i.colours);
      return { kind: "colours", colours, ...coloursVeils(colours) };
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

/** A colour shows softer (greener) than its swatch once the page itself needs a veil, so the Colours card says why. */
export const SOFT_COLOURS_VEIL = 0;
export const SOFT_COLOURS_NOTE = "Light colours show soft, so words stay easy to read.";
