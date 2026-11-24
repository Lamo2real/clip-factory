import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";

// Clip Factory Stories' rail in short windows (owner, 23 Nov: the switch never covers anything). The shell's fixed
// workspace switch and Live chip (app/WorkspaceDock.tsx) sit over the rail's foot: the rail's list of pages ends above
// their box (--ws-dock-room) at every size and scrolls when it needs more room. From 768 px high all its pages fit with
// no scrolling; in a shorter window the chosen page is scrolled into view, and every page can be scrolled to and
// clicked, never the switch in its place.

async function on(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator(".st-rail .st-rail__item.is-active").waitFor({ timeout: 15_000 });
  await page.locator(".ws-dock .live-dot").waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** The list's visible box against the top of the shell's dock parts (the switch, else the Live chip). */
async function room(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".st-rail .st-rail__list")!;
    const r = list.getBoundingClientRect();
    const parts = [...document.querySelectorAll(".ws-dock .ws-switch, .ws-dock .live-dot")].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    const cs = getComputedStyle(list);
    // the list's own room (its box less its padding) and how tall its rows are
    const room = list.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const row = document.querySelector<HTMLElement>(".st-rail .st-rail__item")!.getBoundingClientRect().height;
    // the room between each page's link and the next one's (the pages stay packed under the brand: --st-gap-control)
    const links = [...document.querySelectorAll<HTMLElement>(".st-rail .st-rail__item")].map((a) => a.getBoundingClientRect());
    const gaps = links.slice(1).map((b, i) => Math.round((b.top - links[i]!.bottom) * 10) / 10);
    const gap = parseFloat(getComputedStyle(list).rowGap);
    return { bottom: r.bottom, dockTop: Math.min(...parts.map((b) => b.top)), scrolls: list.scrollHeight > list.clientHeight + 1, room, row, gaps, gap };
  });
}

/** Each page of the rail, scrolled into the list's view, is itself at its centre (nothing of the shell over it). */
async function reachable(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".st-rail .st-rail__list")!;
    const out: string[] = [];
    for (const a of document.querySelectorAll<HTMLElement>(".st-rail .st-rail__item")) {
      a.scrollIntoView({ block: "nearest" });
      const b = a.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!hit || !a.contains(hit) || b.top < l.top - 0.5 || b.bottom > l.bottom + 0.5) out.push(`${a.textContent?.trim()} (${hit?.className ?? "nothing"})`);
    }
    list.scrollTop = 0;
    return out;
  });
}

for (const [w, h] of [
  [1024, 768],
  [1366, 768],
  [1280, 800],
  [1280, 720],
  // just over the old 820 px breakpoint, where 48 px rows came back before the ten pages fit at 48 (the review: the
  // list scrolled and Settings was cut at its end from 821 to 837 px high)
  [1280, 821],
  [1280, 830],
  [1280, 837],
  [1280, 840],
  [1920, 845],
  [1440, 900],
  // tall windows, where the list has far more room than its pages need (they stay packed under the brand)
  [1920, 1080],
  [1440, 1200],
] as const)
  test(`${w}x${h}: the rail's pages end above the switch, every one can be reached, the chosen one is in view`, async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: w, height: h });
    // Social accounts' list and a platform's own page (the rail marks Social accounts on both).
    for (const path of ["/stories", "/stories/settings/ai", "/stories/connections", "/stories/connections/youtube"]) {
      await open(page, path);
      const r = await room(page);
      expect(r.bottom, `${path}: the list ends above the switch`).toBeLessThanOrEqual(r.dockTop);
      if (h >= 768) expect(r.scrolls, `${path}: all the pages fit from 768 px high`).toBe(false);
      // 48 px rows wherever the ten fit at 48 (10 × 48 + 9 × 4 = 516 px of room), the lower 40 px only where not
      expect(r.row, `${path}: rows of ${r.row} px in ${r.room} px of room`).toBe(r.room >= 516 ? 48 : 40);
      // The pages packed under the brand, 4 px apart, never spread down the rail's room.
      expect(r.gap, `${path}: --st-gap-control`).toBe(4);
      expect(r.gaps, `${path}: the room between the pages`).toEqual(r.gaps.map(() => 4));
      // The chosen page is wholly inside the list's view as the page opens, nothing scrolled by hand.
      const shown = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".st-rail .st-rail__list")!.getBoundingClientRect();
        const a = document.querySelector<HTMLElement>(".st-rail .st-rail__item.is-active")!.getBoundingClientRect();
        return a.top >= list.top - 0.5 && a.bottom <= list.bottom + 0.5;
      });
      expect(shown, `${path}: the chosen page is in view`).toBe(true);
      expect(await reachable(page), `${path}: every page can be reached`).toEqual([]);
    }
    // A real click on the last page (Settings) opens it, never Clip Factory.
    await open(page, "/stories");
    const last = page.locator(".st-rail .st-rail__item").last();
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(page).toHaveURL(/\/stories\/settings/);
  });

// The Mac app lays its 28 px title bar over the page, so the rail starts lower: the rows follow the list's own room, not
// the window's height, so its pages fit there too wherever 40 px rows can (from 800 px high), at 48 px where 48 fit.
for (const [w, h] of [
  [1280, 800],
  [1280, 850],
  [1280, 866],
  [1440, 900],
] as const)
  test(`the Mac app, ${w}x${h}: the rail's pages fit above the switch, at 48 px where they can`, async ({ page }) => {
    await asMacWindow(page);
    await on(page);
    await page.setViewportSize({ width: w, height: h });
    for (const path of ["/stories", "/stories/connections", "/stories/connections/youtube"]) {
      await open(page, path);
      const r = await room(page);
      expect(r.bottom, `${path}: the list ends above the switch`).toBeLessThanOrEqual(r.dockTop);
      expect(r.scrolls, `${path}: all the pages fit`).toBe(false);
      expect(r.row, `${path}: rows of ${r.row} px in ${r.room} px of room`).toBe(r.room >= 516 ? 48 : 40);
      expect(r.gaps, `${path}: the room between the pages`).toEqual(r.gaps.map(() => 4));
      expect(await reachable(page), `${path}: every page can be reached`).toEqual([]);
    }
  });
