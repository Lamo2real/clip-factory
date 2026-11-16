import { expect, test } from "@playwright/test";
import { settle } from "./helpers.ts";
test.use({ viewport: { width: 1280, height: 900 } });
for (let i = 0; i < 10; i++) test(`probe ${i}`, async ({ page }) => {
  page.on("console", (m) => console.log(`[${i}] console ${m.type()}: ${m.text().slice(0, 200)}`));
  page.on("framenavigated", (f) => f === page.mainFrame() && console.log(`[${i}] nav ${f.url()}`));
  await page.goto("/settings/look-and-feel/sounds");
  await settle(page);
  await page.getByRole("button", { name: /^Click sound 12: Coin/ }).click();
  await page.waitForTimeout(90);
  await page.getByRole("button", { name: /^Error sound 21: Two-tone down/ }).click();
  await page.waitForTimeout(90);
  const panel = page.getByRole("navigation", { name: "Settings sections" });
  await panel.getByRole("link", { name: "Motion" }).click();
  await settle(page);
  await panel.getByRole("button", { name: "Posting" }).click();
  await panel.getByRole("link", { name: "Accounts" }).click();
  await settle(page);
  await expect(page.getByText("Checking…")).toHaveCount(0);
  const btn = page.getByRole("button", { name: /Connect YouTube/ });
  const box = (await btn.boundingBox())!;
  const info = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return {
      hit: el ? el.outerHTML.slice(0, 160) : null,
      toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent),
      scrollY,
      update: !!document.querySelector(".update-bar"),
      fixed: [...document.querySelectorAll("body *")].filter((e) => getComputedStyle(e).position === "fixed" && e.getBoundingClientRect().height > 0).map((e) => e.className + " " + JSON.stringify(e.getBoundingClientRect())).slice(0, 8),
    };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.evaluate(() => (window.__cfSoundLog = []));
  await page.evaluate(() => document.addEventListener("click", (e) => ((window as unknown as { __hits: string[] }).__hits ??= []).push((e.target as Element).outerHTML.slice(0, 120) + " @" + e.clientX + "," + e.clientY), { capture: true }));
  await btn.click({ force: true });
  await page.waitForTimeout(400);
  console.log(i, "hits", JSON.stringify(await page.evaluate(() => (window as unknown as { __hits?: string[] }).__hits)));
  const log = await page.evaluate(() => window.__cfSoundLog);
  console.log(i, JSON.stringify(box), JSON.stringify(info), JSON.stringify(log));
});
