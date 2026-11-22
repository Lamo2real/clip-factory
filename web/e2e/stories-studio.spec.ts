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
const S = { review: "01JSTST0000000000000000001", needsCheck: "01JSTST0000000000000000002", approved: "01JSTST0000000000000000003", failed: "01JSTST0000000000000000007" };
const I = { deer: "01JSTDE0000000000000000008" };
const C = { pip: "01JSTCH0000000000000000001" };

const PAGES: [string, string][] = [
  ["Ideas", "/stories/ideas"],
  ["Characters", "/stories/characters"],
  ["New character", "/stories/characters/new"],
  ["New character: Design with AI", "/stories/characters/new#design"],
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
  await expect(dest).toContainText(`Goes to ${connected[0] ?? "the connected account"}`);
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
