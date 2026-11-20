import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Upload to many places (docs/CONTRACTS.md §33, §36): only places that are set up get a chip, any number can be on,
// all ready ones start on, Upload posts to exactly the chosen ones, each place keeps its own caption and limit in its
// own row, results show per place with their own Try again. The chips are the only place picker on the card, and a
// failed setup check or a Try again never sends a clip to places nobody picked.

type Post = { postId: string; platform: string; status: string; error?: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: {
      posts(clipId: string): Post[];
      settleWithOneFailed(clipId: string, platform: string, reason?: string): void;
    };
  };
  __cfMockFaults?: { keepStopsAfterSave: number; setupFails?: number; resumeAfterMs?: number };
};

/** YouTube, TikTok, Instagram and Facebook set up; X not started (the owner's own setup, 2026-11-20). */
async function fourReady(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ["youtube", "tiktok", "instagram", "facebook"]) s.finish(p);
    s.setAudit(true);
  });
  await page.goto("/review");
  await settle(page);
}

const UPLOAD = /^Upload( to .+)?$/;

test.describe("Upload to many places", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("only places that are set up show, X is hidden with a quiet hint, all ready ones start on", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const chips = card.locator(".upload-chip");
    await expect(chips).toHaveCount(4);
    await expect(chips).toHaveText(["YouTube", "TikTok", "Instagram", "Facebook"]);
    for (const chip of await chips.all()) {
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(chip.locator(".upload-chip__check svg")).toHaveCount(1);
    }
    await expect(card.getByRole("link", { name: "Set up X to upload there too." })).toHaveAttribute("href", "/settings/posting/setup/x");
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveText("Upload to 4");
    // TikTok needs the owner's tap first (§36); then the line says where it goes.
    await expect(card.locator(".upload-going")).toHaveText("Tap Use my settings first. TikTok needs your tap.");
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.locator(".upload-going")).toHaveText("Going to: YouTube · TikTok · Instagram · Facebook");
    // One row per chosen place (§36), no caption tabs, no X row, and nothing writes "X X".
    await expect(card.getByRole("tab")).toHaveCount(0);
    await expect(card.locator(".place-row")).toHaveCount(4);
    await expect(card.locator('.place-row[data-place="x"]')).toHaveCount(0);
    await expect(card.locator(".upload-to")).not.toContainText("X X");
  });

  test("pick several: chips toggle, rows follow, the label counts, nothing picked turns Upload off", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const chip = (name: string) => card.locator(".upload-chip", { hasText: name });
    await chip("TikTok").click();
    await chip("Facebook").click();
    await expect(chip("TikTok")).toHaveAttribute("aria-pressed", "false");
    await expect(card.locator(".place-row")).toHaveCount(2);
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveText("Upload to 2");
    await chip("Instagram").click();
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveText("Upload to YouTube");
    await chip("YouTube").click();
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveAttribute("aria-disabled", "true");
    await expect(card.locator(".upload-going")).toHaveText("Pick at least one place.");
  });

  test("each place keeps its own caption and limit; a long caption only blocks when its place is on", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.locator('[data-place="instagram"] summary').click();
    await card.getByLabel("Instagram caption").fill("i".repeat(2300));
    await expect(card.locator(".counter.is-over")).toContainText("2300 / 2200");
    await card.locator('[data-place="tiktok"] summary').click();
    await expect(card.getByLabel("TikTok caption")).not.toHaveValue("i".repeat(2300));
    // Turn Instagram off: its row goes, the text stays for later, and Upload is not blocked by it.
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await expect(card.locator('[data-place="instagram"]')).toHaveCount(0);
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(page.getByText(/longer than its platform allows/)).toHaveCount(0);
    await expect(page.getByText("Uploading to 2 places!")).toBeVisible();
  });

  test("Upload posts to exactly the chosen places, and results show per place", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    // The chips are the only place picker: no tab bar, no OS list.
    await expect(card.getByRole("tab")).toHaveCount(0);
    await expect(card.locator("select")).toHaveCount(0);
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(page.getByText("Uploading to 2 places!")).toBeVisible();

    const posts = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.posts(id), clipId);
    expect(posts.map((p) => p.platform).sort()).toEqual(["facebook", "youtube"]);

    // One place did not work: its row says so with the reason and its own Try again; the other is up.
    await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.settleWithOneFailed(id, "facebook", "Facebook said no this time."), clipId);
    // In-app navigation: a reload would start the in-memory mock over.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
    await settle(page);
    const lib = page.locator(`.lib-card[aria-labelledby="lib-${clipId}"]`);
    await expect(lib.getByText("Uploaded", { exact: true })).toBeVisible();
    await expect(lib.getByText("Didn't work. Facebook said no this time.")).toBeVisible();
    await lib.getByRole("button", { name: "Try again, Facebook" }).click();
    await expect(page.getByText("Trying Facebook again!")).toBeVisible();
    const after = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.posts(id), clipId);
    expect(after.find((p) => p.platform === "youtube")!.status).toBe("posted");
    expect(after.find((p) => p.platform === "facebook")!.status).not.toBe("failed");
  });

  test("the last choice is remembered on this device, minus places no longer set up", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    for (const name of ["TikTok", "Instagram", "Facebook"]) await card.locator(".upload-chip", { hasText: name }).click();
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(page.getByText("Uploading to YouTube!")).toBeVisible();
    await page.reload();
    await settle(page);
    const next = page.locator(".review-card").first();
    await expect(next.locator('.upload-chip[aria-pressed="true"]')).toHaveText(["YouTube"]);
  });

  test("a setup check that fails leaves Upload off and sends nothing; Check again brings the chips back", async ({ page }) => {
    // The first setup checks fail (set before the app starts, so nothing is remembered from an earlier page).
    await page.addInitScript(() => {
      let faults: Record<string, unknown> | undefined;
      Object.defineProperty(window, "__cfMockFaults", {
        configurable: true,
        get: () => faults,
        set: (v: Record<string, unknown>) => {
          faults = v;
          v.setupFails = 5;
        },
      });
    });
    await page.goto("/review");
    await settle(page);
    const card = page.locator(".review-card").first();
    await expect(card.getByText("Could not check your places. Check again, then tap Upload.")).toBeVisible();
    await expect(card.getByText("Nothing is set up yet")).toHaveCount(0);
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveAttribute("aria-disabled", "true");
    // Check again while the server is still failing: still no guess.
    await card.getByRole("button", { name: "Check again" }).click();
    await expect(card.getByText("Could not check your places. Check again, then tap Upload.")).toBeVisible();
    // The server answers again: the places come back (live setup news or Check again).
    await page.evaluate(() => {
      const w = window as MockWindow;
      w.__cfMockFaults!.setupFails = 0;
      for (const p of ["youtube", "instagram"]) w.__cfMock!.setup.finish(p);
    });
    await expect(card.locator(".upload-chip")).toHaveCount(2);
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveText("Upload to 2");
  });

  test("Try again after a failed Upload still needs a place, and TikTok's own choices when TikTok is on", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await page.evaluate(() => ((window as MockWindow).__cfMockFaults!.keepStopsAfterSave = 1));
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(card.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    // All places off: Try again is off, it never falls back to Where clips go.
    for (const name of ["YouTube", "Instagram", "Facebook"]) await card.locator(".upload-chip", { hasText: name }).click();
    await expect(card.getByRole("button", { name: "Try again", exact: true })).toHaveAttribute("aria-disabled", "true");
    // TikTok turned on after the failure: Try again waits for TikTok's choices (Use my settings), never a sheet.
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await expect(card.getByRole("button", { name: "Try again", exact: true })).toHaveAttribute("aria-disabled", "true");
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.getByRole("button", { name: "Your settings are on" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Try again", exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await page.evaluate(() => ((window as MockWindow).__cfMockFaults!.resumeAfterMs = 0));
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);
  });

  test("the checks row never overlaps at 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await fourReady(page);
    const summary = page.locator(".review-card").first().locator(".checklist__summary");
    const [label, score] = await Promise.all([summary.locator("span").first().boundingBox(), summary.locator(".checklist__score").boundingBox()]);
    const overlap = label!.x < score!.x + score!.width && score!.x < label!.x + label!.width && label!.y < score!.y + score!.height && score!.y < label!.y + label!.height;
    expect(overlap).toBe(false);
  });
});
