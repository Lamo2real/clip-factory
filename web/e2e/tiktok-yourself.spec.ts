// Post it on TikTok yourself (docs/CONTRACTS.md §42): the Library's button, the sheet, I posted it, Add link and Undo.
import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";
import type { Page } from "@playwright/test";

/** The first card whose TikTok was uploaded privately, found again by its hook (its words change once marked). */
async function privateCard(page: Page) {
  const first = page.locator(".lib-card", { has: page.locator(".post", { hasText: "Uploaded privately" }) }).first();
  const hook = await first.locator(".lib-card__hook").innerText();
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) });
  return { card, row: card.locator(".post", { hasText: "TikTok" }) };
}

test("library: post a private TikTok clip yourself, add its link, and undo", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const { row } = await privateCard(page);
  await row.getByRole("button", { name: "Post it on TikTok yourself" }).click();

  const sheet = page.getByRole("dialog", { name: "Post it on TikTok yourself" });
  await expect(sheet).toBeVisible();
  // A computer: the file and TikTok's own upload page, the steps in TikTok's words, the caption to paste.
  await expect(sheet.getByRole("button", { name: "Save the video" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Open TikTok" })).toBeVisible();
  await expect(sheet.getByText("Everyone", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Clip Factory’s own TikTok upload stays Only me")).toBeVisible();

  // Not a TikTok link: a plain sentence, nothing saved.
  await sheet.getByRole("textbox", { name: /TikTok link/ }).fill("hello");
  await sheet.getByRole("button", { name: "I posted it" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.");

  // No link: posted by you, and Add link asks for it.
  await sheet.getByRole("textbox", { name: /TikTok link/ }).fill("");
  await sheet.getByRole("button", { name: "I posted it" }).click();
  await expect(sheet).toHaveCount(0);
  // No link: the mock's first look for the post on TikTok finds nothing yet.
  await expect(page.getByText("On TikTok for everyone! Clip Factory could not find it on your TikTok yet. Tap Add link in a minute.")).toBeVisible();
  await expect(row).toContainText("Posted by you · Everyone · add the link to count views");
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself" })).toHaveCount(0);

  await row.getByRole("button", { name: "Add the TikTok link" }).click();
  const linkSheet = page.getByRole("dialog", { name: "Add the TikTok link" });
  await linkSheet.getByRole("textbox", { name: /TikTok link/ }).fill("https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
  await linkSheet.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Link saved! Clip Factory will count its views.")).toBeVisible();
  await expect(row).toContainText("Posted by you · Everyone");
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", "https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
});

test("library: Undo takes I posted it back", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const { row } = await privateCard(page);
  await row.getByRole("button", { name: "Post it on TikTok yourself" }).click();
  await page.getByRole("dialog", { name: "Post it on TikTok yourself" }).getByRole("button", { name: "I posted it" }).click();
  await expect(row).toContainText("Posted by you");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row).toContainText("Uploaded privately");
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself" })).toBeVisible();
});

test("library: Add link's Find it on my TikTok finds the post", async ({ page }) => {
  await page.goto("/library");
  await settle(page);
  const { row } = await privateCard(page);
  await row.getByRole("button", { name: "Post it on TikTok yourself" }).click();
  await page.getByRole("dialog", { name: "Post it on TikTok yourself" }).getByRole("button", { name: "I posted it" }).click();
  await row.getByRole("button", { name: "Add the TikTok link" }).click();
  await page.getByRole("dialog", { name: "Add the TikTok link" }).getByRole("button", { name: "Find it on my TikTok" }).click();
  await expect(page.getByText("Found it on your TikTok! Clip Factory will count its views.")).toBeVisible();
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Add the TikTok link" })).toHaveCount(0);
});

test("review: right after Upload without TikTok, Uploaded just now offers Post it yourself", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  const card = page.locator(".review-card").first();
  const hook = await card.locator(".review-card__hook").innerText();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const box = page.locator(".kept-now");
  await expect(box).toBeVisible();
  const item = box.locator(".kept-now__item", { hasText: hook.slice(0, 20) });
  await item.getByRole("button", { name: "Post it on TikTok yourself" }).click();
  const sheet = page.getByRole("dialog", { name: "Post it on TikTok yourself" });
  await sheet.getByRole("button", { name: "I posted it" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Post it on TikTok yourself" })).toHaveCount(0);
});
