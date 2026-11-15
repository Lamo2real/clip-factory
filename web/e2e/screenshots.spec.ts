import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { settle } from "./helpers.ts";

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
