import { expect, test } from "@playwright/test";
import { animationsDone, settle } from "./helpers.ts";

// The update bar (docs/CONTRACTS.md §12.2), driven by the mock build's fake update (?update=1 / window.__cfFakeUpdate).

test("a new version shows the bar with what changed, and Reload runs to 100% and reloads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?update=1");
  await settle(page);

  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  await expect(bar.getByText("New version ready")).toBeVisible();
  await expect(bar.getByRole("list", { name: "What changed" }).getByRole("listitem")).toHaveText(["Settings", "Profile picture"]);

  // It sits above the phone tab bar, never on top of it (where it rests: it slides up from below the screen first).
  await animationsDone(page);
  const barBox = (await bar.boundingBox())!;
  const tabs = (await page.locator("nav.tabbar").boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabs.y);

  // Watch the progress: record every value it shows until the page reloads.
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as Window & { __seen?: number[] }).__seen = seen;
    sessionStorage.setItem("cf.testMarker", "before-reload");
    const tick = () => {
      const el = document.querySelector('[role="progressbar"][aria-label="Update progress"]');
      if (el) seen.push(Number(el.getAttribute("aria-valuenow")));
      sessionStorage.setItem("cf.testSeen", JSON.stringify(seen));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const started = Date.now();
  const reloaded = page.waitForEvent("load", { timeout: 12_000 });
  await bar.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("progressbar", { name: "Update progress" })).toBeVisible();
  await reloaded;
  expect(Date.now() - started).toBeLessThan(11_000);

  const seen = JSON.parse((await page.evaluate(() => sessionStorage.getItem("cf.testSeen"))) ?? "[]") as number[];
  expect(seen.length).toBeGreaterThan(5);
  expect(Math.max(...seen)).toBe(100);
  // Never goes backwards.
  for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  // The fake flag is gone after the reload, so the bar does not come straight back.
  await settle(page);
  expect(page.url()).not.toContain("update=1");
  await expect(page.getByRole("region", { name: "New version" })).toBeHidden();
});

test("Later hides the bar until the next check", async ({ page }) => {
  await page.goto("/settings?update=1");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Later" }).click();
  await expect(bar).toBeHidden();
  await page.evaluate(() => window.__cfCheckForUpdate?.());
  await expect(page.getByRole("region", { name: "New version" })).toBeVisible();
});

test("custom areas from window.__cfFakeUpdate, on desktop beside the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.__cfFakeUpdate = ["Review", "Captions"];
  });
  await page.goto("/");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar.getByRole("listitem")).toHaveText(["Review", "Captions"]);
  const sidebar = (await page.locator("nav.sidebar").boundingBox())!;
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThan(sidebar.x + sidebar.width);
});

test("the bar is centred: in the window without a sidebar, under the content beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?update=1");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  // Beside the sidebar: centred in the space to its right.
  const side = (await page.locator("nav.sidebar").boundingBox())!;
  let box = (await bar.boundingBox())!;
  const contentMid = (side.x + side.width + 1440) / 2;
  expect(Math.abs(box.x + box.width / 2 - contentMid)).toBeLessThan(24);
  // Screens without the sidebar (like sign-in): centred in the window.
  await page.evaluate(() => document.querySelector("nav.sidebar")?.remove());
  await expect.poll(async () => {
    box = (await bar.boundingBox())!;
    return Math.abs(box.x + box.width / 2 - 720);
  }).toBeLessThan(2);
});

test("no bar when the server has the same version", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => window.__cfCheckForUpdate?.());
  // The wait is the test: given time, no bar comes.
  await page.waitForTimeout(300);
  await expect(page.getByRole("region", { name: "New version" })).toBeHidden();
});

test("with reduced motion the bar simply fills, with no confetti", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?update=1");
  await settle(page);
  const reloaded = page.waitForEvent("load", { timeout: 12_000 });
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("canvas.confetti")).toHaveCount(0);
  await reloaded;
});
