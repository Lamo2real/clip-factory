import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle, WIDTHS } from "./helpers.ts";

// The Lamo Stories shell (docs/CONTRACTS.md §45.16, §45.29, §45.30): the switcher reads "Clip Factory | Lamo
// Stories"; switching both ways goes back to the exact page left (Clip Factory's at its scroll position, Ask with
// its conversation and an answer still streaming in); the choice survives a reload; the app opened at "/" with Lamo
// Stories last goes to the last Lamo Stories page; the first time, the setup opens by itself (11 skippable steps,
// the ring, what is left, the dashboard card until finished); Social accounts has each platform's developer-app
// choice, keys, Check it, the authorization status and Check now; and every page of the shell keeps the owner's
// rules: nothing overflows from 320 to 1920 px, the arrow cursor only, AA contrast, no visible edges, targets of
// 44 px (48 on phones). Lamo Stories is switched on here with cf.storiesPreview = 1.

const PAGES = ["/stories", "/stories/library", "/stories/library?kind=videos", "/stories/connections", "/stories/setup"];

async function on(page: Page, extra?: () => void) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
  if (extra) await page.addInitScript(extra);
}

/** A brand-new studio: nothing set up, nothing connected, no developer app picked (the mock's `fresh` knob). */
async function fresh(page: Page) {
  await on(page, () => {
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
  });
}

/** The shell has checked its workspace and the page has its words (no "Getting it ready…" left). */
async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

test.describe("switching", () => {
  test("both ways lands on the exact page left, on a computer", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/library?view=week");
    await settle(page);
    // One choice per workspace, Lamo Clips by the app's own name.
    await expect(page.locator(".sidebar__foot .ws-switch__opt")).toHaveText(["Clip Factory", "Lamo Stories"]);
    await expect(page.locator(".sidebar__foot .ws-switch__opt.is-on")).toHaveText("Clip Factory");
    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await expect(page.locator(".st-rail .ws-switch__opt")).toHaveText(["Clip Factory", "Lamo Stories"]);
    await expect(page.locator(".st-rail .ws-switch__opt.is-on")).toHaveText("Lamo Stories");
    await expect(page.locator(".st-rail .st-rail__label")).toHaveText(["Dashboard", "Ideas", "Characters", "Production", "Review", "Chat", "References", "Library", "Social accounts", "Settings"]);
    await page.locator(".st-rail").getByRole("link", { name: "Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);

    await page.locator(".st-rail .ws-switch__opt", { hasText: "Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library\?view=week$/);
    await settle(page);
    await expect(page.locator(".stories-app")).toHaveCount(0);
    await expect(page.locator("nav.sidebar .sidebar__item.is-active")).toHaveAttribute("data-help", "nav-library");

    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { level: 1, name: "Social accounts" })).toBeVisible();
  });

  test("on the smallest phone (320 px) a slim toggle in the top bar still switches in one tap", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/review");
    await settle(page);
    await expect(page.locator(".topbar .ws-switch-host")).toHaveAttribute("data-ws-switch", "slim");
    await page.locator(".topbar").getByRole("link", { name: "Go to Lamo Stories" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
  });

  test("a switch held by Leave without saving: Keep editing stays and the device still says Clip Factory; Leave switches", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/clip-making/skills/new");
    await settle(page);
    await page.getByLabel("What is the skill called?").fill("Half written");
    const choice = () => page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}").workspaceId as string | undefined);
    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/skills\/new$/);
    expect(await choice()).toBe("clips");
    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    expect(await choice()).toBe("stories");
  });

  test("both ways on a phone, with the toggle in the top bar", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/review");
    await settle(page);
    await page.locator(".topbar").getByRole("link", { name: "Go to Lamo Stories" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await page.locator(".st-tabbar").getByRole("button", { name: "More pages" }).click();
    await expect(page.locator(".st-more .st-more__item")).toHaveText(["Chat", "References", "Library", "Social accounts", "Settings"]);
    await page.locator(".st-more").getByRole("link", { name: "Social accounts" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await storiesReady(page);
    await page.locator(".st-top").getByRole("link", { name: "Go to Clip Factory" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await settle(page);
    await page.locator(".topbar").getByRole("link", { name: "Go to Lamo Stories" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
  });

  test("a reload of a Lamo Stories page stays in Lamo Stories, and the choice is kept on the device", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/stories/library?kind=videos");
    await storiesReady(page);
    await page.reload();
    await storiesReady(page);
    await expect(page).toHaveURL(/\/stories\/library\?kind=videos$/);
    await expect(page.locator(".st-tabs__tab.is-on")).toHaveText("Videos");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cf.workspace") ?? "{}"));
    expect(stored).toMatchObject({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastStoriesPath: "/stories/library?kind=videos" });
  });

  test("opening the app at / when Lamo Stories was last goes to the last Lamo Stories page", async ({ page }) => {
    await on(page, () => {
      if (!sessionStorage.getItem("cf.e2e.started")) {
        sessionStorage.setItem("cf.e2e.started", "1");
        localStorage.setItem("cf.workspace", JSON.stringify({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastClipsPath: "/jobs", lastStoriesPath: "/stories/library" }));
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/stories\/library$/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    // Lamo Clips' own pages open where they are asked for.
    await page.goto("/jobs");
    await settle(page);
    await expect(page).toHaveURL(/\/jobs$/);
  });

  test("coming back to Clip Factory opens its page where it was scrolled to", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto("/library");
    await settle(page);
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    expect(room, "the Library is taller than the window").toBeGreaterThan(200);
    const y = Math.min(600, Math.round(room * 0.6));
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => Math.round(scrollY));
    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await storiesReady(page);
    await page.locator(".st-rail .ws-switch__opt", { hasText: "Clip Factory" }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 6000 }).toBe(kept);
  });

  test("ask, switch to Lamo Stories while the answer streams, switch back: the answer is there", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    const panel = page.locator("#help-panel");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Your question").fill("How do I change my click sound? #long");
    await panel.getByRole("button", { name: "Send" }).click();
    const answer = panel.locator(".ask-msg").last();
    await expect(answer.locator(".ask-answer")).toBeVisible();
    await expect(answer).toHaveAttribute("aria-busy", "true");
    const early = (await answer.locator(".ask-answer").innerText()).length;

    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await storiesReady(page);
    // Lamo Clips' Ask is not part of Lamo Stories.
    await expect(page.locator(".help-launcher, #help-panel")).toHaveCount(0);
    await page.waitForTimeout(1200);
    await page.locator(".st-rail .ws-switch__opt", { hasText: "Clip Factory" }).click();
    await settle(page);

    // The panel is open again, with the question and the answer that kept streaming meanwhile, then finished.
    await expect(panel).toBeVisible();
    await expect(panel.locator(".help-msg--me").last()).toContainText("How do I change my click sound?");
    await expect(answer.getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    expect((await answer.locator(".ask-answer").innerText()).length).toBeGreaterThan(early);
    await expect(answer.locator(".ask-sources")).toContainText("Clip Factory guide");
  });

  test("a closed Ask stays closed across a switch, and its conversation stays too", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    const panel = page.locator("#help-panel");
    await panel.getByLabel("Your question").fill("How do I change my click sound?");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await expect(panel).toHaveCount(0);
    await page.locator(".sidebar__foot .ws-switch__opt", { hasText: "Lamo Stories" }).click();
    await storiesReady(page);
    await page.locator(".st-rail .ws-switch__opt", { hasText: "Clip Factory" }).click();
    await settle(page);
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await expect(panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible();
  });
});

test.describe("the pages", () => {
  test("the dashboard shows every tile in the contract's order", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories");
    await storiesReady(page);
    const titles = await page.locator(".st-tiles > .st-tile").evaluateAll((els) => els.map((e) => (e.querySelector(".st-tile__title, .st-stat__label")?.textContent ?? "").replace(/\d+$/, "").trim()));
    expect(titles).toEqual(["Needs you", "Animations made", "Waiting for review", "Published", "Being made now", "Connected accounts", "How the videos do", "What happened lately"]);
    await expect(page.locator(".st-needs")).toBeVisible();
    await expect(page.locator(".st-tile").filter({ hasText: "Connected accounts" })).toContainText("of 5");
    await expect(page.locator(".st-tile").filter({ hasText: "How the videos do" })).toContainText("Numbers until 7 days after each post.");
  });

  test("Social accounts: logo, name and id, authorization and last checked, Clip Factory's own place, the notes, a connect", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    const cards = page.locator(".st-conn");
    await expect(cards).toHaveCount(5);
    for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X"]) await expect(cards.filter({ has: page.getByRole("heading", { name, exact: true }) }).locator(".st-conn__mark svg")).toBeVisible();
    const yt = cards.filter({ has: page.getByRole("heading", { name: "YouTube" }) });
    await expect(yt).toContainText("Lamo Stories");
    await expect(yt.locator(".st-who__id code")).toHaveText(/^UC/);
    await expect(yt.locator(".st-auth")).toContainText("Allowed: Lamo Stories may post here.");
    await expect(yt.locator(".st-auth")).toContainText("Last checked");
    await expect(yt).toContainText("Clip Factory posts to: Clip Factory Gaming");
    await expect(yt.locator(".st-app")).toContainText("Uses Clip Factory's YouTube app, on purpose.");
    // Check now: a live check, and when it was last checked.
    await yt.getByRole("button", { name: "Check now" }).click();
    await expect(page.locator(".toast").filter({ hasText: "YouTube answered. All good." })).toBeVisible();
    await expect(yt.locator(".st-auth")).toContainText(/Last checked\s*(just now|now|\d+ s ago|seconds? ago|a moment ago)/i);
    const tiktok = cards.filter({ has: page.getByRole("heading", { name: "TikTok" }) });
    await expect(tiktok).toContainText("Sign in to your Lamo Stories account on tiktok.com in this browser first.");
    await expect(tiktok.getByRole("button", { name: "Reconnect" })).toBeVisible();
    const fb = cards.filter({ has: page.getByRole("heading", { name: "Facebook" }) });
    await expect(fb).toContainText("Facebook will ask which Pages this app may use. Tick only your Lamo Stories Page.");
    await expect(fb.locator(".st-app")).toContainText("Uses its own Meta app");

    // Connect Facebook: the pretend platform sends the owner back with a list of Pages to pick from.
    await fb.getByRole("button", { name: "Connect Facebook" }).click();
    await expect(page).toHaveURL(/\/stories\/connections$/);
    await expect(page.locator(".toast").filter({ hasText: "Now pick the Facebook Page Lamo Stories posts to." })).toBeVisible();
    await expect(fb.getByRole("button", { name: /Clip Factory uses this/ })).toBeVisible();
    await fb.getByRole("button", { name: /^Lamo Stories/ }).click();
    await expect(fb.locator(".st-chip").first()).toHaveText("Connected");
    await expect(fb.locator(".st-who__id code")).toHaveText("109876543210987");
  });

  test("Social accounts: the same place as Clip Factory is only used for both after Are you sure", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    const x = page.locator(".st-conn").filter({ has: page.getByRole("heading", { name: "X" }) });
    await expect(x).toContainText("This is the same account Lamo Clips posts to.");
    await x.getByRole("button", { name: "Use it for both" }).click();
    await expect(x.getByRole("group", { name: "Are you sure?" })).toBeVisible();
    await x.getByRole("button", { name: "No, keep it as it is" }).click();
    await expect(x.locator(".st-chip").first()).toHaveText("Same as Clip Factory");
    await x.getByRole("button", { name: "Use it for both" }).click();
    await x.getByRole("button", { name: "Yes, use it for both" }).click();
    await expect(x).toContainText("You chose to use this account for both Clip Factory and Lamo Stories.");

    // Disconnect asks first, and then says where the app can be removed by hand (nothing is revoked).
    const yt = page.locator(".st-conn").filter({ has: page.getByRole("heading", { name: "YouTube" }) });
    await yt.getByRole("button", { name: "Disconnect" }).click();
    await yt.getByRole("button", { name: "Yes, disconnect" }).click();
    await expect(page.getByText("To remove Clip Factory from this account completely, remove the app in the account's own settings.")).toBeVisible();
    await expect(yt.locator(".st-chip").first()).toHaveText("Not connected");
  });

  test("Social accounts shows the result the platform sent back, once", async ({ page }) => {
    await on(page);
    await page.goto("/stories/connections?platform=youtube&result=denied&ws=stories");
    await storiesReady(page);
    await expect(page.locator(".toast").filter({ hasText: "You pressed cancel. Tap Connect YouTube to try again." })).toBeVisible();
    await expect(page).toHaveURL(/\/stories\/connections$/);
  });

  test("Social accounts: each platform asks which developer app before the first Connect, never silently", async ({ page }) => {
    await fresh(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    const card = (name: string) => page.locator(".st-conn").filter({ has: page.getByRole("heading", { name, exact: true }) });

    // X: the choice comes first; Connect stays put until an app is picked.
    const x = card("X");
    await expect(x.getByRole("radiogroup", { name: "Which X app Lamo Stories uses" }).getByRole("radio")).toHaveText([/A separate app for Lamo Stories/, /Clip Factory's app \(quicker\)/]);
    await expect(x.getByRole("button", { name: "Connect X" })).toHaveAttribute("aria-disabled", "true");
    await x.getByRole("button", { name: "Connect X" }).click({ force: true });
    await expect(page.locator(".toast").filter({ hasText: "Pick which X app Lamo Stories uses first." })).toBeVisible();
    await x.getByRole("radio", { name: /Clip Factory's app/ }).click();
    await x.getByRole("button", { name: "Use Clip Factory's app" }).click();
    await expect(x.locator(".st-app")).toContainText("Uses Clip Factory's X app, on purpose.");
    await x.getByRole("button", { name: "Connect X" }).click();
    await expect(x.locator(".st-chip").first()).toHaveText("Connected");

    // YouTube's own app: the redirect URI to copy (Lamo Stories' own callback), the keys form, Check it.
    const yt = card("YouTube");
    await yt.getByRole("radio", { name: /A separate app for Lamo Stories/ }).click();
    await expect(yt.locator(".st-copy__value")).toHaveText(/\/v1\/stories-oauth\/youtube\/callback$/);
    await expect(yt.getByRole("button", { name: "Copy the redirect uri" })).toBeVisible();
    await yt.getByLabel("Client ID").fill("not-a-client-id");
    await expect(yt.locator(".st-field__problem").first()).toContainText("ends with .apps.googleusercontent.com");
    await yt.getByLabel("Client ID").fill("123456789-abcdefghijklmnopqrstuvwxyz12.apps." + "googleusercontent.com");
    await yt.getByLabel("Client secret").fill("GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12");
    await yt.getByRole("button", { name: "Save the keys" }).click();
    await expect(yt.locator(".st-app")).toContainText("Uses its own YouTube app");
    await expect(yt.locator(".st-app code").first()).toHaveText("123456….com");
    await expect(page.locator("body")).not.toContainText("GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12");
    await yt.getByRole("button", { name: "Check it" }).click();
    await expect(yt).toContainText("Your keys work. Now press Connect YouTube.");

    // Meta: no Clip Factory choice at all; one Meta app's keys, entered once, serve Instagram and Facebook.
    const fb = card("Facebook");
    await expect(fb.getByRole("radio")).toHaveCount(0);
    await expect(fb).toContainText("Facebook always uses Lamo Stories' own Meta app");
    await fb.getByLabel("App ID").fill("1234567890123456");
    await fb.getByLabel("App secret").fill("0123456789abcdef0123456789abcdef");
    await fb.getByLabel("Configuration ID").fill("https://www.facebook.com/v27.0/dialog/oauth?config_id=9876543210987654&x=1");
    await fb.getByRole("button", { name: "Save the keys" }).click();
    await expect(page.locator(".toast").filter({ hasText: "The Meta app keys are saved for Instagram and Facebook." })).toBeVisible();
    await expect(card("Instagram").locator(".st-app")).toContainText("Uses its own Meta app");
    await expect(card("Instagram").locator(".st-app")).toContainText("…7654");
  });

  test("the setup opens by itself the first time, on its own; every step can be skipped and done later", async ({ page }) => {
    await fresh(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stories");
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await storiesReady(page);
    // On its own: no navigation, the brand and the switcher stay; the ring says 0 of 11.
    await expect(page.locator(".stories-app.is-alone")).toHaveCount(1);
    await expect(page.locator(".st-rail, .st-tabbar")).toHaveCount(0);
    await expect(page.locator(".st-top .ws-switch-host")).toBeVisible();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "0 of 11 done");
    await expect(page.locator(".st-steps__item")).toHaveCount(11);
    await expect(page.locator(".st-left__item")).toHaveCount(10);

    // 1 → 2: pick the default model; Check models really runs; saving ticks steps 1 to 3.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("#st-setup-step")).toHaveText("Pick your default model");
    await expect(page.getByRole("radiogroup", { name: "Lamo Stories' default model" }).getByRole("radio")).toHaveText([/Claude Fable 5.2/, /Claude Fable 5.1/, /Claude Opus 5.5/, /Claude Sonnet 5.5/, /Claude Haiku 5.5/, /Amazon Nova Pro/]);
    // Builder F2's mock: a sixth, mock-only model (no effort, no price), and this account cannot use Fable 5.1.
    await page.getByRole("button", { name: "Check models" }).click();
    await expect(page.locator(".toast").filter({ hasText: "5 of 6 models answered." })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("radio", { name: /Claude Fable 5.2/ }).click();
    await page.getByRole("button", { name: "Use Claude Fable 5.2" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "3 of 11 done");
    await expect(page.locator("#st-setup-step")).toHaveText("Pick your default effort");
    await page.getByRole("radio", { name: "Maximum" }).click();
    await page.getByRole("button", { name: "Use Maximum" }).click();
    await expect(page.locator("#st-setup-step")).toHaveText("Pick how videos are made");
    await page.getByRole("button", { name: "Use this" }).click();
    await expect(page.locator(".st-setup__head .st-ring")).toHaveAttribute("aria-label", "4 of 11 done");
    await expect(page.locator(".st-setup__head")).toContainText("4 of 11 done");
    // 5: agents and skills, ticked by hand.
    await expect(page.locator(".st-agent")).toHaveCount(5);
    await page.getByRole("button", { name: "Got it" }).click();
    // 6: Instagram: skip for now; it stays on the list of what is left.
    await expect(page.locator("#st-setup-step")).toHaveText("Connect Instagram");
    await expect(page.locator(".st-conn[data-platform=instagram]")).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.locator(".st-steps__item.is-skipped")).toHaveCount(1);
    await expect(page.locator(".st-left__item").filter({ hasText: "Connect Instagram" })).toContainText("skipped");

    // Later: the dashboard keeps a card with the ring and what is left, and the setup carries on from there.
    await page.getByRole("link", { name: "Do this later" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await storiesReady(page);
    await expect(page.locator(".st-rail")).toBeVisible();
    const card = page.locator(".st-setupcard");
    await expect(card).toContainText("Set up Lamo Stories: 5 of 11 done");
    await expect(card).toContainText("Still to do: Connect Instagram, Connect TikTok, Connect YouTube and 2 more.");
    // Only once per studio on this device: after a reload (the pretend server starts over at 0 of 11) the
    // dashboard stays, with the card.
    await page.reload();
    await storiesReady(page);
    await expect(page).toHaveURL(/\/stories$/);
    await expect(card).toContainText("Set up Lamo Stories: 0 of 11 done");
    await card.getByRole("link", { name: "Start the setup" }).click();
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await storiesReady(page);
    await expect(page.locator(".st-rail")).toBeVisible();
    // Step 11: finish with steps left (none of them blocks making videos): confetti, then the card is gone.
    await page.locator(".st-steps__item").filter({ hasText: "Done" }).click();
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("canvas.confetti").first()).toBeAttached();
    await expect(page).toHaveURL(/\/stories$/, { timeout: 8000 });
    await storiesReady(page);
    await expect(page.locator(".st-setupcard")).toHaveCount(0);
  });

  test("Library: files by kind with their story, Download, and a project with how it was made", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories/library");
    await storiesReady(page);
    await expect(page.getByRole("tab")).toHaveText(["Projects", "Videos", "Storyboards", "Characters", "Pictures", "Sounds", "Scenes"]);
    await page.getByRole("tab", { name: "Videos" }).click();
    await expect(page).toHaveURL(/kind=videos/);
    await storiesReady(page);
    const first = page.locator(".st-file").first();
    await expect(first.locator(".st-file__kind")).toContainText("Video");
    await expect(first.getByRole("button", { name: /^Download/ })).toBeVisible();
    await first.locator("a.st-file__title").click();
    await expect(page).toHaveURL(/\/stories\/library\?story=/);
    await storiesReady(page);
    await expect(page.getByRole("heading", { name: "How it was made" })).toBeVisible();
    await expect(page.locator(".st-details")).toContainText("Writer");
    await expect(page.locator(".st-group__title").first()).toHaveText("The video");
  });
});

test.describe("every page keeps the owner's rules", () => {
  for (const path of PAGES)
    test(`${path}: no overflow from 320 to 1920 px`, async ({ page }) => {
      await on(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await storiesReady(page);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(250);
        const o = await findOverflow(page);
        expect(o.page, `${path} @${width}: page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
        expect(o.items, `${path} @${width}`).toEqual([]);
      }
    });

  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const)
    test(`${width} px: arrow cursor, AA contrast, no visible edges, big targets`, async ({ page }) => {
      await on(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      const phone = width < 768;
      for (const path of PAGES) {
        await page.goto(path);
        await storiesReady(page);
        const cursors = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".stories-app, .stories-app *"))
            .map((el) => getComputedStyle(el).cursor)
            .filter((c) => c !== "default" && c !== "auto"),
        );
        expect(cursors, `${path}: cursor`).toEqual([]);
        const axe = await new AxeBuilder({ page }).include(".stories-app").withRules(["color-contrast"]).analyze();
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`)), `${path}: contrast`).toEqual([]);
        expect(await visibleEdges(page), `${path}: edges`).toEqual([]);
        const small = await page.evaluate((need) => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(".stories-app a[href], .stories-app button, .stories-app [role=tab], .stories-app [role=radio], .stories-app [role=switch], .stories-app input"))) {
            if (el.closest(".sr-only") || !el.checkVisibility()) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.bottom < 0 || r.right < 0 || r.top > innerHeight * 6) continue;
            if (r.width < need - 0.5 || r.height < need - 0.5) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${Math.round(r.width)}×${Math.round(r.height)} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`);
          }
          return out;
        }, phone ? 48 : 44);
        expect(small, `${path}: targets`).toEqual([]);
      }
    });

  test("every control shows itself on hover", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stories/connections");
    await storiesReady(page);
    for (const sel of [".st-rail__item:not(.is-active)", ".st-btn:not(.st-btn--main)", ".st-btn--main", ".ws-switch__opt:not(.is-on)", ".st-setupback__go"]) {
      const el = page.locator(sel).first();
      const before = await el.evaluate((e) => getComputedStyle(e).backgroundColor);
      await el.hover();
      await page.waitForTimeout(300);
      const after = await el.evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(after, sel).not.toBe(before);
      await page.mouse.move(0, 0);
    }
  });
});
