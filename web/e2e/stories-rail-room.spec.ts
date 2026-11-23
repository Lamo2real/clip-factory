import { expect, test, type Page } from "@playwright/test";

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
    return { bottom: r.bottom, dockTop: Math.min(...parts.map((b) => b.top)), scrolls: list.scrollHeight > list.clientHeight + 1 };
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
  [1440, 900],
] as const)
  test(`${w}x${h}: the rail's pages end above the switch, every one can be reached, the chosen one is in view`, async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: w, height: h });
    for (const path of ["/stories", "/stories/settings/ai", "/stories/connections"]) {
      await open(page, path);
      const r = await room(page);
      expect(r.bottom, `${path}: the list ends above the switch`).toBeLessThanOrEqual(r.dockTop);
      if (h >= 768) expect(r.scrolls, `${path}: all the pages fit from 768 px high`).toBe(false);
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
