import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Both apps' marks are the real logo wherever the shell draws them (the owner, 22-23 Nov: "the same logo as clip
// factory but with the colors in clip factory stories"; components/WorkspaceMark.tsx, styles/ws-mark.css). The Clips
// Funded mark is in Clips Funded's own warm colours everywhere it stands for Clips Funded: on Clip Factory's round toggle
// that goes to Clips Funded (a phone's top bar, and the computer's dock beside a folded sidebar), on the start-up card
// while Clips Funded's code loads, and in Clips Funded's own rail and top bar. Inside Clips Funded the toggle back to
// Clip Factory shows Clip Factory's real mark: its italic serif "C" on its bone tile with the vermilion dot, computed
// exactly as Clip Factory's own .brand__mark and .brand__dot. Clip Factory's own brand mark stays exactly as it was.

test.use({ reducedMotion: "reduce" });

/** Clips Funded's warm logo (glass-tokens.css §13): the cream tile, the espresso "C", the orange dot. */
const WARM = { tile: "linear-gradient(150deg, rgb(255, 243, 228), rgb(242, 220, 194))", letter: "rgb(42, 22, 11)", dot: "rgb(255, 138, 61)" };
/** Clip Factory's own mark (layout.css .brand__mark, .brand__dot; tokens.css), as it always was. */
const CLIPS = { tile: "rgba(239, 231, 218, 0.92)", letter: "rgb(15, 55, 43)", dot: "rgb(232, 57, 43)", style: "italic" };

type Mark = { tag: string; cls: string; text: string; tile: string; tileImage: string; letter: string; dot: string | null; font: string; style: string; svg: number } | null;

/** A mark as drawn: its tile (colour and picture), its "C", its dot, its type. */
async function markOf(page: Page, selector: string): Promise<Mark> {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.checkVisibility());
    if (!el) return null;
    const cs = getComputedStyle(el);
    const dot = el.querySelector<HTMLElement>(".brand__dot, .ws-mark__dot");
    return {
      tag: el.tagName,
      cls: el.className,
      text: el.textContent ?? "",
      tile: cs.backgroundColor,
      tileImage: cs.backgroundImage,
      letter: cs.color,
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      font: cs.fontFamily,
      style: cs.fontStyle,
      svg: el.querySelectorAll("svg").length + (el.closest("svg") ? 1 : 0),
    };
  }, selector);
}

function expectWarm(m: Mark, why: string) {
  expect(m, why).not.toBeNull();
  expect(m!.cls, why).toContain("ws-mark");
  expect(m!.text, why).toBe("C");
  expect(m!.tileImage, `${why}: the cream tile`).toBe(WARM.tile);
  expect(m!.letter, `${why}: the espresso C`).toBe(WARM.letter);
  expect(m!.dot, `${why}: the orange dot`).toBe(WARM.dot);
  expect(m!.style, why).toBe("italic");
}

async function on(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
  });
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** Clip Factory's own brand mark, as it always was: the same tile, "C", dot and type, untouched by either toggle. */
async function clipsBrand(page: Page) {
  const brand = await markOf(page, "[data-app-pane]:not([hidden]) .brand__mark:not(.ws-mark), .app .brand__mark:not(.ws-mark)");
  expect(brand, "Clip Factory's own brand mark").not.toBeNull();
  expect(brand!.cls).toBe("brand__mark");
  expect(brand!.text).toBe("C");
  expect(brand!.tile, "its bone tile").toBe(CLIPS.tile);
  expect(brand!.tileImage).toBe("none");
  expect(brand!.letter, "its green C").toBe(CLIPS.letter);
  expect(brand!.dot, "its vermilion dot").toBe(CLIPS.dot);
  expect(brand!.style).toBe(CLIPS.style);
  expect(brand!.font).toMatch(/^"Times New Roman"/);
  return brand!;
}

/** Inside Clips Funded, the toggle back to Clip Factory: Clip Factory's real mark, as its .brand__mark draws it. */
function expectClipsMark(m: Mark, brand: NonNullable<Mark>, why: string) {
  expect(m, why).not.toBeNull();
  expect(m!.tag, `${why}: the mark itself, no picture of a C`).toBe("SPAN");
  expect(m!.svg, why).toBe(0);
  expect(m!.cls, why).toContain("ws-clipmark");
  expect(m!.cls.split(" "), why).not.toContain("ws-mark");
  expect(m!.text, why).toBe("C");
  expect(m!.font, `${why}: the serif of .brand__mark`).toBe(brand.font);
  expect(m!.style, `${why}: in italic, as .brand__mark`).toBe(brand.style);
  expect(m!.tile, `${why}: Clip Factory's tile`).toBe(brand.tile);
  expect(m!.tileImage, why).toBe("none");
  expect(m!.letter, `${why}: Clip Factory's C`).toBe(brand.letter);
  expect(m!.dot, `${why}: Clip Factory's dot`).toBe(brand.dot);
}

test("a phone (375 x 812): the Clips Funded mark on Clip Factory's toggle is warm; in Clips Funded the way back is Clip Factory's real mark", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await on(page);
  await page.goto("/");
  await settle(page);
  const brand = await clipsBrand(page);
  // Clip Factory's top bar: the round toggle that goes to Clips Funded
  const toggle = page.locator("[data-app-pane]:not([hidden]) .ws-switch-host--topbar .ws-round--phone");
  await expect(toggle).toHaveAttribute("aria-label", "Go to Clips Funded");
  expectWarm(await markOf(page, "[data-app-pane]:not([hidden]) .ws-switch-host--topbar .ws-round__mark"), "Clip Factory's phone toggle");
  // over to Clips Funded: its own top bar mark warm, and its toggle back shows Clip Factory's real mark
  await toggle.click();
  await page.waitForURL((u) => u.pathname.startsWith("/stories"), { timeout: 15_000 });
  await storiesReady(page);
  expectWarm(await markOf(page, ".st-top .st-brand__mark"), "Clips Funded's own top bar");
  await expect(page.locator(".st-top .ws-round--phone")).toHaveAttribute("aria-label", "Go to Clip Factory");
  expectClipsMark(await markOf(page, ".st-top .ws-round__mark"), brand, "Clips Funded's phone toggle back");
  // and back: Clip Factory's own brand mark and its toggle exactly as before
  await page.locator(".st-top .ws-round--phone").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/stories"), { timeout: 15_000 });
  await settle(page);
  expect(await clipsBrand(page)).toEqual(brand);
  expectWarm(await markOf(page, "[data-app-pane]:not([hidden]) .ws-switch-host--topbar .ws-round__mark"), "Clip Factory's phone toggle again");
});

test("a computer, the sidebar folded (1440 x 900): the dock's round toggle is warm in Clip Factory and Clip Factory's real mark in Clips Funded", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await on(page);
  await page.goto("/");
  await settle(page);
  // Clip Factory's own brand in its open sidebar; then the sidebar folded with its own button, so the dock's switch is
  // a round toggle
  const brand = await clipsBrand(page);
  await page.getByRole("button", { name: "Collapse menu" }).click();
  await expect(page.getByRole("button", { name: "Expand menu" })).toBeVisible();
  await page.waitForTimeout(400);
  const toggle = page.locator(".ws-dock .ws-round");
  await expect(toggle).toHaveAttribute("aria-label", "Go to Clips Funded");
  expectWarm(await markOf(page, ".ws-dock .ws-round__mark"), "the dock's toggle in Clip Factory");
  await toggle.click();
  await page.waitForURL((u) => u.pathname.startsWith("/stories"), { timeout: 15_000 });
  await storiesReady(page);
  expectWarm(await markOf(page, ".st-rail .st-brand__mark"), "Clips Funded's own rail");
  await expect(page.locator(".ws-dock .ws-round")).toHaveAttribute("aria-label", "Go to Clip Factory");
  expectClipsMark(await markOf(page, ".ws-dock .ws-round__mark"), brand, "the dock's toggle in Clips Funded");
  // back in Clip Factory: the warm toggle again, and its own brand exactly as before once its sidebar is open again
  await page.locator(".ws-dock .ws-round").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/stories"), { timeout: 15_000 });
  await settle(page);
  expectWarm(await markOf(page, ".ws-dock .ws-round__mark"), "the dock's toggle in Clip Factory again");
  await page.getByRole("button", { name: "Expand menu" }).click();
  await page.waitForTimeout(400);
  expect(await clipsBrand(page)).toEqual(brand);
});

for (const size of [
  { w: 375, h: 812 },
  { w: 1440, h: 900 },
])
  test(`${size.w} x ${size.h}: the start-up card while Clips Funded's code loads shows the warm mark`, async ({ page }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await on(page);
    // Hold Clips Funded's own chunk until the card is measured.
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    await page.route("**/assets/StoriesApp-*.js", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/stories");
    const card = page.locator('.boot[aria-label="Loading Clips Funded"]');
    await card.waitFor({ timeout: 30_000 });
    const m = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.boot[aria-label="Loading Clips Funded"] .brand__mark')!;
      const cs = getComputedStyle(el);
      return { cls: el.className, text: el.textContent ?? "", tileImage: cs.backgroundImage, letter: cs.color, dot: getComputedStyle(el.querySelector(".brand__dot")!).backgroundColor, inStories: !!el.closest(".stories-app") };
    });
    expect(m.inStories, "outside Clips Funded's own app").toBe(false);
    expect(m.cls).toContain("ws-mark");
    expect(m.text).toBe("C");
    expect(m.tileImage, "the cream tile").toBe(WARM.tile);
    expect(m.letter, "the espresso C").toBe(WARM.letter);
    expect(m.dot, "the orange dot").toBe(WARM.dot);
    release();
    await storiesReady(page);
  });
