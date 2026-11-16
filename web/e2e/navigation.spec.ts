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
      await expect(items).toHaveCount(5);
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

// While a page-change View Transition runs, the browser sends every tap to <html>, not to the button under the
// finger. On a slow device (no GPU help with the glass) the fade can take seconds; the router cuts it short.
test.describe("a slow page change never blocks taps for long", () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  const slowFade = "::view-transition-old(root),::view-transition-new(root){animation-duration:5s!important}";
  const hitTag = (page: import("@playwright/test").Page, x: number, y: number) =>
    page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x, y });

  test("the fade ends by itself within half a second", async ({ page }) => {
    await page.goto("/settings/posting/where");
    await settle(page);
    await page.addStyleTag({ content: slowFade });
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Set up posting" }).click();
    const card = page.locator(".setup-card[data-platform='youtube']");
    await expect(card).toBeVisible();
    // The time is the test: the fade, slowed to 5 s, must have been ended by the app's own cap well before that.
    await page.waitForTimeout(700);
    const box = (await card.boundingBox())!;
    expect(await hitTag(page, box.x + box.width / 2, box.y + box.height / 2)).not.toBe("HTML");
    await page.evaluate(() => (window.__cfSoundLog = []));
    await card.click();
    await expect(page).toHaveURL(/\/setup\/youtube$/);
    await expect.poll(() => page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["tap"]);
  });

  test("a tap during the fade ends it at once", async ({ page }) => {
    await page.goto("/jobs");
    await settle(page);
    await page.addStyleTag({ content: slowFade });
    await page.locator("nav.sidebar").getByRole("link", { name: "Library", exact: true }).click();
    // The fade is over the page (it starts a frame or two after the tap, so wait to see it, not for a fixed time).
    await expect.poll(() => hitTag(page, 640, 450)).toBe("HTML");
    await page.mouse.click(5, 895);
    await expect.poll(() => hitTag(page, 640, 450)).not.toBe("HTML");
  });
});
