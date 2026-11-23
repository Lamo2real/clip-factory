import { expect, test, type Page } from "@playwright/test";
import { EMBER, luminance, stageSpots, STAGE_WINDOWS } from "../src/stories/look.ts";
import { asMacWindow } from "./desktopWindow.ts";

// Clip Factory Stories' liquid-glass foundation (web/src/stories/styles/GLASS-CONTRACT.md) in the mock app, measured
// on screen: the shared figures and glass classes keep every word at 4.5:1 over all three backgrounds (Colours ›
// Ember; a white and a busy picture; See-through in the desktop app over a white and a busy desktop, Clear and
// Frosted); the stage is drawn exactly as stories/look.ts works it out; the liquid rim bends at most three heroes,
// each with a filter made at its own size; reduced transparency makes every glass solid; and Settings › Look keeps its
// choice in Stories' own prefs only. Stories is switched on with cf.storiesPreview = 1.

type Look = { mode?: string; strength?: string };

async function open(page: Page, look: Look, { picture = null as null | "white" | "busy", desktop = null as null | "white" | "busy", width = 1440 } = {}) {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  if (desktop) await asMacWindow(page);
  await page.addInitScript(
    ({ look, picture, desktop }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      const more: Record<string, string> = {};
      for (const [k, v] of Object.entries(look)) more[`look.${k}`] = v as string;
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more }));
      const busy = (w: number, h: number) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d")!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, w, h);
        let s = 7;
        const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 260; i++) {
          x.fillStyle = `hsl(${r() * 360} ${40 + r() * 60}% ${r() < 0.5 ? 90 + r() * 10 : 20 + r() * 60}%)`;
          x.fillRect(r() * w, r() * h, 20 + r() * 240, 20 + r() * 160);
        }
        x.fillStyle = "#fff";
        x.font = "700 22px sans-serif";
        for (let y = 20; y < h; y += 46) x.fillText("Paste a link · Pick a video · white words everywhere ".repeat(4), (y % 3) * -40, y);
        return c.toDataURL("image/jpeg", 0.85);
      };
      const white = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const x = c.getContext("2d")!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, 32, 32);
        return c.toDataURL("image/png");
      };
      if (picture) localStorage.setItem("cf.stories.picture", picture === "white" ? white() : busy(1600, 1000));
      // The desktop behind a see-through window: the page's own canvas (html.see-through leaves it showing).
      if (desktop)
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = `html.see-through, html.see-through body { background: ${desktop === "white" ? "#fff" : `url(${busy(1600, 1000)}) center / cover fixed`} !important; }`;
          document.head.append(st);
        });
    },
    { look, picture, desktop },
  );
  await page.goto("/stories");
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** The figures and glass classes, laid out in place of the page (the same markup stories/glass/*.tsx renders). */
async function specimen(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector(".st-main")!;
    const st = document.createElement("style");
    st.textContent = `
      .st-main > :not(.st-e2e) { display: none !important; }
      .st-e2e { display: grid; gap: var(--st-gap); padding-bottom: 120px; font-family: var(--st-font); color: var(--st-text); font-size: var(--st-fs-body); line-height: var(--st-lh-body); }
      .st-e2e h1, .st-e2e h2, .st-e2e h3, .st-e2e p { margin: 0; }
      .st-e2e__pad { padding: var(--st-inset); display: grid; gap: 10px; align-content: start; }
      .st-e2e__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: var(--st-gap); }
      .st-e2e__bar { position: fixed; z-index: 80; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; gap: 12px; padding: 14px 18px; }
    `;
    document.head.append(st);
    const s = document.createElement("div");
    s.className = "st-e2e";
    s.innerHTML = `
      <header class="st-plate"><h1 class="st-display" style="font-size:var(--st-fs-h1);color:var(--st-text-strong)">Good evening</h1><p style="color:var(--st-text-soft)">Everything happening in your studio. Å ä ö.</p></header>
      <div style="display:flex;flex-wrap:wrap;gap:8px"><button class="st-pill is-on">Today</button><button class="st-pill">This week</button><span class="st-pill st-pill--small">All</span></div>
      <section class="st-glass st-glass--hero st-lens st-e2e__pad"><p class="st-caps" style="color:var(--st-text-amber)">Continue</p><h2 class="st-display">Bunny's big day</h2><p>Scene 3 of 5 is being made.</p>
        <div class="st-media"><span class="st-media__thumb"></span><span class="st-media__text"><span class="st-media__title">The sandwich tower</span><span class="st-media__meta">Bolt and Pip · 0:42</span></span><span class="st-media__bar"><span class="st-media__track"><span class="st-media__fill" style="width:40%"></span></span><span class="st-media__time">0:16</span></span></div></section>
      <div class="st-e2e__grid">
        <article class="st-glass st-e2e__pad"><div class="st-stat"><span class="st-stat__value"><span class="st-stat__num">24</span><span class="st-stat__unit">videos</span></span><span class="st-stat__label">Made this month</span><span class="st-stat__hint">+3 this week</span></div><p style="color:var(--st-text-muted);font-size:var(--st-fs-small)">A hint on the card</p></article>
        <section class="st-cream st-cream-card"><div class="st-cream-card__head"><div><p class="st-cream-card__eyebrow st-caps">Next video</p><h3 class="st-cream-card__title">Bunny's big day</h3></div></div><div class="st-cream-card__body">Posts at 18:00 by itself.</div></section>
        <article class="st-glass st-e2e__pad"><div class="st-dial" style="--st-dial-size:150px"><div class="st-dial__centre"><span class="st-dial__value">60%</span><span class="st-caps" style="color:var(--st-text-soft)">Setup</span></div></div></article>
        <article class="st-glass st-e2e__pad"><h3>Scenes at a time</h3><div class="st-stepper"><button class="st-stepper__btn" aria-label="Less"></button><output class="st-stepper__value">3</output><button class="st-stepper__btn" aria-label="More"></button></div></article>
        <article class="st-glass st-glass--tinted st-e2e__pad" style="--st-tone-rgb: var(--st-mint-rgb)"><h3>Posted</h3><p style="color:var(--st-mint-ink)">Done words in mint</p><p>Cream words on a tinted tile.</p></article>
      </div>
      <div class="st-glass st-glass--float st-e2e__bar"><span>Saved on this device.</span><span style="color:var(--st-text-amber)">Undo</span></div>`;
    main.append(s);
  });
  await page.waitForTimeout(500);
}

/** Every word in the specimen against the lightest and darkest pixel behind its own glyphs (words hidden). */
async function worstContrast(page: Page): Promise<{ worst: number; low: string[]; count: number }> {
  const items = await page.evaluate(() => {
    const out: { t: string; c: string; x: number; y: number; w: number; h: number }[] = [];
    const walk = document.createTreeWalker(document.querySelector(".st-e2e")!, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement!;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 3 || r.bottom < 0 || r.top > innerHeight) continue;
        const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.x + r.width / 2), Math.min(innerHeight - 1, r.y + r.height / 2));
        if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
        out.push({ t: n.textContent.trim().slice(0, 30), c: getComputedStyle(el).color, x: r.x, y: r.y + r.height * 0.15, w: r.width, h: r.height * 0.7 });
      }
    }
    return out;
  });
  await page.addStyleTag({ content: "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; } svg { visibility: hidden !important; }" });
  await page.waitForTimeout(250);
  const shot = await page.screenshot();
  const res = await page.evaluate(
    async ({ src, items }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext("2d")!;
      x.drawImage(img, 0, 0);
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const L = (r: number, g: number, b: number) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return items.map((it) => {
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(it.c)!;
        const tl = L(+m[1]!, +m[2]!, +m[3]!);
        const x0 = Math.max(0, Math.floor(it.x));
        const y0 = Math.max(0, Math.floor(it.y));
        const d = x.getImageData(x0, y0, Math.max(1, Math.min(img.width - x0, Math.ceil(it.w))), Math.max(1, Math.min(img.height - y0, Math.ceil(it.h)))).data;
        let lo = 1;
        let hi = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = L(d[i]!, d[i + 1]!, d[i + 2]!);
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        return { t: it.t, ratio: Math.min(cr(tl, lo), cr(tl, hi)) };
      });
    },
    { src: `data:image/png;base64,${shot.toString("base64")}`, items },
  );
  const low = res.filter((r) => r.ratio < 4.5).map((r) => `${r.ratio.toFixed(2)} "${r.t}"`);
  return { worst: Math.min(...res.map((r) => r.ratio)), low, count: res.length };
}

const BACKGROUNDS: { name: string; look: Look; picture?: "white" | "busy"; desktop?: "white" | "busy"; kind: string }[] = [
  { name: "Colours › Ember", look: {}, kind: "colours" },
  { name: "a white picture", look: { mode: "picture" }, picture: "white", kind: "picture" },
  { name: "a busy picture", look: { mode: "picture" }, picture: "busy", kind: "picture" },
  { name: "See-through, Clear, over a white desktop", look: { mode: "see-through", strength: "clear" }, desktop: "white", kind: "window" },
  { name: "See-through, Clear, over a busy desktop", look: { mode: "see-through", strength: "clear" }, desktop: "busy", kind: "window" },
  { name: "See-through, Frosted, over a white desktop", look: { mode: "see-through", strength: "frosted" }, desktop: "white", kind: "window" },
  { name: "See-through, Frosted, over a busy desktop", look: { mode: "see-through", strength: "frosted" }, desktop: "busy", kind: "window" },
];

test.describe("every word on the glass stays at 4.5:1", () => {
  for (const bg of BACKGROUNDS)
    for (const width of [375, 1440])
      test(`over ${bg.name} at ${width} px`, async ({ page }) => {
        await open(page, bg.look, { picture: bg.picture ?? null, desktop: bg.desktop ?? null, width });
        await expect(page.locator(".stories-app")).toHaveAttribute("data-look", bg.kind);
        await specimen(page);
        const { worst, low, count } = await worstContrast(page);
        expect(count, "words measured").toBeGreaterThan(12);
        expect(low, `worst ${worst.toFixed(2)}`).toEqual([]);
      });
});

test("the stage is drawn exactly as look.ts works the veils out (its lightest pixel)", async ({ page }) => {
  await open(page, {});
  // Only the stage itself (.stories-app::before follows .stories-app's own visibility).
  await page.addStyleTag({ content: "body * { visibility: hidden !important; } body .stories-app { visibility: visible !important; } body .stories-app * { visibility: hidden !important; }" });
  await page.waitForTimeout(300);
  const shot = await page.screenshot();
  const drawn = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    let hi = 0;
    for (let i = 0; i < d.length; i += 4) hi = Math.max(hi, 0.2126 * f(d[i]!) + 0.7152 * f(d[i + 1]!) + 0.0722 * f(d[i + 2]!));
    return hi;
  }, `data:image/png;base64,${shot.toString("base64")}`);
  // The model's lightest pixel for this very window (look.ts stageSpots: per window, as drawn and saturated).
  const at = STAGE_WINDOWS.findIndex(([w, h]) => w === 1440 && h === 900);
  const modelled = luminance(stageSpots(EMBER)[at * 2]!);
  expect(Math.abs(drawn - modelled), `drawn ${drawn.toFixed(4)}, modelled ${modelled.toFixed(4)}`).toBeLessThan(0.006);
});

test("the liquid rim bends at most three heroes, each with a filter of its own size", async ({ page }) => {
  // The rim is only for a capable device (look.ts readGlassEnv: more than 4 cores and 4 GB, no Save-Data); the Linux
  // CI runner has 4 cores and rightly gets the plain light. The device is set here, so it is liquid on every machine.
  await page.addInitScript(() => {
    for (const k of ["hardwareConcurrency", "deviceMemory"]) Object.defineProperty(navigator, k, { configurable: true, get: () => 8 });
  });
  await open(page, {});
  await expect(page.locator(".stories-app")).toHaveAttribute("data-glass", "liquid");
  await page.evaluate(() => {
    const main = document.querySelector(".st-main")!;
    for (let i = 0; i < 5; i++) {
      const h = document.createElement("section");
      h.className = "st-glass st-glass--hero st-lens";
      Object.assign(h.style, { padding: "24px", height: `${160 + i * 10}px`, margin: "12px 0" });
      h.textContent = `Hero ${i + 1}`;
      main.prepend(h);
    }
  });
  await expect(page.locator(".st-lens.is-liquid")).toHaveCount(3);
  const lenses = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".st-lens.is-liquid")).map((el) => {
      const url = el.style.getPropertyValue("--st-lens-url");
      const f = document.querySelector(url.slice(4, -1));
      const r = el.getBoundingClientRect();
      return { bf: getComputedStyle(el).backdropFilter, w: Math.round(r.width), h: Math.round(r.height), fw: Number(f?.getAttribute("width")), fh: Number(f?.getAttribute("height")), maps: f?.querySelectorAll("feImage").length, moves: f?.querySelectorAll("animate, animateTransform").length };
    }),
  );
  for (const l of lenses) {
    // The rim's own map, after the glass's dim (brightness(), look.ts DIM: 1 in every look), never animated.
    expect(l.bf).toMatch(/^blur\(1px\) brightness\((?:1|0?\.\d+)\) url\("?#st-lens-\d+"?\) saturate\(1\.5\)$/);
    expect([l.fw, l.fh]).toEqual([l.w, l.h]);
    expect(l.maps).toBe(1);
    expect(l.moves).toBe(0);
  }
  // Leaving Stories takes the filters off the page.
  await page.locator(".ws-dock .ws-switch__opt").first().click();
  await expect(page.locator("svg.st-lens__defs")).toHaveCount(0);
});

test("no rim bends over the window's own glass (See-through in the app: the desktop is not part of the page)", async ({ page }) => {
  await open(page, { mode: "see-through" }, { desktop: "white" });
  await expect(page.locator(".stories-app")).toHaveAttribute("data-look", "window");
  await specimen(page);
  await page.waitForTimeout(300);
  expect(await page.locator(".st-lens.is-liquid").count()).toBe(0);
  await expect(page.locator("svg.st-lens__defs")).toHaveCount(0);
});

test("reduced transparency makes every glass solid, with no backdrop filter", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await open(page, { mode: "picture" }, { picture: "busy" });
  const app = page.locator(".stories-app");
  await expect(app).toHaveAttribute("data-glass", "solid");
  await specimen(page);
  const got = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>(".stories-app")!;
    const glass = Array.from(document.querySelectorAll<HTMLElement>(".st-e2e .st-glass, .st-e2e .st-plate"));
    return { card: app.style.getPropertyValue("--st-veil-card"), page: app.style.getPropertyValue("--st-veil-page"), filters: glass.map((g) => getComputedStyle(g).backdropFilter), liquid: document.querySelectorAll(".is-liquid").length };
  });
  expect(got.card).toBe("0.96");
  expect(Number(got.page)).toBeGreaterThanOrEqual(0.9);
  expect(new Set(got.filters)).toEqual(new Set(["none"]));
  expect(got.liquid).toBe(0);
});

test("Settings › Look keeps its choice in Stories' own prefs and never touches Clip Factory's", async ({ page }) => {
  await open(page, {});
  // Look is its own page (a deep link straight to it), no longer the last card of Storage.
  await page.goto("/stories/settings/look");
  await expect(page.locator(".st-stg-tab.is-on")).toHaveText("Look");
  const clipFactoryBefore = await page.evaluate(() => ({ prefs: localStorage.getItem("cf.prefs"), background: localStorage.getItem("cf.background") }));
  const look = page.locator("#look");
  await look.waitFor();
  await look.scrollIntoViewIfNeeded();
  const bg = look.getByRole("radiogroup", { name: "Background" });
  await expect(bg.getByRole("radio", { name: /Colours/ })).toHaveAttribute("aria-checked", "true");
  await expect(look.getByRole("radiogroup", { name: "Colours" }).getByRole("radio", { name: /Ember/ })).toHaveAttribute("aria-checked", "true");
  await bg.getByRole("radio", { name: /See-through/ }).click();
  await look.getByRole("radiogroup", { name: "Glass strength" }).getByRole("radio", { name: "Frosted" }).click();
  // In a browser the window cannot show the desktop: the colours, frosted.
  await expect(page.locator(".stories-app")).toHaveAttribute("data-look", "colours");
  await expect(page.locator(".stories-app")).toHaveAttribute("data-strength", "frosted");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".stories-app")!.style.getPropertyValue("--st-veil-page"))).toBe("0.3");
  const stored = await page.evaluate(() => ({ stories: localStorage.getItem("cf.stories.prefs"), cf: { prefs: localStorage.getItem("cf.prefs"), background: localStorage.getItem("cf.background") }, html: document.documentElement.classList.contains("see-through") }));
  expect(JSON.parse(stored.stories!).more).toMatchObject({ "look.mode": "see-through", "look.strength": "frosted" });
  expect(stored.cf).toEqual(clipFactoryBefore);
  expect(stored.html).toBe(false);
  await bg.getByRole("radio", { name: /Picture/ }).click();
  await expect(look.getByRole("button", { name: "Choose a picture" })).toBeVisible();
  // nothing in the Look card is ever `disabled` (the deny sound needs the click)
  await expect(look.locator("[disabled]")).toHaveCount(0);
});
