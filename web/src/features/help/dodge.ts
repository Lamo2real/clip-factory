// The launcher keeps one home spot and stays calm (docs/CONTRACTS.md §19.8): on phones above the tab bar at the right,
// on wide screens bottom right (above the update bar). It never moves and never hides while the page scrolls. Once
// scrolling has settled (no scroll event for DODGE_SETTLE_MS, so a fling, momentum or an iOS rubber-band is one
// scroll), it looks at its spot: if it would rest on a control (a link, button, field, anything focusable, or a part
// of a block marked data-help-dodge), it glides up a little to the nearest clear spot within DODGE_NUDGE_MAX of home,
// or, when there is none that close, fades out where it is; the next settle that finds home clear brings it back
// there. Nothing changes in the middle of a scroll (or a window resize), so small scrolls, momentum and bounces cannot
// make it flicker or jump. With keyboard focus on it, it stays as it is; with its panel open it is home and shown. It
// measures its resting box (no transforms), so fonts, slow machines and transitions do not matter, and measures again
// on the next frame whenever the page changes under it while it is still (content loading in, the update bar).
import { useEffect, useRef, useState, type RefObject } from "react";
import { useRoute } from "../../lib/router.ts";

/** How long the page must be still before the launcher looks at its spot again. */
export const DODGE_SETTLE_MS = 260;
/** The room it keeps around a control: closer than this counts as on it. */
export const DODGE_GAP = 8;
/** The most it ever moves up from home to clear a control; past that it fades out at home instead. */
export const DODGE_NUDGE_MAX = 96;

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** True when the launcher at `base` would rest on (or within `gap` px of) any of the controls. */
export function covers(base: Box, controls: readonly Box[], gap = DODGE_GAP): boolean {
  return controls.some((o) => o.left < base.right + gap && o.right > base.left - gap && o.top < base.bottom + gap && o.bottom > base.top - gap);
}

/**
 * How far up from `base` the launcher has to go to clear every control (keeping the gap), or null when that is more
 * than `max`: then it fades out at home instead. 0 when home is clear.
 */
export function nudgeFor(base: Box, controls: readonly Box[], max = DODGE_NUDGE_MAX, gap = DODGE_GAP): number | null {
  // Clearing one control can land it on the next one up, so repeat until nothing is under it.
  let lift = 0;
  for (let round = 0; round <= controls.length; round++) {
    const at = { ...base, top: base.top - lift, bottom: base.bottom - lift };
    const on = controls.filter((o) => covers(at, [o], gap));
    if (!on.length) return lift;
    lift = Math.max(...on.map((o) => base.bottom - o.top + gap));
    if (lift > max) return null;
  }
  return null;
}

/** What counts as a control the launcher must never sit on (a link, a button, a field, anything focusable). */
export const CONTROLS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
/**
 * Fixed chrome the launcher is already placed clear of by CSS (and its own panel and spotlight). Of the setup list
 * (§17.13) only the glass bar behind its pill and the open panel's scrim are chrome (the page is inert under the
 * scrim); the list's own buttons are controls like any other, so the launcher can never come to rest on one.
 */
const CHROME = ".help-launcher, .help-panel, .help-ring, .update-bar, .tabbar, .sidebar, .setup-todo-bar, .setup-todo-scrim";

/** True for an `overflow-x` / `overflow-y` value that cuts off what runs past the box. */
const cuts = (overflow: string) => overflow !== "" && overflow !== "visible";

/**
 * What shows of a box: the part inside every ancestor that cuts off its content (a scroller, a clamped line, a card
 * with hidden overflow). A tab scrolled out of its row, a strip that runs on under another panel or the third line of
 * a two-line clamp is not on screen there, so the launcher has nothing to keep clear of. `own` also lets the element
 * itself cut (for words: the element they are in may clamp them). Null when nothing of the box shows.
 */
export function shownBox(el: Element, rect: Box, own = false): Box | null {
  const box: Box = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  const view = el.ownerDocument.defaultView;
  if (!view) return box;
  // Inside an absolutely placed box, the ancestors between it and the box it is placed against do not cut it off.
  let placed = false;
  for (let node: Element | null = el; node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement; node = node.parentElement) {
    const s = view.getComputedStyle(node);
    if (placed && s.position !== "static" && s.position !== "") placed = false;
    if (!placed && (own || node !== el) && s.display !== "contents" && (cuts(s.overflowX) || cuts(s.overflowY))) {
      const r = node.getBoundingClientRect();
      if (cuts(s.overflowX)) {
        box.left = Math.max(box.left, r.left);
        box.right = Math.min(box.right, r.right);
      }
      if (cuts(s.overflowY)) {
        box.top = Math.max(box.top, r.top);
        box.bottom = Math.min(box.bottom, r.bottom);
      }
      if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    }
    // A fixed box is laid out against the window: what holds it does not cut it off.
    if (s.position === "fixed") break;
    if (s.position === "absolute") placed = true;
  }
  return box;
}

/**
 * Every control on screen the launcher could cover, as boxes: what shows of each (`shownBox`). A control that holds
 * other controls (a card that is a link with a star inside) counts through the ones inside; elements marked
 * data-help-dodge (a row of choices, the Review action row) count by their parts. Pure DOM reading, so it works for any
 * page without marking it up. With `column` (the launcher's own left and right edge) only controls in that column are
 * returned: the others can never be under it.
 */
export function controlBoxes(doc: Document = document, viewportHeight = window.innerHeight, column?: Pick<Box, "left" | "right">): Box[] {
  const out: Box[] = [];
  const seen = new Set<Element>();
  const add = (el: Element) => {
    if (seen.has(el) || el.closest(CHROME)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= viewportHeight) return;
    if (column && (r.right <= column.left || r.left >= column.right)) return;
    if (el.closest("[inert], [hidden]")) return;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.pointerEvents === "none") return;
    const shown = shownBox(el, r);
    if (shown) out.push(shown);
  };
  // A marked block counts by its parts (each choice, each card, the switch and the button of a row), so the empty
  // end of a row is no obstacle; a marked control, or a block with no parts, counts whole.
  for (const block of Array.from(doc.querySelectorAll("[data-help-dodge]"))) {
    if (block.matches(CONTROLS) || !block.children.length) add(block);
    else for (const part of Array.from(block.children)) add(part);
  }
  for (const el of Array.from(doc.querySelectorAll(CONTROLS))) {
    if (el.querySelector(CONTROLS)) continue;
    add(el);
  }
  return out;
}

/**
 * Where the launcher sits: its layout box, which no transform, translate or scale (the fade, the press) changes,
 * so a measure in the middle of a transition is still right.
 */
export function restingBox(el: HTMLElement): Box {
  // offsetTop/offsetLeft of a position: fixed element are relative to the viewport and ignore transforms.
  return { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth };
}

/** Why the launcher is out of the way right now: its spot is on a control and no clear spot is close. */
export type DodgeReason = "blocked" | null;

/**
 * Where the launcher shows: `lift` px up from home (0 at home), or faded out at home (`hidden`). A scroll only
 * changes this once the page has been still for DODGE_SETTLE_MS, never mid-scroll. While `pinned` (keyboard focus)
 * it stays as it is and shows; with `home` (its panel is open) it is home and shown.
 */
export function useDodge(
  launcher: RefObject<HTMLElement | null>,
  pinned: boolean,
  home = false,
): { hidden: boolean; lift: number; reason: DodgeReason } {
  const [spot, setSpot] = useState<{ lift: number; blocked: boolean }>({ lift: 0, blocked: false });
  const route = useRoute();
  const page = `${route.name}:${window.location.pathname}${window.location.search}`;
  const frozen = useRef(pinned);
  frozen.current = pinned;
  const look = useRef<() => void>(() => undefined);

  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let scrolling = false;
    const measure = () => {
      raf = 0;
      const el = launcher.current;
      if (!el || scrolling || frozen.current) return;
      const base = restingBox(el);
      const lift = nudgeFor(base, controlBoxes(document, window.innerHeight, { left: base.left - DODGE_GAP, right: base.right + DODGE_GAP }));
      // Whole pixels, so sub-pixel layout noise never nudges it.
      const next = lift === null ? { lift: 0, blocked: true } : { lift: Math.ceil(lift), blocked: false };
      setSpot((was) => (was.lift === next.lift && was.blocked === next.blocked ? was : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    look.current = schedule;
    // A scroll changes nothing until it has settled; then the launcher looks at its spot once.
    const onScroll = () => {
      scrolling = true;
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        scrolling = false;
        schedule();
      }, DODGE_SETTLE_MS);
    };
    // Content that loads later (the Review card after its data), controls that grow or shrink, the window itself.
    const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    resized?.observe(document.documentElement);
    if (launcher.current) resized?.observe(launcher.current);
    const changed = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    changed?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-expanded"] });
    // The launcher's spot moves without new content: the update bar's class and height on <html>.
    changed?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
    document.fonts?.addEventListener?.("loadingdone", schedule);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // A page that opens is still: look at once.
    raf = requestAnimationFrame(measure);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearTimeout(quiet);
      cancelAnimationFrame(raf);
      changed?.disconnect();
      resized?.disconnect();
      window.removeEventListener("transitionend", schedule, true);
      window.removeEventListener("animationend", schedule, true);
      document.fonts?.removeEventListener?.("loadingdone", schedule);
    };
  }, [launcher, page]);

  // Focus leaving it, or its panel closing: look at the spot again.
  useEffect(() => {
    if (!pinned) look.current();
  }, [pinned]);

  if (home) return { hidden: false, lift: 0, reason: null };
  const reason: DodgeReason = !pinned && spot.blocked ? "blocked" : null;
  return { hidden: reason !== null, lift: spot.lift, reason };
}
