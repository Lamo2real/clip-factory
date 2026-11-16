import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

const log = (page: Page) => page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind));

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a touch scroll is silent; a tap makes the tap sound", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    await page.evaluate(() => (window.__cfSoundLog = []));

    // A real touch swipe that starts on a button: it scrolls, so no click and no sound.
    const cdp = await page.context().newCDPSession(page);
    // Start the swipe on a button (the big Back button at the top of a settings page on phones).
    const start = await page.locator("main .btn").first().boundingBox();
    // Count what the swipe really produced. Headless Linux browsers do not always scroll for a synthetic gesture,
    // so the test asserts the part that matters: touches arrived, no click fired, no sound played.
    await page.evaluate(() => {
      const w = window as unknown as { __touches: number; __clicks: number };
      w.__touches = 0;
      w.__clicks = 0;
      document.addEventListener("touchstart", () => w.__touches++, { capture: true, passive: true });
      document.addEventListener("click", () => w.__clicks++, { capture: true });
    });
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(start!.x + 20),
      y: Math.round(start!.y + 10),
      yDistance: -400,
      gestureSourceType: "touch",
      speed: 800,
    });
    // Plain touch events with movement, too.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 600 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 450 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 300 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // The wait is the test: given time, no click and no sound follow the swipe.
    await page.waitForTimeout(300);
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __touches: number; __clicks: number };
      return { touches: w.__touches, clicks: w.__clicks };
    });
    expect(counts.touches).toBeGreaterThan(0);
    expect(counts.clicks).toBe(0);
    expect(await log(page)).toEqual([]);

    // A tap on an enabled control.
    const tab = page.locator("nav.tabbar").getByRole("link", { name: "Jobs" });
    await tab.tap();
    await expect.poll(() => log(page)).toEqual(["tap"]);
  });

  test("a touch scroll that starts on an action button plays neither its motion nor a sound (§20.9)", async ({ page }) => {
    await page.goto("/review");
    await settle(page);
    const keep = page.locator(".review-card").first().getByRole("button", { name: "Keep", exact: true });
    await expect(keep).toHaveAttribute("data-act", "keep");
    await keep.scrollIntoViewIfNeeded();
    const box = (await keep.boundingBox())!;
    await page.evaluate(() => {
      const w = window as unknown as { __touches: number; __clicks: number; __played: number };
      w.__touches = 0;
      w.__clicks = 0;
      w.__played = 0;
      window.__cfSoundLog = [];
      document.addEventListener("touchstart", () => w.__touches++, { capture: true, passive: true });
      document.addEventListener("click", () => w.__clicks++, { capture: true });
      // Any .act leaving rest during the swipe would be a motion played by a scroll.
      new MutationObserver((list) => {
        for (const m of list) if (m.target instanceof Element && m.target.matches(".act:not(.is-idle)")) w.__played++;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -300, gestureSourceType: "touch", speed: 800 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 120 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 260 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // The wait is the test: given time, no click and no sound follow the swipe.
    await page.waitForTimeout(300);
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __touches: number; __clicks: number; __played: number };
      return { touches: w.__touches, clicks: w.__clicks, played: w.__played };
    });
    expect(counts.touches).toBeGreaterThan(0);
    expect(counts.clicks).toBe(0);
    expect(counts.played).toBe(0);
    expect(await log(page)).toEqual([]);
    await expect(keep.locator(".act")).toHaveClass(/is-idle/);
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
  await page.getByRole("radio", { name: "Pick a video" }).check({ force: true });
  expect(await log(page)).toEqual(["deny", "tap"]);

  // Plain text is not a control: no sound.
  await page.waitForTimeout(80);
  await page.locator(".hero__lede").click();
  expect(await log(page)).toEqual(["deny", "tap"]);

  // A switched-off button (Save keys before the keys look right) plays deny.
  await page.goto("/settings/posting/setup/youtube");
  await settle(page);
  await page.locator("[data-step='key-paste'] .gstep__head").click();
  const save = page.getByRole("button", { name: "Save keys" });
  await save.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__cfSoundLog = []));
  await save.click({ force: true });
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
  await page.goto("/settings/look-and-feel/sounds");
  await settle(page);
  await page.getByRole("switch", { name: "Sounds" }).click();
  await expect(page.getByRole("switch", { name: "Sounds" })).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => (window.__cfSoundLog = []));
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Look & feel" }).click();
  const entries = await page.evaluate(() => window.__cfSoundLog ?? []);
  expect(entries.length).toBe(1);
  expect(entries.every((e) => e.muted)).toBe(true);
});
