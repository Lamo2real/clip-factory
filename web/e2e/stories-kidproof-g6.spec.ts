import { expect, test, type Page } from "@playwright/test";

// Clips Funded, kid-proof bug hunt (G6) in the mock app: the flows a child got stuck in. The setup brings each new
// step's title into view on a phone; a double tap on Get ideas asks once and opens nothing else; the dashboard's Try
// again on a post that stays stuck says why (no confetti); a double tap on Talk about it in Chat makes one chat; the
// chosen option of a pick shows the keyboard's ring; Settings › Video says Failed with Try again when the makers did
// not load; a reference video that will not play says so; Look › Picture names what is wrong with a file; and Analyze
// runs only its first step until the job answers. Clips Funded is switched on with cf.storiesPreview = 1.

type StoriesWindow = Window & { __cfStoriesMock?: { knobs?: Record<string, unknown>; store?: Record<string, unknown> & { conversations: { title: string }[] } } };

async function preview(page: Page, knobs?: Record<string, unknown>) {
  await page.addInitScript((k) => {
    localStorage.setItem("cf.storiesPreview", "1");
    if (k) (window as unknown as StoriesWindow).__cfStoriesMock = { knobs: k };
  }, knobs ?? null);
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot, .st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

for (const [width, height] of [
  [390, 844],
  [320, 640],
] as const) {
  test(`setup @${width}: every step change brings the new step's title into view`, async ({ page }) => {
    await preview(page, { fresh: true, checkModelsMs: 30 });
    await page.setViewportSize({ width, height });
    await page.goto("/stories/setup");
    await ready(page);
    const title = page.locator("#st-setup-step");
    const onScreen = async () => {
      const box = await title.boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= height;
    };
    const save = page.locator(".st-setup__panel").getByRole("button", { name: "These look right" });
    await save.scrollIntoViewIfNeeded();
    await save.click();
    await expect(title).toHaveText("Pick your default model");
    await expect.poll(onScreen, { timeout: 4000 }).toBe(true);
    // The model's choices start right under the title, not under the thumb.
    await page.locator(".st-setup__panel").getByRole("button", { name: /^Use / }).scrollIntoViewIfNeeded();
    await page.locator(".st-setup__panel").getByRole("button", { name: /^Use / }).click();
    await expect(title).toHaveText(/Pick your default effort/);
    await expect.poll(onScreen, { timeout: 4000 }).toBe(true);
    // A connect step's Skip for now too.
    await page.locator(".st-steps__item").filter({ hasText: "Connect Instagram" }).click();
    await expect(title).toHaveText("Connect Instagram");
    const skip = page.locator(".st-setup__foot").getByRole("button", { name: "Skip for now" });
    await skip.scrollIntoViewIfNeeded();
    await skip.click();
    await expect(title).toHaveText("Connect TikTok");
    await expect.poll(onScreen, { timeout: 4000 }).toBe(true);
  });
}

test("Ideas @390: a double tap on Get ideas asks once and opens nothing else", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stories/ideas");
  await ready(page);
  await page.getByRole("button", { name: "Ask for ideas" }).click();
  const ask = page.getByRole("form", { name: "Ask for ideas" });
  const get = ask.getByRole("button", { name: "Get ideas" });
  await get.scrollIntoViewIfNeeded();
  const before = await get.boundingBox();
  await get.dblclick();
  await expect(ask.locator(".st-s-busy")).toBeVisible();
  // The buttons did not move, and no sheet opened.
  const after = await ask.getByRole("button", { name: /Thinking…|Get ideas/ }).boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Ideas: Tab to the filter and an arrow key: the chosen option shows the focus ring", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/ideas");
  await ready(page);
  const all = page.locator(".st-s-filter input[type=radio]").first();
  await all.focus();
  await page.keyboard.press("ArrowRight");
  const on = page.locator(".st-s-filter .st-s-pick__opt.is-on");
  await expect(on).toContainText("Saved");
  // After its short shadow transition: the ring stays (it used to fade to none on the chosen option).
  await page.waitForTimeout(900);
  expect(await on.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
});

test("dashboard: Try again on a post that stays stuck says why, with no 'Trying again now.'", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories");
  await ready(page);
  const item = page.locator(".st-needs-list__item").filter({ hasText: "needs connecting again" }).filter({ has: page.getByRole("button", { name: "Try again" }) }).first();
  await item.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".toast").filter({ hasText: "needs connecting again" })).toBeVisible();
  await expect(page.locator(".toast").filter({ hasText: "Trying again now." })).toHaveCount(0);
  await expect(page.locator(".st-burst")).toHaveCount(0);
});

test("dashboard: New idea opens the New idea form at once", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories");
  await ready(page);
  await page.locator(".st-page-head, .st-head").getByRole("link", { name: "New idea" }).first().click();
  await expect(page).toHaveURL(/\/stories\/ideas$/);
  await expect(page.getByRole("form", { name: "New idea" })).toBeVisible();
});

test("reference: a double tap on Talk about it in Chat makes one chat; a video that will not play says so", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories/references/01JSTRF0000000000000000001");
  await ready(page);
  // The mock's link cannot play: the player says so, with Try again, in place of dead controls.
  await expect(page.locator(".st-ref-controls--failed")).toContainText("This video would not play.");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => (window as unknown as StoriesWindow).__cfStoriesMock!.store!.conversations.length);
  await page.getByRole("button", { name: "Talk about it in Chat" }).dblclick();
  await expect(page).toHaveURL(/\/stories\/chat\//, { timeout: 10_000 });
  const made = await page.evaluate(() => (window as unknown as StoriesWindow).__cfStoriesMock!.store!.conversations.filter((c) => c.title.startsWith("About ")).length);
  const after = await page.evaluate(() => (window as unknown as StoriesWindow).__cfStoriesMock!.store!.conversations.length);
  expect(after - before).toBe(1);
  expect(made).toBeGreaterThanOrEqual(1);
});

test("reference: right after Analyze it only the first step is working", async ({ page }) => {
  await preview(page, { refSeconds: 20 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/references/01JSTRF0000000000000000002");
  await ready(page);
  await page.getByRole("button", { name: "Analyze it" }).click();
  await expect(page.locator(".st-ref-track")).toBeVisible();
  for (let i = 0; i < 6; i++) {
    expect(await page.locator(".st-ref-track__step.is-running").count()).toBeLessThanOrEqual(1);
    await page.waitForTimeout(250);
  }
});

test("Settings › Video: makers that did not load say Failed with Try again, and Try again brings them back", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/ideas");
  await ready(page);
  await page.evaluate(() => {
    const store = (window as unknown as StoriesWindow).__cfStoriesMock!.store!;
    const real = store.ai;
    (window as unknown as { __g6Ai?: unknown }).__g6Ai = real;
    Object.defineProperty(store, "ai", {
      configurable: true,
      get() {
        throw new TypeError("Failed to fetch");
      },
    });
  });
  // In the app (a reload would make a fresh practice store).
  await page.evaluate(() => {
    history.pushState(null, "", "/stories/settings/video");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const failed = page.locator(".st-stg-failed");
  await expect(failed.first()).toBeVisible({ timeout: 10_000 });
  await expect(failed.first().getByRole("button", { name: "Try again" })).toBeVisible();
  // Prices and keys: one card, never an empty space.
  const prices = page.getByRole("region", { name: "Prices and keys" });
  await expect(prices.locator(".st-stg-failed")).toHaveCount(1);
  await page.evaluate(() => {
    const store = (window as unknown as StoriesWindow).__cfStoriesMock!.store!;
    Object.defineProperty(store, "ai", { configurable: true, writable: true, value: (window as unknown as { __g6Ai?: unknown }).__g6Ai });
  });
  for (const b of await page.locator(".st-stg-failed").getByRole("button", { name: "Try again" }).all()) await b.click().catch(() => undefined);
  await expect(page.locator(".st-stg-failed")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("list", { name: "Provider keys" }).or(page.getByText("None of these providers needs a key"))).toBeVisible();
});

test("Settings › Look › Picture: a PDF says pick a photo; a broken photo says it would not open", async ({ page }) => {
  await preview(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories/settings/look");
  await ready(page);
  await page.getByRole("radiogroup", { name: "Background" }).getByRole("radio", { name: /Picture/ }).click();
  const input = page.locator(".st-look input[type=file]");
  await input.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 notes") });
  await expect(page.getByText("Pick a photo (JPG or PNG).")).toBeVisible();
  await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not a real photo") });
  await expect(page.getByText("That picture would not open. Pick another one.")).toBeVisible();
  await expect(page.getByText("That picture is too big.")).toHaveCount(0);
});
