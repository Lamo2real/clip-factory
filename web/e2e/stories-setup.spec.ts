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

test("round 4: step 4 says the built-in animator makes tall, square or wide videos; a platform that is Lamo Clips' own says why (§45.35 D11, D21)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/setup");
  await ready(page);
  await page.getByRole("navigation", { name: "Setup steps" }).getByRole("button", { name: /Pick how videos are made/ }).click();
  const builtin = page.getByRole("radiogroup", { name: "How videos are made" }).getByRole("radio", { name: /^Built-in animation/ });
  await expect(builtin).toContainText("On. Cartoons drawn right here, tall, square or wide, 30 frames a second.");
  await expect(builtin).not.toContainText("9:16");
  // The seed's X account is Lamo Clips' own: the step stays to do, and What is left says why in the server's words.
  const why = page.locator(".st-left__why");
  await expect(why).toContainText("This is Clip Factory's X account. Pick another in Social accounts, or tap Use it for both.");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(250);
  const o = await findOverflow(page);
  expect(o.page).toBeLessThanOrEqual(o.viewport);
  expect(o.items).toEqual([]);
});

test("round 5: after Finish with steps skipped, the dashboard keeps what is left, and Settings opens the setup again (§45.36 E15)", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/setup");
  await ready(page);
  // Skip three of the connect steps, then go to the end and Finish.
  for (const name of ["Connect TikTok", "Connect Facebook", "Connect X"]) {
    await page.locator(".st-steps__item").filter({ hasText: name }).click();
    await expect(page.locator("#st-setup-step")).toHaveText(name);
    await page.locator(".st-setup__foot").getByRole("button", { name: "Skip for now" }).click();
    await expect(page.locator(".st-steps__item").filter({ hasText: name })).toContainText("Later");
  }
  await page.locator(".st-steps__item").filter({ hasText: "Done" }).click();
  await expect(page.locator("#st-setup-step")).toHaveText("Done");
  await page.locator(".st-setup__foot").getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/stories$/, { timeout: 8000 });
  await ready(page);
  const left = page.locator(".st-setupcard--left");
  await expect(left).toBeVisible();
  await expect(left.getByRole("heading", { level: 2 })).toHaveText(/^Finish setting up: \d+ left$/);
  await expect(left.locator(".st-setupcard__list li")).toContainText(["Connect TikTok"]);
  await left.getByRole("link", { name: "Open setup" }).click();
  await expect(page).toHaveURL(/\/stories\/setup$/);
  await ready(page);
  // Settings always has the way back.
  await page.goto("/stories/settings/ai");
  await ready(page);
  await expect(page.getByRole("link", { name: "Open setup again" })).toBeVisible();
  await expect(page.locator(".st-stg-head__setup-left")).toHaveText(/^\d+ steps? left$/);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/stories");
    await ready(page);
    const o = await findOverflow(page);
    expect(o.page, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
    expect(o.items, `@${width}`).toEqual([]);
  }
});
