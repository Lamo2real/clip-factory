import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle } from "./helpers.ts";

// The workspace switch and the Live chip under it are ONE element of the app's shell, at exactly the same place, size
// and look whichever app is open (docs/CONTRACTS.md §45.38; the owner, 22 Nov: "keep that for both when I switch to
// Lamo Stories and back to Clip Factory", "That should be in the same place no matter what. Even if we're in Lamo
// Stories or if we're in Clip Factory."). Measured here in Clip Factory (/, /library, /settings) and on every Lamo
// Stories page the owner named (the dashboard, Setup, Ideas, Production, Settings, Social accounts), at four window
// sizes and with Clip Factory's sidebar folded, and required to be the same within half a pixel. A picture of each
// is kept under test-results/switch-place.

const CLIPS = ["/", "/library", "/settings"];
const STORIES = ["/stories", "/stories/setup", "/stories/ideas", "/stories/production", "/stories/settings", "/stories/connections"];
const SIZES: { w: number; h: number; folded?: boolean; window?: "mac" | "windows" }[] = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 768, h: 1024 },
  { w: 375, h: 812 },
  { w: 1440, h: 900, folded: true },
  // The desktop app's see-through window: the Mac's (its title bar laid over the page) and Windows' (its frame outside).
  { w: 1280, h: 800, window: "mac" },
  { w: 1280, h: 800, window: "windows" },
];
const SHOTS = join(import.meta.dirname, "..", "test-results", "switch-place");

type Box = { x: number; y: number; width: number; height: number };
interface Place {
  /** The switch: the bar, or the toggle (a round one on a phone). */
  sw: Box | null;
  /** The Live chip. */
  live: Box | null;
  /** The choices on the bar (or the toggle's own name), as read out. */
  names: string[];
  /** The pill's own look: its fill and words, the same in both apps. */
  look: { fill: string; on: string; words: string } | null;
}

/**
 * A fresh window at `size`, with Lamo Stories switched on. `setupDone`: Clip Factory's "Set up posting" list finished
 * (all five skipped, the owner's own state), so nothing of Clip Factory's own sits above its phone top bar.
 */
async function open(browser: Browser, size: (typeof SIZES)[number], setupDone: boolean): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([folded, done]) => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
      if (folded) localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
      if (done && !sessionStorage.getItem("cf-mock-setup-skipped"))
        sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(["youtube", "tiktok", "instagram", "facebook", "x"]));
    },
    [!!size.folded, setupDone] as const,
  );
  const page = await ctx.newPage();
  if (size.window === "mac") await asMacWindow(page);
  if (size.window === "windows") await asMacWindow(page, { titlebar: 0, glass: "mica" });
  return page;
}

/** The switch and the Live chip as they are on screen now (the app on screen's own, on a phone). */
async function place(page: Page): Promise<Place> {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el || !(el as HTMLElement).checkVisibility?.()) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const f = (n: number) => Math.round(n * 100) / 100;
      return {
        x: f(r.x),
        y: f(r.y + window.scrollY),
        width: f(r.width),
        height: f(r.height),
      };
    };
    const pane = document.querySelector<HTMLElement>("[data-app-pane]:not([hidden])");
    const phone = innerWidth < 768;
    const host = phone ? pane?.querySelector(".ws-switch-host--topbar") : document.querySelector(".ws-dock .ws-switch-host");
    const sw = phone ? host?.querySelector(".ws-round") : host;
    const live = phone ? host?.querySelector(".live-dot") : document.querySelector(".ws-dock .live-dot");
    const opts = Array.from(host?.querySelectorAll<HTMLElement>(".ws-switch__opt, .ws-round") ?? []);
    const pill = host?.querySelector<HTMLElement>(".ws-switch__opt.is-on, .ws-round");
    const cs = pill ? getComputedStyle(pill) : null;
    const glide = host?.querySelector<HTMLElement>(".glide");
    return {
      sw: box(sw),
      live: box(live),
      names: opts.map((o) => o.getAttribute("aria-label") ?? o.textContent?.trim() ?? "").map((n) => n.replace(/^Go to /, "")),
      look: cs
        ? {
            fill: glide ? getComputedStyle(glide).backgroundColor : cs.backgroundColor,
            on: cs.color,
            words: `${cs.fontFamily} ${cs.fontSize} ${cs.fontWeight}`,
          }
        : null,
    };
  });
}

/** Waits for the page and the Live chip, then freezes motion so nothing is read mid-pop. */
async function ready(page: Page, path: string) {
  await page.goto(path);
  if (path.startsWith("/stories")) {
    await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  } else await settle(page);
  await page
    .locator(".ws-dock .live-dot, [data-app-pane]:not([hidden]) .ws-switch-host--topbar .live-dot")
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

const same = (a: Box | null, b: Box | null, what: string) => {
  expect(a, `${what}: shown`).not.toBeNull();
  expect(b, `${what}: shown`).not.toBeNull();
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(a![k] - b![k]), `${what}: ${k} ${a![k]} vs ${b![k]}`).toBeLessThanOrEqual(0.5);
};

for (const size of SIZES) {
  const label = `${size.w}x${size.h}${size.folded ? " folded" : ""}${size.window ? ` ${size.window}-window` : ""}`;
  test(`the switch and the Live chip are one box, the same in Clip Factory and on every Lamo Stories page, at ${label}`, async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    const page = await open(browser, size, true);
    const seen: { path: string; at: Place }[] = [];
    for (const path of [...CLIPS, ...STORIES]) {
      await ready(page, path);
      const at = await place(page);
      seen.push({ path, at });
      await page.screenshot({
        path: join(SHOTS, `${label.replace(/ /g, "-")}${path === "/" ? "_home" : path.replace(/\//g, "_")}.png`),
      });
    }
    const [first, ...rest] = seen;
    expect(first!.at.sw, `${first!.path}: the switch`).not.toBeNull();
    for (const { path, at } of rest) {
      same(at.sw, first!.at.sw, `${path} vs ${first!.path}: the switch`);
      same(at.live, first!.at.live, `${path} vs ${first!.path}: the Live chip`);
      // The same element: the same choices and the same look (the shell's, never one app's own style).
      expect(at.names.length, `${path}: its choices`).toBe(first!.at.names.length);
      expect(at.look?.words, `${path}: its words`).toBe(first!.at.look?.words);
    }
    // On a computer the bar lists both apps and its highlight is on the app on screen; on a phone the toggle names the
    // other one.
    if (size.w >= 768) {
      if (!size.folded) for (const { at } of seen) expect(at.names).toEqual(["Clip Factory", "Clip Factory Stories"]);
      for (const { path, at } of seen) expect(at.sw!.x, `${path}: in the left column`).toBeLessThan((size.folded ? 80 : 252) + 14 + 0.5);
    } else for (const { path, at } of seen) expect(at.names, path).toEqual([path.startsWith("/stories") ? "Clip Factory" : "Clip Factory Stories"]);
    // Where it has always been in Clip Factory: the sidebar's foot, the switch right above the Live chip.
    if (size.w >= 768 && !size.folded) expect(first!.at.live!.y - (first!.at.sw!.y + first!.at.sw!.height)).toBeCloseTo(4, 0);
    await page.context().close();
  });
}

test("on a phone, while Clip Factory's own Set up posting pill sits above its top bar, the toggle keeps its side and size", async ({ browser }) => {
  // That pill belongs to Clip Factory's page (it moves Clip Factory's whole page down, top bar included), so there the
  // toggle is that much lower; it is at the same place in the top bar, the same size, at the same side.
  const size = SIZES[3]!;
  const page = await open(browser, size, false);
  await ready(page, "/library");
  const clips = await place(page);
  const bar = await page.locator('[data-app-pane="clips"] .topbar').boundingBox();
  await ready(page, "/stories/ideas");
  const stories = await place(page);
  const top = await page.locator(".st-top").boundingBox();
  for (const k of ["x", "width", "height"] as const) {
    expect(Math.abs(clips.sw![k] - stories.sw![k]), k).toBeLessThanOrEqual(0.5);
    expect(Math.abs(clips.live![k] - stories.live![k]), k).toBeLessThanOrEqual(0.5);
  }
  expect(Math.abs(clips.sw!.y - bar!.y - (stories.sw!.y - top!.y))).toBeLessThanOrEqual(0.5);
  await page.context().close();
});

test("a longer name (the rename to Clip Factory Stories) stands the choices one above the other, the same box in both apps, never cut short", async ({ browser }) => {
  const page = await open(browser, { w: 1440, h: 900 }, true);
  await ready(page, "/library");
  // The server names the studio so from now on (the shell reads the list again when Lamo Stories opens).
  await page.evaluate(() => {
    const store = (window as unknown as { __cfStoriesMock?: { store?: { workspaces: { workspaceName: string }[] } } }).__cfStoriesMock?.store;
    store!.workspaces[1]!.workspaceName = "Clip Factory Stories";
  });
  await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clip Factory Stories" }).click();
  await page.locator(".stories-app[data-ws]").waitFor();
  const bar = page.locator(".ws-dock .ws-switch");
  await expect(bar).toHaveClass(/ws-switch--stack/);
  await expect(bar.locator(".ws-switch__opt")).toHaveText(["Clip Factory", "Clip Factory Stories"]);
  const cut = () => bar.locator(".ws-switch__opt").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(await cut()).toEqual([]);
  await page.waitForTimeout(400);
  const stories = await place(page);
  // The rail's pages stop above it.
  const list = (await page.locator(".st-rail .st-rail__list").boundingBox())!;
  expect(list.y + list.height).toBeLessThanOrEqual(stories.sw!.y + 0.5);
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
  await expect(page).toHaveURL(/\/library$/);
  await settle(page);
  await page.waitForTimeout(400);
  const clips = await place(page);
  same(clips.sw, stories.sw, "the stacked switch");
  same(clips.live, stories.live, "the Live chip");
  // Clip Factory's menu is not covered either: the bar starts below the sixth item.
  const sixth = (await page.locator('nav.sidebar .sidebar__item[data-help="nav-settings"]').boundingBox())!;
  expect(clips.sw!.y).toBeGreaterThanOrEqual(sixth.y + sixth.height + 3.5);
  expect(await cut()).toEqual([]);
  await page.context().close();
});
