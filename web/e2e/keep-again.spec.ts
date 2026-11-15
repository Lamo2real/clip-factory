import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

interface Faults {
  keepStopsAfterSave: number;
  resumeAfterMs: number;
}
type FaultWindow = Window & { __cfMockFaults?: Faults };

test("library: a kept clip that never started posting gets a Try again button", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const stuck = page.locator(".lib-card", { hasText: "This clip has not started posting yet." });
  await expect(stuck).toHaveCount(1);
  const hook = await stuck.locator(".lib-card__hook").innerText();
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/Kept! It posts as soon as your accounts are connected/)).toBeVisible();
  await expect(card.getByText("Posts once these accounts are connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("library: Try again too soon says it is still working", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.resumeAfterMs = 10 * 365 * 24 * 3600 * 1000;
  });
  const card = page.locator(".lib-card", { hasText: "This clip has not started posting yet." });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("status")).toHaveText("Still working on it. Try again in a minute.");
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("review: a Keep that fails turns into Try again", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.keepStopsAfterSave = 1;
  });
  const cards = page.locator(".review-card");
  const before = await cards.count();
  const card = cards.first();
  await card.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByText("Clip Factory cannot be reached.").first()).toBeVisible();
  await expect(card.getByText("Keeping this clip did not finish. Tap Try again.")).toBeVisible();

  // The server saved the Keep but has not started posting: within a minute it answers "still working".
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Still working" })).toHaveText(
    "Still working on it. Try again in a minute.",
  );
  await expect(cards).toHaveCount(before);

  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.resumeAfterMs = 0;
  });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/Kept!/)).toBeVisible();
  await expect(cards).toHaveCount(before - 1);
});
