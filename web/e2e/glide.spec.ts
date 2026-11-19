import { expect, test, type Locator, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// The sliding highlight (docs/CONTRACTS.md §20.12), the arrow-only cursor (§20.13) and the Ask mark (§19).

/** The glide's box and its chosen item's box, rounded. */
async function boxes(bar: Locator, chosen: string) {
  return bar.evaluate((el, sel) => {
    const g = el.querySelector(":scope > .glide")!.getBoundingClientRect();
    const on = el.querySelector(sel)!.getBoundingClientRect();
    const r = (b: DOMRect) => [b.x, b.y, b.width, b.height].map(Math.round);
    return { glide: r(g), on: r(on) };
  }, chosen);
}

async function landsOn(bar: Locator, chosen: string) {
  await expect.poll(async () => {
    const { glide, on } = await boxes(bar, chosen);
    return glide.every((v, i) => Math.abs(v - on[i]!) <= 1);
  }).toBe(true);
}

/** Every pressable thing on the page and the cursor it shows. */
async function cursors(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("a, button, label, input, textarea, select, summary, [role=tab], [role=button], [role=switch], [tabindex]")]
      .map((el) => getComputedStyle(el).cursor)
      .filter((c) => c !== "default"),
  );
}

test.describe("glide", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("the switch bar's highlight slides to the new choice", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const bar = page.locator(".segmented").first();
      await expect(bar).toHaveClass(/has-glide/);
      await landsOn(bar, ".segmented__opt.is-on");
      // It travels instead of jumping: right after the tap one Web Animation runs on the glide's transform only (the
      // slide, with the stretch folded in), from the old spot to the new one. Exact, unlike sampling frames.
      const run = await bar.evaluate(
        (el) =>
          new Promise<{ slide: boolean; stretch: boolean; onlyTransform: boolean }>((done) => {
            const g = el.querySelector<HTMLElement>(":scope > .glide")!;
            const target = [...el.querySelectorAll<HTMLElement>(".segmented__opt")].find((o) => o.textContent?.includes("Pick a video"))!;
            target.querySelector("input")!.click();
            requestAnimationFrame(() => {
              const anims = g.getAnimations();
              const slide = anims.find((a) => a.id === "glide-slide");
              const frames = (slide?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
              const props = new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))));
              const scales = frames.map((f) => /scale\(([\d.]+)/.exec(String(f.transform))?.[1]).map(Number);
              done({
                slide: !!slide && slide.playState === "running",
                stretch: Math.max(...scales) > 1.02,
                onlyTransform: anims.every((a) => a.id === "glide-slide" || a instanceof CSSTransition) && [...props].join() === "transform",
              });
            });
          }),
      );
      expect(run).toEqual({ slide: true, stretch: true, onlyTransform: true });
      await landsOn(bar, ".segmented__opt.is-on");
      // The chosen option no longer paints its own pill; the glide is the pill.
      expect(await bar.locator(".segmented__opt.is-on").evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
    });

    test("between options of different widths the pill keeps its round ends (never squashed)", async ({ page }) => {
      await page.goto("/library");
      await settle(page);
      const bar = page.locator(".segmented", { hasText: "Not posted yet" }).first();
      await expect(bar).toHaveClass(/has-glide/);
      const run = await bar.evaluate(
        (el) =>
          new Promise<{ slide: boolean; scaled: boolean; widths: number[] }>((done) => {
            const g = el.querySelector<HTMLElement>(":scope > .glide")!;
            const target = [...el.querySelectorAll<HTMLElement>(".segmented__opt")].find((o) => o.textContent?.includes("Not posted yet"))!;
            target.querySelector("input")!.click();
            requestAnimationFrame(() => {
              const slide = g.getAnimations().find((a) => a.id === "glide-slide");
              const frames = (slide?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
              done({
                slide: !!slide,
                scaled: frames.some((f) => /scale/.test(String(f.transform))),
                widths: frames.map((f) => parseFloat(String(f.width))),
              });
            });
          }),
      );
      expect(run.slide).toBe(true);
      expect(run.scaled).toBe(false);
      expect(run.widths.at(-1)! - run.widths[0]!).toBeGreaterThan(40);
      await landsOn(bar, ".segmented__opt.is-on");
    });

    test("the menu highlight and its vermilion bar follow the page", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const list = page.locator(".sidebar__list");
      await landsOn(list, ".sidebar__item.is-active");
      await list.locator(".sidebar__item", { hasText: "Library" }).click();
      await expect(page).toHaveURL(/\/library/);
      await landsOn(list, ".sidebar__item.is-active");
      expect(await list.locator(".glide").evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(232, 57, 43)");
      // A resize moves it instantly (no slide), and it stays on the chosen item.
      await page.setViewportSize({ width: 1024, height: 800 });
      await landsOn(list, ".sidebar__item.is-active");
    });

    test("the folded menu keeps its icons and highlight inside the menu", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const list = page.locator(".sidebar__list");
      // The glide takes no room of its own: the first item sits right at the top of the list.
      const gap = () => list.evaluate((el) => Math.round(el.querySelector(".sidebar__item")!.getBoundingClientRect().top - el.getBoundingClientRect().top));
      expect(await list.locator(".glide").evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
      expect(await gap()).toBe(0);
      await page.getByRole("button", { name: "Collapse menu" }).click();
      await expect(page.locator(".sidebar")).toHaveClass(/is-collapsed/);
      await landsOn(list, ".sidebar__item.is-active");
      // Nothing in the list reaches past the folded menu's own edges.
      await expect
        .poll(() =>
          page.locator(".sidebar").evaluate((bar) => {
            const b = bar.getBoundingClientRect();
            if (Math.round(b.width) !== 80) return "still folding";
            return [...bar.querySelectorAll(".sidebar__list > li, .sidebar__item, .sidebar__icon")]
              .map((el) => el.getBoundingClientRect())
              .filter((r) => r.left < b.left - 0.5 || r.right > b.right + 0.5).length;
          }),
        )
        .toBe(0);
      await page.locator(".sidebar__item[data-help='nav-jobs']").click();
      await expect(page).toHaveURL(/\/jobs/);
      await landsOn(list, ".sidebar__item.is-active");
      expect(await gap()).toBe(0);
    });

    test("Library's view tabs slide too", async ({ page }) => {
      await page.goto("/library");
      await settle(page);
      const tabs = page.locator(".lib-tabs");
      await landsOn(tabs, ".lib-tab.is-on");
      await tabs.locator(".lib-tab", { hasText: "This week" }).click();
      await landsOn(tabs, ".lib-tab.is-on");
    });

    test("the cursor is always the plain arrow", async ({ page }) => {
      for (const path of ["/", "/jobs", "/review", "/library", "/settings", "/get-app"]) {
        await page.goto(path);
        await settle(page);
        expect(await cursors(page), path).toEqual([]);
      }
      await page.locator(".help-launcher").click();
      await expect(page.locator(".help-panel")).toBeVisible();
      expect(await cursors(page), "Ask panel").toEqual([]);
    });

    test("Ask wears the Clip Factory mark: a chat bubble with a play button and the vermilion dot", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const mark = page.locator(".help-launcher .ask-mark");
      await expect(mark).toBeVisible();
      expect(await mark.locator(".ask-mark__dot").evaluate((el) => getComputedStyle(el).fill)).toBe("rgb(232, 57, 43)");
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the tab bar tile and its dot slide to the new tab", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const list = page.locator(".tabbar__list");
      await landsOn(list, ".tabbar__item.is-active");
      await list.locator(".tabbar__item").nth(3).click();
      await expect(page).toHaveURL(/\/library/);
      await landsOn(list, ".tabbar__item.is-active");
      expect(await cursors(page)).toEqual([]);
    });

    test("every tab switch glides end to end: no frame skips, no snap at the end", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const list = page.locator(".tabbar__list");
      await landsOn(list, ".tabbar__item.is-active");
      // Every pair of tabs, both ways, pressed like a finger (down, hold, up) so the press shrink is in play.
      const order = [1, 4, 0, 3, 2, 4, 1, 0, 2, 3, 0];
      for (const to of order) {
        const item = list.locator(".tabbar__item").nth(to);
        const b = (await item.boundingBox())!;
        // Record the glide's painted box on every frame from the press until it has long settled.
        await page.evaluate(() => {
          const g = document.querySelector(".tabbar__list > .glide")!;
          const w = window as unknown as { __frames: number[][] };
          w.__frames = [];
          const t0 = performance.now();
          const tick = () => {
            const r = g.getBoundingClientRect();
            // The slide's own clock too (-1 when no slide runs): see perFrame below.
            const run = g.getAnimations().find((a) => a.id === "glide-slide");
            const at = run && run.playState === "running" ? Number(run.currentTime ?? -1) : -1;
            w.__frames.push([r.x, r.width, r.height, performance.now(), at]);
            if (performance.now() - t0 < 1400) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(90);
        await page.mouse.up();
        await page.waitForTimeout(1500);
        const frames = await page.evaluate(() => (window as unknown as { __frames: number[][] }).__frames);
        await landsOn(list, ".tabbar__item.is-active");
        const end = frames[frames.length - 1]!;
        const start = frames[0]!;
        const travel = Math.abs(end[0]! - start[0]!);
        // The slide eases: speed is measured per 16.7 ms (so a busy test machine dropping frames does not count), and
        // never exceeds what the curve itself reaches (its launch is about 4.5x the average speed over the 360 ms
        // slide, plus the stretch; a skipped stretch of frames shows as more).
        // While the slide runs, time is the slide's own clock (Animation.currentTime), not the page's: the slide runs
        // on the compositor, so a new page that takes a frame to lay out (Settings) lets the first sample land a frame
        // into the curve with only one page frame between. The first sample of a slide counts from its start (0). A
        // real skip or snap is still a big step in little slide time.
        const elapsed = (i: number) => {
          const [a, b] = [frames[i - 1]![4]!, frames[i]![4]!];
          if (b >= 0 && a >= 0 && b >= a) return b - a;
          if (b >= 0 && a < 0) return b;
          return frames[i]![3]! - frames[i - 1]![3]!;
        };
        const perFrame = (i: number, k: number) => (Math.abs(frames[i]![k]! - frames[i - 1]![k]!) * 16.7) / Math.max(16.7, elapsed(i));
        let worst = 0;
        for (let i = 1; i < frames.length; i++) worst = Math.max(worst, perFrame(i, 0));
        expect(worst, `tab ${to}: fastest step ${worst.toFixed(1)}px a frame over ${travel.toFixed(1)}px`).toBeLessThanOrEqual(Math.max(8, (travel / (360 / 16.7)) * 6));
        // No sudden change of size from one frame to the next (the old snap at the end grew it ~6px in one frame;
        // the stretch changes it under 1.5px a frame).
        let sizeJump = 0;
        for (let i = 1; i < frames.length; i++) sizeJump = Math.max(sizeJump, perFrame(i, 1), perFrame(i, 2));
        expect(sizeJump, `tab ${to}: size jumped ${sizeJump.toFixed(1)}px in one frame`).toBeLessThanOrEqual(2);
      }
    });
  });

  test.describe("reduced motion", () => {
    test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

    test("no slide or stretch; the highlight still lands on the choice", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const bar = page.locator(".segmented").first();
      await bar.locator(".segmented__opt", { hasText: "Pick a video" }).click();
      const glide = bar.locator(".glide");
      expect(await glide.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe("opacity");
      expect(await glide.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
      expect(await glide.evaluate((el) => el.getAnimations().filter((a) => a.id === "glide-slide").length)).toBe(0);
      await landsOn(bar, ".segmented__opt.is-on");
    });
  });
});
