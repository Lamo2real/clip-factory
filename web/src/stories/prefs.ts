// Lamo Stories' own device preferences for sounds and motion (docs/CONTRACTS.md §45.34; request 2 §2 "Each
// application should remember its own ... User preferences", §9 separate configuration). They live in localStorage
// `cf.stories.prefs` (workspace.ts, under `more`), never in Clip Factory's `cf.prefs`:
//
//   sound.enabled  boolean   click and other sounds on or off
//   sound.click    1..30     which click sound (the error sound stays Clip Factory's choice)
//   motion.reduce  boolean   calm motion
//
// Lamo Stories' Settings › Storage and production › "Sounds and motion" (builder W3c) writes them with
// setStoriesDevicePref(key, value) (null forgets one; the part at the end of this file). Each falls back to Clip
// Factory's own device preference only while it is unset; once set, Clip Factory's choice never changes it. Every
// Lamo Stories sound goes through storiesSound() and every reduced-motion check through storiesReduceMotion() (its
// sliding highlights too: StoriesApp gives Glide this check). Clip Factory's lib/sounds.ts and lib/prefs.ts are not
// changed: while Lamo Stories' own sound setting is set and a Lamo Stories page is on screen, a click there plays
// Lamo Stories' sound (followStoriesClicks) and the app's own click handler stays quiet for that one click. While
// Clip Factory is on screen (Lamo Stories kept behind it), Lamo Stories makes no sound at all.
//
// Lamo Clips' main bundle imports this file (App.tsx: the error toast's sound, the page's calm-motion class): it has
// no Lamo Stories screen or style code.
import { useSyncExternalStore } from "react";
import { getPrefs, prefersReducedMotion } from "../lib/prefs.ts";
import { classifyClick, SoundEngine, type PlayKind } from "../lib/sound.ts";
import { isSoundId } from "../lib/soundCatalog.ts";
import { sounds } from "../lib/sounds.ts";
import { storiesBehind, storiesOnScreen } from "./pane.tsx";
import { onStoriesPrefs, setStoriesPref, storiesPrefs } from "./workspace.ts";

/** Clip Factory is on screen and Lamo Stories kept behind it: no Lamo Stories sound or confetti then (stories/pane.tsx). */
export { storiesBehind };

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

/** Lamo Stories has a sound setting of its own (until then Clip Factory's sound engine plays, exactly as before). */
function ownSound(): boolean {
  return own(STORIES_PREF_KEYS.sound, isBool) !== undefined || own(STORIES_PREF_KEYS.click, isSoundId) !== undefined;
}

let engine: SoundEngine | null = null;
const storiesEngine = () => (engine ??= new SoundEngine(storiesSoundOn, () => ({ tap: storiesClickSound(), deny: getPrefs().errorSound })));
const engineNow = () => (ownSound() ? storiesEngine() : sounds);

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
    if (opts.recipe !== undefined) engineNow().play(kind, opts.target ?? null, opts.recipe);
    else if (opts.target === undefined) engineNow().play(kind);
    else engineNow().play(kind, opts.target);
    return () => undefined;
  }
  if (typeof document === "undefined") return () => undefined;
  const onClick = (e: MouseEvent) => {
    document.removeEventListener("click", onClick, { capture: true });
    if (!storiesBehind()) engineNow().play(kind, e.target);
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}

/** The sound an error toast makes: Lamo Stories' own setting while a Lamo Stories page is on screen. */
export function deniedSound(): void {
  if (storiesOnScreen()) storiesSound("deny");
  else sounds.play("deny");
}

/** The page's calm-motion class (`html.reduce-motion`): Lamo Stories' own switch while one of its pages is on screen. */
export function calmPage(clips: boolean): boolean {
  return storiesOnScreen() ? storiesMotionSetting() : clips;
}

/** Puts the calm-motion class right now (after a switch, or a change of Lamo Stories' own switch). */
export function applyCalmPage(): void {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("reduce-motion", calmPage(getPrefs().reduceMotion));
}

/** Follows Lamo Stories' own switch while one of its pages is on screen. Returns a stop function. */
export function followStoriesMotion(): () => void {
  applyCalmPage();
  return onStoriesPrefs(applyCalmPage);
}

/**
 * While a Lamo Stories page is on screen and Lamo Stories has a sound setting of its own, a click plays Lamo Stories'
 * sound (the same tap or deny the app's click handler would pick) and that handler skips the click: the clicked
 * element wears data-sound="off" for that one click only (the handler, in the document's capture phase, runs after
 * this window listener and before the next document one, which puts it back). Returns a stop function.
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
    if (!ownSound() || !storiesOnScreen()) return;
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
    if (!ownSound() || !storiesOnScreen()) return;
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
