import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Home, Jobs, the job page and the app shell: fixes from the UI audit (web/screenshots/AUDIT-REPORT.md, group
// "shell"). Each test names its finding.

type Faults = { jobsPageSize?: number; olderJobsFails?: number; createJobFails?: number };
type FaultWindow = Window & { __cfMockFaults?: Faults };

async function setFaults(page: Page, faults: Faults) {
  await page.evaluate((f) => Object.assign((window as FaultWindow).__cfMockFaults!, f), faults);
}

async function openJob(page: Page, title: string) {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: title }).click();
  await settle(page);
}

test.describe("job page", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("F009: a pending Stop survives leaving the page, and ends with one 'Job stopped.' and no error", async ({ page }) => {
    await openJob(page, "Ranked grind");
    await page.getByRole("button", { name: "Stop job" }).click();
    await expect(page.getByText("Stopping in a few seconds.")).toBeVisible();
    await page.locator(".sidebar__item[href='/']").click();
    await settle(page);
    await page.goBack();
    await expect(page.getByText("Stopping in a few seconds.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop job" })).toHaveCount(0);
    await expect(page.getByText("Job stopped.")).toBeVisible({ timeout: 12_000 });
    await expect(page.locator(".page-head__meta .pill")).toHaveText(/Canceled/);
    await expect(page.locator(".toast--error")).toHaveCount(0);
  });

  test("F023: uploading tiles open the clip's page and a thrown-away tile is not a link", async ({ page }) => {
    await openJob(page, "Heist night");
    const kept = page.locator("a.clip-tile", { hasText: "Uploading" }).first();
    await expect(kept).toHaveAttribute("href", /^\/clips\/[0-9A-Z]{26}$/);
    const thrown = page.locator(".clip-tile", { hasText: "Thrown away" }).first();
    await expect(thrown).toHaveJSProperty("tagName", "DIV");
    // Not a link, so it does not lift like one on hover.
    await thrown.hover();
    await expect(thrown).toHaveCSS("transform", "none");
    await expect(page.locator("a.clip-tile[href='/library']")).toHaveCount(0);
  });

  test("F088: a failed job's empty Clips line points at the fix, not back Home", async ({ page }) => {
    await openJob(page, "Charity marathon");
    const section = page.locator(".clips-section");
    await expect(section).toContainText("Fix the problem above, then tap Try again.");
    await expect(section).not.toContainText("Go back to Home");
  });

  test("F061: a missing job still has a page heading", async ({ page }) => {
    await page.goto("/jobs/NOPE");
    await settle(page);
    await expect(page.locator("h1")).toHaveText("This job is gone");
    // The clip page's own early returns have one too.
    await page.goto("/clips/NOPE");
    await settle(page);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).not.toBeEmpty();
  });

  test("F064: the clip range never breaks after its dash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openJob(page, "Ranked grind");
    const range = page.locator(".page-head__lede .nowrap");
    await expect(range).toHaveText(/^\d+–\d+ clips$/);
    expect(await range.evaluate((el) => el.getClientRects().length)).toBe(1);
  });
});

test.describe("jobs list", () => {
  test("F078: Show older jobs appends a page, hides at the end, and shakes when a page fails", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await settle(page);
    // Set the knobs, then move in-app so the mock (and its knobs) stay.
    await setFaults(page, { jobsPageSize: 3, olderJobsFails: 1 });
    await page.locator(".sidebar__item[href='/jobs']").click();
    await settle(page);
    const rows = page.locator(".job-list .job-row");
    const older = page.getByRole("button", { name: "Show older jobs" });
    await expect(rows).toHaveCount(3);

    await older.click();
    await expect(older.locator(".act")).toHaveClass(/is-fail/);
    await expect(page.locator(".toast--error")).toBeVisible();
    await expect(rows).toHaveCount(3);

    await older.click();
    await expect(rows).toHaveCount(6);
    await older.click();
    await expect(rows).toHaveCount(7);
    await expect(older).toHaveCount(0);
  });

  test("F027: on a phone each row's 'when' shows and a failed job's whole fix shows", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/jobs");
    await settle(page);
    for (const when of await page.locator(".job-row__when").all()) {
      const fits = await when.evaluate((el) => {
        const row = el.closest(".job-row__meta")!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right <= row.right + 1;
      });
      expect(fits).toBe(true);
    }
    const error = page.locator(".job-row__error").first();
    await expect(error).toContainText("Add your YouTube cookies in Settings");
    expect(await error.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  });

  test("F087: the failed job's pill says Didn't work, never Failed", async ({ page }) => {
    await page.goto("/jobs");
    await settle(page);
    await expect(page.locator(".job-row .pill", { hasText: "Didn't work" })).toHaveCount(1);
    await expect(page.locator(".job-row .pill", { hasText: /^Failed$/ })).toHaveCount(0);
  });
});

test.describe("Home", () => {
  test("F079: a Make clips that fails shakes, says what to do, and keeps the link", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await settle(page);
    await setFaults(page, { createJobFails: 1 });
    const link = page.getByLabel("YouTube, Twitch or Kick link");
    await link.fill("https://youtu.be/dQw4w9WgXcQ");
    const make = page.getByRole("button", { name: "Make clips" });
    await make.click();
    await expect(make.locator(".act")).toHaveClass(/is-fail/);
    await expect(page.locator(".toast--error")).toContainText("Try again");
    await expect(page).toHaveURL(/\/$/);
    await expect(link).toHaveValue("https://youtu.be/dQw4w9WgXcQ");
  });

  test("F087: the source switch says Pick a video", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expect(page.getByRole("radio", { name: "Pick a video" })).toHaveCount(1);
    await expect(page.getByText("Upload a video")).toHaveCount(0);
  });

  test("F020: at 320 px both switches keep their two options side by side", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/");
    await settle(page);
    for (const group of await page.locator(".newjob .segmented").all()) {
      const tops = await group.locator(".segmented__opt").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
    }
  });

  test("F033: at 1024 px the review teasers leave no empty column", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 812 });
    await page.goto("/");
    await settle(page);
    const cols = await page.locator(".home-row__cards").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(cols).toBe(3);
  });

  test("F032: text links are at least 44 px tall on tablets and desktops", async ({ page }) => {
    for (const width of [768, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await settle(page);
      const box = await page.locator(".working .text-link").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("F068: the tab bar's count badge uses the smallest type size, not smaller", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await settle(page);
    const size = await page.locator(".badge").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(12.4);
  });
});

test.describe("app shell", () => {
  test("F011: a malformed #hash does not blank the app", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const url of ["/jobs#100%", "/settings#%E0%A4%A"]) {
      await page.goto(url);
      await settle(page);
      await expect(page.locator("main h1").first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("F019: a keyboard route change draws no ring around the whole page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/jobs");
    await settle(page);
    await page.locator(".job-row").first().focus();
    await page.keyboard.press("Enter");
    await settle(page);
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      // The keyboard route change must really put the page in :focus-visible, or this test proves nothing.
      return { tag: el.tagName, focusVisible: el.matches(":focus-visible"), outline: s.outlineStyle, shadow: s.boxShadow };
    });
    expect(ring).toEqual({ tag: "MAIN", focusVisible: true, outline: "none", shadow: "none" });
  });

  test("a route change hands focus to main and the Skip to content link stays out of sight until tabbed to", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");
    await settle(page);
    await page.locator(".tabbar a[href=\"/jobs\"]").click();
    await settle(page);
    const skip = page.locator(".skip-link");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    expect((await skip.boundingBox())!.y + (await skip.boundingBox())!.height).toBeLessThanOrEqual(0);
    await page.goto("/");
    await settle(page);
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    // It slides down (transition on top), so wait for it to land in view.
    await expect.poll(async () => (await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  });
});
