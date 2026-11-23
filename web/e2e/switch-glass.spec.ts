import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_COLOURS } from "../src/lib/background.ts";
import { asMacWindow } from "./desktopWindow.ts";
import { looseText, scanText, settle } from "./helpers.ts";
import { busyness, decode, type Pixels } from "./pixels.ts";

// The workspace switch is see-through, colour-free liquid glass (the owner, 2026-11-23: "make his color freee and
// liquid glass style", then "see through liquid glassy instead of black and white so whatever is under it is visible
// through the glassy buttons"; docs/CONTRACTS.md §45.38 S5), measured in real pixels wherever it is drawn: the dock
// over Clip Factory's sidebar and over Clips Funded's rail, the stacked switch in both phone top bars' menus, in every
// look (the app's own backdrop, Colours, Colours with a Cream backdrop, Picture with a white photo, the see-through
// window Clear and Frosted over a white desktop, and Clips Funded's own picture and window looks). With the words
// hidden, the pixels where each name's words sit are read:
//   - every name keeps 4.5:1 against the lightest and the darkest pixel behind its words, at rest and hovered;
//   - the chosen side is plainly the chosen one for a child: its lens is at least 0.06 OKLab L over the track where
//     the words sit, at rest and while the other name is hovered (hover lays no light under the words, only in the
//     band above them, where it adds at least 0.01);
//   - the track is see-through: with the switch hidden, the same pixels read what is under it, and the track keeps
//     them, no smoke (at most 0.06 OKLab L darker), only a faint tint (at most 0.05 lighter), and their colour (at
//     least 70 % of their chroma, where they have any);
//   - unfolding Clip Factory's sidebar, the switch keeps its glass: its blur and light never drop while the dock's
//     clip runs (the clip is the switch's own, never its host's, which would be its glass's Backdrop Root);
//   - scanText and looseText (e2e/helpers.ts) read its words over the panel its dock is drawn over, and still catch
//     dimmed words;
//   - the Live chip under it is the same see-through glass (the owner, 23 Nov: "the live indicator should be one
//     glasssy liquyid theme as well"): its word at AA wherever it is drawn, and over the sidebar or the rail the same
//     see-through floors as the track; at a phone's top bar (no panel there) it carries the tint its word needs;
//   - over no panel (Clips Funded's first Setup on a computer: no rail under the dock) the switch and the chip carry a
//     plate of their own, their words at AA and the lens plainly lit, in Clips Funded's Ember, picture and window looks;
//   - in Clips Funded's picture and window looks the phone list's plate keeps the page under it a faint shade: no
//     readable words show through behind the names (its top bar is the list's Backdrop Root, so the list's blur sees
//     nothing of the page).
// test/switchGlass.test.ts holds the colours of the CSS and works them out on paper; this holds what they add up to on
// screen. Pictures under test-results/switch-glass. Clips Funded is switched on with cf.storiesPreview = 1.

const SHOTS = join(import.meta.dirname, "..", "test-results", "switch-glass");
const WHITE = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' fill='#fff'/></svg>")}`;

/**
 * The plainly-chosen floor (S5): the lens over the track, at rest and over a hovered name alike (hover lays no light
 * under the words). What hover's light adds in the band above the words, and AA.
 */
const LIFT = 0.06;
const HOVER_UP = 0.01;
const AA = 4.5;
/** How busy the pixels behind a name in a phone list may be with the switch hidden: a faint shade, no sharp words. */
const SHARP = 2.5;
/** The shell's Live chip in the dock, and at a phone's top bar. */
const LIVE_DOCK = ".ws-dock > .ws-dock__live > .live-dot";
const LIVE_TOP = "[data-app-pane]:not([hidden]) .ws-switch-host--topbar > .live-dot";
/** See-through: the track over what is under it, in OKLab L (no smoke, a faint tint) and the share of its chroma kept. */
const NO_SMOKE = -0.06;
const FAINT = 0.05;
const KEEPS = 0.7;

interface Look {
  name: string;
  /** Clip Factory's look (cf.prefs); none is the app's own. */
  cf?: Record<string, unknown>;
  /** A white photo for Clip Factory's Picture look. */
  picture?: boolean;
  /** The see-through window over a white desktop. */
  window?: boolean;
  /** Clips Funded' own look. */
  stories?: "picture" | "window";
}
const LOOKS: Look[] = [
  { name: "own backdrop" },
  { name: "Colours", cf: { backgroundMode: "colours", backgroundColours: [...DEFAULT_COLOURS] } },
  { name: "Colours Cream", cf: { backgroundMode: "colours", backgroundColours: ["#f7f5ef"] } },
  { name: "Picture white", cf: { backgroundMode: "picture" }, picture: true },
  { name: "window Clear", cf: { backgroundMode: "see-through", glassStrength: "clear" }, window: true },
  { name: "window Frosted", cf: { backgroundMode: "see-through", glassStrength: "frosted" }, window: true },
  { name: "Clips Funded picture white", cf: { backgroundMode: "picture" }, picture: true, stories: "picture" },
  { name: "Clips Funded window", cf: { backgroundMode: "see-through", glassStrength: "clear" }, window: true, stories: "window" },
];

async function useLook(page: Page, look: Look, studios = 0, solo = false) {
  if (look.window) await asMacWindow(page);
  await page.addInitScript(
    ({ cf, picture, stories, studios, white, window: win, solo }) => {
      localStorage.setItem("cf.storiesPreview", "1");
      if (cf) {
        localStorage.setItem("cf.prefs", JSON.stringify(cf));
        sessionStorage.setItem("cf-mock-look", JSON.stringify(cf));
      }
      if (picture) localStorage.setItem("cf.background", white);
      const more: Record<string, string> = {};
      if (stories === "picture") more["look.mode"] = "picture";
      if (stories === "window") more["look.mode"] = "see-through";
      // `solo`: a brand-new studio, whose Setup opens by itself, on its own (no rail under the dock).
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: solo ? [] : ["e2e"], more }));
      if (stories === "picture") localStorage.setItem("cf.stories.picture", white);
      if (studios || solo) (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { ...(studios ? { moreStudios: studios } : {}), ...(solo ? { fresh: true } : {}) } };
      // Every platform skipped: no setup list floating over the sidebar's foot.
      if (!sessionStorage.getItem("cf-mock-setup-skipped")) sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(["youtube", "tiktok", "instagram", "facebook", "x"]));
      // A white desktop behind the see-through window (html.see-through leaves the page's own canvas showing).
      if (win)
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = "html.see-through, html.see-through body { background: #fff !important; }";
          document.head.append(st);
        });
    },
    { cf: look.cf ?? null, picture: !!look.picture, stories: look.stories ?? null, studios, white: WHITE, window: !!look.window, solo },
  );
}

async function open(page: Page, path: "/" | "/stories") {
  await page.goto(path);
  if (path === "/stories") {
    await page.locator(".stories-app[data-ws]").waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
  } else await settle(page);
}

// sRGB, WCAG and OKLab.
type Rgb = [number, number, number];
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const oklab = ([r, g, b]: Rgb): Rgb => {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};

interface Name {
  text: string;
  on: boolean;
  /** Its words' colour. */
  color: Rgb;
  /** The worst contrast of its words against the pixels behind them. */
  contrast: number;
  /** Mean OKLab L and chroma of those pixels. */
  L: number;
  C: number;
  /** How busy those pixels are (pixels.ts busyness: sharp words high, a blur low). */
  busy: number;
  /** Mean OKLab L of the option's top band (1 to 6 px down, 4 px in from its sides): where hover's light lies. */
  topL: number;
}

/** The pixels of `px` (a shot of `clip`) inside `box`: their worst contrast against `words`, mean OKLab L and chroma. */
function behind(px: Pixels, clip: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }, words: number) {
  let worst = Infinity;
  let sL = 0;
  let sa = 0;
  let sb = 0;
  let count = 0;
  const x0 = Math.max(0, Math.ceil(box.x - clip.x));
  const x1 = Math.min(px.width, Math.floor(box.x + box.w - clip.x));
  const y0 = Math.max(0, Math.ceil(box.y - clip.y));
  const y1 = Math.min(px.height, Math.floor(box.y + box.h - clip.y));
  const grid: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * px.width + x) * 4;
      const c: Rgb = [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
      grid.push(c[0], c[1], c[2], 255);
      worst = Math.min(worst, ratio(words, lum(c)));
      const [L, a, b] = oklab(c);
      sL += L;
      sa += a;
      sb += b;
      count++;
    }
  const w = Math.max(0, x1 - x0);
  const busy = w > 1 && count ? busyness({ width: w, height: count / w, data: grid }) : 0;
  return { count, contrast: worst, L: count ? sL / count : 0, C: count ? Math.hypot(sa / count, sb / count) : 0, busy };
}

/**
 * Each name of the switch `root`: its words' colour against the pixels behind them, with the words hidden. `bare`: the
 * whole switch hidden instead, so the same pixels read what is under it.
 */
async function read(page: Page, root: string, shot: string, bare = false): Promise<Name[]> {
  const bar = page.locator(root).first();
  await expect(bar, root).toBeVisible();
  const info = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      bar: { x: r.x, y: r.y, w: r.width, h: r.height },
      names: Array.from(el.querySelectorAll(".ws-switch__opt")).map((o) => {
        const range = document.createRange();
        range.selectNodeContents(o);
        const t = range.getBoundingClientRect();
        const b = o.getBoundingClientRect();
        // Where the words are, inside the option's own box (its 2 px edge left out).
        const x0 = Math.max(t.left, b.left + 2);
        const x1 = Math.min(t.right, b.right - 2);
        return {
          text: o.textContent!.trim(),
          on: o.classList.contains("is-on"),
          color: getComputedStyle(o).color,
          box: { x: x0, y: t.top, w: x1 - x0, h: t.height },
          band: { x: b.left + 4, y: b.top + 1, w: b.width - 8, h: 5 },
        };
      }),
    };
  });
  mkdirSync(SHOTS, { recursive: true });
  const vw = page.viewportSize()!;
  const around = { x: Math.max(0, Math.floor(info.bar.x) - 24), y: Math.max(0, Math.floor(info.bar.y) - 24), width: 0, height: 0 };
  around.width = Math.min(vw.width - around.x, Math.ceil(info.bar.w) + 48);
  around.height = Math.min(vw.height - around.y, Math.ceil(info.bar.h) + 48);
  await page.screenshot({ clip: around, path: join(SHOTS, `${shot} words.png`) });
  const hide = await page.addStyleTag({
    content: bare ? `${root} { visibility: hidden !important; }` : `${root} .ws-switch__opt { color: transparent !important; text-shadow: none !important; transition: none !important; }`,
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const clip = { x: Math.floor(info.bar.x), y: Math.floor(info.bar.y), width: Math.ceil(info.bar.w) + 1, height: Math.ceil(info.bar.h) + 1 };
  const png = await page.screenshot({ clip });
  await page.screenshot({ clip, path: join(SHOTS, `${shot}.png`) });
  await hide.evaluate((el) => (el as Element).remove());
  const px = await decode(page, png);
  return info.names.map((n) => {
    const color = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(n.color)!.slice(1, 4).map(Number) as Rgb;
    const at = behind(px, clip, n.box, lum(color));
    expect(at.count, `${shot}: pixels behind "${n.text}"`).toBeGreaterThan(100);
    const band = behind(px, clip, n.band, lum(color));
    return { text: n.text, on: n.on, color, contrast: at.contrast, L: at.L, C: at.C, busy: at.busy, topL: band.L };
  });
}

/**
 * The Live chip `root` (its word "Live"): its word's colour against the pixels behind it, with the word hidden; `bare`:
 * the whole chip hidden instead, so the same pixels read what is under it.
 */
async function readChip(page: Page, root: string, shot: string, bare = false) {
  const chip = page.locator(root).first();
  await expect(chip, root).toBeVisible({ timeout: 15_000 });
  const info = await chip.evaluate((el) => {
    const label = el.querySelector(".live-dot__label")!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const t = range.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { chip: { x: r.x, y: r.y, w: r.width, h: r.height }, box: { x: t.left, y: t.top, w: t.width, h: t.height }, color: getComputedStyle(label).color };
  });
  mkdirSync(SHOTS, { recursive: true });
  const clip = { x: Math.floor(info.chip.x), y: Math.floor(info.chip.y), width: Math.ceil(info.chip.w) + 1, height: Math.ceil(info.chip.h) + 1 };
  await page.screenshot({ clip, path: join(SHOTS, `${shot} words.png`) });
  const hide = await page.addStyleTag({
    content: bare ? `${root} { visibility: hidden !important; }` : `${root} .live-dot__label { color: transparent !important; text-shadow: none !important; }`,
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const png = await page.screenshot({ clip });
  await page.screenshot({ clip, path: join(SHOTS, `${shot}.png`) });
  await hide.evaluate((el) => (el as Element).remove());
  const color = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(info.color)!.slice(1, 4).map(Number) as Rgb;
  const at = behind(await decode(page, png), clip, info.box, lum(color));
  expect(at.count, `${shot}: pixels behind "Live"`).toBeGreaterThan(40);
  return { ...at, color };
}

/**
 * The Live chip `root`: its word at AA; `seeThrough` (over the sidebar or the rail): against the same pixels with the
 * chip hidden, no smoke, only a faint tint, their colour kept, as the track's.
 */
async function checkChip(page: Page, root: string, at: string, fails: string[], seeThrough: boolean) {
  await page.mouse.move(1, 1);
  const rest = await readChip(page, root, `${at} Live`.replace(/\W+/g, "-"));
  if (rest.contrast < AA) fails.push(`${at}: "Live" ${rest.contrast.toFixed(2)}:1 (words rgb ${rest.color.join(" ")})`);
  let note = `"Live" ${rest.contrast.toFixed(2)}:1 L ${rest.L.toFixed(3)} C ${rest.C.toFixed(3)}`;
  if (seeThrough) {
    const u = await readChip(page, root, `${at} Live under`.replace(/\W+/g, "-"), true);
    note += ` || under L ${u.L.toFixed(3)} C ${u.C.toFixed(3)}`;
    if (rest.L - u.L < NO_SMOKE) fails.push(`${at}: the Live chip is smoked, ${(rest.L - u.L).toFixed(3)} OKLab L under what is behind it`);
    if (rest.L - u.L > FAINT) fails.push(`${at}: the Live chip is frosted over, +${(rest.L - u.L).toFixed(3)} OKLab L`);
    if (u.C > 0.02 && rest.C < KEEPS * u.C) fails.push(`${at}: the Live chip drains the colour behind it, chroma ${rest.C.toFixed(3)} of ${u.C.toFixed(3)}`);
  }
  test.info().annotations.push({ type: `${at} Live`, description: note });
}

const fmt = (ns: Name[]) => ns.map((n) => `${n.on ? "*" : ""}${n.text} ${n.contrast.toFixed(2)}:1 L ${n.L.toFixed(3)} C ${n.C.toFixed(3)} busy ${n.busy.toFixed(2)} top ${n.topL.toFixed(3)}`).join(" | ");

/**
 * The switch `root` at rest and with the other name hovered: every word at AA, the lens plainly the brightest, hover
 * adding light, the track see-through. Failures go to `fails`; every reading to the test's notes.
 */
async function check(page: Page, root: string, at: string, fails: string[], opts: { plate?: boolean; sharp?: boolean } = {}) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  const rest = await read(page, root, `${at} rest`.replace(/\W+/g, "-"));
  const under = await read(page, root, `${at} under`.replace(/\W+/g, "-"), true);
  const on = rest.find((n) => n.on);
  const others = rest.filter((n) => !n.on);
  expect(on, `${at}: a chosen name`).toBeTruthy();
  expect(others.length, `${at}: other names`).toBeGreaterThan(0);
  const other = page.locator(`${root} .ws-switch__opt:not(.is-on)`).first();
  await other.hover();
  // Hover's fill and light fade in (--dur-2).
  await page.waitForTimeout(500);
  const hovered = await read(page, root, `${at} hover`.replace(/\W+/g, "-"));
  await page.mouse.move(1, 1);
  const h = hovered.find((n) => n.text === others[0]!.text)!;
  const hOn = hovered.find((n) => n.on)!;
  test.info().annotations.push({ type: at, description: `rest ${fmt(rest)} || hover ${fmt(hovered)} || under ${fmt(under)}` });
  for (const [state, names] of [["at rest", rest], ["hovered", hovered]] as const)
    for (const n of names) if (n.contrast < AA) fails.push(`${at} ${state}: "${n.text}" ${n.contrast.toFixed(2)}:1 (words rgb ${n.color.join(" ")})`);
  for (const o of others) if (on!.L - o.L < LIFT) fails.push(`${at}: the lens is only +${(on!.L - o.L).toFixed(3)} OKLab L over the track under "${o.text}"`);
  // While the other name is hovered the lens keeps its whole lift over it: hover's light lies above the words.
  if (hOn.L - h.L < LIFT) fails.push(`${at}: the lens is only +${(hOn.L - h.L).toFixed(3)} OKLab L over the hovered "${h.text}"`);
  const restBand = others[0]!.topL;
  if (h.topL - restBand < HOVER_UP) fails.push(`${at}: hover adds only +${(h.topL - restBand).toFixed(3)} OKLab L in its top band`);
  // In a phone list whose plate is the only thing between the names and the page: no sharp words show through.
  if (opts.sharp) for (const u of under) if (u.busy > SHARP) fails.push(`${at}: the page shows through sharp behind "${u.text}" (busy ${u.busy.toFixed(2)})`);
  // Over no panel the track carries a plate of its own: what is under it shows, but darkened, by design.
  if (opts.plate) return;
  // See-through: the track under each other name keeps what is under it (the panel, or the menu's plate).
  for (const o of others) {
    const u = under.find((n) => n.text === o.text)!;
    if (o.L - u.L < NO_SMOKE) fails.push(`${at}: the track under "${o.text}" is smoked, ${(o.L - u.L).toFixed(3)} OKLab L under what is behind it`);
    if (o.L - u.L > FAINT) fails.push(`${at}: the track under "${o.text}" is frosted over, +${(o.L - u.L).toFixed(3)} OKLab L`);
    if (u.C > 0.02 && o.C < KEEPS * u.C) fails.push(`${at}: the track under "${o.text}" drains the colour behind it, chroma ${o.C.toFixed(3)} of ${u.C.toFixed(3)}`);
  }
}

for (const look of LOOKS) {
  test(`the switch is see-through glass, its words at AA and the chosen side plainly lit (${look.name})`, async ({ browser }) => {
    test.setTimeout(150_000);
    const fails: string[] = [];
    // A computer: the dock over Clip Factory's sidebar, then over Clips Funded' rail.
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await useLook(page, look);
      for (const path of ["/", "/stories"] as const) {
        await open(page, path);
        await check(page, ".ws-dock .ws-switch", `${look.name} ${path} 1440`, fails);
        await checkChip(page, LIVE_DOCK, `${look.name} ${path} 1440`, fails, true);
      }
      await ctx.close();
    }
    // A phone, with three workspaces: the stacked switch in the menu of each app's own top bar.
    {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await useLook(page, look, 2);
      for (const path of ["/", "/stories"] as const) {
        await open(page, path);
        // The Live chip at the top bar: no panel under it, so its own tint holds its word.
        await checkChip(page, LIVE_TOP, `${look.name} ${path} phone`, fails, false);
        const host = page.locator("[data-app-pane]:not([hidden]) .ws-switch-host--topbar");
        await host.getByRole("button", { name: /^Pick a workspace/ }).click();
        const menu = "[data-app-pane]:not([hidden]) .ws-menu .ws-switch";
        await page.locator(menu).waitFor();
        await page.waitForTimeout(500);
        // Clips Funded's own picture and window looks: its top bar is the list's Backdrop Root, so only the plate
        // stands between the names and the page.
        await check(page, menu, `${look.name} ${path} phone menu`, fails, { sharp: path === "/stories" && !!look.stories });
        await page.keyboard.press("Escape");
      }
      await ctx.close();
    }
    expect(fails).toEqual([]);
  });
}

// Over no panel: Clips Funded's first Setup opens by itself, on its own, with no rail under the dock on a computer.
for (const look of [LOOKS[0]!, LOOKS.find((l) => l.name === "Clips Funded picture white")!, LOOKS.find((l) => l.name === "Clips Funded window")!]) {
  test(`over no panel (Clips Funded's first Setup) the switch and the Live chip carry a plate: words at AA, the lens plainly lit (${look.stories ?? "Ember"})`, async ({ browser }) => {
    test.setTimeout(90_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await useLook(page, look, 0, true);
    await open(page, "/stories");
    await expect(page).toHaveURL(/\/stories\/setup$/);
    await expect(page.locator(".stories-app.is-alone")).toHaveCount(1);
    await expect(page.locator(".st-rail")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-ws-bare", "");
    const fails: string[] = [];
    await check(page, ".ws-dock .ws-switch", `${look.stories ?? "Ember"} first Setup 1440`, fails, { plate: true });
    await checkChip(page, LIVE_DOCK, `${look.stories ?? "Ember"} first Setup 1440`, fails, false);
    expect(fails).toEqual([]);
    await ctx.close();
  });
}

test("unfolding Clip Factory's sidebar, the switch keeps its blur and light (its own clip, never its host's)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem("cf.prefs", JSON.stringify({ sidebarCollapsed: true }));
    if (!sessionStorage.getItem("cf-mock-setup-skipped")) sessionStorage.setItem("cf-mock-setup-skipped", JSON.stringify(["youtube", "tiktok", "instagram", "facebook", "x"]));
  });
  await page.goto("/jobs");
  await settle(page);
  await page.locator(".sidebar__toggle").click();
  await page.locator(".ws-dock.is-unfolding .ws-switch").waitFor();
  // Held late in the unfold (the sidebar has nearly grown; the dock's clip still runs), then read; then at its end.
  const during = await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = 440;
    }
    const host = document.querySelector<HTMLElement>(".ws-dock .ws-switch-host")!;
    const bar = host.querySelector<HTMLElement>(".ws-switch")!;
    const row = document.querySelector<HTMLElement>(".ws-dock .ws-dock__live")!;
    const chip = row.querySelector<HTMLElement>(".live-dot")!;
    return {
      host: [getComputedStyle(host).clipPath, getComputedStyle(host).opacity],
      bar: getComputedStyle(bar).clipPath,
      row: [getComputedStyle(row).clipPath, getComputedStyle(row).opacity],
      chip: getComputedStyle(chip).clipPath,
    };
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const a = await read(page, ".ws-dock .ws-switch", "unfold-during");
  const la = await readChip(page, LIVE_DOCK, "unfold-during");
  await page.evaluate(() => {
    for (const an of document.getAnimations()) {
      try {
        an.finish();
      } catch {
        an.play();
      }
    }
  });
  await expect(page.locator(".ws-dock")).not.toHaveClass(/is-unfolding/);
  await page.waitForTimeout(300);
  const b = await read(page, ".ws-dock .ws-switch", "unfold-after");
  const lb = await readChip(page, LIVE_DOCK, "unfold-after");
  test.info().annotations.push({ type: "unfold", description: `during ${fmt(a)} || after ${fmt(b)} || Live during L ${la.L.toFixed(3)} C ${la.C.toFixed(3)}, after L ${lb.L.toFixed(3)} C ${lb.C.toFixed(3)}` });
  // The chosen name (Clip Factory, on the left: shown by then) reads the same glass during the clip as after it.
  const [x, y] = [a.find((n) => n.on)!, b.find((n) => n.on)!];
  expect(Math.abs(x.C - y.C), `chroma during ${x.C.toFixed(3)}, after ${y.C.toFixed(3)}`).toBeLessThan(0.008);
  expect(Math.abs(x.L - y.L), `L during ${x.L.toFixed(3)}, after ${y.L.toFixed(3)}`).toBeLessThan(0.015);
  // So the host is never the switch's Backdrop Root: no clip and no opacity of its own; the bar carries the clip.
  expect(during.host).toEqual(["none", "1"]);
  expect(during.bar).toMatch(/^inset\(/);
  // The Live chip the same: its glass reads the same during the clip as after it, and the clip is its own, never its row's.
  expect(Math.abs(la.C - lb.C), `the Live chip's chroma during ${la.C.toFixed(3)}, after ${lb.C.toFixed(3)}`).toBeLessThan(0.008);
  expect(Math.abs(la.L - lb.L), `the Live chip's L during ${la.L.toFixed(3)}, after ${lb.L.toFixed(3)}`).toBeLessThan(0.015);
  expect(during.row).toEqual(["none", "1"]);
  expect(during.chip).toMatch(/^inset\(/);
  await ctx.close();
});

// scanText and looseText (e2e/helpers.ts, every contrast and see-through check) read the switch over the panel its
// dock is drawn over, and stay strict: over a white desktop the switch's faint glass alone could never hold white
// words, so passing there means the panel was read under them; and dimmed words must still fail.
for (const [path, look] of [["/", LOOKS.find((l) => l.name === "window Clear")!], ["/stories", LOOKS.find((l) => l.name === "Clips Funded window")!]] as const) {
  test(`scanText and looseText read the switch's words over the panel under the dock, and still catch dimmed words (${path})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await useLook(page, look);
    await open(page, path);
    await expect(page.locator(".ws-dock .ws-switch .ws-switch__opt")).toHaveCount(2);
    const names = (scan: Awaited<ReturnType<typeof scanText>>) => scan.contrast.filter((f) => f.selector.startsWith("a.ws-switch__opt"));
    expect(names(await scanText(page))).toEqual([]);
    expect((await looseText(page)).filter((t) => t.includes("ws-switch__opt"))).toEqual([]);
    // Dimmed words: both names must fail.
    const dim = await page.addStyleTag({ content: ".ws-dock .ws-switch__opt { color: rgb(255 255 255 / 0.45) !important; transition: none !important; }" });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(names(await scanText(page)).map((f) => f.text).sort()).toHaveLength(2);
    await dim.evaluate((el) => (el as Element).remove());
    await ctx.close();
  });
}
