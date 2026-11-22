import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle } from "./helpers.ts";

// The campaign finder (docs/CONTRACTS.md §41, §41.6 Tests), in mock mode: never started → defaults → "Find campaigns
// for me" → looking → six matches; "Who can join" brings the apply ones; Open → I joined: add it → the card; signed
// in, back to the window → "You're in!" → Reading the rules… → Make clips; Home's chips and the Campaigns card; the
// notification's page; 404, 503 and switched off hide every entry; and on every new screen: no sideways scroll, no
// edges, big targets, the arrow cursor, AA contrast light and dark, reduced motion, the vermilion bottom right and on
// screen at 375 and 1440 (the Find page pins it at every width) and Ask never over it.

const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;
const FIND = "/campaigns/find";

const IDS = {
  fundingpips: "c0c37381-e244-4643-98bd-edbff4bc1465",
  pickleball: "3d9ef19f-1256-47ca-b630-e33e2c923969",
  ungodly: "0d341d7d-e390-4807-9149-9b5294dff3e6",
  hablando: "e815a623-badd-4516-906c-b6cfce227ff9",
};
const DEFAULT_ORDER = [
  "Fundingpips Clipping",
  "Call of Duty - MW4 DMZ Intel Briefing Clipping",
  "Clip Pro Pickleball: CNPL Rallies & Highlights",
  "Santa Cruz Medicinals Clipping",
  "ENERGY DRINKS -  Beverages",
  "$3,000 8lanco 'Every Little Thing' Sound Campaign",
];

type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { cr?: Knobs; setup?: Knobs; finder?: Knobs }; __cfMockCalls?: Record<string, number> };

async function start(page: Page, flags: { fresh?: boolean; off?: "404" | "503" } = {}) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("cf-e2e-finder-init")) return;
    sessionStorage.setItem("cf-e2e-finder-init", "1");
    if (f.fresh) sessionStorage.setItem("cf-mock-cr-start", "fresh");
    if (f.off) sessionStorage.setItem("cf-mock-cr-off", f.off);
  }, flags);
}
async function mock(page: Page) {
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.finder && !!(window as MockWin).__cfMock?.setup && !!(window as MockWin).__cfMock?.cr);
}
const knob = (page: Page, part: "finder" | "cr" | "setup", fn: string, ...args: unknown[]) =>
  page.evaluate(([part, fn, args]) => (window as MockWin).__cfMock![part as "finder"]![fn as string]!(...(args as unknown[])), [part, fn, args] as const);
const calls = (page: Page, name: string) => page.evaluate((n) => (window as MockWin).__cfMockCalls?.[n] ?? 0, name);
/** YouTube, Instagram, Facebook and X set up; TikTok waits for its audit (the golden cases' places). */
async function fourPlaces(page: Page) {
  await page.goto("/");
  await settle(page);
  await mock(page);
  await page.evaluate(() => {
    for (const p of ["youtube", "instagram", "facebook", "x"]) (window as MockWin).__cfMock!.setup!.finish!(p);
  });
}
const tomatoes = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });
const names = (page: Page) => page.locator(".finder-match__name");

/** Never started → the defaults → Find campaigns for me → looking → the matches. */
async function firstLook(page: Page) {
  await page.goto(FIND);
  await settle(page);
  await page.getByRole("button", { name: "Find campaigns for me" }).click();
  await expect(names(page)).toHaveCount(6, { timeout: 15_000 });
}

/** Everything §41.6 asks of a new screen, as a list of problems. */
async function screenProblems(page: Page, phone: boolean): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`sideways scroll ${o.page} > ${o.viewport}`);
  const bad = await page.evaluate((min) => {
    const found: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>("main button, main a.btn, main summary, main .check-chip, main .segmented__opt")) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      // The switch draws 34 px and takes taps on 48 × 64 px (its ::before, components.css).
      const tall = e.classList.contains("switch") ? b.height + 14 : b.height;
      if (tall < min - 0.5) found.push(`"${name}" is ${Math.round(b.width)}x${Math.round(b.height)}`);
      const cur = getComputedStyle(e).cursor;
      if (cur !== "auto" && cur !== "default") found.push(`"${name}" has cursor ${cur}`);
    }
    const redFill = (e: HTMLElement) => {
      const cs = getComputedStyle(e);
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(`${cs.backgroundImage} ${cs.backgroundColor}`);
      return !!m && Number(m[1]) > 150 && Number(m[2]) < 90 && Number(m[3]) < 80;
    };
    const red = [...document.querySelectorAll<HTMLElement>(".btn, .linkbox__paste")].filter((e) => e.getBoundingClientRect().height > 0 && !e.closest(".update-bar") && redFill(e));
    if (red.length > 1) found.push(`${red.length} vermilion buttons: ${red.map((e) => e.textContent?.trim()).join(" | ")}`);
    return found;
  }, phone ? 48 : 44);
  out.push(...bad);
  out.push(...(await visibleEdges(page)).filter((e) => /finder|cr-|campaign|check-chip|segmented/.test(e)));
  return out;
}

/** The vermilion: at the right, on screen (on the first screen when `first`, else once scrolled to), Ask clear. */
async function mainOnTheRight(page: Page, first = true): Promise<string[]> {
  const main = tomatoes(page);
  if (!(await main.count())) return [];
  if (!first) await main.first().scrollIntoViewIfNeeded();
  const box = (await main.first().boundingBox())!;
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  const out: string[] = [];
  if (box.x + box.width < vw / 2) out.push("the main button is not on the right");
  if (box.y < 0 || box.y + box.height > vh) out.push(`the main button is off screen (${Math.round(box.y)})`);
  // Ask fades out in place once the page is still (dodge.ts: 260 ms, held 1 s), so it is given a moment.
  const coveredNow = () => page.evaluate(() => {
    const u = document.querySelector<HTMLElement>("main .btn--primary")?.getBoundingClientRect();
    const el = document.querySelector<HTMLElement>(".help-launcher");
    if (!u || !el) return false;
    const l = el.getBoundingClientRect();
    const touches = !(l.right <= u.left || l.left >= u.right || l.bottom <= u.top || l.top >= u.bottom);
    return touches && getComputedStyle(el).pointerEvents !== "none" && !el.classList.contains("is-hidden") && Number(getComputedStyle(el).opacity) > 0.1;
  });
  let covered = await coveredNow();
  for (let i = 0; covered && i < 25; i++) {
    await page.waitForTimeout(200);
    covered = await coveredNow();
  }
  if (covered) out.push("Ask sits over the main button");
  return out;
}

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  const phone = name === "phone";
  test.describe(`${name}`, () => {
    test.use(use);

    test("never started → the defaults → Find campaigns for me → looking → six matches, one vermilion", async ({ page }) => {
      await start(page);
      await fourPlaces(page);
      await page.goto(FIND);
      await settle(page);
      const want = page.locator("[data-help='cr-finder-want']");
      await expect(want).toContainText("What you want");
      await expect(want.getByRole("radio", { name: "$1", exact: true })).toBeChecked();
      await expect(want.getByRole("radio", { name: "Some left" })).toBeChecked();
      await expect(want.getByRole("radio", { name: "Anyone can join" })).toBeChecked();
      await expect(want).toContainText("The places you set up.");
      await expect(want.getByRole("button", { name: /TikTok/ })).toHaveAttribute("aria-disabled", "true");
      await expect(want).toContainText("TikTok: not yet.");
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Find campaigns for me/);
      expect(await screenProblems(page, phone)).toEqual([]);
      expect(await mainOnTheRight(page)).toEqual([]);
      await tomatoes(page).click();
      await expect(page.getByText("Looking at Content Rewards' campaigns… This takes a minute or two.")).toBeVisible();
      await expect(tomatoes(page)).toHaveCount(0);
      await expect(names(page)).toHaveText(DEFAULT_ORDER, { timeout: 15_000 });
      // The first match is open; its Open on Content Rewards is the screen's one vermilion; every match has Open.
      await expect(page.locator(".finder-match.is-open")).toHaveCount(1);
      await expect(page.locator(".finder-match").first()).toHaveClass(/is-open/);
      await expect(page.locator(".finder-match").getByRole("link", { name: /Open on Content Rewards/ })).toHaveCount(6);
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Open on Content Rewards/);
      await expect(page.locator(".finder-match").first()).toContainText("Pays $6.00 per 1,000 views on YouTube and Instagram. Some of the money is left. Anyone can join.");
      await expect(page.locator(".finder-match").first()).toContainText("Content Rewards' numbers");
      // Tapping another head opens it and folds the rest; the vermilion moves with it.
      await page.locator(".finder-match").nth(2).locator(".finder-match__head").click();
      await expect(page.locator(".finder-match").nth(2)).toHaveClass(/is-open/);
      await expect(page.locator(".finder-match.is-open")).toHaveCount(1);
      await expect(page.locator(".finder-match").nth(2).locator(".btn--primary")).toHaveCount(1);
      await expect(tomatoes(page)).toHaveCount(1);
      expect(await screenProblems(page, phone)).toEqual([]);
      expect(await mainOnTheRight(page)).toEqual([]);
    });

    test("signed in, a match that isn't the first: back from Content Rewards, the You're in! row comes into view", async ({ page, context }) => {
      await start(page);
      await fourPlaces(page);
      await firstLook(page);
      const pickle = page.locator(".finder-match", { hasText: "Clip Pro Pickleball" });
      await pickle.locator(".finder-match__head").click();
      await knob(page, "finder", "joinedOnCr", IDS.pickleball);
      const popup = context.waitForEvent("page");
      await pickle.getByRole("link", { name: /Open on Content Rewards/ }).click();
      await (await popup).close();
      await expect.poll(() => calls(page, "crFinderSaid")).toBeGreaterThanOrEqual(1);
      // Where the window was: the Pickleball card, well below the top of the page.
      await pickle.getByRole("link", { name: /Open on Content Rewards/ }).scrollIntoViewIfNeeded();
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      const row = page.locator(".finder-in").first();
      await expect(row).toContainText("You're in! Clip Pro Pickleball: CNPL Rallies & Highlights is in your campaigns.");
      await expect(page.locator(".finder-match.is-open")).toHaveCount(0);
      const vh = page.viewportSize()!.height;
      await expect
        .poll(async () => {
          const b = await row.locator(".finder-in__main .btn").boundingBox();
          return !!b && b.y >= 0 && b.y + b.height <= vh;
        })
        .toBe(true);
      await expect(row.locator(".finder-in__main .btn")).toBeFocused();
    });

    test("Who can join › Also ones I apply to brings UnGodly and Hablando", async ({ page }) => {
      await start(page);
      await fourPlaces(page);
      await firstLook(page);
      await page.getByRole("button", { name: "Change" }).click();
      await page.locator("[data-help='cr-finder-want']").locator(".segmented__opt", { hasText: "Also ones I apply to" }).click();
      await expect(page.getByText("Updating your matches…")).toBeVisible();
      await expect(names(page)).toHaveCount(8, { timeout: 15_000 });
      await expect(names(page).nth(4)).toHaveText("Clips Hablando - 1$ por cada 1000 visitas");
      await expect(names(page).nth(5)).toHaveText("UnGodly Mobile RPG | Boss Fights & Clutch Plays");
      await expect(page.locator(".finder-match").nth(5)).toContainText("You apply first");
      expect(await calls(page, "crPatchFinder")).toBeGreaterThanOrEqual(2);
      await page.locator("[data-help='cr-finder-want']").getByRole("button", { name: "Done" }).click();
      await expect(page.locator("[data-help='cr-finder-want']")).toContainText("At least $1 per 1,000 views · YouTube, Instagram, Facebook, X · Some money left · Also ones I apply to");
    });
  });
}

test.describe("desktop journeys", () => {
  test.use(DESKTOP);

  test("Open (a new page, opened sent) → I joined: add it → the campaign card", async ({ page, context }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    const first = page.locator(".finder-match").first();
    const popup = context.waitForEvent("page");
    await first.getByRole("link", { name: /Open on Content Rewards/ }).click();
    const tab = await popup;
    expect(tab.url()).toContain(`contentrewards.com/c/campaigns/${IDS.fundingpips}`);
    await tab.close();
    await expect.poll(() => calls(page, "crFinderSaid")).toBeGreaterThanOrEqual(1);
    // Signed in: two steps, and "I joined: add it" is the vermilion now (Open stays, glass).
    await expect(first).toContainText("Tap Join Campaign.");
    await expect(first).toContainText("Does the big button now say Submit clip? Then tap I joined: add it.");
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/I joined: add it/);
    await expect(first.getByRole("link", { name: /Open on Content Rewards/ })).toHaveClass(/btn--glass/);
    await first.locator("summary", { hasText: "If you see…" }).click();
    await expect(first).toContainText("If you see Hold to confirm: Press and hold it.");
    await expect(first).toContainText("If you see Submit clip: You're in already. Tap I joined: add it.");
    await tomatoes(page).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${IDS.fundingpips}$`));
    await expect(page.locator(".cr-head")).toContainText("Fundingpips Clipping");
    await expect(page.locator("[data-help='cr-next-step']")).toContainText("Checking that you joined… This can take a few minutes.");
  });

  test("not signed in: the rules box, then I joined: add it reads the pasted rules", async ({ page, context }) => {
    await start(page);
    await fourPlaces(page);
    await knob(page, "finder", "signedIn", false);
    await firstLook(page);
    const first = page.locator(".finder-match").first();
    // The steps go with him: shown before Open, under On Content Rewards:.
    await expect(first.locator(".finder-steps")).toContainText("On Content Rewards:");
    await expect(first.locator(".finder-steps")).toContainText("Copy everything under Brief and Content requirements.");
    const popup = context.waitForEvent("page");
    await first.getByRole("link", { name: /Open on Content Rewards/ }).click();
    await (await popup).close();
    await expect(first).toContainText("Copy everything under Brief and Content requirements.");
    await expect(page.locator("[data-help='cr-finder-ask']")).toHaveCount(0);
    // The box empty: no vermilion; I joined: add it waits, glass, right under the box.
    await expect(tomatoes(page)).toHaveCount(0);
    await expect(first.getByRole("button", { name: "I joined: add it" })).toHaveClass(/btn--glass/);
    await first.getByLabel("The campaign's rules").fill("Clips 20 to 60 seconds. Use #Funding in every caption.");
    await expect(tomatoes(page)).toHaveText(/I joined: add it/);
    expect(await mainOnTheRight(page)).toEqual([]);
    await first.getByRole("button", { name: "I joined: add it" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${IDS.fundingpips}$`));
    await expect.poll(() => calls(page, "crReadCampaign")).toBeGreaterThanOrEqual(1);
    await expect(page.locator(".cr-head")).toContainText("Fundingpips Clipping");
  });

  for (const how of ["visibilitychange", "focus"] as const)
    test(`signed in: joined on Content Rewards, back to the window (${how}) → You're in! → Reading the rules… → Make clips`, async ({ page, context }) => {
      await start(page);
      await fourPlaces(page);
      await firstLook(page);
      const pickle = page.locator(".finder-match", { hasText: "Clip Pro Pickleball" });
      await pickle.locator(".finder-match__head").click();
      await knob(page, "finder", "joinedOnCr", IDS.pickleball);
      const popup = context.waitForEvent("page");
      await pickle.getByRole("link", { name: /Open on Content Rewards/ }).click();
      await (await popup).close();
      await expect.poll(() => calls(page, "crFinderSaid")).toBeGreaterThanOrEqual(1);
      await page.evaluate((h) => {
        if (h === "focus") window.dispatchEvent(new Event("focus"));
        else document.dispatchEvent(new Event("visibilitychange"));
      }, how);
      const row = page.locator(".finder-in");
      await expect(row).toContainText("You're in! Clip Pro Pickleball: CNPL Rallies & Highlights is in your campaigns.");
      await expect(row.getByRole("button", { name: "Reading the rules… (about 30 seconds)" })).toHaveAttribute("aria-disabled", "true");
      await expect(tomatoes(page)).toHaveCount(0);
      // The live update turns it into the vermilion; a refetch of the finder (the match is gone) keeps the row.
      await expect(row.getByRole("link", { name: "Make clips for this campaign" })).toHaveClass(/btn--primary/, { timeout: 10_000 });
      await knob(page, "finder", "newMatches", 0);
      await page.waitForTimeout(1500);
      await expect(row.getByRole("link", { name: "Make clips for this campaign" })).toBeVisible();
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(page.locator(".finder-match", { hasText: "Clip Pro Pickleball" })).toHaveCount(0);
      await row.getByRole("link", { name: "Make clips for this campaign" }).click();
      await expect(page).toHaveURL(new RegExp(`/\\?campaign=${IDS.pickleball}$`));
    });

  test("signed in, half the money used: the row says so and Make clips anyway goes straight to Make clips", async ({ page, context }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    const first = page.locator(".finder-match").first();
    await knob(page, "finder", "joinedOnCr", IDS.fundingpips);
    const popup = context.waitForEvent("page");
    await first.getByRole("link", { name: /Open on Content Rewards/ }).click();
    await (await popup).close();
    await expect.poll(() => calls(page, "crFinderSaid")).toBeGreaterThanOrEqual(1);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const row = page.locator(".finder-in", { hasText: "Fundingpips Clipping" });
    const anyway = row.getByRole("button", { name: "Make clips anyway" });
    await expect(anyway).toHaveClass(/btn--primary/, { timeout: 15_000 });
    await expect(row.locator(".finder-in__sub")).not.toBeEmpty();
    await expect(tomatoes(page)).toHaveCount(1);
    await anyway.click();
    await expect(page).toHaveURL(new RegExp(`/\\?campaign=${IDS.fundingpips}$`));
  });

  test("an application: the apply steps with the Copy chips, then I applied: add it waits for the brand", async ({ page, context }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    await page.getByRole("button", { name: "Change" }).click();
    await page.locator("[data-help='cr-finder-want']").locator(".segmented__opt", { hasText: "Also ones I apply to" }).click();
    const ungodly = page.locator(".finder-match", { hasText: "UnGodly" });
    await expect(ungodly).toHaveCount(1, { timeout: 15_000 });
    await ungodly.locator(".finder-match__head").click();
    const popup = context.waitForEvent("page");
    await ungodly.getByRole("link", { name: /Open on Content Rewards/ }).click();
    await (await popup).close();
    await expect(ungodly).toContainText("Tap Apply.");
    await expect(ungodly).toContainText("Tap Submit application.");
    await expect(ungodly).toContainText("Your YouTube link");
    await ungodly.getByRole("button", { name: "I applied: add it" }).click();
    await expect(page).toHaveURL(new RegExp(`/campaigns/${IDS.ungodly}$`));
    await expect(page.locator(".cr-chip")).toHaveText("Waiting for the brand");
  });

  test("Not for me hides the open match, opens the next, and Undo brings it back", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    await page.locator(".finder-match").first().getByRole("button", { name: "Not for me" }).click();
    await expect(page.locator(".toast", { hasText: "Hidden." })).toBeVisible();
    await expect(names(page).first()).toHaveText(DEFAULT_ORDER[1]!);
    await expect(page.locator(".finder-match").first()).toHaveClass(/is-open/);
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(names(page).first()).toHaveText(DEFAULT_ORDER[0]!, { timeout: 15_000 });
  });

  test("Why not more? says what was skipped, with Content Rewards' numbers only", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    await page.locator("summary", { hasText: "Why not more?" }).click();
    const fold = page.locator(".finder-why-not");
    await expect(fold).toContainText("I looked at 15 campaigns. 6 match.");
    await expect(fold).toContainText("4 need something Clip Factory can't make.");
    await expect(fold).toContainText("2 want you to apply first.");
    await expect(fold).toContainText("1 campaign pays per post or shares a prize.");
  });

  test("Home: the '3 new campaigns match' chip, and 'Find campaigns' never started; the Campaigns card", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    // Never started: the row's last chip is Find campaigns; the Campaigns card asks what he wants.
    await expect(page.locator(".cr-row-chip.is-find")).toHaveText("Find campaigns");
    await expect(page.locator(".cr-row li").last()).toContainText("Find campaigns");
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator("[data-help='cr-finder-entry']")).toContainText("Tell me what you want. I'll find campaigns that pay for it.");
    await expect(page.locator("[data-help='cr-finder-entry'] a.btn")).toHaveClass(/btn--glass/);
    await mock(page);
    await knob(page, "finder", "newMatches", 3);
    await expect(page.locator("[data-help='cr-finder-entry']")).toContainText("3 new campaigns match what you want.");
    await expect(page.locator("[data-help='cr-finder-entry']")).toContainText("New");
    await page.goto("/");
    await settle(page);
    const chip = page.locator(".cr-row-chip.is-find").first();
    await expect(chip).toHaveText("3 new campaigns match");
    await expect(page.locator(".cr-row li").first()).toContainText("3 new campaigns match");
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`${FIND}$`));
    await expect(page.locator(".finder-new")).toHaveCount(3);
    // seenAll after 2 s: Home's chip says new no more, the page's New chips stay for the visit.
    await expect.poll(() => calls(page, "crPatchFinder"), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    await expect(page.locator(".finder-new")).toHaveCount(3);
    await page.goto("/");
    await settle(page);
    await expect(page.locator(".cr-row-chip.is-find")).toHaveText("Find campaigns");
  });

  test("the notification's page: /campaigns/find opens the Find page with the matches", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    await knob(page, "finder", "newMatches", 1);
    // The push's url (§41.4) is a plain path the service worker keeps as it is.
    expect(/^\/[A-Za-z0-9/_-]*$/.test(FIND)).toBe(true);
    await page.goto(FIND);
    await settle(page);
    await expect(page.getByRole("heading", { name: "Find campaigns", level: 1 })).toBeVisible();
    await expect(names(page)).toHaveCount(6);
    await expect(page.locator(".finder-new")).toHaveCount(1);
  });

  test("stopped: no match shows, Find campaigns again is the vermilion; Home and the card say so", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    await page.getByRole("button", { name: "Stop finding campaigns" }).click();
    await expect(page.getByText("You stopped finding campaigns.").first()).toBeVisible();
    await expect(names(page)).toHaveCount(0);
    await expect(tomatoes(page)).toHaveText(/Find campaigns again/);
    await page.goto("/");
    await settle(page);
    await expect(page.locator(".cr-row-chip.is-find")).toHaveCount(0);
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator("[data-help='cr-finder-entry']")).toContainText("You stopped finding campaigns.");
    await page.goto(FIND);
    await settle(page);
    await tomatoes(page).click();
    await expect(names(page)).toHaveCount(6, { timeout: 15_000 });
  });

  for (const [state, words] of [
    ["down", "Content Rewards didn't answer. I'll try again in a few hours."],
    ["blocked", "Content Rewards isn't letting Clip Factory look right now. Tap Look on Content Rewards yourself."],
    ["not_allowed", "Content Rewards asked apps not to read its campaign pages. Tap Look on Content Rewards yourself."],
    ["unreadable", "I can't read Content Rewards' campaign pages right now. Tap Look on Content Rewards yourself."],
  ] as const)
    test(`${state}: its sentence, the stored matches "As of", the open match keeps the vermilion`, async ({ page }) => {
      await start(page);
      await fourPlaces(page);
      await firstLook(page);
      await knob(page, "finder", "setState", state);
      await expect(page.getByText(words)).toBeVisible({ timeout: 5000 });
      await expect(page.locator(".finder-asof")).toContainText(/^As of \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} [ap]m$/);
      await expect(names(page)).toHaveCount(6);
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Open on Content Rewards/);
    });

  test("no place set up: Set up a place to post first, and Set up YouTube is the vermilion", async ({ page }) => {
    await start(page);
    await page.goto(FIND);
    await settle(page);
    await expect(page.getByText("Set up a place to post first. Then I can find campaigns that pay for it.")).toBeVisible();
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/Set up YouTube/);
    await expect(tomatoes(page)).toHaveAttribute("href", "/settings/posting/setup/youtube?back=/campaigns/find");
    expect(await mainOnTheRight(page)).toEqual([]);
    await expect(page.getByRole("link", { name: "Set up a place", exact: true })).toHaveAttribute("href", "/settings/posting/setup/youtube?back=/campaigns/find");
  });

  test("Set up another place opens a place's own setup, which leads back to Find campaigns", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await settle(page);
    await mock(page);
    await page.evaluate(() => (window as MockWin).__cfMock!.setup!.finish!("youtube"));
    await page.goto(FIND);
    await settle(page);
    const link = page.getByRole("link", { name: "Set up another place" });
    await expect(link).toHaveAttribute("href", "/settings/posting/setup/instagram?back=/campaigns/find");
    await link.click();
    await expect(page).toHaveURL(/\/settings\/posting\/setup\/instagram\?back=\/campaigns\/find$/);
    // He finishes Instagram: the way back is the vermilion.
    await mock(page);
    await page.evaluate(() => (window as MockWin).__cfMock!.setup!.finish!("instagram"));
    await page.reload();
    await settle(page);
    const back = page.locator("[data-setup='back']");
    await expect(back).toHaveText(/Back to Find campaigns/);
    await expect(back).toHaveAttribute("href", FIND);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${FIND}$`));
  });

  test("Ask Content Rewards: only while signed in, one tap, then the date", async ({ page }) => {
    await start(page);
    await fourPlaces(page);
    await firstLook(page);
    const ask = page.locator("[data-help='cr-finder-ask']");
    await expect(ask).toContainText("Clip Factory can't join for you");
    await ask.locator("summary", { hasText: "Show more" }).click();
    await expect(ask).toContainText("This is what Clip Factory sends to Content Rewards' team.");
    await ask.getByRole("button", { name: "Ask Content Rewards" }).click();
    await expect(page.locator(".toast", { hasText: "Sent. Thank you!" })).toBeVisible();
    await expect(ask).toContainText(/You asked Content Rewards on \d{1,2} \w{3}\./);
  });
});

test.describe("switched off and older APIs", () => {
  test.use(DESKTOP);

  async function hidden(page: Page) {
    await page.goto("/");
    await settle(page);
    await expect(page.locator(".cr-row-chip.is-find")).toHaveCount(0);
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator("[data-help='cr-finder-entry']")).toHaveCount(0);
    await page.goto(FIND);
    await settle(page);
    await expect(page.getByText("Find campaigns is coming soon to Clip Factory.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Your campaigns" })).toHaveAttribute("href", "/campaigns");
    await expect(tomatoes(page)).toHaveCount(0);
  }

  test("404 (an API before §38): every entry hides and the page says coming soon", async ({ page }) => {
    await start(page, { off: "404" });
    await hidden(page);
  });

  test("503 (switched off): every entry hides and the page says coming soon", async ({ page }) => {
    await start(page, { off: "503" });
    await hidden(page);
  });

  test("the finder alone switched off (setState unavailable): every entry hides, Find another campaign opens Discover", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await settle(page);
    await mock(page);
    await knob(page, "finder", "setState", "unavailable");
    await hidden(page);
    await expect(page.locator("a", { hasText: "Find another campaign" })).toHaveCount(0);
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator(".cr-below a", { hasText: "Find another campaign" })).toHaveAttribute("href", "https://contentrewards.com/c/discover");
  });

  test("with the finder on, Find another campaign opens the Find page in the same tab", async ({ page }) => {
    await start(page);
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator(".cr-below a", { hasText: "Find another campaign" })).toHaveAttribute("href", FIND);
    await expect(page.locator(".cr-below a", { hasText: "Find another campaign" })).not.toHaveAttribute("target", "_blank");
  });
});

for (const scheme of ["light", "dark"] as const)
  for (const [name, use] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ] as const)
    test.describe(`every finder screen, ${name}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme, reducedMotion: "reduce" });
      test("fits, one vermilion at most, no edges, big targets, the arrow cursor, AA contrast, reduced motion, the phone's main button bottom right", async ({ page, context }) => {
        test.setTimeout(150_000);
        const phone = name === "phone";
        await start(page);
        await fourPlaces(page);
        const failures: string[] = [];
        const check = async (label: string, first = true) => {
          await settle(page);
          for (const p of await screenProblems(page, phone)) failures.push(`${label}: ${p}`);
          const axe = await new AxeBuilder({ page }).include("main").withRules(["color-contrast"]).analyze();
          for (const v of axe.violations) for (const n of v.nodes) failures.push(`${label}: contrast ${n.target.join(" ")}`);
          // Reduced motion: nothing on these screens moves (base.css clamps every transition to 1 ms; a hover the
          // checks above caused may leave such a 1 ms one pending for a frame, which is not motion).
          const moving = await page.evaluate(() =>
            document
              .getAnimations()
              .filter((a) => {
                const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
                const ms = Number(a.effect?.getTiming().duration);
                return !!target?.closest?.(".finder-page, .finder-entry, .cr-row") && a.playState === "running" && !(ms <= 1);
              })
              .map((a) => String(((a.effect as KeyframeEffect).target as Element).className)),
          );
          for (const m of moving) failures.push(`${label}: an animation runs on ${m}`);
          // The Find page pins its vermilion at every width; the other pages only on phones.
          if (phone || page.url().includes(FIND)) for (const p of await mainOnTheRight(page, first)) failures.push(`${label}: ${p}`);
        };
        await page.goto(FIND);
        await check("never started");
        await page.getByRole("button", { name: "Find campaigns for me" }).click();
        await expect(names(page)).toHaveCount(6, { timeout: 15_000 });
        await check("matches");
        const first = page.locator(".finder-match").first();
        const popup = context.waitForEvent("page");
        await first.getByRole("link", { name: /Open on Content Rewards/ }).click();
        await (await popup).close();
        await expect(first.getByRole("button", { name: "I joined: add it" })).toBeVisible();
        await check("opened");
        // What you want opened again sits above the matches: the open match's pinned vermilion shows with its card.
        await page.getByRole("button", { name: "Change" }).click();
        await check("what you want", false);
        await page.goto("/campaigns");
        await check("campaigns");
        await page.goto("/");
        await settle(page);
        const o = await findOverflow(page);
        if (o.page > o.viewport) failures.push(`home: sideways scroll ${o.page} > ${o.viewport}`);
        expect(failures, failures.join("\n")).toEqual([]);
      });
    });

/**
 * The pinned vermilion rides over its card at the bottom right, so on a phone it is over some lines while he scrolls.
 * What the page owes him (§41.1): every line of the open match comes up above the pinned bar at some point of the
 * scroll, a control he focuses is never under it, and the page ends with room for it (so its last lines clear it).
 */
async function pinProblems(page: Page, label: string): Promise<string[]> {
  return page.evaluate(async (label) => {
    const out: string[] = [];
    const tick = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const go = async (y: number) => {
      window.scrollTo({ top: y, behavior: "instant" });
      await tick();
    };
    const pinEl = () => document.querySelector<HTMLElement>(".finder-match.is-open .cr-pin");
    if (!pinEl()) return [`${label}: no pinned vermilion`];
    const over = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * (a.right > b.left && a.left < b.right ? 1 : 0);
    const floor = () => Math.min(innerHeight, document.querySelector<HTMLElement>(".tabbar")?.getBoundingClientRect().top ?? innerHeight);
    // 1. Every line of text in the open match, line by line.
    const body = document.querySelector<HTMLElement>(".finder-match.is-open .finder-match__body")!;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent!.trim() && !n.parentElement!.closest(".cr-pin, .sr-only") && n.parentElement!.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    const lines = (t: Text) => {
      const r = document.createRange();
      r.selectNodeContents(t);
      return [...r.getClientRects()].filter((b) => b.width > 1 && b.height > 1);
    };
    const seen = texts.map((t) => lines(t).map(() => false));
    const max = document.documentElement.scrollHeight - innerHeight;
    for (let y = 0; y <= max + 8; y += 8) {
      await go(Math.min(y, max));
      const pin = pinEl()!.getBoundingClientRect();
      const low = floor();
      texts.forEach((t, i) => {
        lines(t).forEach((b, j) => {
          if (seen[i]![j] === undefined || seen[i]![j]) return;
          if (b.top >= 0 && b.bottom <= low && !over(b, pin)) seen[i]![j] = true;
        });
      });
    }
    texts.forEach((t, i) => seen[i]!.forEach((ok, j) => ok || out.push(`${label}: line ${j + 1} of "${t.textContent!.trim().slice(0, 40)}" never clears the pinned bar`)));
    // 2. A control he focuses is never under the pinned bar (WCAG 2.4.11): the page keeps the bar's lane free.
    const controls = [...body.querySelectorAll<HTMLElement>("a, button, summary, textarea, input")].filter((e) => !e.closest(".cr-pin") && e.getClientRects().length);
    for (const e of controls)
      for (let y = 0; y <= max; y += 160) {
        await go(y);
        (document.activeElement as HTMLElement | null)?.blur?.();
        e.focus();
        await tick();
        const b = e.getBoundingClientRect();
        const hidden = over(b, pinEl()!.getBoundingClientRect());
        // A text box scrolls only its caret's line into view: most of it shows, the line he types on included.
        const field = e.tagName === "TEXTAREA" || e.tagName === "INPUT";
        if (hidden > (field ? b.height / 2 : Math.max(2, b.height * 0.2))) {
          out.push(`${label}: "${(e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 30)}" focused at ${y} is ${Math.round(hidden)} px under the pinned bar`);
          break;
        }
      }
    // 3. Room at the end for the pinned bar (its height and 12 px), and the last line clears its lane.
    const pageEl = document.querySelector<HTMLElement>(".finder-page")!;
    const pin = pinEl()!;
    const room = parseFloat(getComputedStyle(pageEl).paddingBottom);
    if (room < pin.getBoundingClientRect().height + 12 - 0.5) out.push(`${label}: only ${room} px of room under the page for a ${Math.round(pin.getBoundingClientRect().height)} px pinned bar`);
    await go(max);
    const lane = innerHeight - parseFloat(getComputedStyle(pin).bottom) - pin.getBoundingClientRect().height;
    const last = [...pageEl.querySelectorAll<HTMLElement>("*")].filter((e) => !e.children.length && e.getClientRects().length).pop()!;
    if (last.getBoundingClientRect().bottom > lane) out.push(`${label}: the page's last line (${Math.round(last.getBoundingClientRect().bottom)}) is in the pinned bar's lane (${Math.round(lane)})`);
    await go(0);
    return out;
  }, label);
}

for (const [width, height] of [
  [320, 568],
  [375, 812],
  [430, 932],
] as const)
  test.describe(`phone ${width} px: the pinned vermilion never hides a line`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test("before Open, after Open signed in, and after Open by hand with the rules pasted", async ({ page, context }) => {
      test.setTimeout(150_000);
      await start(page);
      await fourPlaces(page);
      await knob(page, "finder", "signedIn", false);
      await firstLook(page);
      await settle(page);
      const failures: string[] = [];
      failures.push(...(await pinProblems(page, "before Open")));
      const first = page.locator(".finder-match").first();
      const popup = context.waitForEvent("page");
      await first.getByRole("link", { name: /Open on Content Rewards/ }).click();
      await (await popup).close();
      await first.getByLabel("The campaign's rules").fill("Clips 20 to 60 seconds. Use #Funding in every caption.");
      await expect(tomatoes(page)).toHaveText(/I joined: add it/);
      await first.locator("summary", { hasText: "If you see…" }).click();
      failures.push(...(await pinProblems(page, "by hand, rules pasted")));
      await knob(page, "finder", "signedIn", true);
      await expect(first).toContainText("Does the big button now say Submit clip? Then tap I joined: add it.");
      failures.push(...(await pinProblems(page, "signed in, opened")));
      expect(failures, failures.join("\n")).toEqual([]);
    });
  });

test("no sideways scroll from 320 to 1920 on the Find page", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await fourPlaces(page);
  await firstLook(page);
  const failures: string[] = [];
  for (const width of [320, 360, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const open of [false, true]) {
      await page.goto(FIND);
      await settle(page);
      if (open) await page.getByRole("button", { name: "Change" }).click();
      const o = await findOverflow(page);
      if (o.page > o.viewport) failures.push(`${width}${open ? " (want open)" : ""}: ${o.page} > ${o.viewport}`);
    }
  }
  expect(failures).toEqual([]);
});
