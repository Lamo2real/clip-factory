import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// CR active (docs/CONTRACTS.md §53), on the mock API: the switch on a Review card starts as CR inactive, CR active shows
// Edit for campaign, the editor puts a logo and words on the cover (drag, corner presets, one warning line), Make it
// says Making it… and the edit is ready a moment later, Reset puts the original back. On a phone the sheet fits.
// More than one picture (§54): tapping a library logo adds a picture with its own chip, the chosen chip is the one the
// corners change, at 4 one line says so, the small x removes one, and Make it keeps every picture.

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

    await sheet.getByLabel("Text", { exact: true }).fill("#Valor");
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

  test("several pictures: chips, the chosen one moves alone, the cap line at 4, the x, then Make it", async ({ page }) => {
    const card = await review(page);
    await card.locator(".cr-switch .segmented__opt", { hasText: /^CR active$/ }).click();
    await card.getByRole("button", { name: "Edit for campaign" }).click();
    const sheet = page.getByRole("dialog", { name: "Edit for campaign" });
    const tile = sheet.getByRole("button", { name: "Lamo Clips", exact: true });
    const chips = sheet.locator(".cr-chips .cr-chip");
    const pictures = sheet.locator(".cr-ed__logo");

    await tile.click();
    await tile.click();
    await expect(chips).toHaveCount(2);
    await expect(pictures).toHaveCount(2);
    await expect(chips.nth(1)).toHaveClass(/is-on/);

    // The chosen chip is the one a corner changes: the first picture moves, the second stays.
    await chips.nth(0).locator(".cr-chip__pick").click();
    await expect(chips.nth(0)).toHaveClass(/is-on/);
    // Places are read against the preview (the warning line that appears below it can shift the whole column).
    const place = async (n: number) => (await pictures.nth(n).boundingBox())!.y - (await sheet.locator(".cr-ed__preview").boundingBox())!.y;
    const second = await place(1);
    const firstBefore = await place(0);
    await sheet.getByRole("button", { name: "Bottom left" }).click();
    await expect.poll(() => place(0)).toBeGreaterThan(firstBefore + 50);
    expect(Math.abs((await place(1)) - second)).toBeLessThan(1);
    // Each covered picture has a dot on its chip; the line names the chosen one's problem.
    await expect(sheet.locator("[data-edit-warning]")).toHaveText("Under the captions");
    await expect(chips.nth(0).locator("[data-chip-dot]")).toBeVisible();

    // At 4 pictures: one line, and the tiles stop adding.
    await tile.click();
    await tile.click();
    await expect(chips).toHaveCount(4);
    await expect(sheet.locator("[data-edit-cap]")).toHaveText("That's 4 pictures. Remove one to add another.");
    await tile.click({ force: true });
    await expect(chips).toHaveCount(4);
    await chips.nth(3).getByRole("button", { name: "Remove picture" }).click();
    await expect(chips).toHaveCount(3);
    await expect(sheet.locator("[data-edit-cap]")).toHaveText("");

    // The keyboard reaches the chips and their x.
    await chips.nth(1).locator(".cr-chip__pick").focus();
    await page.keyboard.press("Enter");
    await expect(chips.nth(1)).toHaveClass(/is-on/);
    await page.keyboard.press("Tab");
    await expect(chips.nth(1).locator(".cr-chip__x")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chips).toHaveCount(2);

    await sheet.getByRole("button", { name: "Make it" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(card.locator(".cr-switch__tags")).toContainText("Logo × 2", { timeout: 10_000 });
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

  test("four pictures and their chips still fit the sheet", async ({ page }) => {
    const card = await review(page);
    await card.locator(".cr-switch .segmented__opt", { hasText: /^CR active$/ }).click();
    await card.getByRole("button", { name: "Edit for campaign" }).click();
    const sheet = page.getByRole("dialog", { name: "Edit for campaign" });
    const tile = sheet.getByRole("button", { name: "Lamo Clips", exact: true });
    for (let i = 0; i < 4; i++) await tile.click();
    await sheet.getByLabel("Text", { exact: true }).fill("#Valor");
    const chips = sheet.locator(".cr-chips");
    await expect(chips.locator(".cr-chip")).toHaveCount(5);
    const box = (await chips.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
