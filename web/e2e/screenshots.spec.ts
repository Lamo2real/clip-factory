import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIVE_SCENE, asDesktop, INACTIVE_FLOOR, paintGlass } from "./glass.ts";
import { CLIPS, openClip, openTodo, settle } from "./helpers.ts";
import { GALLERY, pauseActs, tapAct } from "./motionHelpers.ts";

const dir = process.env.CF_SCREENSHOT_DIR || join(import.meta.dirname, "..", "screenshots");
mkdirSync(dir, { recursive: true });

const SIZES = [
  { name: "phone", width: 390, height: 844, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
];
const PAGES = [
  { name: "home", path: "/" },
  { name: "home-update", path: "/?update=1" },
  { name: "review", path: "/review" },
  { name: "settings", path: "/settings" },
  { name: "settings-look-and-feel", path: "/settings/look-and-feel" },
  { name: "settings-look-and-feel-sounds", path: "/settings/look-and-feel/sounds" },
  { name: "get-app", path: "/get-app" },
];

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    for (const p of PAGES) {
      test(`screenshot ${p.name}`, async ({ page }) => {
        await page.goto(p.path);
        await settle(page);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(dir, `${p.name}-${size.width}x${size.height}.png`) });
      });
    }
  });
}

// The clip performance page and Library › This week (§16.8), light and dark, phone and desktop. The page top shows
// the video and the lines; "-stacks" is scrolled to the five platform stacks.
for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: size.touch,
        isMobile: size.touch,
        colorScheme: scheme,
      });
      const suffix = `${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}`;
      test(`screenshot clip performance ${scheme}`, async ({ page }) => {
        await openClip(page, CLIPS.all);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(dir, `clip-performance${suffix}.png`) });
        await page.evaluate(() => {
          const top = document.querySelector(".perf__preview")!.getBoundingClientRect().bottom + scrollY;
          window.scrollTo(0, top - (window.innerWidth < 600 ? 120 : 180));
        });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(dir, `clip-performance-stacks${suffix}.png`) });
      });
      test(`screenshot this week ${scheme}`, async ({ page }) => {
        await page.goto("/library?view=week");
        await settle(page);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `library-week${suffix}.png`) });
      });
    });
  }
}

// The Skills pages (§18.9): the branch, Write a skill, a skill (with tricky text), a written skill, the edit form (an
// .md and a .zip, whose description box grows), and the delete sheet, at 375 and 1440 px, light and dark.
const SKILL_PAGES = [
  { name: "settings-skills", path: "/settings/clip-making/skills" },
  { name: "settings-skill-new", path: "/settings/clip-making/skills/new" },
  { name: "settings-skill", path: "/settings/clip-making/skills/01JZ8S00000000000000000003" },
  { name: "settings-skill-written", path: "/settings/clip-making/skills/01JZ8S00000000000000000001" },
  { name: "settings-skill-edit", path: "/settings/clip-making/skills/01JZ8S00000000000000000001/edit" },
  { name: "settings-skill-edit-zip", path: "/settings/clip-making/skills/01JZ8S00000000000000000002/edit" },
  // Settings › Clip making › What it learned (§16.12), next to Skills.
  { name: "settings-learned", path: "/settings/clip-making/learned" },
  // Settings › Clip making › Streamers I follow (§24.5).
  { name: "settings-streamers", path: "/settings/clip-making/streamers" },
];
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`skills ${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: size.touch,
        isMobile: size.touch,
        colorScheme: scheme,
      });
      for (const shot of SKILL_PAGES) {
        test(`screenshot ${shot.name} ${scheme}`, async ({ page }) => {
          await page.goto(shot.path);
          await settle(page);
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(dir, `${shot.name}${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}.png`) });
        });
      }
      test(`screenshot settings-skill-delete-sheet ${scheme}`, async ({ page }) => {
        await page.goto("/settings/clip-making/skills/01JZ8S00000000000000000001");
        await settle(page);
        await page.getByRole("button", { name: "Delete" }).click();
        await page.getByRole("dialog").waitFor();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `settings-skill-delete-sheet${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}.png`) });
      });
    });
  }
}

test("screenshot get-app on an iPhone (picture steps)", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto("/get-app");
  await settle(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(dir, "get-app-iphone-390x844.png") });
  await context.close();
});

// Posting setup (§17.12): the list and the YouTube page, phone and desktop, light and dark; plus YouTube connected
// and the pretend consent page.
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`setup ${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: size.touch,
        isMobile: size.touch,
        colorScheme: scheme,
      });
      const suffix = `${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}`;
      test(`screenshot setup ${scheme}`, async ({ page }) => {
        await page.goto("/settings/posting/setup");
        await settle(page);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `setup-list${suffix}.png`) });
        await page.goto("/settings/posting/setup/youtube");
        await settle(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `setup-youtube${suffix}.png`) });
        // Further on: the key step with its Copy chips and paste boxes.
        await page.locator("[data-step='key-client'] .gstep__head").click();
        await page.locator("[data-step='key-paste'] .gstep__head").click();
        await page.locator("[data-step='key-client']").evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `setup-youtube-keys${suffix}.png`) });
      });
    });
  }
}

// The floating setup to-do list (§17.13): the pill and the open list on a phone, the column and the pill on wide
// screens, the skip question, a skipped row, and "All set!".
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "tablet", width: 1024, height: 768, scale: 1, touch: false },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`setup todo ${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: size.touch,
        isMobile: size.touch,
        colorScheme: scheme,
      });
      const suffix = `${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}`;
      test(`screenshot setup todo ${scheme}`, async ({ page }) => {
        await page.goto("/");
        await settle(page);
        await page.screenshot({ path: join(dir, `setup-todo${suffix}.png`) });
        // The pill on its glass bar, with the page under it (the open column has no bar).
        if (size.width < 1440) {
          await page.evaluate(() => window.scrollTo(0, 420));
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(dir, `setup-todo-scrolled${suffix}.png`) });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(300);
        }
        await page.evaluate(() => (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup.finish("youtube"));
        const list = await openTodo(page);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `setup-todo-open${suffix}.png`) });
        await list.getByRole("button", { name: "Skip TikTok" }).click();
        await page.waitForTimeout(450);
        await page.screenshot({ path: join(dir, `setup-todo-skip${suffix}.png`) });
        await page.getByRole("dialog", { name: "Skip TikTok?" }).getByRole("button", { name: "Skip TikTok" }).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `setup-todo-skipped${suffix}.png`) });
        for (const p of ["Instagram", "Facebook", "X"]) {
          await list.getByRole("button", { name: `Skip ${p}` }).click();
          await page.getByRole("dialog", { name: `Skip ${p}?` }).getByRole("button", { name: `Skip ${p}` }).click();
        }
        await page.locator(".setup-todo--done").waitFor();
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(dir, `setup-todo-all-set${suffix}.png`) });
      });
    });
  }
}

test("screenshot setup: YouTube connected and the pretend consent page", async ({ browser }) => {
  for (const size of [
    { width: 375, height: 812, scale: 2 },
    { width: 1440, height: 900, scale: 1 },
  ]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale });
    const page = await context.newPage();
    await page.goto("/");
    await settle(page);
    await page.evaluate(() => (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup.finish("youtube"));
    await page.goto("/settings/posting/setup/youtube?result=connected");
    await settle(page);
    await page.waitForTimeout(1900);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(dir, `setup-youtube-connected-${size.width}x${size.height}.png`) });
    await page.goto("/mock-oauth/youtube?state=v1.screenshot");
    await settle(page);
    await page.screenshot({ path: join(dir, `setup-consent-${size.width}x${size.height}.png`) });
    await page.goto("/");
    await settle(page);
    await page.screenshot({ path: join(dir, `home-setup-list-${size.width}x${size.height}.png`) });
    await context.close();
  }
});

test("screenshot setup: every platform page fresh, and the pickers on a phone and a tablet", async ({ browser }) => {
  for (const size of [
    { width: 375, height: 812, scale: 2, touch: true },
    { width: 1440, height: 900, scale: 1, touch: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: size.touch, hasTouch: size.touch });
    const page = await context.newPage();
    for (const platform of ["youtube", "tiktok", "instagram", "facebook", "x"]) {
      await page.goto(`/settings/posting/setup/${platform}`);
      await settle(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(dir, `setup-${platform}-fresh-${size.width}x${size.height}.png`) });
    }
    await context.close();
  }
  for (const size of [
    { width: 375, height: 812, scale: 2, touch: true },
    { width: 768, height: 1024, scale: 2, touch: true },
  ]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: size.touch, hasTouch: size.touch });
    const page = await context.newPage();
    for (const [platform, id] of [
      ["youtube", "public-privacy"],
      ["tiktok", "public-review"],
    ] as const) {
      await page.goto(`/settings/posting/setup/${platform}`);
      await settle(page);
      await page.locator(`[data-step='${id}'] .gstep__head`).click();
      await page.locator(`[data-step='${id}'] .gstep__picker`).evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `setup-${platform}-picker-${size.width}x${size.height}.png`) });
    }
    await context.close();
  }
});

// Ask Clip Factory's panel with an answer (docs/CONTRACTS.md §19.11), phone and desktop.
for (const size of [
  { width: 375, height: 812, scale: 2, touch: true },
  { width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`help panel ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    test(`screenshot help panel ${size.width}x${size.height}`, async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
      await page.screenshot({ path: join(dir, `help-panel-empty-${size.width}x${size.height}.png`) });
      const box = panel.getByLabel("Your question");
      await box.fill("Where do I change my click sound?");
      await box.press("Enter");
      await panel.locator(".help-actions").last().waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `help-panel-${size.width}x${size.height}.png`) });
    });
    // The Ask box: a two-line question with the paper plane inside the field, then the plane mid-flight.
    test(`screenshot help ask box ${size.width}x${size.height}`, async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.getByRole("button", { name: "Ask Clip Factory" }).click();
      const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
      const box = panel.getByLabel("Your question");
      await box.fill("How do I connect YouTube?\nAnd does it post by itself?");
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(dir, `help-ask-box-${size.width}x${size.height}.png`) });
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForTimeout(220);
      await page.screenshot({ path: join(dir, `help-plane-flying-${size.width}x${size.height}.png`) });
    });
    // Review with the launcher clear of Keep, then the answer button lighting Keep up (the panel steps away when it
    // would cover it), and the panel opened again with the same answer.
    test(`screenshot help spotlight on Review ${size.width}x${size.height}`, async ({ page }) => {
      await page.goto("/review");
      await settle(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, `help-review-launcher-${size.width}x${size.height}.png`) });
      // Where the launcher has no room it steps aside, so open the panel the way any screen can.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("cf:help", { detail: {} })));
      const panel = page.getByRole("dialog", { name: "Ask Clip Factory" });
      const box = panel.getByLabel("Your question");
      await box.fill("What does Keep do?");
      await box.press("Enter");
      await panel.getByRole("button", { name: "Open Review" }).click();
      await page.locator("[data-help-spotlit]").waitFor();
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(dir, `help-spotlight-keep-${size.width}x${size.height}.png`) });
      // The panel may still be stepping away from Keep on a busy runner: then there is nothing to close.
      if (await panel.count())
        await panel
          .getByRole("button", { name: "Close" })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      await expect(panel).toHaveCount(0);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("cf:help", { detail: {} })));
      // The plain answer's steps (§19), or the assistant's answer (§28).
      await panel.locator(".help-steps, .ask-answer").last().waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, `help-panel-reopened-${size.width}x${size.height}.png`) });
    });
  });
}

// Action motions mid-way (docs/CONTRACTS.md §20.10): in the /__motion gallery, the six main kinds are tapped and
// paused at 50 % with document.getAnimations(), then the gallery grid is captured, light and dark, 375 and 1440 px.
for (const width of [375, 1440] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`motion ${width} ${scheme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: scheme });
      test(`screenshot action motions mid-way ${width} ${scheme}`, async ({ page }) => {
        await page.goto(GALLERY);
        await settle(page);
        for (const kind of ["send", "keep", "delete", "refresh", "save", "copy"]) await tapAct(page.locator(`[data-kind="${kind}"]`));
        await pauseActs(page, 0.5);
        await page.locator(".motion-gallery__grid").screenshot({ path: join(dir, `motion-mid-${scheme}-${width}.png`) });
      });
    });
  }
}

// Background modes and see-through glass (§22): the Background page in each mode, phone and desktop, light and dark;
// and the see-through desktop window, simulated. The real glass is drawn by the operating system outside the page,
// so stand-ins for it (e2e/glass.ts) are painted behind the transparent page: a busy picture the way macOS Liquid
// Glass shows it while the window is in use, and the darkest the glass was measured (another app in use, pure black
// behind). Clear and Frosted each.
for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`background ${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: size.touch,
        isMobile: size.touch,
        colorScheme: scheme,
      });
      const suffix = `${scheme === "dark" ? "-dark" : ""}-${size.width}x${size.height}`;
      test(`screenshot settings-background ${scheme}`, async ({ page }) => {
        await page.goto("/settings/look-and-feel/background");
        await settle(page);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `settings-background${suffix}.png`) });
        await page.getByRole("radio", { name: "Colours" }).check();
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(dir, `settings-background-colours${suffix}.png`) });
      });
    });
  }
  test.describe(`see-through ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    for (const strength of ["clear", "frosted"] as const) {
      test(`screenshot see-through ${strength}`, async ({ page }) => {
        await asDesktop(page, "liquid", strength);
        await page.goto("/");
        await settle(page);
        for (const [name, paint] of [
          ["scene", ACTIVE_SCENE],
          ["floor", INACTIVE_FLOOR],
        ] as const) {
          await paintGlass(page, paint);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(dir, `see-through-${name}-${strength}-${size.width}x${size.height}.png`) });
        }
      });
    }
  });
}

// Real earnings (§25.7): Settings › Posting › Money and Home's money tile in each mock state, phone and desktop.
const MONEY_STATES = ["start", "not_yet", "in_program", "earning", "facebook_verified", "unsupported", "not_connected", "error"];
for (const size of SIZES) {
  test.describe(`money ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    for (const state of MONEY_STATES) {
      test(`screenshot money ${state}`, async ({ page }) => {
        await page.goto("/");
        await page.evaluate((s) => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: s, country: "US", seen: ["youtube:in_program", "youtube:first_money"] })), state);
        await page.goto("/settings/posting/money");
        await settle(page);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(dir, `money-${state}-${size.width}x${size.height}.png`), fullPage: true });
      });
    }
    test("screenshot money youtube card open", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "start", country: "US", seen: [] })));
      await page.goto("/settings/posting/money#money-youtube");
      await settle(page);
      const yt = page.locator("[data-money-card='youtube']");
      await yt.getByRole("button", { name: "First time? Steps for a grown-up" }).click();
      await yt.getByRole("button", { name: "More" }).click();
      await page.waitForTimeout(900);
      await yt.screenshot({ path: join(dir, `money-youtube-card-open-${size.width}x${size.height}.png`) });
    });
    for (const state of ["not_yet", "earning"]) {
      test(`screenshot home money tile ${state}`, async ({ page }) => {
        await page.goto("/");
        await page.evaluate((s) => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: s, country: "US", seen: ["youtube:first_money"] })), state);
        await page.goto("/");
        await settle(page);
        await page.locator(".money-tile").scrollIntoViewIfNeeded();
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(dir, `home-money-${state}-${size.width}x${size.height}.png`) });
      });
    }
  });
}

// The money dashboard (§27.9): dash_many at every size the owner uses, light and dark; the other states at a phone and
// a desktop. Saved to web/test-results/screens/money-dashboard-{scenario}-{w}x{h}-{scheme}.png (CF_MONEY_SCREEN_DIR
// for another folder). The clock is fixed so every run draws the same days.
const moneyDir = process.env.CF_MONEY_SCREEN_DIR || join(import.meta.dirname, "..", "test-results", "screens");
mkdirSync(moneyDir, { recursive: true });
const MONEY_SIZES: { w: number; h: number; touch: boolean }[] = [
  { w: 320, h: 568, touch: true },
  { w: 375, h: 812, touch: true },
  { w: 390, h: 844, touch: true },
  { w: 430, h: 932, touch: true },
  { w: 768, h: 1024, touch: true },
  { w: 1024, h: 768, touch: false },
  { w: 1280, h: 800, touch: false },
  { w: 1440, h: 900, touch: false },
  { w: 1920, h: 1080, touch: false },
  { w: 1200, h: 820, touch: false },
  { w: 380, h: 600, touch: false },
];
const MONEY_SHOTS = [
  ...MONEY_SIZES.map((s) => ({ scenario: "dash_many", ...s })),
  ...["dash_youtube_only", "dash_nothing", "dash_error", "dash_two_currencies"].flatMap((scenario) => [
    { scenario, w: 375, h: 812, touch: true },
    { scenario, w: 1440, h: 900, touch: false },
  ]),
];
for (const shot of MONEY_SHOTS) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshot money dashboard ${shot.scenario} ${shot.w}x${shot.h} ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: shot.w, height: shot.h },
        hasTouch: shot.touch,
        isMobile: shot.touch && shot.w < 768,
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(new Date("2026-11-19T12:00:00Z"));
      await page.goto("/");
      await page.evaluate((n) => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: n, country: "US", seen: [] })), shot.scenario);
      await page.goto("/money");
      await settle(page);
      await page.waitForTimeout(500);
      const name = `money-dashboard-${shot.scenario}-${shot.w}x${shot.h}-${scheme}`;
      await page.screenshot({ path: join(moneyDir, `${name}.png`) });
      await page.screenshot({ path: join(moneyDir, `${name}-full.png`), fullPage: true });
      await ctx.close();
    });
  }
}

// Content Rewards (§38.20): its setup page, the campaigns list, a campaign card, a campaign clip on Review and the
// Money part, at 375 and 1440 px.
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`content rewards ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    const suffix = `-${size.width}x${size.height}`;
    test("screenshot content rewards", async ({ page }) => {
      await page.addInitScript(() => {
        if (!sessionStorage.getItem("cf-mock-cr-review")) sessionStorage.setItem("cf-mock-cr-review", "1");
      });
      await page.goto("/");
      await settle(page);
      await page.evaluate(() => {
        const s = (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup;
        for (const p of ["youtube", "instagram", "facebook"]) s.finish(p);
      });
      for (const [name, path] of [
        ["cr-setup", "/settings/posting/setup/contentrewards"],
        ["campaigns", "/campaigns"],
        ["campaign", "/campaigns/200ea21b-be80-4db8-b552-8e32b148604e"],
        ["review-campaign", "/review"],
        ["money-cr", "/money#content-rewards"],
      ] as const) {
        await page.goto(path);
        await settle(page);
        if (name === "money-cr") await page.locator("#content-rewards").scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `${name}${suffix}.png`) });
      }
    });
  });
}

// §41 (docs/CONTRACTS.md §41.6): the campaign finder with its matches (`finder`) and What you want open
// (`finder-want`), at 375 and 1440 px.
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`campaign finder ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    const suffix = `-${size.width}x${size.height}`;
    test("screenshot campaign finder", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { finder?: unknown; setup?: unknown } }).__cfMock?.finder);
      await page.evaluate(() => {
        const m = (window as unknown as { __cfMock: { setup: { finish(p: string): void }; finder: { newMatches(n: number): void } } }).__cfMock;
        for (const p of ["youtube", "instagram", "facebook", "x"]) m.setup.finish(p);
        m.finder.newMatches(3);
      });
      await page.goto("/campaigns/find");
      await settle(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `finder${suffix}.png`) });
      await page.getByRole("button", { name: "Change" }).click();
      await page.locator("[data-help='cr-finder-want']").scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `finder-want${suffix}.png`) });
    });
  });
}

// §39 (docs/CONTRACTS.md §39.5): a campaign clip's fit block on Review, and All your money on the Money page, at 375
// and 1440 px. The campaign clip is the first card of a new FaZe Clips job (the campaign way), in the pretend app.
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`content rewards fit and all money ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch });
    const suffix = `-${size.width}x${size.height}`;
    test("screenshot review-fit and money-all", async ({ page }) => {
      type Knobs = Record<string, (...a: unknown[]) => unknown>;
      const mock = (group: "setup" | "jobs", fn: string, ...args: unknown[]) =>
        page.evaluate(([g, f, a]) => (window as unknown as { __cfMock: Record<string, Knobs> }).__cfMock[g as string]![f as string]!(...(a as unknown[])), [group, fn, args] as const);
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { jobs?: unknown } }).__cfMock?.jobs);
      for (const p of ["youtube", "instagram"]) await mock("setup", "finish", p);
      await page.goto("/?campaign=200ea21b-be80-4db8-b552-8e32b148604e");
      await settle(page);
      await page.getByLabel("YouTube, Twitch or Kick link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      await page.locator("form.newjob").getByRole("button", { name: "Make campaign clips", exact: true }).click();
      await page.waitForURL(/\/jobs\//);
      await mock("jobs", "finish");
      await page.getByRole("link", { name: "Check these clips" }).click();
      await page.waitForURL(/\/review\?job=/);
      await settle(page);
      const fit = page.locator(".review-list__item").first().locator(".cr-fit");
      await expect(fit).toBeVisible();
      await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
      await fit.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.evaluate(() => scrollBy(0, -80));
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `review-fit${suffix}.png`) });
      await page.evaluate(() => {
        history.pushState({}, "", "/money");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await settle(page);
      await expect(page.locator(".cr-all__rows")).toBeVisible();
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(dir, `money-all${suffix}.png`) });
    });
  });
}

// The Content Rewards loose ends (§38, §39), at 375, 390 and 1440 px: Check 1 thing with its own group, the money dock
// with the cards (never over All your money), the setup page's pinned pair resting under step 1's lines, Content
// Rewards said no? with one mark, a toast above the pinned Make clips for this campaign, the job page strip and
// Library's Campaign chip, and Your money is on Whop from the API's movedAt.
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "phone", width: 390, height: 844, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`content rewards loose ends ${size.name} ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch, reducedMotion: "reduce" });
    const suffix = `-${size.width}x${size.height}`;
    const FAZE = "200ea21b-be80-4db8-b552-8e32b148604e";
    const APPLY = "a1cefc3b-4533-438f-8e70-a7299550f1cf";
    type Knobs = Record<string, (...a: unknown[]) => unknown>;
    const knob = (page: import("@playwright/test").Page, group: "setup" | "jobs" | "cr", fn: string, ...args: unknown[]) =>
      page.evaluate(([g, f, a]) => (window as unknown as { __cfMock: Record<string, Knobs> }).__cfMock[g as string]![f as string]!(...(a as unknown[])), [group, fn, args] as const);
    const inApp = async (page: import("@playwright/test").Page, path: string) => {
      await page.evaluate((p) => {
        history.pushState({}, "", p);
        dispatchEvent(new PopStateEvent("popstate"));
      }, path);
      await settle(page);
    };
    const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: join(dir, `${name}${suffix}.png`) });

    test("screenshot review check one, job strip, library chip", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { jobs?: unknown } }).__cfMock?.jobs);
      for (const p of ["youtube", "instagram"]) await knob(page, "setup", "finish", p);
      await page.goto(`/?campaign=${FAZE}`);
      await settle(page);
      await page.getByLabel("YouTube, Twitch or Kick link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      await page.locator("form.newjob").getByRole("button", { name: "Make campaign clips", exact: true }).click();
      await page.waitForURL(/\/jobs\//);
      await settle(page);
      await expect(page.locator(".cr-job [data-cr='job-strip']")).toContainText("Following");
      await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
      await page.locator(".cr-job").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);
      await shot(page, "cr-job-strip");
      await knob(page, "jobs", "finish");
      await page.getByRole("link", { name: "Check these clips" }).click();
      await page.waitForURL(/\/review\?job=/);
      await settle(page);
      await knob(page, "cr", "setRules", FAZE, { uncertain: ["Clips must feel organic"] });
      const card = page.locator(".review-list__item").first().locator(".review-card");
      const fit = card.locator(".cr-fit");
      await expect(fit.locator(".cr-fit__headline")).toHaveText("Check 1 thing, then upload");
      await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
      await fit.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.evaluate(() => scrollBy(0, -80));
      await page.waitForTimeout(400);
      await shot(page, "review-check-one");
      const mine = card.getByRole("button", { name: "Use my settings" });
      if (await mine.count()) await mine.click();
      await card.getByRole("button", { name: /^Upload to \d/ }).click();
      await expect(page.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
      await inApp(page, "/library");
      await expect(page.locator("[data-cr='campaign-chip']")).toHaveCount(1);
      await page.locator("[data-cr='campaign-chip']").evaluate((el) => el.closest(".lib-card")!.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);
      await shot(page, "library-campaign-chip");
    });

    test("screenshot money dock with the cards", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-11-19T12:00:00Z"));
      await page.goto("/");
      await page.evaluate(() => sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "dash_many", country: "US", seen: [] })));
      await page.goto("/money");
      await settle(page);
      await expect(page.locator(".cr-all__rows")).toBeVisible();
      await page.waitForTimeout(400);
      await shot(page, "money-dock-top");
      await page.evaluate(() => scrollBy(0, document.querySelector(".cr-all__total")!.getBoundingClientRect().bottom - innerHeight + 40));
      await page.waitForTimeout(400);
      await shot(page, "money-dock-total");
      await page.evaluate(() => scrollBy(0, document.querySelector(".dash-body")!.getBoundingClientRect().top - 120));
      await page.waitForTimeout(400);
      await shot(page, "money-dock-cards");
    });

    test("screenshot setup pinned pair and said no", async ({ page }) => {
      await page.addInitScript(() => {
        if (sessionStorage.getItem("cf-shot-cr-fresh")) return;
        sessionStorage.setItem("cf-shot-cr-fresh", "1");
        sessionStorage.setItem("cf-mock-cr-start", "fresh");
      });
      await page.goto("/settings/posting/setup/contentrewards");
      await settle(page);
      await page.waitForTimeout(700);
      await shot(page, "cr-setup-fresh");
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { cr?: unknown } }).__cfMock?.cr);
      await knob(page, "cr", "setReadOnly", true);
      await page.reload();
      await settle(page);
      const pilot = page.locator("[data-help='cr-pilot-email']");
      await expect(pilot).toContainText("Content Rewards said no?");
      await pilot.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);
      await shot(page, "cr-setup-said-no");
    });

    test("screenshot you're in toast above the main button", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { cr?: unknown; setup?: unknown } }).__cfMock?.cr);
      await knob(page, "setup", "finish", "youtube");
      await page.goto(`/campaigns/${APPLY}`);
      await settle(page);
      await page.locator("main .btn--primary").filter({ visible: true }).click();
      await expect(page.locator(".cr-chip")).toHaveText("Waiting for the brand");
      await knob(page, "cr", "sayYes", APPLY);
      await expect(page.locator(".toast", { hasText: "You're in!" })).toBeVisible();
      await page.locator("main .btn--primary").filter({ visible: true }).click();
      await expect(page.locator("main .btn--primary").filter({ visible: true })).toHaveText(/Make clips for this campaign/);
      await page.waitForTimeout(300);
      await shot(page, "campaign-in-toast");
    });

    test("screenshot your money is on whop", async ({ page }) => {
      await page.goto("/money#content-rewards");
      await settle(page);
      const part = page.locator("#content-rewards");
      await part.locator(".segmented__opt", { hasText: /^Yes$/ }).click();
      await expect(part.locator("#step-fin-setup")).toBeVisible();
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { cr?: unknown } }).__cfMock?.cr);
      await knob(page, "cr", "moveToWhop");
      await knob(page, "cr", "moneyArrivedOnWhop");
      await page.goto("/money#content-rewards");
      await settle(page);
      await expect(part).toContainText("Your money is on Whop. Move it to your bank.");
      await part.locator("#step-fin-bank").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.evaluate(() => scrollBy(0, -100));
      await page.waitForTimeout(400);
      await shot(page, "money-cr-on-whop");
    });
  });
}

// Get paid (docs/CONTRACTS.md §40.8): the list, YouTube's and Content Rewards' pages, and the Get paid card on Money,
// at 375 and 1440 px, for the pretend owner (YouTube paid twice, Instagram's Gifts on, Content Rewards linked).
for (const size of [
  { name: "phone", width: 375, height: 812, scale: 2, touch: true },
  { name: "desktop", width: 1440, height: 900, scale: 1, touch: false },
]) {
  test.describe(`get paid ${size.name} ${size.width}x${size.height}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      hasTouch: size.touch,
      isMobile: size.touch,
      ...(size.touch ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" } : {}),
    });
    const suffix = `-${size.width}x${size.height}`;
    test("screenshot get paid", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.waitForFunction(() => !!(window as unknown as { __cfMock?: { getpaid?: unknown } }).__cfMock?.getpaid);
      await page.evaluate(() => {
        const m = (window as unknown as { __cfMock: { getpaid: { scenario(n: string): void; whop(on: boolean): void } } }).__cfMock;
        m.getpaid.scenario("owner");
        m.getpaid.whop(true);
        sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "dash_many", country: "SE", seen: [] }));
      });
      for (const [name, path] of [
        ["getpaid-list", "/settings/posting/getpaid"],
        ["getpaid-youtube", "/settings/posting/getpaid/youtube"],
        ["getpaid-contentrewards", "/settings/posting/getpaid/contentrewards"],
        ["money-getpaid", "/money"],
      ] as const) {
        await page.goto(path);
        await settle(page);
        if (name === "money-getpaid") await page.locator(".gp-money").evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(dir, `${name}${suffix}.png`) });
      }
    });
  });
}
