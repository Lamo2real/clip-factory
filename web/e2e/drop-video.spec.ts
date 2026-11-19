import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Drag a video or a link onto the new-job card on Home (docs/CONTRACTS.md §12.4): real dragenter/dragover/drop
// events carrying a DataTransfer, as a drag from Finder or a browser's address bar sends them.

type Payload = { files?: { name: string; type: string }[]; uri?: string; text?: string };

/** Fires one drag event on the element `selector` finds, with a fresh DataTransfer holding the payload. */
async function fire(page: Page, selector: string, type: "dragenter" | "dragover" | "dragleave" | "drop", payload: Payload) {
  return page.evaluate(
    ({ selector, type, payload }) => {
      const dt = new DataTransfer();
      for (const f of payload.files ?? []) dt.items.add(new File([new Uint8Array(2048)], f.name, { type: f.type }));
      if (payload.uri) dt.setData("text/uri-list", payload.uri);
      if (payload.text) dt.setData("text/plain", payload.text);
      const target = document.querySelector(selector)!;
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    },
    { selector, type, payload },
  );
}

/** A whole drag: in, over, then dropped on the same element. */
async function dragDrop(page: Page, selector: string, payload: Payload) {
  await fire(page, selector, "dragenter", payload);
  await fire(page, selector, "dragover", payload);
  return fire(page, selector, "drop", payload);
}

const VIDEO = { name: "Kai Cenat Scammed Me!.mp4", type: "video/mp4" };
const overlay = (page: Page) => page.locator(".newjob__drop");
const sourceTab = (page: Page, name: string) => page.locator(".newjob .segmented__opt", { hasText: name });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await settle(page);
});

test("a video dropped on the file box is picked like the file picker", async ({ page }) => {
  await sourceTab(page, "Pick a video").click();
  await expect(page.locator(".dropzone")).toBeVisible();
  const taken = await dragDrop(page, ".dropzone", { files: [VIDEO] });
  expect(taken).toBe(true);
  await expect(page.locator(".dropzone.has-file")).toContainText(VIDEO.name);
  await expect(overlay(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make clips" })).toBeEnabled();
});

test("dragging files over the card shows one soft highlight that goes on leave, without flicker", async ({ page }) => {
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toHaveText("Drop your video here");
  // Moving onto a field inside the card: enter the child first, then leave the card; the highlight stays.
  await fire(page, "form.newjob textarea", "dragenter", { files: [VIDEO] });
  await fire(page, "form.newjob", "dragleave", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  // Leaving the last one: it goes.
  await fire(page, "form.newjob textarea", "dragleave", { files: [VIDEO] });
  await expect(overlay(page)).toHaveCount(0);
  // The Ask button does not glow for a drag over the card.
  await expect(page.locator(".help-launcher.is-drop")).toHaveCount(0);
});

test("a drag that ends without a leave (Escape) still clears the highlight", async ({ page }) => {
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend")));
  await expect(overlay(page)).toHaveCount(0);
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  // No dragover for a while: the drag is gone.
  await expect(overlay(page)).toHaveCount(0, { timeout: 3000 });
});

test("a video dropped anywhere on the card while Paste a link is on switches to Pick a video", async ({ page }) => {
  await expect(sourceTab(page, "Paste a link")).toHaveClass(/is-on/);
  await dragDrop(page, "form.newjob textarea", { files: [VIDEO] });
  await expect(sourceTab(page, "Pick a video")).toHaveClass(/is-on/);
  await expect(page.locator(".dropzone.has-file")).toContainText(VIDEO.name);
  await expect(page.locator("form.newjob textarea")).toHaveValue("");
});

test("several files: the first video is taken and the toast says one per job", async ({ page }) => {
  await dragDrop(page, "form.newjob", {
    files: [{ name: "cover.png", type: "image/png" }, VIDEO, { name: "second.mov", type: "video/quicktime" }],
  });
  await expect(page.locator(".dropzone.has-file")).toContainText(VIDEO.name);
  await expect(page.getByText(`One video per job. Clip Factory took ${VIDEO.name}.`)).toBeVisible();
});

test("a file that is not a video says so in plain words", async ({ page }) => {
  await page.evaluate(() => (window.__cfSoundLog = []));
  await dragDrop(page, "form.newjob", { files: [{ name: "notes.txt", type: "text/plain" }] });
  await expect(sourceTab(page, "Pick a video")).toHaveClass(/is-on/);
  await expect(page.locator(".dropzone.is-bad")).toBeVisible();
  await expect(page.getByText("That is not a video. Drop an MP4, MOV or WebM video.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make clips" })).toBeDisabled();
  expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toContain("deny");
});

test("a link dragged from a browser switches to Paste a link and is checked", async ({ page }) => {
  await sourceTab(page, "Pick a video").click();
  await fire(page, "form.newjob", "dragenter", { uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await expect(overlay(page)).toHaveText("Drop your link here");
  await fire(page, ".dropzone", "dragover", { uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await fire(page, ".dropzone", "drop", { uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await expect(overlay(page)).toHaveCount(0);
  await expect(sourceTab(page, "Paste a link")).toHaveClass(/is-on/);
  await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(page.getByText("YouTube video found.")).toBeVisible();
});

test("a file dropped outside the card is still refused, and never replaces the app", async ({ page }) => {
  const taken = await dragDrop(page, ".hero__side", { files: [VIDEO] });
  // The window guard takes it (prevents the default) but nothing is picked.
  expect(taken).toBe(true);
  await expect(page).toHaveURL(/\/$/);
  await expect(sourceTab(page, "Paste a link")).toHaveClass(/is-on/);
});

test("Use a video file from a failed job takes a drop the same way", async ({ page }) => {
  await page.goto("/?file=1&from=job_1");
  await settle(page);
  await expect(page.getByText("Tap to choose a video")).toBeVisible();
  await dragDrop(page, ".dropzone", { files: [VIDEO] });
  await expect(page.locator(".dropzone.has-file")).toContainText(VIDEO.name);
});

test("the file box stays a labelled file input for keyboards and screen readers", async ({ page }) => {
  await sourceTab(page, "Pick a video").click();
  const input = page.getByLabel("Video file");
  await expect(input).toHaveAttribute("type", "file");
  await input.setInputFiles({ name: "clip.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(1024) });
  await expect(page.locator(".dropzone.has-file")).toContainText("clip.mov");
});

// Screenshots of the highlight for a look (not a check): CF_DROP_SHOTS=<dir>.
const shots = process.env.CF_DROP_SHOTS;
const SIZES = [
  { width: 1000, height: 650, phone: false },
  { width: 1440, height: 900, phone: false },
  { width: 390, height: 844, phone: true },
];
for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`drop highlight ${size.width}x${size.height} ${scheme}`, () => {
      test.skip(!shots, "screenshots only with CF_DROP_SHOTS");
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: size.phone ? 2 : 1 });
      test(`screenshot drop highlight ${size.width}x${size.height} ${scheme}`, async ({ page }) => {
        mkdirSync(shots!, { recursive: true });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("form.newjob").scrollIntoViewIfNeeded();
        const name = `${size.width}x${size.height}-${scheme}`;
        await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
        await expect(overlay(page)).toBeVisible();
        await page.screenshot({ path: join(shots!, `drag-video-${name}.png`) });
        await fire(page, "form.newjob", "drop", { files: [VIDEO] });
        await expect(page.locator(".dropzone.has-file")).toBeVisible();
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(shots!, `dropped-${name}.png`) });
        await fire(page, "form.newjob", "dragenter", { uri: "https://www.twitch.tv/videos/1" });
        await expect(overlay(page)).toHaveText("Drop your link here");
        await page.screenshot({ path: join(shots!, `drag-link-${name}.png`) });
      });
    });
  }
}
