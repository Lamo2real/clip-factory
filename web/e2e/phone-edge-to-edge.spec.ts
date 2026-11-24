import { expect, test, type Page } from "@playwright/test";
import { stillBackdrop } from "./helpers.ts";

// On a phone the app runs edge to edge, and nothing fixed and coloured lies across the top, at the top of a page or
// scrolled (the owner, 23 Nov: "remove the entire green top bar ... i want the user to be able to see more of the
// screen"; 24 Nov: "remove the top green top fixed color at the top, it just takes space and is unncessary";
// docs/CONTRACTS.md §11.1). The installed iPhone app's status bar is see-through (index.html: black-translucent,
// viewport-fit=cover), so each app's own backdrop shows under the clock, never a solid #0F372B band, never a strip of
// glass, and nothing of a page sits there: what scrolls up fades into the backdrop itself, drawn once more over the
// page in the status bar alone (Clip Factory's .backdrop--cover in its .backdrop-cover, Clips Funded's .st-cover). That
// cover costs a frame next to nothing: its box is the status bar and the top line's air alone, and nothing in it is
// blurred or clipped on any frame (Clip Factory's blobs are pictures of the backdrop's own blurred glows).
// No test browser has a status bar or sets env(safe-area-inset-top), so one is simulated through the app's own hooks
// (tokens.css): --top-safe, which every column starts below, and --status-bar-h, the status bar alone: 59 px (an iPhone
// with a Dynamic Island, 390 x 844) and 47 px (one with a notch, 375 x 812). For the installed app (a status bar) and
// for Safari (none: Safari draws its own bar above the page), in Clip Factory and Clips Funded:
//   (a) at the top of a page and at every scroll stop, the rows under the clock and the icons are the backdrop as it is
//       drawn alone, and white keeps AA on every pixel of them;
//   (b) every control on screen, the first one included, starts at or below the status bar;
//   (c) a bright bar fixed across the top of a page is masked under the clock, and shows from the top line down;
//   (d) over a light look (Cream, a light stage) and over the owner's own picture, the backdrop's own shade keeps the
//       white clock at AA, as little as that pixel needs (none over a dark top), lifting with no edge and gone on the
//       top line (12 px below the bar): nothing of it lies on the page below.
// Run in WebKit too (playwright.config.ts, projects "webkit" and "webkit-phone"): the iPhone app is WebKit.

const SIZES = [
  { w: 390, h: 844, inset: 59 },
  { w: 375, h: 812, inset: 47 },
] as const;
const BAND: [number, number, number] = [15, 55, 43]; // #0F372B, the band iOS drew with status-bar-style "black"
/** The rows iOS draws the clock and the icons on: the status bar's top 75 %, which the cover holds at full strength. */
const clockRows = (inset: number) => Math.floor(inset * 0.75);
const safe = (inset: number) => (inset ? `:root { --top-safe: max(${inset}px, var(--titlebar-h)) !important; --status-bar-h: ${inset}px !important; }` : "");

const PAGES = [
  { name: "Clip Factory Home", path: "/", stories: false },
  { name: "Clip Factory Settings", path: "/settings", stories: false },
  { name: "Clips Funded Dashboard", path: "/stories", stories: true },
] as const;

interface Setup {
  /** Clip Factory's look, on this device and on the (mock) server */
  prefs?: Record<string, unknown> | null;
  /** Clips Funded's Look (cf.stories.prefs `more`) */
  stories?: Record<string, unknown>;
  /** a picture for the chosen app's Picture look: its top quarter in this colour, white below */
  pictureTop?: string;
}

/** A phone with a status bar `inset` px tall (0: Safari, which draws its own bar above the page), Clips Funded on. */
async function phone(page: Page, size: { w: number; h: number; inset: number }, setup: Setup = {}) {
  await stillBackdrop(page);
  await page.addInitScript(
    ({ css, prefs, stories, pictureTop }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], more: stories ?? {} }));
      if (pictureTop) {
        const c = document.createElement("canvas");
        c.width = 780;
        c.height = 1688;
        const x = c.getContext("2d")!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = pictureTop;
        x.fillRect(0, 0, c.width, c.height / 4);
        const url = c.toDataURL("image/png");
        localStorage.setItem("cf.background", url);
        localStorage.setItem("cf.stories.picture", url);
      }
      // The look on this device and on the (mock) server, which /me reads back (api/mock/index.ts, cf-mock-look).
      if (prefs) localStorage.setItem("cf.prefs", JSON.stringify(prefs));
      if (prefs) sessionStorage.setItem("cf-mock-look", JSON.stringify(prefs));
      const add = () => {
        const style = document.createElement("style");
        style.dataset.e2e = "safe-area";
        style.textContent = css;
        document.head.append(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    },
    { css: safe(size.inset), prefs: setup.prefs ?? null, stories: setup.stories ?? null, pictureTop: setup.pictureTop ?? null },
  );
  await page.setViewportSize({ width: size.w, height: size.h });
}

async function open(page: Page, path: string, stories: boolean, inset: number) {
  await page.goto(path);
  if (stories) await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot, .st-loading"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
  // The simulated status bar is in force: every column starts below it, and the app knows it is there.
  expect(
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;top:var(--top-safe);height:var(--status-bar-h)";
      document.body.append(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      return [r.top, r.height];
    }),
  ).toEqual([inset, inset]);
  await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-status-bar"))).toBe(inset > 0);
}

/**
 * The RGB of every pixel in rows y0..y1 (CSS px), row by row: the page drawn at 1x, or with `fine`, drawn at the
 * screen's own pixels and each CSS pixel the mean of its device pixels, so a smooth gradient is read as the light it
 * really gives each row (WebKit's 1x capture is drawn again at 1x, with its gradient's dither landing on whole rows).
 */
async function rows(page: Page, y0: number, y1: number, fine = false): Promise<number[][][]> {
  const width = page.viewportSize()!.width;
  const png = (await page.screenshot({ clip: { x: 0, y: y0, width, height: y1 - y0 + 1 }, scale: fine ? "device" : "css" })).toString("base64");
  return page.evaluate(
    async ({ png, w, h }) => {
      const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const k = Math.max(1, Math.round(bmp.width / w));
      const out: number[][][] = [];
      for (let y = 0; y < Math.min(h, Math.floor(bmp.height / k)); y++) {
        const row: number[][] = [];
        for (let x = 0; x < Math.floor(bmp.width / k); x++) {
          const px = [0, 0, 0];
          for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) for (let c = 0; c < 3; c++) px[c]! += d[((y * k + dy) * bmp.width + x * k + dx) * 4 + c]!;
          row.push(px.map((v) => Math.round(v / (k * k))));
        }
        out.push(row);
      }
      return out;
    },
    { png, w: width, h: y1 - y0 + 1 },
  );
}

/**
 * Draws only the app's own backdrop, as the page draws it under everything (Clip Factory's .backdrop, Clips Funded's
 * .stories-app::before stage): not its cover, nothing of the page. Gives back a way to draw the page again.
 */
async function backdropAlone(page: Page, stories: boolean): Promise<() => Promise<void>> {
  const tag = await page.addStyleTag({
    content: stories
      ? "body * { visibility: hidden !important; } .stories-app { visibility: visible !important; }"
      : "body * { visibility: hidden !important; } .backdrop:not(.backdrop--cover), .backdrop:not(.backdrop--cover) * { visibility: visible !important; }",
  });
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await frames();
  return async () => {
    await tag.evaluate((el) => (el as Element).remove());
    await frames();
  };
}

/** Every control on screen (not the skip link, which waits above the window until it is focused). */
async function controlTops(page: Page) {
  return page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => {
        if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      })
      .map((el) => ({ what: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`, top: Math.round(el.getBoundingClientRect().top * 10) / 10 }))
      .sort((a, b) => a.top - b.top);
  });
}

const near = (a: number[], b: number[], tol: number) => a.every((c, i) => Math.abs(c - b[i]!) <= tol);

function luminance([r, g, b]: number[]): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}
const whiteOn = (c: number[]) => 1.05 / (luminance(c) + 0.05);

/** How far `drawn` is from `alone`, pixel by pixel: the mean and the worst channel difference. */
function apart(drawn: number[][][], alone: number[][][]) {
  let worst = 0;
  let sum = 0;
  let n = 0;
  drawn.forEach((row, y) =>
    row.forEach((px, x) => {
      const d = Math.max(...px.map((c, i) => Math.abs(c - alone[y]![x]![i]!)));
      worst = Math.max(worst, d);
      sum += d;
      n++;
    }),
  );
  return { mean: sum / n, worst };
}

/** The least contrast of white on any pixel of `drawn`. */
const leastWhite = (drawn: number[][][]) => Math.min(...drawn.flatMap((r) => r.map(whiteOn)));

/** The cover each app draws in the status bar: Clip Factory's second backdrop, Clips Funded's stage once more. */
async function covers(page: Page, stories: boolean): Promise<number> {
  return page.evaluate((stories) => {
    return [...document.querySelectorAll(stories ? ".st-cover" : ".backdrop-cover")].filter((el) => {
      const cs = getComputedStyle(el);
      const inside = el.querySelectorAll(stories ? ".st-cover__stage" : ".backdrop.backdrop--cover").length === 1;
      return inside && cs.display !== "none" && cs.position === "fixed" && /gradient/.test(cs.webkitMaskImage || cs.maskImage);
    }).length;
  }, stories);
}

/**
 * What the cover costs a frame: its box (it is the status bar and the top line's air alone, so its fade is that small
 * and nothing of it is drawn below), and what in it is blurred or clipped (nothing: a blur or a clip there is drawn
 * again on every frame, by the phone's GPU, and in software on a machine without one).
 */
async function coverCost(page: Page, stories: boolean) {
  return page.evaluate((stories) => {
    const cover = document.querySelector<HTMLElement>(stories ? ".st-cover" : ".backdrop-cover")!;
    const r = cover.getBoundingClientRect();
    const all = [cover, ...cover.querySelectorAll<HTMLElement>("*")];
    const style = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo);
    const every = all.flatMap((el) => [style(el), style(el, "::before"), style(el, "::after")]);
    return {
      top: r.top,
      height: r.height,
      blurred: every.filter((cs) => cs.filter !== "none" || (cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter") || "none") !== "none").length,
      clipped: every.filter((cs) => cs.clipPath !== "none").length,
    };
  }, stories);
}

for (const size of SIZES) {
  const at = `${size.w}x${size.h} with a ${size.inset} px status bar`;
  const top = clockRows(size.inset) - 1;

  test.describe(`the installed app at ${at}: the backdrop runs up under the clock`, () => {
    for (const p of PAGES) {
      test(`${p.name}, at the top of the page`, async ({ page }) => {
        await phone(page, size);
        await open(page, p.path, p.stories, size.inset);
        expect(await covers(page, p.stories), "the backdrop's cover in the status bar").toBe(1);
        expect(await coverCost(page, p.stories), "the cover: the status bar and the top line's air, nothing blurred or clipped").toEqual({ top: 0, height: size.inset + 12, blurred: 0, clipped: 0 });

        // (b) Nothing to tap or read under the clock: every control on screen starts below the status bar.
        const tops = await controlTops(page);
        expect(tops.length, "controls on screen").toBeGreaterThan(3);
        expect(tops[0]!.top, `the first control, ${tops[0]!.what}`).toBeGreaterThanOrEqual(size.inset);
        expect(tops.filter((t) => t.top < size.inset)).toEqual([]);
        // The page's first column sits on the top line, just below the status bar.
        expect(tops[0]!.top).toBeLessThan(size.inset + 40);

        // (a) Under the clock and the icons: the backdrop as it is drawn alone, not a band, a strip or a scrim.
        const drawn = await rows(page, 0, top);
        for (const row of drawn) expect(row.filter((px) => near(px, BAND, 3)).length / row.length, "share of a row that is the old #0F372B band").toBeLessThan(0.5);
        const back = await backdropAlone(page, p.stories);
        const alone = await rows(page, 0, top);
        await back();
        const d = apart(drawn, alone);
        expect(d.mean, "under the clock against the backdrop drawn alone (mean)").toBeLessThanOrEqual(3);
        expect(d.worst, "under the clock against the backdrop drawn alone (worst pixel)").toBeLessThanOrEqual(12);
        // And the backdrop under the clock keeps the white clock at AA on every pixel (the dark looks need no shade).
        expect(leastWhite(drawn), "white on the lightest pixel under the clock").toBeGreaterThanOrEqual(4.5);
      });
    }

    const SCROLLED = [
      { name: "Clip Factory Home", path: "/", stories: false },
      { name: "Clip Factory Library", path: "/library", stories: false },
      { name: "Clip Factory's Content Rewards help (the owner's screenshot)", path: "/settings/posting/setup/contentrewards", stories: false },
      { name: "Clips Funded Dashboard", path: "/stories", stories: true },
      { name: "Clips Funded Ideas", path: "/stories/ideas", stories: true },
    ] as const;
    for (const p of SCROLLED) {
      test(`${p.name}, scrolled: under the clock only the backdrop, at every scroll stop`, async ({ page }) => {
        await phone(page, size);
        await open(page, p.path, p.stories, size.inset);
        // The owner's page with every fold open, as in the screenshot.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
        await page.waitForTimeout(300);
        const back = await backdropAlone(page, p.stories);
        const alone = await rows(page, 0, top);
        await back();
        const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        expect(room, "the page is long enough to scroll").toBeGreaterThan(300);
        const failing: string[] = [];
        let stops = 0;
        let passedUnder = 0;
        const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        for (let y = 50; y <= Math.min(room, 2500); y += y < 400 ? 50 : 100) {
          await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), y);
          // Nothing comes or goes as the page moves: the cover is always there, so no wait for anything to fade in.
          await page.waitForTimeout(stops === 0 ? 300 : 60);
          const drawn = await rows(page, 0, top);
          const d = apart(drawn, alone);
          if (d.mean > 3 || d.worst > 12) failing.push(`scrollY ${y}: ${d.mean.toFixed(2)} mean, ${d.worst} worst off the backdrop`);
          const least = leastWhite(drawn);
          if (least < 4.5) failing.push(`scrollY ${y}: white ${least.toFixed(2)}:1`);
          // Something of the page really is under the clock (it is there to be masked): without the cover the row in
          // the middle of the status bar is not the backdrop. Seen at three stops, the check has made its point; the
          // stops after it are checked as every stop is (above), without taking the cover away and back each time.
          if (passedUnder < 3) {
            const bare = await page.addStyleTag({ content: ".backdrop--cover, .st-cover { visibility: hidden !important; }" });
            await frames();
            const y0 = Math.floor(size.inset / 2);
            if (apart(await rows(page, y0, y0), [alone[y0]!]).mean > 3) passedUnder++;
            await bare.evaluate((el) => (el as Element).remove());
            await frames();
          }
          stops++;
        }
        expect(stops).toBeGreaterThan(4);
        expect(passedUnder, "scroll stops with a card or a control under the clock").toBeGreaterThan(2);
        expect(failing, "under the clock, at each scroll stop").toEqual([]);
      });
    }

    for (const stories of [false, true]) {
      test(`${stories ? "Clips Funded" : "Clip Factory"}: a bright bar fixed across the top of a page is masked under the clock, and shows from the top line down`, async ({ page }) => {
        await phone(page, size);
        await open(page, stories ? "/stories" : "/", stories, size.inset);
        const back = await backdropAlone(page, stories);
        const alone = await rows(page, 0, top);
        await back();
        // The setup list's pill sits on the top line above the page (and the cover), with its shadow: out of the way.
        await page.addStyleTag({ content: ".setup-todo { visibility: hidden !important; }" });
        // A cream bar fixed at the very top, as high as a page's own bars are drawn (the setup list's strip, a tab bar).
        await page.evaluate(
          ({ stories, h }) => {
            const bar = document.createElement("div");
            bar.dataset.e2e = "top-bar";
            bar.style.cssText = `position:fixed;top:0;left:0;right:0;height:${h + 40}px;z-index:${stories ? 40 : 41};background:#fff6ea;pointer-events:none`;
            (document.querySelector(stories ? ".st-frame" : ".shell") ?? document.body).append(bar);
          },
          { stories, h: size.inset },
        );
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const drawn = await rows(page, 0, size.inset + 30);
        // Under the clock: the backdrop, as if the bar were not there.
        const d = apart(drawn.slice(0, top + 1), alone);
        expect(d.mean, "under the clock over a cream bar (mean)").toBeLessThanOrEqual(3);
        expect(d.worst, "under the clock over a cream bar (worst pixel)").toBeLessThanOrEqual(12);
        expect(leastWhite(drawn.slice(0, top + 1))).toBeGreaterThanOrEqual(4.5);
        // It fades in over the top line's air with no edge: each row a little more of it, never a jump.
        const mid = (y: number) => luminance(drawn[y]![Math.floor(size.w / 2)]!);
        for (let y = top; y < size.inset + 12; y++) expect(mid(y + 1) - mid(y), `row ${y + 1}`).toBeLessThanOrEqual(0.15);
        // From the top line down it is the page's, untouched.
        for (const y of [size.inset + 12, size.inset + 20, size.inset + 30]) drawn[y]!.forEach((px, x) => expect(near(px, [255, 246, 234], 2), `row ${y}, x ${x}: ${px}`).toBe(true));
      });
    }
  });

  test.describe(`Safari at ${size.w}x${size.h}: its own bar above the page, nothing of the page's over it`, () => {
    for (const stories of [false, true]) {
      test(`${stories ? "Clips Funded" : "Clip Factory"}: no cover, the page runs to the top of its window, theme-color is the backdrop's own`, async ({ page }) => {
        await phone(page, { ...size, inset: 0 });
        await open(page, stories ? "/stories" : "/", stories, 0);
        expect(await covers(page, stories)).toBe(0);
        if (!stories) expect(await page.locator(".backdrop").count()).toBe(1);
        // The page's own first column on the line, 12 px down (Safari's bar is above the window).
        const tops = await controlTops(page);
        expect(tops[0]!.top).toBeGreaterThanOrEqual(12);
        expect(tops[0]!.top).toBeLessThan(52);
        // Above it the backdrop, as it is drawn alone.
        const drawn = await rows(page, 0, 8);
        const back = await backdropAlone(page, stories);
        const alone = await rows(page, 0, 8);
        await back();
        expect(apart(drawn, alone).mean).toBeLessThanOrEqual(3);
        // Safari tints its own bar from theme-color: the backdrop's own colour (Clip Factory's top edge, close to its
        // average; Clips Funded's stage colour, its base).
        const theme = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content);
        expect(theme).toBe(stories ? "#1C130E" : "#13483C");
        if (stories) expect(await page.evaluate(() => getComputedStyle(document.querySelector(".stories-app")!).getPropertyValue("--st-stage-c1").trim())).toBe(theme.toLowerCase());
        else {
          const rgb = [1, 3, 5].map((i) => parseInt(theme.slice(i, i + 2), 16));
          const average = [0, 1, 2].map((c) => alone[0]!.reduce((s, px) => s + px[c]!, 0) / alone[0]!.length);
          for (let c = 0; c < 3; c++) expect(Math.abs(average[c]! - rgb[c]!), `theme-color against the backdrop's top row, channel ${c}`).toBeLessThanOrEqual(12);
        }
        // Scrolled, the page runs on up to the top of its window: no cover in Safari (it has no status bar to keep).
        const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        expect(room).toBeGreaterThan(300);
        let seen = 0;
        for (let y = 100; y <= Math.min(room, 1200); y += 100) {
          await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }), y);
          await page.waitForTimeout(60);
          if (apart(await rows(page, 0, 8), alone).mean > 3) seen++;
        }
        expect(seen, "scroll stops where the page shows at the top of Safari's window").toBeGreaterThan(2);
      });
    }
  });

  test.describe(`over a light look at ${at}: the white clock keeps AA over the backdrop's own top, shaded only if it must be`, () => {
    const LIGHT = [
      { name: "Clip Factory on Cream: its backdrop's own shade, with no edge", stories: false, shaded: true, setup: { prefs: { backgroundMode: "colours", backgroundColours: ["#f7f5ef"] } } },
      // Clips Funded's page veil over light colours already holds the white clock (stories/look.ts): no shade at all.
      { name: "Clips Funded on a light stage: its page veil holds the clock, no shade", stories: true, shaded: false, setup: { stories: { "look.mode": "colours", "look.colours": ["#fff3e4", "#e2621f", "#ff9a45"] } } },
    ] as const;
    for (const l of LIGHT) {
      test(l.name, async ({ page }) => {
        await phone(page, size, l.setup);
        await open(page, l.stories ? "/stories" : "/", l.stories, size.inset);
        if (!l.stories) await expect(page.locator(".backdrop--colours").first()).toHaveAttribute("data-colours", "#f7f5ef");
        else await expect(page.locator(".stories-app")).toHaveAttribute("data-look", "colours");
        const shade = await page.evaluate((stories) => {
          const el = stories ? document.querySelector<HTMLElement>(".stories-app")! : document.documentElement;
          return { scrim: Number(el.style.getPropertyValue(stories ? "--st-status-scrim" : "--status-scrim")), shade: el.style.getPropertyValue(stories ? "--st-status-shade" : "--status-shade") };
        }, l.stories);
        if (l.shaded) {
          expect(shade.scrim).toBeGreaterThan(0);
          expect(shade.scrim).toBeLessThan(0.6);
          expect(shade.shade).toMatch(/^linear-gradient\(/);
        } else {
          expect(shade.scrim).toBe(0);
          expect(shade.shade).toBe("none");
          expect(Number(await page.locator(".stories-app").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--st-veil-page")))).toBeGreaterThan(0.5);
        }
        // It is the backdrop's own: under the clock the page is the backdrop drawn alone (its shade too), at AA.
        const end = size.inset + 40;
        const drawn = await rows(page, 0, end, true);
        const back = await backdropAlone(page, l.stories);
        const alone = await rows(page, 0, end, true);
        await back();
        expect(apart(drawn.slice(0, top + 1), alone.slice(0, top + 1)).mean).toBeLessThanOrEqual(3);
        expect(leastWhite(drawn.slice(0, top + 1)), "white over the shaded backdrop, under the clock").toBeGreaterThanOrEqual(4.5);
        // It lifts row by row (no edge) and is gone on the top line, 12 px below the bar: from there down Cream is
        // untouched, as it is further down the page.
        if (l.shaded) {
          const lum = alone.map((r) => r.reduce((s, px) => s + luminance(px), 0) / r.length);
          for (let y = 1; y < lum.length; y++) expect(lum[y]! - lum[y - 1]!, `row ${y}`).toBeGreaterThanOrEqual(-0.004);
          // (even in light over the cover's own span: about 0.03 a row at most; an edge would be a step of 0.5)
          for (let y = 1; y < lum.length; y++) expect(lum[y]! - lum[y - 1]!, `row ${y}`).toBeLessThanOrEqual(0.05);
          for (let y = size.inset + 12; y <= end; y++) {
            expect(Math.min(...alone[y]!.map(luminance)), `Cream on row ${y}, the top line and below`).toBeGreaterThan(0.6);
            expect(apart([alone[y]!], [alone[end]!]).worst, `row ${y} against Cream lower down`).toBeLessThanOrEqual(2);
          }
        }
      });
    }
  });
}

test.describe("over the owner's own picture: only the shade its own top needs, read from its pixels", () => {
  const size = SIZES[0];
  for (const stories of [false, true])
    for (const pic of [
      { top: "#14202c", name: "a dark top (a night sky): no shade at all", needs: false },
      { top: "#ffffff", name: "a white top: the shade AA needs", needs: true },
    ]) {
      test(`${stories ? "Clips Funded" : "Clip Factory"}, ${pic.name}`, async ({ page }) => {
        await phone(page, size, stories ? { stories: { "look.mode": "picture" }, pictureTop: pic.top } : { prefs: { backgroundMode: "picture" }, pictureTop: pic.top });
        await open(page, stories ? "/stories" : "/", stories, size.inset);
        const read = () =>
          page.evaluate((stories) => {
            const el = stories ? document.querySelector<HTMLElement>(".stories-app")! : document.documentElement;
            return Number(el.style.getPropertyValue(stories ? "--st-status-scrim" : "--status-scrim"));
          }, stories);
        if (pic.needs) {
          await expect.poll(read).toBeGreaterThan(0.5);
        } else {
          // Planned for white until the picture is read, then nothing.
          await expect.poll(read).toBe(0);
          expect(await page.evaluate((stories) => (stories ? document.querySelector<HTMLElement>(".stories-app")! : document.documentElement).style.getPropertyValue(stories ? "--st-status-shade" : "--status-shade"), stories)).toBe("none");
        }
        await page.waitForTimeout(200);
        const below = 2 * size.inset + 10;
        const drawn = await rows(page, 0, clockRows(size.inset) - 1);
        const back = await backdropAlone(page, stories);
        const alone = await rows(page, 0, below);
        await back();
        // Under the clock: the backdrop (the picture), at AA.
        expect(apart(drawn, alone.slice(0, drawn.length)).mean).toBeLessThanOrEqual(3);
        expect(leastWhite(drawn), "white over the picture under the clock").toBeGreaterThanOrEqual(4.5);
        // The picture's top quarter is one colour: with no shade, under the clock it is exactly what it is lower down.
        const lum = (y: number) => alone[y]!.reduce((s, px) => s + luminance(px), 0) / alone[y]!.length;
        if (pic.needs) expect(lum(0), "shaded under the clock").toBeLessThan(lum(below) * 0.5);
        else for (let y = 0; y < clockRows(size.inset); y++) expect(apart([alone[y]!], [alone[below]!]).worst, `row ${y}`).toBeLessThanOrEqual(3);
      });
    }
});
