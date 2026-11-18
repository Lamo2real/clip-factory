// Size, contrast and layout floors from the UI audit (F019, F032, F033, F042, F043, F044, F068). The e2e spec
// web/e2e/audit-shell.spec.ts measures the same things in a real browser.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("Home's review teasers fill exactly three columns from 600 px (no empty column)", () => {
    expect(css("screens.css")).toMatch(/@media \(min-width: 600px\) \{\s*\.home-row__cards \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  });
});

describe("vermilion and green words stay AA on tinted glass", () => {
  it("--vermilion-ink and --green-text are at least 4.5:1 on their tints over the lightest panel any look allows", () => {
    const value = (token: string) => new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i").exec(css("tokens.css"))![1]!;
    // The lightest panel any look allows: 0.73 green over a white photo or desktop (no page veil since ADR-45).
    const green = [15, 55, 43];
    const deep = [10, 40, 32];
    const over = (top: number[], under: number[], a: number) => top.map((c, i) => c * a + under[i]! * (1 - a));
    const hex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
    const panel = over(green, [255, 255, 255], 0.73);
    const chip = (tint: number[], a: number) => hex(over(tint, over(deep, panel, 0.35), a));
    expect(contrast(value("--vermilion-ink"), chip([232, 57, 43], 0.2))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(value("--green-text"), chip([95, 165, 133], 0.22))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(value("--ink-3"), hex(panel))).toBeGreaterThanOrEqual(4.5);
  });
});
