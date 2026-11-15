import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";

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
      await expect(items).toHaveCount(5);
      for (const item of await items.all()) {
        // No visible words: only an icon, with the name for screen readers.
        expect((await item.innerText()).replace(/\d+/g, "").trim()).toBe("");
        await expect(item).toHaveAttribute("aria-label", /\w+/);
        await expect(item.locator("svg").first()).toBeVisible();
        const box = await item.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await bar.getByRole("link", { name: /^Review/ }).click();
      await expect(page).toHaveURL(/\/review$/);
      await expect(bar.getByRole("link", { name: /^Review/ })).toHaveAttribute("aria-current", "page");
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
  await page.waitForTimeout(600);
  const narrow = (await sidebar.boundingBox())!.width;
  expect(narrow).toBeLessThan(wide / 2);
  await expect(sidebar.getByText("Library", { exact: true })).toBeHidden();
  await expect(sidebar.getByRole("link", { name: "Library" })).toBeVisible();

  await page.reload();
  await settle(page);
  await expect(page.locator("nav.sidebar")).toHaveClass(/is-collapsed/);
  await page.locator("nav.sidebar").getByRole("button", { name: "Expand menu" }).click();
  await expect(page.locator("nav.sidebar")).not.toHaveClass(/is-collapsed/);
});

test("every screen has one main landmark and a level-one heading", async ({ page }) => {
  for (const path of ["/", "/jobs", "/review", "/library", "/settings"]) {
    await page.goto(path);
    await settle(page);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
  }
});
