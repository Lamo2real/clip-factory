import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Upload to many places (docs/CONTRACTS.md §33): only places that are set up get a chip, any number can be on, all
// ready ones start on, Upload posts to exactly the chosen ones, each place keeps its own caption and limit, results
// show per place with their own Try again, and "Use my settings" / More details carry the owner's preset.

type Post = { postId: string; platform: string; status: string; error?: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: {
      posts(clipId: string): Post[];
      options(postId: string): Record<string, unknown> | null;
      settleWithOneFailed(clipId: string, platform: string, reason?: string): void;
    };
  };
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
    await expect(card.locator(".upload-going")).toHaveText("Going to: YouTube · TikTok · Instagram · Facebook");
    // X is not a caption tab either, and no tab writes "X X".
    await expect(card.getByRole("tab")).toHaveCount(4);
    await expect(card.getByRole("tab", { name: "X" })).toHaveCount(0);
    await expect(card.locator(".upload-to")).not.toContainText("X X");
    await expect(card.locator(".captions")).not.toContainText("X X");
  });

  test("pick several: chips toggle, tabs follow, the label counts, nothing picked turns Upload off", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const chip = (name: string) => card.locator(".upload-chip", { hasText: name });
    await chip("TikTok").click();
    await chip("Facebook").click();
    await expect(chip("TikTok")).toHaveAttribute("aria-pressed", "false");
    await expect(card.getByRole("tab")).toHaveCount(2);
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
    await card.getByRole("tab", { name: "Instagram" }).click();
    await card.getByLabel("Instagram caption").fill("i".repeat(2300));
    await expect(card.locator(".counter.is-over")).toContainText("2300 / 2200");
    await card.getByRole("tab", { name: "TikTok" }).click();
    await expect(card.getByLabel("TikTok caption")).not.toHaveValue("i".repeat(2300));
    // Turn Instagram off: its tab goes, the text stays for later, and Upload is not blocked by it.
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await expect(card.getByRole("tab", { name: /Instagram/ })).toHaveCount(0);
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(page.getByText(/longer than its platform allows/)).toHaveCount(0);
    await expect(page.getByText("Uploading to 2 places!")).toBeVisible();
  });

  test("Upload posts to exactly the chosen places, with My settings, and results show per place", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
    await card.locator(".upload-chip", { hasText: "TikTok" }).click();
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    // More details: YouTube's choices, never made for kids.
    await card.getByText("More details").click();
    await expect(card.getByText("Made for kids: No. Clip Factory never marks a clip as made for kids.")).toBeVisible();
    await card.getByRole("switch", { name: "Tell my subscribers" }).click();
    await card.getByRole("button", { name: UPLOAD }).click();
    await expect(page.getByText("Uploading to 2 places!")).toBeVisible();

    const posts = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.posts(id), clipId);
    expect(posts.map((p) => p.platform).sort()).toEqual(["facebook", "youtube"]);
    const yt = posts.find((p) => p.platform === "youtube")!;
    const options = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.options(id), yt.postId);
    expect(options).toMatchObject({ privacy: "public", category: "20", notifySubscribers: false });
    expect(options).not.toHaveProperty("madeForKids");

    // One place did not work: its row says so with the reason and its own Try again; the other is up.
    await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.settleWithOneFailed(id, "facebook", "Facebook said no this time."), clipId);
    // In-app navigation: a reload would start the in-memory mock over.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
    await settle(page);
    const lib = page.locator(`.lib-card[aria-labelledby="lib-${clipId}"]`);
    await expect(lib.getByText("Uploaded", { exact: true })).toBeVisible();
    await expect(lib.getByText("Didn't work. Facebook said no this time.")).toBeVisible();
    await lib.getByRole("button", { name: "Try Facebook again" }).click();
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

  test("Use my settings fills TikTok's sheet with the owner's own tap; the sheet still shows every TikTok choice", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(page.getByText(/Your settings are on for YouTube, TikTok, Instagram and Facebook\./)).toBeVisible();
    await card.getByRole("button", { name: UPLOAD }).click();
    const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
    await expect(sheet.getByRole("button", { name: /^Who can see it/ })).toContainText("Everyone");
    for (const name of ["Comments", "Duet", "Stitch", "Commercial content"]) await expect(sheet.getByRole("switch", { name })).toBeVisible();
    await expect(sheet.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByRole("switch", { name: "Commercial content" })).toHaveAttribute("aria-checked", "false");
    await sheet.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText("Uploading to 4 places!")).toBeVisible();
    await expect(page.getByText("TikTok can take a few minutes to process your clip.")).toBeVisible();
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

test("Settings › Posting › My settings: one section per place, X included, never made for kids", async ({ page }) => {
  await page.goto("/settings/posting/my-settings");
  await settle(page);
  for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Made for kids: No, always. Clip Factory never marks a clip as made for kids.")).toBeVisible();
  await expect(page.getByText("Tip: swearing in the first seconds or in the title can limit ads on YouTube.")).toBeVisible();
  await expect(page.getByText(/Whether a clip earns money is up to each app/)).toBeVisible();
  await page.getByRole("button", { name: /^Who can reply/ }).click();
  await page.getByRole("option", { name: "People you follow" }).click();
  await expect(page.getByRole("button", { name: /^Who can reply/ })).toContainText("People you follow");
});
