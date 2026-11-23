import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AA,
  BONE,
  BRAND_BRIGHTNESS,
  BRAND_GLASS,
  BRAND_MESH,
  BRAND_PANEL_VEIL,
  BRAND_PLATE_VEIL,
  brandMeshSpots,
  brandMeshWorst,
  CHIP_DEEPEN,
  CHIP_TINTS,
  CHIP_UNDER,
  chipOn,
  COLOURS_BLOB_ALPHA,
  COLOURS_FIELD_END,
  coloursMeshSpots,
  coloursMeshWorst,
  coloursVeil,
  coloursVeils,
  contrast,
  currentColours,
  DEFAULT_COLOURS,
  FLOAT_EXTRA_VEIL,
  FLOAT_HOVER_LIGHT,
  FLOAT_LIGHT,
  FLOAT_VEIL,
  floatTop,
  GHOST_LIFT,
  GHOST_VEIL,
  GLASS_SATURATE,
  GLASS_SATURATE_MAX,
  GLASS_TINT_ALPHA,
  glassCeiling,
  glassChecks,
  glassFloor,
  GREEN_DEEP,
  hexToRgb,
  isHexColour,
  LADDER_STEP,
  ladderFaults,
  LADDER_SLACK,
  noRoom,
  panelWords,
  LEAD_EXTRA_VEIL,
  LEAD_LIGHT,
  LIGHT_PAY_OWN,
  LIGHT_PAY_REDUCED,
  LIGHT_PAY_WHITE,
  lightPay,
  LIQUID_ACTIVE_FLOOR,
  LIQUID_FLOOR,
  LIQUID_MEASURED,
  LIQUID_SAFETY,
  lit,
  luminance,
  MAX_COLOURS_PANEL_VEIL,
  MIN_GLASS_BRIGHTNESS,
  MENU_LIGHT,
  mix,
  minVeil,
  MAX_LIGHT_PAY,
  mostPay,
  platePay,
  veilOver,
  normaliseColours,
  oklabL,
  OLD_DEFAULT_COLOURS,
  ON_BONE,
  onPage,
  OVERLAY_LIGHT,
  PAGE_GHOST_LIFT,
  PAGE_HOVER_LIFT,
  PANEL_LIGHT,
  PANEL_VEIL_FLOOR,
  panelTop,
  PICTURE_BRIGHTNESS,
  PICTURE_GLASS,
  PICTURE_PAGE_VEIL,
  PICTURE_PANEL_VEIL,
  PICTURE_PLATE_VEIL,
  PLATE_WORDS_LIGHT,
  plateWords,
  cantSelfUpdate,
  dimRgb,
  bestGlass,
  showThrough,
  isOldDesktopApp,
  readDesktopVersion,
  OLD_APP_NOTE,
  RAISE_HOVER_LIFT,
  RAISE_HOVER_VEIL,
  RAISE_LIFT,
  RAISE_PRESS_LIFT,
  RAISE_VEIL,
  raised,
  readNativeGlass,
  resolveLook,
  SATURATIONS,
  saturateRgb,
  SEE_THROUGH_LIMIT,
  SELECTED_ALPHA,
  seeThroughChipBackground,
  seeThroughNote,
  seeThroughSelectedBackground,
  seeThroughTrackBackground,
  seeThroughVeils,
  seeThroughWorstBackground,
  SHEET_VEIL,
  softLightOver,
  overlayOver,
  SPECULAR,
  SWATCHES,
  swatchTickIsDark,
  TABBAR_EXTRA_VEIL,
  TABBAR_LIGHT,
  TABBAR_VEIL,
  TEXT_COLOURS,
  TEXT_COLOURS_WINDOW,
  TEXT_TOKENS,
  TINTED_FLOOR,
  TRACK_EXTRA_VEIL,
  TRACK_LIFT,
  underGlass,
  VEIL,
  WINDOW_BRIGHTNESS,
  WINDOW_TEXT_TOKENS,
  windowGlass,
  windowPlateVeil,
  type GlassStrength,
  type LightLook,
  type LightState,
  type LookInput,
  type NativeGlass,
  type Rgb,
  type Scheme,
  type TextToken,
} from "../src/lib/background.ts";

const STYLES = join(import.meta.dirname, "..", "src", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8");
/** Without comments, so a number in a comment never stands in for one in a rule. */
const rules = (name: string) => css(name).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector list is exactly `selector`. */
const block = (text: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? "";
/** Custom properties declared in a rule body. */
const declared = (body: string) => new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

/** Each text colour's luminance, worked out once (the light checks below run over many thousand spots). */
const TEXT_LUMINANCE = TEXT_COLOURS.map(luminance);
/** The lowest contrast any text colour gets on `bg` (WCAG: only the two luminances count). */
const worst = (bg: Rgb) => {
  const lb = luminance(bg);
  let w = Infinity;
  for (const lt of TEXT_LUMINANCE) w = Math.min(w, lt > lb ? (lt + 0.05) / (lb + 0.05) : (lb + 0.05) / (lt + 0.05));
  return w;
};
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(hexToRgb("#777777"), [255, 255, 255])).toBeCloseTo(4.48, 2);
    // Bone on solid bottle green, the reference's pair.
    expect(contrast(BONE, VEIL)).toBeCloseTo(10.68, 2);
    expect(contrast(ON_BONE, BONE)).toBeCloseTo(10.68, 2);
  });

  it("mixes like a browser composites", () => {
    expect(mix([255, 255, 255], [0, 0, 0], 0.5)).toEqual([127.5, 127.5, 127.5]);
    expect(mix([10, 20, 30], [200, 200, 200], 1)).toEqual([10, 20, 30]);
  });

  it("minVeil is the smallest green veil that reaches AA for every text colour", () => {
    for (const under of [[255, 255, 255], [136, 136, 136], hexToRgb("#e8392b"), hexToRgb("#f6c945")] as Rgb[]) {
      const a = minVeil(under);
      expect(worst(mix(VEIL, under, a))).toBeGreaterThanOrEqual(AA);
      if (a > 0) expect(worst(mix(VEIL, under, a - 0.01))).toBeLessThan(AA);
    }
    expect(minVeil(VEIL)).toBe(0);
    // Pure white is the hardest: 0.73 for the one text set (the old root set needed 0.77).
    expect(minVeil(WHITE)).toBe(0.73);
    expect(minVeil(WHITE, TEXT_COLOURS_WINDOW)).toBe(0.73);
    expect(minVeil(WHITE, ["#efe7da", "#e9e0d0", "#e4dac9", "#ffd2ca", "#d2e8c4", "#d6ebc8"].map(hexToRgb))).toBe(0.77);
  });
});

/** The lowest contrast any text colour of the window look gets on `bg`. */
const worstInWindow = (bg: Rgb) => Math.min(...TEXT_COLOURS_WINDOW.map((t) => contrast(t, bg)));
const GLASSES = ["liquid", "vibrancy", "mica", "acrylic", "blur"] as const satisfies readonly NativeGlass[];
const SCHEMES = ["light", "dark"] as const satisfies readonly Scheme[];
const STRENGTHS = ["clear", "frosted"] as const satisfies readonly GlassStrength[];
/** Every glass, setting and strength, with everything its text is checked against (`glassChecks`). */
const EVERY_LOOK = GLASSES.flatMap((glass) =>
  SCHEMES.flatMap((scheme) => STRENGTHS.flatMap((strength) => glassChecks(glass, scheme).map((check) => ({ glass, scheme, strength, check, at: `${glass} ${scheme} ${strength} over ${check.name}` })))),
);

describe("what each window glass can be", () => {
  it("the lightest every glass can be is planned as white: bone text on green panels is hardest there", () => {
    for (const glass of GLASSES) for (const scheme of SCHEMES) expect(glassCeiling(glass, scheme)).toEqual(WHITE);
    // The lightest Liquid Glass measured is effectively white, and never lighter.
    for (const state of ["active", "inactive"] as const) for (const c of LIQUID_MEASURED[state].overWhite) expect(c).toBeLessThanOrEqual(255);
  });

  it("Liquid Glass measurements stay on record, and the floor is a tenth darker than the darkest measured", () => {
    // Measured on 2026-11-16 on macOS 27.2 (docs/CONTRACTS.md §22.3). These are records, not knobs.
    expect(LIQUID_MEASURED).toEqual({
      active: { overBlack: [180, 171, 148], overWhite: [249, 248, 245] },
      inactive: { overBlack: [118, 118, 118], overWhite: [225, 225, 225] },
    });
    expect(LIQUID_SAFETY).toBe(0.1);
    const floor = glassFloor("liquid", "light");
    expect(floor).toEqual(LIQUID_FLOOR);
    for (const c of floor) expect(c).toBeCloseTo(118 * 0.9, 10);
    expect(LIQUID_ACTIVE_FLOOR).toEqual(LIQUID_MEASURED.active.overBlack);
  });

  it("Windows blur's floor is the desktop app's own bottle-green tint over black, worked out rather than rounded", () => {
    // desktop/src-tauri/src/main.rs: GLASS_TINT = Color(15, 55, 43, 140).
    expect(GLASS_TINT_ALPHA).toBeCloseTo(140 / 255, 10);
    expect(TINTED_FLOOR).toEqual(mix(VEIL, [0, 0, 0], GLASS_TINT_ALPHA));
    expect(glassFloor("blur", "light")).toEqual(TINTED_FLOOR);
    const rust = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "src", "main.rs"), "utf8");
    const tint = /const GLASS_TINT: Color = Color\((\d+), (\d+), (\d+), (\d+)\);/.exec(rust)!.slice(1).map(Number);
    expect(tint).toEqual([...VEIL, Math.round(GLASS_TINT_ALPHA * 255)]);
  });

  it("the glasses nobody has measured and a dark setting have a black floor", () => {
    for (const glass of ["acrylic", "mica", "vibrancy"] as const) expect(glassFloor(glass, "light")).toEqual([0, 0, 0]);
    for (const glass of GLASSES) expect(glassFloor(glass, "dark")).toEqual([0, 0, 0]);
  });

  it("every glass is checked over white and over its floor; Liquid Glass in the light setting over every measured point too", () => {
    expect(glassChecks("liquid", "light").map((c) => c.behind)).toEqual([WHITE, LIQUID_FLOOR, [180, 171, 148], [118, 118, 118], [249, 248, 245], [225, 225, 225]]);
    expect(glassChecks("liquid", "dark").map((c) => c.behind)).toEqual([WHITE, [0, 0, 0]]);
    expect(glassChecks("acrylic", "light").map((c) => c.behind)).toEqual([WHITE, [0, 0, 0]]);
    expect(glassChecks("blur", "light").map((c) => c.behind)).toEqual([WHITE, TINTED_FLOOR]);
  });
});

describe("the text colours", () => {
  it("one text set everywhere (ADR-45): every text colour is bone or lighter, and the window look uses the same set", () => {
    for (const c of TEXT_COLOURS) expect(luminance(c)).toBeGreaterThanOrEqual(luminance(BONE) - 1e-9);
    expect(WINDOW_TEXT_TOKENS).toEqual(TEXT_TOKENS);
    expect(TEXT_TOKENS).toEqual({ "--ink": "#efe7da", "--ink-2": "#efe7da", "--ink-3": "#efe7da", "--vermilion-ink": "#ffe2dc", "--green-ink": "#e4f2da", "--green-text": "#e4f2da" });
    expect(TEXT_COLOURS_WINDOW).toHaveLength(Object.keys(TEXT_TOKENS).length);
    expect(TEXT_COLOURS).toHaveLength(Object.keys(TEXT_TOKENS).length);
  });

  it("each stays its own colour: the vermilion words lean red, the green words lean green", () => {
    for (const set of [TEXT_TOKENS, WINDOW_TEXT_TOKENS]) {
      const [r, g] = hexToRgb(set["--vermilion-ink"]);
      expect(r - g).toBeGreaterThan(20);
      const [gr, gg, gb] = hexToRgb(set["--green-ink"]);
      expect(gg).toBeGreaterThan(gr);
      expect(gg).toBeGreaterThan(gb);
    }
  });
});

describe("see-through veil", () => {
  it("Clear: nothing between the panels; a panel carries the least green that keeps every text colour at AA over white", () => {
    for (const glass of GLASSES)
      for (const scheme of SCHEMES) {
        const v = seeThroughVeils(glass, scheme, "clear");
        const least = minVeil(glassCeiling(glass, scheme), TEXT_COLOURS_WINDOW);
        expect(v.page, `${glass} ${scheme}`).toBe(0);
        expect(v.panel, `${glass} ${scheme}`).toBe(Math.max(PANEL_VEIL_FLOOR, least));
        // The least really is the least: one step lighter and a text colour drops under AA.
        expect(worstInWindow(mix(VEIL, WHITE, least - 0.01)), `${glass} ${scheme}`).toBeLessThan(AA);
      }
    expect(seeThroughVeils("liquid", "light", "clear").panel).toBe(0.73);
    expect(PANEL_VEIL_FLOOR).toBe(0.2);
    // The window's glass is behind the page: no web brightness() dims it, so a pane is planned for white as it is.
    expect(WINDOW_BRIGHTNESS).toBe(1);
    for (const glass of GLASSES) for (const scheme of SCHEMES) for (const strength of STRENGTHS) expect(windowGlass(glass, scheme, strength)).toMatchObject({ brightness: 1, plateVeil: windowPlateVeil(glass, scheme, strength) });
  });

  it("a window plate carries the green its words need in its top light, the pay included: AA there, and one step less would not hold", () => {
    // A plate's words start about 6 px down (a display face's glyph box, the top bar's Live chip): half the top light
    // and a quarter of the catch light still lie there. The window look's pay covers it: the plates are the panels'.
    expect(PLATE_WORDS_LIGHT).toBeCloseTo(1 - (1 - PANEL_LIGHT / 2) * (1 - SPECULAR / 4), 10);
    expect([windowPlateVeil("liquid", "light", "clear"), windowPlateVeil("liquid", "light", "frosted")]).toEqual([0.73, 0.62]);
    for (const glass of GLASSES)
      for (const scheme of SCHEMES)
        for (const strength of STRENGTHS) {
          const v = seeThroughVeils(glass, scheme, strength);
          const plate = windowPlateVeil(glass, scheme, strength);
          const pay = lightPay({ kind: "window", ...windowGlass(glass, scheme, strength) });
          const under = mix(VEIL, WHITE, v.page);
          expect(plate, `${glass} ${scheme} ${strength}`).toBeGreaterThanOrEqual(v.panel);
          expect(worstInWindow(lit(under, plate + pay, PLATE_WORDS_LIGHT)), `${glass} ${scheme} ${strength}`).toBeGreaterThanOrEqual(AA);
          if (plate > v.panel) expect(worstInWindow(lit(under, plate - 0.01 + pay, PLATE_WORDS_LIGHT)), `${glass} ${scheme} ${strength}`).toBeLessThan(AA);
        }
  });

  it("the Live chip and \"All set!\" (small words in their top light) carry the plate's tint, and keep AA in every look", () => {
    // glass.css gives them the plate tint in every look; they are panes, so their own filter dims under it where the
    // look dims (the app's own backdrop, the picture, the light colours).
    expect(rules("glass.css")).toMatch(/\nhtml :is\(\.topbar \.live-dot, \.setup-todo--done\[data-mode="pill"\]\) \{\s*--glass-tint: var\(--glass-tint-plate\);/);
    const checks: [string, LightLook, Rgb[]][] = [
      ["the app's own backdrop", { kind: "frosted", ...BRAND_GLASS }, brandMeshSpots()],
      ["a photo", { kind: "picture", ...PICTURE_GLASS }, [WHITE, saturateRgb(WHITE, GLASS_SATURATE_MAX)]],
      ...SWATCH_MIXES.map((cs) => [`colours ${cs.join(" ")}`, { kind: "colours", ...coloursVeils(cs), colours: cs }, coloursMeshSpots(cs)] as [string, LightLook, Rgb[]]),
    ];
    const low: string[] = [];
    for (const [name, look, spots] of checks) {
      const pay = lightPay(look);
      for (const spot of spots) if (worst(lit(underGlass(look, spot), look.plateVeil + platePay(pay), PLATE_WORDS_LIGHT)) < AA) low.push(`${name} over ${spot.map(Math.round)}`);
    }
    expect(low).toEqual([]);
  }, 60_000);

  it("Frosted: a green frost everywhere, and panels the least that keeps AA over it and still shows less than Clear", () => {
    for (const glass of GLASSES)
      for (const scheme of SCHEMES) {
        const at = `${glass} ${scheme}`;
        const clear = seeThroughVeils(glass, scheme, "clear");
        const frosted = seeThroughVeils(glass, scheme, "frosted");
        const frost = mix(VEIL, glassCeiling(glass, scheme), frosted.page);
        expect(frosted.page, at).toBe(0.3);
        expect(worstInWindow(mix(VEIL, frost, frosted.panel)), at).toBeGreaterThanOrEqual(AA);
        expect((1 - frosted.page) * (1 - frosted.panel), at).toBeLessThan((1 - clear.page) * (1 - clear.panel));
        // The least: 0.01 less drops a text colour under AA over the frost, or shows as much as Clear.
        const less = Math.round((frosted.panel - 0.01) * 100) / 100;
        expect(worstInWindow(mix(VEIL, frost, less)) < AA || (1 - frosted.page) * (1 - less) >= 1 - clear.panel, at).toBe(true);
      }
    // AA over the frost on white needs 0.61; showing less than a 0.73 Clear panel needs more than 0.614.
    expect(seeThroughVeils("liquid", "light", "frosted")).toEqual({ page: 0.3, panel: 0.62 });
  });

  it("every text colour of the window look reaches AA on a panel: every glass, setting and strength, over white, its floor and every measured point", () => {
    expect(EVERY_LOOK.length).toBe(GLASSES.length * 2 * 2 * 2 + 4 * 2);
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK) expect(worstInWindow(seeThroughWorstBackground(glass, scheme, strength, check.behind)), at).toBeGreaterThanOrEqual(AA);
  });

  it("the selected (bone) pill's green words reach AA wherever the pill sits", () => {
    expect(SELECTED_ALPHA).toBe(0.92);
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK) expect(contrast(ON_BONE, seeThroughSelectedBackground(glass, scheme, strength, check.behind)), at).toBeGreaterThanOrEqual(AA);
    expect(rules("tokens.css")).toContain(`--selected: rgb(var(--bone-rgb) / ${SELECTED_ALPHA});`);
  });

  it("a pick-one track's labels reach AA on its bone lift, even when the track sits straight on the window", () => {
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK) expect(worstInWindow(seeThroughTrackBackground(glass, scheme, strength, check.behind)), at).toBeGreaterThanOrEqual(AA);
    // glass.css lays the raise's two numbers, in every look: straight on the page they are the track's (tokens.css
    // :root), inside a lit surface the relative raise (checked under the logic of light).
    const track = /\n:is\(\.segmented, \.tabs, \.bg-modes, \.model-picks\) \{([^}]*)\}/.exec(rules("glass.css"))![1]!;
    expect(track).toContain("background-color: rgb(var(--green-rgb) / min(1, var(--light-raise-veil)));");
    expect(track).toContain("background-image: linear-gradient(rgb(var(--bone-rgb) / var(--light-raise-lift)), rgb(var(--bone-rgb) / var(--light-raise-lift)));");
    expect(track).toContain("box-shadow: var(--light-rim-2), var(--light-shade-2);");
    // Straight on the page a track draws no filter, so nothing dims the backdrop under it: the plate veil carries it.
    const root = declared(block(rules("tokens.css"), ":root"));
    expect(root.get("--light-raise-veil")).toBe(`calc(var(--plate-veil) + ${TRACK_EXTRA_VEIL})`);
    expect(root.get("--light-raise-lift")).toBe(String(TRACK_LIFT));
  });

  it("words on a tinted chip reach AA: a vermilion or leaf chip lays bottle green under its tint", () => {
    const rgb = (token: TextToken) => hexToRgb(WINDOW_TEXT_TOKENS[token]);
    const tint = (name: string) => CHIP_TINTS.find((t) => t.name === name)!;
    const CHIPS: { name: string; tint: Rgb; alpha: number; lift: number; texts: readonly Rgb[] }[] = [
      { name: "the vermilion tint (pills, the error sound, callouts)", tint: tint("vermilion").colour, alpha: 0.2, lift: tint("vermilion").lift, texts: [rgb("--vermilion-ink"), rgb("--ink")] },
      { name: "the success tint (pills, the tap sound, guesses)", tint: tint("leaf").colour, alpha: 0.22, lift: tint("leaf").lift, texts: [rgb("--green-text"), rgb("--green-ink"), rgb("--ink")] },
    ];
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK)
      for (const chip of CHIPS) {
        const bg = seeThroughChipBackground(glass, scheme, strength, chip.tint, chip.alpha, check.behind, chip.lift);
        for (const t of chip.texts) expect(contrast(t, bg), `${chip.name}, ${at}`).toBeGreaterThanOrEqual(AA);
      }
    expect(CHIP_TINTS.map((t) => [t.name, t.alpha])).toEqual([["leaf", 0.22], ["vermilion", 0.2], ["amber", 0.16]]);
    // A chip on a row is a level of its own: a whole step of light over the row, in every look (its colour still reads).
    const fails: string[] = [];
    for (const p of LIGHT_PLACES) {
      const e1 = panelWords(p.look, p.behind, false, p.pay);
      for (const row of [raised(e1), raised(e1, 2), raised(panelWords(p.look, p.behind, true, p.pay))])
        for (const t of CHIP_TINTS) {
          const chip = chipOn(row, t);
          if (oklabL(chip) - oklabL(row) < (noRoom(row) ? -LADDER_SLACK : LADDER_STEP) && fails.length < 20) fails.push(`${t.name}: ${(oklabL(chip) - oklabL(row)).toFixed(4)}, ${p.at}`);
        }
    }
    expect(fails).toEqual([]);
    // tokens.css uses the same numbers: bottle green (CHIP_UNDER) under the tint, the bone lift between them.
    const tokens = rules("tokens.css");
    expect(CHIP_UNDER).toEqual(VEIL);
    expect(GREEN_DEEP).toEqual(hexToRgb("#0a2820"));
    const lift = (name: string) => `linear-gradient(rgb(var(--bone-rgb) / ${tint(name).lift}), rgb(var(--bone-rgb) / ${tint(name).lift}))`;
    expect(tokens).toContain(`--tint-leaf: linear-gradient(rgb(var(--green-leaf-rgb) / 0.22), rgb(var(--green-leaf-rgb) / 0.22)), ${lift("leaf")}, rgb(var(--green-rgb) / ${CHIP_DEEPEN});`);
    expect(tokens).toContain(`--tint-vermilion: linear-gradient(rgb(var(--vermilion-rgb) / 0.2), rgb(var(--vermilion-rgb) / 0.2)), ${lift("vermilion")}, rgb(var(--green-rgb) / ${CHIP_DEEPEN});`);
    expect(tokens).toContain(`--tint-amber: linear-gradient(rgb(246 201 69 / 0.16), rgb(246 201 69 / 0.16)), ${lift("amber")}, rgb(var(--green-rgb) / ${CHIP_DEEPEN});`);
  }, 60_000);

  it("the picture look: no veil over the photo; panes dim a white photo to half and carry what is left, plates what it needs as it is", () => {
    expect([PICTURE_PAGE_VEIL, PICTURE_PANEL_VEIL, PICTURE_PLATE_VEIL, PICTURE_BRIGHTNESS]).toEqual([0, 0.29, 0.73, MIN_GLASS_BRIGHTNESS]);
    expect(PICTURE_GLASS).toEqual({ pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL, plateVeil: PICTURE_PLATE_VEIL, brightness: PICTURE_BRIGHTNESS });
    // The pair that shows the most of a white photo, the pay on top.
    expect(bestGlass([WHITE, saturateRgb(WHITE, GLASS_SATURATE_MAX)], MAX_LIGHT_PAY)).toEqual({ panelVeil: PICTURE_PANEL_VEIL, brightness: PICTURE_BRIGHTNESS });
    // 30.5 % of the photo shows through a pane (0.29 + 0.10 at 0.5: a pane dimmed to half pays MAX_LIGHT_PAY / 0.5,
    // mostPay, so the levels on it still climb); main's 0.73 + 0.05 with no dimming showed 22 %.
    expect(showThrough(PICTURE_PANEL_VEIL, PICTURE_BRIGHTNESS, lightPay({ kind: "picture", ...PICTURE_GLASS }))).toBeCloseTo(0.305, 10);
    expect(showThrough(PICTURE_PANEL_VEIL, PICTURE_BRIGHTNESS, lightPay({ kind: "picture", ...PICTURE_GLASS }))).toBeGreaterThan(showThrough(0.73, 1, LIGHT_PAY_WHITE) + 0.08);
    // A pane: a white photo as its glass sees it (dimmed), and 0.01 less is under AA there.
    const seen = dimRgb(WHITE, PICTURE_BRIGHTNESS);
    expect(PICTURE_PANEL_VEIL).toBe(minVeil(seen));
    expect(worst(mix(VEIL, seen, PICTURE_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
    expect(worst(mix(VEIL, seen, PICTURE_PANEL_VEIL - 0.01))).toBeLessThan(AA);
    // A plate (no filter of its own): a white photo as it is.
    expect(PICTURE_PLATE_VEIL).toBe(minVeil(WHITE));
    expect(worst(mix(VEIL, mix(VEIL, WHITE, PICTURE_PAGE_VEIL), PICTURE_PLATE_VEIL))).toBeGreaterThanOrEqual(AA);
    // backdrop-filter saturate() cannot lighten white.
    expect(worst(mix(VEIL, dimRgb(saturateRgb(WHITE, GLASS_SATURATE_MAX), PICTURE_BRIGHTNESS), PICTURE_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
  });

  it("brightness() is modelled as browsers draw it: in sRGB, each channel × b, and what shows is (1 − veil) × b", () => {
    expect(dimRgb(WHITE, 1)).toEqual(WHITE);
    for (const c of [WHITE, hexToRgb("#e8392b"), hexToRgb("#7fd8be"), BRAND_MESH.field[0]!, [0, 0, 0] as Rgb])
      for (const b of [0.5, 0.73, 0.9]) expect(dimRgb(c, b)).toEqual(c.map((v) => v * b));
    // Measured in Chromium (23 Nov): a black and white edge behind a 0.20 pane at brightness(0.73) reads 0.584 through
    // it, against 0.671 behind main's 0.33 with no dimming. Dimming is not free see-through.
    expect(showThrough(0.2, 0.73)).toBeCloseTo(0.584, 10);
    expect(showThrough(0.33)).toBeCloseTo(0.67, 10);
    expect(showThrough(0.2, 1, 0.05, 0.3)).toBeCloseTo(0.7 * 0.75, 10);
    expect(showThrough(0.9, 1, 0.2)).toBe(0);
  });
});

describe("the stylesheets and the text colour list stay in step", () => {
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, rules(f)] as const);

  it("tokens.css has every text colour with the same value", () => {
    const root = declared(block(rules("tokens.css"), ":root"));
    for (const [token, value] of Object.entries(TEXT_TOKENS)) expect(root.get(token), token).toBe(value);
  });

  it("tokens.css has no text colours of its own for the window look any more: one set everywhere", () => {
    expect(rules("tokens.css")).not.toMatch(/html\.see-through\s*\{/);
    const unused: TextToken[] = (Object.keys(TEXT_TOKENS) as TextToken[]).filter((t) => WINDOW_TEXT_TOKENS[t] !== TEXT_TOKENS[t]);
    expect(unused).toEqual([]);
  });

  /**
   * Text colours that are not in the list, each with the reason it never sits on a bare panel tint. A colour that is
   * not a token and not named here fails the test below.
   */
  const NOT_ON_A_PANEL_TINT: Record<string, string> = {
    "#fff": "white words on a vermilion CTA, badge or count fill of their own, and the workspace switch's hovered names on its own smoked clear glass (lighter than bone, so never less contrast; test/switchGlass.test.ts)",
    "#141414": "the workspace switch's chosen name, near-black words on its own near-white clear lens (white 0.86 over the smoked track: AA over anything behind it; test/switchGlass.test.ts)",
    "var(--on-bone)": "green words on a bone fill of their own (the selected pill, inverted chips, the tooltip)",
    "var(--green-deep)": "deep green words on a solid leaf fill of their own",
    "#0a64d8": "Safari's blue in the Get the app drawings, on their own bone card",
    "#ffeec4": "the warn pill's words, on the fill and amber ring of their own",
    "var(--placeholder)": "hint text in an empty field, faded on purpose: 3:1 on the lightest field (checked in styleFloors)",
    inherit: "takes the colour around it",
    "var(--kind-text)": "a sound group's tint colour: --green-text or --vermilion-ink (checked below)",
    "var(--kind-on)": "words on a sound group's own solid fill (checked below)",
    "var(--act-tint)": "a button's glyph, for a blink of its action",
    "var(--green-leaf)": "a button's glyph, for a blink of its action",
    "var(--vermilion-light)": "the error toast's icon, a mark rather than words",
    "rgb(255 255 255 / 0.7)": "a CTA that is off: on its own thin vermilion over deep green (checked below)",
    "var(--ws-mark-letter, #2a160b)": "the Clips Funded mark's espresso C, on the cream tile of its own (checked below)",
    "var(--ws-wordmark, #fff6ea)": "the Clips Funded wordmark, only in Clips Funded's own rail and top bar, on its own dark stage (checked below)",
  };

  it("a CTA that is off keeps its label above 3:1 on any panel, and is not brown", () => {
    const off = (panel: Rgb) => mix(hexToRgb("#e8392b"), mix(GREEN_DEEP, panel, 0.6), 0.35);
    for (const behind of [WHITE, [0, 0, 0] as Rgb]) {
      const panel = mix(VEIL, behind, PANEL_VEIL_FLOOR);
      const fill = off(panel);
      expect(contrast(mix(WHITE, fill, 0.7), fill)).toBeGreaterThanOrEqual(3);
    }
    for (const sheet of ["components.css", "setup.css"]) {
      expect(rules(sheet)).toContain("linear-gradient(rgb(var(--vermilion-rgb) / 0.35), rgb(var(--vermilion-rgb) / 0.35)),\n    rgb(var(--green-deep-rgb) / 0.6)");
    }
  });

  it("the Clips Funded mark's C and wordmark pass AA on their own tile, stage and rail", () => {
    // Clips Funded's warm logo everywhere (the owner, 23 Nov): the espresso C on the cream tile, at both ends of its
    // gradient, and the cream wordmark.
    const mark = rules("ws-mark.css");
    expect(mark).toContain("background: var(--ws-mark-tile, linear-gradient(150deg, #fff3e4, #f2dcc2))");
    expect(mark).toContain("color: var(--ws-mark-letter, #2a160b)");
    expect(mark).toContain("color: var(--ws-wordmark, #fff6ea)");
    for (const tile of ["#fff3e4", "#f2dcc2"]) expect(contrast(hexToRgb("#2a160b"), hexToRgb(tile)), tile).toBeGreaterThanOrEqual(AA);
    // A dark stage (its top bar) and the lightest of a rail's fill, as before; and Clips Funded's espresso stage.
    for (const under of [hexToRgb("#1c1842"), [50, 42, 115] as Rgb, hexToRgb("#1c130e")]) expect(contrast(hexToRgb("#fff6ea"), under)).toBeGreaterThanOrEqual(AA);
  });

  it("every text colour in every stylesheet is a token of the list, or a named exception", () => {
    const tokens = new Set(Object.keys(TEXT_TOKENS).map((t) => `var(${t})`));
    const unknown: string[] = [];
    let seen = 0;
    for (const [file, text] of sheets)
      for (const m of text.matchAll(/(?<![-\w])color:\s*([^;}]+)/g)) {
        seen++;
        const value = m[1]!.trim();
        if (!tokens.has(value) && !(value in NOT_ON_A_PANEL_TINT)) unknown.push(`${file}: color: ${value}`);
      }
    expect(seen).toBeGreaterThan(250);
    expect(unknown).toEqual([]);
    // No stale exception either.
    const used = new Set(sheets.flatMap(([, text]) => [...text.matchAll(/(?<![-\w])color:\s*([^;}]+)/g)].map((m) => m[1]!.trim())));
    expect(Object.keys(NOT_ON_A_PANEL_TINT).filter((v) => !used.has(v))).toEqual([]);
  });

  it("the sound groups' own colours are text colours of the list, on fills they pass on", () => {
    const settings = rules("settings.css");
    const tap = declared(block(settings, ".sound-group.is-tap"));
    const deny = declared(block(settings, ".sound-group.is-deny"));
    expect([tap.get("--kind-text"), deny.get("--kind-text")]).toEqual(["var(--green-text)", "var(--vermilion-ink)"]);
    expect([tap.get("--kind"), tap.get("--kind-on")]).toEqual(["var(--green-leaf)", "var(--green-deep)"]);
    expect(contrast(hexToRgb("#0a2820"), hexToRgb("#5fa585"))).toBeGreaterThanOrEqual(AA);
    expect([deny.get("--kind"), deny.get("--kind-on")]).toEqual(["var(--vermilion-deep)", "#fff"]);
    expect(contrast(WHITE, hexToRgb("#c42a1e"))).toBeGreaterThanOrEqual(AA);
  });

  const ROOT = declared(block(rules("tokens.css"), ":root"));
  const tokenValue = (name: string) => Number(ROOT.get(name));
  /** The most green a look can need under a panel (Clear over white): what a tint that follows `--panel-veil` is read at. */
  const most = Math.max(...GLASSES.flatMap((g) => SCHEMES.map((sc) => seeThroughVeils(g, sc, "clear").panel)));
  /** `a + b`, `a * b` and `a - b` of plain numbers, as calc() works them out. */
  const arith = (e: string) =>
    e
      .replace(/\s-\s/g, " + -1 * ")
      .split("+")
      .reduce((sum, term) => sum + term.split("*").reduce((p, f) => p * Number(f.trim()), 1), 0);
  /**
   * A tint with the tokens.css per-level tints (`var(--glass-tint-*)`) put in, every number token in, and calc(),
   * min() and max() worked out. `--panel-veil` and `--plate-veil` are read at the most a look can need and
   * `--light-pay` where white can be behind (LIGHT_PAY_WHITE), so a tint that follows them is held where the window
   * look holds it.
   */
  const resolveTint = (tint: string) => {
    let t = tint;
    for (let i = 0; i < 4; i++) t = t.replace(/var\((--glass-tint-[a-z]+)\)/g, (_, n: string) => ROOT.get(n) ?? `var(${n})`);
    t = t.replace(/var\((--[a-z0-9-]+)\)/g, (whole, n: string) => {
      if (n === "--panel-veil" || n === "--plate-veil") return String(most);
      if (n === "--light-pay") return String(LIGHT_PAY_WHITE);
      const v = ROOT.get(n);
      return v !== undefined && /^[\d.]+$/.test(v) ? v : whole;
    });
    for (let i = 0; i < 8; i++)
      t = t.replace(/(calc|min|max)\(([\d.\s,+*-]+)\)/g, (_, f: string, args: string) => {
        const xs = args.split(",").map(arith);
        return String(f === "min" ? Math.min(...xs) : f === "max" ? Math.max(...xs) : xs[0]!);
      });
    return t;
  };
  /** A tint's alphas, worked out (`resolveTint`). */
  const tintAlphas = (tint: string) => [...resolveTint(tint).matchAll(/\/\s*([\d.]+)\)/g)].map((a) => Number(a[1]));

  it("a tint that uses the per-level tokens is read the way the browser works it out", () => {
    expect(resolveTint("var(--glass-tint-float)")).toBe(`linear-gradient(rgb(var(--green-rgb) / ${Math.min(1, Math.max(FLOAT_VEIL, most) + FLOAT_EXTRA_VEIL)}), rgb(var(--green-rgb) / ${Math.min(1, Math.max(FLOAT_VEIL, most) + FLOAT_EXTRA_VEIL)}))`);
    expect(tintAlphas("var(--glass-tint-panel)")).toEqual([most + LIGHT_PAY_WHITE, most + LIGHT_PAY_WHITE]);
    expect(tintAlphas("var(--glass-tint-plate)")).toEqual([most + LIGHT_PAY_WHITE, most + LIGHT_PAY_WHITE]);
    expect(tintAlphas("var(--glass-tint-tabbar)").map((a) => a.toFixed(4))).toEqual([TABBAR_VEIL + TABBAR_EXTRA_VEIL, TABBAR_VEIL + TABBAR_EXTRA_VEIL].map((a) => a.toFixed(4)));
    expect(tintAlphas("var(--glass-tint-overlay)")).toEqual([SHEET_VEIL, SHEET_VEIL]);
    expect(tintAlphas("linear-gradient(140deg, rgb(var(--green-rgb) / calc(var(--float-veil) + 0.02)), rgb(var(--green-rgb) / var(--float-veil)))").map((a) => a.toFixed(4))).toEqual(["0.7500", "0.7300"]);
  });

  it("the panel tint of the window look gives way to a surface's own denser tint, and never to a weaker one", () => {
    const glass = rules("glass.css");
    // As light as `.glass` itself (:where), so `.toast`, `.sheet.glass`, `.help-panel` and `.star-btn.is-on` keep theirs.
    // The lead panel keeps its own step there too (:where(), so the exclusion weighs nothing).
    expect(glass).toMatch(/:where\(html\.see-through\) :is\(\.glass, \.glass--clear\):where\(:not\(\.glass--green\)\) \{\s*--glass-tint: var\(--glass-tint-panel\);/);
    expect(glass).not.toMatch(/html\.see-through \.glass[\s,{]/);
    expect(glass).not.toMatch(/html\.see-through \.glass--green/);
    // Every surface with a green tint of its own is at least as strong as the most any glass needs for AA (Clear over
    // white), or is lifted to the panel tint by its own window-look rule. Surfaces that take --panel-veil follow it.
    const lifted: string[] = [];
    for (const [file, text] of sheets) {
      if (file === "glass.css") continue;
      for (const m of text.matchAll(/([^{}]+)\{[^{}]*--glass-tint:\s*([^;]+);/g)) {
        const selector = m[1]!.trim();
        if (m[2]!.trim() === "var(--cta)") continue;
        const alphas = tintAlphas(m[2]!);
        expect(alphas.length, `${file} ${selector}`).toBeGreaterThanOrEqual(2);
        expect(resolveTint(m[2]!), `${file} ${selector}: a surface tint is bottle green`).toMatch(/var\(--green-rgb\)/);
        if (Math.min(...alphas) >= most - 1e-9) continue;
        lifted.push(selector);
        expect(glass, `${file} ${selector}: weaker than a panel can need (${most}), so it needs a rule in the window look`).toContain(`html.see-through ${selector} {`);
      }
    }
    expect(lifted).toEqual([".tabbar"]);
  });

  it("layers that content scrolls under plan for white: the floating tint, the tab bar's 3:1 and the question sheet", () => {
    expect(FLOAT_VEIL).toBe(0.73);
    expect(TABBAR_VEIL).toBe(0.59);
    expect(SHEET_VEIL).toBe(0.86);
    expect(tokenValue("--float-veil")).toBe(FLOAT_VEIL);
    expect(tokenValue("--tabbar-veil")).toBe(TABBAR_VEIL);
    expect(worst(mix(VEIL, WHITE, FLOAT_VEIL))).toBeGreaterThanOrEqual(AA);
    expect(worst(mix(VEIL, WHITE, FLOAT_VEIL - 0.01))).toBeLessThan(AA);
    expect(Math.min(...TEXT_COLOURS.map((t) => contrast(t, mix(VEIL, WHITE, TABBAR_VEIL))))).toBeGreaterThanOrEqual(3);
    // The tab bar's chosen icon sits on the bone glide.
    expect(contrast(ON_BONE, mix(BONE, mix(VEIL, WHITE, TABBAR_VEIL), SELECTED_ALPHA))).toBeGreaterThanOrEqual(AA);
    // A tab's hover (layout.css) is bone alone over the bar: it adds light over a white thumbnail and over black, and
    // the icons keep 3:1 at the bar's lit top over white.
    const layoutCss = readFileSync(join(STYLES, "layout.css"), "utf8");
    const tabHover = Number(/\.tabbar \.tabbar__item:not\(\.is-active\):hover \{\s*background: linear-gradient\(rgb\(var\(--bone-rgb\) \/ ([\d.]+)\)/.exec(layoutCss)?.[1]);
    expect(tabHover).toBeGreaterThan(0);
    for (const behind of [WHITE, [0, 0, 0]] as Rgb[]) {
      const bar = lit(behind, TABBAR_VEIL + TABBAR_EXTRA_VEIL, TABBAR_LIGHT);
      const hover = mix(BONE, bar, tabHover);
      expect(oklabL(hover) - oklabL(bar), "a tab's hover adds light").toBeGreaterThanOrEqual(LADDER_STEP);
      expect(Math.min(...TEXT_COLOURS.map((t) => contrast(t, hover))), "tab icons on hover").toBeGreaterThanOrEqual(3);
    }
    const FLOATING: [string, string][] = [
      ["components.css", ".toast"],
      ["system.css", ".update-bar"],
      ["setup-todo.css", ".setup-todo__pill"],
      ["setup-todo.css", ".setup-todo__pill:hover"],
      ["setup-todo.css", ".setup-todo--rail"],
      ["setup-todo.css", ".setup-todo-panel"],
      ["help.css", ".help-panel"],
      ["help.css", ".help-panel.is-sheet"],
      ["setup.css", ".tt-sheet"],
    ];
    for (const [file, selector] of FLOATING) {
      // The rule for this selector that sets the tint (a selector can have more than one rule).
      const body = [...rules(file).matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector && /--glass-tint/.test(m[2]!))?.[2] ?? "";
      const tint = declared(body).get("--glass-tint");
      expect(tint, `${file} ${selector}`).toBeDefined();
      expect(Math.min(...tintAlphas(tint!)), `${file} ${selector}`).toBeGreaterThanOrEqual(FLOAT_VEIL - 1e-9);
      expect(declared(body).get("--glass-blur") ?? "28px", `${file} ${selector}`).toBe("28px");
      // Planned for white as it is, so its filter dims nothing (the look's brightness() is a pane's).
      expect(declared(body).get("--glass-brightness"), `${file} ${selector}`).toBe("1");
    }
    expect(declared(block(rules("settings.css"), ".sheet.glass")).get("--glass-brightness")).toBe("1");
    expect(declared(block(rules("layout.css"), ".tabbar")).get("--glass-brightness")).toBe("1");
    const sheet = declared(block(rules("settings.css"), ".sheet.glass")).get("--glass-tint")!;
    expect(Math.min(...tintAlphas(sheet))).toBeGreaterThanOrEqual(SHEET_VEIL);
    const tabbar = declared(block(rules("layout.css"), ".tabbar")).get("--glass-tint")!;
    expect(Math.min(...tintAlphas(tabbar))).toBeGreaterThanOrEqual(TABBAR_VEIL);
  });
});

describe("colours", () => {
  it("accepts 1 to 3 distinct #rrggbb colours, lower case", () => {
    expect(normaliseColours(["#F6C945", "#f6c945", "#2B6CB0"])).toEqual(["#f6c945", "#2b6cb0"]);
    expect(normaliseColours(["#111111", "#222222", "#333333", "#444444"])).toHaveLength(3);
    expect(normaliseColours(["red", 3, null, "#12345"])).toEqual([...DEFAULT_COLOURS]);
    expect(normaliseColours(undefined)).toEqual([...DEFAULT_COLOURS]);
    expect(isHexColour("#0f372b")).toBe(true);
    expect(isHexColour("0f372b")).toBe(false);
  });

  it("every swatch is a valid colour with a name, and the defaults are the Clip Factory colours", () => {
    expect(SWATCHES.every((s) => isHexColour(s.hex) && s.name.length > 0)).toBe(true);
    expect(DEFAULT_COLOURS).toEqual(["#0f372b", "#efe7da", "#e8392b"]);
    expect(SWATCHES.slice(0, 3).map((s) => s.name)).toEqual(["Bottle green", "Bone", "Vermilion"]);
    expect(SWATCHES.slice(0, 3).map((s) => s.hex)).toEqual([...DEFAULT_COLOURS]);
  });

  it("the colours mesh is worked out as glass.css draws it: the second colour at 30 %, the third at 45 %, opacity 1", () => {
    const glass = rules("glass.css");
    expect(COLOURS_BLOB_ALPHA).toEqual({ second: 0.3, third: 0.45 });
    expect(glass).toContain(`color-mix(in srgb, var(--c2) ${COLOURS_BLOB_ALPHA.second * 100}%, transparent)`);
    expect(glass).toContain(`color-mix(in srgb, var(--c3) ${COLOURS_BLOB_ALPHA.third * 100}%, transparent)`);
    expect(glass).toContain(`color-mix(in srgb, var(--c1) ${100 - COLOURS_FIELD_END * 100}%, var(--c3))`);
    expect(glass).toMatch(/\.backdrop--colours :is\(\.blob--d, \.blob--e\) \{\s*display: none;/);
    expect(glass).toMatch(/\n\.blob \{[^}]*opacity: 1;/);
  });

  it("the glass takes the veil and dimming that show the most of the mesh, and the veils keep every text colour at AA over the lightest spot", () => {
    // [colours, page veil, panel veil, plate veil, brightness, what shows through a pane with the pay]. Before: page
    // 0 / 0.03 / 0.08 / 0.28 / 0.33 and panels 0.30 / 0.30 / 0.60 / 0.60 / 0.60 / 0.60 with no dimming (a pane
    // showed 65 % of the default colours, 25 % of cream, 23 % of white). Dark colours take no dimming at all. The glass
    // is chosen with an undimmed surface's pay (MAX_LIGHT_PAY); a dimmed pane then pays MAX_LIGHT_PAY / b (mostPay,
    // rounded down: the pay takes no more than 0.05 of what shows): 0.08 at 0.62 and 0.58, 0.10 at 0.5.
    const TABLE: [string[], number, number, number, number, number][] = [
      [[...DEFAULT_COLOURS], 0, 0.2, 0.24, 1, 0.75],
      [["#2b6cb0", "#8e6cc9"], 0, 0.2, 0.25, 0.97, 0.7275],
      [["#9caf88", "#f7f5ef", "#e8412c"], 0, 0.2, 0.61, 0.62, 0.4464],
      [["#f6c945", "#f49ac1"], 0, 0.21, 0.63, 0.58, 0.4118],
      [["#f7f5ef"], 0, 0.24, 0.71, 0.5, 0.33],
      [["#ffffff"], 0, 0.29, 0.73, 0.5, 0.305],
    ];
    for (const [cs, page, panel, plate, brightness, shows] of TABLE) {
      const at = cs.join(" ");
      expect(coloursVeils(cs), at).toEqual({ pageVeil: page, panelVeil: panel, plateVeil: plate, brightness });
      expect(bestGlass(coloursMeshSpots(cs), MAX_LIGHT_PAY), at).toEqual({ panelVeil: panel, brightness });
      expect(showThrough(panel, brightness, lightPay({ kind: "colours", ...coloursVeils(cs), colours: cs }), page), at).toBeCloseTo(shows, 4);
      // No other dimming (every 0.01) shows more with the veil it needs.
      for (let step = 50; step <= 100; step++)
        expect(showThrough(veilOver(coloursMeshSpots(cs).map((s) => dimRgb(s, step / 100))), step / 100, MAX_LIGHT_PAY), `${at} at ${step / 100}`).toBeLessThanOrEqual(showThrough(panel, brightness, MAX_LIGHT_PAY) + 1e-9);
      for (const spot of coloursMeshSpots(cs)) {
        expect(worst(mix(VEIL, dimRgb(mix(VEIL, spot, page), brightness), panel)), at).toBeGreaterThanOrEqual(AA);
        expect(worst(mix(VEIL, mix(VEIL, spot, page), plate)), at).toBeGreaterThanOrEqual(AA);
      }
      expect(luminance(coloursMeshWorst(cs))).toBe(Math.max(...coloursMeshSpots(cs).map(luminance)));
    }
    expect(coloursVeils(DEFAULT_COLOURS)).toEqual({ pageVeil: 0, panelVeil: 0.2, plateVeil: 0.24, brightness: 1 });
    // The deprecated single number is the combined green.
    expect(coloursVeil(["#ffffff"])).toBeCloseTo(0.29, 2);
  });

  it("every mix of 1 to 3 colours from a grid reaches AA, and a panel never carries more than 0.6", () => {
    const grid: string[] = [];
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) grid.push(`#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
    let n = 0;
    const fails: string[] = [];
    for (let i = 0; i < grid.length; i += 3)
      for (let j = 0; j < grid.length; j += 7)
        for (let k = 0; k < grid.length; k += 11) {
          const cs = [...new Set([grid[i]!, grid[j]!, grid[k]!])];
          const v = coloursVeils(cs);
          n++;
          expect(v.panelVeil).toBeLessThanOrEqual(MAX_COLOURS_PANEL_VEIL);
          expect(v.panelVeil).toBeGreaterThanOrEqual(PANEL_VEIL_FLOOR);
          expect(v.brightness).toBeGreaterThanOrEqual(MIN_GLASS_BRIGHTNESS);
          expect(v.brightness).toBeLessThanOrEqual(1);
          // The worst spot as seen bare and through every saturate() the CSS uses: dimmed under a pane, as it is under
          // a plate.
          for (const spot of coloursMeshSpots(cs)) {
            const page = mix(VEIL, spot, v.pageVeil);
            if (worst(mix(VEIL, dimRgb(page, v.brightness), v.panelVeil)) < AA) fails.push(`${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
            if (worst(mix(VEIL, page, v.plateVeil)) < AA) fails.push(`plate: ${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
            // A pick-one track or a control fill straight on the page (no filter: the plate veil).
            if (worst(mix(BONE, mix(VEIL, page, Math.min(1, v.plateVeil + TRACK_EXTRA_VEIL)), TRACK_LIFT)) < AA) fails.push(`track: ${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
            // The lit levels (ADR-87): the top of a panel and of the lead panel, a row on it on hover, the deepest
            // raise on hover, and a control on the page on hover (the tightest of each kind).
            const look: LightLook = { kind: "colours", ...v };
            const e1 = panelWords(look, spot);
            const levels: [string, Rgb][] = [
              ["E1", e1],
              ["the lead panel", panelWords(look, spot, true)],
              ["a plate", plateWords(look, spot)],
              ["E2 hover", raised(e1, 1, "hover")],
              ["E4 hover", raised(e1, 3, "hover")],
              ["a control on the page, hover", onPage(look, spot, "hover")],
            ];
            for (const [name, bg] of levels) if (worst(bg) < AA) fails.push(`${name}: ${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
          }
        }
    expect(n).toBeGreaterThan(40_000);
    expect(fails).toEqual([]);
  }, 120_000);
});

describe("the living backdrop (the web and phone default): its lightest spot decides the panel tint", () => {
  const glass = rules("glass.css");
  const num = (re: RegExp) => Number(re.exec(glass)![1]);

  it("draws exactly the mesh lib/background.ts works out", () => {
    expect(glass).toContain("radial-gradient(120% 90% at 10% 0%, #0f3d31 0%, transparent 60%)");
    expect(glass).toContain("linear-gradient(160deg, #0f3d31 0%, #08221b 50%, #0f3d31 100%)");
    expect(BRAND_MESH.field).toEqual([hexToRgb("#0f3d31"), hexToRgb("#08221b")]);
    const blob = (name: string) => block(glass, `.blob--${name}`);
    const peak = (name: string) => /radial-gradient\(circle[^,]*, rgb\(([^/]+)\/ ([\d.]+)\)/.exec(blob(name))!;
    const VARS: Record<string, string> = { "var(--vermilion-rgb)": "232 57 43", "var(--green-leaf-rgb)": "95 165 133", "var(--bone-rgb)": "239 231 218" };
    for (const b of BRAND_MESH.blobs) {
      const [, colour, alpha] = peak(b.name);
      const rgb = (VARS[colour!.trim()] ?? colour!.trim()).split(/\s+/).map(Number);
      expect(rgb, `blob ${b.name}`).toEqual([...b.colour]);
      expect(Number(alpha), `blob ${b.name}`).toBe(b.alpha);
    }
    expect(glass).toMatch(/\n\.blob \{[^}]*opacity: 1;/);
    // The lenses' bone glow and the caustics' peak.
    expect(num(/0 0 40px 4px rgb\(var\(--bone-rgb\) \/ ([\d.]+)\)/)).toBeLessThanOrEqual(BRAND_MESH.ring);
    expect(num(/\.backdrop__caustic \{[^}]*?radial-gradient\(closest-side, rgb\(var\(--bone-rgb\) \/ ([\d.]+)\)/)).toBe(BRAND_MESH.caustic);
    // The grain over everything: its noise colour, its alpha and its opacity, in overlay.
    const grain = block(glass, ".backdrop__grain");
    expect(grain).toMatch(/mix-blend-mode: overlay;/);
    expect(num(/\.backdrop__grain \{[^}]*?opacity: ([\d.]+);/)).toBe(BRAND_MESH.grain.opacity);
    const matrix = /feColorMatrix values='([^']+)'/.exec(grain)![1]!.trim().split(/\s+/).map(Number);
    expect([matrix[4]! * 255, matrix[9]! * 255, matrix[14]! * 255]).toEqual([...BRAND_MESH.grain.colour]);
    expect(matrix[18]).toBe(BRAND_MESH.grain.alpha);
    expect(matrix.filter((_, i) => i !== 4 && i !== 9 && i !== 14 && i !== 18).every((v) => v === 0)).toBe(true);
    // Backdrop.tsx draws the fifth blob in both meshes.
    const tsx = readFileSync(join(import.meta.dirname, "..", "src", "components", "Backdrop.tsx"), "utf8");
    expect(tsx.match(/className="blob blob--e"/g)).toHaveLength(2);
  });

  it("has no green page veil and no frost for Clear: the colours show at full strength between the panels", () => {
    expect(glass).not.toMatch(/\.backdrop:not\(\.backdrop--window, \.backdrop--colours, \.has-image\)::after \{[^}]*background: rgb\(var\(--green-rgb\)/);
    expect(block(glass, ".backdrop__frost")).toMatch(/background: none;/);
    expect(declared(block(rules("tokens.css"), ":root")).get("--backdrop-veil")).toBe("0");
  });

  it("the worst spot is the lightest of every blob subset over both field ends after saturate(), and the panel tint covers it", () => {
    // Enumerate here too, independently of brandMeshWorst.
    const BONE_ = hexToRgb("#efe7da");
    let worstSpot: Rgb = [0, 0, 0];
    let allStacked: Rgb = [0, 0, 0];
    for (const field of BRAND_MESH.field)
      for (let m = 0; m < 32; m++) {
        let spot: Rgb = field;
        for (const [i, b] of BRAND_MESH.blobs.entries()) if (m & (1 << i)) spot = mix(b.colour, spot, b.alpha);
        spot = mix(BONE_, spot, BRAND_MESH.ring);
        spot = softLightOver(softLightOver(spot, BONE_, BRAND_MESH.caustic), BONE_, BRAND_MESH.caustic);
        spot = overlayOver(spot, BRAND_MESH.grain.colour, BRAND_MESH.grain.opacity * BRAND_MESH.grain.alpha);
        const seen = saturateRgb(spot, GLASS_SATURATE_MAX);
        if (luminance(seen) > luminance(worstSpot)) worstSpot = seen;
        if (m === 31 && luminance(seen) > luminance(allStacked)) allStacked = seen;
      }
    expect(worstSpot).toEqual(brandMeshWorst(GLASS_SATURATE_MAX));
    expect(luminance(brandMeshWorst())).toBeGreaterThanOrEqual(luminance(worstSpot));
    // The stack of every blob is not the worst: a subset is lighter.
    expect(luminance(worstSpot)).toBeGreaterThan(luminance(allStacked));
    // A pane dims the mesh a little (brightness()) and carries the floor: the pair that shows the most of it, 70 %
    // (main's 0.33 with no dimming showed 67 %, the most a veil alone can; 0.20 at brightness(0.73) only 58 %).
    expect([BRAND_PANEL_VEIL, BRAND_PLATE_VEIL, BRAND_BRIGHTNESS]).toEqual([0.2, 0.33, 0.87]);
    expect(BRAND_GLASS).toEqual({ panelVeil: BRAND_PANEL_VEIL, plateVeil: BRAND_PLATE_VEIL, brightness: BRAND_BRIGHTNESS });
    expect(bestGlass(brandMeshSpots(), LIGHT_PAY_OWN)).toEqual({ panelVeil: BRAND_PANEL_VEIL, brightness: BRAND_BRIGHTNESS });
    expect(showThrough(BRAND_PANEL_VEIL, BRAND_BRIGHTNESS)).toBeCloseTo(0.696, 10);
    expect(showThrough(BRAND_PANEL_VEIL, BRAND_BRIGHTNESS)).toBeGreaterThan(showThrough(BRAND_PLATE_VEIL));
    expect(showThrough(BRAND_PANEL_VEIL, BRAND_BRIGHTNESS)).toBeGreaterThan(showThrough(0.2, 0.73));
    const seen = (spot: Rgb) => dimRgb(spot, BRAND_BRIGHTNESS);
    expect(BRAND_PANEL_VEIL).toBe(Math.max(PANEL_VEIL_FLOOR, ...brandMeshSpots().map((spot) => minVeil(seen(spot)))));
    // 0.01 less dimming and the pane needs more than the floor (so it would show less).
    expect(veilOver(brandMeshSpots().map((spot) => dimRgb(spot, BRAND_BRIGHTNESS + 0.01)))).toBeGreaterThan(PANEL_VEIL_FLOOR);
    // A plate (no filter of its own) over the mesh as it is: main's 0.33.
    expect(BRAND_PLATE_VEIL).toBe(Math.max(PANEL_VEIL_FLOOR, ...brandMeshSpots().map((spot) => minVeil(spot))));
    for (const spot of brandMeshSpots()) {
      expect(worst(mix(VEIL, seen(spot), BRAND_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
      expect(worst(mix(VEIL, spot, BRAND_PLATE_VEIL))).toBeGreaterThanOrEqual(AA);
    }
    for (const sat of SATURATIONS) {
      const spot = brandMeshWorst(sat);
      for (const t of TEXT_COLOURS) expect(contrast(t, mix(VEIL, seen(spot), BRAND_PANEL_VEIL)), `saturate ${sat}`).toBeGreaterThanOrEqual(AA);
      // Bare, that spot is under AA: the reason loose words get the plate.
      expect(worst(spot)).toBeLessThan(AA);
      // And undimmed, the thin pane would be too: the glass's own brightness() is what holds its words.
      expect(worst(mix(VEIL, spot, BRAND_PANEL_VEIL))).toBeLessThan(AA);
    }
    // A pick-one track, the control fill, a field, the danger button and a tinted chip over every spot, not only the
    // lightest: mixed in sRGB, a darker spot of another hue can need more.
    const VERMILION = hexToRgb("#e8392b");
    const look: LightLook = { kind: "frosted", ...BRAND_GLASS };
    for (const spot of brandMeshSpots()) {
      const at = `over rgb(${spot.map(Math.round).join(" ")})`;
      const panel = mix(VEIL, seen(spot), BRAND_PANEL_VEIL);
      const top = panelWords(look, spot);
      expect(worst(mix(BONE, mix(VEIL, spot, BRAND_PLATE_VEIL + TRACK_EXTRA_VEIL), TRACK_LIFT)), `track ${at}`).toBeGreaterThanOrEqual(AA);
      // A field is a well, one step below the panel it sits in (the bare panel and its lit top).
      for (const under of [panel, top]) expect(worst(mix(GREEN_DEEP, under, 0.45)), `field ${at}`).toBeGreaterThanOrEqual(AA);
      // Danger (components.css): vermilion 0.14 over the raise's own fill (--fill, --fill-hover, --fill-press), on a
      // panel and straight on the page. On a panel it is a whole step of light over the panel, and hover adds light.
      const onTrack = mix(VEIL, spot, BRAND_PLATE_VEIL + TRACK_EXTRA_VEIL);
      for (const [rest, hover, press] of [
        [lit(top, RAISE_VEIL, RAISE_LIFT), lit(top, RAISE_HOVER_VEIL, RAISE_HOVER_LIFT), lit(top, RAISE_VEIL, RAISE_PRESS_LIFT)],
        [mix(BONE, onTrack, TRACK_LIFT), mix(BONE, onTrack, PAGE_HOVER_LIFT), mix(BONE, onTrack, RAISE_PRESS_LIFT)],
      ]) {
        const [d, dh, dp] = [rest!, hover!, press!].map((under) => mix(VERMILION, under, 0.14));
        for (const bg of [d!, dh!, dp!]) expect(contrast(hexToRgb(TEXT_TOKENS["--vermilion-ink"]), bg), `danger ${at}`).toBeGreaterThanOrEqual(AA);
        expect(oklabL(dh!), `danger hover ${at}`).toBeGreaterThan(oklabL(d!));
      }
      expect(oklabL(mix(VERMILION, lit(top, RAISE_VEIL, RAISE_LIFT), 0.14)) - oklabL(top), `danger over its panel ${at}`).toBeGreaterThanOrEqual(noRoom(top) ? -LADDER_SLACK : LADDER_STEP);
      for (const under of [panel, raised(top)]) expect(contrast(hexToRgb("#ffeec4"), mix([246, 201, 69], mix(CHIP_UNDER, under, CHIP_DEEPEN), 0.16)), `amber chip ${at}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("the see-through has range: the lightest and darkest spots stay told apart through a panel (more than before)", () => {
    const darkest = BRAND_MESH.field[1]!;
    const through = (spot: Rgb) => mix(VEIL, dimRgb(spot, BRAND_BRIGHTNESS), BRAND_PANEL_VEIL);
    for (const sat of [GLASS_SATURATE, GLASS_SATURATE_MAX]) {
      expect(contrast(through(brandMeshWorst(sat)), through(darkest))).toBeGreaterThanOrEqual(2.8);
      // At main's 0.33 with nothing dimmed it was 2.79 and 2.63.
      expect(contrast(through(brandMeshWorst(sat)), through(darkest))).toBeGreaterThan(contrast(mix(VEIL, brandMeshWorst(sat), BRAND_PLATE_VEIL), mix(VEIL, darkest, BRAND_PLATE_VEIL)));
    }
  });

  it("every saturate() in the CSS is at most GLASS_SATURATE_MAX, and the glass uses GLASS_SATURATE", () => {
    const sats: number[] = [];
    // backdrop-filter only: a plain `filter` (the Background tile's little scene) never sits under words.
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) for (const m of rules(f).matchAll(/backdrop-filter:[^;]*?saturate\(([\d.]+)\)/g)) sats.push(Number(m[1]));
    expect(sats.length).toBeGreaterThan(0);
    expect(Math.max(...sats)).toBe(GLASS_SATURATE_MAX);
    // Every strength used is one the worst cases are worked out for.
    expect([...new Set(sats)].filter((x) => !SATURATIONS.includes(x))).toEqual([]);
    expect(declared(block(rules("tokens.css"), ":root")).get("--glass-saturate")).toBe(String(GLASS_SATURATE));
    expect(block(glass, ".glass")).toContain("-webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate)) brightness(var(--glass-brightness));");
    expect(block(glass, ".glass")).toMatch(/(^|\s)backdrop-filter: blur\(var\(--glass-blur\)\) saturate\(var\(--glass-saturate\)\) brightness\(var\(--glass-brightness\)\);/);
  });

  it("every brightness() in a backdrop-filter is the look's own, last, and the CSS starts at the app's own backdrop's", () => {
    const dims: string[] = [];
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css")))
      for (const m of rules(f).matchAll(/backdrop-filter:\s*([^;]+);/g)) if (/brightness\(/.test(m[1]!)) dims.push(`${f}: ${m[1]!.trim()}`);
    expect(dims.length).toBeGreaterThanOrEqual(5);
    // The look's own number (lib/look.ts), after the blur and the saturation, so the maths' order is the browser's.
    for (const d of dims) expect(d, d).toMatch(/saturate\([^)]*\)\)? brightness\(var\(--glass-brightness\)\)$/);
    const root = declared(block(rules("tokens.css"), ":root"));
    expect(Number(root.get("--glass-brightness"))).toBe(BRAND_BRIGHTNESS);
    expect(Number(root.get("--panel-veil"))).toBe(BRAND_PANEL_VEIL);
    expect(Number(root.get("--plate-veil"))).toBe(BRAND_PLATE_VEIL);
    // A stronger blur than before (18 px), for the liquid look; the floats keep their 28 px.
    expect(root.get("--glass-blur")).toBe("24px");
    expect(BRAND_BRIGHTNESS).toBeGreaterThanOrEqual(MIN_GLASS_BRIGHTNESS);
  });

  it("a bone sheen with no green paid under it still fails AA (4.21:1): the reason every lift is paid for", () => {
    expect(worst(mix(BONE, mix(VEIL, dimRgb(brandMeshWorst(GLASS_SATURATE), BRAND_BRIGHTNESS), BRAND_PANEL_VEIL), 0.06))).toBeLessThan(AA);
    // The panel's tint is green only; its light is a layer of its own, paid for (the logic of light, below).
    expect(declared(block(rules("tokens.css"), ":root")).get("--glass-tint-panel")).not.toMatch(/bone/);
  });

  it("nested glass is raised on its panel: the relative raise, lit flat, and no blur of its own", () => {
    const nested = block(glass, ":where(.glass) .glass");
    const d = declared(nested);
    expect(d.get("--glass-tint")).toBe("linear-gradient(rgb(var(--green-rgb) / var(--light-raise-veil)), rgb(var(--green-rgb) / var(--light-raise-veil)))");
    expect(d.get("--glass-light")).toBe("linear-gradient(rgb(var(--bone-rgb) / var(--light-raise-lift)), rgb(var(--bone-rgb) / var(--light-raise-lift)))");
    expect(nested).toMatch(/(^|\s)backdrop-filter: none;/);
    expect(nested).toMatch(/-webkit-backdrop-filter: none;/);
    expect(nested).toContain("box-shadow: var(--glass-shadow-raise);");
  });

  it("the shell's Live chip, while Clip Factory is on screen, is raised on the sidebar exactly as the sidebar's own chip", () => {
    // Clips Funded switched on: the shell draws the Live chip over Clip Factory's sidebar, where the sidebar's own was
    // (app/WorkspaceDock.tsx). Its rule has nested glass's very declarations, as light, right after it (§45.19).
    const nested = ":where(.glass) .glass";
    const dock = ':where([data-app-pane="clips"]:not([hidden]) ~ .ws-dock > .ws-dock__live) > .glass';
    expect(block(glass, dock), "the dock's chip has a rule of its own").not.toBe("");
    expect(block(glass, dock)).toBe(block(glass, nested));
    const at = (selector: string) => glass.indexOf(`\n${selector} {`);
    expect(at(nested)).toBeGreaterThan(0);
    expect(glass.slice(at(nested) + 1, at(dock)).trim(), "right after nested glass").toBe(`${nested} {${block(glass, nested)}}`);
    // Only while Clip Factory is on screen: no other rule of glass.css reaches the dock's chip.
    expect(glass.match(/\.ws-dock__live/g)).toHaveLength(1);
  });

  it("loose words get an E1 plate in every look, and glass.css leaves buttons to components.css", () => {
    expect(glass).toContain("html:is(.see-through, [data-backdrop])");
    expect(glass).not.toContain('[data-backdrop="frosted"]');
    const plates = /\nhtml:is\(\.see-through, \[data-backdrop\]\)\s*:is\(\s*\.page-head__text,[^{]*\{([^}]*)\}/.exec(glass)![1]!;
    // A plate draws no filter, so its words take the plate veil (nothing dims the backdrop under them).
    expect(plates).toContain("background: var(--glass-light-panel), var(--glass-tint-plate);");
    expect(plates).not.toMatch(/backdrop-filter/);
    expect(plates).toContain("box-shadow: var(--glass-shadow-panel);");
    expect(plates).toContain("padding-block: 8px;");
    // The title plates hold their words by their tint alone (worked out with nothing blurred): no filter of their own.
    expect(block(glass, ":is(.page-head__text, .dash-head__text)")).toBe("");
    // No button rule here any more: the fills are context-aware, so components.css draws them in every look.
    expect(glass).not.toMatch(/\.btn--(glass|ghost|danger|lens)/);
    const root = declared(block(rules("tokens.css"), ":root"));
    expect(root.get("--fill-control")).toBe("var(--fill)");
    expect(root.get("--fill")).toBe("linear-gradient(rgb(var(--bone-rgb) / var(--light-raise-lift)), rgb(var(--bone-rgb) / var(--light-raise-lift))), rgb(var(--green-rgb) / min(1, var(--light-raise-veil)))");
  });
});

/**
 * Every place a lit surface can be, with what is behind it: the living backdrop (every corner at every saturation),
 * every window glass × setting × strength × check, a white photo, every mix of 1 to 3 swatches in the Colours look,
 * and reduced transparency (veils 0.92, the pay LIGHT_PAY_WHITE).
 */
interface LightPlace {
  at: string;
  look: LightLook;
  behind: Rgb;
  pay: number;
  floatVeil: number;
}
/** Every ordering of 1 to 3 different swatches: 12 + 12 × 11 + 12 × 11 × 10 = 1,464. */
const SWATCH_MIXES: string[][] = (() => {
  const hexes = SWATCHES.map((s) => s.hex);
  const out: string[][] = [];
  for (const a of hexes) {
    out.push([a]);
    for (const b of hexes) {
      if (b === a) continue;
      out.push([a, b]);
      for (const c of hexes) if (c !== a && c !== b) out.push([a, b, c]);
    }
  }
  return out;
})();
/** The veils glass.css sets under prefers-reduced-transparency. */
const REDUCED_VEIL = 0.92;
/**
 * Each place carries its look's own pay (`lightPay`, what lib/look.ts sets as `--light-pay`): the living backdrop's,
 * each window glass × setting × strength's, a photo's, each mix of colours', and reduced transparency's.
 */
const LIGHT_PLACES: LightPlace[] = (() => {
  const out: LightPlace[] = [];
  const rgb = (c: Rgb) => `rgb(${c.map(Math.round).join(" ")})`;
  const brand: LightLook = { kind: "frosted", ...BRAND_GLASS };
  for (const behind of brandMeshSpots()) out.push({ at: `the living backdrop over ${rgb(behind)}`, look: brand, behind, pay: lightPay(brand), floatVeil: FLOAT_VEIL });
  for (const { glass, scheme, strength, check, at } of EVERY_LOOK) {
    const look: LightLook = { kind: "window", ...windowGlass(glass, scheme, strength) };
    out.push({ at, look, behind: check.behind, pay: lightPay(look), floatVeil: FLOAT_VEIL });
  }
  const photo: LightLook = { kind: "picture", ...PICTURE_GLASS };
  for (const behind of [WHITE, saturateRgb(WHITE, GLASS_SATURATE_MAX), BLACK]) out.push({ at: `a photo, ${rgb(behind)}`, look: photo, behind, pay: lightPay(photo), floatVeil: FLOAT_VEIL });
  for (const cs of SWATCH_MIXES) {
    const v = coloursVeils(cs);
    const look: LightLook = { kind: "colours", ...v, colours: cs };
    const pay = lightPay(look);
    for (const behind of coloursMeshSpots(cs)) out.push({ at: `colours ${cs.join(" ")} over ${rgb(behind)}`, look, behind, pay, floatVeil: FLOAT_VEIL });
  }
  for (const behind of [WHITE, BLACK, ...brandMeshSpots()])
    // Nothing blurs or dims there (backdrop-filter: none), and the plates carry the same 0.92.
    out.push({ at: `reduced transparency over ${rgb(behind)}`, look: { kind: "frosted", panelVeil: REDUCED_VEIL, plateVeil: REDUCED_VEIL, brightness: 1 }, behind, pay: LIGHT_PAY_REDUCED, floatVeil: REDUCED_VEIL });
  return out;
})();

const STATES: readonly LightState[] = ["rest", "hover", "press", "ghost"];
/** Everything words can sit on at a place, each at its TOP (where its light is strongest), named. */
function litSurfaces(p: LightPlace): [name: string, bg: Rgb][] {
  const { look, behind, pay } = p;
  const page = mix(VEIL, behind, look.pageVeil ?? 0);
  const e1 = panelWords(look, behind, false, pay);
  const lead = panelWords(look, behind, true, pay);
  const plate = plateWords(look, behind, pay);
  const out: [string, Rgb][] = [
    ["E1 panel", e1],
    ["E1 lead panel", lead],
    ["E1 plate", plate],
  ];
  for (const [parentName, parent] of [["panel", e1], ["lead panel", lead], ["plate", plate]] as const)
    for (let depth = 1; depth <= 3; depth++) for (const state of STATES) out.push([`E${depth + 1} on the ${parentName}, ${state}`, raised(parent, depth, state)]);
  for (const state of STATES) out.push([`a control straight on the page, ${state}`, onPage(look, behind, state)]);
  for (const t of CHIP_TINTS) out.push([`the ${t.name} chip on a row`, chipOn(raised(e1), t)], [`the ${t.name} chip on a mark`, chipOn(raised(e1, 2), t)]);
  // An option laid over its own pick-one track (glass.css re-declares the raise on a track's options): hovered over a
  // track straight on the page, and over a track on a panel.
  out.push(["an option over a track on the page, hover", raised(onPage(look, behind), 1, "hover")], ["an option over a track on a panel, hover", raised(raised(e1), 1, "hover")]);
  // Later and the Reload lens on the update bar are components.css's own recipes, held by test/buttonLight.test.ts.
  for (const under of [WHITE, page, e1]) {
    const bar = floatTop(under, look, "rest", p.floatVeil);
    out.push(
      ["a floating layer", bar],
      ["a floating layer, hover", floatTop(under, look, "hover", p.floatVeil)],
      ...STATES.flatMap((state) => [1, 2, 3].map((depth) => [`level ${depth + 1} on a floating layer, ${state}`, raised(bar, depth, state)] as [string, Rgb])),
      // Overlays over their scrim (deep green, 0.50 at the lightest), menus and the solid list.
      ["the question sheet", lit(mix(GREEN_DEEP, under, 0.5), Math.max(SHEET_VEIL, look.panelVeil), OVERLAY_LIGHT)],
      ["the picture viewer", lit(mix(GREEN_DEEP, under, 0.5), Math.max(0.9, look.panelVeil), OVERLAY_LIGHT)],
      ["the workspace menu", lit(under, 0.94, MENU_LIGHT)],
      ["the dropdown list", lit(under, 1, MENU_LIGHT)],
    );
  }
  return out;
}

describe("the logic of light (ADR-87): the top layer is brighter, and every lift is paid for", () => {
  const tokens = rules("tokens.css");
  const glass = rules("glass.css");
  const root = declared(block(tokens, ":root"));
  /** The rule that re-declares the raise inside every lit surface. */
  const litBlock = /:where\(([^{}]*)\)\s*\{(\s*--light-raise-veil: [\d.]+;[^}]*)\}/.exec(glass);

  it("tokens.css and glass.css carry exactly the numbers lib/background.ts works out", () => {
    const want: Record<string, number> = {
      "--light-pay": LIGHT_PAY_OWN,
      "--light-panel": PANEL_LIGHT,
      "--light-lead": LEAD_LIGHT,
      "--light-lead-pay": LEAD_EXTRA_VEIL,
      "--light-float": FLOAT_LIGHT,
      "--light-float-hover": FLOAT_HOVER_LIGHT,
      "--light-float-pay": FLOAT_EXTRA_VEIL,
      "--light-overlay": OVERLAY_LIGHT,
      "--light-menu": MENU_LIGHT,
      "--light-tabbar": TABBAR_LIGHT,
      "--light-tabbar-pay": TABBAR_EXTRA_VEIL,
      "--light-spec": SPECULAR,
      // Straight on the page a raised thing is the pick-one track.
      "--light-raise-lift": TRACK_LIFT,
      "--light-raise-hover-lift": PAGE_HOVER_LIFT,
      "--light-ghost-lift": PAGE_GHOST_LIFT,
      "--light-press-lift": RAISE_PRESS_LIFT,
    };
    for (const [token, value] of Object.entries(want)) expect(Number(root.get(token)), token).toBe(value);
    // Straight on the page nothing dims the backdrop under a control: the plate veil carries it.
    for (const token of ["--light-raise-veil", "--light-raise-hover-veil", "--light-ghost-veil"]) expect(root.get(token), token).toBe(`calc(var(--plate-veil) + ${TRACK_EXTRA_VEIL})`);
    // The pay is worked out for each look (lib/look.ts puts it on <html>); the CSS holds the app's own backdrop's
    // until then, a photo's where white can be behind, and reduced transparency's.
    expect(Number(declared(block(glass, 'html:is(.see-through, [data-backdrop="picture"])')).get("--light-pay"))).toBe(LIGHT_PAY_WHITE);
    // Over a photo the glass blurs as it did before (18 px, 14 px where it bends), so the photo's shapes still read.
    expect(declared(block(glass, 'html[data-backdrop="picture"]')).get("--glass-blur")).toBe("18px");
    expect(declared(block(glass, 'html[data-backdrop="picture"]')).get("--glass-refract-blur")).toBe("14px");
    expect(glass).toMatch(new RegExp(`@media \\(prefers-reduced-transparency: reduce\\) \\{[\\s\\S]*--light-pay: ${LIGHT_PAY_REDUCED} !important;`));
    expect(glass).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*--plate-veil: 0\.92 !important;/);
    expect(LIGHT_PAY_OWN).toBe(0);
    for (const kind of ["frosted", "brand"] as const) expect(lightPay({ kind, ...BRAND_GLASS })).toBe(LIGHT_PAY_OWN);
    // The window look pays as a light look does (over a white desktop its panes sit at the AA floor, and the levels
    // above them need room to read brighter): LIGHT_PAY_WHITE, Clear and Frosted, every glass.
    for (const glassName of GLASSES)
      for (const scheme of SCHEMES)
        for (const strength of STRENGTHS) expect(lightPay({ kind: "window", ...windowGlass(glassName, scheme, strength) }), `${glassName} ${scheme} ${strength}`).toBe(LIGHT_PAY_WHITE);
    // A photo's panes dim it to half, so they pay MAX_LIGHT_PAY / 0.5 (mostPay); its plates (no filter) LIGHT_PAY_WHITE.
    expect(lightPay({ kind: "picture", ...PICTURE_GLASS })).toBe(mostPay(PICTURE_BRIGHTNESS));
    expect(platePay(lightPay({ kind: "picture", ...PICTURE_GLASS }))).toBe(LIGHT_PAY_WHITE);
    expect(lightPay({ kind: "window", panelVeil: 0.73, plateVeil: 0.73, brightness: 1 }, true)).toBe(LIGHT_PAY_REDUCED);
    // Colours with no colours named plan for a white mesh: never less than the colours themselves need.
    for (const cs of [DEFAULT_COLOURS, ["#f7f5ef"], ["#8e6cc9", "#0f372b", "#e8392b"]]) {
      const v = coloursVeils(cs);
      expect(lightPay({ kind: "colours", ...v })).toBeGreaterThanOrEqual(lightPay({ kind: "colours", ...v, colours: cs }));
    }
    // Inside every lit surface: the relative raise, and the fills declared again from it.
    expect(litBlock, "the lit-surface block").not.toBeNull();
    const inside = declared(litBlock![2]!);
    expect(Number(inside.get("--light-raise-veil"))).toBe(RAISE_VEIL);
    expect(Number(inside.get("--light-raise-lift"))).toBe(RAISE_LIFT);
    expect(Number(inside.get("--light-raise-hover-veil"))).toBe(RAISE_HOVER_VEIL);
    expect(Number(inside.get("--light-raise-hover-lift"))).toBe(RAISE_HOVER_LIFT);
    expect(Number(inside.get("--light-ghost-veil"))).toBe(GHOST_VEIL);
    expect(Number(inside.get("--light-ghost-lift"))).toBe(GHOST_LIFT);
    for (const fill of ["--fill", "--fill-hover", "--fill-press", "--fill-ghost", "--fill-control"]) expect(inside.get(fill), fill).toBe(root.get(fill));
    const surfaces = litBlock![1]!.split(",").map((x) => x.trim().replace(/\s+/g, " "));
    for (const sel of [".glass", ".dropdown__list", ".ws-menu", ".money-dock", ".tt-sheet", ".help-launcher", ".help-panel", ".page-head__text", ".dash-head__text", ".crumbs__list", ".back-link", ".topbar .brand__name"])
      expect(surfaces, sel).toContain(sel);
    // A pick-one track's options take the relative raise, so their hover is a step over their own track: the options
    // are named (`.segmented > *`), never the track, whose own fill keeps what it sits on (the page or a panel).
    for (const track of [".segmented", ".tabs", ".bg-modes", ".model-picks", ".stepper", ".ws-switch"]) {
      expect(surfaces, track).toContain(`${track} > *`);
      expect(surfaces, track).not.toContain(track);
    }
  });

  it("every pane is green under a bone light that is brightest at its top and eases out by 65 %, lit from above", () => {
    const g = declared(block(glass, ".glass"));
    expect(g.get("--glass-tint")).toBe("var(--glass-tint-panel)");
    expect(g.get("--glass-light")).toBe("var(--glass-light-panel)");
    expect(block(glass, ".glass")).toContain("background: var(--glass-light), var(--glass-tint);");
    expect(block(glass, ".glass")).toContain("box-shadow: var(--glass-shadow-panel);");
    expect(block(glass, ".glass")).toContain("border: 1px solid transparent;");
    const lead = declared(block(glass, ".glass--green"));
    expect([lead.get("--glass-tint"), lead.get("--glass-light")]).toEqual(["var(--glass-tint-lead)", "var(--glass-light-lead)"]);
    // Two flat stops of bottle green (the tests read their alphas), and the pay on the veil.
    const flat = (alpha: string) => `linear-gradient(rgb(var(--green-rgb) / ${alpha}), rgb(var(--green-rgb) / ${alpha}))`;
    expect(root.get("--glass-tint-panel")).toBe(flat("min(1, var(--panel-veil) + var(--light-pay))"));
    // A plate draws no filter: it carries the pay as an undimmed surface does, at most MAX_LIGHT_PAY (platePay).
    expect(root.get("--glass-tint-plate")).toBe(flat(`min(1, var(--plate-veil) + min(var(--light-pay), ${MAX_LIGHT_PAY}))`));
    expect(root.get("--glass-tint-lead")).toBe(flat("min(0.97, var(--panel-veil) + var(--light-pay) + var(--light-lead-pay))"));
    expect(root.get("--glass-tint-float")).toBe(flat("min(1, max(var(--float-veil), var(--panel-veil)) + var(--light-float-pay))"));
    expect(root.get("--glass-tint-tabbar")).toBe(flat("min(1, var(--tabbar-veil) + var(--light-tabbar-pay))"));
    // The light: the catch light at the top centre, then bone from the top down, gone by 65 % on panels.
    expect(root.get("--glass-light-panel")).toBe(
      "var(--glass-spec), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-panel)) 0, rgb(var(--bone-rgb) / calc(var(--light-panel) * 0.5)) 6px, rgb(var(--bone-rgb) / calc(var(--light-panel) * 0.15)) 11px, rgb(var(--bone-rgb) / 0) 14px)",
    );
    // The catch light stays in the smallest top padding above words (8 px: the line plates), never under them.
    expect(root.get("--glass-spec")).toBe("radial-gradient(60% 8px at 50% 0, rgb(var(--bone-rgb) / var(--light-spec)), transparent)");
    expect(root.get("--glass-spec-sm")).toBe("radial-gradient(50% 8px at 50% 0, rgb(var(--bone-rgb) / var(--light-spec)), transparent)");
    // One key light above: every tint and light runs straight down (180deg) or is flat, in tokens.css and glass.css.
    const angled: string[] = [];
    for (const [file, text] of [["tokens.css", tokens], ["glass.css", glass]] as const)
      for (const m of text.matchAll(/(--glass-(?:tint|light)[a-z-]*):\s*([^;]+);/g)) for (const a of m[2]!.matchAll(/(\d+)deg/g)) if (a[1] !== "180") angled.push(`${file} ${m[1]}: ${a[0]}`);
    expect(angled).toEqual([]);
    // A raised thing inside a pane is lit flat: the pane's light shows through it, so it is lit from above too.
    expect(root.get("--fill")).toMatch(/^linear-gradient\(rgb\(var\(--bone-rgb\) \/ var\(--light-raise-lift\)\)/);
  });

  it("every lift is paid for: words reach AA at the top of every level, in every state, in every look", () => {
    expect(SWATCH_MIXES).toHaveLength(1464);
    expect(LIGHT_PLACES.length).toBeGreaterThan(40_000);
    const lowest = new Map<string, number>();
    const fails: string[] = [];
    for (const p of LIGHT_PLACES)
      for (const [name, bg] of litSurfaces(p)) {
        const c = worst(bg);
        if (c < (lowest.get(name) ?? Infinity)) lowest.set(name, c);
        if (c < AA && fails.length < 20) fails.push(`${name}, ${p.at}: ${c.toFixed(2)}`);
      }
    expect(fails).toEqual([]);
    // Every surface was checked; the tightest are close to AA, so nothing here may be rounded up by eye.
    expect(lowest.size).toBeGreaterThan(40);
    expect(Math.min(...lowest.values())).toBeLessThan(4.9);
  }, 60_000);

  it("the selected pill's green words reach AA wherever it sits, and the tab bar's icons reach 3:1", () => {
    const fails: string[] = [];
    for (const p of LIGHT_PLACES) {
      const e1 = panelWords(p.look, p.behind, false, p.pay);
      for (const under of [e1, raised(e1), raised(e1, 2), onPage(p.look, p.behind), plateWords(p.look, p.behind, p.pay)]) if (contrast(ON_BONE, mix(BONE, under, SELECTED_ALPHA)) < AA && fails.length < 20) fails.push(p.at);
    }
    expect(fails).toEqual([]);
    // The tab bar holds icons only and plans for white under it (TABBAR_VEIL + its pay, under its light); in the
    // window look it carries at least the panel tint.
    for (const veil of [TABBAR_VEIL, REDUCED_VEIL, ...EVERY_LOOK.map((l) => Math.max(TABBAR_VEIL, seeThroughVeils(l.glass, l.scheme, l.strength).panel))]) {
      const bar = lit(WHITE, veil + TABBAR_EXTRA_VEIL, TABBAR_LIGHT);
      expect(worst(bar), `tab bar at ${veil}`).toBeGreaterThanOrEqual(3);
      expect(contrast(ON_BONE, mix(BONE, bar, SELECTED_ALPHA)), `the chosen tab at ${veil}`).toBeGreaterThanOrEqual(AA);
    }
    expect(worst(lit(WHITE, TABBAR_VEIL + TABBAR_EXTRA_VEIL, TABBAR_LIGHT))).toBeCloseTo(3.22, 2);
  });

  it("AA holds at any depth: the relative raise's fixed point is under the ceiling", () => {
    // x = lift·bone + (1 − lift)·(veil·green + (1 − veil)·x), solved for x, channel by channel.
    const fixedPoint = (veil: number, lift: number) => BONE.map((b, i) => (lift * b + (1 - lift) * veil * VEIL[i]!) / (1 - (1 - lift) * (1 - veil))) as unknown as Rgb;
    const fixed = fixedPoint(RAISE_VEIL, RAISE_LIFT);
    expect(worst(fixed)).toBeGreaterThanOrEqual(AA);
    // The quiet fill settles a touch lower, so it never outshines a raised thing at any depth.
    expect(oklabL(fixedPoint(GHOST_VEIL, GHOST_LIFT))).toBeLessThanOrEqual(oklabL(fixed));
    // Only one step is ever hovered at a time, so hover is checked on top of resting stacks four levels deep (above).
    // A deep stack settles on it, whatever it started on.
    let x: Rgb = WHITE;
    for (let d = 0; d < 40; d++) x = raised(x);
    expect(worst(x)).toBeCloseTo(worst(fixed), 2);
  });

  /** Each rung a look climbs, as [name, lower, upper, the least it must climb]. */
  const rungs = (p: LightPlace): [string, Rgb, Rgb, number][] => {
    const { look, behind, pay } = p;
    const page = mix(VEIL, behind, look.pageVeil ?? 0);
    const e1 = panelWords(look, behind, false, pay);
    const lead = panelWords(look, behind, true, pay);
    const plate = plateWords(look, behind, pay);
    /** The rest of a level above a pane climbs a whole step over its parent, or (where `noRoom`) steps back at most LADDER_SLACK. */
    const need = (_depth: number, under?: Rgb) => (under && noRoom(under) ? -LADDER_SLACK : LADDER_STEP);
    const out: [string, Rgb, Rgb, number][] = [
      // Inside a pane its top is brighter than its base.
      ["E1 base → top", lit(underGlass(look, behind), look.panelVeil + pay, 0), e1, 0],
      ["E1 → the lead panel", e1, lead, 0],
      ["a control on the page → its hover", onPage(look, behind), onPage(look, behind, "hover"), Number.MIN_VALUE],
      ["a control on the page, pressed → rest", onPage(look, behind, "press"), onPage(look, behind), 0],
      ["a quiet control on the page → rest", onPage(look, behind, "ghost"), onPage(look, behind), 0],
    ];
    for (const [paneName, pane] of [["panel", e1], ["lead panel", lead], ["plate", plate]] as const)
      for (let depth = 1; depth <= 3; depth++) {
        const under = depth === 1 ? pane : raised(pane, depth - 1);
        const rest = raised(under);
        const at = `E${depth + 1} on the ${paneName}`;
        out.push(
          [`${at}: over its parent`, under, rest, need(depth, under)],
          [`${at}: quiet, over its parent`, under, raised(under, 1, "ghost"), need(depth, under)],
          [`${at}: quiet → rest`, raised(under, 1, "ghost"), rest, noRoom(under) ? -LADDER_SLACK : 0],
          [`${at}: rest → hover`, rest, raised(under, 1, "hover"), Number.MIN_VALUE],
          [`${at}: pressed → rest`, raised(under, 1, "press"), rest, 0],
        );
      }
    for (const under of [WHITE, page, e1]) {
      const bar = floatTop(under, look, "rest", p.floatVeil);
      out.push(["a floating layer → its hover", bar, floatTop(under, look, "hover", p.floatVeil), Number.MIN_VALUE]);
      let x = bar;
      for (let depth = 1; depth <= 3; depth++) {
        const rest = raised(x);
        out.push([`level ${depth + 1} on a floating layer: over its parent`, x, rest, need(depth, x)], [`level ${depth + 1} on a floating layer: rest → hover`, rest, raised(x, 1, "hover"), Number.MIN_VALUE]);
        x = rest;
      }
    }
    return out;
  };

  it("the top layer is brighter: from a pane up, every level climbs a whole step, nothing steps back, and hover adds light", () => {
    const lowest = new Map<string, { dl: number; need: number; at: string }>();
    for (const p of LIGHT_PLACES)
      for (const [name, lower, upper, need] of rungs(p)) {
        const dl = oklabL(upper) - oklabL(lower);
        if (dl - need < (lowest.has(name) ? lowest.get(name)!.dl - lowest.get(name)!.need : Infinity)) lowest.set(name, { dl, need, at: p.at });
      }
    // No tolerance: at the hardest corners too (a white desktop or photo, a bright spot of the mesh, a light colour),
    // each rung climbs at least what it must, because the pane under it pays for the room (`lightPay`).
    const short = [...lowest].filter(([, v]) => v.dl < v.need).map(([k, v]) => `${k}: ${v.dl.toFixed(4)} (needs ${v.need}) at ${v.at}`);
    expect(short).toEqual([]);
    expect(lowest.size).toBeGreaterThan(30);
    expect(LADDER_STEP).toBe(0.015);
    // Over the app's own backdrop (its dark field) every step is clearly brighter.
    const field = BRAND_MESH.field[1]!;
    const look: LightLook = { kind: "frosted", ...BRAND_GLASS };
    const e1 = panelTop(look, field);
    const e2 = raised(e1);
    const e3 = raised(e1, 2);
    expect(oklabL(e1) - oklabL(lit(underGlass(look, field), BRAND_PANEL_VEIL + LIGHT_PAY_OWN, 0)), "E1 top over its base").toBeGreaterThan(0.02);
    expect(oklabL(e2) - oklabL(e1), "E2 − E1").toBeGreaterThanOrEqual(0.04);
    expect(oklabL(e3) - oklabL(e2), "E3 − E2").toBeGreaterThanOrEqual(0.03);
    expect(oklabL(raised(e1, 1, "hover")) - oklabL(e2), "E2 hover − E2").toBeGreaterThan(0.01);
    expect(oklabL(panelTop(look, field, true)) - oklabL(e1), "the lead panel − E1").toBeGreaterThan(LADDER_STEP);
    expect(oklabL(mix(BONE, e3, SELECTED_ALPHA)) - oklabL(e3), "E4 selected − E3").toBeGreaterThan(0.4);
  }, 60_000);

  it("an option laid over its own track is a step of light brighter on hover, in every look", () => {
    // glass.css re-declares the relative raise on a pick-one track's options (`.segmented > *` and the rest), so an
    // option's hover is `--fill-hover` laid over the track it sits in: straight on the page (the track is the page's
    // control recipe) and inside a panel or the lead panel (the track is a raised thing). Before, an option on a track
    // straight on the page laid the page's whole recipe again over the track, and hovering it went darker.
    const fails: string[] = [];
    let least = Infinity;
    for (const p of LIGHT_PLACES) {
      const e1 = panelWords(p.look, p.behind, false, p.pay);
      for (const [where, track] of [["on the page", onPage(p.look, p.behind)], ["on a panel", raised(e1)], ["on the lead panel", raised(panelWords(p.look, p.behind, true, p.pay))], ["on a row", raised(e1, 2)]] as const) {
        const hover = raised(track, 1, "hover");
        const dl = oklabL(hover) - oklabL(track);
        least = Math.min(least, dl);
        if (!(dl > (noRoom(track) ? -LADDER_SLACK : 0)) && fails.length < 20) fails.push(`${where}: ${dl.toFixed(4)}, ${p.at}`);
        if (worst(hover) < AA && fails.length < 20) fails.push(`${where}: ${worst(hover).toFixed(2)}:1, ${p.at}`);
      }
    }
    expect(fails).toEqual([]);
    expect(least).toBeGreaterThan(-LADDER_SLACK);
  }, 60_000);

  it("each look's pay is the least that leaves the ladder room: 0.01 less breaks it somewhere", () => {
    const looks: { name: string; spots: Rgb[]; look: LightLook }[] = [
      { name: "the living backdrop", spots: brandMeshSpots(), look: { kind: "frosted", ...BRAND_GLASS } },
      { name: "Clear over white", spots: [WHITE, BLACK], look: { kind: "window", ...windowGlass("liquid", "light", "clear") } },
      { name: "Frosted over white", spots: [WHITE, BLACK], look: { kind: "window", ...windowGlass("liquid", "light", "frosted") } },
      { name: "a white photo", spots: [WHITE], look: { kind: "picture", ...PICTURE_GLASS } },
      ...[DEFAULT_COLOURS, ["#f7f5ef"], ["#8e6cc9", "#0f372b", "#e8392b"], ["#1f2937"]].map((cs) => ({ name: `colours ${cs.join(" ")}`, spots: coloursMeshSpots(cs), look: { kind: "colours" as const, ...coloursVeils(cs), colours: cs } })),
    ];
    for (const { name, spots, look } of looks) {
      const pay = lightPay(look);
      // A pane over the backdrop as its glass sees it, and a plate over it as it is.
      const panes = spots.map((s) => underGlass(look, s));
      const plates = spots.map((s) => mix(VEIL, s, look.pageVeil ?? 0));
      expect(panes.flatMap((pg) => ladderFaults(pg, look.panelVeil, pay)), name).toEqual([]);
      expect(plates.flatMap((pg) => ladderFaults(pg, look.plateVeil, platePay(pay))), `${name}, a plate`).toEqual([]);
      const less = Math.round((pay - 0.01) * 100) / 100;
      if (pay > 0) expect(panes.some((pg) => ladderFaults(pg, look.panelVeil, less, false, true).length > 0) || plates.some((pg) => ladderFaults(pg, look.plateVeil, platePay(less), false, true).length > 0), `${name} at ${less}`).toBe(true);
    }
  });

  it("a pane whose glass dims what it sees pays for that light (MAX_LIGHT_PAY / b): the new-clip card climbs over the hero in Cream and over a white photo, and the plates keep MAX_LIGHT_PAY", () => {
    // MAX_LIGHT_PAY / b, rounded down to 0.01; undimmed (the window look, dark colours) it is 0.05 as before.
    expect([1, 0.97, 0.91, 0.87, 0.7, 0.62, 0.58, 0.51, 0.5].map(mostPay)).toEqual([0.05, 0.05, 0.05, 0.05, 0.07, 0.08, 0.08, 0.09, 0.1]);
    expect(mostPay(WINDOW_BRIGHTNESS)).toBe(LIGHT_PAY_WHITE);
    expect(mostPay(MIN_GLASS_BRIGHTNESS)).toBe(0.1);
    for (const pay of [0, LIGHT_PAY_REDUCED, MAX_LIGHT_PAY, 0.1]) expect(platePay(pay)).toBe(Math.min(pay, MAX_LIGHT_PAY));
    // Through a glass at half the light a pane at its AA floor is near the raise's fixed point: with 0.05 the card on
    // the hero read +0.003 at its words, and e2e/light.spec.ts read +0.014 in its top padding (Chromium on Linux),
    // under the whole step. 0.10 leaves it about main's room at its words (+0.010 there on main).
    const dimmed: [string, LightLook, Rgb[]][] = [
      ["cream", { kind: "colours", ...coloursVeils(["#f7f5ef"]), colours: ["#f7f5ef"] }, coloursMeshSpots(["#f7f5ef"])],
      ["white", { kind: "colours", ...coloursVeils(["#ffffff"]), colours: ["#ffffff"] }, coloursMeshSpots(["#ffffff"])],
      ["a white photo", { kind: "picture", ...PICTURE_GLASS }, [WHITE, saturateRgb(WHITE, GLASS_SATURATE_MAX)]],
    ];
    for (const [name, look, spots] of dimmed) {
      const pay = lightPay(look);
      expect(look.brightness, name).toBe(MIN_GLASS_BRIGHTNESS);
      expect(pay, name).toBe(0.1);
      expect(look.panelVeil + pay, name).toBeLessThan(SEE_THROUGH_LIMIT);
      for (const spot of spots) {
        const hero = panelWords(look, spot, true, pay);
        expect(oklabL(raised(hero)) - oklabL(hero), `${name} over ${spot.map(Math.round)}`).toBeGreaterThanOrEqual(0.0085);
        expect(worst(raised(hero)), name).toBeGreaterThanOrEqual(AA);
        // A plate draws no filter, so it carries what it did (MAX_LIGHT_PAY), and shows as much of the backdrop.
        expect(plateWords(look, spot, pay), name).toEqual(plateWords(look, spot, MAX_LIGHT_PAY));
      }
    }
    // The pay never takes more than MAX_LIGHT_PAY of what shows through a pane (b × the pay), in any look, as before.
    const all: LightLook[] = [{ kind: "picture", ...PICTURE_GLASS }, ...SWATCH_MIXES.map((cs): LightLook => ({ kind: "colours", ...coloursVeils(cs), colours: cs }))];
    for (const glassName of GLASSES) for (const scheme of SCHEMES) for (const strength of STRENGTHS) all.push({ kind: "window", ...windowGlass(glassName, scheme, strength) });
    for (const look of all) expect(look.brightness * lightPay(look), `${look.kind} ${look.colours?.join(" ") ?? ""}`).toBeLessThanOrEqual(MAX_LIGHT_PAY + 1e-9);
    // Where nothing dims, nothing changes: the window look and the default colours pay 0.05.
    expect(lightPay({ kind: "window", ...windowGlass("liquid", "light", "clear") })).toBe(MAX_LIGHT_PAY);
    expect(lightPay({ kind: "colours", ...coloursVeils(DEFAULT_COLOURS), colours: [...DEFAULT_COLOURS] })).toBe(MAX_LIGHT_PAY);
  });

  it("what shows through a pane, (1 − page)(1 − green)(b), is at least main's in every look, and more where AA leaves room (§22.4)", () => {
    // [look, what a pane shows now, what it showed on main (6e737671)]. Main: the own backdrop 0.33, the window look
    // 0.73 + 0.05 Clear and 0.88 Frosted over a 0.30 frost, the picture 0.73 + 0.05, the colours 0.35 (default), cream
    // 0.65 over a 0.28 page veil, white 0.65 over 0.33, and nothing dimmed anywhere.
    const shows = (look: LightLook & { pageVeil?: number }) => showThrough(look.panelVeil, look.brightness, lightPay(look), look.pageVeil ?? 0);
    const colours = (cs: readonly string[]): LightLook => ({ kind: "colours", ...coloursVeils(cs), colours: cs });
    const ROWS: [string, LightLook & { pageVeil?: number }, number, number][] = [
      ["the app's own backdrop", { kind: "frosted", ...BRAND_GLASS }, 0.696, 0.67],
      ["the window look, Clear", { kind: "window", ...windowGlass("liquid", "light", "clear") }, 0.22, 0.22],
      ["the window look, Frosted", { kind: "window", ...windowGlass("liquid", "light", "frosted") }, 0.231, 0.7 * 0.12],
      ["a picture", { kind: "picture", ...PICTURE_GLASS }, 0.305, 0.22],
      ["the default colours", colours(DEFAULT_COLOURS), 0.75, 0.65],
      ["cream", colours(["#f7f5ef"]), 0.33, 0.72 * 0.35],
      ["white", colours(["#ffffff"]), 0.305, 0.67 * 0.35],
    ];
    for (const [name, look, now, main] of ROWS) {
      expect(shows(look), name).toBeCloseTo(now, 3);
      expect(shows(look) + 1e-9, name).toBeGreaterThanOrEqual(main);
    }
    // The window look's Clear is at its floor over a white desktop with the ladder's pay: AA and the logic of light
    // leave no room there (the same in Clips Funded's See-through Clear).
    expect(seeThroughVeils("liquid", "light", "clear").panel).toBe(minVeil(WHITE, TEXT_COLOURS_WINDOW));
  });

  it("the light is soft and static: nothing transitions or animates backdrop-filter, and refraction blurs first", () => {
    const moving: string[] = [];
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
      const text = rules(f);
      for (const m of text.matchAll(/transition(?:-property)?:\s*([^;]+);/g)) if (/backdrop-filter|\bfilter\b|\ball\b/.test(m[1]!)) moving.push(`${f}: ${m[0]}`);
      for (const m of text.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) if (/backdrop-filter/.test(m[1]!)) moving.push(`${f}: @keyframes with backdrop-filter`);
    }
    expect(moving).toEqual([]);
    expect(block(glass, ".refract .glass--refract")).toContain("backdrop-filter: blur(var(--glass-refract-blur)) url(#cf-refract) saturate(1.75) brightness(var(--glass-brightness));");
    expect(declared(block(rules("tokens.css"), ":root")).get("--glass-refract-blur")).toBe("18px");
    // The page title plates hold their words by their tint alone: no blur and no bend of their own (at most three
    // refracting surfaces on a screen, e2e/refract.spec.ts), and Money's band blurs without bending.
    expect(glass).not.toMatch(/page-head__text[^{]*\{[^}]*backdrop-filter/);
    expect(glass).not.toMatch(/dash-head__text[^{]*\{[^}]*backdrop-filter/);
    expect(block(glass, ".refract .dash-band.glass--refract")).toContain("backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate)) brightness(var(--glass-brightness));");
    expect(block(glass, ".refract .dash-band.glass--refract")).not.toContain("url(");
    // Reduced transparency: nothing to see through, so nothing to blur or bend.
    expect(glass).toMatch(/\.glass,\s*\.refract \.glass--refract,\s*\.refract \.dash-band\.glass--refract \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/);
  });
});

/** The decoration a selector may keep: focus rings, the found highlight, progress, the switch, spinners, action blinks. */
const EDGE_OK = /focus|is-found|help-ring|spinner|switch|progress|\.ring\b|ring__|act__item|is-running \.timeline__node::before|@keyframes/;

/** `text` without its `@media (forced-colors: active)` blocks: there the system draws its own edges, by design. */
const withoutForcedColors = (text: string) => {
  let out = text;
  for (let at = out.search(/@media\s*\(forced-colors:\s*active\)\s*\{/); at >= 0; at = out.search(/@media\s*\(forced-colors:\s*active\)\s*\{/)) {
    let depth = 0;
    let end = out.indexOf("{", at);
    for (; end < out.length; end++) {
      if (out[end] === "{") depth++;
      if (out[end] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
};

describe("no visible edges (owner, 2026-11-18)", () => {
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, withoutForcedColors(rules(f))] as const);

  it("skips only what forced colours draw: the system's own edges for buttons", () => {
    const text = ".a { color: red; }\n@media (forced-colors: active) {\n  .btn { border: 1px solid ButtonText; }\n  .x:is(.y) { outline: 2px solid; }\n}\n.b { border: 1px solid red; }";
    expect(withoutForcedColors(text)).toBe(".a { color: red; }\n\n.b { border: 1px solid red; }");
  });
  /** Every innermost rule as [selector, body]. */
  const ruleList = (text: string) => [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim().replace(/\s+/g, " "), m[2]!] as const);
  const layers = (v: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of v) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  /** A shadow layer with (almost) no blur and a spread or an offset: a ring or a hard line. */
  const edgeLayer = (layer: string) => {
    if (/^var\(--(shadow|glow|shade|focus)/.test(layer)) return false;
    const lens = layer
      .replace(/(rgba?|color-mix|var)\((?:[^()]|\([^()]*\))*\)/g, " ")
      .replace(/#[0-9a-f]{3,8}|currentColor|transparent|inset/gi, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => parseFloat(t));
    if (lens.some((n) => Number.isNaN(n))) return false;
    const [x = 0, y = 0, blur = 0, spread = 0] = lens;
    return blur <= 2 && (spread !== 0 || x !== 0 || y !== 0);
  };

  it("no stylesheet draws a border, ring or hard line except the allowed ones", () => {
    const found: string[] = [];
    for (const [file, text] of sheets)
      for (const [selector, body] of ruleList(text)) {
        if (EDGE_OK.test(selector) || /^(\d+%|from|to)(\s|,|$)/.test(selector)) continue;
        for (const m of body.matchAll(/(?:^|[;\s])(border(?:-(?:top|bottom|left|right|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?):\s*([^;]+);/g)) {
          const v = m[2]!.trim();
          if (/^(none|0|transparent)$/.test(v) || /\btransparent$/.test(v)) continue;
          found.push(`${file} ${selector} { ${m[1]}: ${v} }`);
        }
        for (const m of body.matchAll(/box-shadow:\s*([^;]+);/g)) for (const l of layers(m[1]!)) if (edgeLayer(l)) found.push(`${file} ${selector} { box-shadow: ${l} }`);
      }
    expect(found).toEqual([]);
  });

  it("the shared shadows, glows and the light are soft (blurred, never a drawn line), and the glass has no lit rim", () => {
    const root = declared(block(rules("tokens.css"), ":root"));
    // Every soft light and shade of the logic of light (ADR-87): the top glows, the bottom shades and the drops.
    const light = [...root.keys()].filter((t) => /^--light-(rim|shade|shadow)(-|$)/.test(t) || t === "--light-press");
    expect(light.length).toBeGreaterThanOrEqual(17);
    for (const t of ["--shadow-1", "--shadow-2", "--glow-bone", "--glow-vermilion", "--glow-leaf", "--shade-field", ...light]) {
      // Aliases (`--shadow-1: var(--light-shadow-1)`) are read through to the layers they name.
      const value = root.get(t)!.replace(/var\((--light-[a-z0-9-]+)\)/g, (whole, n: string) => root.get(n) ?? whole);
      for (const l of layers(value)) {
        expect(edgeLayer(l.replace(/^var/, "x")), `${t}: ${l}`).toBe(false);
        // A real layer: an offset or a blur bigger than 2 px (so no hairline can hide in a token).
        if (!/^var\(/.test(l)) expect(Math.max(...(l.replace(/rgba?\([^)]*\)|inset/g, " ").trim().split(/\s+/).map(parseFloat).slice(2, 3) as number[])), `${t}: ${l}`).toBeGreaterThan(2);
      }
    }
    // The panes' composed light and shadow name only these soft tokens.
    for (const t of ["--glass-shadow-panel", "--glass-shadow-raise", "--glass-shadow-raise-hover", "--glass-shadow-row", "--glass-shadow-press", "--glass-shadow-float", "--glass-shadow-overlay"])
      for (const l of layers(root.get(t)!)) expect(light, `${t}: ${l}`).toContain(/^var\((--[a-z0-9-]+)\)$/.exec(l)![1]!);
    expect(rules("glass.css")).not.toMatch(/\.glass::before/);
  });
});

describe("the old default colours", () => {
  it("read as the new default, as the API does; any other choice stays", () => {
    expect(OLD_DEFAULT_COLOURS).toEqual(["#9caf88", "#f7f5ef", "#e8412c"]);
    expect(currentColours(["#9CAF88", "#f7f5ef", "#e8412c"])).toEqual([...DEFAULT_COLOURS]);
    expect(currentColours(["#f7f5ef", "#9caf88", "#e8412c"])).toEqual(["#f7f5ef", "#9caf88", "#e8412c"]);
    expect(currentColours(["#9caf88", "#f7f5ef"])).toEqual(["#9caf88", "#f7f5ef"]);
    expect(currentColours(undefined)).toEqual([...DEFAULT_COLOURS]);
  });

  it("the API keeps the same trio", () => {
    const py = readFileSync(join(import.meta.dirname, "..", "..", "api", "src", "clipfactory_api", "settings.py"), "utf8");
    const m = py.match(/OLD_DEFAULT_COLOURS = \(([^)]*)\)/);
    expect([...m![1]!.matchAll(/"(#[0-9a-f]{6})"/g)].map((x) => x[1])).toEqual([...OLD_DEFAULT_COLOURS]);
  });
});

describe("a picked swatch's tick", () => {
  it("is white or bottle green, whichever reads better, and always at least 3:1", () => {
    const samples = [...SWATCHES.map((s) => s.hex), "#808080", "#9a9a9a", "#b0b0b0", "#6b8f71", "#c0392b", "#000000", "#ffffff"];
    for (const hex of samples) {
      const rgb = hexToRgb(hex);
      const tick = swatchTickIsDark(hex) ? ON_BONE : WHITE;
      expect(contrast(tick, rgb), hex).toBeGreaterThanOrEqual(3);
    }
    // Sage (the old default) gets the green tick: white on it is only 2.36:1.
    expect(swatchTickIsDark("#9caf88")).toBe(true);
    expect(swatchTickIsDark("#0f372b")).toBe(false);
  });
});

describe("what is drawn", () => {
  const base: LookInput = { mode: "see-through", picture: null, colours: [...DEFAULT_COLOURS], strength: "clear", glass: "none", scheme: "light" };

  it("see-through shows the window glass only when the desktop app has it", () => {
    expect(resolveLook(base)).toEqual({ kind: "frosted", strength: "clear", ...BRAND_GLASS });
    expect(resolveLook({ ...base, strength: "frosted" })).toEqual({ kind: "frosted", strength: "frosted", ...BRAND_GLASS });
    for (const glass of GLASSES) {
      const v = seeThroughVeils(glass, "light", "clear");
      expect(resolveLook({ ...base, glass })).toEqual({ kind: "window", glass, strength: "clear", pageVeil: v.page, panelVeil: v.panel, plateVeil: windowPlateVeil(glass, "light", "clear"), brightness: WINDOW_BRIGHTNESS });
    }
    const d = seeThroughVeils("acrylic", "dark", "frosted");
    expect(resolveLook({ ...base, glass: "acrylic", strength: "frosted", scheme: "dark" })).toMatchObject({ kind: "window", pageVeil: d.page, panelVeil: d.panel, plateVeil: windowPlateVeil("acrylic", "dark", "frosted"), brightness: 1 });
  });

  it("picture uses the picture on this device, or the Clip Factory colours until there is one", () => {
    expect(resolveLook({ ...base, mode: "picture" })).toEqual({ kind: "brand", ...BRAND_GLASS });
    expect(resolveLook({ ...base, mode: "picture", picture: "data:image/jpeg;base64,x", glass: "vibrancy" })).toEqual({
      kind: "picture",
      url: "data:image/jpeg;base64,x",
      pageVeil: PICTURE_PAGE_VEIL,
      panelVeil: PICTURE_PANEL_VEIL,
      plateVeil: PICTURE_PLATE_VEIL,
      brightness: PICTURE_BRIGHTNESS,
    });
  });

  it("colours draws the chosen colours with their veil, even in the desktop app", () => {
    expect(resolveLook({ ...base, mode: "colours", colours: ["#1F2937"], glass: "acrylic" })).toEqual({ kind: "colours", colours: ["#1f2937"], ...coloursVeils(["#1f2937"]) });
  });

  it("only the desktop wrapper can claim real glass", () => {
    expect(readNativeGlass(undefined)).toBe("none");
    expect(readNativeGlass({ __CF_GLASS__: "vibrancy" })).toBe("none");
    expect(readNativeGlass({ __CF_DESKTOP__: true })).toBe("none");
    for (const glass of GLASSES) expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: glass })).toBe(glass);
    expect(readNativeGlass({ __CF_GLASS__: "liquid" })).toBe("none");
    expect(readNativeGlass({ __CF_DESKTOP__: "true", __CF_GLASS__: "liquid" })).toBe("none");
    expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: "none" })).toBe("none");
    // A name this bundle does not know (a newer desktop app, or junk) is "none": the page stays an ordinary page.
    for (const junk of ["<script>", "crystal", "Liquid", "", 7, null, ["liquid"], { toString: () => "liquid" }]) expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: junk })).toBe("none");
  });

  it("knows every name the desktop app can send", () => {
    const rust = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "src", "main.rs"), "utf8");
    const sent = [...rust.matchAll(/Glass::(\w+) => "([a-z]+)",/g)].map((m) => m[2]!);
    expect(sent.sort()).toEqual(["acrylic", "blur", "liquid", "none", "vibrancy"]);
    for (const name of sent) expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: name })).toBe(name);
  });

  it("explains in one plain sentence why see-through looks different here", () => {
    expect(seeThroughNote("vibrancy", true)).toBeNull();
    expect(seeThroughNote("none", false)).toBe(
      "See-through works in the Mac and Windows app. Browsers don't let apps look behind them, so here you get the Clip Factory colours.",
    );
    // On a phone, no promise that getting the app there would help.
    expect(seeThroughNote("none", false, true)).toBe(
      "See-through works in the Mac and Windows app on a computer. Phones don't let apps look behind them, so here you get the Clip Factory colours.",
    );
    expect(seeThroughNote("none", true)).toMatch(/can't show see-through/);
  });

  it("tells an old desktop app (no __CF_GLASS__ at all) from a computer that truly can't show glass", () => {
    // Wrappers built before 2026-11-16 16:54 set only __CF_DESKTOP__.
    expect(isOldDesktopApp({ __CF_DESKTOP__: true })).toBe(true);
    expect(isOldDesktopApp({ __CF_DESKTOP__: true, __CF_GLASS__: undefined })).toBe(true);
    // Every newer wrapper names a glass, "none" included (old Windows): that is a real "can't".
    for (const glass of [...GLASSES, "none", "crystal", ""]) expect(isOldDesktopApp({ __CF_DESKTOP__: true, __CF_GLASS__: glass })).toBe(false);
    // Browsers and phones are never an old app.
    expect(isOldDesktopApp(undefined)).toBe(false);
    expect(isOldDesktopApp({})).toBe(false);
    expect(isOldDesktopApp({ __CF_DESKTOP__: "true" })).toBe(false);
    expect(isOldDesktopApp({ __CF_DESKTOP__: false })).toBe(false);
    // The old app reads as "no glass" for the look, so the page stays an ordinary page.
    expect(readNativeGlass({ __CF_DESKTOP__: true })).toBe("none");
  });

  it("offers the new installer to every desktop app that names no version, see-through or not", () => {
    // Copies built from main between 2026-11-16 and the updater name a glass but no version: they can't update.
    for (const glass of [undefined, ...GLASSES, "none"]) {
      expect(cantSelfUpdate({ __CF_DESKTOP__: true, __CF_GLASS__: glass })).toBe(true);
      expect(cantSelfUpdate({ __CF_DESKTOP__: true, __CF_GLASS__: glass, __CF_DESKTOP_VERSION__: "1.42.0" })).toBe(false);
    }
    expect(cantSelfUpdate({ __CF_DESKTOP__: true, __CF_GLASS__: "liquid", __CF_DESKTOP_VERSION__: "nope" })).toBe(true);
    expect(cantSelfUpdate({ __CF_DESKTOP__: true, __CF_GLASS__: "liquid", __CF_DESKTOP_VERSION__: 142 })).toBe(true);
    // Browsers and phones never are.
    expect(cantSelfUpdate(undefined)).toBe(false);
    expect(cantSelfUpdate({})).toBe(false);
    expect(cantSelfUpdate({ __CF_DESKTOP__: false, __CF_DESKTOP_VERSION__: undefined })).toBe(false);
    expect(readDesktopVersion({ __CF_DESKTOP__: true, __CF_DESKTOP_VERSION__: "1.42.0" })).toBe("1.42.0");
    expect(readDesktopVersion({ __CF_DESKTOP__: false, __CF_DESKTOP_VERSION__: "1.42.0" })).toBeNull();
  });

  it("asks an old desktop app to update, in a few plain words, and keeps every other note", () => {
    expect(OLD_APP_NOTE).toBe("Update the app to see through.");
    expect(seeThroughNote("none", true, false, true)).toBe(OLD_APP_NOTE);
    expect(OLD_APP_NOTE.split(" ").length).toBeLessThanOrEqual(6);
    // A real "none" desktop app (old Windows) keeps its own note.
    expect(seeThroughNote("none", true, false, false)).toBe("This computer can't show see-through, so here you get the Clip Factory colours.");
    // Browsers and phones keep theirs; "old app" means nothing outside the desktop app.
    expect(seeThroughNote("none", false, false, true)).toMatch(/^See-through works in the Mac and Windows app\. Browsers/);
    expect(seeThroughNote("none", false, true, true)).toMatch(/Phones don't let apps look behind them/);
    // Real glass needs no note at all.
    for (const glass of GLASSES) expect(seeThroughNote(glass, true, false, true)).toBeNull();
  });

  it("the desktop app's script names its version, and every newer app names a glass", () => {
    const init = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "src", "init.js"), "utf8");
    expect(init).toContain('if (typeof window.__CF_GLASS__ !== "string") window.__CF_GLASS__ = "none";');
    const rust = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "src", "main.rs"), "utf8");
    expect(rust).toContain("window.__CF_DESKTOP_VERSION__ = ");
  });
});

describe("prefs keep the background choice on this device", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => localStorage.clear());

  it("defaults to see-through, clear glass and the Clip Factory colours", async () => {
    const { getPrefs } = await import("../src/lib/prefs.ts");
    expect(getPrefs()).toMatchObject({ backgroundMode: "see-through", glassStrength: "clear", backgroundColours: [...DEFAULT_COLOURS] });
  });

  it("a device that cached the old default colours shows the new ones before /me loads", async () => {
    localStorage.setItem("cf.prefs", JSON.stringify({ backgroundMode: "colours", backgroundColours: ["#9caf88", "#f7f5ef", "#e8412c"] }));
    const { getPrefs } = await import("../src/lib/prefs.ts");
    expect(getPrefs().backgroundColours).toEqual([...DEFAULT_COLOURS]);
  });

  it("reads back what was saved, and ignores junk", async () => {
    localStorage.setItem("cf.prefs", JSON.stringify({ backgroundMode: "colours", glassStrength: "frosted", backgroundColours: ["#2B6CB0"] }));
    let { getPrefs } = await import("../src/lib/prefs.ts");
    expect(getPrefs()).toMatchObject({ backgroundMode: "colours", glassStrength: "frosted", backgroundColours: ["#2b6cb0"] });

    vi.resetModules();
    localStorage.setItem("cf.prefs", JSON.stringify({ backgroundMode: "window", glassStrength: 2, backgroundColours: "blue" }));
    ({ getPrefs } = await import("../src/lib/prefs.ts"));
    expect(getPrefs()).toMatchObject({ backgroundMode: "see-through", glassStrength: "clear", backgroundColours: [...DEFAULT_COLOURS] });
  });
});

describe("existing pictures survive the upgrade (§22.1)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => localStorage.clear());

  it("a picture saved before see-through, with no mode saved, starts in Picture", async () => {
    localStorage.setItem("cf.background", "data:image/jpeg;base64,x");
    localStorage.setItem("cf.prefs", JSON.stringify({ soundEnabled: true }));
    const { getPrefs } = await import("../src/lib/prefs.ts");
    expect(getPrefs()).toMatchObject({ backgroundMode: "picture", background: "data:image/jpeg;base64,x" });
  });

  it("a mode the owner did save wins over the picture", async () => {
    localStorage.setItem("cf.background", "data:image/jpeg;base64,x");
    localStorage.setItem("cf.prefs", JSON.stringify({ backgroundMode: "see-through" }));
    const { getPrefs } = await import("../src/lib/prefs.ts");
    expect(getPrefs().backgroundMode).toBe("see-through");
  });
});

describe("the page follows the look", () => {
  it("only the desktop window glass makes the page transparent, and the veil goes on <html>", async () => {
    const { applyLook } = await import("../src/lib/look.ts");
    const root = document.createElement("html");
    const liquid = seeThroughVeils("liquid", "light", "clear");
    applyLook({ kind: "window", glass: "liquid", strength: "clear", ...windowGlass("liquid", "light", "clear") }, root);
    expect(root.classList.contains("see-through")).toBe(true);
    expect(root.dataset.backdrop).toBe("window");
    expect(root.dataset.glass).toBe("liquid");
    expect(root.dataset.strength).toBe("clear");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe(String(liquid.panel));
    // Nothing dims the desktop behind the page, so the glass draws no brightness(), and a plate carries the green its
    // words need in its top light (the panel's 0.73 and the pay cover it).
    expect(root.style.getPropertyValue("--plate-veil")).toBe(String(windowPlateVeil("liquid", "light", "clear")));
    expect(root.style.getPropertyValue("--plate-veil")).toBe("0.73");
    expect(root.style.getPropertyValue("--glass-brightness")).toBe("1");
    // And each look's own pay for the ladder of light (lightPay).
    expect(root.style.getPropertyValue("--light-pay")).toBe(String(LIGHT_PAY_WHITE));
    applyLook({ kind: "window", glass: "liquid", strength: "frosted", ...windowGlass("liquid", "light", "frosted") }, root);
    expect(root.dataset.strength).toBe("frosted");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.3");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.62");
    expect(root.style.getPropertyValue("--plate-veil")).toBe("0.62");

    applyLook({ kind: "frosted", strength: "frosted", ...BRAND_GLASS }, root);
    expect(root.classList.contains("see-through")).toBe(false);
    expect(root.dataset.backdrop).toBe("frosted");
    expect(root.dataset.glass).toBeUndefined();
    expect(root.dataset.strength).toBe("frosted");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.2");
    expect(root.style.getPropertyValue("--plate-veil")).toBe("0.33");
    expect(root.style.getPropertyValue("--glass-brightness")).toBe(String(BRAND_BRIGHTNESS));
    expect(root.style.getPropertyValue("--light-pay")).toBe(String(LIGHT_PAY_OWN));

    // White: the glass dims it to half, so the page keeps no veil (it was 0.33 over panels at 0.60).
    applyLook({ kind: "colours", colours: ["#ffffff"], ...coloursVeils(["#ffffff"]) }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.29");
    expect(root.style.getPropertyValue("--plate-veil")).toBe("0.73");
    expect(root.style.getPropertyValue("--glass-brightness")).toBe("0.5");
    expect(root.style.getPropertyValue("--light-pay")).toBe(String(lightPay({ kind: "colours", colours: ["#ffffff"], ...coloursVeils(["#ffffff"]) })));

    // The picture look: no veil over the photo, and its own panel tint, plate tint and dimming.
    applyLook({ kind: "picture", url: "data:x", ...PICTURE_GLASS }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.29");
    expect(root.style.getPropertyValue("--plate-veil")).toBe("0.73");
    expect(root.style.getPropertyValue("--glass-brightness")).toBe("0.5");
  });
});
