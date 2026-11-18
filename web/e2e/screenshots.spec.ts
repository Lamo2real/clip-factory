import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { ACTIVE_SCENE, asDesktop, INACTIVE_FLOOR, paintGlass } from "./glass.ts";
import { CLIPS, openClip, openTodo, settle } from "./helpers.ts";
import { GALLERY, pauseActs, tapAct } from "./motionHelpers.ts";

const dir = join(import.meta.dirname, "..", "screenshots");
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
      if (await panel.count()) await panel.getByRole("button", { name: "Close" }).click();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("cf:help", { detail: {} })));
      await panel.locator(".help-steps").waitFor();
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
