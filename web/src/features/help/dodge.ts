// The launcher gets out of the way (docs/CONTRACTS.md §19.8): it hides while the page scrolls down, comes back on
// scroll up or 600 ms after scrolling stops, stays while it has keyboard focus, and never sits on a control: it lifts
// to the first free spot above every link, button, field or focusable thing it would overlap (and the blocks marked
// data-help-dodge), or steps aside when there is none within reach. It measures its resting box (no transforms), so
// font metrics, slow machines and transitions do not matter, and measures again whenever the page changes.
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useRoute } from "../../lib/router.ts";

export const DODGE_THRESHOLD = 8;
export const DODGE_SETTLE_MS = 600;
export const DODGE_GAP = 12;

export interface ScrollState {
  /** Where the last direction change was decided. */
  anchor: number;
  hidden: boolean;
}

/** One scroll position: more than 8 px down hides, more than 8 px up shows. Small moves change nothing. */
export function nextScroll(state: ScrollState, y: number): ScrollState {
  if (y - state.anchor > DODGE_THRESHOLD) return { anchor: y, hidden: y > 0 };
  if (state.anchor - y > DODGE_THRESHOLD) return { anchor: y, hidden: false };
  if (y <= 0) return { anchor: 0, hidden: false };
  return state;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far to lift the launcher (`base`, where it sits unlifted) so it clears every obstacle it overlaps, keeping a
 * 12 px gap. Lifting is capped at `max`; beyond that the launcher should hide instead (returns null).
 */
export function liftFor(base: Box, obstacles: readonly Box[], max: number): number | null {
  // Lifting over one obstacle can land the launcher on the next one up, so repeat until nothing overlaps.
  let lift = 0;
  for (let round = 0; round <= obstacles.length; round++) {
    let next = lift;
    for (const o of obstacles) {
      const across = o.left < base.right && o.right > base.left;
      const down = o.top < base.bottom - lift + DODGE_GAP && o.bottom > base.top - lift - DODGE_GAP;
      if (across && down) next = Math.max(next, base.bottom - o.top + DODGE_GAP);
    }
    if (next === lift) break;
    lift = next;
    if (lift > max) return null;
  }
  return lift > max ? null : lift;
}

/** What counts as a control the launcher must never sit on (a link, a button, a field, anything focusable). */
export const CONTROLS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
/** Fixed chrome the launcher is already placed clear of by CSS (and its own panel and spotlight). */
const CHROME = ".help-launcher, .help-panel, .help-ring, .update-bar, .tabbar, .sidebar";

/**
 * Every control on screen the launcher could cover, as boxes. A control that holds other controls (a card that is a
 * link with a star inside) counts through the ones inside; elements marked data-help-dodge (a row of choices, the
 * Review action row) count as one block. Pure DOM reading, so it works for any page without marking it up.
 */
export function controlBoxes(doc: Document = document, viewportHeight = window.innerHeight): Box[] {
  const out: Box[] = [];
  const seen = new Set<Element>();
  const add = (el: Element) => {
    if (seen.has(el) || el.closest(CHROME)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= viewportHeight) return;
    if (el.closest("[inert], [hidden]")) return;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.pointerEvents === "none") return;
    out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  };
  for (const el of Array.from(doc.querySelectorAll("[data-help-dodge]"))) add(el);
  for (const el of Array.from(doc.querySelectorAll(CONTROLS))) {
    if (el.querySelector(CONTROLS)) continue;
    add(el);
  }
  return out;
}

/**
 * Where the launcher sits before any lift or hiding: its layout box, which no transform, translate or scale (the
 * lift, the step-aside slide, the press) changes, so a measure in the middle of a transition is still right.
 */
export function restingBox(el: HTMLElement): Box {
  // offsetTop/offsetLeft of a position: fixed element are relative to the viewport and ignore transforms.
  return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth };
}

/** Why the launcher is out of the way right now: the page is scrolling down, or no free spot is within reach. */
export type DodgeReason = "scroll" | "blocked" | null;

/**
 * Hidden while scrolling down, and how many pixels to lift; never hidden while `pinned` (focus or open panel). With
 * `home` (the panel is open) it goes back to its resting spot under the panel. Focus alone does not move it: a press
 * focuses it before the release, and moving then would carry it away from the finger.
 */
export function useDodge(
  launcher: RefObject<HTMLElement | null>,
  pinned: boolean,
  home = pinned,
): { hidden: boolean; lift: number; reason: DodgeReason; moving: boolean } {
  const [hidden, setHidden] = useState(false);
  const [lift, setLift] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [moving, setMoving] = useState(false);
  const route = useRoute();
  const page = `${route.name}:${window.location.pathname}${window.location.search}`;

  useEffect(() => {
    let state: ScrollState = { anchor: window.scrollY, hidden: false };
    let settle: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = launcher.current;
      if (!el) return;
      const next = liftFor(restingBox(el), controlBoxes(), window.innerHeight * 0.4);
      setBlocked(next === null);
      // Whole pixels, so sub-pixel layout noise does not keep nudging it.
      setLift(next === null ? 0 : Math.ceil(next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    // Content that loads later (the Review card after its data), controls that grow or shrink, the window itself.
    const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    resized?.observe(document.documentElement);
    if (launcher.current) resized?.observe(launcher.current);
    const changed = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    changed?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-expanded"] });
    // The launcher itself moves without new content: the update bar's class and height on <html>, entrances ending.
    changed?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
    document.fonts?.addEventListener?.("loadingdone", schedule);
    const onScroll = () => {
      state = nextScroll(state, window.scrollY);
      setHidden(state.hidden);
      clearTimeout(settle);
      settle = setTimeout(() => {
        state = { anchor: window.scrollY, hidden: false };
        setHidden(false);
      }, DODGE_SETTLE_MS);
      schedule();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    raf = requestAnimationFrame(measure);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearTimeout(settle);
      cancelAnimationFrame(raf);
      changed?.disconnect();
      resized?.disconnect();
      window.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("animationend", schedule, true);
      document.fonts?.removeEventListener?.("loadingdone", schedule);
    };
  }, [launcher, page]);

  const shownLift = home ? 0 : lift;
  // While it slides to a new spot it passes over the page, so it takes no taps until it has arrived: a tap meant for
  // a control it is sliding across reaches that control. Watched frame by frame, so reduced motion (no slide) and
  // slow machines are both right.
  useLayoutEffect(() => {
    const el = launcher.current;
    if (!el) return;
    setMoving(true);
    let raf = requestAnimationFrame(function check() {
      const sliding = el.getAnimations().some((a) => a.playState === "running" && (a as CSSTransition).transitionProperty === "transform");
      if (sliding) raf = requestAnimationFrame(check);
      else setMoving(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [launcher, shownLift]);

  const reason: DodgeReason = pinned ? null : hidden ? "scroll" : blocked ? "blocked" : null;
  return { hidden: reason !== null, lift: shownLift, reason, moving };
}
