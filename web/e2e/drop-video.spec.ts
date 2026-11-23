import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Drag a video or a link onto the new-job card on Home (docs/CONTRACTS.md §12.5): real dragenter/dragover/drop
// events carrying a DataTransfer, as a drag from Finder or a browser's address bar sends them.

type Payload = { files?: { name: string; type: string }[]; uri?: string; text?: string };

/** Fires one drag event on the element `selector` finds, with a fresh DataTransfer holding the payload. A file's
 * type may be "" (Finder sometimes gives none). `at` sets the pointer (inside the page unless given; a
 * leave out of the window is at 0,0). */
async function fire(
  page: Page,
  selector: string,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  payload: Payload,
  at?: { x: number; y: number },
) {
  return page.evaluate(
    ({ selector, type, payload, at }) => {
      const dt = new DataTransfer();
      for (const f of payload.files ?? []) dt.items.add(new File([new Uint8Array(2048)], f.name, { type: f.type }));
      if (payload.uri) dt.setData("text/uri-list", payload.uri);
      if (payload.text) dt.setData("text/plain", payload.text);
      const target = document.querySelector(selector)!;
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at?.x ?? 300, clientY: at?.y ?? 300 });
      target.dispatchEvent(e);
      return { taken: e.defaultPrevented, effect: dt.dropEffect };
    },
    { selector, type, payload, at },
  );
}

/** A whole drag: in, over, then dropped on the same element. */
async function dragDrop(page: Page, selector: string, payload: Payload) {
  await fire(page, selector, "dragenter", payload);
  await fire(page, selector, "dragover", payload);
  return (await fire(page, selector, "drop", payload)).taken;
}
/** The always-there status line a screen reader hears after a drop. */
const said = (page: Page) => page.locator("form.newjob p.sr-only[role=status]");
const MID = { x: 300, y: 300 };

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
  await expect(said(page)).toHaveText(`Video picked: ${VIDEO.name}. Then choose Make clips.`);
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

test("a drag that ends or leaves the window without the card hearing it still clears the highlight", async ({ page }) => {
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new DragEvent("dragend")));
  await expect(overlay(page)).toHaveCount(0);
  // Out of the window (Escape or off the edge): a leave at the edge with nothing to go to.
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toBeVisible();
  await fire(page, "body", "dragleave", { files: [VIDEO] }, { x: 0, y: 0 });
  await expect(overlay(page)).toHaveCount(0);
  // Into another part of the page.
  await fire(page, "form.newjob", "dragenter", { files: [VIDEO] });
  await fire(page, ".hero__side", "dragenter", { files: [VIDEO] });
  await expect(overlay(page)).toHaveCount(0);
});

test("holding still over the card, then moving across the fields, never drops the highlight", async ({ page }) => {
  const f = { files: [VIDEO] };
  await fire(page, "form.newjob", "dragenter", f, MID);
  await fire(page, "form.newjob textarea", "dragenter", f, MID);
  await fire(page, "form.newjob", "dragleave", f, MID);
  await page.waitForTimeout(1500);
  await expect(overlay(page)).toBeVisible();
  await fire(page, "form.newjob textarea", "dragover", f, MID);
  for (const [from, to] of [
    ["form.newjob textarea", "form.newjob .segmented"],
    ["form.newjob .segmented", "form.newjob .newjob__actions"],
    ["form.newjob .newjob__actions", "form.newjob textarea"],
  ] as const) {
    await fire(page, to, "dragenter", f, MID);
    await fire(page, from, "dragleave", f, MID);
    await fire(page, to, "dragover", f, MID);
    await expect(overlay(page)).toBeVisible();
  }
  await page.waitForTimeout(1500);
  await expect(overlay(page)).toBeVisible();
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
  await expect(page.locator(".field__status.is-bad")).toHaveText("That is not a video. Drop an MP4, MOV or WebM video.");
  await expect(page.getByRole("button", { name: "Make clips" })).toBeDisabled();
  expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toContain("deny");
  await expect(said(page)).toHaveText("That is not a video. Drop an MP4, MOV or WebM video.");
});

test("a dropped thing with no type and no video name (like a folder) is not a video", async ({ page }) => {
  await dragDrop(page, "form.newjob", { files: [{ name: "Stream clips", type: "" }] });
  await expect(page.locator(".field__status.is-bad")).toHaveText("That is not a video. Drop an MP4, MOV or WebM video.");
});

test("a .mov from Finder with no type is picked and uploads as a video", async ({ page }) => {
  await dragDrop(page, "form.newjob", { files: [{ name: "clip.mov", type: "" }] });
  await expect(page.locator(".dropzone.has-file")).toContainText("clip.mov");
  await page.getByRole("button", { name: "Make clips" }).click();
  // The mock refuses an upload whose type is not video/… (the exact video/quicktime is checked in drops.test.ts).
  await expect(page).toHaveURL(/\/jobs\//, { timeout: 15_000 });
});

test("a thumbnail dragged off a video page is taken as its link", async ({ page }) => {
  const uri = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const thumb = { files: [{ name: "hqdefault.jpg", type: "image/jpeg" }], uri };
  await fire(page, "form.newjob", "dragenter", thumb);
  await expect(overlay(page)).toHaveText("Drop it here");
  await fire(page, "form.newjob", "dragover", thumb);
  await fire(page, "form.newjob", "drop", thumb);
  await expect(sourceTab(page, "Paste a link")).toHaveClass(/is-on/);
  await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue(uri);
  await expect(page.getByText("That is not a video")).toHaveCount(0);
});

test("a uri-list with comments and several links takes the first link", async ({ page }) => {
  await dragDrop(page, "form.newjob .count-row", { uri: "# from the bar\r\nhttps://kick.com/video/abc\r\nhttps://www.twitch.tv/videos/2" });
  await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("https://kick.com/video/abc");
});

test("a link dragged into Notes goes into the note, not the link box", async ({ page }) => {
  const uri = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  await fire(page, "form.newjob textarea", "dragenter", { uri });
  await expect(overlay(page)).toHaveCount(0);
  const r = await fire(page, "form.newjob textarea", "drop", { uri, text: uri });
  // Not taken by the card: the text box does its own drop.
  expect(r.taken).toBe(false);
  await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("");
});

test("dragged text that is a link shows the link highlight away from the text boxes", async ({ page }) => {
  const text = "https://www.twitch.tv/videos/1";
  await fire(page, "form.newjob .count-row", "dragenter", { text });
  await expect(overlay(page)).toHaveText("Drop your link here");
  await fire(page, "form.newjob .count-row", "dragleave", { text });
  await fire(page, "form.newjob textarea", "dragenter", { text });
  await expect(overlay(page)).toHaveCount(0);
  await fire(page, "form.newjob textarea", "dragleave", { text });
  await dragDrop(page, "form.newjob .count-row", { text });
  await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue(text);
  await expect(said(page)).toHaveText("Link added. Twitch video found.");
});

test("while a job is starting, a drag says so and the drop is refused with plain words", async ({ page }) => {
  await dragDrop(page, "form.newjob", { files: [VIDEO] });
  await page.evaluate(() => {
    (window as unknown as { __cfMockFaults: { latencyMs: number } }).__cfMockFaults.latencyMs = 4000;
  });
  await page.getByRole("button", { name: "Make clips" }).click();
  // The upload bar and Cancel upload show from the tap; once the file is all up, the job is starting.
  await expect(page.locator("form.newjob")).toContainText("Uploading… 100%");
  const other = { files: [{ name: "other.mp4", type: "video/mp4" }] };
  await fire(page, "form.newjob", "dragenter", other);
  await expect(overlay(page)).toHaveText("Starting your job…");
  const over = await fire(page, "form.newjob", "dragover", other);
  expect(over).toEqual({ taken: true, effect: "none" });
  await fire(page, "form.newjob", "drop", other);
  await expect(page.getByText("Clip Factory is starting your job. Drop it again in a moment.")).toBeVisible();
  await expect(page.locator(".dropzone.has-file")).toContainText(VIDEO.name);
});

test("while the upload runs, a drop is refused and says to cancel first", async ({ page }) => {
  await dragDrop(page, "form.newjob", { files: [VIDEO] });
  await page.getByRole("button", { name: "Make clips" }).click();
  // In the page, so the drop lands inside the short mock upload: a MutationObserver sees "Uploading…" the moment
  // it shows (requestAnimationFrame can stall in a headless WebKit).
  const toast = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const form = document.querySelector("form.newjob")!;
        let done = false;
        const tryDrop = () => {
          if (done || !form.textContent?.includes("Uploading…")) return;
          done = true;
          obs.disconnect();
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(8)], "other.mp4", { type: "video/mp4" }));
          form.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
          form.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
          resolve(true);
        };
        const obs = new MutationObserver(tryDrop);
        obs.observe(form, { subtree: true, childList: true, characterData: true });
        tryDrop();
        setTimeout(() => {
          obs.disconnect();
          if (!done) resolve(false);
        }, 15_000);
      }),
  );
  expect(toast).toBe(true);
  await expect(page.getByText("The upload is still running. Cancel it first, then drop again.")).toBeVisible();
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
  await expect(page.locator(".field__status.is-ok")).toHaveText("YouTube video found.");
  await expect(said(page)).toHaveText("Link added. YouTube video found.");
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

// Screenshots of the highlight for a look (not a check): CF_DROP_SHOTS=<dir>. The app has one (dark) theme, so the
// light and dark shots should match; both are kept to show that a light system setting changes nothing.
const shots = process.env.CF_DROP_SHOTS;
const SIZES = [
  { width: 1000, height: 650, phone: false },
  { width: 1440, height: 900, phone: false },
  { width: 1024, height: 768, phone: false },
  { width: 768, height: 1024, phone: false },
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
