import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { contrast, FLOAT_VEIL, luminance, mix, TABBAR_VEIL, type Rgb } from "../src/lib/background.ts";
import { DODGE_SETTLE_MS } from "../src/features/help/dodge.ts";
import { TODO_CELEBRATE_MS } from "../src/lib/setupTodo.ts";
import { GUIDES, SETUP_ORDER } from "../src/setup/index.ts";
import { decode } from "./pixels.ts";
import { asDesktop, paintGlass, WINDOW_EXTRA_ROUTES, WINDOW_LOOKS, type GlassPaint } from "./glass.ts";
import { animationsDone, CLIPS, looseText, MIXED_SETUP, mixedSetup, openClip, resolveRoute, ROUTES, scanText, settle, whiteContrastOnGradient } from "./helpers.ts";

// Every screen's text is readable (audit F081, WCAG 2.1 AA 1.4.3; docs/TESTING.md "Contrast and text size"):
// at 320, 375 and 1440 px, with the browser asking for light and for dark (the app is light-only, so dark must
// look the same), on every route in ROUTES:
//   1. axe-core's color-contrast rule finds no violation;
//   2. every visible text run, and what a field shows (typed words, or its placeholder), reaches 4.5:1 (3:1 for
//      a placeholder, which is a faded hint, and for 24 px, or 18.66 px bold, and up) against every background it can sit on: its ancestors' colours and glass
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

/** The axe color-contrast rule's violations on the page as it is, one line each. */
async function axeContrast(page: Page, at: string): Promise<string[]> {
  const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  return axe.violations.flatMap((v) => v.nodes.map((n) => `${at} axe: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`));
}

/** The rendered-contrast and text-size scan (`scanText`) on the page as it is: one line per failure, and how many text runs it read. */
async function scanRuns(page: Page, at: string): Promise<{ failures: string[]; checked: number }> {
  const scan = await scanText(page, DECORATIVE);
  expect(scan.checked, `${at}: found no text to check`).toBeGreaterThan(0);
  test.info().annotations.push({ type: "text runs", description: `${at}: ${scan.checked} checked, ${scan.pictures} on a picture (axe only)` });
  return {
    checked: scan.checked,
    failures: [
      ...scan.contrast.map((f) => `${at} contrast: ${f.selector} "${f.text}" ${f.ratio}:1 < ${f.need}:1 (${f.color} on ${f.background}, ${f.fontSize}px)`),
      ...scan.tiny.map((f) => `${at} size: ${f.selector} "${f.text}" is ${f.fontSize}px (< 12px)`),
    ],
  };
}

const scanFailures = async (page: Page, at: string): Promise<string[]> => (await scanRuns(page, at)).failures;

/** The three checks on what is on screen now; what fails is added to `failures`. Returns how many text runs it read. */
async function readable(page: Page, at: string, failures: string[]): Promise<number> {
  const scan = await scanRuns(page, at);
  failures.push(...(await axeContrast(page, at)), ...scan.failures);
  return scan.checked;
}

/** Content Rewards' own pages (§38.20): its setup, the campaigns list, a campaign card and the Money part. */
const CR_ROUTES = ["/settings/posting/setup/contentrewards", "/campaigns", "/campaigns/200ea21b-be80-4db8-b552-8e32b148604e", "/campaigns/a1cefc3b-4533-438f-8e70-a7299550f1cf"];

for (const route of [...ROUTES, ...CR_ROUTES]) {
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

/** The "All set!" card says goodbye by itself after a moment; after this that moment never ends, so it can be read. */
const keepAllSet = (page: Page) =>
  page.addInitScript((goodbye) => {
    const real = window.setTimeout;
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => real(fn, goodbye.includes(ms ?? 0) ? 3_600_000 : ms, ...rest)) as typeof window.setTimeout;
  }, [TODO_CELEBRATE_MS, TODO_CELEBRATE_MS / 2]);

/** Ends the list at this width (four ready, then X skipped) and returns the "All set!" card. */
async function allSet(page: Page, width: number) {
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
  return done;
}

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
    // Under the pointer it lights up; the vermilion count must stay readable on that glass too.
    await page.locator(".setup-todo__pill").hover();
    await readableList(page, `folded pill under the pointer ${scheme}`, failures);
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    // Ask may step aside from a control that scrolled under it: let it settle (it waits for the page to be still,
    // then fades) before reading, or the scan catches it half faded.
    await page.waitForTimeout(DODGE_SETTLE_MS + 100);
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
      expect(failures).toEqual([]);
    });
  }

  test(`"All set!" is readable where the column was and in the pill's strip (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await keepAllSet(page);
    const failures: string[] = [];
    for (const width of [375, 1440] as const) {
      const done = await allSet(page, width);
      await readableList(page, `All set! @${width} ${scheme}`, failures);
      await expect(done, "the card left before it was read").toBeVisible();
    }
    expect(failures).toEqual([]);
  });
}

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

  // The floating setup to-do list (§17.13) in every face: the routes above only carry five "Not started" rows.
  test(`window look (${glass}): the setup list is readable and on a tint as the pill, the sheet, the column, under the skip question and as "All set!"`, async ({ page }) => {
    test.setTimeout(240_000);
    await asDesktop(page, glass);
    await keepAllSet(page);
    const failures: string[] = [];
    const scan = async (at: string) => {
      await animationsDone(page);
      expect(await listRuns(page), `${at}: the list shows no words`).toBeGreaterThan(0);
      failures.push(...(await scanOverGlass(page, paints, `${at} ${glass}`)), ...(await looseText(page)).map((t) => `${at} ${glass} straight on the window: ${t}`));
    };

    // A phone: the pill, the pill on its bar, the sheet, the skip question.
    await page.setViewportSize({ width: 375, height: 812 });
    await withEveryRow(page, "/library");
    await expect(page.locator("html")).toHaveClass(/see-through/);
    const pill = page.locator(".setup-todo__pill");
    await expect(pill).toContainText("2/5");
    await scan("the pill @375");
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    await scan("the pill on its bar @375");
    await page.evaluate(() => window.scrollTo(0, 0));
    await pill.click();
    const sheet = page.locator(".setup-todo-panel");
    await expect(sheet.locator(".todo-row[data-platform='tiktok']")).toHaveAttribute("data-state", "skipped");
    await scan("the sheet @375");
    await sheet.getByRole("button", { name: "Skip X", exact: true }).click();
    await expect(skipQuestion(page, "x")).toBeVisible();
    await scan("the skip question over the sheet @375");
    await page.keyboard.press("Escape");

    // A wide screen: the open column, the skip question, then folded to the pill (at rest, under the pointer, on its bar).
    await page.setViewportSize({ width: 1440, height: 900 });
    await withEveryRow(page, "/library");
    const rail = page.locator(".setup-todo--rail");
    for (const [platform, state] of Object.entries(MIXED_SETUP)) await expect(rail.locator(`.todo-row[data-platform='${platform}']`)).toHaveAttribute("data-state", state);
    await scan("the open column @1440");
    await rail.getByRole("button", { name: "Skip X", exact: true }).click();
    await expect(skipQuestion(page, "x")).toBeVisible();
    await scan("the skip question over the column @1440");
    await page.keyboard.press("Escape");
    await expect(skipQuestion(page, "x")).toHaveCount(0);
    await page.getByRole("button", { name: "Make the setup list small" }).click();
    await expect(pill).toBeVisible();
    await scan("the folded pill @1440");
    await pill.hover();
    await scan("the folded pill under the pointer @1440");
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    await scan("the folded pill on its bar @1440");
    await pill.click();
    await expect(rail).toBeVisible();

    // "All set!", in the pill's strip and where the column was.
    for (const width of [375, 1440] as const) {
      const done = await allSet(page, width);
      await scan(`All set! @${width}`);
      await expect(done, "the card left before it was read").toBeVisible();
    }
    expect(failures).toEqual([]);
  });

  // What ROUTES cannot reach by address, or shows only after a tap: surfaces that float over the page (the Ask
  // panel, a sheet, a toast) keep their own denser tint in the window look, and a starred star keeps its the vermilion CTA fill.
  test(`window look (${glass}): the screens behind a tap are readable too (Frosted, sign-in, a clip, This week, Ask, a sheet, a toast)`, async ({ page, browser }) => {
    test.setTimeout(240_000);
    await asDesktop(page, glass);
    const failures: string[] = [];
    const scan = async (at: string) => failures.push(...(await scanOverGlass(page, paints, `${at} ${glass}`)));
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });

      // The clip page, with its star on: white words on the vermilion CTA fill.
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

      // A toast: picking the country in Settings › Posting › Money (§25.7).
      await page.goto("/settings/posting/money");
      await settle(page);
      await page.locator(".money-country__select").selectOption("SE");
      await expect(page.getByText("Saved. Your country is Sweden.")).toBeVisible();
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

// ---------- What content scrolls under, at phone width (ADR-45) ----------
// The tab bar, the setup pill and the Ask sheet float over the page, so a white thumbnail can sit right under them.
// Their tints plan for white (FLOAT_VEIL, TABBAR_VEIL): here the Library is scrolled so clip thumbnails are under the
// tab bar, the real computed tints are read in the browser, and every text colour inside each layer (icons in the tab
// bar, 3:1) is held to what the browser really draws behind it over white: the layer's green with its bone light from
// above (ADR-85), the page under it made white and the layer's own words and icons hidden, measured from the pixels
// at each word and icon (the lightest pixel there, the worst for bone words).
test("the tab bar, the setup pill and the Ask sheet hold their words over a white thumbnail, at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  await settle(page);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(400);
  const read = (selector: string) =>
    page.locator(selector).first().evaluate((layer) => {
      const s = getComputedStyle(layer);
      // The green of its tint (its bone light from above lies on top of it, ADR-85, and is measured from the pixels).
      const alphas = [...s.backgroundImage.matchAll(/rgba?\((15, 55, 43[^)]*)\)/g)].map((m) => {
        const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
        return parts.length >= 4 ? Number(parts[3]) : 1;
      });
      const box = layer.getBoundingClientRect();
      const marks: { color: string; x: number; y: number; w: number; h: number }[] = [];
      for (const el of [layer, ...Array.from(layer.querySelectorAll<HTMLElement>("*"))]) {
        const cs = getComputedStyle(el);
        if (el.closest(".sr-only, .glide, .is-active, [aria-current='page'], .badge, .btn--primary, .btn--action, .help-msg--me, .setup-todo__pill-count") || cs.visibility === "hidden" || el.getClientRects().length === 0) continue;
        if (!(Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) || el.tagName === "svg")) continue;
        // Green and white words sit on bone and vermilion fills of their own, read by the scans above.
        if (["rgb(15, 55, 43)", "rgb(255, 255, 255)"].includes(cs.color)) continue;
        const r = el.getBoundingClientRect();
        const [x0, y0] = [Math.max(r.left, box.left), Math.max(r.top, box.top)];
        const [x1, y1] = [Math.min(r.right, box.right, innerWidth), Math.min(r.bottom, box.bottom, innerHeight)];
        if (x1 - x0 >= 2 && y1 - y0 >= 2) marks.push({ color: cs.color, x: Math.round(x0 - box.left), y: Math.round(y0 - box.top), w: Math.floor(x1 - x0), h: Math.floor(y1 - y0) });
      }
      return { min: Math.min(...alphas), box: { x: box.left, y: box.top, width: box.width, height: box.height }, marks };
    });
  const rgb = (css: string): Rgb => css.match(/[\d.]+/g)!.slice(0, 3).map(Number) as unknown as Rgb;
  const check = async (selector: string, floor: number, need: number) => {
    // Let the layer come to rest first: WebKit slides the setup pill in from above for a moment after the scroll.
    const layer = page.locator(selector).first();
    await expect
      .poll(async () => {
        const a = await layer.boundingBox();
        await page.waitForTimeout(120);
        const b = await layer.boundingBox();
        return !!a && !!b && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 0.5;
      })
      .toBe(true);
    const { min, box, marks } = await read(selector);
    expect(min, `${selector} tint`).toBeGreaterThanOrEqual(floor - 0.005);
    expect(marks.length, `${selector} has words or icons`).toBeGreaterThan(0);
    // A white thumbnail right under the whole layer: everything else is hidden over a white sheet. The layer's own
    // words and icons are made clear, but its raised children (a button, a row, a chip) keep their fills and lights,
    // so words on a raised child are read over that child's real fill, as the browser draws it.
    const tag = await page.addStyleTag({
      content: `body > .cf-white-under { position: fixed; inset: 0; z-index: 0; background: #fff; visibility: visible !important; }
        body *:not(.cf-white-under) { visibility: hidden !important; transition: none !important; animation: none !important; }
        html body ${selector} { visibility: visible !important; }
        html body ${selector} * { visibility: visible !important; color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }
        html body ${selector} :is(svg, img, video, canvas) { visibility: hidden !important; }`,
    });
    await page.evaluate(() => {
      const white = document.createElement("div");
      white.className = "cf-white-under";
      document.body.prepend(white);
    });
    await page.waitForTimeout(300);
    // Where the layer is now: with animations off WebKit puts the setup pill back where it rests, a few px from where
    // it was read. The marks move with it (they are placed from its top left).
    const at = (await layer.boundingBox()) ?? box;
    const clip = { x: Math.max(0, at.x), y: Math.max(0, at.y), width: Math.min(at.width, 390 - Math.max(0, at.x)), height: Math.min(at.height, 844 - Math.max(0, at.y)) };
    const shot = await decode(page, await page.screenshot({ clip }));
    await page.evaluate(() => document.querySelector(".cf-white-under")?.remove());
    await tag.evaluate((el) => (el as Element).remove());
    // The marks are placed from the layer's top left in CSS px; the shot starts at the screen's edge if the layer runs
    // past it, and has the device's pixels (2 per CSS px in Desktop Safari).
    const [ox, oy] = [clip.x - at.x, clip.y - at.y];
    const k = shot.width / clip.width;
    for (const m of marks) {
      // The lightest pixel behind the mark: the hardest spot for bone words and icons.
      let lightest: Rgb = [0, 0, 0];
      for (let y = Math.max(0, Math.round((m.y - oy) * k)); y < Math.min(Math.round((m.y - oy + m.h) * k), shot.height); y++)
        for (let x = Math.max(0, Math.round((m.x - ox) * k)); x < Math.min(Math.round((m.x - ox + m.w) * k), shot.width); x++) {
          const i = (y * shot.width + x) * 4;
          const px: Rgb = [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
          if (luminance(px) > luminance(lightest)) lightest = px;
        }
      // The layer really painted there (not the white sheet), and its words keep their contrast over it.
      expect(luminance(lightest), `${selector}: its green is drawn behind its words`).toBeLessThan(0.5);
      expect(contrast(rgb(m.color), lightest), `${selector} ${m.color} over the drawn ${lightest.map(Math.round).join(" ")}`).toBeGreaterThanOrEqual(need);
    }
  };
  await check(".tabbar", TABBAR_VEIL, 3);
  await check(".setup-todo__pill", FLOAT_VEIL, 4.5);
  // The Ask launcher floats over the page as well (an icon on a phone, 3:1; with its word on wider screens, 4.5:1).
  await check(".help-launcher", FLOAT_VEIL, 4.5);
  await page.locator(".tabbar").screenshot({ path: test.info().outputPath("tabbar-over-thumbnails.png") });
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await page.locator(".help-panel").waitFor();
  await animationsDone(page);
  await check(".help-panel", FLOAT_VEIL, 4.5);
});

// ---------- Controls outside a panel, over a white picture (ADR-45) ----------
// The picture look has no page veil, so a control that sits straight on the page (the Library's tabs) carries its own
// fill. Over a white picture, every word on it is held to AA, worked out from the fill the browser really draws.
test("the Library tabs stay readable over a white picture, at 390 and 1440 px", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.goto("/settings/look-and-feel/background");
    await settle(page);
    const white = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 16, 16);
      return c.toDataURL("image/png").split(",")[1]!;
    });
    await page.getByRole("radio", { name: "Picture" }).check();
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "white.png", mimeType: "image/png", buffer: Buffer.from(white, "base64") });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.backdrop)).toBe("picture");
    await page.goto("/library");
    await settle(page);
    const tabs = await page.locator(".lib-tab:not(.is-on)").evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        const nums = (css: string) =>
          [...css.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
            const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
            return [p[0]!, p[1]!, p[2]!, p.length >= 4 ? p[3]! : 1] as [number, number, number, number];
          });
        // Every painted ancestor up to the page: a loose control has none, so the white picture is right under it.
        let painted = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (nums(cs.backgroundColor).some((c) => c[3] > 0) || cs.backgroundImage !== "none") painted = true;
        }
        return { text: el.textContent!.trim(), color: s.color, base: nums(s.backgroundColor)[0] ?? [0, 0, 0, 0], layers: nums(s.backgroundImage), painted };
      }),
    );
    expect(tabs.length, `unselected tabs @${width}`).toBeGreaterThan(0);
    for (const t of tabs) {
      // Over white: the fill colour, then each image layer on top (top-most first in CSS, so reversed).
      let under: Rgb = [255, 255, 255];
      under = mix([t.base[0], t.base[1], t.base[2]], under, t.base[3]);
      for (const l of [...t.layers].reverse()) under = mix([l[0], l[1], l[2]], under, l[3]);
      const ink = t.color.match(/[\d.]+/g)!.slice(0, 3).map(Number) as unknown as Rgb;
      expect(contrast(ink, under), `"${t.text}" @${width} (painted ancestor: ${t.painted})`).toBeGreaterThanOrEqual(4.5);
    }
    await page.locator(".lib-tabs").screenshot({ path: test.info().outputPath(`lib-tabs-white-picture-${width}.png`) });
  }
});

// Ask as a full assistant (§28, review C14): a file tile's format label, name and size, the status line while an
// answer thinks, and the sources list under an answer, at 375 and 1440 px in both schemes.
const ASK_PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n").toString("base64");
for (const scheme of SCHEMES) {
  test(`Ask's file tiles, status line and sources are readable at 375 and 1440 px (${scheme})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const failures: string[] = [];
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
      await page.goto("/");
      await settle(page);
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      const panel = page.locator("#help-panel");
      await panel.waitFor();
      await page.evaluate((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "report.pdf", { type: "application/pdf" }));
        const e = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
        if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
        document.querySelector(".help-panel__log")!.dispatchEvent(e);
      }, ASK_PDF_B64);
      await panel.locator(".ask-file__format").first().waitFor();
      await animationsDone(page);
      await readable(page, `Ask file tile @${width} ${scheme}`, failures);
      // The status line while the answer thinks (#slow holds the first words back for 9 s).
      await panel.getByLabel("Your question").fill("Where do I change my click sound? #slow");
      await panel.getByRole("button", { name: "Send" }).click();
      await panel.locator(".ask-status").first().waitFor();
      await readable(page, `Ask status line @${width} ${scheme}`, failures);
      // A fresh chat for the answer with web sources.
      await page.goto("/");
      await settle(page);
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      await panel.waitFor();
      await panel.getByLabel("Your question").fill("I made the Meta app, what now? #search");
      await panel.getByRole("button", { name: "Send" }).click();
      await panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" }).waitFor({ timeout: 30_000 });
      await panel.locator(".ask-source__link").first().waitFor();
      await animationsDone(page);
      await readable(page, `Ask sources @${width} ${scheme}`, failures);
    }
    expect(failures).toEqual([]);
  });
}
