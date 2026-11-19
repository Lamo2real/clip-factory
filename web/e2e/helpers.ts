import type { Locator, Page } from "@playwright/test";
import { settingsPath, TREES } from "../src/lib/settingsTree.ts";
import { allSteps, GUIDES } from "../src/setup/index.ts";

/** Every page of the settings tree (§15.1), and each platform's setup page (§17.1). */
export const SETUP_ROUTES: string[] = ["youtube", "tiktok", "instagram", "facebook", "x"].map((p) => `/settings/posting/setup/${p}`);
export const SETTINGS_ROUTES: string[] = [
  settingsPath(),
  ...TREES.flatMap((t) => [settingsPath(t.slug), ...t.branches.map((b) => settingsPath(t.slug, b.slug))]),
  ...SETUP_ROUTES,
];

export const ROUTES: string[] = [
  "/",
  "/jobs",
  "/jobs/:running",
  "/jobs/:failed",
  "/review",
  "/library",
  "/money",
  ...SETTINGS_ROUTES,
  "/get-app",
  "/mock-oauth/youtube",
  "/about.html",
  "/legal/privacy.html",
  "/legal/terms.html",
  "/nope",
];
export const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1920] as const;

/** Waits until the screen has its data (no skeletons) and entrance animations have settled. */
export async function settle(page: Page) {
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  // Pages have no entrance of their own (a page change is an instant swap, docs/CONTRACTS.md §20.16); this leaves
  // room for the small things inside them that still arrive (a badge popping in, a list rising).
  await page.waitForTimeout(650);
}

/**
 * Holds the living backdrop still (its blobs, rings and caustics keep their first pose) for checks that are not about
 * the backdrop. WebKit on Linux (CI) paints without a GPU: those nine full-screen drifts, blurred 56 px and blended,
 * make every frame repaint the whole page, so a frame costs more the more pixels there are (a 1920 px page, or an
 * iPhone at 3x). Clicks wait for frames ("stable") and screenshots for a painted frame, so on the 4-CPU runner an
 * Ask check crawled for minutes and Stop could miss its answer. Call it before the first goto.
 */
export async function stillBackdrop(page: Page) {
  await page.addInitScript(() => {
    const add = () => {
      const style = document.createElement("style");
      style.dataset.e2e = "still-backdrop";
      style.textContent = ".backdrop, .backdrop *, .backdrop::before, .backdrop::after { animation-play-state: paused !important; }";
      document.head.append(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  });
}

/**
 * Waits until the Ask launcher has settled (docs/CONTRACTS.md §19.8): it changes only once the page has been still
 * (and fades back in after a longer stillness, holding each state a while), and carries data-settling while a change
 * may still come. So: a frame for any scroll before this call to reach it, then three frames in a row with no
 * data-settling and no fade running.
 */
export async function launcherSettled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let calm = 0;
        const tick = () => {
          const el = document.querySelector<HTMLElement>(".help-launcher");
          const still = !el || (!el.hasAttribute("data-settling") && el.getAnimations().every((a) => a.playState !== "running"));
          calm = still ? calm + 1 : 0;
          if (calm >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(() => requestAnimationFrame(tick));
      }),
  );
}

/** Resolves the ":running" / ":failed" placeholders to real job ids from the mock list. */
export async function resolveRoute(page: Page, route: string): Promise<string> {
  if (!route.includes(":")) return route;
  const want = route.endsWith(":running") ? "Ranked grind" : "Charity marathon";
  await page.goto("/jobs");
  await settle(page);
  const href = await page.locator(".job-row", { hasText: want }).first().getAttribute("href");
  if (!href) throw new Error(`no job for ${route}`);
  return href;
}

export interface Overflow {
  selector: string;
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Every element that carries text (or media) and is wider inside than its box, ignoring boxes that are meant to
 * scroll or to clip with an ellipsis or line clamp. Also reports horizontal page scroll.
 */
export async function findOverflow(page: Page): Promise<{ page: number; viewport: number; items: Overflow[] }> {
  return page.evaluate(() => {
    const scrollable = (s: CSSStyleDeclaration) => /(auto|scroll)/.test(s.overflowX);
    const clipsOnPurpose = (s: CSSStyleDeclaration) =>
      s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none");
    const items: { selector: string; text: string; scrollWidth: number; clientWidth: number }[] = [];
    const describe = (el: Element) => {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      // The paper plane in flight leaves its button on purpose (it lands back inside), and so does any action motion
      // while it plays (§20: a glyph mid-pop or mid-shake). At rest (.is-idle) an .act is measured like anything else.
      if (el.closest(".sr-only, svg, .backdrop, .confetti, .glass-defs, .fly.is-flying, .act:not(.is-idle)")) continue;
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "CANVAS", "VIDEO"].includes(el.tagName)) continue;
      const s = getComputedStyle(el);
      if (s.display === "inline" || s.display === "none" || s.visibility === "hidden" || s.position === "fixed") continue;
      if (el.clientWidth === 0) continue;
      // Visually hidden on purpose (the .sr-only recipe without the class: a 1 px clipped box), nothing to see.
      if (el.clientWidth <= 1 && s.overflow === "hidden" && (s.clipPath.startsWith("inset(50%") || s.clip !== "auto")) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim().length > 0);
      const hasMedia = !!el.querySelector(":scope > img, :scope > svg, :scope > video");
      if (!hasText && !hasMedia) continue;
      if (scrollable(s) || clipsOnPurpose(s)) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        items.push({ selector: describe(el), text: (el.textContent ?? "").trim().slice(0, 60), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
      // A child box poking out of its parent's right edge (catches media and fixed-width children too).
      const r = el.getBoundingClientRect();
      const p = el.parentElement;
      if (p && !el.closest("[data-tip]")) {
        const ps = getComputedStyle(p);
        const pr = p.getBoundingClientRect();
        // A `display: contents` parent has no box of its own (its children are laid out in the grandparent).
        if (!scrollable(ps) && ps.display !== "inline" && ps.display !== "contents" && r.width > 0 && r.right > pr.right + 1.5 && s.position !== "absolute") {
          items.push({ selector: `${describe(el)} > outside ${describe(p)}`, text: (el.textContent ?? "").trim().slice(0, 60), scrollWidth: Math.round(r.right), clientWidth: Math.round(pr.right) });
        }
      }
    }
    return { page: document.documentElement.scrollWidth, viewport: window.innerWidth, items };
  });
}

/** This week's mock clips (docs/CONTRACTS.md §16): every platform state appears on one of them. */
export const CLIPS = {
  /** Posted everywhere with numbers; TikTok has the most views (the crown). */
  all: "One shot. Whole lobby gone.",
  /** YouTube numbers, TikTok private, Instagram waiting, Facebook failed, X not posted. */
  mixed: "He finally lost it at 3 a.m.",
  /** YouTube posting, TikTok posted without numbers yet, the rest with numbers. */
  fresh: "Police chase in reverse",
} as const;

/**
 * Opens a clip's performance page from the Library, the way the owner does. (The mock makes new ids on every page
 * load, so a clip page is reached by clicking, never by typing its address.)
 */
export async function openClip(page: Page, hook: string) {
  await page.goto("/library");
  await settle(page);
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) });
  await card.locator(".lib-card__link").click();
  await page.waitForURL(/\/clips\/[A-Z0-9]+$/);
  await page.locator("[data-stack]").nth(4).waitFor();
  await settle(page);
  // The lines draw in and the stacks rise over about 1.3 s; a fixed wait was too short on slow CI runners.
  await animationsDone(page);
}

/** Waits until every finite animation (draw-ins, rises, fades) has finished; endless ones (the backdrop) are ignored. */
/**
 * The window's own late arrivals have landed: the setup list (it comes with its data, with a short drop-in) and every
 * one-off entrance (the live dot). On a slow runner `settle` can return before they start, and a check of what a page
 * change does would then see them arriving.
 */
export async function arrived(page: Page) {
  await page.waitForFunction(() => document.querySelector(".setup-todo:not(.setup-todo--hold)") !== null, undefined, { timeout: 15_000 });
  await animationsDone(page);
}

export async function animationsDone(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 15_000 },
  );
}

// ---------- Contrast and text size (audit F081, e2e/contrast.spec.ts) ----------

/** One text run that fails a contrast or size floor. */
export interface TextFailure {
  selector: string;
  text: string;
  /** Worst contrast found against the possible backgrounds (contrast failures only). */
  ratio?: number;
  /** What it needed: 4.5, or 3 for large text. */
  need?: number;
  fontSize: number;
  color?: string;
  background?: string;
}

/**
 * The browser-side kit, installed as `window.__cfContrast`. It is one self-contained function because Playwright
 * sends its source text into the page. WCAG 2.x relative luminance and contrast; colours are [r, g, b, a] with
 * r, g, b in 0-255 and a in 0-1.
 */
function contrastKit() {
  type C = [number, number, number, number];
  const lum = (c: C) =>
    [c[0], c[1], c[2]]
      .map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: C, b: C) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };
  /** Every colour in a computed value: rgb()/rgba() and color(srgb ...), in order. */
  const colours = (s: string): C[] => {
    const out: C[] = [];
    for (const m of s.matchAll(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\)|color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/g)) {
      if (m[1] !== undefined) {
        const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4]);
        out.push([Number(m[1]), Number(m[2]), Number(m[3]), a]);
      } else out.push([Number(m[5]) * 255, Number(m[6]) * 255, Number(m[7]) * 255, m[8] === undefined ? 1 : Number(m[8])]);
    }
    return out;
  };
  /** `top` painted over an opaque `under`. */
  const over = (top: C, under: C): C => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as C;
  /** CSS saturate(s) (Filter Effects spec matrix), as a glass backdrop-filter applies it to what is behind. */
  const saturate = (c: C, s: number): C => {
    const [r, g, b] = c;
    const k = (x: number) => Math.max(0, Math.min(255, x));
    return [
      k((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
      k((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
      k((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
      1,
    ];
  };
  const hex = (c: C) => "#" + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  /** WCAG contrast of white on the darkest-to-lightest stops of an element's background gradient (and --glass-tint). */
  function whiteOnGradient(e: Element): number {
    const s = getComputedStyle(e);
    const stops = colours(s.backgroundImage + " " + s.getPropertyValue("--glass-tint"));
    return Math.min(...stops.map((c) => ratio([255, 255, 255, 1], c)));
  }

  /** Per-column samples of the fixed backdrop (rows every 4 px), from a screenshot of the backdrop alone. */
  let backdrop: { cols: C[][]; step: number } | null = null;
  async function loadBackdrop(png: string | null) {
    if (!png) return void (backdrop = null);
    const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const step = 4;
    const cols: C[][] = [];
    for (let x = 0; x < bmp.width; x += step) {
      const col: C[] = [];
      for (let y = 0; y < bmp.height; y += step) {
        const i = (y * bmp.width + x) * 4;
        col.push([data[i]!, data[i + 1]!, data[i + 2]!, 1]);
      }
      cols.push(col);
    }
    backdrop = { cols, step };
  }

  /**
   * The backdrop colours a box can sit on: its columns, over every row it can reach by scrolling (or only its own
   * rows when it is fixed). Returns the darkest, the lightest and three luminance quartiles between them.
   */
  function baseUnder(r: DOMRect, fixed: boolean): C[] {
    if (!backdrop) return [[255, 255, 255, 1]];
    const { cols, step } = backdrop;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const top = fixed ? r.top : r.top + scrollY - maxScroll;
    const bottom = fixed ? r.bottom : r.bottom + scrollY;
    const x0 = Math.max(0, Math.floor(r.left / step));
    const x1 = Math.min(cols.length - 1, Math.floor((r.right - 1) / step));
    const rows = cols[0]!.length;
    const y0 = Math.max(0, Math.floor(top / step));
    const y1 = Math.min(rows - 1, Math.floor((bottom - 1) / step));
    const seen: C[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) seen.push(cols[x]![y]!);
    if (!seen.length) return [cols[Math.min(x0, cols.length - 1)]![Math.min(Math.max(y0, 0), rows - 1)]!];
    seen.sort((a, b) => lum(a) - lum(b));
    return [0, 0.25, 0.5, 0.75, 1].map((q) => seen[Math.round(q * (seen.length - 1))]!);
  }

  const describe = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };

  /**
   * Every visible text run on the page: its rendered colour against every background it can have, found by walking
   * its ancestors from the root down and compositing each background colour and each gradient stop (glass tints are
   * gradients of translucent colours) over the backdrop, with the glass's backdrop saturate() and any ancestor
   * opacity applied. Also its font size.
   */
  /**
   * The visible text runs, found before the backdrop photo touches the page: [text node, its element], or
   * [null, a field] for what is typed in an input or textarea (its placeholder while it is empty).
   */
  let targets: [Text | null, HTMLElement][] = [];
  const offScreen = (rect: DOMRect) => rect.width < 2 || rect.height < 2 || rect.right <= 0 || rect.left >= document.documentElement.scrollWidth;
  function collect(skip: string): number {
    targets = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const done = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (!text || !el || done.has(el)) continue;
      if (el.closest("script, style, noscript, template, title, option, .sr-only")) continue;
      if (skip && el.closest(skip)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rect = range.getBoundingClientRect();
      // Off-canvas, or a 1 px clip (visually hidden): nothing on screen to read.
      if (offScreen(rect)) continue;
      done.add(el);
      targets.push([n as Text, el]);
    }
    // Fields hold words too, but not in a text node: the typed value, or the placeholder while there is none.
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))) {
      if (el instanceof HTMLInputElement && /^(hidden|checkbox|radio|range|color|file|button|submit|reset|image)$/.test(el.type)) continue;
      if (!(el.value || el.placeholder).trim()) continue;
      if (el.closest(".sr-only") || (skip && el.closest(skip))) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (offScreen(el.getBoundingClientRect())) continue;
      targets.push([null, el]);
    }
    return targets.length;
  }

  function scan() {
    const contrast: unknown[] = [];
    const tiny: unknown[] = [];
    let checked = 0;
    let pictures = 0;
    const hasBackdrop = !!document.querySelector(".backdrop");
    for (const [n, el] of targets) {
      const field = n ? null : (el as HTMLInputElement | HTMLTextAreaElement);
      // An empty field shows its placeholder, in the placeholder's own colour (and opacity).
      const placeholder = !!field && !field.value;
      const text = (n ? (n.textContent ?? "") : field!.value || field!.placeholder).trim();
      let rect = el.getBoundingClientRect();
      if (n) {
        const range = document.createRange();
        range.selectNodeContents(n);
        rect = range.getBoundingClientRect();
      }
      // WCAG 1.4.3 exempts inactive controls.
      if (el.closest(':disabled, [aria-disabled="true"]')) continue;
      checked++;
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      const weight = Number(s.fontWeight) || 400;
      const label = (field ? (placeholder ? "(placeholder) " : "(typed) ") : "") + text.replace(/\s+/g, " ").slice(0, 50);
      if (size < 12) tiny.push({ selector: describe(el), text: label, fontSize: size });

      // Text painted on a picture can't be worked out from styles (axe marks it "needs review" too).
      let pictured = false;
      for (let a: Element | null = el, i = 0; a && i < 4 && !pictured; a = a.parentElement, i++)
        for (const m of Array.from(a.querySelectorAll("img, video, canvas"))) {
          const mr = m.getBoundingClientRect();
          if (!m.contains(el) && mr.left < rect.right && mr.right > rect.left && mr.top < rect.bottom && mr.bottom > rect.top) pictured = true;
        }
      const chain: Element[] = [];
      for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
      // (A picture on <html> or <body> is in the backdrop photo already, like their colours below.)
      if (chain.some((a) => !(hasBackdrop && (a === document.documentElement || a === document.body)) && getComputedStyle(a).backgroundImage.includes("url("))) pictured = true;
      if (pictured) {
        pictures++;
        continue;
      }

      const fixed = chain.some((a) => getComputedStyle(a).position === "fixed");
      // Each state: the colour so far, and the opacity groups entered (what was behind each, and its opacity).
      type State = { bg: C; groups: { behind: C; o: number }[] };
      let states: State[] = baseUnder(rect, fixed).map((bg) => ({ bg, groups: [] }));
      for (const a of chain) {
        const cs = getComputedStyle(a);
        if (hasBackdrop && (a === document.documentElement || a === document.body)) continue;
        const o = Number(cs.opacity);
        if (o < 1) states = states.map((st) => ({ bg: st.bg, groups: [...st.groups, { behind: st.bg, o }] }));
        const sat = /saturate\(([\d.]+)\)/.exec(cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"));
        if (sat) states = states.map((st) => ({ ...st, bg: saturate(st.bg, Number(sat[1])) }));
        const fill = colours(cs.backgroundColor)[0];
        if (fill && fill[3] > 0) states = states.map((st) => ({ ...st, bg: over(fill, st.bg) }));
        const stops = colours(cs.backgroundImage).filter((c) => c[3] > 0);
        if (stops.length) {
          // A gradient's background-image layers paint over its colour; any stop may be under the text.
          const next: State[] = [];
          for (const st of states) for (const stop of stops) next.push({ ...st, bg: over(stop, st.bg) });
          const keep = new Map<string, State>();
          for (const st of next) keep.set(st.bg.map(Math.round).join() + "|" + st.groups.map((g) => g.behind.map(Math.round).join() + g.o).join(), st);
          states = [...keep.values()];
        }
        // A sliding highlight (<Glide>, §20.14) is a sibling painted under the chosen item, not an ancestor: when it
        // sits under the text, its fill is part of the background.
        const glide = a.querySelector(":scope > .glide");
        if (glide && !chain.includes(glide)) {
          const gr = glide.getBoundingClientRect();
          const gs = getComputedStyle(glide);
          const go = Number(gs.opacity);
          if (go > 0 && gr.left <= rect.left && gr.right >= rect.right && gr.top <= rect.top && gr.bottom >= rect.bottom) {
            const layers = [...colours(gs.backgroundColor), ...colours(gs.backgroundImage)].filter((c) => c[3] > 0);
            if (layers.length) {
              const next: State[] = [];
              for (const st of states)
                for (const c of layers) next.push({ ...st, bg: over([c[0], c[1], c[2], c[3] * go], st.bg) });
              states = next;
            }
          }
        }
      }
      const shown = placeholder ? getComputedStyle(el, "::placeholder") : s;
      const fg = colours(el instanceof SVGElement ? s.fill : shown.color)[0];
      if (!fg) continue;
      if (placeholder) fg[3] *= Number(shown.opacity) || 1;
      let worst = Infinity;
      let worstPair: [C, C] = [fg, fg];
      for (const st of states) {
        let t = over(fg, st.bg);
        let b = st.bg;
        for (let g = st.groups.length - 1; g >= 0; g--) {
          const { behind, o } = st.groups[g]!;
          t = over([t[0], t[1], t[2], o], behind);
          b = over([b[0], b[1], b[2], o], behind);
        }
        const r = ratio(t, b);
        if (r < worst) [worst, worstPair] = [r, [t, b]];
      }
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (worst < need - 0.005)
        contrast.push({ selector: describe(el), text: label, ratio: Math.round(worst * 100) / 100, need, fontSize: size, color: hex(worstPair[0]), background: hex(worstPair[1]) });
    }
    return { contrast, tiny, checked, pictures };
  }

  return { lum, ratio, colours, whiteOnGradient, loadBackdrop, collect, scan };
}

type ContrastKit = ReturnType<typeof contrastKit>;

/** What `scanText` found: failures, how many text runs it checked, and how many sat on a picture (skipped). */
export interface TextScan {
  contrast: TextFailure[];
  tiny: TextFailure[];
  checked: number;
  pictures: number;
}

async function installContrastKit(page: Page) {
  const ready = await page.evaluate(() => "__cfContrast" in window);
  if (!ready) await page.evaluate(`window.__cfContrast = (${contrastKit.toString()})()`);
}

/** WCAG contrast of white on the darkest-to-lightest stops of an element's background gradient. */
export async function whiteContrastOnGradient(el: Locator): Promise<number> {
  await installContrastKit(el.page());
  return el.evaluate((e) => (window as unknown as { __cfContrast: ContrastKit }).__cfContrast.whiteOnGradient(e));
}

/**
 * Checks every visible text run on the page, and what each field shows (its typed words, or its placeholder while it
 * is empty) (see `contrastKit().scan`): contrast at least 4.5:1 (3:1 for text of 24 px, or 18.66 px bold, and up)
 * against every background it can sit on, and a font size of at least 12 px.
 * `skip` is a selector of decorative text left out on purpose.
 */
export async function scanText(page: Page, skip = ""): Promise<TextScan> {
  await installContrastKit(page);
  await page.evaluate((sk) => (window as unknown as { __cfContrast: ContrastKit }).__cfContrast.collect(sk), skip);
  let png: string | null = null;
  if (await page.locator(".backdrop").count()) {
    // Photograph the backdrop alone, then put the page back. Everything beside the backdrop's ancestors goes to
    // opacity 0 (inline, !important, no transition). Not visibility: Chromium can leave an inherited visibility
    // change stale in getComputedStyle, which would hide the page from the scan. Reduced motion parks the drift.
    const solo = (on: boolean) =>
      page.evaluate((show) => {
        const marked = "data-cf-solo";
        if (!show) {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${marked}]`))) {
            const [o, t] = JSON.parse(el.getAttribute(marked)!) as [string, string];
            el.style.setProperty("opacity", o);
            el.style.setProperty("transition", t);
            el.removeAttribute(marked);
          }
          return;
        }
        for (let a: Element | null = document.querySelector(".backdrop"); a && a !== document.documentElement; a = a.parentElement)
          for (const sib of Array.from(a.parentElement?.children ?? []))
            if (sib !== a && sib instanceof HTMLElement && !sib.hasAttribute(marked)) {
              sib.setAttribute(marked, JSON.stringify([sib.style.getPropertyValue("opacity"), sib.style.getPropertyValue("transition"), getComputedStyle(sib).opacity]));
              sib.style.setProperty("transition", "none", "important");
              sib.style.setProperty("opacity", "0", "important");
            }
      }, on);
    await solo(true);
    png = (await page.screenshot({ scale: "css" })).toString("base64");
    // Remember what was hidden, then put it back and wait until Chromium's computed styles agree that nothing on
    // the page is still at opacity 0. On a slow runner two frames were not enough: the scan then read every text run
    // inside a hidden group and reported "1:1" for the whole page.
    await page.evaluate(() =>
      document.querySelectorAll("[data-cf-solo]").forEach((el) => el.setAttribute("data-cf-was-solo", (JSON.parse(el.getAttribute("data-cf-solo")!) as string[])[2] ?? "1")),
    );
    await solo(false);
    await page.waitForFunction(
      () => {
        const els = Array.from(document.querySelectorAll<HTMLElement>("[data-cf-was-solo]"));
        void document.body.offsetHeight; // force a style recalc
        return els.every((el) => getComputedStyle(el).opacity === el.getAttribute("data-cf-was-solo"));
      },
      undefined,
      { timeout: 10_000, polling: 50 },
    );
    await page.evaluate(() => document.querySelectorAll("[data-cf-was-solo]").forEach((el) => el.removeAttribute("data-cf-was-solo")));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  await page.evaluate((b) => (window as unknown as { __cfContrast: ContrastKit }).__cfContrast.loadBackdrop(b), png);
  return page.evaluate(
    () => (window as unknown as { __cfContrast: ContrastKit }).__cfContrast.scan() as TextScan,
  );
}

// ---------- The floating setup to-do list (§17.13, e2e/setup-todo.spec.ts) ----------

/**
 * Opens the floating setup to-do list (§17.13) the way the owner does: on wide screens it is already open (or the
 * pill unfolds it), on smaller ones the pill opens the panel. Returns the list's box.
 */
export async function openTodo(page: Page) {
  const list = page.locator(".setup-todo--rail, .setup-todo-panel");
  if (!(await list.isVisible())) await page.locator(".setup-todo__pill").click();
  await list.waitFor();
  return list;
}

/** The five kinds of row the setup list can show, each on one platform after `mixedSetup`. */
export const MIXED_SETUP = { youtube: "ready", tiktok: "skipped", instagram: "in_progress", facebook: "needs_you", x: "not_started" } as const;

/**
 * Gives the setup list one row of every kind (`MIXED_SETUP`): YouTube ready, TikTok skipped, Instagram half done,
 * Facebook asking for the owner ("connect again"), X untouched. Call on a loaded page; the pretend server keeps it
 * in sessionStorage (§17.10), so the next page load shows it.
 */
export async function mixedSetup(page: Page) {
  const step = allSteps(GUIDES.instagram).find((s) => !s.auto && !s.optional)!.id;
  await page.evaluate((firstStep) => {
    type Setup = { finish(p: string): void; expireToken(p: string): void };
    const mock = (window as unknown as { __cfMock: { setup: Setup } }).__cfMock.setup;
    mock.finish("youtube");
    mock.finish("facebook");
    mock.expireToken("facebook");
    const state = JSON.parse(sessionStorage.getItem("cf-mock-setup")!) as Record<string, { stepsDone: string[] }>;
    state.instagram!.stepsDone = [firstStep];
    sessionStorage.setItem("cf-mock-setup", JSON.stringify(state));
    sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(["tiktok"]));
  }, step);
}

/**
 * See-through (§22.3): every visible piece of text must sit on a tinted surface (a glass panel, a scrim, a button),
 * never straight on the transparent window. Returns the text that does not, as "selector: text".
 * A surface counts when its own colour or gradient is at least `minAlpha` opaque. Left out, that is the look's own
 * panel tint (`--panel-veil` on <html>): the least anything that holds words may carry there (0.5 on a page
 * without one).
 */
export async function looseText(page: Page, minAlpha?: number): Promise<string[]> {
  return page.evaluate((given) => {
    const veil = Number(getComputedStyle(document.documentElement).getPropertyValue("--panel-veil"));
    // A hair under the tint itself, so rounding in a computed style never counts against a panel.
    const min = given ?? (veil > 0 ? veil - 0.005 : 0.5);
    const alphaOf = (css: string): number => {
      if (!css || css === "none") return 0;
      let best = 0;
      for (const m of css.matchAll(/rgba?\(([^)]*)\)/g)) {
        const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
        best = Math.max(best, parts.length >= 4 ? Number(parts[3]) : 1);
      }
      if (/url\(/.test(css)) best = 1;
      return best;
    };
    const tinted = (el: Element): boolean => {
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (n.classList.contains("backdrop")) return false;
        // The chosen choice of a glide bar sits on the glide, a sibling drawn under it.
        if (n.matches(".has-glide > .is-on")) return true;
        if (alphaOf(s.backgroundColor) >= min || alphaOf(s.backgroundImage) >= min) return true;
      }
      return false;
    };
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent?.trim();
      const el = t.parentElement;
      if (!text || !el) continue;
      if (el.closest(".sr-only, [aria-hidden='true'], script, style, svg, .glass-defs")) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
      if (tinted(el)) continue;
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
      out.push(`${el.tagName.toLowerCase()}${cls}: ${text.slice(0, 40)}`);
    }
    return [...new Set(out)];
  }, minAlpha);
}
