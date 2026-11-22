// Posted on TikTok without its link (docs/CONTRACTS.md §42.2): the inline Add link in the TikTok row, which saves a
// pasted link or, with an empty box, lets Clip Factory find the post. The manual "Post it yourself" sheet is gone
// (ADR-85): no control of it shows on the Library, the clip page or Review.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

type MockWindow = Window & {
  __cfMock?: {
    mac: {
      ping(): unknown;
      claim(clipId: string): unknown;
      done(clipId: string, link?: string): unknown;
    };
  };
};

const LINK = "https://www.tiktok.com/@lamo.clips/video/7710644811602169121";
/** Every control the manual sheet had, by its name. */
const MANUAL = /Post it (on TikTok )?yourself|I posted it|AirDrop|^Open TikTok$|Save the video|Save to my phone/;

test.use({ viewport: { width: 1440, height: 900 } });

async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

const tiktokRow = (page: Page, clipId: string) =>
  page.locator(".lib-card", { has: page.locator(`[id="lib-${clipId}"]`) }).locator(".post", { has: page.locator(".post__name", { hasText: /^TikTok$/ }) });

/**
 * A clip the owner's Mac posted on TikTok without finding its link (its done came with an empty link), on the
 * Library: Your Mac posts TikTok on, Post with my Mac, then the Mac's done.
 */
async function postedWithoutLink(page: Page) {
  await page.goto("/");
  await settle(page);
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: "My Mac posts my TikTok clips" }).click();
  await expect(page.getByRole("switch", { name: "My Mac posts my TikTok clips" })).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => (window as MockWindow).__cfMock!.mac.ping());
  await go(page, "/library");
  const card = page.locator(".lib-card", { has: page.locator(".post__status", { hasText: /^Not on TikTok yet$/ }) }).first();
  const clipId = (await card.getAttribute("aria-labelledby"))!.replace("lib-", "");
  const row = tiktokRow(page, clipId);
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(row.locator(".post__status")).toHaveText(/^Waiting for your Mac/);
  await page.evaluate((id) => {
    const m = (window as MockWindow).__cfMock!.mac;
    m.claim(id);
    m.done(id, "");
  }, clipId);
  await expect(row.locator(".post__status")).toHaveText("Posted by your Mac · Everyone · add the link");
  return row;
}

test("library: Add link in the row saves a pasted TikTok link", async ({ page }) => {
  const row = await postedWithoutLink(page);
  // The field is in the row itself: no dialog.
  const box = row.getByRole("textbox", { name: "TikTok link" });
  await expect(box).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Paste the TikTok link" })).toBeVisible();

  // Not a TikTok link: a plain sentence, nothing saved.
  await box.fill("hello");
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(row.getByRole("alert")).toHaveText("That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.");
  await expect(row.locator(".post__status")).toHaveText("Posted by your Mac · Everyone · add the link");

  await box.fill(LINK);
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Link saved! Clip Factory will count its views.")).toBeVisible();
  await expect(row.locator(".post__status")).toHaveText(/^Posted by your Mac · Everyone( · numbers .+)?$/);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("textbox")).toHaveCount(0);
});

test("library: Add link with an empty box lets Clip Factory find the post", async ({ page }) => {
  const row = await postedWithoutLink(page);
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Found it on your TikTok! Clip Factory will count its views.")).toBeVisible();
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toBeVisible();
  await expect(row.getByRole("textbox")).toHaveCount(0);
});

test("no Post it yourself, I posted it, AirDrop or Open TikTok anywhere: Library, the clip page and Review", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const none = async () => {
    await expect(page.getByRole("button", { name: MANUAL })).toHaveCount(0);
    await expect(page.getByRole("link", { name: MANUAL })).toHaveCount(0);
    await expect(page.getByText(/Post it yourself|I posted it/)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await none();
  // Each TikTok row has the Mac's own button instead (the switch is off here: Turn on).
  const card = page.locator(".lib-card", { has: page.locator(".post__status", { hasText: /^Your Mac posts TikTok is off$/ }) }).first();
  await expect(card.getByRole("link", { name: "Turn on" })).toBeVisible();
  const clipId = (await card.getAttribute("aria-labelledby"))!.replace("lib-", "");

  await go(page, `/clips/${clipId}`);
  await none();
  await expect(page.locator(".perf__actions").getByRole("link", { name: "Turn on" })).toBeVisible();

  await go(page, "/review");
  const first = page.locator(".review-card").first();
  await first.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  await expect(page.locator(".kept-now")).toBeVisible();
  await expect(page.locator(".kept-now__mac").first()).toHaveText("TikTok: Your Mac posts TikTok is off");
  await none();
});
