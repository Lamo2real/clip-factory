import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

// Settings › Clip making › Clips › AI model (docs/DECISIONS.md ADR-42): the owner picks the model that makes the
// clips, from the list in config/models.json, and a finished job says which model made it.

const NAMES = ["Claude Fable 5.2", "Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"];

test("pick the AI model; the one in use is marked", async ({ page }) => {
  await page.goto("/settings/clip-making/clips");
  await settle(page);
  const apple = page.locator("#ai-model");
  await expect(apple.getByRole("heading", { name: "AI model" })).toBeVisible();
  const group = apple.getByRole("radiogroup", { name: "AI model" });
  const radios = group.getByRole("radio");
  await expect(radios).toHaveCount(5);
  for (const [i, name] of NAMES.entries()) await expect(group.locator(".model-pick").nth(i)).toContainText(name);
  // One plain line under each name.
  await expect(group.locator(".model-pick__line")).toHaveCount(5);
  await expect(group.locator(".model-pick").nth(4)).toContainText("Cheapest, fastest");

  // The usual one is in use until the owner picks another.
  await expect(group.getByRole("radio", { name: /Claude Fable 5\.1/ })).toBeChecked();
  await expect(group.locator(".model-pick.is-on")).toContainText("In use");
  await expect(group.locator(".model-pick__mark")).toHaveCount(1);

  await group.locator(".model-pick", { hasText: "Claude Opus 5.5" }).click();
  await expect(group.getByRole("radio", { name: /Claude Opus 5\.5/ })).toBeChecked();
  await expect(group.locator(".model-pick.is-on")).toContainText("Claude Opus 5.5");
  await expect(group.locator(".model-pick.is-on")).toContainText("In use");
  await expect(group.locator(".model-pick__mark")).toHaveCount(1);
  // The glide slides to the chosen row.
  await expect(group).toHaveClass(/has-glide/);

  // Keyboard: arrows move the choice like any radio group.
  await group.getByRole("radio", { name: /Claude Opus 5\.5/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(group.getByRole("radio", { name: /Claude Sonnet 5\.5/ })).toBeChecked();
});

test("a finished job says which model made it", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.getByText("Heist night with the crew", { exact: false }).first().click();
  await settle(page);
  await expect(page.locator(".job-model")).toHaveText("Made with Claude Fable 5.1.");
});

test.describe("on a small phone", () => {
  test.use({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });

  test("the rows fit: no sideways scroll, each row a full tap target", async ({ page }) => {
    await page.goto("/settings/clip-making/clips");
    await settle(page);
    const rows = page.locator("#ai-model .model-pick");
    await expect(rows).toHaveCount(5);
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
