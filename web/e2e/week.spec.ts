import { expect, test, type Page } from "@playwright/test";
import { CLIPS, findOverflow, settle } from "./helpers.ts";

// Library › This week (docs/CONTRACTS.md §16.8), in mock mode.
type MockWindow = Window & { __cfMockCalls?: Record<string, number> };
const calls = (page: Page, name: string) => page.evaluate((n) => (window as MockWindow).__cfMockCalls?.[n] ?? 0, name);

const views = (page: Page) =>
  page.locator(".week-card__views .sr-only").evaluateAll((els) => els.map((e) => Number((e.textContent ?? "0").replace(/\D/g, ""))));

test("This week: the week's clips, most views first", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  await page.getByRole("link", { name: "This week" }).click();
  await expect(page).toHaveURL(/\/library\?view=week$/);
  await settle(page);
  await expect(page.getByRole("link", { name: "This week" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: /^This week ·\s\d{1,2}( [A-Z][a-z]{2})?–\d{1,2} [A-Z][a-z]{2}$/ })).toBeVisible();
  await expect(page.getByText("Star the clips that did best this week.")).toBeVisible();
  const v = await views(page);
  expect(v.length).toBeGreaterThanOrEqual(3);
  expect(v).toEqual([...v].sort((a, b) => b - a));
  await expect(page.locator(".week-card").first()).toContainText(CLIPS.all);
  await expect(page.locator(".week-card__rank").first()).toHaveText("1");
  // Tapping a clip opens its numbers.
  await page.locator(".week-card__link").first().click();
  await expect(page).toHaveURL(/\/clips\/[A-Z0-9]+$/);
});

test("the arrows go to earlier weeks; the later arrow is off on the current week", async ({ page }) => {
  await page.goto("/library?view=week");
  await settle(page);
  const later = page.getByRole("button", { name: "Later week" });
  await expect(later).toHaveAttribute("aria-disabled", "true");
  await later.click({ force: true });
  await expect(page.getByText("This is the newest week. Tap the left arrow to see earlier weeks.")).toBeVisible();

  await page.getByRole("link", { name: "Earlier week" }).click();
  await expect(page).toHaveURL(/\/library\?view=week&week=\d{4}-W\d{2}$/);
  await settle(page);
  await expect(page.getByRole("heading", { level: 2, name: /^Week of / })).toBeVisible();
  // Last week was already starred: its learning shows as a quote.
  await expect(page.locator(".week__quote")).toContainText("Best of week");
  await expect(page.locator(".week-card", { hasText: "Ninety seconds of pure police chase" }).getByRole("button", { name: "Best this week" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(later).not.toHaveAttribute("aria-disabled", "true");

  // Two weeks back nothing was posted.
  await page.getByRole("link", { name: "Earlier week" }).click();
  await settle(page);
  await expect(page.getByRole("heading", { name: "No clips that week" })).toBeVisible();
  await expect(page.getByText("Nothing was posted that week. Tap the arrows to look at another week.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Make clips" })).toHaveAttribute("href", "/");

  await later.click();
  await later.click();
  await expect(page).toHaveURL(/\/library\?view=week$/);
});

test("stars save together after the last tap, then Clip Factory learns from them", async ({ page }) => {
  await page.goto("/library?view=week");
  await settle(page);
  const stars = page.locator(".week-card").getByRole("button", { name: "Best this week" });
  const saves = await calls(page, "saveWeekBest");
  // Four quick taps, the last one changing its mind. They run in one go in the page, so nothing can be sent between
  // them however slow the machine is, and the count read straight after shows nothing went out yet.
  const sentDuringTaps = await stars.evaluateAll((els) => {
    for (const i of [0, 1, 2, 2]) (els[i] as HTMLElement).click();
    return (window as MockWindow).__cfMockCalls?.saveWeekBest ?? 0;
  });
  expect(sentDuringTaps).toBe(saves); // nothing sent yet: waiting for the last tap
  await expect(stars.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(stars.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(stars.nth(2)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("2 stars", { exact: false })).toBeVisible();
  await expect(page.getByText("Saved. Clip Factory will learn from your picks.")).toBeVisible();
  expect(await calls(page, "saveWeekBest")).toBe(saves + 1);

  await expect(page.getByText("Learning from your picks…")).toBeVisible();
  await expect(page.locator(".week__quote")).toBeVisible();
  await expect(page.locator(".week__quote")).toContainText(/Your picks .* first second/);
  // The wait is the test: nothing more is sent after the one save.
  await page.waitForTimeout(1200);
  expect(await calls(page, "saveWeekBest")).toBe(saves + 1);
  await expect(stars.nth(1)).toHaveAttribute("aria-pressed", "true");
});

test("a bad week link explains itself and goes back", async ({ page }) => {
  await page.goto("/library?view=week&week=2026-W99");
  await settle(page);
  await expect(page.getByRole("heading", { name: "That week does not look right" })).toBeVisible();
  await page.getByRole("link", { name: "Go back to This week" }).click();
  await expect(page).toHaveURL(/\/library\?view=week$/);
});

test("This week fits on a phone and on a desktop", async ({ page }) => {
  for (const size of [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/library?view=week");
    await settle(page);
    const star = await page.locator(".week-card").first().getByRole("button", { name: "Best this week" }).boundingBox();
    expect(star!.width).toBeGreaterThanOrEqual(48);
    expect(star!.height).toBeGreaterThanOrEqual(48);
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
    expect(result.page).toBeLessThanOrEqual(result.viewport);
  }
});

test("each clip's apps show as readable pills: no bare dashes, the best app in vermilion", async ({ page }) => {
  for (const size of [
    { width: 375, height: 812 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/library?view=week");
    await settle(page);
    const card = page.locator(".week-card", { hasText: CLIPS.all });
    const pills = card.locator(".week-card__mark");
    await expect(pills.first()).toBeVisible();
    // Only apps the clip is really on, and the views line says how many.
    const n = await pills.count();
    await expect(card.locator(".week-card__views")).toContainText(new RegExp(`on ${n} apps?$`));
    for (const t of await page.locator(".week-card__marks").allInnerTexts()) expect(t).not.toContain("–");
    // The best app is highlighted and named as best for screen readers.
    await expect(card.locator(".week-card__mark.is-best")).toHaveCount(1);
    await expect(card.locator(".week-card__mark.is-best")).toHaveAttribute("data-platform", "tiktok");
    await expect(card.locator(".week-card__mark.is-best")).toContainText(", best");
    // Readable sizes: 15 px numbers, 16 px marks.
    const size15 = await pills.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size15).toBeGreaterThanOrEqual(15);
    const mark = (await pills.first().locator("svg").boundingBox())!;
    expect(mark.width).toBeGreaterThanOrEqual(16);
    // A pill never breaks across lines.
    for (const h of await pills.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(34);
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
    expect(result.page).toBeLessThanOrEqual(result.viewport);
  }
});
