import { expect, test, type Page } from "@playwright/test";
import { animationsDone, CLIPS, findOverflow, openClip, settle } from "./helpers.ts";

// The clip performance page (docs/CONTRACTS.md §16.8), in mock mode.
type MockWindow = Window & {
  __cfMockCalls?: Record<string, number>;
  __cfMockStats?: { poll(clipId?: string): number };
};

const ORDER = ["youtube", "tiktok", "instagram", "facebook", "x"];
const stack = (page: Page, platform: string) => page.locator(`[data-stack="${platform}"]`);
const big = (page: Page, platform: string) => stack(page, platform).locator('[data-metric="top"]');
const calls = (page: Page, name: string) => page.evaluate((n) => (window as MockWindow).__cfMockCalls?.[n] ?? 0, name);

test("a Library card opens the clip's page: five stacks in order, each with its own numbers, a crown on the best", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openClip(page, CLIPS.all);
  await expect(page.getByRole("heading", { level: 1, name: CLIPS.all })).toBeVisible();
  expect(await page.locator("[data-stack]").evaluateAll((els) => els.map((e) => e.getAttribute("data-stack")))).toEqual(ORDER);
  for (const p of ORDER) await expect(stack(page, p).getByText("Uploaded", { exact: true })).toBeVisible();

  // Each stack is its own platform's numbers.
  await expect(stack(page, "tiktok")).not.toContainText("Saves");
  await expect(stack(page, "instagram")).toContainText("Saves");
  await expect(stack(page, "instagram")).not.toContainText("Impressions");
  await expect(stack(page, "facebook")).not.toContainText("Impressions");
  await expect(stack(page, "x")).toContainText("Impressions");
  await expect(stack(page, "facebook")).toContainText("Plays");
  await expect(stack(page, "youtube")).toContainText("Updates daily");
  await expect(stack(page, "instagram")).toContainText("Can take 2 days");

  // TikTok has the most views in the mock: the crown and the vermilion line are its.
  await expect(stack(page, "tiktok").locator(".pstack__crown")).toBeVisible();
  await expect(page.locator(".pstack__crown")).toHaveCount(1);
  await expect(stack(page, "tiktok").getByRole("heading", { name: "TikTok, best" })).toBeVisible();
  await expect(page.locator('path[data-line="tiktok"]')).toHaveClass(/is-best/);

  await expect(stack(page, "youtube").getByRole("link", { name: /Open on YouTube/ })).toHaveAttribute("target", "_blank");
  await expect(stack(page, "youtube").getByRole("img", { name: /^Views went from/ })).toBeVisible();

  // Back goes to where the owner came from.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test("each calm state says one plain thing and links to the fix", async ({ page }) => {
  await openClip(page, CLIPS.mixed);
  await expect(stack(page, "tiktok")).toContainText("Uploaded privately. TikTok shows numbers after the app is approved.");
  await expect(stack(page, "tiktok")).toContainText("Uploaded privately");
  await expect(stack(page, "instagram")).toContainText("Connect Instagram in Settings › Posting › Set up posting.");
  await expect(stack(page, "instagram").getByRole("link", { name: "Set up Instagram" })).toHaveAttribute("href", "/settings/posting/setup/instagram");
  // Didn't work: its Try again is right in the stack, not at the top of the Library (thousands of px from it).
  await expect(stack(page, "facebook")).toContainText("Facebook said the video was too long for a Reel. Tap Try again.");
  await expect(stack(page, "facebook").getByRole("button", { name: "Try again, Facebook" })).toBeVisible();
  await expect(stack(page, "facebook").getByRole("link", { name: "Go to Library" })).toHaveCount(0);
  // X is on in Where clips go already: no "Turn on X" and no trip there.
  await expect(stack(page, "x")).toContainText("This clip was not sent to X.");
  await expect(stack(page, "x")).not.toContainText("Turn on");
  await expect(page.getByRole("link", { name: "Open Where clips go" })).toHaveCount(0);
  await expect(stack(page, "youtube").locator('[data-metric="top"]')).toBeVisible();

  await stack(page, "instagram").getByRole("link", { name: "Set up Instagram" }).click();
  await expect(page).toHaveURL(/\/settings\/posting\/setup\/instagram$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up Instagram" })).toBeVisible();

  // (When the TikTok numbers come depends on the day: "the Library and the clip page say the same time" below.)
  await openClip(page, CLIPS.fresh);
  await expect(stack(page, "youtube")).toContainText("Posting now…");
  await expect(stack(page, "instagram")).toContainText("Can take 2 days");
});

test.describe("on a Monday morning", () => {
  test.use({ timezoneId: "UTC" });

  test("the Library and the clip page say the same time for a post's numbers (its perfCheckAt)", async ({ page }) => {
    // The mock dates this week's clips from the page's clock: on a Monday morning the fresh clip's numbers come tomorrow.
    await page.clock.install({ time: new Date("2026-11-23T09:00:00Z") });
    await page.goto("/library");
    await settle(page);
    const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: CLIPS.fresh }) });
    await expect(card.locator(".post", { hasText: "TikTok" })).toContainText("· numbers tomorrow");
    await openClip(page, CLIPS.fresh);
    await expect(stack(page, "tiktok")).toContainText("Numbers come tomorrow.");
    await expect(stack(page, "tiktok")).not.toContainText("a few minutes");
  });
});

test("a place that didn't work: Try again in its own stack sends it there again", async ({ page }) => {
  await openClip(page, CLIPS.mixed);
  await stack(page, "facebook").getByRole("button", { name: "Try again, Facebook" }).click();
  await expect(page.getByText("Trying Facebook again!")).toBeVisible();
  await expect(stack(page, "facebook").getByRole("button", { name: "Try again, Facebook" })).toHaveCount(0);
  await expect(stack(page, "facebook")).not.toContainText("too long for a Reel");
});

test("a clip whose posting never started: Try again leads the page, and no stack says Turn on", async ({ page }) => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/library");
    await settle(page);
    // The Library card's line (keep-again.spec.ts): the same line and Try again come on its page.
    const lib = page.locator(".lib-card", { hasText: "This clip has not started uploading yet." });
    await lib.locator(".lib-card__link").click();
    await page.waitForURL(/\/clips\/[A-Z0-9]+$/);
    await page.locator("[data-stack]").nth(4).waitFor();
    const again = page.locator(".perf__actions .keep-again");
    await expect(again).toContainText("This clip has not started uploading yet. Tap Try again.");
    // The one main (vermilion) button is Try again; Refresh numbers, which has nothing to check, steps back.
    await expect(page.locator(".perf .btn--primary")).toHaveCount(1);
    await expect(page.locator(".perf .btn--primary")).toHaveText("Try again");
    await expect(page.getByRole("button", { name: "Refresh numbers" })).not.toHaveClass(/btn--primary/);
    // Every place is on in Where clips go: no stack sends him there.
    await expect(page.getByRole("link", { name: "Open Where clips go" })).toHaveCount(0);
    for (const p of ["youtube", "instagram", "facebook", "x"]) await expect(stack(page, p)).toContainText("Not sent yet. Tap Try again.");
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
  }
  await page.locator(".perf__actions .keep-again").getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(/Saved! It uploads as soon as your accounts are set up/)).toBeVisible();
  await expect(page.locator(".perf__actions .keep-again")).toHaveCount(0);
  await expect(page.locator(".perf .btn--primary")).toHaveText("Refresh numbers");
});

test("TikTok's Turn on on the clip page says what it turns on", async ({ page }) => {
  // Every post of this clip waits for setup, and Your Mac posts TikTok is off: its one button turns the Mac on.
  await openClip(page, "First time seeing the new map");
  await expect(page.locator(".perf__actions").getByRole("link", { name: "Turn on TikTok on my Mac" })).toBeVisible();
  await expect(page.locator(".perf__actions").getByRole("link", { name: "Turn on", exact: true })).toHaveCount(0);
});

test("Refresh numbers: spinner, new numbers over the live connection, then when the next check is", async ({ page }) => {
  await openClip(page, CLIPS.all);
  const button = page.locator(".perf__refresh");
  await expect(button).toHaveText("Refresh numbers");
  const before = await big(page, "youtube").innerText();
  const total = await page.locator('[data-metric="total"]').innerText();
  const fetches = await calls(page, "clipPerformance");

  await button.click();
  // One short line.
  await expect(page.locator(".toast").filter({ hasText: /^Checking all 5 apps now\.$/ })).toBeVisible();
  await expect(big(page, "youtube")).not.toHaveText(before);
  await expect(page.locator('[data-metric="total"]')).not.toHaveText(total);
  await expect(button).toHaveText(/^Next check in \d+ min$/);
  await expect(stack(page, "youtube")).toContainText(/Next check in \d+ min/);
  await expect(stack(page, "youtube")).toContainText("Updated just now");
  // The numbers came over the socket, not from asking the server again.
  expect(await calls(page, "clipPerformance")).toBe(fetches);

  // Waiting: the label is fully readable (no fading, ink on a solid background, at least 4.5:1) with a clock.
  await expect(button).toHaveClass(/is-waiting/);
  const look = () => button.evaluate((el) => {
    const s = getComputedStyle(el);
    const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 4).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].sort((x, y) => y - x) as [number, number];
    return { opacity: Number(s.opacity), bgAlpha: rgb(s.backgroundColor)[3] ?? 1, image: s.backgroundImage, ratio: (a + 0.05) / (b + 0.05) >= 4.5 };
  });
  // Polled: the button eases its background and opacity in over a moment.
  await expect.poll(look).toEqual({ opacity: 1, bgAlpha: 1, image: "none", ratio: true });

  // Too soon: the button is switched off, plays the deny sound and says when.
  await page.evaluate(() => (window.__cfSoundLog = []));
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await button.click({ force: true });
  await expect(page.locator(".toast").filter({ hasText: /^Next check in \d+ min\. Each app only lets Clip Factory look so often\.$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["deny"]);
});

test("the automatic check (the 15-minute poller) updates the page live", async ({ page }) => {
  await openClip(page, CLIPS.all);
  const before = await big(page, "tiktok").innerText();
  await page.evaluate(() => (window as MockWindow).__cfMockStats!.poll());
  await expect(big(page, "tiktok")).not.toHaveText(before);
});

test("the star saves the clip as one of the week's best", async ({ page }) => {
  await openClip(page, CLIPS.mixed);
  const star = page.getByRole("button", { name: "Best this week" });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Saved. Clip Factory will learn from your picks.")).toBeVisible();
  expect(await calls(page, "saveWeekBest")).toBe(1);

  // This week shows it starred (same in-memory store: reached in the app, not by reloading).
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("link", { name: "This week" }).click();
  await settle(page);
  const card = page.locator(".week-card", { hasText: CLIPS.mixed });
  await expect(card.getByRole("button", { name: "Best this week" })).toHaveAttribute("aria-pressed", "true");
});

/** Each path's end point in page coordinates, read from the drawn SVG. */
async function lineEnds(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<SVGPathElement>(".perf-lines path[data-line]")).map((p) => {
      const svg = p.ownerSVGElement!.getBoundingClientRect();
      const end = p.getPointAtLength(p.getTotalLength());
      return { line: p.dataset.line!, x: svg.left + end.x, y: svg.top + end.y };
    }),
  );
}

test("at 1440 px every line ends at its stack's top centre", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openClip(page, CLIPS.all);
  await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "fan");
  const ends = await lineEnds(page);
  expect(ends.map((e) => e.line)).toEqual(ORDER);
  for (const e of ends) {
    const box = (await stack(page, e.line).boundingBox())!;
    expect(Math.abs(e.x - (box.x + box.width / 2)), `${e.line} x`).toBeLessThanOrEqual(2);
    expect(Math.abs(e.y - box.y), `${e.line} y`).toBeLessThanOrEqual(2);
  }
  // Still true after the window changes size (the ResizeObserver redraws them).
  await page.setViewportSize({ width: 1180, height: 900 });
  // Wait on the redraw itself (a slow runner can take longer than any fixed pause), then check every end.
  await expect
    .poll(async () => {
      let worst = 0;
      for (const e of await lineEnds(page)) {
        const box = (await stack(page, e.line).boundingBox())!;
        worst = Math.max(worst, Math.abs(e.x - (box.x + box.width / 2)), Math.abs(e.y - box.y));
      }
      return worst;
    })
    .toBeLessThanOrEqual(2);
  for (const e of await lineEnds(page)) {
    const box = (await stack(page, e.line).boundingBox())!;
    expect(Math.abs(e.x - (box.x + box.width / 2)), `${e.line} x after resize`).toBeLessThanOrEqual(2);
    expect(Math.abs(e.y - box.y), `${e.line} y after resize`).toBeLessThanOrEqual(2);
  }
});

test("at 1024 px (sidebar open) the second-row lines run down the gutters, never over a first-row card", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openClip(page, CLIPS.all);
  await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "rows");
  const hits = await page.evaluate(() => {
    const row1 = ["youtube", "tiktok", "instagram"].map((p) => document.querySelector(`[data-stack="${p}"]`)!.getBoundingClientRect());
    const out: string[] = [];
    for (const name of ["facebook", "x"]) {
      const path = document.querySelector<SVGPathElement>(`path[data-line="${name}"]`)!;
      const svg = path.ownerSVGElement!.getBoundingClientRect();
      const len = path.getTotalLength();
      for (let i = 0; i <= 200; i++) {
        const pt = path.getPointAtLength((len * i) / 200);
        const x = svg.left + pt.x;
        const y = svg.top + pt.y;
        for (const r of row1) if (x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1) out.push(`${name} @${i}`);
      }
      const end = path.getPointAtLength(len);
      const target = document.querySelector(`[data-stack="${name}"]`)!.getBoundingClientRect();
      if (Math.abs(svg.left + end.x - (target.left + target.width / 2)) > 2 || Math.abs(svg.top + end.y - target.top) > 2) out.push(`${name} misses its stack`);
    }
    return out;
  });
  expect(hits).toEqual([]);
});

test("at 375 px a trunk runs down the left with a branch into each card", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openClip(page, CLIPS.all);
  await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "trunk");
  await expect(page.locator('path[data-line="trunk"]')).toHaveCount(1);
  const ends = await lineEnds(page);
  expect(ends.map((e) => e.line)).toEqual(["trunk", ...ORDER]);
  for (const e of ends.slice(1)) {
    const box = (await stack(page, e.line).boundingBox())!;
    expect(Math.abs(e.x - box.x), `${e.line} x`).toBeLessThanOrEqual(2);
    expect(Math.abs(e.y - (box.y + 28)), `${e.line} y`).toBeLessThanOrEqual(2);
  }
  const result = await findOverflow(page);
  expect(result.items).toEqual([]);
  expect(result.page).toBeLessThanOrEqual(result.viewport);
});

test("with reduced motion the lines are simply there, nothing animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openClip(page, CLIPS.all);
  await expect(page.locator(".perf-lines path")).toHaveCount(5);
  await expect(page.locator(".perf-lines")).not.toHaveClass(/perf-lines--draw/);
  const running = await page.evaluate(() => document.querySelector(".perf__stage")!.getAnimations({ subtree: true }).length);
  expect(running).toBe(0);
});

test("phone and desktop: the page fits and the one main vermilion button is Refresh", async ({ page }) => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await openClip(page, CLIPS.mixed);
    await expect(page.locator(".perf .btn--primary")).toHaveCount(1);
    await expect(page.locator(".perf .btn--primary")).toHaveText("Refresh numbers");
    const star = await page.getByRole("button", { name: "Best this week" }).boundingBox();
    expect(star!.height).toBeGreaterThanOrEqual(48);
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
    expect(result.page).toBeLessThanOrEqual(result.viewport);
  }
});

/** Every visible element's top, rounded, for the selector. */
const tops = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));

test("the layout follows the room the page really has (the sidebar counts), and each stack stays roomy", async ({ page }) => {
  for (const [width, height, layout] of [
    [768, 1024, "trunk"],
    [1024, 768, "rows"],
    [1440, 900, "fan"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await openClip(page, CLIPS.all);
    await expect(page.locator(".perf-lines"), `${width}`).toHaveAttribute("data-layout", layout);
    await expect(page.locator(".perf__stage")).toHaveAttribute("data-layout", layout);
    const widths = await page.locator("[data-stack]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    for (const w of widths) expect(w, `stack width at ${width}`).toBeGreaterThanOrEqual(185);
    // Each number sits on its label's line, not under it.
    const split = await page.locator(".pstack__row").evaluateAll((rows) =>
      rows
        .map((r) => {
          const l = r.querySelector(".pstack__label")!.getBoundingClientRect();
          const v = r.querySelector(".pstack__value")!.getBoundingClientRect();
          return Math.abs(l.top - v.top) > 4 ? r.textContent : null;
        })
        .filter(Boolean),
    );
    expect(split, `rows split at ${width}`).toEqual([]);
    // Platform names stay on one line, next to their mark.
    const names = await page.locator(".pstack__name").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    for (const h of names) expect(h).toBeLessThanOrEqual(30);
    const result = await findOverflow(page);
    expect(result.items, JSON.stringify(result.items)).toEqual([]);
  }
});

test("the big numbers line up across the columns, so the best is easy to spot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openClip(page, CLIPS.all);
  await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "fan");
  expect(new Set(await tops(page, '[data-metric="top"]')).size).toBe(1);
  expect(new Set(await tops(page, ".pstack__chip")).size).toBe(1);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator(".perf-lines")).toHaveAttribute("data-layout", "rows");
  await page.waitForTimeout(300); // a beat for the new layout's lines to start drawing; the wait that counts is the next line
  await animationsDone(page);
  const t = await tops(page, '[data-metric="top"]');
  expect(new Set(t.slice(0, 3)).size, "row 1").toBe(1);
  expect(new Set(t.slice(3)).size, "row 2").toBe(1);
});

test("desktop: the winner is named under the total and the stacks start on the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openClip(page, CLIPS.all);
  const win = page.locator(".perf__winner");
  await expect(win).toContainText("Best on TikTok · ");
  await expect(win.locator(".perf__winner-num")).toHaveText(/^[\d.]+K$/);
  await expect(win).toContainText(/views$/);
  await expect(win).toBeInViewport();
  const first = (await stack(page, "youtube").boundingBox())!;
  expect(first.y).toBeLessThan(900 - 40);
  // No phone chips on a wide screen: the stacks are right there.
  await expect(page.locator(".perf__chips")).toHaveCount(0);
});

test("phone: the video comes first, the winner and five chips fit on the first screen, a chip jumps to its stack", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openClip(page, CLIPS.all);
  const preview = (await page.locator(".perf__preview").boundingBox())!;
  const total = (await page.locator(".perf__total").boundingBox())!;
  const title = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
  expect(preview.y).toBeGreaterThan(title.y);
  expect(preview.y + preview.height).toBeLessThanOrEqual(total.y);
  // The total, with its plain-English winner, follows.
  await expect(page.locator(".perf__winner")).toBeVisible();
  expect(preview.y).toBeLessThan(400);

  await expect(page.locator(".perf__winner")).toContainText("Best on TikTok");
  await expect(page.locator(".perf__winner-num")).toHaveText(/^[\d.]+K$/);
  const chips = page.locator(".perf-chip");
  await expect(chips).toHaveCount(5);
  expect(await chips.evaluateAll((els) => els.map((e) => e.getAttribute("data-chip")))).toEqual(ORDER);
  await expect(page.locator(".perf-chip.is-best")).toHaveAttribute("data-chip", "tiktok");
  await expect(page.locator(".perf-chip.is-best")).toHaveAccessibleName(/TikTok: [\d,]+ views, best/);
  // The chips sit right under the video, on the first screen above the bottom tab bar.
  const chipBox = (await page.locator(".perf__chips").boundingBox())!;
  const nav = (await page.locator(".tabbar").boundingBox())!.y;
  expect(chipBox.y).toBeGreaterThan(preview.y + preview.height);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(nav);
  for (const box of await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);

  // The trunk runs down the left of the hero's boxes, never through them.
  const crossing = await page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('path[data-line="trunk"]')!;
    const svg = path.ownerSVGElement!.getBoundingClientRect();
    const boxes = [".perf__total", ".perf__chips", ".perf__actions"].map((s) => document.querySelector(s)!.getBoundingClientRect());
    const len = path.getTotalLength();
    let hits = 0;
    for (let i = 0; i <= 300; i++) {
      const pt = path.getPointAtLength((len * i) / 300);
      const x = svg.left + pt.x;
      const y = svg.top + pt.y;
      for (const r of boxes) if (x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1) hits++;
    }
    return hits;
  });
  expect(crossing).toBe(0);

  await page.locator('.perf-chip[data-chip="x"]').click();
  await expect(stack(page, "x")).toBeInViewport();
  await expect(page.locator("#stack-x")).toBeFocused();
  const result = await findOverflow(page);
  expect(result.items, JSON.stringify(result.items)).toEqual([]);
});
