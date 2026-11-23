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

/**
 * A desktop app from before the see-through window (built before 2026-11-16 16:54): it sets `__CF_DESKTOP__` but never
 * `__CF_GLASS__`. Every newer copy sets `__CF_GLASS__` (to "none" at the least), so an unset one means "update the
 * app", not "this computer can't" (docs/CONTRACTS.md §12.6).
 */
export function isOldDesktopApp(w: { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown } | undefined): boolean {
  return !!w && w.__CF_DESKTOP__ === true && w.__CF_GLASS__ === undefined;
}

const DESKTOP_VERSION = /^\d+\.\d+\.\d+([-+][\w.+-]*)?$/;

/** The version a desktop app names (`1.<n>.0`), only from apps that update themselves; null otherwise. */
export function readDesktopVersion(w: { __CF_DESKTOP__?: unknown; __CF_DESKTOP_VERSION__?: unknown } | undefined): string | null {
  if (!w || w.__CF_DESKTOP__ !== true) return null;
  const v = w.__CF_DESKTOP_VERSION__;
  return typeof v === "string" && DESKTOP_VERSION.test(v) ? v : null;
}

/**
 * A desktop app that cannot update itself: every copy that has the updater names its version
 * (`__CF_DESKTOP_VERSION__`), so one without it, see-through or not, needs the new installer (docs/CONTRACTS.md §12.6).
 * Wider than `isOldDesktopApp`, which only picks the see-through note.
 */
export function cantSelfUpdate(w: { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown; __CF_DESKTOP_VERSION__?: unknown } | undefined): boolean {
  return !!w && w.__CF_DESKTOP__ === true && readDesktopVersion(w) === null;
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
  let need = 0;
  // A spot that already holds at the veil found so far needs no more (the steps that hold run unbroken up to 1).
  for (const spot of spots) if (!veilHolds(spot, need)) need = minVeil(spot);
  return need;
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

/**
 * CSS `brightness(b)`, the last function of every glass surface's backdrop-filter (`--glass-brightness`, set on <html>
 * by lib/look.ts for each look): it dims what the glass sees before the glass lays its tint over it, so a pane holds
 * bone words with far less green and shows far more of the backdrop (owner, 2026-11-23: "make sure everything is more
 * see through in a liquid glassy style"). Chromium and WebKit apply the filter shorthands in sRGB (each channel × b);
 * the spec's default for SVG filters is linearRGB (luminance × b), the lighter of the two for b < 1. Both are worked
 * out and the lighter kept, as for `saturate()`, so the maths never counts on more dimming than a browser draws.
 */
export function dimRgb(c: Rgb, b: number): Rgb {
  if (b >= 1) return c;
  const srgb = c.map((v) => v * b) as unknown as Rgb;
  const linear = c.map((v) => srgbChannel(linearChannel(v) * b)) as unknown as Rgb;
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
 * A panel never carries less than this: at most 80 % of the backdrop shows through a pane (it was 0.30). A pane reads
 * as glass by its blur, saturation, dimming and shadow, not by its tint (ADR-45; it has no drawn edge either), so the
 * floor only keeps a little green under the words; where the backdrop is light the glass's own `brightness()` does
 * the rest (`glassBrightness`).
 */
export const PANEL_VEIL_FLOOR = 0.2;
/**
 * The most a look's glass may dim what it sees (`brightness()`): a white photo seen through a pane at half its light.
 * Less would read as smoked glass rather than clear.
 */
export const MIN_GLASS_BRIGHTNESS = 0.5;
/** The window look: the native glass is behind the page, where a web backdrop-filter cannot dim it. */
export const WINDOW_BRIGHTNESS = 1;

/**
 * How much a look's glass dims what it sees: the least dimming (the largest `brightness()`, in 0.01 steps) at which a
 * pane of `PANEL_VEIL_FLOOR` green alone, with no pay, keeps every text colour at AA over every one of `spots` (the
 * backdrop as drawn, through each saturate()) and leaves the ladder of light its first rung there (`rowRoom`: over a
 * vivid vermilion corner a thin veil leaves a red pane at the AA cap, and a row on it would read more than
 * `LADDER_SLACK` darker), and never under `MIN_GLASS_BRIGHTNESS`. A dark backdrop is dimmed a little, a light one
 * more; whatever the dimming leaves, the pane's veil covers.
 */
export function glassBrightness(spots: readonly Rgb[]): number {
  const holds = (step: number) => {
    const seen = spots.map((spot) => dimRgb(spot, step / 100));
    return seen.every((p) => worstText(mix(VEIL, p, PANEL_VEIL_FLOOR)) >= AA) && seen.every((p) => rowRoom(lit(p, PANEL_VEIL_FLOOR, 0)));
  };
  const least = Math.round(MIN_GLASS_BRIGHTNESS * 100);
  if (holds(100)) return 1;
  if (!holds(least)) return MIN_GLASS_BRIGHTNESS;
  // Dimming more only darkens, so `holds` is monotone: halve between a step that holds and one that does not.
  let [lo, hi] = [least, 100];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (holds(mid)) lo = mid;
    else hi = mid;
  }
  return lo / 100;
}

/**
 * The picture look: no veil over the owner's picture, so it shows at full strength between the panels. A pane plans
 * for a white photo under it, dimmed by its own `brightness()` (`PICTURE_BRIGHTNESS`, 0.5: a white photo reads as
 * mid grey through it), so it carries 0.59 green where it carried 0.73; the title and line plates, with no filter,
 * carry what a white photo needs as it is (`PICTURE_PLATE_VEIL`).
 */
export const PICTURE_PAGE_VEIL = 0;
/** Every spot a pane over a photo is held to: a white one, as it is and through the strongest saturate(). */
const PICTURE_WORST: readonly Rgb[] = [WHITE, saturateRgb(WHITE, GLASS_SATURATE_MAX)];
// PICTURE_BRIGHTNESS, PICTURE_PANEL_VEIL and PICTURE_PLATE_VEIL are worked out at the end of this file (the ladder
// of light takes part in the brightness).

// Three numbers styles/glass.css uses; test/background.test.ts reads them out of the CSS and works out the contrast
// for every glass, so they are not guesses either.
/** Pick-one tracks (`.segmented`, `.tabs`, the Background tiles) lay this lift of bone over their tint. */
export const TRACK_LIFT = 0.08;
/**
 * So a track carries this much more tint than a panel, and the labels on its lift stay at AA over every spot of every
 * look (the colours grid included). Not the lightest spot's need alone: mixed in sRGB, a darker spot of another hue
 * (a brown in the living backdrop) can need more. 0.22 since the ladder (ADR-87): with 0.15 a track over a bright
 * chromatic spot of the Colours mesh (Grape, bottle green, vermilion) read brighter than an option's hover laid on it,
 * so hovering an option went darker there; 0.22 keeps every option's hover a step of light above its own track.
 */
export const TRACK_EXTRA_VEIL = 0.22;
/**
 * Tinted chips (the vermilion pill, the success tint, the sound tags: `--tint-vermilion`, `--tint-leaf` and
 * `--tint-amber` in tokens.css) lay this much green (`CHIP_UNDER`) under their tint, so the colour stays readable and
 * its words keep AA wherever the chip sits.
 */
export const CHIP_DEEPEN = 0.35;
/** Deep green (`--green-deep`): wells under words (fields, `--fill-sunk`) and sheet scrims. */
export const GREEN_DEEP: Rgb = hexToRgb("#0a2820");
/**
 * The green under a tinted chip: bottle green since ADR-87 (it was `GREEN_DEEP`), so a chip on a row is brighter than
 * the row, like every other raised thing, and its colour still reads (leaf 4.95, vermilion 6.00, amber 4.69 at worst).
 */
export const CHIP_UNDER: Rgb = VEIL;

// ---------- The logic of light (ADR-87, docs/CONTRACTS.md §22.7) ----------
//
// One key light above. Every level is brighter than the level under it, and inside every surface the top is brighter
// than the bottom. Brightness is bone laid over green, and every bone lift is paid for with a step more green under
// it, so the words keep AA: bone words cap whatever they sit on at luminance 0.140. The see-through veils above are
// unchanged; the pay goes on top of them. tokens.css and glass.css carry each number (`--light-*`), and
// test/background.test.ts reads every one back and works the contrast and the brightness steps out for every look.

/**
 * The ladder (owner, 2026-11-23: "the top layer is always brighter than the bottom, and it grows gradually in
 * between"). From a pane up, every nested level reads at least this much brighter (OKLab L) than the level it sits
 * on, in every look, and no level or hover ever reads darker. Page to pane is the one exception: over a light
 * backdrop (a white desktop or photo, a bright spot of the mesh, a light colour) a pane holding bone words has to be
 * darker than what is behind it.
 */
export const LADDER_STEP = 0.015;
/**
 * The share of a pane's top light still there at the height of its words: the light lies in the pane's top padding
 * only (full at the top edge, half at 6 px, gone by 14 px: `--glass-light-panel`), so every word of a pane, its
 * heading included, sits on its plain glass at its look's veil and keeps AA there. The ladder is worked out there.
 */
export const WORDS_LIGHT = 0;
/**
 * How much room a level needs under the AA ceiling for a whole step: when even this much bone over its parent would
 * take a text colour under AA, the cap leaves no room there (the very brightest spots of a look), and the level above
 * keeps AA and may not step back by more than `LADDER_SLACK` instead of climbing a step.
 */
export const LADDER_ROOM = 0.12;
/**
 * ... or when its parent already reads this bright (OKLab L): a level that keeps AA at every depth has its fixed
 * point at the AA cap (about L 0.515 over bottle green), and it climbs a whole step only over a parent at least 0.05
 * under it. A bright, saturated spot (a vermilion blob under a thin veil) reads high in L while its luminance still
 * leaves bone room, so the cap is read in both.
 */
export const LADDER_ROOM_L = 0.44;
/** ... the most a level may read darker than its parent where the AA cap leaves no room (`LADDER_ROOM`). */
export const LADDER_SLACK = 0.03;
/**
 * The extra green (`--light-pay`) a pane carries over the app's own living backdrop: 0 since the see-through came
 * first again (coordinator, 2026-11-23: "see-through first"), so a pane shows 80 % of the (dimmed) backdrop. The
 * ladder above it is earned with light (each level's own bone lift), not with a darker pane.
 */
export const LIGHT_PAY_OWN = 0;
/**
 * The window look (Clear and Frosted, every glass): 0, so a pane sits at the AA floor over a white desktop (0.73
 * Clear, 0.62 Frosted). Over white there the AA cap leaves the ladder no room at any pay a see-through pane can carry
 * (a whole step would need 0.27 more), so the levels above it hold their AA and never read darker (`noRoom`), and
 * the see-through comes first (owner, 2026-11-23: "everything more see through").
 */
export const LIGHT_PAY_WINDOW = 0;
/**
 * Picture, where a white photo can be behind: the most a light look may add over its veil (`MAX_LIGHT_PAY`), and
 * never 0.82 or more in all.
 */
export const LIGHT_PAY_WHITE = 0.05;
/** The most green a light look (Picture over white, the light colours) adds over its veil. */
export const MAX_LIGHT_PAY = 0.05;
/** A pane is never this much green or more ("did not feel see-through" at 0.86; spec.md rejects 0.82 or more). */
export const SEE_THROUGH_LIMIT = 0.82;
/** Reduced transparency: the veils are 0.92 there, so a small step pays for the light (glass.css sets it, !important). */
export const LIGHT_PAY_REDUCED = 0.04;
/** A panel's bone light at its very top (E1), inside its top padding: gone 14 px down (`--glass-light-panel`). */
export const PANEL_LIGHT = 0.04;
/**
 * The catch light at the top centre of a pane (`--glass-spec`): 8 px deep, inside the smallest top padding above words
 * (the line plates and compact rows start their words 8 to 12 px down). A display face's tall glyph box or a small
 * chip can start its words about 6 px down, a little inside it: the window look's plates pay for that
 * (`PLATE_WORDS_LIGHT`).
 */
export const SPECULAR = 0.06;
/**
 * The lead panel (the hero, the sign-in card, Library's learnings, the week's quote): the same green as a panel since
 * the ladder (it was 0.03 more), so its stronger light makes it a whole step brighter than a plain panel ...
 */
export const LEAD_EXTRA_VEIL = 0;
/** ... its light at the top. */
export const LEAD_LIGHT = 0.075;
/**
 * A raised thing inside a lit surface (a row, a card, a control, a track, nested glass): this much green over its
 * parent ... (0.22 since the ladder, from 0.14: a stronger step climbs a whole `LADDER_STEP` per level with less room.)
 */
export const RAISE_VEIL = 0.34;
/**
 * ... then this much bone. Its fixed point (31 % bone over bottle green) stays under the AA ceiling, so a resting
 * stack keeps AA at any depth.
 */
export const RAISE_LIFT = 0.13;
/** Hover is one step up: more green ... */
export const RAISE_HOVER_VEIL = 0.37;
/** ... paying for more bone. At every depth a hover reads brighter than its rest. */
export const RAISE_HOVER_LIFT = 0.145;
/** Press is one step down: the raise's green with less bone (and an inset shade from above). */
export const RAISE_PRESS_LIFT = 0.03;
/**
 * A quiet fill inside a lit surface (`--fill-ghost`: a skipped row, a table's every other row, the toast's Undo):
 * a touch less green than a raised thing ...
 */
export const GHOST_VEIL = 0.33;
/** ... and a touch less bone, so it climbs the ladder too and its hover (a raised fill) still adds light. */
export const GHOST_LIFT = 0.125;
/** A ghost button straight on the page: the pick-one track's green (`TRACK_EXTRA_VEIL`) with this lift. */
export const PAGE_GHOST_LIFT = 0.06;
/** A control straight on the page, on hover: the track's green with this lift (its rest is `TRACK_LIFT`). */
export const PAGE_HOVER_LIFT = 0.09;
/**
 * A floating layer (toasts, the setup pill, rail and list, the Ask launcher and panel, the money dock): this much more
 * green than `FLOAT_VEIL` (or the panel, if heavier). It plans for a white thumbnail under it, a light backdrop: the
 * least that keeps its words (mid-height, `FLOAT_WORDS_LIGHT` of its top light) at AA there, within `MAX_LIGHT_PAY`.
 */
export const FLOAT_EXTRA_VEIL = 0.02;
/**
 * The update bar is the one floating layer that darkens more, only by the least the AA cap over a white thumbnail
 * needs: its Reload face reads 0.08 OKLab L over Later and Later 0.03 over the bar, with bone words at AA at rest and
 * on hover, so over white the bar has to sit at about L 0.39 (`--light-update-pay`).
 */
export const UPDATE_EXTRA_VEIL = 0.22;
/** ... paying for this light at its top. */
export const FLOAT_LIGHT = 0.08;
/**
 * The share of a floating layer's top light at the height of its words: like a pane's, its light lies in its top
 * padding only (half at 6 px, gone by 14 px: `--glass-light-float`), so its words, a heading at its top included, sit
 * on its plain glass (`floatTop`).
 */
export const FLOAT_WORDS_LIGHT = 0;
/**
 * A floating layer on hover (the setup pill, the launcher): the same green, a little more light at its top and a flat
 * bone lift of this much under its words (all the room main's float veil leaves over a white thumbnail: 4.52:1).
 */
export const FLOAT_HOVER_LIFT = 0.01;
/** ... and this much light at its top. */
export const FLOAT_HOVER_LIGHT = 0.09;
/** Sheets, the picture viewer and the markup editor: their light at the top, over their near-solid tint. */
export const OVERLAY_LIGHT = 0.12;
/** The dropdown list (solid) and the workspace menu (0.94): their light at the top. */
export const MENU_LIGHT = 0.1;
/** The tab bar (icons only, 3:1): this much more green than `TABBAR_VEIL` ... */
export const TABBAR_EXTRA_VEIL = 0.04;
/** ... paying for this light at its top. */
export const TABBAR_LIGHT = 0.04;

/**
 * The smallest veil strength (0..1, rounded up to 0.01) at which every text colour reaches `target` contrast on the
 * veil laid over `under`.
 */
export function minVeil(under: Rgb, texts: readonly Rgb[] = TEXT_COLOURS, veil: Rgb = VEIL, target = AA): number {
  const holds = (step: number) => veilHolds(under, step / 100, texts, veil, target);
  if (holds(0)) return 0;
  if (!holds(100)) return 1;
  // Luminance is convex along the mix and the veil itself holds, so the steps that hold run unbroken up to 100: the
  // least is found by halving.
  let [lo, hi] = [0, 100];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (holds(mid)) hi = mid;
    else lo = mid;
  }
  return hi / 100;
}
/** Every text colour reaches `target` on `alpha` of the veil over `under`. */
function veilHolds(under: Rgb, alpha: number, texts: readonly Rgb[] = TEXT_COLOURS, veil: Rgb = VEIL, target = AA): boolean {
  const bg = mix(veil, under, alpha);
  return texts.every((t) => contrast(t, bg) >= target);
}

export interface SeeThroughVeils {
  /** Over the whole window, between the panels: what the wallpaper shows through. */
  page: number;
  /** Over every panel and every piece of text that sits straight on the window: enough for AA on the lightest glass. */
  panel: number;
}

/**
 * The two tints in see-through for this glass, setting and strength, worked out for the window look's text colours.
 * The window's own glass is behind the page, where no web `brightness()` reaches, so these are AA floors over white
 * as it is. Clear: nothing between the panels; a panel carries the least green that keeps every text colour at AA on
 * the lightest glass (never less than `PANEL_VEIL_FLOOR`): 0.73. Frosted: a green frost everywhere (0.30), and a
 * panel the least green that keeps AA over the frost on white and still shows a little less of the desktop than a
 * Clear panel, `(1 − frost)(1 − panel) < 1 − clear`: 0.62 (it was 0.88, the Clear panel plus 0.15).
 */
export function seeThroughVeils(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): SeeThroughVeils {
  const ceiling = glassCeiling(glass, scheme);
  const clear = Math.max(PANEL_VEIL_FLOOR, minVeil(ceiling, TEXT_COLOURS_WINDOW));
  if (strength === "clear") return { page: PAGE_VEIL.clear, panel: clear };
  const frost = PAGE_VEIL.frosted;
  const aa = minVeil(mix(VEIL, ceiling, frost), TEXT_COLOURS_WINDOW);
  // The least panel (0.01 steps) that shows strictly less than Clear does.
  const less = Math.floor((1 - (1 - clear) / (1 - frost)) * 100 + 1e-9) / 100 + 0.01;
  return { page: frost, panel: round2(Math.max(PANEL_VEIL_FLOOR, aa, less)) };
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

/**
 * What words on a tinted chip sit on: the panel, the green under the tint (`CHIP_UNDER`), its bone lift (`lift`, see
 * `CHIP_TINTS`), then the chip's own tint (`tint` at `alpha`).
 */
export function seeThroughChipBackground(glass: NativeGlass, scheme: Scheme, strength: GlassStrength, tint: Rgb, alpha: number, behind: Rgb = glassCeiling(glass, scheme), lift = 0): Rgb {
  return mix(tint, mix(BONE, mix(CHIP_UNDER, seeThroughWorstBackground(glass, scheme, strength, behind), CHIP_DEEPEN), lift), alpha);
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

// BRAND_BRIGHTNESS, BRAND_PANEL_VEIL and BRAND_PLATE_VEIL (the app's own living backdrop) are worked out at the end
// of this file.
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

/** The colours look's tints and its glass's dimming (`coloursVeils`). */
export interface ColoursVeils {
  /** Over the whole backdrop (`--backdrop-veil`). */
  pageVeil: number;
  /** On every pane, over the backdrop as its glass sees it (dimmed by `brightness`). */
  panelVeil: number;
  /** Under words where nothing dims the backdrop: the title and line plates, controls straight on the page. */
  plateVeil: number;
  /** The glass's `brightness()` (`glassBrightness` over the mesh). */
  brightness: number;
}

/**
 * The colours look's tints. The glass dims the mesh only as much as the floor needs (`glassBrightness`); the panels
 * then carry what its lightest spot needs as they see it (never under the floor) and the page nothing, up to
 * `MAX_COLOURS_PANEL_VEIL`; past that the panels stay there and the page takes the least that covers it. The plates
 * carry what the lightest spot needs under the page veil, undimmed.
 */
export function coloursVeils(colours: readonly string[]): ColoursVeils {
  const spots = coloursMeshSpots(colours);
  const brightness = glassBrightness(spots);
  const need = veilOver(spots.map((s) => dimRgb(s, brightness)));
  let pageVeil = 0;
  let panelVeil = need;
  if (need > MAX_COLOURS_PANEL_VEIL) {
    panelVeil = MAX_COLOURS_PANEL_VEIL;
    const covered = (p: number) => spots.every((s) => TEXT_COLOURS.every((t) => contrast(t, mix(VEIL, dimRgb(mix(VEIL, s, p), brightness), panelVeil)) >= AA));
    let step = 0;
    while (step < 100 && !covered(step / 100)) step++;
    pageVeil = step / 100;
  }
  const plateVeil = veilOver(spots.map((s) => mix(VEIL, s, pageVeil)));
  return { pageVeil, panelVeil, plateVeil, brightness };
}

/**
 * The least veil (0.01 steps, never under `PANEL_VEIL_FLOOR`) that keeps every text colour at AA over every one of
 * `pages` (the backdrop as the surface sees it: dimmed under a pane, as it is under a plate) and leaves the ladder of
 * light its first rung there (`rowRoom`): over a vivid vermilion a thin veil leaves a red surface at the AA cap, and a
 * row on it would read more than `LADDER_SLACK` darker.
 */
export function veilOver(pages: readonly Rgb[]): number {
  let veil = Math.max(PANEL_VEIL_FLOOR, minVeilOver(pages));
  while (veil < 1 && !pages.every((p) => rowRoom(lit(p, veil, 0)))) veil = round2(veil + 0.01);
  return veil;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- What to draw ----------

/**
 * What every look carries for its glass: the panel veil (over the backdrop as the glass sees it, dimmed by
 * `brightness`), the plate veil (words where nothing dims it: the title and line plates, controls straight on the
 * page) and the glass's `brightness()`.
 */
export type LookGlass = { panelVeil: number; plateVeil: number; brightness: number };
export type Look =
  /**
   * Desktop app with real window glass: the page is transparent; the panels carry the tint that keeps text readable.
   * Nothing dims the desktop, so the glass draws no brightness(), and a plate carries the green its words need in its
   * top light (`windowGlass`): left out, `plateVeil` is `panelVeil` and `brightness` is 1 (`glassOf`).
   */
  | ({ kind: "window"; glass: NativeGlass; strength: GlassStrength; pageVeil: number } & Omit<LookGlass, "plateVeil" | "brightness"> & Partial<LookGlass>)
  /** See-through where the page cannot see behind itself: the living Clip Factory backdrop, frosted or clear. */
  | ({ kind: "frosted"; strength: GlassStrength } & LookGlass)
  | ({ kind: "picture"; url: string; pageVeil: number } & LookGlass)
  /** Picture chosen but none on this device yet: the Clip Factory colours. */
  | ({ kind: "brand" } & LookGlass)
  | ({ kind: "colours"; colours: string[]; pageVeil: number } & LookGlass);

/** A look's glass in full: the window look's plate veil and brightness, when left out, are its panel veil and 1. */
export function glassOf(look: Look): LookGlass {
  return { panelVeil: look.panelVeil, plateVeil: look.plateVeil ?? look.panelVeil, brightness: look.brightness ?? WINDOW_BRIGHTNESS };
}
/**
 * The light under a plate's words: a line plate has 8 px of room above its words, and a display face's glyph box
 * (the brand in a phone's top bar, "This week") or a small chip (the top bar's Live chip) starts them about 6 px down,
 * where half the plate's top light (`PANEL_LIGHT`) and a quarter of its catch light (`SPECULAR`, 8 px deep) still lie.
 * A pane's words start below its light (`WORDS_LIGHT`); a plate's need this much more green wherever no pay and no
 * dimming cover it: the window look.
 */
export const PLATE_WORDS_LIGHT = 1 - (1 - PANEL_LIGHT * 0.5) * (1 - SPECULAR * 0.25);

/**
 * The plate veil of the window look: the least (0.01 steps, never under the panel's) that keeps every window text
 * colour at AA with `PLATE_WORDS_LIGHT` of bone over it, over the lightest glass under the look's frost. Nothing dims
 * the desktop and the window look carries no pay (`LIGHT_PAY_WINDOW`), so the green pays for that light: Clear 0.75
 * (the panel 0.73), Frosted 0.64 (the panel 0.62).
 */
export function windowPlateVeil(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): number {
  const v = seeThroughVeils(glass, scheme, strength);
  const under = mix(VEIL, glassCeiling(glass, scheme), v.page);
  let veil = v.panel;
  while (veil < 1 && !TEXT_COLOURS_WINDOW.every((t) => contrast(t, lit(under, veil, PLATE_WORDS_LIGHT)) >= AA)) veil = round2(veil + 0.01);
  return veil;
}

/**
 * The glass of the window look for this glass, setting and strength: nothing dims the desktop, so the glass draws no
 * brightness(), and a plate carries what its words need in its top light (`windowPlateVeil`).
 */
export function windowGlass(glass: NativeGlass, scheme: Scheme, strength: GlassStrength): LookGlass & { pageVeil: number } {
  const v = seeThroughVeils(glass, scheme, strength);
  return { pageVeil: v.page, panelVeil: v.panel, plateVeil: windowPlateVeil(glass, scheme, strength), brightness: WINDOW_BRIGHTNESS };
}

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
      if (i.glass === "none") return { kind: "frosted", strength: i.strength, ...BRAND_GLASS };
      return { kind: "window", glass: i.glass, strength: i.strength, ...windowGlass(i.glass, i.scheme, i.strength) };
    case "picture":
      return i.picture ? { kind: "picture", url: i.picture, ...PICTURE_GLASS } : { kind: "brand", ...BRAND_GLASS };
    case "colours": {
      const colours = normaliseColours(i.colours);
      return { kind: "colours", colours, ...coloursVeils(colours) };
    }
  }
}

// ---------- The logic of light: what words sit on at each level (ADR-87) ----------

/** `veil` of bottle green (at most solid) over `under`, then `lift` of bone over that: how every lit surface composites. */
export function lit(under: Rgb, veil: number, lift: number): Rgb {
  return mix(BONE, mix(VEIL, under, Math.min(1, veil)), lift);
}

/** How bright a colour looks: its OKLab lightness, 0 (black) to 1 (white). "The top layer is brighter" is measured in it. */
export function oklabL(c: Rgb): number {
  const [r, g, b] = c.map(linearChannel) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/**
 * What the light needs to know of a look: its kind, its panel veil, its plate veil and its glass's `brightness()`
 * (`LookGlass`) and, if it has one, its page veil; for Colours, the colours (without them the pay is planned for a
 * white mesh, the most any colours can need).
 */
export type LightLook = { kind: Look["kind"]; pageVeil?: number; colours?: readonly string[] } & LookGlass;

/** Every spot Picture plans for: a white photo (as it is and through the strongest saturate()) and a black one. */
const PICTURE_SPOTS: readonly Rgb[] = [...PICTURE_WORST, BLACK];
const PAYS = new Map<string, number>();

/**
 * The green that pays for the light (`--light-pay`, set on <html> by lib/look.ts): for each look the least that leaves
 * room for the ladder over every spot it can show (`ladderPay`), on its panes (over the backdrop as their glass sees
 * it) and on its plates (over the backdrop as it is). `LIGHT_PAY_REDUCED` under reduced transparency.
 */
export function lightPay(look: LightLook, reducedTransparency = false): number {
  if (reducedTransparency) return LIGHT_PAY_REDUCED;
  // See-through first: the app's own backdrop (Clear and Frosted) and the window look carry no pay.
  if (look.kind === "frosted" || look.kind === "brand") return LIGHT_PAY_OWN;
  if (look.kind === "window") return LIGHT_PAY_WINDOW;
  const pv = look.pageVeil ?? 0;
  const key = `${look.kind} ${look.panelVeil} ${look.plateVeil} ${look.brightness} ${pv} ${look.colours?.join(" ") ?? ""}`;
  let pay = PAYS.get(key);
  if (pay === undefined) {
    const spots = look.kind === "picture" ? PICTURE_SPOTS : look.colours ? coloursMeshSpots(look.colours) : [WHITE];
    // The least green at which every level climbs a whole step (no room exemption), up to MAX_LIGHT_PAY over the
    // look's veils, and a pane never reaches SEE_THROUGH_LIMIT. Where even that leaves no room (white behind), the cap wins.
    const room = Math.floor((SEE_THROUGH_LIMIT - 0.01 - Math.max(look.panelVeil, look.plateVeil)) * 100 + 1e-9) / 100;
    const need = Math.max(ladderPay(spots, look.panelVeil, pv, true, look.brightness), ladderPay(spots, look.plateVeil, pv, true));
    pay = Math.max(0, Math.min(MAX_LIGHT_PAY, room, need));
    PAYS.set(key, pay);
  }
  return pay;
}

/** `behind` (the backdrop as drawn: the desktop, the photo, a spot of the mesh) under the look's own page veil. */
function onThePage(look: LightLook, behind: Rgb): Rgb {
  return mix(VEIL, behind, look.pageVeil ?? 0);
}

/** `behind` under the look's page veil as a pane's glass sees it: dimmed by its `brightness()`. */
export function underGlass(look: LightLook, behind: Rgb): Rgb {
  return dimRgb(onThePage(look, behind), look.brightness);
}

/**
 * What words at the TOP of a panel sit on (E1, where its light is strongest), over `behind`: the backdrop as the
 * panel's glass sees it (`underGlass`), the panel veil plus the pay, then `PANEL_LIGHT`. `lead`: the lead panel,
 * `LEAD_EXTRA_VEIL` more green (at most 0.97) under `LEAD_LIGHT`.
 */
export function panelTop(look: LightLook, behind: Rgb, lead = false, pay = lightPay(look), share = 1): Rgb {
  const page = underGlass(look, behind);
  if (lead) return lit(page, Math.min(0.97, look.panelVeil + pay + LEAD_EXTRA_VEIL), LEAD_LIGHT * share);
  return lit(page, look.panelVeil + pay, PANEL_LIGHT * share);
}

/** What the words of a pane sit on: `panelTop` at the height of its words (mid-height, `WORDS_LIGHT` of its top light). */
export function panelWords(look: LightLook, behind: Rgb, lead = false, pay = lightPay(look)): Rgb {
  return panelTop(look, behind, lead, pay, WORDS_LIGHT);
}

/**
 * What the words of a title or line plate sit on (E1 with no filter of its own): the backdrop as it is under the
 * look's page veil, the plate veil plus the pay (`--glass-tint-plate`), at the height of its words.
 */
export function plateWords(look: LightLook, behind: Rgb, pay = lightPay(look)): Rgb {
  return lit(onThePage(look, behind), look.plateVeil + pay, PANEL_LIGHT * WORDS_LIGHT);
}

/** OKLab a (green − / red +) of a colour. */
export function oklabA(c: Rgb): number {
  const [r, g, b] = c.map(linearChannel) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
}
/**
 * A vermilion-red parent (OKLab a over this) at `LADDER_RED_L` or brighter: bottle green and bone mixed over red in
 * sRGB pass through a duller brown, so a level that keeps AA at every depth climbs less than a whole step there
 * (+0.009 at the least, a vivid vermilion mesh under a thin veil), though it never reads darker.
 */
export const LADDER_RED_A = 0.06;
/** ... (see `LADDER_RED_A`). */
export const LADDER_RED_L = 0.38;
/**
 * True when the AA cap leaves no room for a whole step over `under`: it reads brighter than `LADDER_ROOM_L`, or it is
 * vermilion-red and brighter than `LADDER_RED_L`, or even `LADDER_ROOM` of bone over it takes a text colour under AA.
 */
export function noRoom(under: Rgb): boolean {
  const L = oklabL(under);
  return L > LADDER_ROOM_L || (L > LADDER_RED_L && oklabA(under) > LADDER_RED_A) || worstText(mix(BONE, under, LADDER_ROOM)) < AA;
}

/** The states a raised thing answers with: hover adds light, press takes it away; a quiet (ghost) fill rests a touch lower. */
export type LightState = "rest" | "hover" | "press" | "ghost";
const RAISE: Record<LightState, readonly [veil: number, lift: number]> = {
  rest: [RAISE_VEIL, RAISE_LIFT],
  hover: [RAISE_HOVER_VEIL, RAISE_HOVER_LIFT],
  press: [RAISE_VEIL, RAISE_PRESS_LIFT],
  ghost: [GHOST_VEIL, GHOST_LIFT],
};

/**
 * What words on a raised thing inside a lit surface sit on, `depth` steps above `parent` (1: a row on a panel, 2: a
 * mark on that row, 3: a chip on the mark). The steps under it rest; `state` is the top one's.
 */
export function raised(parent: Rgb, depth = 1, state: LightState = "rest"): Rgb {
  let under = parent;
  for (let d = 1; d < depth; d++) under = lit(under, RAISE_VEIL, RAISE_LIFT);
  const [veil, lift] = RAISE[state];
  return lit(under, veil, lift);
}

/** Every text colour's luminance, worked out once: the ladder is checked over many thousand spots. */
const TEXT_LUMINANCES = TEXT_COLOURS.map(luminance);
/** The lowest contrast any text colour gets on `bg` (only the two luminances count). */
function worstText(bg: Rgb): number {
  const lb = luminance(bg);
  let w = Infinity;
  for (const lt of TEXT_LUMINANCES) w = Math.min(w, lt > lb ? (lt + 0.05) / (lb + 0.05) : (lb + 0.05) / (lt + 0.05));
  return w;
}
const STATES: readonly LightState[] = ["rest", "hover", "press", "ghost"];
/**
 * The tinted chips (`--tint-*` in tokens.css): their colour at `alpha`, over a `lift` of bone, over `CHIP_DEEPEN` of
 * `CHIP_UNDER`. The bone lift makes a chip a step of light over the row it sits on in every look (vermilion reads
 * darker than a bluish row without it), and the green under it keeps its words at AA.
 */
export const CHIP_TINTS: readonly { name: string; colour: Rgb; alpha: number; lift: number }[] = [
  { name: "leaf", colour: hexToRgb("#5fa585"), alpha: 0.22, lift: 0.04 },
  { name: "vermilion", colour: hexToRgb("#e8392b"), alpha: 0.2, lift: 0.13 },
  { name: "amber", colour: [246, 201, 69], alpha: 0.16, lift: 0.01 },
];
/** What words on a tinted chip laid over `under` sit on (`--tint-*`). */
export function chipOn(under: Rgb, tint: { colour: Rgb; alpha: number; lift: number }): Rgb {
  return mix(tint.colour, mix(BONE, mix(CHIP_UNDER, under, CHIP_DEEPEN), tint.lift), tint.alpha);
}

/**
 * What breaks the ladder over one spot of the page (`page`: the backdrop under the look's page veil) at this pay:
 * empty when every rung holds. A plain panel and the lead panel each carry three levels above them, at rest, hovered,
 * pressed and quiet. Every word keeps AA; the lead panel reads a whole `LADDER_STEP` over a plain one; every level
 * (and its quiet fill) climbs a whole step over what it sits on, or, where `noRoom` (and not `strict`), steps back at
 * most `LADDER_SLACK`; a quiet fill never outshines its rest, and every hover reads brighter than its rest.
 */
export function ladderFaults(page: Rgb, panelVeil: number, pay: number, first = false, strict = false): string[] {
  const faults: string[] = [];
  const L = oklabL;
  // Where the words are: mid-height, WORDS_LIGHT of each pane's top light.
  const e1 = lit(page, panelVeil + pay, PANEL_LIGHT * WORDS_LIGHT);
  const lead = lit(page, Math.min(0.97, panelVeil + pay + LEAD_EXTRA_VEIL), LEAD_LIGHT * WORDS_LIGHT);
  if (worstText(e1) < AA) faults.push("AA on a panel");
  if (worstText(lead) < AA) faults.push("AA on the lead panel");
  if (L(lead) < L(e1)) faults.push("the lead panel never under a panel");
  if (first && faults.length) return faults;
  /** A level over `under` climbs a whole step, or, where the AA cap leaves no room, never steps back more than the slack. */
  const climbs = (under: Rgb, over: Rgb) => L(over) - L(under) >= (!strict && noRoom(under) ? -LADDER_SLACK : LADDER_STEP);
  for (const [name, pane] of [["panel", e1], ["lead panel", lead]] as const) {
    let under = pane;
    for (let depth = 1; depth <= 3; depth++) {
      const at = `E${depth + 1} on the ${name}`;
      const rest = raised(under);
      for (const state of STATES) if (worstText(raised(under, 1, state)) < AA) faults.push(`AA, ${at}, ${state}`);
      if (!climbs(under, rest)) faults.push(`${at} over its parent`);
      if (!climbs(under, raised(under, 1, "ghost"))) faults.push(`${at}, quiet, over its parent`);
      if ((strict || !noRoom(under)) && L(rest) < L(raised(under, 1, "ghost"))) faults.push(`${at}: quiet outshines rest`);
      if (L(raised(under, 1, "hover")) <= L(rest)) faults.push(`${at}: hover adds light`);
      // A tinted chip on a row or on a mark is a level of its own: a step of light over it, its words at AA.
      if (depth <= 2)
        for (const t of CHIP_TINTS) {
          const chip = chipOn(rest, t);
          if (worstText(chip) < AA) faults.push(`AA, the ${t.name} chip on ${at}`);
          if (!climbs(rest, chip)) faults.push(`the ${t.name} chip a step over ${at}`);
        }
      if (first && faults.length) return faults;
      under = rest;
    }
  }
  return faults;
}

/**
 * The ladder's first rung over a pane's words (`pane`): a row on it, at rest and quiet, climbs a whole step, or where
 * the AA cap leaves no room (`noRoom`) reads at most `LADDER_SLACK` darker. The rung that binds over a thin veil (a
 * red pane at the AA cap); `ladderFaults` holds every other.
 */
export function rowRoom(pane: Rgb): boolean {
  const need = noRoom(pane) ? -LADDER_SLACK : LADDER_STEP;
  const L = oklabL(pane);
  return oklabL(raised(pane)) - L >= need && oklabL(raised(pane, 1, "ghost")) - L >= need;
}

/**
 * The least pay (0.01 steps) at which the ladder holds over every spot of a look (`spots`, the backdrop as drawn),
 * under its page veil, as a pane's glass sees it (dimmed by `brightness`; 1 for a plate, which draws no filter). This
 * is what lowers a pane over a light backdrop: page to pane goes darker there, and the ladder above the pane fits
 * under the AA ceiling.
 */
export function ladderPay(spots: readonly Rgb[], panelVeil: number, pageVeil = 0, strict = false, brightness = 1): number {
  const pages = spots.map((s) => dimRgb(mix(VEIL, s, pageVeil), brightness));
  // More green lowers a pane over the light spots that bind and widens every step above it, so the least pay is found
  // by halving (test/background.test.ts checks that 0.01 less breaks the ladder somewhere).
  const holds = (step: number) => panelVeil + step / 100 >= 1 || pages.every((p) => ladderFaults(p, panelVeil, step / 100, true, strict).length === 0);
  if (holds(0)) return 0;
  let [lo, hi] = [0, 100];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (holds(mid)) hi = mid;
    else lo = mid;
  }
  return hi / 100;
}

/**
 * What words on a control straight on the page sit on (no lit surface under it, and no `brightness()` of its own):
 * the backdrop as it is, the plate veil plus the pick-one track's green, the lift of its state.
 */
export function onPage(look: LightLook, behind: Rgb, state: LightState = "rest"): Rgb {
  const lift = { rest: TRACK_LIFT, hover: PAGE_HOVER_LIFT, press: RAISE_PRESS_LIFT, ghost: PAGE_GHOST_LIFT }[state];
  return lit(onThePage(look, behind), look.plateVeil + TRACK_EXTRA_VEIL, lift);
}

/**
 * The top of a floating layer over `under` (a white thumbnail, the backdrop, a panel): `floatVeil` or the panel veil,
 * whichever is heavier, plus `FLOAT_EXTRA_VEIL`, under `FLOAT_LIGHT` (`FLOAT_HOVER_LIGHT` on hover).
 */
export function floatTop(under: Rgb, look: Pick<LightLook, "panelVeil">, state: "rest" | "hover" = "rest", floatVeil = FLOAT_VEIL, share = FLOAT_WORDS_LIGHT): Rgb {
  return lit(under, Math.max(floatVeil, look.panelVeil) + FLOAT_EXTRA_VEIL, state === "hover" ? FLOAT_HOVER_LIGHT * share + FLOAT_HOVER_LIFT : FLOAT_LIGHT * share);
}


/** The note under see-through in an old desktop app (`isOldDesktopApp`); its button gets the new one. */
export const OLD_APP_NOTE = "Update the app to see through.";

/**
 * The one plain line under the choice, so nobody wonders why see-through looks different here. `oldApp`: a desktop
 * app too old to say what glass it has (`isOldDesktopApp`), which only needs the new one.
 */
export function seeThroughNote(glass: NativeGlass, desktopApp: boolean, phone = false, oldApp = false): string | null {
  if (glass !== "none") return null;
  if (desktopApp && oldApp) return OLD_APP_NOTE;
  if (desktopApp) return "This computer can't show see-through, so here you get the Clip Factory colours.";
  if (phone) return "See-through works in the Mac and Windows app on a computer. Phones don't let apps look behind them, so here you get the Clip Factory colours.";
  return "See-through works in the Mac and Windows app. Browsers don't let apps look behind them, so here you get the Clip Factory colours.";
}

/** A colour shows softer (greener) than its swatch once the page itself needs a veil, so the Colours card says why. */
export const SOFT_COLOURS_VEIL = 0;
export const SOFT_COLOURS_NOTE = "Light colours show soft, so words stay easy to read.";

// ---------- Each look's own glass (last: the ladder of light above takes part in the brightness) ----------

/**
 * How much the glass dims the app's own living backdrop: the least at which the floor holds over every corner, AA and
 * the ladder's first rung (0.73; at 0.74 a row over the vermilion corner would read more than 0.03 under its pane).
 */
export const BRAND_BRIGHTNESS = glassBrightness(brandMeshSpots());
/**
 * The panel tint over the app's own living backdrop: the least that keeps AA over its lightest corner as the glass
 * sees it (dimmed by `BRAND_BRIGHTNESS`), never under the floor: 0.20, so 80 % of the backdrop shows (it was 0.33).
 */
export const BRAND_PANEL_VEIL = veilOver(brandMeshSpots().map((s) => dimRgb(s, BRAND_BRIGHTNESS)));
/**
 * What words need over it where nothing dims it: the title and line plates (no filter of their own, so the title
 * plates stay out of the refraction and blur budget) and controls straight on the page. Main's 0.33.
 */
export const BRAND_PLATE_VEIL = veilOver(brandMeshSpots());
/**
 * The picture look's glass: a pane dims a white photo to half its light (`MIN_GLASS_BRIGHTNESS`) and carries 0.59
 * green over it (it was 0.73); a plate, with no filter, carries what a white photo needs as it is (0.73).
 */
export const PICTURE_BRIGHTNESS = glassBrightness(PICTURE_WORST);
export const PICTURE_PANEL_VEIL = veilOver(PICTURE_WORST.map((s) => dimRgb(s, PICTURE_BRIGHTNESS)));
export const PICTURE_PLATE_VEIL = veilOver(PICTURE_WORST);
/** The glass over the app's own living backdrop (see-through without native glass, Picture with no picture yet). */
export const BRAND_GLASS: LookGlass = { panelVeil: BRAND_PANEL_VEIL, plateVeil: BRAND_PLATE_VEIL, brightness: BRAND_BRIGHTNESS };
/** The glass over the owner's picture. */
export const PICTURE_GLASS: LookGlass & { pageVeil: number } = { pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL, plateVeil: PICTURE_PLATE_VEIL, brightness: PICTURE_BRIGHTNESS };
