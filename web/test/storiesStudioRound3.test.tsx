// Lamo Stories studio, round 3 (docs/CONTRACTS.md §45.34): "Write them again" with the draft beside the saved post
// captions and "Use these"; "Next run: {model} · {effort}" in Review and Production; the account a publishing 409
// names, asked as "Post to {name}?" in the publish sheet and in Posts' Try again and sent again with confirmAccount; the
// Production › New hand-over keys (?idea=, ?ref=, ?cast=, ?sec=), an idea's own length and the shape picker; Show more
// on the Production list, each Review group and the Library's Projects, and a ?story= outside the loaded pages; the
// place sounds "(whole scene)"; Edit on an idea card; Design with AI on a saved character showing what changes; the
// Picture maker link; and Download of a video's extra copies. Rendered with the mock's own parts (fake timers).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as library from "../src/stories/api/mock/library.ts";
import * as publishing from "../src/stories/api/mock/publishing.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { CharacterInput, ModelInfo, PersonInput, ReferenceVideo, SocialAccount, StoriesApi, StoriesConfig, Story, TikTokCreator, Workspace } from "../src/stories/api/types.ts";
import { matchStories, storiesHref, type StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen, ideaProblem, ideaPatch } = await import("../src/stories/screens/Ideas.tsx");
const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { ProductionScreen, runModels } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen } = await import("../src/stories/screens/Review.tsx");
const { LibraryScreen } = await import("../src/stories/screens/Library.tsx");
const { LISTED_INFO, ModelsUsed, nextRunLine } = await import("../src/stories/studio/ai.tsx");
const { changedParts } = await import("../src/stories/studio/Design.tsx");
const { cueLabel, isPlaceSound } = await import("../src/stories/studio/SfxEditor.tsx");
const { captionsDraft } = await import("../src/stories/studio/CaptionEditor.tsx");
const { placeOf } = await import("../src/stories/studio/PublishSheet.tsx");
const { accountOf, accountWords } = await import("../src/stories/studio/words.ts");
const { formatOf } = await import("../src/stories/studio/shape.tsx");

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
    captionsOn: true,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1920", aspect: "9:16", quality: "high", fps: 30 },
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "27",
    youtubePrivacy: "public",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};

const account = (platform: SocialAccount["platform"], connectionStatus: SocialAccount["connectionStatus"], accountName: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  socialAccountId: `stories.${platform}`,
  workspaceId: "stories",
  platform,
  app: { choice: "clips", saved: true },
  lastCheckedAt: null,
  connectionStatus,
  externalAccountId: accountName ? `ext-${platform}` : null,
  accountName,
  handle: accountName ? `@${platform}.stories` : null,
  avatarUrl: null,
  sharedWithClips: false,
  connectedAt: null,
  missing: [],
  reason: null,
  reconnectBy: null,
  choices: null,
  limits: [],
  warning: null,
  skipped: false,
  ...extra,
});

const CREATOR: TikTokCreator = { nickname: "Clips Funded", username: "tiktok.stories", avatarUrl: null, privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxDurationSec: 600 };

const MODELS: ModelInfo[] = LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "Ready." }));

const REFS: ReferenceVideo[] = [
  { refId: "01JSTRV0000000000000000001", title: "The banana slip", status: "analyzed", durationSec: 38, bytes: 9_000_000, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: { model: "opus-5-5", effort: "high" }, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z" },
  { refId: "01JSTRV0000000000000000002", title: "Pip on the ice", status: "analyzed", durationSec: 20, bytes: 5_000_000, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: { model: "opus-5-5", effort: "high" }, createdAt: "2026-11-20T11:00:00.000Z", updatedAt: "2026-11-20T11:00:00.000Z" },
];

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function makeApi(knobs: Record<string, unknown> = {}): StoriesApi {
  store = createStore();
  store.knobs = { ...knobs };
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  store.social.push(account("youtube", "connected", "Lamo Stories Channel"), account("tiktok", "connected", "Lamo Stories TikTok"), account("instagram", "not_connected", null), account("facebook", "not_connected", null), account("x", "not_connected", null));
  store.references.push(...structuredClone(REFS));
  publishing.afterSeed(store);
  const now = "2026-11-21T12:00:00.000Z";
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...publishing.api(store),
    ...library.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    guidance: async () => ({ topics: [], checkedAt: now }),
    social: async () => ({ accounts: structuredClone(store.social), clips: [] }),
    checkSocial: async (_ws, platform) => structuredClone(store.social.find((a) => a.platform === platform)!),
    tiktokCreatorInfo: async () => CREATOR,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(MODELS), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
    listReferences: async () => structuredClone(store.references),
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

function start(knobs: Record<string, unknown> = {}) {
  api = makeApi(knobs);
  setStoriesApi(api);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  forgetLoaded();
  start();
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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

function field(label: string | RegExp, within: ParentNode = document): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(within.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
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
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
const lastDialog = () => dialogs().at(-1)!;

/** More stories than one page holds (the API answers at most 50 a page). */
function manyStories(n: number, status: Story["status"]) {
  const base = store.stories.find((s) => s.storyId === S.review)!;
  for (let i = 0; i < n; i += 1) {
    const id = `01JSTXX${String(i).padStart(19, "0")}`;
    store.stories.push({ ...structuredClone(base), storyId: id, title: `Extra video ${i + 1}`, status, createdAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") - i * 60_000).toISOString() });
  }
}

// ---------- Production › New and the router ----------

describe("Production › New from the address (§45.34)", () => {
  it("the router reads ?idea=, up to 3 ?ref= and ?cast=, and ?sec= from 15 to 90, and writes them back", () => {
    const p = matchStories("/stories/production/new", "?idea=i1&ref=r1&ref=r2&ref=r3&ref=r4&cast=c1&cast=c1&cast=bad%20id&sec=40");
    expect(p).toEqual({ name: "production_new", ideaId: "i1", refIds: ["r1", "r2", "r3"], castIds: ["c1"], durationSec: 40 });
    expect(matchStories("/stories/production/new", "?sec=200")).toMatchObject({ durationSec: null, refIds: [], castIds: [] });
    expect(matchStories("/stories/production/new", "?sec=4.5")).toMatchObject({ durationSec: null });
    expect(storiesHref(p)).toBe("/stories/production/new?idea=i1&ref=r1&ref=r2&ref=r3&cast=c1&sec=40");
    expect(storiesHref({ name: "production_new", ideaId: null })).toBe("/stories/production/new");
  });

  it("starts with the address's references, cast and length picked, and sends them", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [REFS[1]!.refId], castIds: [C.bolt, C.nana], durationSec: 35 })} />);
    const cast = Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace(/[✓+]/g, "").trim());
    expect(cast).toEqual(["Bolt", "Nana Rose"]);
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("35");
    expect(Array.from(document.querySelectorAll('.st-s-reftile[aria-pressed="true"]')).map((t) => t.textContent)).toEqual([expect.stringContaining("Pip on the ice")]);
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toEqual({ characterIds: [C.bolt, C.nana], durationSec: 35, captionsOn: true, musicMood: "comedic", referenceIds: [REFS[1]!.refId], ideaId: I.sandwich });
  });

  it("a new hand-over while the page is open starts the form again from its own address", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.bolt], durationSec: 30 })} />);
    const cast = () => Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace(/[✓+]/g, "").trim());
    expect(cast()).toEqual(["Bolt"]);
    await act(async () => root.render(<ToastProvider><ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.nana], durationSec: 60 })} /></ToastProvider>));
    await wait();
    expect(cast()).toEqual(["Nana Rose"]);
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("60");
  });

  it("reference videos from the address keep only the ones in the list, so a deleted one never uses up a pick", async () => {
    store.references.push({ ...structuredClone(REFS[0]!), refId: "01JSTRV0000000000000000003", title: "The third one" });
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [REFS[0]!.refId, "01JSTRVGONE0000000000000000", REFS[1]!.refId], castIds: [C.bolt], durationSec: null })} />);
    const on = () => Array.from(document.querySelectorAll('.st-s-reftile[aria-pressed="true"]')).map((t) => t.querySelector(".st-s-reftile__title")?.textContent);
    expect(on()).toEqual(["The banana slip", "Pip on the ice"]);
    const third = Array.from(document.querySelectorAll<HTMLElement>(".st-s-reftile")).find((t) => t.textContent?.includes("The third one"))!;
    expect(third.getAttribute("aria-disabled")).toBeNull();
    await click(third, 50);
    expect(on()).toEqual(["The banana slip", "Pip on the ice", "The third one"]);
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ referenceIds: [REFS[0]!.refId, REFS[1]!.refId, "01JSTRV0000000000000000003"] });
  });

  it("sends no shape while Settings › Video has not loaded, unless the owner picks one", async () => {
    const create = vi.spyOn(api, "createStory");
    vi.spyOn(api, "getWorkspace").mockImplementation(() => new Promise(() => undefined));
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.bolt], durationSec: null })} />);
    expect(text()).toContain("Your usual shape from Settings › Video is used, unless you pick one here.");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).not.toHaveProperty("format");
    // A shape the owner picks goes with this video.
    await act(async () => root.unmount());
    host.remove();
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.bolt], durationSec: null })} />);
    await pick("Shape", "Square");
    expect(text()).toContain("Just for this video. Settings › Video stays the same.");
    await click(control("Make the video"));
    expect(create.mock.calls[1]![1]).toMatchObject({ format: { aspect: "1:1" } });
  });

  it("with Settings › Video loaded, the usual shape is not sent (the API uses it)", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.bolt], durationSec: null })} />);
    expect(text()).toContain("From Settings › Video.");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).not.toHaveProperty("format");
  });

  it("a cast from the address keeps only this workspace's characters", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: ["01JSTCHNOPE00000000000000", C.dash], durationSec: null })} />);
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ characterIds: [C.dash] });
  });

  it("a picked idea's full idea gives the starting length", async () => {
    store.ideas.find((i) => i.ideaId === I.skid)!.concept!.durationSec = 35;
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.skid })} />);
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("35");
    expect(text()).toContain("The full idea was written for 35 seconds.");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ durationSec: 35, ideaId: I.skid });
  });

  it("the shape picker starts from Settings › Video and sends this video's own shape as format", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    expect(text()).toContain("From Settings › Video.");
    await pick("Shape", "Wide");
    expect(text()).toContain("Just for this video. Settings › Video stays the same.");
    await pick("Size", "1280 × 720");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ format: { aspect: "16:9", width: 1280, height: 720 } });
    const made = store.stories.find((s) => s.status === "producing" && s.title === "The sandwich tower")!;
    expect(made.format).toEqual({ aspect: "16:9", width: 1280, height: 720 });
    expect(formatOf({ video: { aspect: "1:1", resolution: "720x720", quality: "high", fps: 30 } as never })).toEqual({ aspect: "1:1", width: 720, height: 720 });
    expect(formatOf({ video: { aspect: "1:1", resolution: "1080x1920", quality: "high", fps: 30 } as never })).toEqual({ aspect: "9:16", width: 1080, height: 1920 });
  });

  it("the drawing style pick sits beside the shape, starts from Settings › Video and sends this video's own as art (§45.45)", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    const styles = () => Array.from(document.querySelectorAll<HTMLInputElement>(".st-s-artpick input[type=radio]"));
    expect(styles().map((r) => [r.closest("label")?.querySelector(".st-s-pick__label")?.textContent, r.checked])).toEqual([
      ["Night drive", true],
      ["Bright", false],
    ]);
    expect(document.querySelector(".st-s-artpick")?.closest("section")?.querySelector(".st-s-shapepick")).not.toBeNull();
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).not.toHaveProperty("art");
    await act(async () => root.unmount());
    host.remove();
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    await pick("Drawing style", "Bright");
    expect(text()).toContain("Just for this video. Settings › Video stays the same.");
    await click(control("Make the video"));
    expect(create.mock.calls[1]![1]).toMatchObject({ art: "classic" });
    expect(store.stories.filter((s) => s.title === "The sandwich tower").map((s) => s.art).slice(-2)).toEqual(["night_drive", "classic"]);
  });

  it("a video's details say its drawing style; one made before drawing styles is Bright", async () => {
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.failed })} />);
    const facts = Array.from(document.querySelectorAll(".st-s-facts dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(facts).toContainEqual(["Drawing style", "Bright"]);
    await act(async () => root.render(<ToastProvider><ReviewScreen {...page({ name: "review_story", storyId: S.approved })} /></ToastProvider>));
    await wait();
    const made = Array.from(document.querySelectorAll(".st-s-made .st-s-facts dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(made).toContainEqual(["Drawing style", "Bright"]);
  });
});

// ---------- Next run ----------

describe("Next run: {model} · {effort} (Story.effective, §45.34)", () => {
  it("Production and Review show what the next run uses: the video's own setting over the usual", async () => {
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.failed })} />);
    expect(document.querySelector(".st-s-nextrun")?.textContent).toBe("Next run: Claude Opus 5.5 · High");
    await act(async () => root.render(<ToastProvider><ReviewScreen {...page({ name: "review_story", storyId: S.approved })} /></ToastProvider>));
    await wait();
    // The approved video keeps its own model and effort.
    expect(Array.from(document.querySelectorAll(".st-s-nextrun")).map((e) => e.textContent)).toContain("Next run: Claude Fable 5.2 · High");
  });

  it("reads Story.effective first, and says so plainly when a model runs at its own level", () => {
    const story = { ai: { model: null, effort: null }, effective: { model: "sonnet-5-5", effort: null, effortApplied: false, from: "task" as const } };
    expect(nextRunLine(LISTED_INFO, story)).toBe("Next run: Claude Sonnet 5.5 · its own effort level");
    expect(nextRunLine({ ...LISTED_INFO, live: true }, { ai: { model: "haiku-5-5", effort: "low" } })).toBe("Next run: Claude Haiku 5.5 · Low");
  });
});

// ---------- Write them again ----------

describe("Write them again (§45.34)", () => {
  it("shows the draft next to the saved post words; only Use these saves it (PATCH postCaptions)", async () => {
    const write = vi.spyOn(api, "writeCaptions");
    const patch = vi.spyOn(api, "patchStory");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await pick("Which words", "With the post");
    await click(control("Write them again"), 250);
    expect(write).toHaveBeenCalledWith("stories", S.review, undefined);
    await untilTask();
    const draft = document.querySelector(".st-s-draftcaps")!;
    expect(draft.textContent).toContain("Nothing changes until you tap Use these.");
    const before = store.stories.find((s) => s.storyId === S.review)!.postCaptions;
    expect(draft.querySelector(".st-s-draftcaps__was")?.textContent).toContain(before.youtubeTitle);
    expect(patch).not.toHaveBeenCalled();
    await click(control("Use these", draft));
    expect(patch).toHaveBeenCalledTimes(1);
    const sent = patch.mock.calls[0]![2].postCaptions!;
    expect(sent.youtubeTitle).not.toBe(before.youtubeTitle);
    expect(store.stories.find((s) => s.storyId === S.review)!.postCaptions.youtubeTitle).toBe(sent.youtubeTitle);
  });

  it("Keep the saved words drops the draft; a pick for this one goes with the task", async () => {
    const write = vi.spyOn(api, "writeCaptions");
    const patch = vi.spyOn(api, "patchStory");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await pick("Which words", "With the post");
    await click(control(/^Model and effort for this one/, document.querySelector(".st-s-rewrite")!), 50);
    await pick("Model", "Claude Haiku 5.5");
    await click(control("Done", lastDialog()), 50);
    await click(control("Write them again"), 250);
    expect(write).toHaveBeenCalledWith("stories", S.review, { override: { model: "haiku-5-5" } });
    await untilTask();
    await click(control("Keep the saved words"));
    expect(document.querySelector(".st-s-draftcaps")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it("reads the task's draft, filled out to all six places", () => {
    const d = captionsDraft({ taskId: "t", kind: "captions", status: "done", model: null, effort: null, effortApplied: null, result: { storyId: "s", scriptVersion: 2, postCaptions: { youtubeTitle: "x".repeat(150), tiktok: "hi" } }, createdAt: "", updatedAt: "" });
    expect(d?.scriptVersion).toBe(2);
    expect(d?.postCaptions.youtubeTitle).toHaveLength(100);
    expect(d?.postCaptions.instagram).toBe("");
    expect(captionsDraft({ taskId: "t", kind: "captions", status: "done", model: null, effort: null, effortApplied: null, result: {}, createdAt: "", updatedAt: "" })).toBeNull();
  });
});

// ---------- The account question ----------

describe("Post to {name}? (error.account, §45.34)", () => {
  it("the publish sheet asks before a TikTok Lamo Stories cannot tell from Lamo Clips', then sends confirmAccount", async () => {
    start({ tiktokUnsure: true });
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/Lamo Stories TikTok/, lastDialog()), 50);
    // Use my settings picks who can see it from TikTok's own choices (everyone).
    await click(control("Use my settings", lastDialog()), 50);
    await click(control(/^Upload/, lastDialog()));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![2][0]).not.toHaveProperty("confirmAccount");
    const ask = lastDialog();
    // Named by its place first, so it reads right when the account is itself called Lamo Stories (§45.36 E13).
    expect(ask.textContent).toContain("Post to this TikTok account (Lamo Stories TikTok)?");
    expect(ask.textContent).toContain("Goes to this TikTok account: Lamo Stories TikTok (@tiktok.stories)");
    // Its id, behind Technical details (§45.36 E14).
    expect(ask.querySelector(".st-s-dest .st-s-tech")?.textContent).toContain("Account id ext-tiktok");
    await click(control("Yes, post to this account", ask));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![2][0]).toMatchObject({ platform: "tiktok", confirmAccount: "ext-tiktok" });
    expect(text()).toContain("Sending your video");
  });

  it("Posts' Try again asks when the API names a changed account, then sends confirmAccount", async () => {
    const retry = vi.spyOn(api, "retryPublishing");
    // The posted video's TikTok post stopped; meanwhile Lamo Stories' TikTok is another account.
    const job = store.publishing.find((j) => j.platform === "tiktok")!;
    expect(job.externalAccountId).toBe("ext-tiktok");
    Object.assign(store.social.find((a) => a.platform === "tiktok")!, { externalAccountId: "ext-new", accountName: "New TikTok", handle: "@new.tiktok" });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.published })} />);
    const row = Array.from(document.querySelectorAll<HTMLElement>(".st-s-post")).find((r) => r.textContent?.includes("TikTok"))!;
    // Each post names its exact account.
    expect(row.querySelector(".st-s-tech")?.textContent).toContain("Account id ext-tiktok");
    await click(control("Try again", row));
    expect(retry).toHaveBeenLastCalledWith("stories", job.publishingJobId, undefined);
    const ask = lastDialog();
    expect(ask.textContent).toContain("Post to this TikTok account (New TikTok)?");
    expect(ask.textContent).toContain("New TikTok (@new.tiktok)");
    await click(control("Yes, post to this account", ask));
    expect(retry).toHaveBeenLastCalledWith("stories", job.publishingJobId, { confirmAccount: "ext-new" });
    expect(store.publishing.find((j) => j.publishingJobId === job.publishingJobId)).toMatchObject({ publishingStatus: "queued", externalAccountId: "ext-new", accountName: "New TikTok" });
  });

  it("reads the account from the error, finds the place it is about, and says it with its handle", () => {
    const e = Object.assign(new Error("x"), {});
    expect(accountOf(e)).toBeNull();
    const accounts = new Map(store.social.map((a) => [a.platform, a]));
    const named = { externalAccountId: "ext-tiktok", accountName: "A", handle: null };
    expect(placeOf("anything", named, ["youtube", "tiktok"], accounts)).toBe("tiktok");
    expect(placeOf("Clips Funded's YouTube is a different account now: B.", { externalAccountId: "other", accountName: "B", handle: null }, ["youtube", "tiktok"], accounts)).toBe("youtube");
    expect(placeOf("Something else.", { externalAccountId: "other", accountName: "B", handle: null }, ["youtube", "tiktok"], accounts)).toBeNull();
    expect(placeOf("Something else.", { externalAccountId: "other", accountName: "B", handle: null }, ["x"], accounts)).toBe("x");
    expect(accountWords({ externalAccountId: "1", accountName: "Lamo", handle: "lamo.stories" })).toBe("Lamo (@lamo.stories)");
    expect(accountWords({ externalAccountId: "1", accountName: null, handle: null })).toBe("1");
  });

  it("the sheet says Social accounts, never Connections", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    expect(lastDialog().textContent).toContain("Connect in Social accounts");
    expect(lastDialog().textContent).not.toMatch(/Connections/);
  });
});

// ---------- Show more ----------

describe("Show more and ?story= (§45.34 All projects)", () => {
  it("the Production list pages with the cursor", async () => {
    manyStories(52, "review");
    const list = vi.spyOn(api, "listStories");
    await show(<ProductionScreen {...page({ name: "production" })} />);
    expect(document.querySelectorAll(".st-s-run")).toHaveLength(50);
    await click(control("Show more"));
    expect(list.mock.calls.at(-1)![1]).toMatchObject({ cursor: "50" });
    expect(document.querySelectorAll(".st-s-run")).toHaveLength(store.stories.length);
    expect(() => control("Show more")).toThrow();
  });

  it("each Review group pages on its own", async () => {
    manyStories(51, "approved");
    await show(<ReviewScreen {...page({ name: "review" })} />);
    const group = () => document.querySelector<HTMLElement>('section[aria-label="Approved, ready to post"]')!;
    expect(group().querySelectorAll(".st-s-qcard")).toHaveLength(50);
    expect(document.querySelector('section[aria-label="Waiting for you"]')!.textContent).not.toContain("Show more");
    await click(control("Show more", group()));
    expect(group().querySelectorAll(".st-s-qcard")).toHaveLength(52);
  });

  it("the Library's Projects pages, and a ?story= outside the loaded pages is fetched by itself", async () => {
    manyStories(55, "review");
    const get = vi.spyOn(api, "getStory");
    await show(<LibraryScreen {...page({ name: "library", kind: null, storyId: null })} />);
    expect(document.querySelectorAll(".st-project")).toHaveLength(50);
    await click(control("Show more"));
    expect(document.querySelectorAll(".st-project")).toHaveLength(store.stories.length);
    // A fresh visit: only the first page is loaded, so that project is asked for by itself.
    forgetLoaded();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<ToastProvider><LibraryScreen {...page({ name: "library", kind: null, storyId: "01JSTXX0000000000000000054" })} /></ToastProvider>));
    await wait();
    await wait();
    expect(get).toHaveBeenCalledWith("stories", "01JSTXX0000000000000000054");
    expect(document.querySelector(".st-projectview__title")?.textContent).toBe("Extra video 55");
    await act(async () => root.render(<ToastProvider><LibraryScreen {...page({ name: "library", kind: null, storyId: "01JSTXXNOPE000000000000000" })} /></ToastProvider>));
    await wait();
    await wait();
    expect(text()).toContain("We could not find that project");
  });
});

// ---------- Place sounds ----------

describe("the place's own sounds (whole scene)", () => {
  it("are in the list from each scene's start, labelled, and can be moved or removed", async () => {
    const patch = vi.spyOn(api, "patchStory");
    const script = store.scripts[S.review]!;
    const scene = script.scenes.find((sc) => sc.sfx.some(isPlaceSound))!;
    expect(scene).toBeTruthy();
    const bed = scene.sfx.find(isPlaceSound)!;
    expect(bed.at).toBe(0);
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    expect(text()).toContain("They are in the list from the start of each scene");
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".st-s-sfx__row.is-place"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toContain("Sound (whole scene)");
    expect(document.querySelector(".st-s-timeline__mark.is-place")?.getAttribute("aria-label")).toMatch(/\(whole scene\) at 0:00/);
    await click(control(`Remove ${cueLabel(bed)}`, rows[0]!.closest(".st-s-sfx__scene")!), 50);
    await click(control("Save sounds"));
    const sent = patch.mock.calls[0]![2].scenes!.find((e) => e.sceneId === scene.sceneId)!;
    expect(sent.sfx!.some((c) => c.id === bed.id)).toBe(false);
    expect(cueLabel({ id: "s1.amb1", sfx: "wind" })).toBe("Wind (whole scene)");
    expect(cueLabel({ id: "s1.fx1", sfx: "wind" })).toBe("Wind");
  });
});

// ---------- Edit an idea ----------

describe("Edit on an idea card (§45.34)", () => {
  it("changes the title, the kind and the full idea's parts, saved with patchIdea", async () => {
    const patch = vi.spyOn(api, "patchIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const card = () => document.querySelector<HTMLElement>(`[data-idea="${I.skid}"]`)!;
    await click(control(/^Edit When the car starts to slide/, card()), 50);
    const form = card();
    type(field("Title", form), "");
    await click(control("Save changes", form), 50);
    expect(form.textContent).toContain("Give the idea a title.");
    type(field("Title", form), "Black ice, calm hands");
    type(field("Step 1", form), "Pip sees the road shine and slows down.");
    const words = store.ideas.find((i) => i.ideaId === I.skid)!.concept!.onScreenText.length;
    if (words >= 6) await click(control("Remove words 1", form), 50);
    await click(control("Add words", form), 50);
    type(field(`Words ${Math.min(words, 5) + 1}`, form), "Stay calm");
    await click(control("Save changes", form));
    expect(patch).toHaveBeenCalledTimes(1);
    const sent = patch.mock.calls[0]![2];
    expect(sent.title).toBe("Black ice, calm hands");
    expect(sent).not.toHaveProperty("logline");
    expect(sent.concept!.beats[0]).toBe("Pip sees the road shine and slows down.");
    expect(sent.concept!.onScreenText).toContain("Stay calm");
    expect(store.ideas.find((i) => i.ideaId === I.skid)!.title).toBe("Black ice, calm hands");
    expect(card().textContent).toContain("Black ice, calm hands");
  });

  it("an idea with no full idea edits its title, line and kind only; the checks are the API's", () => {
    const idea = store.ideas.find((i) => i.ideaId === I.gps)!;
    expect(ideaPatch(idea, { title: idea.title, logline: "New line", category: "explainer" }, null)).toEqual({ logline: "New line", category: "explainer" });
    const c = { premise: "p", beats: ["a", "b"], lesson: null, ending: "e", tone: "funny" as const, durationSec: 30, onScreenText: [] };
    expect(ideaProblem({ title: "t", logline: "l", category: "comedy" }, c)).toBe("A full idea needs 3 to 8 steps.");
    expect(ideaProblem({ title: "t", logline: "l", category: "comedy" }, { ...c, beats: ["a", "b", "c"], ending: " " })).toBe("Say how it ends.");
    expect(ideaProblem({ title: "t", logline: "l", category: "" }, null)).toBe("Pick what kind of video it is.");
  });
});

// ---------- Characters ----------

describe("Characters (§45.34)", () => {
  it("Design with AI on a saved character sends its id, shows what changes, and Use this puts it in the editor", async () => {
    const design = vi.spyOn(api, "designCharacter");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.pip })} />);
    await click(control("Design with AI"), 50);
    type(field("What should Pip look like?"), "Curly hair and a blue jumper");
    await click(control("Design it"), 250);
    expect(design).toHaveBeenCalledWith("stories", { description: "Curly hair and a blue jumper", characterId: C.pip });
    await untilTask();
    const box = document.querySelector<HTMLElement>(".st-s-redesign")!;
    expect(box.textContent).toContain("What changes:");
    expect(box.textContent).toMatch(/Looks.*hair.*clothes/);
    expect(box.textContent).toContain("Stays the same: Faces, Moves, Sounds, Name, Description, Personality, Traits.");
    await click(control("Keep Pip as now", box), 50);
    expect(document.querySelector(".st-s-redesign")).toBeNull();
  });

  it("the practice agent keeps the name and changes only what the words are about", () => {
    const pip = store.characters.find((c) => c.characterId === C.pip)!;
    const fresh = characters.designFromWords("A speedy robot called Zed with curly hair", false, 3);
    const next = characters.redesign(pip as CharacterInput, fresh, "Give Pip curly hair");
    expect(next.name).toBe("Pip");
    expect((next as PersonInput).look.hair.style).toBe("curly");
    expect((next as PersonInput).look.outfit).toEqual((pip as PersonInput).look.outfit);
    expect(next.movementStyle).toBe(pip.movementStyle);
    expect(changedParts(pip as CharacterInput, next).changed.map((c) => c.part)).toEqual(["looks"]);
  });

  it("with AI pictures off, the line links to Settings › Video › Picture maker", async () => {
    await show(<CharactersScreen {...page({ name: "character", characterId: C.bolt })} />);
    const link = control("Settings › Video › Picture maker");
    expect(link.getAttribute("href")).toBe("/stories/settings/video");
    await expect(api.makePortrait("stories", C.bolt)).rejects.toMatchObject({ status: 409, message: characters.PICTURES_OFF });
  });
});

// ---------- Copies ----------

// ---------- A step that stopped on its model ----------

describe("a step that stopped on its model shows what it was asked with (§45.34)", () => {
  function stoppedJob() {
    const job = structuredClone(store.jobs.find((j) => j.contentId === S.failed)!);
    job.steps = job.steps.map((st) => (st.key === "storyboard" ? { ...st, status: "failed" } : st));
    job.meta.models = [{ step: "storyboard", agentId: "storyboard", model: "opus-5-5", effort: "high", effortApplied: false, failed: true }];
    return job;
  }

  it("the Production runs list: the model and the effort, marked stopped", () => {
    expect(runModels(LISTED_INFO, stoppedJob())).toBe("Write: Opus 5.5 · High (stopped)");
    const ok = stoppedJob();
    ok.meta.models = [{ step: "storyboard", agentId: "storyboard", model: "opus-5-5", effort: "high", effortApplied: true }];
    expect(runModels(LISTED_INFO, ok)).toBe("Write: Opus 5.5 · High");
    // An API that leaves `failed` out: an asked effort not applied on a step that failed is the same record.
    const bare = stoppedJob();
    bare.meta.models = [{ step: "storyboard", agentId: "storyboard", model: "opus-5-5", effort: "high", effortApplied: false }];
    expect(runModels(LISTED_INFO, bare)).toBe("Write: Opus 5.5 · High (stopped)");
    // A model with no effort setting on a finished step is not a stop.
    const own = stoppedJob();
    own.steps = own.steps.map((st) => (st.key === "storyboard" ? { ...st, status: "done" } : st));
    own.meta.models = [{ step: "storyboard", agentId: "storyboard", model: "opus-5-5", effort: null, effortApplied: false }];
    expect(runModels(LISTED_INFO, own)).toBe("Write: Opus 5.5");
  });

  it("Models working on it: never 'no effort setting' for a step that stopped", async () => {
    await show(<ModelsUsed info={LISTED_INFO} job={stoppedJob()} />);
    expect(document.querySelector(".st-s-used__model")?.textContent).toBe("Claude Opus 5.5 · High effort");
    expect(document.querySelector(".st-s-used__note")?.textContent).toBe("This step stopped on this model. This is what it was asked with.");
    expect(text()).not.toContain("no effort setting");
  });

  it("the Library's How it was made: '(stopped)', not '(not offered)'", async () => {
    const job = store.jobs.find((j) => j.contentId === S.failed)!;
    job.meta.models = [...job.meta.models.filter((m) => m.step !== "preview"), { step: "preview", agentId: "quality_assurance", model: "opus-5-5", effort: "high", effortApplied: false, failed: true }];
    await show(<LibraryScreen {...page({ name: "library", kind: null, storyId: S.failed })} />);
    await wait();
    const row = Array.from(document.querySelectorAll(".st-runs dt")).find((d) => d.textContent === "Ready to watch")!.nextElementSibling!;
    expect(row.textContent).toBe("Claude Opus 5.5 · High (stopped)");
    expect(text()).not.toContain("(not offered)");
  });
});

describe("Download offers the video's extra copies (§45.34)", () => {
  it("an approved video with a WebM copy offers Download MP4 and Download WebM", async () => {
    start({ extraFormats: ["webm"] });
    const download = vi.spyOn(api, "download");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await wait();
    await click(control("Download WebM"));
    expect(download).toHaveBeenLastCalledWith("stories", S.approved, { format: "webm" });
    await click(control("Download MP4"));
    expect(download).toHaveBeenLastCalledWith("stories", S.approved);
    expect(() => control("Download MOV")).toThrow();
  });

  it("a video without extra copies has the one Download", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await wait();
    expect(control("Download")).toBeTruthy();
    expect(() => control("Download WebM")).toThrow();
  });
});
