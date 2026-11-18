import { expect, test } from "@playwright/test";
import { findOverflow, settle } from "./helpers.ts";

// "Watch the video": the tenth job step and the "Why:" line on a clip (docs/DECISIONS.md ADR-40, CONTRACTS §5, §8).

const LABELS = [
  "Find the video",
  "Get the video",
  "Write down the words",
  "Listen for big moments",
  "Watch the video",
  "Pick the best moments",
  "Cut the clips",
  "Check each clip",
  "Write the captions",
  "Finish up",
];

test("a new job shows the ten steps in order, with Watch the video after listening", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.getByLabel("YouTube, Twitch or Kick link").fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  const labels = page.locator(".timeline__step .timeline__label");
  await expect(labels).toHaveCount(10);
  const seen = (await labels.allInnerTexts()).map((t) => t.split(",")[0]!.trim());
  expect(seen).toEqual(LABELS);
});

test("a job saved before the watch step existed still shows its nine steps", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  const old = await page.evaluate(() => {
    type Knobs = { jobs: { oldSteps(): { jobId: string; title: string } | null } };
    return (window as unknown as { __cfMock: Knobs }).__cfMock.jobs.oldSteps();
  });
  expect(old).not.toBeNull();
  await page.locator(".job-row", { hasText: old!.title }).first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(page.locator(".timeline__step")).toHaveCount(9);
  await expect(page.locator(".timeline__step", { hasText: "Watch the video" })).toHaveCount(0);
  await expect(page.locator(".timeline__step.is-done")).toHaveCount(9);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

for (const width of [320, 390, 1280]) {
  test(`Review says why a clip was picked, or says nothing, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/review");
    await settle(page);
    const cards = page.locator(".review-card");
    await expect(cards.first()).toBeVisible();
    const why = page.locator(".review-card__why");
    await expect(why.first()).toBeVisible();
    const texts = await why.allInnerTexts();
    for (const t of texts) {
      expect(t).toMatch(/^Why: \S/);
      expect(t.length).toBeLessThanOrEqual(5 + 40);
    }
    // Some clips have nothing that stood out: those cards carry no line at all, not an empty one.
    expect(texts.length).toBeLessThan(await cards.count());
    // The line never changes the mouse cursor (owner's rule) and never pushes the card wider than the screen.
    expect(await why.first().evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
    expect((await findOverflow(page)).items).toEqual([]);
  });
}
