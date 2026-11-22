// The Lamo Stories engine on a real page (docs/CONTRACTS.md §45.10, §45.34), in mock mode: Review's live player draws
// the story in its own shape. The mock's stories are 9:16; the same story made wide (16:9) or square (1:1) is drawn in
// that shape, filled edge to edge, with the arrow cursor kept and nothing scrolling sideways from 320 px.
import { expect, test, type Browser, type Page } from "@playwright/test";

/** The mock's seeded story that is ready to watch (SEED_IDS in src/stories/api/mock/stories.ts). */
const READY = "01JSTST0000000000000000001";

type MockWindow = Window & { __cfStoriesMock?: { store?: { scripts: Record<string, { engine: number; width: number; height: number }> } } };

async function context(browser: Browser, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  return ctx;
}

async function waitForStudio(page: Page) {
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
}

/** Moves inside the app like a tap on a link (a reload would start the in-memory mock afresh). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await waitForStudio(page);
}

/** The player's canvas: its shown size, its pixel size, and whether its corners and middle were painted. */
async function player(page: Page) {
  const canvas = page.locator(".st-s-player canvas.st-story-preview");
  await expect(canvas).toBeVisible();
  // the still frame (reduced motion) is painted on the next animation frame
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>(".st-s-player canvas.st-story-preview");
    const ctx = c?.getContext("2d");
    return !!c && !!ctx && ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[3]! > 0;
  });
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".st-s-player canvas.st-story-preview")!;
    const r = c.getBoundingClientRect();
    const ctx = c.getContext("2d")!;
    const at = (x: number, y: number) => ctx.getImageData(Math.min(c.width - 1, Math.floor(x)), Math.min(c.height - 1, Math.floor(y)), 1, 1).data[3]!;
    return {
      shown: { w: r.width, h: r.height },
      pixels: { w: c.width, h: c.height },
      painted: [at(1, 1), at(c.width - 2, 1), at(1, c.height - 2), at(c.width - 2, c.height - 2), at(c.width / 2, c.height / 2)].every((a) => a === 255),
      cursor: getComputedStyle(c).cursor,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

for (const [w, h] of [
  [320, 640],
  [1280, 800],
] as const) {
  test(`Review's live player draws the story in its own shape: 9:16, then 16:9 and 1:1 (${w}x${h})`, async ({ browser }) => {
    const ctx = await context(browser, w, h);
    const page = await ctx.newPage();
    await page.goto(`/stories/review/${READY}`);
    await waitForStudio(page);

    // the mock's own story: tall 9:16, painted to every corner
    const tall = await player(page);
    expect(tall.painted).toBe(true);
    expect(tall.shown.h / tall.shown.w).toBeCloseTo(16 / 9, 1);
    expect(tall.pixels.h / tall.pixels.w).toBeCloseTo(16 / 9, 2);
    expect(["auto", "default"]).toContain(tall.cursor);
    expect(tall.sideways).toBe(false);

    for (const [width, height] of [
      [1920, 1080],
      [1080, 1080],
      [1280, 720],
    ] as const) {
      // the same story in another size (what a story made with that shape gets from the agent)
      const changed = await page.evaluate(
        ([id, wd, ht]) => {
          const store = (window as MockWindow).__cfStoriesMock?.store;
          const script = store?.scripts[id];
          if (!script) return false;
          store!.scripts[id] = { ...script, engine: Math.max(5, script.engine), width: wd, height: ht };
          return true;
        },
        [READY, width, height] as const,
      );
      expect(changed).toBe(true);
      await go(page, "/stories/review");
      await go(page, `/stories/review/${READY}`);
      const shaped = await player(page);
      expect(shaped.painted, `${width}x${height}`).toBe(true);
      expect(shaped.shown.h / shaped.shown.w, `${width}x${height}`).toBeCloseTo(height / width, 1);
      expect(shaped.pixels.h / shaped.pixels.w, `${width}x${height}`).toBeCloseTo(height / width, 2);
      expect(shaped.sideways, `${width}x${height}`).toBe(false);
    }
    await ctx.close();
  });
}
