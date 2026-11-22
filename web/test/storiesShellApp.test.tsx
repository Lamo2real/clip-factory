// Lamo Stories' shell between the two apps (docs/CONTRACTS.md §45.34): it opens its workspace at once from the list
// the switcher already read and checks again in the background; kept mounted behind Clip Factory it stays quiet (no
// title, no theme colour, no page landmark id, no dashboard poll, no workspace check) and comes back as it was; the
// Mac download host and the app badge run once, in Clip Factory's shell when that is mounted too. The dashboard's
// "Continue: {name}" opens the project open last (idea, video, character or reference video), hidden once it is gone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { setStoriesApi } from "../src/stories/api/client.ts";
import type { Character, Idea, ReferenceVideo, StoriesApi, StoriesDashboard, Story, Workspace } from "../src/stories/api/types.ts";
import type { Onboarding } from "../src/stories/api/types.ts";
import { AppPanes, storiesGoLater } from "../src/stories/pane.tsx";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { currentChoice, rememberStoriesPath, resetWorkspaceMemory, saveStoriesScroll, setKnownWorkspaces, takeStoriesScroll } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/components/CrSendNow.tsx", () => ({ CrSendNow: () => null }));
vi.mock("../src/lib/badge.ts", () => ({ AppBadge: () => <i data-host="badge" /> }));
vi.mock("../src/app/MacFetchHost.tsx", () => ({ MacFetchHost: () => <i data-host="mac" /> }));
/** Every page change StoriesApp asked for (the router itself is not run here). */
const navigated: { to: string; replace: boolean }[] = [];
vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: (to: string, o: { replace?: boolean } = {}) => void navigated.push({ to, replace: !!o.replace }) };
});

const { StoriesApp } = await import("../src/stories/StoriesApp.tsx");
const { openProject, projectGone } = await import("../src/stories/screens/Dashboard.tsx");

const ws = (id: string, type: Workspace["workspaceType"], name = id): Workspace => ({ workspaceId: id, workspaceName: name, workspaceType: type, builtin: type === "clips", configuration: {}, version: 1 });
const CLIPS = ws("clips", "clips", "Lamo Clips");
const STORIES = ws("stories", "stories", "Lamo Stories");
const onboarding: Onboarding = {
  steps: ["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"].map((step, i) => ({ step: step as Onboarding["steps"][number]["step"], label: step, state: i < 4 ? "done" : "todo" })),
  done: 4,
  total: 11,
  finishedAt: null,
};
const dash: StoriesDashboard = {
  counts: { made: 1, review: 0, published: 0, producing: 0, needsCheck: 0, needsYou: 0 },
  needsYou: [],
  producing: [],
  accounts: [],
  performance: { views: 0, likes: 0, comments: 0, shares: 0, posts: 0, checkedAt: null, lastAt: null },
  activity: [],
};
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
/** A promise that never settles: the server has not answered yet. */
const never = <T,>() => new Promise<T>(() => undefined);

let host: HTMLElement;
let root: Root;
let fake: Partial<StoriesApi>;
let meta: HTMLMetaElement;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf.storiesPreview", "1");
  localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#0F372B";
  document.head.appendChild(meta);
  document.title = "Library · Clip Factory";
  fake = {
    listWorkspaces: vi.fn(async () => [CLIPS, STORIES]),
    dashboard: vi.fn(async () => dash),
    getOnboarding: vi.fn(async () => onboarding),
  };
  setStoriesApi(fake as StoriesApi);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  meta.remove();
  setStoriesApi(null);
  localStorage.clear();
});

const inPanes = (on: "clips" | "stories", page: Parameters<typeof StoriesApp>[0]["page"] = { name: "dashboard" }) =>
  act(async () =>
    root.render(
      <ToastProvider>
        <AppPanes on={on} clips={<main id="main" className="clips-main" />} stories={<StoriesApp page={page} />} />
      </ToastProvider>,
    ),
  );

describe("opening at once", () => {
  it("uses the list the switcher already read: the studio shows before the server answers again", async () => {
    setKnownWorkspaces([CLIPS, STORIES]);
    fake.listWorkspaces = vi.fn(() => never<Workspace[]>());
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    expect(host.querySelector(".stories-app")?.getAttribute("data-ws")).toBe("stories");
    expect(host.textContent).not.toContain("Opening the studio");
    // Still checked in the background.
    expect(fake.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("the background check wins when the server's list has changed", async () => {
    const CARS = ws("01JZ0000000000000000000000", "stories", "Lamo Cars");
    setKnownWorkspaces([CLIPS, STORIES]);
    fake.listWorkspaces = vi.fn(async () => [CLIPS, CARS]);
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    await flush();
    await flush();
    expect(host.querySelector(".stories-app")?.getAttribute("data-ws")).toBe(CARS.workspaceId);
  });

  it("without the switcher's list it still waits for the check, as before", async () => {
    fake.listWorkspaces = vi.fn(() => never<Workspace[]>());
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    expect(host.querySelector(".stories-app")?.hasAttribute("data-ws")).toBe(false);
    expect(host.textContent).toContain("Opening the studio");
  });
});

describe("kept behind Clip Factory", () => {
  it("is quiet while hidden (title, theme colour, #main, dashboard poll, workspace check) and comes back as it was", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      await inPanes("stories");
      await act(async () => await vi.advanceTimersByTimeAsync(10));
      expect(document.title).toBe("Dashboard · Lamo Stories · Clip Factory");
      expect(meta.content.toLowerCase()).toBe("#1c1842");
      expect(host.querySelectorAll("#main")).toHaveLength(1);
      expect(host.querySelector("#main")?.classList.contains("st-main")).toBe(true);

      // Clip Factory comes on screen: its title is its own (its shell sets it), the theme colour goes back.
      document.title = "Library · Clip Factory";
      await inPanes("clips");
      expect(meta.content).toBe("#0F372B");
      expect(host.querySelectorAll("#main")).toHaveLength(1);
      expect(host.querySelector("#main")?.classList.contains("clips-main")).toBe(true);
      const lists = vi.mocked(fake.listWorkspaces!).mock.calls.length;
      const dashboards = vi.mocked(fake.dashboard!).mock.calls.length;
      document.title = "Jobs · Clip Factory";
      await act(async () => await vi.advanceTimersByTimeAsync(60_000));
      expect(document.title).toBe("Jobs · Clip Factory");
      expect(fake.dashboard).toHaveBeenCalledTimes(dashboards);
      expect(fake.listWorkspaces).toHaveBeenCalledTimes(lists);
      expect(host.querySelector('[data-app-pane="stories"] .stories-app')).not.toBeNull();

      // Back: at once, on the same page, its title and colour again, checked and polled again.
      await inPanes("stories");
      await act(async () => await vi.advanceTimersByTimeAsync(10));
      expect(document.title).toBe("Dashboard · Lamo Stories · Clip Factory");
      expect(meta.content.toLowerCase()).toBe("#1c1842");
      expect(vi.mocked(fake.listWorkspaces!).mock.calls.length).toBeGreaterThan(lists);
      expect(vi.mocked(fake.dashboard!).mock.calls.length).toBeGreaterThan(dashboards);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a page change that waited while Clip Factory was on screen happens the moment Lamo Stories is back", async () => {
    history.replaceState(null, "", "/stories/ideas");
    await inPanes("stories", { name: "ideas" });
    await flush();
    history.replaceState(null, "", "/jobs");
    await inPanes("clips", { name: "ideas" });
    navigated.length = 0;
    storiesGoLater("/stories/production/S1");
    await flush();
    expect(navigated, "the owner stays in Clip Factory").toEqual([]);
    history.replaceState(null, "", "/stories/ideas");
    await inPanes("stories", { name: "ideas" });
    await flush();
    expect(navigated).toContainEqual({ to: "/stories/production/S1", replace: true });
    history.replaceState(null, "", "/");
  });

  it("comes back where its window was scrolled to (the switch scrolled the window to the top)", async () => {
    const to: number[] = [];
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(5000);
    vi.spyOn(window, "scrollTo").mockImplementation(((o: ScrollToOptions) => {
      to.push(o.top ?? 0);
      Object.defineProperty(window, "scrollY", { value: o.top ?? 0, configurable: true });
    }) as typeof window.scrollTo);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    try {
      history.replaceState(null, "", "/stories/library");
      await inPanes("stories", { name: "library", kind: null, storyId: null });
      await flush();
      expect(to).toEqual([]);
      // The owner leaves from far down the Library (the switcher keeps where the window was).
      saveStoriesScroll("/stories/library", 1400);
      history.replaceState(null, "", "/jobs");
      await inPanes("clips", { name: "library", kind: null, storyId: null });
      await flush();
      expect(to, "nothing moves while Clip Factory is on screen").toEqual([]);
      history.replaceState(null, "", "/stories/library");
      await inPanes("stories", { name: "library", kind: null, storyId: null });
      await flush();
      expect(to).toEqual([1400]);
      expect(takeStoriesScroll("/stories/library"), "read once").toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      history.replaceState(null, "", "/");
    }
  });

  it("never runs the Mac download host or the app badge itself: the shell runs them once, for both apps (§45.37 A2)", async () => {
    await inPanes("stories");
    await flush();
    expect(host.querySelectorAll("[data-host]")).toHaveLength(0);
    await inPanes("clips");
    await inPanes("stories");
    await flush();
    expect(host.querySelectorAll("[data-host]")).toHaveLength(0);
    const read = (path: string) => readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");
    // BothApps draws them once, outside both panes; Clip Factory's shell draws its own only with Lamo Stories off.
    const app = read("app/App.tsx");
    expect(app).toMatch(/<WorkspaceDock \/>\s*<AppBadge \/>\s*<MacFetchHost \/>\s*<\/>/);
    expect(app).toMatch(/\{hosted \? null : \(\s*<>\s*<AppBadge \/>\s*<MacFetchHost \/>/);
    // Nothing of Clip Factory's own is drawn by Lamo Stories: no Content Rewards banner, no badge, no Mac host.
    const stories = read("stories/StoriesApp.tsx");
    for (const name of ["CrSendNow", "AppBadge", "MacFetchHost"]) expect(stories, name).not.toContain(name);
  });
});

describe("Continue: the project open last", () => {
  const STORY = { storyId: "S1", title: "Pip and the icy hill", status: "review" } as Story;

  it("names each kind of project and links to its page; a video still being made opens in Production", async () => {
    const api = {
      listIdeas: vi.fn(async () => [{ ideaId: "I1", title: "Snow day" } as Idea]),
      getStory: vi.fn(async () => ({ story: STORY, job: null, script: null })),
      getCharacter: vi.fn(async () => ({ characterId: "C1", name: "Pip" }) as Character),
      getReference: vi.fn(async () => ({ reference: { refId: "R1", title: "Rainy drive" } as ReferenceVideo, analysis: null })),
    } as unknown as StoriesApi;
    expect(await openProject(api, "stories", { kind: "idea", id: "I1" })).toEqual({ kind: "idea", name: "Snow day", href: "/stories/production/new?idea=I1" });
    expect(await openProject(api, "stories", { kind: "story", id: "S1" })).toEqual({ kind: "story", name: "Pip and the icy hill", href: "/stories/review/S1" });
    expect(await openProject(api, "stories", { kind: "character", id: "C1" })).toEqual({ kind: "character", name: "Pip", href: "/stories/characters/C1" });
    expect(await openProject(api, "stories", { kind: "reference", id: "R1" })).toEqual({ kind: "reference", name: "Rainy drive", href: "/stories/references/R1" });
    vi.mocked(api.getStory).mockResolvedValueOnce({ story: { ...STORY, status: "producing" }, job: null, script: null });
    expect((await openProject(api, "stories", { kind: "story", id: "S1" }))?.href).toBe("/stories/production/S1");
    expect(await openProject(api, "stories", { kind: "idea", id: "GONE" })).toBeNull();
  });

  it("knows a deleted project from a workspace that is gone", () => {
    expect(projectGone(new ApiError(404, "not_found", "We could not find that video. It may have been deleted."))).toBe(true);
    expect(projectGone(new ApiError(404, "not_found", "We could not find that workspace."))).toBe(false);
    expect(projectGone(new ApiError(503, "internal", "Try again."))).toBe(false);
  });

  const visit = async (path: string) => {
    history.replaceState(null, "", path);
    rememberStoriesPath(path, "stories");
    history.replaceState(null, "", "/");
  };

  it("shows on the dashboard with the project's name and goes to it", async () => {
    await visit("/stories/review/S1");
    fake.getStory = vi.fn(async () => ({ story: STORY, job: null, script: null }));
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    await flush();
    await flush();
    const card = host.querySelector<HTMLAnchorElement>("a.st-continue");
    expect(card?.textContent).toContain("Continue: Pip and the icy hill");
    expect(card?.textContent).toContain("The video you had open");
    expect(card?.getAttribute("href")).toBe("/stories/review/S1");
  });

  it("is hidden, and forgotten, once the project is gone (404)", async () => {
    await visit("/stories/characters/C9");
    fake.getCharacter = vi.fn(async () => {
      throw new ApiError(404, "not_found", "We could not find that character.");
    });
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    await flush();
    await flush();
    expect(host.querySelector(".st-continue")).toBeNull();
    expect(currentChoice().lastProject).toBeNull();
  });

  it("stays (not shown this time) when the server only had a hiccup", async () => {
    await visit("/stories/characters/C1");
    fake.getCharacter = vi.fn(async () => {
      throw new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
    });
    setStoriesApi(fake as StoriesApi);
    await act(async () => root.render(<ToastProvider><StoriesApp page={{ name: "dashboard" }} /></ToastProvider>));
    await flush();
    await flush();
    expect(host.querySelector(".st-continue")).toBeNull();
    expect(currentChoice().lastProject).toEqual({ kind: "character", id: "C1" });
  });
});
