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
//   - the search of Clip Factory's kept page while it is hidden (useKeptSearch, §45.35 D18).
//
// Everything here is a no-op while Lamo Stories is switched off: no pane is around anything, `active` is always true,
// `hosted` always false, Clip Factory is always on screen and clipsGoLater is exactly navigate.
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
