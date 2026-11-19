import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle } from "./helpers.ts";

// A page change keeps the window perfectly still (docs/CONTRACTS.md §20.16): only the content swaps. Nothing blinks
// white, nothing twitches. The owner saw the whole see-through desktop window flash on every menu tap: the page
// cross-fade (View Transitions) blended two pictures of the window and thinned out every glass panel for a moment,
// and each new page faded in from transparent, so the light window glass showed through for about 300 ms.
// Run in WebKit too (playwright.config.ts, project "webkit"), the engine of the macOS desktop app.

/** The light native glass at its lightest: white behind the transparent page. A blink shows as a jump toward it. */
const WHITE_GLASS = "html { background: #fff !important; }";

type Region = { name: string; x: number; y: number; w: number; h: number };

/** Mean grey of each region in one screenshot, worked out in the page so no PNG library is needed. */
async function greys(page: Page, regions: Region[]): Promise<number[]> {
  const png = await page.screenshot({ scale: "css", animations: "allow" });
  return page.evaluate(
    async ({ b64, regions }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return regions.map(({ x, y, w, h }) => {
        const d = ctx.getImageData(x, y, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        return s / (d.length / 4);
      });
    },
    { b64: png.toString("base64"), regions },
  );
}

/**
 * Watches every frame for 700 ms after a tap on `item`: no View Transition, no animation fading a glass panel or the
 * page itself, the page's panels never see-through-er than at rest, the backdrop is the same element throughout.
 */
async function watchFrames(page: Page, item: string) {
  return page.evaluate(
    (item) =>
      new Promise<string[]>((done) => {
        const problems = new Set<string>();
        const backdrop = document.querySelector(".backdrop");
        const t0 = performance.now();
        const fades = (a: Animation) => {
          const kf = (a.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          return kf.some((f) => f.opacity !== undefined && Number(f.opacity) < 0.99);
        };
        const tick = () => {
          for (const a of document.getAnimations()) {
            const effect = a.effect as KeyframeEffect | null;
            const pseudo = effect?.pseudoElement ?? "";
            if (pseudo.startsWith("::view-transition")) problems.add(`view transition ${pseudo}`);
            const el = effect?.target as Element | null;
            if (!el || a.playState !== "running" || !fades(a)) continue;
            if (el.matches("html, body, .app, .shell, .main, .main > *, .sidebar, .glass") || el.querySelector(".glass"))
              problems.add(`${el.className || el.tagName} fades (${(a as CSSAnimation).animationName ?? a.id})`);
          }
          // Every panel of the new page is at full strength from its first frame.
          for (const g of document.querySelectorAll<HTMLElement>(".main .glass")) {
            let o = 1;
            for (let n: HTMLElement | null = g; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
            if (o < 0.99) problems.add(`a panel at ${o.toFixed(2)} opacity`);
          }
          if (document.querySelector(".backdrop") !== backdrop) problems.add("the backdrop was drawn again");
          if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          else done([...problems]);
        };
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(item)!.click();
          tick();
        });
      }),
    item,
  );
}

/** Taps through the menu and samples fixed regions in screenshots right after each tap; they must not move. */
async function stillRegions(page: Page, regions: Region[], items: string[]) {
  const rest = await greys(page, regions);
  const worst = regions.map(() => 0);
  for (const item of items) {
    await page.locator(item).click();
    for (let i = 0; i < 6; i++) {
      const now = await greys(page, regions);
      now.forEach((g, k) => (worst[k] = Math.max(worst[k]!, Math.abs(g - rest[k]!))));
    }
  }
  const report = regions.map((r, k) => `${r.name} ${worst[k]!.toFixed(1)}`).join(", ");
  test.info().annotations.push({ type: "still", description: report });
  // About 1% of the grey scale: the old cross-fade moved the menu 30 to 60 levels toward white.
  regions.forEach((r, k) => expect(worst[k], `${r.name} changed by ${worst[k]!.toFixed(1)} grey levels (${report})`).toBeLessThanOrEqual(3));
}

const MENU = ["review", "library", "settings", "home", "jobs"].map((k) => `.sidebar__item[data-help="nav-${k}"]`);

/**
 * Share of near-white pixels in the page's content below its title: on the see-through window over white, that is
 * how much of the light glass shows through. A page that renders empty or with see-through placeholders while its
 * data loads shows as a jump toward 1.
 */
async function lightShare(page: Page): Promise<number> {
  const box = await page.evaluate(() => {
    const main = document.querySelector(".main")!.getBoundingClientRect();
    const head = document.querySelector(".main .page-head, .main h1");
    const top = Math.round(
      head ? head.getBoundingClientRect().bottom + 8 : main.top + 120,
    );
    return {
      x: Math.round(main.left + 8),
      y: top,
      w: Math.round(main.width - 16),
      h: Math.round(Math.min(innerHeight - top - 8, 300)),
    };
  });
  const png = await page.screenshot({ scale: "css", animations: "allow" });
  return page.evaluate(
    async ({ b64, box }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(box.x, box.y, box.w, box.h).data;
      let light = 0;
      for (let i = 0; i < d.length; i += 4)
        if (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]! > 235)
          light++;
      return light / (d.length / 4);
    },
    { b64: png.toString("base64"), box },
  );
}

test.describe("a page change keeps the window still", () => {
  test("the macOS desktop window over light glass (1000 x 650)", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 650 });
    await asMacWindow(page);
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = css;
        document.head.append(s);
      });
    }, WHITE_GLASS);
    await page.goto("/jobs");
    await settle(page);
    await expect(page.locator("html")).toHaveClass(/see-through/);
    for (const item of MENU) expect(await watchFrames(page, item), item).toEqual([]);
    await settle(page);
    // The window's own band (traffic lights), the menu below its items, and the strip between the menu and the page.
    await stillRegions(
      page,
      [
        { name: "title bar band", x: 320, y: 4, w: 560, h: 18 },
        { name: "menu", x: 34, y: 520, w: 180, h: 60 },
        { name: "gap beside the menu", x: 268, y: 160, w: 12, h: 400 },
      ],
      MENU,
    );
  });

  test("a slow connection: the page never goes see-through while it loads", async ({
    page,
  }) => {
    // The cloud app answers in a few hundred ms, not the mock's 30: every first visit shows its loading state long
    // enough to see. The placeholders carry the panel tint, and a page visited before shows its last data at once.
    await page.setViewportSize({ width: 1000, height: 650 });
    await asMacWindow(page);
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = css;
        document.head.append(s);
      });
    }, WHITE_GLASS);
    await page.goto("/jobs");
    await settle(page);
    await page.evaluate(() => {
      (
        window as unknown as { __cfMockFaults: { latencyMs?: number } }
      ).__cfMockFaults.latencyMs = 1200;
    });
    const report: string[] = [];
    for (const round of ["first visit", "second visit"]) {
      for (const item of MENU) {
        const before = await lightShare(page);
        await page.locator(item).click();
        let worst = 0;
        for (let i = 0; i < 4; i++)
          worst = Math.max(worst, await lightShare(page));
        await expect(page.locator(".main .skeleton")).toHaveCount(0, {
          timeout: 5000,
        });
        await page.waitForTimeout(150);
        const after = await lightShare(page);
        report.push(
          `${round} ${item.slice(-12, -2)}: ${before.toFixed(2)} > ${worst.toFixed(2)} > ${after.toFixed(2)}`,
        );
        // While it loads, no more of the glass shows than on either page at rest (5 points for the shimmer).
        expect(worst, report.at(-1)).toBeLessThanOrEqual(
          Math.max(before, after) + 0.05,
        );
      }
    }
    test
      .info()
      .annotations.push({
        type: "light share",
        description: report.join("; "),
      });
  });

  test("a wide browser window (1440 x 900)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/jobs");
    await settle(page);
    // The living backdrop drifts on its own (24 to 44 s loops): held still here, so only a page change could move a pixel.
    await page.addStyleTag({ content: ".backdrop, .backdrop *, .backdrop::after { animation-play-state: paused !important; }" });
    for (const item of MENU) expect(await watchFrames(page, item), item).toEqual([]);
    await settle(page);
    await stillRegions(page, [{ name: "menu", x: 34, y: 700, w: 180, h: 80 }], MENU);
  });

  test("a phone (390 x 844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/jobs");
    await settle(page);
    for (const k of ["review", "library", "settings", "home", "jobs"]) expect(await watchFrames(page, `.tabbar__item[data-help="nav-${k}"]`), k).toEqual([]);
  });
});
