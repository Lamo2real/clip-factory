import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A small glass question over the page ("Delete this skill?", "Leave without saving?"). It is a real dialog: focus
 * moves into it and comes back afterwards, Tab stays inside, Escape or a tap outside closes it (as the safe answer).
 * Used only where an 8-second Undo cannot help (§18.5, §18.7).
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

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.querySelector<HTMLElement>(".sheet__actions button, .sheet__actions a")?.focus();
    return () => before?.focus({ preventScroll: true });
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const all = Array.from(box.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])"));
    if (!all.length) return;
    const first = all[0]!;
    const last = all[all.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="sheet-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
    </div>
  );
}
