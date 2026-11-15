import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// "Get the app" (docs/CONTRACTS.md §12.1).

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";

/** Pretends the page runs inside an installed app window. */
async function asInstalledApp(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => {
      if (q.includes("display-mode: standalone")) {
        return { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList;
      }
      return real(q);
    };
  });
}

test.describe("in a normal browser on a Mac", () => {
  test.use({ userAgent: MAC, viewport: { width: 1440, height: 900 } });

  test("the sidebar offers Get the app, and the page recommends the .dmg", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const item = page.locator("nav.sidebar").getByRole("link", { name: "Get the app" });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page).toHaveURL(/\/get-app$/);
    await expect(page.getByRole("heading", { level: 1, name: /Get the app/ })).toBeVisible();
    await expect(page.getByText("Looks like you are on a Mac.")).toBeVisible();
    const download = page.getByRole("link", { name: "Download for Mac" });
    await expect(download).toHaveAttribute("href", "/downloads/Clip-Factory.dmg");
    await expect(page.getByText(/Privacy & Security, Open Anyway/)).toBeVisible();
    await expect(item).toHaveAttribute("aria-current", "page");

    // Picking another device switches the offer.
    await page.getByRole("button", { name: "Windows", exact: true }).click();
    await expect(page.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", "/downloads/Clip-Factory-Setup.exe");
    await expect(page.getByText(/More info, then Run anyway/)).toBeVisible();
  });

  test("Settings has the Get the app card", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await expect(page.getByRole("heading", { name: /Get the app/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download for Mac" })).toBeVisible();
  });

  test("starting a download does not hide the offer (it may never finish)", async ({ page }) => {
    await page.goto("/get-app");
    await settle(page);
    // Stop the browser from actually saving the fake file.
    await page.route("**/downloads/**", (r) => r.fulfill({ status: 204, body: "" }));
    await page.getByRole("link", { name: "Download for Mac" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Downloading." })).toBeVisible();
    await page.goto("/");
    await settle(page);
    await expect(page.locator("nav.sidebar").getByRole("link", { name: "Get the app" })).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("cf.installed"))).toBeNull();
    // Back on the page in the same session, the download is still offered and the hint is remembered.
    await page.goto("/get-app");
    await settle(page);
    await expect(page.getByRole("link", { name: "Download for Mac" })).toBeVisible();
    await expect(page.getByText("Downloading. Open the file when it finishes.", { exact: false })).toBeVisible();
  });
});

test.describe("Windows", () => {
  test.use({ userAgent: WINDOWS, viewport: { width: 1280, height: 800 } });
  test("recommends the .exe", async ({ page }) => {
    await page.goto("/get-app");
    await settle(page);
    await expect(page.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", "/downloads/Clip-Factory-Setup.exe");
  });
});

test.describe("installed app window", () => {
  test.use({ userAgent: MAC, viewport: { width: 1440, height: 900 } });
  test("hides every Get the app entry when running standalone", async ({ page }) => {
    await asInstalledApp(page);
    await page.goto("/");
    await settle(page);
    await expect(page.locator("nav.sidebar").getByRole("link", { name: "Get the app" })).toHaveCount(0);
    await page.goto("/settings");
    await settle(page);
    await expect(page.getByRole("heading", { name: /Get the app/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Get the app" })).toHaveCount(0);
    // A direct visit is never a dead end.
    await page.goto("/get-app");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: /You have the app/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go home" })).toBeVisible();
  });

  test("hides inside the desktop wrapper", async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __CF_DESKTOP__?: boolean }).__CF_DESKTOP__ = true;
    });
    await page.goto("/");
    await settle(page);
    await expect(page.locator("nav.sidebar").getByRole("link", { name: "Get the app" })).toHaveCount(0);
  });
});

test.describe("iPhone", () => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Home shows a one-time banner; Not now closes it for good", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const banner = page.getByRole("complementary", { name: "Get the app" });
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await settle(page);
    await expect(page.getByRole("complementary", { name: "Get the app" })).toHaveCount(0);
  });

  test("Show me opens three picture steps with the Share icon", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("complementary", { name: "Get the app" }).getByRole("link", { name: "Show me" }).click();
    await expect(page).toHaveURL(/\/get-app$/);
    const steps = page.locator(".steps .step");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("Tap Share");
    await expect(steps.nth(1)).toContainText("Tap Add to Home Screen");
    await expect(steps.nth(2)).toContainText("Tap Add");
    await expect(steps.nth(0).locator("svg.icon")).not.toHaveCount(0);
    await expect(page.getByText("Open this page in Safari first.")).toHaveCount(0);
  });

  test("the iPhone Home Screen app hides the banner", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    await page.goto("/");
    await settle(page);
    await expect(page.getByRole("complementary", { name: "Get the app" })).toHaveCount(0);
  });
});

test.describe("Chrome on iPhone", () => {
  test.use({ userAgent: IPHONE_CHROME, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("says to open the page in Safari first", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await expect(page.getByText("Open this page in Safari first.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy the link" })).toBeVisible();
  });
});

test.describe("big targets on phones", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("every button and control is at least 48px tall", async ({ page }) => {
    const small: string[] = [];
    for (const path of ["/", "/jobs", "/review", "/library", "/settings", "/get-app", "/?update=1"]) {
      await page.goto(path);
      await settle(page);
      const found = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(".btn, .icon-btn, .chip, .segmented__opt, .stepper__btn, .linkbox__paste, .toast__undo, .tabbar__item"),
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
          if (r.height < 47.5) out.push(`${el.className} "${el.textContent?.trim().slice(0, 30)}" ${Math.round(r.height)}px`);
        }
        return out;
      });
      small.push(...found.map((f) => `${path}: ${f}`));
    }
    expect(small, small.join("\n")).toEqual([]);
  });
});
