import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

// Use a video file (docs/CONTRACTS.md §29.7): a failed link job has the button its error names, and it opens Home on
// Pick a video with the file box ready, so the owner only has to choose the file.
test("a failed link job offers Use a video file, which opens the file picker form", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Charity marathon" }).click();
  await settle(page);
  const use = page.getByRole("link", { name: "Use a video file" });
  await expect(use).toBeVisible();
  await use.click();
  await settle(page);
  await expect(page).toHaveURL(/\/\?file=1&from=/);
  await expect(page.getByText("Tap to choose a video")).toBeVisible();
  await expect(page.locator('form.newjob input[type="file"]')).toHaveCount(1);
});

test("a job that worked has no Use a video file button", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Ranked grind" }).click();
  await settle(page);
  await expect(page.getByRole("button", { name: "Stop job" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Use a video file" })).toHaveCount(0);
});
