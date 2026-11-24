import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Home's make-clips form and the job page, kid-proof: a double tap never undoes itself, leaving during an upload asks
// first, what is on screen is what the job gets, a finished upload is never sent twice, the main button is never left
// under the phone's tab bar, and an unsent draft survives a trip to Jobs.

const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
type MockWin = Window & { __cfMockFaults: { latencyMs?: number; createJobFails?: number }; __cfMockCalls: Record<string, number> };

const nav = (page: Page) => page.locator("nav.tabbar, nav.sidebar").filter({ visible: true });
const form = (page: Page) => page.locator("form.newjob");
const linkBox = (page: Page) => page.getByLabel("YouTube, Twitch or Kick link");
const calls = (page: Page, method: string) => page.evaluate((m) => (window as unknown as MockWin).__cfMockCalls[m] ?? 0, method);
/** Every mock answer takes `ms` (createUpload too, so "Uploading…" stays up that long before the file goes). */
const slow = (page: Page, ms: number) => page.evaluate((v) => ((window as unknown as MockWin).__cfMockFaults.latencyMs = v), ms);
/** True when the page asks before a reload or closing the tab. */
const asksOnUnload = (page: Page) =>
  page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

async function pickVideo(page: Page, name = "clip.mp4") {
  await page.getByRole("radio", { name: "Pick a video" }).check({ force: true });
  await form(page).locator('input[type="file"]').setInputFiles({ name, mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
  await expect(form(page)).toContainText(name);
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });

  test("a double tap on Paste keeps the link, and a double tap on Clear leaves the box empty", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.evaluate((t) => navigator.clipboard.writeText(t), VIDEO);
    const paste = form(page).getByRole("button", { name: "Paste", exact: true });
    const p = (await paste.boundingBox())!;
    await page.mouse.click(p.x + p.width / 2, p.y + p.height / 2);
    await expect(linkBox(page)).toHaveValue(VIDEO);
    // The second tap of the double tap lands where Clear has just appeared.
    const clear = form(page).getByRole("button", { name: "Clear link" });
    const c = (await clear.boundingBox())!;
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    // Then Make clips comes into view (the page may scroll once the double tap is over).
    await page.waitForTimeout(1000);
    await expect(linkBox(page)).toHaveValue(VIDEO);

    // A double tap on Clear: the second tap lands on the Paste that took its place.
    const c2 = (await clear.boundingBox())!;
    await page.mouse.click(c2.x + c2.width / 2, c2.y + c2.height / 2);
    await expect(linkBox(page)).toHaveValue("");
    await page.mouse.click(c2.x + c2.width / 2, c2.y + c2.height / 2);
    await page.waitForTimeout(500);
    await expect(linkBox(page)).toHaveValue("");
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    test(`a good link brings Make clips above the tab bar (${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await settle(page);
      await page.evaluate((t) => navigator.clipboard.writeText(t), VIDEO);
      await form(page).getByRole("button", { name: "Paste", exact: true }).click();
      await expect(page.getByText("YouTube video found.")).toBeVisible();
      const make = form(page).getByRole("button", { name: "Make clips", exact: true });
      const bar = page.locator("nav.tabbar");
      await expect
        .poll(async () => {
          const b = (await make.boundingBox())!;
          const t = (await bar.boundingBox())!;
          return b.y >= 0 && b.y + b.height <= t.y;
        })
        .toBe(true);
    });
  }

  for (const width of [360, 375, 390, 393]) {
    test(`"Pick for me (5–10)" never breaks inside its range at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await settle(page);
      const together = await page.evaluate(() => {
        const opt = [...document.querySelectorAll(".count-row .segmented__opt")].find((o) => o.textContent?.includes("Pick for me"))!;
        const walk = document.createTreeWalker(opt, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walk.nextNode()) && !node.textContent?.includes("–"));
        const at = node!.textContent!.indexOf("–");
        const top = (from: number) => {
          const r = document.createRange();
          r.setStart(node!, from);
          r.setEnd(node!, from + 1);
          return r.getBoundingClientRect().top;
        };
        return Math.abs(top(at - 1) - top(at + 1)) < 2;
      });
      expect(together).toBe(true);
    });
  }
});

test("leaving Home while a video uploads asks first: Stay keeps it going, and a reload asks too", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await pickVideo(page);
  expect(await asksOnUnload(page)).toBe(false);
  await slow(page, 3000);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(form(page)).toContainText(/Uploading… \d+%/);
  expect(await asksOnUnload(page)).toBe(true);
  await nav(page).locator('a[href="/jobs"]').first().click();
  const sheet = page.getByRole("dialog", { name: "Leave and stop the upload?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Stay" })).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await sheet.getByRole("button", { name: "Stay" }).click();
  await expect(sheet).toBeHidden();
  // The upload went on: the job page opens by itself, and nothing asks any more.
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("clip.mp4");
  expect(await asksOnUnload(page)).toBe(false);
});

test("Leave in the question stops the upload and goes where the owner tapped", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await pickVideo(page);
  await slow(page, 3000);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(form(page)).toContainText(/Uploading… \d+%/);
  await nav(page).locator('a[href="/jobs"]').first().click();
  await page.getByRole("dialog", { name: "Leave and stop the upload?" }).getByRole("button", { name: "Leave" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.locator(".toast", { hasText: "Upload stopped" })).toBeVisible();
  await page.waitForTimeout(4000);
  expect(await calls(page, "createJob")).toBe(0);
  await expect(page).toHaveURL(/\/jobs$/);
});

test("the clip count and notes changed while the file goes up are the ones the job gets", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await pickVideo(page);
  await slow(page, 1500);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(form(page)).toContainText(/Uploading… \d+%/);
  await page.getByRole("radio", { name: "Exactly" }).check({ force: true });
  await page.getByLabel(/Notes for Clip Factory/).fill("Say hi to Marco");
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  await expect(page.getByText("aiming for 6 clips")).toBeVisible();
  await expect(page.locator(".source-card__notes")).toContainText("Say hi to Marco");
});

test("while the file goes up the video box can't change, says why, and the job is made from that file", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await pickVideo(page, "clip.mp4");
  await slow(page, 1500);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(form(page)).toContainText(/Uploading… \d+%/);
  await expect(form(page).locator('input[type="file"]')).toBeDisabled();
  // The box's own file input is off, so the tap reaches only the box (force: Playwright calls such a label disabled).
  await form(page).locator(".dropzone").click({ force: true });
  await expect(page.locator(".toast", { hasText: "The upload is still running. Tap Cancel upload first." })).toBeVisible();
  await expect(form(page).locator(".dropzone")).toContainText("clip.mp4");
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("clip.mp4");
});

test("a Make clips that fails after the upload keeps the upload: trying again only makes the job", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => ((window as unknown as MockWin).__cfMockFaults.createJobFails = 1));
  await pickVideo(page);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(page.locator(".toast--error")).toContainText("Something went wrong on our side");
  expect(await calls(page, "createUpload")).toBe(1);
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  expect(await calls(page, "createUpload")).toBe(1);
  expect(await calls(page, "createJob")).toBe(2);
});

test("a typed link, the clip count and notes are still there after a trip to Jobs", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await linkBox(page).fill(VIDEO);
  await page.getByRole("radio", { name: "Exactly" }).check({ force: true });
  await page.getByLabel(/Notes for Clip Factory/).fill("Say hi to Marco");
  await nav(page).locator('a[href="/jobs"]').first().click();
  await settle(page);
  await page.goBack();
  await settle(page);
  await expect(linkBox(page)).toHaveValue(VIDEO);
  await expect(page.getByRole("radio", { name: "Exactly" })).toBeChecked();
  await expect(page.getByLabel(/Notes for Clip Factory/)).toHaveValue("Say hi to Marco");
  // Once the job started, Home is fresh again.
  await form(page).getByRole("button", { name: "Make clips" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await nav(page).locator('a[href="/"]').first().click();
  await settle(page);
  await expect(linkBox(page)).toHaveValue("");
  await expect(page.getByLabel(/Notes for Clip Factory/)).toHaveValue("");
});

test("on a computer, Paste without clipboard access names the keys, not press and hold", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await form(page).getByRole("button", { name: "Paste", exact: true }).click();
  await expect(page.locator(".toast")).toContainText(/Click in the box and press (⌘V|Ctrl\+V)\./);
  await expect(page.locator(".toast")).not.toContainText("Press and hold");
});

test("Stop job hands the focus to its Stopping note, not to the page", async ({ page }) => {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Ranked grind" }).click();
  await settle(page);
  await page.getByRole("button", { name: "Stop job" }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".panel__actions .panel__note")).toBeFocused();
});
