import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

// Owner report 2026-11-20: a working job showed 100% and a full bar while steps were still left. Even when the record
// says 100%, the job page, the job list and Home never show it until the job is ready.

test("a working job never shows 100% while steps are left", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  const job = await page.evaluate(() => {
    type Knobs = { jobs: { fullBar(): { jobId: string; title: string } | null } };
    return (window as unknown as { __cfMock: Knobs }).__cfMock.jobs.fullBar();
  });
  expect(job).not.toBeNull();
  const row = page.locator(".job-row", { hasText: job!.title }).first();
  await expect(row.locator(".job-row__step")).toContainText("99%");
  await expect(row.locator('[role="progressbar"]')).not.toHaveAttribute("aria-valuenow", "100");

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job!.jobId}$`));
  await settle(page);
  const left = await page.locator(".timeline__step:not(.is-done)").count();
  expect(left, "the job still has steps left").toBeGreaterThan(0);
  await expect(page.locator(".job-detail .panel__pct")).toHaveText("99%");
  await expect(page.locator('.job-detail [role="progressbar"]').first()).not.toHaveAttribute("aria-valuenow", "100");

  // Home, reached in the app (a reload would start the mock over).
  await page.locator('a[href="/"]').first().click();
  await expect(page).toHaveURL(/\/$/);
  await settle(page);
  const pcts = await page.locator(".working__pct").allInnerTexts();
  expect(pcts.length).toBeGreaterThan(0);
  expect(pcts).not.toContain("100%");
});
