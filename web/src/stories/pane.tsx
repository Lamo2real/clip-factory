// The shell between the two apps (docs/CONTRACTS.md §45.34, request 2 §2: "When I return to Clip Factory, I should
// see the existing application exactly as I left it"; "Switching should be immediate"). Only used while Lamo Stories
// is switched on: then each app, once it has been shown, stays mounted, and the one not on screen is `hidden` and
// `inert`, so its pages, filters, loaded lists, open panels and typing are all there again at once. The `active`
// flag the panes give (true when Lamo Stories is off, and everywhere outside the panes) keeps the hidden app's title,
// focus moves and measuring quiet; while Clip Factory is hidden its window key handlers (Jobs' Escape) hear nothing.
// An app is not kept when it is hidden with one of its dialogs open, or on a page that asks "Leave without saving?"
// (the contract never keeps open sheets or unsaved drafts across a switch): it opens fresh the next time.
//
// Lamo Clips' main bundle imports this file (App.tsx, Nav.tsx): it carries no Lamo Stories screen, style or
// engine code. StoriesApp itself loads in its own chunk (loadStoriesApp), fetched while the browser is idle once the
// switcher is on screen (prefetchStoriesApp), so the first switch does not wait for it either.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { storiesEnabled } from "./flag.ts";
import { isStoriesPath } from "./routes.ts";

export type AppName = "clips" | "stories";

export interface AppPane {
  /** This app is the one on screen (always true while Lamo Stories is switched off). */
  active: boolean;
  /** Clip Factory's shell is mounted too (it then runs the Mac download host and the app badge for both). */
  clipsMounted: boolean;
}

const OFF: AppPane = { active: true, clipsMounted: false };
const PaneContext = createContext<AppPane>(OFF);

export function useAppPane(): AppPane {
  return useContext(PaneContext);
}

/** Whether the app this component belongs to is on screen. True whenever Lamo Stories is switched off. */
export function useAppActive(): boolean {
  return useContext(PaneContext).active;
}

/** A Lamo Stories page is on screen (never while Lamo Stories is switched off). */
export function storiesOnScreen(): boolean {
  return typeof location !== "undefined" && isStoriesPath(location.pathname) && storiesEnabled();
}

/**
 * Lamo Stories is switched on and Clip Factory is on screen. Lamo Stories' pages kept behind it stay quiet then: no
 * sound, no confetti, no page change of their own (never false alarms while Lamo Stories is switched off).
 */
export function storiesBehind(): boolean {
  return storiesEnabled() && typeof location !== "undefined" && !isStoriesPath(location.pathname);
}

let parked: string | null = null;

/**
 * A Lamo Stories page change that comes after a wait (a save that answered, a timer), not with the owner's own tap.
 * While Clip Factory is on screen it waits and happens the moment Lamo Stories is back (StoriesApp), so the owner is
 * never moved out of Clip Factory and Clip Factory's history entry stays his.
 */
export function storiesGoLater(to: string, opts: { replace?: boolean } = {}): void {
  if (storiesBehind()) parked = to;
  else navigate(to, opts);
}

/** The page change that waited while Clip Factory was on screen (once: it is forgotten as it is read), else null. */
export function takeParkedStoriesGo(): string | null {
  const to = parked;
  parked = null;
  return to;
}

// ---------- StoriesApp's own chunk ----------

type StoriesModule = typeof import("./StoriesApp.tsx");
let chunk: Promise<StoriesModule> | null = null;
let loaded: StoriesModule | null = null;

/** Loads StoriesApp's chunk once (App.tsx's lazy StoriesApp and the idle prefetch share it). */
export function loadStoriesApp(): Promise<StoriesModule> {
  chunk ??= import("./StoriesApp.tsx").then(
    (m) => (loaded = m),
    (e: unknown) => {
      chunk = null;
      throw e;
    },
  );
  return chunk;
}

/** StoriesApp's module when its chunk is already here (then it opens with no wait at all), else null. */
export function storiesModule(): StoriesModule | null {
  return loaded;
}

let prefetching = false;

/** Fetches StoriesApp's chunk while the browser is idle (once per visit; only while Lamo Stories is switched on). */
export function prefetchStoriesApp(): void {
  if (prefetching || loaded || !storiesEnabled() || typeof window === "undefined") return;
  prefetching = true;
  const go = () =>
    void loadStoriesApp().catch(() => {
      // Offline: the first switch loads it, as before.
      prefetching = false;
    });
  const idle = (window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(go, { timeout: 4000 });
  else setTimeout(go, 1200);
}

/** Test hook: forget the chunk and the prefetch. */
export function resetStoriesChunk(): void {
  chunk = null;
  loaded = null;
  prefetching = false;
}

// ---------- The two panes ----------

/** A pane on screen takes no box of its own, so the app inside lays out exactly as it does without it. */
const SHOWN: CSSProperties = { display: "contents" };

/** Any dialog open now outside `shown` (the pane just put on screen): one of the app that was just hidden. */
function dialogOpenOutside(shown: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !shown?.contains(el));
}

/**
 * Both apps, each in its pane: `on` is the one on screen. An app is mounted from the first time it is shown, and then
 * stays (unless it was hidden with a dialog open, or `fresh` names it: then it opens fresh next time).
 */
export function AppPanes({ on, clips, stories, fresh = null }: { on: AppName; clips: ReactNode; stories: ReactNode; fresh?: AppName | null }) {
  const [shown, setShown] = useState<Record<AppName, boolean>>(() => ({ clips: on === "clips", stories: on === "stories" }));
  if (!shown[on]) setShown((s) => ({ ...s, [on]: true }));
  // An app that starts fresh is let go the moment it is hidden: it never draws behind the other one, even once.
  if (fresh !== null && fresh !== on && shown[fresh]) setShown((s) => ({ ...s, [fresh]: false }));
  const clipsBox = useRef<HTMLDivElement>(null);
  const storiesBox = useRef<HTMLDivElement>(null);
  const was = useRef(on);

  // Just switched: the app now hidden is kept, unless it was left with a dialog open (a page that starts fresh is
  // already let go above).
  useLayoutEffect(() => {
    const hidden = was.current;
    was.current = on;
    if (hidden === on) return;
    if (dialogOpenOutside((on === "clips" ? clipsBox : storiesBox).current)) setShown((s) => ({ ...s, [hidden]: false }));
  }, [on]);

  // Clip Factory hidden: a key press stops at the document, so Clip Factory's window key handlers (Jobs' Escape, which
  // ends Select) hear nothing from Lamo Stories. React's own handlers and every capture listener still get it.
  const clipsHidden = shown.clips && on !== "clips";
  useEffect(() => {
    if (!clipsHidden) return;
    const quiet = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener("keydown", quiet);
    return () => document.removeEventListener("keydown", quiet);
  }, [clipsHidden]);

  const pane = (app: AppName, node: ReactNode) => {
    if (!shown[app]) return null;
    const active = on === app;
    return (
      <PaneContext.Provider value={{ active, clipsMounted: shown.clips }}>
        <div ref={app === "clips" ? clipsBox : storiesBox} data-app-pane={app} hidden={!active} inert={!active} style={active ? SHOWN : undefined}>
          {node}
        </div>
      </PaneContext.Provider>
    );
  };
  return (
    <>
      {pane("clips", clips)}
      {pane("stories", stories)}
    </>
  );
}
