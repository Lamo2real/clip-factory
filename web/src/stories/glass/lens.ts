// The liquid rim of the big glass surfaces (.st-lens, and the cards this code gives it to, AUTO_LENS): Chromium bends what is behind them with an SVG filter inside
// backdrop-filter. Each hero gets its own filter, its displacement map drawn at the hero's exact pixel size and
// corner radius (a stretched map would make the rim uneven), rebuilt only when that size changes. The map bends the
// backdrop inwards in a band at the rim and is neutral (128, 128) everywhere else, so nothing under the words moves;
// the middle is frosted inside the same filter (the blur the hero would have had anyway).
//
// Budget (the Windows app's WebView2): at most LENS_BUDGET per screen, in document order (never by scroll: a card's
// filter does not change while the owner scrolls), none over 1 MP or half the window, never
// animated (the map is a still picture; nothing here runs per frame). WebKit ignores url() in backdrop-filter, so
// useStoriesBackground starts this only for data-glass="liquid" (Chromium, a capable device, no reduced
// transparency); everywhere else the hero keeps its plain CSS light (glass.css --st-edge-hero, --st-sheen-hero).
// Stories' own code: nothing of Clip Factory's is used here.

export interface LensShape {
  w: number;
  h: number;
  /** the corner radius in px (the hero's border-radius) */
  radius: number;
  /** how wide the bending rim is, px (glass-tokens.css --st-lens-band) */
  band: number;
}

/** At most this many liquid rims on one screen (WebView2's budget); the rest keep the plain CSS light. */
export const LENS_BUDGET = 6;
/** A hero bigger than this (px²), or than half the window, stays flat: the plain CSS light only. */
export const LENS_MAX_AREA = 1_000_000;
/** How far the light moves at the very rim, px (--st-lens-depth). */
export const LENS_DEPTH = 12;
/** How wide the bending rim is, px (--st-lens-band); never wider than the hero's padding, so it never reaches words. */
export const LENS_BAND = 26;
/** The deepest bend for a band: past half of it, the bent picture would fold over itself at the edge. */
export const LENS_FOLD = 0.48;

/**
 * The map's colour at (x, y): red carries x and green carries y (128 = still), blue how much rim. Inside the band
 * the backdrop is read from further in (never from outside the hero, where there is nothing to read), most at the
 * edge, easing to nothing at the band's inner side. Rounded corners bend along their own curve.
 */
export function lensPixel(x: number, y: number, { w, h, radius, band }: LensShape): [number, number, number] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  // The signed distance to the rounded rectangle's edge (negative inside) and the way out from it.
  const px = x - w / 2;
  const py = y - h / 2;
  const qx = Math.abs(px) - (w / 2 - r);
  const qy = Math.abs(py) - (h / 2 - r);
  let nx: number;
  let ny: number;
  let inside: number;
  if (qx > 0 && qy > 0) {
    const len = Math.hypot(qx, qy) || 1;
    nx = (qx / len) * Math.sign(px);
    ny = (qy / len) * Math.sign(py);
    inside = r - Math.hypot(qx, qy);
  } else if (qx > qy) {
    nx = Math.sign(px);
    ny = 0;
    inside = r - qx;
  } else {
    nx = 0;
    ny = Math.sign(py);
    inside = r - qy;
  }
  const b = Math.max(1, band);
  const t = inside >= b || inside < -1 ? 0 : 1 - Math.max(0, inside) / b;
  // How far it bends: t², most at the very edge (like the thick rounded edge of real glass), easing to nothing at the
  // band's inner side. With the depth at most LENS_FOLD of the band, the picture never folds over itself.
  const bend = t * t;
  // How much is rim (the blue): smooth, so the bent edge melts into the frosted middle.
  const rim = t * t * (3 - 2 * t);
  // Read from inside: at the left rim (n points left) look to the right, so red goes over 128.
  return [Math.round(128 - nx * bend * 127), Math.round(128 - ny * bend * 127), Math.round(rim * 255)];
}

/** The map as RGBA pixels (row by row), w × h. */
export function lensPixels(shape: LensShape): Uint8ClampedArray<ArrayBuffer> {
  const { w, h } = shape;
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = lensPixel(x + 0.5, y + 0.5, shape);
      const i = (y * w + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  return out;
}

/** The map as a PNG data URL (a canvas), or null where there is no canvas (tests, old browsers). */
export function lensMapUrl(shape: LensShape): string | null {
  if (typeof document === "undefined") return null;
  try {
    const c = document.createElement("canvas");
    c.width = shape.w;
    c.height = shape.h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(lensPixels(shape), shape.w, shape.h), 0, 0);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * The filter's inside. The middle: the backdrop frosted (`core`, the hero's own blur) under the rest of the hero's
 * veil (`veil` of #1C130E, so with the hero's thinner rim tint on top the words keep exactly the hero's measured
 * veil). The rim: the backdrop bent by the map, kept only in the band (the map's blue), with only the rim tint over
 * it, so the bend shows. Until the map has loaded, the rim is nothing and the whole middle is veiled: never thinner
 * than the hero's veil under words. One displacement pass (no prism split; the warm fringe is the painted edge's),
 * inside WebView2's budget.
 */
export interface FilterPart {
  tag: string;
  attrs: Record<string, string>;
  children?: FilterPart[];
}
export function lensFilterParts(mapUrl: string, { w, h }: { w: number; h: number }, depth = LENS_DEPTH, core = 28, veil = 0): FilterPart[] {
  const scale = (depth / 0.498).toFixed(1);
  const k = Math.min(1, Math.max(0, veil)).toFixed(3);
  return [
    { tag: "feImage", attrs: { href: mapUrl, x: "0", y: "0", width: String(w), height: String(h), preserveAspectRatio: "none", result: "map" } },
    { tag: "feColorMatrix", attrs: { in: "map", type: "matrix", values: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0", result: "rim" } },
    { tag: "feGaussianBlur", attrs: { in: "SourceGraphic", stdDeviation: String(core), edgeMode: "duplicate", result: "soft" } },
    { tag: "feFlood", attrs: { "flood-color": "rgb(28 19 14)", "flood-opacity": k, result: "veil" } },
    { tag: "feComposite", attrs: { in: "veil", in2: "rim", operator: "out", result: "middle" } },
    { tag: "feComposite", attrs: { in: "middle", in2: "soft", operator: "over", result: "frost" } },
    { tag: "feGaussianBlur", attrs: { in: "SourceGraphic", stdDeviation: "1.2", edgeMode: "duplicate", result: "src" } },
    { tag: "feDisplacementMap", attrs: { in: "src", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: "bent" } },
    { tag: "feComposite", attrs: { in: "bent", in2: "rim", operator: "in", result: "edge" } },
    { tag: "feMerge", attrs: {}, children: [{ tag: "feMergeNode", attrs: { in: "frost" } }, { tag: "feMergeNode", attrs: { in: "edge" } }] },
  ];
}

/** The same as text (to read it in a test or a bug report; the page builds it as elements, never from text). */
export function lensFilterMarkup(mapUrl: string, size: { w: number; h: number }, depth = LENS_DEPTH, core = 28, veil = 0): string {
  const one = (p: FilterPart): string => {
    const attrs = Object.entries(p.attrs)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    return p.children ? `<${p.tag}${attrs}>${p.children.map(one).join("")}</${p.tag}>` : `<${p.tag}${attrs}/>`;
  };
  return lensFilterParts(mapUrl, size, depth, core, veil).map(one).join("");
}

function toElement(p: FilterPart): SVGElement {
  const el = document.createElementNS(NS, p.tag);
  for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, v);
  for (const c of p.children ?? []) el.append(toElement(c));
  return el;
}

/** How much more veil the filter lays under the words, so the rim tint on top adds up to the hero's veil. */
export function middleVeil(hero: number, rim: number): number {
  if (!(rim < 1)) return 0;
  return Math.max(0, Math.min(1, 1 - (1 - hero) / (1 - rim)));
}

/** Which of these heroes may bend: the first LENS_BUDGET on screen that are not too big. */
export function pickLenses<T>(items: readonly { el: T; w: number; h: number }[], view: { w: number; h: number }, budget = LENS_BUDGET): T[] {
  const half = (view.w * view.h) / 2;
  return items
    .filter(({ w, h }) => w >= 24 && h >= 24 && w * h <= LENS_MAX_AREA && w * h <= half)
    .slice(0, budget)
    .map(({ el }) => el);
}

/**
 * Every big glass card on screen may bend its rim, not only the ones a screen marked `.st-lens` (the owner: the whole UI
 * as real glass). These are the cards the lens code adds `.st-lens` to itself, after the marked ones, while the budget
 * lasts: not a control, a bar, a sheet or a tinted tile, and never one inside another glass (its parent's filter has
 * already bent what is behind both).
 */
export const AUTO_LENS_KIND = ".st-glass:not(.st-glass--control, .st-glass--bar, .st-glass--float, .st-glass--tinted)";
export const AUTO_LENS = ".st-glass:not(.st-lens, .st-glass--control, .st-glass--bar, .st-glass--float, .st-glass--tinted)";

const NS = "http://www.w3.org/2000/svg";
const LIQUID = "is-liquid";
let lensIds = 0;

interface Built {
  filter: SVGFilterElement;
  key: string;
}

/**
 * Watches `root` for heroes with .st-lens and gives the first LENS_BUDGET of them a rim that bends (.is-liquid and
 * --st-lens-url). Returns the way to stop, which takes everything away again (the filters, the classes, the
 * custom property and the defs it put on the page).
 */
export function watchLenses(
  root: HTMLElement,
  { budget = LENS_BUDGET, band = LENS_BAND, depth = LENS_DEPTH, makeMap = lensMapUrl }: { budget?: number; band?: number; depth?: number; makeMap?: (shape: LensShape) => string | null } = {},
): () => void {
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => undefined;
  const defs = document.createElementNS(NS, "svg");
  defs.setAttribute("class", "st-lens__defs");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("focusable", "false");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  document.body.append(defs);
  const built = new Map<HTMLElement, Built>();
  const sizes = new Map<HTMLElement, { w: number; h: number }>();
  /** the cards this code gave `.st-lens` itself (a screen's own marks are never taken away) */
  const given = new Set<HTMLElement>();

  const drop = (el: HTMLElement) => {
    const b = built.get(el);
    if (b) b.filter.remove();
    built.delete(el);
    // Only when there (a class write is a mutation, and the watcher listens for those).
    if (el.classList.contains(LIQUID)) el.classList.remove(LIQUID);
    el.style.removeProperty("--st-lens-url");
  };
  const build = (el: HTMLElement, w: number, h: number) => {
    const cs = getComputedStyle(el);
    const num = (name: string, fallback: number) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    // The rim stays inside the padding (never under words), and never bends so far that it folds.
    const pad = Math.min(parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0, parseFloat(cs.paddingBottom) || 0);
    // Room for the rim: the card's own padding, or (a link or row card whose padding is inside its children) how far
    // its nearest words, icons or buttons sit from its edge (a picture may lie over the rim).
    let inset = pad;
    if (pad < 12) {
      const box = el.getBoundingClientRect();
      let near = Number.POSITIVE_INFINITY;
      let seen = 0;
      for (const node of Array.from(el.querySelectorAll<HTMLElement>("*"))) {
        if (++seen > 300) break;
        const hasWords = Array.from(node.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? "").trim() !== "");
        if (!hasWords && !node.matches("svg, button, input, [role='button']")) continue;
        const q = node.getBoundingClientRect();
        if (q.width > 0 && q.height > 0) near = Math.min(near, q.left - box.left, box.right - q.right, q.top - box.top, box.bottom - q.bottom);
      }
      if (Number.isFinite(near)) inset = Math.max(pad, near);
    }
    const rimBand = Math.min(num("--st-lens-band", band), inset - 2, Math.floor(Math.min(w, h) / 2) - 2);
    // A card with no room for a rim keeps the painted bevel: the rim must never reach words.
    if (rimBand < 8) return drop(el);
    const rimDepth = Math.min(num("--st-lens-depth", depth), rimBand * LENS_FOLD);
    const radius = parseFloat(cs.borderTopLeftRadius) || 20;
    const veil = middleVeil(num("--st-veil-hero", 0.76), num("--st-veil-lens-rim", 0.36));
    const blur = num("--st-blur", 28);
    const key = `${w}x${h}|${radius}|${rimBand}|${rimDepth}|${veil}|${blur}`;
    const had = built.get(el);
    if (had?.key === key) {
      if (!el.classList.contains(LIQUID)) el.classList.add(LIQUID);
      return;
    }
    const url = makeMap({ w, h, radius, band: rimBand });
    if (!url) return drop(el);
    const filter = had?.filter ?? (document.createElementNS(NS, "filter") as SVGFilterElement);
    if (!had) {
      filter.id = `st-lens-${++lensIds}`;
      filter.setAttribute("color-interpolation-filters", "sRGB");
      filter.setAttribute("filterUnits", "userSpaceOnUse");
      filter.setAttribute("primitiveUnits", "userSpaceOnUse");
      defs.append(filter);
    }
    for (const [k, v] of [["x", "0"], ["y", "0"], ["width", String(w)], ["height", String(h)]] as const) filter.setAttribute(k, v);
    filter.replaceChildren(...lensFilterParts(url, { w, h }, rimDepth, blur, veil).map(toElement));
    built.set(el, { filter, key });
    el.style.setProperty("--st-lens-url", `url(#${filter.id})`);
    if (!el.classList.contains(LIQUID)) el.classList.add(LIQUID);
  };

  let frame = 0;
  const sizer = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const box = e.borderBoxSize?.[0];
      const w = Math.round(box ? box.inlineSize : el.getBoundingClientRect().width);
      const h = Math.round(box ? box.blockSize : el.getBoundingClientRect().height);
      sizes.set(el, { w, h });
    }
    schedule();
  });
  const settle = () => {
    frame = 0;
    const marked = Array.from(root.querySelectorAll<HTMLElement>(".st-lens")).filter((el) => !given.has(el));
    const auto = Array.from(root.querySelectorAll<HTMLElement>(`${AUTO_LENS}, .st-lens`)).filter(
      (el) => (given.has(el) ? el.matches(AUTO_LENS_KIND) : !el.classList.contains("st-lens")) && !el.parentElement?.closest(".st-glass"),
    );
    for (const el of Array.from(given)) if (!auto.includes(el)) {
      given.delete(el);
      el.classList.remove("st-lens");
    }
    for (const el of auto) {
      given.add(el);
      // (re-added where a re-render rewrote the card's class)
      if (!el.classList.contains("st-lens")) el.classList.add("st-lens");
    }
    const heroes = [...marked, ...auto];
    for (const el of heroes) if (!sizes.has(el)) sizer.observe(el);
    for (const el of Array.from(sizes.keys()))
      if (!heroes.includes(el) || !el.isConnected) {
        sizer.unobserve(el);
        sizes.delete(el);
        drop(el);
      }
    const view = { w: window.innerWidth, h: window.innerHeight };
    const items = heroes.filter((el) => sizes.has(el)).map((el) => ({ el, ...sizes.get(el)! }));
    const chosen = new Set(pickLenses(items, view, budget));
    for (const { el, w, h } of items) {
      if (chosen.has(el)) build(el, w, h);
      else drop(el);
    }
  };
  function schedule() {
    if (!frame) frame = requestAnimationFrame(settle);
  }
  const changes = new MutationObserver(schedule);
  changes.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", schedule);
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    changes.disconnect();
    sizer.disconnect();
    removeEventListener("resize", schedule);
    for (const el of Array.from(built.keys())) drop(el);
    for (const el of Array.from(given)) el.classList.remove("st-lens");
    given.clear();
    defs.remove();
  };
}
