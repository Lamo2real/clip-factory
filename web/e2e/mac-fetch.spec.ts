import { expect, test } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle } from "./helpers.ts";

// Mac fetches it (docs/CONTRACTS.md §35): in the desktop window a YouTube link goes to this computer from the start.
// A pretend app stands in for window.__CF_MAC_FETCH__ (desktop/src-tauri/src/init.js): it downloads in a few steps,
// sends, and the job goes on as an upload. The browser (no app) never sees the waiting card for a cloud job.
test("in the desktop window a YouTube job is fetched by the Mac and goes on", async ({ page }) => {
  await asMacWindow(page);
  await page.addInitScript(() => {
    const calls: string[] = [];
    let step = 0;
    const script = [
      { phase: "tools", pct: 0 },
      { phase: "getting", pct: 42 },
      { phase: "getting", pct: 90 },
      { phase: "ready", pct: 100, size: 1000, title: "Me at the zoo", creator: "jawed", durationSec: 19 },
      { phase: "sending", pct: 63 },
      { phase: "sent", pct: 100, size: 1000, title: "Me at the zoo", creator: "jawed", durationSec: 19, etags: [{ n: 1, etag: '"e1"' }] },
    ];
    const at = () => script[Math.min(step, script.length - 1)];
    const w = window as unknown as Record<string, unknown>;
    w.__macCalls = calls;
    w.__CF_MAC_FETCH__ = {
      version: 1,
      start: async (jobId: string, url: string) => {
        calls.push(`start ${url}`);
        return at();
      },
      status: async () => {
        if (!calls.some((c) => c.startsWith("start"))) return null;
        // One step every few looks, so the page has time to show each phase.
        step += 0.25;
        return script[Math.min(Math.floor(step), script.length - 1)];
      },
      upload: async (_jobId: string, partSize: number, parts: unknown[]) => {
        calls.push(`upload ${partSize} ${parts.length}`);
        step = 4;
        return at();
      },
      cancel: async () => {
        calls.push("cancel");
        return true;
      },
    };
  });
  await page.goto("/");
  await settle(page);
  await page.getByLabel("YouTube, Twitch or Kick link").fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText("YouTube video found.")).toBeVisible();
  await page.getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(page.locator(".mac-wait")).toContainText(/Waiting for your Mac to get the video|Your Mac is getting the video/);
  await expect(page.locator(".mac-wait")).not.toContainText("Open Clip Factory on your Mac");
  const macCalls = () => page.evaluate(() => (window as unknown as { __macCalls: string[] }).__macCalls);
  await expect.poll(macCalls, { timeout: 30_000 }).toContain("cancel");
  // The job goes on as an upload of the Mac's video: the waiting card is gone.
  await expect(page.locator(".mac-wait")).toHaveCount(0);
  const calls = await macCalls();
  expect(calls[0]).toBe("start https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  expect(calls).toContain("upload 67108864 1");
  expect(calls.at(-1)).toBe("cancel");
});

test("in a browser a YouTube job tries the cloud and shows no Mac card", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.getByLabel("YouTube, Twitch or Kick link").fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(page.locator(".timeline__step")).toHaveCount(10);
  await expect(page.locator(".mac-wait")).toHaveCount(0);
});
