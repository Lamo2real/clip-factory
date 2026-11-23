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
const { insteadPick, LISTED_INFO, MODEL_STATUS_WORD, ModelMenu, nextRunLine, runTask, sendPick, unusableAsk, usableUsual } = await import("../src/stories/studio/ai.tsx");
const { AccountCard, accountState, checkProblem, postToTitle, POST_YES, postYes, PublishSheet } = await import("../src/stories/studio/PublishSheet.tsx");
const { ActionCard } = await import("../src/stories/chat/actions.tsx");
const { PostRow } = await import("../src/stories/studio/PostsPanel.tsx");
const { Filmstrip, frameShape } = await import("../src/stories/studio/Filmstrip.tsx");
const { referencesCache, referencesChanged } = await import("../src/stories/studio/hooks.ts");
const { accountProblem, accountShown, helperName, helpersLine, modelHelperWords, providerName, thisAccount } = await import("../src/stories/studio/words.ts");

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

const CREATOR: TikTokCreator = { nickname: "Clip Stories", username: "tiktok.stories", avatarUrl: null, privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxDurationSec: 600 };

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
  store.social.push(account("youtube", "connected", "Lamo Stories Channel"), account("tiktok", "connected", "Clip Stories"), account("instagram", "not_connected", null), account("facebook", "not_connected", null), account("x", "not_connected", null));
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

  it("a failed full idea still says what it was tried with, the exact model behind Technical details", async () => {
    start({ taskFail: true });
    await show(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    const card = document.querySelector<HTMLElement>(`[data-idea="${I.sandwich}"]`)!;
    if (Array.from(card.querySelectorAll("button")).some((b) => b.textContent?.trim() === "See the full idea")) await click(control("See the full idea", card), 50);
    await click(control(/^(Make it a full idea|Write it again)$/, card), 50);
    for (let i = 0; i < 24; i += 1) await wait(250);
    expect(card.textContent).toContain("The idea helper could not finish. Tap Try again.");
    const tried = card.querySelector<HTMLElement>(".st-s-taskmade--failed")!;
    expect(tried.querySelector(".st-s-taskmade__line")?.textContent).toMatch(/^Tried with Claude .+/);
    const fold = tried.querySelector<HTMLDetailsElement>(".st-s-tech")!;
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
    expect(dest.textContent).toContain("Goes to this YouTube account: Lamo Stories Channel");
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
    vi.spyOn(api, "publish").mockRejectedValueOnce(new ApiError(409, "conflict", "Clip Stories' YouTube is not connected. Connect it in Clip Stories › Social accounts, then tap Try again."));
    await click(control(/Lamo Stories Channel/, lastDialog()), 50);
    await click(control(/^Upload/, lastDialog()));
    const notice = lastDialog().querySelector<HTMLElement>(".st-s-notice")!;
    expect(notice.textContent).toContain("Social accounts");
    expect(control("Open Social accounts", notice).getAttribute("href")).toBe("/stories/connections");
  });

  it("says which sentences are account problems, as the API's Fix it does", () => {
    expect(accountProblem({ publishingStatus: "needs_attention", error: "This TikTok account (Clip Stories) needs connecting again. Open Clip Stories › Social accounts, then tap Try again." })).toBe(true);
    expect(accountProblem({ publishingStatus: "failed", error: "Facebook did not answer. Tap Try again in a few minutes." })).toBe(false);
    expect(accountProblem({ publishingStatus: "posted", error: "Open Clip Stories › Social accounts" })).toBe(false);
    expect(accountProblem("Clip Stories' TikTok needs connecting again. Fix it in Social accounts, or leave TikTok out.")).toBe(true);
  });

  it("the mock's Needs you › Fix it goes to Social accounts for an account problem, like the API", () => {
    const needs = dashboard.dashboardOf(store, "stories").needsYou.filter((n) => n.publishingJobId);
    const tiktok = needs.find((n) => n.platform === "tiktok")!;
    const facebook = needs.find((n) => n.platform === "facebook")!;
    expect(tiktok.href).toBe("/stories/connections");
    expect(facebook.href).toBe(`/stories/review/${S.published}`);
    expect(dashboard.postHref("Pick another in Clip Stories › Social accounts, then tap Try again.", S.approved)).toBe("/stories/connections");
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
    // No `from`: the run is exactly the stale steps, so only the fact check (a `from: "safety"` makes every step after it again).
    expect(produce).toHaveBeenCalledWith("stories", S.review);
    expect(produce.mock.calls[0]).toHaveLength(2);
  });

  it("Check again runs the fact check alone, then the video can be approved", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(document.querySelector<HTMLElement>(".st-s-editor-box .st-s-pick__opt:nth-of-type(2) input")!, 50);
    type(field("X"), "Pip keeps calm on the ice!");
    await click(control("Save post words"));
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes(POST_WORDS_CHECK))!;
    const before = store.jobs.length;
    await click(control("Check again", notice), 300);
    expect(store.jobs).toHaveLength(before + 1);
    const job = store.jobs.filter((j) => j.contentId === S.review).at(-1)!;
    expect(job.steps.filter((st) => st.status !== "done").map((st) => st.key)).toEqual(["safety"]);
    expect(store.stories.find((s) => s.storyId === S.review)!.stale).toEqual(["safety"]);
    for (let i = 0; i < 40 && store.stories.find((s) => s.storyId === S.review)!.status === "producing"; i += 1) await wait(500);
    const after = await call(api.getStory("stories", S.review));
    expect(after.story).toMatchObject({ status: "review", stale: [] });
    expect((await call(api.approve("stories", S.review, after.story.version))).status).toBe("approved");
  });

  it("a video waiting for its check says Check again for new post words too, never Remake", async () => {
    const story = store.stories.find((s) => s.storyId === S.needsCheck)!;
    expect(onlyPostWords({ ...story, stale: ["safety"] })).toBe(true);
    expect(approveBlock({ ...story, stale: ["safety"], safety: { ...story.safety!, status: "pending", problems: [] } })).toBe(POST_WORDS_CHECK);
    expect(approveBlock({ ...story, stale: ["safety"] })).toBe("Fix the facts first, then tap Check again.");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.needsCheck })} />);
    await click(document.querySelector<HTMLElement>(".st-s-editor-box .st-s-pick__opt:nth-of-type(2) input")!, 50);
    type(field("X"), "Nana Rose sees and is seen in the fog.");
    await click(control("Save post words"));
    expect(store.stories.find((s) => s.storyId === S.needsCheck)!.stale).toEqual(["safety"]);
    expect(text()).toContain(`Saved. ${POST_WORDS_CHECK}`);
    expect(text()).not.toContain("Tap Remake");
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes(POST_WORDS_CHECK))!;
    await click(control("Check again", notice));
    expect(produce).toHaveBeenCalledWith("stories", S.needsCheck);
  });

  it("the mock's approve says Check again for a video waiting for its check, unless the facts need fixing", async () => {
    const seeded = store.stories.find((s) => s.storyId === S.review)!;
    seeded.status = "needs_check";
    seeded.safety = { ...seeded.safety!, status: "pending", problems: [] };
    const { story } = await call(api.getStory("stories", S.review));
    const r = await call(api.patchStory("stories", S.review, { version: story.version, postCaptions: { x: "New words" } }));
    expect(r.story.stale).toEqual(["safety"]);
    const refused = api.approve("stories", S.review, r.story.version).catch((e: unknown) => e);
    await wait(500);
    expect(((await refused) as Error).message).toBe(POST_WORDS_CHECK);
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
    // Next run names what runs, never the refused model.
    expect(nextRunLine(live(), { ai: { model: null, effort: null }, effective: usual })).toBe("Next run: Claude Opus 5.5 · High");
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

  it("Make the video with nothing picked sends the usual's stand-in for the first job only, never kept with the video", async () => {
    fableDenied();
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    expect(document.querySelector(".st-s-newvideo .st-s-ai-btn")?.textContent).toContain("Opus 5.5");
    await click(control("Make the video"));
    expect(dialogs()).toHaveLength(0);
    // Not this video's own setting (the owner kept nothing): the create call's one-job override (§45.5).
    expect(create.mock.calls[0]![1].ai).toBeUndefined();
    expect(create.mock.calls[0]![1].override).toEqual({ model: "opus-5-5" });
    const { story, job } = await create.mock.results[0]!.value;
    expect(story.ai).toEqual({ model: null, effort: null });
    await wait(4000);
    const run = store.jobs.find((j) => j.jobId === job.jobId)!;
    expect(run.meta.models.find((m) => m.step === "storyboard" && m.task === "storyboard")?.model).toBe("opus-5-5");
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
    expect(create.mock.calls[0]![1].ai).toBeUndefined();
    expect(create.mock.calls[0]![1].override).toEqual({ model: "opus-5-5" });
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
    // §45.37 G8: nothing to decide about Clip Factory's own account; a different one made for Clip Stories.
    expect(accountState(account("x", "same_as_clips", "Clip Stories"))).toBe("This is Clip Factory's own account. Connect a different account made for Clip Stories in Social accounts.");
    expect(accountState(account("x", "same_as_clips", "Clip Stories"))).not.toMatch(/Lamo Clips/);
    expect(checkProblem(account("x", "connected", "Clip Stories"), account("x", "same_as_clips", "Clip Stories"))).toContain("is Clip Factory's own account right now");
    expect(thisAccount("tiktok", "Clip Stories")).toBe("this TikTok account (Clip Stories)");
    expect(thisAccount("youtube", null)).toBe("this YouTube account");
    expect(postToTitle("tiktok", { externalAccountId: "ext", accountName: "Clip Stories", handle: "@clip.stories" })).toBe("Post to this TikTok account (Clip Stories)?");
    expect(POST_YES).toBe("Yes, post to this account");
    expect(checkProblem(account("tiktok", "connected", "Old"), account("tiktok", "connected", "Clip Stories", { externalAccountId: "ext-other", handle: "@clip.stories" }))).toBe(
      "Clip Stories' TikTok is now a different account: this TikTok account (Clip Stories, @clip.stories). Look at it below, then tap Upload again.",
    );
  });

  it("the mock's account questions use the handle, else no name, never the raw account id (as the API)", async () => {
    start({ tiktokUnsure: true });
    const tiktok = store.social.find((a) => a.platform === "tiktok")!;
    Object.assign(tiktok, { accountName: null, handle: "@tiktok.stories", externalAccountId: "7312000000000000001" });
    const asked = async (p: Promise<unknown>) => {
      const e = p.catch((x: unknown) => x);
      await wait(500);
      return (await e) as Error;
    };
    let e = await asked(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok" }]));
    expect(e.message).toContain("cannot tell if this TikTok account (@tiktok.stories) is the one Clip Factory posts to");
    Object.assign(tiktok, { handle: null });
    e = await asked(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok" }]));
    expect(e.message).toContain("cannot tell if this TikTok account is the one Clip Factory posts to");
    expect(e.message).not.toContain("7312");
    // The account changed: the same, by its handle or without a name.
    const youtube = store.social.find((a) => a.platform === "youtube")!;
    Object.assign(youtube, { accountName: null, handle: "@stories.channel", externalAccountId: "UCx9raw-channel-id" });
    e = await asked(api.publish("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube", confirmAccount: "UC-old" }]));
    expect(e.message).toBe("Clip Stories' YouTube is a different account now: this YouTube account (@stories.channel). Tap Yes if that is right.");
    Object.assign(youtube, { handle: null });
    e = await asked(api.publish("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube", confirmAccount: "UC-old" }]));
    expect(e.message).toBe("Clip Stories' YouTube is a different account now: this YouTube account. Tap Yes if that is right.");
  });

  it("the TikTok question reads right for an account called Clip Stories, and its button matches", async () => {
    start({ tiktokUnsure: true });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/^TikTok/, lastDialog()), 50);
    await click(control("Use my settings", lastDialog()), 50);
    await click(control(/^Upload/, lastDialog()));
    const ask = lastDialog();
    expect(ask.querySelector(".st-s-sheet__title")?.textContent).toBe("Post to this TikTok account (Clip Stories)?");
    expect(ask.textContent).toContain("Clip Stories cannot tell if this TikTok account (Clip Stories) is the one Clip Factory posts to. Tap Yes if it is your Clip Stories TikTok.");
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
      "This TikTok account (Clip Stories) is the one Clip Factory posts to. Pick another in Clip Stories › Social accounts, then tap Try again.",
      "This YouTube account (Lamo Stories Channel) needs connecting again. Open Clip Stories › Social accounts, then tap Try again.",
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

// ---------- Round 5, second pass: what the two reviews found ----------

describe("a change to the reference videos while Production is open (§45.36 E2)", () => {
  it("reads the list again in place: the ticked reference stays ticked and goes with Make the video", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [REF_A.refId] })} />);
    const pressed = () => Array.from(document.querySelectorAll<HTMLElement>(".st-s-reftile")).filter((t) => t.getAttribute("aria-pressed") === "true").map((t) => t.textContent ?? "");
    expect(pressed()).toEqual([expect.stringContaining(REF_A.title)]);
    // A background upload finishes meanwhile (or a delete's undo runs out).
    store.references.push(structuredClone(REF_NEW));
    await act(async () => referencesChanged());
    await wait(1500);
    // Never "Getting your reference videos…" for good: the list is there, with the new one, and the pick stays.
    expect(text()).not.toContain("Getting your reference videos");
    expect(Array.from(document.querySelectorAll(".st-s-reftile")).map((t) => t.textContent ?? "")).toEqual(expect.arrayContaining([expect.stringContaining(REF_A.title), expect.stringContaining(REF_NEW.title)]));
    expect(pressed()).toEqual([expect.stringContaining(REF_A.title)]);
    const create = vi.spyOn(api, "createStory");
    await click(control("Make the video"));
    expect(create.mock.calls[0]![1]).toMatchObject({ referenceIds: [REF_A.refId] });
  });
});

describe("a model the studio knows cannot be used, kept or per run (§45.36 E12)", () => {
  const live = () => ({ models, tasks, live: true, defaultModel: "opus-5-5" });

  it("a model kept with the video is never swapped by itself: the run asks first", () => {
    fableDenied();
    const kept = { model: "fable-5-1", effort: "high" as const, effortApplied: true, from: "project" as const, modelKept: true };
    expect(usableUsual(live(), kept)).toMatchObject({ model: "fable-5-1", skipped: null });
    expect(sendPick(live(), kept, null)).toBeUndefined();
    expect(unusableAsk(live(), kept, null)).toMatchObject({ bad: { key: "fable-5-1" }, instead: "opus-5-5" });
    // A pick on top of a kept model that works: Use … means the kept one.
    const keptOk = { ...kept, model: "sonnet-5-5" };
    expect(unusableAsk(live(), keptOk, { model: "fable-5-1" })).toMatchObject({ instead: "sonnet-5-5" });
    expect(insteadPick(live(), { instead: "opus-5-5" }, { effort: "low" })).toEqual({ model: "opus-5-5", effort: "low" });
    expect(nextRunLine(live(), { ai: { model: "fable-5-1", effort: null }, effective: kept })).toBe("Next run: Claude Fable 5.1 · High");
  });

  it("the run's first model step decides whose usual is skipped", () => {
    expect(runTask(null)).toBe("storyboard");
    expect(runTask("storyboard", { sceneIds: true })).toBe("scene_rewrite");
    expect(runTask("safety")).toBe("fact_check");
    expect(runTask(null, { stale: ["safety"] })).toBe("fact_check");
    expect(runTask(null, { stale: ["sound", "captions", "assemble", "preview"] })).toBe("final_review");
  });

  it("Review's remake of a video that keeps a refused model asks; Use sends the usual for this run only", async () => {
    fableDenied();
    store.stories.find((s) => s.storyId === S.review)!.ai = { model: "fable-5-1", effort: null };
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    expect(document.querySelector(".st-s-decide__ai .st-s-ai-btn")?.textContent).toContain("Fable 5.1");
    expect(document.querySelector(".st-s-decide__ai .st-s-ai-btn__status")?.textContent).toBe("No access");
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it", lastDialog()), 50);
    expect(produce).not.toHaveBeenCalled();
    expect(lastDialog().querySelector(".st-s-sheet__title")?.textContent).toBe("Claude Fable 5.1 has no access right now. Use Claude Opus 5.5 instead?");
    await click(control("Use Claude Opus 5.5", lastDialog()));
    expect(produce).toHaveBeenCalledWith("stories", S.review, { from: "storyboard", override: { model: "opus-5-5" } });
    // This video still keeps its own model: nothing was saved.
    expect(store.stories.find((s) => s.storyId === S.review)!.ai).toEqual({ model: "fable-5-1", effort: null });
  });

  it("Try it anyway sends nothing over the kept model", async () => {
    fableDenied();
    store.stories.find((s) => s.storyId === S.review)!.ai = { model: "fable-5-1", effort: null };
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it", lastDialog()), 50);
    await click(control("Try Claude Fable 5.1 anyway", lastDialog()));
    expect(produce).toHaveBeenCalledWith("stories", S.review, { from: "storyboard" });
  });

  it("Check again of new post words never takes the writer's stand-in", async () => {
    fableDenied();
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(document.querySelector<HTMLElement>(".st-s-editor-box .st-s-pick__opt:nth-of-type(2) input")!, 50);
    type(field("X"), "Pip keeps calm on the ice!");
    await click(control("Save post words"));
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes(POST_WORDS_CHECK))!;
    await click(control("Check again", notice));
    expect(produce).toHaveBeenCalledWith("stories", S.review);
    expect(produce.mock.calls[0]).toHaveLength(2);
  });

  it("the chips show the usual of the run each button starts, and Remake sends that run's stand-in", async () => {
    // Only the fact check's usual is refused; a captions edit makes the next remake start at the fact check.
    models = models.map((m) => (m.key === "sonnet-5-5" ? { ...m, status: "denied", statusLine: "Amazon Bedrock said this account has no access to Claude Sonnet 5.5." } : m));
    tasks = tasks.map((t) => (t.kind === "fact_check" ? { ...t, effective: { model: "sonnet-5-5", effort: "high", effortApplied: true, from: "agent" } } : t));
    const seeded = store.stories.find((s) => s.storyId === S.review)!;
    seeded.stale = ["safety", "captions", "assemble", "preview"];
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    const chip = document.querySelector<HTMLElement>(".st-s-decide__ai .st-s-ai-btn")!;
    expect(chip.textContent).toContain("Opus 5.5");
    expect(chip.textContent).not.toContain("Sonnet 5.5");
    // Ask for changes starts at the storyboard: its own chip shows the storyboard's usual.
    await click(control("Ask for changes"), 50);
    expect(document.querySelector(".st-s-changes__ai .st-s-field__hint")?.textContent).toBe("These changes use");
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes("Your changes aren't in the video yet"))!;
    await click(control("Remake", notice));
    expect(produce).toHaveBeenCalledWith("stories", S.review, { override: { model: "opus-5-5" } });
  });

  it("a chat card never pre-picks the message's one-time model once it is known to be unusable", async () => {
    fableDenied();
    const changes = vi.spyOn(api, "requestChanges");
    const sceneId = store.stories.find((s) => s.storyId === S.review)!.scenes[0]!.sceneId;
    await show(<ActionCard ws="stories" id="m-once" info={live()} once={{ model: "fable-5-1", effort: "high" }} action={{ kind: "remake_scene", label: "Remake scene 1", payload: { storyId: S.review, sceneIds: [sceneId] } }} />);
    const chip = document.querySelector<HTMLElement>(".st-s-ai-btn.st-chat-action__ai")!;
    expect(chip.textContent).not.toContain("Fable 5.1");
    expect(chip.querySelector(".st-s-ai-btn__status")).toBeNull();
    await click(control("Remake scene 1"));
    expect(changes.mock.calls[0]![2]).toEqual({ sceneIds: [sceneId], override: { effort: "high" } });
  });

  it("a one-time model that works is still the card's first choice", async () => {
    const changes = vi.spyOn(api, "requestChanges");
    const sceneId = store.stories.find((s) => s.storyId === S.review)!.scenes[0]!.sceneId;
    await show(<ActionCard ws="stories" id="m-once-ok" info={live()} once={{ model: "sonnet-5-5", effort: "low" }} action={{ kind: "remake_scene", label: "Remake scene 1", payload: { storyId: S.review, sceneIds: [sceneId] } }} />);
    expect(document.querySelector(".st-s-ai-btn.st-chat-action__ai")?.textContent).toContain("Sonnet 5.5");
    await click(control("Remake scene 1"));
    expect(changes.mock.calls[0]![2]).toEqual({ sceneIds: [sceneId], override: { model: "sonnet-5-5", effort: "low" } });
  });

  it("a chat card never sends the stand-in before the video's own setting is read", async () => {
    fableDenied();
    tasks = tasks.map((t) => (t.kind === "scene_rewrite" ? { ...t, effective: { model: "fable-5-1", effort: "high", effortApplied: true, from: "agent" } } : t));
    vi.spyOn(api, "getStory").mockRejectedValue(new Error("offline"));
    const changes = vi.spyOn(api, "requestChanges");
    const sceneId = store.stories.find((s) => s.storyId === S.review)!.scenes[0]!.sceneId;
    await show(<ActionCard ws="stories" id="m1" info={live()} action={{ kind: "remake_scene", label: "Remake scene 1", payload: { storyId: S.review, sceneIds: [sceneId] } }} />);
    await click(control("Remake scene 1"));
    expect(changes.mock.calls[0]![2]).toEqual({ sceneIds: [sceneId] });
  });
});

describe("Make the video with Amazon Nova Pro records it as the writer (§45.36 E7)", () => {
  it("bedrock-model:{key} for a model that is not Anthropic's, bedrock-claude for Claude; Helpers used names it", async () => {
    const made = await call(api.createStory("stories", { ideaId: I.sandwich, characterIds: [stories.SEED_IDS.characters.pip], ai: { model: "nova-pro", effort: null } }));
    const claude = await call(api.createStory("stories", { brief: { title: "Bolt and the kite", logline: "Bolt flies a kite that flies him.", category: "comedy" }, characterIds: [stories.SEED_IDS.characters.bolt], override: { model: "opus-5-5" } }));
    await wait(4000);
    const run = store.jobs.find((j) => j.jobId === made.job.jobId)!;
    expect(run.meta.writerModel).toBe("nova-pro");
    expect(run.meta.providers.writer).toBe("bedrock-model:nova-pro");
    expect(run.meta.models.find((m) => m.step === "storyboard")).toMatchObject({ model: "nova-pro", modelId: "amazon.nova-pro-v1:0" });
    const other = store.jobs.find((j) => j.jobId === claude.job.jobId)!;
    expect(other.meta.providers.writer).toBe("bedrock-claude");
    // The create call's override is the first job's only (§45.5): never kept with the video.
    expect(store.stories.find((s) => s.storyId === claude.story.storyId)!.ai).toEqual({ model: null, effort: null });
    const lookup = (key: string) => [...LISTED_INFO.models, { ...LISTED_INFO.models[0]!, key: "nova-pro", label: "Amazon Nova Pro", provider: "Amazon", host: "Amazon Bedrock" }].find((m) => m.key === key) ?? null;
    expect(helperName("writer", run.meta.providers.writer, "nova-pro", lookup)).toBe("Amazon Nova Pro on Amazon Bedrock");
  });
});

describe("one name on screen, second pass (§45.36 E13, E14)", () => {
  it("the chosen place and the confirm sheet name the account by its place", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/^TikTok/, lastDialog()), 50);
    const dest = Array.from(lastDialog().querySelectorAll<HTMLElement>(".st-s-dest")).find((d) => d.textContent?.includes("TikTok"))!;
    expect(dest.querySelector(".st-s-dest__who")?.textContent).toBe("Goes to this TikTok account: Clip Stories (@tiktok.stories)");
  });

  it("the yes button matches the sentence the API sends", () => {
    expect(postYes("Clip Stories' TikTok is a different account now: this TikTok account (Clip Stories). Tap Yes if that is right.")).toBe(POST_YES);
    expect(postYes("Clip Stories' TikTok is a different account now: Clip Stories. Tap Post to Clip Stories if that is right.")).toBe("Post to Clip Stories");
    expect(postYes(null)).toBe(POST_YES);
  });

  it("an account with no name or handle never shows its raw id on the first line", async () => {
    expect(accountShown({ accountName: null, handle: null })).toBeNull();
    expect(accountShown({ accountName: "Lamo", handle: "lamo.stories" })).toBe("Lamo (@lamo.stories)");
    const job = { ...store.publishing.find((j) => j.platform === "tiktok" && j.contentId === S.published)!, accountName: null, handle: null, externalAccountId: "UCx9raw-channel-id" };
    await show(
      <>
        <ul>
          <PostRow job={job} onRetry={() => undefined} />
        </ul>
        <AccountCard platform="youtube" account={{ externalAccountId: "UCx9raw-channel-id", accountName: null, handle: null }} />
      </>,
      50,
    );
    expect(document.querySelector(".st-s-post__account")?.textContent).toBe("The connected account");
    expect(document.querySelector(".st-s-dest__who")?.textContent).toBe("Goes to the connected YouTube account.");
    expect(plainText()).not.toContain("UCx9raw-channel-id");
    expect(document.querySelector(".st-s-dest .st-s-tech")?.textContent).toContain("Account id UCx9raw-channel-id");
  });
});

describe("every post that goes up is celebrated once (§45.36 E11)", () => {
  it("one place up and one stopped: the sheet still celebrates the one that went up", async () => {
    start({ publishMs: 300 });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    await click(control(/Lamo Stories Channel/, lastDialog()), 50);
    await click(control(/^TikTok/, lastDialog()), 50);
    await click(control("Use my settings", lastDialog()), 50);
    spy.bursts = 0;
    spy.sounds = [];
    await click(control(/^Upload/, lastDialog()), 50);
    // TikTok's sign-in runs out meanwhile: that place stops, YouTube goes up.
    store.social.find((a) => a.platform === "tiktok")!.connectionStatus = "needs_reconnect";
    await wait(11_000);
    expect(lastDialog().querySelector(".st-s-sheet__title")?.textContent).toBe("Sending your video");
    expect(spy.bursts).toBe(1);
    expect(spy.sounds.filter((s) => s === "success")).toHaveLength(1);
    await wait(11_000);
    expect(spy.bursts).toBe(1);
  });

  it("a post that goes up while the sheet is still on its form is celebrated by the page", async () => {
    start({ publishMs: 3000 });
    await call(api.publish("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube" }]));
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />, 600);
    await click(control("Post it"), 50);
    spy.bursts = 0;
    spy.sounds = [];
    await wait(11_000);
    expect(lastDialog().querySelector(".st-s-sheet__title")?.textContent).toBe("Post it");
    expect(spy.bursts).toBe(1);
    expect(spy.sounds.filter((s) => s === "success")).toHaveLength(1);
  });
});
