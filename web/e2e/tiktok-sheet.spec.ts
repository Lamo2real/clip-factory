import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// The Post to TikTok sheet (docs/CONTRACTS.md §17.8): with TikTok connected, Keep first asks who can see the post.

type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { failTikTok(): { clipId: string; postId: string; hook: string }; options(postId: string): { privacyLevel: string } | null };
  };
  __cfMockCalls?: Record<string, number>;
};

async function connectTikTok(page: Page, audited: boolean) {
  await page.goto("/");
  await settle(page);
  await page.evaluate((a) => {
    const s = (window as MockWindow).__cfMock!.setup;
    s.finish("tiktok");
    s.setAudit(a);
  }, audited);
}

for (const size of [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
]) {
  test.describe(`at ${size.width}px`, () => {
    test.use({ viewport: size });

    test("Keep stays off until a privacy is picked; branded content hides Only me", async ({ page }) => {
      await connectTikTok(page, true);
      await page.goto("/review");
      await settle(page);
      const card = page.locator(".review-card").first();
      await card.getByRole("button", { name: "Keep", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Posting as")).toContainText("Clip Factory");
      const keep = sheet.getByRole("button", { name: "Keep", exact: true });
      const privacy = sheet.getByLabel("Who can see it");
      // No default.
      await expect(privacy).toHaveValue("");
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await expect(sheet.getByText("Pick who can see it to turn on Keep.")).toBeVisible();
      // Comments, Duet and Stitch start off; Stitch is switched off in the creator's TikTok settings.
      await expect(sheet.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "false");
      await expect(sheet.getByRole("switch", { name: "Stitch" })).toHaveAttribute("aria-disabled", "true");

      await privacy.selectOption({ label: "Only me" });
      await expect(keep).not.toHaveAttribute("aria-disabled", "true");

      // Commercial content needs whose: Branded content, which cannot be Only me.
      await sheet.getByRole("switch", { name: "Commercial content" }).click();
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await sheet.getByRole("checkbox", { name: /^Branded content/ }).check();
      await expect(privacy.locator("option", { hasText: "Only me" })).toHaveCount(0);
      await expect(privacy).toHaveValue("");
      await expect(sheet).toContainText("By posting, you agree to TikTok's Music Usage Confirmation and Branded Content Policy.");
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await privacy.selectOption({ label: "Everyone" });
      await expect(keep).not.toHaveAttribute("aria-disabled", "true");

      await keep.click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText("TikTok can take a few minutes to process your clip.")).toBeVisible();
      await expect(page.getByText(/^Kept! Posting to 1 platform\./)).toBeVisible();
    });

    test("before TikTok's audit only Only me is offered, and Not now closes the sheet", async ({ page }) => {
      await connectTikTok(page, false);
      await page.goto("/review");
      await settle(page);
      await page.locator(".review-card").first().getByRole("button", { name: "Keep", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
      await expect(sheet.getByText("TikTok only allows Only me until it checks the app.")).toBeVisible();
      await expect(sheet.getByLabel("Who can see it").locator("option:not([disabled])")).toHaveText(["Only me"]);
      await sheet.getByRole("button", { name: "Not now" }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator(".review-card").first()).toBeVisible();
    });
  });
}

test("without TikTok connected, Keep keeps straight away (no sheet)", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  await page.locator(".review-card").first().getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByText(/Kept! It posts as soon as your accounts are connected/)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Post to TikTok" })).toHaveCount(0);
});

test("library: Try again on a failed clip whose TikTok post needs new choices opens the sheet first", async ({ page }) => {
  await connectTikTok(page, true);
  await page.goto("/library");
  await settle(page);
  const { clipId, postId } = await page.evaluate(() => (window as MockWindow).__cfMock!.posting.failTikTok());
  const card = page.locator(`.lib-card[aria-labelledby="lib-${clipId}"]`);
  await expect(card.getByText("Pick who can see it on TikTok again, then press Try again.")).toBeVisible();
  await expect(card.getByText("Posting did not work. Tap Try again.")).toBeVisible();

  await card.getByRole("button", { name: "Try again" }).click();
  const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
  await expect(sheet).toBeVisible();
  const again = sheet.getByRole("button", { name: "Try again" });
  await expect(again).toHaveAttribute("aria-disabled", "true");
  await sheet.getByLabel("Who can see it").selectOption({ label: "Friends" });
  await again.click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Trying again! Posting now.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Try again" })).toHaveCount(0);
  // The new choices went with the confirm and replaced the TikTok post's options.
  const stored = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.options(id), postId);
  expect(stored).toMatchObject({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS" });
});
