import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

interface Faults {
  keepStopsAfterSave: number;
  resumeAfterMs: number;
  confirmFails?: ("network" | "refused")[];
}
type FaultWindow = Window & { __cfMockFaults?: Faults };

test("library: an uploaded clip that never started posting gets a Try again button", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const stuck = page.locator(".lib-card", { hasText: "This clip has not started uploading yet." });
  await expect(stuck).toHaveCount(1);
  const hook = await stuck.locator(".lib-card__hook").innerText();
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) });
  // Its pill says it has not started (never a green "Uploading" over "has not started uploading yet").
  await expect(card.locator(".lib-card__head .pill")).toHaveText("Not started");
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/Saved! It uploads as soon as your accounts are set up/)).toBeVisible();
  await expect(card.getByText("Posts once these accounts are connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  // Every post now waits for its account: the pill says that, not "Uploading".
  await expect(card.locator(".lib-card__head .pill")).toHaveText("Waiting for setup");
});

test("library: Try again too soon says it is still working", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.resumeAfterMs = 10 * 365 * 24 * 3600 * 1000;
  });
  const card = page.locator(".lib-card", { hasText: "This clip has not started uploading yet." });
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Still working on it. Try again in a minute.");
  await expect(card.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
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
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  await expect(page.getByText("Clip Factory cannot be reached.").first()).toBeVisible();
  await expect(card.getByText("Uploading this clip did not finish. Tap Try again.")).toBeVisible();

  // The server saved the Keep but has not started posting: within a minute it answers "still working".
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(card.getByRole("status").filter({ hasText: "Still working" })).toHaveText(
    "Still working on it. Try again in a minute.",
  );
  await expect(cards).toHaveCount(before);

  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.resumeAfterMs = 0;
  });
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toBeVisible();
  await expect(cards).toHaveCount(before - 1);
});

test("review: once an Upload reached the server, Throw away goes and the card locks until Try again finishes it", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as Window & { __cfMock?: { setup: { finish(p: string): void } } }).__cfMock!.setup;
    for (const p of ["youtube", "instagram", "facebook"]) s.finish(p);
  });
  await page.goto("/review");
  await settle(page);
  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.keepStopsAfterSave = 1;
    (window as FaultWindow).__cfMockFaults!.resumeAfterMs = 0;
  });
  const card = page.locator(".review-card").first();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  await expect(card.getByText("Uploading this clip did not finish. Tap Try again.")).toBeVisible();
  // Try again is the one way on: the server already holds the clip as uploaded.
  await expect(card.getByText("It's already sent, so you can't change it now.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Throw away" })).toHaveCount(0);
  await expect(card.locator(".upload-to").getByRole("button", { name: "Facebook" })).toBeDisabled();
  await card.locator('[data-place="instagram"] summary').click();
  await expect(card.locator('[data-place="instagram"] textarea')).toBeDisabled();
  await expect(card).not.toContainText("saved when you tap");
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/^Uploading to/)).toBeVisible();
});

test("review: a Try again the server refuses after a lost connection opens the card again", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as Window & { __cfMock?: { setup: { finish(p: string): void } } }).__cfMock!.setup;
    for (const p of ["youtube", "instagram", "facebook"]) s.finish(p);
  });
  await page.goto("/review");
  await settle(page);
  await page.evaluate(() => {
    (window as FaultWindow).__cfMockFaults!.confirmFails = ["network", "refused"];
  });
  const card = page.locator(".review-card").first();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  // No answer: it may have reached the server, so the card locks and Try again is the way on.
  await expect(card.getByText("It's already sent, so you can't change it now.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Throw away" })).toHaveCount(0);
  // The server answers 400: it never took the Upload, so the card can be changed (and thrown away) again.
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Pick who can see it on TikTok.").first()).toBeVisible();
  await expect(card.getByText("It's already sent, so you can't change it now.")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Throw away" })).toBeVisible();
  await expect(card.locator(".upload-to").getByRole("button", { name: "Facebook" })).toBeEnabled();
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/^Uploading to/)).toBeVisible();
});
