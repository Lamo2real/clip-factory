import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { CLIPS, openClip, settle } from "./helpers.ts";

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
