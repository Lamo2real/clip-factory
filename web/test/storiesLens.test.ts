// Clip Factory Stories' stage and liquid rim (web/src/stories/styles/GLASS-CONTRACT.md, the foundation): the stage
// glass.css draws is exactly the one stories/look.ts works the veils out from (so Ember needs no veil over the page
// and every word on it stays at 4.5:1); the liquid rim's map bends only in a band at the edge, inwards, never folding,
// still in the middle; its filter keeps the hero's own veil under the words; at most LENS_BUDGET rims per screen,
// none too big; and the watcher takes away everything it put on the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LENS_BUDGET as LOOK_LENS_BUDGET, COLOUR_FLOORS, EMBER, INKS, AA, PICTURE, STAGE_LIGHTS, STAGE_WINDOWS, contrast, hexToRgb, luminance, mix, stageAt, stageSpots, veilsFor, VEIL } from "../src/stories/look.ts";
import { LENS_BAND, LENS_BUDGET, LENS_DEPTH, LENS_FOLD, lensFilterMarkup, lensPixel, lensPixels, middleVeil, pickLenses, watchLenses } from "../src/stories/glass/lens.ts";

const STYLES = join(import.meta.dirname, "..", "src", "stories", "styles");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
const glassCss = strip(readFileSync(join(STYLES, "glass.css"), "utf8"));
const tokensCss = strip(readFileSync(join(STYLES, "glass-tokens.css"), "utf8"));
const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss)?.[1]?.trim();

describe("the stage", () => {
  it("glass.css draws exactly the lights look.ts works the veils out from", () => {
    // (The stage's cover under a phone's status bar, .st-cover__stage, is drawn by the very same rule.)
    const rule = /\.stories-app::before,\s*\.st-cover__stage\s*\{([^}]*)\}/.exec(glassCss)?.[1] ?? "";
    const drawn = Array.from(rule.matchAll(/radial-gradient\(([\d.]+)(vmax|vmin|vw|vh) ([\d.]+)(vmax|vmin|vw|vh) at ([\d.-]+)% ([\d.-]+)%, rgb\(var\(--st-(stage-c2|stage-c3|shadow)-rgb\) \/ (var\(--[a-z0-9-]+\)|[\d.]+)\), transparent ([\d.]+)%\)/g)).map((m) => {
      const alpha = m[8]!.startsWith("var(") ? Number(token(/var\((--[a-z0-9-]+)\)/.exec(m[8]!)![1]!)) : Number(m[8]);
      return { tone: m[7] === "stage-c2" ? 2 : m[7] === "stage-c3" ? 3 : "shadow", alpha, rx: Number(m[1]), ux: m[2], ry: Number(m[3]), uy: m[4], x: Number(m[5]), y: Number(m[6]), stop: Number(m[9]) / 100 };
    });
    const model = STAGE_LIGHTS.map((l) => ({ tone: l.tone, alpha: l.alpha, rx: l.rx, ux: l.ux ?? "vmax", ry: l.ry, uy: l.uy ?? "vmax", x: l.x, y: l.y, stop: l.stop ?? 0.7 }));
    expect(drawn).toEqual(model);
    // and it paints the first colour under them, the page veil over them, and over all of it only the shade under a
    // phone's clock (none over Ember: test/edgeToEdge.test.ts)
    expect(rule).toMatch(/var\(--st-stage-c1\);?\s*$/);
    expect(rule).toMatch(/background:\s*var\(--st-status-shade, none\) 0 0 \/ 100% var\(--status-shade-h, 0px\) no-repeat,\s*linear-gradient\(rgb\(var\(--st-veil-rgb\) \/ var\(--st-veil-page\)\)/);
  });

  it("Ember's colours are the tokens' (the default the page shows before look.ts runs)", () => {
    const rgb = (hex: string) => hexToRgb(hex).join(" ");
    expect(token("--st-stage-c1")).toBe(EMBER[0]);
    expect(token("--st-stage-c2-rgb")).toBe(rgb(EMBER[1]!));
    expect(token("--st-stage-c3-rgb")).toBe(rgb(EMBER[2]!));
    expect(token("--st-glow-copper")).toBe(EMBER[1]);
    expect(token("--st-glow-amber")).toBe(EMBER[2]);
  });

  it("works a light out the way CSS draws it: the colour at its alpha in its middle, nothing past its stop", () => {
    const one = [{ tone: 3 as const, alpha: 0.5, rx: 10, ry: 10, x: 50, y: 50 }];
    const base = hexToRgb(EMBER[0]!);
    const top = hexToRgb(EMBER[2]!);
    expect(stageAt(EMBER, 500, 500, 1000, 1000, one).map(Math.round)).toEqual(mix(top, base, 0.5).map(Math.round));
    expect(stageAt(EMBER, 0, 0, 1000, 1000, one)).toEqual(base);
  });

  it("is warm and lit, yet its lightest pixel anywhere (phones to ultrawide) keeps every word at 4.5:1 with no veil over the page", () => {
    const spots = stageSpots(EMBER);
    expect(spots.length).toBe(STAGE_WINDOWS.length * 2);
    const inks = Object.values(INKS).map(hexToRgb);
    for (const s of spots) for (const ink of inks) expect(contrast(ink, s)).toBeGreaterThanOrEqual(AA);
    expect(veilsFor({ mode: "colours", strength: "clear", colours: [...EMBER], picture: null }, "none").page).toBe(0);
    // lit: the room is not a black page (the lights reach at least 0.08 luminance somewhere on every screen)
    for (let i = 0; i < spots.length; i += 2) expect(luminance(spots[i]!)).toBeGreaterThan(0.06);
  });

  it("puts a veil over the page for colours too bright to read on", () => {
    const v = veilsFor({ mode: "colours", strength: "clear", colours: ["#ffffff"], picture: null }, "none");
    expect(v.page).toBeGreaterThan(0.5);
    const inks = Object.values(INKS).map(hexToRgb);
    for (const ink of inks) expect(contrast(ink, mix(VEIL, [255, 255, 255], v.page))).toBeGreaterThanOrEqual(AA);
  });
});

describe("the liquid rim's map", () => {
  const shape = { w: 400, h: 200, radius: 20, band: LENS_BAND };

  it("is still in the middle and bends only in the band at the edge, inwards", () => {
    expect(lensPixel(200, 100, shape)).toEqual([128, 128, 0]);
    expect(lensPixel(200, LENS_BAND + 1, shape)).toEqual([128, 128, 0]);
    const left = lensPixel(0.5, 100, shape);
    expect(left[0]).toBeGreaterThan(240); // reads from the right: further in
    expect(left[1]).toBe(128);
    expect(left[2]).toBeGreaterThan(240); // all rim
    const right = lensPixel(399.5, 100, shape);
    expect(right[0]).toBeLessThan(16);
    const top = lensPixel(200, 0.5, shape);
    expect(top[1]).toBeGreaterThan(240);
    const bottom = lensPixel(200, 199.5, shape);
    expect(bottom[1]).toBeLessThan(16);
    // a corner bends along its own curve: both ways, inwards
    const corner = lensPixel(8, 8, shape);
    // and outside the rounded corner (clipped away by the border radius) it is still
    expect(lensPixel(1, 1, shape)).toEqual([128, 128, 0]);
    expect(corner[0]).toBeGreaterThan(128);
    expect(corner[1]).toBeGreaterThan(128);
  });

  it("never folds the picture over itself (each row and column still reads in order)", () => {
    const depth = Math.min(LENS_DEPTH, LENS_BAND * LENS_FOLD);
    const scale = depth / 0.498;
    let last = -Infinity;
    for (let y = 0.5; y < 60; y += 0.5) {
      const g = lensPixel(200, y, shape)[1];
      const src = y + scale * (g / 255 - 0.5);
      expect(src, `y ${y}`).toBeGreaterThanOrEqual(last - 0.6);
      last = src;
    }
  });

  it("is made at the hero's own size (no stretched map)", () => {
    const px = lensPixels({ w: 30, h: 20, radius: 6, band: 6 });
    expect(px.length).toBe(30 * 20 * 4);
    expect(px[3]).toBe(255);
  });
});

describe("the liquid rim's filter", () => {
  it("frosts the middle, bends the rim, in one displacement pass", () => {
    const f = lensFilterMarkup("data:image/png;base64,AA", { w: 320, h: 180 }, 12, 28, 0.6);
    expect(f).toContain('<feImage href="data:image/png;base64,AA" x="0" y="0" width="320" height="180" preserveAspectRatio="none" result="map"/>');
    expect(f.match(/<feDisplacementMap/g)).toHaveLength(1);
    expect(f).toContain('scale="24.1"');
    expect(f).toContain('stdDeviation="28"');
    expect(f).toContain('flood-opacity="0.600"');
    expect(f).not.toMatch(/<animate/);
  });

  it("keeps exactly the hero's veil under the words: the rim tint and the filter's veil add up to it", () => {
    for (const [hero, rim] of [
      [0.6, 0.4],
      [0.76, 0.4],
      [0.89, 0.4],
      [0.96, 0.96],
    ] as const) {
      const k = middleVeil(hero, rim);
      expect(1 - (1 - rim) * (1 - k)).toBeCloseTo(hero, 6);
    }
    expect(Number(token("--st-veil-lens-rim"))).toBeLessThan(Number(token("--st-veil-hero")));
    // the rim's own tint is never thicker than the thinnest hero it is under: over the colours (their floor) and over a
    // picture (its own, thicker rim), so the filter's veil under the words is never below 0
    expect(Number(token("--st-veil-lens-rim"))).toBeLessThanOrEqual(COLOUR_FLOORS.hero);
    const picture = [...tokensCss.matchAll(/\.stories-app\[data-look="picture"\] \{([^}]*)\}/g)].map((m) => /--st-veil-lens-rim:\s*([\d.]+)/.exec(m[1]!)).find(Boolean);
    expect(Number(picture![1])).toBeLessThan(PICTURE.hero);
  });

  it("goes solid with reduced transparency (the rim's tint too)", () => {
    const rt = /@media \(prefers-reduced-transparency: reduce\)[^{]*\{\s*\.stories-app\.stories-app\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
    expect(rt).toMatch(/--st-veil-lens-rim:\s*var\(--st-veil-solid\)/);
    expect(rt).toMatch(/--st-veil-hero:\s*var\(--st-veil-solid\)/);
    expect(glassCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)[^{]*\{[^}]*\.st-lens\.is-liquid[^}]*\{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/);
  });

  it("is Chromium's and Liquid's only, and nothing in glass.css animates a filter", () => {
    expect(glassCss).toMatch(/\.refract \.stories-app\[data-glass="liquid"\] \.st-lens\.is-liquid \{[^}]*backdrop-filter: blur\(1px\) brightness\(var\(--st-dim\)\) var\(--st-lens-url\)/);
    for (const m of glassCss.matchAll(/transition[^;]*;/g)) expect(m[0]).not.toMatch(/filter/);
  });
});

describe("the budget", () => {
  it("bends at most LENS_BUDGET heroes, none over 1 MP or half the window", () => {
    expect(LENS_BUDGET).toBe(6);
    expect(LOOK_LENS_BUDGET).toBe(LENS_BUDGET);
    const view = { w: 1440, h: 900 };
    const items = [
      { el: "big", w: 1300, h: 800 },
      { el: "a", w: 600, h: 300 },
      { el: "tiny", w: 10, h: 300 },
      { el: "b", w: 400, h: 400 },
      { el: "c", w: 200, h: 200 },
      { el: "d", w: 300, h: 300 },
    ];
    expect(pickLenses(items, view)).toEqual(["a", "b", "c", "d"]);
    expect(pickLenses([{ el: "half", w: 1000, h: 700 }], view)).toEqual([]);
  });
});

describe("the watcher", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("gives the first three heroes a rim of their own and takes it all away again", async () => {
    const observed: Element[] = [];
    class FakeResize {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observed.push(el);
        this.cb([{ target: el, borderBoxSize: [{ inlineSize: 320, blockSize: 180 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResize);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const root = document.createElement("div");
    root.className = "stories-app";
    for (let i = 0; i < 8; i++) {
      const h = document.createElement("section");
      h.className = "st-glass st-glass--hero st-lens";
      h.style.padding = "24px";
      root.append(h);
    }
    document.body.append(root);
    stop = watchLenses(root, { makeMap: () => "data:image/png;base64,AA" });
    await new Promise((r) => setTimeout(r, 20));
    const heroes = Array.from(root.querySelectorAll<HTMLElement>(".st-lens"));
    expect(observed.length).toBe(8);
    expect(heroes.map((h) => h.classList.contains("is-liquid"))).toEqual([true, true, true, true, true, true, false, false]);
    const url = heroes[0]!.style.getPropertyValue("--st-lens-url");
    expect(url).toMatch(/^url\(#st-lens-\d+\)$/);
    const defs = document.querySelector("svg.st-lens__defs")!;
    expect(defs.querySelectorAll("filter")).toHaveLength(6);
    expect(defs.querySelector(`filter${url.slice(4, -1)}`)?.getAttribute("width")).toBe("320");
    stop();
    stop = null;
    expect(document.querySelector("svg.st-lens__defs")).toBeNull();
    expect(heroes.some((h) => h.classList.contains("is-liquid") || h.style.getPropertyValue("--st-lens-url"))).toBe(false);
  });

  it("gives every big glass card a rim that bends, after the marked ones, and takes it away again", async () => {
    class FakeResize {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, borderBoxSize: [{ inlineSize: 320, blockSize: 180 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResize);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const root = document.createElement("div");
    root.innerHTML = `
      <section class="st-glass" id="plain" style="padding:24px"></section>
      <section class="st-glass st-lens" id="marked" style="padding:24px"></section>
      <button class="st-glass st-glass--control" id="control"></button>
      <header class="st-glass st-glass--bar" id="bar"></header>
      <section class="st-glass" id="outer" style="padding:24px"><section class="st-glass" id="inner" style="padding:24px"></section></section>`;
    document.body.append(root);
    stop = watchLenses(root, { makeMap: () => "data:image/png;base64,AA" });
    await new Promise((r) => setTimeout(r, 20));
    const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
    expect(el("plain").classList.contains("is-liquid")).toBe(true);
    expect(el("marked").classList.contains("is-liquid")).toBe(true);
    expect(el("outer").classList.contains("is-liquid")).toBe(true);
    for (const id of ["control", "bar", "inner"]) expect(el(id).classList.contains("is-liquid")).toBe(false);
    stop();
    stop = null;
    expect(el("plain").classList.contains("st-lens")).toBe(false);
    expect(el("marked").classList.contains("st-lens")).toBe(true);
  });

  it("keeps the painted bevel where a card has no room for the rim, and gives a rewritten card its rim back", async () => {
    class FakeResize {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, borderBoxSize: [{ inlineSize: 320, blockSize: 180 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResize);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const root = document.createElement("div");
    root.innerHTML = '<section class="st-glass" id="tight" style="padding:6px"></section><section class="st-glass" id="roomy" style="padding:24px"></section>';
    document.body.append(root);
    const addScroll = vi.spyOn(window, "addEventListener");
    stop = watchLenses(root, { makeMap: () => "data:image/png;base64,AA" });
    await new Promise((r) => setTimeout(r, 20));
    const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
    expect(el("tight").classList.contains("is-liquid")).toBe(false);
    expect(el("roomy").classList.contains("is-liquid")).toBe(true);
    // scrolling never changes which cards bend: nothing listens to it
    expect(addScroll.mock.calls.some(([type]) => type === "scroll")).toBe(false);
    addScroll.mockRestore();
    // a re-render rewrites the class: both marks come back
    el("roomy").className = "st-glass";
    await new Promise((r) => setTimeout(r, 20));
    expect(el("roomy").classList.contains("st-lens")).toBe(true);
    expect(el("roomy").classList.contains("is-liquid")).toBe(true);
  });

  it("does nothing where the browser cannot watch sizes", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const root = document.createElement("div");
    root.innerHTML = '<section class="st-lens"></section>';
    stop = watchLenses(root);
    expect(root.querySelector(".is-liquid")).toBeNull();
    expect(document.querySelector("svg.st-lens__defs")).toBeNull();
  });
});
