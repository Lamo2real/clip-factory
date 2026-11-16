// Clips the owner threw away on Review that are still inside their 8-second Undo, or whose decline already went
// through (§12.3, §20.7). The Undo toast lives on above every page, so this store outlives the Review screen: leaving
// Review and coming back inside the 8 seconds must not show the clip again (the server still lists it as waiting
// until the decline is sent), and Undo must bring it back on whichever Review is on screen by then.
import { useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { Clip } from "../api/types.ts";
import type { Toaster } from "../components/Toasts.tsx";

/** Shown when the decline finds the clip already kept or thrown away somewhere else. */
export const ALREADY_DECIDED = "This clip was already kept or thrown away somewhere else, so there is nothing more to do.";

const hidden = new Set<string>();
const listeners = new Set<() => void>();
const backListeners = new Set<(clipId: string) => void>();
let snapshot: ReadonlySet<string> = new Set();

function changed() {
  snapshot = new Set(hidden);
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The clip ids to leave out of the Review list right now (thrown away, Undo still on screen or already declined). */
export function useThrownAway(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** Whether this clip is thrown away (waiting for its Undo to run out, or declined). */
export function isThrownAway(clipId: string): boolean {
  return hidden.has(clipId);
}

/** Calls `fn` with the clip id each time a thrown-away clip comes back (Undo, or the decline failed). */
export function onClipBack(fn: (clipId: string) => void): () => void {
  backListeners.add(fn);
  return () => {
    backListeners.delete(fn);
  };
}

function back(clipId: string) {
  hidden.delete(clipId);
  changed();
  for (const fn of backListeners) fn(clipId);
}

/**
 * Hides the clip at once and shows "Clip thrown away." with Undo for 8 s. Undo brings it back and sends nothing;
 * the decline goes when the toast ends. A decline that fails brings the clip back with an error toast, except when
 * the clip was already decided (kept or thrown away somewhere else): then it stays gone and a calm note says so.
 */
export function throwAwayWithUndo(clip: Clip, toast: Toaster, onDeclined?: () => void): void {
  hidden.add(clip.clipId);
  changed();
  toast.undo("Clip thrown away.", {
    onUndo: () => back(clip.clipId),
    onCommit: () => {
      api()
        .declineClip(clip.clipId)
        .then(
          () => onDeclined?.(),
          (e: unknown) => {
            if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
              // Already decided (kept or thrown away on another screen or device): not a failure, nothing to do.
              toast.info(ALREADY_DECIDED);
              return;
            }
            back(clip.clipId);
            toast.error(`${friendlyMessage(e)} The clip is back in your list.`);
          },
        );
    },
  });
}

/** Tests only: forget every thrown-away clip. */
export function resetThrownAway(): void {
  hidden.clear();
  changed();
}
