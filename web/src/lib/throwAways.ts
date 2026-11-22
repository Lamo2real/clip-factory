// Clips the owner threw away on Review that are still inside their 8-second Undo, or whose decline already went
// through (§12.3, §20.7). The Undo toast lives on above every page, so this store outlives the Review screen: leaving
// Review and coming back inside the 8 seconds must not show the clip again (the server still lists it as waiting
// until the decline is sent), and Undo must bring it back on whichever Review is on screen by then.
import { useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { Clip } from "../api/types.ts";
import type { Toaster } from "../components/Toasts.tsx";
import { AUTO_ALREADY_SENT } from "./autopost.ts";

/** Shown when the decline finds the clip already kept or thrown away somewhere else. */
export const ALREADY_DECIDED = "This clip was already uploaded or thrown away somewhere else, so there is nothing more to do.";

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

/** An api call; one that throws before it starts (no such call) rejects like any other failure. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (e) {
    return Promise.reject(e);
  }
}

/** Whether auto-posting already sent the clip (read again after a refused decline; unknown → no). */
const sentByAutoPosting = (clipId: string): Promise<boolean> =>
  attempt(() => api().getClip(clipId)).then(
    (c) => !!c.auto,
    () => false,
  );

/**
 * Hides the clip at once and shows "Clip thrown away." with Undo for 8 s. Undo brings it back and sends nothing;
 * the decline goes when the toast ends. A decline that fails brings the clip back with an error toast, except when
 * the clip was already decided (kept or thrown away somewhere else): then it stays gone and a calm note says so.
 *
 * Auto-posting (§46.13): the tap also holds the clip at once (POST /hold), whatever auto-posting's state, so a run
 * inside the 8 s leaves it alone; Undo lets it go again (DELETE /hold). When a run already sent it, the hold says so:
 * the clip stays out of Review, the Undo toast goes, no decline is sent, and "Auto-posting already sent this clip."
 */
export function throwAwayWithUndo(clip: Clip, toast: Toaster, onDeclined?: () => void): void {
  const { clipId } = clip;
  hidden.add(clipId);
  changed();
  let sentByAuto = false;
  const closeUndo = new AbortController();
  const alreadySent = () => {
    if (sentByAuto) return;
    sentByAuto = true;
    if (!hidden.has(clipId)) {
      hidden.add(clipId);
      changed();
    }
    closeUndo.abort();
    toast.info(AUTO_ALREADY_SENT);
  };
  void attempt(() => api().holdClip(clipId)).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 409 && e.message === AUTO_ALREADY_SENT) alreadySent();
    // Anything else (decided somewhere else, an api without holds, no connection): the decline decides, as before.
  });
  toast.undo("Clip thrown away.", {
    signal: closeUndo.signal,
    onUndo: () => {
      if (sentByAuto) return;
      back(clipId);
      void attempt(() => api().unholdClip(clipId)).catch(() => undefined);
    },
    onCommit: () => {
      if (sentByAuto) return;
      api()
        .declineClip(clipId)
        .then(
          () => onDeclined?.(),
          async (e: unknown) => {
            if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
              // Already decided (kept or thrown away on another screen or device, or sent by auto-posting): not a
              // failure, nothing to do.
              const auto = await sentByAutoPosting(clipId);
              if (!sentByAuto) toast.info(auto ? AUTO_ALREADY_SENT : ALREADY_DECIDED);
              return;
            }
            back(clipId);
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
