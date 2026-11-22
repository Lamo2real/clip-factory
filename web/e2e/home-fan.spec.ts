import { expect, test, type Page } from "@playwright/test";
import { settle, stillBackdrop } from "./helpers.ts";

// Home's fanned covers spring open under the pointer in every engine (owner, 2026-11-22: "when i try to hover over
// these three images in windows desktop app its to laggy and not smooth like it is on mac"). The Windows app is
// Chromium (WebView2): there the deal-in animation, filled `both`, kept hold of transform after it ended, so the hover
// started no transition and the covers jumped in one frame; and while the finished deal stayed on the cover, the
// spring ran on the main thread instead of the compositor. The Mac app (WebKit) springs either way.

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await stillBackdrop(page);
  // The covers sit beside the form from 1100 px of window.
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** Opens Home and waits until every cover is dealt (its entrance animation ended and was dropped). */
async function dealtHome(page: Page) {
  await page.goto("/");
  await settle(page);
  const items = page.locator(".cover-stack__item");
  await expect(items).toHaveCount(3);
  await expect(page.locator(".cover-stack__item[data-dealt]")).toHaveCount(3, { timeout: 5000 });
  return items;
}

/** The pointer somewhere on Home that is not the covers. */
async function pointerAway(page: Page) {
  const title = await page.locator(".hero__title").boundingBox();
  await page.mouse.move(title!.x + 10, title!.y + title!.height / 2);
}

/** The last cover's turn in degrees (7 resting, 10 fanned). */
const turn = (page: Page) =>
  page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelectorAll(".cover-stack__item")[2]!).transform);
    return (Math.atan2(m.b, m.a) * 180) / Math.PI;
  });

async function hover(page: Page) {
  const stack = await page.locator(".cover-stack").boundingBox();
  await page.mouse.move(stack!.x + stack!.width / 2, stack!.y + stack!.height / 2);
}

test("the covers spring open on hover instead of jumping, and the finished deal is dropped", async ({ page }) => {
  const items = await dealtHome(page);
  // No deal is left on a cover once it is dealt: a finished animation of transform keeps the spring off Chromium's
  // compositor.
  const deals = await items.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).filter((a) => (a as CSSAnimation).animationName === "deal").length);
  expect(deals).toBe(0);
  await expect(items.first()).toHaveCSS("will-change", "transform");

  await pointerAway(page);
  await page.waitForTimeout(200);
  expect(await turn(page)).toBeCloseTo(7, 1);
  await hover(page);
  // The hover starts a real transition (a jump starts none), and a quarter of the way in the cover is somewhere
  // between resting and fanned. Holding the transition there keeps this true however slow the machine draws.
  const quarter = await page.evaluate(() => {
    const el = document.querySelectorAll(".cover-stack__item")[2]!;
    return new Promise<{ duration: number; deg: number } | null>((done) => {
      const t0 = performance.now();
      const look = () => {
        const spring = el.getAnimations().find((a) => a instanceof CSSTransition && a.transitionProperty === "transform");
        if (spring) {
          spring.pause();
          spring.currentTime = 130;
          const m = new DOMMatrix(getComputedStyle(el).transform);
          const deg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
          spring.play();
          done({ duration: Number(spring.effect?.getComputedTiming().duration), deg });
        } else if (performance.now() - t0 > 2000) done(null);
        else requestAnimationFrame(look);
      };
      look();
    });
  });
  expect(quarter, "a transition runs on the cover").not.toBeNull();
  expect(quarter!.duration).toBeGreaterThan(300);
  expect(quarter!.deg).toBeGreaterThan(7.2);
  expect(Math.abs(quarter!.deg - 10)).toBeGreaterThan(0.05);
  // It ends fanned wider than it rests.
  await expect.poll(() => turn(page), { timeout: 3000 }).toBeCloseTo(10, 1);
});

test("Chromium runs the hover's spring on the compositor", async ({ page, browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium's trace says whether an animation could be composited");
  await dealtHome(page);
  await pointerAway(page);
  await page.waitForTimeout(200);
  await browser.startTracing(page, { categories: ["blink.animations", "devtools.timeline"] });
  await hover(page);
  await page.waitForTimeout(700);
  await pointerAway(page);
  await page.waitForTimeout(700);
  const events = (JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; ph: string; args?: { data?: Record<string, unknown> } }[] }).traceEvents.filter((e) => e.name === "Animation");
  // The trace saw the covers' transitions start (so a clean result below means something) ...
  const started = events.filter((e) => e.ph === "b" && String(e.args?.data?.nodeName).includes("cover-stack__item") && e.args?.data?.displayName === "transform");
  expect(started.length).toBeGreaterThanOrEqual(2);
  // ... and none of them fell back to the main thread (64 was "the target has incompatible animations": the old deal).
  const failed = events.filter((e) => e.ph === "n" && e.args?.data?.compositeFailed !== undefined).map((e) => e.args!.data!.compositeFailed);
  expect(failed).toEqual([]);
});

test("with reduced motion the covers still deal in and fan out at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const items = await dealtHome(page);
  await expect(items.nth(2)).toHaveCSS("opacity", "1");
  await expect(items.nth(2)).toHaveCSS("transition-duration", "0.001s");
  await pointerAway(page);
  await page.waitForTimeout(200);
  expect(await turn(page)).toBeCloseTo(7, 1);
  await hover(page);
  // Read after two drawn frames: an engine starts a transition on the frame after the hover and its clock moves only
  // when it draws, so even a 1 ms one shows its first pose until then. Linux WebKit in CI draws without a GPU and can
  // take over a second a frame here.
  const afterTwoFrames = () =>
    page.evaluate(
      () =>
        new Promise<number>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const m = new DOMMatrix(getComputedStyle(document.querySelectorAll(".cover-stack__item")[2]!).transform);
              done((Math.atan2(m.b, m.a) * 180) / Math.PI);
            }),
          ),
        ),
    );
  await expect.poll(afterTwoFrames, { timeout: 5000 }).toBeCloseTo(10, 1);
});
