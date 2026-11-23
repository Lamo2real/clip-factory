import { expect, test, type Locator, type Page } from "@playwright/test";
import { animationsDone, settle } from "./helpers.ts";
import { decode, grey } from "./pixels.ts";

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

// Reload is a colourless liquid-glass lens (owner, 2026-11-23; ADR-85): bone words, no vermilion anywhere on it, and
// it reads as the primary choice beside Later by light alone. Later stays the quiet ghost, and hover adds light.
test.describe("Reload is a colourless glass lens", () => {
  /** The vermilion family: the raw colour and the CTA's two stops. */
  const VERMILION = [/\b232[,\s]+57[,\s]+43\b/, /\b206[,\s]+48[,\s]+36\b/, /\b184[,\s]+38[,\s]+28\b/];

  /** What a button paints (its fill, shadow and shine) and its words' colour, beside --ink worked out the same way. */
  const paint = (el: Locator) =>
    el.evaluate((node) => {
      const cs = getComputedStyle(node);
      const probe = document.createElement("span");
      probe.style.color = "var(--ink)";
      document.body.append(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      return {
        fill: [cs.backgroundImage, cs.backgroundColor, cs.boxShadow, getComputedStyle(node, "::before").backgroundImage].join(" "),
        color: cs.color,
        ink,
      };
    });

  /** The mean grey of a 6 x 3 px patch in a button's top padding, centred: light and glass only, no words. */
  const topLight = async (page: Page, el: Locator) => {
    const box = (await el.boundingBox())!;
    const clip = { x: Math.round(box.x + box.width / 2 - 3), y: Math.round(box.y + 4), width: 6, height: 3 };
    const px = await decode(page, await page.screenshot({ clip }));
    let sum = 0;
    for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) sum += grey(px, x, y);
    return sum / (px.width * px.height);
  };

  for (const width of [390, 1440]) {
    test(`at ${width} px: no vermilion, bone words, brighter than Later, brighter still on hover`, async ({ page }) => {
      // Reduced motion: every transition is 1 ms and nothing lifts, so each state is read where it lands.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await page.goto("/?update=1");
      await settle(page);
      await animationsDone(page);
      const bar = page.getByRole("region", { name: "New version" });
      const reload = bar.getByRole("button", { name: "Reload" });
      const later = bar.getByRole("button", { name: "Later" });
      await expect(reload).toHaveClass(/\bbtn--glass\b/);
      await expect(reload).toHaveClass(/\bbtn--lens\b/);
      await expect(reload).not.toHaveClass(/btn--primary|btn--action/);
      await expect(later).toHaveClass(/\bbtn--ghost\b/);
      // Its motion stays: refresh plays on the glyph.
      await expect(reload).toHaveAttribute("data-act", "refresh");
      await expect(reload.locator(".act.act--refresh")).toHaveCount(1);

      const rest = await paint(reload);
      for (const red of VERMILION) expect(rest.fill, `Reload paints ${red}`).not.toMatch(red);
      expect(rest.color).toBe(rest.ink);
      expect((await paint(later)).color).toBe(rest.ink);

      // By light alone: the lens is clearly brighter than Later beside it, and hover brightens it again.
      await page.mouse.move(0, 0);
      const lens = await topLight(page, reload);
      const quiet = await topLight(page, later);
      expect(lens, `Reload ${lens.toFixed(1)} vs Later ${quiet.toFixed(1)}`).toBeGreaterThan(quiet + 4);
      await reload.hover();
      await expect.poll(() => topLight(page, reload)).toBeGreaterThan(lens + 0.5);
      for (const red of VERMILION) expect((await paint(reload)).fill, `hovered Reload paints ${red}`).not.toMatch(red);
    });
  }
});
