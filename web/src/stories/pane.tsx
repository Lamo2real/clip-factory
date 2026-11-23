// The shell between the two apps (docs/CONTRACTS.md §45.34, request 2 §2: "When I return to Clip Factory, I should
// see the existing application exactly as I left it"; "Switching should be immediate"). Only used while Lamo Stories
// is switched on: then each app, once it has been shown, stays mounted, and the one not on screen is `hidden` and
// `inert`, so its pages, filters, loaded lists, open panels and typing are all there again at once. The `active`
// flag the panes give (true when Lamo Stories is off, and everywhere outside the panes) keeps the hidden app's title,
// focus moves and measuring quiet; while Clip Factory is hidden its window key handlers (Jobs' Escape) hear nothing.
// An app is not kept when it is hidden with one of its dialogs open, or on a page that asks "Leave without saving?"
// (the contract never keeps open sheets or unsaved drafts across a switch): it opens fresh the next time.
//
// Lamo Clips' main bundle imports this file (the shell: App.tsx and its workspace switch, app/WorkspaceDock.tsx): it
// carries no Lamo Stories screen, style or engine code. StoriesApp itself loads in its own chunk (loadStoriesApp),
// fetched while the browser is idle once the switch is on screen, and at once when the pointer or the keyboard comes
// to its Lamo Stories choice (prefetchStoriesApp, preloadStoriesApp), so the first switch does not wait for it.
//
// Round 4 (§45.35 D16, D17, D18): each pane has its own error boundary, so one app breaking never takes the other
// with it (Lamo Stories' own card is StoriesPaneBoundary below; Clip Factory's pane keeps Clip Factory's own
// boundary and fallback, App.tsx); a pane that is hidden has every playing video and sound in it paused; Clip
// Factory's pane carries the search of its kept route (useKeptSearch), so Home opened for a campaign is kept across a
// round trip; and a Lamo Stories redirect to another site that comes after a wait (Connect) waits while Clip Factory
// is on screen.
//
// The sliding window (the owner, 23 Nov: "id like the transission between clip factory and clips funded to be like a
// sliding window"): a switch to the other app slides the whole app, Clip Factory on the left and Clips Funded on the
// right. Going to Clips Funded, Clip Factory's pane slides out to the left while Clips Funded's slides in from the right;
// going back, the other way. Both panes move on the slow-in slow-out curve (the owner, 23 Nov: "make sure the switch
// between clip factory and clips funded uses slow in slow out effect when switching between them"; tokens.css
// --ease-in-out), as the switch's lens does, for the same length, from the same tap. The shell's dock (the switch and
// the Live chip) is outside both panes and stays where it is. The pane coming in is mounted before the tap (the pointer
// or the keyboard coming to its choice), at its kept page and its kept scroll; one that is not ready yet slides in as
// its loading card. Only for the slide do both panes take a box, the size of the window, each showing its page where
// it is scrolled to, moved by transform alone (no layout during it), with will-change only then; the page changes
// once they have landed, and everything is back at rest in that same task. Calm motion never slides.
import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button, Empty } from "../components/ui.tsx";
import { navigate } from "../lib/router.ts";
import { APP_SLIDE_ID, APP_SLIDE_MS, appSlideEase, PaneContext, setAppOnScreen, setAppSlider, useAppActive, type AppName, type AppPane, type AppSlide } from "../app/shell.ts";
import { storiesEnabled } from "./flag.ts";
import { isStoriesPath } from "./routes.ts";
import { saveClipsScroll, saveStoriesScroll, takeClipsScroll, takeStoriesScroll } from "./workspace.ts";

// The pane's context, which app is on screen and Clip Factory's kept search are the shell's own (app/shell.ts, which
// both apps import); they are named here too for Lamo Stories' screens and the tests that read them from this file.
export { KeptSearchProvider, PaneContext, storiesOnScreen, useAppActive, useAppPane, useKeptSearch, type AppName, type AppPane } from "../app/shell.ts";

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

/**
 * Fetches StoriesApp's chunk now: the pointer or the keyboard came to the switch's Lamo Stories choice, so the tap that
 * follows finds it here (nothing is parsed during the switch's slide). Quiet when it cannot load (offline: the switch
 * itself loads it again).
 */
export function preloadStoriesApp(): void {
  if (loaded || !storiesEnabled()) return;
  void loadStoriesApp().catch(() => undefined);
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

// ---------- The sliding window ----------

/** Clip Factory sits on the left and Clips Funded on the right: going to Clips Funded, everything moves left. */
const SIDE: Record<AppName, number> = { clips: 0, stories: 1 };

/**
 * Where the page coming in will be scrolled to once it is on screen: the place kept for it when the owner left it
 * (workspace.ts). Read without using it up (it is put back at once), so the app still puts its own page back there.
 */
function keptScroll(app: AppName, path: string): number {
  const y = app === "clips" ? takeClipsScroll(path) : takeStoriesScroll(path);
  if (y === null) return 0;
  if (app === "clips") saveClipsScroll(path, y);
  else saveStoriesScroll(path, y);
  return y;
}

/** A slide under way, as AppPanes keeps it: the handle the switch holds, and how to bring it to rest. */
interface Running {
  slide: AppSlide;
  /** Everything back at rest, `app` on screen (the app it slid to, or the one it came from). */
  rest(app: AppName): void;
}

/**
 * Both apps, each in its pane: `on` is the one on screen. An app is mounted from the first time it is shown, and then
 * stays (unless it was hidden with a dialog open, or `fresh` names it: then it opens fresh next time). An app can also
 * be mounted a moment before it is shown (the pointer came to the switch's way there), so a slide finds it ready.
 * `alsoSlides` names what an app draws outside its pane that slides with it (Clip Factory's own backdrop: each app
 * slides with its own background, and it is drawn for the slide even while Clips Funded is on screen).
 */
export function AppPanes({
  on,
  clips,
  stories,
  fresh = null,
  alsoSlides,
}: {
  on: AppName;
  clips: ReactNode;
  stories: ReactNode;
  fresh?: AppName | null;
  alsoSlides?: Partial<Record<AppName, () => HTMLElement | null>>;
}) {
  const [shown, setShown] = useState<Record<AppName, boolean>>(() => ({ clips: on === "clips", stories: on === "stories" }));
  /** The app a slide is on its way to (mounted for it, though not on screen yet). */
  const slidingTo = useRef<AppName | null>(null);
  if (!shown[on]) setShown((s) => ({ ...s, [on]: true }));
  // An app that starts fresh is let go the moment it is hidden: it never draws behind the other one, even once (only
  // while it slides in is it mounted before it is on screen).
  if (fresh !== null && fresh !== on && fresh !== slidingTo.current && shown[fresh]) setShown((s) => ({ ...s, [fresh]: false }));
  const clipsBox = useRef<HTMLDivElement>(null);
  const storiesBox = useRef<HTMLDivElement>(null);
  const was = useRef(on);
  const running = useRef<Running | null>(null);
  // What the slider reads when the switch calls it (outside React's render).
  const now = useRef({ on, shown, fresh, alsoSlides });
  now.current = { on, shown, fresh, alsoSlides };

  // The app on screen is the shell's to say (app/shell.ts): Clip Factory's own backdrop is drawn only while it is
  // (app/ClipsBackdrop.tsx), and html.see-through is the wish of the app on screen, before the first frame of a switch.
  useLayoutEffect(() => setAppOnScreen(on), [on]);
  useLayoutEffect(() => () => setAppOnScreen("clips"), []);

  // The sliding window, for the shell's switch (app/shell.ts startAppSlide).
  useLayoutEffect(() => {
    const box = (app: AppName) => (app === "clips" ? clipsBox : storiesBox).current;
    const unset = setAppSlider({
      busy: () => running.current !== null,
      prepare(to) {
        // The slow-in slow-out curve is read now, while nothing in the page waits to be styled (read after the panes
        // change, it would style the whole page coming in inside the tap's own task).
        appSlideEase();
        const { on: at, shown: has, fresh: anew } = now.current;
        // An app that opens fresh is mounted only by the slide itself (it never waits behind the other one).
        if (to === at || has[to] || to === anew) return;
        setShown((s) => (s[to] ? s : { ...s, [to]: true }));
      },
      start(to, path) {
        const from = now.current.on;
        if (to === from || running.current || typeof document === "undefined" || document.hidden) return null;
        const out = box(from);
        if (!out || typeof out.animate !== "function") return null;
        if (!now.current.shown[to]) {
          // Not mounted yet (no pointer came near the choice before): it mounts now, its loading card if its code is
          // not here yet, and slides in as it is.
          slidingTo.current = to;
          flushSync(() => setShown((s) => ({ ...s, [to]: true })));
        }
        const inn = box(to);
        if (!inn) {
          slidingTo.current = null;
          return null;
        }
        slidingTo.current = to;
        const root = document.documentElement;
        const step = SIDE[to] > SIDE[from] ? -100 : 100;
        const parts: { el: HTMLElement; from: number; to: number }[] = [
          { el: out, from: 0, to: step },
          { el: inn, from: -step, to: 0 },
        ];
        const anims: Animation[] = [];
        let state: "running" | "landed" | "back" | "done" = "running";
        let resolve: (ok: boolean) => void = () => undefined;
        const landed = new Promise<boolean>((r) => (resolve = r));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let fromY = 0;
        let toY = 0;
        let minHeight = "";

        const rest = (app: AppName) => {
          if (state === "done") return;
          const began = anims.length > 0;
          state = "done";
          clearTimeout(timer);
          resolve(false);
          running.current = null;
          slidingTo.current = null;
          if (began) {
            for (const a of anims) a.cancel();
            for (const p of parts) {
              p.el.removeAttribute("data-app-slide");
              p.el.style.removeProperty("--app-pane-y");
            }
            root.style.minHeight = minHeight;
            // The app on screen is back in the page's flow, where its pane showed it: the window scrolls there now,
            // before the next frame (the app's own scroll keeping then finds it there already).
            const y = app === to ? toY : fromY;
            if (Math.abs(window.scrollY - y) > 0.5) window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
          }
          // Sent back from an app that opens fresh: it is let go again.
          if (app !== to && now.current.fresh === to) setShown((s) => ({ ...s, [to]: false }));
        };

        // The panes change once the switch's highlight has measured where it goes (Glide reads the bar's layout in the
        // microtask its class change queued, before this one), so that read never waits for two pages to be laid
        // out; the page is laid out once, for the first frame of both slides.
        queueMicrotask(() => {
          if (state !== "running") return;
          // Everything is read, and the slides made, while the page is still styled and laid out as Glide measured it:
          // a Web Animation made after the panes change would style the whole page coming in inside the tap's own task
          // (it is styled once, for the first frame).
          const easing = appSlideEase();
          fromY = window.scrollY;
          toY = keptScroll(to, path);
          const wanted = toY;
          const height = root.scrollHeight;
          for (const app of [from, to]) {
            const el = now.current.alsoSlides?.[app]?.();
            if (!el || out.contains(el) || inn.contains(el)) continue;
            parts.push(app === from ? { el, from: 0, to: step } : { el, from: -step, to: 0 });
          }
          const timing: KeyframeAnimationOptions = { duration: APP_SLIDE_MS, easing, fill: "both", id: APP_SLIDE_ID };
          for (const p of parts) anims.push(p.el.animate([{ transform: `translateX(${p.from}%)` }, { transform: `translateX(${p.to}%)` }], timing));
          // Both panes leave the page's flow for the slide: the page keeps its height, so the window's scroll stays.
          minHeight = root.style.minHeight;
          root.style.minHeight = `${height}px`;
          out.style.setProperty("--app-pane-y", `${fromY}px`);
          inn.style.setProperty("--app-pane-y", `${toY}px`);
          for (const p of parts) p.el.setAttribute("data-app-slide", p.el === out ? "out" : p.el === inn ? "in" : "with");
          // On the first frame the page draws after the tap: the page coming in goes as far down as it goes now (its
          // kept place, unless it got shorter), and both slides start from that frame together (as Glide does: a slide
          // left "pending" until the compositor reports back can lose its first frames on a busy machine).
          requestAnimationFrame(() => {
            if (state === "done") return;
            // The page's own height (its boxes sit toY higher in the pane), as the window will scroll it.
            const tall = Array.from(inn.children).reduce((h, c) => (c instanceof HTMLElement ? Math.max(h, c.offsetTop + c.offsetHeight) : h), 0) + toY;
            const y = Math.max(0, Math.min(wanted, Math.floor(tall - inn.clientHeight)));
            if (y !== toY) inn.style.setProperty("--app-pane-y", `${(toY = y)}px`);
            if (!anims.some((a) => a.pending) || document.timeline?.currentTime == null) return;
            const t = performance.now();
            for (const a of anims) if (a.playState === "running" && a.playbackRate > 0) a.startTime = t;
          });
          // A window hidden mid-way draws no frames, so its slide never ends: it is finished well after it would have.
          timer = setTimeout(() => {
            for (const a of anims) if (a.playState !== "finished") a.finish();
          }, APP_SLIDE_MS + 2000);
          void Promise.all(anims.map((a) => a.finished)).then(
            () => {
              if (state === "back") return rest(from);
              if (state !== "running") return;
              state = "landed";
              resolve(true);
              // The switch changes the page now (settle). Should nobody do it, the panes come to rest anyway.
              clearTimeout(timer);
              timer = setTimeout(() => rest(now.current.on), 1000);
            },
            () => undefined,
          );
        });

        const slide: AppSlide = {
          to,
          landed,
          settle: () => {
            if (state === "landed") rest(now.current.on);
          },
          back: () => {
            if (state !== "running") return;
            if (!anims.length) return rest(from);
            state = "back";
            resolve(false);
            for (const a of anims) a.reverse();
          },
        };
        running.current = { slide, rest };
        return slide;
      },
    });
    return () => {
      unset();
      running.current?.rest(now.current.on);
    };
  }, []);

  // Just switched: the app now hidden is kept, unless it was left with a dialog open (a page that starts fresh is
  // already let go above). A slide under way comes to rest with it.
  useLayoutEffect(() => {
    const hidden = was.current;
    was.current = on;
    if (hidden === on) return;
    running.current?.rest(on);
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

  // The same value until it changes: an app mounted ahead of a slide never re-renders the one on screen.
  const clipsPane = useMemo<AppPane>(() => ({ active: on === "clips", clipsMounted: shown.clips, hosted: true }), [on, shown.clips]);
  const storiesPane = useMemo<AppPane>(() => ({ active: on === "stories", clipsMounted: shown.clips, hosted: true }), [on, shown.clips]);

  const pane = (app: AppName, node: ReactNode) => {
    if (!shown[app]) return null;
    const active = on === app;
    return (
      <PaneContext.Provider value={app === "clips" ? clipsPane : storiesPane}>
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
      <h1 className="sr-only">Clips Funded had a problem</h1>
      <Empty
        icon="alert"
        title="Clips Funded had a problem."
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
