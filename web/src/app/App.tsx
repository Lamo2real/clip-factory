import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { initApi } from "../api/index.ts";
import { auth, onSignedOut } from "../lib/auth.ts";
import { loadConfig } from "../lib/config.ts";
import { usePrefs } from "../lib/prefs.ts";
import { navigate, useHash, useRoute, type Route } from "../lib/router.ts";
import { findBranch, findTree, legacySettingsRedirect } from "../lib/settingsTree.ts";
import { sounds } from "../lib/sounds.ts";
import { Backdrop, GlassFilter } from "../components/Backdrop.tsx";
import { Sidebar, TabBar } from "../components/Nav.tsx";
import { ToastProvider } from "../components/Toasts.tsx";
import { UpdateBar } from "../components/UpdateBar.tsx";
import { GetAppPanel } from "../components/GetApp.tsx";
import { LiveDot } from "../components/LiveDot.tsx";
import { A, Button, Empty, LinkButton } from "../components/ui.tsx";
import { Home } from "../screens/home/Home.tsx";
import { JobDetail } from "../screens/jobs/JobDetail.tsx";
import { Jobs } from "../screens/jobs/Jobs.tsx";
import { Library } from "../screens/library/Library.tsx";
import { Review } from "../screens/review/Review.tsx";
import { Settings } from "../screens/settings/Settings.tsx";
import { SignIn } from "../screens/SignIn.tsx";
import { SessionProvider } from "./session.tsx";

type Boot = { state: "loading" } | { state: "signed_out"; note: string | null } | { state: "ready" } | { state: "broken" };

const TITLES: Record<Route["name"], string> = {
  home: "Home",
  jobs: "Jobs",
  job: "Job",
  review: "Review",
  library: "Library",
  settings: "Settings",
  get_app: "Get the app",
  not_found: "Not found",
};

/** The tab title: deeper Settings pages name where you are ("Sounds · Settings"). */
export function titleFor(route: Route): string {
  if (route.name === "settings" && route.tree) {
    const tree = findTree(route.tree);
    const branch = tree && route.branch ? findBranch(tree, route.branch) : undefined;
    return `${branch?.name ?? tree?.name ?? "Settings"} · Settings`;
  }
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
      onSignedOut(() =>
        setBoot({ state: "signed_out", note: "Your sign-in on this device has ended. Please sign in again." }),
      ),
    [],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", prefs.reduceMotion);
  }, [prefs.reduceMotion]);

  const signOut = useCallback(async () => {
    await auth().signOut();
    setBoot({ state: "signed_out", note: null });
  }, []);

  return (
    <ToastProvider onError={() => sounds.play("deny")}>
      <Backdrop />
      <GlassFilter />
      {boot.state === "loading" ? (
        <div className="boot" role="status" aria-label="Loading Clip Factory">
          <span className="brand__mark brand__mark--boot" aria-hidden="true">
            C<span className="brand__dot" />
          </span>
        </div>
      ) : boot.state === "broken" ? (
        <main className="boot" id="main">
          <Empty icon="alert" title="Clip Factory could not start" action={<Button variant="primary" icon="retry" onClick={() => location.reload()}>Try again</Button>}>
            Check that you are online (Wi-Fi or mobile data), then tap Try again.
          </Empty>
        </main>
      ) : boot.state === "signed_out" ? (
        <SignIn note={boot.note} onDone={() => setBoot({ state: "ready" })} />
      ) : (
        <SessionProvider onSignOut={signOut}>
          <Shell />
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
          <LiveDot />
        </header>
        <main className="main" id="main" ref={main} tabIndex={-1}>
          <Screen route={route} />
        </main>
      </div>
      <TabBar />
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
      return <Library />;
    case "settings":
      return <Settings tree={route.tree} branch={route.branch} />;
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
