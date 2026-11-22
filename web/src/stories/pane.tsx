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
//
// Round 4 (§45.35 D16, D17, D18): each pane has its own error boundary, so one app breaking never takes the other
// with it (Lamo Stories' own card is StoriesPaneBoundary below; Clip Factory's pane keeps Clip Factory's own
// boundary and fallback, App.tsx); a pane that is hidden has every playing video and sound in it paused; Clip
// Factory's pane carries the search of its kept route (useKeptSearch), so Home opened for a campaign is kept across a
// round trip; and a Lamo Stories redirect to another site that comes after a wait (Connect) waits while Clip Factory
// is on screen.
import { Component, createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { Button, Empty } from "../components/ui.tsx";
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

let parkedAway: { url: string; expiresAt: string | null } | null = null;

/**
 * A Lamo Stories move to another site that comes after a wait (Connect's sign-in page, once the server gave its
 * address): while Clip Factory is on screen it waits, and goes the moment Lamo Stories is back (StoriesApp), so the
 * owner is never taken out of Clip Factory. `expiresAt` is when the address stops working (Connect's sign-in state is
 * good for 10 minutes, §45.13.2): one that ran out while it waited is never opened.
 */
export function storiesAwayLater(url: string, expiresAt: string | null = null, go: (url: string) => void = (u) => location.assign(u)): void {
  if (storiesBehind()) parkedAway = { url, expiresAt };
  else go(url);
}

/**
 * The move to another site that waited while Clip Factory was on screen (once: it is forgotten as it is read), else
 * null. `expired` is true when its address ran out while it waited (then it must not be opened).
 */
export function takeParkedStoriesAway(now: number = Date.now()): { url: string; expired: boolean } | null {
  const held = parkedAway;
  parkedAway = null;
  if (!held) return null;
  const until = held.expiresAt ? Date.parse(held.expiresAt) : Number.NaN;
  return { url: held.url, expired: Number.isFinite(until) && now >= until };
}

/** What Lamo Stories says when a held sign-in page ran out before it was back on screen. */
export const AWAY_RAN_OUT = "That sign-in link ran out. Tap Connect again.";

// ---------- Clip Factory's search, kept while it is hidden (§45.35 D18) ----------

/** The search of Clip Factory's kept route, given by BothApps around Clip Factory's pane (null: no pane around). */
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

/** Pauses every video and sound playing inside `box` (a pane just hidden keeps quiet, §45.35 D17). */
export function pauseMediaIn(box: HTMLElement | null): number {
  if (!box) return 0;
  let n = 0;
  for (const m of Array.from(box.querySelectorAll<HTMLMediaElement>("video, audio"))) {
    if (m.paused) continue;
    try {
      m.pause();
      n++;
    } catch {
      // A media element that cannot pause (not loaded yet) makes no sound either.
    }
  }
  return n;
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
    // The app now hidden makes no sound: its playing videos and sounds pause (they stay where they were).
    pauseMediaIn((hidden === "clips" ? clipsBox : storiesBox).current);
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

// ---------- Lamo Stories' own error boundary (§45.35 D16) ----------

interface StoriesBoundaryProps {
  children: ReactNode;
  /** Go to Clip Factory: the stored choice says Clip Factory, then its last page opens (App.tsx gives it). */
  onClips: () => void;
}

/**
 * Around Lamo Stories' pane: a render error anywhere in Lamo Stories (its shell, its navigation, its chunk that did
 * not load) shows Lamo Stories' own card, "Lamo Stories had a problem.", and never reaches Clip Factory. Try again
 * mounts Lamo Stories afresh (a new lazy app, so a chunk that failed is fetched again); Go to Clip Factory opens Clip
 * Factory's last page. Lamo Stories' styles may not have loaded, so the card is drawn with Clip Factory's own parts.
 */
export class StoriesPaneBoundary extends Component<StoriesBoundaryProps, { failed: boolean; attempt: number }> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    return <StoriesProblem onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} onClips={this.props.onClips} />;
  }
}

/** Centred in the window, as Clip Factory's start-up card is (its own box, so nothing waits for a "boot" to end). */
const PROBLEM_BOX: CSSProperties = { display: "grid", placeItems: "center", minHeight: "100dvh", padding: 24 };

/** Lamo Stories' own card when it broke (the page's main landmark only while its pane is on screen). */
function StoriesProblem({ onRetry, onClips }: { onRetry: () => void; onClips: () => void }) {
  const active = useAppActive();
  return (
    <main style={PROBLEM_BOX} id={active ? "main" : undefined} data-stories-problem="">
      <h1 className="sr-only">Lamo Stories had a problem</h1>
      <Empty
        icon="alert"
        title="Lamo Stories had a problem."
        heading="h2"
        action={
          <>
            <Button variant="primary" icon="retry" act="retry" onClick={onRetry}>
              Try again
            </Button>
            <Button icon="home" onClick={onClips}>
              Go to Clip Factory
            </Button>
          </>
        }
      >
        Tap Try again. Clip Factory is fine: tap Go to Clip Factory to keep working there.
      </Empty>
    </main>
  );
}
