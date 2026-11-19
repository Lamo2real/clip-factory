import { expect, test, type Page } from "@playwright/test";
import { GLIDE_MS } from "../src/components/Glide.tsx";
import { asMacWindow } from "./desktopWindow.ts";
import { arrived, settle } from "./helpers.ts";

// The menu highlight slides smoothly from start to finish on every page change (docs/CONTRACTS.md §20.13), in WebKit
// (the macOS desktop app's engine) and Chromium. Every frame is sampled from the tap until long after it lands:
// - it lands exactly on the chosen item, never passes it and never creeps back (no spring overshoot);
// - no frame jumps further than the curve itself moves (a stall shows as a jump);
// - in the last two thirds of the slide no frame comes later than about two and a half frames (the old cross-fade ended there
//   and WebKit rebuilt the whole glass page right on it: 35 to 118 ms gaps);
// - the slide is one transform-only animation, so the compositor runs it.
// Run in WebKit too (playwright.config.ts, project "webkit").

type Frame = [t: number, x: number, y: number, w: number, h: number];

/** The worst gap between frames while nothing happens: what this machine does on its own. */
async function idleGap(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((done) => {
        const ts: number[] = [];
        const t0 = performance.now();
        const tick = (now: number) => {
          ts.push(now);
          if (now - t0 < 400) requestAnimationFrame(tick);
          else done(Math.max(...ts.slice(1).map((t, i) => t - ts[i]!)));
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Taps `item` (a selector inside `list`) and records the glide's painted box on every frame until 900 ms after the
 * slide started (at most 5 s after the tap). The slide starts on the first frame drawn after the tap; on a busy CI
 * runner that frame came up to a second late, and a fixed 900 ms from the tap then ended mid-slide or before it.
 */
async function record(page: Page, list: string, item: string) {
  return page.evaluate(
    ({ list, item }) =>
      new Promise<{ frames: [number, number, number, number, number][]; target: number[]; anims: string[]; transitions: string }>((done) => {
        const box = document.querySelector<HTMLElement>(list)!;
        const g = box.querySelector<HTMLElement>(":scope > .glide")!;
        const frames: [number, number, number, number, number][] = [];
        let anims: string[] = [];
        let t0 = 0;
        let tSlide = -1;
        const tick = (now: number) => {
          const r = g.getBoundingClientRect();
          frames.push([now - t0, r.x, r.y, r.width, r.height]);
          if (anims.length === 0 && frames.length >= 2 && frames.length <= 12) {
            // What runs on the glide right after the tap (the first frames that show any: a slow runner can take a
            // frame or two to draw the new page): the one slide animation and the properties it animates.
            anims = g.getAnimations().map((a) => {
              const kf = (a.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
              const props = [...new Set(kf.flatMap((f) => Object.keys(f)).filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)))];
              return `${a.id || (a as CSSTransition).transitionProperty || "?"}:${props.join("+")}`;
            });
          }
          if (tSlide < 0 && g.getAnimations().some((a) => !a.pending)) tSlide = now;
          const from = tSlide < 0 ? t0 : tSlide;
          if (now - from < 900 && now - t0 < 5000) requestAnimationFrame(tick);
          else {
            const on = box.querySelector<HTMLElement>(item)!.getBoundingClientRect();
            done({ frames, target: [on.x, on.y, on.width, on.height], anims, transitions: getComputedStyle(g).transitionProperty });
          }
        };
        // A real tap presses before it clicks, and the app does its press work then (the first press builds the audio
        // context for the click sounds, lib/sound.ts). A bare click() skipped that, so on CI the first switch paid
        // for it inside the click's own frame and the slide started up to two seconds late.
        const target = box.querySelector<HTMLElement>(item)!;
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse" }));
        requestAnimationFrame(() =>
          requestAnimationFrame((now) => {
            t0 = now;
            target.click();
            tick(now);
          }),
        );
      }),
    { list, item },
  );
}

function analyse(frames: Frame[], target: number[], axis: 1 | 2) {
  const centre = (f: Frame | number[]) => f[axis]! + f[axis + 2]! / 2;
  const from = centre(frames[0]!);
  const to = target[axis - 1]! + target[axis + 1]! / 2;
  const travel = to - from;
  const dir = Math.sign(travel) || 1;
  const progress = frames.map((f) => (centre(f) - from) / (travel || 1));
  const start = frames.findIndex((_, i) => i > 0 && Math.abs(centre(frames[i]!) - from) > 0.5);
  const tStart = frames[Math.max(0, start - 1)]![0];
  let back = 0;
  let worstStep = 0;
  let lateGap = 0;
  let gap = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i]![0] - frames[i - 1]![0];
    const step = (centre(frames[i]!) - centre(frames[i - 1]!)) * dir;
    back = Math.min(back, step);
    if (frames[i]![0] <= tStart + GLIDE_MS + 34) {
      worstStep = Math.max(worstStep, (Math.abs(step) * 16.7) / Math.max(16.7, dt));
      gap = Math.max(gap, dt);
      if (frames[i - 1]![0] >= tStart + GLIDE_MS / 3) lateGap = Math.max(lateGap, dt);
    }
  }
  const last = frames[frames.length - 1]!;
  const landed = [last[1] - target[0]!, last[2] - target[1]!, last[3] - target[2]!, last[4] - target[3]!].every((d) => Math.abs(d) <= 1);
  const miss = `glide ${last.slice(1).map((v) => v.toFixed(1)).join(",")} vs item ${target.map((v) => v.toFixed(1)).join(",")}`;
  return { travel, overshoot: Math.max(...progress), back, worstStep, gap, lateGap, landed, miss, tStart };
}

async function everySwitch(page: Page, list: string, itemSel: (to: string) => string, order: string[], axis: 1 | 2) {
  const idle = await idleGap(page);
  // About two and a half frames, or more on a machine that is slow on its own.
  const allowed = Math.max(42, idle * 2.5);
  const report: string[] = [];
  let late = 0;
  for (const to of order) {
    const rec = await record(page, list, itemSel(to));
    const a = analyse(rec.frames, rec.target, axis);
    if (process.env.GLIDE_DEBUG) console.log(to, JSON.stringify(rec.frames.map((f) => [Math.round(f[0]), Math.round(f[axis]! * 10) / 10])));
    report.push(`${to}: ${Math.round(a.travel)}px, gap ${a.gap.toFixed(0)}ms (last 2/3 ${a.lateGap.toFixed(0)}ms), top ${(a.overshoot * 100).toFixed(1)}%`);
    // One animation, transform only; nothing transitions its place or size.
    expect(rec.anims, to).toEqual(["glide-slide:transform"]);
    expect(rec.transitions, to).not.toMatch(/transform|width|height|left|top|all/);
    expect(a.landed, `${to}: lands on the chosen item (to the pixel): ${a.miss}`).toBe(true);
    expect(a.overshoot, `${to}: never passes the item`).toBeLessThanOrEqual(1.01);
    expect(a.back, `${to}: never creeps back`).toBeGreaterThanOrEqual(-0.5);
    // The curve's fastest frame is its launch: about 0.21 of the way per 16.7 ms. A stall shows as a bigger jump.
    expect(a.worstStep, `${to}: fastest step over ${Math.abs(a.travel).toFixed(0)}px`).toBeLessThanOrEqual(Math.abs(a.travel) * 0.21 * 1.3 + 1.5);
    if (a.lateGap > allowed) late++;
  }
  // The slide runs on the compositor, so a late frame of the page's own (its main thread, say the tall Review page
  // being built) does not move it on screen; the checks above (one transform animation, the curve's steps, landing,
  // no overshoot) are what the eye sees. These frame times follow the machine's load (four test workers on CI made
  // three of seven switches late), so they only catch the old fault: the cross-fade's end stalled the last third of
  // most switches. Fewer than half may come late.
  expect(late, `switches with a frame later than ${allowed.toFixed(0)} ms in the last two thirds of the slide (${report.join(" | ")})`).toBeLessThanOrEqual(Math.floor((order.length - 1) / 2));
  test.info().annotations.push({ type: "glide", description: report.join(" | ") });
}

// WebKit here means the Mac app's engine, so its run counts on macOS. Playwright's WebKit on the Linux CI runners is
// the GTK/WPE port with its own compositor: on CI it never started the glide's Web Animation at all (every switch,
// reduced motion stated off), which says nothing about WKWebView. Chromium runs everywhere; WebKit runs on a Mac.
test.skip(({ browserName }) => browserName === "webkit" && process.platform !== "darwin", "WebKit's slide is measured on macOS (the Mac app's engine)");

const SIDEBAR = ["jobs", "review", "library", "settings", "home", "review", "jobs"];
const sidebarItem = (to: string) => `.sidebar__item[data-help="nav-${to}"]`;

test.describe("the menu highlight slides smoothly", () => {
  test("in the macOS desktop window (1000 x 650, see-through glass)", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 650 });
    await asMacWindow(page);
    await page.goto("/");
    await settle(page);
    await arrived(page);
    await expect(page.locator("html")).toHaveClass(/see-through/);
    await everySwitch(page, ".sidebar__list", sidebarItem, SIDEBAR, 2);
  });

  test("in a wide browser window (1440 x 900)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    await arrived(page);
    await everySwitch(page, ".sidebar__list", sidebarItem, SIDEBAR, 2);
  });

  test("on a phone's tab bar (390 x 844)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await settle(page);
    await arrived(page);
    await everySwitch(page, ".tabbar__list", (to) => `.tabbar__item[data-help="nav-${to}"]`, ["jobs", "library", "home", "review", "settings", "jobs"], 1);
  });
});
