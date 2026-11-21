import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import {
  CAMPAIGN_WAY_TAPS,
  CONNECT_CF_TAPS_FROM_ZERO,
  CONNECT_TAPS_DONE,
  COPY_TAPS,
  NORMAL_HOME_CONTROLS,
  NORMAL_REVIEW_CONTROLS,
  NORMAL_REVIEW_EXTRA,
  NORMAL_WAY_TAPS,
  controlsIn,
  tap,
} from "./flows.ts";
import { settle } from "./helpers.ts";

// The two ways and their click counts (docs/CONTRACTS.md §39.1, §39.5), in mock mode, at 375×812 and 1440×900. Every
// click and key press that acts goes through tap() (e2e/flows.ts), which fails as soon as the count is over. The
// normal way is frozen: Home's form at / and a normal clip's Review card keep origin/main's controls, and 5 taps
// upload, whether Content Rewards is missing (404), switched off (503) or on with campaigns joined.

const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";
const FAZE_URL = `https://contentrewards.com/c/campaigns/${FAZE}`;
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { cr?: Knobs; setup?: Knobs; jobs?: Knobs } };

/** Start states read once by the mock, then the places he has set up. */
async function start(page: Page, flags: { fresh?: boolean; off?: "404" | "503"; remake?: boolean; review?: boolean } = {}) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("cf-e2e-two-ways")) return;
    sessionStorage.setItem("cf-e2e-two-ways", "1");
    if (f.fresh) sessionStorage.setItem("cf-mock-cr-start", "fresh");
    if (f.off) sessionStorage.setItem("cf-mock-cr-off", f.off);
    if (f.remake) sessionStorage.setItem("cf-mock-cr-remake", "on");
    if (f.review) sessionStorage.setItem("cf-mock-cr-review", "1");
  }, flags);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
}
async function ready(page: Page, ...platforms: string[]) {
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.setup && !!(window as MockWin).__cfMock?.jobs);
  await page.evaluate((ps) => {
    for (const p of ps) (window as MockWin).__cfMock!.setup!.finish!(p);
  }, platforms);
}
const copy = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
/** "(the job runs)": the newest job finishes; waiting is never a step. */
const jobRuns = (page: Page) => page.evaluate(() => (window as MockWin).__cfMock!.jobs!.finish!());
const knob = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => (window as MockWin).__cfMock!.cr![fn as string]!(...(args as unknown[])), [fn, args] as const);

/** The normal way: Paste, Make clips, the job page's way to Review, Use my settings, Upload to 2. */
async function normalWay(page: Page, extra: readonly string[] = []) {
  const taps = tap(NORMAL_WAY_TAPS);
  await page.goto("/");
  await settle(page);
  await copy(page, VIDEO);
  await taps.tap(page.locator("form.newjob").getByRole("button", { name: "Paste", exact: true }));
  const make = page.locator("form.newjob").getByRole("button", { name: "Make clips", exact: true });
  await expect(make).toBeEnabled();
  await taps.tap(make);
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await jobRuns(page);
  await taps.tap(page.getByRole("link", { name: "Check these clips" }), "Go to Review");
  await expect(page).toHaveURL(/\/review\?job=/);
  const card = page.locator(".review-card").first();
  await expect(card).toBeVisible();
  await page.waitForTimeout(400);
  if (extra.length) await expect(card.locator(".cr-suggest")).toBeVisible();
  const have = await controlsIn(page, ".review-list__item:first-child .review-card");
  expect(have.filter((c) => !c.startsWith("button:Make a ") && c !== "button:Not now")).toEqual(NORMAL_REVIEW_CONTROLS);
  expect(have.filter((c) => c.startsWith("button:Make a ") || c === "button:Not now").map((c) => c.replace(/Make a .+ copy/, "Make a {campaign} copy"))).toEqual(extra);
  await taps.tap(card.locator("[data-help='use-my-settings'] button"), "Use my settings");
  const upload = card.getByRole("button", { name: /^Upload to 2$/ });
  await expect(upload).toBeEnabled();
  await expect(upload).not.toHaveAttribute("aria-disabled", "true");
  await taps.tap(upload);
  await expect(page.getByText(/^(Uploading to|Saved!)/)).toBeVisible();
  expect(taps.count).toBe(NORMAL_WAY_TAPS);
}

async function homeIsFrozen(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.waitForTimeout(300);
  expect(await controlsIn(page, "form.newjob")).toEqual(NORMAL_HOME_CONTROLS.empty);
  const form = page.locator("form.newjob");
  // Inside the form: no campaign anchor or class, and no word "campaign" but Notes' own placeholder.
  expect(await form.locator("[data-help^='cr-'], [class*='cr-']").count()).toBe(0);
  expect((await form.innerText()).toLowerCase()).not.toContain("campaign");
  await page.getByLabel("YouTube, Twitch or Kick link").fill(VIDEO);
  expect(await controlsIn(page, "form.newjob")).toEqual(NORMAL_HOME_CONTROLS.withLink);
  expect((await form.innerText()).toLowerCase()).not.toContain("campaign");
  await page.getByRole("radio", { name: "Exactly" }).check({ force: true });
  expect(await controlsIn(page, "form.newjob")).toContain("button:More: Number of clips");
}

for (const [size, viewport] of [
  ["phone", { width: 375, height: 812 }],
  ["desktop", { width: 1440, height: 900 }],
] as const) {
  test.describe(`${size}`, () => {
    test.use({ viewport, ...(size === "phone" ? { hasTouch: true, isMobile: true } : {}) });

    for (const off of ["404", "503", null] as const) {
      test(`the normal way is frozen (${off ? `Content Rewards ${off}` : "Content Rewards on, campaigns joined"}): Home's controls, 5 taps to upload`, async ({ page }) => {
        await start(page, off ? { off } : {});
        await page.goto("/");
        await ready(page, "youtube", "instagram");
        await homeIsFrozen(page);
        await normalWay(page);
      });
    }

    test("a normal clip with a fitting campaign: exactly two more optional controls, still 5 taps", async ({ page }) => {
      await start(page, { remake: true });
      await page.goto("/");
      await ready(page, "youtube", "instagram");
      await homeIsFrozen(page);
      await normalWay(page, NORMAL_REVIEW_EXTRA);
    });

    test("the campaign way: 6 taps from the row chip, the main button reading Make campaign clips", async ({ page }) => {
      await start(page);
      await page.goto("/");
      await ready(page, "youtube", "instagram");
      const taps = tap(CAMPAIGN_WAY_TAPS);
      await page.goto("/");
      await settle(page);
      const chip = page.locator(`.cr-row-chip[data-campaign='${FAZE}']`);
      await expect(chip).toContainText("FaZe Clips");
      await expect(chip).toContainText("Make campaign clips");
      await expect(page.locator(".cr-row")).toContainText("Tap a campaign to make clips for it.");
      await taps.tap(chip, "FaZe Clips · Make campaign clips");
      await expect(page).toHaveURL(new RegExp(`/\\?campaign=${FAZE}$`));
      await expect(page.locator(".cr-way")).toContainText("Campaign clips · FaZe Clips");
      await expect(page.locator(".cr-way")).toContainText(/Clip Factory follows its \d+ rules on every clip\./);
      await expect(page.locator(".cr-way__lines")).toContainText("FaZe Clips pays only for clips of FaZe Clan's YouTube and Twitch.");
      await copy(page, VIDEO);
      await taps.tap(page.locator("form.newjob").getByRole("button", { name: "Paste", exact: true }));
      const make = page.locator("form.newjob").getByRole("button", { name: "Make campaign clips", exact: true });
      await expect(make).toBeEnabled();
      await taps.tap(make);
      await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
      await jobRuns(page);
      await taps.tap(page.getByRole("link", { name: "Check these clips" }), "Go to Review");
      const card = page.locator(".review-card").first();
      await expect(card.locator(".cr-fit")).toContainText("Can earn on FaZe Clips");
      // A deleted tag still uploads in 6: the upload puts it back ("Fix it for me" is optional).
      await card.locator("[data-place='instagram'] summary").click();
      const ig = card.getByLabel("Instagram caption");
      await ig.fill((await ig.inputValue()).replace("#FaZe", "").trim());
      await expect(card.locator(".cr-fit")).toContainText("The Instagram words are missing #FaZe.");
      await expect(card.locator(".cr-fit")).toContainText("Can earn on FaZe Clips");
      await taps.tap(card.locator("[data-help='use-my-settings'] button"), "Use my settings");
      const upload = card.getByRole("button", { name: /^Upload to 2$/ });
      await expect(upload).toHaveClass(/btn--primary/);
      await taps.tap(upload);
      await expect(page.getByText(/^Uploading to/)).toBeVisible();
      expect(taps.count).toBe(CAMPAIGN_WAY_TAPS);
    });

    test("the copy: Make a GameFuel Clips copy arrives right after its original by live news, then 3 taps", async ({ page }) => {
      await start(page, { remake: true });
      await page.goto("/");
      await ready(page, "youtube", "instagram");
      await page.goto("/");
      await settle(page);
      await copy(page, VIDEO);
      await page.locator("form.newjob").getByRole("button", { name: "Paste", exact: true }).click();
      await page.locator("form.newjob").getByRole("button", { name: "Make clips", exact: true }).click();
      await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
      await jobRuns(page);
      await page.getByRole("link", { name: "Check these clips" }).click();
      const first = page.locator(".review-list__item").first();
      const line = first.locator(".cr-suggest");
      await expect(line).toContainText(/This clip could earn money on .+\./);
      const before = await page.locator(".review-list__item").count();
      const taps = tap(COPY_TAPS);
      await taps.tap(line.getByRole("button", { name: /^Make a .+ copy$/ }));
      await expect(line).toContainText(/Making a .+ copy… It shows here in about 3 minutes\./);
      await expect(page.locator(".review-list__item")).toHaveCount(before + 1, { timeout: 15_000 });
      const copyCard = page.locator(".review-list__item").nth(1).locator(".review-card");
      await expect(copyCard.locator(".cr-fit")).toContainText(/Campaign clip · /);
      await expect(line).toContainText(/The .+ copy is ready, right below\. Upload the copy to earn money\. You can throw this one away\./);
      await taps.tap(copyCard.locator("[data-help='use-my-settings'] button"), "Use my settings");
      await taps.tap(copyCard.getByRole("button", { name: /^Upload to 2$/ }));
      await expect(page.getByText(/^Uploading to/)).toBeVisible();
      expect(taps.count).toBe(COPY_TAPS);
    });
  });
}

test.describe("Connect Content Rewards: the taps (desktop, the Mac app)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function pasteAndAdd(page: Page, taps: ReturnType<typeof tap>) {
    // He posts to YouTube and Instagram from Clip Factory already (the places a campaign pays for).
    await page.goto("/");
    await ready(page, "youtube", "instagram");
    await page.goto("/");
    await settle(page);
    await copy(page, FAZE_URL);
    await taps.tap(page.locator("form.newjob").getByRole("button", { name: "Paste", exact: true }));
    await taps.tap(page.locator("form.newjob").getByRole("button", { name: "Add campaign", exact: true }));
    await expect(page).toHaveURL(new RegExp(`/campaigns/${FAZE}$`));
    const next = page.locator("[data-help='cr-next-step']");
    await expect(next).toContainText("Connect Content Rewards so I can see if you're in.");
    await taps.tap(next.getByRole("link", { name: "Connect Content Rewards" }));
    await expect(page).toHaveURL(/\/settings\/posting\/setup\/contentrewards\?back=/);
  }

  async function allowAndBack(page: Page, taps: ReturnType<typeof tap>) {
    const popup = page.waitForEvent("popup");
    await taps.tap(page.locator("#step-connect").getByRole("button", { name: "Connect Content Rewards", exact: true }));
    const consent = await popup;
    taps.outside("the pretend allow page: Allow");
    await consent.getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".result-card")).toContainText("Content Rewards is connected!");
    await expect(page.locator(".result-card")).toContainText("Next: back to FaZe Clips.");
    const back = page.locator("[data-cr='back']");
    await expect(back).toHaveText(/Back to FaZe Clips/);
    await expect(back).toHaveClass(/btn--primary/);
  }

  test("already set up on Content Rewards: 7 taps with the Yes shortcut", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    const taps = tap(CONNECT_TAPS_DONE);
    await pasteAndAdd(page, taps);
    await expect(page.locator("[data-cr='shortcut']")).toContainText(/Already use Content Rewards, with .+\?/);
    await taps.tap(page.locator("[data-cr='shortcut']").getByRole("button", { name: "Yes" }));
    await expect(page.locator("[data-cr='shortcut']")).toHaveCount(0);
    await allowAndBack(page, taps);
    await knob(page, "join", FAZE);
    await taps.tap(page.locator("[data-cr='back']"));
    await expect(page).toHaveURL(new RegExp(`/campaigns/${FAZE}$`));
    await expect(page.locator("[data-help='cr-next-step']")).toContainText("You're in!");
    expect(taps.count).toBe(CONNECT_TAPS_DONE);
  });

  test("already set up, without the shortcut: 8 taps (I have an account, I added them)", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    const taps = tap(CONNECT_TAPS_DONE + 1);
    await pasteAndAdd(page, taps);
    await taps.tap(page.locator("#step-ready-account").getByRole("button", { name: "I have an account" }));
    await taps.tap(page.locator("#step-ready-socials").getByRole("button", { name: "I added them" }));
    await allowAndBack(page, taps);
    await knob(page, "join", FAZE);
    await taps.tap(page.locator("[data-cr='back']"));
    await expect(page.locator("[data-help='cr-next-step']")).toContainText("You're in!");
    expect(taps.count).toBe(CONNECT_TAPS_DONE + 1);
  });

  test("from zero: 9 Clip Factory taps and the allow up to Back to FaZe Clips, then Open campaign and You're in!", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    const taps = tap(CONNECT_CF_TAPS_FROM_ZERO + 1);
    await pasteAndAdd(page, taps);
    const one = page.locator("#step-ready-account");
    let popup = page.waitForEvent("popup");
    await taps.tap(one.getByRole("link", { name: /Open Content Rewards/ }));
    await (await popup).close();
    await taps.tap(one.getByRole("button", { name: "I have an account" }));
    const two = page.locator("#step-ready-socials");
    popup = page.waitForEvent("popup");
    await taps.tap(two.getByRole("link", { name: /Open Content Rewards settings/ }));
    await (await popup).close();
    await taps.tap(two.getByRole("button", { name: "I added them" }));
    await allowAndBack(page, taps);
    await taps.tap(page.locator("[data-cr='back']"));
    expect(taps.count).toBe(CONNECT_CF_TAPS_FROM_ZERO);
    const next = page.locator("[data-help='cr-next-step']");
    await expect(next).toContainText("Not joined yet");
    popup = page.waitForEvent("popup");
    await taps.tap(next.getByRole("link", { name: /Open campaign/ }));
    await (await popup).close();
    await knob(page, "join", FAZE);
    // Coming back to the window: the card checks by itself.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(next).toContainText("You're in!");
    expect(taps.count).toBe(CONNECT_CF_TAPS_FROM_ZERO + 1);
  });
});
