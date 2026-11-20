// Mac fetches it (docs/CONTRACTS.md §35): in the desktop app only, keeps an eye on the owner's jobs and gets every
// YouTube video that waits for a Mac, on this computer's own connection. In a browser (no window.__CF_MAC_FETCH__)
// it renders nothing and does nothing. Jobs come from one list read at start, every live job event, a resync, and a
// list read every 30 seconds, so a job that waited while the app was closed is picked up when it opens.
import { useEffect } from "react";
import { api } from "../api/index.ts";
import { onLiveSignal } from "../lib/live.ts";
import { macBridge, macDeviceId, MacFetcher, RELIST_MS } from "../lib/macFetch.ts";

export function MacFetchHost() {
  useEffect(() => {
    const bridge = macBridge();
    if (!bridge) return;
    const fetcher = new MacFetcher({ api: api(), bridge, deviceId: macDeviceId() });
    let alive = true;
    const relist = () => {
      api()
        .listJobs({ limit: 20 })
        .then((r) => {
          if (alive) for (const job of r.jobs) fetcher.consider(job);
        })
        .catch(() => undefined);
    };
    relist();
    const every = setInterval(relist, RELIST_MS);
    const off = onLiveSignal((s) => {
      if (s.kind === "resync") relist();
      else if (s.event.type === "job" && s.event.op === "upsert" && s.event.item) fetcher.consider(s.event.item);
    });
    return () => {
      alive = false;
      clearInterval(every);
      off();
      // Signing out or closing the window: the app keeps its half-done download for the next start.
    };
  }, []);
  return null;
}
