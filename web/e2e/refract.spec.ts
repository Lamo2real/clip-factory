import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";
import { busyness, decode } from "./pixels.ts";

// Words scrolled under the refracting glass (the tab bar, the sidebar, the hero) are blurred, not just bent: in
// Chromium `url(#cf-refract)` before `blur()` left the backdrop sharp (glass.css .refract .glass--refract).

test.use({ reducedMotion: "reduce" });

test("text under the phone tab bar is frosted by its blur", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.classList.contains("refract"))).toBe(true);
  const bar = page.locator("nav.tabbar");
  const box = (await bar.boundingBox())!;
  // Sharp white words right under the bar, and the bar's own icons hidden so only what is behind it is measured.
  await page.evaluate((y) => {
    const d = document.createElement("div");
    d.textContent = "Paste a link Pick a video YouTube Twitch or Kick link ".repeat(8);
    Object.assign(d.style, { position: "fixed", left: "0", right: "0", top: `${y}px`, zIndex: "1", color: "#fff", font: "700 18px sans-serif", lineHeight: "20px" });
    document.body.append(d);
    for (const c of Array.from(document.querySelectorAll("nav.tabbar > *"))) (c as HTMLElement).style.visibility = "hidden";
  }, box.y);
  await page.waitForTimeout(300);
  const clip = { x: box.x + 16, y: box.y + 8, width: box.width - 32, height: box.height - 16 };
  const through = busyness(await decode(page, await page.screenshot({ clip })));
  await page.addStyleTag({ content: "nav.tabbar { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" });
  await page.waitForTimeout(300);
  const bare = busyness(await decode(page, await page.screenshot({ clip })));
  expect(bare, "the words behind are there to blur").toBeGreaterThan(4);
  expect(through, `blurred ${through.toFixed(2)} vs sharp ${bare.toFixed(2)}`).toBeLessThan(bare * 0.25);
});
