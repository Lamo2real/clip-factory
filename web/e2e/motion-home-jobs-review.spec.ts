import { expect, test, type Page } from "@playwright/test";
import { ACT_FAIL_MS, ACT_MS, ACT_REWIND_MS } from "../src/lib/motion.ts";
import { animationsDone, settle } from "./helpers.ts";
import { actTransforms, actWidths, holdClock, MOTION_WIDTHS, noSideScroll, pauseActs, recordAct, tapAct, tapUntilPhase, watchFor } from "./motionHelpers.ts";

// Action motion on Home, Jobs and Review (docs/CONTRACTS.md §20.11 (a)). The handler always fires first; the motion
// is decoration on the button's own glyph; failures shake; Undo rewinds or brings the card back.

type MockWindow = Window & {
  __cfMockFaults?: { keepStopsAfterSave: number };
  __cfMockCalls?: Record<string, number>;
};

const calls = (page: Page, name: string) => page.evaluate((n) => (window as MockWindow).__cfMockCalls?.[n] ?? 0, name);

async function openJob(page: Page, title: string) {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: title }).click();
  await settle(page);
}

test.describe("motion: Home (APPLY a)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Before the page loads, so a test can hold the page's clock (holdClock); until then time runs as usual.
    await page.clock.install();
    await page.goto("/");
    await settle(page);
  });

  test("Make clips flies its scissors and the job starts before the flight ends", async ({ page }) => {
    await page.getByLabel("YouTube, Twitch or Kick link").fill("https://youtu.be/dQw4w9WgXcQ");
    const make = page.getByRole("button", { name: "Make clips" });
    await expect(make).toHaveAttribute("data-act", "send");
    const before = await calls(page, "createJob");
    const { cls } = await tapAct(make);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act", "act--send", "is-play"]));
    // The request goes out at the tap, not after the motion.
    await expect.poll(() => calls(page, "createJob"), { timeout: ACT_MS.send }).toBeGreaterThan(before);
    await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  });

  test("a disabled Make clips does not play", async ({ page }) => {
    const make = page.getByRole("button", { name: "Make clips" });
    await expect(make).toHaveAttribute("aria-disabled", "true");
    const { cls } = await tapAct(make);
    expect(cls).toContain("is-idle");
  });

  test("Paste drops in, and shakes when nothing is copied; Clear clears", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const paste = page.getByRole("button", { name: "Paste" });
    await expect(paste).toHaveAttribute("data-act", "paste");
    await expect(paste.locator(".act")).toHaveClass(/act--paste/);
    // The shake is short and starts after the clipboard answers, so wait for it inside the page: a polling check can
    // miss it on a busy machine.
    expect(await tapUntilPhase(paste, "is-fail")).toBe(true);
    await expect(page.getByText("Nothing is copied yet.")).toBeVisible();

    await page.evaluate(() => navigator.clipboard.writeText("https://youtu.be/dQw4w9WgXcQ"));
    await page.waitForTimeout(400);
    await paste.click();
    await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("https://youtu.be/dQw4w9WgXcQ");
    const clear = page.getByRole("button", { name: "Clear link" });
    await expect(clear).toHaveAttribute("data-act", "clear");
    // A tap on Clear within 400 ms of it taking Paste's place is a double tap's second half and is ignored
    // (NewJobForm.tsx SWAP_MS, home-jobs-guards.spec.ts); this is a tap of its own, a moment later.
    await page.waitForTimeout(500);
    await clear.click();
    await expect(page.getByLabel("YouTube, Twitch or Kick link")).toHaveValue("");
  });

  test("the dropzone's arrow rises when a video arrives and shakes on a wrong file", async ({ page }) => {
    await page.getByRole("radio", { name: "Pick a video" }).check({ force: true });
    const glyph = page.locator(".dropzone .act");
    await expect(glyph).toHaveClass(/act--upload/);
    await expect(glyph).toHaveClass(/is-idle/);
    const input = page.locator('input[type="file"][accept="video/*"]');
    // The page's clock is held from the file arriving: the shake and the rise cannot end before they are checked, and
    // the shake's return to rest is timed on the page's own clock, not on a busy machine's.
    await holdClock(page);
    await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await expect(glyph).toHaveClass(/is-fail/);
    await expect(page.getByText("That is not a video.")).toBeVisible();
    await page.clock.runFor(ACT_FAIL_MS);
    await expect(glyph).toHaveClass(/is-idle/);
    await input.setInputFiles({ name: "stream.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024) });
    await expect(glyph).toHaveClass(/is-play/);
    await page.clock.resume();
  });

  test("Exactly bumps its label and the stepper pops its plus and minus", async ({ page }) => {
    await page.getByRole("radio", { name: "Exactly" }).check({ force: true });
    await expect(page.locator(".segmented__opt.is-on .act", { hasText: "Exactly" })).toHaveClass(/act--toggle/);
    const more = page.getByRole("button", { name: "More: Number of clips" });
    await expect(more).toHaveAttribute("data-act", "add");
    await tapAct(more);
    await expect(page.locator(".stepper__num")).toHaveClass(/is-up/);
    const fewer = page.getByRole("button", { name: "Fewer: Number of clips" });
    await expect(fewer).toHaveAttribute("data-act", "remove");
    await tapAct(fewer);
    await expect(page.locator(".stepper__num")).toHaveClass(/is-down/);
  });
});

test.describe("motion: Jobs (APPLY a)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Before the page loads, so a test can hold the page's clock (holdClock); until then time runs as usual.
    await page.clock.install();
  });

  test("Stop job plays at the tap and rewinds on Undo", async ({ page }) => {
    await openJob(page, "Ranked grind");
    const stop = page.getByRole("button", { name: "Stop job" });
    await expect(stop).toHaveAttribute("data-act", "stop");
    // The page's clock is held from the tap: the 8 s Undo cannot run out on a busy machine, the rewind cannot end before
    // it is checked, and its return to rest is timed on the page's own clock.
    await holdClock(page);
    await stop.click();
    await expect(page.getByText("Stopping in a few seconds.")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(stop.locator(".act")).toHaveClass(/act--stop/);
    await expect(stop.locator(".act")).toHaveClass(/is-rewind/);
    await page.clock.runFor(ACT_REWIND_MS);
    await expect(stop.locator(".act")).toHaveClass(/is-idle/);
    await page.clock.resume();
  });

  test("Try again on a failed job turns its arrow and the job restarts at the tap", async ({ page }) => {
    await openJob(page, "Charity marathon");
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toHaveAttribute("data-act", "retry");
    const before = await calls(page, "retryJob");
    const { cls } = await tapAct(retry);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act--retry", "is-play"]));
    await expect.poll(() => calls(page, "retryJob"), { timeout: ACT_MS.retry }).toBeGreaterThan(before);
    await expect(page.getByText("Starting again from the beginning.")).toBeVisible();
  });
});

test.describe("motion: Review (APPLY a)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/review");
    await settle(page);
  });

  test("Upload flies its plane, keeps its confetti and the card leaves", async ({ page }) => {
    const cards = page.locator(".review-card");
    const before = await cards.count();
    const keep = cards.first().getByRole("button", { name: /^Upload( to .+)?$/ });
    await expect(keep).toHaveAttribute("data-act", "send");
    // The plane flies once the upload really starts (after the TikTok check), not on a tap that only opens a sheet.
    const seen = await recordAct(keep, 1200);
    expect(seen.join(" ")).toMatch(/act--send is-play/);
    await expect(page.locator("canvas.confetti")).toHaveCount(1);
    await expect(cards).toHaveCount(before - 1);
  });

  test("a refused Upload (caption too long) only shakes: never the plane", async ({ page }) => {
    const card = page.locator(".review-card").first();
    await card.locator('[data-place="x"] summary').click();
    await card.getByLabel("X caption").fill("x".repeat(300));
    const keep = card.getByRole("button", { name: /^Upload( to .+)?$/ });
    const phases = (await recordAct(keep, 200)).join(" ");
    expect(phases).toContain("is-fail");
    expect(phases).not.toContain("is-play");
    await expect(page.getByText(/longer than its platform allows/)).toBeVisible();
  });

  test("an Upload that does not finish shakes the Try again glyph", async ({ page }) => {
    await page.evaluate(() => {
      (window as MockWindow).__cfMockFaults!.keepStopsAfterSave = 1;
    });
    const card = page.locator(".review-card").first();
    // Try again only shakes for ACT_FAIL_MS, after the upload's answer: watch for it from before the tap, so a busy
    // machine cannot hide it between two polls.
    const shook = await watchFor(card, '[data-act="retry"] .act.is-fail');
    await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
    const again = card.getByRole("button", { name: "Try again", exact: true });
    await expect(again).toHaveAttribute("data-act", "retry");
    await expect.poll(shook).toBe(true);
    // No success visuals on failure.
    await expect(page.locator("canvas.confetti")).toHaveCount(0);
  });

  test("Throw away tosses the bin; Undo brings the card back with its return motion", async ({ page }) => {
    const cards = page.locator(".review-card");
    const before = await cards.count();
    const hook = await cards.first().locator(".review-card__hook").innerText();
    const toss = cards.first().getByRole("button", { name: "Throw away" });
    await expect(toss).toHaveAttribute("data-act", "throw");
    // The return motion lasts ACT_REWIND_MS: watch for it from before the tap (not between it and the 8 s Undo), so a
    // busy machine cannot hide it.
    const returned = await watchFor(page.locator("body"), ".review-card.is-returning", { hasText: hook });
    const { cls } = await tapAct(toss);
    expect(cls.split(" ")).toEqual(expect.arrayContaining(["act--throw", "is-play"]));
    await expect(cards).toHaveCount(before - 1);
    await page.getByRole("button", { name: "Undo" }).click();
    const back = page.locator(".review-card", { has: page.locator(".review-card__hook", { hasText: hook }) });
    await expect.poll(returned).toBe(true);
    await expect(back).toBeVisible();
    // The return ends on a timer of ACT_REWIND_MS; a busy machine can run that timer late, so allow it time to end.
    await expect(back).not.toHaveClass(/is-returning/, { timeout: ACT_REWIND_MS + 2000 });
  });

  test("a place row's chevron turns when it opens; the checks chevron turns with the state", async ({ page }) => {
    const card = page.locator(".review-card").first();
    // One row per place (§36), no caption tabs: opening a row turns its chevron.
    await expect(card.getByRole("tab")).toHaveCount(0);
    const x = card.locator('[data-place="x"]');
    const rowChev = x.locator(".place-row__chev");
    await expect(rowChev).toHaveClass(/act-turn/);
    await x.locator("summary").click();
    await expect(x).toHaveAttribute("open", "");
    await expect.poll(() => rowChev.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
    // X's mark already reads "X": no visible "X X".
    await expect(x.locator("summary")).not.toContainText("X X");

    const chev = card.locator(".checklist__chev");
    await expect(chev).toHaveClass(/act-turn/);
    await card.locator(".checklist__summary").click();
    await expect.poll(() => chev.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none");
  });

  test("Show every job clears the job filter", async ({ page }) => {
    const href = await page.locator(".review-card__job").first().getAttribute("href");
    const jobId = href!.split("/").pop()!;
    // In the app: the pretend app keeps its jobs in this page only, so a fresh load would ask for a job that is not
    // there (its own "This job isn't here" with a Show every job of its own), never this job's clips.
    await page.evaluate((to) => {
      history.pushState({}, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/review?job=${jobId}`);
    await settle(page);
    await expect(page.locator(".review-card").first()).toBeVisible();
    const all = page.getByRole("link", { name: "Show every job" });
    await expect(all).toHaveAttribute("data-act", "clear");
    await all.click();
    await expect(page).toHaveURL(/\/review$/);
  });

  test("reduced motion: Keep and Throw away only fade, nothing moves", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const cards = page.locator(".review-card");
    const toss = cards.nth(1).getByRole("button", { name: "Throw away" });
    const { cls } = await tapAct(toss);
    expect(cls).toContain("is-fade");
    for (const f of [0.25, 0.5, 0.75]) {
      await pauseActs(page, f);
      for (const t of await actTransforms(page)) expect(t).toBe("none");
    }
  });
});

test.describe("motion: no overflow while Home and Review animate (APPLY a)", () => {
  for (const width of MOTION_WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await settle(page);
      // Tapped where a child taps: on the option's words.
      await page.locator(".segmented__opt", { hasText: "Exactly" }).click();
      await page.locator(".segmented__opt", { hasText: "Pick a video" }).click();
      await expect(page.getByRole("radio", { name: "Exactly" })).toBeChecked();
      await animationsDone(page); // the highlights have slid over and the new fields are in
      let widths = await actWidths(page);
      await tapAct(page.getByRole("button", { name: "More: Number of clips" }));
      await page.locator('input[type="file"][accept="video/*"]').setInputFiles({ name: "a.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(16) });
      await pauseActs(page, 0.5);
      expect(await noSideScroll(page)).toBe(true);
      const during = await actWidths(page);
      for (const [k, w] of Object.entries(widths)) if (k in during) expect(during[k], k).toBe(w);

      await page.goto("/review");
      await settle(page);
      const card = page.locator(".review-card").last();
      // Opening a place row (§36) makes the card taller, so the chevron turn is compared with the page once the row is
      // open, and Throw away with the page after that.
      await card.locator('[data-place="tiktok"] summary').click();
      await pauseActs(page, 0.5);
      const midTab = await actWidths(page);
      await page.evaluate(() => {
        for (const a of document.getAnimations()) if (a.playState === "paused") a.finish();
      });
      await animationsDone(page); // the chosen tab has finished growing to show its name
      widths = await actWidths(page);
      for (const [k, w] of Object.entries(widths)) if (k in midTab) expect(midTab[k], `${k} during the tab bump`).toBe(w);
      await tapAct(card.getByRole("button", { name: "Throw away" }));
      await pauseActs(page, 0.5);
      expect(await noSideScroll(page)).toBe(true);
      const duringReview = await actWidths(page);
      for (const [k, w] of Object.entries(widths)) if (k in duringReview) expect(duringReview[k], k).toBe(w);
    });
  }
});
