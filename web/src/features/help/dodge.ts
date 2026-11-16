// The launcher gets out of the way (docs/CONTRACTS.md §19.8): it hides while the page scrolls down, comes back on
// scroll up or 600 ms after scrolling stops, stays while it has keyboard focus, and lifts above the elements marked
// data-help-dodge (the Review action row, the Home link box, the Best stars, settings switches…) when they would
// overlap. It measures again whenever the page changes (route, new content, an obstacle's size), not only on scroll.
import { useEffect, useState, type RefObject } from "react";
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

/** Hidden while scrolling down, and how many pixels to lift; never hidden while `pinned` (focus or open panel). */
export function useDodge(launcher: RefObject<HTMLElement | null>, pinned: boolean): { hidden: boolean; lift: number } {
  const [hidden, setHidden] = useState(false);
  const [lift, setLift] = useState(0);
  const [blocked, setBlocked] = useState(false);
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
      // Measure where it sits without the lift (the transform is ours).
      const r = el.getBoundingClientRect();
      const current = Number(el.dataset.lift || 0);
      const base = { top: r.top + current, bottom: r.bottom + current, left: r.left, right: r.right };
      const obstacles = Array.from(document.querySelectorAll<HTMLElement>("[data-help-dodge]"))
        .map((o) => o.getBoundingClientRect())
        .filter((o) => o.width > 0 && o.bottom > 0 && o.top < window.innerHeight);
      const next = liftFor(base, obstacles, window.innerHeight * 0.4);
      setBlocked(next === null);
      setLift(next ?? 0);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    // Content that loads later (the Review card after its data) and obstacles that grow or shrink.
    const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    const watched = new Set<Element>();
    const watch = () => {
      if (!resized) return;
      for (const o of Array.from(document.querySelectorAll("[data-help-dodge]"))) {
        if (watched.has(o)) continue;
        watched.add(o);
        resized.observe(o);
      }
      for (const o of Array.from(watched)) {
        if (o.isConnected) continue;
        watched.delete(o);
        resized.unobserve(o);
      }
    };
    const changed = typeof MutationObserver !== "undefined" ? new MutationObserver(() => {
      watch();
      schedule();
    }) : null;
    changed?.observe(document.body, { childList: true, subtree: true });
    // The launcher itself moves without new content: the update bar's class and height on <html>, entrances ending.
    const moved = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    moved?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
    watch();
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
      moved?.disconnect();
      resized?.disconnect();
      window.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("animationend", schedule, true);
    };
  }, [launcher, page]);

  return { hidden: !pinned && (hidden || blocked), lift: pinned ? 0 : lift };
}
