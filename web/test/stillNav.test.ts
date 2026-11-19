import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cubicBezier, GLIDE_EASE, GLIDE_MS, slideFrames } from "../src/components/Glide.tsx";
import { applyTitlebar, titlebarHeight } from "../src/lib/look.ts";

// Page changes keep the window still (docs/CONTRACTS.md §20.16), the glide slides on the compositor without
// overshooting (§20.13), and every column shares one top line below the desktop window's title bar band (§11.1).

const SRC = join(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
const css = files(join(SRC, "styles"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ f, text: readFileSync(f, "utf8") }));
const code = files(SRC)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ f, text: readFileSync(f, "utf8") }));

describe("page changes are still", () => {
  it("no View Transition anywhere: no cross-fade of the whole window", () => {
    for (const { f, text } of code) expect(text.includes("startViewTransition"), f).toBe(false);
    for (const { f, text } of css) expect(/::view-transition/.test(text), f).toBe(false);
  });

  it("nothing animates the page itself or its blocks as they open", () => {
    for (const { f, text } of css) {
      // `.main > *`, `.main`, `.shell`, `.page`: the whole page or each of its blocks fading in shows the window glass.
      const rules = text.match(/(^|\})\s*([^{}]*\b(?:\.main|\.shell|\.app|\.page)\b[^{}]*)\{[^}]*\banimation\s*:[^}]*\}/g) ?? [];
      const bad = rules.filter((r) => !/animation\s*:\s*none/.test(r));
      expect(bad, f).toEqual([]);
    }
  });
});

describe("the glide's slide", () => {
  it("is transform only in CSS: no transition of its place or size, no separate stretch animation", () => {
    const glide = css.find(({ f }) => f.endsWith("glide.css"))!.text;
    const rule = /\n\.glide \{([^}]*)\}/.exec(glide)![1]!;
    expect(rule).toMatch(/transition:\s*opacity[^;]*;/);
    expect(rule).not.toMatch(/transition:[^;]*(transform|width|height|left|top)/);
    expect(glide).not.toMatch(/@keyframes glide-stretch/);
    expect(rule).toMatch(/will-change:\s*transform/);
  });

  it("eases out without passing the target, and is done in about a third of a second", () => {
    expect(GLIDE_MS).toBeLessThanOrEqual(380);
    let prev = 0;
    for (let i = 0; i <= 100; i++) {
      const p = cubicBezier(GLIDE_EASE, i / 100);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(p).toBeLessThanOrEqual(1 + 1e-9);
      prev = p;
    }
    expect(cubicBezier(GLIDE_EASE, 0.5)).toBeGreaterThan(0.85);
  });

  it("starts on the old box, ends exactly at rest, stretches on the way and never passes the new box", () => {
    const from = { x: 0, y: 40, width: 200, height: 40 };
    const to = { x: 0, y: 200, width: 200, height: 40 };
    const frames = slideFrames(from, to, "y");
    const parse = (t: string) => {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(t)!;
      return m.slice(1).map(Number) as [number, number, number, number];
    };
    const first = parse(String(frames[0]!.transform));
    const last = parse(String(frames[frames.length - 1]!.transform));
    expect(first).toEqual([0, 40, 1, 1]);
    expect(last).toEqual([0, 200, 1, 1]);
    let prevCentre = -Infinity;
    let stretched = 1;
    for (const f of frames) {
      const [, ty, , sy] = parse(String(f.transform));
      const centre = ty + (40 * sy) / 2;
      expect(centre).toBeGreaterThanOrEqual(prevCentre - 0.01);
      expect(centre).toBeLessThanOrEqual(220 + 0.01);
      prevCentre = centre;
      stretched = Math.max(stretched, sy);
    }
    expect(stretched).toBeGreaterThan(1.05);
    expect(stretched).toBeLessThanOrEqual(1.09 + 1e-6);
    // Only transforms: the compositor can run it on its own.
    for (const f of frames) expect(Object.keys(f).sort()).toEqual(["offset", "transform"]);
  });

  it("changes size by scale between boxes of different sizes", () => {
    const frames = slideFrames({ x: 0, y: 0, width: 100, height: 40 }, { x: 150, y: 0, width: 50, height: 40 }, "x");
    expect(String(frames[0]!.transform)).toBe("translate(0px, 0px) scale(2, 1)");
    expect(String(frames.at(-1)!.transform)).toBe("translate(150px, 0px) scale(1, 1)");
  });
});

describe("the desktop window's title bar band", () => {
  it("is read only inside the desktop app, and only as a sane number", () => {
    expect(titlebarHeight({ __CF_DESKTOP__: true, __CF_TITLEBAR__: 28 })).toBe(28);
    expect(titlebarHeight({ __CF_DESKTOP__: true, __CF_TITLEBAR__: 0 })).toBe(0);
    expect(titlebarHeight({ __CF_DESKTOP__: true })).toBe(0);
    expect(titlebarHeight({ __CF_TITLEBAR__: 28 })).toBe(0);
    expect(titlebarHeight({ __CF_DESKTOP__: "true", __CF_TITLEBAR__: 28 })).toBe(0);
    expect(titlebarHeight({ __CF_DESKTOP__: true, __CF_TITLEBAR__: "28" })).toBe(0);
    expect(titlebarHeight({ __CF_DESKTOP__: true, __CF_TITLEBAR__: Number.NaN })).toBe(0);
    expect(titlebarHeight({ __CF_DESKTOP__: true, __CF_TITLEBAR__: 5000 })).toBe(0);
    expect(titlebarHeight(undefined)).toBe(0);
  });

  it("marks the page and sets the band's height, and clears both again", () => {
    const root = document.createElement("html");
    applyTitlebar(28, root);
    expect(root.dataset.titlebar).toBe("overlay");
    expect(root.style.getPropertyValue("--titlebar-h")).toBe("28px");
    applyTitlebar(0, root);
    expect(root.dataset.titlebar).toBeUndefined();
    expect(root.style.getPropertyValue("--titlebar-h")).toBe("");
  });

  it("every column reads the one top line: no column adds its own number to the safe area", () => {
    for (const { f, text } of css) {
      if (f.endsWith("tokens.css")) continue;
      // The top safe area is only ever read through --top-safe / --top-line.
      expect(text.match(/env\(safe-area-inset-top\)/g) ?? [], f).toEqual([]);
    }
    const tokens = css.find(({ f }) => f.endsWith("tokens.css"))!.text;
    expect(tokens).toMatch(/--top-safe:\s*max\(env\(safe-area-inset-top\), var\(--titlebar-h\)\)/);
    expect(tokens).toMatch(/html\[data-titlebar="overlay"\]\s*\{\s*--titlebar-h:\s*28px;/);
  });
});
