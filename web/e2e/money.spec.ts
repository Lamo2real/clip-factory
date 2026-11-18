import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { CLIPS, findOverflow, openClip, settle } from "./helpers.ts";

// Settings › Posting › Money and Home's money tile (docs/CONTRACTS.md §25.7): every card state from the mock, one
// vermilion button that does "Allow money reading" end to end, money only with the platform's estimate tag,
// celebrations once, the country pick, old anchors, and 375 px with no sideways scroll in light and dark.

const PATH = "/settings/posting/money";

/** Picks the mock's scenario (kept in sessionStorage, so the page and a trip through Allow keep it), then opens `to`. */
async function scenario(page: Page, name: string, to = PATH, country: string | null = "US") {
  await page.goto("/");
  await page.evaluate(([n, c]) => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: n, country: c, seen: [] })), [name, country] as const);
  await page.goto(to);
  await settle(page);
}

const card = (page: Page, platform: string) => page.locator(`[data-money-card='${platform}']`);
const pill = (page: Page, platform: string) => card(page, platform).locator("[data-money-state] .pill");

test("first visit: real progress, one Allow money reading button, and apps that don't share say so", async ({ page }) => {
  await scenario(page, "start");
  await expect(page.getByText("Clip Factory only shows money an app reports.", { exact: false })).toBeVisible();
  await expect(page.getByText("No money yet.", { exact: false }).first()).toBeVisible();
  await expect(pill(page, "youtube")).toHaveText("Needs your OK");
  await expect(card(page, "youtube").getByText("812 / 1,000 subscribers")).toBeVisible();
  await expect(card(page, "youtube").locator(".money-goals > .money-goal")).toHaveCount(3);
  const allow = card(page, "youtube").getByRole("button", { name: "Allow money reading" });
  await expect(allow).toBeVisible();
  await expect(allow).toHaveClass(/btn--action/);
  await expect(card(page, "youtube").locator(".btn--action, .btn--primary")).toHaveCount(1);
  // The grown-up steps and the fan-money goals wait behind small toggles.
  await card(page, "youtube").getByRole("button", { name: "First time? Steps for a grown-up" }).click();
  await expect(card(page, "youtube").getByText("Use the same Google Cloud project. Don't make new keys.", { exact: false })).toBeVisible();
  await card(page, "youtube").getByRole("button", { name: "More" }).click();
  await expect(card(page, "youtube").getByText("500 subscribers for fan money", { exact: false })).toBeVisible();
  await card(page, "youtube").getByRole("button", { name: "What does watch hours in 12 months mean?" }).click();
  await expect(card(page, "youtube").getByText("YouTube Studio's number is the official one.", { exact: false })).toBeVisible();
  await expect(pill(page, "instagram")).toHaveText("Goal reached");
  await expect(card(page, "instagram")).toContainText("Instagram also checks things we can't see.");
  await expect(card(page, "instagram")).toContainText("Instagram doesn't share earnings with apps.");
  await expect(pill(page, "facebook")).toHaveText("Not earning yet");
  await expect(card(page, "facebook")).toContainText("Facebook money: coming soon");
  await expect(card(page, "x")).toContainText("X doesn't share earnings with apps.");
  // No money figure anywhere without its platform's estimate tag.
  await expect(page.locator(".settings-content")).not.toContainText("$");
  await expect(page.locator("[data-money='revenue']")).toHaveCount(0);
  await expect(page.getByText("Clip Factory never needs your bank details.")).toBeVisible();
});

test("Allow money reading goes to the platform and comes back merged, with a check started", async ({ page }) => {
  await scenario(page, "start");
  await card(page, "youtube").getByRole("button", { name: "Allow money reading" }).click();
  await expect(page.getByText("Done! Clip Factory can read money from YouTube now. Checking…")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`)); // the result is read once and taken out of the address
  await expect(pill(page, "youtube")).toHaveText("Not yet");
  await expect(card(page, "youtube")).toContainText("Not in YouTube Partner Program yet. Here's how close you are.");
  await expect(card(page, "youtube").getByRole("button", { name: "Allow money reading" })).toHaveCount(0);
});

test("a refused grant changes nothing and says why in plain words", async ({ page }) => {
  await scenario(page, "start", `${PATH}?result=money_missing&platform=tiktok`);
  await expect(page.getByText("TikTok hasn't approved this yet. Try again after it's approved. Posting still works.")).toBeVisible();
  await expect(pill(page, "tiktok")).toHaveText("Needs your OK");
});

test("earning: this month's money with YouTube's estimate tag, and the first-money party plays once", async ({ page }) => {
  await scenario(page, "earning");
  await expect(page.getByText("Your first money from YouTube!")).toBeVisible();
  await expect(pill(page, "youtube")).toHaveText("Earning");
  const revenue = card(page, "youtube").locator("[data-money='revenue']");
  await expect(revenue).toContainText("This month");
  await expect(revenue).toContainText("YouTube's estimate");
  await expect(revenue).toContainText(/\$\d+\.\d\d/);
  await expect(page.locator("[data-money-month='USD']")).toContainText("YouTube's estimate");
  await expect(card(page, "youtube")).toContainText("Can change at month end · 2–3 days behind");
  await expect(card(page, "youtube")).toContainText("AdSense for YouTube › Payments");
  for (const word of ["paid you", "received", "actual"]) await expect(page.locator(".settings-content")).not.toContainText(word);
  await page.reload();
  await settle(page);
  await expect(page.getByText("Your first money from YouTube!")).toHaveCount(0);
});

test("two currencies stay two lines, never added together", async ({ page }) => {
  await scenario(page, "facebook_verified");
  await expect(page.locator("[data-money-month]")).toHaveCount(2);
  await expect(page.locator("[data-money-month='EUR']")).toContainText("Meta's estimate");
  await expect(card(page, "facebook").locator("[data-money='revenue']")).toContainText("Meta's estimate");
});

test("in the programme: Home celebrates once and shows how close the money is", async ({ page }) => {
  await scenario(page, "in_program", "/");
  await expect(page.getByText("You're in YouTube's Partner Program!")).toBeVisible();
  const tile = page.locator(".money-tile");
  await expect(tile).toContainText("Your money.");
  await tile.getByRole("link", { name: "See money" }).click();
  await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  await settle(page);
  await expect(pill(page, "youtube")).toHaveText("In the programme");
  await expect(page.getByText("You're in YouTube's Partner Program!")).toHaveCount(0);
});

test("Home's tile shows the bar nearest its goal before any money", async ({ page }) => {
  await scenario(page, "not_yet", "/");
  const tile = page.locator(".money-tile");
  await expect(tile).toContainText("No money yet. Here's how close you are.");
  await expect(tile.locator("[data-near='youtube']")).toContainText("812 / 1,000 subscribers");
  await expect(tile.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "81");
});

test("the country is picked once and TikTok's goals follow it", async ({ page }) => {
  await scenario(page, "unsupported", PATH, null);
  await expect(card(page, "tiktok")).toContainText("Pick your country at the top to see this programme's goals.");
  await page.locator(".money-country__select").selectOption("US");
  await expect(page.getByText("Saved. Your country is United States.")).toBeVisible();
  await expect(card(page, "tiktok").getByText("10,500 / 10,000 followers")).toBeVisible();
  await expect(card(page, "tiktok")).toContainText("Don't switch to a Business account. Creator Rewards won't pay it.");
});

test("Check now runs once an hour", async ({ page }) => {
  await scenario(page, "not_yet");
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Checking every app now. New numbers show in a minute.")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Clip Factory checked less than an hour ago. Your numbers are up to date.")).toBeVisible();
});

test("not connected and couldn't-check states read plainly", async ({ page }) => {
  await scenario(page, "not_connected");
  for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"]) await expect(pill(page, p)).toHaveText("Not connected");
  await expect(card(page, "youtube")).toContainText("Connect YouTube in Settings › Posting › Set up posting to see this.");
  await scenario(page, "error");
  await expect(pill(page, "youtube")).toHaveText("Couldn't check");
  await expect(card(page, "youtube")).toContainText("Turn on YouTube Analytics API in Google Cloud.");
});

test("the old money anchors open the Money branch", async ({ page }) => {
  for (const old of ["money-rate", "money-how"]) {
    await page.goto(`/settings#${old}`);
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  }
});

test("the clip page and This week show only money YouTube reported, with its tag", async ({ page }) => {
  await scenario(page, "not_yet", "/");
  await openClip(page, CLIPS.all);
  await expect(page.locator("[data-reported-money]")).toHaveCount(0);
  await expect(page.locator(".perf")).not.toContainText("$");
  await page.evaluate(() => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "earning", country: "US", seen: ["youtube:first_money"] })));
  await openClip(page, CLIPS.all);
  const yt = page.locator("[data-reported-money='youtube']");
  await expect(yt).toContainText(/YouTube's estimate for this clip: \$\d+\.\d\d/);
  await expect(page.locator("[data-reported-money]")).toHaveCount(1);
  await page.goto("/library?view=week");
  await settle(page);
  await expect(page.locator("[data-week-money='youtube']")).toHaveText("YouTube's estimate for this week: $3.10");
});

for (const scheme of ["light", "dark"] as const) {
  test(`375 px, ${scheme}: Money and Home's tile never scroll sideways and pass contrast`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path] of [
      ["earning", PATH],
      ["start", PATH],
      ["not_yet", "/"],
    ] as const) {
      await scenario(page, name, path);
      const over = await findOverflow(page);
      expect(over.items, `${name} ${path}`).toEqual([]);
      expect(over.page).toBeLessThanOrEqual(over.viewport);
      if (path === PATH) {
        const axe = await new AxeBuilder({ page }).include(".settings-content").withRules(["color-contrast"]).analyze();
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
      }
    }
  });
}
