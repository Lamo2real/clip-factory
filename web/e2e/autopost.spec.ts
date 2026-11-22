import { expect, test, type Page } from "@playwright/test";
import { findOverflow, settle } from "./helpers.ts";

// Auto-posting (docs/CONTRACTS.md §46.2, §46.15) in mock mode, at 390 × 844 and 1440 × 900: the switch and its
// line, both controls saving with "Saved.", the result line and its warnings, where they go, Next up with Throw away
// and its Undo, a run on the fake clock with Recent, Didn't work and its own Try again, Post it yourself for TikTok,
// Practice run now, the Private test run (once a minute), the Review card's line and Home's hint. The fake clock
// (window.__cfMock.autopost) starts on Sunday 22 November 2026 at 10:20 UTC, and the browser reads UTC.

type Post = { postId: string; platform: string; status: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: {
      posts(clipId: string): Post[];
      settleWithOneFailed(clipId: string, platform: string, reason?: string): void;
      failWhilePosting(clipId: string, platform: string, reason?: string): void;
    };
    autopost: { set(at: string): void; advance(ms: number): Promise<string[]>; runs(): { runId: string; clips: { clipId: string }[] }[] };
  };
};

const SIZES = [
  { name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { name: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

/** In-app navigation: the pretend app keeps its clips, posts and fake clock in this page only (a reload starts over). */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

/** YouTube, TikTok, Instagram and Facebook set up (X not), the clock at Sun 10:20, then Settings › Posting › Auto-posting. */
async function open(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    const m = (window as MockWindow).__cfMock!;
    for (const p of ["youtube", "tiktok", "instagram", "facebook"]) m.setup.finish(p);
    m.setup.setAudit(true);
    m.autopost.set("2026-11-22T10:20:00.000Z");
  });
  await go(page, "/settings/posting/auto");
  await expect(page.getByRole("heading", { level: 1, name: "Auto-posting" })).toBeVisible();
  await expect(page.locator(".autopost__where .autopost__line")).toBeVisible();
}

const theSwitch = (page: Page) => page.getByRole("switch", { name: "Post my clips by themselves" });
const toast = (page: Page, text: string | RegExp) => page.locator(".toast__text", { hasText: text }).last();
const saved = (page: Page) => expect(toast(page, /^Saved\.$/)).toBeVisible();

async function turnOn(page: Page) {
  await theSwitch(page).click();
  await expect(theSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".autopost__state")).toHaveText("On. Next: Sun 11:00.");
}

/** Picks "Post every" in the app's own dropdown. */
async function every(page: Page, label: string) {
  const button = page.locator("#auto-post-every .dropdown__button");
  await button.click();
  await page.locator("#auto-post-every").getByRole("option", { name: label, exact: true }).click();
  await expect(button).toContainText(label);
}

for (const size of SIZES) {
  test.describe(`auto-posting on a ${size.name}`, () => {
    test.use({ viewport: size.viewport, timezoneId: "UTC", ...("isMobile" in size ? { hasTouch: true, isMobile: true } : {}) });

    test("the switch, both controls save, the result line and its warnings, where they go", async ({ page }) => {
      await open(page);
      await expect(theSwitch(page)).toHaveAttribute("aria-checked", "false");
      await expect(page.locator(".autopost__state")).toHaveText("Off. Nothing posts by itself.");
      await expect(page.locator(".autopost__result")).toHaveText("1 clip every 5 hours = about 5 clips a day per platform.");
      await expect(page.locator(".autopost__warn")).toHaveCount(0);

      await turnOn(page);
      await saved(page);

      await every(page, "4 hours");
      await saved(page);
      await expect(page.locator(".autopost__result")).toHaveText("1 clip every 4 hours = 6 clips a day per platform.");
      await expect(page.locator(".autopost__warn")).toHaveAttribute("role", "status");
      await expect(page.locator(".autopost__warn")).toHaveText("That's more than 5 clips a day on each platform.");
      await expect(page.locator(".autopost__state")).toHaveText("On. Next: Sun 11:00.");

      const clips = page.getByRole("radiogroup", { name: "Clips each time" });
      await expect(clips.getByRole("radio")).toHaveCount(5);
      await clips.getByRole("radio", { name: "5", exact: true }).click();
      await saved(page);
      await expect(page.locator(".autopost__result")).toHaveText("5 clips every 4 hours = 30 clips a day per platform.");
      await every(page, "1 hour");
      await expect(page.locator(".autopost__result")).toHaveText("5 clips every 1 hour = 120 clips a day per platform.");
      await expect(page.locator(".autopost__warn")).toHaveText(
        "That's more than 5 clips a day on each platform. YouTube takes at most 100 uploads a day, so some would wait until the next day.",
      );
      await every(page, "7 hours");
      await clips.getByRole("radio", { name: "2", exact: true }).click();
      await expect(page.locator(".autopost__result")).toHaveText("2 clips every 7 hours = about 7 clips a day per platform.");

      // Where they go: the set-up places but TikTok, then one line per place left out.
      await expect(page.locator(".autopost__where .autopost__line")).toHaveText("Goes to YouTube, Instagram and Facebook.");
      const left = page.locator(".autopost__left-row");
      await expect(left).toHaveText([
        "TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself.",
        /^X: not set up yet\.\s*Set up X$/,
      ]);
      await expect(left.nth(1).getByRole("link", { name: "Set up X" })).toHaveAttribute("href", "/settings/posting/setup/x");

      // Off again: nothing posts, and Next up has no times.
      await theSwitch(page).click();
      await expect(page.locator(".autopost__state")).toHaveText("Off. Nothing posts by itself.");
      await expect(page.locator("#auto-post-next-name")).toHaveText("Would go first");
      await expect(page.locator(".autopost__when")).toHaveCount(0);

      // Nothing leaves the screen, and the arrow is the only cursor.
      const overflow = await findOverflow(page);
      expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
      expect(overflow.items).toEqual([]);
      const pointers = await page.evaluate(() => Array.from(document.querySelectorAll(".branch-body *")).filter((el) => getComputedStyle(el).cursor === "pointer").length);
      expect(pointers).toBe(0);
    });

    test("Next up: oldest first with times, Throw away and its Undo; the Review card's line and Home's hint", async ({ page }) => {
      await open(page);
      await turnOn(page);
      const rows = page.locator("#auto-post-next .autopost__row");
      await expect(rows).toHaveCount(5);
      await expect(page.locator("#auto-post-next-name")).toHaveText("Next up");
      await expect(rows.locator(".autopost__when")).toHaveText(["Sun 11:00", "Sun 16:00", "Sun 21:00", "Mon 02:00", "Mon 07:00"]);
      const first = (await rows.first().locator(".autopost__hook").innerText()).trim();
      const target = rows.first().getByRole("button", { name: `Throw away, ${first}` });
      await expect(target).toBeVisible();
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await target.click();
      await expect(toast(page, "Clip thrown away.")).toBeVisible();
      await expect(rows).toHaveCount(4);
      await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
      await expect(rows).toHaveCount(5);
      await expect(rows.first().locator(".autopost__hook")).toHaveText(first);

      // Review: the same clip says when it goes up; Upload and Throw away stay.
      await go(page, "/review");
      const card = page.locator(".review-card", { has: page.locator(".review-card__hook", { hasText: first }) }).first();
      await expect(card.locator(".autopost-line")).toHaveText("Goes up by itself Sun 11:00. Throw it away to stop it.");
      await expect(card.getByRole("button", { name: /^Upload( to .+)?$/ })).toBeVisible();
      await expect(card.getByRole("button", { name: "Throw away" })).toBeVisible();

      // Home's hint, while on; unchanged while practising.
      await go(page, "/");
      await expect(page.locator(".newjob__hint")).toHaveText("Auto-posting is on: your clips go up by themselves every 5 hours, oldest first.");
      await go(page, "/settings/posting/auto");
      await page.locator("#auto-post-test > summary").click();
      await page.getByRole("switch", { name: "Practice" }).click();
      await saved(page);
      await expect(page.locator(".autopost__state")).toHaveText("On, practising. Next practice: Sun 11:00. Nothing gets sent.");
      await go(page, "/");
      await expect(page.locator(".newjob__hint")).toHaveText("Nothing gets posted until you tap Upload.");
      await go(page, "/review");
      await expect(card.locator(".autopost-line")).toHaveText("Practice picks it Sun 11:00. Nothing gets sent.");
    });

    test("a run on the clock: Recent, Didn't work with its own Try again, Post it yourself, the Library's words", async ({ page }) => {
      await open(page);
      await turnOn(page);
      const hook = (await page.locator("#auto-post-next .autopost__hook").first().innerText()).trim();
      const ran = await page.evaluate(async () => (await (window as MockWindow).__cfMock!.autopost.advance(3_600_000)).filter((r) => r.includes("#")));
      expect(ran).toEqual(["2026-11-22T11:00:00Z#scheduled"]);
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      const recent = page.locator("#auto-post-recent .autopost__run");
      await expect(recent.first()).toHaveText(`Sun 11:00 · “${hook}”: YouTube … Instagram … Facebook …`);
      await expect(page.locator(".autopost__state")).toHaveText("On. Next: Sun 16:00.");

      // Facebook does not work while YouTube and Instagram are still going up: no Try again yet (it would do nothing).
      const clipId = await page.evaluate(() => (window as MockWindow).__cfMock!.autopost.runs()[0]!.clips[0]!.clipId);
      const reason = "Facebook said the video was too long for a Reel.";
      await page.evaluate(([id, why]) => (window as MockWindow).__cfMock!.posting.failWhilePosting(id!, "facebook", why), [clipId, reason]);
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      const failed = page.locator("#auto-post-failed .autopost__row");
      await expect(failed).toHaveCount(1);
      await expect(failed).toContainText(reason);
      await expect(failed.locator(".autopost__wait")).toHaveCount(0);
      await expect(failed.getByRole("button", { name: "Try again, Facebook" })).toHaveCount(0);

      // The others go up: now Facebook gets its own Try again.
      await page.evaluate(([id, why]) => (window as MockWindow).__cfMock!.posting.settleWithOneFailed(id!, "facebook", why), [clipId, reason]);
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      await expect(recent.first().locator(".autopost__run-text")).toHaveText(`Sun 11:00 · “${hook}”: YouTube ✓ Instagram ✓ Facebook ✗`);
      await expect(recent.first().getByRole("link", { name: "Open the YouTube post" })).toHaveAttribute("target", "_blank");
      await expect(recent.first().getByRole("link", { name: "Open the Instagram post" })).toBeVisible();

      await expect(failed).toHaveCount(1);
      await expect(failed).toContainText("Facebook");
      await expect(failed).toContainText(hook);
      await expect(failed).toContainText(reason);
      // TikTok is never part of a run: it waits for his own tap.
      await expect(page.locator("#auto-post-tiktok .autopost__row", { hasText: hook }).getByRole("button", { name: "Post it on TikTok yourself" })).toBeVisible();

      await failed.getByRole("button", { name: "Try again, Facebook" }).click();
      await expect(page.getByText("Trying Facebook again!")).toBeVisible();
      await expect(page.locator("#auto-post-failed")).toHaveCount(0);

      // Library: an auto-posted post adds "· by auto-posting" after its state.
      await go(page, "/library");
      const lib = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) }).first();
      await expect(lib.locator(".post", { hasText: "YouTube" }).locator(".post__status")).toContainText("Uploaded · by auto-posting");
    });

    test("Test it first: Practice run now, Private test run once a minute, both in Recent", async ({ page }) => {
      await open(page);
      const fold = page.locator("#auto-post-test");
      await expect(fold).not.toHaveAttribute("open", "");
      await fold.locator("summary").click();
      await expect(page.getByRole("switch", { name: "Practice" })).toHaveAttribute("aria-checked", "false");
      const hook = (await page.locator("#auto-post-next .autopost__hook").first().innerText()).trim();

      // Runs whatever the switch says: still off.
      await page.getByRole("button", { name: "Practice run now" }).click();
      const recent = page.locator("#auto-post-recent .autopost__run");
      await expect(recent.first()).toHaveText(`Sun 10:20 · Practice: would post “${hook}” to YouTube, Instagram and Facebook.`);
      await page.getByRole("button", { name: "Private test run" }).click();
      await expect(toast(page, "A test run just started. Wait a minute.")).toBeVisible();

      await page.evaluate(() => (window as MockWindow).__cfMock!.autopost.advance(61_000));
      await expect(page.locator("#auto-private-line")).toHaveText(
        "Posts the next clip so only you can see it: YouTube as Only me, Facebook as a draft on your Page, Instagram uploaded and checked but not published. It leaves Review.",
      );
      await page.getByRole("button", { name: "Private test run" }).click();
      await expect(recent.first().locator(".autopost__run-text")).toHaveText(
        `Private test · “${hook}”: YouTube (only you) · Facebook (draft) · Instagram (checked, not published)`,
      );
      await expect(recent.first().getByRole("link", { name: "Open the YouTube post" })).toBeVisible();
      // It left Review, and never moved the schedule.
      await expect(page.locator("#auto-post-next .autopost__hook").first()).not.toHaveText(hook);
      await expect(page.locator(".autopost__state")).toHaveText("Off. Nothing posts by itself.");

      // Library says where each private post waits, with no numbers.
      await go(page, "/library");
      const lib = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) }).first();
      await expect(lib.locator(".post", { hasText: "YouTube" }).locator(".post__status")).toHaveText("Private test · only you");
      await expect(lib.locator(".post", { hasText: "Facebook" }).locator(".post__status")).toHaveText("Private test · draft on your Page");
      await expect(lib.locator(".post", { hasText: "Instagram" }).locator(".post__status")).toHaveText("Private test · checked, not published");
    });

    test("Throw away from the keyboard: the focus goes to the next row, and after the last to Next up", async ({ page }) => {
      await open(page);
      const rows = page.locator("#auto-post-next .autopost__row");
      const count = await rows.count();
      expect(count).toBeGreaterThan(1);
      await rows.first().getByRole("button", { name: /^Throw away, / }).focus();
      for (let left = count; left > 1; left--) {
        await page.keyboard.press("Enter");
        await expect(rows).toHaveCount(left - 1);
        await expect(rows.first().getByRole("button", { name: /^Throw away, / })).toBeFocused();
      }
      await page.keyboard.press("Enter");
      await expect(rows).toHaveCount(0);
      await expect(page.locator("#auto-post-next")).toBeFocused();
      // Waits for you and Recent stay on the page, empty or not (only Didn't work and TikTok's hide when empty).
      await expect(page.locator("#auto-post-waiting")).toBeVisible();
      await expect(page.locator("#auto-post-recent")).toBeVisible();
    });

    test("Find a setting: a list that draws once the status is read, and the Test it first fold", async ({ page }) => {
      await open(page);
      await turnOn(page);
      await page.evaluate(async () => (window as MockWindow).__cfMock!.autopost.advance(3_600_000));
      const clipId = await page.evaluate(() => (window as MockWindow).__cfMock!.autopost.runs()[0]!.clips[0]!.clipId);
      await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.settleWithOneFailed(id, "facebook"), clipId);

      // Away and back with #auto-post-failed: Didn't work only draws after GET /v1/autopost (slow here, well after the
      // page's first look for it), and is still found.
      await go(page, "/settings/posting");
      await page.evaluate(() => ((window as unknown as { __cfMockFaults: { latencyMs?: number } }).__cfMockFaults.latencyMs = 700));
      await go(page, "/settings/posting/auto#auto-post-failed");
      const found = page.locator("#auto-post-failed");
      await expect(found).toBeFocused();
      await expect(found).toHaveClass(/is-found/);
      await expect(found).toBeInViewport();
      await page.evaluate(() => delete (window as unknown as { __cfMockFaults: { latencyMs?: number } }).__cfMockFaults.latencyMs);

      // The fold opens by itself and takes the focus.
      await go(page, "/settings/posting");
      await go(page, "/settings/posting/auto#auto-post-test");
      const fold = page.locator("#auto-post-test");
      await expect(fold).toHaveAttribute("open", "");
      await expect(fold).toBeFocused();
      await expect(page.getByRole("button", { name: "Practice run now" })).toBeInViewport();
    });
  });
}
