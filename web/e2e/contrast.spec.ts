import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TODO_CELEBRATE_MS } from "../src/lib/setupTodo.ts";
import { GUIDES, SETUP_ORDER } from "../src/setup/index.ts";
import { animationsDone, MIXED_SETUP, mixedSetup, resolveRoute, ROUTES, scanText, settle } from "./helpers.ts";
import { asDesktop, paintGlass, WINDOW_EXTRA_ROUTES, WINDOW_LOOKS, type GlassPaint } from "./glass.ts";
import { animationsDone, CLIPS, openClip, resolveRoute, ROUTES, scanText, settle, whiteContrastOnGradient } from "./helpers.ts";

// Every screen's text is readable (audit F081, WCAG 2.1 AA 1.4.3; docs/TESTING.md "Contrast and text size"):
// at 320, 375 and 1440 px, with the browser asking for light and for dark (the app is light-only, so dark must
// look the same), on every route in ROUTES:
//   1. axe-core's color-contrast rule finds no violation;
//   2. every visible text run, and what a field shows (typed words, or its placeholder), reaches 4.5:1 (3:1 for
//      24 px, or 18.66 px bold, and up) against every background it can sit on: its ancestors' colours and glass
//      gradients composited over the backdrop it can scroll across;
//   3. no visible text is smaller than 12 px.
// Reduced motion parks the drifting backdrop and finishes entrance fades, so every run measures the same picture.
//
// The window look (see-through in the desktop app, docs/CONTRACTS.md §22.3) is held to the same bar: the page is
// transparent there, so each stand-in for the real window glass (e2e/glass.ts) is painted behind it and the same
// scan runs again, for every glass that has its own tints.

const WIDTHS = [320, 375, 1440] as const;
const SCHEMES = ["light", "dark"] as const;

/**
 * Decorative text left out on purpose, as one CSS selector. It is empty today: every visible text run passes.
 * Only add aria-hidden text that carries no meaning (never a label, a number or an error), each with a comment
 * saying why, and add the same selector to the axe `exclude` below.
 */
const DECORATIVE = "";

test.use({ reducedMotion: "reduce" });

/** The three checks on what is on screen now; what fails is added to `failures`. Returns how many text runs it read. */
async function readable(page: Page, at: string, failures: string[]): Promise<number> {
  const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  for (const v of axe.violations)
    for (const n of v.nodes) failures.push(`${at} axe: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);

  const scan = await scanText(page, DECORATIVE);
  expect(scan.checked, `${at}: found no text to check`).toBeGreaterThan(0);
  test.info().annotations.push({ type: "text runs", description: `${at}: ${scan.checked} checked, ${scan.pictures} on a picture (axe only)` });
  for (const f of scan.contrast)
    failures.push(`${at} contrast: ${f.selector} "${f.text}" ${f.ratio}:1 < ${f.need}:1 (${f.color} on ${f.background}, ${f.fontSize}px)`);
  for (const f of scan.tiny) failures.push(`${at} size: ${f.selector} "${f.text}" is ${f.fontSize}px (< 12px)`);
  return scan.checked;
/** The axe color-contrast rule's violations on the page as it is, one line each. */
async function axeContrast(page: Page, at: string): Promise<string[]> {
  const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  return axe.violations.flatMap((v) => v.nodes.map((n) => `${at} axe: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`));
}

/** The rendered-contrast and text-size scan (`scanText`) on the page as it is, one line per failure. */
async function scanFailures(page: Page, at: string): Promise<string[]> {
  const scan = await scanText(page, DECORATIVE);
  expect(scan.checked, `${at}: found no text to check`).toBeGreaterThan(0);
  test.info().annotations.push({ type: "text runs", description: `${at}: ${scan.checked} checked, ${scan.pictures} on a picture (axe only)` });
  return [
    ...scan.contrast.map((f) => `${at} contrast: ${f.selector} "${f.text}" ${f.ratio}:1 < ${f.need}:1 (${f.color} on ${f.background}, ${f.fontSize}px)`),
    ...scan.tiny.map((f) => `${at} size: ${f.selector} "${f.text}" is ${f.fontSize}px (< 12px)`),
  ];
}

for (const route of ROUTES) {
  test(`text on ${route} is readable at 320, 375 and 1440 px, light and dark`, async ({ page }) => {
    test.setTimeout(180_000);
    const path = await resolveRoute(page, route);
    const failures: string[] = [];
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.goto(path);
        await settle(page);
        await animationsDone(page);
        await readable(page, `${path} @${width} ${scheme}`, failures);
        const at = `${path} @${width} ${scheme}`;
        failures.push(...(await axeContrast(page, at)), ...(await scanFailures(page, at)));
      }
    }
    expect(failures).toEqual([]);
  });
}

// ---------- The floating setup to-do list (docs/CONTRACTS.md §17.13) ----------
// The routes above carry it in its plainest face: five "Not started" rows, as the open column at 1440 px and as the
// pill at 320 and 375 px. Here every other face is read the same way, in light and dark: the open column and the
// phone sheet with one row of every kind (ready, skipped, half done, needs you, not started), the pill folded on a
// wide screen and on its glass bar once the page has scrolled, the skip question over each, the "All set!" card,
// and Settings › Set up posting with its Skip and Un-skip lines.

/** How many text runs the list's own surfaces show now (the pill, the open list, the sheet, the question, "All set!"). */
const listRuns = (page: Page) =>
  page.evaluate(() => {
    let n = 0;
    for (const box of Array.from(document.querySelectorAll(".setup-todo, .setup-todo-panel, .sheet"))) {
      const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) if ((t.textContent ?? "").trim() && !t.parentElement!.closest(".sr-only")) n++;
    }
    return n;
  });

/** Reads the screen (`readable`) and makes sure the list's own words were among what it read. */
async function readableList(page: Page, at: string, failures: string[]) {
  await animationsDone(page);
  const runs = await listRuns(page);
  expect(runs, `${at}: the list shows no words`).toBeGreaterThan(0);
  expect(await readable(page, at, failures), `${at}: fewer words read than the list shows`).toBeGreaterThanOrEqual(runs);
}

/** The list with one row of every kind, on `path`. */
async function withEveryRow(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
  await mixedSetup(page);
  await page.goto(path);
  await settle(page);
}

const skipQuestion = (page: Page, platform: (typeof SETUP_ORDER)[number]) => page.getByRole("dialog", { name: `Skip ${GUIDES[platform].name}?` });

for (const scheme of SCHEMES) {
  test(`the setup list is readable as the open column, folded and under the skip question at 1440 px (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await withEveryRow(page, "/library");
    const failures: string[] = [];
    const rail = page.locator(".setup-todo--rail");
    for (const [platform, state] of Object.entries(MIXED_SETUP)) await expect(rail.locator(`.todo-row[data-platform='${platform}']`)).toHaveAttribute("data-state", state);
    await readableList(page, `open column ${scheme}`, failures);

    // The skip question over it.
    await rail.getByRole("button", { name: "Skip X", exact: true }).click();
    await expect(skipQuestion(page, "x")).toBeVisible();
    await readableList(page, `skip question over the column ${scheme}`, failures);
    await page.keyboard.press("Escape");
    await expect(skipQuestion(page, "x")).toHaveCount(0);

    // Folded to the pill: at the top of the page, then on its glass bar with the page under it.
    await page.getByRole("button", { name: "Make the setup list small" }).click();
    await expect(page.locator(".setup-todo__pill")).toBeVisible();
    await readableList(page, `folded pill ${scheme}`, failures);
    // Under the pointer it lights up; the tomato count must stay readable on that glass too.
    await page.locator(".setup-todo__pill").hover();
    await readableList(page, `folded pill under the pointer ${scheme}`, failures);
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    await readableList(page, `folded pill on its bar ${scheme}`, failures);

    // Settings keeps every platform: a skipped card with Un-skip, cards with Skip, one that needs the owner.
    await page.goto("/settings/posting/setup");
    await settle(page);
    await expect(page.locator("[data-skipped='tiktok']")).toBeVisible();
    await expect(page.locator("[data-skip]")).toHaveCount(3);
    await animationsDone(page);
    await readable(page, `Settings cards ${scheme}`, failures);
    expect(failures).toEqual([]);
  });

  for (const width of [320, 375] as const) {
    test(`the setup list is readable as the pill, the sheet and under the skip question at ${width} px (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 812 });
      await withEveryRow(page, "/library");
      const failures: string[] = [];
      const pill = page.locator(".setup-todo__pill");
      await expect(pill).toContainText("2/5");
      await readableList(page, `pill @${width} ${scheme}`, failures);
      await page.evaluate(() => window.scrollTo(0, 500));
      await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
      await readableList(page, `pill on its bar @${width} ${scheme}`, failures);
      await page.evaluate(() => window.scrollTo(0, 0));

      // The sheet, with one row of every kind.
      await pill.click();
      const sheet = page.locator(".setup-todo-panel");
      for (const [platform, state] of Object.entries(MIXED_SETUP)) await expect(sheet.locator(`.todo-row[data-platform='${platform}']`)).toHaveAttribute("data-state", state);
      await readableList(page, `sheet @${width} ${scheme}`, failures);

      // The skip question over the sheet.
      await sheet.getByRole("button", { name: "Skip X", exact: true }).click();
      await expect(skipQuestion(page, "x")).toBeVisible();
      await readableList(page, `skip question over the sheet @${width} ${scheme}`, failures);
      await page.keyboard.press("Escape");

      // Settings keeps every platform, with the Skip and Un-skip lines.
      await page.goto("/settings/posting/setup");
      await settle(page);
      await expect(page.locator("[data-skipped='tiktok']")).toBeVisible();
      await animationsDone(page);
      await readable(page, `Settings cards @${width} ${scheme}`, failures);
// ---------- The window look ----------

/** Paints each stand-in behind the transparent page and scans the text over it. axe runs once, on the darkest. */
async function scanOverGlass(page: Page, paints: readonly GlassPaint[], at: string): Promise<string[]> {
  const failures: string[] = [];
  for (const [i, paint] of paints.entries()) {
    await paintGlass(page, paint);
    if (i === 0) failures.push(...(await axeContrast(page, `${at} over ${paint.name}`)));
    failures.push(...(await scanFailures(page, `${at} over ${paint.name}`)));
  }
  return failures;
}

// The static pages (about, legal) are their own opaque pages, never see-through. The window look also covers the
// addresses the route list leaves out (This week, the skill pages).
const WINDOW_ROUTES = [...ROUTES.filter((r) => !r.endsWith(".html")), ...WINDOW_EXTRA_ROUTES];

for (const { glass, paints } of WINDOW_LOOKS) {
  for (const route of WINDOW_ROUTES) {
    test(`window look (${glass}): text on ${route} is readable over every stand-in for the glass, at 320, 375 and 1440 px`, async ({ page }) => {
      test.setTimeout(180_000);
      await asDesktop(page, glass);
      const path = await resolveRoute(page, route);
      const failures: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.goto(path);
        await settle(page);
        await animationsDone(page);
        await expect(page.locator("html"), `${path}: not in the window look`).toHaveClass(/see-through/);
        failures.push(...(await scanOverGlass(page, paints, `${path} @${width} ${glass}`)));
      }
      expect(failures).toEqual([]);
    });
  }

  test(`"All set!" is readable where the column was and in the pill's strip (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // The card says goodbye by itself after a moment; here that moment never ends, so it can be read.
    await page.addInitScript((goodbye) => {
      const real = window.setTimeout;
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => real(fn, goodbye.includes(ms ?? 0) ? 3_600_000 : ms, ...rest)) as typeof window.setTimeout;
    }, [TODO_CELEBRATE_MS, TODO_CELEBRATE_MS / 2]);
    const failures: string[] = [];
    for (const width of [375, 1440] as const) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
      await page.goto("/library");
      await settle(page);
      // Four ready and X left; skipping X ends the list.
      await page.evaluate((platforms) => {
        type MockWindow = Window & { __cfMock: { setup: { reset(): void; finish(p: string): void } } };
        sessionStorage.removeItem("cf-mock-setup-skipped");
        const mock = (window as unknown as MockWindow).__cfMock.setup;
        mock.reset();
        for (const p of platforms) mock.finish(p);
      }, SETUP_ORDER.filter((p) => p !== "x"));
      await page.goto("/library");
      await settle(page);
      await expect(page.locator(".setup-todo")).toContainText("4/5");
      if (width < 768) await page.locator(".setup-todo__pill").click();
      await page.locator(".setup-todo--rail, .setup-todo-panel").getByRole("button", { name: "Skip X", exact: true }).click();
      await skipQuestion(page, "x").getByRole("button", { name: "Skip X", exact: true }).click();
      const done = page.locator(".setup-todo--done");
      await expect(done).toContainText("All set!");
      await expect(done).toHaveAttribute("data-mode", width < 768 ? "pill" : "rail");
      await readableList(page, `All set! @${width} ${scheme}`, failures);
      await expect(done, "the card left before it was read").toBeVisible();
  // What ROUTES cannot reach by address, or shows only after a tap: surfaces that float over the page (the Ask
  // panel, a sheet, a toast) keep their own denser tint in the window look, and a starred star keeps its deep sage.
  test(`window look (${glass}): the screens behind a tap are readable too (Frosted, sign-in, a clip, This week, Ask, a sheet, a toast)`, async ({ page, browser }) => {
    test.setTimeout(240_000);
    await asDesktop(page, glass);
    const failures: string[] = [];
    const scan = async (at: string) => failures.push(...(await scanOverGlass(page, paints, `${at} ${glass}`)));
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });

      // The clip page, with its star on: white words on deep sage.
      await openClip(page, CLIPS.all);
      const star = page.getByRole("button", { name: /Best this week/ });
      if ((await star.getAttribute("aria-pressed")) !== "true") await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "true");
      await animationsDone(page);
      expect(await whiteContrastOnGradient(star), `the starred star @${width} ${glass}`).toBeGreaterThanOrEqual(4.5);
      await scan(`a clip page @${width}`);

      // This week, with a starred card.
      await page.goto("/library?view=week");
      await settle(page);
      await expect(page.locator(".week-card").first()).toBeVisible();
      const cardStar = page.locator(".star-btn--card").first();
      if ((await cardStar.getAttribute("aria-pressed")) !== "true") await cardStar.click();
      await expect(cardStar).toHaveAttribute("aria-pressed", "true");
      await animationsDone(page);
      expect(await whiteContrastOnGradient(cardStar), `a starred card @${width} ${glass}`).toBeGreaterThanOrEqual(4.5);
      await scan(`This week @${width}`);

      // A sheet over the page.
      await page.goto("/settings/clip-making/skills/01JZ8S00000000000000000001");
      await settle(page);
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("dialog").waitFor();
      await animationsDone(page);
      await scan(`the delete sheet @${width}`);

      // A toast: saving an amount in Settings › Money.
      await page.goto("/settings/posting/money");
      await settle(page);
      await page.getByLabel("Your amount for 1,000 views on YouTube").fill("2,5");
      await page.locator('[data-money-rate="youtube"]').getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved. YouTube now uses $2.50 for 1,000 views.")).toBeVisible();
      await animationsDone(page);
      await scan(`a toast @${width}`);

      // The Ask panel with an answer.
      await page.goto("/");
      await settle(page);
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
      const box = panel.getByLabel("Your question");
      await box.fill("Where do I change my click sound?");
      await box.press("Enter");
      await panel.locator(".help-actions").last().waitFor();
      await animationsDone(page);
      await scan(`the Ask panel @${width}`);
    }

    // Frosted, and the sign-in card (a fresh browser each, so nothing saved above comes along).
    for (const [name, prepare, path] of [
      ["Frosted Home", (p: Page) => asDesktop(p, glass, "frosted"), "/"],
      ["Frosted Review", (p: Page) => asDesktop(p, glass, "frosted"), "/review"],
      ["sign in", async (p: Page) => (await asDesktop(p, glass), await p.addInitScript(() => sessionStorage.setItem("cf.mockSignedOut", "1"))), "/"],
    ] as const) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const other = await context.newPage();
      await prepare(other);
      for (const width of [375, 1440]) {
        await other.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await other.goto(path);
        if (name === "sign in") await other.getByRole("button", { name: "Sign in" }).waitFor();
        await settle(other);
        await animationsDone(other);
        await expect(other.locator("html")).toHaveClass(/see-through/);
        if (name.startsWith("Frosted")) await expect(other.locator("html")).toHaveAttribute("data-strength", "frosted");
        failures.push(...(await scanOverGlass(other, paints, `${name} @${width} ${glass}`)));
      }
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}
