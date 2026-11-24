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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installStatusBar, lightestPixel, pictureStrip, SHADE_HOLD, SHADE_STEPS, statusBar, statusShade } from "../src/app/statusBar.ts";
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
      ".backdrop__shade",
      ".backdrop.backdrop--cover",
      ".stories-app::before",
      '.stories-app[data-look="picture"]::before',
      "[data-status-bar] .stories-app::after",
      '[data-status-bar] .stories-app[data-look="picture"]::after',
    ]);
    const readers: string[] = [];
    for (const f of all) for (const [sel, body] of rules(readFileSync(f, "utf8"))) if (/var\(--status-bar-h\b|var\(--status-cover-fade\b/.test(body)) readers.push(sel);
    expect(readers.filter((s) => !allowed.has(s))).toEqual([]);
    expect(new Set(readers)).toEqual(allowed);
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
  it("is nothing at all when no shade is needed, else held under the clock and easing out in even, small steps", () => {
    expect(statusShade(0)).toBe("none");
    expect(SHADE_HOLD).toBe(37.5); // 75 % of the bar, in a box two bars tall
    for (const a of [0.08, 0.42, 0.61]) {
      const g = statusShade(a);
      const stops = [...g.matchAll(/rgb\(0 0 0 \/ ([\d.]+)\) ([\d.]+)%/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      expect(g.startsWith(`linear-gradient(rgb(0 0 0 / ${a}) 37.5%, `)).toBe(true);
      expect(g.endsWith(", transparent)")).toBe(true);
      expect(stops).toHaveLength(SHADE_STEPS);
      const alphas = [...stops.map((s) => s[0]), 0];
      for (let i = 1; i < alphas.length; i++) {
        expect(alphas[i]!).toBeLessThan(alphas[i - 1]!);
        // smoothstep in eighths: no step more than 19 % of the whole shade
        expect(alphas[i - 1]! - alphas[i]!).toBeLessThanOrEqual(a * 0.19 + 0.001);
      }
      for (let i = 1; i < stops.length; i++) expect(stops[i]![1]).toBeCloseTo(SHADE_HOLD + ((100 - SHADE_HOLD) * i) / SHADE_STEPS, 2);
    }
  });

  it("Clip Factory draws it in its backdrop, above every layer of it, twice the bar tall, clear of taps", () => {
    expect(declarations(rule(read("src", "styles", "glass.css"), ".backdrop__shade"))).toEqual([
      "position: absolute",
      "inset: 0 0 auto 0",
      "z-index: 1",
      "height: calc(var(--status-bar-h) * 2)",
      "background: var(--status-shade, none)",
      "pointer-events: none",
    ]);
  });

  it("Clips Funded draws it as its stage's top layer, over the colours and over a picture", () => {
    const css = read("src", "stories", "styles", "glass.css");
    for (const sel of [".stories-app::before", '.stories-app[data-look="picture"]::before'])
      expect(rule(css, sel)).toMatch(/background:\s*var\(--st-status-shade, none\) 0 0 \/ 100% calc\(var\(--status-bar-h, 0px\) \* 2\) no-repeat,\s*linear-gradient\(rgb\(var\(--st-veil-rgb\) \/ var\(--st-veil-page\)\)/);
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
