import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle } from "./helpers.ts";

// The two apps stay apart (docs/CONTRACTS.md §45.38; request 2: "These two applications must not depend on each
// other's internal functionality"). A Clip Factory request that finishes while Lamo Stories is on screen never moves
// the owner out of Lamo Stories: the address, the history and the device's stored choice (cf.workspace) stay Lamo
// Stories', and the page change it asked for happens the moment he comes back to Clip Factory. Nothing of Clip
// Factory's own (its Content Rewards banner) is drawn in Lamo Stories.

const CR_URL = (id: string) => `https://contentrewards.com/c/campaigns/${id}`;
const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";

async function on(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
  });
  // Calm motion: the switch goes the moment it is tapped (no slide to wait for), so it lands while the request runs.
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
}

/** Every answer of Clip Factory's (pretend) server takes this long from now on (undefined: as usual again). */
const slow = (page: Page, ms: number | undefined) =>
  page.evaluate((latencyMs) => {
    const w = window as unknown as { __cfMockFaults?: Record<string, unknown> };
    w.__cfMockFaults = { ...(w.__cfMockFaults ?? {}), latencyMs };
  }, ms);

const choice = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}") as { workspaceId?: string; lastClipsPath?: string });

test("Add campaign that answers while Lamo Stories is on screen: the owner stays there, and the campaign opens when he is back", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await settle(page);
  await page.getByLabel("YouTube, Twitch or Kick link").fill(CR_URL(FAZE));
  const add = page.getByRole("button", { name: "Add campaign" });
  await expect(add).toHaveClass(/btn--primary/);
  await slow(page, 2500);
  await add.click();
  // While it is still asking, over to Lamo Stories.
  await page.locator(".ws-dock").getByRole("link", { name: "Clip Stories" }).click();
  await expect(page).toHaveURL(/\/stories$/);
  await storiesReady(page);
  const entries = await page.evaluate((): number => window.history.length);
  const stored = await choice(page);
  expect(stored.workspaceId).toBe("stories");
  // The request answers (2.5 s) and well after: still Lamo Stories, its own history entry, the same stored choice.
  await page.waitForTimeout(3500);
  await expect(page).toHaveURL(/\/stories$/);
  expect(await page.evaluate((): number => window.history.length)).toBe(entries);
  expect(await choice(page)).toEqual(stored);
  await expect(page.locator(".stories-app")).toBeVisible();
  await expect(page.locator('[data-app-pane="clips"]')).toBeHidden();
  // Back to Clip Factory: the campaign it added opens now.
  await slow(page, undefined);
  await page.locator(".ws-dock").getByRole("link", { name: "Clip Factory", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${FAZE}$`));
  await expect(page.locator(".cr-head")).toContainText("FaZe Clips");
  expect((await choice(page)).workspaceId).toBe("clips");
});

test("a skill saved while Lamo Stories is on screen: no jump, no toast or sound over it, and its page opens when he is back", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/clip-making/skills/new");
  await settle(page);
  await page.getByLabel("What is the skill called?").fill("Kept apart");
  await page.getByLabel("When should Clip Factory use it?").fill("Every time it picks moments from my streams.");
  await page.getByLabel("What should it do?").fill("Pick the moments where the chat goes wild, and keep each clip under a minute.");
  await page.evaluate(() => {
    const w = window as unknown as { __cfSoundLog?: unknown[]; __toasts: string[] };
    w.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof HTMLElement) for (const t of [n, ...Array.from(n.querySelectorAll(".toast__text"))]) if (t.matches(".toast__text")) w.__toasts.push(t.textContent?.trim() ?? "");
    }).observe(document.body, { childList: true, subtree: true });
  });
  await slow(page, 2500);
  await page.getByRole("button", { name: "Save skill" }).click();
  await page.locator(".ws-dock").getByRole("link", { name: "Clip Stories" }).click();
  await expect(page).toHaveURL(/\/stories$/);
  await storiesReady(page);
  const stored = await choice(page);
  await page.evaluate(() => ((window as unknown as { __cfSoundLog?: unknown[] }).__cfSoundLog = []));
  await page.waitForTimeout(3500);
  // Still Lamo Stories: the skill editor's "replace" move never overwrote Lamo Stories' history entry.
  await expect(page).toHaveURL(/\/stories$/);
  expect(await choice(page)).toEqual(stored);
  // Clip Factory's "Your skill is ready" toast and its tap sound never played over Lamo Stories.
  expect(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).not.toContain("Your skill is ready. Clip Factory will use it every time.");
  const heard = await page.evaluate(() => ((window as unknown as { __cfSoundLog?: { muted: boolean }[] }).__cfSoundLog ?? []).filter((e) => !e.muted));
  expect(heard).toEqual([]);
  await expect(page.locator(".confetti")).toHaveCount(0);
  // Back: the skill's own page, in place of the editor.
  await slow(page, undefined);
  await page.locator(".ws-dock").getByRole("link", { name: "Clip Factory", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/clip-making\/skills\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Kept apart" })).toBeVisible();
});

test("Lamo Stories never draws Clip Factory's own Content Rewards banner, even in the Mac app", async ({ page }) => {
  await asMacWindow(page);
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories");
  await storiesReady(page);
  await expect(page.locator(".stories-app .cr-sendnow")).toHaveCount(0);
  // The shell's own parts are there once, outside both apps.
  await expect(page.locator(".ws-dock")).toHaveCount(1);
  await expect(page.locator(".stories-app .ws-dock, [data-app-pane] .ws-dock")).toHaveCount(0);
});
