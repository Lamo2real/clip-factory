// "Leave without saving?" for Clips Funded's editors (docs/CONTRACTS.md §18.7): a box with unsaved typing or picks holds
// every page change (an in-app link, a tab, Back) and asks first, with Keep editing and Leave (and, on Make a new
// video, Save draft as the main button, §45.47: it saves, then goes on); the browser asks on a
// reload or a closed tab. Several boxes on one page (Review's captions and sounds) share the one guard the router has:
// the newest box with changes asks. Only while Clips Funded is on screen: a page kept behind Clip Factory never holds
// Clip Factory's own page changes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setLeaveGuard } from "../../lib/router.ts";
import { useAppActive } from "../pane.tsx";
import { isStoriesPath } from "../routes.ts";
import { StSheet } from "./kit.tsx";

type Holder = { ask: (proceed: () => void) => void };

/** The boxes with unsaved changes now, oldest first. */
const holders: Holder[] = [];
let off: (() => void) | null = null;

function sync() {
  off?.();
  off = null;
  if (!holders.length) return;
  const holds = (to: string) => isStoriesPath(to.split(/[?#]/)[0] ?? "");
  off = setLeaveGuard((to, proceed) => {
    // The switch to Clip Factory keeps this page (and its changes) as it is (§45.34): nothing to ask, and it slides.
    if (!holds(to)) return false;
    const last = holders[holders.length - 1];
    if (!last) return false;
    last.ask(proceed);
    return true;
  }, holds);
}

/** How many boxes hold the page now (tests). */
export function leaveHolders(): number {
  return holders.length;
}

export const LEAVE_TITLE = "Leave without saving?";

export const SAVE_DRAFT = "Save draft";

export interface LeaveOptions {
  /** Save draft (§45.47): saves, and resolves true when it did; the page change then goes on. */
  onSave?: () => Promise<boolean>;
}

/**
 * Holds page changes while `dirty` (and the box is not saving), and returns the question to draw ("Leave without
 * saving?" with Keep editing and Leave, plus Save draft when `onSave` is given) once the owner tries to go.
 */
export function useLeaveGuard(dirty: boolean, options: LeaveOptions = {}): ReactNode {
  const active = useAppActive();
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const { onSave } = options;
  const on = dirty && active;
  const holder = useRef<Holder>({ ask: (proceed) => setLeaving(() => proceed) });

  useEffect(() => {
    if (!on) return;
    const h = holder.current;
    holders.push(h);
    sync();
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers ask only when a value is set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      const i = holders.indexOf(h);
      if (i >= 0) holders.splice(i, 1);
      sync();
      window.removeEventListener("beforeunload", unload);
    };
  }, [on]);

  if (!leaving) return null;
  return (
    <StSheet
      title={LEAVE_TITLE}
      onClose={() => setLeaving(null)}
      actions={
        <>
          <button
            type="button"
            className="st-btn"
            onClick={() => {
              const go = leaving;
              setLeaving(null);
              go();
            }}
          >
            Leave
          </button>
          <button type="button" className={onSave ? "st-btn" : "st-btn st-btn--main"} onClick={() => setLeaving(null)}>
            Keep editing
          </button>
          {onSave ? (
            <button
              type="button"
              className="st-btn st-btn--main"
              aria-disabled={saving || undefined}
              onClick={() => {
                if (saving) return;
                const go = leaving;
                setSaving(true);
                void onSave()
                  .catch(() => false)
                  .then((ok) => {
                    setSaving(false);
                    if (!ok) return;
                    setLeaving(null);
                    go();
                  });
              }}
            >
              {saving ? "Saving…" : SAVE_DRAFT}
            </button>
          ) : null}
        </>
      }
    >
      <p>Your changes are not saved yet. If you leave, they are gone.</p>
    </StSheet>
  );
}
