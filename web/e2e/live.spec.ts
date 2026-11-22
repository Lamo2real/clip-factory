import { expect, test, type Page } from "@playwright/test";
import { animationsDone, findOverflow, settle, WIDTHS } from "./helpers.ts";

// Live updates in mock mode: a fake WebSocket on the in-memory store (docs/CONTRACTS.md §14.2, §14.12).
interface LiveControls {
  open(): number;
  drop(): void;
  advance(): void;
  setAvailable(on: boolean): void;
  line(at?: number): void;
}
type MockWindow = Window & {
  __cfMockLive?: LiveControls;
  __cfMockCalls?: Record<string, number>;
  __cfMockFaults?: { similarEmpty?: boolean };
};

const calls = (page: Page, name: string) => page.evaluate((n) => (window as MockWindow).__cfMockCalls?.[n] ?? 0, name);
const liveDot = (page: Page) => page.locator(".live-dot").filter({ visible: true });

test("job progress arrives over the live connection, without polling", async ({ page }) => {
  // Opened from the list in the app (a reload makes a fresh mock store with new ids).
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Ranked grind" }).click();
  await expect(page.locator(".panel__pct")).toBeVisible();
  await expect(liveDot(page)).toBeVisible();
  await expect(liveDot(page)).toContainText("Live");

  const pct = page.locator(".panel__pct");
  const before = await pct.innerText();
  const polls = await calls(page, "getJob");
  await page.evaluate(() => (window as MockWindow).__cfMockLive!.advance());
  await expect(pct).not.toHaveText(before);
  const second = await pct.innerText();
  await page.evaluate(() => (window as MockWindow).__cfMockLive!.advance());
  await expect(pct).not.toHaveText(second);
  // The screen changed, and it did not ask the server: the update came over the socket.
  expect(await calls(page, "getJob")).toBe(polls);
});

test("the jobs list moves along live too", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await expect(liveDot(page)).toBeVisible();
  const row = page.locator(".job-row", { hasText: "Ranked grind" });
  const step = row.locator(".job-row__step");
  const before = await step.innerText();
  const polls = await calls(page, "listJobs");
  await page.evaluate(() => (window as MockWindow).__cfMockLive!.advance());
  await expect(step).not.toHaveText(before);
  expect(await calls(page, "listJobs")).toBe(polls);
});

test("a dropped connection reconnects quietly and fetches again", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await expect(liveDot(page)).toBeVisible();
  const fetches = await calls(page, "listJobs");
  await page.evaluate(() => (window as MockWindow).__cfMockLive!.drop());
  // Gone while down (never a warning), back within the first 1-second backoff.
  await expect(liveDot(page)).toHaveCount(0);
  await expect(liveDot(page)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".toast")).toHaveCount(0);
  // The reconnect refetched what is on screen.
  await expect.poll(() => calls(page, "listJobs")).toBeGreaterThan(fetches);
  expect(await page.evaluate(() => (window as MockWindow).__cfMockLive!.open())).toBe(1);
});

test("with the live API unavailable the app keeps working on polls, with no dot and no warning", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.evaluate(() => {
    const live = (window as MockWindow).__cfMockLive!;
    live.setAvailable(false);
    live.drop();
  });
  await expect(liveDot(page)).toHaveCount(0);
  // The wait is the test: given time, still no dot and no message.
  await page.waitForTimeout(2500);
  await expect(liveDot(page)).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".job-row").first()).toBeVisible();
});

test("the Live dot shows in the sidebar on larger screens and in the top bar on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await settle(page);
  // The sidebar foot's Live chip row (the shell draws it there next to Lamo Stories, §45.37).
  await expect(page.locator(".sidebar__live .live-dot")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.locator(".topbar .live-dot")).toBeVisible();
  await expect(page.locator(".topbar .live-dot")).toHaveAttribute("title", "Live: changes show up by themselves");
});

test("Review and Library show clips that did well, and hide the strip when there are none", async ({ page }) => {
  await page.goto("/review");
  await settle(page);
  const strip = page.locator(".review-card").first().locator(".similar");
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("heading", { name: "Like clips that did well" })).toBeVisible();
  const items = strip.locator(".similar__item");
  expect(await items.count()).toBeGreaterThan(0);
  expect(await items.count()).toBeLessThanOrEqual(5);
  await expect(items.first()).toContainText(/views/);
  await expect(items.first()).toContainText(/% alike/);

  await page.goto("/library");
  await settle(page);
  await expect(page.locator(".lib-card .similar").first()).toBeVisible();

  // Nothing measured yet: no strip at all, not an empty one. (In-app navigation keeps the mock's knobs.)
  await page.evaluate(() => {
    (window as MockWindow).__cfMockFaults!.similarEmpty = true;
  });
  await page.locator(".sidebar__item[href='/review'], .tabbar__item[href='/review']").filter({ visible: true }).first().click();
  await expect(page.locator(".review-card").first()).toBeVisible();
  // The wait is the test: given time, the strip still does not come.
  await page.waitForTimeout(800);
  await expect(page.locator(".similar")).toHaveCount(0);
  await expect(page.getByText("Like clips that did well")).toHaveCount(0);
});

test("the hooks API's old return links open that platform's setup", async ({ page }) => {
  await page.goto("/settings?account=instagram&status=coming_soon");
  await settle(page);
  // Accounts became Set up posting (§17.1): the link lands on Instagram's steps, and "coming soon" is gone.
  await expect(page).toHaveURL(/\/settings\/posting\/setup\/instagram$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up Instagram" })).toBeVisible();
  await expect(page.getByText("arrives soon")).toHaveCount(0);
});

// Nothing may run out of its box at any width (docs/CONTRACTS.md §11), including the new strip and the Live dot.
for (const width of WIDTHS) {
  test(`the clips-that-did-well strip and the Live dot fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const failures: string[] = [];
    for (const path of ["/review", "/library", "/settings?account=youtube&status=coming_soon"]) {
      await page.goto(path);
      await settle(page);
      await expect(liveDot(page)).toBeVisible();
      if (path !== "/review" && path !== "/library") {
        const r = await findOverflow(page);
        for (const o of r.items) failures.push(`${path}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
        continue;
      }
      // Bring every strip on screen so each one loads, then check the whole page.
      const cards = page.locator(path === "/review" ? ".review-card" : ".lib-card");
      const n = await cards.count();
      for (let i = 0; i < n; i++) await cards.nth(i).scrollIntoViewIfNeeded();
      await expect(page.locator(".similar").first()).toBeVisible();
      await animationsDone(page); // the strips have come in
      const r = await findOverflow(page);
      if (r.page > r.viewport) failures.push(`${path}: page scrolls sideways (${r.page}px > ${r.viewport}px)`);
      for (const o of r.items) failures.push(`${path}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
      // The strip scrolls inside itself; it never makes its card wider.
      const wider = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".similar")).filter((s) => {
          const card = s.closest(".review-card, .lib-card")!;
          return s.getBoundingClientRect().right > card.getBoundingClientRect().right + 1;
        }).length,
      );
      if (wider) failures.push(`${path}: ${wider} strip(s) wider than their card`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
}

// The live status line (docs/CONTRACTS.md §31): what the job is doing right now, in one line, pushed over the socket.
const pushLine = (page: Page, at: number) => page.evaluate((k) => (window as MockWindow).__cfMockLive!.line(k), at);

test("the job page shows what it is doing right now, and the line moves live", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Ranked grind" }).click();
  await expect(liveDot(page)).toContainText("Live");
  const line = page.locator(".live-line");
  await expect(line).toBeVisible();
  const polls = await calls(page, "getJob");

  await pushLine(page, 0);
  await expect(line.locator(".live-line__text")).toHaveText("Cutting clip 3 of 7");
  await expect(line.locator(".live-line__detail")).toHaveText("0:41 of 0:58");
  await expect(line.locator(".live-line__tech")).toHaveText("ffmpeg · 1080×1920 · 30 fps");
  const heard = page.locator('.live-line [role="status"]');
  await expect(heard).toHaveText("Cutting clip 3 of 7.");

  // The seconds move: the screen changes, a screen reader hears nothing new.
  await pushLine(page, 1);
  await expect(line.locator(".live-line__detail")).toHaveText("0:52 of 0:58");
  await expect(heard).toHaveText("Cutting clip 3 of 7.");
  // The next clip: heard once.
  await pushLine(page, 2);
  await expect(line.locator(".live-line__text")).toHaveText("Cutting clip 4 of 7");
  await expect(heard).toHaveText("Cutting clip 4 of 7.");
  // A model call: the web counts the seconds itself.
  await pushLine(page, 3);
  await expect(line.locator(".live-line__text")).toHaveText("Checking clip 4 of 7 with Claude");
  await expect(line.locator(".live-line__detail")).toHaveText(/^1:1\d$/);
  await expect(line.locator(".live-line__detail")).not.toHaveText(await line.locator(".live-line__detail").innerText());
  // Only the hidden status is a live region, never the moving words.
  expect(await line.locator(".live-line__body [aria-live]").count()).toBe(0);
  expect(await calls(page, "getJob")).toBe(polls);
});

test("the jobs list and Home's Working now show the same line", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await expect(liveDot(page)).toBeVisible();
  const step = page.locator(".job-row", { hasText: "Ranked grind" }).locator(".job-row__step");
  await pushLine(page, 2);
  await expect(step).toContainText("Cutting clip 4 of 7");
  await expect(step).toHaveClass(/clamp-1/);

  await page.goto("/");
  await settle(page);
  await expect(liveDot(page)).toBeVisible();
  const working = page.locator(".working__job", { hasText: "Ranked grind" }).locator(".working__step");
  await pushLine(page, 0);
  await expect(working).toContainText("Cutting clip 3 of 7");
  await pushLine(page, 3);
  await expect(working).toContainText("Checking clip 4 of 7 with Claude");
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    const r = await findOverflow(page);
    expect(r.page, `page scrolls sideways at ${w}px`).toBeLessThanOrEqual(r.viewport);
    expect(r.items, `something runs out of its box at ${w}px`).toEqual([]);
  }
});
