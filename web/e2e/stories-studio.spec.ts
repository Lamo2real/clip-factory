// Lamo Stories studio screens in mock mode (docs/CONTRACTS.md §45.16.5, §45.16.6, §45.19, §45.25): every Ideas,
// Characters, Production and Review page fits from 320 px (no sideways scroll), draws no edges, keeps the arrow cursor,
// reaches AA contrast and has targets of 44 px (48 on phones), every pick-one bar has its sliding highlight; the AI
// buttons run as tasks whose line names the model and effort, with the "Model and effort for this one" sheet; Design
// with AI makes a character that saves; and the whole flow works: idea → character → production (with the video's own
// model) → review → approve → the publish sheet (only connected accounts, nothing chosen until tapped, the exact
// account with Check now, Use my settings, Upload). Needs the Lamo Stories shell and the mock's workspace, social and
// publishing parts (builder F) and the engine (builder D); the mock runs every job and task in a few seconds.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow } from "./helpers.ts";

/** The mock's seeded ids (SEED_IDS in src/stories/api/mock/stories.ts; test/storiesStudioMock.test.tsx keeps them equal). */
const S = { review: "01JSTST0000000000000000001", needsCheck: "01JSTST0000000000000000002", approved: "01JSTST0000000000000000003", published: "01JSTST0000000000000000004", failed: "01JSTST0000000000000000007" };
const I = { deer: "01JSTDE0000000000000000008", skid: "01JSTDE0000000000000000001", sandwich: "01JSTDE0000000000000000004" };
const C = { pip: "01JSTCH0000000000000000001", bolt: "01JSTCH0000000000000000002" };
/** A seeded, analyzed reference video (SEED_IDS in src/stories/api/mock/references.ts). */
const REF = { analyzed: "01JSTRF0000000000000000001" };
const SERIES = "01JSTSR0000000000000000001"; // the mock's seeded "My first car" (§45.44)
const CAR = "01JSTCH0000000000000000005"; // the mock's seeded car, Rosso (SEED_CAR_ID, §45.42)

const PAGES: [string, string][] = [
  ["Ideas", "/stories/ideas"],
  ["Characters", "/stories/characters"],
  ["New character", "/stories/characters/new"],
  ["New character: Design with AI", "/stories/characters/new#design"],
  ["A character", `/stories/characters/${C.pip}`],
  ["Production", "/stories/production"],
  ["New video", `/stories/production/new?idea=${I.deer}`],
  ["New video from the chat", `/stories/production/new?idea=${I.sandwich}&ref=${REF.analyzed}&cast=${C.pip}&cast=${C.bolt}&sec=40`],
  ["A stopped video", `/stories/production/${S.failed}`],
  ["Review", "/stories/review"],
  ["Review: facts to check", `/stories/review/${S.needsCheck}`],
  ["Review: ready to watch", `/stories/review/${S.review}`],
  ["Review: approved", `/stories/review/${S.approved}`],
  ["Series", "/stories/series"],
  ["A series", `/stories/series/${SERIES}`],
  ["New character: a car", "/stories/characters/new?kind=car"],
  ["Cars", "/stories/cars"],
  ["New car", "/stories/cars/new"],
  ["A car", `/stories/cars/${CAR}`],
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

/** The rules a sheet must keep at this size (no sideways scroll, no edges, AA contrast, the main button bottom right). */
async function sheetRules(page: Page, w: number, name: string | RegExp) {
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet).toBeVisible();
  const o = await findOverflow(page);
  expect(o.page, `${w}: sideways scroll`).toBeLessThanOrEqual(o.viewport);
  expect((await visibleEdges(page)).filter((e) => /\.st-/.test(e)), `${w}: edges`).toEqual([]);
  const axe = await new AxeBuilder({ page }).include(".st-s-sheet").withRules(["color-contrast"]).analyze();
  expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))), `${w}: contrast`).toEqual([]);
  const main = await sheet.locator(".st-s-sheet__actions .st-btn--main").boundingBox();
  expect(main && main.x + main.width).toBeGreaterThan(w * 0.6);
  for (const bar of await sheet.locator("[role=radiogroup]").all()) await expect(bar.locator(":scope > .glide")).toHaveCount(1);
  return sheet;
}

test("Ask for ideas runs as a task whose line names the model and effort; the model menu fits on a phone and a desktop", async ({ browser }) => {
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, "/stories/ideas");
    await page.getByRole("button", { name: "Ask for ideas" }).click();
    const ask = page.getByRole("form", { name: "Ask for ideas" });
    const menu = ask.getByRole("button", { name: /^Model and effort for this one: Claude Opus 5\.5/ });
    await expect(menu).toBeVisible();
    await menu.click();
    const sheet = await sheetRules(page, w, "Model and effort for this one");
    await expect(sheet).toContainText("Just for this one. Your settings stay the same.");
    await sheet.locator(".st-s-pick__opt", { hasText: "Claude Fable 5.2" }).click();
    await sheet.locator(".st-s-pick__opt", { hasText: "Maximum" }).click();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(ask.getByRole("button", { name: /^Model and effort for this one: Claude Fable 5\.2, Maximum effort, just this one$/ })).toBeVisible();
    await ask.getByRole("button", { name: "Get ideas" }).click();
    await expect(ask.locator(".st-s-busy")).toContainText(/Claude Fable 5\.2 · Maximum effort/);
    await expect(page.locator(".st-s-draft")).toHaveCount(4, { timeout: 20_000 });
    expect(await audit(page, `Ideas with drafts ${w}`, touch && w < 768)).toEqual([]);
    await ctx.close();
  }
});

test("reference videos in a new video, and the model notes of a video, fit and follow the rules", async ({ browser }) => {
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, "/stories/ideas");
    await page.evaluate(() => {
      const store = (window as StoriesWindow).__cfStoriesMock?.store as unknown as { references: unknown[] } | undefined;
      const at = "2026-11-20T10:00:00.000Z";
      const base = { bytes: 9_000_000, currentJobId: null, ai: { model: null, effort: null }, createdAt: at, updatedAt: at };
      store?.references.push(
        { ...base, refId: "01JSTRV0000000000000000001", title: "The banana slip, a very long reference video title to wrap", status: "analyzed", durationSec: 38, analyzedWith: { model: "opus-5-5", effort: "high" } },
        { ...base, refId: "01JSTRV0000000000000000002", title: "Snow day sketch", status: "ready", durationSec: null, analyzedWith: null },
      );
    });
    await go(page, `/stories/production/new?idea=${I.deer}`);
    const tile = page.locator(".st-s-reftile", { hasText: "The banana slip" });
    await expect(tile.or(page.getByText("Your reference videos could not load."))).toBeVisible();
    // The list comes from the references part (builder H); until it is built the page says so and never blocks.
    if (await tile.isVisible()) {
      await tile.click();
      await expect(tile).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".st-s-reftile", { hasText: "Snow day sketch" })).toHaveAttribute("aria-disabled", "true");
    } else test.info().annotations.push({ type: "note", description: "The mock's references part is not built here yet." });
    expect(await audit(page, `New video with references ${w}`, touch && w < 768)).toEqual([]);
    await go(page, `/stories/production/${S.failed}`);
    await page.locator(".st-s-details__sum", { hasText: "Production details" }).click();
    await expect(page.locator(".st-s-used__row").first()).toBeVisible();
    expect(await audit(page, `A stopped video, details open ${w}`, touch && w < 768)).toEqual([]);
    await go(page, `/stories/review/${S.review}`);
    await page.locator(".st-s-details__sum", { hasText: "How it was made" }).click();
    await expect(page.locator(".st-s-made .st-s-used__row").first()).toBeVisible();
    expect(await audit(page, `Review, how it was made ${w}`, touch && w < 768)).toEqual([]);
    await ctx.close();
  }
});

test("Design with AI: words make a first try in the editor, and it saves", async ({ browser }) => {
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, "/stories/characters");
  await page.getByRole("link", { name: "Design with AI" }).click();
  await expect(page).toHaveURL(/\/stories\/characters\/new#design$/);
  await page.getByLabel("What is your character like?").fill("A tall, clumsy robot called Zed with glasses who loves to dance");
  await page.getByRole("button", { name: "Design it" }).click();
  await expect(page.locator(".st-s-design .st-s-busy")).toContainText("Designing your character with");
  await expect(page.getByText("Here is a first try.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Zed");
  expect(await audit(page, "Design with AI done", false)).toEqual([]);
  await page.getByRole("button", { name: "Save character" }).click();
  await expect(page).toHaveURL(/\/stories\/characters\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { name: "Zed", exact: true })).toBeVisible();
  await ctx.close();
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
  // This video's own model and effort, kept with it.
  await page.getByRole("button", { name: /^Model and effort for this video/ }).click();
  const own = page.getByRole("dialog", { name: "Model and effort for this video" });
  await own.locator(".st-s-pick__opt", { hasText: "Claude Sonnet 5.5" }).click();
  await own.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Make the video" }).click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
  await expect(page.locator(".st-s-track__step")).toHaveCount(8);
  await expect(page.getByRole("link", { name: "Watch it in Review" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".st-s-film__card").first()).toBeVisible();
  await page.locator(".st-s-details__sum", { hasText: "Production details" }).click();
  await expect(page.locator(".st-s-used__row", { hasText: "Write the story" })).toContainText("Claude Sonnet 5.5");

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
  // The exact account it goes to, checked live before Upload.
  const dest = sheet.locator(".st-s-dest").first();
  // By its place first, so it reads right when the account is itself called Lamo Stories (§45.36 E13).
  await expect(dest).toContainText(connected[0] ? `account: ${connected[0]}` : "Goes to the connected");
  await expect(dest).toContainText("Goes to ");
  await dest.getByRole("button", { name: "Check now" }).click();
  await expect(dest).toContainText("Checked just now");
  await sheet.getByRole("button", { name: "Use my settings" }).click();
  await expect(sheet.getByText("My settings: everyone can see it")).toBeVisible();
  await sheet.getByRole("button", { name: "More details" }).click();
  await expect(sheet.locator(".st-s-sheet__actions .st-btn--main")).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
  await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
  await expect(page.getByRole("dialog", { name: /Sending your video|Posted!/ })).toBeVisible();
  await expect(page.locator(".st-s-sheet .st-s-post")).toHaveCount(1);
  await ctx.close();
});

// ---------- Round 3 (§45.34) ----------

/** Lets the sliding highlights reach the new choice before the page is measured. */
const settle = (page: Page) => page.waitForTimeout(700);

/** Lamo Stories' mock store as these tests change it (inside the page). */
type R3Window = Window & {
  __cfStoriesMock?: { store?: { knobs: Record<string, unknown>; social: { platform: string; connectionStatus: string; reason: string | null; externalAccountId: string | null }[] } };
};

test("round 3, Production › New: the hand-over keys, the idea's own length, and the shape picker", async ({ browser }) => {
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/production/new?idea=${I.sandwich}&ref=${REF.analyzed}&cast=${C.pip}&cast=${C.bolt}&sec=40`);
    await expect(page.locator('.st-s-casttile[aria-pressed="true"]')).toHaveCount(2);
    await expect(page.locator('input[type="range"]').first()).toHaveValue("40");
    await expect(page.locator('.st-s-reftile[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByText("From Settings › Video.")).toBeVisible();
    await page.locator(".st-s-shapepick .st-s-pick__opt", { hasText: "Wide" }).click();
    await expect(page.getByText("Just for this video. Settings › Video stays the same.")).toBeVisible();
    await settle(page);
    expect(await audit(page, `New video with a wide shape ${w}`, touch && w < 768)).toEqual([]);
    await page.getByRole("button", { name: "Make the video" }).click();
    await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
    await page.locator(".st-s-details__sum", { hasText: "Production details" }).click();
    await expect(page.locator(".st-s-facts")).toContainText("Wide (16:9), 1920 × 1080");
    await expect(page.locator(".st-s-facts")).toContainText("Next run: Claude");
    await ctx.close();
  }
  // A saved idea's full idea gives the starting length.
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, `/stories/production/new?idea=${I.skid}`);
  await expect(page.getByText(/The full idea was written for \d+ seconds\./)).toBeVisible();
  // Reference videos from the address that are not in the list (deleted since) are dropped: they never use up the 3
  // picks, so a real one can still be picked.
  await go(page, `/stories/production/new?idea=${I.sandwich}&ref=01JSTRFGONE000000000000001&ref=01JSTRFGONE000000000000002&ref=01JSTRFGONE000000000000003`);
  const tile = page.locator(".st-s-reftile", { hasText: "Penguin on the ice rink" });
  await expect(tile).toBeVisible();
  await expect(page.locator('.st-s-reftile[aria-pressed="true"]')).toHaveCount(0);
  await expect(tile).not.toHaveAttribute("aria-disabled", "true");
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  await ctx.close();
});

test("round 3, Review: Next run, Write them again beside the saved words, the place sounds, and extra copies", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    await ctx.addInitScript(() => ((window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { extraFormats: ["webm"], taskSeconds: 1 } }));
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.review}`);
    // Said once: "Remakes use" in the decision names the model, and Next run is in How it was made.
    await expect(page.locator(".st-s-decide .st-s-nextrun")).toHaveCount(0);
    await expect(page.locator(".st-s-made .st-s-nextrun")).toHaveText(/^Next run: Claude .+ · .+$/);
    // The place's own sounds, labelled, from each scene's start.
    await expect(page.locator(".st-s-sfx__row.is-place").first()).toContainText("Sound (whole scene)");
    // Write them again: the draft beside the saved words, saved only by Use these.
    await page.locator(".st-s-captions").first().waitFor();
    await page.locator("#st-captions-title").scrollIntoViewIfNeeded();
    await page.locator(".st-s-pick__opt", { hasText: "With the post" }).click();
    await page.getByRole("button", { name: "Write them again" }).click();
    const draft = page.locator(".st-s-draftcaps");
    await expect(draft).toBeVisible({ timeout: 20_000 });
    await expect(draft.locator(".st-s-draftcaps__row").first()).toContainText("Saved");
    await expect(draft.locator(".st-s-draftcaps__row").first()).toContainText("New");
    await settle(page);
    expect(await audit(page, `Review with new post words ${w}`, touch && w < 768)).toEqual([]);
    await draft.getByRole("button", { name: "Use these" }).click();
    // New post words are not in the video: only the quick fact check is needed (§45.36 E10).
    await expect(page.getByText("Saved. Your new post words need a quick check. Tap Check again.")).toBeVisible();
    await expect(page.locator(".st-s-draftcaps")).toHaveCount(0);
    // An approved video with a WebM copy offers it by name.
    await go(page, `/stories/review/${S.approved}`);
    await expect(page.getByRole("button", { name: "Download WebM" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download MP4" })).toBeVisible();
    await settle(page);
    expect(await audit(page, `Review with copies ${w}`, touch && w < 768)).toEqual([]);
    await page.getByRole("button", { name: "Download WebM" }).click();
    await expect(page.getByText("Downloading the WebM copy.")).toBeVisible();
    await ctx.close();
  }
});

test("round 3, Ideas and Characters: Edit an idea card; a redesign shows what changes before Use this", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    await ctx.addInitScript(() => ((window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { taskSeconds: 1 } }));
    const page = await ctx.newPage();
    await open(page, "/stories/ideas");
    const card = page.locator(`[data-idea="${I.skid}"]`);
    await card.getByRole("button", { name: /^Edit / }).click();
    const form = page.getByRole("form", { name: /^Edit / });
    await expect(form.getByRole("group", { name: "The full idea" })).toBeVisible();
    await settle(page);
    expect(await audit(page, `Edit an idea ${w}`, touch && w < 768)).toEqual([]);
    await form.getByLabel("Title").fill("Calm hands on black ice");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved “Calm hands on black ice”.")).toBeVisible();
    await expect(card).toContainText("Calm hands on black ice");

    await go(page, `/stories/characters/${C.pip}`);
    await page.getByRole("button", { name: "Design with AI" }).click();
    await page.getByLabel("What should Pip look like?").fill("Curly hair and a blue jumper");
    await page.getByRole("button", { name: "Design it" }).click();
    const compare = page.locator(".st-s-redesign");
    await expect(compare).toBeVisible({ timeout: 20_000 });
    await expect(compare).toContainText("What changes:");
    await expect(compare).toContainText("Stays the same:");
    await settle(page);
    expect(await audit(page, `A redesign ${w}`, touch && w < 768)).toEqual([]);
    await compare.getByRole("button", { name: "Use this" }).click();
    await expect(page.getByText("The new version of Pip is in the editor.")).toBeVisible();
    // With AI pictures off, the way to turn them on.
    await expect(page.getByRole("link", { name: "Settings › Video › Picture maker" })).toHaveAttribute("href", "/stories/settings/video");
    await ctx.close();
  }
});

test("round 3, Post to {name}?: the publish sheet and Posts' Try again ask about the account the API names", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.approved}`);
    // Lamo Stories' TikTok is connected, and Lamo Stories cannot tell it from Lamo Clips' own (TikTok's own ids).
    await page.evaluate(() => {
      const st = (window as R3Window).__cfStoriesMock?.store;
      const t = st?.social.find((a) => a.platform === "tiktok");
      if (st && t) {
        t.connectionStatus = "connected";
        t.reason = null;
        st.knobs.tiktokUnsure = true;
      }
    });
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Post it" });
    await sheet.locator("button.st-s-place", { hasText: "TikTok" }).click();
    await sheet.getByRole("button", { name: "Use my settings" }).click();
    // This TikTok account only allows "Only me" until TikTok approves the app: picked from TikTok's own choices.
    await sheet.locator(".st-s-tiktok [aria-haspopup=listbox]").click();
    await page.getByRole("option", { name: "Only me" }).click();
    await expect(sheet.locator(".st-s-sheet__actions .st-btn--main")).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
    await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
    // Named by its place first, so it reads right when the account is itself called Lamo Stories (§45.36 E13).
    const ask = await sheetRules(page, w, /^Post to this TikTok account( \(.+\))?\?$/);
    await expect(ask).toContainText("Clips Funded cannot tell if");
    await expect(ask).not.toContainText("Lamo Clips");
    // The account id is behind Technical details (§45.36 E14).
    await expect(ask.locator(".st-s-dest--ask .st-s-tech")).toContainText("Account id");
    await ask.getByRole("button", { name: /^Yes, post to / }).click();
    await expect(page.getByRole("dialog", { name: /Sending your video|Posted!/ })).toBeVisible();
    await page.getByRole("dialog", { name: /Sending your video|Posted!/ }).locator(".st-s-sheet__actions .st-btn--main").click();
    // Posts' Try again on the posted video's stopped TikTok post: the API names the account, the owner says yes.
    await go(page, `/stories/review/${S.published}`);
    await page.evaluate(() => {
      const st = (window as R3Window).__cfStoriesMock?.store;
      const t = st?.social.find((a) => a.platform === "tiktok");
      if (st && t) {
        t.externalAccountId = "-000another-open-id";
        st.knobs.tiktokUnsure = false;
      }
    });
    const row = page.locator(".st-s-post", { hasText: "TikTok" });
    await row.getByRole("button", { name: "Try again" }).click();
    const again = await sheetRules(page, w, /^Post to this TikTok account( \(.+\))?\?$/);
    await expect(again).toContainText("a different account now");
    await again.getByRole("button", { name: /^Yes, post to / }).click();
    await expect(row).toContainText(/Waiting|Sending|Posted/);
    await expect(row).toContainText("Account id -000another-open-id");
    await ctx.close();
  }
});

test("round 4: the publish sheet's Not ready to post rows stay readable from 320 to 390 px", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [360, 740, true],
    [390, 844, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.approved}`);
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Post it" });
    await expect(sheet).toBeVisible();
    await page.waitForFunction(() => !document.querySelector(".st-s-sheet .st-s-busy"));
    const off = sheet.locator(".st-s-places--off .st-s-place--off");
    expect(await off.count(), `${w}: the mock has accounts that are not ready`).toBeGreaterThan(0);
    const o = await findOverflow(page);
    expect(o.items.filter((i) => /st-/.test(i.selector)), `${w}: cut-off text`).toEqual([]);
    for (const row of await off.all()) {
      const words = await row.locator(".st-s-place__text").boundingBox();
      const link = await row.locator(".st-btn").boundingBox();
      const box = await row.boundingBox();
      // One word per line was 4 px wide at 390 and 0 px at 320 (§45.35 D21): the words always get the room.
      expect(words && words.width, `${w}: the words' width`).toBeGreaterThan(120);
      expect(link && box && link.x + link.width, `${w}: the link inside its row`).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 1);
      // On phones the link has its own row under the words, at the right where the thumb is.
      if (w < 560 && words && link && box) {
        expect(link.y, `${w}: the link under the words`).toBeGreaterThanOrEqual(words.y + words.height - 1);
        expect(link.x + link.width, `${w}: the link at the right`).toBeGreaterThan(box.x + box.width * 0.6);
      }
    }
    await ctx.close();
  }
});

/** Moves to a Library page inside the app and waits until its data is in (the Library is not a .st-studio page). */
async function goLibrary(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.locator(".st-library").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".st-library .st-loading"), undefined, { timeout: 20_000 });
}

/** The owner's measurable rules on a Library page: no cut-off text or sideways scroll, no edges, AA contrast. */
async function libraryAudit(page: Page, label: string): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) if (/st-/.test(i.selector)) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  for (const e of await visibleEdges(page)) if (/\.st-/.test(e)) out.push(`${label}: edge ${e}`);
  const axe = await new AxeBuilder({ page }).include(".st-library").withRules(["color-contrast"]).analyze();
  for (const v of axe.violations) for (const n of v.nodes) out.push(`${label}: contrast ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);
  const cursors = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".st-library summary, .st-library button, .st-library a"))
      .filter((e) => !["default", "auto"].includes(getComputedStyle(e).cursor))
      .map((e) => (e.textContent ?? "").trim().slice(0, 40)),
  );
  for (const c of cursors) out.push(`${label}: "${c}" changes the cursor`);
  return out;
}

test("round 4: Production and the Library say everything in words; the exact parts are behind Technical details", async ({ browser }) => {
  test.setTimeout(120_000);
  const raw = /bedrock-claude|builtin-rig|builtin-2d|builtin-synth|nova-canvas|nova-reel|s3:\/\//;
  /** The page's visible words outside the Technical details folds. */
  const plain = (page: Page, root: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)!.cloneNode(true) as Element;
      for (const f of el.querySelectorAll(".st-s-tech")) f.remove();
      return el.textContent ?? "";
    }, root);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/production/${S.approved}`);
    await page.locator(".st-s-details__sum", { hasText: "Production details" }).click();
    const details = page.locator(".st-s-details").first();
    await expect(details).toContainText("Helpers used");
    await expect(details).toContainText("Claude on Amazon Bedrock");
    await expect(details).toContainText("Clips Funded's own folder in Clip Factory's media storage");
    await expect(details.locator("dt, h3", { hasText: /^Made with$/ })).toHaveCount(1);
    await expect(details.locator(".st-s-used__id").first()).toHaveText(/^Model ID \S+ in eu-north-1$/);
    expect(await plain(page, ".st-s-details")).not.toMatch(raw);
    const fold = details.locator(".st-s-tech");
    await fold.locator("summary").click();
    await expect(fold).toContainText("s3://");
    await expect(fold).toContainText("Seed");
    await settle(page);
    expect(await audit(page, `Production details and Technical details ${w}`, touch && w < 768)).toEqual([]);

    // The Library's project page.
    await goLibrary(page, `/stories/library?story=${S.approved}`);
    const made = page.locator(".st-details");
    await expect(made).toContainText("Clips Funded's own folder in Clip Factory's media storage");
    await expect(made).toContainText("Claude on Amazon Bedrock");
    expect(await plain(page, ".st-details")).not.toMatch(raw);
    for (const f of await made.locator(".st-s-tech summary").all()) await f.click();
    await expect(made.locator(".st-s-tech").first()).toContainText("s3://");
    await expect(made.locator(".st-s-tech").nth(1)).toContainText(/Model ID \S+ in eu-north-1/);
    await settle(page);
    expect(await libraryAudit(page, `Library project, Technical details open ${w}`)).toEqual([]);

    // The Videos tab lists a video's WebM and MOV copies (§45.35 D10).
    await page.evaluate((storyId) => {
      const store = (window as StoriesWindow).__cfStoriesMock?.store as unknown as { assets: Record<string, unknown>[]; stories: { storyId: string; title: string; scriptVersion: number }[] } | undefined;
      const story = store?.stories.find((s) => s.storyId === storyId);
      if (!store || !story) return;
      for (const [f, type] of [
        ["webm", "video/webm"],
        ["mov", "video/quicktime"],
      ])
        store.assets.push({ assetId: `01JSTAS${f === "webm" ? "W" : "M"}000000000000000000`, kind: "video", storyId, characterId: null, title: story.title, url: `data:${type};base64,`, contentType: type, bytes: 12_000_000, version: story.scriptVersion, createdAt: new Date().toISOString(), meta: { current: 1, format: f } });
    }, S.approved);
    await goLibrary(page, "/stories/library?kind=videos");
    await expect(page.locator(".st-file__kind", { hasText: "Video copy · WebM" })).toBeVisible();
    await expect(page.locator(".st-file__kind", { hasText: "Video copy · MOV" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Download video copy \(WebM\) of / })).toBeVisible();
    await settle(page);
    expect(await libraryAudit(page, `Library videos with copies ${w}`)).toEqual([]);
    await ctx.close();
  }
});

test("round 4: the timeline chip shows the short name, and a one-line idea is never cut in the idea picker", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1440, 900, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.review}`);
    const names = page.locator(".st-s-timeline__name");
    expect(await names.count()).toBeGreaterThan(0);
    const cut = await names.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    expect(cut, `${w}: chips cut off`).toEqual([]);
    await expect(page.locator(".st-s-timeline__mark.is-place .st-s-timeline__name").first()).not.toContainText("(whole scene)");
    await go(page, "/stories/production/new");
    const lines = page.locator(".st-s-ideapick .st-s-pick__line");
    expect(await lines.count()).toBeGreaterThan(0);
    const clamped = await lines.evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent));
    expect(clamped, `${w}: idea lines cut off`).toEqual([]);
    await ctx.close();
  }
});

// ---------- Round 5 (§45.36) ----------

type R5Window = Window & {
  __cfStoriesMock?: { store?: { knobs: Record<string, unknown>; scripts: Record<string, { width: number; height: number }> } };
  __cfSoundLog?: { kind: string }[];
  __bursts?: number;
};

/** The words inside a root, without its Technical details folds. */
const plainOf = (page: Page, root: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!.cloneNode(true) as Element;
    for (const f of el.querySelectorAll(".st-s-tech")) f.remove();
    return el.textContent ?? "";
  }, root);

test("round 5, Review: new post words need only Check again and the tab stays; account problems open Social accounts; ids are folded", async ({ browser }) => {
  test.setTimeout(120_000);
  const words = "Your new post words need a quick check. Tap Check again.";
  for (const [w, h, touch] of [
    [390, 844, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.review}`);
    // §45.36 E10: only the post words change.
    await page.locator("#st-captions-title").scrollIntoViewIfNeeded();
    await page.locator(".st-s-pick__opt", { hasText: "With the post" }).click();
    await page.getByLabel("X", { exact: true }).fill("Pip keeps calm on the ice!");
    await page.getByRole("button", { name: "Save post words" }).click();
    await expect(page.getByText(`Saved. ${words}`)).toBeVisible();
    // The box started again with the new version, on the tab the owner was on.
    await expect(page.locator(".st-s-pick__opt", { hasText: "With the post" })).toHaveClass(/is-on/);
    await expect(page.locator(".st-s-pick__opt", { hasText: "On the video" })).not.toHaveClass(/is-on/);
    await expect(page.locator("#st-approve-why")).toHaveText(words);
    const notice = page.locator(".st-s-notice", { hasText: words });
    await expect(notice.getByRole("button", { name: "Check again" })).toBeVisible();
    await expect(page.locator(".st-studio")).not.toContainText("Tap Remake");
    await settle(page);
    expect(await audit(page, `Review, new post words ${w}`, touch && w < 768)).toEqual([]);
    await notice.getByRole("button", { name: "Check again" }).click();
    await expect(page.locator(".st-s-review__side .st-s-steps, .st-s-review__side [aria-label='Being made again']").first()).toBeVisible({ timeout: 10_000 });
    // Only the fact check runs: every other step stays done (never a remake of the video).
    const track = page.locator(".st-s-review__side [aria-label='Being made again'] .st-s-track__step");
    await expect(track.first()).toBeVisible();
    expect(await track.evaluateAll((li) => li.filter((x) => !x.classList.contains("is-done") && !x.textContent?.includes("Check the facts")).length)).toBe(0);
    // Then the video can be approved.
    await expect(page.locator("[aria-label='Being made again']")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator("#st-approve-why")).toHaveCount(0);

    // §45.36 E9 and E14: the posted video's Posts panel.
    await go(page, `/stories/review/${S.published}`);
    const tiktok = page.locator(".st-s-post", { hasText: "TikTok" });
    await expect(tiktok.getByRole("link", { name: "Open Social accounts" })).toHaveAttribute("href", "/stories/connections");
    await expect(tiktok.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator(".st-s-post", { hasText: "Facebook" }).getByRole("link", { name: "Open Social accounts" })).toHaveCount(0);
    expect(await plainOf(page, ".st-s-postspanel")).not.toMatch(/Account id|ext-|open-id/);
    expect(await plainOf(page, ".st-studio")).not.toContain("Lamo Clips");
    await settle(page);
    expect(await audit(page, `Posts with an account problem ${w}`, touch && w < 768)).toEqual([]);
    await tiktok.getByRole("link", { name: "Open Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await ctx.close();
  }
});

test("round 5: Posted! in the Post it sheet gets the star burst and the cheer", async ({ browser }) => {
  test.setTimeout(90_000);
  // Motion on: the star burst draws (a calm-motion device gets the cheer alone).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { publishMs: 300 } };
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLCanvasElement && n.classList.contains("st-burst")) (window as R5Window).__bursts = ((window as R5Window).__bursts ?? 0) + 1;
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  await open(page, `/stories/review/${S.approved}`);
  await page.getByRole("button", { name: "Post it", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post it" });
  await sheet.locator("button.st-s-place", { hasText: "YouTube" }).click();
  await page.evaluate(() => {
    (window as R5Window).__cfSoundLog = [];
    (window as R5Window).__bursts = 0;
  });
  await sheet.locator(".st-s-sheet__actions .st-btn--main").click();
  await expect(page.getByRole("dialog", { name: "Posted!" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as R5Window).__bursts ?? 0)).toBe(1);
  await expect.poll(() => page.evaluate(() => ((window as R5Window).__cfSoundLog ?? []).filter((e) => e.kind === "success").length)).toBe(1);
  await ctx.close();
});

test("round 5: a model with no access is never pre-picked, and Make the video asks first", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    // The storyboard agent's own model is Claude Fable 5.1, which this account has no access to (the mock's seed).
    await open(page, `/stories/production/new?idea=${I.sandwich}`);
    const chip = page.locator(".st-s-newvideo .st-s-ai-btn");
    await expect(chip).toContainText("Opus 5.5");
    await expect(chip).not.toContainText("Fable 5.1");
    await chip.click();
    const menu = await sheetRules(page, w, "Model and effort for this video");
    await expect(menu.locator(".st-s-pick__opt").first()).toContainText("Claude Fable 5.1 has no access right now, so the usual is this one.");
    await expect(menu.locator(".st-s-pick__opt", { hasText: "Claude Fable 5.1" }).last()).toContainText("No access:");
    await menu.locator(".st-s-pick__opt", { hasText: /^Claude Fable 5\.1/ }).click();
    await menu.getByRole("button", { name: "Done" }).click();
    await expect(chip.locator(".st-s-ai-btn__status")).toHaveText("No access");
    await settle(page);
    expect(await audit(page, `New video with a model that has no access ${w}`, touch && w < 768)).toEqual([]);
    await page.getByRole("button", { name: "Make the video" }).click();
    const ask = await sheetRules(page, w, "Claude Fable 5.1 has no access right now. Use Claude Opus 5.5 instead?");
    await expect(ask.getByRole("button", { name: "Try Claude Fable 5.1 anyway" })).toBeVisible();
    await ask.getByRole("button", { name: "Use Claude Opus 5.5" }).click();
    await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/, { timeout: 20_000 });
    await ctx.close();
  }
});

test("round 5: the play badge leaves a square video's caption clear; a full idea says what made it; Fix it opens Social accounts", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  // §45.36 E18: a square video's scenes.
  await open(page, "/stories/ideas");
  await page.evaluate((id) => {
    const script = (window as R5Window).__cfStoriesMock?.store?.scripts[id];
    if (script) Object.assign(script, { width: 1080, height: 1080 });
  }, S.review);
  await go(page, `/stories/review/${S.review}`);
  await expect(page.locator(".st-s-film.st-s-film--square")).toHaveCount(1);
  const frame = await page.locator(".st-s-film__frame").first().boundingBox();
  const badge = await page.locator(".st-s-film__play").first().boundingBox();
  expect(frame && badge).toBeTruthy();
  // In the top part of the frame, never in the band at the bottom where square captions sit.
  expect(badge!.y + badge!.height).toBeLessThan(frame!.y + frame!.height * 0.5);

  // §45.36 E8: a finished full idea says its model in words; the exact model id is behind Technical details.
  await go(page, "/stories/ideas");
  const card = page.locator(`[data-idea="${I.sandwich}"]`);
  if (await card.getByRole("button", { name: "See the full idea" }).isVisible()) await card.getByRole("button", { name: "See the full idea" }).click();
  await card.getByRole("button", { name: /^(Make it a full idea|Write it again)$/ }).click();
  const made = card.locator(".st-s-taskmade");
  await expect(made).toContainText(/^Made with Claude .+/, { timeout: 20_000 });
  expect(await plainOf(page, `[data-idea="${I.sandwich}"]`)).not.toContain("Model ID");
  await made.locator(".st-s-tech summary").click();
  await expect(made.locator(".st-s-tech")).toContainText(/Model ID \S+ in eu-north-1/);
  await settle(page);
  expect(await audit(page, "A full idea with its exact model open", false)).toEqual([]);
  // A failed one still says what it was tried with, the exact model behind the same fold.
  await page.evaluate(() => {
    const st = (window as R5Window).__cfStoriesMock?.store;
    if (st) st.knobs.taskFail = true;
  });
  await card.getByRole("button", { name: /^(Make it a full idea|Write it again)$/ }).click();
  const tried = card.locator(".st-s-taskmade--failed");
  await expect(tried).toContainText(/^Tried with Claude .+/, { timeout: 20_000 });
  await expect(card).toContainText("The idea helper could not finish. Tap Try again.");
  expect(await plainOf(page, `[data-idea="${I.sandwich}"]`)).not.toContain("Model ID");
  await tried.locator(".st-s-tech summary").click();
  await expect(tried.locator(".st-s-tech")).toContainText(/Model ID \S+ in eu-north-1/);

  // §45.36 E9: the dashboard's Fix it for a post that stopped on an account problem opens Social accounts.
  await page.evaluate(() => {
    history.pushState({}, "", "/stories");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  const item = page.locator(".st-needs-list__item", { hasText: "needs connecting again. Open Clips Funded › Social accounts" }).first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  // that platform's own page on Social accounts
  await expect(item.locator("a").last()).toHaveAttribute("href", "/stories/connections/tiktok");
  await expect(item.locator("a").last()).toHaveText("Fix it");
  await ctx.close();
});

test("round 5: a stand-in is never kept with the video, and a video made with Amazon Nova Pro names it as its writer", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  // §45.36 E12: nothing picked, and the storyboard agent's own model has no access (the mock's seed): the first job
  // uses the stand-in, and the video keeps nothing of its own.
  await open(page, `/stories/production/new?idea=${I.sandwich}`);
  await expect(page.locator(".st-s-newvideo .st-s-ai-btn")).toContainText("Opus 5.5");
  await page.getByRole("button", { name: "Make the video" }).click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  await expect(page.locator(".st-studio")).toContainText("Your usual settings");
  await expect(page.locator(".st-studio")).not.toContainText("kept with this video");

  // §45.36 E7: Amazon Nova Pro (not Anthropic's) kept with a new video writes it, and Helpers used says so.
  await go(page, `/stories/production/new?idea=${I.sandwich}`);
  const chip = page.locator(".st-s-newvideo .st-s-ai-btn");
  await chip.click();
  const menu = await sheetRules(page, 1280, "Model and effort for this video");
  await menu.locator(".st-s-pick__opt", { hasText: /^Amazon Nova Pro/ }).click();
  await menu.getByRole("button", { name: "Done" }).click();
  await expect(chip).toContainText("Amazon Nova Pro");
  await page.getByRole("button", { name: "Make the video" }).click();
  await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  await page.locator(".st-s-details__sum", { hasText: "Production details" }).click();
  await expect(page.locator(".st-s-details")).toContainText("Amazon Nova Pro on Amazon Bedrock", { timeout: 20_000 });
  await expect(page.locator(".st-s-details")).not.toContainText("Claude on Amazon Bedrock");
  await settle(page);
  expect(await audit(page, "Production details of a video written by Amazon Nova Pro", false)).toEqual([]);
  await ctx.close();
});
