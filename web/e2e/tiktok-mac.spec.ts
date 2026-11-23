// Your Mac posts it on TikTok (docs/CONTRACTS.md §47) in mock mode: Settings › Posting › Your Mac posts TikTok (the
// switch, the Mac's check-in, Send these to my Mac), and the TikTok row on the Library, the clip page and Review's
// Uploaded just now, which says only what the Mac is doing, with at most one button (§47.4, ADR-85): Waiting for your
// Mac, Posting…, Didn't work with Try again, It's on TikTok (with Try again second) once the Mac pressed Post, Posted
// by your Mac, Not on TikTok yet with Post with my Mac, Turn on while the Mac can't post, and Open Your Mac posts
// TikTok while it needs him or is paused. The Mac is moved by the helper's knobs (window.__cfMock.mac). The pretend
// app keeps its settings and posts in this page only, so every step after the first page is an in-app navigation.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

type Job = { clipId: string; postId: string; hook: string; state: string; source: string; privacy: string; comment: boolean; duet: boolean; stitch: boolean };
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
/** An Upload tap's clip (and Post with my Mac, and Try again): the Mac takes it at its next check-in. */
const CHECK_IN = "Waiting for your Mac · next check-in in about a minute";
const PRESSED = "Didn't work: your Mac couldn't tell if it posted · look on your TikTok first";
const OPEN_MAC = "Open Your Mac posts TikTok";

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
  await expect(status).toHaveText(CHECK_IN);
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
  await expect(status).toHaveText(CHECK_IN);

  // It pressed Post but couldn't tell if it posted: look on TikTok first. It's on TikTok, or Try again (second), which
  // says it is not there.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "pressing");
  await mac.stopped(page, clipId, "Timed out.");
  await expect(status).toHaveText(PRESSED);
  await expect(row.getByRole("button")).toHaveCount(2);
  await expect(row.getByRole("button", { name: "It's on TikTok" })).toBeVisible();
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(status).toHaveText(CHECK_IN);

  // Posted by the Mac: Everyone, with Open and its numbers, and no button.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "finding");
  await expect(status).toHaveText("Posting…");
  await mac.done(page, clipId, LINK);
  await expect(status).toHaveText(/^Posted by your Mac · Everyone · numbers in /);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("button")).toHaveCount(0);
});

/** Switched on and checked in, a clip that isn't on TikTok yet sent with Post with my Mac: its id and TikTok row. */
async function sentWithMyMac(page: Page) {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac.ping(page);
  await go(page, "/library");
  const clipId = await clipWhoseRowSays(page, "Not on TikTok yet");
  const row = tiktokRow(page, clipId);
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(row.locator(".post__status")).toHaveText(CHECK_IN);
  return { clipId, row, status: row.locator(".post__status") };
}

test("library: the Mac pressed Post but couldn't tell: It's on TikTok saves its link, Try again comes second", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "pressing");
  await mac.stopped(page, clipId, "Timed out.");
  await expect(status).toHaveText(PRESSED);
  // Two choices, It's on TikTok first; the link box opens only on a tap.
  const onTikTok = row.getByRole("button", { name: "It's on TikTok" });
  const again = row.getByRole("button", { name: "Try again, TikTok" });
  await expect(row.getByRole("button")).toHaveCount(2);
  const [a, b] = [await onTikTok.boundingBox(), await again.boundingBox()];
  expect(a!.x).toBeLessThan(b!.x);
  await expect(onTikTok).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByRole("textbox")).toHaveCount(0);

  // Each one shows it can be pressed (hover), and the cursor stays the arrow.
  const plain = await onTikTok.evaluate((el) => getComputedStyle(el).backgroundColor);
  await onTikTok.hover();
  await expect.poll(() => onTikTok.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(plain);
  const ghost = await again.evaluate((el) => getComputedStyle(el).backgroundColor);
  await again.hover();
  await expect.poll(() => again.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(ghost);

  await onTikTok.click();
  await expect(onTikTok).toHaveAttribute("aria-expanded", "true");
  const box = row.getByRole("textbox", { name: "TikTok link" });
  await expect(box).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await box.fill(LINK);
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Link saved! Clip Factory will count its views.")).toBeVisible();
  await expect(status).toHaveText(/^Posted by you · Everyone( · numbers .+)?$/);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("button")).toHaveCount(0);
  // Nothing went to the Mac again: no second post.
  expect((await mac.queue(page)).some((j) => j.clipId === clipId)).toBe(false);
});

test("library: a post left Posting… says so once the Mac can't post (asleep, or the switch off), never a spinner for good", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await mac.claim(page, clipId);
  await expect(status).toHaveText("Posting…");
  await expect(row.locator(".spinner")).toHaveCount(1);
  // The Mac fell asleep mid-post: not seen for 30 minutes.
  await mac.seen(page, new Date(Date.now() - 31 * 60_000).toISOString());
  await refocus(page);
  await expect(status).toHaveText(/^Your Mac hasn't checked in since (\w{3} )?\d\d:\d\d$/);
  await expect(row.locator(".spinner")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");

  // The switch turned off while it was working.
  await mac.ping(page);
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false");
  await go(page, "/library");
  await expect(status).toHaveText("Your Mac posts TikTok is off");
  await expect(row.locator(".spinner")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
});

test("library: the Mac needs him, or is paused: what to do, and Open Your Mac posts TikTok under the words", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac.ping(page, "needs_you", "TikTok wants you to log in again.");
  await go(page, "/library");
  const clipId = await clipWhoseRowSays(page, "Your Mac needs you: TikTok wants you to log in again · look at your Mac");
  const row = tiktokRow(page, clipId);
  const open = row.getByRole("link", { name: OPEN_MAC });
  await expect(open).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await expect(row.getByRole("button")).toHaveCount(0);
  // Its own line, under the words, on the right of the row.
  const [words, link, li] = [await row.locator(".post__status").boundingBox(), await open.boundingBox(), await row.boundingBox()];
  expect(link!.y).toBeGreaterThanOrEqual(words!.y + words!.height - 1);
  expect(li!.x + li!.width - (link!.x + link!.width)).toBeLessThan(16);

  await mac.ping(page, "paused");
  await refocus(page);
  await expect(row.locator(".post__status")).toHaveText("Your Mac is paused · start it again on your Mac");
  await expect(open).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await open.click();
  await expect(page).toHaveURL(/\/settings\/posting\/tiktok-mac$/);
});

test("library: auto-posting off, a backlog clip goes now with Post with my Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const job = await sendAll(page);
  await mac.ping(page);
  await go(page, "/library");
  const row = tiktokRow(page, job.clipId);
  const status = row.locator(".post__status");
  await expect(status).toHaveText("Waiting for your Mac · auto-posting is off");
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(page.getByText("Sent to your Mac! It posts it in a minute.")).toBeVisible();
  await expect(status).toHaveText(CHECK_IN);
  await expect(row.getByRole("button")).toHaveCount(0);
  // It goes first, as an Upload tap's; the rest of the backlog still waits for auto-posting.
  const queue = await mac.queue(page);
  expect(queue.find((j) => j.clipId === job.clipId)).toMatchObject({ source: "upload", state: "waiting" });
  expect(queue.filter((j) => j.clipId !== job.clipId).every((j) => j.source === "sent")).toBe(true);
});

/** The clip Clip Factory uploaded "Only me" on TikTok: its row has the post's Open while the switch is off. */
async function privateClip(page: Page): Promise<string> {
  const card = page
    .locator(".lib-card", {
      has: page
        .locator(".post", { has: page.locator(".post__status", { hasText: /^Your Mac posts TikTok is off$/ }) })
        .filter({ has: page.getByRole("link", { name: "Open the TikTok post" }) }),
    })
    .first();
  await expect(card).toBeVisible();
  return (await card.getAttribute("aria-labelledby"))!.replace("lib-", "");
}

for (const width of [1440, 375]) {
  test(`library at ${width}: a private upload is not lit green, and its button sits right of the words with Open under it`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/library");
    await settle(page);
    // The switch is off: Turn on, and the post's Open.
    const row = tiktokRow(page, await privateClip(page));
    await expect(row.locator(".post__status")).toHaveText("Your Mac posts TikTok is off");
    await expect(row).not.toHaveClass(/is-posted/);
    const button = row.getByRole("link", { name: "Turn on" });
    const open = row.getByRole("link", { name: "Open the TikTok post" });
    const [mark, text, b, o] = [
      await row.locator(".post__mark").boundingBox(),
      await row.locator(".post__text").boundingBox(),
      await button.boundingBox(),
      await open.boundingBox(),
    ];
    // The mark keeps its own size, the words start right after it, the button is right of the words (on their line),
    // and Open sits under the button, on the right.
    expect(mark!.width).toBeLessThan(40);
    expect(text!.x - (mark!.x + mark!.width)).toBeLessThan(16);
    expect(b!.x).toBeGreaterThanOrEqual(text!.x + text!.width - 1);
    expect(b!.y).toBeLessThan(text!.y + text!.height);
    expect(o!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 1);
    expect(Math.abs(o!.x + o!.width - (b!.x + b!.width))).toBeLessThan(2);
    // Words get at least a third of the row.
    expect(text!.width).toBeGreaterThan((await row.boundingBox())!.width / 3);

    // On, checked in: Only you can see it, with Post with my Mac; still not green.
    await turnOn(page);
    await mac.ping(page);
    await go(page, "/library");
    await expect(row.locator(".post__status")).toHaveText("Only you can see it on TikTok");
    await expect(row).not.toHaveClass(/is-posted/);
    const post = await row.getByRole("button", { name: "Post with my Mac" }).boundingBox();
    const words = await row.locator(".post__text").boundingBox();
    expect(post!.x).toBeGreaterThanOrEqual(words!.x + words!.width - 1);
    expect(post!.y).toBeLessThan(words!.y + words!.height);
  });
}

test("library: a backlog clip waits for auto-posting, a quiet Mac says since when, and the switch off says so", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const job = await sendAll(page);
  await mac.ping(page);
  await go(page, "/library");
  const row = tiktokRow(page, job.clipId);
  const status = row.locator(".post__status");
  // Sent from the backlog while auto-posting is off: it would wait for good, so Post with my Mac sends this one now.
  await expect(status).toHaveText("Waiting for your Mac · auto-posting is off");
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Post with my Mac" })).toBeVisible();

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
  await expect(calm).toHaveText(CHECK_IN);
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
  await expect(calm).toHaveText(CHECK_IN);

  // The switch off: said, with Turn on in the actions.
  await mac.claim(page, clipId);
  await mac.stopped(page, clipId, "Timed out.");
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await go(page, `/clips/${clipId}`);
  await expect(calm).toHaveText("Your Mac posts TikTok is off");
  await expect(actions.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
});

test("review: the hint, TikTok on My settings with no tap, and Uploaded just now follows the Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ["youtube", "tiktok"]) s.finish(p);
    s.setAudit(false);
  });
  // Off: the hint says to turn it on, with Turn on right beside it.
  await go(page, "/review");
  const off = page.locator(".review-card").first();
  await expect(off.locator(".tt-yourself-hint")).toHaveText("TikTok: turn on Your Mac posts TikTok so it posts for everyone.");
  await expect(off.locator(".tt-yourself-hint-row").getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  // Off, TikTok's API rule (§17.8): nothing picked for TikTok, and Upload waits for his tap.
  await expect(off.locator('[data-place="tiktok"] summary')).toContainText("Who can see it: not picked yet");
  await expect(off.locator(".upload-going")).toHaveText("Tap Use my settings first. TikTok needs your tap.");

  await turnOn(page);
  await go(page, "/review");
  const card = page.locator(".review-card").first();
  const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
  const hook = await card.locator(".review-card__hook").innerText();
  await expect(card.locator(".tt-yourself-hint")).toHaveText("TikTok: your Mac posts it for everyone.");
  await expect(card.getByRole("link", { name: "Turn on" })).toHaveCount(0);
  // On: TikTok starts on My settings like every other place (Everyone, all three on), with no tap before Upload.
  await expect(card.getByRole("button", { name: "Your settings are on" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Use my settings" })).toHaveCount(0);
  await expect(card.locator(".my-settings__note")).toHaveText("Every place uses your settings. Tap a place below to change it for this clip.");
  const tiktokNow = card.locator('[data-place="tiktok"] .place-row__now');
  await expect(tiktokNow).toContainText("Who can see it: Everyone · Comments on · Duet on · Stitch on");
  await expect(tiktokNow).not.toContainText("not picked yet");
  // Its row is read-only for what the Mac uses (§47.9): the Mac posts My settings, so no per-clip privacy or switches.
  await card.locator('[data-place="tiktok"] summary').click();
  const ttRow = card.locator('[data-place="tiktok"]');
  await expect(ttRow.locator(".tt-mac-uses")).toContainText("Your Mac posts it with My settings: Everyone · Comments on · Duet on · Stitch on");
  await expect(ttRow.getByRole("link", { name: "Change My settings" })).toHaveAttribute("href", "/settings/posting/my-settings");
  await expect(ttRow.locator('[aria-haspopup="listbox"]')).toHaveCount(0);
  await expect(ttRow.getByRole("switch")).toHaveCount(1);
  // Branded content waits: the Mac can't add TikTok's label yet.
  await ttRow.getByRole("switch", { name: "Commercial content" }).click();
  await ttRow.getByRole("checkbox", { name: /^Branded content/ }).click();
  const held = "Your Mac can't add TikTok's Branded content label yet. Untick it, or untick TikTok for this clip.";
  await expect(card.locator(".upload-going")).toHaveText(held);
  await expect(ttRow.getByRole("alert")).toHaveText(held);
  await ttRow.getByRole("checkbox", { name: /^Branded content/ }).click();
  await ttRow.getByRole("switch", { name: "Commercial content" }).click();
  await expect(card.locator(".upload-going")).toHaveText("Going to: YouTube · TikTok");
  const upload = card.getByRole("button", { name: /^Upload( to .+)?$/ });
  await expect(upload).not.toHaveAttribute("aria-disabled", "true");
  await upload.click();
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
  // The Mac's job: Everyone, with Comment, Duet and Stitch on.
  expect((await mac.queue(page)).find((j) => j.clipId === clipId)).toMatchObject({ privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: true });

  // It checks in, then posts it, live.
  await mac.ping(page);
  await refocus(page);
  await expect(line).toHaveText(`TikTok: ${CHECK_IN}`);
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "uploading");
  await expect(line).toHaveText("TikTok: Posting…");
  await mac.done(page, clipId);
  await expect(line).toHaveText("TikTok: Posted by your Mac · Everyone");
  // Its Open link, as on Library.
  await expect(item.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", /tiktok\.com/);
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
  await expect(item.locator(".kept-now__mac")).toHaveText(`TikTok: ${CHECK_IN}`);
  await expect(item.getByRole("button", { name: "Post with my Mac" })).toHaveCount(0);
});
