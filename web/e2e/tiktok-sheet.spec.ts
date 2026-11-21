import { expect, test, type Locator, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// TikTok's choices (docs/CONTRACTS.md §17.8, §36, TikTok's Content Sharing Guidelines). On the Review card they live
// in the TikTok row: who can see it is the app's own dropdown with nothing picked until the owner picks or taps Use my
// settings; Comments, Duet and Stitch show and start off; Commercial content needs Your brand or Branded content. The
// Post to TikTok sheet only opens where there is no row: Try again in the Library when TikTok wants a new pick.

/** The "Who can see it" dropdown inside `scope`. */
const dropdown = (scope: Locator) => scope.locator(".dropdown__button").first();

/** The names in the open dropdown list. */
async function choices(scope: Locator): Promise<string[]> {
  await dropdown(scope).click();
  const names = await scope.getByRole("option").locator(".dropdown__name").allInnerTexts();
  await dropdown(scope).click();
  return names;
}

/** Picks a "Who can see it" choice. */
async function pick(scope: Locator, name: string) {
  await dropdown(scope).click();
  await scope.getByRole("option", { name, exact: true }).click();
}

type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: {
      failTikTok(): { clipId: string; postId: string; hook: string };
      options(postId: string): { privacyLevel: string } | null;
      posts(clipId: string): { postId: string; platform: string }[];
    };
  };
  __cfMockFaults?: { keepStopsAfterSave: number; resumeAfterMs: number };
};

async function connectTikTok(page: Page, audited: boolean) {
  await page.goto("/");
  await settle(page);
  await page.evaluate((a) => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    s.finish("tiktok");
    s.setAudit(a);
  }, audited);
}

const UPLOAD = /^Upload( to .+)?$/;

for (const size of [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
]) {
  test.describe(`at ${size.width}px`, () => {
    test.use({ viewport: size });

    test("the TikTok row: nothing picked, Upload off until the owner picks; branded content greys Only me and Followers", async ({ page }) => {
      await connectTikTok(page, true);
      await page.goto("/review");
      await settle(page);
      const card = page.locator(".review-card").first();
      const upload = card.getByRole("button", { name: UPLOAD });
      await expect(upload).toHaveAttribute("aria-disabled", "true");
      await expect(card.locator(".upload-going")).toHaveText("Tap Use my settings first. TikTok needs your tap.");
      // The Music Usage Confirmation shows near Upload whenever TikTok is ticked.
      await expect(card.locator(".tt-legal")).toHaveText("By posting, you agree to TikTok's Music Usage Confirmation.");

      const row = card.locator('[data-place="tiktok"]');
      await row.locator("summary").click();
      await expect(row.getByText("Posting as")).toContainText("Clip Factory");
      // The app's own dropdown, never the OS list, with nothing picked; Everyone first, exactly TikTok's choices.
      await expect(row.locator("select")).toHaveCount(0);
      await expect(dropdown(row)).toHaveText("Pick who can see it");
      expect(await choices(row)).toEqual(["Everyone", "Followers", "Friends", "Only me"]);
      await expect(upload).toHaveAttribute("aria-disabled", "true");
      // Comments, Duet and Stitch start off; Stitch is switched off in the creator's TikTok settings.
      await expect(row.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "false");
      await expect(row.getByRole("switch", { name: "Duet" })).toHaveAttribute("aria-checked", "false");
      await expect(row.getByRole("switch", { name: "Stitch" })).toHaveAttribute("aria-disabled", "true");
      await expect(row.getByRole("switch", { name: "Commercial content" })).toHaveAttribute("aria-checked", "false");

      await pick(row, "Only me");
      await expect(dropdown(row)).toHaveText("Only me");
      await expect(upload).not.toHaveAttribute("aria-disabled", "true");

      // Commercial content needs whose: TikTok's own words show on Upload (hover) and under it (phones have no hover).
      const whose = "You need to indicate if your content promotes yourself, a third party, or both.";
      await row.getByRole("switch", { name: "Commercial content" }).click();
      await expect(upload).toHaveAttribute("aria-disabled", "true");
      await expect(upload).toHaveAttribute("title", whose);
      await expect(card.locator(".upload-going")).toHaveText(`${whose} Pick Your brand or Branded content on TikTok first.`);
      // Your brand: the video is labeled Promotional content.
      await row.getByRole("checkbox", { name: /^Your brand/ }).check();
      await expect(row.getByText("Your video will be labeled as 'Promotional content'.")).toBeVisible();
      await expect(upload).not.toHaveAttribute("title", whose);
      await row.getByRole("checkbox", { name: /^Your brand/ }).uncheck();
      // Only me was picked first: Branded content (paid partnership) is greyed and says what to do; Only me stays picked.
      const branded = row.getByRole("checkbox", { name: /^Branded content/ });
      await expect(branded).toBeDisabled();
      await expect(row.getByText("Branded content can't be Only me. Pick Everyone or Friends first.")).toBeVisible();
      await expect(dropdown(row)).toHaveText("Only me");
      await pick(row, "Everyone");
      await branded.check();
      await expect(row.getByText("Your video will be labeled as 'Paid partnership'.")).toBeVisible();
      // Branded content ticked: Only me and Followers show greyed with TikTok's line.
      await dropdown(row).click();
      for (const name of ["Followers", "Only me"]) await expect(row.getByRole("option", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-disabled", "true");
      for (const name of ["Everyone", "Friends"]) await expect(row.getByRole("option", { name: new RegExp(`^${name}`) })).not.toHaveAttribute("aria-disabled", "true");
      await expect(row.getByRole("option", { name: /^Only me/ })).toContainText("Branded content visibility cannot be set to private.");
      await dropdown(row).click();
      await expect(card.locator(".tt-legal")).toHaveText("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
      await expect(upload).not.toHaveAttribute("aria-disabled", "true");
      await upload.click();
      await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);
      await expect(page.getByText("TikTok can take a few minutes to process your clip.")).toBeVisible();
      await expect(page.getByText(/^Uploading to TikTok!/)).toBeVisible();
    });

    test("before TikTok's audit only Only me is offered, with the plain line; Use my settings picks it", async ({ page }) => {
      await connectTikTok(page, false);
      await page.goto("/review");
      await settle(page);
      const card = page.locator(".review-card").first();
      const row = card.locator('[data-place="tiktok"]');
      await row.locator("summary").click();
      await expect(row.getByText("TikTok keeps posts private until it approves your app.")).toBeVisible();
      expect(await choices(row)).toEqual(["Only me"]);
      // Still the owner's own tap: nothing picked yet.
      await expect(dropdown(row)).toHaveText("Pick who can see it");
      await card.getByRole("button", { name: "Use my settings" }).click();
      await expect(dropdown(row)).toHaveText("Only me");
      await expect(card.getByRole("button", { name: UPLOAD })).not.toHaveAttribute("aria-disabled", "true");
    });
  });
}

test("with nothing set up, Upload saves it straight away (no sheet, no Upload to chips)", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  await page.locator(".review-card").first().getByRole("button", { name: UPLOAD }).click();
  await expect(page.getByText(/Saved! It uploads as soon as your accounts are set up/)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);
});

test("library: Try again on a failed clip whose TikTok post needs new choices opens the sheet first", async ({ page }) => {
  await connectTikTok(page, true);
  await page.goto("/library");
  await settle(page);
  const { clipId, postId } = await page.evaluate(() => (window as MockWindow).__cfMock!.posting.failTikTok());
  const card = page.locator(`.lib-card[aria-labelledby="lib-${clipId}"]`);
  await expect(card.getByText("Pick who can see it on TikTok again, then press Try again.")).toBeVisible();
  await expect(card.getByText("Uploading did not work. Tap Try again.")).toBeVisible();

  const opener = card.getByRole("button", { name: "Try again", exact: true });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
  await expect(sheet).toBeVisible();
  const again = sheet.getByRole("button", { name: "Try again", exact: true });
  await expect(again).toHaveAttribute("aria-disabled", "true");
  await expect(dropdown(sheet)).toHaveText("Pick who can see it");
  await expect(sheet.getByText("Pick who can see it to turn on Try again.")).toBeVisible();
  for (const name of ["Comments", "Duet", "Commercial content"]) await expect(sheet.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
  await expect(sheet).toContainText("By posting, you agree to TikTok's Music Usage Confirmation.");

  // F002: drawn on body, the backdrop is the viewport and covers the nav.
  const box = await page.locator(".tt-sheet-backdrop").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const bottom = document.elementFromPoint(innerWidth / 2, innerHeight - 4);
    return { parent: el.parentElement?.tagName, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, covered: !!bottom?.closest(".tt-sheet-backdrop") };
  });
  expect(box).toMatchObject({ parent: "BODY", x: 0, y: 0, w: box.vw, h: box.vh, covered: true });
  // F030: Tab never leaves the sheet; Escape gives the focus back.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".tt-sheet"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await pick(sheet, "Friends");
  await again.click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Trying again! Uploading now.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  // The new choices went with the confirm and replaced the TikTok post's options.
  const stored = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.options(id), postId);
  expect(stored).toMatchObject({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS" });
});

test("review: an Upload that does not finish shakes Upload, then Try again uploads with the same TikTok choices (F080)", async ({ page }) => {
  await connectTikTok(page, true);
  await page.goto("/review");
  await settle(page);
  const cards = page.locator(".review-card");
  const before = await cards.count();
  await page.evaluate(() => {
    (window as MockWindow).__cfMockFaults!.keepStopsAfterSave = 1;
  });
  const card = cards.first();
  await card.getByRole("button", { name: "Use my settings" }).click();
  const upload = card.getByRole("button", { name: UPLOAD });
  await upload.click();

  // The failure shakes the card's Upload, shows the error toast and no celebration; the card stays with Try again.
  const again = card.getByRole("button", { name: "Try again", exact: true });
  await expect(again.locator(".act")).toHaveClass(/is-fail/);
  await expect(page.locator(".toast", { hasText: "cannot be reached" })).toBeVisible();
  await expect(page.locator("canvas.confetti")).toHaveCount(0);
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toHaveCount(0);
  await expect(card.getByText("Uploading this clip did not finish. Tap Try again.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);

  await page.evaluate(() => {
    (window as MockWindow).__cfMockFaults!.resumeAfterMs = 0;
  });
  await again.click();
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toBeVisible();
  await expect(cards).toHaveCount(before - 1);
});
