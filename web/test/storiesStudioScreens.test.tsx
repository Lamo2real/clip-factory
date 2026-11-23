// The Lamo Stories studio screens (docs/CONTRACTS.md §45.16.5, §45.16.6, §45.25; spec §5.B–E and the second request
// §3–§5): Ideas, Characters, Production and Review, rendered with a fake StoriesApi (setStoriesApi) built from the
// mock's ideas, characters and stories parts plus small stand-ins for the rest (Lamo Stories' own models from
// stories/config/models.json, reference videos, social accounts). Only storiesApi() is used; nothing leaves the machine.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { GuidanceTopic, ModelInfo, PublishingJob, ReferenceVideo, SocialAccount, StoriesApi, StoriesConfig, TikTokCreator, Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no canvas: the engine previews draw nothing, quietly.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen, adviceLine } = await import("../src/stories/screens/Ideas.tsx");
const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen, approveBlock } = await import("../src/stories/screens/Review.tsx");
const { optionsFor, PublishSheet } = await import("../src/stories/studio/PublishSheet.tsx");
const { NO_TIKTOK_CHOICES } = await import("../src/lib/tiktokChoices.ts");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Lamo Stories",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 50,
    captionsOn: false,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1920", aspect: "9:16", quality: "high", fps: 30 },
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "1",
    youtubePrivacy: "unlisted",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};

const account = (platform: SocialAccount["platform"], connectionStatus: SocialAccount["connectionStatus"], accountName: string | null): SocialAccount => ({
  socialAccountId: `stories.${platform}`,
  workspaceId: "stories",
  platform,
  app: { choice: platform === "instagram" || platform === "facebook" ? "own" : "clips", saved: true },
  lastCheckedAt: accountName ? "2026-11-21T09:00:00.000Z" : null,
  connectionStatus,
  externalAccountId: accountName ? `ext-${platform}` : null,
  accountName,
  handle: null,
  avatarUrl: null,
  sharedWithClips: false,
  connectedAt: null,
  missing: [],
  reason: null,
  reconnectBy: null,
  choices: null,
  limits: [],
  warning: null,
});

const CREATOR: TikTokCreator = {
  nickname: "Clips Funded",
  username: "funded.clips",
  avatarUrl: null,
  privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxDurationSec: 600,
};

const TOPICS: GuidanceTopic[] = ideas.guidanceTopicIds().map((id) => ({ id, title: ideas.topicTitle(id)!, steps: [], donts: [], caveats: [], citations: ideas.citationsFor(id) }));

/** Lamo Stories' own models as Settings › AI would answer once they were checked (one refused). */
const MODELS: ModelInfo[] = LISTED_INFO.models.map((m) => (m.key === "haiku-5-5" ? { ...m, status: "denied", statusLine: "Bedrock says this account can't use it yet." } : { ...m, status: "ok", statusLine: "Ready." }));

const REFS: ReferenceVideo[] = [
  { refId: "01JSTRV0000000000000000001", title: "The banana slip", status: "analyzed", durationSec: 38, bytes: 9_000_000, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: { model: "opus-5-5", effort: "high" }, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z" },
  { refId: "01JSTRV0000000000000000002", title: "Snow day sketch", status: "ready", durationSec: null, bytes: 5_000_000, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: null, createdAt: "2026-11-20T11:00:00.000Z", updatedAt: "2026-11-20T11:00:00.000Z" },
];

let store: MockStore;
let api: StoriesApi;
let pubs: PublishingJob[];
let root: Root;
let host: HTMLElement;

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  store.social.push(account("youtube", "connected", "Lamo Stories Channel"), account("tiktok", "connected", "Lamo Stories TikTok"), account("instagram", "needs_reconnect", "lamo.stories"), account("facebook", "not_connected", null), account("x", "not_connected", null));
  store.references.push(...structuredClone(REFS));
  pubs = [];
  const now = "2026-11-21T12:00:00.000Z";
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    patchWorkspace: async () => store.workspaces[0]!,
    dashboard: async () => Promise.reject(new Error("not used")),
    library: async () => ({ items: [], nextCursor: null }),
    providers: async () => [],
    guidance: async () => ({ topics: TOPICS, checkedAt: now }),
    social: async () => ({ accounts: structuredClone(store.social), clips: [] }),
    connectSocial: async () => ({ authorizeUrl: "/", expiresAt: now }),
    chooseSocial: async () => store.social[0]!,
    tiktokCreatorInfo: async () => CREATOR,
    disconnectSocial: async () => undefined,
    publish: async (ws, storyId, targets) => {
      const made = targets.map((t, i): PublishingJob => ({ publishingJobId: `pj${i}`, workspaceId: ws, contentId: storyId, socialAccountId: t.socialAccountId, platform: t.platform, publishingStatus: "queued", accountName: store.social.find((a) => a.platform === t.platform)?.accountName ?? null, createdAt: now, updatedAt: now }));
      pubs.push(...made);
      return structuredClone(made);
    },
    listPublishing: async () => structuredClone(pubs),
    retryPublishing: async (_ws, id) => {
      const j = pubs.find((x) => x.publishingJobId === id)!;
      j.publishingStatus = "queued";
      delete j.error;
      return structuredClone(j);
    },
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(MODELS), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
    listReferences: async () => structuredClone(store.references),
  };
  impl.checkSocial = async (_ws, platform) => {
    const a = store.social.find((x) => x.platform === platform)!;
    a.lastCheckedAt = new Date().toISOString();
    return structuredClone(a);
  };
  // Anything a studio screen never calls answers "not used".
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  forgetLoaded();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

/** Lets fake latency, polls and effects run. */
async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets an AI task run to its end the way the page reads it (every second), one short act at a time. */
async function untilTask(seconds = 5) {
  for (let i = 0; i < seconds * 4; i += 1) await wait(250);
}

async function show(node: ReactNode) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await wait();
}

const page = (p: StoriesPage) => ({ ws: "stories", page: p });

/** The button or link whose words match. */
function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label"));
  const words = (el: HTMLElement) => [el.textContent?.trim() ?? "", el.getAttribute("aria-label") ?? ""];
  const hit = all.find((el) => words(el).some((w) => (typeof name === "string" ? w === name : name.test(w))));
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}

async function click(el: HTMLElement, ms = 1500) {
  await act(async () => el.click());
  await wait(ms);
}

function type(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("not a text box");
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${String(label)}`);
  return el;
}

async function pick(group: string, option: string) {
  const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === group);
  if (!g) throw new Error(`no pick bar ${group}`);
  const opt = Array.from(g.querySelectorAll("label")).find((l) => l.querySelector(".st-s-pick__label")?.textContent?.trim() === option);
  if (!opt) throw new Error(`no option ${option}`);
  await click(opt.querySelector("input") as HTMLElement, 50);
}

const text = () => document.body.textContent ?? "";

// ---------- Ideas ----------

describe("Ideas", () => {
  it("shows the board with each safety idea's checked advice, and a safety idea without it cannot become a video", async () => {
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const cards = Array.from(document.querySelectorAll(".st-s-idea"));
    expect(cards.length).toBe(store.ideas.length);
    const deer = cards.find((c) => c.textContent?.includes("A deer on the road"))!;
    expect(deer.textContent).toMatch(/Checked advice: .*From /);
    const tractor = cards.find((c) => c.textContent?.includes("Overtaking a tractor"))!;
    expect(tractor.textContent).toContain("Needs checked advice");
    const make = control("Make the video", tractor);
    expect(make.getAttribute("aria-disabled")).toBe("true");
    await click(make);
    expect(location.pathname).toBe("/stories");
    await click(control("Make the video", deer));
    expect(location.pathname + location.search).toBe(`/stories/production/new?idea=${I.deer}`);
    expect(adviceLine({ category: "comedy", safetyTopicId: null, needsGuidance: false }, TOPICS)).toBeNull();
  });

  it("New idea: a title, one line and one of four big kinds, then Save", async () => {
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("New idea"), 50);
    await click(control("Save idea"), 50);
    expect(text()).toContain("Give the idea a title.");
    type(field("Title"), "Dash learns to juggle");
    type(field("What happens, in one line"), "Dash drops every ball, then finds the trick.");
    await pick("What kind of video?", "Funny");
    await click(control("Save idea"));
    expect(create).toHaveBeenCalledWith("stories", { title: "Dash learns to juggle", logline: "Dash drops every ball, then finds the trick.", category: "comedy", source: "manual" });
    expect(Array.from(document.querySelectorAll(".st-s-idea__title")).map((e) => e.textContent)).toContain("Dash learns to juggle");
  });

  it("Ask for ideas: a task read every second with the model and effort named, then drafts; each is saved only when Save is tapped", async () => {
    const gen = vi.spyOn(api, "generateIdeas");
    const read = vi.spyOn(api, "getTask");
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    type(field(/What about/), "a snowy day");
    await pick("What kind?", "Everyday skills");
    // The menu's button says what will run before anything is sent.
    expect(control(/^Model and effort for this one: Claude Opus 5\.5, High effort$/).textContent).toContain("Opus 5.5 · High");
    await click(control("Get ideas"), 250);
    expect(gen).toHaveBeenCalledWith("stories", { topic: "a snowy day", category: "everyday_skills", count: 4 });
    await untilTask(1.25);
    expect(document.querySelector(".st-s-busy")?.textContent).toMatch(/Thinking of ideas with Claude Opus 5\.5 · High effort…/);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(1);
    await untilTask();
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    const drafts = Array.from(document.querySelectorAll(".st-s-draft"));
    expect(drafts).toHaveLength(4);
    expect(document.querySelector(".st-s-panel .st-s-busy")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    await click(control("Save", drafts[1]!));
    expect(create).toHaveBeenCalledTimes(1);
    expect(drafts[1]!.textContent).toContain("Saved");
  });

  it("Model and effort for this one: the pick goes with that request only, and the line names it", async () => {
    const gen = vi.spyOn(api, "generateIdeas");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    await click(control(/^Model and effort for this one/), 50);
    const dialog = () => document.querySelector('[role="dialog"]')!;
    expect(dialog().textContent).toContain("Just for this one. Your settings stay the same.");
    expect(dialog().textContent).toContain("Usual: Claude Opus 5.5");
    expect(dialog().textContent).toContain("Bedrock says this account can't use it yet.");
    await pick("Model", "Claude Fable 5.2");
    await pick("Effort", "Maximum");
    await click(control("Done", dialog()), 50);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(control(/^Model and effort for this one: Claude Fable 5\.2, Maximum effort, just this one$/)).toBeDefined();
    await click(control("Get ideas"), 250);
    expect(gen).toHaveBeenLastCalledWith("stories", { count: 4, override: { model: "fable-5-2", effort: "max" } });
    await untilTask(1.25);
    expect(document.querySelector(".st-s-busy")?.textContent).toContain("with Claude Fable 5.2 · Maximum effort");
    await untilTask();
    // Back to the usual: nothing is sent but the request.
    await click(control(/^Model and effort for this one/), 50);
    await click(control("Use the usual", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Get ideas"), 50);
    expect(gen).toHaveBeenLastCalledWith("stories", { count: 4 });
  });

  it("a task that fails shows its plain sentence with Try again (and the way to Settings › AI for a refused model)", async () => {
    store.knobs.taskFail = true;
    const gen = vi.spyOn(api, "generateIdeas");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    await click(control("Get ideas"), 250);
    await untilTask();
    expect(text()).toContain("The idea helper could not finish. Tap Try again.");
    await click(control("Try again", document.querySelector(".st-s-panel")!), 250);
    await untilTask();
    expect(gen).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(".st-s-draft")).toHaveLength(4);
    store.knobs.deniedModels = ["opus-5-5"];
    await click(control("Ask for ideas"), 50);
    await click(control("Ask for ideas"), 50);
    await click(control("Get ideas"), 250);
    await untilTask();
    expect(text()).toContain("Claude Opus 5.5 isn't available right now");
    expect(control("Open Settings › AI").getAttribute("href")).toBe("/stories/settings/ai");
  });

  it("Try again after a refused model sends the model picked since, not the old one", async () => {
    store.knobs.deniedModels = ["fable-5-2"];
    const gen = vi.spyOn(api, "generateIdeas");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    await click(control(/^Model and effort for this one/), 50);
    await pick("Model", "Claude Fable 5.2");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Get ideas"), 250);
    await untilTask();
    expect(text()).toContain("Claude Fable 5.2 isn't available right now");
    // The sentence says to pick another model: the owner does, in the same menu, then taps Try again.
    await click(control(/^Model and effort for this one/), 50);
    await pick("Model", "Claude Opus 5.5");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Try again", document.querySelector(".st-s-panel")!), 250);
    expect(gen).toHaveBeenLastCalledWith("stories", { count: 4, override: { model: "opus-5-5" } });
    await untilTask(1.25);
    expect(document.querySelector(".st-s-busy")?.textContent).toContain("with Claude Opus 5.5");
    await untilTask();
    expect(document.querySelectorAll(".st-s-draft")).toHaveLength(4);
  });

  it("a task that can't be read any more stops with its sentence and Try again, and the buttons work again", async () => {
    const read = vi.spyOn(api, "getTask").mockRejectedValue(new ApiError(404, "not_found", "We could not find that task. Tap Try again."));
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const gps = () => Array.from(document.querySelectorAll(".st-s-idea")).find((c) => c.textContent?.includes("sleepy GPS"))!;
    await click(control("Make it a full idea", gps()), 250);
    await untilTask(2);
    expect(read).toHaveBeenCalled();
    expect(gps().querySelector(".st-s-busy")).toBeNull();
    expect(gps().textContent).toContain("We could not find that task. Tap Try again.");
    expect(control("Try again", gps())).toBeDefined();
    expect(control("Make it a full idea", gps()).getAttribute("aria-disabled")).toBeNull();
    // A connection that keeps dropping ends the same way after a few tries.
    read.mockReset();
    read.mockRejectedValue(new ApiError(0, "network", "Clip Factory cannot be reached. Check your connection and try again."));
    await click(control("Try again", gps()), 250);
    await untilTask(30);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(gps().textContent).toContain("Clip Factory cannot be reached.");
    expect(control("Try again", gps())).toBeDefined();
  });

  it("when Lamo Stories' settings can't be read, the menu never names a guess as the owner's usual model", async () => {
    vi.spyOn(api, "getAi").mockRejectedValue(new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment."));
    forgetLoaded();
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    const menu = control(/^Model and effort for this one/);
    expect(menu.getAttribute("aria-label")).toBe("Model and effort for this one: your usual model and effort");
    expect(menu.textContent).toContain("Usual");
    expect(menu.textContent).not.toContain("Opus");
    await click(menu, 50);
    const dialog = () => document.querySelector('[role="dialog"]')!;
    expect(dialog().textContent).toContain("Your usual model");
    expect(dialog().textContent).not.toContain("Usual: Claude");
    expect(dialog().textContent).not.toContain("From your Clips Funded settings");
    await click(control("Use the usual", dialog()), 50);
    // Until the task answers (here it never does), the line says only what is known.
    vi.spyOn(api, "generateIdeas").mockImplementation(() => new Promise(() => undefined));
    await click(control("Get ideas"), 250);
    expect(document.querySelector(".st-s-busy")?.textContent).toContain("Thinking of ideas with your usual model and effort…");
  });

  it("Make it a full idea shows the concept; More like this adds drafts that point at it; each has its own menu", async () => {
    const vary = vi.spyOn(api, "ideaVariations");
    const expand = vi.spyOn(api, "expandIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const gps = () => Array.from(document.querySelectorAll(".st-s-idea")).find((c) => c.textContent?.includes("sleepy GPS"))!;
    const menus = gps().querySelectorAll(".st-s-aipair .st-s-ai-btn");
    expect(menus).toHaveLength(2);
    await click(control("Make it a full idea", gps()), 250);
    expect(expand).toHaveBeenCalledWith("stories", I.gps, { durationSec: 50 });
    await untilTask(1.25);
    expect(gps().textContent).toContain("Writing the full idea with Claude Opus 5.5 · High effort…");
    await untilTask();
    expect(gps().querySelector(".st-s-concept")).not.toBeNull();
    expect(gps().querySelectorAll(".st-s-concept__beats li").length).toBeGreaterThanOrEqual(3);
    await click(control(/^Model and effort for this one/, gps().querySelectorAll(".st-s-aipair")[1]!), 50);
    await pick("Effort", "Low");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("More like this", gps()), 250);
    await untilTask();
    expect(vary).toHaveBeenCalledWith("stories", I.gps, { count: 3, override: { effort: "low" } });
    expect(document.querySelector(".st-s-drafts__title")?.textContent).toContain("More like");
    expect(document.querySelectorAll(".st-s-draft")).toHaveLength(3);
  });

  it("Delete hides the card at once and Undo brings it back; without Undo it is deleted", async () => {
    const del = vi.spyOn(api, "deleteIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const rainbow = () => Array.from(document.querySelectorAll(".st-s-idea")).find((c) => c.textContent?.includes("How a rainbow is made"));
    await click(control("Delete", rainbow()!), 50);
    expect(rainbow()).toBeUndefined();
    await click(control("Undo"), 50);
    expect(rainbow()).toBeDefined();
    await click(control("Delete", rainbow()!), 50);
    await wait(9000);
    expect(del).toHaveBeenCalledWith("stories", I.rainbow);
    expect(store.ideas.some((i) => i.ideaId === I.rainbow)).toBe(false);
  });
});

// ---------- Characters ----------

describe("Characters", () => {
  it("the gallery shows every character with its rig", async () => {
    await show(<CharactersScreen {...page({ name: "characters" })} />);
    const cards = Array.from(document.querySelectorAll(".st-s-cast__card"));
    expect(cards.map((c) => c.querySelector(".st-s-cast__name")?.textContent)).toEqual(["Bolt", "Dash", "Nana Rose", "Pip"]);
    expect(cards.every((c) => c.querySelector("canvas[role=img]"))).toBe(true);
  });

  it("New character: the five parts, a live preview with each face and move to try, then Save", async () => {
    const create = vi.spyOn(api, "createCharacter");
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    await pick("Shape", "Tall");
    await pick("Hair style", "Curly");
    await click(control("Next: Face"), 50);
    expect(document.querySelectorAll(".st-s-face")).toHaveLength(14);
    await click(control(/^Try\s*Shocked$/), 50);
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Shocked");
    const neutral = Array.from(document.querySelectorAll(".st-s-face")).find((f) => f.textContent?.includes("Neutral"))!;
    expect(control(/Uses it/, neutral).getAttribute("aria-disabled")).toBe("true");
    await click(control("Next: Moves"), 50);
    await pick("Try a move", "Jump");
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Jump");
    await click(control("Next: Sounds"), 50);
    // The Whoa chip itself, not its "Play Whoa" button beside it (§45.40).
    await click(control(/^[+✓]\s*Whoa$/), 50);
    await click(control("Next: Name and personality"), 50);
    await click(control("Save character"), 50);
    expect(text()).toContain("Give your character a name.");
    type(field("Name"), "Zed");
    type(field("Personality"), "Brave and kind");
    type(field(/^Traits/), "brave");
    await click(control("Add"), 50);
    await click(control("Save character"));
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![1];
    expect(sent).toMatchObject({ name: "Zed", personality: "Brave and kind", traits: ["brave"], movementStyle: "bouncy" });
    expect(sent.look).toMatchObject({ body: "tall", hair: { style: "curly" } });
    expect(sent.voice.noises).toContain("whoa");
    expect(sent.expressions).toContain("neutral");
    expect(location.pathname).toMatch(/^\/stories\/characters\/[0-9A-Z]{26}$/);
  });

  it("an edit that lost a race (409) offers Reload; delete asks first and is refused while a story with it is being made", async () => {
    const put = vi.spyOn(api, "putCharacter");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.nana })} />);
    store.characters.find((c) => c.characterId === C.nana)!.version += 1;
    await click(control("Save changes"));
    expect(put).toHaveBeenCalledTimes(1);
    expect(text()).toContain("was changed somewhere else");
    await click(control("Reload"));
    await click(control("Save changes"));
    expect(put).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Nana Rose is saved.");
    await click(control("Delete"), 50);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete Nana Rose?");
    await click(control("Delete", document.querySelector('[role="dialog"]')!));
    expect(text()).toContain("is in a story that is being made");
    expect(store.characters.some((c) => c.characterId === C.nana)).toBe(true);
  });

  it("reference pictures go up with a progress bar and can be removed; the AI picture says how to turn it on", async () => {
    const up = vi.spyOn(api, "referenceUpload");
    const done = vi.spyOn(api, "referenceComplete");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.bolt })} />);
    expect(text()).toContain("AI pictures are off");
    const input = document.querySelector<HTMLInputElement>('.st-s-refs input[type="file"]')!;
    const file = new File([new Uint8Array(4000)], "bolt.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await wait(300);
    expect(document.querySelector(".st-s-refs .st-s-progress")).not.toBeNull();
    await wait(3000);
    expect(up).toHaveBeenCalledWith("stories", C.bolt, { filename: "bolt.png", contentType: "image/png", size: 4000 });
    expect(done).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(1);
    await click(control(/Remove picture 1/));
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(0);
  });

  it("Design with AI: words and a picture make a first try in the editor; nothing is saved until Save", async () => {
    const upload = vi.spyOn(api, "designUpload");
    const design = vi.spyOn(api, "designCharacter");
    const create = vi.spyOn(api, "createCharacter");
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    await click(control("Design with AI"), 50);
    await click(control("Design it"), 50);
    expect(text()).toContain("Say what your character is like, or add a picture.");
    expect(design).not.toHaveBeenCalled();
    type(field("What is your character like?"), "A tall, clumsy robot called Zed with a blue cap who loves to dance");
    const input = document.querySelector<HTMLInputElement>('.st-s-design input[type="file"]')!;
    const file = new File([new Uint8Array(3000)], "zed.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await wait(3000);
    expect(upload).toHaveBeenCalledWith("stories", { filename: "zed.png", contentType: "image/png", size: 3000 });
    const assetId = (await upload.mock.results[0]!.value).assetId;
    await click(control("Design it"), 250);
    expect(design).toHaveBeenCalledWith("stories", { description: "A tall, clumsy robot called Zed with a blue cap who loves to dance", referenceAssetId: assetId });
    await untilTask(1.25);
    expect(document.querySelector(".st-s-design .st-s-busy")?.textContent).toContain("Designing your character with Claude Opus 5.5 · High effort");
    await untilTask();
    expect(text()).toContain("Here is a first try.");
    // The draft is in the editor, open on its name and personality to check.
    expect(field("Name").value).toBe("Zed");
    expect(create).not.toHaveBeenCalled();
    await click(control("Save character"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({ name: "Zed", movementStyle: "clumsy", look: { body: "tall", hair: { style: "cap" } } });
  });

  it("Design with AI on a character's page keeps its name and can start from one of its own pictures", async () => {
    const design = vi.spyOn(api, "designCharacter");
    const put = vi.spyOn(api, "putCharacter");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.pip })} />);
    await click(control("Design with AI"), 50);
    const pipRef = store.characters.find((c) => c.characterId === C.pip)!.references[0]!.assetId;
    await click(control("Use picture 1"), 50);
    await click(control("Design it"), 250);
    // A redesign of this very character (§45.34): the agent starts from it.
    expect(design).toHaveBeenCalledWith("stories", { referenceAssetId: pipRef, characterId: C.pip });
    await untilTask();
    // Which parts change is shown before Use this; nothing is in the editor yet.
    expect(text()).toContain("What changes:");
    expect(put).not.toHaveBeenCalled();
    await click(control("Use this"));
    expect(text()).toContain("The new version of Pip is in the editor. Nothing changes until you tap Save changes.");
    expect(put).not.toHaveBeenCalled();
    await click(control("Save changes"));
    expect(put.mock.calls[0]![2]).toMatchObject({ name: "Pip" });
  });

  it("the gallery's Design with AI opens a new character with the design panel open", async () => {
    await show(<CharactersScreen {...page({ name: "characters" })} />);
    expect(control("Design with AI").getAttribute("href")).toBe("/stories/characters/new#design");
    history.replaceState(null, "", "/stories/characters/new#design");
    await act(async () => root.render(<ToastProvider><CharactersScreen {...page({ name: "character_new" })} /></ToastProvider>));
    await wait();
    expect(document.querySelector(".st-s-design textarea")).not.toBeNull();
  });
});

// ---------- Production ----------

describe("Production", () => {
  it("New: the idea from the link, its cast, the workspace's default length and captions, then Make the video", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    const chosen = () => Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent);
    expect(chosen().map((t) => t?.replace(/[✓+]/g, "").trim())).toEqual(["Dash", "Pip"]);
    const length = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(length.value).toBe("50");
    expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    const tile = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".st-s-casttile")).find((t) => t.textContent?.includes(name))!;
    await click(tile("Bolt"), 50);
    await click(tile("Nana Rose"), 50);
    expect(tile("Nana Rose").getAttribute("aria-disabled")).toBe("true");
    expect(tile("Nana Rose").getAttribute("aria-pressed")).toBe("false");
    await click(control("Make the video"));
    expect(create).toHaveBeenCalledWith("stories", { characterIds: [C.pip, C.dash, C.bolt], durationSec: 50, captionsOn: false, musicMood: "comedic", ideaId: I.sandwich });
    expect(location.pathname).toMatch(/^\/stories\/production\/[0-9A-Z]{26}$/);
  });

  it("New: the length's white − and + step it 5 seconds a tap, and past 90 seconds the + says no", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    const length = () => document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(length().value).toBe("50");
    await click(control("More: Length"), 50);
    expect(length().value).toBe("55");
    expect(document.querySelector(".st-s-slider__stepper output")?.textContent).toBe("55 seconds");
    await click(control("Less: Length"), 50);
    await click(control("Less: Length"), 50);
    expect(length().value).toBe("45");
    for (let i = 0; i < 12; i++) await click(control("More: Length"), 20);
    expect(length().value).toBe("90");
    expect(control("More: Length").getAttribute("aria-disabled")).toBe("true");
    expect(control("Less: Length").getAttribute("aria-disabled")).toBeNull();
    await click(control("Make the video"));
    expect(create).toHaveBeenCalledWith("stories", expect.objectContaining({ durationSec: 90 }));
  });

  it("New: up to 3 studied reference videos and this video's own model and effort go with the story", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    const tile = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".st-s-reftile")).find((t) => t.textContent?.includes(name))!;
    expect(tile("Snow day sketch").getAttribute("aria-disabled")).toBe("true");
    expect(tile("Snow day sketch").textContent).toContain("Not studied yet");
    await click(tile("Snow day sketch"), 50);
    await click(tile("The banana slip"), 50);
    expect(tile("The banana slip").getAttribute("aria-pressed")).toBe("true");
    await click(control(/^Model and effort for this video/), 50);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Kept with this video.");
    await pick("Model", "Claude Sonnet 5.5");
    await pick("Effort", "Extra high");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ referenceIds: [REFS[0]!.refId], ai: { model: "sonnet-5-5", effort: "xhigh" }, ideaId: I.sandwich });
    const made = store.stories.find((x) => x.title === "The sandwich tower" && x.status === "producing")!;
    expect(made.ai).toEqual({ model: "sonnet-5-5", effort: "xhigh" });
  });

  it("New: with no reference videos it says where to add one, and making the video never waits for them", async () => {
    store.references = [];
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    expect(text()).toContain("No reference videos yet.");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).not.toHaveProperty("referenceIds");
    expect(create.mock.calls[0]![1]).not.toHaveProperty("ai");
  });

  it("a video's page shows which model and effort made each step, its own setting, and Try again's pick for that run only", async () => {
    const produce = vi.spyOn(api, "produce");
    const patch = vi.spyOn(api, "patchStory");
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.failed })} />);
    document.querySelector<HTMLDetailsElement>(".st-s-details")!.open = true;
    const used = () => Array.from(document.querySelectorAll(".st-s-used__row")).map((r) => r.textContent);
    // The storyboard step's post captions call is its own row, as the agent records it (§45.35 D5).
    expect(used()).toEqual(["Write the storyClaude Opus 5.5 · High effortStoryboard", "Post captionsClaude Opus 5.5 · High effortStoryboard", "Check the factsClaude Opus 5.5 · High effortQuality check"]);
    expect(text()).toContain("Your usual settings");
    // The video's own setting (kept): it can change while the video waits.
    await click(control(/^Model and effort for this video/), 50);
    await pick("Model", "Claude Fable 5.1");
    await click(control("Done", document.querySelector('[role="dialog"]')!));
    expect(patch.mock.calls[0]![2]).toMatchObject({ ai: { model: "fable-5-1", effort: null } });
    expect(text()).toContain("Claude Fable 5.1 (kept with this video)");
    // Try again with a pick for this run only.
    await click(control(/^Model and effort for this one/), 50);
    await pick("Effort", "Low");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Try again from “Animate”"));
    expect(produce).toHaveBeenCalledWith("stories", S.failed, { override: { effort: "low" } });
    expect(store.stories.find((x) => x.storyId === S.failed)!.ai).toEqual({ model: "fable-5-1", effort: null });
  });

  it("New: a safety idea without checked advice can't start, and a typed safety concept outside the list is refused with the list", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.tractor })} />);
    expect(text()).toContain("only makes driving-safety videos from checked advice");
    await click(control("Make the video"), 50);
    expect(create).not.toHaveBeenCalled();
    await pick("Where the idea comes from", "Type my own");
    type(field("Title"), "Parking in a tiny space");
    type(field("What happens, in one line"), "Dash squeezes the car into a tiny gap.");
    await pick("What kind of video?", "Driving safety");
    // The idea's own character came along.
    expect(document.querySelector('.st-s-casttile[aria-pressed="true"]')?.textContent).toContain("Dash");
    await click(control("Make the video"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Checked advice covers:");
  });

  it("the story's page shows the eight steps, checks every 2 seconds while it runs, and lands on Watch it in Review", async () => {
    const get = vi.spyOn(api, "getStory");
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.producing })} />);
    expect(document.querySelectorAll(".st-s-track__step")).toHaveLength(8);
    const calls = get.mock.calls.length;
    await wait(4100);
    expect(get.mock.calls.length - calls).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll(".st-s-film__card").length).toBeGreaterThan(2);
    await wait(10_000);
    expect(document.querySelectorAll(".st-s-track__step.is-done")).toHaveLength(8);
    expect(control("Watch it in Review").getAttribute("href")).toBe(`/stories/review/${S.producing}`);
  });

  it("a video's preview row has its kind and length, a bar with its percent, and the page's actions (Cancel, Try again)", async () => {
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.producing })} />);
    const row = () => document.querySelector<HTMLElement>(".st-s-preview__row")!;
    expect(row().querySelector(".st-media__meta")?.textContent).toMatch(/ · \d+ seconds?$/);
    expect(row().querySelector('[role="progressbar"]')).not.toBeNull();
    expect(row().querySelector(".st-media__time")?.textContent).toMatch(/^\d+%$/);
    expect(control("Cancel", row())).not.toBeNull();
    await act(async () => root.render(<ToastProvider><ProductionScreen {...page({ name: "production_story", storyId: S.failed })} /></ToastProvider>));
    await wait();
    expect(control("Try again from “Animate”", row()).className).toContain("st-btn--main");
    // The steps panel below shows the steps only.
    expect(document.querySelector('[aria-label="The steps"] button')).toBeNull();
  });

  it("Cancel stops a run; Try again on a stopped one runs only what is left", async () => {
    const cancel = vi.spyOn(api, "cancelStory");
    const produce = vi.spyOn(api, "produce");
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.producing })} />);
    await click(control("Cancel"));
    expect(cancel).toHaveBeenCalledWith("stories", S.producing);
    await act(async () => root.render(<ToastProvider><ProductionScreen {...page({ name: "production_story", storyId: S.failed })} /></ToastProvider>));
    await wait();
    await click(control("Try again from “Animate”"));
    expect(produce).toHaveBeenCalledWith("stories", S.failed);
    expect(document.querySelector(".st-s-track.is-live")).not.toBeNull();
    await wait(6000);
    expect(document.querySelector(".st-s-track__step.is-running, .st-s-track__step.is-done:nth-child(8)")).not.toBeNull();
  });

  it("the list shows every story with its step track", async () => {
    await show(<ProductionScreen {...page({ name: "production" })} />);
    expect(document.querySelectorAll(".st-s-run")).toHaveLength(store.stories.length);
    expect(document.querySelectorAll(".st-s-run .st-s-track__steps").length).toBe(store.stories.length);
  });
});

// ---------- Review ----------

describe("Review", () => {
  it("the queue holds only videos to watch or check (and approved and posted ones below)", async () => {
    await show(<ReviewScreen {...page({ name: "review" })} />);
    const titles = Array.from(document.querySelectorAll(".st-s-qcard__title")).map((e) => e.textContent);
    expect(titles).toEqual(["Foggy morning drive", "When the car starts to slide", "Bolt ties his shoes", "The sandwich tower"]);
  });

  it("needs_check: the problems and sources show, Approve waits, and a fixed caption is saved then checked again", async () => {
    const patch = vi.spyOn(api, "patchStory");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.needsCheck })} />);
    expect(text()).toContain("Fix the facts first.");
    expect(document.querySelectorAll(".st-s-sources li").length).toBeGreaterThan(0);
    expect(control("Approve").getAttribute("aria-disabled")).toBe("true");
    const bad = Array.from(document.querySelectorAll<HTMLInputElement>(".st-s-cue input")).find((i) => /full beam/.test(i.value))!;
    type(bad, "Use dipped headlights in fog");
    await click(control("Save captions"));
    expect(patch.mock.calls[0]![2]).toMatchObject({ captions: expect.arrayContaining([expect.objectContaining({ text: "Use dipped headlights in fog" })]) });
    await click(control("Check again"));
    expect(produce).toHaveBeenCalledWith("stories", S.needsCheck);
    await wait(12_000);
    expect(control("Approve").getAttribute("aria-disabled")).toBeNull();
  });

  it("Approve celebrates and turns into Post it; the approve rule blocks a stale video", async () => {
    const approve = vi.spyOn(api, "approve");
    const story = structuredClone(store.stories.find((s) => s.storyId === S.review)!);
    expect(approveBlock({ ...story, stale: ["sound"] })).toBe("Your changes aren't in the video yet. Tap Remake first.");
    expect(approveBlock({ ...story, safety: { ...story.safety!, checkedScriptVersion: story.scriptVersion - 1 } })).toBe("The facts were checked on an older version of the words. Tap Check again.");
    expect(approveBlock({ ...story, safety: { ...story.safety!, status: "skipped" } })).toBe("The facts were checked on an older version of the words. Tap Check again.");
    expect(approveBlock({ ...story, category: "comedy", safety: { ...story.safety!, status: "skipped" } })).toBeNull();
    expect(approveBlock(story)).toBeNull();
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Approve"));
    expect(approve).toHaveBeenCalledWith("stories", S.review, story.version);
    expect(text()).toContain("Approved! Now you can post it.");
    expect(control("Post it")).toBeDefined();
    expect(control("Download")).toBeDefined();
  });

  it("Remake this scene sends only the scene; Remake the whole video starts from the storyboard; Ask for changes sends the note and scenes", async () => {
    const changes = vi.spyOn(api, "requestChanges");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    const second = store.stories.find((s) => s.storyId === S.review)!.scenes[1]!.sceneId;
    await click(control("Remake this scene", document.querySelectorAll(".st-s-film__card")[1]!));
    expect(changes).toHaveBeenLastCalledWith("stories", S.review, { sceneIds: [second] });
    await wait(12_000);
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it"));
    expect(produce).toHaveBeenLastCalledWith("stories", S.review, { from: "storyboard" });
    await wait(12_000);
    await click(control("Ask for changes"), 50);
    type(field("What should change?"), "More snow, please");
    await click(control(/^\+?\s*1\. /), 50);
    await click(control("Send the changes"));
    expect(changes).toHaveBeenLastCalledWith("stories", S.review, { note: "More snow, please", sceneIds: [store.stories.find((s) => s.storyId === S.review)!.scenes[0]!.sceneId] });
  });

  it("a remake's model and effort are for that job only; How it was made lists each step's model", async () => {
    const changes = vi.spyOn(api, "requestChanges");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    document.querySelector<HTMLDetailsElement>(".st-s-made")!.open = true;
    expect(Array.from(document.querySelectorAll(".st-s-made .st-s-used__row")).map((r) => r.querySelector(".st-s-used__step")?.textContent)).toEqual(["Write the story", "Post captions", "Check the facts", "Last look"]);
    const remakes = document.querySelector(".st-s-decide__ai")!;
    await click(control(/^Model and effort for this one/, remakes), 50);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Just for the next remake.");
    await pick("Model", "Claude Fable 5.2");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    const second = store.stories.find((x) => x.storyId === S.review)!.scenes[1]!.sceneId;
    await click(control("Remake this scene", document.querySelectorAll(".st-s-film__card")[1]!));
    expect(changes).toHaveBeenLastCalledWith("stories", S.review, { sceneIds: [second], override: { model: "fable-5-2" } });
    expect(store.stories.find((x) => x.storyId === S.review)!.ai).toEqual({ model: null, effort: null });
    await wait(12_000);
    // The pick was used once; the next remake is back to the usual.
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it"));
    expect(produce).toHaveBeenLastCalledWith("stories", S.review, { from: "storyboard" });
    await wait(12_000);
    const job = store.jobs.filter((j) => j.contentId === S.review).at(-2)!;
    expect(job.meta.models.find((m) => m.step === "storyboard")).toMatchObject({ model: "fable-5-2" });
  });

  it("How it was made keeps each step's model after a later run of only some steps", async () => {
    const story = store.stories.find((s) => s.storyId === S.review)!;
    const seeded = store.jobs.find((j) => j.contentId === S.review)!;
    // A later Remake of only the sound and the last steps: its record has only the last look.
    const later = structuredClone(seeded);
    Object.assign(later, { jobId: "01JSTJBLATER0000000000000", createdAt: "2026-11-21T11:00:00.000Z", updatedAt: "2026-11-21T11:01:00.000Z" });
    later.configuration = { run: ["sound", "assemble", "preview"], from: null, sceneIds: null, note: null };
    later.meta = { ...later.meta, writerModel: null, models: [{ step: "preview", agentId: "quality_assurance", model: "fable-5-2", effort: "low", effortApplied: true }] };
    store.jobs.push(later);
    story.currentJobId = later.jobId;
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    document.querySelector<HTMLDetailsElement>(".st-s-made")!.open = true;
    const rows = () => Array.from(document.querySelectorAll(".st-s-made .st-s-used__row")).map((r) => `${r.querySelector(".st-s-used__step")?.textContent}: ${r.querySelector(".st-s-used__model")?.textContent}`);
    expect(rows()).toEqual(["Write the story: Claude Opus 5.5 · High effort", "Post captions: Claude Opus 5.5 · High effort", "Check the facts: Claude Opus 5.5 · High effort", "Last look: Claude Fable 5.2 · Low effort"]);
    expect(text()).not.toContain("No model notes for this version.");
  });

  it("a remake stopped by a refused model says why on Review, with Open Settings › AI, and Try again takes a new pick", async () => {
    store.knobs.deniedModels = ["fable-5-2"];
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Remake the whole video"), 50);
    await click(control(/^Model and effort for this one/, document.querySelector('[role="dialog"]')!), 50);
    const menus = () => document.querySelectorAll('[role="dialog"]');
    await pick("Model", "Claude Fable 5.2");
    await click(control("Done", menus()[menus().length - 1]!), 50);
    await click(control("Remake it"));
    await wait(12_000);
    const notice = () => Array.from(document.querySelectorAll(".st-s-notice")).find((n) => n.textContent?.includes("isn't available right now"))!;
    expect(notice().textContent).toContain("Claude Fable 5.2 isn't available right now: Bedrock says this account can't use it yet. Pick another model in Clips Funded › Settings › AI, or try again.");
    expect(control("Open Settings › AI", notice()).getAttribute("href")).toBe("/stories/settings/ai");
    expect(Array.from(document.querySelectorAll(".toast--bad .toast__text, .toast--error .toast__text, .toast__text")).some((t) => t.textContent?.includes("isn't available right now"))).toBe(true);
    await click(control(/^Model and effort for this one/, notice()), 50);
    await pick("Model", "Claude Opus 5.5");
    await click(control("Done", document.querySelector('[role="dialog"]')!), 50);
    await click(control("Try again", notice()));
    expect(produce).toHaveBeenLastCalledWith("stories", S.review, { override: { model: "opus-5-5" } });
  });

  it("the production page of a video stopped by a refused model offers Open Settings › AI beside Try again", async () => {
    store.knobs.deniedModels = ["fable-5-2"];
    const started = api.produce("stories", S.review, { from: "storyboard", override: { model: "fable-5-2" } });
    await wait(1500);
    await started;
    await wait(12_000);
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.review })} />);
    expect(text()).toContain("Claude Fable 5.2 isn't available right now");
    expect(control("Open Settings › AI", document.querySelector(".st-s-actionbar")!).getAttribute("href")).toBe("/stories/settings/ai");
  });

  it("Check again shows only when it is needed: never for a needs_check video with nothing changed, and for an old check", async () => {
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.needsCheck })} />);
    expect(text()).toContain("Fix the facts first.");
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Check again")).toBe(false);
    expect(text()).not.toContain("Changed the words?");
    await act(async () => root.unmount());
    host.remove();
    // A video whose facts were checked on an older storyboard and has nothing to make again: Check again from the check.
    const story = store.stories.find((s) => s.storyId === S.review)!;
    story.safety = { ...story.safety!, checkedScriptVersion: story.scriptVersion - 1 };
    forgetLoaded();
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    expect(document.getElementById("st-approve-why")?.textContent).toBe("The facts were checked on an older version of the words. Tap Check again.");
    await click(control("Check again"));
    expect(produce).toHaveBeenLastCalledWith("stories", S.review, { from: "safety" });
  });

  it("Tab inside the model menu opened from Remake the whole video stays in that menu", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Remake the whole video"), 50);
    await click(control(/^Model and effort for this one/, document.querySelector('[role="dialog"]')!), 50);
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    const inner = dialogs[1]!;
    const usual = control("Use the usual", inner);
    usual.focus();
    act(() => {
      usual.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(usual);
    expect(inner.contains(document.activeElement)).toBe(true);
  });

  it("Reject keeps the reason", async () => {
    const reject = vi.spyOn(api, "reject");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Reject"), 50);
    type(field(/^Why\?/), "Too dark");
    await click(control("Reject the video"));
    expect(reject).toHaveBeenCalledWith("stories", S.review, "Too dark");
    expect(text()).toContain("Not used.");
  });

  it("the post words show each platform's limit; the sound effects editor adds, moves and removes effects", async () => {
    const patch = vi.spyOn(api, "patchStory");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await pick("Which words", "With the post");
    type(field("X"), "x".repeat(281));
    expect(text()).toContain("281 / 280");
    await click(control("Save post words"), 50);
    expect(patch).not.toHaveBeenCalled();
    type(field("X"), "Pip on ice!");
    await click(control("Save post words"));
    expect(patch.mock.calls[0]![2]).toMatchObject({ postCaptions: { x: "Pip on ice!" } });
    expect(Object.keys(patch.mock.calls[0]![2].postCaptions!)).toEqual(["x"]);

    const scene = document.querySelectorAll(".st-s-sfx__scene")[2]!;
    const before = scene.querySelectorAll(".st-s-sfx__row").length;
    await click(control(/Add a sound/, scene), 50);
    expect(scene.querySelectorAll(".st-s-sfx__row")).toHaveLength(before + 1);
    const marks = scene.querySelectorAll<HTMLButtonElement>(".st-s-timeline__mark");
    const mark = marks[marks.length - 1]!;
    await act(async () => mark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await click(control("Save sounds"));
    const sent = patch.mock.calls[1]![2].scenes![0]!;
    const script = store.scripts[S.review]!;
    expect(sent.sceneId).toBe(script.scenes[2]!.sceneId);
    const added = sent.sfx!.find((c) => c.id.includes(".own"))!;
    expect(added).toMatchObject({ sfx: "pop", volume: 0.8 });
    // Added in the middle of the scene, then moved on by one tenth of a second with the arrow key.
    expect(added.at).toBeCloseTo(Math.round((Math.round((script.scenes[2]!.durationSec / 2) * 10) / 10 + 0.1) * 10) / 10, 5);
    expect(text()).toContain("Saved. Tap Remake to put it in the video.");
    expect(text()).toContain("Your changes aren't in the video yet.");
    const rows = () => document.querySelectorAll(".st-s-sfx__scene")[2]!.querySelectorAll(".st-s-sfx__row");
    const n = rows().length;
    await click(control(/^Remove/, rows()[n - 1]!), 50);
    expect(rows()).toHaveLength(n - 1);
  });

  it("Download fetches the file link for an approved video", async () => {
    const dl = vi.spyOn(api, "download");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Download"));
    expect(dl).toHaveBeenCalledWith("stories", S.approved);
    expect(clicked).toHaveBeenCalled();
    clicked.mockRestore();
  });
});

// ---------- Post it ----------

describe("Post it", () => {
  it("lists only this workspace's connected accounts by name, with nothing chosen; others only offer Connect in Social accounts", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = document.querySelector('[role="dialog"]')!;
    const places = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button.st-s-place"));
    expect(places.map((p) => p.querySelector(".st-s-place__name")?.textContent)).toEqual(["Lamo Stories Channel", "Lamo Stories TikTok"]);
    expect(places.every((p) => p.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(control(/^Upload/, dialog).getAttribute("aria-disabled")).toBe("true");
    const off = Array.from(dialog.querySelectorAll(".st-s-place--off"));
    expect(off.map((o) => o.querySelector(".st-s-place__platform")?.textContent)).toEqual(["Instagram", "Facebook", "X"]);
    expect(off.every((o) => o.querySelector('a[href="/stories/connections"]'))).toBe(true);
  });

  it("TikTok: who can see it starts empty with TikTok's own choices; Comments, Duet and Stitch show and start off; Use my settings fills the preset", async () => {
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    await click(control(/Lamo Stories TikTok/, dialog()));
    expect(dialog().querySelector(".dropdown__value")?.textContent).toBe("Pick who can see it");
    const switches = () => Array.from(dialog().querySelectorAll<HTMLElement>(".st-s-tiktok [role=switch]"));
    expect(switches().slice(0, 3).map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(control(/^Upload/, dialog()).getAttribute("aria-disabled")).toBe("true");
    await click(control(/Lamo Stories Channel/, dialog()), 50);
    await click(control("Use my settings", dialog()), 50);
    expect(dialog().querySelector(".dropdown__value")?.textContent).toBe("Everyone");
    expect(switches().slice(0, 3).map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    await click(control("More details", dialog()), 50);
    expect(dialog().textContent).toContain("Made for kids: No");
    await click(control("Upload to 2 places", dialog()));
    expect(publish).toHaveBeenCalledWith("stories", S.approved, [
      { platform: "tiktok", socialAccountId: "stories.tiktok", options: { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false } },
      { platform: "youtube", socialAccountId: "stories.youtube", options: { privacy: "public", category: "1", notifySubscribers: true } },
    ]);
    expect(dialog().textContent).toContain("Sending your video");
  });

  it("flat options per platform (§45.6)", () => {
    const yt = { privacy: "private" as const, category: "27", notifySubscribers: false };
    expect(optionsFor("youtube", yt, true, NO_TIKTOK_CHOICES, null)).toEqual({ privacy: "private", category: "27", notifySubscribers: false });
    expect(optionsFor("instagram", yt, false, NO_TIKTOK_CHOICES, null)).toEqual({ shareToFeed: false });
    expect(optionsFor("facebook", yt, true, NO_TIKTOK_CHOICES, null)).toBeUndefined();
    expect(optionsFor("tiktok", yt, true, { ...NO_TIKTOK_CHOICES, privacy: "SELF_ONLY", comments: true }, { ...CREATOR, commentDisabled: true })).toEqual({
      privacyLevel: "SELF_ONLY",
      disableComment: true,
      disableDuet: true,
      disableStitch: true,
      brandContent: false,
      brandOrganic: false,
    });
  });

  it("the Posts panel: each job's sentence and Try again; a changed account asks first, then sends confirmAccount", async () => {
    const retry = vi.spyOn(api, "retryPublishing");
    pubs.push({
      publishingJobId: "pj-old",
      workspaceId: "stories",
      contentId: S.approved,
      socialAccountId: "stories.youtube",
      platform: "youtube",
      publishingStatus: "needs_attention",
      accountName: "Old Channel",
      error: "Clips Funded's YouTube (Old Channel) needs connecting again. Open Clips Funded › Connections, then tap Try again.",
      createdAt: "2026-11-21T11:00:00.000Z",
      updatedAt: "2026-11-21T11:00:00.000Z",
    });
    retry.mockRejectedValueOnce(new ApiError(409, "conflict", "Clips Funded's YouTube is now Lamo Stories Channel. Check it, then tap Try again."));
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    expect(document.querySelector(".st-s-post__why")?.textContent).toContain("needs connecting again");
    await click(control("Try again", document.querySelector(".st-s-postspanel")!));
    expect(retry).toHaveBeenCalledWith("stories", "pj-old", undefined);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Lamo Stories Channel");
    expect(dialog.textContent).toContain("ext-youtube");
    await click(control(/Yes, post to/, dialog));
    expect(retry).toHaveBeenLastCalledWith("stories", "pj-old", { confirmAccount: "ext-youtube" });
    expect(document.querySelector(".st-s-post")?.textContent).toContain("Waiting");
  });

  it("a 409 that is not about the account is only shown; no 'Post to …?' question", async () => {
    const retry = vi.spyOn(api, "retryPublishing");
    pubs.push({ publishingJobId: "pj-busy", workspaceId: "stories", contentId: S.approved, socialAccountId: "stories.youtube", platform: "youtube", publishingStatus: "failed", accountName: "Lamo Stories Channel", error: "YouTube said no. Tap Try again.", createdAt: "2026-11-21T11:00:00.000Z", updatedAt: "2026-11-21T11:00:00.000Z" });
    retry.mockRejectedValueOnce(new ApiError(409, "conflict", "This post is not stuck. There is nothing to try again."));
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Try again", document.querySelector(".st-s-postspanel")!));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).toContain("This post is not stuck. There is nothing to try again.");
  });

  it("a post that goes up while watching is celebrated", async () => {
    pubs.push({ publishingJobId: "pj1", workspaceId: "stories", contentId: S.approved, socialAccountId: "stories.youtube", platform: "youtube", publishingStatus: "publishing", accountName: "Lamo Stories Channel", createdAt: "2026-11-21T11:00:00.000Z", updatedAt: "2026-11-21T11:00:00.000Z" });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    pubs[0]!.publishingStatus = "posted";
    pubs[0]!.url = "https://youtube.com/shorts/x";
    await wait(10_500);
    expect(text()).toContain("Posted to YouTube!");
    expect(document.querySelector(".st-s-post a")?.getAttribute("href")).toBe("https://youtube.com/shorts/x");
  });

  it("the sheet alone: no account connected means no post, only the way to Connections", async () => {
    for (const a of store.social) a.connectionStatus = "not_connected";
    const story = store.stories.find((s) => s.storyId === S.approved)!;
    await show(<PublishSheet ws="stories" story={story} config={{}} jobs={[]} onSent={() => undefined} onRetry={() => undefined} onClose={() => undefined} />);
    expect(document.querySelectorAll("button.st-s-place")).toHaveLength(0);
    expect(text()).toContain("No Clips Funded account is connected yet.");
    expect(control("Upload").getAttribute("aria-disabled")).toBe("true");
  });

  it("each chosen place shows the exact account it goes to with Check now; Upload checks every account not checked yet first", async () => {
    const check = vi.spyOn(api, "checkSocial");
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    expect(dialog().querySelector(".st-s-dest")).toBeNull();
    await click(control(/Lamo Stories Channel/, dialog()), 50);
    const dest = () => dialog().querySelector(".st-s-dest")!;
    expect(dest().textContent).toContain("Goes to this YouTube account: Lamo Stories Channel");
    expect(dest().textContent).toContain("Account id ext-youtube");
    expect(dest().textContent).toContain("Last checked 3 hours ago.");
    await click(control("Check now", dest()));
    expect(check).toHaveBeenCalledWith("stories", "youtube");
    expect(dest().textContent).toContain("Checked just now: this is the account the video goes to.");
    await click(control(/Lamo Stories TikTok/, dialog()), 50);
    await click(control("Use my settings", dialog()), 50);
    await click(control("Upload to 2 places", dialog()));
    // YouTube was checked in the sheet; TikTok is checked at the tap, then the video goes.
    expect(check.mock.calls.map((c) => c[1])).toEqual(["youtube", "tiktok"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(check.mock.invocationCallOrder[1]!).toBeLessThan(publish.mock.invocationCallOrder[0]!);
  });

  it("Check now finding another TikTok account asks TikTok's choices again for it", async () => {
    const info = vi.spyOn(api, "tiktokCreatorInfo");
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    await click(control(/Lamo Stories TikTok/, dialog()));
    await click(control("Use my settings", dialog()), 50);
    expect(dialog().textContent).toContain(`Posting as ${CREATOR.nickname} (@${CREATOR.username})`);
    expect(info).toHaveBeenCalledTimes(1);
    // Meanwhile Lamo Stories' TikTok was connected to another account, with other choices.
    Object.assign(store.social.find((a) => a.platform === "tiktok")!, { externalAccountId: "ext-tt-new", accountName: "New TikTok", handle: "@newtt" });
    info.mockResolvedValue({ ...CREATOR, nickname: "New TikTok", username: "newtt", privacyOptions: ["SELF_ONLY"] });
    await click(control("Check now", dialog().querySelector(".st-s-dest")!));
    expect(info).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain("Posting as New TikTok (@newtt)");
    expect(dialog().textContent).not.toContain(`Posting as ${CREATOR.nickname}`);
    // The old account's "Everyone" is not offered to this one: Use my settings keeps only what it allows.
    expect(dialog().querySelector(".dropdown__value")?.textContent).not.toBe("Everyone");
    await click(control("Upload", dialog()));
    expect(publish.mock.calls.flatMap((c) => c[2]).every((t) => t.platform !== "tiktok" || (t.options as { privacyLevel?: string }).privacyLevel !== "PUBLIC_TO_EVERYONE")).toBe(true);
  });

  it("Upload stops when a check finds another account or a lost connection, and says which", async () => {
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    await click(control(/Lamo Stories Channel/, dialog()), 50);
    await click(control(/Lamo Stories TikTok/, dialog()), 50);
    await click(control("Use my settings", dialog()), 50);
    // Meanwhile YouTube was connected to another channel and TikTok's sign-in ran out.
    Object.assign(store.social.find((a) => a.platform === "youtube")!, { externalAccountId: "ext-other", accountName: "Someone Else", handle: "@someone" });
    store.social.find((a) => a.platform === "tiktok")!.connectionStatus = "needs_reconnect";
    await click(control("Upload to 2 places", dialog()));
    expect(publish).not.toHaveBeenCalled();
    // By its place first, so it reads right when the account is itself called Lamo Stories (§45.36 E13).
    expect(dialog().textContent).toContain("Clips Funded's YouTube is now a different account: this YouTube account (Someone Else, @someone). Look at it below, then tap Upload again.");
    expect(dialog().textContent).toContain("Clips Funded's TikTok needs connecting again. Fix it in Social accounts, or leave TikTok out.");
    expect(dialog().querySelector(".st-s-dest")?.textContent).toContain("Goes to this YouTube account: Someone Else (@someone)");
    // TikTok left the list of chosen places; the owner has seen the new YouTube account, so the next tap sends.
    await click(control("Upload", dialog()));
    expect(publish).toHaveBeenCalledWith("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube", options: { privacy: "public", category: "1", notifySubscribers: true } }]);
  });
});
