import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Review fixes from the UI audit (docs/CONTRACTS.md §12.4 "Review screen", §17.8).

async function openReview(page: Page) {
  await page.goto("/review");
  await settle(page);
}

const hooks = (page: Page) => page.locator(".review-card__hook").allInnerTexts();

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a refused Keep opens the too-long tab, marks it red and names the platform (F006)", async ({ page }) => {
    await openReview(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("tab", { name: "X" }).click();
    await card.getByLabel("X caption").fill("x".repeat(350));
    await card.getByRole("tab", { name: "YouTube" }).click();
    const x = card.getByRole("tab", { name: "X, too long" });
    await expect(x).toHaveClass(/is-over/);
    await expect(x).toHaveAttribute("aria-selected", "false");

    await card.getByRole("button", { name: "Keep", exact: true }).click();
    await expect(page.getByText("Your X caption is longer than its platform allows. Make it shorter, then tap Keep.")).toBeVisible();
    await expect(x).toHaveAttribute("aria-selected", "true");
    await expect(x).toBeFocused();
    await expect(x).toBeInViewport({ ratio: 1 });
    await expect(card.getByLabel("X caption")).toHaveAttribute("aria-invalid", "true");
  });

  test("a clip thrown away stays gone when you leave Review and come back inside the Undo time (F007)", async ({ page }) => {
    await openReview(page);
    const first = (await hooks(page))[0]!;
    await page.locator(".review-card").first().getByRole("button", { name: "Throw away" }).click();
    await expect(page.locator(".review-card__hook", { hasText: first })).toHaveCount(0);
    await page.locator('a[href="/jobs"]:visible').first().click();
    await page.waitForURL(/\/jobs$/);
    await page.locator('a[href="/review"]:visible').first().click();
    await page.waitForURL(/\/review$/);
    await settle(page);
    expect(await hooks(page)).not.toContain(first);
    // Undo still brings it back on this new Review.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".review-card__hook", { hasText: first })).toBeVisible();
    await expect(page.locator(".review-card__hook", { hasText: first })).toBeFocused();
  });

  test("Throw away moves the focus to the next card's title, never to the page (F031)", async ({ page }) => {
    await openReview(page);
    const [, second] = await hooks(page);
    const toss = page.locator(".review-card").first().getByRole("button", { name: "Throw away" });
    await toss.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".review-card__hook", { hasText: second! })).toBeFocused();
  });

  test("throwing away the last card moves the focus to the card before it (F031)", async ({ page }) => {
    await openReview(page);
    const all = await hooks(page);
    const toss = page.locator(".review-card").last().getByRole("button", { name: "Throw away" });
    await toss.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".review-card__hook", { hasText: all[all.length - 2]! })).toBeFocused();
  });

  test("arriving from a clip link scrolls there once; Throw away further down does not jump back (F008)", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.locator("a.teaser").first().click();
    await page.waitForURL(/\/review#clip-/);
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const cards = page.locator(".review-card");
    const count = await cards.count();
    await cards.last().getByRole("button", { name: "Throw away" }).click();
    await expect(cards).toHaveCount(count - 1);
    // The wait is the test: given time, the page has not been pulled back up to the linked clip.
    await page.waitForTimeout(300);
    const y = await page.evaluate(() => scrollY);
    const linked = await page.evaluate(() => document.getElementById(location.hash.slice(1))?.getBoundingClientRect().top ?? null);
    // The page stays near the bottom: the linked clip is not pulled back to the top of the screen.
    expect(linked === null || Math.abs(linked) > 100).toBe(true);
    expect(y).toBeGreaterThan(400);
  });

  test("the source line keeps its link icon beside the words (F035)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openReview(page);
    const links = page.locator(".review-card__source");
    for (let i = 0; i < (await links.count()); i++) {
      const row = links.nth(i);
      // The icon is inside the link (or the plain line), so it can never wrap onto a line of its own.
      await expect(row.locator(":scope > svg")).toHaveCount(0);
      await expect(row.locator(".text-link svg, .review-card__source-text svg")).toHaveCount(1);
      const gap = await row.evaluate((el) => {
        const svg = el.querySelector("svg")!.getBoundingClientRect();
        const holder = el.querySelector(".text-link, .review-card__source-text")!.getBoundingClientRect();
        return svg.top - holder.top;
      });
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(40);
    }
  });

  test("a job-filtered Review says it is one job, with the total (F060)", async ({ page }) => {
    await openReview(page);
    const total = await page.locator(".review-card").count();
    await page.locator(".review-card__job").first().click();
    await page.waitForURL(/\/jobs\//);
    await settle(page);
    await page.locator('a[href^="/review?job="]').first().click();
    await page.waitForURL(/\/review\?job=/);
    await settle(page);
    const here = await page.locator(".review-card").count();
    const count = page.locator(".review-count");
    await expect(count).toContainText(/from this job waiting/);
    if (here < total) await expect(count).toContainText(`(${total} in all)`);
    await expect(page.getByText("These clips all come from one job.", { exact: false })).toBeVisible();
  });
});

for (const width of [320, 375, 960, 1024, 1280]) {
  test(`at ${width}px all five caption tabs are in sight and the actions line up (F021, F028, F034)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page);
    const card = page.locator(".review-card").first();
    const strip = card.locator(".captions .tabs");
    const fit = await strip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const tabs = Array.from(el.querySelectorAll('[role="tab"]')).map((t) => t.getBoundingClientRect());
      return { tabs: tabs.length, inside: tabs.every((t) => t.left >= box.left - 1 && t.right <= box.right + 1), over: el.scrollWidth - el.clientWidth };
    });
    expect(fit.tabs).toBe(5);
    expect(fit.inside).toBe(true);
    expect(fit.over).toBeLessThanOrEqual(1);

    // The decision column is never squeezed: stacked, or at least 400px wide beside the video.
    const body = await card.locator(".review-card__body").evaluate((el) => el.getBoundingClientRect().width);
    expect(body).toBeGreaterThanOrEqual(Math.min(400, width - 64));

    // Throw away and Keep: one row, or two rows with the same left edge and width.
    const [a, b] = await Promise.all(
      ["Throw away", "Keep"].map((name) => card.getByRole("button", { name, exact: true }).boundingBox()),
    );
    if (Math.abs(a!.y - b!.y) > 20) {
      expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(a!.width - b!.width)).toBeLessThanOrEqual(1);
    }
  });
}

test("the shared confirm sheet dims the whole screen, not just the form (F002)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/settings/clip-making/skills/new");
  await settle(page);
  await page.getByLabel("When should Clip Factory use it?").fill("Only on Fridays.");
  await page.getByRole("link", { name: "Cancel" }).click();
  const leave = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(leave).toBeVisible();
  const box = await page.locator(".sheet-scrim").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const corner = document.elementFromPoint(4, innerHeight - 4);
    return { parent: el.parentElement?.tagName, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, covered: !!corner?.closest(".sheet-scrim") };
  });
  expect(box).toMatchObject({ parent: "BODY", x: 0, y: 0, w: box.vw, h: box.vh, covered: true });
});
