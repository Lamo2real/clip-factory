// The Lamo Stories shell (docs/CONTRACTS.md §45.16.2): its own navigation and look ("an animation studio"), the
// workspace check, the Needs you bar, then the page. Only reached while Lamo Stories is switched on
// (web/src/stories/flag.ts); Lamo Clips keeps its own Shell, untouched. The first time a studio opens, its setup
// (/stories/setup, §45.29) opens by itself, on its own without the navigation; after that it is one page among the
// others, reached from the dashboard's card until it is finished. Nothing of Clip Factory's own is shown here (its
// Ask, its setup to-do, its Content Rewards banner, its toasts and sounds); the shell draws what both apps share
// outside both panes (the workspace switch with the Live chip, the app badge, the Mac download host and the update
// bar), and this rail, top bar and every page leave the switch's box free (§45.38). The page title and the theme
// colour go back to Lamo Clips' when this is hidden or unmounts. With Clip Factory on screen it stays mounted behind it, hidden and inert
// (stories/pane.tsx, §45.34), so coming back shows the page exactly as it was; meanwhile it is quiet (no title, no
// focus move, no workspace check, no dashboard poll). Its workspace is picked at once from the list the switcher
// already read, and checked again in the background. Clicks and sounds follow Lamo Stories' own sound setting
// (stories/prefs.ts).
import "./styles/stories.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api/errors.ts";
import { appSwitched, setStoriesWorkspaceShown, setSwitchBare, whenAppSlidesIn } from "../app/shell.ts";
import { TopBarSwitch } from "../app/WorkspaceDock.tsx";
import { useToast } from "../components/Toasts.tsx";
import { Glide } from "../components/Glide.tsx";
import { A } from "../components/ui.tsx";
import { STORIES_BRAND, WorkspaceMark, WorkspaceWordmark } from "../components/WorkspaceMark.tsx";
import { navigate, useHash } from "../lib/router.ts";
import { loadStoriesApi, setStoriesApi } from "./api/client.ts";
import { GlideCalm } from "../components/Glide.tsx";
import { AWAY_RAN_OUT, takeParkedStoriesAway, takeParkedStoriesGo, useAppPane } from "./pane.tsx";
import { THEME_COLOUR, useStoriesBackground } from "./look.ts";
import { addStoriesFonts } from "./fonts.ts";
import { TAB_ORB } from "./glass/index.ts";
import { followStoriesClicks, storiesReduceMotion } from "./prefs.ts";
import type { StoriesApi, Workspace } from "./api/types.ts";
import { storiesHref, type StoriesPage } from "./routes.ts";
import { CarsScreen } from "./screens/Cars.tsx";
import { CharactersScreen } from "./screens/Characters.tsx";
import { ChatScreen } from "./screens/Chat.tsx";
import { ConnectionsScreen } from "./screens/Connections.tsx";
import { DashboardScreen } from "./screens/Dashboard.tsx";
import { IdeasScreen } from "./screens/Ideas.tsx";
import { LibraryScreen } from "./screens/Library.tsx";
import { ProductionScreen } from "./screens/Production.tsx";
import { ReferencesScreen } from "./screens/References.tsx";
import { ReviewScreen } from "./screens/Review.tsx";
import { SeriesScreen } from "./screens/Series.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import { WorkspaceArt } from "./studio/art.tsx";
import type { StoriesScreenProps } from "./screens/types.ts";
import { NeedsYouBar, refreshOnboarding, StBoundary, StEmpty, StError, StIcon, StLinkButton, StLoading, useDashboard, type StIconName } from "./ui.tsx";
import {
  onChoiceChange,
  rememberStoriesPath,
  restoreScroll,
  serverWorkspaces,
  setKnownWorkspaces,
  setStoriesPrefs,
  storiesPrefs,
  storiesTitle,
  takeStoriesScroll,
  wantedStoriesWorkspace,
} from "./workspace.ts";

interface NavItem {
  label: string;
  icon: StIconName;
  page: StoriesPage;
  match: StoriesPage["name"][];
}

const NAV: NavItem[] = [
  {
    label: "Dashboard",
    icon: "home",
    page: { name: "dashboard" },
    match: ["dashboard"],
  },
  { label: "Ideas", icon: "bulb", page: { name: "ideas" }, match: ["ideas"] },
  {
    label: "Characters",
    icon: "face",
    page: { name: "characters" },
    // the cars are characters too (§45.41): their pages sit under Characters
    match: ["characters", "character", "character_new", "cars", "car_new", "car"],
  },
  {
    label: "Production",
    icon: "clapper",
    page: { name: "production" },
    match: ["production", "production_new", "production_story"],
  },
  {
    label: "Review",
    icon: "screen",
    page: { name: "review" },
    match: ["review", "review_story"],
  },
  { label: "Series", icon: "folder", page: { name: "series" }, match: ["series", "series_one"] },
  {
    label: "Chat",
    icon: "chat",
    page: { name: "chat" },
    match: ["chat", "chat_conv"],
  },
  {
    label: "References",
    icon: "film",
    page: { name: "references" },
    match: ["references", "reference"],
  },
  {
    label: "Library",
    icon: "boxes",
    page: { name: "library", kind: null, storyId: null },
    match: ["library"],
  },
  {
    label: "Social accounts",
    icon: "plug",
    page: { name: "connections", platform: null, result: null, ws: null },
    match: ["connections"],
  },
  {
    label: "Settings",
    icon: "sliders",
    page: { name: "settings", section: "ai" },
    match: ["settings", "setup"],
  },
];

/**
 * The first time (§45.29): a studio whose setup has not started (nothing done, nothing skipped, not finished) and
 * that has not opened its setup on this device yet. Only from the dashboard, the page the switch lands on first:
 * an OAuth return or a link to another page is never taken away.
 */
export function opensSetup(
  page: StoriesPage,
  ws: string,
  o: {
    done: number;
    finishedAt: string | null;
    steps: { state: string }[];
  } | null,
  shown: readonly string[],
): boolean {
  if (page.name !== "dashboard" || !o || o.finishedAt || shown.includes(ws)) return false;
  return o.done === 0 && o.steps.every((s) => s.state === "todo");
}

/** On phones the bar has room for five pages and More; More holds the rest. */
const TABS = NAV.slice(0, 5);
const MORE = NAV.slice(5);


/** Picks the workspace to show: a checked id from the server's own list, never one taken from the address alone. */
export function pickWorkspace(list: Workspace[], wanted: string | null): string | null {
  const stories = list.filter((w) => w.workspaceType === "stories");
  if (wanted && stories.some((w) => w.workspaceId === wanted)) return wanted;
  return stories[0]?.workspaceId ?? null;
}

/**
 * The workspace to open (§45.16.2): the callback's `?ws=` when it is one of the owner's Lamo Stories workspaces, else
 * the last one used on this device when it still is one, else the first.
 */
export function chooseWorkspace(list: Workspace[], fromAddress: string | null, last: string | null, skip: readonly string[] = []): string | null {
  const usable = list.filter((w) => !skip.includes(w.workspaceId));
  const stories = usable.filter((w) => w.workspaceType === "stories").map((w) => w.workspaceId);
  if (fromAddress && stories.includes(fromAddress)) return fromAddress;
  return pickWorkspace(usable, last);
}

const GONE = Symbol.for("cf.stories.watched");

/** "We could not find that workspace." on a workspace call: the list is asked again once and another one is used. */
export function isWorkspaceGone(e: unknown): boolean {
  return e instanceof ApiError && e.code === "not_found" && /could not find that workspace/i.test(e.message);
}

/** Who hears about a workspace that is gone: the mounted StoriesApp (none while Lamo Clips is on screen). */
let onGone: ((ws: string) => void) | null = null;

/** Wraps the client (once) so every screen's call that finds its workspace gone tells the shell. */
export function watchWorkspace(api: StoriesApi): StoriesApi {
  if ((api as unknown as Record<symbol, boolean>)[GONE]) return api;
  const out: Record<string | symbol, unknown> = { [GONE]: true };
  for (const [key, fn] of Object.entries(api)) {
    if (typeof fn !== "function") continue;
    out[key] = (...args: unknown[]) =>
      (fn as (...a: unknown[]) => Promise<unknown>).apply(api, args).catch((e: unknown) => {
        if (key !== "listWorkspaces" && typeof args[0] === "string" && isWorkspaceGone(e)) onGone?.(args[0]);
        throw e;
      });
  }
  return out as unknown as StoriesApi;
}

function Screen(props: StoriesScreenProps) {
  switch (props.page.name) {
    case "dashboard":
      return <DashboardScreen {...props} />;
    case "ideas":
      return <IdeasScreen {...props} />;
    case "characters":
    case "character":
    case "character_new":
      return <CharactersScreen {...props} />;
    case "cars":
    case "car_new":
    case "car":
      return <CarsScreen {...props} />;
    case "production":
    case "production_new":
    case "production_story":
      return <ProductionScreen {...props} />;
    case "review":
    case "review_story":
      return <ReviewScreen {...props} />;
    case "library":
      return <LibraryScreen {...props} />;
    case "series":
    case "series_one":
      return <SeriesScreen {...props} />;
    case "connections":
      return <ConnectionsScreen {...props} />;
    case "settings":
      return <SettingsScreen {...props} />;
    case "chat":
    case "chat_conv":
      return <ChatScreen {...props} />;
    case "references":
    case "reference":
      return <ReferencesScreen {...props} />;
    case "setup":
      return <SetupScreen {...props} />;
    default:
      return (
        <section className="st-page">
          <h1 className="sr-only">We could not find that page</h1>
          <StEmpty
            mood="think"
            tone="sky"
            title="We could not find that page"
            action={
              <StLinkButton href={storiesHref({ name: "dashboard" })} main>
                Go to the dashboard
              </StLinkButton>
            }
          >
            The link may be old or have a typo.
          </StEmpty>
        </section>
      );
  }
}

/** The brand in the rail and the phone top bar: Clip Factory's mark in Stories' colours and "Clips Funded". */
function Brand() {
  return (
    <A href="/stories" className="st-brand" aria-label={`${STORIES_BRAND} dashboard`}>
      <WorkspaceMark className="st-brand__mark" />
      <WorkspaceWordmark className="st-brand__name" />
    </A>
  );
}

/** The waiting count on Review (stories ready to watch or needing a check). */
function ReviewCount({ ws }: { ws: string | null }) {
  return ws ? <ReviewCountFor ws={ws} /> : null;
}

function ReviewCountFor({ ws }: { ws: string }) {
  const { data } = useDashboard(ws);
  const n = (data?.counts.review ?? 0) + (data?.counts.needsCheck ?? 0);
  if (n <= 0) return null;
  return (
    <span className="st-count" aria-label={`${n} waiting`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Below this width the sheets sit at the bottom of the screen, where the toasts are too. */
const PHONE_MAX = 767;
/** The action bars of Lamo Stories' sheets (the studio's and the chat's). */
const SHEET_BARS = ".st-s-sheet__actions, .st-chat-sheet__actions";

/**
 * How far above the bottom of the window the toasts go so they clear an open sheet's buttons on a phone (its action
 * bar's top, plus 8 px of air); 0 when no sheet is open, on wider screens, or for a bar that is not on screen.
 */
export function toastLift(bar: Pick<HTMLElement, "getBoundingClientRect"> | null, width: number, height: number): number {
  if (!bar || width > PHONE_MAX) return 0;
  const r = bar.getBoundingClientRect();
  if (r.height <= 0 || r.top >= height) return 0;
  return Math.max(0, Math.round(height - r.top + 8));
}

/**
 * While Lamo Stories is on screen: the page's toasts (global, Clip Factory's own stack) are lifted above an open
 * sheet's action bar on phones. It sets `st-toasts-up` and `--st-toast-lift` on the page's body, which only Lamo
 * Stories' own stylesheet reads, and takes both away when the sheet closes or Lamo Stories is hidden.
 */
function useToastLift(root: { current: HTMLElement | null }, active: boolean): void {
  useEffect(() => {
    const box = root.current;
    if (!active || !box || typeof window === "undefined") return;
    const body = document.body;
    let frame = 0;
    const measure = () => {
      const lift = toastLift(box.querySelector<HTMLElement>(SHEET_BARS), window.innerWidth, window.innerHeight);
      body.classList.toggle("st-toasts-up", lift > 0);
      if (lift > 0) body.style.setProperty("--st-toast-lift", `${lift}px`);
      else body.style.removeProperty("--st-toast-lift");
    };
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const mo = new MutationObserver(soon);
    mo.observe(box, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    // A sheet rises into place: measured again once it is there.
    box.addEventListener("animationend", soon);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener("resize", soon);
      box.removeEventListener("animationend", soon);
      body.classList.remove("st-toasts-up");
      body.style.removeProperty("--st-toast-lift");
    };
  }, [root, active]);
}

/** The workspace the switcher's list already names (null until the server answered this visit). */
function quickWorkspace(fromAddress: string | null): string | null {
  const list = serverWorkspaces();
  return list ? chooseWorkspace(list, fromAddress, wantedStoriesWorkspace()) : null;
}

export function StoriesApp({ page }: { page: StoriesPage }) {
  // Its own fonts, put on the page by the first Stories screen drawn (never by the prefetched chunk: stories/fonts.ts):
  // on screen, or the moment a slide brings it in. Mounted ahead of a tap behind Clip Factory (the pointer came to the
  // switch), it waits, so Clip Factory's words on screen are never painted again by a face arriving.
  const { active, hosted } = useAppPane();
  useLayoutEffect(() => (active || !hosted ? addStoriesFonts() : whenAppSlidesIn("stories", () => addStoriesFonts())), [active, hosted]);
  // Its sliding highlights follow Lamo Stories' own calm-motion switch, never Clip Factory's once it has its own.
  return (
    <GlideCalm.Provider value={storiesReduceMotion}>
      <StoriesShell page={page} />
    </GlideCalm.Provider>
  );
}

function StoriesShell({ page }: { page: StoriesPage }) {
  // On screen (Clip Factory's shell may stay mounted behind it, and this one behind Clip Factory: stories/pane.tsx).
  const { active } = useAppPane();
  const fromAddress = page.name === "connections" ? page.ws : null;
  const [ws, setWs] = useState<string | null>(() => quickWorkspace(fromAddress));
  // Mounted ahead of a slide, hidden behind Clip Factory (stories/pane.tsx), its workspace was chosen then. Coming on
  // screen it opens the one the switcher picked since (§45.35 D19: Studio 3 from a list of four), chosen in this same
  // render, so nothing on screen remembers the old one first (the remembering below would write it back as the choice).
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    const quick = active ? quickWorkspace(fromAddress) : null;
    if (quick && quick !== ws) setWs(quick);
  }
  const [problem, setProblem] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  /** The setup opened by itself: it shows on its own until the owner leaves it. */
  const [alone, setAlone] = useState(false);
  const tried = useRef<Set<string>>(new Set());
  const main = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const hash = useHash();
  const toast = useToast();
  const pageKey = JSON.stringify(page);
  // The background behind the glass (Stories › Settings › Look, the glass contract): data-look and the veils on the root.
  useStoriesBackground(root, active);

  const check = useCallback(
    async (skip: string[] = []) => {
      const api = await loadStoriesApi();
      const list = await api.listWorkspaces();
      setKnownWorkspaces(list);
      return chooseWorkspace(list, fromAddress, wantedStoriesWorkspace(), skip);
    },
    [fromAddress],
  );

  // The workspace check (§45.16.2, §45.34): at once from the list the switcher already read, then the server's list
  // again in the background, which wins when it disagrees (before the first screen when there is no list yet).
  // listWorkspaces also makes "Lamo Stories" on first use. While Clip Factory is on screen it rests; coming back
  // checks again.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const run = () => {
      const quick = quickWorkspace(fromAddress);
      if (quick) {
        setWs(quick);
        setProblem(null);
      }
      check()
        .then((id) => {
          if (!live) return;
          if (id) {
            setWs(id);
            setProblem(null);
          } else setProblem("Clips Funded is not ready yet. Try again in a minute.");
        })
        .catch(() => live && !quick && setProblem("Clips Funded could not load. Check that you are online, then try again."));
    };
    run();
    // The switcher picked another Lamo Stories workspace: check again.
    const off = onChoiceChange(run);
    return () => {
      live = false;
      off();
    };
  }, [check, active, fromAddress]);

  // A screen found its workspace gone: ask for the list once more and use another one (once per id).
  useEffect(() => {
    let live = true;
    void loadStoriesApi().then((api) => {
      const watched = watchWorkspace(api);
      if (watched !== api) setStoriesApi(watched);
    });
    onGone = (gone) => {
      if (tried.current.has(gone)) return;
      tried.current.add(gone);
      void check([...tried.current])
        .then((id) => {
          if (!live) return;
          if (id) setWs(id);
          else setProblem("We could not find that workspace. Reload the page to try again.");
        })
        .catch(() => live && setProblem("Clips Funded could not load. Check that you are online, then try again."));
    };
    return () => {
      live = false;
      onGone = null;
    };
  }, [check]);

  // Every Lamo Stories page is where switching back lands, and the shell's switch marks the workspace shown.
  useEffect(() => {
    if (active && ws) rememberStoriesPath(location.pathname + location.search + location.hash, ws);
  }, [ws, pageKey, hash, active]);
  useEffect(() => {
    if (active) setStoriesWorkspaceShown(ws);
  }, [ws, active]);

  // The first time this studio opens, its setup opens by itself (once per studio on this device).
  const pageName = page.name;
  useEffect(() => {
    if (!active || !ws || pageName !== "dashboard") return;
    let live = true;
    void refreshOnboarding(ws).then((o) => {
      if (!live || !opensSetup({ name: "dashboard" }, ws, o, storiesPrefs().setupShown)) return;
      setStoriesPrefs({ setupShown: [...storiesPrefs().setupShown, ws] });
      setAlone(true);
      navigate("/stories/setup", { replace: true });
    });
    return () => {
      live = false;
    };
  }, [ws, pageName, active]);
  useEffect(() => {
    if (pageName !== "setup") setAlone(false);
  }, [pageName]);

  // Its own theme colour and title while on screen, given back when it is hidden or leaves.
  useLayoutEffect(() => {
    if (!active) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const colour = meta?.getAttribute("content") ?? null;
    const title = document.title;
    meta?.setAttribute("content", THEME_COLOUR);
    return () => {
      if (meta && colour !== null) meta.setAttribute("content", colour);
      document.title = title;
    };
  }, [active]);

  // The tab title names the page ("Ideas · Lamo Stories · Clip Factory", as App.tsx's titleFor does).
  useEffect(() => {
    if (active) document.title = `${storiesTitle(JSON.parse(pageKey) as StoriesPage)} · Clip Factory`;
  }, [pageKey, active]);

  // After a page change (or coming back from Clip Factory), focus moves to the page so screen readers start at its
  // heading.
  useEffect(() => {
    if (!active) return;
    if (first.current) {
      first.current = false;
      // The visit's first screen keeps focus where the browser put it; Clips Funded coming on screen by a switch (its
      // first slide in included) takes it, as every later page change does.
      if (!appSwitched()) return;
    }
    main.current?.focus({ preventScroll: true });
  }, [pageKey, active]);
  useEffect(() => setMore(false), [pageKey]);

  // Clicks follow Lamo Stories' own sound setting while it is on screen.
  useEffect(() => (active ? followStoriesClicks() : undefined), [active]);

  // Back on screen: a move to another site that waited while Clip Factory was shown goes now (Connect's sign-in page,
  // stories/pane.tsx storiesAwayLater), a page change that waited happens now (storiesGoLater), else the page opens
  // where the window was when the owner switched away.
  useEffect(() => {
    if (!active) return;
    const away = takeParkedStoriesAway();
    if (away && !away.expired) {
      location.assign(away.url);
      return;
    }
    // Its sign-in state ran out while Clip Factory was on screen: opening it would only end in a refusal.
    if (away) toast.info(AWAY_RAN_OUT);
    const at = location.pathname + location.search + location.hash;
    const to = takeParkedStoriesGo();
    if (to) {
      takeStoriesScroll(at);
      navigate(to, { replace: true });
      return;
    }
    const y = takeStoriesScroll(at);
    return y === null ? undefined : restoreScroll(y);
  }, [active, toast]);

  // On phones the toasts sit above an open sheet's buttons, never over them (§45.35 D21).
  useToastLift(root, active);

  const on = (item: NavItem) => item.match.includes(page.name);
  const moreOn = MORE.some(on);
  const solo = alone && page.name === "setup";
  // On a computer the shell's switch is drawn over the rail; on its own Setup there is none, so the page tells the shell
  // while it is on screen, and the shell's switch carries a plate of its own there (app/shell.ts setSwitchBare).
  useLayoutEffect(() => {
    if (!active || !solo) return;
    setSwitchBare(true);
    return () => setSwitchBare(false);
  }, [active, solo]);

  // A short window: the rail's list of pages stops above the shell's switch and scrolls; the chosen page is always
  // scrolled into its view (the switch never covers a page, and the chosen one is never cut off at the list's end).
  const railList = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = railList.current;
    if (!list) return;
    const show = () => {
      const item = list.querySelector<HTMLElement>(".st-rail__item.is-active");
      if (!item || list.scrollHeight <= list.clientHeight) return;
      const box = list.getBoundingClientRect();
      const at = item.getBoundingClientRect();
      const top = at.top - box.top + list.scrollTop;
      const bottom = at.bottom - box.top + list.scrollTop;
      if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
      list.scrollTop = Math.max(0, bottom - list.clientHeight + 6);
    };
    show();
    // The list's room changes after the first paint (the shell lays out its switch, the fonts arrive, the window
    // is resized): the chosen page stays in view.
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(show);
    watch.observe(list);
    return () => watch.disconnect();
  }, [page.name, solo]);

  return (
    <div ref={root} className={`stories-app${solo ? " is-alone" : ""}`} data-ws={ws ?? undefined}>
      <a className="st-skip" href="#main">
        Skip to content
      </a>
      {solo ? null : (
        <nav className="st-rail st-glass" aria-label="Clips Funded">
          <Brand />
          {/* For the keyboard the shell's switch comes right after this list, where it is drawn (data-ws-tab-after). */}
          <ul className="st-rail__list" data-ws-tab-after="" ref={railList}>
            <Glide active=".st-rail__item.is-active" className="glide--st-rail" as="li" />
            {NAV.map((item) => (
              <li key={item.label}>
                <A href={storiesHref(item.page)} className={`st-rail__item${on(item) ? " is-active" : ""}`} aria-current={on(item) ? "page" : undefined}>
                  <StIcon name={item.icon} size={22} />
                  <span className="st-rail__label">{item.label}</span>
                  {item.label === "Review" ? <ReviewCount ws={ws} /> : null}
                </A>
              </li>
            ))}
          </ul>
          {/* The shell's workspace switch and Live chip sit here, over the rail (app/WorkspaceDock.tsx): the list of
              pages stops above them. */}
          <div className="st-rail__foot" aria-hidden="true" />
        </nav>
      )}
      <div className="st-frame">
        {/* The phone top bar is a backing plate for its words (nothing over Ember, glass over a picture or the desktop). */}
        <header className="st-top st-plate">
          <Brand />
          <TopBarSwitch />
        </header>
        <main className="st-main" id={active ? "main" : undefined} ref={main} tabIndex={-1}>
          {ws && !solo ? <NeedsYouBar ws={ws} here={storiesHref(page)} /> : null}
          {problem ? (
            <section className="st-page">
              <h1 className="sr-only">Clips Funded</h1>
              <StError message={problem} onRetry={() => location.reload()} />
            </section>
          ) : ws ? (
            <StBoundary resetKey={pageKey}>
              {/* Every preview on the page draws in this workspace's drawing style (§45.45). */}
              <WorkspaceArt key={ws} ws={ws}>
                <Screen key={ws} ws={ws} page={page} />
              </WorkspaceArt>
            </StBoundary>
          ) : (
            <section className="st-page">
              <h1 className="sr-only">Clips Funded</h1>
              <StLoading label="Opening the studio…" />
            </section>
          )}
        </main>
      </div>
      {solo ? null : (
        <nav className="st-tabbar st-glass st-glass--bar" aria-label="Clips Funded">
          <ul className="st-tabbar__list">
            {/* The round active highlight (the figure's orb) slides between the tabs. */}
            <Glide active=".st-tabbar__item.is-active" className={`glide--st-tab ${TAB_ORB}`} as="li" />
            {TABS.map((item) => (
              <li key={item.label} className="st-tabbar__cell">
                <A href={storiesHref(item.page)} className={`st-tabbar__item${on(item) ? " is-active" : ""}`} aria-current={on(item) ? "page" : undefined} aria-label={item.label} title={item.label}>
                  <StIcon name={item.icon} size={24} />
                  {item.label === "Review" ? <ReviewCount ws={ws} /> : null}
                </A>
              </li>
            ))}
            <li className="st-tabbar__cell">
              <button
                type="button"
                className={`st-tabbar__item${moreOn && !more ? " is-active" : ""}${more ? " is-open" : ""}`}
                aria-label="More pages"
                title="More"
                aria-expanded={more}
                aria-controls="st-more"
                onClick={() => setMore((m) => !m)}
              >
                <StIcon name="more" size={24} />
              </button>
            </li>
          </ul>
        </nav>
      )}
      {more ? (
        <div className="st-more" id="st-more" role="dialog" aria-label="More pages">
          <button type="button" className="st-more__shade" aria-label="Close" onClick={() => setMore(false)} />
          <div className="st-more__sheet st-glass st-glass--float">
            {MORE.map((item) => (
              <A key={item.label} href={storiesHref(item.page)} className={`st-more__item${on(item) ? " is-active" : ""}`} aria-current={on(item) ? "page" : undefined}>
                <StIcon name={item.icon} size={24} />
                {item.label}
              </A>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
