import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AA,
  BONE,
  CHIP_DEEPEN,
  coloursVeil,
  contrast,
  DEFAULT_COLOURS,
  FROSTED_EXTRA,
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
  MAX_FROSTED_PANEL_VEIL,
  mix,
  minVeil,
  normaliseColours,
  ON_BONE,
  PANEL_VEIL_FLOOR,
  PICTURE_PAGE_VEIL,
  PICTURE_PANEL_VEIL,
  readNativeGlass,
  resolveLook,
  SELECTED_ALPHA,
  seeThroughChipBackground,
  seeThroughNote,
  seeThroughSelectedBackground,
  seeThroughTrackBackground,
  seeThroughVeils,
  seeThroughWorstBackground,
  SWATCHES,
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
    // Pure white is the hardest: 0.77 for the root text set, 0.73 for the window look's.
    expect(minVeil(WHITE)).toBe(0.77);
    expect(minVeil(WHITE, TEXT_COLOURS_WINDOW)).toBe(0.73);
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
  it("every text colour is light (bone or lighter); the window look lifts the softer ones to bone or lighter", () => {
    for (const c of TEXT_COLOURS) expect(luminance(c)).toBeGreaterThanOrEqual(0.69);
    for (const c of TEXT_COLOURS_WINDOW) expect(luminance(c)).toBeGreaterThanOrEqual(luminance(BONE) - 1e-9);
    const changed = (Object.keys(TEXT_TOKENS) as TextToken[]).filter((t) => WINDOW_TEXT_TOKENS[t] !== TEXT_TOKENS[t]);
    expect(changed).toEqual(["--ink-2", "--ink-3", "--vermilion-ink", "--green-ink", "--green-text"]);
    for (const t of changed) expect(luminance(hexToRgb(WINDOW_TEXT_TOKENS[t])), t).toBeGreaterThan(luminance(hexToRgb(TEXT_TOKENS[t])));
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
    expect(PANEL_VEIL_FLOOR).toBe(0.45);
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

  it("the picture look: a green veil over the photo and green panels, enough for every text colour over a white photo", () => {
    expect([PICTURE_PAGE_VEIL, PICTURE_PANEL_VEIL]).toEqual([0.35, 0.65]);
    expect(worst(mix(VEIL, mix(VEIL, WHITE, PICTURE_PAGE_VEIL), PICTURE_PANEL_VEIL))).toBeGreaterThanOrEqual(AA);
  });
});

describe("the stylesheets and the text colour list stay in step", () => {
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, rules(f)] as const);
  const block = (text: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? "";
  const declared = (body: string) => new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

  it("tokens.css has every text colour with the same value", () => {
    const root = declared(block(rules("tokens.css"), ":root"));
    for (const [token, value] of Object.entries(TEXT_TOKENS)) expect(root.get(token), token).toBe(value);
  });

  it("html.see-through in tokens.css changes exactly the window look's lighter colours", () => {
    const windowLook = declared(block(rules("tokens.css"), "html.see-through"));
    const lighter = Object.fromEntries((Object.keys(TEXT_TOKENS) as TextToken[]).filter((t) => WINDOW_TEXT_TOKENS[t] !== TEXT_TOKENS[t]).map((t) => [t, WINDOW_TEXT_TOKENS[t]]));
    expect(Object.fromEntries(windowLook)).toEqual(lighter);
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
  };

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
        const alphas = [...m[2]!.matchAll(/\/\s*([\d.]+)\)/g)].map((a) => Number(a[1]));
        expect(alphas.length, `${file} ${selector}`).toBeGreaterThanOrEqual(2);
        expect(m[2], `${file} ${selector}: a surface tint is bottle green`).toMatch(/var\(--green-rgb\)/);
        if (Math.min(...alphas) >= most) continue;
        lifted.push(selector);
        expect(glass, `${file} ${selector}: weaker than a panel can need (${most}), so it needs a rule in the window look`).toContain(`html.see-through ${selector} {`);
      }
    }
    expect(lifted).toEqual([".tabbar"]);
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

  it("the veil keeps text at AA on each colour and on the blend between any two", () => {
    const sets = [[...DEFAULT_COLOURS], ["#1f2937"], ["#ff0000", "#00ff00"], ["#f6c945", "#2b6cb0", "#8e6cc9"], ["#fafafa"], ["#ffffff"]];
    for (const set of sets) {
      const veil = coloursVeil(set);
      const rgbs = set.map(hexToRgb);
      const samples: Rgb[] = [...rgbs];
      for (let i = 0; i < rgbs.length; i++) for (let j = i + 1; j < rgbs.length; j++) samples.push(mix(rgbs[i]!, rgbs[j]!, 0.5));
      for (const s of samples) expect(worst(mix(VEIL, s, veil))).toBeGreaterThanOrEqual(AA);
    }
    // Dark colours need no veil at all; light ones need a lot (bone decides the default: 0.74).
    expect(coloursVeil(["#1f2937"])).toBe(0);
    expect(coloursVeil(["#0f372b"])).toBe(0);
    expect(coloursVeil([...DEFAULT_COLOURS])).toBe(0.74);
    expect(coloursVeil(["#ffffff"])).toBe(minVeil(WHITE));
  });
});

describe("what is drawn", () => {
  const base: LookInput = { mode: "see-through", picture: null, colours: [...DEFAULT_COLOURS], strength: "clear", glass: "none", scheme: "light" };

  it("see-through shows the window glass only when the desktop app has it", () => {
    expect(resolveLook(base)).toEqual({ kind: "frosted", strength: "clear" });
    expect(resolveLook({ ...base, strength: "frosted" })).toEqual({ kind: "frosted", strength: "frosted" });
    for (const glass of GLASSES) {
      const v = seeThroughVeils(glass, "light", "clear");
      expect(resolveLook({ ...base, glass })).toEqual({ kind: "window", glass, strength: "clear", pageVeil: v.page, panelVeil: v.panel });
    }
    const d = seeThroughVeils("acrylic", "dark", "frosted");
    expect(resolveLook({ ...base, glass: "acrylic", strength: "frosted", scheme: "dark" })).toMatchObject({ kind: "window", pageVeil: d.page, panelVeil: d.panel });
  });

  it("picture uses the picture on this device, or the Clip Factory colours until there is one", () => {
    expect(resolveLook({ ...base, mode: "picture" })).toEqual({ kind: "brand" });
    expect(resolveLook({ ...base, mode: "picture", picture: "data:image/jpeg;base64,x", glass: "vibrancy" })).toEqual({
      kind: "picture",
      url: "data:image/jpeg;base64,x",
      pageVeil: PICTURE_PAGE_VEIL,
      panelVeil: PICTURE_PANEL_VEIL,
    });
  });

  it("colours draws the chosen colours with their veil, even in the desktop app", () => {
    expect(resolveLook({ ...base, mode: "colours", colours: ["#1F2937"], glass: "acrylic" })).toEqual({ kind: "colours", colours: ["#1f2937"], veil: coloursVeil(["#1f2937"]) });
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

    applyLook({ kind: "frosted", strength: "frosted" }, root);
    expect(root.classList.contains("see-through")).toBe(false);
    expect(root.dataset.backdrop).toBe("frosted");
    expect(root.dataset.glass).toBeUndefined();
    expect(root.dataset.strength).toBe("frosted");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("");

    applyLook({ kind: "colours", colours: ["#ffffff"], veil: 0.77 }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.77");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("");

    // The picture look: a green veil over the photo and its own panel tint.
    applyLook({ kind: "picture", url: "data:x", pageVeil: PICTURE_PAGE_VEIL, panelVeil: PICTURE_PANEL_VEIL }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.35");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.65");
  });
});
