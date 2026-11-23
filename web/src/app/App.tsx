import "../styles/contentrewards.css";
import "../styles/finder.css";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { initApi } from "../api/index.ts";
import { auth, onSignedOut } from "../lib/auth.ts";
import { loadConfig } from "../lib/config.ts";
import { getPrefs, usePrefs } from "../lib/prefs.ts";
import { navigate, useHash, useRoute, type Route } from "../lib/router.ts";
import { findBranch, findTree, legacySettingsRedirect } from "../lib/settingsTree.ts";
import { forgetLoaded } from "../lib/hooks.ts";
import { resetCr } from "../lib/contentRewards.ts";
import { resetGetPaid } from "../lib/getPaid.ts";
import { resetFinder } from "../lib/finder.ts";
import { sounds } from "../lib/sounds.ts";
import { GlassFilter } from "../components/Backdrop.tsx";
import { ClipsBackdrop } from "./ClipsBackdrop.tsx";
import { Sidebar, TabBar } from "../components/Nav.tsx";
import { ToastProvider, ToastScope } from "../components/Toasts.tsx";
import { UpdateBar } from "../components/UpdateBar.tsx";
import { GetAppPanel } from "../components/GetApp.tsx";
import { LiveDot } from "../components/LiveDot.tsx";
import { ClipMark } from "../components/ClipMark.tsx";
import { A, Button, Empty, LinkButton } from "../components/ui.tsx";
import { Home } from "../screens/home/Home.tsx";
import { JobDetail } from "../screens/jobs/JobDetail.tsx";
import { Jobs } from "../screens/jobs/Jobs.tsx";
import { Library } from "../screens/library/Library.tsx";
import { weekTitle } from "../screens/library/WeekView.tsx";
import { ClipPerformance } from "../screens/clip/ClipPerformance.tsx";
import { MoneyDashboard } from "../screens/money/MoneyDashboard.tsx";
import { Review } from "../screens/review/Review.tsx";
import { Settings } from "../screens/settings/Settings.tsx";
import { SignIn } from "../screens/SignIn.tsx";
import { SessionProvider } from "./session.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { MockConsent } from "../screens/settings/setup/MockConsent.tsx";
import { MockCrConsent } from "../screens/campaigns/MockCrConsent.tsx";
import { CampaignsPage } from "../screens/campaigns/CampaignsPage.tsx";
import { CampaignPage } from "../screens/campaigns/CampaignPage.tsx";
import { FindPage } from "../screens/campaigns/FindPage.tsx";
import { CrSendNow } from "../components/CrSendNow.tsx";
import { BankDone, MockBankPage } from "../screens/getpaid/bank/BankDone.tsx";
import { BANK_DONE_PATH } from "../getpaid/bank.ts";
import { resetBank } from "../lib/bank.ts";
import { GUIDES } from "../setup/index.ts";
import { AskClipFactory } from "../features/help/HelpLauncher.tsx";
import { AskMemoryProvider } from "../features/help/askMemory.tsx";
import { SetupTodo } from "../components/SetupTodo.tsx";
import { AppBadge } from "../lib/badge.ts";
import { MacFetchHost } from "./MacFetchHost.tsx";
import { forgetDevice } from "../lib/push.ts";
import { chooseClips, redirectAtStart, restoreScroll, storiesTitle, takeClipsScroll } from "../stories/workspace.ts";
import { storiesEnabled } from "../stories/flag.ts";
import type { StoriesPage } from "../stories/routes.ts";
import { AppPanes, loadStoriesApp, storiesModule, StoriesPaneBoundary } from "../stories/pane.tsx";
import { WorkspaceMark } from "../components/WorkspaceMark.tsx";
import { calmPage, followStoriesMotion, storiesDeniedSound } from "../stories/prefs.ts";
import { KeptSearchProvider, storiesOnScreen, takeParkedClipsGo, useAppActive, useShellHosted } from "./shell.ts";
import { TopBarSwitch, WorkspaceDock } from "./WorkspaceDock.tsx";
/**
 * The motion gallery (§20.10): mock builds only. Tested on import.meta.env directly (not isMock) so a real build
 * drops the import and does not even carry the code.
 */
const MotionGallery = import.meta.env.VITE_MOCK === "1" ? lazy(() => import("../dev/MotionGallery.tsx").then((m) => ({ default: m.MotionGallery }))) : null;

// Opening the app at "/" when Lamo Stories was the last choice goes to the last Lamo Stories page (§45.16.1), before
// the first screen draws. Nothing happens while Lamo Stories is switched off.
redirectAtStart();

type Boot = { state: "loading" } | { state: "signed_out"; note: string | null } | { state: "ready" } | { state: "broken" };

const TITLES: Record<Route["name"], string> = {
  home: "Home",
  jobs: "Jobs",
  job: "Job",
  review: "Review",
  library: "Library",
  clip: "Clip numbers",
  money: "Money",
  settings: "Settings",
  skill: "Skill",
  get_app: "Get the app",
  mock_oauth: "Pretend sign-in",
  mock_cr_consent: "Pretend Content Rewards",
  cr_setup: "Content Rewards setup · Settings",
  getpaid: "Get paid · Settings",
  "getpaid-bank": "Your bank · Get paid · Settings",
  campaigns: "Your campaigns",
  campaigns_find: "Find campaigns",
  campaign: "Campaign",
  motion_gallery: "Motion gallery",
  stories: "Clips Funded",
  not_found: "Not found",
};

/** The tab title: deeper Settings pages name where you are ("Sounds · Settings"). */
export function titleFor(route: Route): string {
  if (route.name === "settings" && route.platform) return `${GUIDES[route.platform].name} setup · Settings`;
  if (route.name === "getpaid") return `${route.place === "contentrewards" ? "Content Rewards" : GUIDES[route.place].name} · Get paid · Settings`;
  if (route.name === "settings" && route.tree) {
    const tree = findTree(route.tree);
    const branch = tree && route.branch ? findBranch(tree, route.branch) : undefined;
    return `${branch?.name ?? tree?.name ?? "Settings"} · Settings`;
  }
  if (route.name === "skill") return `${route.mode === "new" ? "Write a skill" : route.mode === "edit" ? "Change a skill" : "Skill"} · Settings`;
  if (route.name === "library" && route.view === "week") return `${weekTitle(route.week)} · Library`;
  if (route.name === "stories") return storiesTitle(route.page);
  return TITLES[route.name];
}

/** BankID's way back (§40.5.2): /bank-done is shown before the sign-in gate. */
export const isBankDone = (pathname: string) => (pathname.replace(/\/+$/, "") || "/") === BANK_DONE_PATH;

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [bankDone] = useState(() => typeof location !== "undefined" && isBankDone(location.pathname));
  const prefs = usePrefs();

  const start = useCallback(async () => {
    try {
      await loadConfig();
      await initApi();
      const user = await auth().currentUser();
      setBoot(user ? { state: "ready" } : { state: "signed_out", note: null });
    } catch (e) {
      console.error(e);
      setBoot({ state: "broken" });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(
    () =>
      onSignedOut(() => {
        forgetLoaded();
        resetCr();
        resetGetPaid();
        resetBank();
        resetFinder();
        setBoot({ state: "signed_out", note: "Your sign-in on this device has ended. Please sign in again." });
      }),
    [],
  );

  // Calm motion (Settings › Look & feel). While a Lamo Stories page is on screen, Lamo Stories' own switch (§45.34).
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", calmPage(prefs.reduceMotion));
  }, [prefs.reduceMotion]);

  const signOut = useCallback(async () => {
    await Promise.race([forgetDevice(), new Promise<void>((done) => setTimeout(done, 4000))]);
    await auth().signOut();
    forgetLoaded();
    resetCr();
    resetGetPaid();
    resetBank();
    resetFinder();
    setBoot({ state: "signed_out", note: null });
  }, []);

  return (
    <ToastProvider onError={() => (storiesOnScreen() ? storiesDeniedSound() : sounds.play("deny"))}>
      {/* Clip Factory's own backdrop: only while Clip Factory is on screen (always, while Lamo Stories is off). */}
      <ClipsBackdrop />
      <GlassFilter />
      {/* The desktop window's title bar band (macOS, §11.1): invisible, and only there when look.ts set
          data-titlebar="overlay". Pressing it moves the window, and a double click zooms it, like a title bar. */}
      <div className="titlebar-drag" data-tauri-drag-region="" aria-hidden="true" />
      {/* BankID's way back (§40.5.2): a public page, before the sign-in gate, with no API call and no data. */}
      {bankDone ? (
        <BankDone boot={boot.state} />
      ) : boot.state === "loading" ? (
        <div className="boot" role="status" aria-label="Loading Clip Factory">
          <ClipMark className="brand__mark--boot" />
        </div>
      ) : boot.state === "broken" ? (
        <main className="boot" id="main">
          <Empty icon="alert" title="Clip Factory could not start" action={<Button variant="primary" icon="retry" act="retry" onClick={() => location.reload()}>Try again</Button>}>
            Check that you are online (Wi-Fi or mobile data), then tap Try again.
          </Empty>
        </main>
      ) : boot.state === "signed_out" ? (
        <SignIn note={boot.note} onDone={() => setBoot({ state: "ready" })} />
      ) : (
        <SessionProvider onSignOut={signOut}>
          {/* Ask's conversation sits above the Clip Factory / Lamo Stories branch, so a switch keeps it (§45.16.1). */}
          <AskMemoryProvider>{storiesEnabled() ? <BothApps /> : <Shell />}</AskMemoryProvider>
        </SessionProvider>
      )}
      {!bankDone && (boot.state === "ready" || boot.state === "signed_out") ? <UpdateBar /> : null}
    </ToastProvider>
  );
}

/**
 * Lamo Stories switched on (docs/CONTRACTS.md §45.16.2, §45.34, §45.35, §45.38): Clip Factory's Shell for every
 * Lamo Clips route and Lamo Stories' own shell for /stories. Each, once shown, stays mounted while the other is on
 * screen (hidden and inert), so coming back shows it exactly as it was left. Home opened for a campaign
 * (`/?campaign=…`) is kept too: Clip Factory's pane carries the search of its kept page (useKeptSearch), so Home still
 * reads its own way while Lamo Stories' address is shown. Only the skill editor opens fresh (it asks "Leave without
 * saving?", and unsaved typing is never carried across a switch). Each pane has its own error boundary: Clip Factory's
 * own (its fallback as it always was) and Lamo Stories' card, so one app breaking never takes the other with it, and
 * its own toasts (a toast its app raises while hidden waits for it to be back). The shell itself draws what both share,
 * once, outside both panes: the workspace switch with the Live chip (WorkspaceDock), the app badge and the Mac download
 * host. The panes tell the shell which app is on screen (app/shell.ts): Clip Factory's own backdrop is drawn only while
 * Clip Factory is (ClipsBackdrop), and html.see-through is the wish of the app on screen, never one app's over the
 * other's.
 */
function BothApps() {
  const route = useRoute();
  const inStories = route.name === "stories";
  const lastStories = useRef<StoriesPage>(inStories ? route.page : { name: "dashboard" });
  if (route.name === "stories") lastStories.current = route.page;
  const lastClips = useRef<Route>(route);
  const lastClipsSearch = useRef(typeof location === "undefined" ? "" : location.search);
  if (!inStories) {
    lastClips.current = route;
    lastClipsSearch.current = typeof location === "undefined" ? "" : location.search;
  }
  const held = lastClips.current;
  const fresh = held.name === "skill" && held.mode !== "read" ? "clips" : null;
  // The calm-motion class follows the app on screen (Lamo Stories' own switch, Clip Factory's otherwise).
  useLayoutEffect(() => followStoriesMotion(clipsCalm), [inStories]);
  return (
    <>
      <AppPanes
        on={inStories ? "stories" : "clips"}
        fresh={fresh}
        clips={
          <KeptSearchProvider value={lastClipsSearch.current}>
            <ToastScope active={!inStories} onScreen={clipsOnScreen} onError={clipsDenied}>
              <ErrorBoundary scope="app">
                <Shell />
              </ErrorBoundary>
            </ToastScope>
          </KeptSearchProvider>
        }
        stories={
          <ToastScope active={inStories} onScreen={storiesOnScreen} onError={storiesDeniedSound} className="st-toast">
            <StoriesPaneBoundary onClips={() => navigate(chooseClips())}>
              <StoriesHost page={lastStories.current} />
            </StoriesPaneBoundary>
          </ToastScope>
        }
      />
      <WorkspaceDock />
      <AppBadge />
      <MacFetchHost />
    </>
  );
}

const clipsCalm = () => getPrefs().reduceMotion;
const clipsOnScreen = () => !storiesOnScreen();
const clipsDenied = () => sounds.play("deny");

/**
 * Lamo Stories' shell, from its own chunk: at once when the idle prefetch already brought it, else after it loads.
 * Each mount makes its own lazy app, so Try again on Lamo Stories' error card fetches a chunk that failed once more.
 */
function StoriesHost({ page }: { page: StoriesPage }) {
  const [Stories] = useState<ComponentType<{ page: StoriesPage }>>(() => storiesModule()?.StoriesApp ?? lazy(() => loadStoriesApp().then((m) => ({ default: m.StoriesApp }))));
  return (
    <Suspense
      fallback={
        <div className="boot" role="status" aria-label="Loading Clips Funded">
          <WorkspaceMark boot />
        </div>
      }
    >
      <Stories page={page} />
    </Suspense>
  );
}

function Shell() {
  // On screen (always, while Lamo Stories is switched off). Hidden behind Lamo Stories, it keeps its last page and
  // stays quiet: no title, no focus move, no redirect.
  const active = useAppActive();
  // Next to Lamo Stories: the shell draws the switch and the Live chip, the app badge and the Mac download host.
  const hosted = useShellHosted();
  const live = useRoute();
  const kept = useRef(live);
  if (active) kept.current = live;
  const route = kept.current;
  const hash = useHash();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  // Compared by value: a new route object for the same page (or a jump within it) is not a page change.
  const page = JSON.stringify(route);

  // Old one-page Settings links (`/settings#skills`, the hooks API's `?account=…`) go to their branch (§15.1).
  useLayoutEffect(() => {
    if (!active) return;
    const to = legacySettingsRedirect(location.pathname, location.search, location.hash);
    if (to) navigate(to, { replace: true });
  }, [page, hash, active]);

  // After a page change (or coming back from Lamo Stories), move focus to the page so screen readers start at its
  // heading.
  useEffect(() => {
    if (!active) return;
    document.title = `${titleFor(JSON.parse(page) as Route)} · Clip Factory`;
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [page, active]);

  // Back on screen next to Lamo Stories: a page change that waited while Lamo Stories was shown happens now (a
  // campaign added, a skill saved: clipsGoLater, §45.38), else the page opens where the owner left it (its lists may
  // still be loading, so it waits for the page to grow, and lets go as soon as the owner scrolls himself, §45.36 E1).
  useEffect(() => {
    if (!active || !hosted) return;
    const at = location.pathname + location.search + location.hash;
    const go = takeParkedClipsGo();
    if (go) {
      takeClipsScroll(at);
      navigate(go.to, { replace: go.replace, force: go.force });
      return;
    }
    const y = takeClipsScroll(at);
    return y === null ? undefined : restoreScroll(y);
  }, [active, hosted]);

  // Mock mode's pretend consent pages stand alone, like the platform's real page would.
  if (route.name === "mock_oauth") return <MockConsent platform={route.platform} />;
  if (route.name === "mock_cr_consent") return <MockCrConsent />;
  // Mock builds only: the pretend bank page a connect goes to (§40.5.11). It is a whole page load, so the address says.
  if (import.meta.env.VITE_MOCK === "1" && location.pathname === "/mock-bank") return <MockBankPage />;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar />
      <div className="shell">
        <header className="topbar">
          <A href="/" className="brand" aria-label="Clip Factory home">
            <ClipMark />
            <span className="brand__name">
              Clip <em>Factory</em>
            </span>
          </A>
          {hosted ? <TopBarSwitch /> : <LiveDot />}
        </header>
        <main className="main" id={active ? "main" : undefined} ref={main} tabIndex={-1}>
          {/* One broken screen never blanks the app; moving to another page clears the error. */}
          {/* The Mac app's "send this now" banner (§38.6): in the flow, so it never covers a control. */}
          <CrSendNow route={route} />
          <ErrorBoundary resetKey={page} scope="page">
            <Screen route={route} />
          </ErrorBoundary>
        </main>
      </div>
      <TabBar />
      <AskClipFactory />
      <SetupTodo />
      {hosted ? null : (
        <>
          <AppBadge />
          <MacFetchHost />
        </>
      )}
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <Home />;
    case "jobs":
      return <Jobs />;
    case "job":
      return <JobDetail key={route.jobId} jobId={route.jobId} />;
    case "review":
      return <Review jobId={route.jobId} />;
    case "library":
      return <Library view={route.view} week={route.week} />;
    case "clip":
      return <ClipPerformance key={route.clipId} clipId={route.clipId} />;
    case "money":
      return <MoneyDashboard />;
    case "settings":
      return <Settings tree={route.tree} branch={route.branch} platform={route.platform ?? null} />;
    case "cr_setup":
      return <Settings tree="posting" branch="setup" contentRewards />;
    case "getpaid":
      return <Settings tree="posting" branch="getpaid" getPaid={route.place} />;
    case "getpaid-bank":
      return <Settings tree="posting" branch="getpaid" bank />;
    case "campaigns":
      return <CampaignsPage />;
    case "campaigns_find":
      return <FindPage />;
    case "campaign":
      return <CampaignPage key={route.campaignId} campaignId={route.campaignId} />;
    case "skill":
      return <Settings skill={{ mode: route.mode, skillId: route.skillId }} />;
    case "motion_gallery":
      return MotionGallery ? (
        <Suspense fallback={null}>
          <MotionGallery />
        </Suspense>
      ) : null;
    case "get_app":
      return (
        <div className="page page--narrow">
          <GetAppPanel headingLevel={1} installedNote />
        </div>
      );
    default:
      return (
        <div className="page">
          <h1 className="sr-only">Page not found</h1>
          <Empty icon="info" title="This page does not exist" action={<LinkButton href="/" variant="primary" icon="home">Go home</LinkButton>}>
            The link may be old or have a typo. Tap Go home to start again.
          </Empty>
        </div>
      );
  }
}
