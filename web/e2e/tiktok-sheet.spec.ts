import { expect, test, type Locator, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// The Post to TikTok sheet (docs/CONTRACTS.md §17.8, §33.5): with TikTok chosen, Upload first asks who can see the
// post, in the app's own dropdown (never the OS list) with no default: TikTok's Content Sharing Guidelines.

/** Picks a "Who can see it" choice in the sheet's dropdown. */
async function pick(sheet: Locator, name: string) {
  await sheet.getByRole("button", { name: /^Who can see it/ }).click();
  await sheet.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { failTikTok(): { clipId: string; postId: string; hook: string }; options(postId: string): { privacyLevel: string } | null };
  };
  __cfMockCalls?: Record<string, number>;
  __cfMockFaults?: { keepStopsAfterSave: number; resumeAfterMs: number };
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

    test("Upload stays off until a privacy is picked; branded content hides Only me", async ({ page }) => {
      await connectTikTok(page, true);
      await page.goto("/review");
      await settle(page);
      const card = page.locator(".review-card").first();
      await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
      const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Posting as")).toContainText("Clip Factory");
      const keep = sheet.getByRole("button", { name: "Upload", exact: true });
      const privacy = sheet.getByRole("button", { name: /^Who can see it/ });
      // The app's own dropdown, no OS list, and no default.
      await expect(sheet.locator("select")).toHaveCount(0);
      await expect(privacy).toHaveAttribute("aria-haspopup", "listbox");
      await expect(privacy).toContainText("Pick who can see it");
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await expect(sheet.getByText("Tap who can see it to turn on Upload.")).toBeVisible();
      // Everyone first, exactly TikTok's choices, nothing picked.
      await privacy.click();
      await expect(sheet.getByRole("option").locator(".dropdown__name")).toHaveText(["Everyone", "Followers", "Friends", "Only me"]);
      await expect(sheet.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeVisible();
      // Comments, Duet and Stitch start off; Stitch is switched off in the creator's TikTok settings.
      await expect(sheet.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "false");
      await expect(sheet.getByRole("switch", { name: "Stitch" })).toHaveAttribute("aria-disabled", "true");

      // Turn all on switches on Comments and Duet in one tap; Stitch stays off (TikTok turned it off) and each stays visible.
      await sheet.getByRole("button", { name: "Turn all on" }).click();
      await expect(sheet.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "true");
      await expect(sheet.getByRole("switch", { name: "Duet" })).toHaveAttribute("aria-checked", "true");
      await expect(sheet.getByRole("switch", { name: "Stitch" })).toHaveAttribute("aria-checked", "false");

      await pick(sheet, "Only me");
      await expect(privacy).toContainText("Only me");
      await expect(keep).not.toHaveAttribute("aria-disabled", "true");

      // Commercial content needs whose: Branded content, which cannot be Only me.
      await sheet.getByRole("switch", { name: "Commercial content" }).click();
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await sheet.getByRole("checkbox", { name: /^Branded content/ }).check();
      await expect(privacy).toContainText("Pick who can see it");
      await privacy.click();
      await expect(sheet.getByRole("option", { name: /^Only me/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toContainText("By posting, you agree to TikTok's Music Usage Confirmation and Branded Content Policy.");
      await expect(keep).toHaveAttribute("aria-disabled", "true");
      await pick(sheet, "Everyone");
      await expect(keep).not.toHaveAttribute("aria-disabled", "true");

      await keep.click();
      await expect(sheet).toHaveCount(0);
      await expect(page.getByText("TikTok can take a few minutes to process your clip.")).toBeVisible();
      await expect(page.getByText(/^Uploading to TikTok!/)).toBeVisible();
    });

    test("the sheet covers the whole screen, keeps typed letters and traps Tab; Escape gives the focus back to Upload", async ({ page }) => {
      await connectTikTok(page, true);
      await page.goto("/review");
      await settle(page);
      const keepOnCard = page.locator(".review-card").nth(1).getByRole("button", { name: /^Upload( to .+)?$/ });
      await keepOnCard.click();
      const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
      await expect(sheet.getByText("Posting as")).toBeVisible();

      // F002: drawn on body, the backdrop is the viewport, the title and Close are on screen, the nav is covered.
      const box = await page.locator(".tt-sheet-backdrop").evaluate((el) => {
        const r = el.getBoundingClientRect();
        const bottom = document.elementFromPoint(innerWidth / 2, innerHeight - 4);
        return { parent: el.parentElement?.tagName, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, covered: !!bottom?.closest(".tt-sheet-backdrop") };
      });
      expect(box).toMatchObject({ parent: "BODY", x: 0, y: 0, w: box.vw, h: box.vh, covered: true });
      const title = await sheet.getByRole("heading", { name: "Post to TikTok" }).boundingBox();
      expect(title!.y).toBeGreaterThanOrEqual(0);
      await expect(sheet.getByRole("button", { name: "Close" })).toBeInViewport();

      // F003: every typed letter stays, and the caret stays in the box.
      const caption = sheet.getByLabel("Caption");
      const before = await caption.inputValue();
      await caption.click();
      // The end of the whole caption, not of its first line (a long caption wraps in the box).
      await caption.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
      await caption.pressSequentially(" abc", { delay: 40 });
      await expect(caption).toHaveValue(`${before} abc`);
      await expect(caption).toBeFocused();

      // F030: Tab never leaves the sheet.
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement?.closest(".tt-sheet"))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(keepOnCard).toBeFocused();
    });

    test("before TikTok's audit only Only me is offered, and Not now closes the sheet", async ({ page }) => {
      await connectTikTok(page, false);
      await page.goto("/review");
      await settle(page);
      await page.locator(".review-card").first().getByRole("button", { name: /^Upload( to .+)?$/ }).click();
      const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
      await expect(sheet.getByText("TikTok keeps posts private until it approves your app.")).toBeVisible();
      await sheet.getByRole("button", { name: /^Who can see it/ }).click();
      await expect(sheet.getByRole("option").locator(".dropdown__name")).toHaveText(["Only me"]);
      await page.keyboard.press("Escape");
      await sheet.getByRole("button", { name: "Not now" }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator(".review-card").first()).toBeVisible();
    });
  });
}

test("with nothing set up, Upload saves it straight away (no sheet, no Upload to chips)", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  await page.locator(".review-card").first().getByRole("button", { name: /^Upload( to .+)?$/ }).click();
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

  await card.getByRole("button", { name: "Try again" }).click();
  const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
  await expect(sheet).toBeVisible();
  const again = sheet.getByRole("button", { name: "Try again" });
  await expect(again).toHaveAttribute("aria-disabled", "true");
  await pick(sheet, "Friends");
  await again.click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Trying again! Uploading now.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Try again" })).toHaveCount(0);
  // The new choices went with the confirm and replaced the TikTok post's options.
  const stored = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.options(id), postId);
  expect(stored).toMatchObject({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS" });
});

test("review: an Upload from the TikTok sheet that does not finish shakes the sheet's Upload, then Try again uploads it (F080)", async ({ page }) => {
  await connectTikTok(page, true);
  await page.goto("/review");
  await settle(page);
  const cards = page.locator(".review-card");
  const before = await cards.count();
  await page.evaluate(() => {
    (window as MockWindow).__cfMockFaults!.keepStopsAfterSave = 1;
  });
  const card = cards.first();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const sheet = page.getByRole("dialog", { name: "Post to TikTok" });
  await pick(sheet, "Everyone");
  const sheetKeep = sheet.getByRole("button", { name: "Upload", exact: true });
  await sheetKeep.click();

  // The failure shakes the sheet's own Upload, shows the error toast and no celebration; the card stays with Try again.
  await expect(sheetKeep.locator(".act")).toHaveClass(/is-fail/);
  const errorToast = page.locator(".toast", { hasText: "cannot be reached" });
  await expect(errorToast).toBeVisible();
  // The toast sits above the sheet's backdrop (the sheet is drawn on body), so the owner can read it.
  const onTop = await errorToast.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".toast");
  });
  expect(onTop).toBe(true);
  await expect(page.locator("canvas.confetti")).toHaveCount(0);
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toHaveCount(0);
  await expect(card.getByText("Uploading this clip did not finish. Tap Try again.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();

  // Try again (old enough to resume) finishes the keep with the same TikTok choices.
  await sheet.getByRole("button", { name: "Not now" }).click();
  await expect(sheet).toHaveCount(0);
  await page.evaluate(() => {
    (window as MockWindow).__cfMockFaults!.resumeAfterMs = 0;
  });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toBeVisible();
  await expect(cards).toHaveCount(before - 1);
});
