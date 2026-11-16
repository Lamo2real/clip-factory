// The action motion harness (docs/CONTRACTS.md §20.10): CORE's gallery checks use it, and each APPLY builder reuses
// it for its own screens in motion.spec.ts.
import type { Locator, Page } from "@playwright/test";

/** The six widths the motion overflow check runs at. */
export const MOTION_WIDTHS = [320, 375, 430, 768, 1440, 1920] as const;

/** The motion gallery (mock mode only). */
export const GALLERY = "/__motion";

/**
 * Taps an `act` button from inside the page (so nothing in front of it can take the tap) and reports whether the
 * handler had fired (`data-fired`, set synchronously by the gallery) and the wrapper's classes once React has
 * rendered the tap (a microtask later, long before the shortest motion ends).
 */
export async function tapAct(button: Locator): Promise<{ fired: string | null; cls: string }> {
  return button.evaluate(async (el: HTMLElement) => {
    el.click();
    const fired = el.dataset.fired ?? null;
    await new Promise((r) => setTimeout(r, 0));
    return { fired, cls: el.querySelector(".act")?.className ?? "" };
  });
}

/** Pauses every running action motion (and the stepper's number bump) at `fraction` of its duration. */
export async function pauseActs(page: Page, fraction: number): Promise<number> {
  return page.evaluate((f) => {
    let n = 0;
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect | null)?.target;
      if (!(target instanceof Element) || !target.closest(".act, .stepper__num, .is-returning")) continue;
      const timing = a.effect!.getComputedTiming();
      const total = Number(timing.endTime ?? 0);
      a.pause();
      a.currentTime = total * f;
      n++;
    }
    return n;
  }, fraction);
}

/** Every `.act__item`'s computed transform (for the reduced-motion "no movement" rule). */
export async function actTransforms(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".act__item"), (el) => getComputedStyle(el).transform));
}

/** Widths of every `[data-act]` button, keyed by its kind and position. */
export async function actWidths(page: Page): Promise<Record<string, number>> {
  // Keyed by the element itself (a tag given on first sight), not its place in the page: a card that leaves or an
  // Undo toast that arrives mid-animation must not make one button's width be compared with another's.
  return page.evaluate(() => {
    const w = window as unknown as { __cfActKey?: number };
    return Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>("[data-act]"), (el) => {
        el.dataset.actKey ??= String((w.__cfActKey = (w.__cfActKey ?? 0) + 1));
        return [`${el.dataset.act}#${el.dataset.actKey}`, el.offsetWidth];
      }),
    );
  });
}

/** True when the page does not scroll sideways. */
export async function noSideScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

/** Reads the sound log's kinds (§15 test hook). */
export async function soundKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind));
}

/**
 * Taps an `act` button from inside the page and records every class its `.act` wrapper takes for `ms` (the wrapper
 * may be swapped for a spinner and back while a request runs). For motions that start after an await, or phases too
 * short to catch with a polling assertion.
 */
export async function recordAct(button: Locator, ms: number): Promise<string[]> {
  return button.evaluate(async (el: HTMLElement, wait: number) => {
    const seen: string[] = [];
    const note = () => {
      const cls = el.querySelector(".act")?.className;
      if (cls && seen[seen.length - 1] !== cls) seen.push(cls);
    };
    const obs = new MutationObserver(note);
    obs.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    el.click();
    note();
    await new Promise((r) => setTimeout(r, wait));
    obs.disconnect();
    return seen;
  }, ms);
}
