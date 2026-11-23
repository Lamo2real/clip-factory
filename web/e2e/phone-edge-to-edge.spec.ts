import { expect, test, type Page } from "@playwright/test";
import { stillBackdrop } from "./helpers.ts";

// On a phone the app runs edge to edge (the owner, 23 Nov: "remove the entire green top bar ... i want the user to be
// able to see more of the screen then just some green color at the top"; docs/CONTRACTS.md §11.1). The installed
// iPhone app's status bar is see-through (index.html: black-translucent, viewport-fit=cover), so each app's own
// backdrop shows under the clock, never a solid #0F372B band, and nothing of a page sits there.
// No test browser has a status bar or sets env(safe-area-inset-top), so a 59 px one (an iPhone with a Dynamic Island)
// is simulated through the app's own hooks (tokens.css): --top-safe, which every column starts below, and
// --status-bar-h, the status bar alone. At 390 x 844, in Clip Factory (Home, Settings) and Clips Funded (Dashboard):
//   (a) the pixel row at y = 10, under the clock, is the backdrop as it is drawn alone, not the solid green band;
//   (b) every control on screen, the first one included, starts at or below the status bar.
// And over a light look (Cream) the soft scrim keeps the white clock at AA there.
// Run in WebKit too (playwright.config.ts, project "webkit"): the iPhone app is WebKit.

const INSET = 59;
const W = 390;
const H = 844;
const BAND: [number, number, number] = [15, 55, 43]; // #0F372B, the band iOS drew with status-bar-style "black"
const SAFE = `:root { --top-safe: max(${INSET}px, var(--titlebar-h)) !important; --status-bar-h: ${INSET}px !important; }`;

const PAGES = [
  { name: "Clip Factory Home", path: "/", stories: false },
  { name: "Clip Factory Settings", path: "/settings", stories: false },
  { name: "Clips Funded Dashboard", path: "/stories", stories: true },
] as const;

/** A phone with a 59 px status bar, Clips Funded switched on (the workspace switch in both apps' top bars). */
async function phone(page: Page, prefs: Record<string, unknown> | null = null) {
  await stillBackdrop(page);
  await page.addInitScript(
    ({ css, prefs }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], more: {} }));
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
    { css: SAFE, prefs },
  );
  await page.setViewportSize({ width: W, height: H });
}

async function open(page: Page, path: string, stories: boolean) {
  await page.goto(path);
  if (stories) await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot, .st-loading"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
  // The simulated status bar is in force: every column starts below it.
  expect(await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:var(--top-safe);height:var(--status-bar-h)";
    document.body.append(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return [r.top, r.height];
  })).toEqual([INSET, INSET]);
}

/** The RGB of every pixel in rows y0..y1 (CSS px, the page drawn at 1x), row by row. */
async function rows(page: Page, y0: number, y1: number): Promise<number[][][]> {
  const png = (await page.screenshot({ clip: { x: 0, y: y0, width: W, height: y1 - y0 + 1 }, scale: "css" })).toString("base64");
  return page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const out: number[][][] = [];
    for (let y = 0; y < bmp.height; y++) {
      const row: number[][] = [];
      for (let x = 0; x < bmp.width; x++) row.push([d[(y * bmp.width + x) * 4]!, d[(y * bmp.width + x) * 4 + 1]!, d[(y * bmp.width + x) * 4 + 2]!]);
      out.push(row);
    }
    return out;
  }, png);
}

/** Draws only the app's backdrop (Clip Factory's .backdrop, Clips Funded's .stories-app::before stage). */
async function backdropAlone(page: Page, stories: boolean) {
  await page.addStyleTag({
    content: stories
      ? "body * { visibility: hidden !important; } .stories-app { visibility: visible !important; } .stories-app::after { display: none !important; }"
      : "body * { visibility: hidden !important; } .backdrop, .backdrop * { visibility: visible !important; }",
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
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

test.describe("a phone runs edge to edge: the backdrop shows under the status bar", () => {
  for (const p of PAGES) {
    test(`${p.name} at ${W}x${H} with a ${INSET} px status bar`, async ({ page }) => {
      await phone(page);
      await open(page, p.path, p.stories);

      // (b) Nothing to tap or read under the clock: every control on screen starts below the status bar.
      const tops = await controlTops(page);
      expect(tops.length, "controls on screen").toBeGreaterThan(3);
      expect(tops[0]!.top, `the first control, ${tops[0]!.what}`).toBeGreaterThanOrEqual(INSET);
      expect(tops.filter((t) => t.top < INSET)).toEqual([]);
      // The page's first column sits on the top line, just below the status bar.
      expect(tops[0]!.top).toBeLessThan(INSET + 40);

      // (a) The row under the clock is the backdrop, not a solid green band.
      const [row] = await rows(page, 10, 10);
      const green = row!.filter((px) => near(px, BAND, 3)).length;
      expect(green / row!.length, "share of the row that is the old #0F372B band").toBeLessThan(0.5);
      await backdropAlone(page, p.stories);
      const [alone] = await rows(page, 10, 10);
      let worst = 0;
      let sum = 0;
      for (let x = 0; x < W; x++) {
        const d = Math.max(...row![x]!.map((c, i) => Math.abs(c - alone![x]![i]!)));
        worst = Math.max(worst, d);
        sum += d;
      }
      expect(sum / W, "the row under the clock against the backdrop drawn alone (mean)").toBeLessThanOrEqual(3);
      expect(worst, "the row under the clock against the backdrop drawn alone (worst pixel)").toBeLessThanOrEqual(12);
      // And the backdrop under the clock keeps the white clock at AA (the dark looks need no scrim).
      expect(Math.min(...row!.map(whiteOn)), "white on the row under the clock").toBeGreaterThanOrEqual(4.5);
    });
  }

  test("a light look (Cream) gets a soft scrim in the status bar alone: the white clock keeps AA, the page below is untouched", async ({ page }) => {
    await phone(page, { backgroundMode: "colours", backgroundColours: ["#f7f5ef"] });
    await open(page, "/", false);
    await expect(page.locator(".backdrop--colours")).toHaveAttribute("data-colours", "#f7f5ef");
    const scrim = Number(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--status-scrim")));
    expect(scrim).toBeGreaterThan(0);
    expect(scrim).toBeLessThan(0.6);
    await backdropAlone(page, false);
    await page.addStyleTag({ content: ".app { visibility: visible !important; }" });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // Where the clock and the icons are drawn (from the top of the screen to 75 % of the status bar): AA everywhere.
    const clock = await rows(page, 0, Math.floor(INSET * 0.75) - 1);
    const least = Math.min(...clock.flatMap((r) => r.map(whiteOn)));
    expect(least, "white on the scrim over Cream, under the clock").toBeGreaterThanOrEqual(4.5);
    // Below the status bar the backdrop is as it is: Cream, not darkened.
    const [below] = await rows(page, INSET + 4, INSET + 4);
    expect(Math.min(...below!.map(luminance)), "Cream just below the status bar").toBeGreaterThan(0.6);
  });
});
