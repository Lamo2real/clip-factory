// Your Mac posts it on TikTok (docs/CONTRACTS.md §47) in mock mode: Settings › Posting › Your Mac posts TikTok (the
// switch, the Mac's check-in with Start my Mac again, Open the stopped clip and Let them go, Send these to my Mac), and
// the TikTok row on the Library, the clip page and Review's Uploaded just now, which says only what the Mac is doing,
// with at most one button (§47.4, ADR-86): Waiting for your Mac (its place in the Mac's queue, or the backlog's own
// time), Posting… (never Not sure it posted while the Mac works on it), Didn't work with Try again, Not sure it posted
// (pressed and stopped, or stuck) with It's on TikTok and, once the Mac stopped looking, a quieter Try again that asks
// first, Posted by your Mac, Not on TikTok yet with Post with my Mac, a campaign clip that skips TikTok for now, Turn on
// while the Mac can't post, Open the stopped clip while it needs him, and Start my Mac again while it is paused. On a
// narrow card the button goes under the words. The Mac is moved by the helper's knobs (window.__cfMock.mac). The
// pretend app keeps its settings and posts in this page only, so every step after the first page is an in-app
// navigation.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";
import { clockWords } from "../src/lib/tiktokMac.ts";

type Job = {
  clipId: string;
  postId: string;
  hook: string;
  state: string;
  source: string;
  privacy: string;
  comment: boolean;
  duet: boolean;
  stitch: boolean;
  pressedBefore?: string;
  againAt?: string;
};
type Extra = { backlogAt?: string; backfill?: boolean; holdBefore?: string; resumeDone?: string; letGoDone?: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { posts(clipId: string): { postId: string; platform: string; status: string }[]; campaignClip(): string };
    mac: {
      ping(state?: string, reason?: string, device?: string, extra?: Extra): { on: boolean };
      seen(at: string | null): void;
      login(login: "saved" | "none", done?: boolean): void;
      claim(clipId: string, device?: string, agoMs?: number): Job;
      step(clipId: string, step: string, device?: string, agoMs?: number): Job;
      beat(clipId: string, agoMs?: number): Job;
      done(clipId: string, link?: string): unknown;
      stopped(clipId: string, reason: string, needsYou?: boolean): Job;
      queue(): Job[];
      source(clipId: string, source: string, sinceAgoMs?: number): unknown;
    };
  };
};

const LINK = "https://www.tiktok.com/@lamo.clips/video/7710644811602169121";
const MIN = 60_000;
/** First in the Mac's queue (an Upload tap's, Post with my Mac, Try again): the Mac takes it next. */
const NEXT = "Waiting for your Mac · next";
const PRESSED = "Not sure it posted · look on your TikTok";
/** Inside the 30-minute find window after Post: from when Try again comes. */
const PRESSED_WAIT = /^Not sure it posted · look on your TikTok · Try again from (?:\w{3} )?\d\d:\d\d$/;
const STOPPED_EARLY = "Your Mac stopped before it pressed Post";
const AGAIN_ASK = "Post it again? Only if it's not on your TikTok.";
const OPEN_MAC = "Open Your Mac posts TikTok";
const CAMPAIGN = "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet.";
/** Post was pressed this long ago: the Mac's 30-minute find window is over, so Try again shows. */
const WINDOW_OVER = 31 * MIN;

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
  ping: (page: Page, state?: string, reason?: string, extra?: Extra) =>
    page.evaluate(([s, r, x]) => (window as MockWindow).__cfMock!.mac.ping(s, r, undefined, x), [state, reason, extra] as const),
  seen: (page: Page, at: string | null) => page.evaluate((t) => (window as MockWindow).__cfMock!.mac.seen(t), at),
  /** `agoMs`: the claim (and its beat) was made that long ago (a helper that lost track of it: stuck after 5 minutes). */
  claim: (page: Page, clipId: string, agoMs = 0) =>
    page.evaluate(([id, ago]) => (window as MockWindow).__cfMock!.mac.claim(id, undefined, ago), [clipId, agoMs] as const),
  /** `agoMs`: the step (and Post's press) was that long ago. */
  step: (page: Page, clipId: string, step: string, agoMs = 0) =>
    page.evaluate(([id, st, ago]) => (window as MockWindow).__cfMock!.mac.step(id, st, undefined, ago), [clipId, step, agoMs] as const),
  beat: (page: Page, clipId: string, agoMs = 0) => page.evaluate(([id, ago]) => (window as MockWindow).__cfMock!.mac.beat(id, ago), [clipId, agoMs] as const),
  stopped: (page: Page, clipId: string, reason: string, needsYou = false) =>
    page.evaluate(([id, r, n]) => (window as MockWindow).__cfMock!.mac.stopped(id, r, n), [clipId, reason, needsYou] as const),
  done: (page: Page, clipId: string, link?: string) =>
    page.evaluate(([id, l]) => void (window as MockWindow).__cfMock!.mac.done(id, l), [clipId, link] as const),
  queue: (page: Page) => page.evaluate(() => (window as MockWindow).__cfMock!.mac.queue()),
  login: (page: Page, login: "saved" | "none", done?: boolean) =>
    page.evaluate(([l, d]) => (window as MockWindow).__cfMock!.mac.login(l, d), [login, done] as const),
  source: (page: Page, clipId: string, source: string, sinceAgoMs?: number) =>
    page.evaluate(([id, s, ago]) => void (window as MockWindow).__cfMock!.mac.source(id, s, ago), [clipId, source, sinceAgoMs] as const),
};

/** "14:05", the owner's own clock time, as the rows say it for today. */
const hm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** The rows' own words for a time: "14:05" today, with the day in front once it is another day ("Tue 00:18"), as
 * clockWords says it. A run near midnight crosses the day, and a bare clock time would then be wrong. */
const rowTime = (t: number) => clockWords(t, Date.now());

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
  await expect(page.getByText(/^Sent \d+ clips? to your Mac\./)).toBeVisible();
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
  // Never a dead end: how to set it up, right under it.
  const setUp = page.locator('[data-mac="setup"]');
  await expect(setUp).toContainText("./install.sh --no-start");
  await expect(setUp).toContainText("Log in to TikTok and to Clip Factory in the window that opens.");
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
  // The Mac never checked in: they wait for it, and the page says so before and after.
  await expect(page.getByText("They wait until your Mac checks in.")).toBeVisible();
  await page.getByRole("button", { name: "Yes, send them" }).click();
  await expect(page.getByText(`Sent ${n} clip${n === 1 ? "" : "s"} to your Mac. They wait until your Mac checks in.`)).toBeVisible();
  await expect(page.getByText(`Posts when you tap Upload · ${n} waiting`)).toBeVisible();
  await expect(page.getByText(`${n} clip${n === 1 ? " already waits" : "s already wait"} for your Mac.`)).toBeVisible();
  await expect(page.getByText("0 clips aren't on TikTok yet.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send these to my Mac" })).toHaveCount(0);
  // The backlog goes one after each auto-posting run, not at once.
  expect((await mac.queue(page)).every((j) => j.source === "sent")).toBe(true);

  // The Mac checks in, then needs him.
  await mac.ping(page);
  await refocus(page);
  await expect(page.getByText(/^Your Mac checked in \w{3} \d\d:\d\d\.$/)).toBeVisible();
  await expect(setUp).toHaveCount(0);
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

test("settings: the Mac's hold with Let them go, Start my Mac again, and Open the stopped clip (D5)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  // It holds auto-posting clips made before a time: said, with Let them go.
  const hold = Date.now() - 60 * MIN;
  await mac.ping(page, "ok", undefined, { holdBefore: new Date(hold).toISOString() });
  await refocus(page);
  await expect(page.locator("[data-mac='hold']")).toHaveText(new RegExp(`^Your Mac holds auto-posting clips made before \\w{3} ${hm(hold)}\\.$`));
  await page.getByRole("button", { name: "Let them go" }).click();
  await expect(page.getByText("Your Mac lets them go within a minute.")).toBeVisible();
  await expect(page.getByText("Your Mac lets them go the next time it checks in, within a minute.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Let them go" })).toHaveCount(0);
  // The Mac let them go: its ping holds nothing.
  await mac.ping(page);
  await refocus(page);
  await expect(page.locator("[data-mac='hold']")).toHaveCount(0);
  await expect(page.getByText(/lets them go the next time/)).toHaveCount(0);

  // Paused: Start my Mac again, right under its line.
  await mac.ping(page, "paused");
  await refocus(page);
  await expect(page.getByText("Paused on your Mac. Your clips wait until it's started again.")).toBeVisible();
  await page.getByRole("button", { name: "Start my Mac again" }).click();
  await expect(page.getByText("Your Mac starts again within a minute.")).toBeVisible();
  await expect(page.getByText("Your Mac starts again the next time it checks in, within a minute.")).toBeVisible();

  // It needs him on one clip: Open the stopped clip goes straight to it.
  await mac.ping(page);
  await go(page, "/library");
  const target = await clipWhoseRowSays(page, "Not on TikTok yet");
  await tiktokRow(page, target).getByRole("button", { name: "Post with my Mac" }).click();
  await expect(tiktokRow(page, target).locator(".post__status")).toHaveText(NEXT);
  await go(page, "/settings/posting/tiktok-mac");
  await mac.claim(page, target);
  await mac.stopped(page, target, "TikTok wants a code. Type it on your Mac.", true);
  await refocus(page);
  await expect(page.getByText("Your Mac needs you: TikTok wants a code. Type it on your Mac.")).toBeVisible();
  const open = page.getByRole("link", { name: "Open the stopped clip" });
  await expect(open).toHaveAttribute("href", `/clips/${target}`);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/clips/${target}$`));
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

  // On, but the Mac never checked in: its page (with the setup steps), never Turn on (the switch is on).
  await go(page, "/library");
  await expect(status).toHaveText("Your Mac isn't set up yet");
  await expect(row.getByRole("link", { name: OPEN_MAC })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveCount(0);

  // It checks in: not on TikTok yet, with one Post with my Mac.
  await mac.ping(page);
  await refocus(page);
  await expect(status).toHaveText(/^(Not on TikTok yet|Only you can see it on TikTok)$/);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("link")).toHaveCount(0);
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(page.getByText("Sent to your Mac! It posts it in a minute.")).toBeVisible();
  // It goes at once and first, as an Upload tap's: next in the Mac's queue.
  await expect(status).toHaveText(NEXT);
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
  await expect(status).toHaveText(NEXT);

  // It pressed Post (over 30 minutes ago) but couldn't tell if it posted: look on TikTok first. It's on TikTok, or Try
  // again (second), which asks first, then says it is not there.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "pressing", WINDOW_OVER);
  await mac.stopped(page, clipId, "Timed out.");
  await expect(status).toHaveText(PRESSED);
  await expect(row.getByRole("button")).toHaveCount(2);
  await expect(row.getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(row.getByText(AGAIN_ASK)).toBeVisible();
  await row.getByRole("button", { name: "Yes, post it again" }).click();
  await expect(page.getByText("Sent to your Mac again.")).toBeVisible();
  await expect(status).toHaveText(NEXT);
  await expect(row.getByText(AGAIN_ASK)).toHaveCount(0);
  // The Mac's never-twice guard sees the press it had, and when he tapped Try again.
  expect((await mac.queue(page)).find((j) => j.clipId === clipId)).toMatchObject({ pressedBefore: expect.any(String), againAt: expect.any(String) });

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
  await expect(row.locator(".post__status")).toHaveText(NEXT);
  return { clipId, row, status: row.locator(".post__status") };
}

/** The Mac claimed it, pressed Post `pressedAgoMs` ago and stopped: not sure it posted. */
async function pressedAndStopped(page: Page, clipId: string, pressedAgoMs: number, needsYou = false) {
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "pressing", pressedAgoMs);
  await mac.stopped(page, clipId, needsYou ? "TikTok logged your Mac out." : "Timed out.", needsYou);
}

test("library: not sure it posted: It's on TikTok saves its link, a quieter Try again comes second and asks first", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await pressedAndStopped(page, clipId, WINDOW_OVER);
  await expect(status).toHaveText(PRESSED);
  // Two choices, It's on TikTok first; the link box opens only on a tap.
  const onTikTok = row.getByRole("button", { name: "It's on TikTok", exact: true });
  const again = row.getByRole("button", { name: "Try again, TikTok" });
  await expect(row.getByRole("button")).toHaveCount(2);
  const [a, b] = [await onTikTok.boundingBox(), await again.boundingBox()];
  expect(a!.x).toBeLessThan(b!.x);
  await expect(onTikTok).toHaveAttribute("aria-expanded", "false");
  await expect(row.getByRole("textbox")).toHaveCount(0);

  // Try again looks quieter than It's on TikTok: no fill of its own, its words underlined (never the same button).
  // Measured at rest: the pointer still sits where Post with my Mac was tapped, and Try again is drawn right under it,
  // so on a slow runner its hover (It's on TikTok's fill, on purpose) had landed by now; the hover is checked below.
  await page.mouse.move(0, 0);
  await expect.poll(() => again.evaluate((el) => el.matches(":hover"))).toBe(false);
  const look = (el: Element) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundImage === "none" ? s.backgroundColor : s.backgroundImage, line: s.textDecorationLine, shadow: s.boxShadow };
  };
  const [loud, quiet] = [await onTikTok.evaluate(look), await again.evaluate(look)];
  expect(quiet.bg).not.toBe(loud.bg);
  expect(quiet.line).toBe("underline");
  expect(loud.line).not.toBe("underline");
  expect(quiet.shadow).toBe("none");

  // Each one shows it can be pressed (hover), and the cursor stays the arrow.
  const plain = await onTikTok.evaluate((el) => getComputedStyle(el).backgroundColor);
  await onTikTok.hover();
  await expect.poll(() => onTikTok.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(plain);
  const ghost = await again.evaluate((el) => getComputedStyle(el).backgroundColor);
  await again.hover();
  await expect.poll(() => again.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(ghost);
  for (const b of [onTikTok, again]) expect(await b.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");

  // Try again asks first, the question starting where the row's words start; Not now leaves it, and nothing goes.
  await again.click();
  await expect(row.getByText(AGAIN_ASK)).toBeVisible();
  const [ask, words] = [await row.getByText(AGAIN_ASK).boundingBox(), await row.locator(".post__text").boundingBox()];
  expect(Math.abs(ask!.x - words!.x)).toBeLessThan(2);
  await expect(row.getByRole("button", { name: "Yes, post it again" })).toBeFocused();
  await row.getByRole("button", { name: "Not now" }).click();
  await expect(row.getByText(AGAIN_ASK)).toHaveCount(0);
  await expect(status).toHaveText(PRESSED);
  expect((await mac.queue(page)).some((j) => j.clipId === clipId)).toBe(false);

  await onTikTok.click();
  await expect(onTikTok).toHaveAttribute("aria-expanded", "true");
  const box = row.getByRole("textbox", { name: "TikTok link" });
  await expect(box).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Find it for me sits right next to the link box (no link needed).
  const find = row.getByRole("button", { name: "Find it for me" });
  await expect(find).toBeVisible();
  const [bx, f] = [await box.boundingBox(), await find.boundingBox()];
  expect(Math.abs(f!.y + f!.height / 2 - (bx!.y + bx!.height / 2)) < 4 || f!.y >= bx!.y + bx!.height - 1).toBe(true);
  // An empty box sends nothing: it says to paste the link or find it.
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(row.getByRole("alert")).toHaveText("Paste the link first, or tap Find it for me.");
  await expect(status).toHaveText(PRESSED);
  await box.fill(LINK);
  await row.getByRole("button", { name: "Save the link" }).click();
  await expect(page.getByText("Link saved! Clip Factory will count its views.")).toBeVisible();
  await expect(status).toHaveText(/^Posted by you · Everyone( · numbers .+)?$/);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("button")).toHaveCount(0);
  // Nothing went to the Mac again: no second post.
  expect((await mac.queue(page)).some((j) => j.clipId === clipId)).toBe(false);
});

test("library: inside the Mac's 30-minute find window after Post there is no Try again, only It's on TikTok, and the row says from when", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await pressedAndStopped(page, clipId, 10 * MIN);
  await expect(status).toHaveText(PRESSED_WAIT);
  // From 30 minutes after Post (20 from now, give or take the minute it is).
  const said = (await status.innerText()).slice(-5);
  expect([rowTime(Date.now() + 20 * MIN), rowTime(Date.now() + 19 * MIN), rowTime(Date.now() + 21 * MIN)]).toContain(said);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Try again, TikTok" })).toHaveCount(0);
});

test("library: Find it for me that finds nothing saves nothing; the next look finds it, and the Mac that needed him goes on", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await pressedAndStopped(page, clipId, 10 * MIN, true);
  await expect(status).toHaveText(PRESSED_WAIT);
  await row.getByRole("button", { name: "It's on TikTok", exact: true }).click();
  await row.getByRole("button", { name: "Find it for me" }).click();
  // Not found yet: said in the row, and nothing was saved.
  await expect(row.getByRole("alert")).toHaveText("Not found yet. Try again in a minute, or paste the link.");
  await expect(status).toHaveText(PRESSED_WAIT);
  await expect(page.getByText(/^Saved\./)).toHaveCount(0);
  await row.getByRole("button", { name: "Find it for me" }).click();
  await expect(page.getByText("Found it on your TikTok! Clip Factory will count its views.")).toBeVisible();
  await expect(status).toHaveText(/^Posted by you · Everyone( · numbers .+)?$/);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toBeVisible();
  // It answered the stopped post: the Mac is fine again (as after Try again).
  await go(page, "/settings/posting/tiktok-mac");
  await expect(page.getByText(/^Your Mac checked in /)).toBeVisible();
  await expect(page.getByText(/^Your Mac needs you/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the stopped clip" })).toHaveCount(0);
});

test("library: It's on TikTok, no link asks first, then saves it without its link", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await pressedAndStopped(page, clipId, 10 * MIN);
  await row.getByRole("button", { name: "It's on TikTok", exact: true }).click();
  const noLink = row.getByRole("button", { name: "It's on TikTok, no link" });
  await expect(noLink).toBeVisible();
  await noLink.click();
  const ask = "Save it as on TikTok without its link? Its views show once you add the link.";
  await expect(row.getByText(ask)).toBeVisible();
  await expect(row.getByRole("button", { name: "Yes, it's on TikTok" })).toBeFocused();
  // Not now: back to the link box, nothing saved.
  await row.getByRole("button", { name: "Not now" }).click();
  await expect(row.getByText(ask)).toHaveCount(0);
  await expect(row.getByRole("textbox", { name: "TikTok link" })).toBeVisible();
  await expect(status).toHaveText(PRESSED_WAIT);
  await row.getByRole("button", { name: "It's on TikTok, no link" }).click();
  await row.getByRole("button", { name: "Yes, it's on TikTok" }).click();
  await expect(page.getByText("Saved. Add its link later to see its views.")).toBeVisible();
  await expect(status).toHaveText("Posted by you · Everyone · add the link");
  // Its Add link has no no-link button: it is saved already.
  await expect(row.getByRole("button", { name: "It's on TikTok, no link" })).toHaveCount(0);
  expect((await mac.queue(page)).some((j) => j.clipId === clipId)).toBe(false);
});

test("library: Posting… while the Mac beats, even long after its claim; stuck before Post once its beat is 5 minutes old: Try again only", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  // Claimed 40 minutes ago (upload wait, Post, the find window), its beat a minute ago: still the Mac's.
  await mac.claim(page, clipId, 40 * MIN);
  await mac.beat(page, clipId, MIN);
  await expect(status).toHaveText("Posting…");
  await expect(row.locator(".spinner")).toHaveCount(1);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(PRESSED)).toHaveCount(0);
  // Its beat 6 minutes old (the helper crashed or lost track of it), while the Mac checks in.
  await mac.beat(page, clipId, 6 * MIN);
  await mac.ping(page);
  await refocus(page);
  // Post was never pressed, so it can't be on TikTok: said so, with Try again only (no It's on TikTok, no question).
  await expect(status).toHaveText(STOPPED_EARLY);
  await expect(row.locator(".spinner")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("button", { name: "It's on TikTok", exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(row.getByText(AGAIN_ASK)).toHaveCount(0);
  await expect(status).toHaveText(NEXT);
  // Back in line, so the Mac claims it afresh.
  expect((await mac.queue(page)).find((j) => j.clipId === clipId)).toMatchObject({ state: "waiting", source: "upload" });
  await mac.claim(page, clipId);
  await expect(status).toHaveText("Posting…");
});

test("library: Upload taps say their place in the Mac's queue, one at a time", async ({ page }) => {
  const { clipId: first, status } = await sentWithMyMac(page);
  const second = await clipWhoseRowSays(page, "(Not on TikTok yet|Only you can see it on TikTok)");
  await tiktokRow(page, second).getByRole("button", { name: "Post with my Mac" }).click();
  await expect(tiktokRow(page, second).locator(".post__status")).toHaveText("Waiting for your Mac · in line (1 before it)");
  await expect(status).toHaveText(NEXT);
  // The first one is on the Mac now: the second still waits behind it.
  await mac.claim(page, first);
  await expect(status).toHaveText("Posting…");
  await refocus(page);
  await expect(tiktokRow(page, second).locator(".post__status")).toHaveText("Waiting for your Mac · in line (1 before it)");
  await mac.done(page, first, LINK);
  await refocus(page);
  await expect(tiktokRow(page, second).locator(".post__status")).toHaveText(NEXT);
});

test("library: the backlog's first clip says the Mac's own time; the rest their place; a backfill says in line", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await go(page, "/settings/posting/auto");
  const auto = page.getByRole("switch", { name: "Post my clips by themselves" });
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await sendAll(page);
  const at = Date.now() + 45 * MIN;
  await mac.ping(page, "ok", undefined, { backlogAt: new Date(at).toISOString() });
  const queue = await mac.queue(page);
  expect(queue.length).toBeGreaterThan(1);
  await go(page, "/library");
  const first = tiktokRow(page, queue[0]!.clipId).locator(".post__status");
  await expect(first).toHaveText(`Waiting for your Mac · goes at about ${rowTime(at)}`);
  // Never the same time on a later one: its place in the Mac's queue.
  await expect(tiktokRow(page, queue[1]!.clipId).locator(".post__status")).toHaveText("Waiting for your Mac · in line (1 before it)");
  await expect(page.locator(".post__status", { hasText: "goes at about" })).toHaveCount(1);
  // Its time passed: next.
  await mac.ping(page, "ok", undefined, { backlogAt: new Date(Date.now() - MIN).toISOString() });
  await refocus(page);
  await expect(first).toHaveText(NEXT);
  // A backfill goes at the Mac's own pace: in line, no time.
  await mac.ping(page, "ok", undefined, { backfill: true });
  await refocus(page);
  await expect(first).toHaveText("Waiting for your Mac · in line");
  // The Mac doesn't say (an older helper): no time at all.
  await mac.ping(page);
  await refocus(page);
  await expect(first).toHaveText("Waiting for your Mac");
});

test("library: a campaign clip skips TikTok for now, in plain words with no button, and Send these leaves it out", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  const before = Number((await page.getByText(/^\d+ clips? (isn't|aren't) on TikTok yet\.$/).innerText()).split(" ")[0]);
  await mac.ping(page);
  const clipId = await page.evaluate(() => (window as MockWindow).__cfMock!.posting.campaignClip());
  await go(page, "/library");
  const row = tiktokRow(page, clipId);
  await expect(cardOf(page, clipId).locator("[data-cr='campaign-chip']")).toHaveText("Campaign");
  await expect(row.locator(".post__status")).toHaveText(CAMPAIGN);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row.getByRole("link", { name: /Turn on|Open/ })).toHaveCount(0);
  await expect(row).not.toHaveClass(/is-failed/);
  await expect(page.getByText("Campaign clip: post it in the TikTok app")).toHaveCount(0);
  // Settings' Send these to my Mac counts it no more.
  await go(page, "/settings/posting/tiktok-mac");
  await expect(page.getByText(new RegExp(`^${before - 1} clips? (isn't|aren't) on TikTok yet\\.$`))).toBeVisible();
  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await page.getByRole("button", { name: "Yes, send them" }).click();
  await expect(page.getByText(/^Sent \d+ clips? to your Mac\./)).toBeVisible();
  expect((await mac.queue(page)).some((j) => j.clipId === clipId)).toBe(false);
});

test("library: a post left Posting… once the switch went off says so; a Mac gone quiet says since when, with It's on TikTok and Try again", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await mac.claim(page, clipId);
  await expect(status).toHaveText("Posting…");
  await expect(row.locator(".spinner")).toHaveCount(1);

  // The switch turned off while it was working: said, with Turn on.
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "false");
  await go(page, "/library");
  await expect(status).toHaveText("Your Mac posts TikTok is off");
  await expect(row.locator(".spinner")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await expect(page.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");

  // The Mac fell asleep mid-upload: neither it nor the job beat for 12 minutes. Before Post: since when, Try again only.
  const quiet = Date.now() - 12 * MIN;
  await mac.beat(page, clipId, 12 * MIN);
  await mac.seen(page, new Date(quiet).toISOString());
  await go(page, "/library");
  await refocus(page);
  await expect(status).toHaveText(`Your Mac hasn't checked in since ${rowTime(quiet)}`);
  await expect(row.locator(".spinner")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Try again, TikTok" })).toBeVisible();

  // After Post (pressed 40 minutes ago, so the find window is over): since when, It's on TikTok and Try again.
  await mac.step(page, clipId, "pressing", 40 * MIN);
  await mac.beat(page, clipId, 12 * MIN);
  await mac.seen(page, new Date(quiet).toISOString());
  await refocus(page);
  await expect(status).toHaveText(`Your Mac hasn't checked in since ${rowTime(quiet)}`);
  await expect(row.getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(row.getByText(AGAIN_ASK)).toBeVisible();
  await row.getByRole("button", { name: "Yes, post it again" }).click();
  await expect(page.getByText("Sent to your Mac again.")).toBeVisible();
  expect((await mac.queue(page)).find((j) => j.clipId === clipId)).toMatchObject({ state: "waiting" });
});

test("library: the Mac needs him: Open the stopped clip, where its Try again is", async ({ page }) => {
  const { clipId: stopped, status: stoppedStatus } = await sentWithMyMac(page);
  await mac.claim(page, stopped);
  await mac.stopped(page, stopped, "TikTok wants a code. Type it on your Mac.", true);
  await expect(stoppedStatus).toHaveText("Didn't work: TikTok wants a code · look at your Mac first");
  await refocus(page);
  const other = await clipWhoseRowSays(page, "Your Mac needs you: TikTok wants a code · look at your Mac");
  const row = tiktokRow(page, other);
  const open = row.getByRole("link", { name: "Open the stopped clip" });
  await expect(open).toHaveAttribute("href", `/clips/${stopped}`);
  await expect(row.getByRole("button")).toHaveCount(0);
  // Its own line, under the words, on the right of the row.
  const [words, link, li] = [await row.locator(".post__status").boundingBox(), await open.boundingBox(), await row.boundingBox()];
  expect(link!.y).toBeGreaterThanOrEqual(words!.y + words!.height - 1);
  expect(li!.x + li!.width - (link!.x + link!.width)).toBeLessThan(16);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/clips/${stopped}$`));
  await settle(page);
  await page.locator(".perf__actions").getByRole("button", { name: "Try again, TikTok" }).click();
  await expect(page.locator('[data-stack="tiktok"] .pstack__calm-text')).toHaveText(NEXT);
});

test("library: paused on the Mac: Start my Mac again, then it says it starts again within a minute", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await turnOn(page);
  await mac.ping(page, "paused");
  await go(page, "/library");
  const clipId = await clipWhoseRowSays(page, "Paused on your Mac · your clips wait until it's started again");
  const row = tiktokRow(page, clipId);
  const start = row.getByRole("button", { name: "Start my Mac again" });
  await expect(start).toBeVisible();
  await expect(row.getByRole("link")).toHaveCount(0);
  // The trial pause: its own words, the same button.
  await mac.ping(page, "paused", "Paused after the 3 trial posts. Clip Factory checks their views first.");
  await refocus(page);
  await expect(row.locator(".post__status")).toHaveText("Paused after the 3 trial posts · your Mac goes on once their views are checked");
  await start.click();
  await expect(page.getByText("Your Mac starts again within a minute.")).toBeVisible();
  // Every row says so within a second, with no second button.
  await expect(row.locator(".post__status")).toHaveText("Paused after the 3 trial posts · starting again within a minute", { timeout: 1500 });
  await expect(page.getByRole("button", { name: "Start my Mac again" })).toHaveCount(0);
  await go(page, "/settings/posting/tiktok-mac");
  await expect(page.getByText("Your Mac starts again the next time it checks in, within a minute.")).toBeVisible();
  // The Mac did it: it checks in fine.
  await mac.ping(page);
  await refocus(page);
  await expect(page.getByText(/^Your Mac checked in /)).toBeVisible();
  await expect(page.getByText(/starts again the next time/)).toHaveCount(0);
});

test("library: an auto-posting clip the Mac holds says so, with Post with my Mac", async ({ page }) => {
  const { clipId, row, status } = await sentWithMyMac(page);
  await go(page, "/settings/posting/auto");
  const auto = page.getByRole("switch", { name: "Post my clips by themselves" });
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await mac.source(page, clipId, "auto", 3 * 60 * MIN);
  const hold = Date.now() - 60 * MIN;
  await mac.ping(page, "ok", undefined, { holdBefore: new Date(hold).toISOString() });
  await go(page, "/library");
  await refocus(page);
  await expect(status).toHaveText(`Held on your Mac: made before ${rowTime(hold)}`);
  await row.getByRole("button", { name: "Post with my Mac" }).click();
  await expect(page.getByText("Sent to your Mac! It posts it in a minute.")).toBeVisible();
  await expect(status).toHaveText(NEXT);
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
  await expect(status).toHaveText(NEXT);
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
  test(`library at ${width}: a private upload is not lit green; on the narrow card its button goes under the words, Open beside them`, async ({ page }) => {
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
    // The mark keeps its own size and the words start right after it. The cards are narrow at both sizes (three side
    // by side at 1440), so the button goes under the words, on the right of the row's full width, and Open stays beside
    // the words, on their line.
    const li = (await row.boundingBox())!;
    expect(mark!.width).toBeLessThan(40);
    expect(text!.x - (mark!.x + mark!.width)).toBeLessThan(16);
    expect(b!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
    expect(li.x + li.width - (b!.x + b!.width)).toBeLessThan(16);
    expect(o!.x).toBeGreaterThanOrEqual(text!.x + text!.width - 1);
    expect(o!.y).toBeLessThan(text!.y + text!.height);
    // The words get the row, less the mark and Open.
    expect(text!.width).toBeGreaterThan(li.width / 2);

    // On, checked in: Only you can see it, with Post with my Mac; still not green.
    await turnOn(page);
    await mac.ping(page);
    await go(page, "/library");
    await expect(row.locator(".post__status")).toHaveText("Only you can see it on TikTok");
    await expect(row).not.toHaveClass(/is-posted/);
    const post = await row.getByRole("button", { name: "Post with my Mac" }).boundingBox();
    const words = await row.locator(".post__text").boundingBox();
    const li2 = (await row.boundingBox())!;
    expect(post!.y).toBeGreaterThanOrEqual(words!.y + words!.height - 1);
    expect(li2.x + li2.width - (post!.x + post!.width)).toBeLessThan(16);
    // Its words stay on one line instead of a thin column.
    expect(words!.height).toBeLessThan(48);
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

  // Not seen for 30 minutes: since when, with Open Your Mac posts TikTok (its switch is already on).
  await mac.seen(page, new Date(Date.now() - 31 * 60_000).toISOString());
  await refocus(page);
  await expect(status).toHaveText(/^Your Mac hasn't checked in since (\w{3} )?\d\d:\d\d$/);
  await expect(row.getByRole("link", { name: OPEN_MAC })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await expect(row.getByRole("link", { name: "Turn on" })).toHaveCount(0);

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
  await expect(calm).toHaveText(NEXT);
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
  await expect(calm).toHaveText(NEXT);

  // The switch off: said, with Turn on in the actions.
  await mac.claim(page, clipId);
  await mac.stopped(page, clipId, "Timed out.");
  await go(page, "/settings/posting/tiktok-mac");
  await page.getByRole("switch", { name: SWITCH }).click();
  await go(page, `/clips/${clipId}`);
  await expect(calm).toHaveText("Your Mac posts TikTok is off");
  await expect(actions.getByRole("link", { name: "Turn on" })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
});

for (const width of [1440, 375]) {
  test(`clip page at ${width}: not sure it posted, its chip, and the two choices lined up with the actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { clipId } = await sentWithMyMac(page);
    await pressedAndStopped(page, clipId, WINDOW_OVER);
    await go(page, `/clips/${clipId}`);
    const stack = page.locator('[data-stack="tiktok"]');
    // "Not sure it posted" once, on the chip; the line says where to look (D7).
    await expect(stack.locator(".pstack__chip")).toHaveText("Not sure it posted");
    await expect(stack.locator(".pstack__calm-text")).toHaveText("Look on your TikTok");
    await expect(stack.getByText(/Not sure it posted/)).toHaveCount(1);
    const actions = page.locator(".perf__actions");
    const choices = actions.locator(".post__choices");
    await expect(choices.getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
    const [a, c] = [(await actions.boundingBox())!, (await choices.boundingBox())!];
    const refresh = (await actions.locator(".perf__refresh").boundingBox())!;
    const mid = (r: { x: number; width: number }) => r.x + r.width / 2;
    // Centred under the centred actions on a phone; from the left with the other actions on a wide screen.
    if (width < 620) expect(Math.abs(mid(c) - mid(a))).toBeLessThan(4);
    else expect(Math.abs(c.x - refresh.x)).toBeLessThan(4);
    // Its question sits the same way.
    await choices.getByRole("button", { name: "Try again, TikTok" }).click();
    const ask = actions.locator(".post__confirm");
    await expect(ask).toContainText(AGAIN_ASK);
    const q = (await ask.locator(".post__confirm-buttons").boundingBox())!;
    if (width < 620) expect(Math.abs(mid(q) - mid(a))).toBeLessThan(4);
    else expect(Math.abs(q.x - refresh.x)).toBeLessThan(4);
  });
}

test("clip page: inside the find window it says from when Try again comes; a Mac gone quiet says since when (review round 3, items 5-6)", async ({ page }) => {
  const { clipId } = await sentWithMyMac(page);
  await pressedAndStopped(page, clipId, 10 * MIN);
  await go(page, `/clips/${clipId}`);
  const stack = page.locator('[data-stack="tiktok"]');
  await expect(stack.locator(".pstack__chip")).toHaveText("Not sure it posted");
  await expect(stack.locator(".pstack__calm-text")).toHaveText(/^Look on your TikTok · Try again from (?:\w{3} )?\d\d:\d\d$/);
  const actions = page.locator(".perf__actions");
  await expect(actions.getByRole("button", { name: "It's on TikTok", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Try again, TikTok" })).toHaveCount(0);

  // Another clip, pressed and then its Mac went quiet (no beat or check-in for 12 minutes): the row's words.
  await go(page, "/library");
  const other = await clipWhoseRowSays(page, "(Not on TikTok yet|Only you can see it on TikTok)");
  await tiktokRow(page, other).getByRole("button", { name: "Post with my Mac" }).click();
  await expect(tiktokRow(page, other).locator(".post__status")).toHaveText(/^Waiting for your Mac/);
  await mac.claim(page, other);
  await mac.step(page, other, "pressing", 40 * MIN);
  const quiet = Date.now() - 12 * MIN;
  await mac.beat(page, other, 12 * MIN);
  await mac.seen(page, new Date(quiet).toISOString());
  await go(page, `/clips/${other}`);
  await expect(stack.locator(".pstack__chip")).toHaveText("Not sure it posted");
  await expect(stack.locator(".pstack__calm-text")).toHaveText(`Your Mac hasn't checked in since ${rowTime(quiet)}`);
  await expect(stack.getByText(/Not sure it posted/)).toHaveCount(1);
});

test("review at 375: Uploaded just now reads the words first, then its buttons, on screen too", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
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
  const words = (await item.locator(".kept-now__text").boundingBox())!;
  for (const name of ["See how it does", "Post with my Mac"]) {
    const b = (await item.getByRole(name === "See how it does" ? "link" : "button", { name }).boundingBox())!;
    expect(b.y, name).toBeGreaterThanOrEqual(words.y + words.height - 1);
  }
  // Reading order: the hook and the TikTok line come before the buttons.
  const order = await item.evaluate((li) => [...li.querySelectorAll(".kept-now__hook, .kept-now__mac, a.btn, button")].map((e) => e.textContent?.trim().slice(0, 16)));
  expect(order.slice(0, 2)).toEqual([hook.slice(0, 16), "TikTok: Not on T"]);
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
  // The Mac never checked in: the line says so before Upload, with its page (never "for everyone", never Turn on).
  await expect(card.locator(".tt-yourself-hint")).toHaveText("TikTok: Your Mac isn't set up yet");
  await expect(card.locator('[data-mac="card"]').getByRole("link", { name: OPEN_MAC })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
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
  const held = "Your Mac can't add TikTok's Branded content label yet. Untick it, or untick TikTok, then post this clip in the TikTok app with its label, not with your Mac.";
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
  // The Mac never checked in: said, with its page (the switch is on: never Turn on).
  await expect(line).toHaveText("TikTok: Your Mac isn't set up yet");
  await expect(item.getByRole("link", { name: OPEN_MAC })).toHaveAttribute("href", "/settings/posting/tiktok-mac");
  await expect(item.getByRole("link", { name: "Turn on" })).toHaveCount(0);
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
  await expect(line).toHaveText(`TikTok: ${NEXT}`);
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "uploading");
  await expect(line).toHaveText("TikTok: Posting…");
  await mac.done(page, clipId);
  await expect(line).toHaveText("TikTok: Posted by your Mac · Everyone");
  // Its Open link, as on Library.
  await expect(item.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", /tiktok\.com/);
});

test("review: a clip with Branded content ticked, uploaded without TikTok, is never offered Post with my Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ["youtube", "tiktok"]) s.finish(p);
    s.setAudit(false);
  });
  await turnOn(page);
  await mac.ping(page);
  await go(page, "/review");
  const card = page.locator(".review-card").first();
  const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
  const hook = await card.locator(".review-card__hook").innerText();
  await card.locator('[data-place="tiktok"] summary').click();
  const ttRow = card.locator('[data-place="tiktok"]');
  await ttRow.getByRole("switch", { name: "Commercial content" }).click();
  await ttRow.getByRole("checkbox", { name: /^Branded content/ }).click();
  // The hold's way out: untick TikTok here and post it in the TikTok app.
  await card.locator(".upload-chip", { hasText: "TikTok" }).click();
  await expect(card.locator(".upload-going")).toHaveText("Going to: YouTube");
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const item = page.locator(".kept-now__item", { hasText: hook.slice(0, 20) });
  // The Mac can't add TikTok's label: no Post with my Mac, the Add link for the post he makes in the TikTok app.
  await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Commercial content: post it in the TikTok app, with its label");
  await expect(item.getByRole("button", { name: "Post with my Mac" })).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Save the link" })).toBeVisible();
  expect((await mac.queue(page)).find((j) => j.clipId === clipId)).toBeUndefined();
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
  await expect(item.locator(".kept-now__mac")).toHaveText(`TikTok: ${NEXT}`);
  await expect(item.getByRole("button", { name: "Post with my Mac" })).toHaveCount(0);
});
