// Your Mac posts it on TikTok (docs/CONTRACTS.md §47) in mock mode: Settings › Posting › Your Mac posts TikTok (the
// switch, the Mac's check-in, Send these to my Mac), and the TikTok row on the Library, the clip page and Review's
// Uploaded just now, which says only what the Mac is doing, with at most one button (§47.4, ADR-85): Waiting for your
// Mac · next at, Posting…, Didn't work with Try again, Posted by your Mac, Not on TikTok yet with Post with my Mac,
// and Turn on while the Mac can't post. The Mac is moved by the helper's knobs (window.__cfMock.mac). The pretend app
// keeps its settings and posts in this page only, so every step after the first page is an in-app navigation.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

type Job = { clipId: string; postId: string; hook: string; state: string; source: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { posts(clipId: string): { postId: string; platform: string; status: string }[] };
    mac: {
      ping(state?: string, reason?: string): { on: boolean };
      seen(at: string | null): void;
      login(login: "saved" | "none", done?: boolean): void;
      claim(clipId: string): Job;
      step(clipId: string, step: string): Job;
      done(clipId: string, link?: string): unknown;
      stopped(clipId: string, reason: string, needsYou?: boolean): Job;
      queue(): Job[];
    };
  };
};

const LINK = "https://www.tiktok.com/@lamo.clips/video/7710644811602169121";
const NEXT_AT = /^Waiting for your Mac · next at (\w{3} )?\d\d:\d\d$/;

test.use({ viewport: { width: 1440, height: 900 } });

async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

/** The pages read the Mac's check-in again when the window gets the focus. */
async function refocus(page: Page) {
  await page.evaluate(() => dispatchEvent(new Event("focus")));
}

/** The Mac helper's routes, through the mock's knobs (window.__cfMock.mac). */
const mac = {
  ping: (page: Page, state?: string, reason?: string) =>
    page.evaluate(([s, r]) => (window as MockWindow).__cfMock!.mac.ping(s, r), [state, reason] as const),
  seen: (page: Page, at: string | null) => page.evaluate((t) => (window as MockWindow).__cfMock!.mac.seen(t), at),
  claim: (page: Page, clipId: string) => page.evaluate((id) => (window as MockWindow).__cfMock!.mac.claim(id), clipId),
  step: (page: Page, clipId: string, step: string) =>
    page.evaluate(([id, st]) => (window as MockWindow).__cfMock!.mac.step(id, st), [clipId, step] as const),
  stopped: (page: Page, clipId: string, reason: string) =>
    page.evaluate(([id, r]) => (window as MockWindow).__cfMock!.mac.stopped(id, r), [clipId, reason] as const),
  done: (page: Page, clipId: string, link?: string) =>
    page.evaluate(([id, l]) => void (window as MockWindow).__cfMock!.mac.done(id, l), [clipId, link] as const),
  queue: (page: Page) => page.evaluate(() => (window as MockWindow).__cfMock!.mac.queue()),
  login: (page: Page, login: "saved" | "none", done?: boolean) =>
    page.evaluate(([l, d]) => (window as MockWindow).__cfMock!.mac.login(l, d), [login, done] as const),
};

const SWITCH = "My Mac posts my TikTok clips";

/** Settings › Posting › Your Mac posts TikTok, switched on. */
async function turnOn(page: Page) {
  await go(page, "/settings/posting/tiktok-mac");
  const sw = page.getByRole("switch", { name: SWITCH });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("On. Upload and auto-posting hand TikTok to your Mac.")).toBeVisible();
}

/** Switched on, every clip that isn't on TikTok yet sent to the Mac (the backlog); answers the first job in the queue. */
async function sendAll(page: Page): Promise<Job> {
  await turnOn(page);
  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await expect(page.getByText("They go one at a time, oldest first.")).toBeVisible();
  await page.getByRole("button", { name: "Yes, send them" }).click();
  await expect(page.getByText(/^Sent \d+ clips? to your Mac\.$/)).toBeVisible();
  const first = (await mac.queue(page))[0];
  expect(first).toBeTruthy();
  return first!;
}

const cardOf = (page: Page, clipId: string) => page.locator(".lib-card", { has: page.locator(`[id="lib-${clipId}"]`) });
const tiktokRow = (page: Page, clipId: string) => cardOf(page, clipId).locator(".post", { has: page.locator(".post__name", { hasText: /^TikTok$/ }) });
/** The first Library card whose TikTok row says exactly `words`. */
async function clipWhoseRowSays(page: Page, words: string): Promise<string> {
  const card = page.locator(".lib-card", { has: page.locator(".post__status", { hasText: new RegExp(`^${words}$`) }) }).first();
  await expect(card).toBeVisible();
  return (await card.getAttribute("aria-labelledby"))!.replace("lib-", "");
}

test("settings: the switch, the Mac's check-in and Send these to my Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await go(page, "/settings/posting/tiktok-mac");
  await expect(page.getByText("Off. Your Mac doesn't post your TikTok clips.")).toBeVisible();
  await expect(page.getByText("Your Mac hasn't checked in yet. Set it up on your Mac.")).toBeVisible();
  await expect(page.getByText("To stop it, turn the switch off. Your Mac stops at once.")).toBeVisible();
  // Off: nothing to send.
  await expect(page.getByRole("button", { name: "Send these to my Mac" })).toHaveCount(0);

  await turnOn(page);
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("Posts when you tap Upload · 0 waiting")).toBeVisible();
  const line = page.getByText(/^\d+ clips? (isn't|aren't) on TikTok yet\.$/);
  await expect(line).toBeVisible();
  const n = Number((await line.innerText()).split(" ")[0]);
  expect(n).toBeGreaterThan(0);

  // One tap asks first; Not now sends nothing.
  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await expect(page.getByText("They go one at a time, oldest first.")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("Posts when you tap Upload · 0 waiting")).toBeVisible();

  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await page.getByRole("button", { name: "Yes, send them" }).click();
  await expect(page.getByText(`Sent ${n} clip${n === 1 ? "" : "s"} to your Mac.`)).toBeVisible();
  await expect(page.getByText(`Posts when you tap Upload · ${n} waiting`)).toBeVisible();
  await expect(page.getByText("0 clips aren't on TikTok yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send these to my Mac" })).toHaveCount(0);
  // The backlog goes one after each auto-posting run, not at once.
  expect((await mac.queue(page)).every((j) => j.source === "sent")).toBe(true);

  // The Mac checks in, then needs him.
  await mac.ping(page);
  await refocus(page);
  await expect(page.getByText(/^Your Mac checked in \w{3} \d\d:\d\d\.$/)).toBeVisible();
  await mac.ping(page, "needs_you", "TikTok wants you to log in again.");
  await refocus(page);
  await expect(page.getByText("Your Mac needs you: TikTok wants you to log in again.")).toBeVisible();

  // Off again: the Mac's queue is empty at once.
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByText("Off. Your Mac doesn't post your TikTok clips.")).toBeVisible();
  await expect.poll(async () => (await mac.queue(page)).length).toBe(0);
});

test("settings: the TikTok login on the Mac, Change and Forget (§47.8)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await go(page, "/settings/posting/tiktok-mac");
  // No Mac yet: nothing to change.
  await expect(page.getByRole("button", { name: "Change TikTok login" })).toHaveCount(0);
  await mac.ping(page);
  await mac.login(page, "saved");
  await refocus(page);
  await expect(page.getByText("Your TikTok login is kept in your Mac's Keychain, so your Mac logs back in to TikTok by itself.")).toBeVisible();

  await page.getByRole("button", { name: "Change TikTok login" }).click();
  await expect(page.getByText("Your Mac asks for the new login the next time it checks in, within a minute.")).toBeVisible();

  // Forget asks first; Not now leaves it.
  await page.getByRole("button", { name: "Forget TikTok login" }).click();
  await expect(page.getByText("Forget it? Then your Mac can't log back in to TikTok by itself.")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByRole("button", { name: "Forget TikTok login" }).click();
  await page.getByRole("button", { name: "Yes, forget it" }).click();
  await expect(page.getByText("Your Mac forgets the login the next time it checks in, within a minute.")).toBeVisible();

  // The Mac did it: no login kept, so there is nothing to forget.
  await mac.login(page, "none", true);
  await refocus(page);
  await expect(page.getByText("No TikTok login is kept on your Mac. If TikTok logs your Mac out, you log in again on the Mac.")).toBeVisible();
  await expect(page.getByText(/the next time it checks in/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Forget TikTok login" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change TikTok login" })).toBeVisible();
});

test("library: off, not set up, Post with my Mac, Posting…, Didn't work with Try again, and posted by your Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await go(page, "/library");
  // The switch is off: the row says so, with Turn on (a link) and nothing else.
  const clipId = await clipWhoseRowSays(page, "Your Mac posts TikTok is off");
  const row = tiktokRow(page, clipId);
  const status = row.locator(".post__status");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await row.getByRole("link", { name: "Turn on" }).click();
  await expect(page).toHaveURL(/\/settings\/posting\/tiktok-mac$/);
  await settle(page);
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");

  // On, but the Mac never checked in.
  await go(page, "/library");
  await expect(status).toHaveText("Your Mac isn't set up yet");
  await expect(row.getByRole("link", { name: "Turn on" })).toBeVisible();

  // It checks in: not on TikTok yet, with one Post with my Mac.
  await mac.ping(page);
  await refocus(page);
  await expect(status).toHaveText(/^(Not on TikTok yet|Only you can see it on TikTok)$/);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("link")).toHaveCount(0);
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(page.getByText("Sent to your Mac! It posts it in a minute.")).toBeVisible();
  // It goes at once and first, as an Upload tap's: its next check-in, within a minute.
  await expect(status).toHaveText(NEXT_AT);
  await expect(row.getByRole("button")).toHaveCount(0);
  expect((await mac.queue(page))[0]).toMatchObject({ clipId, source: "upload", state: "waiting" });

  // It works on it, live: Posting…, with no button.
  await mac.claim(page, clipId);
  await expect(status).toHaveText("Posting…");
  await expect(row.getByRole("button")).toHaveCount(0);
  await mac.step(page, clipId, "uploading");
  await expect(status).toHaveText("Posting…");

  // It stops: the reason's first sentence, and one Try again, which goes to the Mac at once.
  await mac.stopped(page, clipId, "TikTok wants you to log in again. Then it carries on.");
  await expect(status).toHaveText("Didn't work: TikTok wants you to log in again");
  await expect(row.getByRole("button")).toHaveCount(1);
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(status).toHaveText(NEXT_AT);

  // It pressed Post but could not confirm it: look on TikTok first; Try again says it is not there.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "pressing");
  await mac.stopped(page, clipId, "Timed out.");
  await expect(status).toHaveText("Didn't work: your Mac couldn't check it posted · look on your TikTok first");
  await expect(row.getByRole("button")).toHaveCount(1);
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(status).toHaveText(NEXT_AT);

  // Posted by the Mac: Everyone, with Open and its numbers, and no button.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "finding");
  await expect(status).toHaveText("Posting…");
  await mac.done(page, clipId, LINK);
  await expect(status).toHaveText(/^Posted by your Mac · Everyone · numbers in /);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("library: a backlog clip waits for auto-posting, a quiet Mac says since when, and the switch off says so", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const job = await sendAll(page);
  await mac.ping(page);
  await go(page, "/library");
  const row = tiktokRow(page, job.clipId);
  const status = row.locator(".post__status");
  // Sent from the backlog while auto-posting is off: it waits for auto-posting, with Turn on to it.
  await expect(status).toHaveText("Waiting for your Mac · auto-posting is off");
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/auto");
  await expect(row.getByRole("button")).toHaveCount(0);

  // Not seen for 30 minutes: since when, with Turn on to the switch.
  await mac.seen(page, new Date(Date.now() - 31 * 60_000).toISOString());
  await refocus(page);
  await expect(status).toHaveText(/^Your Mac hasn't checked in since (\w{3} )?\d\d:\d\d$/);
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");

  // The switch off: said, with Turn on.
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false");
  await go(page, "/library");
  await expect(status).toHaveText("Your Mac posts TikTok is off");
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("clip page: TikTok's stack says what the Mac does, and its one button sits in the actions", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac.ping(page);
  await go(page, "/library");
  const clipId = await clipWhoseRowSays(page, "Not on TikTok yet");
  await go(page, `/clips/${clipId}`);
  const stack = page.locator('[data-stack="tiktok"]');
  const calm = stack.locator(".pstack__calm-text");
  const actions = page.locator(".perf__actions");
  await expect(calm).toHaveText("Not on TikTok yet");
  await expect(stack.getByRole("link", { name: "Go to Library" })).toHaveCount(0);
  await actions.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(calm).toHaveText(NEXT_AT);
  await expect(actions.getByRole("button", { name: /Post with my Mac|Try again/ })).toHaveCount(0);

  await mac.claim(page, clipId);
  await expect(calm).toHaveText("Posting…");
  await expect(stack.locator(".pstack__chip")).toHaveText("Posting…");
  await mac.stopped(page, clipId, "TikTok wants you to log in again.");
  await expect(calm).toHaveText("Didn't work: TikTok wants you to log in again");
  await expect(stack.locator(".pstack__chip")).toHaveText("Didn't work");
  // Try again is right here: no Go to Library.
  await expect(stack.getByRole("link", { name: "Go to Library" })).toHaveCount(0);
  await actions.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(calm).toHaveText(NEXT_AT);

  // The switch off: said, with Turn on in the actions.
  await mac.claim(page, clipId);
  await mac.stopped(page, clipId, "Timed out.");
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await go(page, `/clips/${clipId}`);
  await expect(calm).toHaveText("Your Mac posts TikTok is off");
  await expect(actions.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
});

test("review: the hint, and Uploaded just now follows the Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ["youtube", "tiktok"]) s.finish(p);
    s.setAudit(false);
  });
  // Off: the hint says to turn it on.
  await go(page, "/review");
  await expect(page.locator(".review-card").first().locator(".tt-yourself-hint")).toHaveText("TikTok: turn on Your Mac posts TikTok so it posts for everyone.");

  await turnOn(page);
  await go(page, "/review");
  const card = page.locator(".review-card").first();
  const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
  const hook = await card.locator(".review-card__hook").innerText();
  await expect(card.locator(".tt-yourself-hint")).toHaveText("TikTok: your Mac posts it for everyone.");
  await card.getByRole("button", { name: "Use my settings" }).click();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const item = page.locator(".kept-now__item", { hasText: hook.slice(0, 20) });
  const line = item.locator(".kept-now__mac");
  // The Mac never checked in: said, with Turn on.
  await expect(line).toHaveText("TikTok: Your Mac isn't set up yet");
  await expect(item.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  // Nothing of Clip Factory's own goes to TikTok's API, and no sheet.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const posts = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.posts(id), clipId);
  expect(posts.find((p) => p.platform === "tiktok")?.status).toBe("mac");
  expect(posts.find((p) => p.platform === "youtube")?.status).toBe("queued");

  // It checks in, then posts it, live.
  await mac.ping(page);
  await refocus(page);
  await expect(line).toHaveText(/^TikTok: Waiting for your Mac · next at (\w{3} )?\d\d:\d\d$/);
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "uploading");
  await expect(line).toHaveText("TikTok: Posting…");
  await mac.done(page, clipId);
  await expect(line).toHaveText("TikTok: Posted by your Mac · Everyone");
});

test("review: uploaded without TikTok, Uploaded just now offers Post with my Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac.ping(page);
  await go(page, "/review");
  const card = page.locator(".review-card").first();
  const hook = await card.locator(".review-card__hook").innerText();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const item = page.locator(".kept-now__item", { hasText: hook.slice(0, 20) });
  await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Not on TikTok yet");
  await item.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(item.locator(".kept-now__mac")).toHaveText(/^TikTok: Waiting for your Mac · next at (\w{3} )?\d\d:\d\d$/);
  await expect(item.getByRole("button", { name: "Post with my Mac" })).toHaveCount(0);
});
