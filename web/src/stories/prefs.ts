// Lamo Stories' own device preferences for sounds and motion (docs/CONTRACTS.md §45.34, §45.38; request 2 §2 "Each
// application should remember its own ... User preferences", §9 separate configuration). They live in localStorage
// `cf.stories.prefs` (workspace.ts, under `more`), never in Clip Factory's `cf.prefs`:
//
//   sound.enabled  boolean   click and other sounds on or off (on until changed)
//   sound.click    1..30     which click sound (Lamo Stories' own usual one until picked)
//   sound.deny     1..30     which error sound (Lamo Stories' own usual one until picked)
//   motion.reduce  boolean   calm motion (off until changed; the device's own "reduce motion" always counts)
//
// Lamo Stories' Settings › Storage and production › "Sounds and motion" writes them with setStoriesDevicePref(key,
// value) (null forgets one; the part at the end of this file). Each one that is unset is Lamo Stories' own default
// (STORIES_DEFAULTS), never Clip Factory's choice: the two apps share nothing here (§45.38 A2). Every Lamo Stories
// sound goes through storiesSound() (Lamo Stories' own engine) and every reduced-motion check through
// storiesReduceMotion() (its sliding highlights too: StoriesApp gives Glide this check). Clip Factory's lib/sounds.ts
// and lib/prefs.ts are not read: while a Lamo Stories page is on screen a click there plays Lamo Stories' sound
// (followStoriesClicks) and Clip Factory's own engine is quiet (lib/sounds.ts). While Clip Factory is on screen (Lamo
// Stories kept behind it), Lamo Stories makes no sound at all.
//
// Lamo Clips' main bundle imports this file (App.tsx: the shell's error toast sound, the page's calm-motion class): it
// has no Lamo Stories screen or style code.
import { useSyncExternalStore } from "react";
import { classifyClick, SoundEngine, type PlayKind } from "../lib/sound.ts";
import { DEFAULT_CLICK_SOUND, DEFAULT_ERROR_SOUND, isSoundId } from "../lib/soundCatalog.ts";
import { storiesBehind, storiesOnScreen } from "./pane.tsx";
import { onStoriesPrefs, setStoriesPref, storiesPrefs } from "./workspace.ts";

/** Clip Factory is on screen and Lamo Stories kept behind it: no Lamo Stories sound or confetti then (stories/pane.tsx). */
export { storiesBehind };

/** The keys in cf.stories.prefs (`more`), agreed with Lamo Stories' Settings card. */
export const STORIES_PREF_KEYS = { sound: "sound.enabled", click: "sound.click", deny: "sound.deny", motion: "motion.reduce" } as const;

/**
 * Lamo Stories' own choices while this device has set none (§45.38 A2): sounds on, its usual click and error sounds,
 * motion as the device asks. They are Lamo Stories' own numbers, never read from Clip Factory's settings.
 */
export const STORIES_DEFAULTS = { sound: true, click: DEFAULT_CLICK_SOUND, deny: DEFAULT_ERROR_SOUND, motion: false } as const;

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function own<T>(key: string, ok: (v: unknown) => v is T): T | undefined {
  const v = storiesPrefs().more[key];
  return ok(v) ? v : undefined;
}

/** Lamo Stories' sounds are on (its own choice, else its own default: on). */
export function storiesSoundOn(): boolean {
  return own(STORIES_PREF_KEYS.sound, isBool) ?? STORIES_DEFAULTS.sound;
}

/** Lamo Stories' click sound, 1..30 (its own choice, else its own usual one). */
export function storiesClickSound(): number {
  return own(STORIES_PREF_KEYS.click, isSoundId) ?? STORIES_DEFAULTS.click;
}

/** Lamo Stories' error sound, 1..30 (its own choice, else its own usual one). */
export function storiesErrorSound(): number {
  return own(STORIES_PREF_KEYS.deny, isSoundId) ?? STORIES_DEFAULTS.deny;
}

/** Lamo Stories' own calm-motion switch (else its own default: off), without the device's setting. */
export function storiesMotionSetting(): boolean {
  return own(STORIES_PREF_KEYS.motion, isBool) ?? STORIES_DEFAULTS.motion;
}

/** The device asks for less motion (the system's own setting, whatever either app says). */
function deviceCalm(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Whether Lamo Stories should keep motion calm: its own switch, or the device's own setting. */
export function storiesReduceMotion(): boolean {
  return storiesMotionSetting() || deviceCalm();
}

let engine: SoundEngine | null = null;
const storiesEngine = () => (engine ??= new SoundEngine(storiesSoundOn, () => ({ tap: storiesClickSound(), deny: storiesErrorSound() })));

/**
 * Plays a Lamo Stories sound ("tap", "deny" or the "success" cheer) by Lamo Stories' own setting, now or, with
 * `onNextTap`, on the owner's next tap (a page that just loaded cannot play audio yet). `recipe` plays one of the 30
 * sounds of that kind (a sound picker's preview). Quiet while Clip Factory is on screen: a page kept behind it never
 * cheers over Clip Factory, and a cheer waiting for a tap that comes in Clip Factory is dropped. Returns a cancel
 * function.
 */
export function storiesSound(kind: PlayKind, opts: { target?: EventTarget | null; onNextTap?: boolean; recipe?: number } = {}): () => void {
  if (storiesBehind()) return () => undefined;
  if (!opts.onNextTap) {
    if (opts.recipe !== undefined) storiesEngine().play(kind, opts.target ?? null, opts.recipe);
    else if (opts.target === undefined) storiesEngine().play(kind);
    else storiesEngine().play(kind, opts.target);
    return () => undefined;
  }
  if (typeof document === "undefined") return () => undefined;
  const onClick = (e: MouseEvent) => {
    document.removeEventListener("click", onClick, { capture: true });
    if (!storiesBehind()) storiesEngine().play(kind, e.target);
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}

/** The error sound a Lamo Stories toast makes (its own engine and its own error sound; quiet behind Clip Factory). */
export function storiesDeniedSound(): void {
  storiesSound("deny");
}

/** The page's calm-motion class (`html.reduce-motion`): Lamo Stories' own switch while one of its pages is on screen. */
export function calmPage(clips: boolean): boolean {
  return storiesOnScreen() ? storiesMotionSetting() : clips;
}

/**
 * Puts the calm-motion class right now (after a switch, or a change of Lamo Stories' own switch). `clips` is Clip
 * Factory's own calm-motion choice, which the shell passes in (this file never reads Clip Factory's settings).
 */
export function applyCalmPage(clips: () => boolean): void {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("reduce-motion", calmPage(clips()));
}

/** Follows Lamo Stories' own switch while one of its pages is on screen. Returns a stop function. */
export function followStoriesMotion(clips: () => boolean): () => void {
  applyCalmPage(clips);
  return onStoriesPrefs(() => applyCalmPage(clips));
}

/**
 * While a Lamo Stories page is on screen, a click plays Lamo Stories' own sound (the same tap or deny the app's click
 * handler would pick) and that handler skips the click: the clicked element wears data-sound="off" for that one click
 * only (the handler, in the document's capture phase, runs after this window listener and before the next document
 * one, which puts it back). Clip Factory's engine is quiet then anyway (lib/sounds.ts). Returns a stop function.
 */
export function followStoriesClicks(): () => void {
  if (typeof window === "undefined") return () => undefined;
  let held: { el: Element; was: string | null } | null = null;
  const giveBack = () => {
    if (!held) return;
    const { el, was } = held;
    held = null;
    if (was === null) el.removeAttribute("data-sound");
    else el.setAttribute("data-sound", was);
  };
  const onClick = (e: MouseEvent) => {
    giveBack();
    if (!storiesOnScreen()) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const kind = classifyClick(t);
    if (!kind) return;
    storiesEngine().play(kind, t);
    held = { el: t, was: t.getAttribute("data-sound") };
    t.setAttribute("data-sound", "off");
    setTimeout(giveBack, 0);
  };
  // The press before a click builds Lamo Stories' audio first, as the app's handler does for its own.
  const onPress = (e: Event) => {
    if (!storiesOnScreen()) return;
    if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
    if (classifyClick(e.target)) storiesEngine().warm();
  };
  window.addEventListener("click", onClick, { capture: true });
  document.addEventListener("click", giveBack, { capture: true });
  window.addEventListener("pointerdown", onPress, { capture: true, passive: true });
  window.addEventListener("keydown", onPress, { capture: true, passive: true });
  return () => {
    window.removeEventListener("click", onClick, { capture: true });
    document.removeEventListener("click", giveBack, { capture: true });
    window.removeEventListener("pointerdown", onPress, { capture: true });
    window.removeEventListener("keydown", onPress, { capture: true });
    giveBack();
  };
}

// ---------- Settings › Storage and production › Sounds and motion writes them (builder W3c) ----------

/** One of the four keys. */
export type StoriesDeviceKey = (typeof STORIES_PREF_KEYS)[keyof typeof STORIES_PREF_KEYS];

/** Which of the four this device has set for Lamo Stories itself; an unset one is Lamo Stories' own default. */
export interface StoriesDeviceOwn {
  sound: boolean | undefined;
  click: number | undefined;
  deny: number | undefined;
  motion: boolean | undefined;
}

/**
 * Keeps one of Lamo Stories' own choices on this device: sounds on or off and calm motion as true or false, the click
 * and error sounds as their numbers (1..30), exactly the shapes the readers above take. null forgets it, so Lamo
 * Stories' own default applies again; any other value is not kept.
 */
export function setStoriesDevicePref(key: "sound.enabled" | "motion.reduce", value: boolean | null): void;
export function setStoriesDevicePref(key: "sound.click" | "sound.deny", value: number | null): void;
export function setStoriesDevicePref(key: StoriesDeviceKey, value: boolean | number | null): void {
  const known = (Object.values(STORIES_PREF_KEYS) as string[]).includes(key);
  const number = key === STORIES_PREF_KEYS.click || key === STORIES_PREF_KEYS.deny;
  const fits = value === null || (number ? isSoundId(value) : isBool(value));
  if (known && fits) setStoriesPref(key, value);
}

/** This device's own choices for Lamo Stories (an unset one is undefined). */
export function storiesDeviceOwn(): StoriesDeviceOwn {
  return {
    sound: own(STORIES_PREF_KEYS.sound, isBool),
    click: own(STORIES_PREF_KEYS.click, isSoundId),
    deny: own(STORIES_PREF_KEYS.deny, isSoundId),
    motion: own(STORIES_PREF_KEYS.motion, isBool),
  };
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
