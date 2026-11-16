import { expect, test, type Page } from "@playwright/test";
import { SETTINGS_ROUTES, settle } from "./helpers.ts";

// Findings from the November 2026 UI/UX audit, each pinned so it cannot come back,
// plus the whole owner journey on a phone and on a desktop.

type MockWindow = Window & { __cfMockLive?: { advance(): void } };

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } as const;
const DESKTOP = { viewport: { width: 1280, height: 900 } } as const;

/** The navigation that is showing: the icon tab bar on phones, the sidebar on larger screens. */
const nav = (page: Page) => page.locator("nav.tabbar, nav.sidebar").filter({ visible: true });

const SCREENS = ["/", "/jobs", "/review", "/library", ...SETTINGS_ROUTES, "/get-app", "/nope"];

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("each screen has at most one tomato button", async ({ page }) => {
      const extra: string[] = [];
      for (const path of SCREENS) {
        await page.goto(path);
        await settle(page);
        const labels = await page
          .locator("main .btn--primary")
          .filter({ visible: true })
          .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));
        if (labels.length > 1) extra.push(`${path}: ${labels.join(", ")}`);
      }
      expect(extra, extra.join("\n")).toEqual([]);
    });

    test("the small sound tags in Settings read clearly (at least 4.5:1)", async ({ page }) => {
      await page.goto("/settings/look-and-feel/sounds");
      await settle(page);
      const color = await page.locator(".sound-group.is-tap .apple__tag").first().evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe("rgb(61, 79, 49)");
    });

    test("Review: only the top clip's Keep is tomato, and the next one takes over", async ({ page }) => {
      await page.goto("/review");
      await settle(page);
      const cards = page.locator(".review-card");
      expect(await cards.count()).toBeGreaterThan(1);
      const keep = (i: number) => cards.nth(i).getByRole("button", { name: "Keep", exact: true });
      await expect(keep(0)).toHaveClass(/btn--primary/);
      await expect(keep(1)).not.toHaveClass(/btn--primary/);
      await cards.first().getByRole("button", { name: "Throw away" }).click();
      await expect(keep(0)).toHaveClass(/btn--primary/);
    });

    test("a job that is gone offers a way back, not a Try again that cannot work", async ({ page }) => {
      await page.goto("/jobs/01JOBTHATDOESNOTEXIST00000");
      await expect(page.getByText("This job is gone")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await page.getByRole("link", { name: "See all jobs" }).click();
      await expect(page).toHaveURL(/\/jobs$/);
      await expect(page.locator(".job-row").first()).toBeVisible();
    });

    test("sign in: the password can be shown to check for typos", async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"));
      await page.goto("/");
      const field = page.getByLabel("Password");
      await field.fill("Temporary1!");
      await expect(field).toHaveAttribute("type", "password");
      const show = page.getByRole("button", { name: "Show" });
      const box = (await show.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(48);
      await show.click();
      await expect(field).toHaveAttribute("type", "text");
      await expect(page.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");

      await page.getByLabel("Email").fill("new@example.com");
      await page.getByRole("button", { name: "Sign in" }).click();
      const fresh = page.getByLabel("New password");
      await expect(fresh).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "Show" }).click();
      await expect(fresh).toHaveAttribute("type", "text");
    });

    test("the owner journey: link, live progress, Review with Undo, Library, Get the app, update Reload", async ({ page }) => {
      await page.goto("/");
      await settle(page);

      // Link → a job starts.
      await page.getByLabel("YouTube, Twitch or Kick link").fill("https://youtu.be/dQw4w9WgXcQ");
      await expect(page.getByText("YouTube video found.")).toBeVisible();
      await page.getByRole("button", { name: "Make clips" }).click();
      await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
      await expect(page.locator(".timeline__step")).toHaveCount(9);

      // Live progress on a running job.
      await nav(page).getByRole("link", { name: "Jobs", exact: true }).click();
      await page.locator(".job-row", { hasText: "Ranked grind" }).click();
      const pct = page.locator(".panel__pct");
      await expect(pct).toBeVisible();
      const before = await pct.innerText();
      await page.evaluate(() => (window as MockWindow).__cfMockLive!.advance());
      await expect(pct).not.toHaveText(before);

      // Review: Keep one, throw one away, Undo brings it back.
      await nav(page).getByRole("link", { name: /^Review/ }).click();
      await settle(page);
      const cards = page.locator(".review-card");
      const count = await cards.count();
      await cards.first().getByRole("button", { name: "Keep", exact: true }).click();
      await expect(cards).toHaveCount(count - 1);
      await cards.first().getByRole("button", { name: "Throw away" }).click();
      await expect(cards).toHaveCount(count - 2);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(cards).toHaveCount(count - 1);

      // Library.
      await nav(page).getByRole("link", { name: "Library", exact: true }).click();
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("how it did");

      // Get the app, with a new version waiting: Reload runs and reloads the page.
      await page.goto("/get-app?update=1");
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Get the");
      const bar = page.getByRole("region", { name: "New version" });
      await expect(bar).toBeVisible();
      const reloaded = page.waitForEvent("load", { timeout: 12_000 });
      await bar.getByRole("button", { name: "Reload" }).click();
      await reloaded;
      await settle(page);
      await expect(bar).toBeHidden();
    });
  });
}

test.describe("big fields on phones", () => {
  test.use(PHONE);
  test("text fields and the password button are at least 48px tall", async ({ page }) => {
    const small: string[] = [];
    await page.goto("/");
    await settle(page);
    for (const el of await page.locator("main input:not([type=radio]):not([type=checkbox]):not([type=file]), main textarea").filter({ visible: true }).all()) {
      const box = (await el.boundingBox())!;
      if (box.height < 47.5) small.push(`${await el.getAttribute("aria-label") ?? await el.getAttribute("id")}: ${Math.round(box.height)}px`);
    }
    expect(small, small.join("\n")).toEqual([]);
  });
});
