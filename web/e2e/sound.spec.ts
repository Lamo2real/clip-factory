import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

const log = (page: Page) => page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind));

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a touch scroll is silent; a tap makes the tap sound", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await page.evaluate(() => (window.__cfSoundLog = []));

    // A real touch swipe that starts on a button: it scrolls, so no click and no sound.
    const cdp = await page.context().newCDPSession(page);
    // The first button on the page (the Get the app card's device chooser sits at the top on phones).
    const start = await page.locator("main button").first().boundingBox();
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(start!.x + 20),
      y: Math.round(start!.y + 10),
      yDistance: -400,
      gestureSourceType: "touch",
      speed: 1200,
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
    // Plain touch events with movement, too.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 600 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 450 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 300 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    expect(await log(page)).toEqual([]);

    // A tap on an enabled control.
    const tab = page.locator("nav.tabbar").getByRole("link", { name: "Jobs" });
    await tab.tap();
    await expect.poll(() => log(page)).toEqual(["tap"]);
  });
});

test("enabled controls tap, switched-off controls deny, errors deny", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => (window.__cfSoundLog = []));

  // "Make clips" is switched off until a link is pasted.
  await page.getByRole("button", { name: "Make clips" }).click({ force: true });
  expect(await log(page)).toEqual(["deny"]);

  await page.waitForTimeout(80);
  await page.getByRole("radio", { name: "Upload a video" }).check({ force: true });
  expect(await log(page)).toEqual(["deny", "tap"]);

  // Plain text is not a control: no sound.
  await page.waitForTimeout(80);
  await page.locator(".hero__lede").click();
  expect(await log(page)).toEqual(["deny", "tap"]);

  // A "coming soon" button is switched off: deny, and a note says why.
  await page.goto("/settings");
  await settle(page);
  await page.evaluate(() => (window.__cfSoundLog = []));
  await page.getByRole("button", { name: /Connect YouTube/ }).click({ force: true });
  await expect.poll(() => log(page)).toEqual(["deny"]);

  // An error toast plays the deny sound by itself, right after the tap that caused it.
  await page.goto("/review");
  await settle(page);
  const card = page.locator(".review-card").first();
  await card.getByRole("tab", { name: "X" }).click();
  await card.getByLabel("X caption").fill("x".repeat(300));
  await page.evaluate(() => (window.__cfSoundLog = []));
  await card.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByText(/longer than its platform allows/)).toBeVisible();
  await expect.poll(() => log(page)).toEqual(["tap", "deny"]);
});

test("the Sound setting mutes every sound", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  await page.getByRole("switch", { name: "Sounds" }).click();
  await expect(page.getByRole("switch", { name: "Sounds" })).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => (window.__cfSoundLog = []));
  await page.getByRole("link", { name: "Skills" }).first().click();
  const entries = await page.evaluate(() => window.__cfSoundLog ?? []);
  expect(entries.length).toBe(1);
  expect(entries.every((e) => e.muted)).toBe(true);
});
