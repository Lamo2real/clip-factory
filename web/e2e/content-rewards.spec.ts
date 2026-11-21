import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle } from "./helpers.ts";

// Content Rewards campaigns (docs/CONTRACTS.md §38, §38.20), in mock mode: setup, joining, the campaign card for
// each membership, making and uploading campaign clips, each clip on Content Rewards, and getting paid. Every
// screen: one vermilion button at most, no sideways scroll, no edges, big targets, the arrow cursor, AA contrast.

const IDS = {
  faze: "200ea21b-be80-4db8-b552-8e32b148604e",
  apply: "a1cefc3b-4533-438f-8e70-a7299550f1cf",
  logo: "3b1e6c3e-1f0a-4a55-9a8e-6f2b9d1c4e70",
  paused: "4c2f7d4f-2a1b-4b66-8b9f-7a3c0e2d5f81",
  group: "6e4b9f61-4c3d-4d88-adb0-9c5e2a4f7ba3",
  manual: "9b7ecd94-7f6a-4abb-a0e3-cf8b5d7cae06",
  money: "0c8fdea5-8a7b-4bcc-b1f4-d09c6e8dbf17",
};
const CR_URL = (id: string) => `https://contentrewards.com/c/campaigns/${id}`;
const SETUP = "/settings/posting/setup/contentrewards";

const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;

type Cr = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { cr?: Cr; setup?: Cr } };

/** Start states read once by the mock (src/api/mock/contentrewards.ts). */
async function start(page: Page, flags: { fresh?: boolean; review?: boolean | "tiktok"; off?: "404" | "503" } = {}) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("cf-e2e-cr-init")) return;
    sessionStorage.setItem("cf-e2e-cr-init", "1");
    if (f.fresh) sessionStorage.setItem("cf-mock-cr-start", "fresh");
    if (f.review) sessionStorage.setItem("cf-mock-cr-review", f.review === "tiktok" ? "tiktok" : "1");
    if (f.off) sessionStorage.setItem("cf-mock-cr-off", f.off);
  }, flags);
}

async function mock(page: Page) {
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.cr && !!(window as MockWin).__cfMock?.setup);
}
const cr = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => (window as MockWin).__cfMock!.cr![fn as string]!(...(args as unknown[])), [fn, args] as const);
const finishSetup = (page: Page, ...platforms: string[]) =>
  page.evaluate((ps) => {
    for (const p of ps) (window as MockWin).__cfMock!.setup!.finish!(p);
  }, platforms);

/** The screen's vermilion buttons (each screen has at most one). */
const tomatoes = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });

async function screenProblems(page: Page, phone: boolean): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`sideways scroll ${o.page} > ${o.viewport}`);
  const bad = await page.evaluate((min) => {
    const found: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>("main button, main a.btn, main summary, main .check-chip")) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      if (b.height < min - 0.5) found.push(`"${name}" is ${Math.round(b.width)}x${Math.round(b.height)}`);
      const cur = getComputedStyle(e).cursor;
      if (cur !== "auto" && cur !== "default") found.push(`"${name}" has cursor ${cur}`);
    }
    // Every red-filled control on the whole page (the floating setup list and the paste box too), not only main's.
    const redFill = (e: HTMLElement) => {
      const cs = getComputedStyle(e);
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(`${cs.backgroundImage} ${cs.backgroundColor}`);
      return !!m && Number(m[1]) > 150 && Number(m[2]) < 90 && Number(m[3]) < 80;
    };
    const red = [...document.querySelectorAll<HTMLElement>(".btn, .linkbox__paste")].filter((e) => e.getBoundingClientRect().height > 0 && !e.closest(".update-bar") && redFill(e));
    if (red.length > 1) found.push(`${red.length} vermilion buttons: ${red.map((e) => e.textContent?.trim()).join(" | ")}`);
    return found;
  }, phone ? 48 : 44);
  out.push(...bad);
  out.push(...(await visibleEdges(page)).filter((e) => /cr-|campaign|money|setup-card|gstep/.test(e)));
  return out;
}

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  const phone = name === "phone";
  test.describe(`${name}`, () => {
    test.use(use);

    test("Set up posting: five platform cards, the Content Rewards card apart, the floating list still 0/5", async ({ page }) => {
      await start(page, { fresh: true });
      await page.goto("/settings/posting/setup");
      await settle(page);
      await expect(page.getByRole("list", { name: "The five platforms" }).locator(".setup-card")).toHaveCount(5);
      const card = page.locator("[data-cr='card']");
      await expect(card).toContainText("Content Rewards");
      await expect(card).toContainText("Not started");
      await expect(page.getByRole("heading", { name: "Get paid by brands" })).toBeVisible();
      await card.click();
      await expect(page).toHaveURL(new RegExp(`${SETUP}$`));
      await expect(page.getByRole("heading", { name: "Content Rewards", level: 1 })).toBeVisible();
      // The floating setup list (§17.13) still counts five places, never Content Rewards.
      await page.goto("/");
      await settle(page);
      await expect(page.locator(".setup-todo")).toContainText(/0\/5|0 of 5/);
    });

    test("the setup page: steps 1 and 2 tick with I did this, the ring counts 3, the folds open", async ({ page }) => {
      await start(page, { fresh: true });
      await page.goto(SETUP);
      await settle(page);
      await expect(page.locator(".setup-head")).toContainText("0/3");
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Open Content Rewards/);
      await page.locator("#step-ready-account").getByRole("button", { name: "I did this" }).click();
      await expect(page.locator("#step-ready-account")).toHaveAttribute("data-done", "true");
      await expect(page.locator(".setup-head")).toContainText("1/3");
      const socials = page.locator("#step-ready-socials");
      await expect(socials.locator(".gstep__body")).toBeVisible();
      await socials.getByText("Content Rewards says Not a professional account?").click();
      await expect(socials.locator("#fold-instagram")).toContainText("Tap Account type and tools.");
      await socials.getByRole("button", { name: "I did this" }).click();
      await expect(page.locator(".setup-head")).toContainText("2/3");
      const connect = page.locator("#step-connect");
      // Step 3's Mac-app lines and hints never show where Connect can't run.
      await expect(connect).not.toContainText("Your web browser opens");
      await expect(connect).not.toContainText("If you see");
      if (phone) {
        await expect(connect).toContainText("Do this step on your Mac. Open Clip Factory there, then Settings, Set up posting, Content Rewards.");
        await expect(connect.getByRole("button", { name: "Connect Content Rewards", exact: true })).toHaveCount(0);
        await expect(tomatoes(page)).toHaveCount(0);
      } else {
        await expect(connect).toContainText("Connect works in the Clip Factory app on your Mac.");
        await expect(tomatoes(page)).toHaveText(/Get the app/);
      }
      expect(await screenProblems(page, phone)).toEqual([]);
    });

    test("Home: a campaign link is recognised; a group asks which one; an invite link says what to do", async ({ page }) => {
      await start(page, { fresh: true });
      await page.goto("/");
      await settle(page);
      const box = page.getByLabel("YouTube, Twitch or Kick link");
      await box.fill("https://contentrewards.com/c/invite/abc123");
      await expect(page.locator(".newjob")).toContainText("That's an invite link. Open it, join, then copy the campaign's own link");
      await box.fill(`${CR_URL(IDS.group)}?group=1`);
      await expect(page.locator(".newjob")).toContainText("That's a Content Rewards campaign!");
      await page.getByRole("button", { name: "Add campaign" }).click();
      await expect(page.getByText("This link is a group of campaigns. Tap the one you want.")).toBeVisible();
      await expect(page.locator(".cr-choice")).toHaveCount(2);
      await box.fill(CR_URL(IDS.faze));
      const add = page.getByRole("button", { name: "Add campaign" });
      await expect(add).toHaveClass(/btn--primary/);
      await add.click();
      await expect(page).toHaveURL(new RegExp(`/campaigns/${IDS.faze}$`));
      await expect(page.locator(".cr-head")).toContainText("FaZe Clips");
    });

    test("Campaigns, empty: Open Content Rewards is the vermilion until a link is pasted, then Add campaign", async ({ page }) => {
      await start(page, { fresh: true });
      await page.goto("/campaigns");
      await settle(page);
      await expect(page.locator(".cr-join .gstep")).toHaveCount(3);
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Open Content Rewards/);
      await page.getByLabel("Paste a Content Rewards campaign link").fill(CR_URL(IDS.faze));
      await expect(tomatoes(page)).toHaveCount(1);
      await expect(tomatoes(page)).toHaveText(/Add campaign/);
      expect(await screenProblems(page, phone)).toEqual([]);
    });
  });
}

test.describe("desktop journeys", () => {
  test.use(DESKTOP);

  test("the Mac app: Connect → pretend consent → Allow → confetti and Content Rewards is connected!", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    await page.goto(SETUP);
    await settle(page);
    await page.locator("#step-ready-account").getByRole("button", { name: "I did this" }).click();
    await page.locator("#step-ready-socials").getByRole("button", { name: "I did this" }).click();
    const connect = page.getByRole("button", { name: "Connect Content Rewards", exact: true });
    await expect(connect).toHaveClass(/btn--primary/);
    const popup = page.waitForEvent("popup");
    await connect.click();
    await expect(page.getByText("Waiting for you in the browser…")).toBeVisible();
    const consent = await popup;
    await consent.getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".result-card")).toContainText("Content Rewards is connected!");
    await expect(page.locator("canvas.confetti")).toHaveCount(1);
    await expect(page.getByLabel("Content Rewards: ready")).toBeVisible();
    await expect(page.locator("[data-help='cr-ready']")).toContainText("Clip Factory sends your campaign clips for you.");
    // With no campaign yet and nothing else to do, Add a campaign is the one vermilion.
    await expect(tomatoes(page)).toHaveText(/Add a campaign/);
  });

  test("Cancel on the consent page gives the denied card; read only opens Content Rewards said no?", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    await page.goto(SETUP);
    await settle(page);
    await page.locator("#step-connect .gstep__head").click();
    let popup = page.waitForEvent("popup");
    await page.locator("#step-connect").getByRole("button", { name: "Connect Content Rewards", exact: true }).click();
    await (await popup).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".result-card")).toContainText("You didn't allow it. Tap Connect Content Rewards to try again.");
    // The answer is where he is: inside step 3, right above its button, on screen.
    await expect(page.locator("#step-connect .result-card")).toBeInViewport();

    await mock(page);
    await cr(page, "setResult", "read_only");
    popup = page.waitForEvent("popup");
    await page.locator("#step-connect").getByRole("button", { name: "Connect Content Rewards", exact: true }).click();
    await (await popup).getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".result-card")).toContainText("Connected, but Content Rewards hasn't let Clip Factory send clips yet.");
    const pilot = page.locator("[data-help='cr-pilot-email']");
    await expect(pilot).toContainText("Content Rewards turns this on by email.");
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/Open email/);
    await expect(pilot.getByRole("button", { name: "Copy Email to Content Rewards" })).toHaveCount(0);
    await pilot.getByRole("button", { name: "Show more" }).click();
    await expect(pilot.getByRole("button", { name: "Copy Email to Content Rewards" })).toBeVisible();
    await pilot.getByRole("button", { name: "I sent it" }).click();
    await expect(pilot).toContainText("Content Rewards will email you back.");
    await expect(page.locator("[data-cr='card']")).toHaveCount(0);
  });

  test("Connect before ticking step 2: the answer is on screen, and step 2's Open is the one vermilion (no Add a campaign yet)", async ({ page }) => {
    await start(page, { fresh: true });
    await asMacWindow(page, { crConnect: true });
    await page.goto(SETUP);
    await settle(page);
    await page.locator("#step-connect .gstep__head").click();
    const popup = page.waitForEvent("popup");
    await page.locator("#step-connect").getByRole("button", { name: "Connect Content Rewards", exact: true }).click();
    await (await popup).getByRole("button", { name: "Allow" }).click();
    await expect(page.locator("#step-connect .result-card")).toContainText("Content Rewards is connected!");
    await expect(page.locator("#step-connect .result-card")).toBeInViewport();
    // Content Rewards doesn't know his YouTube yet (as after a real first Connect: step 2 is not done).
    await mock(page);
    await cr(page, "unlink", "youtube");
    // Step 3's three lines show once, in the Mac app only.
    expect(((await page.locator("#step-connect").textContent()) ?? "").split("Your web browser opens").length - 1).toBe(1);
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/Open Content Rewards settings/);
    await expect(page.getByRole("link", { name: "Add a campaign" })).toHaveCount(0);
    await expect(page.locator("[data-help='cr-ready']")).toContainText("You're connected");
    expect(await screenProblems(page, false)).toEqual([]);
  });

  test("Disconnect, then Undo keeps it; the sign-in-again week has one vermilion", async ({ page }) => {
    await start(page);
    await asMacWindow(page, { crConnect: true });
    await page.goto(SETUP);
    await settle(page);
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-help='cr-ready']")).toContainText("Clip Factory sends your campaign clips for you.");
    await mock(page);
    await cr(page, "expireSoon");
    await expect(page.locator(".cr-calm")).toContainText(/Sign in to Content Rewards again by \w{3} \d{1,2} \w{3}\. It takes one minute\./);
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/Connect again/);
  });

  test("not connected → Can't connect now? → It says Submit clip → the rules box → I'm in. Read these rules → Make clips", async ({ page }) => {
    await start(page, { fresh: true });
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram");
    await page.goto("/campaigns");
    await settle(page);
    await page.getByLabel("Paste a Content Rewards campaign link").fill(CR_URL(IDS.faze));
    await page.getByRole("button", { name: "Add campaign" }).click();
    const next = page.locator("[data-help='cr-next-step']");
    await expect(page.locator(".cr-chip")).toHaveText("Connect first");
    await expect(next).toContainText("Connect Content Rewards so I can see if you're in.");
    await expect(tomatoes(page)).toHaveText(/Connect Content Rewards/);
    await next.getByText("Can't connect now?").click();
    await next.getByRole("button", { name: "It says Submit clip" }).click();
    // The rules are hidden until he joins: the box opens at once, and saying "I'm in" and giving the rules is one step.
    const box = next.getByLabel("The campaign's rules");
    await expect(box).toBeVisible();
    await expect(tomatoes(page)).toHaveText(/I'm in\. Read these rules/);
    await box.fill("Clips 20 to 60 seconds. Use #FaZe and @FaZeClan in every caption.");
    await tomatoes(page).click();
    await expect(page.locator(".cr-chip")).toHaveText("You're in");
    await expect(next).toContainText("You're in. After each post, I'll remind you to send it to Content Rewards yourself.", { timeout: 10_000 });
    await expect(tomatoes(page)).toHaveText(/Make clips for this campaign/);
    await expect(page.locator("[data-help='cr-rules']")).toContainText("#FaZe");
  });

  test("Content Rewards said no: Check it yourself → Open campaign, then the pasted rules make I'm in the vermilion", async ({ page }) => {
    await start(page, { fresh: true });
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube");
    await cr(page, "refuse");
    await page.goto("/campaigns");
    await settle(page);
    await page.getByLabel("Paste a Content Rewards campaign link").fill(CR_URL(IDS.faze));
    await page.getByRole("button", { name: "Add campaign" }).click();
    const next = page.locator("[data-help='cr-next-step']");
    await expect(page.locator(".cr-chip")).toHaveText("Check it yourself");
    await expect(next).toContainText("Content Rewards hasn't let Clip Factory look yet.");
    await expect(tomatoes(page)).toHaveText(/Open campaign/);
    await expect(next.locator(".cr-next__lines li")).toHaveCount(2);
    await next.getByLabel("The campaign's rules").fill("Use #FaZe in every caption.");
    await expect(tomatoes(page)).toHaveText(/I'm in\. Read these rules/);
    // Open campaign (the first line's button) still has a glass button, above the box.
    await expect(next.locator(".cr-next__glass").getByRole("link", { name: /Open campaign/ })).toBeVisible();
    await tomatoes(page).click();
    await expect(page.locator(".cr-chip")).toHaveText("You're in");
  });

  test("an application campaign: Yes, I applied → waiting (no vermilion) → the brand says yes → You're in! once", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube");
    await page.goto(`/campaigns/${IDS.apply}`);
    await settle(page);
    const next = page.locator("[data-help='cr-next-step']");
    await expect(page.locator(".cr-chip")).toHaveText("Applied?");
    await expect(tomatoes(page)).toHaveText(/Yes, I applied/);
    await tomatoes(page).click();
    await expect(page.locator(".cr-chip")).toHaveText("Waiting for the brand");
    await expect(next).toContainText("Nothing to do. I'll tell you when you're in.");
    await expect(tomatoes(page)).toHaveCount(0);
    await mock(page);
    await cr(page, "sayYes", IDS.apply);
    await expect(page.locator(".cr-chip")).toHaveText("You're in");
    await expect(page.getByText("You're in!").first()).toBeVisible();
    await expect(page.locator("canvas.confetti")).toHaveCount(1);
    // Soft stop (half the money used): one "Make clips anyway", then Make clips.
    await expect(tomatoes(page)).toHaveText(/Make clips anyway/);
    await tomatoes(page).click();
    await expect(tomatoes(page)).toHaveText(/Make clips for this campaign/);
    await page.reload();
    await settle(page);
    await expect(page.locator("canvas.confetti")).toHaveCount(0);
  });

  test("the logo: SVG refused, a Drive folder refused, a Drive file added", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube");
    await page.goto(`/campaigns/${IDS.logo}`);
    await settle(page);
    await expect(tomatoes(page)).toHaveText(/Add the logo/);
    const logo = page.locator("[data-help='cr-logo']");
    await logo.locator("input[type=file]").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(logo).toContainText("Clip Factory needs a PNG, JPG or WebP picture. Save the logo as PNG and try again.");
    await logo.getByLabel("Or type the logo's link").fill("https://drive.google.com/drive/folders/abc");
    await logo.getByLabel("Or type the logo's link").press("Enter");
    await expect(logo).toContainText("That's a folder. Open the logo file in it, then copy that link.");
    await logo.locator("input[type=file]").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) });
    await expect(logo).toContainText("Logo added ✓");
    await expect(tomatoes(page)).toHaveText(/Make clips for this campaign/);
  });

  test("Make clips → Home with the campaign picked and its channel chip; Check now", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram");
    await page.goto(`/campaigns/${IDS.faze}`);
    await settle(page);
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.locator(".cr-head")).toContainText("Checked");
    await expect(page.locator("[data-help='cr-pay']")).toContainText("$1.00 per 1,000 views");
    await expect(page.locator("[data-help='cr-things-you-do']")).toContainText("Keep each clip up for 30 days. Don't delete it.");
    await tomatoes(page).click();
    await expect(page).toHaveURL(new RegExp(`/\\?campaign=${IDS.faze}$`));
    const bar = page.locator(".cr-for");
    await expect(bar.locator(".segmented__opt.is-on")).toContainText("FaZe Clips");
    await expect(bar.getByRole("link", { name: /Open FaZe Clan's YouTube/ })).toHaveAttribute("href", "https://www.youtube.com/@FaZeClan/videos");
    await expect(bar).toContainText("Pick a video there. Copy its link. Come back and tap Paste.");
  });

  test("Make clips while the brand's new rules are being read: Reading the rules…, then it starts by itself once", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram");
    await page.goto(`/?campaign=${IDS.faze}`);
    await settle(page);
    await page.getByLabel("YouTube, Twitch or Kick link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await expect(page.locator(".newjob")).toContainText(/YouTube/);
    // The rules changed on Content Rewards a moment ago: Home doesn't know yet. The read takes 4 s here, so a slow
    // machine's click still lands while it runs.
    await cr(page, "rulesChanged", IDS.faze, 4000);
    await page.getByRole("button", { name: "Make clips", exact: true }).click();
    await expect(page.locator(".newjob")).toContainText("Reading the rules… I start your clips when they are ready.");
    await expect(page).toHaveURL(/\/jobs\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
  });

  test("Review: the strip, only the paid places, I linked it brings YouTube back, the locked YouTube choices", async ({ page }) => {
    await start(page, { review: true });
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram", "x");
    await cr(page, "unlink", "youtube");
    await page.goto("/review");
    await settle(page);
    const card = page.locator(".review-card").filter({ has: page.locator("[data-help='cr-review-strip']") });
    await expect(card.locator(".cr-strip")).toContainText("For FaZe Clips · Content Rewards");
    await expect(card.locator(".cr-strip")).toContainText("#Ad at the start");
    await expect(card.locator(".upload-chip")).toHaveCount(1);
    await expect(card.locator(".upload-to")).toContainText("Only places this campaign pays for.");
    await expect(card.locator(".upload-to")).toContainText("Link YouTube inside Content Rewards first.");
    await card.getByRole("button", { name: "I linked it" }).click();
    await expect(card.locator(".upload-chip")).toHaveCount(2);
    await expect(card.locator(".upload-chip", { hasText: "YouTube" })).toHaveAttribute("aria-pressed", "true");
    await expect(card.locator("[data-place='youtube'] .place-row__now")).toHaveText("Who can see it: Everyone · Made for kids: No · Paid promotion");
    await card.locator("[data-place='youtube'] summary").click();
    await expect(card.locator("[data-place='youtube']")).toContainText("Campaign clips are public, never made for kids, and marked as paid.");
    await expect(card.locator("[data-place='youtube']").getByRole("switch", { name: "Made for kids" })).toHaveCount(0);
    await expect(card).toContainText("After it posts, Clip Factory sends it to Content Rewards by itself.");
    await expect(card.getByRole("button", { name: "Your settings are on" })).toBeVisible();
    await card.getByRole("button", { name: "Upload to 2" }).click();
    await expect(page.getByText("Uploading to 2 places!")).toBeVisible();
  });

  test("each clip on Content Rewards: approved, not approved with Ask again, send by hand with one line for two posts, proof", async ({ page, context }) => {
    await start(page);
    await page.goto(`/campaigns/${IDS.money}`);
    await settle(page);
    const clips = page.locator("[data-help='cr-campaign-clips']");
    await expect(clips).toContainText("3 approved · 0 waiting · 2 not approved");
    await expect(clips.locator("[data-state='approved']").filter({ hasText: "Approved ✓ · 12.3K views on YouTube" })).toHaveCount(1);
    const rejected = clips.locator("[data-state='rejected']").filter({ hasText: "Logo missing" });
    await expect(rejected).toContainText("Next time: keep the logo on screen the whole clip.");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const popup = page.waitForEvent("popup");
    await rejected.getByRole("button", { name: "Ask again" }).click();
    expect((await popup).url()).toBe("https://contentrewards.com/c/submissions");
    await expect(page.getByText("Words copied.")).toBeVisible();
    await rejected.getByRole("button", { name: "I asked" }).click();
    await expect(clips.locator("[data-state='rejected']").filter({ hasText: "Asked again ✓" })).toHaveCount(1);

    // Two posts of one clip wait to be sent by hand: one line, the smallest minutes left, its copy the two links.
    await mock(page);
    const pairs = await clips.locator("[data-post]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-clip")!, e.getAttribute("data-post")!] as const));
    const byClip = new Map<string, string[]>();
    for (const [clip, post] of pairs) byClip.set(clip, [...(byClip.get(clip) ?? []), post]);
    const two = [...byClip.values()].find((list) => list.length >= 2)!;
    await cr(page, "sendFails", two[0]);
    await cr(page, "sendFails", two[1]);
    // The waiting send comes first on the card, and its Copy and open is the screen's one vermilion (§38.6).
    const first = page.locator(".cr-send-first");
    await expect(first).toContainText(/Send your clip now \(1[12] min left\)\. Then make more clips\./);
    const line = first.locator("[data-state='send_by_hand']");
    await expect(line).toHaveCount(1);
    await expect(clips.locator("[data-state='send_by_hand']")).toHaveCount(0);
    await expect(tomatoes(page)).toHaveCount(1);
    await expect(tomatoes(page)).toHaveText(/Copy and open/);
    await expect(line).toContainText(/Send these 2 to Content Rewards now \(1[12] min left\)/);
    await expect(line.getByRole("button", { name: "Copy and open" })).toBeVisible();
    await expect(line.getByRole("button", { name: "Copy link" })).toBeVisible();
    await line.getByRole("button", { name: "Copy link" }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).split("\n")).toHaveLength(2);
    await line.getByRole("button", { name: "I sent it" }).click();
    await expect(clips.locator("[data-state='sent_by_hand']").first()).toContainText("You sent it ✓ · Looking for it on Content Rewards…");

    // Proof the brand asks for.
    const approved = await clips.locator("[data-state='approved']").first().getAttribute("data-post");
    await cr(page, "proofDue", approved);
    await expect(clips).toContainText("To do: send the brand a screen recording of this clip's views.");
    await clips.locator(`[data-post='${approved}']`).getByRole("button", { name: "I sent it" }).click();
    await expect(clips).not.toContainText("To do: send the brand a screen recording of this clip's views.");
  });

  test("Library shows each campaign clip's Content Rewards line (read per campaign, as the API answers)", async ({ page }) => {
    await start(page);
    await page.goto("/library");
    await settle(page);
    await expect(page.locator(".library-grid [data-help='cr-post-line']").first()).toBeVisible();
    await expect(page.locator(".library-grid [data-help='cr-post-line'][data-state='approved']").first()).toContainText("Approved ✓");
  });

  test("the Mac banner: a waiting send shows on other pages in green, never on the line's own page", async ({ page }) => {
    await start(page);
    await asMacWindow(page);
    await page.goto(`/campaigns/${IDS.money}`);
    await settle(page);
    await mock(page);
    const post = await page.locator("[data-help='cr-campaign-clips'] [data-post]").first().getAttribute("data-post");
    await cr(page, "sendFails", post);
    await page.goto("/jobs");
    await settle(page);
    const banner = page.locator(".cr-sendnow");
    // It names the clip, so he knows which one to send.
    await expect(banner).toContainText(/Send “.+” to Content Rewards now \(\d+ min left\)/);
    await expect(banner.getByRole("button", { name: "Copy and open" })).toHaveClass(/btn--leaf/);
    await page.goto(`/campaigns/${IDS.money}`);
    await settle(page);
    await expect(page.locator(".cr-sendnow")).toHaveCount(0);
  });

  test("Money: Finance first, the three tiles with their hints, one step, the celebration", async ({ page }) => {
    await start(page);
    await page.goto("/money#content-rewards");
    await settle(page);
    const part = page.locator("#content-rewards");
    await expect(part).toContainText("Whop is the website where Content Rewards sends your money. From there it goes to your bank.");
    await expect(part.locator("[data-tile='still']")).toContainText("$4.20");
    await expect(part.locator("[data-tile='still']")).toContainText("On Content Rewards: Queued and Arriving.");
    await expect(part.locator("[data-tile='way']")).toContainText("$0.00");
    await expect(part.locator("[data-tile='ready']")).toContainText("$18.25");
    await expect(part).toContainText("Content Rewards paid you $62.40 so far");
    await expect(part).toContainText("3 clips are waiting for the brand.");
    await expect(part.locator(".btn--primary")).toHaveCount(0);
    await part.locator(".segmented__opt", { hasText: /^No$/ }).click();
    // Step 1 first: a first-timer links Whop before he can move money there.
    await expect(part.locator(".btn--primary")).toHaveCount(1);
    await expect(part.locator(".btn--primary")).toContainText("Open Content Rewards settings");
    await part.locator("#step-move-whop").getByRole("button", { name: "I did this" }).click();
    await expect(part.locator(".btn--primary")).toHaveCount(1);
    await expect(part.locator(".btn--primary")).toContainText("Open Earnings");
    await expect(part.locator("#step-move-withdraw")).toContainText("18.25");
    await part.getByRole("button", { name: "Change my answer" }).click();
    await part.locator(".segmented__opt", { hasText: /^Yes$/ }).click();
    await expect(part.locator("#step-fin-setup")).toBeVisible();
    await expect(part.locator("#step-move-whop")).toHaveCount(0);
    // With Finance, Set up payouts comes first, and Move money's hint points at it.
    await expect(part.locator(".btn--primary")).toHaveCount(1);
    await expect(part.locator("#step-fin-setup .btn--primary")).toHaveCount(1);
    await mock(page);
    await cr(page, "pay", 421);
    await expect(page.getByText("Money from Content Rewards! $4.21 is in your balance.")).toBeVisible();
    await expect(page.locator("canvas.confetti")).toHaveCount(1);
  });

  test("an API from before Content Rewards (404): every part and link is hidden", async ({ page }) => {
    await start(page, { off: "404" });
    await page.goto("/settings/posting/setup");
    await settle(page);
    await expect(page.locator("[data-cr='card']")).toHaveCount(0);
    await page.goto("/");
    await settle(page);
    await expect(page.locator(".cr-row")).toHaveCount(0);
    await page.getByLabel("YouTube, Twitch or Kick link").fill(CR_URL(IDS.faze));
    await expect(page.locator(".newjob")).toContainText("Clip Factory can't use Content Rewards links yet.");
  });

  test("switched off (503 unavailable): Coming soon, with no button", async ({ page }) => {
    await start(page, { off: "503" });
    await page.goto("/settings/posting/setup");
    await settle(page);
    await expect(page.locator(".setup-card.is-soon")).toContainText("Coming soon");
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.getByText("Content Rewards is coming soon to Clip Factory.")).toBeVisible();
  });
});

test.describe("phone: the main button stays pinned", () => {
  test.use(PHONE);
  test("the next step's button stays bottom right while scrolling the campaign card down to the logo", async ({ page }) => {
    await start(page);
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram", "facebook");
    await page.goto(`/campaigns/${IDS.logo}`);
    await settle(page);
    const main = tomatoes(page);
    await expect(main).toHaveCount(1);
    await expect(main).toHaveText(/Add the logo/);
    const vw = page.viewportSize()!.width;
    const vh = page.viewportSize()!.height;
    for (const part of [".cr-pay", ".cr-rules", ".cr-logo"]) {
      await page.locator(part).scrollIntoViewIfNeeded();
      await settle(page);
      const box = (await main.boundingBox())!;
      expect(box.x + box.width, part).toBeGreaterThan(vw / 2);
      expect(box.y, part).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, part).toBeLessThanOrEqual(vh);
    }
  });

  test("the setup page: the current step's Open is pinned bottom right", async ({ page }) => {
    await start(page, { fresh: true });
    await page.goto(SETUP);
    await settle(page);
    const main = tomatoes(page);
    await expect(main).toHaveCount(1);
    const box = (await main.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width / 2);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("Campaigns with none yet: the join steps come first, Paste is glass, one vermilion on the first screen", async ({ page }) => {
    await start(page, { fresh: true });
    await page.goto("/campaigns");
    await settle(page);
    await expect(page.locator(".cr-paste .linkbox__paste")).not.toHaveCSS("background-image", /206, 48, 36/);
    await expect(tomatoes(page)).toHaveText(/Open Content Rewards/);
    await expect(tomatoes(page)).toBeInViewport();
    await expect(page.locator("#step-join-copy")).toBeVisible();
    expect(await screenProblems(page, true)).toEqual([]);
  });
});

test.describe("campaign clips after Upload", () => {
  test.use(DESKTOP);

  test("Review: a campaign that pays for TikTok leaves TikTok out until its audit, and says so", async ({ page }) => {
    await start(page, { review: "tiktok" });
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram", "tiktok");
    await page.goto("/review");
    await settle(page);
    const card = page.locator(".review-card").filter({ has: page.locator("[data-help='cr-review-strip']") });
    await expect(card.locator(".upload-to")).toContainText("TikTok is left out for now. Until TikTok checks Clip Factory, TikTok posts are private, and private posts can't earn.");
    await expect(card.locator(".upload-chip", { hasText: "TikTok" })).toHaveCount(0);
    await expect(card.locator(".upload-chip")).toHaveCount(2);
  });

  test("the clip's line walks Sending → Sent → Approved after Upload", async ({ page }) => {
    test.setTimeout(60_000);
    await start(page, { review: true });
    await page.goto("/");
    await mock(page);
    await finishSetup(page, "youtube", "instagram");
    await page.goto("/review");
    await settle(page);
    const card = page.locator(".review-card").filter({ has: page.locator("[data-help='cr-review-strip']") });
    const clipId = ((await card.getAttribute("aria-labelledby")) ?? "").replace(/^hook-/, "");
    expect(clipId).not.toBe("");
    const mine = card.getByRole("button", { name: "Use my settings" });
    if (await mine.count()) await mine.click();
    await card.getByRole("button", { name: /^Upload to \d/ }).click();
    await expect(page.getByText(/Uploading to \d places?!/)).toBeVisible();
    // The posts go live.
    await page.evaluate((id) => (window as unknown as { __cfMock: { posting: { settleWithOneFailed(c: string, p: string): void } } }).__cfMock.posting.settleWithOneFailed(id, "tiktok"), clipId);
    // In-app (the mock's uploaded posts live in this page only, so no reload).
    await page.evaluate((id) => {
      history.pushState({}, "", `/clips/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, clipId);
    await settle(page);
    const lines = page.locator(".cr-clip [data-help='cr-post-line']");
    await expect(lines.first()).toContainText("Sending to Content Rewards…");
    await page.waitForTimeout(1700);
    await page.locator(".cr-clip").getByRole("button", { name: "Check now" }).click();
    await expect(lines.first()).toContainText("Sent ✓ · Waiting for the brand to check it");
    await page.waitForTimeout(4600);
    await page.locator(".cr-clip").getByRole("button", { name: "Check now" }).click();
    await expect(lines.first()).toContainText("Approved ✓");
  });
});

test.describe("reduced motion", () => {
  test.use({ ...DESKTOP, reducedMotion: "reduce" });
  test("You're in! without confetti", async ({ page }) => {
    await start(page);
    await page.goto(`/campaigns/${IDS.apply}`);
    await settle(page);
    await mock(page);
    await cr(page, "sayYes", IDS.apply);
    await expect(page.locator(".cr-chip")).toHaveText("You're in");
    await expect(page.locator("canvas.confetti")).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const)
  for (const [name, use] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ] as const)
    test.describe(`every Content Rewards page, ${name}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });
      test("fits, one vermilion at most, no edges, big targets, the arrow cursor, AA contrast; the phone's main button bottom right", async ({ page }) => {
        test.setTimeout(120_000);
        const phone = name === "phone";
        await start(page);
        await page.goto("/");
        await mock(page);
        await finishSetup(page, "youtube", "instagram", "facebook");
        const failures: string[] = [];
        for (const path of [SETUP, "/campaigns", `/campaigns/${IDS.faze}`, `/campaigns/${IDS.apply}`, `/campaigns/${IDS.money}`, `/campaigns/${IDS.paused}`]) {
          await page.goto(path);
          await settle(page);
          for (const p of await screenProblems(page, phone)) failures.push(`${path}: ${p}`);
          const axe = await new AxeBuilder({ page }).include("main").withRules(["color-contrast"]).analyze();
          for (const v of axe.violations) for (const n of v.nodes) failures.push(`${path}: contrast ${n.target.join(" ")}`);
          if (phone) {
            const main = tomatoes(page);
            if (await main.count()) {
              const box = (await main.first().boundingBox())!;
              const vw = page.viewportSize()!.width;
              const vh = page.viewportSize()!.height;
              if (box.x + box.width < vw / 2) failures.push(`${path}: the main button is not on the right`);
              // Pinned: on the first screen, inside the viewport and above the tab bar.
              if (box.y < 0 || box.y + box.height > vh) failures.push(`${path}: the main button is off screen (${Math.round(box.y)})`);
            }
          }
        }
        expect(failures, failures.join("\n")).toEqual([]);
      });
    });

test("no sideways scroll from 320 to 1920 on the campaign card and the setup page", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  const failures: string[] = [];
  for (const width of [320, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [SETUP, `/campaigns/${IDS.faze}`, "/campaigns"]) {
      await page.goto(path);
      await settle(page);
      const o = await findOverflow(page);
      if (o.page > o.viewport) failures.push(`${width} ${path}: ${o.page} > ${o.viewport}`);
    }
  }
  expect(failures).toEqual([]);
});
