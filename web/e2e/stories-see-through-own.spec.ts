import { expect, test, type Page } from "@playwright/test";
import { asDesktop, paintGlass } from "./glass.ts";

// Stories' See-through and Glass strength follow Stories' own Look (Settings › Look, cf.stories.prefs), never Clip
// Factory's Look or Glass strength (the owner, 23 Nov). In the desktop app with Clip Factory on Colours or on
// See-through Frosted: while Stories is on screen in See-through, the desktop (painted pure magenta behind the page,
// as e2e/glass.ts paints the window's glass) shows between its panels exactly as Stories' own strength says (Clear:
// the magenta itself; Frosted: only Stories' own 0.30 frost over it), with nothing of Clip Factory's own backdrop
// drawn under it. Back in Clip Factory, Clip Factory's look is exactly what its own settings say.

test.use({ reducedMotion: "reduce" });

const VEIL = [28, 19, 14];
const MAGENTA = [255, 0, 255];
const FROST = 0.3;

async function prepare(page: Page, cf: "colours" | "frosted", strength: "clear" | "frosted") {
  await asDesktop(page, "liquid", cf === "frosted" ? "frosted" : undefined);
  await page.addInitScript(
    ({ cf, strength }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more: { "look.mode": "see-through", "look.strength": strength } }));
      if (cf === "colours") {
        const look = JSON.stringify({ backgroundMode: "colours", glassStrength: "clear" });
        if (!localStorage.getItem("cf.prefs")) localStorage.setItem("cf.prefs", look);
        if (!sessionStorage.getItem("cf-mock-look")) sessionStorage.setItem("cf-mock-look", look);
      }
    },
    { cf, strength },
  );
}

async function ready(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot, .skeleton"), undefined, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
}

/** The share of the screen (in %) within 14 of `want` per channel. */
async function share(page: Page, want: number[]): Promise<number> {
  const shot = await page.screenshot({ scale: "css" });
  return page.evaluate(
    async ({ src, want }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext("2d")!;
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - want[0]!) <= 14 && Math.abs(d[i + 1]! - want[1]!) <= 14 && Math.abs(d[i + 2]! - want[2]!) <= 14) n++;
      return (n / (d.length / 4)) * 100;
    },
    { src: `data:image/png;base64,${shot.toString("base64")}`, want },
  );
}

const shown = (page: Page) =>
  page.evaluate(() => ({
    seeThrough: document.documentElement.classList.contains("see-through"),
    look: document.querySelector<HTMLElement>(".stories-app")?.dataset.look ?? null,
    strength: document.querySelector<HTMLElement>(".stories-app")?.dataset.strength ?? null,
    backdrops: [...document.querySelectorAll<HTMLElement>(".backdrop")].filter((b) => !b.closest(".stories-app")).map((b) => getComputedStyle(b).display),
  }));

for (const cf of ["colours", "frosted"] as const)
  for (const strength of ["clear", "frosted"] as const)
    test(`Clip Factory on ${cf === "colours" ? "Colours" : "See-through Frosted"}, Stories See-through ${strength}: Stories' own choice shows`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await prepare(page, cf, strength);
      await page.goto("/stories/library");
      await ready(page);
      const s = await shown(page);
      expect(s.look).toBe("window");
      expect(s.strength).toBe(strength);
      expect(s.seeThrough).toBe(true);
      expect(s.backdrops.length).toBeGreaterThan(0);
      expect(s.backdrops.every((d) => d === "none"), s.backdrops.join(" ")).toBe(true);
      // The desktop between the panels: the magenta itself for Clear, Stories' own frost over it for Frosted.
      await paintGlass(page, { name: "magenta", background: "rgb(255 0 255)" });
      const want = strength === "clear" ? MAGENTA : MAGENTA.map((m, i) => Math.round(VEIL[i]! * FROST + m * (1 - FROST)));
      expect(await share(page, want)).toBeGreaterThan(8);
      await paintGlass(page, { name: "none", background: "" });
      // Over to Clip Factory: its own look again, as its settings say.
      await page.locator(".ws-dock .ws-switch__opt:not(.is-on)").first().click();
      await page.waitForURL((u) => !u.pathname.startsWith("/stories"), { timeout: 15_000 });
      await page.waitForTimeout(800);
      const back = await shown(page);
      expect(back.seeThrough).toBe(cf === "frosted");
      expect(back.backdrops.length).toBeGreaterThan(0);
      expect(back.backdrops.every((d) => d !== "none"), back.backdrops.join(" ")).toBe(true);
    });
