// On a phone the app runs edge to edge, and nothing fixed and coloured lies across the top, at the top of a page or
// scrolled (the owner, 23 Nov: "remove the entire green top bar ... i want the user to be able to see more of the
// screen"; 24 Nov: "remove the top green top fixed color at the top, it just takes space and is unncessary";
// docs/CONTRACTS.md §11.1). The installed iPhone app asks for a see-through status bar (black-translucent) over a page
// that covers the whole screen (viewport-fit=cover), so each app's own backdrop shows under the clock. Every column
// starts below the status bar (--top-safe, --top-line), and what scrolls up to the clock fades into the backdrop
// itself: each app draws its backdrop once more over the page, in the status bar alone (Clip Factory's
// .backdrop--cover, Clips Funded's .stories-app::after), never a strip, scrim or band of its own. The white clock keeps
// AA over the backdrop: where a look's top edge is too light for it (light colours, a light top to the owner's
// picture, read from its own pixels), the backdrop itself is shaded under the clock, as little as AA needs, easing out
// with no edge; nothing at all over the dark looks. e2e/phone-edge-to-edge.spec.ts checks the same on the drawn page.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStatusBar, lightestPixel, OLD_BAR_DELAY, OLD_BAR_HINT, OLD_BAR_SEEN, oldStatusBar, pictureStrip, SHADE_AIR, SHADE_HOLD, SHADE_STEPS, statusBar, statusShade, useOldStatusBarHint } from "../src/app/statusBar.ts";
import { Backdrop, driftTogether, PICTURE_BLEED } from "../src/components/Backdrop.tsx";
import { AA, contrast, hexToRgb, mix, resolveLook, statusBarUnder, statusScrim, VEIL, type LookInput, type Rgb } from "../src/lib/background.ts";
import { applyLook } from "../src/lib/look.ts";
import { setPrefs, type Prefs } from "../src/lib/prefs.ts";
import {
  EMBER,
  lookProps,
  PRESETS,
  stageTopLightest,
  statusBarUnder as storiesStatusBarUnder,
  statusScrim as storiesStatusScrim,
  VEIL as STORIES_VEIL,
  type StoriesLook,
} from "../src/stories/look.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEB = join(import.meta.dirname, "..");
const SRC = join(WEB, "src");
const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Every rule of `sheet` (comments left out), as [selector, declarations]; a rule inside @media keeps its own selector. */
const rules = (sheet: string) => [...strip(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);

/** The declarations of the one rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const found = rules(sheet).filter(([s]) => s === selector);
  expect(found, selector).toHaveLength(1);
  return found[0]![1];
}

/** A rule's declarations, one per line, trimmed (a multi-line value joined to one line). */
const declarations = (body: string) =>
  body
    .split(";")
    .map((d) => d.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** The z-index of the first rule for exactly `selector` in `file` (styles/) that sets one. */
function zOf(file: string, selector: string): number {
  const found = rules(read("src", "styles", file)).find(([s, b]) => s === selector && /z-index:/.test(b));
  expect(found, `${file} ${selector}`).toBeTruthy();
  return Number(/z-index:\s*(-?\d+);/.exec(found![1])?.[1]);
}

/** Every style sheet in `dir`, deep. */
const sheets = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sheets(p);
    return name.endsWith(".css") ? [p] : [];
  });
/** Every source file in `dir`, deep. */
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });

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
    // "black" and "default" are an opaque bar iOS fills with theme-color (the #0F372B band of the owner's screenshot)
    // and lays the page below.
    expect(html).not.toMatch(/status-bar-style" content="(black|default)"/);
    expect(html.match(/apple-mobile-web-app-status-bar-style/g)).toHaveLength(1);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*\bviewport-fit=cover\b[^"]*" \/>/);
  });

  it("keeps theme-color only for the bars a browser draws itself: the backdrop's own top colour, once, as the manifest's", () => {
    // Under black-translucent iOS fills nothing in an installed app, so theme-color never paints its status bar; it
    // tints only what Safari and Android draw outside the page, where no page can show its backdrop.
    expect(html.match(/<meta name="theme-color"/g)).toHaveLength(1);
    expect(html).toMatch(/<meta name="theme-color" content="#13483C" \/>/);
    const manifest = JSON.parse(read("public", "manifest.webmanifest")) as { display: string; theme_color: string };
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#13483C");
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

describe("nothing fixed and coloured lies across the top, at the top of a page or scrolled", () => {
  const all = [...sheets(join(SRC, "styles")), ...sheets(join(SRC, "stories", "styles"))];

  it("no strip, scrim or band: the status bar's old layers and their flag are gone from every file", () => {
    const bad: string[] = [];
    for (const f of sources(SRC)) {
      const text = readFileSync(f, "utf8");
      if (/data-scrolled|\[data-scrolled\]|installPageScrolled|pageScrolled/.test(text)) bad.push(`${relative(SRC, f)}: the scrolled strip's flag`);
      if (/--(st-)?status-strip-veil|--status-bar-fade|statusStripVeil/.test(text)) bad.push(`${relative(SRC, f)}: the glass strip`);
    }
    for (const f of all) {
      for (const [sel] of rules(readFileSync(f, "utf8")))
        if (/(^|,|\s)(\.app|\.signin|\.st-frame)::(before|after)\b/.test(sel) || /(^|,)\s*\.stories-app::after\b/.test(sel)) bad.push(`${relative(SRC, f)}: ${sel}`);
      // The scrim is a number the shade is worked out from, never a layer of its own.
      if (/var\(--(st-)?status-scrim/.test(strip(readFileSync(f, "utf8")))) bad.push(`${relative(SRC, f)}: draws the scrim`);
    }
    expect(bad).toEqual([]);
    expect(read("src", "main.tsx")).toMatch(/^installStatusBar\(\);$/m);
  });

  it("only the backdrop reaches into the status bar: its cover and its shade, and the tokens", () => {
    const allowed = new Set([
      ":root",
      "html[data-status-bar]",
      ".backdrop__shade",
      ".backdrop.backdrop--cover",
      ".stories-app::before",
      '.stories-app[data-look="picture"]::before',
      "[data-status-bar] .stories-app::after",
      '[data-status-bar] .stories-app[data-look="picture"]::after',
    ]);
    // Money's band on wide screens (an installed iPad app) reads the shade's box only to stop below it, on the top line.
    const below = new Set([".dash-band"]);
    const readers: string[] = [];
    for (const f of all) for (const [sel, body] of rules(readFileSync(f, "utf8"))) if (/var\(--status-bar-h\b|var\(--status-cover-fade\b|var\(--status-shade-h\b/.test(body)) readers.push(sel);
    expect(readers.filter((s) => !allowed.has(s) && !below.has(s))).toEqual([]);
    expect(new Set(readers.filter((s) => !below.has(s)))).toEqual(allowed);
    expect(strip(read("src", "styles", "money-dash.css"))).toMatch(/top: calc\(max\(var\(--top-safe\) \+ 8px, var\(--status-shade-h\)\) \+ var\(--todo-bar-h, 0px\)\);/);
  });

  it("the cover's mask: full under the clock and the icons, easing out with no edge to nothing on the top line", () => {
    const tokens = strip(read("src", "styles", "tokens.css"));
    const fade = /--status-cover-fade:\s*([^;]+);/.exec(tokens)?.[1]?.replace(/\s+/g, " ").trim();
    expect(fade).toBe(
      "linear-gradient( #000 calc(var(--status-bar-h) * 0.75), rgb(0 0 0 / 0.9) calc(var(--status-bar-h) * 0.8 + 2.4px), rgb(0 0 0 / 0.65) calc(var(--status-bar-h) * 0.85 + 4.8px), rgb(0 0 0 / 0.35) calc(var(--status-bar-h) * 0.9 + 7.2px), rgb(0 0 0 / 0.1) calc(var(--status-bar-h) * 0.95 + 9.6px), transparent calc(var(--status-bar-h) + 12px) )",
    );
    // Each stop where it says it is, for a 59 px and a 47 px bar: from 75 % of the bar to the top line (+12 px), in
    // even fifths, each a step down of at most 0.3.
    const stops = [...fade!.matchAll(/(#000|rgb\(0 0 0 \/ ([\d.]+)\)|transparent) calc\(var\(--status-bar-h\)(?: \* ([\d.]+))?(?: \+ ([\d.]+)px)?\)/g)].map((m) => ({
      alpha: m[1] === "#000" ? 1 : m[1] === "transparent" ? 0 : Number(m[2]),
      at: (h: number) => h * Number(m[3] ?? 1) + Number(m[4] ?? 0),
    }));
    expect(stops).toHaveLength(6);
    for (const h of [59, 47]) {
      stops.forEach((s, i) => expect(s.at(h)).toBeCloseTo(h * 0.75 + ((h + 12 - h * 0.75) * i) / 5, 6));
      for (let i = 1; i < stops.length; i++) {
        const step = Math.round((stops[i - 1]!.alpha - stops[i]!.alpha) * 100);
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(30);
      }
    }
    // The top line is the cover's end: what sits on it at the top of a page is never touched.
    expect(tokens).toMatch(/--top-line:\s*calc\(var\(--top-safe\) \+ 12px\)/);
  });

  it("Clip Factory's cover is the backdrop itself, over the page and under every sheet, menu and toast, clear of taps", () => {
    const body = rule(read("src", "styles", "glass.css"), ".backdrop.backdrop--cover");
    expect(declarations(body)).toEqual([
      "z-index: 42",
      "pointer-events: none",
      "-webkit-mask-image: var(--status-cover-fade)",
      "mask-image: var(--status-cover-fade)",
      "clip-path: inset(0 0 calc(100% - var(--status-bar-h) - 12px) 0)",
    ]);
    // Over everything a page scrolls under the clock (its bars, the setup list's glass strip, an open dropdown) ...
    const cover = 42;
    for (const [file, sel] of [
      ["setup-todo.css", ".setup-todo-bar"],
      ["layout.css", ".tabbar"],
      ["money-dash.css", ".money-dock"],
      ["money-dash.css", ".dash-band"],
      ["screens.css", ".select-bar"],
      ["screens.css", ".dropdown.is-open"],
      ["glide.css", ".ws-dock"],
    ] as const)
      expect(zOf(file, sel), sel).toBeLessThan(cover);
    // ... and under the setup list, every menu, sheet, toast and scrim (they dim it with the page).
    for (const [file, sel] of [
      ["setup-todo.css", ".setup-todo"],
      ["help.css", ".help-launcher"],
      ["glide.css", ".ws-menu"],
      ["system.css", ".update-bar"],
      ["setup-todo.css", ".setup-todo-scrim"],
      ["setup.css", ".tt-sheet-backdrop"],
      ["components.css", ".toasts"],
      ["help.css", ".help-panel"],
      ["settings.css", ".sheet-scrim"],
      ["help.css", ".help-viewer-scrim"],
      ["base.css", ".skip-link"],
      ["ask.css", ".mk"],
    ] as const)
      expect(zOf(file, sel), sel).toBeGreaterThan(cover);
  });

  it("Clips Funded's cover is its stage itself, the same layers, over its pages and under its sheets", () => {
    const css = read("src", "stories", "styles", "glass.css");
    const bg = (body: string) => /background:([^;]+);/.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
    const cover = rule(css, "[data-status-bar] .stories-app::after");
    expect(bg(cover)).toBe(bg(rule(css, ".stories-app::before")));
    expect(bg(rule(css, '[data-status-bar] .stories-app[data-look="picture"]::after'))).toBe(bg(rule(css, '.stories-app[data-look="picture"]::before')));
    expect(declarations(cover).filter((d) => !d.startsWith("background:"))).toEqual([
      'content: ""',
      "position: fixed",
      "inset: 0",
      "z-index: 50",
      "pointer-events: none",
      "-webkit-mask-image: var(--status-cover-fade)",
      "mask-image: var(--status-cover-fade)",
      "clip-path: inset(0 0 calc(100% - var(--status-bar-h, 0px) - 12px) 0)",
    ]);
    // The desktop window has no status bar.
    expect(declarations(rule(css, '[data-status-bar] .stories-app[data-look="window"]::after'))).toEqual(["content: none"]);
    // Over its top bar (nav - 1) and its tab bar (nav), under its sheets (float) and bursts.
    const tokens = strip(read("src", "stories", "styles", "glass-tokens.css"));
    const z = (name: string) => Number(new RegExp(`--st-z-${name}:\\s*(-?\\d+);`).exec(tokens)?.[1]);
    expect(rule(read("src", "stories", "styles", "st-frame.css"), ".st-top")).toMatch(/z-index: calc\(var\(--st-z-nav\) - 1\);/);
    expect(z("nav")).toBeLessThan(50);
    expect(z("float")).toBeGreaterThan(50);
    // The workspace switch's list at a phone's top bar shares its stacking context: it shows whole over the cover.
    expect(zOf("glide.css", ".ws-menu")).toBeGreaterThan(50);
    expect(z("burst")).toBeGreaterThan(50);
    expect(z("stage")).toBeLessThan(0);
  });
});

describe("the cover is drawn only under a status bar, with the backdrop, the same elements in the same frame", () => {
  let host: HTMLDivElement;
  let root: Root;
  let barH = 0;
  let stop: () => void = () => undefined;
  const html = document.documentElement;
  const resize = (h: number) => {
    barH = h;
    act(() => void window.dispatchEvent(new Event("resize")));
  };
  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    barH = 0;
    stop = installStatusBar(html, window, () => barH);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    stop();
    act(() => void setPrefs({ backgroundMode: "see-through", glassStrength: "clear", background: null }));
  });
  const backdrops = () => [...host.querySelectorAll<HTMLElement>(".backdrop")];
  const shape = (el: Element): string => `${el.tagName}.${el.className}[${[...el.children].map(shape).join(",")}]`;

  const LOOKS: Record<string, Partial<Prefs>> = {
    "the living backdrop": { backgroundMode: "see-through", glassStrength: "clear", background: null },
    "the living backdrop, Frosted": { backgroundMode: "see-through", glassStrength: "frosted", background: null },
    Colours: { backgroundMode: "colours", backgroundColours: ["#f7f5ef", "#e2621f"], background: null },
    "a picture": { backgroundMode: "picture", background: "data:image/png;base64,iVBORw0KGgo=" },
  };
  for (const [name, prefs] of Object.entries(LOOKS))
    it(`${name}: none on a computer, the same backdrop over the page under a status bar, gone again on its side`, () => {
      act(() => void setPrefs(prefs));
      act(() => root.render(createElement(Backdrop)));
      expect(html.hasAttribute("data-status-bar")).toBe(false);
      expect(backdrops()).toHaveLength(1);
      const alone = host.innerHTML;
      resize(59);
      expect(statusBar().h).toBe(59);
      expect(html.hasAttribute("data-status-bar")).toBe(true);
      const [drawn, cover] = backdrops();
      expect(backdrops()).toHaveLength(2);
      // The page's backdrop is untouched, the cover comes after it (so `.backdrop` still finds the page's own), and
      // it is the very same elements with one class more.
      expect(host.firstElementChild).toBe(drawn);
      expect(drawn!.outerHTML).toBe(alone);
      expect(cover!.className).toBe(`${drawn!.className} backdrop--cover`);
      expect(shape(cover!).replace(" backdrop--cover", "")).toBe(shape(drawn!));
      expect(cover!.getAttribute("aria-hidden")).toBe("true");
      // The shade under the clock is part of both, above everything else in them.
      expect(drawn!.lastElementChild!.className).toBe("backdrop__shade");
      // Kept away together while the other app is on screen (their drift waits together).
      act(() => root.render(createElement(Backdrop, { away: true })));
      expect(backdrops().map((b) => b.className.endsWith(" backdrop--away"))).toEqual([true, true]);
      expect(backdrops()[1]!.className).toBe(`${backdrops()[0]!.className.replace(/ backdrop--away$/, "")} backdrop--cover backdrop--away`);
      act(() => root.render(createElement(Backdrop)));
      resize(0);
      expect(html.hasAttribute("data-status-bar")).toBe(false);
      expect(host.innerHTML).toBe(alone);
    });

  it("the desktop window's see-through look has no status bar to cover", () => {
    (window as { __CF_DESKTOP__?: boolean; __CF_GLASS__?: string }).__CF_DESKTOP__ = true;
    (window as { __CF_DESKTOP__?: boolean; __CF_GLASS__?: string }).__CF_GLASS__ = "vibrancy";
    try {
      act(() => root.render(createElement(Backdrop)));
      resize(59);
      expect(backdrops().map((b) => b.className)).toEqual(["backdrop backdrop--window"]);
      expect(host.querySelector(".backdrop__shade")).toBeNull();
    } finally {
      delete (window as { __CF_DESKTOP__?: boolean }).__CF_DESKTOP__;
      delete (window as { __CF_GLASS__?: string }).__CF_GLASS__;
    }
  });

  it("a cover drawn later takes up the backdrop's drift where it is, and a waiting drift keeps waiting", () => {
    const anim = (t: number | null) => ({ currentTime: t, playState: "running" });
    const from = [anim(1200), anim(30_500), anim(null)];
    const to = [anim(0), anim(0), anim(7)];
    driftTogether({ getAnimations: () => from } as unknown as Element, { getAnimations: () => to } as unknown as Element);
    expect(to.map((a) => a.currentTime)).toEqual([1200, 30_500, 7]);
    expect(to.map((a) => a.playState)).toEqual(["running", "running", "running"]);
    // A different set of drifts is left alone.
    const other = [anim(5)];
    driftTogether({ getAnimations: () => from } as unknown as Element, { getAnimations: () => other } as unknown as Element);
    expect(other[0]!.currentTime).toBe(5);
  });

  it("slides with Clip Factory's pane, as its backdrop does", () => {
    expect(read("src", "app", "App.tsx")).toMatch(/const ALSO_SLIDES = \{ clips: \(\) => \[\.\.\.document\.querySelectorAll<HTMLElement>\("\.backdrop"\)\] \};/);
  });
});

describe("the shade under the clock: part of the backdrop, only what the white clock needs, with no edge", () => {
  /** The shade's stops for a `h` px bar: [alpha, px from the top of the screen]. */
  const shadeStops = (g: string, h: number) =>
    [...g.matchAll(/(rgb\(0 0 0 \/ ([\d.]+)\)|transparent) calc\(var\(--status-bar-h\) \* ([\d.]+)(?: \+ ([\d.]+)px)?\)/g)].map(
      (m) => [m[1] === "transparent" ? 0 : Number(m[2]), h * Number(m[3]) + Number(m[4] ?? 0)] as const,
    );
  /** The shade's alpha at `y` (px), as a browser draws the gradient: linear between its stops, nothing past the last. */
  const alphaAt = (stops: readonly (readonly [number, number])[], y: number) => {
    if (y <= stops[0]![1]) return stops[0]![0];
    for (let i = 1; i < stops.length; i++) {
      const [a1, y1] = stops[i]!;
      const [a0, y0] = stops[i - 1]!;
      if (y <= y1) return a0 + ((a1 - a0) * (y - y0)) / (y1 - y0);
    }
    return 0;
  };
  const luminance = ([r, g, b]: Rgb) => {
    const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  it("is nothing at all when no shade is needed, else held under the clock and gone on the top line, in eighths", () => {
    expect(statusShade(0)).toBe("none");
    expect([SHADE_HOLD, SHADE_AIR, SHADE_STEPS]).toEqual([0.75, 12, 8]); // the cover's own span: 75 % of the bar to the top line
    for (const a of [0.08, 0.42, 0.61]) {
      const g = statusShade(a);
      expect(g.startsWith(`linear-gradient(rgb(0 0 0 / ${a}) calc(var(--status-bar-h) * 0.75), `)).toBe(true);
      expect(g.endsWith(", transparent calc(var(--status-bar-h) * 1 + 12px))")).toBe(true);
      for (const h of [59, 47]) {
        const stops = shadeStops(g, h);
        expect(stops).toHaveLength(SHADE_STEPS + 1);
        // Where each stop lies: from 75 % of the bar to the top line (the bar + 12 px), in even eighths.
        stops.forEach(([, y], i) => expect(y).toBeCloseTo(h * 0.75 + ((h + 12 - h * 0.75) * i) / SHADE_STEPS, 6));
        // Each step lighter than the one above, never a jump.
        for (let i = 1; i < stops.length; i++) {
          expect(stops[i]![0]).toBeLessThan(stops[i - 1]![0]);
          expect(stops[i - 1]![0] - stops[i]![0]).toBeLessThanOrEqual(a * 0.25 + 0.001);
        }
      }
    }
  });

  it("lifts evenly in light, with no edge, and leaves the page below the bar untouched (Cream, a white picture top)", () => {
    for (const under of [hexToRgb("#f7f5ef"), WHITE]) {
      const a = statusScrim(under);
      expect(a).toBeGreaterThan(0.4);
      const g = statusShade(a);
      for (const h of [59, 47]) {
        const stops = shadeStops(g, h);
        // Each row as the screen draws it: black at the shade's alpha over the backdrop, at the row's middle.
        const row = (y: number) => luminance(mix(BLACK, under, alphaAt(stops, y + 0.5)).map(Math.round) as unknown as Rgb);
        // Under the clock and the icons (the bar's top 75 %): the full shade, so the white clock keeps AA.
        for (let y = 0; y < Math.floor(h * 0.75); y++) expect(contrast(WHITE, mix(BLACK, under, alphaAt(stops, y + 0.5))), `row ${y}`).toBeGreaterThanOrEqual(AA);
        // Below that, each row a little lighter than the one above, never a step: about 0.03 at most (an edge is 0.5).
        for (let y = 1; y < h + 24; y++) {
          expect(row(y) - row(y - 1), `${h} px bar, row ${y}`).toBeGreaterThanOrEqual(-0.004);
          expect(row(y) - row(y - 1), `${h} px bar, row ${y}`).toBeLessThanOrEqual(0.05);
        }
        // From the top line (the bar + 12 px) down: untouched.
        for (let y = h + 12; y < h + 24; y++) expect(alphaAt(stops, y + 0.5), `${h} px bar, row ${y}`).toBe(0);
      }
    }
  });

  it("lies in a box from the top of the screen to the top line while there is a status bar, else none at all", () => {
    const tokens = strip(read("src", "styles", "tokens.css"));
    expect(tokens.match(/--status-shade-h:[^;]+;/g)).toEqual(["--status-shade-h: 0px;", "--status-shade-h: calc(var(--status-bar-h) + 12px);"]);
    expect(declarations(rule(tokens, "html[data-status-bar]"))).toEqual(["--status-shade-h: calc(var(--status-bar-h) + 12px)"]);
  });

  it("Clip Factory draws it in its backdrop, above every layer of it, to the top line, clear of taps", () => {
    expect(declarations(rule(read("src", "styles", "glass.css"), ".backdrop__shade"))).toEqual([
      "position: absolute",
      "inset: 0 0 auto 0",
      "z-index: 1",
      "height: var(--status-shade-h)",
      "background: var(--status-shade, none)",
      "pointer-events: none",
    ]);
  });

  it("Clips Funded draws it as its stage's top layer, over the colours and over a picture", () => {
    const css = read("src", "stories", "styles", "glass.css");
    for (const sel of [".stories-app::before", '.stories-app[data-look="picture"]::before'])
      expect(rule(css, sel)).toMatch(/background:\s*var\(--st-status-shade, none\) 0 0 \/ 100% var\(--status-shade-h, 0px\) no-repeat,\s*linear-gradient\(rgb\(var\(--st-veil-rgb\) \/ var\(--st-veil-page\)\)/);
  });

  it("is 0 over Clip Factory's living backdrop (clear and frosted) and its dark colours", () => {
    for (const l of [look({}), look({ strength: "frosted" }), look({ mode: "picture" }), look({ mode: "colours", colours: ["#0f372b", "#efe7da", "#e8392b"] })]) {
      expect(statusScrim(statusBarUnder(l)), l.kind).toBe(0);
      expect(contrast(WHITE, statusBarUnder(l))).toBeGreaterThanOrEqual(AA);
    }
    // The desktop window has no status bar.
    expect(statusScrim(statusBarUnder(look({ glass: "liquid" })))).toBe(0);
  });

  it("is the least black that holds AA over a light Colours look", () => {
    for (const colours of [["#f7f5ef"], ["#efe7da", "#e8392b"], ["#f6c945", "#7fd8be", "#7cc4f2"], ["#7cc4f2"]]) {
      const l = look({ mode: "colours", colours });
      const under = statusBarUnder(l);
      // The first colour is the top edge, under the look's page veil.
      expect(under).toEqual(mix(hexToRgb("#0f372b"), hexToRgb(colours[0]!), l.kind === "colours" ? l.pageVeil : 0));
      const scrim = statusScrim(under);
      expect(scrim, colours.join()).toBeGreaterThan(0);
      leastForAA(under, scrim);
    }
  });

  it("over the owner's picture: planned for white until its own pixels under the clock are read, then only what they need", () => {
    const picture = look({ mode: "picture", picture: "data:image/png;base64,AA==" });
    if (picture.kind !== "picture") throw new Error("a picture look");
    expect(statusBarUnder(picture)).toEqual(mix(VEIL, WHITE, picture.pageVeil));
    leastForAA(WHITE, statusScrim(statusBarUnder(picture)));
    expect(statusScrim(statusBarUnder(picture))).toBeGreaterThan(0.5);
    // A dark top (a night sky): nothing at all.
    expect(statusScrim(statusBarUnder(picture, [18, 30, 52]))).toBe(0);
    // A light one: the least for that pixel, under the look's page veil.
    for (const top of [[205, 214, 226], [120, 160, 140], [255, 200, 120]] as Rgb[]) {
      const under = statusBarUnder(picture, top);
      expect(under).toEqual(mix(VEIL, top, picture.pageVeil));
      leastForAA(under, statusScrim(under));
    }
  });

  it("is set on the page with the look: the scrim it is worked out from and the shade itself", () => {
    const root = document.createElement("html");
    applyLook(look({}), root);
    expect(root.style.getPropertyValue("--status-scrim")).toBe("0");
    expect(root.style.getPropertyValue("--status-shade")).toBe("none");
    applyLook(look({ mode: "colours", colours: ["#f7f5ef"] }), root);
    const scrim = Number(root.style.getPropertyValue("--status-scrim"));
    expect(scrim).toBeGreaterThan(0);
    expect(root.style.getPropertyValue("--status-shade")).toBe(statusShade(scrim));
    const picture = look({ mode: "picture", picture: "data:image/png;base64,AA==" });
    applyLook(picture, root);
    expect(Number(root.style.getPropertyValue("--status-scrim"))).toBe(statusScrim(WHITE));
    applyLook(picture, root, [10, 20, 30]);
    expect(root.style.getPropertyValue("--status-shade")).toBe("none");
  });

  it("Clips Funded: none over Ember, Rose and Lagoon, the least for AA over light colours (after its page veil) and a picture", () => {
    const stories = (l: Partial<StoriesLook>): StoriesLook => ({ mode: "colours", strength: "clear", colours: [...EMBER], picture: null, ...l });
    for (const p of PRESETS) {
      const props = lookProps(stories({ colours: [...p.colours] }), "none");
      expect(props.style["--st-status-scrim"], p.name).toBe("0");
      expect(props.style["--st-status-shade"], p.name).toBe("none");
      expect(contrast(WHITE, stageTopLightest(p.colours))).toBeGreaterThanOrEqual(AA);
    }
    // Light colours: the stage's page veil already darkens its top strip, and the shade is what is left for AA.
    for (const colours of [["#fff3e4", "#e2621f", "#ff9a45"], ["#ffffff"], ["#7cc4f2", "#f6c945"]]) {
      const light = lookProps(stories({ colours }), "none");
      const scrim = Number(light.style["--st-status-scrim"]);
      leastForAA(storiesStatusBarUnder("colours", colours, Number(light.style["--st-veil-page"])), scrim);
      expect(light.style["--st-status-shade"]).toBe(statusShade(scrim));
    }
    // A picture: planned for white until read, then only what its own top needs.
    const pic = stories({ mode: "picture", picture: "data:image/png;base64,AA==" });
    const unread = lookProps(pic, "none");
    expect(Number(unread.style["--st-status-scrim"])).toBe(storiesStatusScrim(storiesStatusBarUnder("picture", EMBER, Number(unread.style["--st-veil-page"]))));
    expect(Number(unread.style["--st-status-scrim"])).toBeGreaterThan(0);
    const dark = lookProps(pic, "none", "simple", [16, 12, 10]);
    expect(dark.style["--st-status-shade"]).toBe("none");
    const lightTop: Rgb = [230, 190, 150];
    const read = lookProps(pic, "none", "simple", lightTop);
    expect(storiesStatusBarUnder("picture", EMBER, Number(read.style["--st-veil-page"]), lightTop)).toEqual(mix(STORIES_VEIL, lightTop, Number(read.style["--st-veil-page"])));
    leastForAA(storiesStatusBarUnder("picture", EMBER, Number(read.style["--st-veil-page"]), lightTop), Number(read.style["--st-status-scrim"]));
    // The desktop window (see-through with real window glass) has no status bar.
    expect(lookProps(stories({ mode: "see-through" }), "liquid").style["--st-status-shade"]).toBe("none");
  });
});

describe("the owner's picture under the clock is read where it really lies", () => {
  it("finds the window's top strip in the picture as background-size: cover lays it, centred, with the app's bleed", () => {
    // A picture of the window's own shape, no bleed: the strip is the picture's top, the bar's share of its height.
    expect(pictureStrip(780, 1688, { w: 390, vh: 844, bar: 59, bleed: 0 })).toEqual({ sx: 0, sy: 0, sw: 780, sh: 118 });
    // A wide picture on a phone: as tall as the window, cut at both sides, centred.
    const wide = pictureStrip(4000, 2000, { w: 390, vh: 844, bar: 47, bleed: 0 });
    const scale = 844 / 2000;
    expect(wide.sx).toBeCloseTo((4000 * scale - 390) / 2 / scale, 6);
    expect(wide.sy).toBe(0);
    expect(wide.sw).toBeCloseTo(390 / scale, 6);
    expect(wide.sh).toBeCloseTo(47 / scale, 6);
    // Clip Factory's picture runs 2 % past the window on every side (glass.css .backdrop__image: inset -2 %).
    expect(PICTURE_BLEED).toBe(0.02);
    expect(rule(read("src", "styles", "glass.css"), ".backdrop__image")).toMatch(/inset: -2%;[\s\S]*background-size: cover;\s*background-position: center;/);
    const bled = pictureStrip(390, 844, { w: 390, vh: 844, bar: 59, bleed: 0.02 });
    expect(bled.sx).toBeCloseTo(390 * 0.02 / 1.04, 6);
    expect(bled.sy).toBeCloseTo(844 * 0.02 / 1.04, 6);
    expect(bled.sh).toBeCloseTo(59 / 1.04, 6);
    // Clips Funded's covers the window as it is.
    expect(read("src", "stories", "styles", "glass.css")).toMatch(/var\(--st-picture\) center \/ cover no-repeat/);
  });

  it("takes the lightest pixel of the strip, by luminance", () => {
    expect(lightestPixel([0, 0, 255, 255, 0, 180, 0, 255, 200, 40, 40, 255])).toEqual([0, 180, 0]);
    expect(lightestPixel([])).toBeNull();
  });
});

describe("Clips Funded's sticky panels stop below the status bar (an installed iPad app runs under it too)", () => {
  it("each one's top clears --top-safe", () => {
    /** The one rule for `selector` in `file` that makes it sticky (inside its @media or @container). */
    const sticky = (file: string, selector: string) => {
      const css = strip(read("src", "stories", "styles", file));
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

describe("a Home Screen app added before it ran edge to edge: told once how to get the whole screen", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const old = { standalone: true, userAgent: IPHONE, screenH: 844, upright: true, inset: 0 };

  it("is the old opaque bar only in the Home Screen app on a tall iPhone held upright with no top inset", () => {
    expect(oldStatusBar(old)).toBe(true);
    expect(oldStatusBar({ ...old, screenH: 812 })).toBe(true);
    // black-translucent: the bar is see-through and the page runs under it (59 px, 47 px).
    expect(oldStatusBar({ ...old, inset: 59 })).toBe(false);
    expect(oldStatusBar({ ...old, inset: 47 })).toBe(false);
    // Safari draws its own bar above the page; a phone on its side has no inset; an iPhone SE, an iPad, a computer.
    expect(oldStatusBar({ ...old, standalone: false })).toBe(false);
    expect(oldStatusBar({ ...old, upright: false })).toBe(false);
    expect(oldStatusBar({ ...old, screenH: 667 })).toBe(false);
    expect(oldStatusBar({ ...old, userAgent: IPAD })).toBe(false);
    expect(oldStatusBar({ ...old, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(false);
  });

  it("says the one thing to do, in plain words, once on this device", () => {
    expect(OLD_BAR_HINT).toBe("To use the whole screen, remove Clip Factory from your Home Screen and add it again from Safari.");
    expect(read("src", "app", "App.tsx")).toMatch(/useOldStatusBarHint\(useCallback\(\(text: string\) => toast\.info\(text, \{ ms: 12_000, group: "old-status-bar" \}\), \[toast\]\)\);/);

    const said: string[] = [];
    const say = (t: string) => void said.push(t);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const Probe = () => {
      useOldStatusBarHint(say);
      return null;
    };
    const page = (standalone: boolean) => {
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(IPHONE);
      vi.spyOn(window.screen, "height", "get").mockReturnValue(844);
      vi.spyOn(window.screen, "width", "get").mockReturnValue(390);
      window.matchMedia = ((q: string) => ({ matches: q === "(orientation: portrait)" || (standalone && q === "(display-mode: standalone)") })) as unknown as typeof window.matchMedia;
    };
    const open = () => {
      act(() => root.render(createElement(Probe, { key: Math.random() })));
      act(() => void vi.advanceTimersByTime(OLD_BAR_DELAY));
    };
    const matchMedia = window.matchMedia;
    vi.useFakeTimers();
    try {
      localStorage.clear();
      // In Safari: nothing.
      page(false);
      open();
      expect(said).toEqual([]);
      // The Home Screen app with the old bar (no status bar inset): once, and never again on this device.
      page(true);
      open();
      expect(said).toEqual([OLD_BAR_HINT]);
      expect(localStorage.getItem(OLD_BAR_SEEN)).toBe("1");
      open();
      expect(said).toEqual([OLD_BAR_HINT]);
      // Added again (black-translucent: a status bar of 59 px): nothing.
      localStorage.clear();
      const stop = installStatusBar(document.documentElement, window, () => 59);
      open();
      stop();
      expect(said).toEqual([OLD_BAR_HINT]);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.useRealTimers();
      vi.restoreAllMocks();
      window.matchMedia = matchMedia;
      localStorage.clear();
    }
  });
});
