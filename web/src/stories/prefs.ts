// Lamo Stories' own device preferences for sounds and motion (docs/CONTRACTS.md §45.34; request 2 §2 "Each
// application should remember its own ... User preferences", §9 separate configuration). They live in localStorage
// `cf.stories.prefs` (workspace.ts, under `more`), never in Clip Factory's `cf.prefs`:
//
//   sound.enabled  boolean   click and other sounds on or off
//   sound.click    1..30     which click sound (the error sound stays Clip Factory's choice)
//   motion.reduce  boolean   calm motion
//
// Each falls back to Clip Factory's own device preference only while it is unset; once set, Clip Factory's choice
// never changes it. The readers below are the shell's (builder W3b, whose file also has the sound engine that plays
// them); Lamo Stories' Settings › Storage and production › "Sounds and motion" writes them with setStoriesDevicePref
// (the part at the end of this file).
import { useSyncExternalStore } from "react";
import { getPrefs, prefersReducedMotion } from "../lib/prefs.ts";
import { isSoundId } from "../lib/soundCatalog.ts";
import { onStoriesPrefs, setStoriesPref, storiesPrefs } from "./workspace.ts";

/** The keys in cf.stories.prefs (`more`), agreed with Lamo Stories' Settings card. */
export const STORIES_PREF_KEYS = { sound: "sound.enabled", click: "sound.click", motion: "motion.reduce" } as const;

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function own<T>(key: string, ok: (v: unknown) => v is T): T | undefined {
  const v = storiesPrefs().more[key];
  return ok(v) ? v : undefined;
}

/** Lamo Stories' sounds are on (its own choice, else Clip Factory's). */
export function storiesSoundOn(): boolean {
  return own(STORIES_PREF_KEYS.sound, isBool) ?? getPrefs().soundEnabled;
}

/** Lamo Stories' click sound, 1..30 (its own choice, else Clip Factory's). */
export function storiesClickSound(): number {
  return own(STORIES_PREF_KEYS.click, isSoundId) ?? getPrefs().clickSound;
}

/** Lamo Stories' own calm-motion switch (else Clip Factory's), without the system setting. */
export function storiesMotionSetting(): boolean {
  return own(STORIES_PREF_KEYS.motion, isBool) ?? getPrefs().reduceMotion;
}

/** Whether Lamo Stories should keep motion calm: its own switch (else Clip Factory's), or the system's setting. */
export function storiesReduceMotion(): boolean {
  const mine = own(STORIES_PREF_KEYS.motion, isBool);
  if (mine === undefined) return prefersReducedMotion();
  return mine || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// ---------- Settings › Storage and production › Sounds and motion writes them (builder W3c) ----------

/** One of the three keys. */
export type StoriesDeviceKey = (typeof STORIES_PREF_KEYS)[keyof typeof STORIES_PREF_KEYS];

/** Which of the three this device has set for Lamo Stories itself; an unset one follows Clip Factory's. */
export interface StoriesDeviceOwn {
  sound: boolean | undefined;
  click: number | undefined;
  motion: boolean | undefined;
}

/**
 * Keeps one of Lamo Stories' own choices on this device: sounds on or off and calm motion as true or false, the click
 * sound as its number (1..30), exactly the shapes the readers above take. null forgets it, so Clip Factory's choice
 * applies again; any other value is not kept.
 */
export function setStoriesDevicePref(key: "sound.enabled" | "motion.reduce", value: boolean | null): void;
export function setStoriesDevicePref(key: "sound.click", value: number | null): void;
export function setStoriesDevicePref(key: StoriesDeviceKey, value: boolean | number | null): void {
  const known = (Object.values(STORIES_PREF_KEYS) as string[]).includes(key);
  const fits = value === null || (key === STORIES_PREF_KEYS.click ? isSoundId(value) : isBool(value));
  if (known && fits) setStoriesPref(key, value);
}

/** This device's own choices for Lamo Stories (an unset one is undefined). */
export function storiesDeviceOwn(): StoriesDeviceOwn {
  return { sound: own(STORIES_PREF_KEYS.sound, isBool), click: own(STORIES_PREF_KEYS.click, isSoundId), motion: own(STORIES_PREF_KEYS.motion, isBool) };
}

const NO_PREFS: Record<string, unknown> = {};

/** Re-renders when Lamo Stories' own device preferences change (here or on another screen); read them with the readers above. */
export function useStoriesDevicePrefs(): Record<string, unknown> {
  return useSyncExternalStore(
    (fn) => onStoriesPrefs(fn),
    () => storiesPrefs().more,
    () => NO_PREFS,
  );
}
