import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AA,
  CHIP_LIFT,
  coloursVeil,
  contrast,
  DEFAULT_COLOURS,
  FROSTED_EXTRA,
  GLASS_TINT_ALPHA,
  glassChecks,
  glassFloor,
  hexToRgb,
  isHexColour,
  LIQUID_ACTIVE_FLOOR,
  LIQUID_FLOOR,
  LIQUID_MEASURED,
  LIQUID_SAFETY,
  luminance,
  MAX_FROSTED_PANEL_VEIL,
  MIN_PANEL_VEIL,
  mix,
  minVeil,
  normaliseColours,
  readNativeGlass,
  resolveLook,
  seeThroughChipBackground,
  seeThroughNote,
  seeThroughTrackBackground,
  seeThroughVeils,
  seeThroughWorstBackground,
  SWATCHES,
  TEXT_COLOURS,
  TEXT_COLOURS_WINDOW,
  TEXT_TOKENS,
  TINTED_FLOOR,
  TRACK_EXTRA_VEIL,
  TRACK_SHADE,
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

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(hexToRgb("#777777"), [255, 255, 255])).toBeCloseTo(4.48, 2);
    // tokens.css says tomato-ink is at least 5.2:1 even on tinted glass; on plain off-white it is well above that.
    expect(contrast(hexToRgb(TEXT_TOKENS["--tomato-ink"]), VEIL)).toBeGreaterThan(5.5);
  });

  it("mixes like a browser composites", () => {
    expect(mix([255, 255, 255], [0, 0, 0], 0.5)).toEqual([127.5, 127.5, 127.5]);
    expect(mix([10, 20, 30], [200, 200, 200], 1)).toEqual([10, 20, 30]);
  });

  it("minVeil is the smallest veil that reaches AA for every text colour", () => {
    for (const under of [[0, 0, 0], [136, 136, 136], hexToRgb("#e8412c"), hexToRgb("#1f2937")] as Rgb[]) {
      const a = minVeil(under);
      expect(worst(mix(VEIL, under, a))).toBeGreaterThanOrEqual(AA);
      if (a > 0) expect(worst(mix(VEIL, under, a - 0.01))).toBeLessThan(AA);
    }
    expect(minVeil(VEIL)).toBe(0);
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

describe("the darkest each window glass can be", () => {
  it("Liquid Glass is planned a tenth darker than the darkest it was measured (another app in use, black behind)", () => {
    // Measured on 2026-11-16 on macOS 27.2 (docs/CONTRACTS.md §22.3). These are records, not knobs.
    expect(LIQUID_MEASURED).toEqual({
      active: { overBlack: [180, 171, 148], overWhite: [249, 248, 245] },
      inactive: { overBlack: [118, 118, 118], overWhite: [225, 225, 225] },
    });
    expect(LIQUID_SAFETY).toBe(0.1);
    const floor = glassFloor("liquid", "light");
    expect(floor).toEqual(LIQUID_FLOOR);
    for (const c of floor) expect(c).toBeCloseTo(118 * 0.9, 10);
    // Darker than anything measured, in use or not.
    expect(luminance(floor)).toBeLessThan(luminance(LIQUID_MEASURED.inactive.overBlack));
    expect(luminance(LIQUID_MEASURED.inactive.overBlack)).toBeLessThan(luminance(LIQUID_ACTIVE_FLOOR));
    expect(LIQUID_ACTIVE_FLOOR).toEqual(LIQUID_MEASURED.active.overBlack);
  });

  it("Windows blur is the desktop app's own tint over black, worked out rather than rounded", () => {
    // desktop/src-tauri/src/main.rs: GLASS_TINT = Color(247, 245, 239, 140).
    expect(GLASS_TINT_ALPHA).toBeCloseTo(140 / 255, 10);
    expect(TINTED_FLOOR[0]).toBeCloseTo(135.6, 1);
    expect(TINTED_FLOOR[1]).toBeCloseTo(134.5, 1);
    expect(TINTED_FLOOR[2]).toBeCloseTo(131.2, 1);
    expect(glassFloor("blur", "light")).toEqual(TINTED_FLOOR);
    const rust = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "src", "main.rs"), "utf8");
    const tint = /const GLASS_TINT: Color = Color\((\d+), (\d+), (\d+), (\d+)\);/.exec(rust)!.slice(1).map(Number);
    expect(tint).toEqual([...VEIL, Math.round(GLASS_TINT_ALPHA * 255)]);
  });

  it("the glasses nobody has measured (Windows 11 acrylic, mica, macOS 15 vibrancy) promise nothing: black", () => {
    for (const glass of ["acrylic", "mica", "vibrancy"] as const) expect(glassFloor(glass, "light")).toEqual([0, 0, 0]);
  });

  it("a dark setting is black for every glass", () => {
    for (const glass of GLASSES) expect(glassFloor(glass, "dark")).toEqual([0, 0, 0]);
  });

  it("Liquid Glass in the light setting is also checked against both measured floors", () => {
    expect(glassChecks("liquid", "light").map((c) => c.behind)).toEqual([LIQUID_FLOOR, [255, 255, 255], [180, 171, 148], [118, 118, 118]]);
    expect(glassChecks("liquid", "dark").map((c) => c.behind)).toEqual([[0, 0, 0], [255, 255, 255]]);
    expect(glassChecks("acrylic", "light").map((c) => c.behind)).toEqual([[0, 0, 0], [255, 255, 255]]);
    expect(glassChecks("blur", "light").map((c) => c.behind)).toEqual([TINTED_FLOOR, [255, 255, 255]]);
  });
});

describe("the window look's text colours", () => {
  /** Hue in degrees. */
  const hue = ([r, g, b]: Rgb) => {
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    const d = max - min || 1;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const DEEPER: TextToken[] = ["--ink-3", "--tomato-ink", "--sage-ink", "--sage-text"];

  it("only the four lightest change; each goes deeper, to a relative luminance of 0.047 or less", () => {
    const changed = (Object.keys(TEXT_TOKENS) as TextToken[]).filter((t) => WINDOW_TEXT_TOKENS[t] !== TEXT_TOKENS[t]);
    expect(changed).toEqual(DEEPER);
    for (const t of DEEPER) {
      expect(luminance(hexToRgb(WINDOW_TEXT_TOKENS[t])), t).toBeLessThanOrEqual(0.047);
      expect(luminance(hexToRgb(WINDOW_TEXT_TOKENS[t])), t).toBeLessThan(luminance(hexToRgb(TEXT_TOKENS[t])));
    }
    // Nothing in the set is lighter than that, so one panel tint fits them all.
    for (const c of TEXT_COLOURS_WINDOW) expect(luminance(c)).toBeLessThanOrEqual(0.047);
    expect(TEXT_COLOURS_WINDOW).toHaveLength(Object.keys(TEXT_TOKENS).length);
  });

  it("each stays its own colour: grey-green, tomato and sage keep their hue and can be told apart", () => {
    for (const t of DEEPER) {
      const turn = Math.abs(hue(hexToRgb(WINDOW_TEXT_TOKENS[t])) - hue(hexToRgb(TEXT_TOKENS[t])));
      expect(Math.min(turn, 360 - turn), t).toBeLessThanOrEqual(12);
    }
    const [ink3, tomato, sage] = (["--ink-3", "--tomato-ink", "--sage-ink"] as const).map((t) => hexToRgb(WINDOW_TEXT_TOKENS[t]));
    // Tomato is red (red leads green by a lot); sage is clearly greener than the grey-green meta colour.
    expect(tomato![0] - tomato![1]).toBeGreaterThan(60);
    expect(sage![1] - sage![2]).toBeGreaterThan(2 * (ink3![1] - ink3![2]));
  });
});

describe("see-through veil", () => {
  it("Clear: nothing between the panels; a panel carries the least that keeps every text colour at AA on the darkest glass", () => {
    for (const glass of GLASSES)
      for (const scheme of SCHEMES) {
        const v = seeThroughVeils(glass, scheme, "clear");
        const least = minVeil(glassFloor(glass, scheme), TEXT_COLOURS_WINDOW);
        expect(v.page, `${glass} ${scheme}`).toBe(0);
        expect(v.panel, `${glass} ${scheme}`).toBe(Math.max(MIN_PANEL_VEIL, least));
        // The least really is the least: one step lighter and a text colour drops under AA.
        if (least > 0) expect(worstInWindow(mix(VEIL, glassFloor(glass, scheme), least - 0.01)), `${glass} ${scheme}`).toBeLessThan(AA);
      }
  });

  it("Liquid Glass panels are well under half solid; the unmeasured glasses stay careful; a panel is never less than a pane", () => {
    const liquid = seeThroughVeils("liquid", "light", "clear").panel;
    const black = seeThroughVeils("vibrancy", "light", "clear").panel;
    const blur = seeThroughVeils("blur", "light", "clear").panel;
    expect(liquid).toBeGreaterThanOrEqual(0.4);
    expect(liquid).toBeLessThanOrEqual(0.48);
    expect(black).toBeGreaterThanOrEqual(0.62);
    expect(black).toBeLessThanOrEqual(0.72);
    for (const glass of ["acrylic", "mica"] as const) expect(seeThroughVeils(glass, "light", "clear").panel).toBe(black);
    // Blur's floor is the lightest, so it would need the least; the floor for "still a pane" holds it up.
    expect(minVeil(TINTED_FLOOR, TEXT_COLOURS_WINDOW)).toBeLessThan(MIN_PANEL_VEIL);
    expect(blur).toBe(MIN_PANEL_VEIL);
    expect(MIN_PANEL_VEIL).toBe(0.35);
    expect(blur).toBeLessThan(liquid);
    expect(liquid).toBeLessThan(black);
    // The deeper text colours are what makes this possible: with the usual ones a panel would need far more.
    expect(minVeil(LIQUID_FLOOR)).toBeGreaterThan(liquid + 0.1);
  });

  it("Frosted: a light frost everywhere and heavier panels, so it always shows less than Clear", () => {
    expect(FROSTED_EXTRA).toBe(0.15);
    for (const glass of GLASSES)
      for (const scheme of SCHEMES) {
        const clear = seeThroughVeils(glass, scheme, "clear");
        const frosted = seeThroughVeils(glass, scheme, "frosted");
        expect(frosted.page, `${glass} ${scheme}`).toBe(0.3);
        expect(frosted.panel, `${glass} ${scheme}`).toBeCloseTo(Math.min(MAX_FROSTED_PANEL_VEIL, clear.panel + FROSTED_EXTRA), 10);
        expect(frosted.panel).toBeLessThanOrEqual(0.95);
        // What shows through a panel: (1 - page) × (1 - panel). And between the panels: 1 - page.
        expect((1 - frosted.page) * (1 - frosted.panel), `${glass} ${scheme}`).toBeLessThan((1 - clear.page) * (1 - clear.panel));
        expect(1 - frosted.page).toBeLessThan(1 - clear.page);
      }
  });

  it("every text colour of the window look reaches AA on a panel: every glass, setting and strength, over its floor, over white, and for Liquid Glass over both measured floors", () => {
    expect(EVERY_LOOK.length).toBe(GLASSES.length * 2 * 2 * 2 + 2 * 2);
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK) expect(worstInWindow(seeThroughWorstBackground(glass, scheme, strength, check.behind)), at).toBeGreaterThanOrEqual(AA);
  });

  it("a pick-one track's labels reach AA on its shade, even when the track sits straight on the window", () => {
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK) expect(worstInWindow(seeThroughTrackBackground(glass, scheme, strength, check.behind)), at).toBeGreaterThanOrEqual(AA);
    // glass.css uses the same two numbers.
    const track = /html\.see-through :is\(\.segmented, \.tabs, \.bg-modes, \.model-picks\) \{([^}]*)\}/.exec(rules("glass.css"))![1]!;
    expect(track).toContain(`background-color: rgb(var(--offwhite-rgb) / calc(var(--panel-veil) + ${TRACK_EXTRA_VEIL}))`);
    expect(track).toContain(`rgb(var(--ink-rgb) / ${TRACK_SHADE})`);
  });

  it("words on a tinted chip reach AA: over the darkest glass an ink or tomato chip is never darker than its panel", () => {
    const rgb = (token: TextToken) => hexToRgb(WINDOW_TEXT_TOKENS[token]);
    const [INK, TOMATO, SAGE] = [hexToRgb("#1e2a1b"), hexToRgb("#e8412c"), hexToRgb("#9caf88")];
    const every = TEXT_COLOURS_WINDOW;
    /** Each tint the stylesheets lay under words on a panel, with the text colours written on it. */
    const CHIPS: { name: string; tint: Rgb; alpha: number; texts: readonly Rgb[] }[] = [
      { name: "the tomato pill and the error sound's tag", tint: TOMATO, alpha: 0.14, texts: [rgb("--tomato-ink")] },
      { name: "If you need it", tint: INK, alpha: 0.07, texts: [rgb("--ink-3")] },
      { name: "a code word", tint: INK, alpha: 0.08, texts: [rgb("--ink"), rgb("--ink-2")] },
      { name: "no video yet", tint: INK, alpha: 0.1, texts: [rgb("--ink-2")] },
      { name: "a clip tile without a cover", tint: INK, alpha: 0.12, texts: [rgb("--ink-2")] },
      { name: "the fixes list", tint: TOMATO, alpha: 0.08, texts: every },
      { name: "the setting that was found", tint: TOMATO, alpha: 0.09, texts: every },
      { name: "the tap sound's tag", tint: SAGE, alpha: 0.4, texts: [rgb("--sage-text"), rgb("--ink")] },
    ];
    for (const { glass, scheme, strength, check, at } of EVERY_LOOK)
      for (const chip of CHIPS) {
        const bg = seeThroughChipBackground(glass, scheme, strength, chip.tint, chip.alpha, check.behind);
        for (const t of chip.texts) expect(contrast(t, bg), `${chip.name}, ${at}`).toBeGreaterThanOrEqual(AA);
      }
    // On the darkest glass (where it matters) the wash makes up for an ink or tomato tint in full.
    for (const glass of GLASSES)
      for (const chip of CHIPS.filter((c) => c.tint !== SAGE))
        expect(luminance(seeThroughChipBackground(glass, "light", "clear", chip.tint, chip.alpha)), `${chip.name} ${glass}`).toBeGreaterThanOrEqual(luminance(seeThroughWorstBackground(glass, "light", "clear")));
    // glass.css uses the same number.
    expect(rules("glass.css")).toContain(`background-image: linear-gradient(rgb(255 255 255 / ${CHIP_LIFT}), rgb(255 255 255 / ${CHIP_LIFT}));`);
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

  it("html.see-through in tokens.css changes exactly the window look's deeper colours", () => {
    const windowLook = declared(block(rules("tokens.css"), "html.see-through"));
    const deeper = Object.fromEntries((Object.keys(TEXT_TOKENS) as TextToken[]).filter((t) => WINDOW_TEXT_TOKENS[t] !== TEXT_TOKENS[t]).map((t) => [t, WINDOW_TEXT_TOKENS[t]]));
    expect(Object.fromEntries(windowLook)).toEqual(deeper);
  });

  /**
   * Text colours that are not in the list, each with the reason it never sits on a bare panel tint (or the rule
   * that covers it in the window look). A colour that is not a token and not named here fails the test below.
   */
  const NOT_ON_A_PANEL_TINT: Record<string, string> = {
    "#fff": "white words on a tomato, deep sage or ink fill of their own",
    "var(--offwhite)": "off-white words on an ink fill of their own",
    "#eef1e7": "code on its own ink block",
    "#7a3b0f": "the warn pill, on its own solid fill",
    "#0a64d8": "the blue in the Get the app drawings, on their own white",
    inherit: "takes the colour around it",
    "var(--kind-text, var(--kind))": "a sound group's own colour: --sage-text or --tomato-ink (checked below)",
    "var(--tomato-deep)": "a mark, not words; on a panel the window look turns it to --tomato-ink (checked below)",
    "var(--act-tint)": "a button's glyph, for a blink of its action",
    "var(--sage)": "a button's glyph, for a blink of its action",
    "#5f6a5a": "placeholders; the window look turns them to --ink-3 (checked below)",
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

  it("the exceptions that can sit on a panel are covered by a rule in the window look", () => {
    const glass = rules("glass.css");
    expect(block(glass, "html.see-through ::placeholder")).toMatch(/color:\s*var\(--ink-3\);\s*opacity:\s*1;/);
    expect(block(glass, "html.see-through .checklist__items .is-fail > .icon")).toMatch(/color:\s*var\(--tomato-ink\);/);
    // The sound groups' own colours are text colours of the list.
    const settings = rules("settings.css");
    expect(declared(block(settings, ".sound-group.is-tap")).get("--kind-text")).toBe("var(--sage-text)");
    expect(declared(block(settings, ".sound-group.is-deny")).get("--kind")).toBe("var(--tomato-ink)");
    expect(declared(block(settings, ".sound-group.is-deny")).has("--kind-text")).toBe(false);
  });

  it("the panel tint of the window look gives way to a surface's own denser tint, and never to a weaker one", () => {
    const glass = rules("glass.css");
    // As light as `.glass` itself (:where), so `.toast`, `.sheet.glass`, `.help-panel` and `.star-btn.is-on` keep theirs.
    expect(glass).toMatch(/:where\(html\.see-through\) :is\(\.glass, \.glass--clear\) \{\s*--glass-tint: linear-gradient\(140deg, rgb\(255 255 255 \/ var\(--panel-veil\)\), rgb\(var\(--offwhite-rgb\) \/ var\(--panel-veil\)\)\);/);
    expect(glass).not.toMatch(/html\.see-through \.glass[\s,{]/);
    // It comes after the recipes it replaces (same weight, so the later rule wins).
    expect(glass.indexOf(":where(html.see-through) :is(.glass, .glass--clear)")).toBeGreaterThan(glass.indexOf("\n.glass--clear {"));
    // Every surface with a tint of its own is at least as strong as the most any glass needs for AA (Clear on a
    // black floor), or is lifted to the panel tint by its own window-look rule.
    const most = Math.max(...GLASSES.flatMap((g) => SCHEMES.map((sc) => seeThroughVeils(g, sc, "clear").panel)));
    const lifted: string[] = [];
    for (const [file, text] of sheets) {
      if (file === "glass.css") continue;
      for (const m of text.matchAll(/([^{}]+)\{[^{}]*--glass-tint:\s*linear-gradient\(([^;]+);/g)) {
        const selector = m[1]!.trim();
        const alphas = [...m[2]!.matchAll(/\/\s*([\d.]+)\)/g)].map((a) => Number(a[1]));
        expect(alphas.length, `${file} ${selector}`).toBeGreaterThanOrEqual(2);
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
    expect(isHexColour("#9caf88")).toBe(true);
    expect(isHexColour("9caf88")).toBe(false);
  });

  it("every swatch is a valid colour with a name, and the defaults are the Clip Factory colours", () => {
    expect(SWATCHES.every((s) => isHexColour(s.hex) && s.name.length > 0)).toBe(true);
    expect(SWATCHES.slice(0, 3).map((s) => s.hex)).toEqual([...DEFAULT_COLOURS]);
  });

  it("the veil keeps text at AA on each colour and on the blend between any two", () => {
    const sets = [[...DEFAULT_COLOURS], ["#1f2937"], ["#ff0000", "#00ff00"], ["#f6c945", "#2b6cb0", "#8e6cc9"], ["#f7f5ef"]];
    for (const set of sets) {
      const veil = coloursVeil(set);
      const rgbs = set.map(hexToRgb);
      const samples: Rgb[] = [...rgbs];
      for (let i = 0; i < rgbs.length; i++) for (let j = i + 1; j < rgbs.length; j++) samples.push(mix(rgbs[i]!, rgbs[j]!, 0.5));
      for (const s of samples) expect(worst(mix(VEIL, s, veil))).toBeGreaterThanOrEqual(AA);
    }
    // Light colours need no veil at all; Night needs a lot (0.75 with today's text colours).
    expect(coloursVeil(["#f7f5ef"])).toBe(0);
    expect(coloursVeil(["#1f2937"])).toBe(minVeil(hexToRgb("#1f2937")));
    expect(coloursVeil(["#1f2937"])).toBeGreaterThan(0.7);
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
    expect(resolveLook({ ...base, mode: "picture", picture: "data:image/jpeg;base64,x", glass: "vibrancy" })).toEqual({ kind: "picture", url: "data:image/jpeg;base64,x" });
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

    applyLook({ kind: "colours", colours: ["#1f2937"], veil: 0.84 }, root);
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0.84");
  });
});
