// The Lamo Stories shell's workspace check in the web (docs/CONTRACTS.md §45.16.2): the workspace shown is always one
// from the server's own list (the callback's ?ws= only when it is one of them, else the last one used here, else the
// first), a "We could not find that workspace." answer asks for the list once more and falls back, the Needs you bar
// shows the first thing that needs the owner, the page title and theme colour go back when the shell leaves, and the
// first time a studio opens its setup opens by itself, on its own, once per studio on this device (§45.29).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { setStoriesApi } from "../src/stories/api/client.ts";
import type { StoriesApi, StoriesDashboard, Workspace } from "../src/stories/api/types.ts";
import type { Onboarding } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory, storiesPrefs } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/components/CrSendNow.tsx", () => ({ CrSendNow: () => null }));
vi.mock("../src/lib/badge.ts", () => ({ AppBadge: () => null }));
vi.mock("../src/app/MacFetchHost.tsx", () => ({ MacFetchHost: () => null }));

const navigated: string[] = [];
vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: (to: string) => navigated.push(to) };
});

const { StoriesApp, chooseWorkspace, isWorkspaceGone, opensSetup, pickWorkspace } = await import("../src/stories/StoriesApp.tsx");

const onboarding = (done: number, skipped = 0, finishedAt: string | null = null): Onboarding => ({
  steps: ["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"].map((step, i) => ({
    step: step as Onboarding["steps"][number]["step"],
    label: step,
    state: i < done ? "done" : i < done + skipped ? "skipped" : "todo",
  })),
  done,
  total: 11,
  finishedAt,
});

const ws = (id: string, type: Workspace["workspaceType"], name = id): Workspace => ({ workspaceId: id, workspaceName: name, workspaceType: type, builtin: type === "clips", configuration: {}, version: 1 });
const CLIPS = ws("clips", "clips", "Lamo Clips");
const STORIES = ws("stories", "stories", "Lamo Stories");
const CARS = ws("01JZ0000000000000000000000", "stories", "Lamo Cars");

const dash = (sentence: string | null): StoriesDashboard => ({
  counts: { made: 1, review: 0, published: 0, producing: 0, needsCheck: 0, needsYou: sentence ? 1 : 0 },
  needsYou: sentence ? [{ publishingJobId: null, storyId: null, title: "TikTok", platform: "tiktok", sentence, href: "/stories/connections" }] : [],
  producing: [],
  accounts: [],
  performance: { views: 0, likes: 0, comments: 0, shares: 0, posts: 0, checkedAt: null, lastAt: null },
  activity: [],
});

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("picking the workspace", () => {
  const list = [CLIPS, STORIES, CARS];

  it("uses the callback's ?ws= only when it is one of the owner's Lamo Stories workspaces", () => {
    expect(chooseWorkspace(list, CARS.workspaceId, null)).toBe(CARS.workspaceId);
    expect(chooseWorkspace(list, "clips", null)).toBe("stories");
    expect(chooseWorkspace(list, "01JZ9999999999999999999999", null)).toBe("stories");
  });

  it("else the last one used on this device when it still is one, else the first", () => {
    expect(chooseWorkspace(list, null, CARS.workspaceId)).toBe(CARS.workspaceId);
    expect(chooseWorkspace([CLIPS, STORIES], null, CARS.workspaceId)).toBe("stories");
    expect(chooseWorkspace([CLIPS], null, null)).toBeNull();
    expect(pickWorkspace(list, "clips")).toBe("stories");
  });

  it("can leave out a workspace that turned out to be gone", () => {
    expect(chooseWorkspace(list, null, "stories", ["stories"])).toBe(CARS.workspaceId);
  });

  it("knows the server's 'gone' sentence from any other not found", () => {
    expect(isWorkspaceGone(new ApiError(404, "not_found", "We could not find that workspace."))).toBe(true);
    expect(isWorkspaceGone(new ApiError(404, "not_found", "We could not find that story."))).toBe(false);
    expect(isWorkspaceGone(new Error("We could not find that workspace."))).toBe(false);
  });
});

describe("the first-time setup", () => {
  it("opens by itself only for a studio that has not started it, from the dashboard, once per device", () => {
    expect(opensSetup({ name: "dashboard" }, "stories", onboarding(0), [])).toBe(true);
    expect(opensSetup({ name: "dashboard" }, "stories", onboarding(0), ["stories"])).toBe(false);
    expect(opensSetup({ name: "dashboard" }, "stories", onboarding(2), [])).toBe(false);
    expect(opensSetup({ name: "dashboard" }, "stories", onboarding(0, 1), [])).toBe(false);
    expect(opensSetup({ name: "dashboard" }, "stories", onboarding(0, 0, "2026-11-21T12:00:00.000Z"), [])).toBe(false);
    expect(opensSetup({ name: "dashboard" }, "stories", null, [])).toBe(false);
    // An OAuth return or a link to another page is never taken away.
    expect(opensSetup({ name: "connections", platform: "x", result: "connected", ws: "stories" }, "stories", onboarding(0), [])).toBe(false);
  });
});

describe("the shell", () => {
  let host: HTMLElement;
  let root: Root;
  let fake: Partial<StoriesApi>;
  let meta: HTMLMetaElement;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf.storiesPreview", "1");
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    navigated.length = 0;
    meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#0F372B";
    document.head.appendChild(meta);
    document.title = "Home · Clip Factory";
    fake = {
      listWorkspaces: vi.fn(async () => [CLIPS, STORIES, CARS]),
      dashboard: vi.fn(async () => dash("Clips Funded's TikTok needs connecting again.")),
      getOnboarding: vi.fn(async () => onboarding(4)),
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

  const mount = async () => {
    await act(async () =>
      root.render(
        <ToastProvider>
          <StoriesApp page={{ name: "dashboard" }} />
        </ToastProvider>,
      ),
    );
    await flush();
    await flush();
  };

  it("checks the workspace list before the first screen, then shows its own navigation and the Needs you bar", async () => {
    await mount();
    expect(fake.listWorkspaces).toHaveBeenCalled();
    expect(host.querySelector(".stories-app")?.getAttribute("data-ws")).toBe("stories");
    expect([...host.querySelectorAll(".st-rail__label")].map((e) => e.textContent)).toEqual([
      "Dashboard",
      "Ideas",
      "Characters",
      "Cars",
      "Production",
      "Review",
      "Series",
      "Chat",
      "References",
      "Library",
      "Social accounts",
      "Settings",
    ]);
    expect(host.querySelector(".st-needs")?.textContent).toContain("Clips Funded's TikTok needs connecting again.");
    // Lamo Clips' Ask and setup to-do are not part of Lamo Stories.
    expect(host.querySelector(".help-launcher, .setup-todo")).toBeNull();
  });

  it("the first time, goes to the setup by itself (once), shown on its own without the navigation", async () => {
    fake.getOnboarding = vi.fn(async () => onboarding(0));
    setStoriesApi(fake as StoriesApi);
    await mount();
    expect(navigated).toEqual(["/stories/setup"]);
    expect(storiesPrefs().setupShown).toEqual(["stories"]);
    // The router then shows the setup page: on its own, no rail, no tab bar, no Needs you bar.
    await act(async () =>
      root.render(
        <ToastProvider>
          <StoriesApp page={{ name: "setup" }} />
        </ToastProvider>,
      ),
    );
    await flush();
    expect(host.querySelector(".stories-app.is-alone")).not.toBeNull();
    expect(host.querySelector(".st-rail, .st-tabbar, .st-needs")).toBeNull();
    // Leaving the setup brings the navigation back.
    await act(async () =>
      root.render(
        <ToastProvider>
          <StoriesApp page={{ name: "ideas" }} />
        </ToastProvider>,
      ),
    );
    await flush();
    expect(host.querySelector(".stories-app.is-alone")).toBeNull();
    expect(host.querySelector(".st-rail")).not.toBeNull();
    // The phone's tab bar carries the shared mark the app's dropdown keeps its list above (Dropdown.tsx).
    expect(host.querySelector(".st-tabbar[data-bottom-bar]")).not.toBeNull();
  });

  it("does not go to the setup by itself once it has started, or when it was shown here before", async () => {
    await mount();
    expect(navigated).toEqual([]);
    fake.getOnboarding = vi.fn(async () => onboarding(0));
    localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"] }));
    resetWorkspaceMemory();
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(navigated).toEqual([]);
  });

  it("falls back to another workspace once when the server says this one is gone", async () => {
    localStorage.setItem("cf.workspace", JSON.stringify({ workspaceId: "stories", lastStoriesWorkspaceId: "stories", lastClipsPath: "/", lastStoriesPath: "/stories" }));
    resetWorkspaceMemory();
    let lists = 0;
    fake.listWorkspaces = vi.fn(async () => (lists++ === 0 ? [CLIPS, STORIES, CARS] : [CLIPS, CARS]));
    fake.dashboard = vi.fn(async (id: string) => {
      if (id === "stories") throw new ApiError(404, "not_found", "We could not find that workspace.");
      return dash(null);
    });
    setStoriesApi(fake as StoriesApi);
    await mount();
    await flush();
    await flush();
    expect(fake.listWorkspaces).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".stories-app")?.getAttribute("data-ws")).toBe(CARS.workspaceId);
  });

  it("says so plainly when there is no Lamo Stories workspace at all", async () => {
    fake.listWorkspaces = vi.fn(async () => [CLIPS]);
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clips Funded is not ready yet");
  });

  it("gives the page title and the theme colour back to Lamo Clips when it leaves", async () => {
    await mount();
    expect(meta.content.toLowerCase()).toBe("#1c130e");
    document.title = "Dashboard · Clips Funded · Clip Factory";
    act(() => root.render(<ToastProvider>{null}</ToastProvider>));
    expect(meta.content).toBe("#0F372B");
    expect(document.title).toBe("Home · Clip Factory");
  });
});
