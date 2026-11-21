// The workspace choice on this device (docs/CONTRACTS.md §45.16.1): localStorage `cf.workspace` keeps the last
// workspace, the last page of each, and Lamo Stories' open conversation and project; switching goes back to the
// exact page left (Clip Factory's at its scroll position, sessionStorage); the app opened at "/" with Lamo Stories
// last goes to the last Lamo Stories page; Lamo Stories' own device preferences live in `cf.stories.prefs`, never in
// Clip Factory's `cf.prefs`; and nothing unsafe or broken in storage is ever followed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/stories/api/types.ts";
import {
  cleanPath,
  currentChoice,
  DEFAULT_CHOICE,
  openedOn,
  rememberConversation,
  rememberProject,
  restoreScroll,
  saveClipsScroll,
  SCROLL_KEY,
  setStoriesPref,
  setStoriesPrefs,
  STORIES_PREFS_KEY,
  storiesPref,
  storiesPrefs,
  switcherName,
  takeClipsScroll,
  DEFAULT_WORKSPACES,
  knownWorkspaces,
  onChoiceChange,
  readChoice,
  rememberClipsPath,
  rememberStoriesPath,
  resetWorkspaceMemory,
  settleSwitch,
  wantedStoriesWorkspace,
  setKnownWorkspaces,
  startPath,
  storiesTitle,
  switchTarget,
  WORKSPACE_KEY,
} from "../src/stories/workspace.ts";

const ws = (id: string, type: Workspace["workspaceType"], name = id): Workspace => ({ workspaceId: id, workspaceName: name, workspaceType: type, builtin: type === "clips", configuration: {}, version: 1 });
const CLIPS = ws("clips", "clips", "Lamo Clips");
const STORIES = ws("stories", "stories", "Lamo Stories");
const CARS = ws("01JZ0000000000000000000000", "stories", "Lamo Cars");

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetWorkspaceMemory();
});
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("the stored choice", () => {
  it("starts in Lamo Clips with no last pages", () => {
    expect(readChoice()).toEqual(DEFAULT_CHOICE);
    expect(DEFAULT_CHOICE).toEqual({ workspaceId: "clips", lastStoriesWorkspaceId: null, lastClipsPath: "/", lastStoriesPath: "/stories", lastConversationId: null, lastProject: null });
  });

  it("keeps the last page of each workspace and the workspace last used, across a reload", () => {
    rememberClipsPath("/library?view=week");
    rememberStoriesPath("/stories/ideas", "stories");
    resetWorkspaceMemory(); // a reload: only localStorage is left
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!)).toEqual({
      workspaceId: "stories",
      lastStoriesWorkspaceId: "stories",
      lastClipsPath: "/library?view=week",
      lastStoriesPath: "/stories/ideas",
      lastConversationId: null,
      lastProject: null,
    });
    expect(currentChoice().workspaceId).toBe("stories");
  });

  it("keeps Lamo Stories' open conversation and project (from the page's address, or told by a screen)", () => {
    rememberStoriesPath("/stories/chat/01JZCONV000000000000000000", "stories");
    rememberStoriesPath("/stories/review/01JZSTORY00000000000000000", "stories");
    expect(currentChoice()).toMatchObject({ lastConversationId: "01JZCONV000000000000000000", lastProject: { kind: "story", id: "01JZSTORY00000000000000000" } });
    // Other pages keep both; a screen can say which ones (or forget a deleted conversation).
    rememberStoriesPath("/stories/library", "stories");
    expect(currentChoice().lastConversationId).toBe("01JZCONV000000000000000000");
    rememberProject({ kind: "reference", id: "r1" });
    rememberConversation(null);
    resetWorkspaceMemory();
    expect(currentChoice()).toMatchObject({ lastConversationId: null, lastProject: { kind: "reference", id: "r1" } });
    expect(openedOn({ name: "production_new", ideaId: "i9" }).project).toEqual({ kind: "idea", id: "i9" });
    expect(openedOn({ name: "character", characterId: "c2" }).project).toEqual({ kind: "character", id: "c2" });
    // Another Lamo Stories workspace has its own conversations: switching there forgets them.
    settleSwitch(CARS);
    expect(currentChoice()).toMatchObject({ lastConversationId: null, lastProject: null });
  });

  it("never keeps a broken conversation or project", () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ lastConversationId: "../x", lastProject: { kind: "skill", id: "s" } }));
    expect(readChoice()).toMatchObject({ lastConversationId: null, lastProject: null });
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ lastProject: { kind: "story", id: "a b" } }));
    expect(readChoice().lastProject).toBeNull();
  });

  it("never follows a broken or unsafe value: another site, a backslash, a page of the wrong workspace", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ workspaceId: "../x", lastClipsPath: "//evil.example/", lastStoriesPath: "https://evil.example/stories" }),
      JSON.stringify({ workspaceId: "stories", lastClipsPath: "/stories/ideas", lastStoriesPath: "/jobs" }),
      JSON.stringify({ lastClipsPath: "/\\evil.example", lastStoriesPath: "/stories\n/x", lastStoriesWorkspaceId: "clips" }),
      JSON.stringify(null),
      JSON.stringify([1, 2]),
    ]) {
      localStorage.setItem(WORKSPACE_KEY, bad);
      const c = readChoice();
      expect(c.lastClipsPath, bad).toBe("/");
      expect(c.lastStoriesPath, bad).toBe("/stories");
      expect(c.lastStoriesWorkspaceId, bad).toBeNull();
      expect(["clips", "stories"]).toContain(c.workspaceId);
    }
  });

  it("drops the words that are only for one visit (a connect's result, the OAuth return)", () => {
    expect(cleanPath("/stories/connections?platform=youtube&result=connected&ws=stories")).toBe("/stories/connections");
    expect(cleanPath("/settings/posting/setup/youtube?result=connected")).toBe("/settings/posting/setup/youtube");
    expect(cleanPath("/library?view=week&week=2026-W47#top")).toBe("/library?view=week&week=2026-W47#top");
    rememberStoriesPath("/stories/connections?platform=x&result=denied&ws=stories", "stories");
    expect(currentChoice().lastStoriesPath).toBe("/stories/connections");
  });

  it("ignores pages of the other workspace and addresses that are not the app's", () => {
    rememberClipsPath("/stories/ideas");
    rememberStoriesPath("/jobs", "stories");
    rememberClipsPath("https://evil.example/");
    expect(currentChoice()).toEqual(DEFAULT_CHOICE);
  });

  it("tells listeners only when the workspace changes, not on every page", () => {
    let calls = 0;
    const off = onChoiceChange(() => calls++);
    rememberClipsPath("/jobs");
    rememberClipsPath("/review");
    expect(calls).toBe(0);
    rememberStoriesPath("/stories", "stories");
    expect(calls).toBe(1);
    rememberStoriesPath("/stories/library", "stories");
    expect(calls).toBe(1);
    off();
  });
});

describe("switching", () => {
  it("goes to the exact page left in the other workspace, both ways", () => {
    rememberClipsPath("/review?job=01JZ0000000000000000000000");
    expect(switchTarget(STORIES)).toBe("/stories");
    settleSwitch(STORIES);
    rememberStoriesPath("/stories/library?kind=videos", "stories");
    expect(switchTarget(CLIPS)).toBe("/review?job=01JZ0000000000000000000000");
    settleSwitch(CLIPS);
    // Back in Lamo Clips its first page records the choice (the sidebar's tracker).
    rememberClipsPath("/review?job=01JZ0000000000000000000000");
    expect(currentChoice().workspaceId).toBe("clips");
    expect(switchTarget(STORIES)).toBe("/stories/library?kind=videos");
    settleSwitch(STORIES);
    expect(currentChoice().workspaceId).toBe("stories");
  });

  it("opens a different Lamo Stories workspace at its dashboard (its pages are its own)", () => {
    rememberStoriesPath("/stories/characters", "stories");
    expect(switchTarget(CARS)).toBe("/stories");
    settleSwitch(CARS);
    expect(currentChoice()).toMatchObject({ workspaceId: CARS.workspaceId, lastStoriesWorkspaceId: CARS.workspaceId });
  });

  it("records nothing until the page really changed: a 'Leave without saving?' the owner stays on leaves the choice as it was", () => {
    rememberClipsPath("/settings/clip-making/skills/new");
    let calls = 0;
    const off = onChoiceChange(() => calls++);
    // A tap on Lamo Stories while a page is holding the owner: the target is worked out, nothing is written.
    expect(switchTarget(STORIES)).toBe("/stories");
    expect(currentChoice().workspaceId).toBe("clips");
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).workspaceId).toBe("clips");
    expect(calls).toBe(0);
    // ...the app opened at "/" later still stays in Lamo Clips.
    resetWorkspaceMemory();
    expect(startPath("/", "", "", true)).toBeNull();
    // The way back from Lamo Stories asks nobody: nothing fires for a switch that never happened.
    rememberStoriesPath("/stories/ideas", "stories");
    calls = 0;
    switchTarget(CLIPS);
    expect(calls).toBe(0);
    expect(currentChoice().workspaceId).toBe("stories");
    off();
  });

  it("tells Lamo Stories which workspace a switch is on its way to, until a page of it (or of Lamo Clips) opens", () => {
    rememberStoriesPath("/stories/ideas", "stories");
    expect(wantedStoriesWorkspace()).toBe("stories");
    switchTarget(CARS);
    expect(wantedStoriesWorkspace()).toBe(CARS.workspaceId);
    expect(currentChoice().lastStoriesWorkspaceId).toBe("stories");
    // Lamo Stories opened it: the choice is recorded from that page, and nothing is pending any more.
    rememberStoriesPath("/stories", CARS.workspaceId);
    expect(currentChoice().lastStoriesWorkspaceId).toBe(CARS.workspaceId);
    switchTarget(STORIES);
    // The owner stayed in Lamo Clips and went on to another page: the tap is forgotten.
    rememberClipsPath("/jobs");
    expect(wantedStoriesWorkspace()).toBe(CARS.workspaceId);
  });
});

describe("Clip Factory's scroll position across a switch", () => {
  it("is kept for the page the owner left, read once, and only for that page", () => {
    saveClipsScroll("/library?view=week", 812.4);
    expect(JSON.parse(sessionStorage.getItem(SCROLL_KEY)!)).toEqual({ path: "/library?view=week", y: 812 });
    expect(takeClipsScroll("/jobs")).toBeNull();
    saveClipsScroll("/library?view=week", 812);
    expect(takeClipsScroll("/library?view=week")).toBe(812);
    expect(takeClipsScroll("/library?view=week")).toBeNull();
    saveClipsScroll("/stories/ideas", 300);
    expect(sessionStorage.getItem(SCROLL_KEY)).toBeNull();
  });

  it("scrolls back once the page is tall enough, and lets go when the owner scrolls first", async () => {
    const to = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 3000 });
    restoreScroll(700);
    await vi.waitFor(() => expect(to).toHaveBeenCalledWith({ top: 700, behavior: "instant" }));
    to.mockClear();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 100 });
    restoreScroll(900, 10_000);
    window.dispatchEvent(new Event("wheel"));
    await new Promise((r) => setTimeout(r, 60));
    expect(to).not.toHaveBeenCalled();
    to.mockRestore();
  });
});

describe("Lamo Stories' own device preferences", () => {
  it("live in cf.stories.prefs, never in Clip Factory's cf.prefs", () => {
    setStoriesPrefs({ setupShown: ["stories"] });
    expect(JSON.parse(localStorage.getItem(STORIES_PREFS_KEY)!)).toEqual({ setupShown: ["stories"], more: {} });
    expect(localStorage.getItem("cf.prefs")).toBeNull();
    resetWorkspaceMemory();
    expect(storiesPrefs().setupShown).toEqual(["stories"]);
    localStorage.setItem(STORIES_PREFS_KEY, JSON.stringify({ setupShown: ["../x", 4, "stories"], more: { "bad key": 1, "chat.wide": true } }));
    resetWorkspaceMemory();
    expect(storiesPrefs()).toEqual({ setupShown: ["stories"], more: { "chat.wide": true } });
  });

  it("keep any screen's own preference by its key, of the same kind as asked, small", () => {
    expect(storiesPref("chat.enterSends", true)).toBe(true);
    setStoriesPref("chat.enterSends", false);
    expect(storiesPref("chat.enterSends", true)).toBe(false);
    expect(storiesPref("chat.enterSends", "x")).toBe("x");
    setStoriesPref("chat.enterSends", null);
    expect(storiesPref("chat.enterSends", true)).toBe(true);
    setStoriesPref("big", "x".repeat(5000));
    expect(storiesPref("big", "")).toBe("");
    setStoriesPref("../evil", 1);
    expect(Object.keys(storiesPrefs().more)).toEqual([]);
    expect(localStorage.getItem("cf.prefs")).toBeNull();
  });
});

describe("opening the app", () => {
  it("at / with Lamo Stories last, goes to the last Lamo Stories page", () => {
    rememberStoriesPath("/stories/review", "stories");
    expect(startPath("/", "", "", true)).toBe("/stories/review");
  });

  it("stays put with Lamo Clips last, on any other address, and while Lamo Stories is off", () => {
    expect(startPath("/", "", "", true)).toBeNull();
    rememberStoriesPath("/stories/review", "stories");
    expect(startPath("/", "", "", false)).toBeNull();
    expect(startPath("/jobs", "", "", true)).toBeNull();
    expect(startPath("/", "?x=1", "", true)).toBeNull();
    expect(startPath("/", "", "#a", true)).toBeNull();
  });
});

describe("the workspace list", () => {
  it("shows Clip Factory and Lamo Stories until the server answers", () => {
    expect(knownWorkspaces()).toEqual(DEFAULT_WORKSPACES);
    expect(knownWorkspaces().map(switcherName)).toEqual(["Clip Factory", "Lamo Stories"]);
  });

  it("labels Lamo Clips with the app's own name, whatever the server calls it, and other workspaces by theirs", () => {
    expect(switcherName(CLIPS)).toBe("Clip Factory");
    expect(switcherName(CARS)).toBe("Lamo Cars");
  });

  it("then every workspace the server lists, Lamo Clips first, never two Lamo Clips", () => {
    setKnownWorkspaces([STORIES, CLIPS, CARS, ws("clips2", "clips")]);
    expect(knownWorkspaces().map((w) => w.workspaceId)).toEqual(["clips", "stories", CARS.workspaceId]);
  });
});

it("names each Lamo Stories page in the tab title", () => {
  expect(storiesTitle({ name: "dashboard" })).toBe("Dashboard · Lamo Stories");
  expect(storiesTitle({ name: "connections", platform: null, result: null, ws: null })).toBe("Social accounts · Lamo Stories");
  expect(storiesTitle({ name: "setup" })).toBe("Set up · Lamo Stories");
  expect(storiesTitle({ name: "chat_conv", convId: "c" })).toBe("Chat · Lamo Stories");
});
