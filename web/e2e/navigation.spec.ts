import { expect, test } from "@playwright/test";
import { SETTINGS_ROUTES, settle } from "./helpers.ts";

test.describe("phones", () => {
  for (const width of [320, 390, 414]) {
    test(`bottom bar shows icons only at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await settle(page);
      const bar = page.locator("nav.tabbar");
      await expect(bar).toBeVisible();
      await expect(page.locator("nav.sidebar")).toBeHidden();
      const items = bar.locator("a");
      // Home, Jobs, Review, Library, Money (§27.4), Settings.
      await expect(items).toHaveCount(6);
      for (const item of await items.all()) {
        // No visible words: only an icon, with the name for screen readers.
        expect((await item.innerText()).replace(/\d+/g, "").trim()).toBe("");
        await expect(item).toHaveAttribute("aria-label", /\w+/);
        await expect(item.locator("svg").first()).toBeVisible();
        const box = await item.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(48);
        expect(box!.height).toBeGreaterThanOrEqual(48);
      }
      await bar.getByRole("link", { name: /^Review/ }).click();
      await expect(page).toHaveURL(/\/review$/);
      await expect(bar.getByRole("link", { name: /^Review/ })).toHaveAttribute("aria-current", "page");
      await bar.getByRole("link", { name: "Money" }).click();
      await expect(page).toHaveURL(/\/money$/);
      await expect(bar.getByRole("link", { name: "Money" })).toHaveAttribute("aria-current", "page");
    });
  }
});

test("the sidebar collapses to icons on desktop and remembers it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await settle(page);
  const sidebar = page.locator("nav.sidebar");
  await expect(sidebar).toBeVisible();
  await expect(page.locator("nav.tabbar")).toBeHidden();
  await expect(sidebar.getByText("Library")).toBeVisible();
  const wide = (await sidebar.boundingBox())!.width;

  await sidebar.getByRole("button", { name: "Collapse menu" }).click();
  await expect(sidebar).toHaveClass(/is-collapsed/);
  // The width animates; wait for it to settle rather than for a fixed time (CI machines are slower).
  await expect.poll(async () => (await sidebar.boundingBox())!.width, { timeout: 10_000 }).toBeLessThan(wide / 2);
  await expect(sidebar.getByText("Library", { exact: true })).toBeHidden();
  await expect(sidebar.getByRole("link", { name: "Library" })).toBeVisible();

  await page.reload();
  await settle(page);
  await expect(page.locator("nav.sidebar")).toHaveClass(/is-collapsed/);
  await page.locator("nav.sidebar").getByRole("button", { name: "Expand menu" }).click();
  await expect(page.locator("nav.sidebar")).not.toHaveClass(/is-collapsed/);
});

test("every screen has one main landmark and a level-one heading", async ({ page }) => {
  for (const path of ["/", "/jobs", "/review", "/library", ...SETTINGS_ROUTES]) {
    await page.goto(path);
    await settle(page);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
  }
});

// A page change is an instant swap with no View Transition (docs/CONTRACTS.md §20.16): nothing ever covers the page
// for a moment and swallows taps, and the window never blinks. e2e/page-still.spec.ts checks the stillness itself.
test("a page change never starts a View Transition", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __vtCalls: number };
    w.__vtCalls = 0;
    const doc = Document.prototype as unknown as { startViewTransition?: (...a: unknown[]) => unknown };
    const orig = doc.startViewTransition;
    if (orig)
      doc.startViewTransition = function (this: Document, ...a: unknown[]) {
        w.__vtCalls++;
        return orig.apply(this, a);
      };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/jobs");
  await settle(page);
  for (const key of ["library", "review", "settings", "home"]) {
    await page.locator(`nav.sidebar .sidebar__item[data-help="nav-${key}"]`).click();
    // Right after the tap the page under the finger is the page itself, never a captured picture of it.
    expect(await page.evaluate(() => document.elementFromPoint(640, 450)?.tagName)).not.toBe("HTML");
  }
  await page.goBack();
  expect(await page.evaluate(() => (window as unknown as { __vtCalls: number }).__vtCalls)).toBe(0);
});
