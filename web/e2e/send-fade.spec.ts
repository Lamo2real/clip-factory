import { expect, test, type Page } from "@playwright/test";
import { SEND_FADE_MS } from "../src/lib/motion.ts";
import { settle } from "./helpers.ts";
import { GALLERY, tapAct } from "./motionHelpers.ts";

// Send keeps its 300 ms fade under reduced motion, from the system setting and from Settings (docs/CONTRACTS.md §20.6):
// the paper plane in Ask (audit F045: it was cut to 1 ms) and the in-button send (audit F070: it was 240 ms).
const seconds = `${SEND_FADE_MS / 1000}s`;

async function reduce(page: Page, source: "os" | "setting", then: string) {
  if (source === "os") {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(then);
    await settle(page);
    return;
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/settings/look-and-feel/motion");
  await settle(page);
  const sw = page.getByRole("switch", { name: /Reduce motion/ });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, then);
  await settle(page);
}

for (const source of ["os", "setting"] as const) {
  test.describe(`send fade with reduced motion (${source})`, () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the Ask paper plane fades over 300 ms", async ({ page }) => {
      await reduce(page, source, "/");
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
      await panel.getByLabel("Your question").fill("Where do I change my click sound?");
      const send = panel.getByRole("button", { name: "Send", exact: true });
      const duration = await send.evaluate(async (el: HTMLElement) => {
        el.click();
        await new Promise((r) => requestAnimationFrame(r));
        const item = el.querySelector(".fly__item");
        return item ? getComputedStyle(item).animationDuration : "missing";
      });
      expect(duration).toBe(seconds);
    });

    test("the in-button send fades over 300 ms", async ({ page }) => {
      await reduce(page, source, GALLERY);
      const button = page.locator('[data-kind="send"]');
      const { cls } = await tapAct(button);
      expect(cls).toContain("is-fade");
      expect(await button.locator(".act__item").evaluate((el) => getComputedStyle(el).animationDuration)).toBe(seconds);
      expect(await button.locator(".act").evaluate((el) => getComputedStyle(el).animationDuration)).toBe(seconds);
    });
  });
}
