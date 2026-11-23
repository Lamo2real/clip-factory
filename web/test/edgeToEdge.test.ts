// On a phone the app runs edge to edge (the owner, 23 Nov: "remove the entire green top bar ... i want the user to be
// able to see more of the screen then just some green color at the top"). The installed iPhone app asks for a
// see-through status bar (black-translucent) over a page that covers the whole screen (viewport-fit=cover), so the
// backdrop of each app, not a solid green band, shows under the clock. Every column still starts below the status bar
// (--top-safe, --top-line), and the white clock keeps AA: a soft scrim in the status bar alone where a look's top edge
// is light, nothing over the dark looks. e2e/phone-edge-to-edge.spec.ts checks the same on the drawn page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AA, contrast, hexToRgb, mix, resolveLook, statusBarUnder, statusScrim, type LookInput, type Rgb } from "../src/lib/background.ts";
import { applyLook } from "../src/lib/look.ts";
import {
  EMBER,
  lookProps,
  PRESETS,
  stageTopLightest,
  statusBarUnder as storiesStatusBarUnder,
  statusScrim as storiesStatusScrim,
  type StoriesLook,
} from "../src/stories/look.ts";

const WEB = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** The declarations of the one rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const found = [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === selector);
  expect(found, selector).toHaveLength(1);
  return found[0]![2]!;
}

/** White over `under` with `scrim` of black between them keeps AA, and 0.01 less would not (unless it is 0). */
function leastForAA(under: Rgb, scrim: number) {
  expect(contrast(WHITE, mix(BLACK, under, scrim))).toBeGreaterThanOrEqual(AA);
  if (scrim > 0) expect(contrast(WHITE, mix(BLACK, under, scrim - 0.01))).toBeLessThan(AA);
}

const look = (i: Partial<LookInput>) =>
  resolveLook({ mode: "see-through", picture: null, colours: [], strength: "clear", glass: "none", scheme: "dark", ...i });

describe("the installed phone app runs edge to edge", () => {
  const html = read("index.html");

  it("asks iOS for a see-through status bar over a page that covers the whole screen", () => {
    expect(html).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
    expect(html).not.toMatch(/status-bar-style" content="(black|default)"/);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*\bviewport-fit=cover\b[^"]*" \/>/);
  });

  it("keeps the status bar's height in one token, read only through tokens.css", () => {
    const tokens = read("src", "styles", "tokens.css");
    expect(tokens).toMatch(/--status-bar-h:\s*env\(safe-area-inset-top\);/);
    // Every column still starts below it (and below the desktop window's title bar).
    expect(tokens).toMatch(/--top-safe:\s*max\(env\(safe-area-inset-top\), var\(--titlebar-h\)\)/);
    expect(tokens).toMatch(/--top-line:\s*calc\(var\(--top-safe\) \+ 12px\)/);
  });

  it("paints no solid green band behind the page: the body under the backdrop is the backdrop's own top edge", () => {
    const base = read("src", "styles", "base.css");
    expect(rule(base, "body")).toMatch(/background: #0f3d31;/);
    expect(read("src", "styles", "glass.css")).toContain("linear-gradient(160deg, #0f3d31 0%, #08221b 50%, #0f3d31 100%)");
  });
});

describe("the status bar's scrim: AA for the white clock, nothing over the dark looks", () => {
  it("Clip Factory draws it in the status bar alone, above everything, clear of taps, with no filter or transition", () => {
    const body = rule(read("src", "styles", "layout.css"), ".app::after,\n.signin::after");
    expect(body).toMatch(/position: fixed;/);
    expect(body).toMatch(/inset: 0 0 auto 0;/);
    expect(body).toMatch(/height: var\(--status-bar-h\);/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/background: linear-gradient\(rgb\(0 0 0 \/ var\(--status-scrim, 0\)\) 75%, rgb\(0 0 0 \/ 0\)\);/);
    expect(body).not.toMatch(/backdrop-filter|transition|animation/);
  });

  it("Clips Funded draws its own the same way, from its own look", () => {
    const body = rule(read("src", "stories", "styles", "glass.css"), ".stories-app::after");
    expect(body).toMatch(/position: fixed;/);
    expect(body).toMatch(/height: var\(--status-bar-h, 0px\);/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/background: linear-gradient\(rgb\(0 0 0 \/ var\(--st-status-scrim, 0\)\) 75%, rgb\(0 0 0 \/ 0\)\);/);
    expect(body).not.toMatch(/backdrop-filter|transition|animation/);
  });

  it("is 0 over Clip Factory's living backdrop (clear and frosted) and its dark colours", () => {
    for (const l of [look({}), look({ strength: "frosted" }), look({ mode: "picture" }), look({ mode: "colours", colours: ["#0f372b", "#efe7da", "#e8392b"] })]) {
      expect(statusScrim(statusBarUnder(l)), l.kind).toBe(0);
      expect(contrast(WHITE, statusBarUnder(l))).toBeGreaterThanOrEqual(AA);
    }
    // The desktop window has no status bar.
    expect(statusScrim(statusBarUnder(look({ glass: "liquid" })))).toBe(0);
  });

  it("is the least black that holds AA over a light Colours look and over any picture", () => {
    for (const colours of [["#f7f5ef"], ["#efe7da", "#e8392b"], ["#f6c945", "#7fd8be", "#7cc4f2"], ["#7cc4f2"]]) {
      const l = look({ mode: "colours", colours });
      const under = statusBarUnder(l);
      // The first colour is the top edge, under the look's page veil.
      expect(under).toEqual(mix(hexToRgb("#0f372b"), hexToRgb(colours[0]!), l.kind === "colours" ? l.pageVeil : 0));
      const scrim = statusScrim(under);
      expect(scrim, colours.join()).toBeGreaterThan(0);
      leastForAA(under, scrim);
    }
    const picture = look({ mode: "picture", picture: "data:image/png;base64,AA==" });
    const scrim = statusScrim(statusBarUnder(picture));
    expect(scrim).toBeGreaterThan(0);
    leastForAA(WHITE, scrim);
  });

  it("is set on the page with the look", () => {
    const root = document.createElement("html");
    applyLook(look({}), root);
    expect(root.style.getPropertyValue("--status-scrim")).toBe("0");
    applyLook(look({ mode: "colours", colours: ["#f7f5ef"] }), root);
    expect(Number(root.style.getPropertyValue("--status-scrim"))).toBeGreaterThan(0);
  });

  it("Clips Funded: 0 over Ember, Rose and Lagoon, the least for AA over light colours (after its page veil) and a picture", () => {
    const stories = (l: Partial<StoriesLook>): StoriesLook => ({ mode: "colours", strength: "clear", colours: [...EMBER], picture: null, ...l });
    for (const p of PRESETS) {
      expect(lookProps(stories({ colours: [...p.colours] }), "none").style["--st-status-scrim"], p.name).toBe("0");
      expect(contrast(WHITE, stageTopLightest(p.colours))).toBeGreaterThanOrEqual(AA);
    }
    // Light colours: the stage's page veil already darkens its top strip, and the scrim is what is left for AA.
    for (const colours of [["#fff3e4", "#e2621f", "#ff9a45"], ["#ffffff"], ["#7cc4f2", "#f6c945"]]) {
      const light = lookProps(stories({ colours }), "none");
      leastForAA(storiesStatusBarUnder("colours", colours, Number(light.style["--st-veil-page"])), Number(light.style["--st-status-scrim"]));
    }
    const picture = lookProps(stories({ mode: "picture", picture: "data:image/png;base64,AA==" }), "none");
    expect(Number(picture.style["--st-status-scrim"])).toBe(storiesStatusScrim(storiesStatusBarUnder("picture", EMBER, Number(picture.style["--st-veil-page"]))));
    expect(Number(picture.style["--st-status-scrim"])).toBeGreaterThan(0);
    // The desktop window (see-through with real window glass) has no status bar.
    expect(lookProps(stories({ mode: "see-through" }), "liquid").style["--st-status-scrim"]).toBe("0");
  });
});
