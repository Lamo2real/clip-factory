import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AA,
  BONE,
  BRAND_MESH,
  BRAND_PANEL_VEIL,
  brandMeshSpots,
  brandMeshWorst,
  CHIP_DEEPEN,
  COLOURS_BLOB_ALPHA,
  COLOURS_FIELD_END,
  coloursMeshSpots,
  coloursMeshWorst,
  coloursVeil,
  coloursVeils,
  contrast,
  currentColours,
  DEFAULT_COLOURS,
  FLOAT_VEIL,
  FROSTED_EXTRA,
  GLASS_SATURATE,
  GLASS_SATURATE_MAX,
  GLASS_TINT_ALPHA,
  glassCeiling,
  glassChecks,
  glassFloor,
  GREEN_DEEP,
  hexToRgb,
  isHexColour,
  LIQUID_ACTIVE_FLOOR,
  LIQUID_FLOOR,
  LIQUID_MEASURED,
  LIQUID_SAFETY,
  luminance,
  MAX_COLOURS_PANEL_VEIL,
  MAX_FROSTED_PANEL_VEIL,
  mix,
  minVeil,
  normaliseColours,
  OLD_DEFAULT_COLOURS,
  ON_BONE,
  PANEL_VEIL_FLOOR,
  PICTURE_PAGE_VEIL,
  PICTURE_PANEL_VEIL,
  cantSelfUpdate,
  isOldDesktopApp,
  readDesktopVersion,
  OLD_APP_NOTE,
  readNativeGlass,
  resolveLook,
  SATURATIONS,
  saturateRgb,
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
  SWATCHES,
  swatchTickIsDark,
  TABBAR_VEIL,
  TEXT_COLOURS,
  TEXT_COLOURS_WINDOW,
  TEXT_TOKENS,
  TINTED_FLOOR,
  TRACK_EXTRA_VEIL,
  TRACK_LIFT,
  VEIL,
  WINDOW_TEXT_TOKENS,
  type GlassStrength,
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

/** The lowest contrast any text colour gets on `bg`. */
const worst = (bg: Rgb) => Math.min(...TEXT_COLOURS.map((t) => contrast(t, bg)));
const WHITE: Rgb = [255, 255, 255];

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
    expect(PANEL_VEIL_FLOOR).toBe(0.3);
  });

  it("Frosted: a green frost everywhere and heavier panels, so it always shows less than Clear", () => {
    expect(FROSTED_EXTRA).toBe(0.15);
    for (const glass of GLASSES)
      for (const scheme of SCHEMES) {
        const clear = seeThroughVeils(glass, scheme, "clear");
        const frosted = seeThroughVeils(glass, scheme, "frosted");
        expect(frosted.page, `${glass} ${scheme}`).toBe(0.3);
        expect(frosted.panel, `${glass} ${scheme}`).toBeCloseTo(Math.min(MAX_FROSTED_PANEL_VEIL, clear.panel + FROSTED_EXTRA), 10);
        expect(frosted.panel).toBeLessThanOrEqual(0.95);
        expect((1 - frosted.page) * (1 - frosted.panel), `${glass} ${scheme}`).toBeLessThan((1 - clear.page) * (1 - clear.panel));
      }
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
    // glass.css uses the same two numbers, in every look.
    const track = /\n:is\(\.segmented, \.tabs, \.bg-modes, \.model-picks\) \{([^}]*)\}/.exec(rules("glass.css"))![1]!;
    expect(track).toContain(`background-color: rgb(var(--green-rgb) / calc(var(--panel-veil) + ${TRACK_EXTRA_VEIL}))`);
    expect(track).toContain(`rgb(var(--bone-rgb) / ${TRACK_LIFT})`);
  });

  it("words on a tinted chip reach AA: a vermilion or leaf chip lays deep green under its tint", () => {
    const rgb = (token: TextToken) => hexToRgb(WINDOW_TEXT_TOKENS[token]);
    const [VERMILION, LEAF] = [hexToRgb("#e8392b"), hexToRgb("#5fa585")];
    const CHIPS: { name: string; tint: Rgb; alpha: number; texts: readonly Rgb[] }[] = [
      { name: "the vermilion tint (pills, the error sound, callouts)", tint: VERMILION, alpha: 0.2, texts: [rgb("--vermilion-ink"), rgb("--ink")] },
      { name: "the success tint (pills, the tap sound, guesses)", tint: LEAF, alpha: 0.22, texts: [rgb("--green-text"), rgb("--green-ink"), rgb("--ink")] },
    ];
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK)
      for (const chip of CHIPS) {
        const bg = seeThroughChipBackground(glass, scheme, strength, chip.tint, chip.alpha, check.behind);
        for (const t of chip.texts) expect(contrast(t, bg), `${chip.name}, ${at}`).toBeGreaterThanOrEqual(AA);
      }
    // Over white, where it matters, the chip is never lighter than its panel.
    for (const glass of GLASSES)
      for (const chip of CHIPS)
        expect(luminance(seeThroughChipBackground(glass, "light", "clear", chip.tint, chip.alpha)), `${chip.name} ${glass}`).toBeLessThanOrEqual(luminance(seeThroughWorstBackground(glass, "light", "clear")));
    // tokens.css uses the same numbers.
    const tokens = rules("tokens.css");
    expect(GREEN_DEEP).toEqual(hexToRgb("#0a2820"));
    expect(tokens).toContain(`--tint-leaf: linear-gradient(rgb(var(--green-leaf-rgb) / 0.22), rgb(var(--green-leaf-rgb) / 0.22)), rgb(var(--green-deep-rgb) / ${CHIP_DEEPEN});`);
    expect(tokens).toContain(`--tint-vermilion: linear-gradient(rgb(var(--vermilion-rgb) / 0.2), rgb(var(--vermilion-rgb) / 0.2)), rgb(var(--green-deep-rgb) / ${CHIP_DEEPEN});`);
  });

  it("the picture look: no veil over the photo, and panels with enough green for every text colour over a white photo", () => {
    expect([PICTURE_PAGE_VEIL, PICTURE_PANEL_VEIL]).toEqual([0, 0.73]);
    expect(PICTURE_PANEL_VEIL).toBe(minVeil(WHITE));
    expect(worst(mix(VEIL, mix(VEIL, WHITE, PICTURE_PAGE_VEIL), PICTURE_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
    // backdrop-filter saturate() cannot lighten white.
    expect(worst(mix(VEIL, saturateRgb(WHITE, GLASS_SATURATE_MAX), PICTURE_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
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
    "#fff": "white words on a vermilion CTA, badge or count fill of their own",
    "var(--on-bone)": "green words on a bone fill of their own (the selected pill, inverted chips, the tooltip)",
    "var(--green-deep)": "deep green words on a solid leaf fill of their own",
    "#0a64d8": "Safari's blue in the Get the app drawings, on their own bone card",
    "#ffeec4": "the warn pill's words, on the fill and amber ring of their own",
    inherit: "takes the colour around it",
    "var(--kind-text)": "a sound group's tint colour: --green-text or --vermilion-ink (checked below)",
    "var(--kind-on)": "words on a sound group's own solid fill (checked below)",
    "var(--act-tint)": "a button's glyph, for a blink of its action",
    "var(--green-leaf)": "a button's glyph, for a blink of its action",
    "var(--vermilion-light)": "the error toast's icon, a mark rather than words",
    "rgb(255 255 255 / 0.7)": "a CTA that is off: on its own thin vermilion over deep green (checked below)",
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

  /** A tint's alphas, with the floating-layer and tab-bar tokens and their calc() worked out. */
  const tokenValue = (name: string) => Number(declared(block(rules("tokens.css"), ":root")).get(name));
  const tintAlphas = (tint: string) =>
    [
      ...tint
        .replace(/var\((--float-veil|--tabbar-veil)\)/g, (_, t: string) => String(tokenValue(t)))
        .replace(/calc\(([\d.]+) \+ ([\d.]+)\)/g, (_, a: string, b: string) => String(Number(a) + Number(b)))
        .matchAll(/\/\s*([\d.]+)\)/g),
    ].map((a) => Number(a[1]));

  it("the panel tint of the window look gives way to a surface's own denser tint, and never to a weaker one", () => {
    const glass = rules("glass.css");
    // As light as `.glass` itself (:where), so `.toast`, `.sheet.glass`, `.help-panel` and `.star-btn.is-on` keep theirs.
    expect(glass).toMatch(/:where\(html\.see-through\) :is\(\.glass, \.glass--clear\) \{\s*--glass-tint: linear-gradient\(140deg, rgb\(var\(--green-rgb\) \/ var\(--panel-veil\)\), rgb\(var\(--green-rgb\) \/ var\(--panel-veil\)\)\);/);
    expect(glass).not.toMatch(/html\.see-through \.glass[\s,{]/);
    // Every surface with a green tint of its own is at least as strong as the most any glass needs for AA (Clear over
    // white), or is lifted to the panel tint by its own window-look rule. Surfaces that take --panel-veil follow it.
    const most = Math.max(...GLASSES.flatMap((g) => SCHEMES.map((sc) => seeThroughVeils(g, sc, "clear").panel)));
    const lifted: string[] = [];
    for (const [file, text] of sheets) {
      if (file === "glass.css") continue;
      for (const m of text.matchAll(/([^{}]+)\{[^{}]*--glass-tint:\s*([^;]+);/g)) {
        const selector = m[1]!.trim();
        if (m[2]!.trim() === "var(--cta)") continue;
        const alphas = tintAlphas(m[2]!);
        expect(alphas.length, `${file} ${selector}`).toBeGreaterThanOrEqual(2);
        expect(m[2], `${file} ${selector}: a surface tint is bottle green`).toMatch(/var\(--green-rgb\)/);
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
    }
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

  it("the veils split between page and panels and keep every text colour at AA over the lightest spot", () => {
    const TABLE: [string[], number, number][] = [
      [[...DEFAULT_COLOURS], 0, 0.3],
      [["#2b6cb0", "#8e6cc9"], 0, 0.3],
      [["#9caf88", "#f7f5ef", "#e8412c"], 0.03, 0.6],
      [["#f6c945", "#f49ac1"], 0.08, 0.6],
      [["#f7f5ef"], 0.28, 0.6],
      [["#ffffff"], 0.33, 0.6],
    ];
    for (const [cs, page, panel] of TABLE) {
      expect(coloursVeils(cs), cs.join(" ")).toEqual({ pageVeil: page, panelVeil: panel });
      for (const spot of coloursMeshSpots(cs)) expect(worst(mix(VEIL, mix(VEIL, spot, page), panel)), cs.join(" ")).toBeGreaterThanOrEqual(AA);
      expect(luminance(coloursMeshWorst(cs))).toBe(Math.max(...coloursMeshSpots(cs).map(luminance)));
    }
    expect(coloursVeils(DEFAULT_COLOURS)).toEqual({ pageVeil: 0, panelVeil: 0.3 });
    // The deprecated single number is the combined green.
    expect(coloursVeil(["#ffffff"])).toBeCloseTo(1 - (1 - 0.33) * (1 - 0.6), 2);
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
          // The worst spot as seen bare and through every saturate() the CSS uses.
          for (const spot of coloursMeshSpots(cs)) {
            const page = mix(VEIL, spot, v.pageVeil);
            if (worst(mix(VEIL, page, v.panelVeil)) < AA) fails.push(`${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
            // A pick-one track or a control fill straight on the page.
            if (worst(mix(BONE, mix(VEIL, page, Math.min(1, v.panelVeil + TRACK_EXTRA_VEIL)), TRACK_LIFT)) < AA) fails.push(`track: ${cs.join(" ")} over rgb(${spot.map(Math.round).join(" ")})`);
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
    expect(BRAND_PANEL_VEIL).toBe(0.33);
    expect(BRAND_PANEL_VEIL).toBe(Math.max(PANEL_VEIL_FLOOR, ...brandMeshSpots().map((spot) => minVeil(spot))));
    for (const spot of brandMeshSpots()) expect(worst(mix(VEIL, spot, BRAND_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
    for (const sat of SATURATIONS) {
      const spot = brandMeshWorst(sat);
      for (const t of TEXT_COLOURS) expect(contrast(t, mix(VEIL, spot, BRAND_PANEL_VEIL)), `saturate ${sat}`).toBeGreaterThanOrEqual(AA);
      // Bare, that spot is under AA: the reason loose words get the scrim.
      expect(worst(spot)).toBeLessThan(AA);
    }
    // A pick-one track, the control fill, a field, the danger button and a tinted chip over every spot, not only the
    // lightest: mixed in sRGB, a darker spot of another hue can need more.
    for (const spot of brandMeshSpots()) {
      const at = `over rgb(${spot.map(Math.round).join(" ")})`;
      const panel = mix(VEIL, spot, BRAND_PANEL_VEIL);
      expect(worst(mix(BONE, mix(VEIL, spot, BRAND_PANEL_VEIL + TRACK_EXTRA_VEIL), TRACK_LIFT)), `track ${at}`).toBeGreaterThanOrEqual(AA);
      expect(worst(mix(GREEN_DEEP, panel, 0.45)), `field ${at}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(hexToRgb(TEXT_TOKENS["--vermilion-ink"]), mix(hexToRgb("#e8392b"), mix(VEIL, spot, BRAND_PANEL_VEIL + 0.1), 0.14)), `danger ${at}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(hexToRgb("#ffeec4"), mix([246, 201, 69], mix(GREEN_DEEP, panel, CHIP_DEEPEN), 0.16)), `amber chip ${at}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("the see-through has range: the lightest and darkest spots stay told apart through a panel", () => {
    const darkest = BRAND_MESH.field[1]!;
    for (const sat of [GLASS_SATURATE, GLASS_SATURATE_MAX]) expect(contrast(mix(VEIL, brandMeshWorst(sat), BRAND_PANEL_VEIL), mix(VEIL, darkest, BRAND_PANEL_VEIL))).toBeGreaterThanOrEqual(2.5);
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
    expect(block(glass, ".glass")).toContain("backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));");
  });

  it("panels carry no bone sheen (it fails AA at 4.48:1), and nested glass carries no tint of its own", () => {
    const tint = declared(block(glass, ".glass")).get("--glass-tint")!;
    expect(tint).not.toMatch(/bone/);
    expect(worst(mix(BONE, mix(VEIL, brandMeshWorst(GLASS_SATURATE), BRAND_PANEL_VEIL), 0.06))).toBeLessThan(AA);
    expect(glass).toMatch(/:where\(\.glass\) \.glass \{\s*--glass-tint: transparent;/);
  });

  it("loose words get the panel-tint scrim and buttons the control fill in every look", () => {
    expect(glass).toContain("html:is(.see-through, [data-backdrop])");
    expect(glass).not.toContain('[data-backdrop="frosted"]');
    expect(glass).toMatch(/html:where\(\.see-through, \[data-backdrop\]\) :is\(\.btn--glass, \.btn--ghost\) \{\s*background: var\(--fill-control\);/);
    const fill = declared(block(rules("tokens.css"), ":root")).get("--fill-control")!;
    expect(fill).toBe(`linear-gradient(rgb(var(--bone-rgb) / ${TRACK_LIFT}), rgb(var(--bone-rgb) / ${TRACK_LIFT})), rgb(var(--green-rgb) / calc(var(--panel-veil) + ${TRACK_EXTRA_VEIL}))`);
  });
});

/** The decoration a selector may keep: focus rings, the found highlight, progress, the switch, spinners, action blinks. */
const EDGE_OK = /focus|is-found|help-ring|spinner|switch|progress|\.ring\b|ring__|act__item|is-running \.timeline__node::before|@keyframes/;

describe("no visible edges (owner, 2026-11-18)", () => {
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, rules(f)] as const);
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

  it("the shared shadows and glows are soft, and the glass has no lit rim", () => {
    const root = declared(block(rules("tokens.css"), ":root"));
    for (const t of ["--shadow-1", "--shadow-2", "--glow-bone", "--glow-vermilion", "--glow-leaf", "--shade-field"]) for (const l of layers(root.get(t)!)) expect(edgeLayer(l.replace(/^var/, "x")), `${t}: ${l}`).toBe(false);
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
    expect(resolveLook(base)).toEqual({ kind: "frosted", strength: "clear", panelVeil: BRAND_PANEL_VEIL });
    expect(resolveLook({ ...base, strength: "frosted" })).toEqual({ kind: "frosted", strength: "frosted", panelVeil: BRAND_PANEL_VEIL });
    for (const glass of GLASSES) {
      const v = seeThroughVeils(glass, "light", "clear");
      expect(resolveLook({ ...base, glass })).toEqual({ kind: "window", glass, strength: "clear", pageVeil: v.page, panelVeil: v.panel });
    }
    const d = seeThroughVeils("acrylic", "dark", "frosted");
    expect(resolveLook({ ...base, glass: "acrylic", strength: "frosted", scheme: "dark" })).toMatchObject({ kind: "window", pageVeil: d.page, panelVeil: d.panel });
  });

  it("picture uses the picture on this device, or the Clip Factory colours until there is one", () => {
    expect(resolveLook({ ...base, mode: "picture" })).toEqual({ kind: "brand", panelVeil: BRAND_PANEL_VEIL });
    expect(resolveLook({ ...base, mode: "picture", picture: "data:image/jpeg;base64,x", glass: "vibrancy" })).toEqual({
      kind: "picture",
      url: "data:image/jpeg;base64,x",
      pageVeil: PICTURE_PAGE_VEIL,
      panelVeil: PICTURE_PANEL_VEIL,
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
    applyLook({ kind: "window", glass: "liquid", strength: "clear", pageVeil: liquid.page, panelVeil: liquid.panel }, root);
    expect(root.classList.contains("see-through")).toBe(true);
    expect(root.dataset.backdrop).toBe("window");
    expect(root.dataset.glass).toBe("liquid");
    expect(root.dataset.strength).toBe("clear");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe(String(liquid.panel));
    const frosted = seeThroughVeils("liquid", "light", "frosted");
    applyLook({ kind: "window", glass: "liquid", strength: "frosted", pageVeil: frosted.page, panelVeil: frosted.panel }, root);
    expect(root.dataset.strength).toBe("frosted");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.3");
    expect(Number(root.style.getPropertyValue("--panel-veil"))).toBeCloseTo(liquid.panel + 0.15, 10);

    applyLook({ kind: "frosted", strength: "frosted", panelVeil: BRAND_PANEL_VEIL }, root);
    expect(root.classList.contains("see-through")).toBe(false);
    expect(root.dataset.backdrop).toBe("frosted");
    expect(root.dataset.glass).toBeUndefined();
    expect(root.dataset.strength).toBe("frosted");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.33");

    applyLook({ kind: "colours", colours: ["#ffffff"], ...coloursVeils(["#ffffff"]) }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.33");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.6");

    // The picture look: no veil over the photo, and its own panel tint.
    applyLook({ kind: "picture", url: "data:x", pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.73");
  });
});
