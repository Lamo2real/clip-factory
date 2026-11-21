// The Lamo Stories shell (docs/CONTRACTS.md §45.16.2): its own navigation and look, the workspace check, then the
// page. Only reached while Lamo Stories is switched on (web/src/stories/flag.ts); Lamo Clips keeps its own Shell.
// SCAFFOLD (Phase 1): a plain, working shell so the screen builders can run their pages; builder F owns this file and
// gives it the studio look, the switcher, the Needs you bar and the polish.
import "./styles/stories.css";
import { useEffect, useState } from "react";
import { MacFetchHost } from "../app/MacFetchHost.tsx";
import { AppBadge } from "../lib/badge.ts";
import { A } from "../components/ui.tsx";
import { loadStoriesApi } from "./api/client.ts";
import type { Workspace } from "./api/types.ts";
import { storiesHref, type StoriesPage } from "./routes.ts";
import { CharactersScreen } from "./screens/Characters.tsx";
import { ConnectionsScreen } from "./screens/Connections.tsx";
import { DashboardScreen } from "./screens/Dashboard.tsx";
import { IdeasScreen } from "./screens/Ideas.tsx";
import { LibraryScreen } from "./screens/Library.tsx";
import { ProductionScreen } from "./screens/Production.tsx";
import { ReviewScreen } from "./screens/Review.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import type { StoriesScreenProps } from "./screens/types.ts";

const NAV: { label: string; page: StoriesPage; match: StoriesPage["name"][] }[] = [
  { label: "Dashboard", page: { name: "dashboard" }, match: ["dashboard"] },
  { label: "Ideas", page: { name: "ideas" }, match: ["ideas"] },
  { label: "Characters", page: { name: "characters" }, match: ["characters", "character", "character_new"] },
  { label: "Production", page: { name: "production" }, match: ["production", "production_new", "production_story"] },
  { label: "Review", page: { name: "review" }, match: ["review", "review_story"] },
  { label: "Library", page: { name: "library", kind: null, storyId: null }, match: ["library"] },
  { label: "Connections", page: { name: "connections", platform: null, result: null, ws: null }, match: ["connections"] },
  { label: "Settings", page: { name: "settings" }, match: ["settings"] },
];

/** Picks the workspace to show: a checked id from the server's own list, never one taken from the address alone. */
export function pickWorkspace(list: Workspace[], wanted: string | null): string | null {
  const stories = list.filter((w) => w.workspaceType === "stories");
  if (wanted && stories.some((w) => w.workspaceId === wanted)) return wanted;
  return stories[0]?.workspaceId ?? null;
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
    default:
      return (
        <section className="st-page">
          <h1>We could not find that page</h1>
          <A href={storiesHref({ name: "dashboard" })}>Go to the Lamo Stories dashboard</A>
        </section>
      );
  }
}

export function StoriesApp({ page }: { page: StoriesPage }) {
  const [ws, setWs] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const wanted = page.name === "connections" ? page.ws : null;

  useEffect(() => {
    let live = true;
    loadStoriesApi()
      .then((api) => api.listWorkspaces())
      .then((list) => {
        if (!live) return;
        const id = pickWorkspace(list, wanted);
        if (id) setWs(id);
        else setProblem("Lamo Stories is not ready yet. Try again in a minute.");
      })
      .catch(() => live && setProblem("Lamo Stories could not load. Check that you are online, then try again."));
    return () => {
      live = false;
    };
  }, [wanted]);

  return (
    <div className="stories-app">
      <nav className="st-nav" aria-label="Lamo Stories">
        {NAV.map((item) => (
          <A key={item.label} href={storiesHref(item.page)} className={item.match.includes(page.name) ? "st-nav__item is-active" : "st-nav__item"}>
            {item.label}
          </A>
        ))}
        <A href="/" className="st-nav__item">
          Lamo Clips
        </A>
      </nav>
      <main className="st-main" id="main" tabIndex={-1}>
        {problem ? <p role="alert">{problem}</p> : ws ? <Screen ws={ws} page={page} /> : <p role="status">Loading…</p>}
      </main>
      <AppBadge />
      <MacFetchHost />
    </div>
  );
}
