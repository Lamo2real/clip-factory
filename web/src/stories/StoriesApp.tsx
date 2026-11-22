// The Lamo Stories shell (docs/CONTRACTS.md §45.16.2): its own navigation and look ("an animation studio"), the
// workspace check, the Needs you bar, then the page. Only reached while Lamo Stories is switched on
// (web/src/stories/flag.ts); Lamo Clips keeps its own Shell, untouched. The first time a studio opens, its setup
// (/stories/setup, §45.29) opens by itself, on its own without the navigation; after that it is one page among the
// others, reached from the dashboard's card until it is finished. Lamo Clips' Ask and setup to-do are not shown
// here; the Mac app's "send this now" banner (CrSendNow), the Mac download host and the app badge are, unchanged, and
// the update bar, toasts and sounds stay global (App.tsx). The page title and the theme colour go back to Lamo
// Clips' when this unmounts.
import "./styles/stories.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api/errors.ts";
import { MacFetchHost } from "../app/MacFetchHost.tsx";
import { CrSendNow } from "../components/CrSendNow.tsx";
import { Glide } from "../components/Glide.tsx";
import { WorkspaceSwitch } from "../components/Nav.tsx";
import { A } from "../components/ui.tsx";
import { AppBadge } from "../lib/badge.ts";
import { navigate, useHash } from "../lib/router.ts";
import { loadStoriesApi, setStoriesApi } from "./api/client.ts";
import type { StoriesApi, Workspace } from "./api/types.ts";
import { storiesHref, type StoriesPage } from "./routes.ts";
import { CharactersScreen } from "./screens/Characters.tsx";
import { ChatScreen } from "./screens/Chat.tsx";
import { ConnectionsScreen } from "./screens/Connections.tsx";
import { DashboardScreen } from "./screens/Dashboard.tsx";
import { IdeasScreen } from "./screens/Ideas.tsx";
import { LibraryScreen } from "./screens/Library.tsx";
import { ProductionScreen } from "./screens/Production.tsx";
import { ReferencesScreen } from "./screens/References.tsx";
import { ReviewScreen } from "./screens/Review.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SetupScreen } from "./screens/Setup.tsx";
import type { StoriesScreenProps } from "./screens/types.ts";
import { NeedsYouBar, refreshOnboarding, StBoundary, StEmpty, StError, StIcon, StLinkButton, StLoading, useDashboard, type StIconName } from "./ui.tsx";
import { onChoiceChange, rememberStoriesPath, setKnownWorkspaces, setStoriesPrefs, storiesPrefs, wantedStoriesWorkspace } from "./workspace.ts";

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
    match: ["characters", "character", "character_new"],
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

const STAGE = "#1C1842";

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
    case "production":
    case "production_new":
    case "production_story":
      return <ProductionScreen {...props} />;
    case "review":
    case "review_story":
      return <ReviewScreen {...props} />;
    case "library":
      return <LibraryScreen {...props} />;
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

/** The Lamo Stories mark: a little sunny face on the night stage. */
function StoriesMark({ size = 40 }: { size?: number }) {
  return (
    <svg className="st-brand__mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="38" height="38" rx="13" fill="#FFC94A" />
      <circle cx="14.5" cy="17" r="3" fill="#1C1842" />
      <circle cx="25.5" cy="17" r="3" fill="#1C1842" />
      <circle cx="15.4" cy="16" r="1" fill="#FFF6E5" />
      <circle cx="26.4" cy="16" r="1" fill="#FFF6E5" />
      <path d="M13 24.5c3.8 4 10.2 4 14 0" fill="none" stroke="#1C1842" strokeWidth="3" strokeLinecap="round" />
      <circle cx="31.5" cy="8.5" r="3" fill="#FF6F61" />
    </svg>
  );
}

function Brand() {
  return (
    <A href="/stories" className="st-brand" aria-label="Lamo Stories dashboard">
      <StoriesMark />
      <span className="st-brand__name">
        Lamo <em>Stories</em>
      </span>
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

export function StoriesApp({ page }: { page: StoriesPage }) {
  const [ws, setWs] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  /** The setup opened by itself: it shows on its own until the owner leaves it. */
  const [alone, setAlone] = useState(false);
  const fromAddress = page.name === "connections" ? page.ws : null;
  const tried = useRef<Set<string>>(new Set());
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const hash = useHash();
  const pageKey = JSON.stringify(page);

  const check = useCallback(
    async (skip: string[] = []) => {
      const api = await loadStoriesApi();
      const list = await api.listWorkspaces();
      setKnownWorkspaces(list);
      return chooseWorkspace(list, fromAddress, wantedStoriesWorkspace(), skip);
    },
    [fromAddress],
  );

  // The workspace check, before the first screen (§45.16.2). listWorkspaces also makes "Lamo Stories" on first use.
  useEffect(() => {
    let live = true;
    const run = () =>
      check()
        .then((id) => {
          if (!live) return;
          if (id) {
            setWs(id);
            setProblem(null);
          } else setProblem("Lamo Stories is not ready yet. Try again in a minute.");
        })
        .catch(() => live && setProblem("Lamo Stories could not load. Check that you are online, then try again."));
    void run();
    // The switcher picked another Lamo Stories workspace: check again.
    const off = onChoiceChange(() => void run());
    return () => {
      live = false;
      off();
    };
  }, [check]);

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
        .catch(() => live && setProblem("Lamo Stories could not load. Check that you are online, then try again."));
    };
    return () => {
      live = false;
      onGone = null;
    };
  }, [check]);

  // Every Lamo Stories page is where switching back lands.
  useEffect(() => {
    if (ws) rememberStoriesPath(location.pathname + location.search + location.hash, ws);
  }, [ws, pageKey, hash]);

  // The first time this studio opens, its setup opens by itself (once per studio on this device).
  const pageName = page.name;
  useEffect(() => {
    if (!ws || pageName !== "dashboard") return;
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
  }, [ws, pageName]);
  useEffect(() => {
    if (pageName !== "setup") setAlone(false);
  }, [pageName]);

  // Its own title (App.tsx's titleFor names the page) and theme colour, given back on the way out.
  useLayoutEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const colour = meta?.getAttribute("content") ?? null;
    const title = document.title;
    meta?.setAttribute("content", STAGE);
    return () => {
      if (meta && colour !== null) meta.setAttribute("content", colour);
      document.title = title;
    };
  }, []);

  // After a page change, focus moves to the page so screen readers start at its heading.
  useEffect(() => {
    setMore(false);
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [pageKey]);

  const on = (item: NavItem) => item.match.includes(page.name);
  const moreOn = MORE.some(on);
  const solo = alone && page.name === "setup";

  return (
    <div className={`stories-app${solo ? " is-alone" : ""}`} data-ws={ws ?? undefined}>
      <a className="st-skip" href="#main">
        Skip to content
      </a>
      {solo ? null : (
        <nav className="st-rail" aria-label="Lamo Stories">
          <Brand />
          <ul className="st-rail__list">
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
          <div className="st-rail__foot">
            <WorkspaceSwitch place="stories-rail" current={ws ?? "stories"} />
          </div>
        </nav>
      )}
      <div className="st-frame">
        <header className="st-top">
          <Brand />
          <WorkspaceSwitch place="stories-top" current={ws ?? "stories"} />
        </header>
        <main className="st-main" id="main" ref={main} tabIndex={-1}>
          <CrSendNow route={{ name: "stories", page }} />
          {ws && !solo ? <NeedsYouBar ws={ws} /> : null}
          {problem ? (
            <section className="st-page">
              <h1 className="sr-only">Lamo Stories</h1>
              <StError message={problem} onRetry={() => location.reload()} />
            </section>
          ) : ws ? (
            <StBoundary resetKey={pageKey}>
              <Screen key={ws} ws={ws} page={page} />
            </StBoundary>
          ) : (
            <section className="st-page">
              <h1 className="sr-only">Lamo Stories</h1>
              <StLoading label="Opening the studio…" />
            </section>
          )}
        </main>
      </div>
      {solo ? null : (
        <nav className="st-tabbar" aria-label="Lamo Stories">
          <ul className="st-tabbar__list">
            <Glide active=".st-tabbar__item.is-active" className="glide--st-tab" as="li" />
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
          <div className="st-more__sheet">
            {MORE.map((item) => (
              <A key={item.label} href={storiesHref(item.page)} className={`st-more__item${on(item) ? " is-active" : ""}`} aria-current={on(item) ? "page" : undefined}>
                <StIcon name={item.icon} size={24} />
                {item.label}
              </A>
            ))}
          </div>
        </div>
      ) : null}
      <AppBadge />
      <MacFetchHost />
    </div>
  );
}
