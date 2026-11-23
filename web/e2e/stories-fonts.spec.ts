import { expect, test, type Page } from "@playwright/test";
import { CLIPS, openClip } from "./helpers.ts";

// Funded Clips' type (docs/CONTRACTS.md §45.39) in the real faces: its toasts are Fraunces, though the shell draws
// every toast outside .stories-app, while Clip Factory's stay Inter even after Funded Clips has been on screen; and,
// as neither Fugaz One nor Fraunces has tabular figures, every number that ticks keeps one width (its box holds its
// widest value), so nothing beside it moves. Funded Clips is switched on here with cf.storiesPreview = 1.

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** A toast's class, its words' font and whether it sits inside Funded Clips' own box. */
async function toastType(page: Page, text: string) {
  const toast = page.locator(".toast").filter({ hasText: text });
  await expect(toast).toBeVisible();
  return toast.evaluate(async (t) => {
    await document.fonts.ready;
    const words = t.querySelector(".toast__text")!;
    const s = getComputedStyle(words);
    return {
      cls: t.className,
      family: s.fontFamily,
      inStories: !!t.closest(".stories-app"),
      loaded: document.fonts.check(`${s.fontWeight} ${s.fontSize} Fraunces`, words.textContent ?? ""),
    };
  });
}

test("Funded Clips' toasts are Fraunces in the shell's toast box; Clip Factory's stay Inter, also after Funded Clips was on screen", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await openClip(page, CLIPS.all);

  await page.locator(".ws-dock .ws-switch__opt", { hasText: "Funded Clips" }).click();
  await storiesReady(page);
  await page.getByRole("button", { name: "Try again" }).first().click();
  const mine = await toastType(page, "Trying again now.");
  expect(mine.inStories, "the shell draws it, outside .stories-app").toBe(false);
  expect(mine.cls.split(" ")).toContain("st-toast");
  expect(mine.family).toMatch(/^"?Fraunces"?, "Iowan Old Style", Georgia, serif$/);
  expect(mine.loaded, "Fraunces is loaded for it").toBe(true);

  // Back in Clip Factory (its pane kept, Funded Clips' style sheet still on the page): its own toast is Inter.
  await page.locator(".ws-dock .ws-switch__opt", { hasText: /^Clip Factory$/ }).click();
  await expect(page).toHaveURL(/\/clips\/[A-Z0-9]+$/);
  await page.locator(".perf__refresh").click();
  const theirs = await toastType(page, "Checking all 5 apps now.");
  expect(theirs.cls.split(" ")).not.toContain("st-toast");
  expect(theirs.family).toMatch(/^"Inter Variable", Inter,/);
});

test("every number that ticks keeps one width in Fugaz One and Fraunces: its box holds its widest value", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/stories");
  await storiesReady(page);
  const report = await page.evaluate(async () => {
    await document.fonts.ready;
    const app = document.querySelector(".stories-app")!;
    const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const range = (a: number, z: number) => Array.from({ length: z - a + 1 }, (_, i) => a + i);
    /**
     * Each value drawn in the element the screens use (its class, its parent's, the min-width the code gives it):
     * the box's widths (one, when it holds), and the values wider than their box.
     */
    const check = (name: string, make: () => { box: HTMLElement; root: HTMLElement }, values: string[], minWidth?: (v: string) => string) => {
      const { box, root } = make();
      app.appendChild(root);
      const widths = new Set<number>();
      const over: string[] = [];
      for (const v of values) {
        box.replaceChildren();
        const words = document.createElement("span");
        words.textContent = v;
        box.appendChild(words);
        if (minWidth) box.style.minWidth = minWidth(v);
        widths.add(Math.round(box.getBoundingClientRect().width * 100) / 100);
        if (words.getBoundingClientRect().width > box.getBoundingClientRect().width + 0.01) over.push(v);
      }
      const family = getComputedStyle(box).fontFamily;
      root.remove();
      return { name, family, widths: [...widths], over };
    };
    const inFlex = (cls: string, parent = "") => () => {
      const root = document.createElement("span");
      root.className = parent;
      root.style.display = "flex";
      const box = document.createElement("span");
      box.className = cls;
      root.appendChild(box);
      return { box, root };
    };
    return [
      // MediaRow's percent, a flex item beside the track: 0% to 100%.
      check("progress percent", inFlex("st-media__time", "st-media__bar"), range(0, 100).map((n) => `${n}%`)),
      // The reference player's time, for a clip of 0:45 and one of 12:34 (Player.tsx: the length's clock in ch).
      check("player time (0:45)", inFlex("st-ref-controls__now", "st-ref-controls__time"), range(0, 45).map(clock), () => `${clock(45).length}ch`),
      check("player time (12:34)", inFlex("st-ref-controls__now", "st-ref-controls__time"), range(0, 754).map(clock), () => `${clock(754).length}ch`),
      // The AI's seconds (ai.tsx: one ch a digit and the " s"), per number of digits.
      ...[1, 2, 3].map((d) =>
        check(`AI seconds (${d} digits)`, inFlex("st-s-ai-secs", "st-s-busy"), range(d === 1 ? 0 : 10 ** (d - 1), 10 ** d - 1).map((n) => `${n} s`), (v) => `calc(${v.length - 2}ch + 0.75em)`),
      ),
      // Settings › Video's length, the big Fugaz One number the slider moves: 15 to 90.
      check(
        "video length",
        () => {
          const root = document.createElement("p");
          root.className = "st-stg-length__value";
          const box = document.createElement("strong");
          root.appendChild(box);
          return { box, root };
        },
        range(15, 90).map(String),
      ),
    ];
  });
  for (const r of report) {
    expect(r.over, `${r.name}: wider than its box`).toEqual([]);
    expect(r.widths, `${r.name}: one width for every value`).toHaveLength(1);
  }
  // The faces really are the ones measured (Fugaz One for the big number, Fraunces for the rest).
  expect(report.find((r) => r.name === "video length")!.family).toMatch(/^"?Fugaz One"?,/);
  for (const r of report.filter((x) => x.name !== "video length")) expect(r.family, r.name).toMatch(/^"?Fraunces"?,/);
});
