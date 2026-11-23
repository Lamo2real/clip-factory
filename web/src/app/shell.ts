// The application shell's own bridge between the two apps (docs/CONTRACTS.md §45.38; request 2: "The only shared
// element should be the application shell", "These two applications must not depend on each other's internal
// functionality"). Clip Factory's files and Lamo Stories' files both import this small module; neither imports the
// other's code for these. It holds:
//
//   - the pane each app sits in (AppPanes, stories/pane.tsx): whether this app is the one on screen (`active`), and
//     whether the shell hosts it next to the other app (`hosted`: the shell then draws the workspace switch and the
//     Live chip for both, app/WorkspaceDock.tsx, and each app leaves their place free);
//   - which app is on screen right now (by the address: every /stories page is Lamo Stories);
//   - Clip Factory's page changes that come after a wait (a request that answered): while Lamo Stories is on screen
//     they wait, and happen the moment Clip Factory is back (clipsGoLater), the mirror of Lamo Stories' storiesGoLater;
//   - the search of Clip Factory's kept page while it is hidden (useKeptSearch, §45.35 D18);
//   - the page's own glass: which app the shell shows (AppPanes says), and html.see-through, which only the shell
//     writes, from the wish of the app on screen (each app states its own with setPageGlass, never the other's);
//   - the sliding window between the two apps (the owner, 23 Nov: "id like the transission between clip factory and
//     clips funded to be like a sliding window"): the workspace switch hands its tap to AppPanes, which slides both
//     panes side by side (startAppSlide), and the page changes once they have landed.
//
// Everything here is a no-op while Lamo Stories is switched off: no pane is around anything, `active` is always true,
// `hosted` always false, Clip Factory is always on screen, clipsGoLater is exactly navigate and html.see-through is
// exactly Clip Factory's own wish.
import { createContext, useContext, useSyncExternalStore } from "react";
import { navigate } from "../lib/router.ts";
import { storiesEnabled } from "../stories/flag.ts";
import { isStoriesPath } from "../stories/routes.ts";

export type AppName = "clips" | "stories";

export interface AppPane {
  /** This app is the one on screen (always true while Lamo Stories is switched off). */
  active: boolean;
  /** Clip Factory's shell is mounted too. */
  clipsMounted: boolean;
  /** The shell hosts this app next to the other one: the workspace switch and the Live chip are the shell's. */
  hosted: boolean;
}

const OFF: AppPane = { active: true, clipsMounted: false, hosted: false };

/** Given by AppPanes around each app's pane; outside a pane (always, while Lamo Stories is off) it is OFF. */
export const PaneContext = createContext<AppPane>(OFF);

export function useAppPane(): AppPane {
  return useContext(PaneContext);
}

/** Whether the app this component belongs to is on screen. True whenever Lamo Stories is switched off. */
export function useAppActive(): boolean {
  return useContext(PaneContext).active;
}

/** The shell hosts this app next to the other one: it draws the switch and the Live chip, the app leaves room. */
export function useShellHosted(): boolean {
  return useContext(PaneContext).hosted;
}

/** A Lamo Stories page is on screen (never while Lamo Stories is switched off). */
export function storiesOnScreen(): boolean {
  return typeof location !== "undefined" && isStoriesPath(location.pathname) && storiesEnabled();
}

/**
 * Clip Factory is not the app on screen (a Lamo Stories page is). Clip Factory's pages kept behind Lamo Stories stay
 * quiet then: no page change, no toast, no sound, no confetti of their own. Always false while Lamo Stories is off.
 */
export function clipsHidden(): boolean {
  return storiesOnScreen();
}

type ParkedGo = { to: string; replace: boolean; force: boolean };
let parkedClips: ParkedGo | null = null;

/**
 * A Clip Factory page change that comes after a wait (a campaign added, a skill saved), not with the owner's own tap.
 * While Lamo Stories is on screen it waits, and happens the moment Clip Factory is back on screen (App.tsx), so the
 * owner is never moved out of Lamo Stories, the stored workspace choice stays his, and Lamo Stories' own history entry
 * and its "Leave without saving?" are never touched. Otherwise (and always while Lamo Stories is off) exactly
 * navigate(to, opts).
 */
export function clipsGoLater(to: string, opts: { replace?: boolean; force?: boolean } = {}): void {
  if (clipsHidden()) parkedClips = { to, replace: !!opts.replace, force: !!opts.force };
  else navigate(to, opts);
}

/** The Clip Factory page change that waited while Lamo Stories was on screen (once: forgotten as it is read). */
export function takeParkedClipsGo(): ParkedGo | null {
  const held = parkedClips;
  parkedClips = null;
  return held;
}

// ---------- The Lamo Stories workspace on screen (the shell's switch marks it) ----------

let storiesWs: string | null = null;
const wsListeners = new Set<() => void>();

/** StoriesApp says which of the owner's Lamo Stories workspaces it shows (while it is on screen). */
export function setStoriesWorkspaceShown(ws: string | null): void {
  if (ws === storiesWs) return;
  storiesWs = ws;
  for (const fn of wsListeners) fn();
}

/** The Lamo Stories workspace StoriesApp shows (null until it has picked one this visit). */
export function useStoriesWorkspaceShown(): string | null {
  return useSyncExternalStore(
    (fn) => {
      wsListeners.add(fn);
      return () => wsListeners.delete(fn);
    },
    () => storiesWs,
    () => null,
  );
}

// ---------- Clip Factory's search, kept while it is hidden (§45.35 D18) ----------

/** The search of Clip Factory's kept route, given by the shell around Clip Factory's pane (null: no pane around). */
const KeptSearch = createContext<string | null>(null);

/** Gives Clip Factory's pane the search of the page it keeps (App.tsx, only while Lamo Stories is switched on). */
export const KeptSearchProvider = KeptSearch.Provider;

/**
 * The address's search for a Clip Factory screen: exactly `window.location.search` when no pane is around it (always,
 * while Lamo Stories is switched off), and the search of Clip Factory's own kept page inside its pane, so a page kept
 * behind Lamo Stories still reads its own address, not Lamo Stories'.
 */
export function useKeptSearch(): string {
  const kept = useContext(KeptSearch);
  if (kept !== null) return kept;
  return typeof location === "undefined" ? "" : location.search;
}

// ---------- The page's own glass: html.see-through, the shell's (from the wish of the app on screen) ----------

/** The app the shell shows: AppPanes says, as it switches (always Clip Factory while Lamo Stories is switched off). */
let onScreen: AppName = "clips";
const screenListeners = new Set<() => void>();
/** What each app wants while it is on screen: the page itself transparent (the desktop window's glass shows). */
const pageGlass: Record<AppName, boolean> = { clips: false, stories: false };

function writePageGlass(root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  root?.classList.toggle("see-through", pageGlass[onScreen]);
}

/**
 * An app says whether it wants the page itself transparent while it is on screen (html.see-through: the desktop
 * window's own glass shows the desktop): Clip Factory from its Look (lib/look.ts applyLook), Lamo Stories from its own
 * (stories/look.ts). Only the shell writes the class, from the wish of the app on screen, so neither app ever reads,
 * keeps or takes away the other's: a wish stated while the other app is on screen waits, and is the page's the moment
 * its app is back. While Lamo Stories is switched off this is exactly Clip Factory's own toggle.
 */
export function setPageGlass(app: AppName, on: boolean, root?: HTMLElement): void {
  pageGlass[app] = on;
  writePageGlass(root);
}

/** The shell says which app it shows (AppPanes, as it switches; Clip Factory again once the panes are gone). */
export function setAppOnScreen(app: AppName): void {
  const changed = app !== onScreen;
  onScreen = app;
  writePageGlass();
  if (changed) for (const fn of screenListeners) fn();
}

/** The app the shell shows now (always "clips" while Lamo Stories is switched off). */
export function appOnScreen(): AppName {
  return onScreen;
}

/** Re-renders when the shell shows the other app (App.tsx draws Clip Factory's own backdrop only while it is on screen). */
export function useAppOnScreen(): AppName {
  return useSyncExternalStore(
    (fn) => {
      screenListeners.add(fn);
      return () => screenListeners.delete(fn);
    },
    () => onScreen,
    () => "clips" as const,
  );
}

// ---------- The sliding window between the two apps (AppPanes runs it, the workspace switch starts it) ----------

/**
 * How long the two panes slide, and the workspace switch's lens with them (its Glide is given this length), on the
 * app's slow-in slow-out curve (appSlideEase), so the whole switch reads as one move.
 */
export const APP_SLIDE_MS = 450;
/** The slow-in slow-out curve (tokens.css --ease-in-out), until the page's own has been read. */
export const APP_SLIDE_EASE = "cubic-bezier(0.65, 0, 0.35, 1)";

let slideCurve: string | null = null;

/**
 * The curve the whole switch moves on (the owner, 23 Nov: "make sure the switch between clip factory and clips funded
 * uses slow in slow out effect when switching between them"): tokens.css --ease-in-out, which starts gently, speeds up
 * in the middle and settles gently. Both panes' slide and the switch's lens use it (the lens through .glide--ws's
 * --glide-ease, the same token). Read once from the page, ahead of a tap (prepareAppSlide), so a tap never styles the
 * page to read it.
 */
export function appSlideEase(): string {
  if (slideCurve) return slideCurve;
  const own = typeof getComputedStyle === "function" && typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue("--ease-in-out").trim() : "";
  if (!own) return APP_SLIDE_EASE;
  return (slideCurve = own);
}
/** The id of the panes' Web Animations (e2e/stories-switch-slide.spec.ts finds them by it). */
export const APP_SLIDE_ID = "app-slide";

/**
 * One slide from the app on screen to the other: Clip Factory on the left, Clips Funded on the right, both panes the
 * size of the window and moved by transform alone. The page changes only once it has landed (the switch then calls
 * settle, which puts the panes back at rest: the new one in place, or the old one again if the page did not change).
 */
export interface AppSlide {
  /** The app it slides to. */
  readonly to: AppName;
  /** True once both panes have landed; false when it was sent back or cut short (nothing to do then). */
  readonly landed: Promise<boolean>;
  /** The switch was made (or held): the panes come to rest on the app now on screen. */
  settle(): void;
  /** Tapped back during the slide: both panes slide back to where they were, and nothing changes. */
  back(): void;
}

/** What AppPanes gives the shell while both apps sit in their panes. */
export interface AppSlider {
  /** The pointer or the keyboard came to a way to `to`: its pane is mounted now (hidden), so the tap finds it ready. */
  prepare(to: AppName): void;
  /** Starts the slide to `to`, whose page will be `path`; null when there is nothing to slide (the caller switches at once). */
  start(to: AppName, path: string): AppSlide | null;
  /** A slide is under way. */
  busy(): boolean;
}

let slider: AppSlider | null = null;

/** AppPanes says it is there (and returns the function that says it is gone). */
export function setAppSlider(s: AppSlider): () => void {
  slider = s;
  return () => {
    if (slider === s) slider = null;
  };
}

/** Mounts `to`'s pane ahead of a tap (nothing while Lamo Stories is switched off, or for the app on screen). */
export function prepareAppSlide(to: AppName): void {
  appSlideEase();
  slider?.prepare(to);
}

/**
 * Slides the whole app to `to` (whose page will be `path`), from this tap. Null when nothing slides: Lamo Stories is
 * switched off, `to` is on screen already, a slide is under way, the window is hidden, or the browser has no Web
 * Animations. The caller decides calm motion and "Leave without saving?" before (neither ever slides).
 */
export function startAppSlide(to: AppName, path: string): AppSlide | null {
  return slider?.start(to, path) ?? null;
}

/** A slide between the two apps is under way. */
export function appSliding(): boolean {
  return slider?.busy() ?? false;
}
