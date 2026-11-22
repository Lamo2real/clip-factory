// Lamo Stories' own device preferences (docs/CONTRACTS.md §45.34 "Lamo Stories' own device preferences", request 2
// §9): all sounds on or off, click sounds on or off, and reduced motion, kept in this device's `cf.stories.prefs`
// (beside the workspace memory, under its own keys `sound.enabled`, `sound.click` and `motion.reduce`), never in
// Clip Factory's `cf.prefs`. Lamo Stories' screens read these first and fall back to Clip Factory's only while one is
// unset; once set, Clip Factory's preferences never change it. Settings › Storage and production › Sounds and motion
// writes them with setStoriesDevicePref.
import { useSyncExternalStore } from "react";
import { onStoriesPrefs, setStoriesPref, storiesPrefs } from "./workspace.ts";

export type StoriesDeviceKey = "sound.enabled" | "sound.click" | "motion.reduce";
export const STORIES_DEVICE_KEYS: readonly StoriesDeviceKey[] = ["sound.enabled", "sound.click", "motion.reduce"];

/** This device's own choice for Lamo Stories, or null while it was never set (then Clip Factory's applies). */
export function storiesDevicePref(key: StoriesDeviceKey): boolean | null {
  const v = storiesPrefs().more[key];
  return typeof v === "boolean" ? v : null;
}

/** Keeps one choice for Lamo Stories on this device; null forgets it, so Clip Factory's applies again. */
export function setStoriesDevicePref(key: StoriesDeviceKey, value: boolean | null): void {
  if (!STORIES_DEVICE_KEYS.includes(key)) return;
  setStoriesPref(key, value);
}

/** The choice, kept up to date when it changes (on this page or another). */
export function useStoriesDevicePref(key: StoriesDeviceKey): boolean | null {
  return useSyncExternalStore(
    (fn) => onStoriesPrefs(fn),
    () => storiesDevicePref(key),
    () => null,
  );
}
