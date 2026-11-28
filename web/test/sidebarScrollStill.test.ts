// The sidebar never blinks as the page scrolls in the desktop window (owner, 2026-11-28: "this sidebar is bugging out
// and blinking and every time i scroll"). In the Mac app's WKWebView a fixed backdrop-filter layer under the workspace
// switch's own filter blinked on scroll. In the window look nothing of the page is behind the sidebar (or Clips
// Funded's rail) and no web filter can see the desktop, so both draw no backdrop-filter there: the same pixels, no
// flicker. Elsewhere (browsers, phones, the picture and colours looks) they keep their glass.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "src", ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level rule's selector and body, in order. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! });
  return out;
}

const noFilter = (body: string) => /(^|;)\s*backdrop-filter:\s*none\s*;/.test(body) && /-webkit-backdrop-filter:\s*none\s*;/.test(body);

describe("the sidebar in the desktop window draws no backdrop-filter", () => {
  it("Clip Factory's sidebar: none in html.see-through, more specific than the refracting glass", () => {
    const all = rules(read("styles", "glass.css"));
    const fix = all.findIndex((r) => r.selector === "html.see-through .sidebar.glass");
    expect(fix, "html.see-through .sidebar.glass rule").toBeGreaterThan(-1);
    expect(noFilter(all[fix]!.body)).toBe(true);
    // The refracting glass (.refract .glass--refract, 0-2-0) comes earlier and is less specific (0-3-1 here).
    const refract = all.findIndex((r) => r.selector === ".refract .glass--refract");
    expect(refract).toBeGreaterThan(-1);
    expect(refract).toBeLessThan(fix);
  });

  it("the sidebar keeps its glass outside the desktop window", () => {
    const layout = read("styles", "layout.css");
    expect(layout).not.toMatch(/\.sidebar[^{]*\{[^}]*backdrop-filter/);
    const nav = readFileSync(join(import.meta.dirname, "..", "src", "components", "Nav.tsx"), "utf8");
    expect(nav).toContain("sidebar glass glass--refract");
  });

  it("Clips Funded's rail: none in the window look only", () => {
    const all = rules(read("stories", "styles", "glass.css"));
    const fix = all.find((r) => r.selector === '.stories-app[data-look="window"] .st-rail.st-glass');
    expect(fix, "window-look rail rule").toBeDefined();
    expect(noFilter(fix!.body)).toBe(true);
    expect(all.some((r) => /\.st-rail/.test(r.selector) && !/data-look="window"/.test(r.selector) && /backdrop-filter:\s*none/.test(r.body))).toBe(false);
  });
});
