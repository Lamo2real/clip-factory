// "Takes you there and lights up the button" (docs/CONTRACTS.md §19.8): waits for a [data-help~="id"] element,
// scrolls it to the middle, draws a bone ring with a soft vermilion glow that fades over 2.4 s, and says where it is.
// It never moves the focus. With reduced motion the scroll jumps and the ring stays still.
//
// The 2.4 s count from when the control has arrived (on screen and still), not from when the scroll starts: on a slow
// machine the page change and the smooth scroll can take a second or two, and the owner must still see it lit.

export const SPOT_WAIT_MS = 4000;
export const SPOT_SHOW_MS = 2400;
/** The control counts as arrived once it has not moved for this long while on screen. */
export const SPOT_STILL_MS = 150;
/** The longest the ring waits for the control to arrive before its 2.4 s start anyway (a page that never stops moving). */
export const SPOT_ARRIVE_CAP_MS = 4000;
/** The ring's fade-in (help.css: the first 12 % of its 2.4 s), held bright until the control arrives. */
const RING_IN_MS = 288;

const cssEscape = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** The first visible element carrying one of the ids, in the order given. */
export function findTarget(ids: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const id of ids) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-help~="${cssEscape(id)}"]`))) {
      if (!el.closest(".help-panel") && visible(el)) return el;
    }
  }
  return null;
}

/** A short name for the announcement: the element's label, its heading, or its words. */
export function nameOf(el: HTMLElement): string {
  // A settings apple with its own heading carries its real name as a tag ("Click sound"); an account row its name.
  const heading = el.querySelector(".apple__tag") ?? el.querySelector(".account__name, .apple__name, h2, h3");
  const text = el.getAttribute("aria-label") || heading?.textContent || wordsOf(el);
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** The element's words with a space between its parts ("TikTok Not connected", never "TikTokNot connected"). */
function wordsOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true") return "";
  return Array.from(node.childNodes).map(wordsOf).join(" ");
}

/** Taller than this share of the window, only the element's heading gets the ring (a whole sound list is too big). */
export const TALL_SHARE = 0.6;
export const TALL_TOP = 80;

/** What to ring: the element, or its heading when the element is too tall to see at once. */
export function ringTarget(el: HTMLElement, viewHeight = window.innerHeight): HTMLElement {
  if (el.getBoundingClientRect().height <= TALL_SHARE * viewHeight) return el;
  const head = el.querySelector<HTMLElement>(".apple__head, .apple__name, header, h2, h3");
  return head?.closest<HTMLElement>("div, header") ?? head ?? el;
}

function announcer(): HTMLElement {
  let el = document.getElementById("help-announce");
  if (!el) {
    el = document.createElement("div");
    el.id = "help-announce";
    el.className = "sr-only";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export interface SpotlightOptions {
  reduced: boolean;
  waitMs?: number;
  showMs?: number;
  /** Called once the control has arrived (on screen and still), or the wait for that ran out. */
  onArrive?: (el: HTMLElement) => void;
}

/** True when the middle of the box is inside the window. */
export function onScreen(r: DOMRect | { top: number; bottom: number; left: number; right: number }, w = window.innerWidth, h = window.innerHeight): boolean {
  const y = (r.top + r.bottom) / 2;
  const x = (r.left + r.right) / 2;
  return y >= 0 && y <= h && x >= 0 && x <= w;
}

/**
 * Spotlights the first of `ids` to appear within `waitMs`. Resolves with the element that got the ring (or null when none showed up)
 * and returns a stop function through `onStop` so a new spotlight can end the last one.
 */
let stopLast: (() => void) | null = null;

export async function spotlight(ids: readonly string[], { reduced, waitMs = SPOT_WAIT_MS, showMs = SPOT_SHOW_MS, onArrive }: SpotlightOptions): Promise<HTMLElement | null> {
  stopLast?.();
  if (!ids.length) return null;
  const until = Date.now() + waitMs;
  let target = findTarget(ids);
  while (!target && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    // The page can go away while it waits (a test ending, a closing window): then there is nothing to light up.
    if (typeof document === "undefined") return null;
    target = findTarget(ids);
  }
  if (!target) return null;
  const spot = target;
  const el = ringTarget(spot);
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  // Whether this scroll will move the page at all: then the control has not arrived before the page has scrolled (a
  // slow machine can start a smooth scroll a few hundred ms late, and the control sits still until then).
  const r0 = el.getBoundingClientRect();
  const want = el === spot ? window.scrollY + r0.top + r0.height / 2 - window.innerHeight / 2 : window.scrollY + r0.top - TALL_TOP;
  const room = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  let waitScroll = Math.abs(Math.min(room, Math.max(0, want)) - window.scrollY) > 2;
  const scrolled = () => {
    waitScroll = false;
  };
  addEventListener("scroll", scrolled, { capture: true, passive: true });
  if (el === spot) el.scrollIntoView?.({ block: "center", behavior });
  else window.scrollTo?.({ top: Math.max(0, window.scrollY + r0.top - TALL_TOP), behavior });

  const ring = document.createElement("div");
  ring.className = `help-ring ${reduced ? "is-static" : "is-coming"}`;
  ring.setAttribute("aria-hidden", "true");
  document.body.appendChild(ring);
  spot.setAttribute("data-help-spotlit", "");
  let raf = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Arrival: the ring's box on screen and unmoved for SPOT_STILL_MS (timed by the clock, since a slow machine draws
  // few frames), or SPOT_ARRIVE_CAP_MS gone by. Only then does the ring's own time start.
  let lastTop = Number.NaN;
  let lastLeft = Number.NaN;
  let stillSince = Date.now();
  let arrived = false;
  const arrive = () => {
    if (arrived || done) return;
    arrived = true;
    // The visible fade (help.css) starts now too, from where the fade-in ended, so it is never spent before arrival.
    ring.classList.remove("is-coming");
    ring.style.animationDelay = `-${RING_IN_MS}ms`;
    removeEventListener("scroll", scrolled, { capture: true });
    clearTimeout(cap);
    timer = setTimeout(stop, showMs);
    onArrive?.(el);
  };
  const place = () => {
    const r = el.getBoundingClientRect();
    ring.style.transform = `translate(${Math.round(r.left - 6)}px, ${Math.round(r.top - 6)}px)`;
    ring.style.width = `${Math.round(r.width + 12)}px`;
    ring.style.height = `${Math.round(r.height + 12)}px`;
    if (!arrived) {
      const now = Date.now();
      if (waitScroll || r.top !== lastTop || r.left !== lastLeft) {
        lastTop = r.top;
        lastLeft = r.left;
        stillSince = now;
      } else if (now - stillSince >= SPOT_STILL_MS && onScreen(r)) arrive();
    }
    raf = requestAnimationFrame(place);
  };
  const cap = setTimeout(arrive, SPOT_ARRIVE_CAP_MS);
  place();
  announcer().textContent = `Here it is: ${nameOf(spot)}`;

  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    clearTimeout(cap);
    removeEventListener("scroll", scrolled, { capture: true });
    ring.remove();
    spot.removeAttribute("data-help-spotlit");
    if (stopLast === stop) stopLast = null;
  };
  stopLast = stop;
  return el;
}
