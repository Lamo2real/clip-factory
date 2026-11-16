import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AA,
  coloursVeil,
  contrast,
  DEFAULT_COLOURS,
  GLASS_TINT_ALPHA,
  glassFloor,
  hexToRgb,
  isHexColour,
  mix,
  minVeil,
  normaliseColours,
  readNativeGlass,
  resolveLook,
  seeThroughNote,
  seeThroughVeils,
  seeThroughWorstBackground,
  SWATCHES,
  TINTED_FLOOR,
  TEXT_COLOURS,
  VEIL,
  type LookInput,
  type Rgb,
} from "../src/lib/background.ts";

/** The lowest contrast any text colour gets on `bg`. */
const worst = (bg: Rgb) => Math.min(...TEXT_COLOURS.map((t) => contrast(t, bg)));

describe("contrast maths", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(hexToRgb("#777777"), [255, 255, 255])).toBeCloseTo(4.48, 2);
    // tokens.css says tomato-ink is 5.5:1 on light glass; on off-white it is a little more.
    expect(contrast(hexToRgb("#a92b1b"), VEIL)).toBeGreaterThan(5.5);
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

describe("see-through veil", () => {
  const GLASSES = ["vibrancy", "acrylic", "blur"] as const;

  it("the tinted floor is the desktop app's own tint over black, worked out rather than rounded", () => {
    // desktop/src-tauri/src/main.rs: GLASS_TINT = Color(247, 245, 239, 140).
    expect(GLASS_TINT_ALPHA).toBeCloseTo(140 / 255, 10);
    expect(TINTED_FLOOR[0]).toBeCloseTo(135.6, 1);
    expect(TINTED_FLOOR[1]).toBeCloseTo(134.5, 1);
    expect(TINTED_FLOOR[2]).toBeCloseTo(131.2, 1);
    // #888888 would have been a little too kind: tomato-ink fell to 4.49 at the old 0.67.
    expect(minVeil(TINTED_FLOOR)).toBe(0.68);
  });

  it("only Windows blur keeps the app's tint; Windows 11 acrylic and macOS glass promise nothing, so assume black", () => {
    expect(glassFloor("blur", "light")).toEqual(TINTED_FLOOR);
    expect(glassFloor("acrylic", "light")).toEqual([0, 0, 0]);
    expect(glassFloor("vibrancy", "light")).toEqual([0, 0, 0]);
    expect(glassFloor("blur", "dark")).toEqual([0, 0, 0]);
  });

  it("keeps every text colour at AA on the darkest each glass can be, light and dark, Clear and Frosted", () => {
    for (const glass of GLASSES)
      for (const scheme of ["light", "dark"] as const)
        for (const strength of ["clear", "frosted"] as const)
          expect(worst(seeThroughWorstBackground(glass, scheme, strength)), `${glass} ${scheme} ${strength}`).toBeGreaterThanOrEqual(AA);
  });

  it("Clear leaves the gaps between panels untouched; Frosted frosts them and shows less through the panels too", () => {
    for (const glass of GLASSES) {
      const clear = seeThroughVeils(glass, "light", "clear");
      const frosted = seeThroughVeils(glass, "light", "frosted");
      expect(clear.page).toBe(0);
      expect(frosted.page).toBeGreaterThan(0);
      // What shows through a panel: (1 - page) × (1 - panel).
      expect((1 - frosted.page) * (1 - frosted.panel)).toBeLessThan((1 - clear.page) * (1 - clear.panel));
      expect(frosted.panel).toBeLessThanOrEqual(0.95);
    }
    expect(seeThroughVeils("blur", "light", "clear").panel).toBe(0.68);
    expect(seeThroughVeils("vibrancy", "light", "clear").panel).toBe(minVeil([0, 0, 0]));
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
    // Light colours need no veil at all; Night needs a lot.
    expect(coloursVeil(["#f7f5ef"])).toBe(0);
    expect(coloursVeil(["#1f2937"])).toBeGreaterThan(0.75);
  });
});

describe("what is drawn", () => {
  const base: LookInput = { mode: "see-through", picture: null, colours: [...DEFAULT_COLOURS], strength: "clear", glass: "none", scheme: "light" };

  it("see-through shows the window glass only when the desktop app has it", () => {
    expect(resolveLook(base)).toEqual({ kind: "frosted", strength: "clear" });
    expect(resolveLook({ ...base, strength: "frosted" })).toEqual({ kind: "frosted", strength: "frosted" });
    const v = seeThroughVeils("vibrancy", "light", "clear");
    expect(resolveLook({ ...base, glass: "vibrancy" })).toEqual({ kind: "window", glass: "vibrancy", strength: "clear", pageVeil: v.page, panelVeil: v.panel });
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
    expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: "acrylic" })).toBe("acrylic");
    expect(readNativeGlass({ __CF_DESKTOP__: true, __CF_GLASS__: "<script>" })).toBe("none");
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
    applyLook({ kind: "window", glass: "vibrancy", strength: "clear", pageVeil: 0, panelVeil: 0.86 }, root);
    expect(root.classList.contains("see-through")).toBe(true);
    expect(root.dataset.backdrop).toBe("window");
    expect(root.dataset.glass).toBe("vibrancy");
    expect(root.dataset.strength).toBe("clear");
    expect(root.style.getPropertyValue("--backdrop-veil")).toBe("0");
    expect(root.style.getPropertyValue("--panel-veil")).toBe("0.86");

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
