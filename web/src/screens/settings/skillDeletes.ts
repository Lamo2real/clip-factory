// Skills the owner deleted that are still inside their 8-second Undo (§18.5), and the one just added. The delete starts on the skill page and
// the Undo toast lives on above every page, so the Skills list reads this to leave those rows out until the time is
// up, and to put a row back on Undo or when the delete fails.
import { useSyncExternalStore } from "react";
import { api, friendlyMessage, type Skill } from "../../api/index.ts";
import type { Toaster } from "../../components/Toasts.tsx";

const hidden = new Set<string>();
/** The deletes whose Undo is still on screen (a subset of `hidden`). */
const undoable = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();
let undoSnapshot: ReadonlySet<string> = new Set();

function changed() {
  snapshot = new Set(hidden);
  undoSnapshot = new Set(undoable);
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The ids to leave out of the Skills list right now. */
export function useHiddenSkills(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** The skills just deleted whose Undo can still bring them back. */
export function useUndoableDeletes(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => undoSnapshot,
    () => undoSnapshot,
  );
}

/**
 * Hides the skill at once and shows "Deleted {title}." with Undo for 8 s. Undo brings it back and sends nothing;
 * the DELETE goes when the toast ends (or the page closes). A failed DELETE brings it back with an error toast.
 */
export function deleteWithUndo(skill: Skill, toast: Toaster): void {
  hidden.add(skill.skillId);
  undoable.add(skill.skillId);
  changed();
  const restore = () => {
    hidden.delete(skill.skillId);
    undoable.delete(skill.skillId);
    changed();
  };
  toast.undo(`Deleted ${skill.title}.`, {
    onUndo: restore,
    onCommit: () => {
      undoable.delete(skill.skillId);
      changed();
      api()
        .deleteSkill(skill.skillId)
        .then(
          // Stays hidden: the list that still has it was loaded before the delete.
          () => undefined,
          (e: unknown) => {
            restore();
            toast.error(`${friendlyMessage(e)} The skill is back in your list.`);
          },
        );
    },
  });
}

let fresh: string | null = null;

/** The skill just written: its row pops in once when the owner goes back to the list. */
export function markNewSkill(skillId: string): void {
  fresh = skillId;
}

/** Whether this row is the one just added (asked once per row; the answer is used up). */
export function isNewSkill(skillId: string): boolean {
  if (fresh !== skillId) return false;
  fresh = null;
  return true;
}
