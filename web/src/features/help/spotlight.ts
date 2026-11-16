// "Takes you there and lights up the button" (docs/CONTRACTS.md §19.8): waits for a [data-help~="id"] element,
// scrolls it to the middle, draws a sage ring with a soft tomato glow that fades over 2.4 s, and says where it is.
// It never moves the focus. With reduced motion the scroll jumps and the ring stays still.

export const SPOT_WAIT_MS = 4000;
export const SPOT_SHOW_MS = 2400;

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
}

/**
 * Spotlights the first of `ids` to appear within `waitMs`. Resolves with the element that got the ring (or null when none showed up)
 * and returns a stop function through `onStop` so a new spotlight can end the last one.
 */
let stopLast: (() => void) | null = null;

export async function spotlight(ids: readonly string[], { reduced, waitMs = SPOT_WAIT_MS, showMs = SPOT_SHOW_MS }: SpotlightOptions): Promise<HTMLElement | null> {
  stopLast?.();
  if (!ids.length) return null;
  const until = Date.now() + waitMs;
  let target = findTarget(ids);
  while (!target && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    target = findTarget(ids);
  }
  if (!target) return null;
  const spot = target;
  const el = ringTarget(spot);
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  if (el === spot) el.scrollIntoView?.({ block: "center", behavior });
  else window.scrollTo?.({ top: Math.max(0, window.scrollY + el.getBoundingClientRect().top - TALL_TOP), behavior });

  const ring = document.createElement("div");
  ring.className = `help-ring${reduced ? " is-static" : ""}`;
  ring.setAttribute("aria-hidden", "true");
  document.body.appendChild(ring);
  spot.setAttribute("data-help-spotlit", "");
  let raf = 0;
  const place = () => {
    const r = el.getBoundingClientRect();
    ring.style.transform = `translate(${Math.round(r.left - 6)}px, ${Math.round(r.top - 6)}px)`;
    ring.style.width = `${Math.round(r.width + 12)}px`;
    ring.style.height = `${Math.round(r.height + 12)}px`;
    raf = requestAnimationFrame(place);
  };
  place();
  announcer().textContent = `Here it is: ${nameOf(spot)}`;

  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    ring.remove();
    spot.removeAttribute("data-help-spotlit");
    if (stopLast === stop) stopLast = null;
  };
  const timer = setTimeout(stop, showMs);
  stopLast = stop;
  return el;
}
