import { expect, test, type Page } from "@playwright/test";
import { asMacWindow, TRAFFIC_LIGHTS } from "./desktopWindow.ts";
import { arrived, settle, stillBackdrop } from "./helpers.ts";

// One top line (docs/CONTRACTS.md §11.1). Scrolled to the top, every column starts on the same horizontal line: the
// menu, the setup list (open card or pill), the settings folders and the page's first panel or title plate. Each one
// reads --top-line; none adds a number of its own. In the macOS desktop window the title bar lies over the page
// (no white strip), so the line starts below the traffic lights' band, which nothing may cover.
// With the setup list folded to its pill (narrower windows, including the desktop app's first 1200 x 820 window), the
// pill sits on the line too, at the right end of the page's first row, which leaves it room. Only below 940 px, where
// that row would be too narrow, does the page start one pill strip lower (--todo-top).
// Run in WebKit too (playwright.config.ts, project "webkit").

const ROUTES = ["/", "/jobs", "/review", "/library", "/settings", "/settings/look-and-feel/background"];

// WebKit on Linux paints without a GPU: hold the living backdrop still so frames stay cheap (helpers.ts, stillBackdrop).
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await stillBackdrop(page);
});

/** The top edge (CSS px) of each visible column, rounded to a tenth. */
async function tops(page: Page) {
  return page.evaluate(() => {
    const vis = (sel: string) =>
      [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    const top = (sel: string) => {
      const el = vis(sel);
      return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
    };
    const page = document.querySelector(".main > *");
    const first = page?.firstElementChild as HTMLElement | null;
    // The first thing the page shows: the title plate or the breadcrumbs inside a settings layout, else the first block.
    const firstTop = (() => {
      const content = document.querySelector(".settings-content");
      // The first block that takes room on the page (not a heading kept for screen readers only).
      const takesRoom = (n: Element | null | undefined) =>
        [...(n?.children ?? [])].find((c) => {
          const cs = getComputedStyle(c);
          return c.getBoundingClientRect().height > 2 && cs.position !== "absolute" && cs.position !== "fixed" && !c.matches(".sr-only");
        }) as HTMLElement | undefined;
      const el = takesRoom(content) ?? takesRoom(page) ?? first;
      const plate = el?.matches(".page-head") ? el.querySelector<HTMLElement>(".page-head__text") ?? el : el;
      return plate ? Math.round(plate.getBoundingClientRect().top * 10) / 10 : null;
    })();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:var(--top-line);height:var(--todo-top, 0px)";
    document.body.append(probe);
    const line = probe.getBoundingClientRect().top;
    const todoTop = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      line,
      todoTop,
      mode: document.querySelector<HTMLElement>(".setup-todo")?.dataset.mode ?? null,
      sidebar: top(".sidebar"),
      topbar: top(".topbar"),
      todo: top(".setup-todo:not(.setup-todo--hold)"),
      folders: top(".folders"),
      first: firstTop,
    };
  });
}

/** Asserts the tops; returns a line for the report. */
async function checkLine(page: Page, route: string) {
  await page.goto(route);
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  // The setup list arrives with its data and a short drop-in of its own: read its place once it has landed.
  await arrived(page);
  // And read once the list stands still on the line (a slow runner can still be drawing its drop-in).
  await expect
    .poll(async () => {
      const a = await tops(page);
      return a.todo === null || Math.abs(a.todo - a.line) <= 1;
    }, { timeout: 5_000 })
    .toBe(true)
    .catch(() => undefined);
  const t = await tops(page);
  const near = (v: number | null, want: number, what: string) => {
    if (v !== null) expect(Math.abs(v - want), `${route}: ${what} at ${v}, line at ${want} (${JSON.stringify(t)})`).toBeLessThanOrEqual(1);
  };
  if (t.sidebar !== null) near(t.sidebar, t.line, "menu");
  if (t.topbar !== null) near(t.topbar, t.line + t.todoTop, "top bar");
  near(t.todo, t.line, "setup list");
  // The page (and the folders beside it) start on the line, or one pill strip below it while the pill shows.
  const pageLine = t.mode === "pill" ? t.line + t.todoTop : t.line;
  if (t.topbar === null) near(t.first, pageLine, "page");
  near(t.folders, pageLine, "settings folders");
  return `${route} ${JSON.stringify(t)}`;
}

/** Nothing the owner can see or press sits in the traffic lights' band. */
async function lightsClear(page: Page) {
  const hits = await page.evaluate(({ x, y, width, height }) => {
    const out: string[] = [];
    for (let px = x + 4; px < x + width; px += 8)
      for (let py = y + 2; py < y + height; py += 6) {
        for (const el of document.elementsFromPoint(px, py)) {
          if (el.matches("html, body, #root, .app, .shell, .main, .backdrop, .backdrop *, .titlebar-drag, .setup-todo-bar, .setup-todo-bar *")) continue;
          out.push(`${el.tagName}.${el.className}`);
        }
      }
    return [...new Set(out)];
  }, TRAFFIC_LIGHTS);
  expect(hits, "covers the traffic lights").toEqual([]);
}

for (const size of [
  { width: 1000, height: 650 },
  { width: 1200, height: 820 },
  { width: 1440, height: 900 },
]) {
  test(`the macOS desktop window at ${size.width} x ${size.height}: one top line below the traffic lights`, async ({ page }) => {
    await page.setViewportSize(size);
    await asMacWindow(page);
    const report: string[] = [];
    for (const route of ROUTES) {
      report.push(await checkLine(page, route));
      const t = await tops(page);
      // 28 px for the title bar band, then the usual 14 px.
      expect(t.line).toBe(42);
      await lightsClear(page);
    }
    // The band is the window's title bar: invisible, and pressing it drags the window (Tauri's drag script).
    const strip = page.locator(".titlebar-drag");
    await expect(strip).toHaveAttribute("data-tauri-drag-region", "");
    const s = await strip.evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, width: r.width, bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
    });
    // Exactly the title bar (28 px), never the air below it, where page controls scroll up and must still take a click.
    expect(s).toEqual({ top: 0, height: 28, width: size.width, bg: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none" });
    test.info().annotations.push({ type: "tops", description: report.join("\n") });
  });
}

test("the macOS desktop window: a control scrolled up just under the title bar still takes its click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await asMacWindow(page);
  await page.goto("/library");
  await settle(page);
  const week = page.locator(".lib-tab", { hasText: "This week" });
  // Scroll so the tab's top sits at 30 px: below the 28 px title bar, inside the 14 px of air above the top line.
  const top = await week.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), top - 30);
  const b = (await week.boundingBox())!;
  expect(b.y).toBeLessThan(42);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".lib-tab") !== null, { x: b.x + b.width / 2, y: 34 })).toBe(true);
  await page.mouse.click(b.x + b.width / 2, 34);
  await expect(page).toHaveURL(/view=week/);
});

test("a Windows or Linux desktop window keeps its own frame: no band", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await asMacWindow(page, { titlebar: 0 });
  await checkLine(page, "/settings");
  expect((await tops(page)).line).toBe(14);
  await expect(page.locator(".titlebar-drag")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.dataset.titlebar ?? null)).toBeNull();
});

test("a web page that claims a title bar is not the desktop app: no band", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => ((window as unknown as Record<string, unknown>).__CF_TITLEBAR__ = 28));
  await page.goto("/");
  await settle(page);
  expect((await tops(page)).line).toBe(14);
  await expect(page.locator(".titlebar-drag")).toBeHidden();
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1000, height: 650 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
]) {
  test(`a browser at ${size.width} x ${size.height}: one top line`, async ({ page }) => {
    await page.setViewportSize(size);
    const report: string[] = [];
    for (const route of ROUTES) report.push(await checkLine(page, route));
    expect((await tops(page)).line).toBe(size.width >= 768 ? 14 : 12);
    await expect(page.locator(".titlebar-drag")).toBeHidden();
    test.info().annotations.push({ type: "tops", description: report.join("\n") });
  });
}
