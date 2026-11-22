import "../styles/contentrewards.css";
import "../styles/finder.css";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { initApi } from "../api/index.ts";
import { auth, onSignedOut } from "../lib/auth.ts";
import { loadConfig } from "../lib/config.ts";
import { usePrefs } from "../lib/prefs.ts";
import { navigate, useHash, useRoute, type Route } from "../lib/router.ts";
import { findBranch, findTree, legacySettingsRedirect } from "../lib/settingsTree.ts";
import { forgetLoaded } from "../lib/hooks.ts";
import { resetCr } from "../lib/contentRewards.ts";
import { resetFinder } from "../lib/finder.ts";
import { sounds } from "../lib/sounds.ts";
import { Backdrop, GlassFilter } from "../components/Backdrop.tsx";
import { Sidebar, TabBar, WorkspaceSwitch } from "../components/Nav.tsx";
import { ToastProvider } from "../components/Toasts.tsx";
import { UpdateBar } from "../components/UpdateBar.tsx";
import { GetAppPanel } from "../components/GetApp.tsx";
import { LiveDot } from "../components/LiveDot.tsx";
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
import { GUIDES } from "../setup/index.ts";
import { AskClipFactory } from "../features/help/HelpLauncher.tsx";
import { AskMemoryProvider } from "../features/help/askMemory.tsx";
import { SetupTodo } from "../components/SetupTodo.tsx";
import { AppBadge } from "../lib/badge.ts";
import { MacFetchHost } from "./MacFetchHost.tsx";
import { forgetDevice } from "../lib/push.ts";
import { redirectAtStart, storiesTitle } from "../stories/workspace.ts";
/**
 * The motion gallery (§20.10): mock builds only. Tested on import.meta.env directly (not isMock) so a real build
 * drops the import and does not even carry the code.
 */
const MotionGallery = import.meta.env.VITE_MOCK === "1" ? lazy(() => import("../dev/MotionGallery.tsx").then((m) => ({ default: m.MotionGallery }))) : null;

/** Lamo Stories (docs/CONTRACTS.md §45.16.2) loads only when it is opened, so Lamo Clips' own bundle and styles stay as
 * they were. */
const StoriesApp = lazy(() => import("../stories/StoriesApp.tsx").then((m) => ({ default: m.StoriesApp })));

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
  campaigns: "Your campaigns",
  campaigns_find: "Find campaigns",
  campaign: "Campaign",
  motion_gallery: "Motion gallery",
  stories: "Lamo Stories",
  not_found: "Not found",
};

/** The tab title: deeper Settings pages name where you are ("Sounds · Settings"). */
export function titleFor(route: Route): string {
  if (route.name === "settings" && route.platform) return `${GUIDES[route.platform].name} setup · Settings`;
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

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
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
        resetFinder();
        setBoot({ state: "signed_out", note: "Your sign-in on this device has ended. Please sign in again." });
      }),
    [],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", prefs.reduceMotion);
  }, [prefs.reduceMotion]);

  const signOut = useCallback(async () => {
    await Promise.race([forgetDevice(), new Promise<void>((done) => setTimeout(done, 4000))]);
    await auth().signOut();
    forgetLoaded();
    resetCr();
    resetFinder();
    setBoot({ state: "signed_out", note: null });
  }, []);

  return (
    <ToastProvider onError={() => sounds.play("deny")}>
      <Backdrop />
      <GlassFilter />
      {/* The desktop window's title bar band (macOS, §11.1): invisible, and only there when look.ts set
          data-titlebar="overlay". Pressing it moves the window, and a double click zooms it, like a title bar. */}
      <div className="titlebar-drag" data-tauri-drag-region="" aria-hidden="true" />
      {boot.state === "loading" ? (
        <div className="boot" role="status" aria-label="Loading Clip Factory">
          <span className="brand__mark brand__mark--boot" aria-hidden="true">
            C<span className="brand__dot" />
          </span>
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
          <AskMemoryProvider>
            <Shell />
          </AskMemoryProvider>
        </SessionProvider>
      )}
      {boot.state === "ready" || boot.state === "signed_out" ? <UpdateBar /> : null}
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const hash = useHash();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  // Compared by value: a new route object for the same page (or a jump within it) is not a page change.
  const page = JSON.stringify(route);

  // Old one-page Settings links (`/settings#skills`, the hooks API's `?account=…`) go to their branch (§15.1).
  useLayoutEffect(() => {
    const to = legacySettingsRedirect(location.pathname, location.search, location.hash);
    if (to) navigate(to, { replace: true });
  }, [page, hash]);

  // After a page change, move focus to the page so screen readers start at its heading.
  useEffect(() => {
    document.title = `${titleFor(JSON.parse(page) as Route)} · Clip Factory`;
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [page]);

  // Mock mode's pretend consent pages stand alone, like the platform's real page would.
  if (route.name === "mock_oauth") return <MockConsent platform={route.platform} />;
  if (route.name === "mock_cr_consent") return <MockCrConsent />;
  // Lamo Stories has its own shell (docs/CONTRACTS.md §45.16.2); every other route keeps this one, unchanged.
  if (route.name === "stories")
    return (
      <Suspense fallback={<div className="boot" role="status" aria-label="Loading Lamo Stories" />}>
        <StoriesApp page={route.page} />
      </Suspense>
    );

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar />
      <div className="shell">
        <header className="topbar">
          <A href="/" className="brand" aria-label="Clip Factory home">
            <span className="brand__mark" aria-hidden="true">
              C<span className="brand__dot" />
            </span>
            <span className="brand__name">
              Clip <em>Factory</em>
            </span>
          </A>
          <WorkspaceSwitch place="topbar" />
          <LiveDot />
        </header>
        <main className="main" id="main" ref={main} tabIndex={-1}>
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
      <AppBadge />
      <MacFetchHost />
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
