import { expect, test, type Page } from "@playwright/test";
import { ACT_MS } from "../src/lib/motion.ts";
import { settle } from "./helpers.ts";
import { actWidths, holdClock, MOTION_WIDTHS, noSideScroll, pauseActs, recordAct, soundKinds, tapAct, tapHeld, watchFor } from "./motionHelpers.ts";

// Action motion on the app shell (docs/CONTRACTS.md §20.11 (d)): the sidebar collapse turn, Get the app (device
// chips, Download, Copy the link) and the update bar's Reload.

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";

/** Makes the clipboard succeed or fail on demand (headless Chromium's own clipboard is not reliable). */
async function fakeClipboard(page: Page, ok: boolean) {
  await page.addInitScript((works) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => (works ? Promise.resolve() : Promise.reject(new Error("blocked"))) },
    });
  }, ok);
}

test.describe("motion: shell (APPLY d)", () => {
  test.describe("sidebar", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("the collapse icon turns 180° with the menu, and does not turn under reduced motion", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const toggle = page.locator("nav.sidebar").getByRole("button", { name: "Collapse menu" });
      const turn = toggle.locator(".act-turn");
      // Open: turned 180° (the panel glyph inside is drawn pre-turned, so it reads the usual way round).
      await expect.poll(() => turn.evaluate((el) => getComputedStyle(el).transform)).toMatch(/^matrix\(-1, /);
      expect(await turn.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.24s");
      const before = await toggle.evaluate((el) => (el as HTMLElement).offsetWidth);
      await toggle.click();
      const expand = page.locator("nav.sidebar").getByRole("button", { name: "Expand menu" });
      await expect.poll(() => expand.locator(".act-turn").evaluate((el) => getComputedStyle(el).transform)).toBe("none");
      expect(await expand.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(before);
      await expand.click();

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = page.locator("nav.sidebar .sidebar__toggle .act-turn");
      expect(Number.parseFloat(await reduced.evaluate((el) => getComputedStyle(el).transitionDuration))).toBeLessThan(0.01);
    });
  });

  test.describe("Get the app on a Mac", () => {
    test.use({ userAgent: MAC, viewport: { width: 1440, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.route("**/downloads/**", (r) => r.fulfill({ status: 204, body: "" }));
      // Before the page loads, so a test can hold the page's clock (holdClock); until then time runs as usual.
      await page.clock.install();
      await page.goto("/get-app");
      await settle(page);
    });

    test("a device chip bumps its label; Download plays download; the action is not delayed", async ({ page }) => {
      const windows = page.getByRole("button", { name: "Windows", exact: true });
      await expect(windows).toHaveAttribute("data-act", "toggle");
      await windows.click();
      // The new choice applies at once and its label carries the bump.
      await expect(page.getByRole("link", { name: "Download for Windows" })).toBeVisible();
      await expect(windows.locator(".act.act--toggle")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Mac", exact: true }).locator(".act")).toHaveCount(0);

      await page.getByRole("button", { name: "Mac", exact: true }).click();
      const download = page.getByRole("link", { name: "Download for Mac" });
      await expect(download).toHaveAttribute("data-act", "download");
      const width = await download.evaluate((el) => (el as HTMLElement).offsetWidth);
      // The page's clock is held from the tap: the glyph stays in its play phase until the test moves the clock on, so
      // the checks cannot race its end timer on a busy machine, and its return to rest is timed on the page.s clock.
      await holdClock(page);
      await tapHeld(download);
      await expect(download.locator(".act")).toContainClass("act act--download is-play");
      // The handler ran in the same click: the hint is already there while the arrow is still moving.
      await expect(page.getByRole("status").filter({ hasText: "Downloading." })).toBeVisible();
      await expect(download.locator(".act")).toContainClass("is-play");
      expect(await download.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(width);
      await page.clock.runFor(ACT_MS.download);
      await expect(download.locator(".act")).toHaveClass(/is-idle/);
      await page.clock.resume();
      // The glyph never takes the button's name.
      await expect(download.locator(".act")).toHaveAttribute("aria-hidden", "true");
    });

    test("reduced motion: the download and the chip only fade", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const { cls } = await tapAct(page.getByRole("link", { name: "Download for Mac" }));
      expect(cls).toContain("is-fade");
      const chip = await page.getByRole("button", { name: "Windows", exact: true }).evaluate(async (el: HTMLElement) => {
        el.click();
        await new Promise((r) => setTimeout(r, 0));
        return el.querySelector(".act")?.className ?? "";
      });
      expect(chip).toContain("is-fade");
      await pauseActs(page, 0.5);
      const moved = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".getapp .act__item"), (el) => getComputedStyle(el).transform).filter((t) => t !== "none"),
      );
      expect(moved).toEqual([]);
    });

    for (const width of MOTION_WIDTHS) {
      test(`nothing overflows or grows mid-motion at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await settle(page);
        const before = await actWidths(page);
        await page.getByRole("link", { name: "Download for Mac" }).evaluate((el: HTMLElement) => el.click());
        await page.getByRole("button", { name: "Windows", exact: true }).evaluate((el: HTMLElement) => el.click());
        await page.getByRole("link", { name: "Download for Windows" }).evaluate((el: HTMLElement) => el.click());
        await pauseActs(page, 0.5);
        expect(await noSideScroll(page)).toBe(true);
        const during = await actWidths(page);
        for (const [k, w] of Object.entries(during)) if (k in before) expect(w, k).toBe(before[k]);
      });
    }
  });

  test.describe("Copy the link on iPhone Chrome", () => {
    test.use({ userAgent: IPHONE_CHROME, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("copying plays copy, then shows Link copied", async ({ page }) => {
      await fakeClipboard(page, true);
      await page.goto("/settings/app/get-the-app");
      await settle(page);
      const copy = page.getByRole("button", { name: "Copy the link" });
      await expect(copy).toHaveAttribute("data-act", "copy");
      const { cls } = await tapAct(copy);
      expect(cls).toContain("act--copy");
      expect(cls).toContain("is-play");
      await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });

    test("a blocked clipboard shakes the button with one deny and no Link copied", async ({ page }) => {
      await fakeClipboard(page, false);
      await page.goto("/settings/app/get-the-app");
      await settle(page);
      await page.evaluate(() => (window.__cfSoundLog = []));
      const copy = page.getByRole("button", { name: "Copy the link" });
      // The shake is short (ACT_FAIL_MS): watch for it from before the tap, so a busy machine cannot hide it.
      const shook = await watchFor(copy, ".act.is-fail");
      await copy.click();
      await expect.poll(shook).toBe(true);
      await expect(page.getByText("Copy the address at the top of the screen instead.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Link copied" })).toHaveCount(0);
      await expect.poll(() => soundKinds(page)).toContain("deny");
      expect((await soundKinds(page)).filter((k) => k === "deny")).toHaveLength(1);
      expect(await soundKinds(page)).not.toContain("success");
    });
  });

  test("the update bar's Reload carries refresh and still reloads at the tap", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/?update=1");
    await settle(page);
    const bar = page.getByRole("region", { name: "New version" });
    const reload = bar.getByRole("button", { name: "Reload" });
    await expect(reload).toHaveAttribute("data-act", "refresh");
    await expect(reload.locator(".act.act--refresh")).toHaveCount(1);
    expect(await noSideScroll(page)).toBe(true);
    await reload.click();
    // Nothing waits for the motion: the progress starts straight away.
    await expect(page.getByRole("progressbar", { name: "Update progress" })).toBeVisible();
  });
});

test.describe("motion: sign in (APPLY d)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"));
    // Before the page loads, so a test can hold the page's clock (holdClock); until then time runs as usual.
    await page.clock.install();
    await page.goto("/");
    await page.getByLabel("Email").waitFor();
  });

  test("Sign in snaps its link; a wrong password shakes it with one deny; the eye blinks", async ({ page }) => {
    const signIn = page.getByRole("button", { name: "Sign in" });
    await expect(signIn).toHaveAttribute("data-act", "connect");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByLabel("Password").fill("wrong");
    await page.evaluate(() => (window.__cfSoundLog = []));
    const seen = (await recordAct(signIn, 1500)).join(" ");
    expect(seen).toMatch(/act--connect is-play/);
    expect(seen).toMatch(/act--connect is-fail/);
    await expect(page.getByRole("alert")).toContainText("That email or password is not right.");
    await expect.poll(() => soundKinds(page)).toContain("deny");
    expect((await soundKinds(page)).filter((k) => k === "deny")).toHaveLength(1);
    expect(await soundKinds(page)).not.toContain("success");

    const eye = page.getByRole("button", { name: "Show" });
    await expect(eye).toHaveAttribute("data-act", "blink");
    // Held from the tap, so the 180 ms blink is still in its play phase when checked and rests on the page.s clock.
    await holdClock(page);
    await tapHeld(eye);
    // Now named Hide (same button).
    const glyph = page.locator(".password__toggle .act");
    await expect(glyph).toContainClass("act--blink is-play");
    await expect(page.getByLabel("Password")).toHaveAttribute("type", "text");
    await page.clock.runFor(ACT_MS.blink);
    await expect(glyph).toHaveClass(/is-idle/);
    await page.clock.resume();
  });

  test("Start again turns its arrow and goes back to the first step", async ({ page }) => {
    await page.getByLabel("Email").fill("new@example.com");
    await page.getByLabel("Password").fill("Temporary1!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("New password")).toBeVisible();
    const again = page.getByRole("button", { name: "Start again" });
    await expect(again).toHaveAttribute("data-act", "retry");
    await again.click();
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
  });
});
