import { expect, test, type Page } from "@playwright/test";
import { animationsDone, CLIPS, findOverflow, openClip, settle } from "./helpers.ts";

// Earnings (docs/CONTRACTS.md §21), in mock mode: the money guess on the clip page, Library and This week, and the
// Settings › Posting › Money edit flow. The mock keeps settings only until the next full page load, so the flow moves
// between screens with in-app links.

const MONEY = "/settings/posting/money";
const earned = (page: Page, platform: string) => page.locator(`[data-stack="${platform}"] [data-earned="${platform}"]`);

/** Opens a clip from the Library without reloading the app (keeps settings changed in this visit). */
async function openClipInApp(page: Page, hook: string) {
  await page.getByRole("navigation").getByRole("link", { name: "Library", exact: true }).first().click();
  await page.waitForURL(/\/library$/);
  await settle(page);
  await page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) }).locator(".lib-card__link").click();
  await page.waitForURL(/\/clips\/[A-Z0-9]+$/);
  await page.locator("[data-stack]").nth(4).waitFor();
  await settle(page);
  await animationsDone(page);
}

async function expectNoOverflow(page: Page, where: string) {
  const o = await findOverflow(page);
  expect(o.items, `${where}: ${JSON.stringify(o.items.slice(0, 3))}`).toEqual([]);
  expect(o.page, `${where}: page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
}

/** Flips apps' "Do I get paid here?" switches in Settings › Money to `on` (this page load only). */
async function setPaid(page: Page, names: string[], on: boolean) {
  for (const name of names) {
    const sw = page.getByRole("switch", { name: `Do I get paid on ${name}?` });
    if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", String(on));
  }
}

const GUESS = /Earned (about \$[\d,]+\.\d{2}|less than 1¢)/;

test("by default the clip page shows a money guess for YouTube, Facebook and X; TikTok and Instagram start off", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openClip(page, CLIPS.all);

  const total = page.locator('[data-earned="total"]');
  await expect(total).toContainText(/This clip earned (about \$[\d,]+\.\d{2}|less than 1¢)/);
  await expect(page.locator(".perf__money .perf__guess")).toHaveText("Best guess");

  for (const p of ["youtube", "facebook", "x"]) await expect(earned(page, p)).toContainText(GUESS);
  for (const p of ["youtube", "facebook", "x"]) await expect(earned(page, p)).not.toContainText("about less than");
  await expect(earned(page, "tiktok")).toContainText("Earned $0.00");
  await expect(earned(page, "tiktok")).toContainText("Turn this on in Settings › Money if TikTok pays you.");

  // The total is the sum of the stacks (to the cent).
  const cents = await page.evaluate(() => {
    const read = (t: string) => (/less than/.test(t) ? 0 : Number((/\$([\d,.]+)/.exec(t)?.[1] ?? "0").replace(/,/g, "")));
    const parts = [...document.querySelectorAll(".pstack__earned-num")].map((e) => read(e.textContent ?? ""));
    return { sum: Math.round(parts.reduce((a, b) => a + b, 0) * 100), total: Math.round(read(document.querySelector('[data-earned="total"]')!.textContent ?? "") * 100) };
  });
  expect(Math.abs(cents.sum - cents.total)).toBeLessThanOrEqual(3); // each stack rounds to the cent on its own

  const how = page.getByRole("button", { name: "How is this worked out?" });
  await expect(how).toHaveAttribute("aria-expanded", "false");
  await how.click();
  await expect(how).toHaveAttribute("aria-expanded", "true");
  const box = page.locator("#perf-money-how");
  await expect(box).toContainText("It is a guess, not money you were sent.");
  await expect(box).toContainText("do not pay for replays");
  // The same short names as the stacks and Settings › Money.
  await expect(box).toContainText("YouTube: $0.05 for 1,000 views (usual)");
  await expect(box).toContainText("X: $0.12 for 1,000 views (usual)");
  await expect(box).not.toContainText("YouTube Shorts");
  await expect(box).toContainText("TikTok: off, so $0");
  // An app that is on says plainly that it only counts inside its paid program, with who gets paid.
  await expect(box.locator('[data-how="youtube"]')).toContainText("This only counts if you are in YouTube's paid program. Only channels in the YouTube Partner Program");
  await expect(box.locator('[data-how="facebook"]')).toContainText("This only counts if you are in Facebook's paid program.");
  await expect(box.locator('[data-how="x"]')).toContainText("This only counts if you are in X's paid program.");
  await expect(box.locator('[data-how="tiktok"]')).not.toContainText("paid program");
  // Each mark sits on a dark round tile and is hidden from screen readers, so X reads once ("X:"), never "X X".
  const xRow = box.locator('[data-how="x"]');
  await expect(xRow.locator(".perf__how-tile")).toHaveCount(1);
  await expect(xRow.locator(".perf__how-tile")).toHaveAttribute("aria-hidden", "true");
  expect(await xRow.locator(".perf__how-tile").evaluate((e) => getComputedStyle(e).borderRadius)).toBe("50%");
  await expect(xRow).not.toContainText(/X\s*X/);
  await box.getByRole("link", { name: "Change it in Settings › Money" }).click();
  await expect(page).toHaveURL(new RegExp(`${MONEY}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Money" })).toBeVisible();
});

test("with every app switched off, the clip page shows $0 with the plain reasons, and what it would be", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(MONEY);
  await settle(page);
  await setPaid(page, ["YouTube", "Facebook", "X"], false);
  await openClipInApp(page, CLIPS.all);

  const total = page.locator('[data-earned="total"]');
  await expect(total).toHaveText("This clip earned $0.00");
  await expect(page.locator(".perf__money")).toContainText("These apps are switched off in Settings › Money.");
  // $0 is not a guess: no Best guess tag.
  await expect(page.locator(".perf__money .perf__guess")).toHaveCount(0);
  await expect(earned(page, "youtube")).toContainText("Earned $0.00");
  await expect(earned(page, "youtube")).toContainText("YouTube does not pay you for views right now.");
  await expect(earned(page, "youtube")).toContainText(/If YouTube paid you, this would be (about \$[\d,]+\.\d{2}|less than 1¢)\./);
  await expect(earned(page, "tiktok")).toContainText("Turn this on in Settings › Money if TikTok pays you.");

  await page.getByRole("button", { name: "How is this worked out?" }).click();
  const box = page.locator("#perf-money-how");
  await expect(box).toContainText("YouTube: off, so $0");
  await expect(box).not.toContainText("paid program");
});

test("Settings › Money: check a typed amount, save it, switch an app on, and see it on the clip page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(MONEY);
  await settle(page);
  await expect(page.getByRole("heading", { name: "Do I get paid here?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Money for 1,000 views" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Where the numbers come from" })).toBeVisible();

  // The defaults: YouTube, Facebook and X on (each says it only counts in its paid program); TikTok and Instagram off.
  const sw = (name: string) => page.getByRole("switch", { name: `Do I get paid on ${name}?` });
  for (const name of ["YouTube", "Facebook", "X"]) await expect(sw(name)).toHaveAttribute("aria-checked", "true");
  for (const name of ["TikTok", "Instagram"]) await expect(sw(name)).toHaveAttribute("aria-checked", "false");
  await expect(page.locator('[data-money-rule="youtube"]')).toHaveText(
    "This only counts if you are in YouTube's paid program. Only channels in the YouTube Partner Program get Shorts money. From February 2027 a channel also needs about 10 million Shorts views every 3 months.",
  );
  await expect(page.locator('[data-money-rule="facebook"]')).toContainText("This only counts if you are in Facebook's paid program.");
  await expect(page.locator('[data-money-rule="x"]')).toContainText("This only counts if you are in X's paid program.");
  await expect(page.locator('[data-money-rule="tiktok"]')).toHaveCount(0);
  await expect(page.locator('[data-money-rule="instagram"]')).toHaveCount(0);
  await expect(page.locator('[data-money-rate="youtube"]')).toContainText("Usually $0.05 ($0.02 to $0.10)");

  const box = page.getByLabel("Your amount for 1,000 views on YouTube");
  const form = page.locator('[data-money-rate="youtube"]');
  await box.fill("abc");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toHaveText("Type only a number, like 0.05.");
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await box.fill("0.055");
  await box.press("Enter");
  await expect(form.getByRole("alert")).toHaveText("Use at most 2 numbers after the dot, like 0.05.");
  await box.fill("1000");
  await box.press("Enter");
  await expect(form.getByRole("alert")).toHaveText("That is too much. The most is 100 dollars.");

  await box.fill("2,5");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. YouTube now uses $2.50 for 1,000 views.")).toBeVisible();
  await expect(form).toContainText("Using your amount: $2.50.");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(box).toHaveValue("2.5");

  await sw("TikTok").click();
  await expect(sw("TikTok")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("TikTok is on. Clips earn money there.")).toBeVisible();
  await expect(page.locator('[data-money-rule="tiktok"]')).toContainText("This only counts if you are in TikTok's paid program.");
  // Off again: the line goes away.
  await sw("Instagram").click();
  await expect(page.locator('[data-money-rule="instagram"]')).toBeVisible();
  await sw("Instagram").click();
  await expect(sw("Instagram")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator('[data-money-rule="instagram"]')).toHaveCount(0);

  // Each app's mark sits on a tile, so X reads as one X, not "X X".
  await expect(page.locator('[data-money-paid="x"] .money__tile')).toHaveCount(1);

  // Sources: hidden until asked, in plain words, each with a readable date and a full-size tap target.
  const yt = page.locator('[data-money-sources="youtube"]');
  await yt.getByRole("button").click();
  await expect(yt.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(yt).toContainText("Who gets paid:");
  await expect(yt).toContainText("What counts: People who watched your Short in the Shorts feed.");
  // The plain lines (link titles are the pages' own names) carry none of the grown-up words.
  const plain = (await yt.locator(".money__fine").allTextContents()).join(" ");
  expect(plain).not.toMatch(/Shorts Monetization Module|RPM|Creator Pool/);
  const link = yt.getByRole("link", { name: /YouTube Help: YouTube Shorts monetization policies/ });
  await expect(link).toHaveAttribute("target", "_blank");
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(yt).toContainText("Checked 16 Nov 2026");
  await expect(yt).not.toContainText("accessed 2026-11-16");

  // On the clip page: YouTube uses $2.50, TikTok is on but the clip is under a minute.
  await openClipInApp(page, CLIPS.all);
  await expect(earned(page, "tiktok")).toContainText("TikTok only pays for videos 1 minute or longer.");
  await page.getByRole("button", { name: "How is this worked out?" }).click();
  await expect(page.locator("#perf-money-how")).toContainText("YouTube: $2.50 for 1,000 views (your amount)");
  await expect(page.locator("#perf-money-how")).toContainText("TikTok: clip too short, so $0");

  // Back to the usual amount.
  await page.locator("#perf-money-how").getByRole("link", { name: "Change it in Settings › Money" }).click();
  await settle(page);
  await page.locator('[data-money-rate="youtube"]').getByRole("button", { name: "Use the usual" }).click();
  await expect(page.getByText("YouTube uses the usual amount again.")).toBeVisible();
  await expect(page.locator('[data-money-rate="youtube"]')).toContainText("Using the usual amount.");
  await expect(page.locator('[data-money-rate="youtube"]').getByRole("button", { name: "Use the usual" })).toHaveCount(0);
});

test("Find a setting finds Money", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  await page.getByRole("combobox", { name: "Find a setting" }).last().fill("do i get paid");
  await expect(page.getByRole("option", { name: /Do I get paid here\?/ }).first()).toBeVisible();
});

test("Library and This week: the usual switches show a Best guess; every app off shows $0 with its reason", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/library");
  await settle(page);
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: CLIPS.all }) }).locator('[data-earned="clip"]');
  await expect(card).toContainText(GUESS);
  await expect(card.locator(".earned-guess")).toBeVisible();
  await expect(card.locator(".earned-guess")).toHaveText("Best guess");

  await page.getByRole("link", { name: "This week" }).click();
  await settle(page);
  // The cards come after the week's numbers load; on a slow runner settle() alone returned before they were drawn.
  const hooks = page.locator(".week-card__hook");
  await expect(hooks.first()).toBeVisible();
  const before = await hooks.allTextContents();
  expect(before.length).toBeGreaterThan(1);
  const week = page.locator('[data-earned="week"]');
  await expect(week).toContainText(/This week earned (about \$[\d,]+\.\d{2}|less than 1¢)/);
  await expect(week.locator(".earned-guess")).toBeVisible();
  const weekCard = page.locator(".week-card", { hasText: CLIPS.all }).locator('[data-earned="clip"]');
  await expect(weekCard).toContainText(/Earned (about|less than)/);
  await expect(weekCard.locator(".earned-guess")).toBeVisible();

  // Switch YouTube, Facebook and X off, then come back in the app (the mock forgets settings on a reload).
  await page.goto(MONEY);
  await settle(page);
  await setPaid(page, ["YouTube", "Facebook", "X"], false);
  await page.getByRole("navigation").getByRole("link", { name: "Library", exact: true }).first().click();
  await page.waitForURL(/\/library$/);
  await settle(page);
  await expect(card).toContainText("Earned $0.00");
  await expect(card).toContainText("These apps are switched off in Settings › Money.");
  await expect(card.locator(".earned-guess")).toHaveCount(0);

  await page.getByRole("link", { name: "This week" }).click();
  await settle(page);
  await expect(week).toContainText("This week earned $0.00");
  await expect(week).toContainText("These apps are switched off in Settings › Money.");
  await expect(weekCard).toContainText("These apps are switched off");
  // The order (most views first) is the same with or without money. (Retries until every card is drawn again.)
  await expect.poll(() => hooks.allTextContents()).toEqual(before);
});

for (const width of [320, 375, 768, 1440, 1920]) {
  test(`nothing overflows at ${width} px: clip page, Money, Library, This week`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openClip(page, CLIPS.all);
    await page.getByRole("button", { name: "How is this worked out?" }).click();
    // Measure only once the opened box is drawn (a measure straight after the click could see the page before it).
    await expect(page.locator("#perf-money-how")).toBeVisible();
    await expectNoOverflow(page, `clip ${width}`);

    await page.goto(MONEY);
    await settle(page);
    for (const p of ["youtube", "x"]) {
      const sources = page.locator(`[data-money-sources="${p}"]`);
      await sources.getByRole("button").click();
      await expect(sources.locator(".money__link").first()).toBeVisible();
    }
    // Every source link is a full 44 px tap target at every width.
    const heights = await page.locator(".money__link").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await page.getByLabel("Your amount for 1,000 views on Facebook").fill("x");
    await page.locator('[data-money-rate="facebook"]').getByRole("button", { name: "Save" }).click();
    await expect(page.locator('[data-money-rate="facebook"]').getByRole("alert")).toBeVisible();
    await page.waitForTimeout(500);
    await expectNoOverflow(page, `money ${width}`);

    await page.goto("/library");
    await settle(page);
    await expect(page.locator(".lib-card").first()).toBeVisible();
    await expectNoOverflow(page, `library ${width}`);

    await page.goto("/library?view=week");
    await settle(page);
    await expect(page.locator(".week-card").first()).toBeVisible();
    await expectNoOverflow(page, `week ${width}`);
  });
}
