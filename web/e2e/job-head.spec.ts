import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle } from "./helpers.ts";

// The job page's title plate (docs/CONTRACTS.md §11.1): at every size, and in the macOS window with its see-through
// title bar, the plate starts below the top safe line with room to spare and ends inside the window, and the job's tag
// ("Didn't work") sits inside the plate, never beside it or in the gap under it. Run in WebKit too (playwright.config.ts).

const SIZES = [
  { name: "phone", width: 390, height: 844, mac: false },
  { name: "tablet", width: 800, height: 1000, mac: false },
  { name: "mac window", width: 1000, height: 650, mac: true },
  { name: "mac window wide", width: 1440, height: 900, mac: true },
  { name: "desktop", width: 1400, height: 900, mac: false },
];

async function openFailedJob(page: Page) {
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".job-row", { hasText: "Charity marathon" }).click();
  await settle(page);
  await expect(page.locator(".job-detail .page-head__title")).toBeVisible();
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    };
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:var(--top-safe);height:0";
    document.body.append(probe);
    const safe = probe.getBoundingClientRect().top;
    probe.remove();
    return { plate: r(".job-detail .page-head__text"), chip: r(".job-detail .page-head .pill"), safe, vh: innerHeight };
  });
}

for (const size of SIZES) {
  test(`job page title plate is in view and holds its tag: ${size.name} ${size.width}x${size.height}`, async ({ page }) => {
    if (size.mac) await asMacWindow(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await openFailedJob(page);
    await expect(page.locator(".job-detail .page-head .pill")).toHaveText(/Didn't work/);
    const { plate, chip, safe, vh } = await boxes(page);
    expect(plate.top, "plate starts below the top safe line with room").toBeGreaterThanOrEqual(safe + 8);
    expect(plate.bottom, "plate ends inside the window").toBeLessThanOrEqual(vh);
    expect(chip.left, "tag inside the plate (left)").toBeGreaterThanOrEqual(plate.left);
    expect(chip.right, "tag inside the plate (right)").toBeLessThanOrEqual(plate.right + 0.5);
    expect(chip.top, "tag inside the plate (top)").toBeGreaterThanOrEqual(plate.top);
    expect(chip.bottom, "tag inside the plate (bottom)").toBeLessThanOrEqual(plate.bottom + 0.5);
  });
}
