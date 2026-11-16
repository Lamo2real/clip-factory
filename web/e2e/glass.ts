import type { Page } from "@playwright/test";
import { glassFloor, LIQUID_MEASURED, type GlassStrength, type NativeGlass, type Rgb } from "../src/lib/background.ts";

// Stand-ins for the desktop window's glass (docs/CONTRACTS.md §22). The real glass is drawn by the operating system
// outside the page, so no browser test can see it. These paint what was measured behind the transparent page
// instead; `scanText` (helpers.ts) then holds every piece of text to the same contrast bar as any other look.

/**
 * Pretends to be the desktop app with this window glass, the way desktop/src-tauri/src/init.js does. `glass` is what
 * the wrapper would report ("liquid", "vibrancy", "acrylic", "blur", "none", or a name this web bundle does not
 * know). With `strength`, Glass strength is already saved, on the device and on the (mock) server.
 */
export async function asDesktop(page: Page, glass: string, strength?: GlassStrength) {
  await page.addInitScript(
    ({ glass, strength }) => {
      (window as unknown as Record<string, unknown>).__CF_GLASS__ = glass;
      (window as unknown as Record<string, unknown>).__CF_DESKTOP__ = true;
      if (!strength) return;
      const look = JSON.stringify({ backgroundMode: "see-through", glassStrength: strength });
      if (!localStorage.getItem("cf.prefs")) localStorage.setItem("cf.prefs", look);
      if (!sessionStorage.getItem("cf-mock-look")) sessionStorage.setItem("cf-mock-look", look);
    },
    { glass, strength },
  );
}

const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/**
 * A busy picture (sky, sun, a white cloud, a red car, a pitch-black garage, grass) the way macOS Liquid Glass shows
 * it: blurred soft (big shapes stay guessable, small ones melt), then mapped so that black and white come out as
 * measured (`LIQUID_MEASURED`) for a window in use (`active`) or with another app in use (`inactive`). A CSS
 * `background` value that stays put while the page scrolls, like the real glass.
 */
export function glassScene(state: keyof typeof LIQUID_MEASURED): string {
  const { overBlack, overWhite } = LIQUID_MEASURED[state];
  const map = (["R", "G", "B"] as const)
    .map((c, i) => `<feFunc${c} type='linear' slope='${((overWhite[i]! - overBlack[i]!) / 255).toFixed(4)}' intercept='${(overBlack[i]! / 255).toFixed(4)}'/>`)
    .join("");
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90' preserveAspectRatio='xMidYMid slice'>" +
    `<defs><filter id='g' x='0' y='0' width='160' height='90' filterUnits='userSpaceOnUse' color-interpolation-filters='sRGB'><feGaussianBlur stdDeviation='1.1'/><feComponentTransfer>${map}<feFuncA type='linear' slope='0' intercept='1'/></feComponentTransfer></filter></defs>` +
    "<g filter='url(#g)'>" +
    "<rect x='-40' y='-40' width='240' height='104' fill='#7cc4f2'/>" +
    "<circle cx='132' cy='16' r='11' fill='#f6c945'/>" +
    "<rect x='14' y='8' width='44' height='16' rx='8' fill='#fff'/>" +
    "<rect x='-40' y='62' width='240' height='70' fill='#3f5a33'/>" +
    "<rect x='-40' y='22' width='76' height='44' fill='#000'/>" +
    "<path d='M52 66c2-10 8-15 18-16l12-11c4-3 8-4 13-4h26c6 0 11 2 14 7l8 9c10 1 17 6 18 15z' fill='#e8412c'/>" +
    "<circle cx='75' cy='68' r='9' fill='#000'/><circle cx='131' cy='68' r='9' fill='#000'/>" +
    "</g></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / cover no-repeat fixed, ${css(overBlack)}`;
}

/** What a test paints behind the transparent page. */
export interface GlassPaint {
  name: string;
  /** A CSS `background` for `<html>`. */
  background: string;
}
/** Liquid Glass at its darkest, exactly as measured: another app is in use and pure black is behind the window. */
export const INACTIVE_FLOOR: GlassPaint = { name: "the inactive glass over black, as measured", background: css(LIQUID_MEASURED.inactive.overBlack) };
/** Liquid Glass over pure black while the window is in use (khaki, from the app's tint). */
export const ACTIVE_FLOOR: GlassPaint = { name: "the glass in use over black, as measured", background: css(LIQUID_MEASURED.active.overBlack) };
/** The lightest any glass can be. */
export const WHITE: GlassPaint = { name: "white", background: "rgb(255 255 255)" };
export const INACTIVE_SCENE: GlassPaint = { name: "a busy picture behind the inactive glass", background: glassScene("inactive") };
export const ACTIVE_SCENE: GlassPaint = { name: "a busy picture behind the glass in use", background: glassScene("active") };
/**
 * The darkest this glass can be as the page plans for it (`glassFloor`): a tenth darker than measured for Liquid
 * Glass, the app's tint over black for Windows blur, plain black for the glasses nobody has measured.
 */
export function plannedFloor(glass: NativeGlass): GlassPaint {
  return { name: `the darkest ${glass} glass the page plans for`, background: css(glassFloor(glass, "light")) };
}

/**
 * Every window glass with its own numbers, and what to paint behind it. Windows acrylic and mica plan for the same
 * black as the macOS vibrancy material and get the same tints, so one of the three stands for all.
 */
export const WINDOW_LOOKS: readonly { glass: NativeGlass; paints: readonly GlassPaint[] }[] = [
  { glass: "liquid", paints: [plannedFloor("liquid"), INACTIVE_FLOOR, ACTIVE_FLOOR, INACTIVE_SCENE, ACTIVE_SCENE, WHITE] },
  { glass: "vibrancy", paints: [plannedFloor("vibrancy"), WHITE] },
  { glass: "blur", paints: [plannedFloor("blur"), WHITE] },
];

/**
 * Screens with an address that the shared route list (`ROUTES` in helpers.ts) leaves out, where words sit between
 * panels: This week (with clips, and an empty week) and the skill pages (write one, one the owner wrote, one from a
 * file, the edit form, one that does not exist). The window look is checked on them as on every route.
 */
export const WINDOW_EXTRA_ROUTES: readonly string[] = [
  "/library?view=week",
  "/library?view=week&week=2026-W30",
  ...["new", "01JZ8S00000000000000000001", "01JZ8S00000000000000000003", "01JZ8S00000000000000000001/edit", "nope"].map((p) => `/settings/clip-making/skills/${p}`),
];

/** Paints `<html>` with a stand-in for the glass (the page itself stays transparent). */
export async function paintGlass(page: Page, paint: GlassPaint) {
  await page.evaluate(async (bg) => {
    document.documentElement.style.setProperty("background", bg, "important");
    // Two frames, so a picture taken next (scanText photographs the backdrop) can never show the paint before.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, paint.background);
}
