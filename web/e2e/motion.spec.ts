import { expect, test } from "@playwright/test";
import { ACT_KINDS, ACT_MS } from "../src/lib/motion.ts";
import { settle } from "./helpers.ts";
import { actTransforms, actWidths, GALLERY, holdClock, MOTION_WIDTHS, noSideScroll, pauseActs, soundKinds, tapAct, tapHeld, tapUntilPhase } from "./motionHelpers.ts";

// Action motion (docs/CONTRACTS.md §20). CORE: the gallery at /__motion (mock mode only). APPLY builders add their
// screens' checks below in their own test.describe blocks, reusing motionHelpers.ts.

test.describe("motion gallery (CORE)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Before the page loads, so a test can hold the page's clock (holdClock); until then time runs as usual.
    await page.clock.install();
    await page.goto(GALLERY);
    await settle(page);
  });

  test("every kind: the handler fires first, the motion plays, then it rests", async ({ page }) => {
    // §20.10's "back to is-idle within ACT_MS + 200" is timed on the page's own clock, held still and then moved on by
    // exactly ACT_MS: a busy machine can run the motion's end timer and the polls late, but cannot change this answer.
    await holdClock(page);
    for (const kind of ACT_KINDS) {
      const button = page.locator(`[data-kind="${kind}"]`);
      await expect(button).toHaveAttribute("data-act", kind);
      const fired = await tapHeld(button);
      expect(fired, kind).not.toBeNull();
      // The clock is held, so the motion is still in its play phase however long this check takes: the handler fired
      // (data-fired, read straight after the click) before the motion ended.
      await expect(button.locator(".act"), kind).toContainClass(`act act--${kind} is-play`);
      await page.clock.runFor(ACT_MS[kind]);
      await expect(button.locator(".act"), kind).toHaveClass(/is-idle/);
    }
    await page.clock.resume();
  });

  test("a failing action shakes, plays one deny and no success", async ({ page }) => {
    await page.getByRole("switch", { name: "Make them fail" }).click();
    for (const kind of ["keep", "save", "send", "check"] as const) {
      await page.waitForTimeout(350);
      await page.evaluate(() => (window.__cfSoundLog = []));
      const button = page.locator(`[data-kind="${kind}"]`);
      // The shake is short (ACT_FAIL_MS), so wait for it inside the page: a polling check can miss it when busy.
      expect(await tapUntilPhase(button, "is-fail"), kind).toBe(true);
      // No ring, tick or trail stays behind.
      await expect(button.locator(".act__trail")).toHaveCount(0);
      expect(await button.locator(".act__item").evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
      await expect.poll(() => soundKinds(page)).toEqual(["tap", "deny"]);
    }
  });

  test("the stepper bumps and the segmented label bumps", async ({ page }) => {
    const more = page.getByRole("button", { name: "More: Things" });
    await expect(more).toHaveAttribute("data-act", "add");
    await tapAct(more);
    await expect(page.locator(".stepper__num")).toHaveClass(/is-up/);
    await page.getByRole("radio", { name: "Second" }).check({ force: true });
    await expect(page.locator(".segmented__opt.is-on .act")).toHaveClass(/act--toggle/);
  });

  for (const source of ["os", "setting"] as const) {
    test(`reduced motion (${source}): every kind only fades, nothing moves`, async ({ page }) => {
      if (source === "os") {
        await page.emulateMedia({ reducedMotion: "reduce" });
      } else {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.goto("/settings/look-and-feel/motion");
        await settle(page);
        const sw = page.getByRole("switch", { name: /Reduce motion/ });
        await sw.click();
        await expect(sw).toHaveAttribute("aria-checked", "true");
        // In-app navigation keeps the setting just made.
        await page.evaluate((to) => {
          history.pushState(null, "", to);
          dispatchEvent(new PopStateEvent("popstate"));
        }, GALLERY);
        await expect(page.locator("[data-kind]").first()).toBeVisible();
      }
      for (const kind of ACT_KINDS) {
        const { cls } = await tapAct(page.locator(`[data-kind="${kind}"]`));
        expect(cls.split(" "), kind).toEqual(expect.arrayContaining(["act", `act--${kind}`, "is-fade"]));
      }
      for (const f of [0.25, 0.5, 0.75]) {
        await pauseActs(page, f);
        expect((await actTransforms(page)).filter((t) => t !== "none"), `at ${f}`).toEqual([]);
      }
    });
  }

  for (const width of MOTION_WIDTHS) {
    test(`nothing overflows or grows mid-animation at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(GALLERY);
      await settle(page);
      const before = await actWidths(page);
      for (const kind of ACT_KINDS) await tapAct(page.locator(`[data-kind="${kind}"]`));
      await tapAct(page.getByRole("button", { name: "More: Things" }));
      for (const f of [0.25, 0.5, 0.75]) {
        await pauseActs(page, f);
        expect(await noSideScroll(page), `side scroll at ${f}`).toBe(true);
        expect(await actWidths(page), `button widths at ${f}`).toEqual(before);
      }
    });
  }
});
