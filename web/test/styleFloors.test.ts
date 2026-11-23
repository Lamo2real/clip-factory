// Size, contrast and layout floors from the UI audit (F019, F032, F033, F042, F043, F044, F068). The e2e spec
// web/e2e/audit-shell.spec.ts measures the same things in a real browser.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHIP_DEEPEN, CHIP_UNDER, dimRgb, luminance as lum, mix, PICTURE_BRIGHTNESS, PICTURE_PANEL_VEIL, seeThroughVeils, VEIL, type Rgb } from "../src/lib/background.ts";

const STYLES = join(import.meta.dirname, "..", "src", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8");
const all = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .map((f) => [f, css(f)] as const);

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(text: string, selector: string): string {
  const at = text.indexOf(`\n${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf("}", at));
}

function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const WHITE: Rgb = [255, 255, 255];
/**
 * The lightest panels any look allows, each at the AA floor: the window's Clear over a white desktop (0.73 green, no
 * web filter dims it) and a pane over a white photo, which its own brightness() dims to half (0.59 green). The second
 * is the lighter (luminance 0.139 against 0.136), so both are checked.
 */
const LIGHTEST_PANELS: readonly Rgb[] = [mix(VEIL, WHITE, seeThroughVeils("liquid", "light", "clear").panel), mix(VEIL, dimRgb(WHITE, PICTURE_BRIGHTNESS), PICTURE_PANEL_VEIL)];

describe("type and target floors", () => {
  it("no text is set below the smallest token, --fs-xs (0.78rem)", () => {
    const tiny: string[] = [];
    for (const [file, text] of all)
      for (const m of text.matchAll(/font-size:\s*(0?\.\d+)rem/g)) if (Number(m[1]) < 0.78) tiny.push(`${file}: ${m[0]}`);
    expect(tiny).toEqual([]);
  });

  it("text links are at least 44 px tall at every width", () => {
    expect(rule(css("base.css"), ".text-link")).toMatch(/min-height:\s*44px/);
  });

  it("the page that takes focus after a route change draws no ring", () => {
    const base = css("base.css");
    const at = base.indexOf(".main:focus-visible");
    expect(at).toBeGreaterThan(0);
    expect(base.slice(at, base.indexOf("}", at))).toMatch(/outline:\s*none/);
  });

  it("Home's rows lay out by Home's own width and never stretch a card to a taller neighbour", () => {
    const screens = css("screens.css");
    expect(screens).toMatch(/\.home \{[^}]*container: home \/ inline-size;/);
    expect(screens).toMatch(/\.home-row \{[^}]*align-items: start;/);
    // The old side-by-side heading column (the reason short cards were stretched) is gone from every row.
    expect(screens).not.toMatch(/minmax\(200px, 0\.9fr\)/);
    // No Home row (any section with class "home-row X" under screens/home) puts its boxes beside the heading block with
    // a grid of its own, in any style file: that is what stretched a short box to the heading's height. Only the review
    // row's views total may stand beside it (inside the `home` container rule, bottom-aligned).
    const home = join(import.meta.dirname, "..", "src", "screens", "home");
    const rows = new Set<string>();
    for (const f of readdirSync(home).filter((n) => n.endsWith(".tsx")))
      for (const m of readFileSync(join(home, f), "utf8").matchAll(/className="home-row ([\w-]+)/g)) rows.add(m[1]!);
    expect([...rows]).toEqual(expect.arrayContaining(["home-row--review", "money-tile", "streamers-row", "cr-row"]));
    for (const cls of rows)
      for (const [file, text] of all) {
        // Rules for the row itself (not what is inside it, such as the views total's own number-and-lines grid).
        const grids = text.match(new RegExp(`\\.${cls}\\s*\\{[^}]*grid-template-columns`, "g")) ?? [];
        expect(grids.length, `${file}: .${cls} sets its own columns`).toBe(cls === "home-row--review" && file === "screens.css" ? 1 : 0);
      }
  });

  it("Home's review teasers run one row of 2 to 6 equal covers and draw only the ones that fit (no empty column)", () => {
    const screens = css("screens.css");
    expect(screens).toMatch(/\.home-row__cards \{\s*--cols: 2;[^}]*display: flex;/);
    // One short of a full row still fills it; fewer keep their usual size (240 px at most) instead of blowing up.
    expect(screens).toMatch(/\.home-row__cards > \* \{[^}]*flex: 1 1 0;[^}]*max-width: min\(240px, \(100% - \(var\(--grow-cols\) - 1\) \* 12px\) \/ var\(--grow-cols\)\);/);
    for (const [cols, hide] of [
      [3, 4],
      [4, 5],
      [5, 6],
    ])
      expect(screens).toMatch(new RegExp(`--cols: ${cols};\\s*\\}\\s*\\.home-row__cards > :nth-child\\(n \\+ ${hide}\\) \\{\\s*display: none;`));
    expect(screens).toMatch(/@container home \(max-width: 419\.98px\) \{\s*\.home-row__cards > :nth-child\(n \+ 3\) \{\s*display: none;/);
    expect(screens).toMatch(/@container home \(min-width: 1060px\) \{\s*\.home-row__cards \{\s*--cols: 6;/);
  });
});

describe("vermilion and green words stay AA on tinted glass", () => {
  it("--vermilion-ink and --green-text are at least 4.5:1 on their tints over the lightest panel any look allows", () => {
    const value = (token: string) => new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i").exec(css("tokens.css"))![1]!;
    // The lightest panels any look allows (LIGHTEST_PANELS; no page veil since ADR-45). A chip lays bottle green under
    // its tint (CHIP_UNDER, ADR-87; it was deep green).
    expect(lum(LIGHTEST_PANELS[1]!)).toBeGreaterThan(lum(LIGHTEST_PANELS[0]!));
    const over = (top: number[], under: number[], a: number) => top.map((c, i) => c * a + under[i]! * (1 - a));
    const hex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    for (const panel of LIGHTEST_PANELS) {
      const chip = (tint: number[], a: number) => hex(over(tint, over([...CHIP_UNDER], [...panel], CHIP_DEEPEN), a));
      expect(contrast(value("--vermilion-ink"), chip([232, 57, 43], 0.2))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(value("--green-text"), chip([95, 165, 133], 0.22))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(value("--ink-3"), hex([...panel]))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the comfort halo", () => {
  it("never sits behind dark green words on a bone fill: every rule with --on-bone words drops it", () => {
    const missing: string[] = [];
    for (const [file, text] of all)
      for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g))
        if (/(^|[\s;])color: var\(--on-bone\);/.test(m[2]!) && !/text-shadow: none;/.test(m[2]!)) missing.push(`${file}: ${m[1]!.trim()}`);
    expect(missing).toEqual([]);
  });
});

describe("placeholders read as hints", () => {
  const tokens = css("tokens.css");
  const placeholder = /--placeholder:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!;
  const ink = /--ink:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!;
  it("is at least 3:1 on the lightest field any look allows, and clearly dimmer than typed text", () => {
    const over = (top: number[], under: number[], a: number) => top.map((c, i) => c * a + under[i]! * (1 - a));
    const hex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    for (const panel of LIGHTEST_PANELS) {
      const field = hex(over([10, 40, 32], [...panel], 0.45));
      expect(contrast(placeholder, field)).toBeGreaterThanOrEqual(3);
      expect(contrast(ink, field) / contrast(placeholder, field)).toBeGreaterThanOrEqual(1.5);
    }
    expect(contrast(ink, placeholder)).toBeGreaterThanOrEqual(1.8);
    expect(placeholder.toLowerCase()).not.toBe(ink.toLowerCase());
  });
  it("is set app-wide with Firefox's own dimming normalised", () => {
    const base = css("base.css");
    expect(base).toMatch(/input::placeholder,\s*textarea::placeholder \{\s*color: var\(--placeholder\);\s*opacity: 1;/);
    expect(base).toMatch(/::-webkit-input-placeholder/);
  });
  it("no rule still colours a placeholder with the typed-text ink", () => {
    for (const [file, text] of all) expect(text, file).not.toMatch(/::placeholder \{[^}]*var\(--ink/);
  });
});
