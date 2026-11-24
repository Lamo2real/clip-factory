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
/** Shown instead of "Clip thrown away." when the server already holds the clip as uploaded (Upload went through). */
export const ALREADY_UPLOADING = "This clip is already uploading, so it can't be thrown away.";

/** The clip statuses that mean Upload went through: it can't be thrown away any more. */
const UPLOADED = new Set<Clip["status"]>(["confirmed", "publishing", "posted", "failed"]);

const hidden = new Set<string>();
const listeners = new Set<() => void>();
const backListeners = new Set<(clipId: string, released: Promise<void>) => void>();
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

/**
 * Calls `fn` with the clip id each time a thrown-away clip comes back (Undo, or the decline failed), at once. Its hold
 * is let go after that: `released` settles once it is (or the release failed), so auto-posting's status read only then
 * has the clip in line again (§46.13).
 */
export function onClipBack(fn: (clipId: string, released: Promise<void>) => void): () => void {
  backListeners.add(fn);
  return () => {
    backListeners.delete(fn);
  };
}

function back(clipId: string, released: Promise<void>) {
  hidden.delete(clipId);
  changed();
  for (const fn of backListeners) fn(clipId, released);
}

/** An api call; one that throws before it starts (no such call) rejects like any other failure. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Why the server refused to hold or decline the clip, read again: auto-posting sent it, Upload went through ("uploading"),
 * or something else (thrown away somewhere else, gone, or the read failed).
 */
const decidedHow = (clipId: string): Promise<"auto" | "uploading" | "other"> =>
  attempt(() => api().getClip(clipId)).then(
    (c) => (c.auto ? "auto" : UPLOADED.has(c.status) ? "uploading" : "other"),
    () => "other" as const,
  );

/**
 * Hides the clip at once and shows "Clip thrown away." with Undo for 8 s. Undo brings it back and sends nothing;
 * the decline goes when the toast ends. A decline that fails brings the clip back with an error toast, except when
 * the clip was already decided (kept or thrown away somewhere else): then it stays gone and a calm note says so.
 *
 * Auto-posting (§46.13): the tap also holds the clip at once (POST /hold), whatever auto-posting's state, so a run
 * inside the 8 s leaves it alone; the hold lasts a day, so a decline that comes late (a phone locked during the toast
 * stops its timer) still finds it held. Undo lets it go again (DELETE /hold, sent only after the hold's own answer, so
 * it always lands last). When a run already sent it, the hold says so: the clip stays out of Review, the Undo toast
 * goes, no decline is sent, and "Auto-posting already sent this clip."
 *
 * A hold (or decline) refused because Upload already went through (the clip is confirmed, publishing, posted or
 * failed): the Undo toast goes, nothing is declined, and it says "This clip is already uploading" (never "somewhere
 * else" about this very tap).
 */
export function throwAwayWithUndo(clip: Clip, toast: Toaster, onDeclined?: () => void): void {
  const { clipId } = clip;
  hidden.add(clipId);
  changed();
  let sentByAuto = false;
  const closeUndo = new AbortController();
  /** The clip is out of Review for good (sent by a run, or uploading): no Undo, no decline, one calm note. */
  const alreadySent = (note: string = AUTO_ALREADY_SENT) => {
    if (sentByAuto) return;
    sentByAuto = true;
    if (!hidden.has(clipId)) {
      hidden.add(clipId);
      changed();
    }
    closeUndo.abort();
    toast.info(note);
  };
  const held = attempt(() => api().holdClip(clipId)).then(
    () => undefined,
    async (e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 409) return;
      if (e.message === AUTO_ALREADY_SENT) return alreadySent();
      // Upload already went through (this card's own Upload that did not finish, or another device's).
      const how = await decidedHow(clipId);
      if (how === "auto") alreadySent();
      else if (how === "uploading") alreadySent(ALREADY_UPLOADING);
      // Anything else (decided somewhere else, an api without holds, no connection): the decline decides, as before.
    },
  );
  /** Lets auto-posting take it again: after the hold's answer, so a slow hold never lands after it. Never fails. */
  const release = (): Promise<void> =>
    held.then(() => attempt(() => api().unholdClip(clipId))).then(
      () => undefined,
      () => undefined,
    );
  toast.undo("Clip thrown away.", {
    signal: closeUndo.signal,
    onUndo: () => {
      if (sentByAuto) return;
      back(clipId, release());
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
              const how = await decidedHow(clipId);
              if (!sentByAuto) toast.info(how === "auto" ? AUTO_ALREADY_SENT : how === "uploading" ? ALREADY_UPLOADING : ALREADY_DECIDED);
              return;
            }
            // Back in his list: auto-posting may take it again too.
            back(clipId, release());
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
