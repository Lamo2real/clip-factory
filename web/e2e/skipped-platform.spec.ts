import { expect, test, type Page } from "@playwright/test";
import { CLIPS, openClip, openTodo, settle } from "./helpers.ts";

// Rule S (docs/CONTRACTS.md §48; the owner, 24 Nov: "if i skip on a platform setup then i dont want to see it anywhere
// except in settings or social accounts tab"), in both apps of the mock build. A platform the owner skipped leaves
// every reminder, count, "N left" list and "connect X" nudge. It shows only in Clip Factory › Settings › Posting › Set
// up posting and in Clips Funded › Social accounts (and Clips Funded's setup, which its nav counts as Settings), each
// with a way back. Skipping in one app never touches the other app's skips.

type CfMock = Window & { __cfMock?: { setup: { finish(p: string): void } } };
type Account = { platform: string; connectionStatus: string; externalAccountId: string | null; accountName: string | null; handle: string | null; reason: string | null; warning: string | null; choices: unknown; missing: string[]; connectedAt: string | null };
type StoriesMock = Window & { __cfStoriesMock?: { store?: { social: Account[] } } };

async function on(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test("Clip Factory: skip X, and X leaves the list, its count, Home and Review; Settings keeps it with Un-skip; Clips Funded's X is untouched", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => (window as CfMock).__cfMock!.setup.finish("youtube"));
  await page.goto("/");
  await settle(page);

  // Before: X is on the floating list, in its count, and in Home's followers line.
  let todo = await openTodo(page);
  await expect(todo.locator(".todo-row")).toHaveCount(5);
  await expect(page.locator(".setup-todo")).toContainText("1/5");
  await expect(page.locator(".followers-tile__off")).toHaveText("Not connected: TikTok, Facebook and X.");

  // Skip asks first; only the confirmed answer takes X away.
  await todo.getByRole("button", { name: "Skip X", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Skip X?" });
  await sheet.getByRole("button", { name: "Skip X", exact: true }).click();
  await expect(sheet).toHaveCount(0);

  // The floating list and its count leave X out.
  todo = await openTodo(page);
  await expect(todo.locator(".todo-row[data-platform='x']")).toHaveCount(0);
  await expect(todo.locator(".todo-row")).toHaveCount(4);
  await expect(page.locator(".setup-todo")).toContainText("1/4");
  // Home: the followers tile never names it.
  await expect(page.locator(".followers-tile__off")).toHaveText("Not connected: TikTok and Facebook.");
  await expect(page.locator(".followers-tile__off")).toHaveAttribute("data-off", "tiktok,facebook");
  // After a reload too (the skip is saved on the server).
  await page.waitForFunction(() => sessionStorage.getItem("cf-mock-setup-skipped") === JSON.stringify(["x"]));
  await page.reload();
  await settle(page);
  await expect((await openTodo(page)).locator(".todo-row[data-platform='x']")).toHaveCount(0);
  await expect(page.locator(".followers-tile__off")).toHaveText("Not connected: TikTok and Facebook.");

  // Review › Upload to: the hint names the places still to set up, never X.
  await page.goto("/review");
  await settle(page);
  const hint = page.locator(".review-card").first().locator("a.upload-to__hint");
  await expect(hint).toHaveText("Set up TikTok, Instagram and Facebook to upload there too.");
  await expect(page.locator(".review-card").first().locator(".upload-to")).not.toContainText("Set up X");

  // A clip's page: X's stack (no post there) says only that, with no way to set X up or turn it on. Instagram, not
  // skipped, still has its nudge.
  await openClip(page, CLIPS.mixed);
  const xStack = page.locator('[data-stack="x"]');
  await expect(xStack.locator(".pstack__calm-text")).toHaveText("Not posted here.");
  await expect(xStack.getByRole("link")).toHaveCount(0);
  await expect(page.locator(".perf")).not.toContainText("Turn on X");
  await expect(page.locator(".perf")).not.toContainText("Set up X");
  await expect(page.locator('[data-stack="instagram"]').getByRole("link", { name: "Set up Instagram" })).toBeVisible();

  // Settings › Posting › Set up posting: all five cards; X's says Skipped, with Un-skip, and the count leaves it out.
  await page.goto("/settings/posting/setup");
  await settle(page);
  await expect(page.locator(".setup-card[data-platform]")).toHaveCount(5);
  await expect(page.locator(".setup-card[data-platform='x'] .setup-card__state")).toHaveText("Skipped");
  await expect(page.locator("[data-skipped='x']")).toContainText("You won't post to X until you set it up.");
  await expect(page.getByText("1 of 4 ready")).toBeVisible();

  // Clips Funded keeps its own: its X is not skipped there, and its count still has five places.
  await page.goto("/stories/connections");
  await storiesReady(page);
  await expect(page.locator(".st-social-row-wrap[data-platform='x']")).not.toHaveAttribute("data-state", "skipped");
  await expect(page.locator(".st-social-progress h2")).toHaveText(/ of 5 ready$/);

  // Un-skip in Settings brings X back to the list, its count and Home.
  await page.goto("/settings/posting/setup");
  await settle(page);
  await page.getByRole("button", { name: "Un-skip X" }).click();
  await expect(page.locator("[data-skipped='x']")).toHaveCount(0);
  await expect(page.getByText("1 of 5 ready")).toBeVisible();
  await page.waitForFunction(() => sessionStorage.getItem("cf-mock-setup-skipped") === "[]");
  await page.goto("/");
  await settle(page);
  await expect((await openTodo(page)).locator(".todo-row[data-platform='x']")).toHaveAttribute("data-state", "not_started");
  await expect(page.locator(".setup-todo")).toContainText("1/5");
  await expect(page.locator(".followers-tile__off")).toHaveText("Not connected: TikTok, Facebook and X.");
});

test("Clips Funded, the owner's case: X skipped in the setup leaves the dashboard, its count and Needs you; Social accounts keeps it with Un-skip; Clip Factory's X is untouched", async ({ page }) => {
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/stories/setup");
  await storiesReady(page);
  // As the owner had it: YouTube, TikTok, Instagram and Facebook connected with Clips Funded's own accounts, and X
  // needing a new sign-in.
  await page.evaluate(() => {
    const store = (window as StoriesMock).__cfStoriesMock!.store!;
    const at = new Date().toISOString();
    store.social = store.social.map((a) =>
      a.platform === "x"
        ? { ...a, connectionStatus: "needs_reconnect", externalAccountId: "funded-x", accountName: "Clips Funded", handle: "@fundedclips", reason: "token_dead", warning: null, choices: null, missing: [], connectedAt: at }
        : a.platform === "youtube"
          ? a
          : { ...a, connectionStatus: "connected", externalAccountId: `funded-${a.platform}`, accountName: "Clips Funded", handle: "@fundedclips", reason: null, warning: null, choices: null, missing: [], connectedAt: at },
    );
  });

  // The setup: the AI steps, then X skipped for now, then Finish.
  const steps = page.getByRole("navigation", { name: "Setup steps" });
  const step = page.locator("#st-setup-step");
  const foot = page.locator(".st-setup__foot");
  const ring = page.locator(".st-setup__head .st-ring");
  await steps.getByRole("button", { name: /Set up the AI/ }).click();
  await page.getByRole("button", { name: "These look right" }).click();
  await expect(step).toHaveText("Pick your default model");
  await page.getByRole("radio", { name: /Claude Fable 5.2/ }).click();
  await page.getByRole("button", { name: "Use Claude Fable 5.2" }).click();
  await expect(step).toHaveText("Pick your default effort");
  await page.getByRole("radio", { name: "Maximum" }).click();
  await page.getByRole("button", { name: "Use Maximum" }).click();
  await expect(step).toHaveText("Pick how videos are made");
  await page.getByRole("button", { name: "Use this" }).click();
  await expect(step).toHaveText("Meet your agents and skills");
  await steps.getByRole("button", { name: /Connect X/ }).click();
  await expect(step).toHaveText("Connect X");
  await expect(ring).toHaveAttribute("aria-label", "9 of 11 done");
  await foot.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Skipped. It stays in Social accounts." })).toBeVisible();
  // The setup counts as Settings: X shows there, as Skipped, and leaves the count.
  await expect(steps.locator(".st-steps__item").filter({ hasText: "Connect X" })).toContainText("Skipped");
  await expect(ring).toHaveAttribute("aria-label", "9 of 10 done");
  await steps.getByRole("button", { name: /^Done/ }).click();
  await foot.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/stories$/, { timeout: 8000 });
  await storiesReady(page);

  // The dashboard of the owner's screenshot: no "Finish setting up: 1 left · Connect X", and "4 of 4", not "4 of 5".
  const dash = page.locator(".st-dash");
  await expect(page.locator(".st-setupcard")).toHaveCount(0);
  await expect(dash).not.toContainText("Finish setting up");
  await expect(dash).not.toContainText("Connect X");
  const accounts = page.locator(".st-tile").filter({ hasText: "Connected accounts" });
  await expect(accounts.locator(".st-tile__big")).toHaveText("4 of 4");
  await expect(accounts.locator(".st-accounts__row")).toHaveCount(4);
  expect(await accounts.locator(".st-accounts__row .sr-only").allTextContents()).toEqual(["YouTube: ", "TikTok: ", "Instagram: ", "Facebook: "]);
  // Needs you (the tile and the bar on every page) has nothing about X.
  await expect(page.locator(".st-needs-list__mark[title='X']")).toHaveCount(0);
  await expect(page.locator(".st-tile--needs")).not.toContainText("This X account");
  await expect(page.locator("aside.st-needs")).not.toContainText("This X account");
  // Settings: nothing left to do.
  await page.locator(".st-rail").getByRole("link", { name: "Settings", exact: true }).click();
  await storiesReady(page);
  await expect(page.locator(".st-stg-head__setup-left")).toHaveCount(0);

  // Social accounts keeps X, as Skipped, with Un-skip; the count leaves it out.
  await page.locator(".st-rail").getByRole("link", { name: "Social accounts", exact: true }).click();
  await storiesReady(page);
  const x = page.locator(".st-social-row-wrap[data-platform='x']");
  await expect(x).toHaveAttribute("data-state", "skipped");
  await expect(x.locator(".st-chip")).toHaveText("Skipped");
  // Said once: the row's line, and under its hairline only the way back.
  await expect(x.locator(".st-social-row__line")).toHaveText("You won't post here.");
  await expect(x.locator("[data-skipped='x']")).toHaveText("Un-skip");
  await expect(page.locator(".st-social-progress h2")).toHaveText("4 of 4 ready");
  await expect(page.locator(".st-social-progress")).toContainText("Every place is ready.");
  // Its own page says so too.
  await x.locator("a.st-social-row").click();
  await expect(page).toHaveURL(/\/stories\/connections\/x$/);
  await expect(page.locator(".st-social-one__skipped")).toContainText("You skipped X. You won't post there until you set it up.");

  // Clip Factory keeps its own: its X is still on its list, never skipped.
  expect(await page.evaluate(() => sessionStorage.getItem("cf-mock-setup-skipped"))).toBeNull();
  await page.locator(".ws-dock").getByRole("link", { name: "Clip Factory", exact: true }).click();
  await settle(page);
  await expect((await openTodo(page)).locator(".todo-row[data-platform='x']")).toHaveAttribute("data-state", "not_started");
  await page.locator(".ws-dock").getByRole("link", { name: "Clips Funded" }).click();
  await storiesReady(page);

  // Un-skip on X's page brings it back to the dashboard: its count, its Needs you line and what is left.
  await expect(page).toHaveURL(/\/stories\/connections\/x$/);
  await page.getByRole("button", { name: "Un-skip X" }).click();
  await expect(page.locator(".toast").filter({ hasText: "X is back." })).toBeVisible();
  await expect(page.locator(".st-social-one__skipped")).toHaveCount(0);
  await page.locator(".st-rail").getByRole("link", { name: "Dashboard", exact: true }).click();
  await storiesReady(page);
  await expect(accounts.locator(".st-tile__big")).toHaveText("4 of 5");
  await expect(page.locator(".st-tile--needs")).toContainText("This X account (Clips Funded) needs connecting again.");
  // Its account line, and a post that stopped on X: both were left out while it was skipped.
  await expect(page.locator(".st-needs-list__mark[title='X']")).toHaveCount(2);
  await expect(page.locator(".st-setupcard--left")).toContainText("Finish setting up: 1 left");
  await expect(page.locator(".st-setupcard--left")).toContainText("Connect X");
});
