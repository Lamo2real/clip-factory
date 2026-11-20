// The number on the app icon (docs/CONTRACTS.md §32.6): how many videos are working right now. The Badging API works
// for the app added to the Home Screen on iPhone and iPad (iOS 16.4+) and for installed apps on Mac, Windows and
// Android. While the app is open it keeps the number right from the job list and live job events; while it is closed,
// each notification carries the number and the service worker sets it (web/sw/sw.js).
import { useEffect, useRef } from "react";
import { api } from "../api/index.ts";
import type { Job } from "../api/types.ts";
import { useLiveEvents } from "./live.ts";

type BadgeNavigator = {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function badgeSupported(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return !!nav && typeof (nav as BadgeNavigator).setAppBadge === "function";
}

/** Sets the icon's number; 0 clears it. Never throws: a device without badges simply shows none. */
export async function setBadge(n: number, nav: unknown = typeof navigator === "undefined" ? undefined : navigator): Promise<void> {
  const b = nav as BadgeNavigator | undefined;
  if (!b || typeof b.setAppBadge !== "function") return;
  try {
    if (n > 0) await b.setAppBadge(n);
    else if (typeof b.clearAppBadge === "function") await b.clearAppBadge();
    else await b.setAppBadge(0);
  } catch {
    // No permission yet (iPhone asks with notifications): nothing to show.
  }
}

const ACTIVE = new Set(["queued", "running"]);

/** Which jobs are working, kept by id so live events can add, change or end one. */
export function workingIds(jobs: Pick<Job, "jobId" | "status">[]): Set<string> {
  return new Set(jobs.filter((j) => ACTIVE.has(j.status)).map((j) => j.jobId));
}

/** Keeps the app icon's number right while the app is open. Renders nothing. */
export function AppBadge() {
  const working = useRef<Set<string> | null>(null);
  const reload = useRef(() => {});
  reload.current = () => {
    if (!badgeSupported()) return;
    api()
      .listJobs({ limit: 50 })
      .then((r) => {
        working.current = workingIds(r.jobs);
        void setBadge(working.current.size);
      })
      .catch(() => {});
  };
  useEffect(() => {
    reload.current();
    const onShow = () => {
      if (document.visibilityState === "visible") reload.current();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);
  useLiveEvents(
    (e) => {
      if (e.type !== "job" || !working.current) return;
      if (e.op === "upsert" && e.item && ACTIVE.has(e.item.status)) working.current.add(e.id);
      else working.current.delete(e.id);
      void setBadge(working.current.size);
    },
    () => reload.current(),
  );
  return null;
}
