// Jobs the owner asked to stop that are still inside their 8-second Undo (§16.8). The Undo toast lives on above every
// page, so this lives outside the job page too: leaving the page and coming back still shows "Stopping in a few
// seconds" instead of a second Stop job button, and the stop still happens (or is undone) once.
import { useSyncExternalStore } from "react";
import { api } from "../../api/index.ts";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import type { Job } from "../../api/types.ts";
import type { Toaster } from "../../components/Toasts.tsx";

const pending = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** True while this job's Stop is waiting for its Undo to run out (or for the cancel request to finish). */
export function useStopping(jobId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pending.has(jobId),
    () => false,
  );
}

export function isStopping(jobId: string): boolean {
  return pending.has(jobId);
}

export interface StopHooks {
  /** Undo was tapped in time: nothing was sent. */
  onUndo?: () => void;
  /** The job is stopped. */
  onStopped?: (job: Job) => void;
  /** The server said no for a reason other than "it already finished". */
  onFail?: () => void;
}

/**
 * Shows "Stopping this job." with Undo for 8 s; the cancel is sent when the toast ends (or the page closes). A job
 * that finished or stopped on its own inside the Undo window is left alone quietly: there is nothing to stop.
 */
export function stopWithUndo(jobId: string, toast: Toaster, hooks: StopHooks = {}): void {
  if (pending.has(jobId)) return;
  pending.add(jobId);
  changed();
  const done = () => {
    pending.delete(jobId);
    changed();
  };
  toast.undo("Stopping this job.", {
    onUndo: () => {
      done();
      hooks.onUndo?.();
    },
    onCommit: () => {
      void api()
        .cancelJob(jobId)
        .then(
          (job) => {
            toast.info("Job stopped.");
            hooks.onStopped?.(job);
          },
          (e: unknown) => {
            // 409: the job is no longer working (it finished, failed or was stopped elsewhere). Not an error to show.
            if (e instanceof ApiError && e.status === 409) return;
            hooks.onFail?.();
            toast.error(friendlyMessage(e));
          },
        )
        .finally(done);
    },
  });
}

/** Tests only: forget every pending stop. */
export function resetPendingStops(): void {
  pending.clear();
  changed();
}
