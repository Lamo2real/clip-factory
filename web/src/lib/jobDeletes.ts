// Jobs the owner deleted (docs/CONTRACTS.md §34.5). Like Stop job and Throw away, the delete waits 8 seconds for an
// Undo before anything is sent, and the Undo toast lives on above every page, so this store outlives the screen that
// asked: the job (and, when the owner ticked the box, its clips in Review) stays out of every list and count while
// the Undo is up and after the delete went through, so a poll answered a moment before can never show it again.
import { useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { friendlyMessage } from "../api/errors.ts";
import type { JobDeleteClips, JobDeleted } from "../api/types.ts";
import type { Toaster } from "../components/Toasts.tsx";
import { plural } from "./format.ts";

/** One job on its way out: whether it was working, and how many of its Review clips go with it. */
export interface DeletingJob {
  jobId: string;
  working: boolean;
  /** Clips in Review that go with it (0 when the owner left the box unticked). */
  reviewClips: number;
}

export interface DeletedState {
  /** Every job deleted on this device (Undo still up, being sent, or done): hidden everywhere. */
  jobs: ReadonlySet<string>;
  /** Jobs whose Review clips are deleted too: those clips are hidden from Review. */
  reviewJobs: ReadonlySet<string>;
  /** Not yet confirmed by the server's counts: taken off the running count and the Review badge. */
  working: number;
  reviewClips: number;
}

/** The API takes at most this many jobs per call (§34.3). */
export const BATCH = 25;

const hidden = new Map<string, DeletingJob & { counted: boolean; clips: JobDeleteClips }>();
const listeners = new Set<() => void>();
const backListeners = new Set<(jobIds: string[]) => void>();
let snapshot: DeletedState = { jobs: new Set(), reviewJobs: new Set(), working: 0, reviewClips: 0 };

function changed() {
  const all = [...hidden.values()];
  const counted = all.filter((j) => j.counted);
  snapshot = {
    jobs: new Set(all.map((j) => j.jobId)),
    reviewJobs: new Set(all.filter((j) => j.clips === "delete").map((j) => j.jobId)),
    working: counted.filter((j) => j.working).length,
    reviewClips: counted.reduce((n, j) => n + j.reviewClips, 0),
  };
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** What to leave out of lists and counts right now. */
export function useDeletedJobs(): DeletedState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function isDeleted(jobId: string): boolean {
  return hidden.has(jobId);
}

/** Calls `fn` with the job ids that came back (Undo, or the delete failed). */
export function onJobsBack(fn: (jobIds: string[]) => void): () => void {
  backListeners.add(fn);
  return () => {
    backListeners.delete(fn);
  };
}

function back(jobIds: string[]) {
  for (const id of jobIds) hidden.delete(id);
  changed();
  for (const fn of backListeners) fn(jobIds);
}

/** The toast's words: "Job deleted." or "3 jobs deleted." */
export function deletedText(n: number): string {
  return n === 1 ? "Job deleted." : `${plural(n, "job")} deleted.`;
}

export interface DeleteHooks {
  /** Undo was tapped in time: nothing was sent. */
  onUndo?: () => void;
  /** The server deleted them. Return a promise (a fresh count) to keep the counts adjusted until it is done. */
  onDeleted?: (results: JobDeleted[]) => unknown;
  /** The delete failed: the jobs are back. */
  onFail?: () => void;
}

/**
 * Hides the jobs at once and shows "Job deleted." with Undo for 8 seconds; the delete is sent when the toast ends (or
 * the page closes). Undo brings them back and sends nothing. A delete that fails brings back the jobs it could not
 * delete, with an error toast; a job already gone (deleted on another device) simply stays gone.
 */
export function deleteWithUndo(jobs: DeletingJob[], clips: JobDeleteClips, toast: Toaster, hooks: DeleteHooks = {}): void {
  const fresh = jobs.filter((j) => !hidden.has(j.jobId));
  if (!fresh.length) return;
  for (const j of fresh) hidden.set(j.jobId, { ...j, reviewClips: clips === "delete" ? j.reviewClips : 0, counted: true, clips });
  changed();
  const ids = fresh.map((j) => j.jobId);
  toast.undo(deletedText(ids.length), {
    onUndo: () => {
      back(ids);
      hooks.onUndo?.();
    },
    onCommit: () => void send(ids, clips, toast, hooks),
  });
}

async function send(ids: string[], clips: JobDeleteClips, toast: Toaster, hooks: DeleteHooks) {
  const results: JobDeleted[] = [];
  const failed: string[] = [];
  let error: unknown = null;
  for (let at = 0; at < ids.length; at += BATCH) {
    const part = ids.slice(at, at + BATCH);
    try {
      if (part.length === 1) results.push(await api().deleteJob(part[0]!, clips));
      else results.push(...(await api().deleteJobs(part, clips)));
    } catch (e) {
      failed.push(...part);
      error = e;
    }
  }
  if (failed.length) {
    back(failed);
    hooks.onFail?.();
    const what = failed.length === 1 ? "The job is back in your list." : `${plural(failed.length, "job")} are back in your list.`;
    toast.error(`${friendlyMessage(error)} ${what}`);
  }
  if (results.length) {
    try {
      await hooks.onDeleted?.(results);
    } catch {
      // The counts catch up on their own (live events, the next poll).
    }
  }
  // The server's counts now include the delete: stop taking these off them (they stay hidden).
  for (const r of results) {
    const j = hidden.get(r.jobId);
    if (j) j.counted = false;
  }
  changed();
}

/** Tests only: forget every deleted job. */
export function resetDeletedJobs(): void {
  hidden.clear();
  changed();
}
