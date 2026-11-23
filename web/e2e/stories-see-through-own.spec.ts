import { expect, test, type Page } from "@playwright/test";
import { asDesktop, paintGlass } from "./glass.ts";
import { settle } from "./helpers.ts";

// Stories' See-through and Glass strength follow Stories' own Look (Settings › Look, cf.stories.prefs), never Clip
// Factory's Look or Glass strength (the owner, 23 Nov), and the two apps never touch each other's page: the shell draws
// Clip Factory's own backdrop only while Clip Factory is on screen (app/ClipsBackdrop.tsx) and alone writes
// html.see-through, from the wish of the app on screen (app/shell.ts). The real app, in the desktop app (vibrancy), with
// the desktop painted pure magenta behind the page (as e2e/glass.ts paints the window's glass): for Clip Factory on
// Colours, a Picture, See-through Clear and See-through Frosted, each with Stories' See-through Clear and Frosted,
// opened in either app and switched both ways. While Stories is on screen the desktop shows between its panels exactly
// as Stories' own strength says (Clear: the magenta itself; Frosted: only Stories' own 0.30 frost over it) and nothing of
// Clip Factory's backdrop is in the page; back in Clip Factory its page is exactly what its own settings say (its
// class, its backdrop drawn, the desktop showing only for its See-through Clear). And the review's case: Clip Factory's
// Look saved on another device (Colours, then See-through again) while Stories is on screen, then back in Clip
// Factory: its See-through page. Stories switched off: Clip Factory exactly as its settings say.

test.use({ reducedMotion: "reduce" });

const VEIL = [28, 19, 14];
const MAGENTA = [255, 0, 255];
const FROST = 0.3;

type ClipsLook = "colours" | "picture" | "clear" | "frosted";
const NAMES: Record<ClipsLook, string> = { colours: "Colours", picture: "a Picture", clear: "See-through Clear", frosted: "See-through Frosted" };
const KIND: Record<ClipsLook, string> = { colours: "colours", picture: "picture", clear: "window", frosted: "window" };
const BACKDROP: Record<ClipsLook, string> = { colours: "backdrop--colours", picture: "has-image", clear: "backdrop--window", frosted: "backdrop--window" };

async function prepare(page: Page, cf: ClipsLook, strength: "clear" | "frosted" | null) {
  await asDesktop(page, "vibrancy");
  await page.addInitScript(
    ({ cf, strength }) => {
      localStorage.setItem("cf.storiesPreview", strength ? "1" : "0");
      if (strength) localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more: { "look.mode": "see-through", "look.strength": strength } }));
      const look = JSON.stringify({
        backgroundMode: cf === "clear" || cf === "frosted" ? "see-through" : cf,
        glassStrength: cf === "frosted" ? "frosted" : "clear",
        backgroundColours: ["#e2621f", "#3355dd"],
      });
      if (!localStorage.getItem("cf.prefs")) localStorage.setItem("cf.prefs", look);
      if (!sessionStorage.getItem("cf-mock-look")) sessionStorage.setItem("cf-mock-look", look);
      if (cf === "picture" && !localStorage.getItem("cf.background")) {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 40;
        const x = c.getContext("2d")!;
        const g = x.createLinearGradient(0, 0, 64, 40);
        g.addColorStop(0, "#f4d9b0");
        g.addColorStop(0.5, "#5a7fa8");
        g.addColorStop(1, "#ffffff");
        x.fillStyle = g;
        x.fillRect(0, 0, 64, 40);
        localStorage.setItem("cf.background", c.toDataURL("image/jpeg"));
      }
    },
    { cf, strength },
  );
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot, .skeleton"), undefined, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
}

async function clipsReady(page: Page) {
  await page.locator(".app main.main").waitFor({ timeout: 30_000 });
  await settle(page);
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

/** The share of the screen that is the magenta desktop (or its colour under `frost` of the veil), painted behind. */
async function desktopShown(page: Page, frost = 0): Promise<number> {
  await paintGlass(page, { name: "magenta", background: "rgb(255 0 255)" });
  const got = await share(page, MAGENTA.map((m, i) => Math.round(VEIL[i]! * frost + m * (1 - frost))));
  await paintGlass(page, { name: "none", background: "" });
  return got;
}

const shown = (page: Page) =>
  page.evaluate(() => ({
    seeThrough: document.documentElement.classList.contains("see-through"),
    backdropKind: document.documentElement.dataset.backdrop ?? null,
    strengthOnHtml: document.documentElement.dataset.strength ?? null,
    look: document.querySelector<HTMLElement>(".stories-app")?.dataset.look ?? null,
    strength: document.querySelector<HTMLElement>(".stories-app")?.dataset.strength ?? null,
    // Clip Factory's own backdrop: every .backdrop outside Stories, as drawn
    backdrops: [...document.querySelectorAll<HTMLElement>(".backdrop")].filter((b) => !b.closest(".stories-app")).map((b) => ({ cls: b.className, display: getComputedStyle(b).display })),
    // nothing of Stories' old reach into Clip Factory's page
    marks: [...document.querySelectorAll("[data-st-hidden], [data-st-window], [data-st-see-through]")].length,
  }));

async function expectStories(page: Page, strength: "clear" | "frosted", why: string) {
  const s = await shown(page);
  expect(s.look, why).toBe("window");
  expect(s.strength, why).toBe(strength);
  expect(s.seeThrough, `${why}: the page is see-through`).toBe(true);
  expect(s.backdrops, `${why}: nothing of Clip Factory's backdrop under Stories`).toEqual([]);
  expect(s.marks, why).toBe(0);
  // The desktop between the panels: the magenta itself for Clear, Stories' own frost over it for Frosted (5 to 6 % of
  // the dashboard at 1440 x 900, 8 % or more of the library; anything of Clip Factory's backdrop under it: none).
  expect(await desktopShown(page, strength === "clear" ? 0 : FROST), `${why}: the desktop as Stories' ${strength} says`).toBeGreaterThan(3);
}

async function expectClips(page: Page, cf: ClipsLook, why: string) {
  const s = await shown(page);
  expect(s.seeThrough, `${why}: html.see-through`).toBe(cf === "clear" || cf === "frosted");
  expect(s.backdropKind, `${why}: data-backdrop`).toBe(KIND[cf]);
  expect(s.strengthOnHtml, `${why}: data-strength`).toBe(cf === "clear" ? "clear" : cf === "frosted" ? "frosted" : null);
  expect(s.backdrops.length, `${why}: Clip Factory's backdrop is drawn`).toBe(1);
  expect(s.backdrops[0]!.cls, why).toContain(BACKDROP[cf]);
  expect(s.backdrops[0]!.display, why).not.toBe("none");
  expect(s.marks, why).toBe(0);
  // The desktop shows between Clip Factory's panels only for its See-through Clear (its Frosted lays its own frost).
  const desktop = await desktopShown(page);
  if (cf === "clear") expect(desktop, `${why}: the desktop shows`).toBeGreaterThan(8);
  else expect(desktop, `${why}: nothing of the desktop shows`).toBeLessThan(0.5);
}

async function toOther(page: Page, to: "clips" | "stories") {
  await page.locator(".ws-dock .ws-switch__opt:not(.is-on)").first().click();
  if (to === "clips") {
    await page.waitForURL((u) => !u.pathname.startsWith("/stories"), { timeout: 15_000 });
    await clipsReady(page);
  } else {
    await page.waitForURL((u) => u.pathname.startsWith("/stories"), { timeout: 15_000 });
    await storiesReady(page);
  }
}

for (const cf of ["colours", "picture", "clear", "frosted"] as const)
  for (const strength of ["clear", "frosted"] as const) {
    test(`Clip Factory on ${NAMES[cf]}, Stories See-through ${strength}: opened in Stories, then Clip Factory, then Stories`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await prepare(page, cf, strength);
      await page.goto("/stories/library");
      await storiesReady(page);
      await expectStories(page, strength, "opened in Stories");
      await toOther(page, "clips");
      await expectClips(page, cf, "over to Clip Factory");
      await toOther(page, "stories");
      await expectStories(page, strength, "back in Stories");
    });

    test(`Clip Factory on ${NAMES[cf]}, Stories See-through ${strength}: opened in Clip Factory, then Stories, then Clip Factory`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await prepare(page, cf, strength);
      await page.goto("/");
      await clipsReady(page);
      await expectClips(page, cf, "opened in Clip Factory");
      await toOther(page, "stories");
      await expectStories(page, strength, "over to Stories");
      await toOther(page, "clips");
      await expectClips(page, cf, "back in Clip Factory");
    });
  }

/** Another device saves Clip Factory's Look; this device has it once its session refreshed (cf.prefs says so). */
async function savedElsewhere(page: Page, patch: { backgroundMode: string; glassStrength?: string }) {
  await page.evaluate((p) => (window as unknown as { __cfMock: { otherDevice: { saveLook: (x: unknown) => void } } }).__cfMock.otherDevice.saveLook(p), patch);
  await page.waitForFunction((mode) => (JSON.parse(localStorage.getItem("cf.prefs") ?? "{}") as { backgroundMode?: string }).backgroundMode === mode, patch.backgroundMode, { timeout: 15_000 });
  await page.waitForTimeout(300);
}

test("the review's case: Clip Factory's Look saved as Colours and then See-through on another device while Stories is on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, "clear", "clear");
  await page.goto("/stories/library");
  await storiesReady(page);
  await expectStories(page, "clear", "Stories on screen");
  await savedElsewhere(page, { backgroundMode: "colours" });
  await expectStories(page, "clear", "Clip Factory synced to Colours");
  await savedElsewhere(page, { backgroundMode: "see-through" });
  await expectStories(page, "clear", "Clip Factory synced back to See-through");
  await toOther(page, "clips");
  await expectClips(page, "clear", "back in Clip Factory: its See-through page");
});

test("the other way: Clip Factory on Colours, saved as See-through on another device while Stories is on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, "colours", "frosted");
  await page.goto("/");
  await clipsReady(page);
  await toOther(page, "stories");
  await expectStories(page, "frosted", "Stories on screen");
  await savedElsewhere(page, { backgroundMode: "see-through", glassStrength: "clear" });
  await expectStories(page, "frosted", "Clip Factory synced to See-through");
  await toOther(page, "clips");
  await expectClips(page, "clear", "back in Clip Factory: its See-through page");
  await toOther(page, "stories");
  await savedElsewhere(page, { backgroundMode: "colours" });
  await toOther(page, "clips");
  await expectClips(page, "colours", "back in Clip Factory again: its Colours");
});

for (const cf of ["colours", "picture", "clear", "frosted"] as const)
  test(`Stories switched off, Clip Factory on ${NAMES[cf]}: exactly as its own settings say`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page, cf, null);
    await page.goto("/");
    await clipsReady(page);
    expect(await page.locator("[data-app-pane], .ws-dock").count()).toBe(0);
    await expectClips(page, cf, "Stories off");
  });
