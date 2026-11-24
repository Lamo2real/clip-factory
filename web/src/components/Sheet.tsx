import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Everything Tab can land on inside a dialog. */
const FOCUSABLE =
  "button:not([disabled]), a[href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), video[controls], summary, [tabindex]:not([tabindex='-1'])";

/**
 * Keeps Tab and Shift+Tab inside `box` (a modal dialog): from the last control Tab goes to the first, and back.
 * Focus that sits on the dialog itself (or anywhere outside it) moves to the first or last control.
 */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault(): void }, box: HTMLElement | null): void {
  if (e.key !== "Tab" || !box) return;
  const all = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
  if (!all.length) {
    e.preventDefault();
    return;
  }
  const first = all[0]!;
  const last = all[all.length - 1]!;
  const at = document.activeElement;
  const inside = at instanceof Node && box.contains(at) && at !== box;
  if (e.shiftKey && (at === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/** How long after a tap that closed a sheet its double-click's second click can still come, and how far from it. */
const SECOND_CLICK_MS = 500;
const SECOND_CLICK_PX = 40;

/**
 * A sheet closed by a tap is gone at once, so the second click of a double-click (a double tap) would land on what
 * was under it: another job's row, the next page. That one click, near the first and soon after it, is swallowed.
 * Typing in between (a key, a paste) means the next tap is a new choice, not a double tap's second half: it goes
 * through (Use the newest, a quick change to the words, then Save changes where the sheet's button was).
 */
export function swallowSecondClick(tap: { x: number; y: number; at: number }): void {
  if (typeof document === "undefined" || performance.now() - tap.at > SECOND_CLICK_MS) return;
  const done = () => {
    document.removeEventListener("click", eat, true);
    document.removeEventListener("keydown", done, true);
    document.removeEventListener("input", done, true);
    clearTimeout(timer);
  };
  const eat = (e: MouseEvent) => {
    done();
    const near = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= SECOND_CLICK_PX;
    if (e.detail === 0 || !near || performance.now() - tap.at > SECOND_CLICK_MS) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener("click", eat, true);
  document.addEventListener("keydown", done, true);
  document.addEventListener("input", done, true);
  const timer = setTimeout(done, SECOND_CLICK_MS);
}

/**
 * A small glass question over the page ("Delete this skill?", "Leave without saving?"). It is a real dialog: focus
 * moves into it and comes back afterwards, Tab stays inside, Escape or a tap outside closes it (as the safe answer).
 * Used where an 8-second Undo cannot help (§18.5, §18.7), or where there is a real choice to make first (Delete job
 * asks whether the clips in Review go too, §34.6). It is drawn on document.body (a portal), so its scrim
 * covers the whole screen even when the page that asks sits inside a glass card or a moving page.
 */
export function Sheet({
  title,
  children,
  actions,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  /** The buttons; the first one gets the focus, so put the safe answer first. */
  actions: ReactNode;
  onClose: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  // The last pointer tap inside the sheet or on its scrim (a keyboard "click" has detail 0 and is not one).
  const tap = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.querySelector<HTMLElement>(".sheet__actions button, .sheet__actions a")?.focus();
    return () => {
      before?.focus({ preventScroll: true });
      if (tap.current) swallowSecondClick(tap.current);
    };
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    trapTab(e, box.current);
  }

  return createPortal(
    <div
      className="sheet-scrim"
      onClickCapture={(e) => {
        tap.current = e.detail > 0 ? { x: e.clientX, y: e.clientY, at: performance.now() } : null;
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        className="sheet glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={children ? `${id}-d` : undefined}
        onKeyDown={keys}
      >
        <h2 className="sheet__title user-text" id={`${id}-t`}>
          {title}
        </h2>
        {children ? (
          <div className="sheet__text" id={`${id}-d`}>
            {children}
          </div>
        ) : null}
        <div className="sheet__actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
