// Lamo Stories studio screens in mock mode (docs/CONTRACTS.md §45.16.5, §45.16.6, §45.19): every Ideas, Characters,
// Production and Review page fits from 320 px (no sideways scroll), draws no edges, keeps the arrow cursor, reaches AA
// contrast and has targets of 44 px (48 on phones), every pick-one bar has its sliding highlight, and the whole flow
// works: idea → character → production → review → approve → the publish sheet (only connected accounts, nothing chosen
// until tapped, Use my settings, Post it). Needs the Lamo Stories shell and the mock's workspace, social and
// publishing parts (builder F) and the engine (builder D); the mock runs every job in a few seconds.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow } from "./helpers.ts";

/** The mock's seeded ids (SEED_IDS in src/stories/api/mock/stories.ts; test/storiesStudioMock.test.tsx keeps them equal). */
const S = { review: "01JSTST0000000000000000001", needsCheck: "01JSTST0000000000000000002", approved: "01JSTST0000000000000000003", failed: "01JSTST0000000000000000007" };
const I = { deer: "01JSTDE0000000000000000008" };
const C = { pip: "01JSTCH0000000000000000001" };

const PAGES: [string, string][] = [
  ["Ideas", "/stories/ideas"],
  ["Characters", "/stories/characters"],
  ["New character", "/stories/characters/new"],
  ["A character", `/stories/characters/${C.pip}`],
  ["Production", "/stories/production"],
  ["New video", `/stories/production/new?idea=${I.deer}`],
  ["A stopped video", `/stories/production/${S.failed}`],
  ["Review", "/stories/review"],
  ["Review: facts to check", `/stories/review/${S.needsCheck}`],
  ["Review: ready to watch", `/stories/review/${S.review}`],
  ["Review: approved", `/stories/review/${S.approved}`],
];

const SIZES: [number, number, boolean][] = [
  [320, 640, true],
  [390, 844, true],
  [1024, 768, false],
  [1920, 1080, false],
];

type StoriesWindow = Window & { __cfStoriesMock?: { store?: { knobs: Record<string, unknown>; social: { platform: string; connectionStatus: string; accountName: string | null }[] } } };

async function context(browser: Browser, width: number, height: number, touch: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  return ctx;
}

/** Opens a studio page and waits until its data is in. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** Moves to another page inside the app, like a tap on a link (a reload would start the in-memory mock afresh). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.locator(".st-studio").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
}

/** Every rule of the owner's that can be measured on the page as it is now. */
async function audit(page: Page, label: string, phone: boolean): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) if (/st-/.test(i.selector)) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  for (const e of await visibleEdges(page)) if (/\.st-/.test(e)) out.push(`${label}: edge ${e}`);
  const axe = await new AxeBuilder({ page }).include(".st-studio").withRules(["color-contrast"]).analyze();
  for (const v of axe.violations) for (const n of v.nodes) out.push(`${label}: contrast ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);
  const bad = await page.evaluate((min) => {
    const found: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const e of document.querySelectorAll<HTMLElement>(".st-studio button, .st-studio a, .st-studio input:not([type=radio]):not([type=file])")) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      if (r.height < min - 0.5 || r.width < min - 0.5) found.push(`"${name}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.right > vw + 0.5 || r.left < -0.5) {
        const scroller = e.closest(".st-s-film");
        if (!scroller) found.push(`"${name}" is off the screen`);
      }
      const cursor = getComputedStyle(e).cursor;
      if (cursor !== "default" && cursor !== "auto") found.push(`"${name}" changes the cursor (${cursor})`);
    }
    for (const bar of document.querySelectorAll(".st-studio [role=radiogroup]")) if (!bar.querySelector(":scope > .glide")) found.push(`a pick-one bar without its sliding highlight: ${bar.textContent?.slice(0, 40)}`);
    return found;
  }, phone ? 48 : 44);
  for (const b of bad) out.push(`${label}: ${b}`);
  return out;
}

for (const [w, h, touch] of SIZES)
  for (const [name, path] of PAGES)
    test(`studio page fits and follows the rules: ${name} at ${w}x${h}`, async ({ browser }) => {
      const ctx = await context(browser, w, h, touch);
      const page = await ctx.newPage();
      await open(page, path);
      expect(await audit(page, `${name} ${w}`, touch && w < 768)).toEqual([]);
      await ctx.close();
    });

test("the publish sheet fits and follows the rules on a phone and a desktop", async ({ browser }) => {
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.approved}`);
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Post it" });
    await expect(sheet).toBeVisible();
    await page.waitForFunction(() => !document.querySelector(".st-s-sheet .st-s-busy"));
    const o = await findOverflow(page);
    expect(o.page, `${w}: sideways scroll`).toBeLessThanOrEqual(o.viewport);
    expect((await visibleEdges(page)).filter((e) => /\.st-/.test(e)), `${w}: edges`).toEqual([]);
    const axe = await new AxeBuilder({ page }).include(".st-s-sheet").withRules(["color-contrast"]).analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))), `${w}: contrast`).toEqual([]);
    // The main button sits at the bottom right, where the thumb is.
    const main = await sheet.locator(".st-s-sheet__actions .st-btn--main").boundingBox();
    expect(main && main.x + main.width).toBeGreaterThan(w * 0.6);
    await ctx.close();
  }
});

test("the whole flow: idea, character, production, review, approve and the publish sheet", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, "/stories/ideas");
  await page.evaluate(() => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store) store.knobs.jobSeconds = 3;
  });

  // 1. An idea, typed by hand.
  await page.getByRole("button", { name: "New idea" }).click();
  await page.getByLabel("Title").fill("Zed and the giant snowball");
  await page.getByLabel("What happens, in one line").fill("Zed rolls a snowball so big it rolls him.");
  await page.locator(".st-s-pick__opt", { hasText: "Funny" }).click();
  await page.getByRole("button", { name: "Save idea" }).click();
  const card = page.locator(".st-s-idea", { hasText: "Zed and the giant snowball" });
  await expect(card).toBeVisible();

  // 2. A character, through the stepper.
  await go(page, "/stories/characters/new");
  await page.locator(".st-s-pick__opt", { hasText: "Tall" }).click();
  for (const next of ["Next: Face", "Next: Moves", "Next: Sounds", "Next: Name and personality"]) await page.getByRole("button", { name: next }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Zed");
  await page.getByRole("button", { name: "Save character" }).click();
  await expect(page).toHaveURL(/\/stories\/characters\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { name: "Zed", exact: true })).toBeVisible();

  // 3. Production: the idea with the new character.
  await go(page, "/stories/ideas");
  await page.locator(".st-s-idea", { hasText: "Zed and the giant snowball" }).getByRole("button", { name: "Make the video" }).click();
  await expect(page).toHaveURL(/\/stories\/production\/new\?idea=/);
  await page.locator(".st-s-casttile", { hasText: "Zed" }).click();
  await page.evaluate(() => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store) store.knobs.jobSeconds = 3;
  });
  await page.getByRole("button", { name: "Make the video" }).click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  await expect(page.locator(".st-s-track__step")).toHaveCount(8);
  await expect(page.getByRole("link", { name: "Watch it in Review" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".st-s-film__card").first()).toBeVisible();

  // 4. Review and approve.
  await page.getByRole("link", { name: "Watch it in Review" }).click();
  await expect(page).toHaveURL(/\/stories\/review\/[0-9A-Z]{26}$/);
  await expect(page.locator(".st-s-player canvas, .st-s-player video")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved! Now you can post it.")).toBeVisible();

  // 5. The publish sheet: only this workspace's connected accounts, each by name, nothing chosen until tapped.
  await page.evaluate(() => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store && !store.social.some((a) => a.connectionStatus === "connected") && store.social[0]) {
      store.social[0].connectionStatus = "connected";
      store.social[0].accountName = store.social[0].accountName ?? "Lamo Stories Channel";
    }
  });
  const connected = await page.evaluate(() => ((window as StoriesWindow).__cfStoriesMock?.store?.social ?? []).filter((a) => a.connectionStatus === "connected").map((a) => a.accountName));
  await page.getByRole("button", { name: "Post it", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post it" });
  await expect(sheet).toBeVisible();
  const places = sheet.locator("button.st-s-place");
  await expect(places).toHaveCount(connected.length);
  expect((await sheet.locator("button.st-s-place .st-s-place__name").allTextContents()).sort()).toEqual(connected.map((n) => n ?? "Connected account").sort());
  await expect(sheet.locator('button.st-s-place[aria-pressed="true"]')).toHaveCount(0);
  await expect(sheet.locator(".st-s-sheet__actions .st-btn--main")).toHaveAttribute("aria-disabled", "true");
  await places.first().click();
  await expect(places.first()).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Use my settings" }).click();
  await expect(sheet.getByText("My settings: everyone can see it")).toBeVisible();
  await sheet.getByRole("button", { name: "More details" }).click();
  await expect(sheet.locator(".st-s-sheet__actions .st-btn--main")).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
  await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
  await expect(page.getByRole("dialog", { name: /Sending your video|Posted!/ })).toBeVisible();
  await expect(page.locator(".st-s-sheet .st-s-post")).toHaveCount(1);
  await ctx.close();
});
