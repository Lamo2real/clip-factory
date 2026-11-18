// The launcher keeps one home spot and stays calm (docs/CONTRACTS.md §19.8): on phones above the tab bar at the right,
// on wide screens bottom right (above the update bar). It never moves: no lift, no slide, nothing sideways. The only
// thing it ever does is fade out in place, and only when it would make a control hard to tap: one it covers by more
// than DODGE_COVER of its area, or one with no part of at least DODGE_TAP px (or its full size, if smaller) left
// free beside it. A big row link or card it rests on the edge of stays easy to tap, so that never hides it.
// It is calm about when, too. Nothing changes while the page scrolls or a finger is on the screen; it fades out
// only once the page has been still for DODGE_SETTLE_MS (so a fling, momentum or an iOS rubber-band is one scroll),
// fades back in only after DODGE_RETURN_MS of stillness, and keeps each state for at least DODGE_HOLD_MS, so short
// reading-pace scrolls cannot make it blink. With keyboard focus on it, it stays shown; with its panel open it is
// shown. It measures its resting box (no transforms), and looks again whenever the page changes under it.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useRoute } from "../../lib/router.ts";

/** How long the page (and the finger) must be still before the launcher may fade out. */
export const DODGE_SETTLE_MS = 260;
/** How long the page must be still before it fades back in: longer, so it does not come back between two flicks. */
export const DODGE_RETURN_MS = 700;
/** The least time it stays in a state (shown or faded) once it has changed. */
export const DODGE_HOLD_MS = 1000;
/** The smallest part of a control, in px each way, that still counts as easy to tap. */
export const DODGE_TAP = 44;
/** Covering more than this share of a control's area makes it hard to tap. */
export const DODGE_COVER = 0.3;

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * True when the launcher at `base` makes `control` hard to tap: it covers more than DODGE_COVER of it, or what is
 * left of it beside the launcher (left, right, above or below) is nowhere DODGE_TAP px (or the control's own size,
 * if smaller) each way. A control it does not touch is never hard to tap.
 */
export function hardToTap(base: Box, control: Box): boolean {
  const w = Math.min(base.right, control.right) - Math.max(base.left, control.left);
  const h = Math.min(base.bottom, control.bottom) - Math.max(base.top, control.top);
  if (w <= 0 || h <= 0) return false;
  const cw = control.right - control.left;
  const ch = control.bottom - control.top;
  if ((w * h) / (cw * ch) > DODGE_COVER) return true;
  const needW = Math.min(DODGE_TAP, cw);
  const needH = Math.min(DODGE_TAP, ch);
  const free = [
    [base.left - control.left, ch],
    [control.right - base.right, ch],
    [cw, base.top - control.top],
    [cw, control.bottom - base.bottom],
  ];
  return !free.some(([fw, fh]) => fw! >= needW && fh! >= needH);
}

/** True when the launcher at `base` would make any of the controls hard to tap (`hardToTap`). */
export function blocks(base: Box, controls: readonly Box[]): boolean {
  return controls.some((c) => hardToTap(base, c));
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

/** Why the launcher is out of the way right now: it would make a control under its spot hard to tap. */
export type DodgeReason = "blocked" | null;

/**
 * Whether the launcher shows at its home spot or is faded out there (`hidden`). It changes only once the page and the
 * finger have been still (DODGE_SETTLE_MS to fade out, DODGE_RETURN_MS to come back) and never sooner than
 * DODGE_HOLD_MS after its last change. While `pinned` (keyboard focus) it shows and stays; with `home` (its panel is
 * open) it shows.
 */
export function useDodge(launcher: RefObject<HTMLElement | null>, pinned: boolean, home = false): { hidden: boolean; reason: DodgeReason } {
  const [blocked, setBlocked] = useState(false);
  const route = useRoute();
  const page = `${route.name}:${window.location.pathname}${window.location.search}`;
  const frozen = useRef(pinned);
  frozen.current = pinned;
  const shown = useRef(!blocked);
  shown.current = !blocked;
  const look = useRef<() => void>(() => undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let touching = false;
    // A page that opens is still and has never changed: it may look, and change, at once.
    let lastMove = -Infinity;
    let lastChange = -Infinity;
    // data-settling on the launcher while it may still change (tests wait for it to go).
    const settling = (on: boolean) => {
      const el = launcher.current;
      if (el) el.toggleAttribute("data-settling", on);
    };
    const later = (ms: number) => {
      clearTimeout(timer);
      settling(true);
      timer = setTimeout(schedule, Math.max(0, ms));
    };
    const check = () => {
      raf = 0;
      const el = launcher.current;
      if (!el) return;
      if (frozen.current) return settling(false);
      if (touching) return settling(true);
      const now = performance.now();
      const still = now - lastMove;
      if (still < DODGE_SETTLE_MS) return later(DODGE_SETTLE_MS - still);
      const base = restingBox(el);
      const want = blocks(base, controlBoxes(document, window.innerHeight, { left: base.left, right: base.right }));
      if (want === !shown.current) return settling(false);
      // Back in only after a longer stillness, and never sooner than the hold after the last change.
      const wait = Math.max(want ? 0 : DODGE_RETURN_MS - still, DODGE_HOLD_MS - (now - lastChange));
      if (wait > 0) return later(wait);
      lastChange = now;
      shown.current = !want;
      settling(false);
      setBlocked(want);
    };
    function schedule() {
      if (!raf) raf = requestAnimationFrame(check);
    }
    look.current = schedule;
    // Movement (a scroll, a resize, a finger) changes nothing; the launcher looks again once it has settled.
    const moved = () => {
      lastMove = performance.now();
      later(DODGE_SETTLE_MS);
    };
    const touchDown = () => {
      touching = true;
      moved();
    };
    const touchUp = (e: TouchEvent) => {
      touching = e.touches.length > 0;
      moved();
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
    window.addEventListener("scroll", moved, { passive: true });
    window.addEventListener("resize", moved);
    window.addEventListener("touchstart", touchDown, { passive: true });
    window.addEventListener("touchmove", moved, { passive: true });
    window.addEventListener("touchend", touchUp, { passive: true });
    window.addEventListener("touchcancel", touchUp, { passive: true });
    raf = requestAnimationFrame(check);
    return () => {
      window.removeEventListener("scroll", moved);
      window.removeEventListener("resize", moved);
      window.removeEventListener("touchstart", touchDown);
      window.removeEventListener("touchmove", moved);
      window.removeEventListener("touchend", touchUp);
      window.removeEventListener("touchcancel", touchUp);
      clearTimeout(timer);
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

  if (home) return { hidden: false, reason: null };
  const reason: DodgeReason = !pinned && blocked ? "blocked" : null;
  return { hidden: reason !== null, reason };
}
