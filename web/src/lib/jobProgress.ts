import type { Job } from "../api/types.ts";

/** The most a job that is not finished shows: 100% means done, so it is kept for a ready job only. */
export const WORKING_CAP = 0.99;

/** How full a job's bar is (0..1). Only a ready job is full; any other job stays at 99% at most, even if the record
 *  says more (a run before the fix of 2026-11-20 could write 100% while steps were left). */
export function jobProgress(job: Pick<Job, "status" | "progress">): number {
  if (job.status === "ready") return 1;
  const p = Number(job.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.min(WORKING_CAP, Math.max(0, p));
}

/** The same as a whole percent, for the number beside the bar. */
export function jobPercent(job: Pick<Job, "status" | "progress">): number {
  return Math.round(jobProgress(job) * 100);
}
