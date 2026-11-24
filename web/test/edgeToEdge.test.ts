// On a phone the app runs edge to edge (the owner, 23 Nov: "remove the entire green top bar ... i want the user to be
// able to see more of the screen then just some green color at the top"). The installed iPhone app asks for a
// see-through status bar (black-translucent) over a page that covers the whole screen (viewport-fit=cover), so the
// backdrop of each app, not a solid green band, shows under the clock. Every column still starts below the status bar
// (--top-safe, --top-line), and the white clock keeps AA: a soft scrim in the status bar alone where a look's top edge
// is light, nothing over the dark looks. e2e/phone-edge-to-edge.spec.ts checks the same on the drawn page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AA, contrast, dimRgb, glassOf, hexToRgb, mix, resolveLook, statusBarUnder, statusScrim, statusStripVeil, VEIL, type LookInput, type Rgb } from "../src/lib/background.ts";
import { applyLook } from "../src/lib/look.ts";
import { installPageScrolled } from "../src/lib/pageScrolled.ts";
import {
  EMBER,
  lookProps,
  PRESETS,
  stageTopLightest,
  statusBarUnder as storiesStatusBarUnder,
  statusScrim as storiesStatusScrim,
  statusStripVeil as storiesStatusStripVeil,
  VEIL as STORIES_VEIL,
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
    expect(body).toMatch(/background: rgb\(0 0 0 \/ var\(--status-scrim, 0\)\);/);
    expect(body).toMatch(/-webkit-mask-image: var\(--status-bar-fade\);/);
    expect(body).toMatch(/(^|\s)mask-image: var\(--status-bar-fade\);/);
    expect(body).not.toMatch(/backdrop-filter|transition|animation|opacity/);
  });

  it("Clips Funded draws its own the same way, from its own look", () => {
    const body = rule(read("src", "stories", "styles", "glass.css"), ".stories-app::after");
    expect(body).toMatch(/position: fixed;/);
    expect(body).toMatch(/height: var\(--status-bar-h, 0px\);/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/background: rgb\(0 0 0 \/ var\(--st-status-scrim, 0\)\);/);
    expect(body).toMatch(/-webkit-mask-image: var\(--status-bar-fade\);/);
    expect(body).toMatch(/(^|\s)mask-image: var\(--status-bar-fade\);/);
    expect(body).not.toMatch(/backdrop-filter|transition|animation|opacity/);
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

describe("the status bar's fade: held under the clock, easing out over the bar's last quarter", () => {
  it("is one token both apps' scrim and strip mask with, full to 75 % and down to nothing at the bar's bottom", () => {
    const fade = /--status-bar-fade:\s*([^;]+);/.exec(read("src", "styles", "tokens.css"))?.[1];
    expect(fade).toBe("linear-gradient(#000 75%, rgb(0 0 0 / 0.9) 80%, rgb(0 0 0 / 0.65) 85%, rgb(0 0 0 / 0.35) 90%, rgb(0 0 0 / 0.1) 95%, transparent)");
    // An eased fade in even 5 % steps, each at most 0.3 down: no hard lower edge.
    const steps = [1, ...[...fade!.matchAll(/rgb\(0 0 0 \/ ([\d.]+)\)/g)].map((m) => Number(m[1])), 0];
    for (let i = 1; i < steps.length; i++) expect(Math.round((steps[i - 1]! - steps[i]!) * 100)).toBeGreaterThan(0);
    for (let i = 1; i < steps.length; i++) expect(Math.round((steps[i - 1]! - steps[i]!) * 100)).toBeLessThanOrEqual(30);
  });
});

describe("once the page has scrolled, a glass strip under the clock keeps it at AA over any card", () => {
  it("<html data-scrolled> is there once the page has scrolled at all, and gone back at the top", () => {
    const root = document.createElement("html");
    const at = (y: number) => {
      Object.defineProperty(window, "scrollY", { value: y, configurable: true });
      window.dispatchEvent(new Event("scroll"));
    };
    at(0);
    const stop = installPageScrolled(root, window);
    expect(root.hasAttribute("data-scrolled")).toBe(false);
    at(1);
    expect(root.hasAttribute("data-scrolled")).toBe(true);
    at(900);
    expect(root.hasAttribute("data-scrolled")).toBe(true);
    at(0);
    expect(root.hasAttribute("data-scrolled")).toBe(false);
    // A bounce above the top (iOS) is the top.
    at(-40);
    expect(root.hasAttribute("data-scrolled")).toBe(false);
    stop();
    at(300);
    expect(root.hasAttribute("data-scrolled")).toBe(false);
    at(0);
    expect(read("src", "main.tsx")).toMatch(/^installPageScrolled\(\);$/m);
  });

  it("Clip Factory: the app's own glass in the status bar alone, clear of taps, shown on its opacity alone", () => {
    const layout = read("src", "styles", "layout.css");
    const body = rule(layout, ".app::before,\n.signin::before");
    expect(body).toMatch(/position: fixed;/);
    expect(body).toMatch(/inset: 0 0 auto 0;/);
    expect(body).toMatch(/z-index: 209;/);
    expect(body).toMatch(/height: var\(--status-bar-h\);/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/background: rgb\(var\(--green-rgb\) \/ var\(--status-strip-veil\)\);/);
    // The glass's blur and saturation (saturate() keeps white white), and no dimming the veil would count on.
    expect(body).toMatch(/-webkit-backdrop-filter: blur\(var\(--glass-blur\)\) saturate\(var\(--glass-saturate\)\);/);
    expect(body).toMatch(/(^|\s)backdrop-filter: blur\(var\(--glass-blur\)\) saturate\(var\(--glass-saturate\)\);/);
    expect(body).toMatch(/(^|\s)mask-image: var\(--status-bar-fade\);/);
    expect(body).toMatch(/opacity: 0;/);
    // Never a transition of the filter: only the opacity moves, and only on the way out (back at the top). Once the
    // page has moved it is there at once: a fade in would leave the white clock over a light card while it came.
    expect(/transition:\s*([^;]+);/.exec(body)?.[1]).toBe("opacity var(--dur-2) var(--ease-out)");
    expect(body).not.toMatch(/animation/);
    expect(rule(layout, "html[data-scrolled] :is(.app, .signin)::before")).toMatch(/^\s*opacity: 1;\s*transition: none;\s*$/);
  });

  it("Clips Funded: its own glass the same way, from its own veil", () => {
    const css = read("src", "stories", "styles", "glass.css");
    const body = rule(css, ".st-frame::before");
    expect(body).toMatch(/position: fixed;/);
    expect(body).toMatch(/inset: 0 0 auto 0;/);
    expect(body).toMatch(/height: var\(--status-bar-h, 0px\);/);
    expect(body).toMatch(/pointer-events: none;/);
    expect(body).toMatch(/background: rgb\(var\(--st-veil-rgb\) \/ var\(--st-status-strip-veil\)\);/);
    expect(body).toMatch(/(^|\s)backdrop-filter: blur\(var\(--st-blur\)\) saturate\(var\(--st-saturate\)\);/);
    expect(body).toMatch(/(^|\s)mask-image: var\(--status-bar-fade\);/);
    expect(body).toMatch(/opacity: 0;/);
    // It fades out back at the top, and is there at once once the page has moved (a cream card never shows under
    // the white clock while it comes).
    expect(/transition:\s*([^;]+);/.exec(body)?.[1]).toBe("opacity var(--st-dur-hover) var(--st-ease-out)");
    expect(body).not.toMatch(/animation/);
    expect(rule(css, "[data-scrolled] .st-frame::before")).toMatch(/^\s*opacity: 1;\s*transition: none;\s*$/);
  });

  it("Clip Factory's veil is the least green that keeps the white clock at AA over white, in every look", () => {
    const v = statusStripVeil();
    expect(/--status-strip-veil:\s*([\d.]+);/.exec(read("src", "styles", "tokens.css"))?.[1]).toBe(String(v));
    // AA with an 8-bit rounding step to spare, and 0.01 less would not keep that.
    const lighter = (c: Rgb) => c.map((x) => Math.min(255, x + 1)) as unknown as Rgb;
    expect(contrast(WHITE, lighter(mix(VEIL, WHITE, v)))).toBeGreaterThanOrEqual(AA);
    expect(contrast(WHITE, lighter(mix(VEIL, WHITE, v - 0.01)))).toBeLessThan(AA);
    // Over anything a page can slide under it (bone, cream, vermilion, yellow), seen as it is or through any look's
    // brightness(): nothing is lighter than white.
    for (const l of [look({}), look({ mode: "picture", picture: "data:image/png;base64,AA==" }), look({ mode: "colours", colours: ["#f7f5ef"] })])
      for (const card of [hexToRgb("#fff6ea"), hexToRgb("#efe7da"), hexToRgb("#e8392b"), hexToRgb("#f6c945")]) {
        expect(contrast(WHITE, mix(VEIL, card, v))).toBeGreaterThanOrEqual(AA);
        expect(contrast(WHITE, mix(VEIL, dimRgb(card, glassOf(l).brightness), v))).toBeGreaterThanOrEqual(AA);
      }
  });

  it("Clips Funded's veil is the least espresso that keeps the white clock at AA over white (a cream card too)", () => {
    const v = storiesStatusStripVeil();
    expect(/--st-status-strip-veil:\s*([\d.]+);/.exec(read("src", "stories", "styles", "glass-tokens.css"))?.[1]).toBe(String(v));
    const lighter = (c: Rgb) => c.map((x) => Math.min(255, x + 1)) as unknown as Rgb;
    expect(contrast(WHITE, lighter(mix(STORIES_VEIL, WHITE, v)))).toBeGreaterThanOrEqual(AA);
    expect(contrast(WHITE, lighter(mix(STORIES_VEIL, WHITE, v - 0.01)))).toBeLessThan(AA);
    expect(contrast(WHITE, mix(STORIES_VEIL, [255, 246, 234], v))).toBeGreaterThanOrEqual(AA);
  });
});

describe("Clips Funded's sticky panels stop below the status bar (an installed iPad app runs under it too)", () => {
  it("each one's top clears --top-safe", () => {
    /** The one rule for `selector` in `file` that makes it sticky (inside its @media or @container). */
    const sticky = (file: string, selector: string) => {
      const css = read("src", "stories", "styles", file).replace(/\/\*[\s\S]*?\*\//g, "");
      const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === selector && /position: sticky;/.test(m[2]!));
      expect(found, `${file} ${selector}`).toHaveLength(1);
      return found[0]![2]!;
    };
    expect(sticky("chat.css", ".st-chat-side")).toMatch(/top: calc\(var\(--top-safe, 0px\) \+ 12px\);/);
    expect(sticky("sd-review.css", ".st-s-review__player")).toMatch(/top: calc\(var\(--top-safe, 0px\) \+ 16px\);/);
    expect(sticky("sd-characters.css", ".st-s-editor__stage")).toMatch(/top: calc\(var\(--top-safe, 0px\) \+ var\(--st-space-4\)\);/);
    expect(sticky("sd-ideas.css", ".st-s-ideaedit:has(> .st-s-ideaedit__full) > .st-s-ideaedit__basics")).toMatch(/top: calc\(var\(--top-safe, 0px\) \+ var\(--st-space-4\)\);/);
    // The chat list it holds stays within the window below it.
    expect(rule(read("src", "stories", "styles", "chat.css"), ".st-chat-side > .st-chat-list")).toMatch(/max-height: calc\(100vh - 36px - var\(--top-safe, 0px\)\);/);
  });
});
