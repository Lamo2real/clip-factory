import type { Job } from "../../api/types.ts";

/** The API's largest page (CONTRACTS.md §5: limit is 1 to 50). */
export const MAX_PAGE = 50;

/** How many of the newest jobs the live poll asks for: enough to cover what is on screen, never over the API limit. */
export function pollLimit(shown: number): number {
  return Math.min(MAX_PAGE, Math.max(20, shown));
}

/**
 * Folds a fresh first page into the list on screen. Jobs already shown are updated where they are,
 * new jobs go on top (newest first), and older pages loaded with "Show older jobs" stay put, so the
 * saved cursor still points after the last job shown and nothing is skipped.
 */
export function mergeJobs(current: Job[], fresh: Job[]): Job[] {
  const byId = new Map(fresh.map((j) => [j.jobId, j]));
  const known = new Set(current.map((j) => j.jobId));
  const added = fresh.filter((j) => !known.has(j.jobId));
  return [...added, ...current.map((j) => byId.get(j.jobId) ?? j)];
}
