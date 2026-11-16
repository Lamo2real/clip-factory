// Is Ask Clip Factory on? (docs/CONTRACTS.md §19.8). Checked on sign-in, every 5 minutes, when the app comes back
// to the front, and after any "turned off" answer. Off hides the launcher and the panel, and also stops the local
// fallback: the kill switch means no answers at all.
import { useSyncExternalStore } from "react";
import type { HelpClient } from "./helpApi.ts";

export const STATUS_EVERY_MS = 5 * 60_000;

/** "unknown" until the first check; a failed check counts as on (the local corpus can still answer). */
export type HelpSwitch = "unknown" | "on" | "off";

let current: HelpSwitch = "unknown";
const listeners = new Set<() => void>();

export function helpSwitch(): HelpSwitch {
  return current;
}

export function setHelpSwitch(next: HelpSwitch): void {
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

export function useHelpSwitch(): HelpSwitch {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => "unknown",
  );
}

let inflight: Promise<HelpSwitch> | null = null;

/** Asks the API once (concurrent calls share one request). */
export function checkHelpStatus(client: HelpClient): Promise<HelpSwitch> {
  inflight ??= client
    .status()
    .then((r) => {
      const next: HelpSwitch = r.kind === "ok" ? (r.status.enabled ? "on" : "off") : current === "off" ? "off" : "on";
      setHelpSwitch(next);
      return next;
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** Starts the checks; returns a stop function. */
export function watchHelpStatus(client: HelpClient): () => void {
  void checkHelpStatus(client);
  const timer = setInterval(() => void checkHelpStatus(client), STATUS_EVERY_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkHelpStatus(client);
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
