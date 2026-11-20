// The live status lines of working jobs (docs/CONTRACTS.md §31), held once for the whole app: the job page, the Jobs
// list and Home's "Working now" all read the same line. Lines arrive as `jobLive` events on the shared live
// connection (nothing new polls); a fetched job carries its line too (`job.live`), so a page load shows it at once.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Job, JobLive, LiveEvent } from "../api/types.ts";
import { onLiveSignal } from "./live.ts";
import { applyJobLiveEvent, pickJobLive } from "./liveCache.ts";

let lines = new Map<string, JobLive>();
const listeners = new Set<() => void>();

/** Folds one live event in (anything but a `jobLive` event changes nothing). */
export function takeJobLive(ev: LiveEvent): void {
  if (ev.type !== "jobLive") return;
  lines = applyJobLiveEvent(lines, ev);
  for (const fn of listeners) fn();
}

/** Tests and sign-out: forget every line. */
export function clearJobLive(): void {
  lines = new Map();
  for (const fn of listeners) fn();
}

// One listener for the whole app (not one per row on screen): every jobLive event folds in once. Wired when the
// first line is drawn, so importing this file does nothing on its own.
let wired = false;

function subscribe(fn: () => void) {
  if (!wired) {
    wired = true;
    onLiveSignal((s) => {
      if (s.kind === "event" && !s.event.partial) takeJobLive(s.event);
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The line to show for `job` right now, or null (ended job, no line yet, or a line of an older run). */
export function useJobLive(job: Pick<Job, "jobId" | "status" | "run" | "live">): JobLive | null {
  const pushed = useSyncExternalStore(
    subscribe,
    () => lines.get(job.jobId),
    () => undefined,
  );
  return pickJobLive(job, pushed);
}

/** Date.now(), refreshed every `ms` while `active` (the seconds of a model call, "last update 2 min ago"). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** After this long without a new line it reads "Still working: Cut the clips" (CONTRACTS §31.5). */
export const STALE_MS = 60_000;

/** Seconds as "0:21" or "1:02:03". */
export function clockText(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface LineWords {
  text: string;
  detail: string;
  tech: string;
  stale: boolean;
  /** What a screen reader hears: only the step and the clip number, never the seconds or MB. */
  say: string;
}

/** The words on screen for a line at time `now`. `label` is the running step's label ("Cut the clips"). */
export function lineWords(line: JobLive, now: number, label: string | undefined): LineWords {
  const at = Date.parse(line.at);
  const stale = Number.isFinite(at) && now - at > STALE_MS;
  if (stale) {
    const mins = Math.max(1, Math.floor((now - at) / 60_000));
    return {
      text: label ? `Still working: ${label}` : "Still working",
      detail: `last update ${mins} min ago`,
      tech: "",
      stale: true,
      say: label ? `Still working: ${label}.` : "Still working.",
    };
  }
  const parts = line.detail ? [line.detail] : [];
  const since = line.since ? Date.parse(line.since) : NaN;
  if (Number.isFinite(since)) parts.push(clockText((now - since) / 1000));
  return { text: line.text, detail: parts.join(" · "), tech: line.tech ?? "", stale: false, say: `${line.text}.` };
}
