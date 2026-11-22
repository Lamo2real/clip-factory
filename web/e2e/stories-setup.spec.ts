import { expect, test, type Page } from "@playwright/test";
import { findOverflow } from "./helpers.ts";

// Lamo Stories › Set up Lamo Stories, steps 1 and 2 (docs/CONTRACTS.md §45.34) in the mock app: Check models in
// step 1 ticks it, and step 2 starts from the models' fresh states (a model that just answered says so), never the
// ones loaded before the check. Lamo Stories is switched on with cf.storiesPreview = 1; the mock's `fresh` knob is a
// brand-new studio.

async function fresh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
  });
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test("after Check models in step 1, step 2 starts from the models' fresh states", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/setup");
  await ready(page);
  await expect(page.locator("#st-setup-step")).toHaveText("Set up the AI");
  const sonnet = page.locator(".st-setup__model").filter({ hasText: "Claude Sonnet 5.5" });
  await expect(sonnet).toContainText("Not checked yet");
  await page.getByRole("button", { name: "Check models" }).click();
  await expect(page.locator(".toast").filter({ hasText: "5 of 6 models answered." })).toBeVisible({ timeout: 10_000 });
  await expect(sonnet).toContainText("Works");
  await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "1 of 11 done");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("#st-setup-step")).toHaveText("Pick your default model");
  const radio = page.getByRole("radiogroup", { name: "Lamo Stories' default model" }).getByRole("radio", { name: /Claude Sonnet 5.5/ });
  await expect(radio).toContainText("Works: it answered.");
  await expect(radio).not.toContainText("Not checked yet");
  const o = await findOverflow(page);
  expect(o.page, "the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
  expect(o.items).toEqual([]);
});
