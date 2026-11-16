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
      // Record the glide's x on every frame from the tap until it settles, inside the page (no round trips).
      const xs = await bar.evaluate(
        (el) =>
          new Promise<{ start: number; end: number; seen: number[] }>((done) => {
            const g = el.querySelector<HTMLElement>(":scope > .glide")!;
            const target = [...el.querySelectorAll<HTMLElement>(".segmented__opt")].find((o) => o.textContent?.includes("Upload a video"))!;
            const start = g.getBoundingClientRect().x;
            const seen: number[] = [];
            const t0 = performance.now();
            const tick = () => {
              seen.push(g.getBoundingClientRect().x);
              if (performance.now() - t0 < 900) requestAnimationFrame(tick);
              else done({ start, end: target.getBoundingClientRect().x, seen });
            };
            target.querySelector("input")!.click();
            requestAnimationFrame(tick);
          }),
      );
      // It travels: part-way across before it lands (not a jump).
      expect(xs.seen.some((x) => x > xs.start + 4 && x < xs.end - 4)).toBe(true);
      await landsOn(bar, ".segmented__opt.is-on");
      // The chosen option no longer paints its own pill; the glide is the pill.
      expect(await bar.locator(".segmented__opt.is-on").evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
    });

    test("the menu highlight and its tomato bar follow the page", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const list = page.locator(".sidebar__list");
      await landsOn(list, ".sidebar__item.is-active");
      await list.locator(".sidebar__item", { hasText: "Library" }).click();
      await expect(page).toHaveURL(/\/library/);
      await landsOn(list, ".sidebar__item.is-active");
      expect(await list.locator(".glide").evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(232, 65, 44)");
      // A resize moves it instantly (no slide), and it stays on the chosen item.
      await page.setViewportSize({ width: 1024, height: 800 });
      await landsOn(list, ".sidebar__item.is-active");
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

    test("Ask wears the Clip Factory mark: a chat bubble with a play button and the tomato dot", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const mark = page.locator(".help-launcher .ask-mark");
      await expect(mark).toBeVisible();
      expect(await mark.locator(".ask-mark__dot").evaluate((el) => getComputedStyle(el).fill)).toBe("rgb(232, 65, 44)");
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
  });

  test.describe("reduced motion", () => {
    test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

    test("no slide or stretch; the highlight still lands on the choice", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const bar = page.locator(".segmented").first();
      await bar.locator(".segmented__opt", { hasText: "Upload a video" }).click();
      const glide = bar.locator(".glide");
      expect(await glide.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe("opacity");
      expect(await glide.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
      await landsOn(bar, ".segmented__opt.is-on");
    });
  });
});
