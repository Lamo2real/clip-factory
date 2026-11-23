import { mkdirSync, readFileSync } from "node:fs";
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
const SIZES: { w: number; h: number; folded?: boolean; window?: "mac" | "windows"; picture?: boolean }[] = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 768, h: 1024 },
  { w: 375, h: 812 },
  { w: 1440, h: 900, folded: true },
  // The desktop app's see-through window: the Mac's (its title bar laid over the page) and Windows' (its frame outside).
  { w: 1280, h: 800, window: "mac" },
  { w: 1280, h: 800, window: "windows" },
  // Stories' own Picture background (a white picture): its rail and phone top bar are glass plates over it there.
  { w: 1440, h: 900, picture: true },
  { w: 375, h: 812, picture: true },
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
async function open(browser: Browser, size: (typeof SIZES)[number], setupDone: boolean, firstTime = false): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    reducedMotion: "reduce",
  });
  // A brand-new studio: Lamo Stories opens its Setup by itself, on its own (no rail), the page the owner circled.
  if (firstTime) await ctx.addInitScript(() => ((window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } }));
  await ctx.addInitScript(
    ([folded, done, first, picture]) => {
      localStorage.setItem("cf.storiesPreview", "1");
      const more = picture ? { more: { "look.mode": "picture" } } : {};
      if (!first) localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], ...more }));
      else if (picture) localStorage.setItem("cf.stories.prefs", JSON.stringify(more));
      if (picture) {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const x = c.getContext("2d")!;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, 32, 32);
        localStorage.setItem("cf.stories.picture", c.toDataURL("image/png"));
      }
      if (folded) localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
      if (done && !sessionStorage.getItem("cf-mock-setup-skipped"))
        sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(["youtube", "tiktok", "instagram", "facebook", "x"]));
    },
    [!!size.folded, setupDone, firstTime, !!size.picture] as const,
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

/** Opens `path` (unless it is on screen already), waits for the page and the Live chip, and lets them settle. */
async function ready(page: Page, path: string, go = true) {
  if (go) await page.goto(path);
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

/**
 * Nothing covers the switch or the Live chip, and they cover nothing of the page: at their middle and near each side
 * the topmost thing is the dock itself, and right under it only the app's own empty background (the sidebar's or the
 * rail's glass, the page's frame): never a control, a picture or a line of words of the page.
 */
async function uncovered(page: Page, what: string) {
  const found = await page.evaluate(() => {
    const phone = innerWidth < 768;
    const pane = document.querySelector("[data-app-pane]:not([hidden])");
    const parts = phone
      ? [pane?.querySelector(".ws-switch-host--topbar .ws-round"), pane?.querySelector(".ws-switch-host--topbar .live-dot")]
      : [document.querySelector(".ws-dock .ws-switch-host"), document.querySelector(".ws-dock .live-dot")];
    const own = (el: Element) => (phone ? !!el.closest(".ws-switch-host--topbar") : !!el.closest(".ws-dock"));
    const content = (el: Element) =>
      el.closest("a, button, input, select, textarea, label, img, svg, video, canvas, [tabindex]:not(main):not([tabindex='-1'])") ??
      (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) ? el : null);
    const bad: string[] = [];
    for (const part of parts) {
      if (!part) {
        bad.push("missing");
        continue;
      }
      const r = part.getBoundingClientRect();
      // Its middle, and 3 px in from the middle of each side (inside a pill's and a circle's round ends too).
      const mx = r.x + r.width / 2;
      const my = r.y + r.height / 2;
      for (const [x, y] of [
        [mx, my],
        [r.x + 3, my],
        [r.right - 3, my],
        [mx, r.y + 3],
        [mx, r.bottom - 3],
      ] as const) {
        const stack = document.elementsFromPoint(x, y);
        if (!stack[0] || !own(stack[0])) {
          bad.push(`${part.className} at ${Math.round(x)},${Math.round(y)}: covered by ${stack[0]?.className || stack[0]?.tagName}`);
          continue;
        }
        const below = stack.find((el) => !own(el));
        const hit = below ? content(below) : null;
        if (hit) bad.push(`${part.className} at ${Math.round(x)},${Math.round(y)}: over ${hit.tagName}.${hit.className} "${(hit.textContent ?? "").trim().slice(0, 30)}"`);
      }
    }
    return bad;
  });
  expect(found, `${what}: the switch and the Live chip, uncovered and over nothing of the page`).toEqual([]);
}

const same = (a: Box | null, b: Box | null, what: string) => {
  expect(a, `${what}: shown`).not.toBeNull();
  expect(b, `${what}: shown`).not.toBeNull();
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(a![k] - b![k]), `${what}: ${k} ${a![k]} vs ${b![k]}`).toBeLessThanOrEqual(0.5);
};

for (const size of SIZES) {
  const label = `${size.w}x${size.h}${size.folded ? " folded" : ""}${size.window ? ` ${size.window}-window` : ""}${size.picture ? " picture" : ""}`;
  test(`the switch and the Live chip are one box, the same in Clip Factory and on every Lamo Stories page, at ${label}`, async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    const page = await open(browser, size, true);
    const seen: { path: string; at: Place }[] = [];
    for (const path of [...CLIPS, ...STORIES]) {
      await ready(page, path);
      const at = await place(page);
      seen.push({ path, at });
      await uncovered(page, `${label} ${path}`);
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
      if (!size.folded) for (const { at } of seen) expect(at.names).toEqual(["Clip Factory", "Funded Clips"]);
      for (const { path, at } of seen) expect(at.sw!.x, `${path}: in the left column`).toBeLessThan((size.folded ? 80 : 252) + 14 + 0.5);
    } else for (const { path, at } of seen) expect(at.names, path).toEqual([path.startsWith("/stories") ? "Clip Factory" : "Funded Clips"]);
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

test("a longer workspace name stands the choices one above the other, the same box in both apps, never cut short", async ({ browser }) => {
  const page = await open(browser, { w: 1440, h: 900 }, true);
  await ready(page, "/library");
  const bar = page.locator(".ws-dock .ws-switch");
  // Today's two names, "Clip Factory" and "Funded Clips", fit side by side.
  await expect(bar.locator(".ws-switch__opt")).toHaveText(["Clip Factory", "Funded Clips"]);
  await expect(bar).not.toHaveClass(/ws-switch--stack/);
  // The server names the studio so from now on (the shell reads the list again when Lamo Stories opens).
  await page.evaluate(() => {
    const store = (window as unknown as { __cfStoriesMock?: { store?: { workspaces: { workspaceName: string }[] } } }).__cfStoriesMock?.store;
    store!.workspaces[1]!.workspaceName = "Driving Safety Stories";
  });
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Funded Clips$/ }).click();
  await page.locator(".stories-app[data-ws]").waitFor();
  await expect(bar).toHaveClass(/ws-switch--stack/);
  await expect(bar.locator(".ws-switch__opt")).toHaveText(["Clip Factory", "Driving Safety Stories"]);
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

test("Lamo Stories' first Setup, on its own (the page the owner circled), shows the switch and the Live chip at Clip Factory's box", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const size of [SIZES[0]!, { w: 1280, h: 900 }, SIZES[2]!]) {
    const page = await open(browser, size, true, true);
    await ready(page, "/library");
    const clips = await place(page);
    await page.goto("/stories");
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await ready(page, "/stories/setup", false);
    await expect(page.locator(".stories-app.is-alone")).toHaveCount(1);
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "0 of 11 done");
    const setup = await place(page);
    await page.screenshot({ path: join(SHOTS, `${size.w}x${size.h}_first-setup-alone.png`) });
    same(setup.sw, clips.sw, `${size.w}x${size.h} the first Setup vs /library: the switch`);
    same(setup.live, clips.live, `${size.w}x${size.h} the first Setup vs /library: the Live chip`);
    await uncovered(page, `${size.w}x${size.h} the first Setup`);
    await page.context().close();
  }
});

test("Inter arriving after the switch is drawn never leaves it stacked: the same box as on a page where Inter was in at once", async ({ browser }) => {
  // A computer without Inter installed (the Linux CI runners, Windows, most Macs) draws the names in its own, wider
  // font until the web font is in; measured then, the two names did not fit side by side, and the switch stayed
  // stacked, 46 px higher, on every page where Inter came a moment late (CI run 45112115668: / side by side, /library
  // and Lamo Stories' pages stacked). A Mac with Inter installed draws Inter even before the web font is in, so a wide
  // font stands in for the missing one here, and Inter's file is held back. The stand-in is the same on every
  // computer: the repo's own Jost (web/public/fonts/stories, OFL) at 160 %, put on the page by the test before
  // anything is drawn (a system font such as Verdana is not on the Linux runner, whose own sans-serif fits).
  const page = await open(browser, SIZES[0]!, true);
  const ctx = page.context();
  const wide = readFileSync(join(import.meta.dirname, "..", "public", "fonts", "stories", "Jost-latin.woff2")).toString("base64");
  await page.addInitScript((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // From bytes, so it is loaded at once: the first measure already sees it.
    document.fonts.add(new FontFace("E2EWide", bytes, { sizeAdjust: "160%" } as FontFaceDescriptors));
  }, wide);
  const FAMILY = '"Inter Variable", Inter, system-ui,';
  let swapped = false;
  await ctx.route(/\/assets\/[^/]+\.css$/, async (route) => {
    const r = await route.fetch();
    const css = await r.text();
    swapped ||= css.includes(FAMILY);
    await route.fulfill({ response: r, body: css.replaceAll(FAMILY, '"Inter Variable", E2EWide,') });
  });
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await ctx.route(/\/assets\/inter-[^/]+\.woff2$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/library", { waitUntil: "domcontentloaded" });
  expect(swapped, "the app's font list, with the wide font in for the missing Inter").toBe(true);
  expect(await page.evaluate(() => Array.from(document.fonts).some((f) => f.family === "E2EWide" && f.status === "loaded")), "the wide stand-in, in before the first paint").toBe(true);
  const bar = page.locator(".ws-dock .ws-switch");
  // In the wide font the names do not fit side by side (stacked is right while it is drawn).
  await expect(bar).toHaveClass(/ws-switch--stack/, { timeout: 15_000 });
  release();
  await ready(page, "/library", false);
  await expect(bar).not.toHaveClass(/ws-switch--stack/);
  const late = await place(page);
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  // The next page has Inter from the cache at once: the same box.
  await ready(page, "/settings");
  const warm = await place(page);
  same(late.sw, warm.sw, "Inter came late vs at once: the switch");
  same(late.live, warm.live, "Inter came late vs at once: the Live chip");
  await page.context().close();
});

test("Clip Factory's jobs starting or ending behind Lamo Stories never move the switch there", async ({ browser }) => {
  const page = await open(browser, SIZES[0]!, true);
  await ready(page, "/library");
  await expect(page.locator("nav.sidebar .sidebar__status")).toBeVisible();
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Funded Clips$/ }).click();
  await page.locator(".stories-app[data-ws]").waitFor();
  await page.waitForTimeout(500);
  const before = await place(page);
  const room = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ws-dock-room"));
  const roomBefore = await room();
  // Every Clip Factory job finishes now, while Lamo Stories is on screen: Clip Factory's own foot (kept behind it)
  // loses its jobs line.
  await page.evaluate(() => {
    const jobs = (window as unknown as { __cfMock: { jobs: { finish(): string | null } } }).__cfMock.jobs;
    for (let i = 0; i < 20 && jobs.finish(); i++);
  });
  await expect(page.locator('[data-app-pane="clips"] .sidebar__status')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const after = await place(page);
  same(after.sw, before.sw, "the switch, after Clip Factory's jobs ended behind Lamo Stories");
  same(after.live, before.live, "the Live chip, after Clip Factory's jobs ended behind Lamo Stories");
  expect(await room(), "the room Lamo Stories' rail leaves it").toBe(roomBefore);
  // Back in Clip Factory it is where Clip Factory's foot has it now: right above the Live chip, right above Get the app.
  await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clip Factory" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.waitForTimeout(500);
  const back = await place(page);
  const getApp = (await page.locator("nav.sidebar .sidebar__getapp").boundingBox())!;
  expect(back.live!.y - (back.sw!.y + back.sw!.height)).toBeCloseTo(4, 0);
  const row = (await page.locator(".ws-dock .ws-dock__live").boundingBox())!;
  expect(getApp.y - (row.y + row.height)).toBeCloseTo(4, 0);
  await page.context().close();
});

test("a Lamo Stories sheet covers the switch like the rest of the page: no tap and no key reach it, and it is back once the sheet closes", async ({ browser }) => {
  const page = await open(browser, SIZES[0]!, true);
  await ready(page, "/stories/characters/01JSTCH0000000000000000001");
  await page.getByRole("button", { name: /^Delete/ }).first().click();
  const sheet = page.getByRole("dialog", { name: /Delete Pip/ });
  await expect(sheet).toBeVisible();
  const centre = async () =>
    page.evaluate(() => {
      const r = document.querySelector(".ws-dock .ws-switch-host")!.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { inDock: !!top?.closest(".ws-dock"), scrim: !!top && !!top.querySelector('[aria-modal="true"]'), inert: document.querySelector<HTMLElement>(".ws-dock")!.inert };
    });
  await expect.poll(centre).toEqual({ inDock: false, scrim: true, inert: true });
  // A tap there is a tap on the dim (it closes the sheet, the safe answer): Lamo Stories stays, the page too.
  const opt = (await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clip Factory" }).boundingBox())!;
  await page.mouse.click(opt.x + opt.width / 2, opt.y + opt.height / 2);
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/stories\/characters\//);
  await expect.poll(centre).toEqual({ inDock: true, scrim: false, inert: false });
  await page.context().close();
});

test("Clip Factory's own dialog covers the switch too (its dim is over it, and the switch takes no key)", async ({ browser }) => {
  const page = await open(browser, { w: 1000, h: 720 }, false);
  await ready(page, "/library");
  await page.locator(".setup-todo__pill").click();
  await expect(page.locator("#setup-todo-panel")).toBeVisible();
  const centre = () =>
    page.evaluate(() => {
      const r = document.querySelector(".ws-dock .ws-switch-host")!.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { inDock: !!top?.closest(".ws-dock"), inert: document.querySelector<HTMLElement>(".ws-dock")!.inert, dimmed: document.querySelector(".ws-dock")!.classList.contains("is-under") };
    });
  await expect.poll(centre).toEqual({ inDock: false, inert: true, dimmed: false });
  await page.keyboard.press("Escape");
  await expect(page.locator("#setup-todo-panel")).toHaveCount(0);
  await expect.poll(centre).toEqual({ inDock: true, inert: false, dimmed: false });
  await page.context().close();
});

test("for the keyboard the switch comes where it is drawn: right after the menu, before Get the app, in both apps", async ({ browser }) => {
  const page = await open(browser, SIZES[0]!, true);
  await ready(page, "/library");
  const focused = () => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
  await page.locator('nav.sidebar .sidebar__item[data-help="nav-settings"]').focus();
  const forward: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    forward.push(await focused());
  }
  expect(forward).toEqual(["Clip Factory", "Funded Clips", "Get the app"]);
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("Funded Clips");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("Settings");
  // Lamo Stories: right after its rail's pages.
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Funded Clips$/ }).click();
  await page.locator(".stories-app[data-ws]").waitFor();
  await page.locator(".st-rail .st-rail__item").last().focus();
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("Clip Factory");
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("Funded Clips");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ws-dock"))).toBe(false);
  await page.context().close();
});

test("unfolding Clip Factory's sidebar, the switch and the Live chip never show past the growing sidebar", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
  });
  const page = await ctx.newPage();
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".sidebar__toggle").click();
  // Held at moments of the unfold (the sidebar's own growth and the dock's, on one clock).
  for (const t of [40, 110, 220, 360]) {
    const at = await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
      const side = document.querySelector("nav.sidebar")!.getBoundingClientRect();
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        const m = /inset\(([^)]*)\)/.exec(getComputedStyle(el).clipPath);
        const right = m ? parseFloat(m[1]!.trim().split(/\s+/)[1] ?? m[1]!.trim().split(/\s+/)[0]!) : 0;
        return r.right - Math.max(0, right);
      };
      return {
        side: side.right,
        sw: shown(document.querySelector(".ws-dock .ws-switch-host")!),
        live: shown(document.querySelector(".ws-dock .ws-dock__live")!),
      };
    }, t);
    expect(at.sw, `${t} ms: the switch`).toBeLessThanOrEqual(at.side + 0.5);
    expect(at.live, `${t} ms: the Live chip's row`).toBeLessThanOrEqual(at.side + 0.5);
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        // An endless one (the Live chip's breath) has no end: it just plays on.
        a.play();
      }
    }
  });
  await expect(page.locator(".ws-dock")).not.toHaveClass(/is-unfolding/);
  await expect(page.locator(".ws-dock .ws-switch-host")).toHaveAttribute("data-ws-switch", "bar");
  await ctx.close();
});
