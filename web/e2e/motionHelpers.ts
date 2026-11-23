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

/**
 * Holds the page's own clock still, so a motion's phase (play, fail, rewind) cannot end by itself while the test looks
 * at it; `page.clock.runFor(ms)` then moves the page's time on by exactly `ms`, firing the motion's end timer when it
 * is due. A phase ends on a setTimeout on the page's main thread (lib/motion.ts useAction), and on a busy CI runner
 * (several browsers on a few CPUs) that timer, React's commit and Playwright's polls can each run hundreds of ms
 * late, so a wall-clock limit such as "idle within ACT_MS + 200" measures the machine rather than the app. On the
 * page's clock the same check is exact and the machine's speed cannot change its answer.
 *
 * The page needs `page.clock.install()` before it loads. While the clock is held the page's timers,
 * requestAnimationFrame callbacks, Date and performance.now stand still (so do the mock API's answers, which wait on
 * timers; CSS animations still run), so hold it just before the tap and `page.clock.resume()` after the check. Taps on
 * a held page come from `tapHeld` or Playwright's own actions: tapAct waits on a page timer.
 */
export async function holdClock(page: Page): Promise<void> {
  // pauseAt takes a time on the page's clock that is still ahead of it when the call lands, and a slow round trip
  // can overtake a short lead ("Cannot fast-forward to the past"), so read the clock again and try again.
  for (let attempt = 1; ; attempt++) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 100);
      return;
    } catch (e) {
      if (attempt >= 5 || !String(e).includes("past")) throw e;
    }
  }
}

/**
 * Taps an `act` button from inside the page (so nothing in front of it can take the tap), for a page whose clock is
 * held (holdClock), and returns the handler's `data-fired` mark (set synchronously by the gallery) read straight after
 * the click. The wrapper's phase is then checked with a normal assertion: on a held clock it cannot end meanwhile.
 */
export async function tapHeld(button: Locator): Promise<string | null> {
  return button.evaluate((el: HTMLElement) => {
    el.click();
    return el.dataset.fired ?? null;
  });
}

/**
 * Starts watching inside `root` for an element matching `selector` (and containing `hasText`, when given) before the
 * action that brings it (a Playwright click, a picked file, an Undo). Returns a check that says whether it has shown
 * since, for `expect.poll(check).toBe(true)`: the answer stays true once it has shown, so the poll's own timeout (from
 * when the check starts) is the only limit. A short phase (a 320 ms shake, a 360 ms rewind or return, a 760 ms flight)
 * can come and go between two polls of a polling assertion on a busy machine; a MutationObserver armed first cannot
 * miss it. Throws when the selector already matches before the action, so a leftover phase cannot pass for a new one.
 */
export async function watchFor(root: Locator, selector: string, { hasText }: { hasText?: string } = {}): Promise<() => Promise<boolean>> {
  const id = await root.evaluate(
    (el: Element, [sel, text]: [string, string | null]) => {
      const w = window as unknown as { __cfSeen?: Record<string, boolean>; __cfSeenN?: number };
      // Like Playwright's hasText: a substring, any case, spaces folded.
      const fold = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
      const want = text === null ? null : fold(text);
      const hit = () => Array.from(el.querySelectorAll(sel)).some((m) => want === null || fold(m.textContent ?? "").includes(want));
      if (hit()) return null;
      const key = String((w.__cfSeenN = (w.__cfSeenN ?? 0) + 1));
      const seen = (w.__cfSeen ??= {});
      seen[key] = false;
      const obs = new MutationObserver(() => {
        if (!hit()) return;
        seen[key] = true;
        obs.disconnect();
      });
      obs.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      return key;
    },
    [selector, hasText ?? null] as [string, string | null],
  );
  if (id === null) throw new Error(`watchFor: "${selector}" already shows before the action`);
  return () => root.page().evaluate((key) => (window as unknown as { __cfSeen: Record<string, boolean> }).__cfSeen[key] === true, id);
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

/**
 * Taps an `act` button from inside the page and waits there until its `.act` wrapper shows `phase` (for example
 * "is-fail"). True as soon as it shows, false after `timeout`. A short phase can come and go between two polls of a
 * polling assertion on a busy machine; a MutationObserver cannot miss it.
 */
export async function tapUntilPhase(button: Locator, phase: string, timeout = 5000): Promise<boolean> {
  return button.evaluate(
    (el: HTMLElement, [want, ms]: [string, number]) =>
      new Promise<boolean>((done) => {
        const hit = () => el.querySelector(".act")?.classList.contains(want) ?? false;
        const finish = (ok: boolean) => {
          obs.disconnect();
          clearTimeout(timer);
          done(ok);
        };
        const obs = new MutationObserver(() => {
          if (hit()) finish(true);
        });
        obs.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
        const timer = setTimeout(() => finish(false), ms);
        el.click();
        if (hit()) finish(true);
      }),
    [phase, timeout] as [string, number],
  );
}
