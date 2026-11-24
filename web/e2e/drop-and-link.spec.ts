import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Drag and drop to upload everywhere, and "paste a link" instead of uploading (docs/CONTRACTS.md §45.40, §12.5), in
// mock mode. The drags are real dragenter/dragover/drop events carrying a DataTransfer, as a drag from Finder or a
// browser sends them; a paste is a paste event carrying the clipboard's data.
// * The window's guard: opened straight into Clips Funded (no Clip Factory shell, so no Ask guard), a stray file
//   never replaces the app and a stray link never navigates.
// * Clips Funded › References: a video dropped anywhere on the page starts its upload; a wrong file is refused with
//   one short line; a dropped link fills the box; a pasted YouTube link, then Add, is a row "Getting it…" that becomes
//   its own page and then studies ("Analyzing…"); a blocked link (the metadata address, a site that isn't allowed)
//   says why in kid words and can't be added; a link whose video did not arrive says why and Try again gets it;
//   keyboard upload still works; Ask's own drops stay Ask's; and with Clips Funded kept behind Clip Factory, nothing
//   dropped there becomes a reference.
// * A picture dropped on a picture upload (Clip Factory › Settings › Background picture) is set.
// Tests with "desktop" in their name are left out of the iPhone run (playwright.config.ts, webkit-phone).

type DropFile = { name: string; type: string; base64?: string };
type Payload = { files?: DropFile[]; uri?: string; text?: string };
type StoriesWindow = Window & { __cfStoriesMock?: { store?: { knobs: Record<string, unknown>; references: { refId: string; title: string; status: string; link?: string | null }[] } } };

const TIKTOK = "https://www.tiktok.com/@lamo/video/7300000000000000001";
const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO: DropFile = { name: "kai_dance.mp4", type: "video/mp4" };
const PICTURE: DropFile = { name: "shot.png", type: "image/png" };
/** A real 1×1 PNG, for the drops that open the picture. */
const PNG: DropFile = { name: "sky.png", type: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };

/** Fires one drag event on what `selector` finds, with a fresh DataTransfer: whether the page took it. (Chromium
 * keeps a made-up DataTransfer's dropEffect at "none" whatever a handler sets, so the effect each zone and the guard
 * set is checked in test/useFileDrop.test.tsx and test/dropGuard.test.ts.) */
async function fire(page: Page, selector: string, type: "dragenter" | "dragover" | "dragleave" | "drop", payload: Payload) {
  return page.evaluate(
    ({ selector, type, payload }) => {
      const dt = new DataTransfer();
      for (const f of payload.files ?? []) {
        const bytes = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : new Uint8Array(2048);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (payload.uri) dt.setData("text/uri-list", payload.uri);
      if (payload.text) dt.setData("text/plain", payload.text);
      const target = document.querySelector(selector)!;
      const box = target.getBoundingClientRect();
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.x + box.width / 2, clientY: box.y + Math.min(box.height / 2, 40) });
      target.dispatchEvent(e);
      return { taken: e.defaultPrevented };
    },
    { selector, type, payload },
  );
}

/** A whole drag: in, over, then dropped on the same element. Answers whether the drop was taken. */
async function dragDrop(page: Page, selector: string, payload: Payload) {
  await fire(page, selector, "dragenter", payload);
  await fire(page, selector, "dragover", payload);
  return (await fire(page, selector, "drop", payload)).taken;
}

/** A paste of this text on what `selector` finds (the clipboard's data as a paste event carries it). */
async function paste(page: Page, selector: string, text: string) {
  return page.evaluate(
    ({ selector, text }) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", { value: dt });
      document.querySelector(selector)!.dispatchEvent(e);
      return e.defaultPrevented;
    },
    { selector, text },
  );
}

async function knobs(page: Page, set: Record<string, unknown>) {
  await page.evaluate((k) => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store) Object.assign(store.knobs, k);
  }, set);
}

const references = (page: Page) => page.evaluate(() => ((window as StoriesWindow).__cfStoriesMock?.store?.references ?? []).map((r) => ({ ...r })));

/** Clips Funded switched on, its References page open with its list in. */
async function openReferences(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stories/references");
  await page.locator(".st-refs .st-ref-link__input").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"), undefined, { timeout: 20_000 });
  await page.waitForTimeout(300);
}

const box = (page: Page) => page.locator(".st-ref-link__input");
const line = (page: Page) => page.locator(".st-ref-line");
const add = (page: Page) => page.getByRole("button", { name: "Add", exact: true });
const layer = (page: Page) => page.locator(".stories-app .drop-layer.st-drop");
const REF_PAGE = /\/stories\/references\/[0-9A-Z]{26}$/;

test.describe("the window's drop guard (desktop)", () => {
  async function openStories(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories");
    await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
    await expect(page.locator(".st-rail")).toBeVisible();
  }

  test("opened straight into Clips Funded, a file dropped on the rail never replaces the app", async ({ page }) => {
    await openStories(page);
    const url = page.url();
    await fire(page, ".st-rail", "dragenter", { files: [VIDEO] });
    // The guard took it: the browser never opens the file in place of the app.
    expect((await fire(page, ".st-rail", "dragover", { files: [VIDEO] })).taken).toBe(true);
    expect((await fire(page, ".st-rail", "drop", { files: [VIDEO] })).taken).toBe(true);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await expect(page.locator(".stories-app[data-ws]")).toBeVisible();
  });

  test("opened straight into Clips Funded, a link dropped on the rail never navigates", async ({ page }) => {
    await openStories(page);
    const url = page.url();
    const link = { uri: YOUTUBE, text: YOUTUBE };
    expect((await fire(page, ".st-rail", "dragover", link)).taken).toBe(true);
    expect((await fire(page, ".st-rail", "drop", link)).taken).toBe(true);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await expect(page.locator(".stories-app[data-ws]")).toBeVisible();
  });
});

test("a video dropped on the References page off the card starts its upload and opens its page (desktop)", async ({ page }) => {
  test.setTimeout(60_000);
  await openReferences(page);
  // While it is over the page: the glass "Drop your video here", over the whole window.
  await fire(page, ".st-chat-head", "dragenter", { files: [VIDEO] });
  await expect(layer(page)).toBeVisible();
  await expect(layer(page)).toHaveText("Drop your video here");
  await expect(layer(page)).toHaveClass(/drop-layer--page/);
  expect((await fire(page, ".st-chat-head", "dragover", { files: [VIDEO] })).taken).toBe(true);
  expect((await fire(page, ".st-chat-head", "drop", { files: [VIDEO] })).taken).toBe(true);
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveURL(REF_PAGE, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "kai dance" })).toBeVisible();
  expect((await references(page)).some((r) => r.title === "kai dance")).toBe(true);
});

test("a wrong file dropped on References is refused with one short line, and nothing is sent (desktop)", async ({ page }) => {
  await openReferences(page);
  const before = (await references(page)).length;
  expect(await dragDrop(page, ".st-ref-grid", { files: [PICTURE] })).toBe(true);
  await expect(page.locator(".stories-app .drop-layer.is-refused")).toHaveText("Pick an MP4 or MOV video.");
  // Screen readers hear it too.
  await expect(page.locator(".stories-app > span.sr-only[role=status]", { hasText: "Pick an MP4 or MOV video." })).toHaveCount(1);
  await expect(page.locator(".st-ref-upload")).toHaveCount(0);
  expect((await references(page)).length).toBe(before);
});

test("a link dropped on References fills the box, and Add is next (desktop)", async ({ page }) => {
  await openReferences(page);
  await fire(page, ".st-ref-grid", "dragenter", { uri: TIKTOK });
  await expect(layer(page)).toHaveText("Drop the link here");
  await fire(page, ".st-ref-grid", "dragover", { uri: TIKTOK });
  expect((await fire(page, ".st-ref-grid", "drop", { uri: TIKTOK })).taken).toBe(true);
  await expect(box(page)).toHaveValue(TIKTOK);
  await expect(line(page)).toHaveText("TikTok video found.");
  await expect(add(page)).toBeFocused();
  // Never added by itself, and nothing navigated away: a dropped link never opens.
  expect((await references(page)).some((r) => r.link === TIKTOK)).toBe(false);
  await expect(page).toHaveURL(/\/stories\/references$/);
});

test("a pasted YouTube link, then Add: Getting it…, then its own page, then Analyzing…", async ({ page }) => {
  test.setTimeout(60_000);
  await openReferences(page);
  await knobs(page, { refFetchSeconds: 1, refSeconds: 60 });
  // Pasted with nothing focused (share text and all): the box takes the link, and nothing is added yet.
  expect(await paste(page, ".st-chat-head", `Look at this one! ${YOUTUBE}&t=42s`)).toBe(true);
  await expect(box(page)).toHaveValue(`${YOUTUBE}&t=42s`);
  await expect(line(page)).toHaveText("YouTube video found.");
  await expect(add(page)).toBeFocused();
  await add(page).click();
  const row = page.locator(".st-ref-card").first();
  await expect(row).toContainText("YouTube video");
  await expect(row).toContainText("Getting it…");
  await expect(row).toContainText("From YouTube");
  await expect(box(page)).toHaveValue("");
  expect((await references(page)).find((r) => r.link === YOUTUBE)?.status).toBe("fetching");
  // It arrives: its own page opens, ready to study.
  await expect(page).toHaveURL(REF_PAGE, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "YouTube video" })).toBeVisible();
  await page.getByRole("button", { name: "Analyze it" }).click();
  await expect(page.getByRole("heading", { name: "Analyzing…" })).toBeVisible({ timeout: 10_000 });
  expect((await references(page)).find((r) => r.link === YOUTUBE)?.status).toBe("analyzing");
});

test("a blocked link says why in kid words and can't be added", async ({ page }) => {
  await openReferences(page);
  const before = (await references(page)).length;
  const blocked: [string, string][] = [
    ["ftp://169.254.169.254/latest/meta-data/", "That isn't a link. Copy the video's link, then paste it here."],
    ["http://169.254.169.254/latest/meta-data/", "We can't get videos from that site. Save the video, then upload it."],
    ["https://169.254.169.254/latest/meta-data/", "We can't get videos from that site. Save the video, then upload it."],
    ["https://vimeo.com/123456789", "We can't get videos from that site. Save the video, then upload it."],
    ["https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "We can't get videos from that site. Save the video, then upload it."],
    ["https://www.tiktok.com/@lamo", "That link isn't one video. Open the video, tap Share, then Copy link."],
  ];
  for (const [link, why] of blocked) {
    await box(page).fill(link);
    // Never judged letter by letter: the reason shows once Enter is pressed (or the box is left).
    await expect(line(page)).toHaveText("");
    await box(page).press("Enter");
    await expect(line(page)).toHaveText(why);
    await expect(add(page)).toHaveCount(0);
  }
  // A pasted one fills the box the same way, and is refused the same way.
  await box(page).fill("");
  expect(await paste(page, ".st-chat-head", "http://169.254.169.254/latest/meta-data/")).toBe(true);
  await expect(line(page)).toHaveText("We can't get videos from that site. Save the video, then upload it.");
  await expect(add(page)).toHaveCount(0);
  // Enter on each of them sent nothing either (the API refuses the same links: api/tests/test_ws_ref_links.py).
  await page.waitForTimeout(300);
  expect((await references(page)).length).toBe(before);
});

test("a link whose video did not arrive opens its page, which says why, and Try again gets it (desktop)", async ({ page }) => {
  test.setTimeout(60_000);
  const sorry = "YouTube didn't let us get it. Save the video, then upload it.";
  await openReferences(page);
  await knobs(page, { refFetchSeconds: 0.5, refFetchFail: sorry });
  await box(page).fill("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  await expect(line(page)).toHaveText("YouTube video found.");
  await add(page).click();
  const row = page.locator(".st-ref-card", { hasText: "YouTube video" });
  await expect(row).toContainText("Getting it…");
  // Its own page opens by itself (never a coral chip alone), with the reason and one main button.
  await expect(page).toHaveURL(REF_PAGE, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "It didn't arrive" })).toBeVisible();
  await expect(page.locator(".st-ref-fetch .st-ref-failed")).toHaveText(sorry);
  // Blocked: asking again may not help, so Upload a video is the main button and Try again stays beside it.
  await expect(page.locator(".st-ref-fetch .st-chat-btn--main")).toHaveText("Upload a video");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Getting it from YouTube…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze it" })).toBeVisible({ timeout: 20_000 });
});

test("keyboard upload still works on References: Tab to Upload a video, Enter, pick the file (desktop)", async ({ page }) => {
  test.setTimeout(60_000);
  await openReferences(page);
  const upload = page.getByRole("button", { name: "Upload a video" });
  await box(page).focus();
  for (let i = 0; i < 4 && !(await upload.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(upload).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "snow_day.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(400_000, 7) });
  await expect(page).toHaveURL(REF_PAGE, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "snow day" })).toBeVisible();
});

test("a picture dropped on Clip Factory's background picture card is set (desktop)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings/look-and-feel/background");
  await settle(page);
  const card = ".bg-picker";
  await page.locator(card).scrollIntoViewIfNeeded();
  // Nothing shows at rest.
  await expect(page.locator(`${card} .drop-layer`)).toHaveCount(0);
  await fire(page, card, "dragenter", { files: [PNG] });
  await expect(page.locator(`${card} .drop-layer.drop-layer--clips`)).toHaveText("Drop it here");
  // A file that is no picture: its own line, and nothing set.
  await fire(page, card, "drop", { files: [VIDEO] });
  await expect(page.locator(`${card} .drop-layer.is-refused`)).toHaveText("That is not a picture. Tap Choose a picture and pick a JPG or PNG.");
  expect(await dragDrop(page, card, { files: [PNG] })).toBe(true);
  await expect(page.getByText("Background set on this device.")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#background-picture").getByText("In use", { exact: true })).toBeVisible();
});

/** Clip Factory first, then Clips Funded › References by the switch: Clip Factory stays mounted behind it. */
async function bothApps(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await settle(page);
  await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.evaluate(() => {
    history.pushState({}, "", "/stories/references");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.locator(".st-refs .st-ref-link__input").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"), undefined, { timeout: 20_000 });
}

test("a picture dropped on Ask's launcher while on References is never a reference (desktop)", async ({ page }) => {
  await bothApps(page);
  await expect(page.locator(".help-launcher")).toHaveCount(1);
  const before = (await references(page)).length;
  await dragDrop(page, ".help-launcher", { files: [PICTURE] });
  // References neither took it nor refused it: Ask's own drop is Ask's.
  await expect(page.locator(".stories-app .drop-layer")).toHaveCount(0);
  await expect(page.locator(".st-ref-upload")).toHaveCount(0);
  expect((await references(page)).length).toBe(before);
  // The page's own drop is on all the while: the same picture dropped on the list is refused there.
  expect(await dragDrop(page, ".st-ref-grid", { files: [PICTURE] })).toBe(true);
  await expect(page.locator(".stories-app .drop-layer.is-refused")).toHaveText("Pick an MP4 or MOV video.");
});

test("with Clips Funded kept behind a Clip Factory page, nothing dropped there becomes a reference (desktop)", async ({ page }) => {
  await bothApps(page);
  const before = (await references(page)).length;
  // On screen, the page takes drops: a drag over it shows the layer.
  await fire(page, ".st-chat-head", "dragenter", { files: [VIDEO] });
  await expect(layer(page)).toHaveText("Drop your video here");
  await fire(page, ".st-chat-head", "drop", { files: [PICTURE] });
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
  await settle(page);
  await expect(page.locator('[data-app-pane="stories"]')).toHaveAttribute("inert", "");
  await dragDrop(page, ".ws-dock", { files: [VIDEO] });
  await dragDrop(page, ".ws-dock", { uri: TIKTOK });
  await page.waitForTimeout(600);
  expect((await references(page)).length).toBe(before);
  // Back in Clips Funded: no upload started, and the box is still empty.
  await page.locator(".ws-dock .ws-switch__opt", { hasText: "Clips Funded" }).click();
  await expect(box(page)).toBeVisible();
  await expect(page.locator(".st-ref-upload")).toHaveCount(0);
  await expect(box(page)).toHaveValue("");
});
