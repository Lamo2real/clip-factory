import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle, WIDTHS } from "./helpers.ts";

// The Lamo Stories shell (docs/CONTRACTS.md §45.16, §45.29, §45.30): the switcher reads "Clip Factory | Lamo
// Stories"; switching both ways goes back to the exact page left (Clip Factory's at its scroll position, Ask with
// its conversation and an answer still streaming in); the choice survives a reload; the app opened at "/" with Lamo
// Stories last goes to the last Lamo Stories page; the first time, the setup opens by itself (11 skippable steps,
// the ring, what is left, the dashboard card until finished; a platform skipped leaves every reminder); Social accounts
// is a row per platform, each opening the platform's own page with its developer-app choice, keys, Check it, the
// authorization status and Check now; and every page of the shell keeps the owner's
// rules: nothing overflows from 320 to 1920 px, the arrow cursor only, AA contrast, no visible edges, targets of
// 44 px (48 on phones). Lamo Stories is switched on here with cf.storiesPreview = 1.

const PAGES = [
  "/stories",
  "/stories/library",
  "/stories/library?kind=videos",
  "/stories/connections",
  // Each platform's own page (its card was on Social accounts before).
  "/stories/connections/youtube",
  "/stories/connections/tiktok",
  "/stories/connections/instagram",
  "/stories/connections/facebook",
  "/stories/connections/x",
  "/stories/setup",
];

/** A platform's card on its own page (opened from its row on Social accounts, so the pretend app keeps what it holds). */
async function platformCard(page: Page, name: string) {
  const slug = name.toLowerCase();
  if (!/\/stories\/connections$/.test(new URL(page.url()).pathname)) {
    await page.goto("/stories/connections");
    await storiesReady(page);
  }
  await page.locator(`.st-social-row-wrap[data-platform="${slug}"] a.st-social-row`).click();
  await expect(page).toHaveURL(new RegExp(`/stories/connections/${slug}$`));
  await storiesReady(page);
  return page.locator(".st-conn").filter({ has: page.getByRole("heading", { name, exact: true }) });
}
/** Back to Social accounts' list, by its breadcrumb. */
async function backToList(page: Page) {
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Social accounts" }).click();
  await expect(page).toHaveURL(/\/stories\/connections$/);
}

async function on(page: Page, extra?: () => void) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  if (extra) await page.addInitScript(extra);
}

/** A brand-new studio: nothing set up, nothing connected, no developer app picked (the mock's `fresh` knob). */
async function fresh(page: Page) {
  await on(page, () => {
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
  });
}

/** The shell has checked its workspace and the page has its words (no "Getting it ready…" left). */
async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

test.describe("switching", () => {
  test("both ways lands on the exact page left, on a computer", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/library?view=week");
    await settle(page);
    // One choice per workspace, Lamo Clips by the app's own name.
    await expect(page.locator(".ws-dock .ws-switch__opt")).toHaveText(["Clip Factory", "Clips Funded"]);
    await expect(page.locator(".ws-dock .ws-switch__opt.is-on")).toHaveText("Clip Factory");
    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await expect(page.locator(".ws-dock .ws-switch__opt")).toHaveText(["Clip Factory", "Clips Funded"]);
    await expect(page.locator(".ws-dock .ws-switch__opt.is-on")).toHaveText("Clips Funded");
    await expect(page.locator(".st-rail .st-rail__label")).toHaveText(["Dashboard", "Ideas", "Characters", "Cars", "Production", "Review", "Series", "Chat", "References", "Library", "Social accounts", "Settings"]);
    await page.locator(".st-rail").getByRole("link", { name: "Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);

    await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
    await expect(page).toHaveURL(/\/library\?view=week$/);
    await settle(page);
    // Lamo Stories stays mounted behind Clip Factory (§45.34): hidden and inert, nothing of it on screen.
    await expect(page.locator('[data-app-pane="stories"]')).toHaveAttribute("inert", "");
    await expect(page.locator('[data-app-pane="stories"]')).toBeHidden();
    await expect(page.locator(".stories-app")).toBeHidden();
    await expect(page.locator('[data-app-pane="clips"]')).not.toHaveAttribute("inert");
    await expect(page.locator("nav.sidebar .sidebar__item.is-active")).toHaveAttribute("data-help", "nav-library");

    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { level: 1, name: "Social accounts" })).toBeVisible();
  });

  test("on the smallest phone (320 px) the top bar's toggle is a full 48 px one (the brand keeps its mark, drops its name) and switches in one tap", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/review");
    await settle(page);
    const host = page.locator(".topbar .ws-switch-host");
    await expect(host).toHaveAttribute("data-ws-switch", "round");
    await expect(host).toHaveAttribute("data-ws-squeeze", "");
    const toggle = (await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).boundingBox())!;
    expect(toggle.width).toBeGreaterThanOrEqual(44);
    expect(toggle.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".topbar .brand__name")).toBeHidden();
    await expect(page.locator(".topbar .brand__mark")).toBeVisible();
    await expect(page.locator(".topbar").getByRole("link", { name: "Clip Factory home" })).toBeVisible();
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
  });

  test("E16: from 340 px up the brand keeps its name, and every phone width has a toggle of 44 px or more both ways", async ({ page }) => {
    await on(page);
    for (const width of [320, 340, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/review");
      await settle(page);
      await page.waitForTimeout(150);
      const toggle = (await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).boundingBox())!;
      expect(toggle.width, `${width} px wide`).toBeGreaterThanOrEqual(44);
      expect(toggle.height, `${width} px wide`).toBeGreaterThanOrEqual(44);
      if (width >= 340) await expect(page.locator(".topbar .brand__name"), `${width} px wide`).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, `${width} px wide`).toBeLessThanOrEqual(0);
    }
  });

  test("Clips Funded keeps its whole name: side by side with Clip Factory in the switch, and in its own top bar on a phone", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories");
    await storiesReady(page);
    const opts = page.locator(".ws-dock .ws-switch__opt");
    await expect(opts).toHaveCount(2);
    for (const name of ["Clip Factory", "Clips Funded"]) {
      const opt = page.locator(".ws-dock .ws-switch__opt", { hasText: new RegExp(`^${name}$`) });
      await expect(opt).toBeVisible();
      expect(await opt.evaluate((o) => o.scrollWidth <= o.clientWidth), `${name} is not cut short`).toBe(true);
    }
    const tops = await opts.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(Math.abs((tops[0] ?? 0) - (tops[1] ?? -99)), "the two names sit side by side").toBeLessThan(2);
    for (const width of [340, 375]) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto("/stories");
      await storiesReady(page);
      const brand = page.locator(".st-top .st-brand__name");
      await expect(brand, `${width} px wide`).toBeVisible();
      await expect(brand, `${width} px wide`).toHaveText("Clips Funded");
      const cut = await brand.evaluate((n) => {
        const r = n.getBoundingClientRect();
        const bar = n.closest(".st-top")!.getBoundingClientRect();
        return n.scrollWidth > n.clientWidth || r.left < bar.left || r.right > bar.right;
      });
      expect(cut, `${width} px wide: the name is whole, inside the top bar`).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width} px wide`).toBeLessThanOrEqual(0);
    }
  });

  test("a switch held by Leave without saving: Keep editing stays and the device still says Clip Factory; Leave switches", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/clip-making/skills/new");
    await settle(page);
    await page.getByLabel("What is the skill called?").fill("Half written");
    const choice = () => page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").workspaceId as string | undefined);
    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/skills\/new$/);
    expect(await choice()).toBe("clips");
    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    expect(await choice()).toBe("stories");
  });

  test("both ways on a phone, with the toggle in the top bar", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/review");
    await settle(page);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await page.locator(".st-tabbar").getByRole("button", { name: "More pages" }).click();
    await expect(page.locator(".st-more .st-more__item")).toHaveText(["Cars", "Series", "Chat", "References", "Library", "Social accounts", "Settings"]);
    await page.locator(".st-more").getByRole("link", { name: "Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await settle(page);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
  });

  test("a reload of a Lamo Stories page stays in Lamo Stories, and the choice is kept on the device", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/stories/library?kind=videos");
    await storiesReady(page);
    await page.reload();
    await storiesReady(page);
    await expect(page).toHaveURL(/\/stories\/library\?kind=videos$/);
    await expect(page.locator(".st-tabs__tab.is-on")).toHaveText("Videos");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}"));
    expect(stored).toMatchObject({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastStoriesPath: "/stories/library?kind=videos" });
  });

  test("opening the app at / when Lamo Stories was last goes to the last Lamo Stories page", async ({ page }) => {
    await on(page, () => {
      if (!sessionStorage.getItem("cf.e2e.started")) {
        sessionStorage.setItem("cf.e2e.started", "1");
        localStorage.setItem("cf.workspace", JSON.stringify({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastClipsPath: "/jobs", lastStoriesPath: "/stories/library" }));
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/stories\/library$/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    // Lamo Clips' own pages open where they are asked for.
    await page.goto("/jobs");
    await settle(page);
    await expect(page).toHaveURL(/\/jobs$/);
  });

  test("coming back to Clip Factory opens its page where it was scrolled to", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto("/library");
    await settle(page);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the Library is taller than the window").toBeGreaterThan(200);
    const y = Math.min(600, Math.round(room * 0.6));
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => Math.round(scrollY));
    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
  });

  test("E1: on a phone (390x844) too, coming back to Clip Factory opens its Library where it was scrolled to", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/library");
    await settle(page);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the Library is taller than the phone's window").toBeGreaterThan(300);
    await page.evaluate((to) => window.scrollTo(0, to), Math.min(874, Math.round(room * 0.6)));
    // He reads there a moment; the tap below first scrolls the page up to the top bar, as his thumb does.
    await page.waitForTimeout(1800);
    const kept = await page.evaluate(() => Math.round(scrollY));
    expect(kept).toBeGreaterThan(200);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
    // A second round trip keeps it as well.
    await page.waitForTimeout(1800);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
    // A slow way up in short flicks (over four seconds), then the switch at once: still where he was reading.
    await page.waitForTimeout(1800);
    for (let i = 1; i <= 10; i++) {
      await page.evaluate((to) => window.scrollTo(0, to), Math.round(kept * (1 - i / 10)));
      await page.waitForTimeout(500);
    }
    expect(await page.evaluate(() => Math.round(scrollY))).toBe(0);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
    // A jump to the top (a status-bar tap) and two seconds to find the switch: still where he was reading.
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
  });

  test("E1: on a phone, reading at the top of Clip Factory's Library for a while keeps the top on the way back", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/library");
    await settle(page);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the Library is taller than the phone's window").toBeGreaterThan(300);
    await page.evaluate((to) => window.scrollTo(0, to), Math.min(874, Math.round(room * 0.6)));
    await page.waitForTimeout(1800);
    // Up to the top, and reading there longer than it takes to find the switch: the top is where he left it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(10_500);
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library$/);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => Math.round(scrollY))).toBe(0);
    // Resting part way up (below the top bar) is a reading place of its own.
    await page.evaluate((to) => window.scrollTo(0, to), Math.min(874, Math.round(room * 0.6)));
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".topbar").getByRole("link", { name: "Go to Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(400);
  });

  test("ask, switch to Lamo Stories while the answer streams, switch back: the answer is there", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    const panel = page.locator("#help-panel");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Your question").fill("How do I change my click sound? #long");
    await panel.getByRole("button", { name: "Send" }).click();
    const answer = panel.locator(".ask-msg").last();
    await expect(answer.locator(".ask-answer")).toBeVisible();
    await expect(answer).toHaveAttribute("aria-busy", "true");
    const early = (await answer.locator(".ask-answer").innerText()).length;

    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await storiesReady(page);
    // Lamo Clips' Ask is not part of Lamo Stories: it waits behind it, hidden and inert, with the rest of Clip Factory.
    await expect(page.locator(".help-launcher:visible, #help-panel:visible")).toHaveCount(0);
    await expect(page.locator('[data-app-pane="clips"]')).toHaveAttribute("inert", "");
    await page.waitForTimeout(1200);
    await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
    await settle(page);

    // The panel is open again, with the question and the answer that kept streaming meanwhile, then finished.
    await expect(panel).toBeVisible();
    await expect(panel.locator(".help-msg--me").last()).toContainText("How do I change my click sound?");
    await expect(answer.getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    expect((await answer.locator(".ask-answer").innerText()).length).toBeGreaterThan(early);
    await expect(answer.locator(".ask-sources")).toContainText("Clip Factory guide");
  });

  test("a closed Ask stays closed across a switch, and its conversation stays too", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    const panel = page.locator("#help-panel");
    await panel.getByLabel("Your question").fill("How do I change my click sound?");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await expect(panel).toHaveCount(0);
    await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
    await storiesReady(page);
    await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
    await settle(page);
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await expect(panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible();
  });
});

type FaultWindow = Window & { __cfMockFaults?: { jobsPageSize?: number } };

/** The shell's switch (§45.38), the same in both apps: to Lamo Stories, and to Clip Factory. */
const toStories = (page: Page) => page.locator(".ws-dock").getByRole("link", { name: /^(Go to )?Clips Funded$/ }).click();
/** The shell's switch to Clip Factory (§45.38): the bar's choice, or the toggle that goes there in a short window. */
const toClips = (page: Page) => page.locator(".ws-dock").getByRole("link", { name: /^(Go to )?Clip Factory$/ }).click();

test.describe("each app stays exactly as it was left (§45.34)", () => {
  test("Clip Factory's Library keeps its filter and its scroll across a round trip", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.goto("/library");
    await settle(page);
    const waiting = page.getByRole("radio", { name: "Not posted yet", exact: true });
    await waiting.check({ force: true });
    await expect(waiting).toBeChecked();
    const shown = await page.locator(".lib-card").count();
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the filtered Library is taller than the window").toBeGreaterThan(120);
    await page.evaluate((to) => window.scrollTo(0, to), Math.round(room * 0.7));
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => Math.round(scrollY));

    await toStories(page);
    await storiesReady(page);
    await toClips(page);
    // The filter is part of the address (Back and a reload keep it too).
    await expect(page).toHaveURL(/\/library\?show=waiting$/);
    // At once: the same page, still filtered, the same cards, where it was scrolled to.
    await expect(waiting).toBeChecked();
    await expect(page.locator(".lib-card")).toHaveCount(shown);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
    expect(await page.title()).toBe("Library · Clip Factory");
  });

  test("Clip Factory's Jobs keeps the older jobs it showed, Select, and its scroll; its Escape stays quiet in Lamo Stories", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.goto("/");
    await settle(page);
    await page.evaluate(() => Object.assign((window as FaultWindow).__cfMockFaults!, { jobsPageSize: 3 }));
    await page.locator(".sidebar__item[href='/jobs']").click();
    await settle(page);
    const rows = page.locator(".job-list .job-row");
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: "Show older jobs" }).click();
    await expect(rows).toHaveCount(6);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const picked = page.getByRole("toolbar", { name: "Picked jobs" });
    await expect(picked).toBeVisible();
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the jobs list is taller than the window").toBeGreaterThan(120);
    await page.evaluate((to) => window.scrollTo(0, to), Math.round(room * 0.8));
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => Math.round(scrollY));

    await toStories(page);
    await storiesReady(page);
    // Escape in Lamo Stories never reaches Clip Factory's Jobs (it would end Select there).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await toClips(page);
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(rows).toHaveCount(6);
    await expect(picked).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
    // Back on screen, Clip Factory's own Escape works as before.
    await page.keyboard.press("Escape");
    await expect(picked).toHaveCount(0);
  });

  test("Lamo Stories keeps its page as it was (typing included), and the hidden app never takes the title", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories/ideas");
    await storiesReady(page);
    await page.getByRole("button", { name: "New idea" }).click();
    const form = page.getByRole("form", { name: "New idea" });
    await form.getByLabel("Title").fill("Pip and the icy hill");
    expect(await page.title()).toBe("Ideas · Clips Funded · Clip Factory");

    await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    expect(await page.title()).toBe("Home · Clip Factory");
    // Clip Factory's pages change the title; the hidden Lamo Stories never does.
    await page.locator(".sidebar__item[href='/review']").click();
    await settle(page);
    expect(await page.title()).toBe("Review · Clip Factory");

    await toStories(page);
    await expect(page).toHaveURL(/\/stories\/ideas$/);
    await expect(form.getByLabel("Title")).toHaveValue("Pip and the icy hill");
    expect(await page.title()).toBe("Ideas · Clips Funded · Clip Factory");
    // Only one page landmark answers to #main: the one on screen.
    await expect(page.locator("#main")).toHaveCount(1);
    await expect(page.locator("#main")).toHaveClass(/st-main/);
  });

  test("the first switch waits for nothing: the studio's code was fetched while idle, and the workspace list is reused", async ({ page }) => {
    await on(page);
    const asked: string[] = [];
    page.on("request", (r) => {
      if (/\/assets\/StoriesApp-[^/]+\.js$/.test(r.url())) asked.push(r.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/library");
    await settle(page);
    await expect.poll(() => asked.length, { timeout: 8000 }).toBeGreaterThan(0);
    // Watch for any wait between the tap and the studio.
    await page.evaluate(() => {
      const w = window as unknown as { __waited?: string[] };
      w.__waited = [];
      new MutationObserver(() => {
        for (const el of Array.from(document.querySelectorAll('.boot[aria-label="Loading Clips Funded"], .st-loading'))) w.__waited!.push(el.classList.contains("boot") ? "boot" : (el.textContent ?? ""));
      }).observe(document.body, { childList: true, subtree: true });
    });
    await toStories(page);
    await page.locator(".stories-app[data-ws]").waitFor();
    const waited = await page.evaluate(() => (window as unknown as { __waited: string[] }).__waited);
    expect(waited.filter((t) => t === "boot" || t.includes("Opening the studio")), "no loading screen before the studio").toEqual([]);
  });

  test("Continue: the project open last comes back on the dashboard, and goes once it is gone", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/characters");
    await storiesReady(page);
    const first = page.locator("a.st-s-cast__card").first();
    const href = (await first.getAttribute("href"))!;
    const name = (await first.locator(".st-s-cast__name").textContent())!.trim();
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await storiesReady(page);
    const last = (await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").lastProject)) as { kind: string; id: string };
    expect(last.kind).toBe("character");

    await page.locator(".st-rail").getByRole("link", { name: "Dashboard", exact: true }).click();
    await storiesReady(page);
    const card = page.locator(".st-continue");
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Continue: ${name}`);
    await expect(card).toContainText("The character you had open");
    const before = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
    await card.hover();
    await page.waitForTimeout(300);
    expect(await card.evaluate((e) => getComputedStyle(e).backgroundColor), "hover").not.toBe(before);
    // The owner's rules: AA contrast, no visible edges, no overflow from 320 px.
    const axe = await new AxeBuilder({ page }).include(".st-continue").withRules(["color-contrast"]).analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))), "contrast").toEqual([]);
    expect((await visibleEdges(page)).filter((e) => e.includes("st-continue")), "edges").toEqual([]);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(250);
    const o = await findOverflow(page);
    expect(o.page, "320 px: the page scrolls sideways").toBeLessThanOrEqual(o.viewport);
    expect(o.items, "320 px").toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));

    // A project that was deleted meanwhile: no card, and it is forgotten.
    await page.evaluate(() => {
      const c = JSON.parse(localStorage.getItem("cf.workspace") ?? "{}");
      localStorage.setItem("cf.workspace", JSON.stringify({ ...c, lastProject: { kind: "story", id: "01JZGONE000000000000000000" } }));
    });
    await page.goto("/stories");
    await storiesReady(page);
    await expect(page.locator(".st-tiles")).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").lastProject)).toBeNull();
  });
});

type StoriesMockWindow = Window & { __cfStoriesMock?: { store?: { knobs: Record<string, unknown> } } };

/** Records, from now on, every confetti and toast that appears anywhere on the page. */
const watchShows = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __shows?: string[] };
    w.__shows = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.matches("canvas.confetti")) w.__shows!.push("confetti");
          for (const t of [n, ...Array.from(n.querySelectorAll(".toast__text"))]) if (t.matches(".toast__text, .toast")) w.__shows!.push(`toast: ${t.textContent?.trim()}`);
        }
    }).observe(document.body, { childList: true, subtree: true });
  });
const shows = (page: Page) => page.evaluate(() => (window as unknown as { __shows?: string[] }).__shows ?? []);

test.describe("Lamo Stories kept behind Clip Factory stays quiet (§45.34)", () => {
  test("Lamo Stories comes back where its window was scrolled to", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "Social accounts is taller than the window").toBeGreaterThan(200);
    await page.evaluate((to) => window.scrollTo(0, to), Math.round(room * 0.7));
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => Math.round(scrollY));
    expect(kept).toBeGreaterThan(100);

    await toClips(page);
    await settle(page);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBeLessThan(kept);
    await toStories(page);
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
  });

  test("a video that finishes while Clip Factory is on screen celebrates only once Lamo Stories is back", async ({ page }) => {
    test.setTimeout(90_000);
    await on(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/stories/production/01JSTST0000000000000000006");
    await storiesReady(page);
    await expect(page.getByRole("link", { name: "Watch it in Review" })).toHaveCount(0);
    // The seed run ends 9 s after the page opened.
    await page.evaluate(() => {
      const store = (window as StoriesMockWindow).__cfStoriesMock?.store;
      if (store) store.knobs.jobSeconds = 9;
    });
    await toClips(page);
    await settle(page);
    await watchShows(page);
    await page.waitForTimeout(11_000);
    expect(await shows(page), "nothing of Lamo Stories over Clip Factory").toEqual([]);
    await expect(page.locator('[data-app-pane="clips"]')).toBeVisible();

    // Back: the finished run is noticed at once, and celebrated here.
    await toStories(page);
    await expect(page.getByRole("link", { name: "Watch it in Review" })).toBeVisible({ timeout: 8000 });
    await expect(page.locator(".toast__text", { hasText: "Your video is ready to watch!" })).toBeVisible();
    expect(await shows(page)).toContain("confetti");
  });

  test("a chat's Undo that ends behind Clip Factory never moves the owner out of it", async ({ page }) => {
    test.setTimeout(60_000);
    await on(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    // The chat open last is "What makes a good hook"; the list is asked for itself.
    await page.goto("/stories/chat/01JSTCV0000000000000000002");
    await storiesReady(page);
    await page.goto("/stories/chat?all=1");
    await storiesReady(page);
    await page.locator(".st-chat-row", { hasText: "Winter ideas for Pip" }).getByRole("button", { name: /^Delete/ }).click();
    await expect(page.locator(".st-chat-row", { hasText: "Winter ideas for Pip" })).toHaveCount(0);

    await toClips(page);
    // The page changes once the sliding window has landed (stories/pane.tsx AppPanes): Clip Factory's address first.
    await expect(page, "back on Clip Factory's page").not.toHaveURL(/\/stories(\/|\?|$)/);
    await settle(page);
    const at = page.url();
    // The Undo window (6 s) ends behind Clip Factory and the chat list loads again there.
    await page.waitForTimeout(9000);
    expect(page.url()).toBe(at);
    await expect(page.locator('[data-app-pane="clips"]')).toBeVisible();
    await expect(page.locator('[data-app-pane="stories"]')).toBeHidden();
    // Back is Clip Factory's own history still: the Lamo Stories list, as the owner left it.
    await toStories(page);
    await expect(page).toHaveURL(/\/stories\/chat\?all=1$/);
    await expect(page.locator(".st-chat-row", { hasText: "Winter ideas for Pip" })).toHaveCount(0);
    await expect(page.locator(".st-chat-row", { hasText: "What makes a good hook" })).toBeVisible();
  });

  test("Clip Factory's Home opened for a campaign is kept across a round trip, typing included, on the way the owner was on (§45.35 D18)", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";
    await page.goto(`/?campaign=${FAZE}`);
    await settle(page);
    const link = page.getByLabel("YouTube, Twitch or Kick link");
    await link.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const campaignForm = page.getByRole("form", { name: "Make campaign clips" });
    await expect(campaignForm).toBeVisible();
    await watchShows(page);

    await toStories(page);
    await storiesReady(page);
    // Kept behind Lamo Stories (hidden and inert), still on its own way: Lamo Stories' address never reaches it.
    await expect(page.locator('[data-app-pane="clips"]')).toHaveAttribute("inert", "");
    await expect(page.locator('[data-app-pane="clips"]').getByRole("form", { name: "Make campaign clips", includeHidden: true })).toHaveCount(1);
    await toClips(page);
    await settle(page);
    await expect(page).toHaveURL(new RegExp(`/\\?campaign=${FAZE}$`));
    await expect(campaignForm).toBeVisible();
    await expect(link).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect((await shows(page)).filter((t) => t.startsWith("toast")), "no upload or form was stopped behind Lamo Stories").toEqual([]);

    // The normal way of Home is where switching back lands once the owner went there.
    await page.getByRole("link", { name: "Make normal clips instead" }).click();
    await expect(page).toHaveURL(/\/$/);
    await settle(page);
    await page.getByLabel("YouTube, Twitch or Kick link").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    await toStories(page);
    await storiesReady(page);
    await expect(page.locator('[data-app-pane="clips"]')).toHaveAttribute("inert", "");
    await toClips(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  });

  test("Clip Factory's Home: another campaign picked in Which campaign is where switching back lands (§45.35 D18)", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";
    // Two places set up, so two campaigns are ready for clips and Home shows its "Which campaign" bar.
    await page.goto("/");
    type Setup = { __cfMock?: { setup?: { finish?: (p: string) => void } } };
    await page.waitForFunction(() => !!(window as unknown as Setup).__cfMock?.setup);
    await page.evaluate(() => ["youtube", "instagram"].forEach((p) => (window as unknown as Setup).__cfMock!.setup!.finish!(p)));
    await page.goto(`/?campaign=${FAZE}`);
    await settle(page);
    // Another campaign picked in "Which campaign" moves the address without a page change: the way back still opens
    // the campaign the kept form shows, so the address and the form agree.
    const which = page.locator(".cr-for .segmented__opt");
    await expect(which).not.toHaveCount(0);
    await expect(which).not.toHaveCount(1);
    const other = page.locator(".cr-for .segmented__opt:not(.is-on)").first();
    const otherName = (await other.innerText()).trim();
    await other.click();
    await expect(page).not.toHaveURL(new RegExp(`/\\?campaign=${FAZE}$`));
    const picked = new URL(page.url()).search;
    expect(picked).toMatch(/^\?campaign=/);
    await toStories(page);
    await storiesReady(page);
    await toClips(page);
    // The page changes once the sliding window has landed (stories/pane.tsx AppPanes; on CI's runners more than
    // settle's wait after the tap, 23 Nov): the way back opens the campaign picked, nothing else on the way.
    await expect.poll(() => new URL(page.url()).pathname, { message: "back on Clip Factory's Home" }).toBe("/");
    await settle(page);
    expect(new URL(page.url()).search).toBe(picked);
    await expect(page.locator(".cr-for").getByRole("radio", { name: otherName })).toBeChecked();
    // A reload opens the same campaign: the address and the kept form said the same thing.
    await page.reload();
    await settle(page);
    await expect(page.locator(".cr-for").getByRole("radio", { name: otherName })).toBeChecked();
  });

  test("Clip Factory calm, Lamo Stories' own motion on: Lamo Stories' highlights slide and its confetti shows; Clip Factory's stay calm", async ({ page }) => {
    // Lamo Stories' own device choice: motion on (what its Settings card writes).
    await on(page, () => localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], more: { "motion.reduce": false } })));
    await page.setViewportSize({ width: 1440, height: 900 });
    // Clip Factory's own: calm motion, from its Settings.
    await page.goto("/settings/look-and-feel/motion");
    await settle(page);
    await page.getByRole("switch", { name: "Reduce motion" }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    const slid = () => page.evaluate(() => document.getAnimations().some((a) => (a as Animation & { id: string }).id === "glide-slide"));

    await toStories(page);
    await storiesReady(page);
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await page.locator(".st-rail").getByRole("link", { name: "Library", exact: true }).click();
    await storiesReady(page);
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect.poll(slid, { timeout: 2000 }).toBe(true);

    // Its studio confetti too (saving an idea), which Clip Factory's calm setting used to still.
    await page.locator(".st-rail").getByRole("link", { name: "Ideas", exact: true }).click();
    await storiesReady(page);
    await watchShows(page);
    await page.getByRole("button", { name: "New idea" }).click();
    const form = page.getByRole("form", { name: "New idea" });
    await form.getByLabel("Title").fill("Pip and the icy hill");
    await form.getByLabel("What happens, in one line").fill("Pip slides down an icy hill and stops just in time.");
    await form.locator(".st-s-pick__opt").first().click();
    await form.getByRole("button", { name: "Save idea" }).click();
    await expect.poll(() => shows(page)).toContain("confetti");

    // Clip Factory keeps its own calm: its highlights jump, as before.
    await toClips(page);
    await settle(page);
    await expect(page.locator("html")).toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await page.locator(".sidebar__item[href='/library']").click();
    await settle(page);
    await page.waitForTimeout(300);
    await page.getByRole("radio", { name: "Not posted yet", exact: true }).check({ force: true });
    await page.waitForTimeout(150);
    expect(await slid()).toBe(false);
  });
});

test.describe("Lamo Stories' own sounds and motion (cf.stories.prefs, §45.34)", () => {
  type Log = { kind: string; sound: number; muted: boolean }[];
  const log = (page: Page) => page.evaluate(() => (window as unknown as { __cfSoundLog?: Log }).__cfSoundLog ?? []);
  const clear = (page: Page) => page.evaluate(() => ((window as unknown as { __cfSoundLog?: Log }).__cfSoundLog = []));

  test("unset, Lamo Stories plays its own usual sounds (never Clip Factory's choice); set, its own wins and Clip Factory's choice never changes it", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Clip Factory's own choice (its Settings › Look and feel › Sounds): a click sound of his own, 12, not the usual 6.
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    await page.getByRole("button", { name: /^Click sound 12:/ }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cf.prefs") ?? "{}").clickSound)).toBe(12);
    // Over to Lamo Stories without a reload (the mock server keeps its settings only for this visit).
    await toStories(page);
    await storiesReady(page);
    await page.locator(".st-rail").getByRole("link", { name: "Library", exact: true }).click();
    await storiesReady(page);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cf.prefs") ?? "{}"))).toMatchObject({ soundEnabled: true, clickSound: 12, reduceMotion: false });
    const mine = 9;
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await clear(page);
    await page.getByRole("tab", { name: "Videos" }).click();
    // Lamo Stories' own usual click sound (6, Water drop), one sound only: Clip Factory's 12 is never heard here (§45.38 A2).
    expect((await log(page)).filter((e) => e.kind === "tap")).toEqual([expect.objectContaining({ sound: 6, muted: false })]);

    // Lamo Stories' own: sounds off, another click sound, calm motion (what its Settings card writes).
    await page.evaluate((click) => localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], more: { "sound.enabled": false, "sound.click": click, "motion.reduce": true } })), mine);
    await page.reload();
    await storiesReady(page);
    await expect(page.locator("html")).toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await clear(page);
    await page.getByRole("tab", { name: "Pictures" }).click();
    expect((await log(page)).filter((e) => e.kind === "tap")).toEqual([expect.objectContaining({ sound: mine, muted: true })]);

    // Clip Factory keeps its own: sounds on, its click sound (the reload gave the mock back its usual one), motion as it was.
    const clips = (await page.evaluate(() => JSON.parse(localStorage.getItem("cf.prefs") ?? "{}"))) as { soundEnabled: boolean; clickSound: number; reduceMotion: boolean };
    await toClips(page);
    await settle(page);
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await clear(page);
    await page.locator(".sidebar__item[href='/review']").click();
    expect((await log(page)).filter((e) => e.kind === "tap")).toEqual([expect.objectContaining({ sound: clips.clickSound, muted: false })]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cf.prefs") ?? "{}"))).toMatchObject({ soundEnabled: true, clickSound: clips.clickSound, reduceMotion: false });

    // Back in Lamo Stories, its own choice again.
    await toStories(page);
    await storiesReady(page);
    await expect(page.locator("html")).toHaveClass(/(^|\s)reduce-motion(\s|$)/);
    await clear(page);
    await page.getByRole("tab", { name: "Sounds" }).click();
    expect((await log(page)).filter((e) => e.kind === "tap")).toEqual([expect.objectContaining({ sound: mine, muted: true })]);
  });
});

test.describe("the pages", () => {
  test("the dashboard shows every tile in the contract's order", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories");
    await storiesReady(page);
    const titles = await page.locator(".st-tiles > .st-tile").evaluateAll((els) => els.map((e) => (e.querySelector(".st-tile__title, .st-stat__label")?.textContent ?? "").replace(/\d+$/, "").trim()));
    expect(titles).toEqual(["Needs you", "Animations made", "Waiting for review", "Published", "Being made now", "Connected accounts", "How the videos do", "What happened lately"]);
    await expect(page.locator(".st-needs")).toBeVisible();
    await expect(page.locator(".st-tile").filter({ hasText: "Connected accounts" })).toContainText("of 5");
    await expect(page.locator(".st-tile").filter({ hasText: "How the videos do" })).toContainText("Numbers until 7 days after each post.");
  });

  test("Social accounts: logo, name and id, authorization and last checked, Clip Factory's own place, the notes, a connect", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    // The list: each platform's logo and name on its row.
    const rows = page.locator(".st-social-rows > .st-social-row-wrap");
    await expect(rows).toHaveCount(5);
    for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) await expect(rows.filter({ has: page.locator(".st-social-row__name", { hasText: new RegExp(`^${name}$`) }) }).locator(".st-social-row__mark svg")).toBeVisible();
    // Each card on its platform's page, with its logo.
    for (const name of ["TikTok", "Instagram", "X"]) {
      await expect((await platformCard(page, name)).locator(".st-conn__mark svg"), name).toBeVisible();
      await backToList(page);
    }
    const yt = await platformCard(page, "YouTube");
    await expect(yt.locator(".st-conn__mark svg")).toBeVisible();
    await expect(yt.locator(".st-who")).toContainText("Clips Funded");
    await expect(yt.locator(".st-who__id code")).toHaveText(/^UC/);
    await expect(yt.locator(".st-auth")).toContainText("Allowed: Clips Funded may post here.");
    await expect(yt.locator(".st-auth")).toContainText("Last checked");
    await expect(yt).toContainText("Clip Factory posts to: Clip Factory Gaming");
    await expect(yt.locator(".st-app")).toContainText("Shares Clip Factory's YouTube app, on purpose. Clip Factory's posts always go first. Clips Funded uses what's left.");
    await expect(yt.locator(".st-app")).toContainText("Even with Clip Factory's app, sign in with a different account made for Clips Funded.");
    // Check now: a live check, and when it was last checked (in the card's More fold).
    await yt.locator(".st-conn__more > summary").click();
    await yt.getByRole("button", { name: "Check now" }).click();
    await expect(page.locator(".toast").filter({ hasText: "YouTube answered. All good." })).toBeVisible();
    await expect(yt.locator(".st-auth")).toContainText(/Last checked\s*(just now|now|\d+ s ago|seconds? ago|a moment ago)/i);
    await backToList(page);
    const tiktok = await platformCard(page, "TikTok");
    await expect(tiktok).toContainText("Sign in to your Clips Funded account on tiktok.com in this browser first.");
    await expect(tiktok.getByRole("button", { name: "Connect again" })).toBeVisible();
    await backToList(page);
    const fb = await platformCard(page, "Facebook");
    await expect(fb).toContainText("Facebook will ask which Pages this app may use. Tick only your Clips Funded Page.");
    await expect(fb.locator(".st-app")).toContainText("Uses its own Meta app");

    // Connect Facebook: the pretend platform sends the owner back, to Facebook's page, with a list of Pages to pick from.
    await fb.getByRole("button", { name: "Connect Facebook" }).click();
    await expect(page).toHaveURL(/\/stories\/connections\/facebook$/);
    await expect(page.locator(".toast").filter({ hasText: "Now pick the Facebook Page Clips Funded posts to." })).toBeVisible();
    await expect(fb.getByRole("button", { name: /Clip Factory's own/ })).toHaveAttribute("aria-disabled", "true");
    await fb.getByRole("button", { name: /^Clips Funded/ }).click();
    await expect(fb.locator(".st-chip").first()).toHaveText("Ready");
    await expect(fb.locator(".st-who__id code")).toHaveText("109876543210987");
  });

  test("Social accounts: Clip Factory's own account is never shared; every card asks for a new account (§45.37 G8)", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    // No way to use it for both on the list either; its row says it is Clip Factory's account.
    await expect(page.getByRole("button", { name: /for both/i })).toHaveCount(0);
    await expect(page.getByText(/use it for both/i)).toHaveCount(0);
    await expect(page.locator('.st-social-row-wrap[data-platform="x"] .st-social-row__line')).toHaveText("That's Clip Factory's account.");
    // Up front on every card whose next step is an account: a new account made for Clips Funded (the connected YouTube
    // that is fine does not say it again).
    for (const name of ["TikTok", "Instagram", "Facebook"]) {
      const card = await platformCard(page, name);
      await expect(card.locator(".st-conn__new"), name).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
      await expect(page.getByRole("button", { name: /for both/i }), name).toHaveCount(0);
      await expect(page.getByText(/use it for both/i), name).toHaveCount(0);
      await backToList(page);
    }
    const x = await platformCard(page, "X");
    await expect(x.locator(".st-conn__new")).toHaveText("Use a new account made for Clips Funded, not Clip Factory's.");
    await expect(x).toContainText("This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.");
    await expect(x.locator(".st-chip").first()).toHaveText("Clip Factory's own");
    // No way to use it for both, anywhere on the page.
    await expect(page.getByRole("button", { name: /for both/i })).toHaveCount(0);
    await expect(page.getByText(/use it for both/i)).toHaveCount(0);
    await expect(x.getByRole("button", { name: "Pick another account" })).toBeVisible();
    await backToList(page);

    // Disconnect asks first, and then says where the app can be removed by hand (nothing is revoked).
    const yt = await platformCard(page, "YouTube");
    await expect(yt.locator(".st-conn__new")).toHaveCount(0);
    await yt.locator(".st-conn__more > summary").click();
    await yt.getByRole("button", { name: "Disconnect" }).click();
    await yt.getByRole("button", { name: "Yes, disconnect" }).click();
    await expect(page.getByText("To remove Clip Factory from this account completely, remove the app in the account's own settings.")).toBeVisible();
    await expect(yt.locator(".st-chip").first()).toHaveText("Not connected");
  });

  test("Social accounts shows the result the platform sent back, once", async ({ page }) => {
    await on(page);
    await page.goto("/stories/connections?platform=youtube&result=denied&ws=stories");
    await storiesReady(page);
    // The connected YouTube's button is "Pick another channel": the sentence names that one.
    await expect(page.locator(".toast").filter({ hasText: "You pressed cancel. Tap Pick another channel to try again." })).toBeVisible();
    // It landed on YouTube's own page, whose address is its own now (a reload never says it again).
    await expect(page).toHaveURL(/\/stories\/connections\/youtube$/);
    await expect(page.locator('section.st-social-one[data-platform="youtube"]')).toBeVisible();
    await page.reload();
    await storiesReady(page);
    await expect(page.locator(".toast").filter({ hasText: "You pressed cancel." })).toHaveCount(0);
  });

  test("Social accounts: each platform asks which developer app before the first Connect, never silently", async ({ page }) => {
    await fresh(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    const card = (name: string) => page.locator(".st-conn").filter({ has: page.getByRole("heading", { name, exact: true }) });

    // X (on its own page): the choice comes first: Set up the app is the card's one main button and opens it on the card; Connect comes
    // once an app is picked.
    const x = await platformCard(page, "X");
    await expect(x.locator(".st-conn__more > summary")).toHaveText("More for X");
    await expect(x.getByRole("button", { name: "Connect X" })).toHaveCount(0);
    await expect(x.getByRole("button", { name: "Set up the app for X" })).toHaveClass(/st-btn--main/);
    await x.getByRole("button", { name: "Set up the app for X" }).click();
    await expect(x.getByRole("radiogroup", { name: "Which X app Clips Funded uses" }).getByRole("radio")).toHaveText([
      /A separate app for Clips Funded/,
      /Share Clip Factory's app.*Clip Factory's posts always go first\. Clips Funded uses what's left\. Even with Clip Factory's app, sign in with a different account made for Clips Funded\./,
    ]);
    await expect(x).not.toContainText("quicker");
    // Picking Clip Factory's app is the choice: it is saved at once, with no second button of the same name.
    await x.getByRole("radio", { name: /Share Clip Factory's app/ }).click();
    await expect(x.getByRole("button", { name: "Share Clip Factory's app" })).toHaveCount(0);
    await expect(x.locator(".st-app")).toContainText("Shares Clip Factory's X app, on purpose. Clip Factory's posts always go first. Clips Funded uses what's left.");
    await x.getByRole("button", { name: "Connect X" }).click();
    await expect(x.locator(".st-chip").first()).toHaveText("Ready");

    // YouTube's own app: the redirect URI to copy (Lamo Stories' own callback), the keys form, Check it.
    await backToList(page);
    const yt = await platformCard(page, "YouTube");
    await yt.getByRole("button", { name: "Set up the app for YouTube" }).click();
    await yt.getByRole("radio", { name: /A separate app for Clips Funded/ }).click();
    await expect(yt.locator(".st-copy__value")).toHaveText(/\/v1\/stories-oauth\/youtube\/callback$/);
    await expect(yt.getByRole("button", { name: "Copy the redirect uri" })).toBeVisible();
    await yt.getByLabel("Client ID").fill("not-a-client-id");
    await expect(yt.locator(".st-field__problem").first()).toContainText("ends with .apps.googleusercontent.com");
    await yt.getByLabel("Client ID").fill("123456789-abcdefghijklmnopqrstuvwxyz12.apps." + "googleusercontent.com");
    await yt.getByLabel("Client secret").fill("GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12");
    await yt.getByRole("button", { name: "Save the keys" }).click();
    await expect(yt.locator(".st-app")).toContainText("Uses its own YouTube app");
    await expect(yt.locator(".st-app code").first()).toHaveText("123456….com");
    await expect(page.locator("body")).not.toContainText("GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12");
    // The app is ready: Connect is the card's main button, and the saved app's Check it is in More.
    await expect(yt.getByRole("button", { name: "Connect YouTube" })).toHaveClass(/st-btn--main/);
    await yt.locator(".st-conn__more > summary").click();
    await yt.getByRole("button", { name: "Check it" }).click();
    await expect(yt).toContainText("Your keys work. Now press Connect YouTube.");

    // Meta: no Clip Factory choice at all; one Meta app's keys, entered once, serve Instagram and Facebook.
    await backToList(page);
    const fb = await platformCard(page, "Facebook");
    await fb.getByRole("button", { name: "Set up the app for Facebook" }).click();
    await expect(fb.getByRole("radio")).toHaveCount(0);
    await expect(fb).toContainText("Facebook always uses Clips Funded's own Meta app");
    await fb.getByLabel("App ID").fill("1234567890123456");
    await fb.getByLabel("App secret").fill("0123456789abcdef0123456789abcdef");
    await fb.getByLabel("Configuration ID").fill("https://www.facebook.com/v27.0/dialog/oauth?config_id=9876543210987654&x=1");
    await fb.getByRole("button", { name: "Save the keys" }).click();
    await expect(page.locator(".toast").filter({ hasText: "The Meta app keys are saved for Instagram and Facebook." })).toBeVisible();
    await backToList(page);
    await platformCard(page, "Instagram");
    // Instagram's app is ready too: its More fold holds the saved Meta app.
    await card("Instagram").locator(".st-conn__more > summary").click();
    await expect(card("Instagram").locator(".st-app")).toContainText("Uses its own Meta app");
    await expect(card("Instagram").locator(".st-app")).toContainText("…7654");
  });

  test("the setup opens by itself the first time, on its own; every step can be skipped and done later", async ({ page }) => {
    await fresh(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories");
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await storiesReady(page);
    // On its own: no navigation, the brand stays, and the shell's switch is where it is on every page (bottom left,
    // §45.38), never a round toggle at the top right instead; the ring says 0 of 11.
    await expect(page.locator(".stories-app.is-alone")).toHaveCount(1);
    await expect(page.locator(".st-rail, .st-tabbar")).toHaveCount(0);
    await expect(page.locator(".ws-dock .ws-switch__opt.is-on")).toHaveText("Clips Funded");
    await expect(page.locator(".st-top .ws-switch-host")).toBeHidden();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "0 of 11 done");
    await expect(page.locator(".st-steps__item")).toHaveCount(11);
    // What is left is the step list itself: no pills that say the steps again.
    await expect(page.locator(".st-left__item")).toHaveCount(0);

    // 1: the models and their state; "These look right" ticks step 1 (§45.34).
    await expect(page.locator(".st-setup__model")).toHaveCount(6);
    await page.getByRole("button", { name: "These look right" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "1 of 11 done");
    // 2: pick the default model; Check models really runs; saving ticks step 2 only (the effort is picked in 3).
    await expect(page.locator("#st-setup-step")).toHaveText("Pick your default model");
    await expect(page.getByRole("radiogroup", { name: "Clips Funded's default model" }).getByRole("radio")).toHaveText([/Claude Fable 5.2/, /Claude Fable 5.1/, /Claude Opus 5.5/, /Claude Sonnet 5.5/, /Claude Haiku 5.5/, /Amazon Nova Pro/]);
    // Builder F2's mock: a sixth, mock-only model (no effort, no price), and this account cannot use Fable 5.1.
    await page.getByRole("button", { name: "Check models" }).click();
    await expect(page.locator(".toast").filter({ hasText: "5 of 6 models answered." })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("radio", { name: /Claude Fable 5.2/ }).click();
    await page.getByRole("button", { name: "Use Claude Fable 5.2" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "2 of 11 done");
    await expect(page.locator("#st-setup-step")).toHaveText("Pick your default effort");
    await page.getByRole("radio", { name: "Maximum" }).click();
    await page.getByRole("button", { name: "Use Maximum" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "3 of 11 done");
    await expect(page.locator("#st-setup-step")).toHaveText("Pick how videos are made");
    await page.getByRole("button", { name: "Use this" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "4 of 11 done");
    await expect(page.locator(".st-setup__head")).toContainText("4 of 11 done");
    // 5: agents and skills, ticked by hand.
    await expect(page.locator(".st-agent")).toHaveCount(5);
    await page.getByRole("button", { name: "Got it" }).click();
    // 6: Instagram: skip for now; it stays on the list of what is left.
    await expect(page.locator("#st-setup-step")).toHaveText("Connect Instagram");
    await expect(page.locator(".st-conn[data-platform=instagram]")).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.locator(".toast").filter({ hasText: "Skipped. It stays in Social accounts." })).toBeVisible();
    await expect(page.locator(".st-steps__item.is-skipped")).toHaveCount(1);
    // A platform skipped says Skipped (it waits on Social accounts), never Later.
    await expect(page.locator(".st-steps__item.is-skipped").filter({ hasText: "Connect Instagram" })).toContainText("Skipped");
    await expect(page.locator(".st-steps__item.is-skipped").filter({ hasText: "Connect Instagram" })).not.toContainText("Later");

    // Later: the dashboard keeps a card with the ring and what is left, and the setup carries on from there.
    await page.getByRole("link", { name: "Do this later" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await expect(page.locator(".st-rail")).toBeVisible();
    const card = page.locator(".st-setupcard");
    // Instagram, skipped, is not counted and not on the list: 5 of the 10 steps left to count are done.
    await expect(card).toContainText("Set up Clips Funded: 5 of 10 done");
    await expect(card).toContainText("Still to do: Connect TikTok, Connect YouTube, Connect Facebook and 1 more.");
    await expect(card).not.toContainText("Instagram");
    // Only once per studio on this device: after a reload (the pretend server starts over at 0 of 11) the
    // dashboard stays, with the card.
    await page.reload();
    await storiesReady(page);
    await expect(page).toHaveURL(/\/stories$/);
    await expect(card).toContainText("Set up Clips Funded: 0 of 11 done");
    await card.getByRole("link", { name: "Start the setup" }).click();
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await storiesReady(page);
    await expect(page.locator(".st-rail")).toBeVisible();
    // Step 11: finish with steps left (none of them blocks making videos): confetti, then the big card is gone and
    // a small one keeps what is left, with a way back to it (§45.36 E15).
    await page.locator(".st-steps__item").filter({ hasText: "Done" }).click();
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("canvas.confetti").first()).toBeAttached();
    await expect(page).toHaveURL(/\/stories$/, { timeout: 8000 });
    await storiesReady(page);
    await expect(page.locator(".st-setupcard:not(.st-setupcard--left)")).toHaveCount(0);
    await expect(page.locator(".st-setupcard--left h2")).toHaveText(/^Finish setting up: \d+ left$/);
    await expect(page.locator(".st-setupcard--left").getByRole("link", { name: "Open setup" })).toHaveAttribute("href", "/stories/setup");
  });

  test("Library: files by kind with their story, Download, and a project with how it was made", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories/library");
    await storiesReady(page);
    await expect(page.getByRole("tab")).toHaveText(["Projects", "Videos", "Storyboards", "Characters", "Pictures", "Sounds", "Scenes"]);
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect(page).toHaveURL(/kind=videos/);
    await storiesReady(page);
    const first = page.locator(".st-file").first();
    await expect(first.locator(".st-file__kind")).toContainText("Video");
    await expect(first.getByRole("button", { name: /^Download/ })).toBeVisible();
    await first.locator("a.st-file__title").click();
    await expect(page).toHaveURL(/\/stories\/library\?story=/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { name: "How it was made" })).toBeVisible();
    await expect(page.locator(".st-details")).toContainText("Writer");
    await expect(page.locator(".st-group__title").first()).toHaveText("The video");
  });
});

test.describe("every page keeps the owner's rules", () => {
  for (const path of PAGES)
    test(`${path}: no overflow from 320 to 1920 px`, async ({ page }) => {
      await on(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await storiesReady(page);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(250);
        const o = await findOverflow(page);
        expect(o.page, `${path} @${width}: page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
        expect(o.items, `${path} @${width}`).toEqual([]);
      }
    });

  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const)
    test(`${width} px: arrow cursor, AA contrast, no visible edges, big targets`, async ({ page }) => {
      await on(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      const phone = width < 768;
      for (const path of PAGES) {
        await page.goto(path);
        await storiesReady(page);
        const cursors = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".stories-app, .stories-app *"))
            .map((el) => getComputedStyle(el).cursor)
            .filter((c) => c !== "default" && c !== "auto"),
        );
        expect(cursors, `${path}: cursor`).toEqual([]);
        const axe = await new AxeBuilder({ page }).include(".stories-app").withRules(["color-contrast"]).analyze();
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`)), `${path}: contrast`).toEqual([]);
        expect(await visibleEdges(page), `${path}: edges`).toEqual([]);
        const small = await page.evaluate((need) => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(".stories-app a[href], .stories-app button, .stories-app [role=tab], .stories-app [role=radio], .stories-app [role=switch], .stories-app input"))) {
            if (el.closest(".sr-only") || !el.checkVisibility()) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.bottom < 0 || r.right < 0 || r.top > innerHeight * 6) continue;
            if (r.width < need - 0.5 || r.height < need - 0.5) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${Math.round(r.width)}×${Math.round(r.height)} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`);
          }
          return out;
        }, phone ? 48 : 44);
        expect(small, `${path}: targets`).toEqual([]);
      }
    });

  test("every control shows itself on hover", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Social accounts' list (a row's link too; the list has no main button: the rows are the way on), then a platform's
    // own page, whose card has the one main button.
    for (const [path, sels] of [
      ["/stories/connections", [".st-rail__item:not(.is-active)", ".st-btn:not(.st-btn--main)", ".ws-switch__opt:not(.is-on)", ".st-setupback__go", "a.st-social-row"]],
      ["/stories/connections/facebook", [".st-btn:not(.st-btn--main)", ".st-btn--main", ".st-crumbs__link"]],
    ] as const) {
      await page.goto(path);
      await storiesReady(page);
      if (path === "/stories/connections") await expect(page.locator(".st-connections .st-btn--main")).toHaveCount(0);
      for (const sel of sels) {
        const el = page.locator(sel).first();
        const before = await el.evaluate((e) => getComputedStyle(e).backgroundColor);
        await el.hover();
        // The hover's colour eases in; a slow frame (a busy machine) must not read it before its first step.
        await expect.poll(() => el.evaluate((e) => getComputedStyle(e).backgroundColor), { message: `${path} ${sel}`, timeout: 3000 }).not.toBe(before);
        await page.mouse.move(0, 0);
      }
    }
  });
});

test.describe("round 4: the two apps stay apart and quiet (§45.35)", () => {
  test("D16: Lamo Stories breaking shows its own card; Clip Factory stays as it was; Try again brings Lamo Stories back", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Lamo Stories' own code cannot load (a network hiccup): its chunk fails, in the idle fetch and on the switch.
    const chunk = /\/assets\/StoriesApp-[^/]+\.js$/;
    await page.route(chunk, (r) => r.abort());
    await page.goto("/library?view=week");
    await settle(page);
    await toStories(page);
    const card = page.locator('[data-app-pane="stories"] [data-stories-problem]');
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Clips Funded had a problem." })).toBeVisible();
    // Clip Factory is untouched behind it: kept, hidden and inert, never its own "Something went wrong".
    await expect(page.locator('[data-app-pane="clips"]')).toHaveAttribute("inert", "");
    await expect(page.getByText("Tap Reload to start Clip Factory again.")).toHaveCount(0);
    await card.getByRole("button", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library\?view=week$/);
    await expect(page.locator('[data-app-pane="clips"]')).not.toHaveAttribute("inert");
    await expect(page.locator("nav.sidebar .sidebar__item.is-active")).toHaveAttribute("data-help", "nav-library");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").workspaceId)).toBe("clips");
    // Once the code can load: Try again makes a fresh Lamo Stories.
    await page.unroute(chunk);
    await toStories(page);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Try again" }).click();
    await storiesReady(page);
    await expect(card).toHaveCount(0);
    await expect(page.locator(".stories-app")).toBeVisible();
  });

  for (const [width, height, mac] of [
    [1280, 600, false],
    [1280, 650, false],
    [1280, 520, false],
    [1280, 650, true],
    [1000, 600, true],
  ] as const)
    test(`E16: at ${width}x${height}${mac ? " in the Mac window" : ""} Lamo Stories' own switcher is in view and takes one click, with no scrolling`, async ({ page }) => {
      if (mac) await asMacWindow(page);
      await on(page);
      await page.setViewportSize({ width, height });
      await page.goto("/stories/library");
      await storiesReady(page);
      // The shell's switch (§45.38): the bar's Clip Factory choice, or in a short window the toggle that goes there.
      const opt = page.locator(".ws-dock").getByRole("link", { name: /^(Go to )?Clip Factory$/ });
      const hit = await opt.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const list = document.querySelector(".st-rail .st-rail__list")!.getBoundingClientRect();
        // Over the rail it is never over the list of pages (the rail's foot keeps its box free).
        const overList = r.left < list.right && r.right > list.left && r.top < list.bottom - 0.5 && r.bottom > list.top;
        return { same: !!at && (at === el || el.contains(at)), bottom: r.bottom, top: r.top, inner: innerHeight, overList };
      });
      expect(hit.same, "the switcher's Clip Factory choice is what is under its own centre").toBe(true);
      expect(hit.overList, "the switch covers none of the rail's pages").toBe(false);
      expect(hit.top).toBeGreaterThanOrEqual(0);
      expect(hit.bottom).toBeLessThanOrEqual(hit.inner);
      // The brand stays at the top too; only the list of pages scrolls, inside the rail.
      await expect(page.locator(".st-rail .st-brand")).toBeInViewport();
      expect(await page.locator(".st-rail").evaluate((el) => el.scrollTop)).toBe(0);
      // A real click at that spot, with nothing scrolled first: Clip Factory.
      const box = (await opt.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page).not.toHaveURL(/\/stories/);
      await settle(page);
    });

  test("E16: in a short window every page of the rail can still be reached (the list scrolls inside the rail)", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.goto("/stories");
    await storiesReady(page);
    const last = page.locator(".st-rail .st-rail__item").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page).toHaveURL(/\/stories\/settings/);
    await expect(page.locator(".ws-dock").getByRole("link", { name: /^(Go to )?Clip Factory$/ })).toBeInViewport();
  });

  test("D19: in a short window with the sidebar folded, the slim toggle beside the fold button switches in one click", async ({ page }) => {
    await on(page, () => localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true })));
    await page.setViewportSize({ width: 1000, height: 560 });
    await page.goto("/jobs");
    await settle(page);
    // The shell's switch (§45.38), beside the fold button in this window.
    const dock = page.locator(".ws-dock");
    await expect(dock).toHaveAttribute("data-ws-dock", "top");
    const beside = dock.locator(".ws-switch-host");
    await expect(beside).toHaveAttribute("data-ws-switch", "slim");
    const fold = (await page.locator(".sidebar__toggle").boundingBox())!;
    const slim = (await beside.boundingBox())!;
    expect(slim.x).toBeGreaterThanOrEqual(fold.x + fold.width + 3.5);
    expect(slim.width).toBeGreaterThanOrEqual(28);
    expect(slim.height).toBeGreaterThanOrEqual(28);
    const go = beside.getByRole("link", { name: "Go to Clips Funded" });
    // It answers a hover, as every control does: its fill changes (since the logic of light, ADR-87, a hover lays more
    // bone light over the same green, so the change can be in the light layer alone).
    const fill = () => go.evaluate((el) => `${getComputedStyle(el).backgroundColor} ${getComputedStyle(el).backgroundImage}`);
    const rest = await fill();
    await go.hover();
    await expect.poll(fill).not.toBe(rest);
    await go.click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await toClips(page);
    await expect(page).toHaveURL(/\/jobs$/);
    // Unfolded, the foot has room again and the toggle beside the fold button is gone.
    await page.locator(".sidebar__toggle").click();
    await expect(dock).not.toHaveAttribute("data-ws-dock", "top");
    await expect(dock).not.toHaveAttribute("data-ws-dock", "none");
  });

  test("D19: with more than two workspaces, the toggle beside the fold button opens its list below it, inside the window", async ({ page }) => {
    await on(page, () => {
      localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
      (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { moreStudios: 2 } };
    });
    await page.setViewportSize({ width: 1000, height: 560 });
    await page.goto("/jobs");
    await settle(page);
    await expect(page.locator(".ws-dock")).toHaveAttribute("data-ws-dock", "top");
    const beside = page.locator(".ws-dock .ws-switch-host");
    await expect(beside).toHaveAttribute("data-ws-switch", "slim");
    const toggle = beside.getByRole("button", { name: "Pick a workspace (now Clip Factory)" });
    await toggle.click();
    const menu = beside.getByRole("dialog", { name: "Pick a workspace" });
    await expect(menu.locator(".ws-switch__opt")).toHaveCount(4);
    const box = (await menu.boundingBox())!;
    const at = (await toggle.boundingBox())!;
    // Below the toggle and wholly on screen: every choice can be reached.
    expect(box.y).toBeGreaterThanOrEqual(at.y + at.height);
    expect(box.y + box.height).toBeLessThanOrEqual(560);
    expect(box.x + box.width).toBeLessThanOrEqual(1000);
    await menu.locator(".ws-switch__opt", { hasText: "Studio 3" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await expect(page.locator(".stories-app")).toHaveAttribute("data-ws", "ws_studio_3");
  });

  test("D17: a Connect that answers while Clip Factory is on screen waits, and goes on once Lamo Stories is back", async ({ page }) => {
    await on(page, () => {
      (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { connectMs: 1500, connectResult: "connected" } };
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/library");
    await settle(page);
    await toStories(page);
    await storiesReady(page);
    await page.locator(".st-rail").getByRole("link", { name: "Social accounts" }).click();
    await storiesReady(page);
    await page.locator('.st-social-row-wrap[data-platform="facebook"] a.st-social-row').click();
    await expect(page).toHaveURL(/\/stories\/connections\/facebook$/);
    await storiesReady(page);
    const fb = page.locator('.st-conn[data-platform="facebook"]');
    await fb.getByRole("button", { name: "Connect Facebook" }).click();
    await toClips(page);
    await settle(page);
    await page.waitForTimeout(2500);
    // The answer came behind Clip Factory: nothing moved.
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.locator('[data-app-pane="clips"]')).toBeVisible();
    await toStories(page);
    await expect(page.locator(".toast__text").filter({ hasText: "Connected as Clips Funded" })).toBeVisible({ timeout: 8000 });
    await expect(page).toHaveURL(/\/stories\/connections\/facebook$/);
  });

  test("D17: a video playing in Clip Factory is paused when Lamo Stories is opened", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/review");
    await settle(page);
    // A playing clip (the mock's clip has no real video, so the page's own element is made to play).
    const playing = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-app-pane="clips"] video') ?? document.querySelector('[data-app-pane="clips"] main')!.appendChild(document.createElement("video"));
      let paused = false;
      Object.defineProperty(v, "paused", { configurable: true, get: () => paused });
      Object.defineProperty(v, "pause", { configurable: true, value: () => void (paused = true) });
      (window as unknown as { __clip: HTMLVideoElement }).__clip = v;
      return !v.paused;
    });
    expect(playing).toBe(true);
    await toStories(page);
    await storiesReady(page);
    expect(await page.evaluate(() => (window as unknown as { __clip: HTMLVideoElement }).__clip.paused)).toBe(true);
  });

  test("D21: on a phone the toasts sit above an open sheet's buttons, and go back when it closes", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/stories/review/01JSTST0000000000000000003");
    await storiesReady(page);
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    const bar = page.locator(".st-s-sheet__actions");
    await expect(bar).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page.locator("body")).toHaveClass(/(^|\s)st-toasts-up(\s|$)/);
    const barTop = await bar.evaluate((el) => el.getBoundingClientRect().top);
    const stackBottom = await page.locator(".toasts").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(stackBottom, "the toasts end above the sheet's buttons").toBeLessThanOrEqual(barTop - 7);
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/(^|\s)st-toasts-up(\s|$)/);
    // On a computer they stay where they always are.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Post it", exact: true }).click();
    await expect(bar).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator("body")).not.toHaveClass(/(^|\s)st-toasts-up(\s|$)/);
  });

  test("D21: the dashboard's connected accounts are never cut off at 320 px", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/stories");
    await storiesReady(page);
    const rows = page.locator(".st-accounts__row");
    await expect(rows).toHaveCount(5);
    const cut = await rows.evaluateAll((els) =>
      els.flatMap((row) => {
        const r = row.getBoundingClientRect();
        const out: string[] = [];
        for (const el of Array.from(row.querySelectorAll<HTMLElement>(".st-accounts__name, .st-chip"))) {
          const b = el.getBoundingClientRect();
          if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.textContent}: cut (${el.scrollWidth} > ${el.clientWidth})`);
          if (b.right > r.right + 0.5 || b.left < r.left - 0.5) out.push(`${el.textContent}: outside its row`);
        }
        return out;
      }),
    );
    expect(cut).toEqual([]);
  });
});
