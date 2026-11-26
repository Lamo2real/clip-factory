import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// CR active (docs/CONTRACTS.md §53), on the mock API: the switch on a Review card starts as CR inactive, CR active shows
// Edit for campaign, the editor puts a logo and words on the cover (drag, corner presets, one warning line), Make it
// says Making it… and the edit is ready a moment later, Reset puts the original back. On a phone the sheet fits.

async function review(page: Page) {
  await page.goto("/review");
  await settle(page);
  return page.locator(".review-card").first();
}

test.describe("CR active", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("CR inactive by default; CR active, the editor, Make it, then Reset", async ({ page }) => {
    const card = await review(page);
    const sw = card.locator(".cr-switch");
    await expect(sw.locator(".segmented__opt.is-on")).toHaveText("CR inactive");
    await expect(card.getByRole("button", { name: "Edit for campaign" })).toHaveCount(0);

    await sw.locator(".segmented__opt", { hasText: /^CR active$/ }).click();
    const edit = card.getByRole("button", { name: "Edit for campaign" });
    await expect(edit).toBeVisible();
    await edit.click();

    const sheet = page.getByRole("dialog", { name: "Edit for campaign" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Whole clip", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Only part of the clip")).toBeVisible();
    // A logo from the library, then a corner, and the one warning line when it sits under the captions.
    await sheet.getByRole("button", { name: "Lamo Clips", exact: true }).click();
    await expect(sheet.locator(".cr-ed__logo")).toBeVisible();
    await sheet.getByRole("button", { name: "Bottom left" }).first().click();
    await expect(sheet.locator("[data-edit-warning]")).toHaveText("Under the captions");
    await expect(sheet.locator(".cr-ed__logo")).toHaveClass(/is-warn/);

    // Drag it to the top left of the cover: the warning goes away.
    const preview = (await sheet.locator(".cr-ed__preview").boundingBox())!;
    const logo = (await sheet.locator(".cr-ed__logo").boundingBox())!;
    await page.mouse.move(logo.x + logo.width / 2, logo.y + logo.height / 2);
    await page.mouse.down();
    await page.mouse.move(preview.x + preview.width * 0.3, preview.y + preview.height * 0.1, { steps: 6 });
    await page.mouse.up();
    await expect(sheet.locator("[data-edit-warning]")).toHaveCount(0);
    await expect(sheet.locator(".cr-ed__logo")).not.toHaveClass(/is-warn/);

    await sheet.getByLabel("Text").fill("#Valor");
    await expect(sheet.locator(".cr-ed__text")).toHaveText("#Valor");
    await sheet.getByRole("button", { name: "Make it" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(card.getByText("Making it…")).toBeVisible();
    // The pretend render takes about 1.5 s and the card asks again every 2 s.
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".cr-switch__tags")).toContainText("Logo");
    await expect(card.locator(".cr-switch__tags")).toContainText("Text");
    await expect(page.getByText("Your edit is ready.")).toBeVisible();

    await card.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByText("Edit removed")).toBeVisible();
    await expect(card.locator(".cr-switch__tags")).toHaveCount(0);
  });

  test("switching back to CR inactive leaves the card as it was", async ({ page }) => {
    const card = await review(page);
    const sw = card.locator(".cr-switch");
    await sw.locator(".segmented__opt", { hasText: /^CR active$/ }).click();
    await expect(card.getByRole("button", { name: "Edit for campaign" })).toBeVisible();
    await sw.locator(".segmented__opt", { hasText: /^CR inactive$/ }).click();
    await expect(card.getByRole("button", { name: "Edit for campaign" })).toHaveCount(0);
  });
});

test.describe("CR active on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the editor sheet fits the screen", async ({ page }) => {
    const card = await review(page);
    await card.locator(".cr-switch .segmented__opt", { hasText: /^CR active$/ }).click();
    await card.getByRole("button", { name: "Edit for campaign" }).click();
    const sheet = page.getByRole("dialog", { name: "Edit for campaign" });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(sheet.getByRole("button", { name: "Make it" })).toBeAttached();
  });
});
