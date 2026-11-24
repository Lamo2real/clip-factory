import { expect, test, type Locator, type Page } from "@playwright/test";
import { SEND_FADE_MS } from "../src/lib/motion.ts";
import { settle } from "./helpers.ts";
import { GALLERY } from "./motionHelpers.ts";

// Send keeps its 300 ms fade under reduced motion, from the system setting and from Settings (docs/CONTRACTS.md §20.6):
// the paper plane in Ask (audit F045: it was cut to 1 ms) and the in-button send (audit F070: it was 240 ms).
const seconds = `${SEND_FADE_MS / 1000}s`;

/**
 * Taps `button` and reads its glyph's fade while the fade is on: in the tap's own task, the moment the wrapper's class
 * changes (React puts it on before the task ends). The fade ends on the app's own timer (SEND_FADE_MS, lib/motion.ts
 * useAction), never on a frame, and on CI's software paint the next frame, or the next round trip, has come after it:
 * the glyph at rest again read base.css's 1 ms ("0.001s").
 */
function tapAndRead(button: Locator, wrapper: string, items: string[]) {
  return button.evaluate(
    async (el: HTMLElement, { wrapper, items }) => {
      const box = el.querySelector(wrapper);
      if (!box) return { cls: "missing", durations: [] as string[] };
      await new Promise<void>((done) => {
        const mo = new MutationObserver(() => {
          mo.disconnect();
          done();
        });
        mo.observe(box, { attributes: true, attributeFilter: ["class"] });
        setTimeout(() => {
          mo.disconnect();
          done();
        }, 2000);
        el.click();
      });
      return { cls: box.className, durations: items.map((s) => (el.querySelector(s) ? getComputedStyle(el.querySelector(s)!).animationDuration : "missing")) };
    },
    { wrapper, items },
  );
}

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
      const { cls, durations } = await tapAndRead(send, ".fly", [".fly__item"]);
      expect(cls).toContain("is-fading");
      expect(durations).toEqual([seconds]);
    });

    test("the in-button send fades over 300 ms", async ({ page }) => {
      await reduce(page, source, GALLERY);
      const button = page.locator('[data-kind="send"]');
      const { cls, durations } = await tapAndRead(button, ".act", [".act__item", ".act"]);
      expect(cls).toContain("is-fade");
      expect(durations).toEqual([seconds, seconds]);
    });
  });
}
