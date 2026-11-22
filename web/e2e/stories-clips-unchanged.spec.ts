import { expect, test, type Browser, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Lamo Clips does not change (docs/CONTRACTS.md §45.1, §45.16.1, §45.17, §45.38). With Lamo Stories switched off the
// shell has no new element at all: no switcher in the page, the six menu items and the six phone tabs exactly as
// before, and every /stories address is Lamo Clips' own "page does not exist". Switched on (cf.storiesPreview = 1) the
// six items, their boxes, the Live chip, Get the app, the jobs line and the tab bar are identical to the switched-off
// page, and the shell's switch (app/WorkspaceDock.tsx) sits only in space that was empty at every size: above the
// Live chip in the sidebar's foot (or a round toggle beside or above it, or a slim one between the menu and the foot,
// or, in a folded sidebar too short for that, a slim one beside the fold button) and, on a phone, in the top bar
// between the brand and the Live chip, never covering or pushing anything (on the smallest phones, 320 px, the brand
// drops its name, §45.36 E16). Pixel before/after shots against main are taken on one machine (web/scripts/clips-unchanged.sh).

const ITEMS = [
  ["home", "/", "Home"],
  ["jobs", "/jobs", "Jobs"],
  ["review", "/review", "Review"],
  ["library", "/library", "Library"],
  ["money", "/money", "Money"],
  ["settings", "/settings", "Settings"],
] as const;

type Box = { x: number; y: number; width: number; height: number };
interface Layout {
  items: (Box | null)[];
  tabs: (Box | null)[];
  tabbar: Box | null;
  foot: Record<string, Box | null>;
  top: Record<string, Box | null>;
  mainTop: number;
  /** the page's own box (beside the sidebar) */
  page: Box | null;
  switcher: { mode: string | null; box: Box | null; place: string; squeeze: boolean }[];
}

const SIZES: { w: number; h: number; folded?: boolean }[] = [
  { w: 320, h: 700 },
  { w: 340, h: 700 },
  { w: 360, h: 740 },
  { w: 390, h: 844 },
  { w: 1000, h: 600 },
  { w: 1000, h: 600, folded: true },
  { w: 1000, h: 650 },
  { w: 1000, h: 650, folded: true },
  { w: 1000, h: 720 },
  { w: 1000, h: 720, folded: true },
  { w: 1440, h: 900 },
  { w: 1440, h: 900, folded: true },
  // A short window with the sidebar folded: no room in the foot, so a slim toggle sits beside the fold button (§45.35 D19).
  { w: 1000, h: 560, folded: true },
];

async function open(browser: Browser, size: (typeof SIZES)[number], on: boolean, path = "/"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, reducedMotion: "reduce" });
  await ctx.addInitScript(
    ([flag, folded]) => {
      localStorage.setItem("cf.storiesPreview", flag ? "1" : "0");
      if (folded) localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
    },
    [on, !!size.folded] as const,
  );
  const page = await ctx.newPage();
  await page.goto(path);
  await settle(page);
  return page;
}

/** Waits for the late arrivals that change the shell (the live dot, the jobs line) so both runs compare the same page,
 * then stops every animation and transition: the live dot pulses (a scale), and a box read in the middle of a pulse
 * would differ between two otherwise identical pages. Only this test's page is frozen; the app is not changed. */
async function steady(page: Page, phone: boolean) {
  await page.locator(phone ? ".topbar .live-dot" : ".sidebar__live .live-dot").waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate((keys) => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    };
    return {
      items: keys.map((k) => box(document.querySelector(`nav.sidebar .sidebar__item[data-help="nav-${k}"]`))),
      tabs: keys.map((k) => box(document.querySelector(`nav.tabbar .tabbar__item[data-help="nav-${k}"]`))),
      tabbar: box(document.querySelector("nav.tabbar")),
      foot: {
        live: box(document.querySelector(".sidebar__live .live-dot")),
        getapp: box(document.querySelector(".sidebar__getapp")),
        status: box(document.querySelector(".sidebar__status")),
        toggle: box(document.querySelector(".sidebar__toggle")),
        brand: box(document.querySelector(".sidebar__top .brand")),
      },
      top: { brand: box(document.querySelector(".topbar .brand")), live: box(document.querySelector(".topbar .live-dot")), bar: box(document.querySelector(".topbar")) },
      mainTop: Math.round(document.querySelector("main")!.getBoundingClientRect().top),
      page: box(document.querySelector(".shell > .main")),
      // The shell's switch (§45.38): on a computer the dock's (its place in data-ws-dock), on a phone the top bar's toggle.
      switcher: Array.from(document.querySelectorAll(".ws-switch-host"))
        .filter((el) => box(el))
        .map((el) => {
          const top = el.classList.contains("ws-switch-host--topbar");
          const dock = el.closest(".ws-dock")?.getAttribute("data-ws-dock");
          return {
            mode: el.getAttribute("data-ws-switch"),
            squeeze: el.hasAttribute("data-ws-squeeze"),
            // On a phone the toggle's own box (the Live chip sits beside it in the same host).
            box: box(top ? el.querySelector(".ws-round") : el),
            place: top ? "topbar" : dock === "top" ? "sidebar-top" : "sidebar",
          };
        }),
    };
  }, ITEMS.map(([k]) => k));
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test.describe("with Lamo Stories switched off", () => {
  for (const size of [SIZES[0]!, SIZES[3]!, SIZES[6]!, SIZES[10]!])
    test(`the shell has no new element at ${size.w}×${size.h}`, async ({ browser }) => {
      const page = await open(browser, size, false);
      await steady(page, size.w < 768);
      await expect(page.locator(".ws-dock, .ws-switch-host, .ws-switch, .ws-round, [data-ws-switch], [data-ws-dock]")).toHaveCount(0);
      // The six menu items and the six phone tabs, in order, with their own words and addresses.
      const side = page.locator("nav.sidebar .sidebar__list .sidebar__item");
      await expect(side).toHaveCount(6);
      const tabs = page.locator("nav.tabbar .tabbar__item");
      await expect(tabs).toHaveCount(6);
      for (const [i, [key, href, label]] of ITEMS.entries()) {
        await expect(side.nth(i)).toHaveAttribute("href", href);
        await expect(side.nth(i)).toHaveAttribute("data-help", `nav-${key}`);
        await expect(side.nth(i).locator(".sidebar__label")).toHaveText(label);
        await expect(tabs.nth(i)).toHaveAttribute("href", href);
        await expect(tabs.nth(i)).toHaveAttribute("title", label);
      }
      // The sidebar foot holds what it held before, and nothing else.
      const foot = await page.locator(".sidebar__foot > *").evaluateAll((els) => els.map((e) => e.className));
      expect(foot.every((c) => /sidebar__(live|getapp|status)/.test(c)), foot.join(", ")).toBe(true);
      const top = await page.locator(".topbar > *").evaluateAll((els) => els.map((e) => e.className.split(" ")[0]));
      expect(top.filter((c) => c !== "live-dot")).toEqual(["brand"]);
      await page.context().close();
    });

  for (const path of ["/stories", "/stories/ideas", "/stories/connections?platform=youtube&result=connected&ws=stories"])
    test(`${path} is Lamo Clips' own "page does not exist"`, async ({ browser }) => {
      const page = await open(browser, { w: 1280, h: 800 }, false, path);
      await expect(page.getByText("This page does not exist")).toBeVisible();
      await expect(page.locator(".stories-app")).toHaveCount(0);
      await expect(page.locator("nav.sidebar .sidebar__item.is-active")).toHaveCount(0);
      expect(await page.title()).toBe("Not found · Clip Factory");
      await page.context().close();
    });

  test("the page tree is as before: the shell right under #root, no pane, and Lamo Stories' code is never fetched", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "0"));
    const page = await ctx.newPage();
    const fetched: string[] = [];
    page.on("request", (r) => {
      if (/\/assets\/StoriesApp-[^/]+\.(js|css)$/.test(r.url())) fetched.push(r.url());
    });
    await page.goto("/library");
    await settle(page);
    await expect(page.locator("#root > .app")).toHaveCount(1);
    await expect(page.locator("[data-app-pane]")).toHaveCount(0);
    await expect(page.locator("main#main")).toHaveCount(1);
    // Idle for a while (the switched-on app fetches the studio's code then): nothing of Lamo Stories comes.
    await page.waitForTimeout(2500);
    expect(fetched).toEqual([]);
    await ctx.close();
  });

  test("opening / never jumps to Lamo Stories, whatever was stored", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "0"));
    await ctx.addInitScript(() =>
      localStorage.setItem("cf.workspace", JSON.stringify({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastClipsPath: "/jobs", lastStoriesPath: "/stories/ideas" })),
    );
    const page = await ctx.newPage();
    await page.goto("/");
    await settle(page);
    expect(new URL(page.url()).pathname).toBe("/");
    await ctx.close();
  });
});

test.describe("with Lamo Stories switched on", () => {
  for (const size of SIZES)
    test(`the six items, their boxes and the tab bar are as before, and the switcher covers nothing at ${size.w}×${size.h}${size.folded ? ", folded" : ""}`, async ({ browser }) => {
      const phone = size.w < 768;
      const off = await open(browser, size, false);
      await steady(off, phone);
      const before = await layout(off);
      await off.context().close();
      const on = await open(browser, size, true);
      await steady(on, phone);
      // The switcher measures after the live dot arrives: give it a frame or two to settle.
      await on.waitForTimeout(300);
      const after = await layout(on);

      expect(after.items).toEqual(before.items);
      expect(after.tabs).toEqual(before.tabs);
      expect(after.tabbar).toEqual(before.tabbar);
      expect(after.foot).toEqual(before.foot);
      // On the smallest phones (320 px) the brand drops its name so the switch stays a full 48 px (§45.36 E16): its
      // mark stays where it was; the live dot and the bar do not move. Everywhere else the top bar is as before.
      const squeezed = after.switcher.some((sw) => sw.place === "topbar" && sw.squeeze);
      if (squeezed) {
        expect(phone && size.w < 340, "the brand drops its name only below 340 px").toBe(true);
        expect({ ...after.top, brand: null }).toEqual({ ...before.top, brand: null });
        expect({ x: after.top.brand!.x, y: after.top.brand!.y, height: after.top.brand!.height }).toEqual({ x: before.top.brand!.x, y: before.top.brand!.y, height: before.top.brand!.height });
        expect(after.top.brand!.width).toBeGreaterThanOrEqual(44);
      } else expect(after.top).toEqual(before.top);
      expect(after.mainTop).toBe(before.mainTop);

      // A folded sidebar in a window under about 570 px tall has no room in its foot: then the way across is the slim
      // toggle beside the fold button (§45.35 D19); everywhere else the switch is in the foot. One switch, always.
      const short = !phone && !!size.folded && size.h < 570;
      expect(after.switcher, "one switch on screen").toHaveLength(1);
      const here = after.switcher[0]!;
      expect(here.place, "where the switch is").toBe(phone ? "topbar" : short ? "sidebar-top" : "sidebar");
      expect(here, "a switcher host in the shell").toBeTruthy();
      const others = [...after.items, ...after.tabs, ...Object.values(after.foot), after.top.brand, after.top.live].filter((b): b is Box => !!b);
      // There is a way across at every size (§45.16.1): never missing, never covering or moving anything.
      expect(here.mode, "a switcher in the shell").not.toBe("none");
      expect(here.box, "the switcher has a box").toBeTruthy();
      const box = here.box!;
      for (const b of others) expect(overlaps(box, b), `switcher ${JSON.stringify(box)} covers ${JSON.stringify(b)}`).toBe(false);
      if (phone) {
        // Inside the top bar, between the brand and the live dot, 48 px tall for a finger.
        const bar = after.top.bar!;
        expect(box.y).toBeGreaterThanOrEqual(bar.y - 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
        expect(box.x).toBeGreaterThanOrEqual(after.top.brand!.x + after.top.brand!.width + 3.5);
        if (after.top.live) expect(box.x + box.width).toBeLessThanOrEqual(after.top.live.x - 3.5);
        expect(box.height).toBeGreaterThanOrEqual(48);
        // A full finger's target at every width: at least 44 px (§45.36 E16).
        expect(box.width).toBeGreaterThanOrEqual(44);
      } else if (short) {
        // Right of the fold button with 4 px of air, as tall as it is, and short of the page with 4 px of air.
        const toggle = after.foot.toggle!;
        expect(box.x).toBeGreaterThanOrEqual(toggle.x + toggle.width + 3.5);
        expect(box.y).toBeGreaterThanOrEqual(toggle.y - 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(toggle.y + toggle.height + 0.5);
        if (after.page && after.page.y < box.y + box.height) expect(box.x + box.width).toBeLessThanOrEqual(after.page.x - 3.5);
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
        expect(here.mode).toBe("slim");
      } else {
        const sidebar = await on.locator("nav.sidebar").boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(sidebar!.x);
        expect(box.x + box.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width + 0.5);
        expect(box.y).toBeGreaterThanOrEqual(after.items[5]!.y + after.items[5]!.height + 3.5);
        if (here.mode === "slim") {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(28);
        } else expect(box.height).toBeGreaterThanOrEqual(44);
      }
      // Where there is room it is there in its largest form: the bar from about 650 px tall with the sidebar open, a
      // round toggle beside the live dot below that; folded, a round toggle, and in a short folded window (600 px
      // tall, 36 px between the menu and the foot) a slim one over that gap. On phones the icon over the short name
      // from 360 px (a pill with the name where it is roomy); at 340 px a slim icon-only toggle of 48 px fills the gap
      // with 4 px of air on each side; at 320 px the brand and the live dot leave about 38 px, so the brand drops its
      // name and the toggle is the round 48 px one (§45.36 E16).
      if (!phone && !size.folded) expect(here.mode, "sidebar open").toBe(size.h >= 650 ? "bar" : "corner");
      if (!phone && size.folded && !short) expect(here.mode, "sidebar folded").toBe(size.h >= 650 ? "round" : "slim");
      // On a phone it is the round toggle in both apps (the same box: 48 px, 44 by 48 below 360 px); the brand drops its
      // name only below 340 px.
      if (phone) expect([here.mode, here.squeeze], `phone at ${size.w}`).toEqual(["round", size.w < 340]);
      if (phone) expect(here.box!.width, `phone at ${size.w}`).toBe(size.w < 360 ? 44 : 48);
      await on.context().close();
    });

  test("Clip Factory's shell sits in a pane that takes no box of its own; Lamo Stories mounts only once it is opened", async ({ browser }) => {
    const page = await open(browser, { w: 1440, h: 900 }, true, "/library");
    await expect(page.locator('#root > [data-app-pane="clips"] > .app')).toHaveCount(1);
    expect(await page.locator('[data-app-pane="clips"]').evaluate((el) => getComputedStyle(el).display)).toBe("contents");
    await expect(page.locator('[data-app-pane="clips"]')).not.toHaveAttribute("inert");
    await expect(page.locator('[data-app-pane="stories"], .stories-app')).toHaveCount(0);
    await expect(page.locator("main#main")).toHaveCount(1);
    await page.context().close();
  });

  test("the switcher is a pick bar on the sliding highlight, never a menu item and never a new tab", async ({ browser }) => {
    const page = await open(browser, { w: 1440, h: 900 }, true);
    // The shell's own (§45.38), laid over the sidebar's foot: never one of the sidebar's own items.
    const bar = page.locator(".ws-dock .ws-switch");
    await expect(bar).toBeVisible();
    // One choice per workspace the server lists; Lamo Clips goes by the app's own name.
    await expect(bar.locator(".ws-switch__opt")).toHaveText(["Clip Factory", "Lamo Stories"]);
    await expect(bar.locator(".glide")).toHaveCount(1);
    await expect(bar.locator(".ws-switch__opt.is-on")).toHaveText("Clip Factory");
    await expect(page.locator(".sidebar__item.ws-switch__opt, .ws-switch .sidebar__item")).toHaveCount(0);
    for (const a of await bar.locator("a").all()) expect(await a.getAttribute("target")).toBeNull();
    await expect(page.locator("nav.sidebar .sidebar__list .sidebar__item")).toHaveCount(6);
    await page.context().close();
  });
});
