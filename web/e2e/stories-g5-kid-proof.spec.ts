// Kid-proof fixes in Clips Funded on a phone (the owner: "even an 8 year old should be able to use the app"): what a
// tap changed is where the child is looking. Make the video's missing pick shows by the pinned button and its part
// comes into view; Next opens the next character step at its top; Try a face shows the preview; Ask for changes says
// what is missing by its own box; the chat's box is a short row on a 320 px phone; "Add a picture" shows the focus ring;
// Upload in Post it says which place to tap. Mock mode: nothing leaves the machine.
import { expect, test, type Browser, type Page } from "@playwright/test";

const S = { review: "01JSTST0000000000000000001", approved: "01JSTST0000000000000000003" };
const C = { pip: "01JSTCH0000000000000000001" };
const CONV = { winter: "01JSTCV0000000000000000001" };

async function context(browser: Browser, width: number, height: number, touch: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  return ctx;
}

async function open(page: Page, path: string, ready = ".st-studio") {
  await page.goto(path);
  await page.locator(ready).first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

for (const [w, h] of [
  [390, 844],
  [320, 640],
] as const) {
  test(`phone ${w}: Make the video with nothing picked shows why where the child looks`, async ({ browser }) => {
    const ctx = await context(browser, w, h, true);
    const page = await ctx.newPage();
    await open(page, "/stories/production/new");
    await page.locator(".st-make").click();
    const why = page.locator(".st-s-actionbar--pin .st-s-notice", { hasText: "Pick an idea, or tap Type my own." });
    await expect(why).toBeInViewport();
    await expect(page.locator(".st-make")).toBeInViewport();
    // The idea part comes into view, with the focus.
    await expect(page.locator("#st-nv-1")).toBeFocused();
    await expect(page.locator("#st-nv-1")).toBeInViewport();
    await ctx.close();
  });

  test(`phone ${w}: Next opens the next character step at its top, and Try shows the preview`, async ({ browser }) => {
    const ctx = await context(browser, w, h, true);
    const page = await ctx.newPage();
    await open(page, "/stories/characters/new");
    await page.getByRole("button", { name: "Next: Face" }).click();
    const face = page.locator('.st-s-editor__part[aria-label="Face"]');
    await expect(face).toBeFocused();
    await expect.poll(() => face.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeGreaterThanOrEqual(0);
    await expect.poll(() => face.evaluate((el) => el.getBoundingClientRect().top < innerHeight / 2)).toBe(true);
    // Try a face far down the list: the preview it changes comes into view.
    const sad = page.locator(".st-s-face", { hasText: "Sad" }).getByRole("button", { name: /^Try/ });
    await sad.scrollIntoViewIfNeeded();
    await sad.click();
    await expect(page.locator(".st-s-editor__now")).toContainText("Sad");
    await expect(page.locator(".st-s-editor__preview")).toBeInViewport({ ratio: 0.5 });
    await ctx.close();
  });

  test(`phone ${w}: Send the changes with nothing said says so by its box`, async ({ browser }) => {
    const ctx = await context(browser, w, h, true);
    const page = await ctx.newPage();
    await open(page, `/stories/review/${S.review}`);
    await page.getByRole("button", { name: "Ask for changes" }).click();
    // (It looks off until something is said, but a tap still answers.)
    await page.getByRole("button", { name: "Send the changes" }).click({ force: true });
    const form = page.getByRole("form", { name: "Ask for changes" });
    await expect(form.getByText("Say what to change, or pick a scene.")).toBeInViewport();
    await expect(form.getByLabel("What should change?")).toBeFocused();
    await ctx.close();
  });
}

test("phone 320: the chat's box is a short row and its hint fits on one line", async ({ browser }) => {
  const ctx = await context(browser, 320, 640, true);
  const page = await ctx.newPage();
  await open(page, `/stories/chat/${CONV.winter}`, ".st-chat-compose");
  const box = page.locator(".st-chat-compose");
  await expect(box).toBeVisible();
  const tall = await box.evaluate((el) => el.getBoundingClientRect().height);
  expect(tall).toBeLessThanOrEqual(190);
  // The model and effort fold into one chip that still opens the sheet.
  const chip = box.locator(".st-chat-ai__part--model");
  await expect(chip).toBeVisible();
  await expect(box.locator(".st-chat-ai__part--effort")).toBeHidden();
  const words = await chip.evaluate((el) => `${el.textContent}${getComputedStyle(el, "::after").content}`);
  expect(words).toMatch(/· /);
  // The placeholder fits: the empty box is one line tall.
  const area = box.getByRole("textbox", { name: "Your message" });
  const fits = await area.evaluate((el) => (el as HTMLTextAreaElement).scrollHeight <= (el as HTMLTextAreaElement).clientHeight + 1);
  expect(fits).toBe(true);
  await chip.click();
  await expect(page.getByRole("dialog", { name: "Model and effort" })).toBeVisible();
  await ctx.close();
});

test("a half-typed chat message comes back after another page", async ({ browser }) => {
  const ctx = await context(browser, 390, 844, true);
  const page = await ctx.newPage();
  await open(page, `/stories/chat/${CONV.winter}`, ".st-chat-compose");
  const area = page.getByRole("textbox", { name: "Your message" });
  await area.fill("A snowman who wants to be a lifeguard");
  await page.evaluate(() => {
    history.pushState({}, "", "/stories/ideas");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.locator(".st-studio").first().waitFor();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue("A snowman who wants to be a lifeguard");
  await ctx.close();
});

test("desktop: Add a picture shows the focus ring while its file input has the keyboard", async ({ browser }) => {
  const ctx = await context(browser, 1440, 900, false);
  const page = await ctx.newPage();
  await open(page, `/stories/characters/${C.pip}`);
  const input = page.locator('.st-s-refs__add input[type="file"]');
  await page.keyboard.press("Tab");
  await input.focus();
  const ring = await page.locator(".st-s-refs__add label").evaluate((el) => getComputedStyle(el).boxShadow);
  const plain = await page.getByRole("button", { name: "Next: Face" }).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  expect(ring).not.toBe(plain);
  await ctx.close();
});

test("Post it: Upload with nothing picked says which place to tap, by the buttons", async ({ browser }) => {
  const ctx = await context(browser, 390, 844, true);
  const page = await ctx.newPage();
  await open(page, `/stories/review/${S.approved}`);
  await page.getByRole("button", { name: "Post it", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Post it" });
  await expect(sheet.locator("button.st-s-place").first()).toBeVisible();
  // One orange button in the sheet: Upload.
  await expect(sheet.locator(".st-btn--main")).toHaveCount(1);
  await sheet.locator(".st-s-sheet__actions .st-btn--main").click({ force: true });
  const why = sheet.locator(".st-s-sheet__actions .st-s-sheet__why");
  // The mock's only connected place is YouTube.
  await expect(why).toHaveText("Tap YouTube first.");
  await expect(why).toBeInViewport();
  await expect(sheet.locator("button.st-s-place").first()).toBeFocused();
  // With one place, Use my settings picks it too.
  await sheet.getByRole("button", { name: "Use my settings" }).click();
  await expect(sheet.locator("button.st-s-place").first()).toHaveAttribute("aria-pressed", "true");
  await expect(why).toHaveCount(0);
  await ctx.close();
});
