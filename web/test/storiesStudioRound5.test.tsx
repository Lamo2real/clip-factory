// Lamo Stories studio, round 5 (the final check's decisions, §45.36): Production › New ticks a ?ref= reference only
// against a list read just now (E2); the helpers name the writer from the model that wrote it (E7); AI tasks show the
// exact model behind Technical details (E8); an account problem always has Open Social accounts, and the mock's Fix it
// goes there (E9); new post words need only Check again, and the captions tab stays where the owner was (E10); the Post
// it sheet's Posted! celebrates (E11); a model the studio knows cannot be used is never pre-picked and Make the video
// asks first (E12); the other app is Clip Factory and an account is "this {Platform} account ({name})" (E13); account
// and model ids are folded away (E14); and the play badge leaves square and wide captions clear (E18). Rendered with
// the mock's own parts (fake timers); nothing leaves the machine.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as dashboard from "../src/stories/api/mock/dashboard.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as library from "../src/stories/api/mock/library.ts";
import * as publishing from "../src/stories/api/mock/publishing.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { Effective, ModelInfo, ReferenceVideo, SocialAccount, StoriesApi, StoriesConfig, TaskInfo, TikTokCreator, Workspace } from "../src/stories/api/types.ts";
import type { StoryScript } from "../src/stories/engine/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

const spy = vi.hoisted(() => ({ bursts: 0, sounds: [] as string[], celebrations: 0 }));

// The star burst and the cheer, counted on their way through (they still run).
vi.mock("../src/stories/ui.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/stories/ui.tsx")>();
  return {
    ...real,
    starBurst: (...a: Parameters<typeof real.starBurst>) => {
      spy.bursts += 1;
      real.starBurst(...a);
    },
  };
});
vi.mock("../src/stories/prefs.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/stories/prefs.ts")>();
  return {
    ...real,
    storiesSound: (...a: Parameters<typeof real.storiesSound>) => {
      spy.sounds.push(a[0]);
      return real.storiesSound(...a);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen } = await import("../src/stories/screens/Ideas.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen, approveBlock, onlyPostWords, POST_WORDS_CHECK } = await import("../src/stories/screens/Review.tsx");
const { LISTED_INFO, MODEL_STATUS_WORD, ModelMenu, sendPick, unusableAsk, usableUsual } = await import("../src/stories/studio/ai.tsx");
const { accountState, checkProblem, postToTitle, POST_YES, PublishSheet } = await import("../src/stories/studio/PublishSheet.tsx");
const { PostRow } = await import("../src/stories/studio/PostsPanel.tsx");
const { Filmstrip, frameShape } = await import("../src/stories/studio/Filmstrip.tsx");
const { referencesCache, referencesChanged } = await import("../src/stories/studio/hooks.ts");
const { accountProblem, helperName, helpersLine, modelHelperWords, providerName, thisAccount } = await import("../src/stories/studio/words.ts");

const S = stories.SEED_IDS.stories;
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
  ...extra,
});

const CREATOR: TikTokCreator = { nickname: "Lamo Stories", username: "tiktok.stories", avatarUrl: null, privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxDurationSec: 600 };

/** A Meta model the owner added (it writes storyboards as "bedrock-model:custom-llama", §45.36 E7). */
const LLAMA: ModelInfo = { ...LISTED_INFO.models[0]!, key: "custom-llama", label: "Llama 4 Maverick", provider: "Meta", host: "Amazon Bedrock", modelId: "us.meta.llama4-maverick-17b-instruct-v1:0", efforts: [], defaultEffort: null, custom: true, status: "ok", statusLine: "It answered on the last call." };

const REF_A: ReferenceVideo = { refId: "01JSTRV0000000000000000001", title: "The banana slip", status: "analyzed", durationSec: 38, bytes: 9_000_000, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: { model: "opus-5-5", effort: "high" }, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z" };
const REF_NEW: ReferenceVideo = { ...REF_A, refId: "01JSTRV0000000000000000009", title: "Dog chases the snowball", durationSec: 12, createdAt: "2026-11-22T07:00:00.000Z", updatedAt: "2026-11-22T07:00:00.000Z" };

let store: MockStore;
let api: StoriesApi;
let root: Root | undefined;
let host: HTMLElement | undefined;
/** What GET …/ai answers (the tests change the models' status and the storyboard's usual). */
let models: ModelInfo[];
let tasks: TaskInfo[];
let refsDelay = 0;

function makeApi(knobs: Record<string, unknown> = {}): StoriesApi {
  store = createStore();
  store.knobs = { ...knobs };
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  store.social.push(account("youtube", "connected", "Lamo Stories Channel"), account("tiktok", "connected", "Lamo Stories"), account("instagram", "not_connected", null), account("facebook", "not_connected", null), account("x", "not_connected", null));
  store.references.push(structuredClone(REF_A));
  publishing.afterSeed(store);
  const now = "2026-11-22T08:00:00.000Z";
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
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(models), agents: [], tasks: structuredClone(tasks) }),
    listReferences: async () => {
      if (refsDelay) await new Promise((r) => setTimeout(r, refsDelay));
      return structuredClone(store.references);
    },
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

function start(knobs: Record<string, unknown> = {}) {
  api = makeApi(knobs);
  setStoriesApi(api);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T08:00:00.000Z"));
  forgetLoaded();
  models = LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "It answered on the last call." }));
  tasks = structuredClone(LISTED_INFO.tasks);
  refsDelay = 0;
  spy.bursts = 0;
  spy.sounds = [];
  start();
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  await unmount();
  setStoriesApi(null);
  vi.useRealTimers();
});

async function unmount() {
  const r = root;
  root = undefined;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = undefined;
}

async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A mock call, with its pretend wait let go. */
async function call<T>(p: Promise<T>): Promise<T> {
  await wait(500);
  return p;
}

async function show(node: ReactNode, ms = 1500) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ToastProvider>{node}</ToastProvider>));
  await wait(ms);
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
/** The words on screen outside the "Technical details" folds. */
function plainText(within: Element = document.body): string {
  const copy = within.cloneNode(true) as Element;
  for (const fold of copy.querySelectorAll(".st-s-tech")) fold.remove();
  return copy.textContent ?? "";
}

/** The storyboard agent's usual is Claude Fable 5.1, which Bedrock refused on its last call. */
function fableDenied() {
  models = models.map((m) => (m.key === "fable-5-1" ? { ...m, status: "denied", statusLine: "Amazon Bedrock said this account has no access to Claude Fable 5.1." } : m));
  const agent: Effective = { model: "fable-5-1", effort: "high", effortApplied: true, from: "agent" };
  tasks = tasks.map((t) => (t.kind === "storyboard" || t.kind === "captions" ? { ...t, effective: agent } : t));
}

// ---------- E2: a reference uploaded in this visit stays ticked ----------

describe("Production › New ticks a reference from the address against a fresh list only (§45.36 E2)", () => {
  it("a list remembered from an earlier visit never drops a reference uploaded since", async () => {
    // An earlier visit remembers the list with only the banana video.
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    expect(document.querySelectorAll(".st-s-reftile")).toHaveLength(1);
    await unmount();
    // A new video is uploaded and studied; Use in a video opens Production › New with ?ref= while the list is slow.
    store.references.push(structuredClone(REF_NEW));
    refsDelay = 4000;
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [REF_NEW.refId] })} />, 500);
    // The remembered list shows first: the new video has no tile yet.
    expect(Array.from(document.querySelectorAll(".st-s-reftile")).map((t) => t.textContent)).not.toContain(expect.stringContaining(REF_NEW.title));
    await wait(4500);
    const tile = Array.from(document.querySelectorAll<HTMLElement>(".st-s-reftile")).find((t) => t.textContent?.includes(REF_NEW.title))!;
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ referenceIds: [REF_NEW.refId] });
  });

  it("a reference that is really gone is still dropped once the fresh list says so", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: ["01JSTRV0000000000000000077", REF_A.refId] })} />);
    const create = vi.spyOn(api, "createStory");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ referenceIds: [REF_A.refId] });
  });

  it("an upload, a study or a delete gives the studio's reference list a new cache name", () => {
    const before = referencesCache();
    referencesChanged();
    expect(referencesCache()).not.toBe(before);
    expect(referencesCache()).toMatch(/^st-s-refvids:/);
  });
});

// ---------- E7: the writer by its real model ----------

describe("Helpers used names the real writer (§45.36 E7)", () => {
  const lookup = (key: string) => [...LISTED_INFO.models, LLAMA].find((m) => m.key === key) ?? null;

  it("an added model is named from its maker and label, on its host; never a raw id", () => {
    expect(providerName("bedrock-model:custom-llama", lookup)).toBe("Meta Llama 4 Maverick on Amazon Bedrock");
    expect(providerName("bedrock-model:custom-gone", lookup)).toBe("A model on Amazon Bedrock");
    expect(providerName("bedrock-model:custom-llama")).toBe("A model on Amazon Bedrock");
    expect(modelHelperWords({ label: "Amazon Nova Pro", provider: "Amazon", host: "Amazon Bedrock" })).toBe("Amazon Nova Pro on Amazon Bedrock");
    expect(providerName("bedrock-claude", lookup)).toBe("Claude on Amazon Bedrock");
    expect(helpersLine({ writer: "bedrock-model:custom-llama", images: "builtin-rig" }, "custom-llama", lookup)).toBe("Meta Llama 4 Maverick on Amazon Bedrock, Built-in drawing");
  });

  it("an older run recorded as bedrock-claude is named from its non-Anthropic writer model", () => {
    expect(helperName("writer", "bedrock-claude", "custom-llama", lookup)).toBe("Meta Llama 4 Maverick on Amazon Bedrock");
    expect(helperName("writer", "bedrock-claude", "opus-5-5", lookup)).toBe("Claude on Amazon Bedrock");
    expect(helperName("images", "builtin-rig", "custom-llama", lookup)).toBe("Built-in drawing");
  });

  it("Production's details say the Meta model wrote it, like its Writer line", async () => {
    models = [...models, LLAMA];
    const job = store.jobs.filter((j) => j.contentId === S.approved).at(-1)!;
    job.meta.writerModel = "custom-llama";
    job.meta.providers = { ...job.meta.providers, writer: "bedrock-model:custom-llama" };
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.approved })} />);
    const details = document.querySelector<HTMLDetailsElement>(".st-s-details")!;
    details.open = true;
    const facts = new Map(Array.from(details.querySelectorAll(":scope > .st-s-facts dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(facts.get("Writer")).toBe("Llama 4 Maverick");
    expect(facts.get("Helpers used")).toContain("Meta Llama 4 Maverick on Amazon Bedrock");
    expect(facts.get("Helpers used")).not.toContain("Claude");
  });
});

// ---------- E8 and E14: exact models behind Technical details ----------

describe("every model record has its details, folded away (§45.36 E8, E14)", () => {
  it("a finished full idea says what made it, with the exact model behind Technical details", async () => {
    await show(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    const card = document.querySelector<HTMLElement>(`[data-idea="${I.sandwich}"]`)!;
    // An idea with a full idea shows it first, then offers Write it again; one without offers Make it a full idea.
    if (Array.from(card.querySelectorAll("button")).some((b) => b.textContent?.trim() === "See the full idea")) await click(control("See the full idea", card), 50);
    await click(control(/^(Make it a full idea|Write it again)$/, card), 50);
    for (let i = 0; i < 24; i += 1) await wait(250);
    const made = card.querySelector<HTMLElement>(".st-s-taskmade")!;
    expect(made.querySelector(".st-s-taskmade__line")?.textContent).toMatch(/^Made with Claude .+/);
    const fold = made.querySelector<HTMLDetailsElement>(".st-s-tech")!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toMatch(/Model ID \S*anthropic\.claude-\S+ in eu-north-1/);
    expect(plainText(card)).not.toContain("Model ID");
  });

  it("Review's How it was made keeps the ids in its fold, never as a first line", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    const made = document.querySelector<HTMLElement>(".st-s-made")!;
    expect(made.querySelector(".st-s-used .st-s-tech")?.textContent).toMatch(/Model ID \S+ in eu-north-1/);
    expect(plainText(made)).not.toContain("Model ID");
  });

  it("a post's account id sits behind Technical details; its name and handle stay on the row", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.published })} />);
    const row = Array.from(document.querySelectorAll<HTMLElement>(".st-s-post")).find((r) => r.textContent?.includes("YouTube"))!;
    expect(row.querySelector(".st-s-post__account")?.textContent).toContain("Lamo Stories Channel");
    expect(row.querySelector(".st-s-tech")?.textContent).toContain("Account id ext-youtube");
    expect(plainText(row)).not.toContain("ext-youtube");
  });

  it("the Post it sheet's chosen place folds its account id too", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/Lamo Stories Channel/, lastDialog()), 50);
    const dest = lastDialog().querySelector<HTMLElement>(".st-s-dest")!;
    expect(dest.textContent).toContain("Goes to Lamo Stories Channel");
    expect(dest.querySelector(".st-s-tech")?.textContent).toContain("Account id ext-youtube");
    expect(plainText(dest)).not.toContain("ext-youtube");
  });
});

// ---------- E9: a way to fix an account problem ----------

describe("an account problem always has Open Social accounts (§45.36 E9)", () => {
  it("the Posts panel offers it next to Try again only for an account problem", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.published })} />);
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".st-s-post"));
    const tiktok = rows.find((r) => r.textContent?.includes("TikTok"))!;
    const facebook = rows.find((r) => r.textContent?.includes("Facebook"))!;
    expect(tiktok.querySelector(".st-s-post__why")?.textContent).toContain("Social accounts");
    const link = control("Open Social accounts", tiktok);
    expect(link.getAttribute("href")).toBe("/stories/connections");
    expect(control("Try again", tiktok)).toBeTruthy();
    expect(() => control("Open Social accounts", facebook)).toThrow();
  });

  it("the Post it sheet's sent view and its own problems have it too", async () => {
    const story = store.stories.find((s) => s.storyId === S.published)!;
    const jobs = store.publishing.filter((j) => j.contentId === S.published);
    await show(<PublishSheet ws="stories" story={story} config={{}} jobs={jobs} onSent={() => undefined} onRetry={() => undefined} onClose={() => undefined} />);
    vi.spyOn(api, "publish").mockRejectedValueOnce(new ApiError(409, "conflict", "Lamo Stories' YouTube is not connected. Connect it in Lamo Stories › Social accounts, then tap Try again."));
    await click(control(/Lamo Stories Channel/, lastDialog()), 50);
    await click(control(/^Upload/, lastDialog()));
    const notice = lastDialog().querySelector<HTMLElement>(".st-s-notice")!;
    expect(notice.textContent).toContain("Social accounts");
    expect(control("Open Social accounts", notice).getAttribute("href")).toBe("/stories/connections");
  });

  it("says which sentences are account problems, as the API's Fix it does", () => {
    expect(accountProblem({ publishingStatus: "needs_attention", error: "This TikTok account (Lamo Stories) needs connecting again. Open Lamo Stories › Social accounts, then tap Try again." })).toBe(true);
    expect(accountProblem({ publishingStatus: "failed", error: "Facebook did not answer. Tap Try again in a few minutes." })).toBe(false);
    expect(accountProblem({ publishingStatus: "posted", error: "Open Lamo Stories › Social accounts" })).toBe(false);
    expect(accountProblem("Lamo Stories' TikTok needs connecting again. Fix it in Social accounts, or leave TikTok out.")).toBe(true);
  });

  it("the mock's Needs you › Fix it goes to Social accounts for an account problem, like the API", () => {
    const needs = dashboard.dashboardOf(store, "stories").needsYou.filter((n) => n.publishingJobId);
    const tiktok = needs.find((n) => n.platform === "tiktok")!;
    const facebook = needs.find((n) => n.platform === "facebook")!;
    expect(tiktok.href).toBe("/stories/connections");
    expect(facebook.href).toBe(`/stories/review/${S.published}`);
    expect(dashboard.postHref("Pick another in Lamo Stories › Social accounts, then tap Try again.", S.approved)).toBe("/stories/connections");
  });
});

// ---------- E10: new post words need a quick check, not a remake ----------

describe("post words alone need Check again, never a remake (§45.36 E10)", () => {
  it("the approve rule and its sentence", () => {
    const story = store.stories.find((s) => s.storyId === S.review)!;
    expect(onlyPostWords({ ...story, stale: ["safety"] })).toBe(true);
    expect(onlyPostWords({ ...story, stale: ["safety", "sound"] })).toBe(false);
    expect(approveBlock({ ...story, stale: ["safety"] })).toBe(POST_WORDS_CHECK);
    expect(POST_WORDS_CHECK).toBe("Your new post words need a quick check. Tap Check again.");
    expect(approveBlock({ ...story, stale: ["safety", "sound"] })).toBe("Your changes aren't in the video yet. Tap Remake first.");
  });

  it("saving the post words keeps the tab, says Check again, and Check again checks from the facts", async () => {
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(document.querySelector<HTMLElement>(".st-s-editor-box .st-s-pick__opt:nth-of-type(2) input")!, 50);
    const tabOn = () => document.querySelector(".st-s-editor-box .st-s-pick__opt.is-on")?.textContent;
    expect(tabOn()).toBe("With the post");
    type(field("X"), "Pip keeps calm on the ice!");
    await click(control("Save post words"));
    expect(store.stories.find((s) => s.storyId === S.review)!.stale).toEqual(["safety"]);
    // The box started again with the new version, on the tab the owner was on.
    expect(tabOn()).toBe("With the post");
    expect(text()).toContain(`Saved. ${POST_WORDS_CHECK}`);
    expect(document.getElementById("st-approve-why")?.textContent).toBe(POST_WORDS_CHECK);
    expect(text()).not.toContain("Tap Remake");
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes(POST_WORDS_CHECK))!;
    await click(control("Check again", notice));
    expect(produce).toHaveBeenCalledWith("stories", S.review, { from: "safety" });
  });

  it("Use these keeps the tab too", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(document.querySelector<HTMLElement>(".st-s-editor-box .st-s-pick__opt:nth-of-type(2) input")!, 50);
    await click(control("Write them again"), 50);
    for (let i = 0; i < 24 && !document.querySelector(".st-s-draftcaps"); i += 1) await wait(250);
    await click(control("Use these", document.querySelector(".st-s-draftcaps")!));
    expect(document.querySelector(".st-s-editor-box .st-s-pick__opt.is-on")?.textContent).toBe("With the post");
    expect(text()).toContain(`Saved. ${POST_WORDS_CHECK}`);
  });

  it("the mock's approve says the same", async () => {
    const { story } = await call(api.getStory("stories", S.review));
    const r = await call(api.patchStory("stories", S.review, { version: story.version, postCaptions: { x: "New words" } }));
    expect(r.story.stale).toEqual(["safety"]);
    const refused = api.approve("stories", S.review, r.story.version).catch((e: unknown) => e);
    await wait(500);
    expect(((await refused) as Error).message).toBe(POST_WORDS_CHECK);
  });
});

// ---------- E11: Posted! celebrates ----------

describe("the Post it sheet's Posted! celebrates, as Approve does (§45.36 E11)", () => {
  it("one star burst and one success cheer when every place is up", async () => {
    start({ publishMs: 300 });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/Lamo Stories Channel/, lastDialog()), 50);
    spy.bursts = 0;
    spy.sounds = [];
    await click(control(/^Upload/, lastDialog()), 500);
    expect(lastDialog().querySelector(".st-s-sheet__title")?.textContent).toBe("Sending your video");
    expect(spy.bursts).toBe(0);
    await wait(11_000);
    expect(lastDialog().querySelector(".st-s-sheet__title")?.textContent).toBe("Posted!");
    expect(spy.bursts).toBe(1);
    expect(spy.sounds.filter((s) => s === "success")).toHaveLength(1);
    // It celebrates once, however often the page reads the posts again.
    await wait(11_000);
    expect(spy.bursts).toBe(1);
  });
});

// ---------- E12: a model the studio knows cannot be used ----------

describe("a model the studio knows cannot be used is never pre-picked (§45.36 E12)", () => {
  const live = () => ({ models, tasks, live: true, defaultModel: "opus-5-5" });

  it("the usual skips it, and what the menu shows is what is sent", () => {
    fableDenied();
    const usual: Effective = { model: "fable-5-1", effort: "high", effortApplied: true, from: "agent" };
    expect(usableUsual(live(), usual)).toMatchObject({ model: "opus-5-5", effort: "high", skipped: "fable-5-1" });
    expect(sendPick(live(), usual, null)).toEqual({ model: "opus-5-5" });
    expect(sendPick(live(), usual, { effort: "low" })).toEqual({ model: "opus-5-5", effort: "low" });
    expect(sendPick(live(), usual, { model: "sonnet-5-5" })).toEqual({ model: "sonnet-5-5" });
    // A usual that works is sent as before: nothing.
    expect(sendPick(live(), { ...usual, model: "opus-5-5" }, null)).toBeUndefined();
    // Settings that could not be read know no status: nothing is skipped.
    expect(sendPick({ ...LISTED_INFO }, usual, null)).toBeUndefined();
    expect(unusableAsk(live(), usual, { model: "fable-5-1" })).toMatchObject({ bad: { key: "fable-5-1" }, instead: "opus-5-5" });
    expect(unusableAsk(live(), usual, { model: "sonnet-5-5" })).toBeNull();
    expect(MODEL_STATUS_WORD).toEqual({ ok: "Works", not_checked: "Not checked yet", denied: "No access", not_found: "Not found", error: "Problem" });
  });

  it("the menu shows the skipped model with its status line, and its chip says No access when picked", async () => {
    fableDenied();
    let value: { model?: string } | null = null;
    const usual: Effective = { model: "fable-5-1", effort: "high", effortApplied: true, from: "agent" };
    await show(<ModelMenu info={live()} usual={usual} value={null} onChange={(v) => (value = v)} />, 50);
    const chip = document.querySelector<HTMLElement>(".st-s-ai-btn")!;
    expect(chip.textContent).toContain("Opus 5.5");
    expect(chip.classList.contains("is-bad")).toBe(false);
    await click(chip, 50);
    const sheet = lastDialog();
    const lines = Array.from(sheet.querySelectorAll(".st-s-pick__opt")).map((o) => o.textContent ?? "");
    expect(lines[0]).toBe("Usual: Claude Opus 5.5Claude Fable 5.1 has no access right now, so the usual is this one.");
    expect(lines.find((l) => l.startsWith("Claude Fable 5.1"))).toContain("No access: Amazon Bedrock said this account has no access to Claude Fable 5.1.");
    expect(lines.find((l) => l.startsWith("Claude Opus 5.5"))).toContain("Works.");
    await unmount();
    await show(<ModelMenu info={live()} usual={usual} value={{ model: "fable-5-1" }} onChange={(v) => (value = v)} />, 50);
    const bad = document.querySelector<HTMLElement>(".st-s-ai-btn")!;
    expect(bad.classList.contains("is-bad")).toBe(true);
    expect(bad.querySelector(".st-s-ai-btn__status")?.textContent).toBe("No access");
    expect(bad.getAttribute("aria-label")).toContain("no access");
    expect(value).toBeNull();
  });

  it("Make the video with nothing picked sends the usual's stand-in, never the refused model", async () => {
    fableDenied();
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    expect(document.querySelector(".st-s-newvideo .st-s-ai-btn")?.textContent).toContain("Opus 5.5");
    await click(control("Make the video"));
    expect(dialogs()).toHaveLength(0);
    expect(create.mock.calls[0]![1].ai).toEqual({ model: "opus-5-5", effort: null });
  });

  it("Make the video with it picked asks first: Use the usual, or try it anyway", async () => {
    fableDenied();
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    await click(control(/^Model and effort for this video/), 50);
    await pick("Model", "Claude Fable 5.1");
    await click(control("Done", lastDialog()), 50);
    expect(document.querySelector(".st-s-newvideo .st-s-ai-btn__status")?.textContent).toBe("No access");
    await click(control("Make the video"), 50);
    expect(create).not.toHaveBeenCalled();
    const ask = lastDialog();
    expect(ask.querySelector(".st-s-sheet__title")?.textContent).toBe("Claude Fable 5.1 has no access right now. Use Claude Opus 5.5 instead?");
    await click(control("Use Claude Opus 5.5", ask));
    expect(create.mock.calls[0]![1].ai).toEqual({ model: "opus-5-5", effort: null });
  });

  it("Try it anyway sends the model the owner picked", async () => {
    fableDenied();
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    await click(control(/^Model and effort for this video/), 50);
    await pick("Model", "Claude Fable 5.1");
    await click(control("Done", lastDialog()), 50);
    await click(control("Make the video"), 50);
    await click(control("Try Claude Fable 5.1 anyway", lastDialog()));
    expect(create.mock.calls[0]![1].ai).toEqual({ model: "fable-5-1", effort: null });
  });

  it("Review's remakes use the stand-in too", async () => {
    fableDenied();
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    expect(document.querySelector(".st-s-decide__ai .st-s-ai-btn")?.textContent).toContain("Opus 5.5");
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it", lastDialog()));
    expect(produce).toHaveBeenCalledWith("stories", S.review, { from: "storyboard", override: { model: "opus-5-5" } });
  });
});

// ---------- E13: one name for the other app ----------

describe("one name on screen: Clip Factory, and accounts by their place (§45.36 E13)", () => {
  it("the publish sheet's words", () => {
    expect(accountState(account("x", "same_as_clips", "Lamo Stories"))).toBe("This is Clip Factory's account. Decide in Social accounts.");
    expect(checkProblem(account("x", "connected", "Lamo Stories"), account("x", "same_as_clips", "Lamo Stories"))).toContain("is Clip Factory's own account right now");
    expect(thisAccount("tiktok", "Lamo Stories")).toBe("this TikTok account (Lamo Stories)");
    expect(thisAccount("youtube", null)).toBe("this YouTube account");
    expect(postToTitle("tiktok", { externalAccountId: "ext", accountName: "Lamo Stories", handle: "@lamo.stories" })).toBe("Post to this TikTok account (Lamo Stories)?");
    expect(POST_YES).toBe("Yes, post to this account");
  });

  it("the TikTok question reads right for an account called Lamo Stories, and its button matches", async () => {
    start({ tiktokUnsure: true });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/^TikTok/, lastDialog()), 50);
    await click(control("Use my settings", lastDialog()), 50);
    await click(control(/^Upload/, lastDialog()));
    const ask = lastDialog();
    expect(ask.querySelector(".st-s-sheet__title")?.textContent).toBe("Post to this TikTok account (Lamo Stories)?");
    expect(ask.textContent).toContain("Lamo Stories cannot tell if this TikTok account (Lamo Stories) is the one Clip Factory posts to. Tap Yes if it is your Lamo Stories TikTok.");
    expect(ask.textContent).not.toContain("Lamo Clips");
    expect(ask.textContent).not.toContain("gives each app its own id");
    expect(control(POST_YES, ask)).toBeTruthy();
  });

  it("the mock's posting sentences never say Lamo Clips", async () => {
    Object.assign(store.social.find((a) => a.platform === "tiktok")!, { connectionStatus: "same_as_clips" });
    Object.assign(store.social.find((a) => a.platform === "youtube")!, { connectionStatus: "needs_reconnect" });
    const made = await call(
      api.publish("stories", S.approved, [
        { platform: "tiktok", socialAccountId: "stories.tiktok" },
        { platform: "youtube", socialAccountId: "stories.youtube" },
      ]),
    );
    expect(made.map((j) => j.error)).toEqual([
      "This TikTok account (Lamo Stories) is the one Clip Factory posts to. Pick another in Lamo Stories › Social accounts, then tap Try again.",
      "This YouTube account (Lamo Stories Channel) needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.",
    ]);
    expect(JSON.stringify(store.publishing)).not.toContain("Lamo Clips");
  });

  it("the studio's screens never say Lamo Clips", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.published })} />);
    expect(text()).not.toContain("Lamo Clips");
  });
});

// ---------- E18: the play badge on square and wide thumbnails ----------

describe("the play badge never covers a square or wide caption (§45.36 E18)", () => {
  it("the filmstrip knows the shape, and the badge sits in the top corner for square and wide", async () => {
    expect(frameShape({ width: 1080, height: 1920 } as StoryScript)).toBe("tall");
    expect(frameShape({ width: 1080, height: 1080 } as StoryScript)).toBe("square");
    expect(frameShape({ width: 1920, height: 1080 } as StoryScript)).toBe("wide");
    expect(frameShape(null)).toBe("tall");
    const script = structuredClone(store.scripts[S.review]!);
    const story = store.stories.find((s) => s.storyId === S.review)!;
    await show(<Filmstrip script={{ ...script, width: 1080, height: 1080 } as StoryScript} scenes={story.scenes} />, 50);
    expect(document.querySelector(".st-s-film")?.classList.contains("st-s-film--square")).toBe(true);
    const css = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "studio.css"), "utf8");
    const rule = /\.st-s-film--square \.st-s-film__play,\s*\.st-s-film--wide \.st-s-film__play \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/top: 6px/);
    expect(rule).toMatch(/bottom: auto/);
  });
});

// ---------- A post row on its own ----------

describe("PostRow (§45.36 E9, E14)", () => {
  it("a post that stopped on an account problem has both ways out; the id is folded", async () => {
    const job = store.publishing.find((j) => j.platform === "tiktok" && j.contentId === S.published)!;
    await show(
      <ul>
        <PostRow job={job} onRetry={() => undefined} />
      </ul>,
      50,
    );
    const row = document.querySelector<HTMLElement>(".st-s-post")!;
    expect(Array.from(row.querySelectorAll(".st-s-post__actions a, .st-s-post__actions button")).map((e) => e.textContent)).toEqual(["Open Social accounts", "Try again"]);
  });
});
