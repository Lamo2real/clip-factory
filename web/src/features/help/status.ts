// Is Ask Clip Factory on? (docs/CONTRACTS.md §19.8). Checked on sign-in, every 5 minutes, when the app comes back
// to the front, and after any "turned off" answer. Off hides the launcher and the panel, and also stops the local
// fallback: the kill switch means no answers at all.
import { useSyncExternalStore } from "react";
import type { HelpClient } from "./helpApi.ts";
import type { AssistantStatus } from "./types.ts";

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

// Pictures in Ask (§26): on only when the last check said so (model mode and the pictures switch on).
let pictures = false;
const pictureListeners = new Set<() => void>();

export function picturesOn(): boolean {
  return pictures;
}

export function setPicturesOn(next: boolean): void {
  if (next === pictures) return;
  pictures = next;
  for (const fn of pictureListeners) fn();
}

export function usePicturesOn(): boolean {
  return useSyncExternalStore(
    (fn) => {
      pictureListeners.add(fn);
      return () => pictureListeners.delete(fn);
    },
    () => pictures,
    () => false,
  );
}

// Ask as a full assistant (§27): on only when the last check said so; off means the §19 answers.
let assistant: AssistantStatus = { on: false, web: "off", files: false };
const assistantListeners = new Set<() => void>();

export function assistantStatus(): AssistantStatus {
  return assistant;
}

export function setAssistantStatus(next: AssistantStatus): void {
  if (next.on === assistant.on && next.web === assistant.web && next.files === assistant.files) return;
  assistant = next;
  for (const fn of assistantListeners) fn();
}

export function useAssistant(): AssistantStatus {
  return useSyncExternalStore(
    (fn) => {
      assistantListeners.add(fn);
      return () => assistantListeners.delete(fn);
    },
    () => assistant,
    () => assistant,
  );
}

let inflight: Promise<HelpSwitch> | null = null;

/** Asks the API once (concurrent calls share one request). */
export function checkHelpStatus(client: HelpClient): Promise<HelpSwitch> {
  inflight ??= client
    .status()
    .then((r) => {
      const next: HelpSwitch = r.kind === "ok" ? (r.status.enabled ? "on" : "off") : current === "off" ? "off" : "on";
      // A failed check keeps the last answer about pictures; off turns them off.
      if (r.kind === "ok") {
        setPicturesOn(r.status.enabled && r.status.pictures === true);
        setAssistantStatus(r.status.enabled && r.status.assistant ? r.status.assistant : { on: false, web: "off", files: false });
      } else if (next === "off") {
        setPicturesOn(false);
        setAssistantStatus({ on: false, web: "off", files: false });
      }
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
