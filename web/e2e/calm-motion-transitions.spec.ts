import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Calm motion adds no transitions (docs/CONTRACTS.md §20.6). base.css cuts every transition and animation to 1 ms
// under calm motion (the system's setting or Settings › Motion, in either app). transition-property is `all` unless a
// rule sets it, so before base.css also gave every element `transition-property: none` (at specificity 0, so every
// element's own transition still wins), every style change on every element was a 1 ms transition of it. A transition
// lands only on the next frame drawn, and on CI's software paint that frame came hundreds of ms late: the page read
// the old place, colour or visibility (the dock's switch, Clips Funded's rail foot, the dock's toggle mark, Clip
// Factory's backdrop). These checks read styles only, never a frame: no element or ::before/::after may transition
// every property, in both apps, after a switch each way and a page change in each, while the parts with a transition
// of their own keep it, at 1 ms.

/** Elements and pseudo-elements that would transition every property (`all` with a duration over 0). */
const transitionsAll = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    let seen = 0;
    let own = 0;
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`;
    for (const el of document.querySelectorAll("body *")) {
      for (const pseudo of [null, "::before", "::after"] as const) {
        const cs = getComputedStyle(el, pseudo);
        const props = cs.transitionProperty.split(",").map((p) => p.trim());
        const durations = cs.transitionDuration.split(",").map((d) => parseFloat(d));
        const lasts = (i: number) => (durations[i % durations.length] ?? 0) > 0;
        seen++;
        if (props.some((p, i) => p === "all" && lasts(i))) found.push(`${name(el)}${pseudo ?? ""}`);
        // A transition of its own (a property list), cut to base.css's 1 ms.
        else if (props.some((p, i) => p !== "none" && p !== "all" && lasts(i)) && cs.transitionDuration.split(",").every((d) => d.trim() === "0.001s")) own++;
      }
    }
    return { found: [...new Set(found)].slice(0, 20), seen, own };
  });

async function expectNoneAdded(page: Page, where: string) {
  const { found, seen, own } = await transitionsAll(page);
  expect(seen, `${where}: the page was read`).toBeGreaterThan(300);
  expect(found, `${where}: nothing transitions every property`).toEqual([]);
  // The controls' own transitions are still there, cut to 1 ms, so they still end (and their end event fires) at once.
  expect(own, `${where}: own transitions kept at 1 ms`).toBeGreaterThan(0);
}

type Calm = "os" | "setting";

/** Calm motion from the system's setting, or from Settings › Motion (Clip Factory's switch, and Clips Funded's own). */
async function calm(page: Page, how: Calm) {
  await page.emulateMedia({ reducedMotion: how === "os" ? "reduce" : "no-preference" });
  await page.addInitScript((setting) => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more: setting ? { "motion.reduce": true } : {} }));
  }, how === "setting");
  if (how === "os") {
    await page.goto("/");
    await clipsReady(page);
    return;
  }
  // The account's settings arrive after the page loads and win over this device's copy, so the switch is turned on.
  await page.goto("/settings/look-and-feel/motion");
  await clipsReady(page);
  const sw = page.getByRole("switch", { name: /Reduce motion/ });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await goInApp(page, "/");
  await clipsReady(page);
  expect(await page.evaluate(() => document.documentElement.classList.contains("reduce-motion"))).toBe(true);
}

async function clipsReady(page: Page) {
  await page.locator(".app main.main").waitFor({ timeout: 30_000 });
  await settle(page);
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot, .skeleton"), undefined, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

/** An in-app page change (no reload), as a tap on a menu item makes. */
async function goInApp(page: Page, to: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, to);
}

const SIZES = [
  { width: 1440, height: 900, phone: false },
  { width: 375, height: 812, phone: true },
] as const;

for (const how of ["os", "setting"] as const)
  for (const size of SIZES)
    test(`calm motion (${how === "os" ? "the system's setting" : "Settings › Motion"}) at ${size.width} px adds no transitions: both apps, a switch each way, a page change in each`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await calm(page, how);
      await expectNoneAdded(page, "Clip Factory's Home");

      await goInApp(page, "/library");
      await clipsReady(page);
      await expectNoneAdded(page, "Clip Factory's Library");

      const toStories = size.phone ? page.locator("[data-app-pane]:not([hidden]) .ws-switch-host--topbar .ws-round--phone") : page.locator(".ws-dock .ws-switch__opt:not(.is-on), .ws-dock .ws-round").first();
      await toStories.click();
      await page.waitForURL((u) => u.pathname.startsWith("/stories"), { timeout: 15_000 });
      await storiesReady(page);
      if (how === "setting") expect(await page.evaluate(() => document.documentElement.classList.contains("reduce-motion"))).toBe(true);
      await expectNoneAdded(page, "Clips Funded after the switch");

      await goInApp(page, "/stories/ideas");
      await page.locator(".st-studio").first().waitFor();
      await storiesReady(page);
      await expectNoneAdded(page, "Clips Funded's Ideas");

      const toClips = size.phone ? page.locator(".st-top .ws-round--phone") : page.locator(".ws-dock .ws-switch__opt:not(.is-on), .ws-dock .ws-round").first();
      await toClips.click();
      await page.waitForURL((u) => !u.pathname.startsWith("/stories"), { timeout: 15_000 });
      await clipsReady(page);
      await expectNoneAdded(page, "Clip Factory after the switch back");
    });

test("with motion on, nothing changes: an element with no transition of its own still has none, and the controls keep their own", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await clipsReady(page);
  const read = await page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? { property: getComputedStyle(el).transitionProperty, duration: getComputedStyle(el).transitionDuration } : null;
    };
    return { main: cs(".app main.main"), btn: cs(".btn") };
  });
  // The initial value, untouched by base.css: `all` over 0 s (no transition at all).
  expect(read.main).toEqual({ property: "all", duration: "0s" });
  // A control's own transition at its full length.
  expect(read.btn?.property).toContain("transform");
  expect(read.btn?.duration).not.toContain("0.001s");
});
