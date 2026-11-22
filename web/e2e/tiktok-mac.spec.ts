// Your Mac posts it on TikTok (docs/CONTRACTS.md §47) in mock mode: Settings › Posting › Your Mac posts TikTok (the
// switch, the Mac's check-in, Send these to my Mac), the Library's TikTok row as the Mac waits, works, stops and posts
// (moved by the Mac helper's knobs, window.__cfMock.mac), Post it yourself instead, and Review's hint and Uploaded
// just now. The pretend app keeps its settings and posts in this page only, so every step after the first page is an
// in-app navigation.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

type Job = { clipId: string; postId: string; hook: string; state: string };
type MockWindow = Window & {
  __cfMock?: {
    setup: { finish(p: string): void; setAudit(passed: boolean): void };
    posting: { posts(clipId: string): { postId: string; platform: string; status: string }[] };
    mac: {
      ping(state?: string, reason?: string): { on: boolean };
      claim(clipId: string): Job;
      step(clipId: string, step: string): Job;
      done(clipId: string, link?: string): unknown;
      stopped(clipId: string, reason: string, needsYou?: boolean): Job;
      queue(): Job[];
    };
  };
};

const PRESSED = "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it.";
const LINK = "https://www.tiktok.com/@lamo.clips/video/7710644811602169121";

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
  claim: (page: Page, clipId: string) => page.evaluate((id) => (window as MockWindow).__cfMock!.mac.claim(id), clipId),
  step: (page: Page, clipId: string, step: string) =>
    page.evaluate(([id, st]) => (window as MockWindow).__cfMock!.mac.step(id, st), [clipId, step] as const),
  stopped: (page: Page, clipId: string, reason: string) =>
    page.evaluate(([id, r]) => (window as MockWindow).__cfMock!.mac.stopped(id, r), [clipId, reason] as const),
  done: (page: Page, clipId: string, link?: string) =>
    page.evaluate(([id, l]) => void (window as MockWindow).__cfMock!.mac.done(id, l), [clipId, link] as const),
  queue: (page: Page) => page.evaluate(() => (window as MockWindow).__cfMock!.mac.queue()),
};

/** Settings › Posting › Your Mac posts TikTok, switched on. */
async function turnOn(page: Page) {
  await go(page, "/settings/posting/tiktok-mac");
  const sw = page.getByRole("switch", { name: "My Mac posts my TikTok clips" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("On. Upload and auto-posting hand TikTok to your Mac.")).toBeVisible();
}

/** Switched on, every clip that shows Post it yourself sent to the Mac; answers the first job in the queue. */
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

test("settings: the switch, the Mac's check-in and Send these to my Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await go(page, "/settings/posting/tiktok-mac");
  await expect(page.getByText("Off. TikTok works as before: Post it yourself.")).toBeVisible();
  await expect(page.getByText("Your Mac hasn't checked in yet. Set it up on your Mac.")).toBeVisible();
  await expect(page.getByText("To stop it, turn the switch off. Your Mac stops at once.")).toBeVisible();
  // Off: nothing to send.
  await expect(page.getByRole("button", { name: "Send these to my Mac" })).toHaveCount(0);

  await turnOn(page);
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("0 waiting for your Mac")).toBeVisible();
  const line = page.getByText(/^\d+ clips? shows? Post it yourself\.$/);
  await expect(line).toBeVisible();
  const n = Number((await line.innerText()).split(" ")[0]);
  expect(n).toBeGreaterThan(0);

  // One tap asks first; Not now sends nothing.
  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await expect(page.getByText("They go one at a time, oldest first.")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("0 waiting for your Mac")).toBeVisible();

  await page.getByRole("button", { name: "Send these to my Mac" }).click();
  await page.getByRole("button", { name: "Yes, send them" }).click();
  await expect(page.getByText(`Sent ${n} clip${n === 1 ? "" : "s"} to your Mac.`)).toBeVisible();
  await expect(page.getByText(`${n} waiting for your Mac`)).toBeVisible();
  await expect(page.getByText("0 clips show Post it yourself.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send these to my Mac" })).toHaveCount(0);

  // The Mac checks in, then needs him.
  await mac.ping(page);
  await refocus(page);
  await expect(page.getByText(/^Your Mac checked in \w{3} \d\d:\d\d\.$/)).toBeVisible();
  await mac.ping(page, "needs_you", "TikTok wants you to log in again.");
  await refocus(page);
  await expect(page.getByText("Your Mac needs you: TikTok wants you to log in again.")).toBeVisible();

  // Off again: the Mac's queue is empty at once.
  await page.getByRole("switch", { name: "My Mac posts my TikTok clips" }).click();
  await expect(page.getByText("Off. TikTok works as before: Post it yourself.")).toBeVisible();
  await expect.poll(async () => (await mac.queue(page)).length).toBe(0);
});

test("library: the TikTok row as the Mac waits, works, stops, tries again and posts it", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const job = await sendAll(page);
  await go(page, "/library");
  const row = tiktokRow(page, job.clipId);
  await expect(row).toContainText("Waiting for your Mac · set up your Mac first");
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself instead" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself", exact: true })).toHaveCount(0);

  // The Mac checks in: just "Waiting for your Mac".
  await mac.ping(page);
  await refocus(page);
  await expect(row.locator(".post__status")).toHaveText("Waiting for your Mac");

  // It works on it, live, step by step; meanwhile he can't take it back.
  await mac.claim(page, job.clipId);
  await expect(row).toContainText("Your Mac is posting it · Getting the video");
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself instead" })).toHaveCount(0);
  await mac.step(page, job.clipId, "uploading");
  await expect(row).toContainText("Your Mac is posting it · Uploading");

  // It stops: the reason, Try again, and Post it yourself instead.
  await mac.stopped(page, job.clipId, "TikTok wants you to log in again.");
  await expect(row).toContainText("Your Mac stopped: TikTok wants you to log in again.");
  await expect(row.getByRole("button", { name: "Post it on TikTok yourself instead" })).toBeVisible();
  await row.getByRole("button", { name: "Try again" }).click();
  await expect(row.locator(".post__status")).toHaveText("Waiting for your Mac");

  // It pressed Post but could not confirm it: Try again says it is not on TikTok.
  await mac.claim(page, job.clipId);
  await mac.step(page, job.clipId, "pressing");
  await expect(row).toContainText("Your Mac is posting it · Posting");
  await mac.stopped(page, job.clipId, "Timed out.");
  await expect(row).toContainText(`Your Mac stopped: ${PRESSED}`);
  await row.getByRole("button", { name: "It's not on TikTok, try again" }).click();
  await expect(row.locator(".post__status")).toHaveText("Waiting for your Mac");

  // Posted by the Mac: Everyone, with Open.
  await mac.claim(page, job.clipId);
  await mac.step(page, job.clipId, "finding");
  await expect(row).toContainText("Your Mac is posting it · Finding the link");
  await mac.done(page, job.clipId, LINK);
  // Its numbers come as for any public post.
  await expect(row.locator(".post__status")).toHaveText(/^Posted by your Mac · Everyone · numbers in /);
  await expect(row.getByRole("link", { name: "Open the TikTok post" })).toHaveAttribute("href", LINK);
  await expect(row.getByRole("button", { name: /Post it on TikTok yourself/ })).toHaveCount(0);
});

test("library: Post it yourself instead takes it back from the Mac and opens the sheet", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const job = await sendAll(page);
  await go(page, "/library");
  const row = tiktokRow(page, job.clipId);
  await row.getByRole("button", { name: "Post it on TikTok yourself instead" }).click();
  const sheet = page.getByRole("dialog", { name: "Post it on TikTok yourself" });
  await expect(sheet).toBeVisible();
  // Taken back: the Mac no longer has it.
  expect((await mac.queue(page)).map((j) => j.clipId)).not.toContain(job.clipId);
  await sheet.getByRole("button", { name: "I posted it" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(tiktokRow(page, job.clipId)).toContainText("Posted by you · Everyone");
});

test("review: the hint says the Mac posts it, and Uploaded just now follows the Mac", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    localStorage.removeItem("cf-upload-to");
    const s = (window as MockWindow).__cfMock!.setup;
    for (const p of ["youtube", "tiktok"]) s.finish(p);
    s.setAudit(false);
  });
  // Off: TikTok's own hint, as before.
  await go(page, "/review");
  await expect(page.locator(".review-card").first().locator(".tt-yourself-hint")).toHaveText(
    "Until TikTok approves the app, Clip Factory can only upload to a private TikTok account. Yours is public? Untick TikTok, tap Upload, then post it yourself.",
  );

  await turnOn(page);
  await go(page, "/review");
  const card = page.locator(".review-card").first();
  const clipId = (await card.locator("..").getAttribute("id"))!.replace("clip-", "");
  const hook = await card.locator(".review-card__hook").innerText();
  await expect(card.locator(".tt-yourself-hint")).toHaveText("TikTok: your Mac posts it for everyone.");
  await card.getByRole("button", { name: "Use my settings" }).click();
  await card.getByRole("button", { name: /^Upload( to .+)?$/ }).click();
  const item = page.locator(".kept-now__item", { hasText: hook.slice(0, 20) });
  await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Waiting for your Mac · set up your Mac first");
  // The sheet does not open by itself, and nothing of Clip Factory's own goes to TikTok's API.
  await expect(page.getByRole("dialog", { name: "Post it on TikTok yourself" })).toHaveCount(0);
  const posts = await page.evaluate((id) => (window as MockWindow).__cfMock!.posting.posts(id), clipId);
  expect(posts.find((p) => p.platform === "tiktok")?.status).toBe("mac");
  expect(posts.find((p) => p.platform === "youtube")?.status).toBe("queued");

  // Live: the Mac's steps show here too.
  await mac.claim(page, clipId);
  await mac.step(page, clipId, "uploading");
  await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Your Mac is posting it · Uploading");
  await mac.done(page, clipId);
  await expect(item.locator(".kept-now__mac")).toHaveText("TikTok: Posted by your Mac · Everyone");
});

test("auto-posting: Where they go says the Mac posts TikTok while it is on", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => (window as MockWindow).__cfMock!.setup.finish("youtube"));
  await go(page, "/settings/posting/auto");
  await expect(page.getByText("TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself.")).toBeVisible();
  await expect(page.getByText("TikTok: your Mac posts it.")).toHaveCount(0);
  await turnOn(page);
  await go(page, "/settings/posting/auto");
  await expect(page.getByText("TikTok: your Mac posts it.")).toBeVisible();
  await expect(page.getByText("TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself.")).toHaveCount(0);
});
