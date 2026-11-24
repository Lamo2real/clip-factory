// The TikTok rows' new states (docs/CONTRACTS.md §47.4, round 3: D1-D7) as pictures, at 375 and 1440, in mock mode:
// the Library rows (not sure it posted with and without Try again, its real hover, stuck, a Mac gone quiet, the two
// questions, Find it for me that finds nothing, a campaign clip, paused, held, needs you, the queue's words, a Mac
// still working past 15 minutes), the clip page's stack, Review's campaign card and Uploaded just now (three Upload
// taps in the Mac's line among them), and Settings › Your Mac posts TikTok. Runs only when
// CF_TT_SHOTS_DIR names a folder (the screenshots project, on demand); no two pictures may be the same bytes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

const dir = process.env.CF_TT_SHOTS_DIR ?? "";
test.skip(!dir, "CF_TT_SHOTS_DIR is not set: the TikTok round-3 pictures are taken on demand only.");
test.describe.configure({ mode: "serial" });

type Extra = { backlogAt?: string; backfill?: boolean; holdBefore?: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { campaignClip(): string };
    mac: {
      ping(state?: string, reason?: string, device?: string, extra?: Extra): unknown;
      seen(at: string | null): void;
      claim(clipId: string, device?: string, agoMs?: number): unknown;
      step(clipId: string, step: string, device?: string, agoMs?: number): unknown;
      beat(clipId: string, agoMs?: number): unknown;
      stopped(clipId: string, reason: string, needsYou?: boolean): unknown;
      source(clipId: string, source: string, sinceAgoMs?: number): unknown;
    };
  };
};

const MIN = 60_000;
const WINDOW_OVER = 31 * MIN;
const SWITCH = "My Mac posts my TikTok clips";

async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}
const refocus = (page: Page) => page.evaluate(() => dispatchEvent(new Event("focus")));
/** One of the Mac helper's knobs (window.__cfMock.mac), by name. */
const mac = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([name, list]) => void ((window as MockWindow).__cfMock!.mac as unknown as Record<string, (...a: unknown[]) => unknown>)[name as string]!(...(list as unknown[])),
    [fn, args] as const,
  );
/** Claimed, Post pressed `agoMs` ago, then stopped: not sure it posted. */
async function pressed(page: Page, clipId: string, agoMs: number) {
  await mac(page, "claim", clipId);
  await mac(page, "step", clipId, "pressing", undefined, agoMs);
  await mac(page, "stopped", clipId, "Timed out.");
}

async function turnOn(page: Page) {
  await go(page, "/settings/posting/tiktok-mac");
  const sw = page.getByRole("switch", { name: SWITCH });
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
}
const cardOf = (page: Page, clipId: string) => page.locator(".lib-card", { has: page.locator(`[id="lib-${clipId}"]`) });
const rowOf = (page: Page, clipId: string) => cardOf(page, clipId).locator(".post", { has: page.locator(".post__name", { hasText: /^TikTok$/ }) });
async function clipSaying(page: Page, words: string, skip: string[] = []): Promise<string> {
  const cards = page.locator(".lib-card", { has: page.locator(".post__status", { hasText: new RegExp(`^${words}$`) }) });
  await expect(cards.first()).toBeVisible();
  for (const id of await cards.evaluateAll((els) => els.map((e) => e.getAttribute("aria-labelledby")!.replace("lib-", ""))))
    if (!skip.includes(id)) return id;
  throw new Error(`no other card says ${words}`);
}

/** Mac on and checked in, at the Library; a clip sent with Post with my Mac. */
async function sent(page: Page, skip: string[] = []): Promise<string> {
  await go(page, "/library");
  const clipId = await clipSaying(page, "(Not on TikTok yet|Only you can see it on TikTok)", skip);
  await rowOf(page, clipId).getByRole("button", { name: "Post with my Mac" }).click();
  await expect(rowOf(page, clipId).locator(".post__status")).toHaveText(/^Waiting for your Mac/);
  return clipId;
}

async function fresh(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac(page, "ping");
}

/** A picture of `what` (scrolled into view, the pointer parked away from it unless hovering). */
async function shot(page: Page, what: Locator, name: string, width: number, hover = false) {
  await what.evaluate((el) => el.scrollIntoView({ block: "center" }));
  if (!hover) await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  // The toasts of earlier taps, and the bars that float over the page, are not part of the state being shown (they
  // keep their place, only unseen, so nothing moves).
  await what.screenshot({ path: join(dir, `${name}-${width}.png`), animations: "disabled", caret: "hide", style: OVERLAYS });
}
const OVERLAYS = ".toasts, .tabbar, .topbar, .setup-todo-bar, .setup-todo, .help-launcher { visibility: hidden !important; }";

for (const width of [375, 1440]) {
  test.describe(`at ${width}`, () => {
    test.beforeAll(() => mkdirSync(dir, { recursive: true }));

    test(`library not sure it posted, its hover, the window, stuck and offline (${width})`, async ({ page }) => {
      // The pretend data has two clips the Mac can take: b goes stuck, then waits out the find window; a goes through
      // not sure it posted, its questions, then a Mac gone quiet.
      await fresh(page, width);
      const a = await sent(page);
      const b = await sent(page, [a]);
      // Stuck: working, its beat 6 minutes old, Post never pressed: it can't be on TikTok, so Try again only.
      await mac(page, "claim", b, undefined, 8 * MIN);
      await mac(page, "beat", b, 6 * MIN);
      await refocus(page);
      await expect(rowOf(page, b).locator(".post__status")).toHaveText("Your Mac stopped before it pressed Post");
      await expect(rowOf(page, b).getByRole("button", { name: "Try again, TikTok" })).toBeVisible();
      await expect(rowOf(page, b).getByRole("button", { name: "It's on TikTok", exact: true })).toHaveCount(0);
      // A real hover on its Try again.
      const stuckAgain = rowOf(page, b).getByRole("button", { name: "Try again, TikTok" });
      await shot(page, cardOf(page, b), "lib-stuck", width);
      await stuckAgain.hover();
      await expect.poll(() => stuckAgain.evaluate((el) => el.matches(":hover"))).toBe(true);
      await shot(page, cardOf(page, b), "lib-stuck-hover", width, true);
      await stuckAgain.click();
      await expect(rowOf(page, b).locator(".post__status")).toHaveText(/^Waiting for your Mac/);
      // Inside the find window after Post: no Try again yet, and the row says from when.
      await pressed(page, b, 10 * MIN);
      await expect(rowOf(page, b).locator(".post__status")).toHaveText(/^Not sure it posted · look on your TikTok · Try again from (?:\w{3} )?\d\d:\d\d$/);
      await expect(rowOf(page, b).getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
      await expect(rowOf(page, b).getByRole("button", { name: "Try again, TikTok" })).toHaveCount(0);
      await shot(page, cardOf(page, b), "lib-not-sure-in-window", width);
      // The same on the clip page: from when Try again comes (and none yet).
      await go(page, `/clips/${b}`);
      const stack = page.locator('[data-stack="tiktok"]');
      await expect(stack.locator(".pstack__calm-text")).toHaveText(/^Look on your TikTok · Try again from (?:\w{3} )?\d\d:\d\d$/);
      await expect(page.locator(".perf__actions").getByRole("button", { name: "Try again, TikTok" })).toHaveCount(0);
      await shot(page, stack, "clip-try-again-from", width);
      await go(page, "/library");

      await pressed(page, a, WINDOW_OVER);
      const card = cardOf(page, a);
      await expect(rowOf(page, a).locator(".post__status")).toHaveText("Not sure it posted · look on your TikTok");
      await shot(page, card, "lib-not-sure", width);
      // A real hover on the quieter Try again.
      const again = rowOf(page, a).getByRole("button", { name: "Try again, TikTok" });
      await again.hover();
      await expect.poll(() => again.evaluate((el) => el.matches(":hover"))).toBe(true);
      await shot(page, card, "lib-not-sure-hover-again", width, true);
      await again.click();
      await expect(rowOf(page, a).getByText("Post it again? Only if it's not on your TikTok.")).toBeVisible();
      await shot(page, card, "lib-again-confirm", width);
      await rowOf(page, a).getByRole("button", { name: "Not now" }).click();
      // It's on TikTok: Find it for me that finds nothing, then the no-link question.
      await rowOf(page, a).getByRole("button", { name: "It's on TikTok", exact: true }).click();
      await rowOf(page, a).getByRole("button", { name: "Find it for me" }).click();
      await expect(rowOf(page, a).getByRole("alert")).toHaveText("Not found yet. Try again in a minute, or paste the link.");
      await shot(page, card, "lib-find-not-found", width);
      await rowOf(page, a).getByRole("button", { name: "It's on TikTok, no link" }).click();
      await expect(rowOf(page, a).getByText("Save it as on TikTok without its link? Its views show once you add the link.")).toBeVisible();
      await shot(page, card, "lib-no-link-confirm", width);
      await rowOf(page, a).getByRole("button", { name: "Not now" }).click();

      // Posted again (the window is over); then the Mac goes quiet mid-post: since when.
      await rowOf(page, a).getByRole("button", { name: "Try again, TikTok" }).click();
      await rowOf(page, a).getByRole("button", { name: "Yes, post it again" }).click();
      await expect(rowOf(page, a).locator(".post__status")).toHaveText(/^Waiting for your Mac/);
      await mac(page, "claim", a, undefined, 14 * MIN);
      await mac(page, "beat", a, 12 * MIN);
      await mac(page, "seen", new Date(Date.now() - 12 * MIN).toISOString());
      await refocus(page);
      await expect(rowOf(page, a).locator(".post__status")).toHaveText(/^Your Mac hasn't checked in since /);
      await expect(rowOf(page, a).getByRole("button", { name: "Try again, TikTok" })).toBeVisible();
      await shot(page, card, "lib-offline-working", width);
      // The same after Post (pressed 40 minutes ago): It's on TikTok and Try again.
      await mac(page, "step", a, "pressing", undefined, 40 * MIN);
      await mac(page, "beat", a, 12 * MIN);
      await mac(page, "seen", new Date(Date.now() - 12 * MIN).toISOString());
      await refocus(page);
      await expect(rowOf(page, a).getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
      await expect(rowOf(page, a).getByRole("button", { name: "Try again, TikTok" })).toBeVisible();
      await shot(page, card, "lib-offline-pressed", width);
    });

    test(`library: a campaign clip (${width})`, async ({ page }) => {
      await fresh(page, width);
      const campaign = await page.evaluate(() => (window as MockWindow).__cfMock!.posting.campaignClip());
      await go(page, "/library");
      await expect(rowOf(page, campaign).locator(".post__status")).toHaveText("Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet.");
      await shot(page, cardOf(page, campaign), "lib-campaign", width);
    });

    test(`library: a Mac still working past 15 minutes offers nothing to tap (${width})`, async ({ page }) => {
      // D2: claimed 20 minutes ago (the upload wait), its beat fresh: still Posting…, never Not sure or Try again.
      await fresh(page, width);
      const a = await sent(page);
      await mac(page, "claim", a, undefined, 20 * MIN);
      await mac(page, "step", a, "uploading");
      await refocus(page);
      await expect(rowOf(page, a).locator(".post__status")).toHaveText("Posting…");
      await expect(rowOf(page, a).getByRole("button", { name: "Try again, TikTok" })).toHaveCount(0);
      await expect(rowOf(page, a).getByRole("button", { name: "It's on TikTok", exact: true })).toHaveCount(0);
      await shot(page, cardOf(page, a), "lib-working-past-15", width);
    });

    test(`review: three Upload taps wait in the Mac's line (${width})`, async ({ page }) => {
      // D4: each Upload tap's row shows its place in the Mac's line (one per tick, in the order he tapped).
      await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
      await page.addInitScript(() => {
        if (sessionStorage.getItem("cf-e2e-tt3q")) return;
        sessionStorage.setItem("cf-e2e-tt3q", "1");
        localStorage.removeItem("cf-upload-to");
      });
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as MockWindow).__cfMock?.setup);
      await page.evaluate(() => {
        const s = (window as MockWindow).__cfMock!.setup;
        for (const p of ["youtube", "instagram", "tiktok"]) s.finish(p);
        s.setAudit(false);
      });
      await turnOn(page);
      await mac(page, "ping");
      await go(page, "/review");
      for (let i = 0; i < 3; i++) {
        const card = page.locator(".review-card").filter({ hasNot: page.locator("[data-help~='cr-review-strip']") }).first();
        const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
        const own = page.locator(`[id="clip-${clipId}"] .review-card`);
        const upload = own.getByRole("button", { name: /^Upload( to .+)?$/ });
        await expect(upload).toBeVisible();
        const mine = own.getByRole("button", { name: "Use my settings" });
        if (await mine.count()) await mine.click();
        await expect(upload).toBeEnabled();
        await upload.click();
        await expect(page.locator(".kept-now__mac")).toHaveCount(i + 1);
        await expect(page.locator(`[id="clip-${clipId}"]`)).toHaveCount(0);
      }
      const kept = page.locator(".kept-now");
      // Uploaded just now lists the newest first: the last tap has two before it.
      await expect(kept.locator(".kept-now__mac")).toHaveText([
        "TikTok: Waiting for your Mac · in line (2 before it)",
        "TikTok: Waiting for your Mac · in line (1 before it)",
        "TikTok: Waiting for your Mac · next",
      ]);
      await shot(page, kept, "review-kept-queue-3", width);
    });

    test(`library: the queue's words (${width})`, async ({ page }) => {
      await fresh(page, width);
      const first = await sent(page);
      const second = await sent(page, [first]);
      await expect(rowOf(page, first).locator(".post__status")).toHaveText("Waiting for your Mac · next");
      await shot(page, cardOf(page, first), "lib-queue-next", width);
      await expect(rowOf(page, second).locator(".post__status")).toHaveText("Waiting for your Mac · in line (1 before it)");
      await shot(page, cardOf(page, second), "lib-queue-in-line", width);
    });

    test(`library: the backlog's time, held, paused and needs you (${width})`, async ({ page }) => {
      await fresh(page, width);
      await go(page, "/settings/posting/auto");
      const auto = page.getByRole("switch", { name: "Post my clips by themselves" });
      await auto.click();
      await expect(auto).toHaveAttribute("aria-checked", "true");
      await go(page, "/settings/posting/tiktok-mac");
      await page.getByRole("button", { name: "Send these to my Mac" }).click();
      await page.getByRole("button", { name: "Yes, send them" }).click();
      await expect(page.getByText(/^Sent \d+ clips? to your Mac\.$/)).toBeVisible();
      await mac(page, "ping", "ok", undefined, undefined, { backlogAt: new Date(Date.now() + 45 * MIN).toISOString() });
      await go(page, "/library");
      await refocus(page);
      const first = await clipSaying(page, "Waiting for your Mac · goes at about \\d\\d:\\d\\d");
      await shot(page, cardOf(page, first), "lib-backlog-time", width);
      const second = await clipSaying(page, "Waiting for your Mac · in line \\(1 before it\\)");

      // Held on the Mac: an auto-posting clip made before its hold.
      await mac(page, "source", second, "auto", 180 * MIN);
      await mac(page, "ping", "ok", undefined, undefined, { holdBefore: new Date(Date.now() - 60 * MIN).toISOString() });
      await refocus(page);
      await expect(rowOf(page, second).locator(".post__status")).toHaveText(/^Held on your Mac: made before /);
      await shot(page, cardOf(page, second), "lib-held", width);

      // Paused: Start my Mac again.
      await mac(page, "ping", "paused", "Paused on your Mac.");
      await refocus(page);
      await expect(rowOf(page, first).getByRole("button", { name: "Start my Mac again" })).toBeVisible();
      await shot(page, cardOf(page, first), "lib-paused-start-again", width);

      // Needs him: Open the stopped clip.
      await mac(page, "ping");
      await mac(page, "claim", first);
      await mac(page, "stopped", first, "TikTok wants a code. Type it on your Mac.", true);
      await refocus(page);
      await expect(rowOf(page, second).getByRole("link", { name: "Open the stopped clip" })).toBeVisible();
      await shot(page, cardOf(page, second), "lib-needs-you-link", width);
    });

    test(`clip page and Settings (${width})`, async ({ page }) => {
      await fresh(page, width);
      const a = await sent(page);
      await pressed(page, a, WINDOW_OVER);
      await go(page, `/clips/${a}`);
      const stack = page.locator('[data-stack="tiktok"]');
      await expect(stack.getByText(/Not sure it posted/)).toHaveCount(1);
      await expect(stack.locator(".pstack__calm-text")).toHaveText("Look on your TikTok");
      await expect(stack.locator(".pstack__chip")).toHaveText("Not sure it posted");
      await shot(page, stack, "clip-not-sure-stack", width);


      await go(page, "/settings/posting/tiktok-mac");
      const status = page.locator(".apple-panel", { has: page.locator("[data-mac='helper']") });
      await mac(page, "ping", "paused", "Paused on your Mac.");
      await refocus(page);
      await expect(page.getByRole("button", { name: "Start my Mac again" })).toBeVisible();
      await shot(page, status, "settings-mac-paused", width);
      await mac(page, "ping", "ok", undefined, undefined, { holdBefore: new Date(Date.now() - 60 * MIN).toISOString() });
      await refocus(page);
      await expect(page.getByRole("button", { name: "Let them go" })).toBeVisible();
      await shot(page, status, "settings-mac-hold", width);
      const b = await sent(page, [a]);
      await mac(page, "claim", b);
      await mac(page, "stopped", b, "TikTok wants a code. Type it on your Mac.", true);
      await go(page, "/settings/posting/tiktok-mac");
      await expect(page.getByRole("link", { name: "Open the stopped clip" })).toBeVisible();
      await shot(page, status, "settings-mac-needs-you", width);
    });

    test(`review: a campaign clip without TikTok, and Uploaded just now (${width})`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
      await page.addInitScript(() => {
        if (sessionStorage.getItem("cf-e2e-tt3")) return;
        sessionStorage.setItem("cf-e2e-tt3", "1");
        sessionStorage.setItem("cf-mock-cr-review", "tiktok");
        localStorage.removeItem("cf-upload-to");
      });
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as MockWindow).__cfMock?.setup);
      await page.evaluate(() => {
        const s = (window as MockWindow).__cfMock!.setup;
        for (const p of ["youtube", "instagram", "tiktok"]) s.finish(p);
        s.setAudit(false);
      });
      await go(page, "/review");
      const campaignCard = page.locator(".review-card").filter({ has: page.locator("[data-help~='cr-review-strip']") });
      await expect(campaignCard.locator(".upload-to")).toContainText("Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet.");
      await shot(page, campaignCard.locator(".upload-to"), "review-campaign-skip", width);

      await turnOn(page);
      await mac(page, "ping");
      await go(page, "/review");
      const card = page.locator(".review-card").filter({ hasNot: page.locator("[data-help~='cr-review-strip']") }).first();
      const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
      const mine = card.getByRole("button", { name: "Use my settings" });
      if (await mine.count()) await mine.click();
      await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
      const kept = page.locator(".kept-now");
      await expect(kept).toBeVisible();
      await pressed(page, clipId, WINDOW_OVER);
      const item = page.locator(".kept-now__item").first();
      await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Not sure it posted · look on your TikTok");
      await shot(page, kept, "review-kept-not-sure", width);
      await item.getByRole("button", { name: "Try again, TikTok" }).click();
      await expect(item.getByText("Post it again? Only if it's not on your TikTok.")).toBeVisible();
      await shot(page, kept, "review-kept-confirm", width);
      await item.getByRole("button", { name: "Not now" }).click();
      await item.getByRole("button", { name: "It's on TikTok", exact: true }).click();
      await expect(item.getByRole("textbox", { name: "TikTok link" })).toBeVisible();
      await shot(page, kept, "review-kept-link-box", width);
    });

    test(`every picture at ${width} is there, none the same bytes as another, none wider than the page`, async ({ page }) => {
      const names = [
        "lib-not-sure",
        "lib-not-sure-hover-again",
        "lib-not-sure-in-window",
        "lib-stuck",
        "lib-stuck-hover",
        "lib-offline-working",
        "lib-offline-pressed",
        "lib-again-confirm",
        "lib-no-link-confirm",
        "lib-find-not-found",
        "lib-campaign",
        "lib-paused-start-again",
        "lib-held",
        "lib-needs-you-link",
        "lib-queue-next",
        "lib-queue-in-line",
        "lib-backlog-time",
        "lib-working-past-15",
        "review-kept-queue-3",
        "clip-not-sure-stack",
        "clip-try-again-from",
        "review-campaign-skip",
        "review-kept-not-sure",
        "review-kept-confirm",
        "review-kept-link-box",
        "settings-mac-paused",
        "settings-mac-hold",
        "settings-mac-needs-you",
      ];
      const files = readdirSync(dir).filter((f) => f.endsWith(`-${width}.png`));
      for (const n of names) expect(files, n).toContain(`${n}-${width}.png`);
      const seen = new Map<string, string>();
      for (const f of files) {
        const bytes = readFileSync(join(dir, f));
        const hash = createHash("sha256").update(bytes).digest("hex");
        expect(seen.get(hash), `${f} is the same picture as ${seen.get(hash)}`).toBeUndefined();
        seen.set(hash, f);
        // A PNG's width is in its header: no picture is wider than the page (no layout break).
        expect(bytes.readUInt32BE(16), f).toBeLessThanOrEqual(width);
      }
      expect(readFileSync(join(dir, `lib-not-sure-hover-again-${width}.png`)).equals(readFileSync(join(dir, `lib-not-sure-${width}.png`)))).toBe(false);
      expect(readFileSync(join(dir, `lib-stuck-hover-${width}.png`)).equals(readFileSync(join(dir, `lib-stuck-${width}.png`)))).toBe(false);
      void page;
    });
  });
}
