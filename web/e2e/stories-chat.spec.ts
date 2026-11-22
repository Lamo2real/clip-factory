// Lamo Stories › Chat and References in mock mode (docs/CONTRACTS.md §45.16.7, §45.19, §45.27, §45.28): every page
// fits from 320 to 1920 px (no sideways scroll), draws no edges, keeps the arrow cursor, reaches AA contrast, has
// targets of 44 px (48 on phones) and a sliding highlight on every pick-one bar; and the flows work: "Model: … ·
// Effort: …" above the box, a sent message at once and the answer as it streams, Stop, "Just for this message" (sent,
// never saved), the conversation's own setting, the last open chat remembered, rename and delete with Undo, pictures,
// the director's buttons (only on a tap), failures with Try again; a reference video uploaded in parts with its
// progress, analyzed with a per-run model, the step track, the analysis, Use in a video, rename, delete with Undo.
// Needs the Lamo Stories shell and the mock's workspace part (builder F); the chat and references parts are H's.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow } from "./helpers.ts";

/** The mock's seeded ids (SEED_IDS in src/stories/api/mock/chat.ts and references.ts). */
const CONV = { winter: "01JSTCV0000000000000000001", hooks: "01JSTCV0000000000000000002", long: "01JSTCV0000000000000000003" };
const REF = { analyzed: "01JSTRF0000000000000000001", ready: "01JSTRF0000000000000000002" };

const PAGES: [string, string][] = [
  ["Chat list", "/stories/chat?all=1"],
  ["A chat", `/stories/chat/${CONV.winter}`],
  ["A chat with its own model", `/stories/chat/${CONV.hooks}`],
  ["References", "/stories/references"],
  ["An analyzed reference", `/stories/references/${REF.analyzed}`],
  ["A reference to analyze", `/stories/references/${REF.ready}`],
];

const SIZES: [number, number, boolean][] = [
  [320, 640, true],
  [390, 844, true],
  [1024, 768, false],
  [1920, 1080, false],
];

type Knobs = Record<string, unknown>;
type StoriesWindow = Window & {
  __cfStoriesMock?: { store?: { knobs: Knobs; memory: { text: string }[]; references: { refId: string; status: string }[] } };
  __cfSoundLog?: { kind: string }[];
};

async function context(browser: Browser, width: number, height: number, touch: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  return ctx;
}

const ROOT = ".st-chat, .st-refs";

/** Opens a page and waits until its data is in. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator(ROOT).first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** Moves inside the app like a tap on a link (a reload would start the in-memory mock afresh). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.locator(ROOT).first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"), undefined, { timeout: 20_000 });
}

async function knobs(page: Page, set: Knobs) {
  await page.evaluate((k) => {
    const store = (window as StoriesWindow).__cfStoriesMock?.store;
    if (store) Object.assign(store.knobs, k);
  }, set);
}

const soundKinds = (page: Page) => page.evaluate(() => ((window as StoriesWindow).__cfSoundLog ?? []).map((e) => e.kind));

/** Every rule of the owner's that can be measured on the page as it is now. */
async function audit(page: Page, label: string, phone: boolean, root = ROOT): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) if (/st-/.test(i.selector)) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  for (const e of await visibleEdges(page)) if (/\.st-/.test(e)) out.push(`${label}: edge ${e}`);
  const axe = await new AxeBuilder({ page }).include(root).withRules(["color-contrast"]).analyze();
  for (const v of axe.violations) for (const n of v.nodes) out.push(`${label}: contrast ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);
  const bad = await page.evaluate(
    ({ min, root }) => {
      const found: string[] = [];
      const vw = document.documentElement.clientWidth;
      const scope = root
        .split(",")
        .map((r) => r.trim())
        .flatMap((r) => [`${r} button`, `${r} a`, `${r} input:not([type=radio]):not([type=file])`, `${r} textarea`, `${r} [role=radio]`])
        .join(", ");
      for (const e of document.querySelectorAll<HTMLElement>(scope)) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(e).display === "inline" || e.closest(".sr-only")) continue;
        const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
        if (r.height < min - 0.5 || r.width < min - 0.5) found.push(`"${name}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
        if (r.right > vw + 0.5 || r.left < -0.5) found.push(`"${name}" is off the screen`);
        const cursor = getComputedStyle(e).cursor;
        if (cursor !== "default" && cursor !== "auto" && cursor !== "text") found.push(`"${name}" changes the cursor (${cursor})`);
      }
      for (const bar of document.querySelectorAll(root.split(",").map((r) => `${r.trim()} [role=radiogroup]`).join(", ")))
        if (!bar.querySelector(":scope > .glide")) found.push(`a pick-one bar without its sliding highlight: ${bar.textContent?.slice(0, 40)}`);
      return found;
    },
    { min: phone ? 48 : 44, root },
  );
  for (const b of bad) out.push(`${label}: ${b}`);
  return out;
}

for (const [w, h, touch] of SIZES)
  for (const [name, path] of PAGES)
    test(`chat page fits and follows the rules: ${name} at ${w}x${h}`, async ({ browser }) => {
      const ctx = await context(browser, w, h, touch);
      const page = await ctx.newPage();
      await open(page, path);
      expect(await audit(page, `${name} ${w}`, touch && w < 768)).toEqual([]);
      await ctx.close();
    });

test("the model sheet fits and follows the rules on a phone and a desktop", async ({ browser }) => {
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/chat/${CONV.winter}`);
    await page.locator(".st-chat-ai__part").first().click();
    const sheet = page.getByRole("dialog", { name: "Model and effort" });
    await expect(sheet).toBeVisible();
    expect(await audit(page, `sheet ${w}`, touch && w < 768, ".st-chat-sheet")).toEqual([]);
    // Done sits at the bottom right, where the thumb is.
    const done = await sheet.getByRole("button", { name: "Done" }).boundingBox();
    expect(done && done.x + done.width).toBeGreaterThan(w * 0.6);
    await ctx.close();
  }
});

test("the model and effort line, sending, streaming, Stop, and Just for this message", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, "/stories/chat?all=1");
  await knobs(page, { chatChunkMs: 150, chatThinkMs: 400 });

  // A new chat: the line names the effective values before anything is sent.
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(page).toHaveURL(/\/stories\/chat\/[0-9A-Z]{26}$/);
  const line = page.locator(".st-chat-ai__line");
  await expect(line).toHaveText("Model: Claude Opus 5.5 · Effort: High");

  // An empty box says why Send does nothing, with the deny sound.
  await page.evaluate(() => ((window as StoriesWindow).__cfSoundLog = []));
  await expect(page.locator(".st-chat-send")).toHaveAttribute("aria-disabled", "true");
  await page.locator(".st-chat-send").click({ force: true });
  await expect(page.getByText("Type a message first.")).toBeVisible();
  expect(await soundKinds(page)).toContain("deny");

  // Sent: the message shows at once, then the answer arrives a few words at a time and ends with its button.
  const box = page.getByRole("textbox", { name: "Your message" });
  await box.fill("Three funny ideas about snow, please");
  await page.locator(".st-chat-send").click();
  await expect(page.locator(".st-chat-msg--user").last()).toContainText("Three funny ideas about snow, please");
  const answer = page.locator(".st-chat-msg--assistant").last();
  await expect(answer.locator(".st-chat-caret")).toBeVisible({ timeout: 10_000 });
  const partial = (await answer.locator(".st-chat-text").textContent()) ?? "";
  await expect(answer.getByRole("button", { name: "Save this idea" })).toBeVisible({ timeout: 20_000 });
  expect(((await answer.locator(".st-chat-text").textContent()) ?? "").length).toBeGreaterThan(partial.length);
  await expect(answer.locator(".st-chat-msg__meta")).toHaveText("Claude Opus 5.5 · High");
  // The new chat took its name from the first message.
  await expect(page.locator(".st-chat-conv__title")).toHaveText("Three funny ideas about snow, please");

  // Stop: the answer stops where it is.
  await knobs(page, { chatChunkMs: 600 });
  await box.fill("Another one about ice");
  await page.locator(".st-chat-send").click();
  const second = page.locator(".st-chat-msg--assistant").last();
  await expect(second.locator(".st-chat-caret")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Stop the answer" }).click();
  await expect(second.getByText("Stopped")).toBeVisible();
  await expect(page.locator(".st-chat-send")).toHaveAccessibleName("Send");

  // Just for this message: Claude Fable 5.2 at Maximum for the next message only.
  await knobs(page, { chatChunkMs: 120 });
  await page.getByRole("button", { name: "Just for this message" }).click();
  const sheet = page.getByRole("dialog", { name: "Model and effort" });
  await expect(sheet.getByRole("radio", { name: /Just for this message/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("radio", { name: /Claude Fable 5\.2/ }).click();
  await sheet.getByRole("radio", { name: /Maximum/ }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".st-chat-ai .st-chat-chip", { hasText: "Just for this message" })).toBeVisible();
  await expect(line).toHaveText("Model: Claude Fable 5.2 · Effort: Maximum");
  await box.fill("Make it really clever");
  await page.locator(".st-chat-send").click();
  const third = page.locator(".st-chat-msg--assistant").last();
  await expect(third.locator(".st-chat-msg__meta")).toHaveText("Claude Fable 5.2 · Maximum", { timeout: 20_000 });
  // Not saved: the next message is back on the chat's own setting.
  await expect(line).toHaveText("Model: Claude Opus 5.5 · Effort: High");
  await expect(page.locator(".st-chat-ai .st-chat-chip", { hasText: "Just for this message" })).toHaveCount(0);

  // The chat's own setting: saved for this chat, shown at once and after coming back.
  const convUrl = page.url();
  await page.locator(".st-chat-ai__part").first().click();
  await expect(sheet.getByRole("radio", { name: /For this chat/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("radio", { name: /Claude Sonnet 5\.5/ }).click();
  await expect(sheet.getByText("Saved for this chat.")).toBeVisible();
  await sheet.getByRole("radio", { name: /^Low/ }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(line).toHaveText("Model: Claude Sonnet 5.5 · Effort: Low");
  await go(page, "/stories/references");
  await go(page, new URL(convUrl).pathname);
  await expect(line).toHaveText("Model: Claude Sonnet 5.5 · Effort: Low");
  await ctx.close();
});

test("the last open chat is remembered, and chats are renamed and deleted with Undo", async ({ browser }) => {
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, `/stories/chat/${CONV.hooks}`);
  await expect(page.locator(".st-chat-ai__line")).toHaveText("Model: Claude Sonnet 5.5 · Effort: Medium");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").lastConversationId)).toBe(CONV.hooks);
  await go(page, "/stories/references");
  await go(page, "/stories/chat");
  await expect(page).toHaveURL(new RegExp(`/stories/chat/${CONV.hooks}$`));
  // After a reload too.
  await page.goto("/stories/chat");
  await expect(page).toHaveURL(new RegExp(`/stories/chat/${CONV.hooks}$`), { timeout: 20_000 });

  // Rename from the list.
  const row = page.locator(".st-chat-row", { hasText: "What makes a good hook" });
  await row.getByRole("button", { name: "Rename What makes a good hook" }).click();
  await page.getByLabel("New name").fill("Hooks that work");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".st-chat-row__title", { hasText: "Hooks that work" })).toBeVisible();

  // Delete with Undo: gone at once, back with Undo.
  await page.locator(".st-chat-row", { hasText: "Hooks that work" }).getByRole("button", { name: /^Delete/ }).click();
  await expect(page.locator(".st-chat-row", { hasText: "Hooks that work" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".st-chat-row", { hasText: "Hooks that work" })).toBeVisible();
  // Delete for real: after the Undo bar goes, it stays gone.
  await page.locator(".st-chat-row", { hasText: "Hooks that work" }).getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeHidden({ timeout: 12_000 });
  await expect(page.locator(".st-chat-row", { hasText: "Hooks that work" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").lastConversationId ?? null)).toBeNull();
  await ctx.close();
});

test("the director's buttons act only on a tap; a failed answer says why and tries again; pictures go with a message", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, "/stories/chat?all=1");
  await knobs(page, { chatChunkMs: 100, chatThinkMs: 300, refSeconds: 2 });
  await page.getByRole("button", { name: "New chat" }).first().click();
  const box = page.getByRole("textbox", { name: "Your message" });

  // A failure: the sentence, then Try again.
  await knobs(page, { chatFail: "The director could not answer this time. Try again." });
  await box.fill("Can you analyze my reference video?");
  await page.locator(".st-chat-send").click();
  const failed = page.locator(".st-chat-msg--assistant.is-failed");
  await expect(failed).toContainText("The director could not answer this time.", { timeout: 15_000 });
  await failed.getByRole("button", { name: "Try again" }).click();

  // The answer's button: nothing happens until it is tapped, then the normal route runs.
  const answer = page.locator(".st-chat-msg--assistant").last();
  const analyze = answer.getByRole("button", { name: "Analyze this reference video" });
  await expect(analyze).toBeVisible({ timeout: 15_000 });
  const status = () => page.evaluate((id) => (window as StoriesWindow).__cfStoriesMock?.store?.references.find((r) => r.refId === id)?.status, REF.ready);
  expect(await status()).toBe("ready");
  await page.evaluate(() => ((window as StoriesWindow).__cfSoundLog = []));
  await analyze.click();
  await expect(answer.getByText("Looking at the video now!")).toBeVisible();
  expect(await status()).toBe("analyzing");
  expect(await soundKinds(page)).toContain("success");
  await answer.getByRole("link", { name: "Open the reference video" }).click();
  await expect(page).toHaveURL(new RegExp(`/stories/references/${REF.ready}$`));
  await expect(page.locator(".st-ref-track__step")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "What happens" })).toBeVisible({ timeout: 20_000 });

  // Make the video (the agent's { story } payload with a short concept): the tap saves the concept as an idea and
  // opens Production › New with that idea picked; nothing is made until Make the video is tapped there.
  await page.goBack();
  await expect(page).toHaveURL(/\/stories\/chat\/[0-9A-Z]{26}$/);
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"));
  await box.fill("Let's make a video of it");
  await page.locator(".st-chat-send").click();
  const make = page.locator(".st-chat-msg--assistant").last().getByRole("button", { name: "Make the video" });
  await expect(make).toBeVisible({ timeout: 15_000 });
  const storiesBefore = await page.evaluate(() => ((window as StoriesWindow).__cfStoriesMock?.store as unknown as { stories: unknown[] }).stories.length);
  await make.click();
  await expect(page).toHaveURL(/\/stories\/production\/new\?idea=[0-9A-Z]{26}.*sec=40/);
  await expect(page.getByText("Pip and the icy path").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => ((window as StoriesWindow).__cfStoriesMock?.store as unknown as { stories: unknown[] }).stories.length)).toBe(storiesBefore);

  // Pictures: too big is refused before upload; a good one uploads with its progress and goes with the message.
  await go(page, "/stories/chat?all=1");
  await page.locator(".st-chat-row").first().locator(".st-chat-row__main").click();
  await page.waitForFunction(() => !document.querySelector(".st-chat-wait"));
  const input = page.locator('.st-chat-compose input[type="file"]');
  await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 10, 1) });
  await expect(page.getByText("That picture is too big. Pick one under 5 MB.")).toBeVisible();
  await page.getByRole("button", { name: "Take out huge.png" }).click();
  await input.setInputFiles("e2e/fixtures/shot.png");
  await expect(page.locator(".st-chat-pic img")).toBeVisible();
  await expect(page.locator(".st-chat-pic .st-chat-progress")).toHaveCount(0, { timeout: 10_000 });
  await box.fill("Here is the look I want");
  await page.locator(".st-chat-send").click();
  await expect(page.locator(".st-chat-msg--user").last().locator("img.st-chat-bubble__pic")).toBeVisible();
  await expect(page.locator(".st-chat-pic")).toHaveCount(0);
  await ctx.close();
});

test("the chat can be about a project, and remembering goes to Settings › Memory", async ({ browser }) => {
  const ctx = await context(browser, 390, 844, true);
  const page = await ctx.newPage();
  await open(page, `/stories/chat/${CONV.winter}`);
  await knobs(page, { chatChunkMs: 80, chatThinkMs: 200 });
  await page.getByRole("button", { name: "Pick what it is about" }).click();
  const sheet = page.getByRole("dialog", { name: "What is this chat about?" });
  // Done sits at the bottom right of the sheet on a phone, and closes it without a change.
  const done = await sheet.getByRole("button", { name: "Done" }).boundingBox();
  expect(done && done.x + done.width).toBeGreaterThan(390 * 0.6);
  expect(done && done.y).toBeGreaterThan(844 * 0.5);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator(".st-chat-project__chip")).toHaveCount(0);
  await page.getByRole("button", { name: "Pick what it is about" }).click();
  await sheet.getByRole("radio", { name: "References" }).click();
  await sheet.getByRole("radio", { name: /Penguin on the ice rink/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator(".st-chat-project__chip")).toHaveText("Reference video: Penguin on the ice rink");

  await page.getByRole("textbox", { name: "Your message" }).fill("Please remember that Lamo likes slapstick endings.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".st-chat-msg--assistant").last().getByRole("button", { name: "See what I remember" })).toBeVisible({ timeout: 15_000 });
  const memory = await page.evaluate(() => (window as StoriesWindow).__cfStoriesMock?.store?.memory.map((m) => m.text) ?? []);
  expect(memory).toContain("Lamo likes slapstick endings");
  // Phone controls sit on the right: Send is at the right edge of the box.
  const send = await page.locator(".st-chat-send").boundingBox();
  expect(send && send.x + send.width).toBeGreaterThan(390 * 0.8);
  await ctx.close();
});

test("a reference video: upload in parts, analyze with a per-run model, the analysis, use it, rename, delete with Undo", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, "/stories/references");
  await knobs(page, { refSeconds: 3 });

  // A file that is not a video is refused before anything is sent.
  const input = page.locator('.st-ref-drop input[type="file"]');
  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByText("Pick an MP4 or MOV video.")).toBeVisible();
  await page.getByRole("button", { name: "Hide notes" }).click();

  // Upload: the progress, then its own page, ready to analyze.
  await page.evaluate(() => ((window as StoriesWindow).__cfSoundLog = []));
  await input.setInputFiles({ name: "my_fav-clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1_500_000, 7) });
  await expect(page.locator(".st-ref-upload .st-chat-progress")).toBeVisible();
  await expect(page).toHaveURL(/\/stories\/references\/[0-9A-Z]{26}$/, { timeout: 20_000 });
  expect(await soundKinds(page)).toContain("success");
  await expect(page.getByRole("heading", { level: 1, name: "my fav clip" })).toBeVisible();
  await expect(page.locator(".st-ref__meta")).toContainText("Ready to analyze");

  // Use in a video waits for the analysis, and says so.
  await page.getByRole("button", { name: "Use in a video" }).click({ force: true });
  await expect(page.getByText("Analyze it first, then use it in a video.")).toBeVisible();

  // Analyze with a model just for this run: the line shows it, the run uses it, the setting is not kept.
  // The usual setting is the reference-analysis task's (Lamo Stories › Settings › AI), whatever it is set to.
  const line = page.locator(".st-chat-ai__line");
  await expect(line).toHaveText(/^Model: Claude .+ · Effort: .+$/);
  const usual = (await line.textContent()) ?? "";
  await page.getByRole("button", { name: "Just for this run" }).click();
  const sheet = page.getByRole("dialog", { name: "Model and effort for this run" });
  await sheet.getByRole("radio", { name: /Claude Haiku 5\.5/ }).click();
  await sheet.getByRole("radio", { name: /^Medium/ }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(line).toHaveText("Model: Claude Haiku 5.5 · Effort: Medium");
  await knobs(page, { refSeconds: 6 });
  await page.getByRole("button", { name: "Analyze it" }).click();
  await expect(page.locator(".st-ref-track__step")).toHaveCount(3);
  // The answer carries the analysis job (§45.34): each step's own state and the job's own progress.
  await expect(page.locator(".st-ref-card2 .st-chat-progress")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".st-ref-track__step.is-done, .st-ref-track__step.is-running").first()).toBeVisible();
  await expect(page.locator(".st-ref-track")).toContainText("Look at it");
  await expect(page.locator(".st-ref-track")).toContainText("Listen");
  await expect(page.locator(".st-ref-track")).toContainText("Write it up");
  for (const heading of ["What happens", "The hook", "Pacing", "Shot by shot", "Jokes and acting", "Sound", "Captions", "Borrow these", "Don't copy these"])
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".st-ref-with")).toHaveText("Analyzed with Claude Haiku 5.5 · Medium");
  await expect(line).toHaveText(usual);

  // A re-run that fails is not cheered: it says so, keeps the last analysis, and offers another model.
  await knobs(page, { refFail: "This video can't be opened right now.", refSeconds: 3 });
  await page.evaluate(() => ((window as StoriesWindow).__cfSoundLog = []));
  await page.getByRole("button", { name: "Analyze again" }).click();
  await expect(page.locator(".st-ref-failed")).toContainText("The new analysis did not finish", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "What happens" })).toBeVisible();
  await expect(page.locator(".st-ref-failed").getByRole("button", { name: "Pick another model" })).toBeVisible();
  expect(await soundKinds(page)).not.toContain("success");

  // Rename.
  await page.getByRole("button", { name: "Rename my fav clip" }).click();
  await page.getByLabel("Name of this video").fill("My favourite clip");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My favourite clip" })).toBeVisible();

  // Use in a video: Production › New with it.
  const refUrl = page.url();
  const refId = refUrl.split("/").pop()!;
  await page.getByRole("button", { name: "Use in a video" }).click();
  await expect(page).toHaveURL(new RegExp(`/stories/production/new\\?ref=${refId}$`));

  // Delete with Undo: back on the list, gone, and back again with Undo.
  await go(page, new URL(refUrl).pathname);
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/stories\/references$/);
  await expect(page.locator(".st-ref-card", { hasText: "My favourite clip" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".st-ref-card", { hasText: "My favourite clip" })).toBeVisible();
  await ctx.close();
});

// ---------- Round 3 (§45.34) ----------

/** Lets the sliding highlights reach the new choice before the page is measured. */
const settle = (page: Page) => page.waitForTimeout(700);

test("round 3: the provider beside the line, Show earlier messages, and a failed answer keeps its model and Try again's choice", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    await ctx.addInitScript(() => ((window as StoriesWindow).__cfStoriesMock = { knobs: { longChat: 530 } } as never));
    const page = await ctx.newPage();
    await open(page, `/stories/chat/${CONV.long}`);
    await expect(page.locator(".st-chat-ai__provider")).toHaveText("From Amazon Bedrock");
    await expect(page.locator(".st-chat-msg")).toHaveCount(500);
    const earlier = page.getByRole("button", { name: "Show earlier messages" });
    await expect(earlier).toBeVisible();
    await settle(page);
    expect(await audit(page, `a long chat ${w}`, touch && w < 768)).toEqual([]);
    await earlier.click();
    await expect(page.locator(".st-chat-msg")).toHaveCount(530);
    await expect(page.locator(".st-chat-msg").first()).toContainText("Question number 1");
    await expect(earlier).toHaveCount(0);
    await ctx.close();
  }

  const ctx = await context(browser, 1280, 800, false);
  const page = await ctx.newPage();
  await open(page, `/stories/chat/${CONV.winter}`);
  await knobs(page, { chatChunkMs: 20, chatThinkMs: 50 });
  await page.getByRole("button", { name: "Just for this message" }).click();
  const sheet = page.getByRole("dialog", { name: "Model and effort" });
  await expect(sheet).toContainText("Amazon Bedrock.");
  await sheet.getByRole("radio", { name: /Claude Fable 5\.1/ }).click();
  await sheet.getByRole("radio", { name: /^Low/ }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await knobs(page, { chatFail: "The director could not answer this time. Try again." });
  await page.getByRole("textbox", { name: "Your message" }).fill("Ideas about rain");
  await page.getByRole("button", { name: "Send" }).click();
  const failed = page.locator(".st-chat-msg--assistant.is-failed");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed.locator(".st-chat-msg__meta")).toHaveText("Claude Fable 5.1 · Low");
  await failed.getByRole("button", { name: "Try again" }).click();
  // Sent again with the same choice: the new answer names it.
  await expect(page.locator(".st-chat-msg--assistant").last().locator(".st-chat-msg__meta")).toHaveText("Claude Fable 5.1 · Low", { timeout: 20_000 });
  await expect(page.locator(".st-chat-msg--assistant").last()).not.toHaveClass(/is-failed/);
  await ctx.close();
});

test("round 3: Analyze this reference video carries the model menu, starting from the message's own choice", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/chat/${CONV.winter}`);
    await knobs(page, { chatChunkMs: 20, chatThinkMs: 50, refSeconds: 2 });
    await page.getByRole("button", { name: "Just for this message" }).click();
    const sheet = page.getByRole("dialog", { name: "Model and effort" });
    await sheet.getByRole("radio", { name: /Claude Sonnet 5\.5/ }).click();
    await sheet.getByRole("button", { name: "Done" }).click();
    await page.getByRole("textbox", { name: "Your message" }).fill("Can you analyze my reference video?");
    await page.getByRole("button", { name: "Send" }).click();
    const card = page.locator(".st-chat-action--analyze_reference");
    await expect(card).toBeVisible({ timeout: 20_000 });
    const menu = card.getByRole("button", { name: /^Model and effort for this analysis: Claude Sonnet 5\.5/ });
    await expect(menu).toBeVisible();
    await settle(page);
    expect(await audit(page, `the analyze card ${w}`, touch && w < 768)).toEqual([]);
    await menu.click();
    const own = page.getByRole("dialog", { name: "Model and effort for this analysis" });
    await expect(own).toContainText("Just for this run.");
    await own.locator(".st-s-pick__opt", { hasText: "Claude Haiku 5.5" }).click();
    await own.getByRole("button", { name: "Done" }).click();
    await card.getByRole("button", { name: "Analyze this reference video" }).click();
    await expect(card).toContainText("Looking at the video now!");
    await card.getByRole("link", { name: "Open the reference video" }).click();
    await expect(page).toHaveURL(new RegExp(`/stories/references/${REF.ready}$`));
    await expect(page.locator(".st-ref-with")).toHaveText("Analyzed with Claude Haiku 5.5 · High", { timeout: 20_000 });
    await ctx.close();
  }
});

test("round 3: a reference video keeps its own model and effort, and a stopped analysis shows each step and its reason", async ({ browser }) => {
  test.setTimeout(90_000);
  for (const [w, h, touch] of [
    [320, 640, true],
    [1280, 800, false],
  ] as const) {
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await open(page, `/stories/references/${REF.ready}`);
    await page.getByRole("button", { name: "Just for this run" }).click();
    const sheet = page.getByRole("dialog", { name: /Model and effort for this (run|video)/ });
    await sheet.getByRole("radio", { name: "Keep with this video" }).click();
    await expect(sheet).toContainText("Kept with this video. Every analysis of it uses it.");
    await settle(page);
    expect(await audit(page, `keep with this video ${w}`, touch && w < 768, ".st-chat-sheet")).toEqual([]);
    await sheet.getByRole("radio", { name: /Claude Sonnet 5\.5/ }).click();
    await expect(sheet.getByRole("status")).toHaveText("Kept with this video.");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".st-chat-ai__line")).toHaveText(/^Model: Claude Sonnet 5\.5 · Effort: /);
    await expect(page.getByText("Kept with this video (its own setting).")).toBeVisible();
    await knobs(page, { refFail: "Claude Sonnet 5.5 isn't available right now: no access. Pick another model in Lamo Stories › Settings › AI, or try again.", refSeconds: 2 });
    await page.getByRole("button", { name: "Analyze it" }).click();
    const failed = page.locator(".st-ref-failed");
    await expect(failed).toContainText("no access", { timeout: 20_000 });
    await expect(page.locator(".st-ref-track--stopped .st-ref-track__step.is-failed")).toContainText("Listen");
    await settle(page);
    expect(await audit(page, `a stopped analysis ${w}`, touch && w < 768)).toEqual([]);
    await ctx.close();
  }
});
