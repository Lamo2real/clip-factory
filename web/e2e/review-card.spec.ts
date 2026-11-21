import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// The simple Review card (docs/CONTRACTS.md §36), the owner's ask: "select all of them, click one button, upload",
// plus one button for his settings and each platform's own options in its own row. A standard upload is two taps:
// Use my settings, then Upload to 4. There is one place picker only (the Upload to chips), and the round Ask button
// never covers Upload.

type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: {
      posts(clipId: string): { postId: string; platform: string; status: string }[];
      options(postId: string): Record<string, unknown> | null;
      clipOptions(postId: string): Record<string, unknown> | null;
    };
  };
};

/** YouTube, TikTok, Instagram and Facebook set up and TikTok audited; X not started (the owner's setup). */
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

test.describe("the simple Review card", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a standard upload is two taps: Use my settings, then Upload to 4", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
    const upload = card.getByRole("button", { name: UPLOAD });
    await expect(upload).toHaveText("Upload to 4");
    // TikTok needs the owner's own tap: Upload waits, and says why in plain words.
    await expect(upload).toHaveAttribute("aria-disabled", "true");
    await expect(card.locator(".upload-going")).toHaveText("Tap Use my settings first. TikTok needs your tap.");
    await expect(card.getByText("Your other places already use your settings. TikTok needs your tap each time.")).toBeVisible();

    // Tap 1.
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.getByRole("button", { name: "Your settings are on" })).toBeVisible();
    await expect(card.locator('[data-place="tiktok"] summary')).toContainText("Who can see it: Everyone · Comments on · Duet on · Stitch off");
    await expect(card.locator(".upload-going")).toHaveText("Going to: YouTube · TikTok · Instagram · Facebook");
    await expect(card.locator(".tt-legal")).toContainText("Music Usage Confirmation");
    // Tap 2: no sheet pops up, it just uploads.
    await upload.click();
    await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);
    await expect(page.getByText("Uploading to 4 places!")).toBeVisible();

    // What went to the server: the owner's settings for each place, never made for kids, Commercial content off.
    const sent = await page.evaluate((id) => {
      const m = (window as MockWindow).__cfMock!.posting;
      return Object.fromEntries(m.posts(id).map((p) => [p.platform, p.platform === "tiktok" ? m.options(p.postId) : m.clipOptions(p.postId)]));
    }, clipId);
    expect(Object.keys(sent).sort()).toEqual(["facebook", "instagram", "tiktok", "youtube"]);
    expect(sent.tiktok).toEqual({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: true, brandContent: false, brandOrganic: false });
    expect(sent.youtube).toEqual({ privacy: "public", category: "20", madeForKids: false, notifySubscribers: true, embeddable: true });
    expect(sent.instagram).toEqual({ shareToFeed: true });
    expect(sent.facebook).toBeNull();
  });

  test("one place picker only: no caption tab bar, one closed row per ticked place", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await expect(card.getByRole("tab")).toHaveCount(0);
    await expect(card.getByRole("tablist")).toHaveCount(0);
    await expect(card.locator(".upload-chip")).toHaveCount(4);
    const rows = card.locator(".place-row");
    await expect(rows.locator(".place-row__title")).toHaveText([
      "YouTube · title, description and settings",
      "TikTok · caption and settings",
      "Instagram · caption and settings",
      "Facebook · caption and settings",
    ]);
    for (const row of await rows.all()) await expect(row).not.toHaveAttribute("open", "");
    // Unticking a place takes its row away; ticking it brings it back.
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    await expect(rows).toHaveCount(3);
    await card.locator(".upload-chip", { hasText: "Instagram" }).click();
    await expect(rows).toHaveCount(4);
  });

  test("each row opens its own words and every option", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    const yt = card.locator('[data-place="youtube"]');
    await yt.locator("summary").click();
    await expect(yt.getByLabel("Title")).toBeVisible();
    await expect(yt.getByLabel("Description")).toBeVisible();
    await expect(yt.getByRole("radiogroup", { name: "Who can see it on YouTube" }).getByRole("radio", { checked: true })).toHaveAccessibleName("Everyone");
    await expect(yt.getByRole("switch", { name: "Made for kids" })).toHaveAttribute("aria-checked", "false");
    await expect(yt.locator(".dropdown__button")).toHaveText("Gaming");
    // A change for this clip only: the summary says it, and the button offers the owner's settings back.
    await yt.getByRole("radiogroup", { name: "Who can see it on YouTube" }).getByRole("radio", { name: "Link only" }).check();
    await expect(yt.locator("summary")).toContainText("Who can see it: Link only");
    await expect(card.getByText("You changed some for this clip. Tap to put yours back.")).toBeVisible();

    const tt = card.locator('[data-place="tiktok"]');
    await tt.locator("summary").click();
    await expect(tt.getByLabel("TikTok caption")).toBeVisible();
    for (const name of ["Comments", "Duet", "Stitch", "Commercial content"]) await expect(tt.getByRole("switch", { name })).toBeVisible();

    const ig = card.locator('[data-place="instagram"]');
    await ig.locator("summary").click();
    await expect(ig.getByLabel("Instagram caption")).toBeVisible();
    await expect(ig.getByRole("switch", { name: "Also show it in my feed" })).toHaveAttribute("aria-checked", "true");

    const fb = card.locator('[data-place="facebook"]');
    await fb.locator("summary").click();
    await expect(fb.getByLabel("Facebook caption")).toBeVisible();
    await expect(fb).toContainText("Everyone can see it.");
  });

  test("a paid partnership is one tick in the TikTok row and keeps the settings on", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    const tt = card.locator('[data-place="tiktok"]');
    await tt.locator("summary").click();
    await tt.getByRole("switch", { name: "Commercial content" }).click();
    await expect(card.getByRole("button", { name: UPLOAD })).toHaveAttribute("aria-disabled", "true");
    await tt.getByRole("checkbox", { name: /^Branded content/ }).check();
    await expect(card.getByRole("button", { name: "Your settings are on" })).toBeVisible();
    await expect(card.locator(".tt-legal")).toContainText("Branded Content Policy");
    await expect(card.getByRole("button", { name: UPLOAD })).not.toHaveAttribute("aria-disabled", "true");
  });

  test("putting his settings back keeps a paid partnership ticked on this clip", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    const tt = card.locator('[data-place="tiktok"]');
    await tt.locator("summary").click();
    await tt.getByRole("switch", { name: "Commercial content" }).click();
    await tt.getByRole("checkbox", { name: /^Branded content/ }).check();
    const yt = card.locator('[data-place="youtube"]');
    await yt.locator("summary").click();
    await yt.getByRole("radiogroup", { name: "Who can see it on YouTube" }).getByRole("radio", { name: "Link only" }).check();
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(tt.getByRole("checkbox", { name: /^Branded content/ })).toBeChecked();
    await expect(tt.locator("summary")).toContainText("Paid partnership");
    await expect(card.locator(".tt-legal")).toContainText("Branded Content Policy");
    await expect(card.getByRole("button", { name: UPLOAD })).not.toHaveAttribute("aria-disabled", "true");
  });

  test("the closed TikTok row names the account he posts as", async ({ page }) => {
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.locator('[data-place="tiktok"] summary')).toContainText("Posting as ");
  });

  test("My settings are saved in Settings › Posting and Use my settings puts them on", async ({ page }) => {
    await fourReady(page);
    await page.goto("/settings/posting/my-settings");
    await settle(page);
    for (const id of ["youtube", "tiktok", "instagram", "facebook", "x"]) await expect(page.locator(`#my-settings-${id}`)).toBeVisible();
    await expect(page.getByText("Made for kids: No. My settings never mark a clip as made for kids.")).toBeVisible();
    await page.locator("#my-settings-tiktok").getByRole("switch", { name: "Duet" }).click();
    await expect(page.locator("#my-settings-tiktok").getByRole("switch", { name: "Duet" })).toHaveAttribute("aria-checked", "false");
    // In-app navigation: a reload would start the in-memory mock over.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).click();
    await settle(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.locator('[data-place="tiktok"] summary')).toContainText("Duet off");
  });
});

test("on a phone, tapping the held Upload takes him to Use my settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fourReady(page);
  const card = page.locator(".review-card").first();
  const upload = card.getByRole("button", { name: UPLOAD });
  await upload.scrollIntoViewIfNeeded();
  await expect(upload).toHaveAttribute("aria-disabled", "true");
  await upload.click({ force: true });
  const mine = card.getByRole("button", { name: "Use my settings" });
  await expect(mine).toBeFocused();
  await expect(mine).toBeInViewport();
  await expect(page.getByText("Uploading to 4 places!")).toHaveCount(0);
});

// The owner's screenshot: the round Ask button sat over the right end of "Upload to 4".
for (const size of [
  { width: 1000, height: 650 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Ask never covers Upload at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await fourReady(page);
    const card = page.locator(".review-card").first();
    await card.getByRole("button", { name: "Use my settings" }).click();
    await expect(card.locator('[data-place="tiktok"] summary')).toContainText("Who can see it: Everyone");
    const upload = card.getByRole("button", { name: UPLOAD });
    await expect(upload).not.toHaveAttribute("aria-disabled", "true");
    // The worst spot: Upload level with the launcher (bottoms lined up, so Upload stays above a phone's tab bar).
    await page.evaluate(() => {
      const u = document.querySelector(".review-card .review-card__actions button:last-child")!.getBoundingClientRect();
      const l = document.querySelector(".help-launcher")!.getBoundingClientRect();
      window.scrollBy(0, u.bottom - l.bottom);
    });
    const covered = async () =>
      page.evaluate(() => {
        const u = document.querySelector(".review-card .review-card__actions button:last-child")!.getBoundingClientRect();
        const el = document.querySelector<HTMLElement>(".help-launcher")!;
        const l = el.getBoundingClientRect();
        const touches = !(l.right <= u.left || l.left >= u.right || l.bottom <= u.top || l.top >= u.bottom);
        const shown = getComputedStyle(el).pointerEvents !== "none" && !el.classList.contains("is-hidden");
        return touches && shown;
      });
    await expect.poll(covered, { timeout: 5000 }).toBe(false);
    // Upload itself takes the tap at its right end, where the launcher sat.
    const box = (await upload.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x!, y!);
      return el?.closest(".review-card__actions") ? "upload" : `${el?.tagName}.${el?.className}`;
    }, [box.x + box.width - 8, box.y + box.height / 2]);
    expect(hit).toBe("upload");
  });
}

test("a campaign clip (§38.5): the strip, only the paid places, YouTube locked public and never for kids, paid partnership on", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("cf-mock-cr-review")) sessionStorage.setItem("cf-mock-cr-review", "1");
  });
  await fourReady(page);
  const card = page.locator(".review-card").filter({ has: page.locator("[data-help='cr-review-strip']") });
  await expect(card.locator(".cr-strip")).toContainText("For FaZe Clips · Content Rewards");
  // FaZe Clips pays for YouTube and Instagram: TikTok and Facebook are set up but get no chip.
  await expect(card.locator(".upload-chip")).toHaveCount(2);
  await expect(card.locator(".upload-chip[aria-pressed='true']")).toHaveCount(2);
  await expect(card.locator("[data-place='youtube'] .place-row__now")).toHaveText("Who can see it: Everyone · Made for kids: No · Paid promotion");
  await card.locator("[data-place='instagram'] summary").click();
  await expect(card.locator("[data-place='instagram']")).toContainText("Instagram doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers.");
  await card.getByRole("button", { name: "Upload to 2" }).click();
  await expect(page.getByText("Uploading to 2 places!")).toBeVisible();
});
