// Lamo Stories studio, round 4 (docs/CONTRACTS.md §45.35): each step's exact model id in a details line (D5); the
// Library's Videos tab with a video's WebM and MOV copies (D10); Production's and the Library's details in plain words
// (helpers by name, one "Made with", the folder, seed and versions behind "Technical details", the safety topic's
// title, D21); previews that show each character's own face; "Write it again" keeping the full idea's own length; the
// timeline chip's short name; and Characters' save and delete never moving the owner out of Clip Factory (D17).
// Rendered with the mock's own parts (fake timers); CharacterPreview is a stand-in that shows the face it was given.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as library from "../src/stories/api/mock/library.ts";
import * as publishing from "../src/stories/api/mock/publishing.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { GuidanceTopic, LibraryItem, ModelInfo, ProductionJob, StoriesApi, StoriesConfig, Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

vi.mock("../src/stories/preview/CharacterPreview.tsx", () => ({
  CharacterPreview: ({ expression = "neutral", label }: { expression?: string; label: string }) => <span className="st-test-preview" data-face={expression} aria-label={label} role="img" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen } = await import("../src/stories/screens/Ideas.tsx");
const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen } = await import("../src/stories/screens/Review.tsx");
const { LibraryScreen, TAB_KINDS, tabFor } = await import("../src/stories/screens/Library.tsx");
const { LISTED_INFO, ModelsUsed, modelIdLine } = await import("../src/stories/studio/ai.tsx");
const { RedesignCompare } = await import("../src/stories/studio/Design.tsx");
const { inputOf, showFace } = await import("../src/stories/studio/looks.ts");
const { sfxLabel } = await import("../src/stories/studio/SfxEditor.tsx");
const { helpersLine, providerName, STORAGE_WORDS, topicTitle } = await import("../src/stories/studio/words.ts");
const { takeParkedStoriesGo } = await import("../src/stories/pane.tsx");
const { ActionCard } = await import("../src/stories/chat/actions.tsx");

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

const MODELS: ModelInfo[] = LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "Ready." }));

const TOPIC: GuidanceTopic = { id: "skid-recovery", title: "When the car slides on ice", steps: [], donts: [], caveats: [], citations: [] };

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function makeApi(): StoriesApi {
  store = createStore();
  store.knobs = {};
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  publishing.afterSeed(store);
  library.afterSeed(store);
  const now = "2026-11-22T08:00:00.000Z";
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...publishing.api(store),
    ...library.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    guidance: async () => ({ topics: [TOPIC], checkedAt: now }),
    social: async () => ({ accounts: structuredClone(store.social), clips: [] }),
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(MODELS), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
    listReferences: async () => [],
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T08:00:00.000Z"));
  localStorage.clear();
  forgetLoaded();
  takeParkedStoriesGo();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  takeParkedStoriesGo();
  localStorage.clear();
  vi.useRealTimers();
});

async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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

function field(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${String(label)}`);
  return el;
}

const text = () => document.body.textContent ?? "";
/** The words on the page outside its "Technical details" folds. */
function plainText(within: Element = document.body): string {
  const copy = within.cloneNode(true) as Element;
  for (const fold of copy.querySelectorAll(".st-s-tech")) fold.remove();
  return copy.textContent ?? "";
}
const RAW_IDS = /bedrock-claude|builtin-rig|builtin-2d|builtin-synth|nova-canvas|nova-reel|s3:\/\//;

/** Lamo Stories is switched on (this device's preview) and the owner has gone to Clip Factory's Library. */
function clipFactoryOnScreen() {
  localStorage.setItem("cf.storiesPreview", "1");
  history.replaceState(null, "", "/library");
}

// ---------- D5: the exact model ---------

describe("each step's exact model id is in a details line (§45.35 D5)", () => {
  function job(models: ProductionJob["meta"]["models"]): ProductionJob {
    const j = structuredClone(store.jobs.find((x) => x.contentId === S.approved)!);
    j.meta.models = models;
    return j;
  }

  it("Made with: the model id and Region the step really called, beside the words it had before", async () => {
    await show(
      <ModelsUsed
        info={LISTED_INFO}
        job={job([
          { step: "storyboard", agentId: "storyboard", task: "storyboard", model: "opus-5-5", modelId: "global.anthropic.claude-opus-5-5", region: "eu-north-1", effort: "high", effortApplied: true },
          { step: "safety", agentId: "quality_assurance", model: "opus-5-5", effort: "high", effortApplied: true },
        ])}
      />,
    );
    const items = Array.from(document.querySelectorAll(".st-s-used__item"));
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".st-s-used__row")?.textContent).toBe("Write the storyClaude Opus 5.5 · High effortStoryboard");
    // The exact ids sit behind Technical details (§45.36 E14), one line a record that says its id.
    const fold = document.querySelector<HTMLDetailsElement>(".st-s-used .st-s-tech")!;
    expect(fold.open).toBe(false);
    expect(Array.from(fold.querySelectorAll(".st-s-used__id")).map((e) => e.textContent)).toEqual(["Model ID global.anthropic.claude-opus-5-5 in eu-north-1"]);
    expect(fold.querySelector("li")?.textContent).toBe("Write the story: Model ID global.anthropic.claude-opus-5-5 in eu-north-1");
    expect(items.some((i) => i.textContent?.includes("Model ID"))).toBe(false);
    // An older record says nothing about the id: nothing is guessed from today's settings.
    expect(fold.textContent).not.toContain("Check the facts");
    expect(modelIdLine({ modelId: "arn:aws:bedrock:eu-west-1:123456789012:provisioned-model/abc" })).toBe("Model ID arn:aws:bedrock:eu-west-1:123456789012:provisioned-model/abc");
    expect(modelIdLine({ modelId: " " })).toBeNull();
  });

  it("the mock records exactly what each step called, and Production shows it", async () => {
    const made = store.jobs.find((x) => x.contentId === S.approved)!;
    expect(made.meta.models.find((m) => m.step === "storyboard")).toMatchObject({ task: "storyboard", modelId: expect.stringMatching(/anthropic\.claude-/), region: "eu-north-1" });
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.approved })} />);
    document.querySelector<HTMLDetailsElement>(".st-s-details")!.open = true;
    const ids = Array.from(document.querySelectorAll(".st-s-used__id")).map((e) => e.textContent);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((t) => /^Model ID \S*anthropic\.claude-\S+ in eu-north-1$/.test(t ?? ""))).toBe(true);
  });

  it("Review's How it was made shows the same line", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    expect(document.querySelectorAll(".st-s-made .st-s-used__id").length).toBeGreaterThan(0);
  });
});

describe("a step that makes two calls lists each by its own task (§45.35 D5)", () => {
  // The agent's own shape: the storyboard step writes the story (or a new take of some scenes), then the post captions.
  const call = { modelId: "global.anthropic.claude-opus-5-5", region: "eu-north-1", effort: "high" as const, effortApplied: true };
  const AGENT: ProductionJob["meta"]["models"] = [
    { step: "storyboard", agentId: "storyboard", task: "storyboard", model: "opus-5-5", ...call },
    { step: "storyboard", agentId: "storyboard", task: "captions", model: "sonnet-5-5", ...call },
    { step: "safety", agentId: "quality_assurance", task: "fact_check", model: "opus-5-5", ...call },
  ];
  function run(jobId: string, createdAt: string, models: ProductionJob["meta"]["models"]): ProductionJob {
    const j = structuredClone(store.jobs.find((x) => x.contentId === S.approved)!);
    Object.assign(j, { jobId, createdAt, updatedAt: createdAt });
    j.meta.models = models;
    return j;
  }
  const steps = () => Array.from(document.querySelectorAll(".st-s-used__step")).map((e) => e.textContent);

  it("Models working on it, Made with and a run's line: Write the story and Post captions, never the same words twice", async () => {
    const { madeWith } = await import("../src/stories/studio/ai.tsx");
    const { runModels } = await import("../src/stories/screens/Production.tsx");
    const job = run("01JSTJBTWOCALLS00000000000", "2026-11-22T07:00:00.000Z", AGENT);
    await show(<ModelsUsed info={LISTED_INFO} job={job} />);
    expect(steps()).toEqual(["Write the story", "Post captions", "Check the facts"]);
    expect(runModels(LISTED_INFO, job)).toBe("Write: Opus 5.5 · High · Captions: Sonnet 5.5 · High · Check: Opus 5.5 · High");
    // A new take of two scenes: its own words, and the video now keeps that run's calls for the step, not the older ones.
    const take = run("01JSTJBNEWTAKE00000000000", "2026-11-22T07:30:00.000Z", [
      { step: "storyboard", agentId: "storyboard", task: "captions", model: "haiku-5-5", ...call },
      { step: "storyboard", agentId: "storyboard", task: "scene_rewrite", model: "fable-5-2", ...call },
    ]);
    expect(madeWith([take, job]).map((u) => `${u.task}:${u.model}`)).toEqual(["scene_rewrite:fable-5-2", "captions:haiku-5-5", "fact_check:opus-5-5"]);
    expect(runModels(LISTED_INFO, take)).toBe("Captions: Haiku 5.5 · High · New take: Fable 5.2 · High");
    // An older record with no task (an API before §45.35) still shows once per step.
    const old = run("01JSTJBOLDRECORD000000000", "2026-11-22T06:00:00.000Z", AGENT.map(({ task: _task, ...m }) => m));
    expect(madeWith([old]).map((u) => u.step)).toEqual(["storyboard", "safety"]);
  });

  it("the Library's How it was made and its Exact models: one row per call, each with its own words and key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.jobs.find((j) => j.contentId === S.review)!.meta.models = structuredClone(AGENT);
    await show(<LibraryScreen {...page({ name: "library", kind: null, storyId: S.review })} />);
    await wait();
    const run = document.querySelector(".st-details .st-run")!;
    const rows = Array.from(run.querySelectorAll(":scope > .st-facts dt")).map((d) => d.textContent);
    expect(rows.filter((t) => t === "Write the story")).toHaveLength(1);
    expect(rows).toContain("Post captions");
    const ids = Array.from(run.querySelectorAll(".st-tech__ids li")).map((li) => li.textContent);
    expect(ids).toEqual(["Write the story: Model ID global.anthropic.claude-opus-5-5 in eu-north-1", "Post captions: Model ID global.anthropic.claude-opus-5-5 in eu-north-1", expect.stringMatching(/: Model ID global\.anthropic\.claude-opus-5-5 in eu-north-1$/)]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  });

  it("the mock records the post captions call as its own record, like the agent", async () => {
    const made = api.createStory("stories", { brief: { title: "Hats", logline: "Pip tries on hats.", category: "comedy" }, characterIds: [C.pip] });
    await wait(1500);
    const { story } = await made;
    await wait(12_000);
    const read = api.getStory("stories", story.storyId);
    await wait(1500);
    const job = (await read).job!;
    expect(job.status).toBe("ready");
    expect(job.meta.models.filter((m) => m.step === "storyboard").map((m) => m.task)).toEqual(["storyboard", "captions"]);
    expect(job.meta.models.find((m) => m.task === "captions")).toMatchObject({ agentId: "storyboard", model: "opus-5-5", modelId: expect.stringMatching(/anthropic\.claude-/), region: "eu-north-1", effortApplied: true });
    expect(job.meta.writerModel).toBe("opus-5-5");
  });
});

// ---------- D10: the Videos tab ---------

describe("the Library's Videos tab lists a video's WebM and MOV copies (§45.35 D10)", () => {
  function copy(format: "webm" | "mov"): LibraryItem {
    const story = store.stories.find((s) => s.storyId === S.approved)!;
    return {
      assetId: `01JSTAS${format === "webm" ? "W" : "M"}000000000000000000`,
      kind: "video",
      storyId: story.storyId,
      characterId: null,
      title: story.title,
      url: `data:video/${format};base64,`,
      contentType: format === "webm" ? "video/webm" : "video/quicktime",
      bytes: 12_000_000,
      version: story.scriptVersion,
      createdAt: "2026-11-22T07:00:00.000Z",
      meta: { current: 1, format },
    };
  }

  it("asks for both kinds and shows each copy with its own Download", async () => {
    store.assets.push(copy("webm"), copy("mov"));
    const read = vi.spyOn(api, "library");
    expect(TAB_KINDS.videos).toEqual(["final_video", "video"]);
    expect(tabFor("video")).toBe("videos");
    await show(<LibraryScreen {...page({ name: "library", kind: "videos", storyId: null })} />);
    expect(read.mock.calls.map((c) => c[1]?.kind)).toEqual(expect.arrayContaining(["final_video", "video"]));
    const kinds = Array.from(document.querySelectorAll(".st-file__kind")).map((k) => k.textContent);
    expect(kinds).toContain("Video copy · WebM");
    expect(kinds).toContain("Video copy · MOV");
    expect(kinds).toContain("Video");
    expect(control(/^Download video copy \(WebM\) of /)).toBeTruthy();
    expect(control(/^Download video copy \(MOV\) of /)).toBeTruthy();
  });

  it("an API that does not know the kind yet (400) still shows the MP4s, never a broken tab", async () => {
    const real = api.library.bind(api);
    vi.spyOn(api, "library").mockImplementation(async (ws, q) => {
      if (q?.kind === "video") throw new ApiError(400, "bad_request", "kind must be a file kind or all.");
      return real(ws, q);
    });
    await show(<LibraryScreen {...page({ name: "library", kind: "videos", storyId: null })} />);
    expect(document.querySelectorAll(".st-file").length).toBeGreaterThan(0);
    expect(Array.from(document.querySelectorAll(".st-file__kind")).every((k) => k.textContent === "Video")).toBe(true);
    expect(text()).not.toContain("kind must be");
  });
});

// ---------- D21: plain words in the details ---------

describe("Production's details say everything in words (§45.35 D21)", () => {
  it("helpers by name, one Made with, the folder words, and the path, seed and engine behind Technical details", async () => {
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.approved })} />);
    const details = document.querySelector<HTMLDetailsElement>(".st-s-details")!;
    details.open = true;
    const story = store.stories.find((s) => s.storyId === S.approved)!;
    const facts = new Map(Array.from(details.querySelectorAll(":scope > .st-s-facts dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(facts.get("Helpers used")).toBe("Claude on Amazon Bedrock, Built-in drawing, Built-in animator, Built-in sounds");
    expect(facts.get("Saved in")).toBe(STORAGE_WORDS);
    expect(facts.has("Seed")).toBe(false);
    expect(facts.has("Drawing engine")).toBe(false);
    const headings = Array.from(details.querySelectorAll("dt, h3")).filter((e) => e.textContent === "Made with");
    expect(headings).toHaveLength(1);
    expect(plainText(details)).not.toMatch(RAW_IDS);
    expect(plainText(details)).not.toContain(story.storageLocation);
    const fold = details.querySelector<HTMLDetailsElement>(".st-s-tech")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")?.textContent).toBe("Technical details");
    expect(fold.textContent).toContain(story.storageLocation);
    expect(fold.textContent).toContain("Seed");
    expect(fold.textContent).toContain("Drawing engine");
  });

  it("the words for every helper; an id the list does not know is never shown", () => {
    expect(providerName("bedrock-claude")).toBe("Claude on Amazon Bedrock");
    expect(providerName("nova-canvas")).toBe("Amazon Nova Canvas");
    expect(providerName("nova-reel")).toBe("Amazon Nova Reel");
    expect(providerName("something-new")).toBe("Another helper");
    expect(helpersLine({ writer: "bedrock-claude", images: "builtin-rig", animation: "builtin-2d", audio: "builtin-synth" })).toBe("Claude on Amazon Bedrock, Built-in drawing, Built-in animator, Built-in sounds");
    expect(helpersLine({ a: "x", b: "y" })).toBe("Another helper");
    expect(topicTitle([TOPIC], "skid-recovery")).toBe("When the car slides on ice");
    expect(topicTitle([], "skid-recovery")).toBe("Checked road advice");
    expect(topicTitle([TOPIC], null)).toBeNull();
  });
});

describe("the Library's How it was made says everything in words (§45.35 D5, D21)", () => {
  it("the safety topic's title, helpers by name, the folder words, and the exact parts behind Technical details", async () => {
    const story = store.stories.find((s) => s.storyId === S.review)!;
    const job = store.jobs.find((j) => j.contentId === S.review)!;
    job.meta.safetyTopicId = "skid-recovery";
    await show(<LibraryScreen {...page({ name: "library", kind: null, storyId: S.review })} />);
    await wait();
    const section = document.querySelector(".st-details")!;
    const run = section.querySelector(".st-run")!;
    const dd = (name: string) => Array.from(run.querySelectorAll(":scope > .st-facts dt")).find((d) => d.textContent === name)?.nextElementSibling?.textContent;
    expect(dd("Safety advice")).toBe("When the car slides on ice");
    expect(dd("Writing")).toBe("Claude on Amazon Bedrock");
    expect(dd("Pictures")).toBe("Built-in drawing");
    expect(dd("Animation")).toBe("Built-in animator");
    expect(dd("Sound")).toBe("Built-in sounds");
    expect(dd("Seed")).toBeUndefined();
    expect(plainText(section)).not.toMatch(RAW_IDS);
    expect(plainText(section)).not.toContain("skid-recovery");
    expect(plainText(section)).not.toContain(story.storageLocation);
    expect(plainText(section)).toContain(STORAGE_WORDS);
    const folds = Array.from(section.querySelectorAll(".st-s-tech"));
    expect(folds[0]!.textContent).toContain(story.storageLocation);
    const runFold = run.querySelector(".st-s-tech")!;
    expect(runFold.textContent).toContain("Seed");
    expect(runFold.textContent).toMatch(/Model ID \S*anthropic\.claude-\S+ in eu-north-1/);
  });
});

describe("previews show each character's own face (§45.35 D21)", () => {
  it("showFace: happy when it has it, else its first face that is not neutral", () => {
    expect(showFace({ expressions: ["neutral", "happy", "sad"] })).toBe("happy");
    expect(showFace({ expressions: ["neutral", "surprised", "sad"] })).toBe("surprised");
    expect(showFace({ expressions: ["neutral"] })).toBe("neutral");
    expect(showFace({ expressions: [] })).toBe("neutral");
  });

  it("the gallery, a picked cast tile and the redesign comparison", async () => {
    const bolt = store.characters.find((c) => c.characterId === C.bolt)!;
    bolt.expressions = ["neutral", "surprised", "worried"];
    await show(<CharactersScreen {...page({ name: "characters" })} />);
    const face = (name: string) => document.querySelector(`[aria-label="${name}, moving"]`)?.getAttribute("data-face");
    expect(face("Bolt")).toBe("surprised");
    expect(face("Pip")).toBe("happy");
    await act(async () => root.render(<ToastProvider><ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, refIds: [], castIds: [C.bolt], durationSec: null })} /></ToastProvider>));
    await wait();
    expect(document.querySelector('.st-s-casttile[aria-pressed="true"] [role="img"]')?.getAttribute("data-face")).toBe("surprised");
    const now = inputOf(bolt);
    await act(async () => root.render(<RedesignCompare now={now} next={{ ...now, expressions: ["neutral", "angry", "sad"] }} onUse={() => undefined} onDrop={() => undefined} />));
    const pair = Array.from(document.querySelectorAll(".st-s-redesign__fig [role='img']")).map((e) => e.getAttribute("data-face"));
    expect(pair).toEqual(["surprised", "angry"]);
    // The chat's "Save this character" card shows the character the director made with one of its own faces.
    const made = { ...now, name: "Frost", expressions: ["neutral", "proud", "sad"] };
    await act(async () => root.render(<ActionCard ws="stories" id="m4:0" action={{ kind: "save_character", label: "Save this character", payload: { character: made } }} />));
    expect(document.querySelector('[aria-label="How Frost looks"]')?.getAttribute("data-face")).toBe("proud");
  });

  it("a character's own page opens its big preview on its own face, never a smile it does not make", async () => {
    const bolt = store.characters.find((c) => c.characterId === C.bolt)!;
    bolt.expressions = ["neutral", "angry", "sad"];
    await show(<CharactersScreen {...page({ name: "character", characterId: C.bolt })} />);
    const stage = document.querySelector('[aria-label^="Bolt, "][aria-label*=" face, "]');
    expect(stage?.getAttribute("data-face")).toBe("angry");
    expect(stage?.getAttribute("aria-label")).not.toContain("Happy");
    // A character that has the happy face still opens on it.
    await act(async () => root.unmount());
    host.remove();
    await show(<CharactersScreen {...page({ name: "character", characterId: C.pip })} />);
    expect(document.querySelector('[aria-label^="Pip, "][aria-label*=" face, "]')?.getAttribute("data-face")).toBe("happy");
  });
});

describe("Write it again keeps the full idea's own length (§45.35 D21)", () => {
  it("a first try starts from the usual length; Write it again sends the full idea's own", async () => {
    const expand = vi.spyOn(api, "expandIdea");
    const skid = store.ideas.find((i) => i.ideaId === I.skid)!;
    skid.concept!.durationSec = 70;
    const sandwich = store.ideas.find((i) => i.ideaId === I.sandwich)!;
    delete sandwich.concept;
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-idea="${id}"]`)!;
    await click(control("See the full idea", card(I.skid)), 50);
    await click(control("Write it again", card(I.skid)), 50);
    expect(expand).toHaveBeenLastCalledWith("stories", I.skid, { durationSec: 70 });
    await click(control("Make it a full idea", card(I.sandwich)), 50);
    expect(expand).toHaveBeenLastCalledWith("stories", I.sandwich, { durationSec: 50 });
  });
});

describe("the timeline chip shows the sound's short name (§45.35 D21)", () => {
  it("'Wind', with '(whole scene)' in its spoken name and the row below", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    const mark = document.querySelector<HTMLElement>(".st-s-timeline__mark.is-place")!;
    const script = store.scripts[S.review]!;
    const bed = script.scenes.flatMap((sc) => sc.sfx).find((c) => /\.amb\d+$/.test(c.id))!;
    expect(mark.querySelector(".st-s-timeline__name")?.textContent).toBe(sfxLabel(bed.sfx));
    expect(mark.textContent).not.toContain("(whole scene)");
    expect(mark.getAttribute("aria-label")).toMatch(/\(whole scene\) at 0:00/);
    expect(text()).toContain("Sound (whole scene)");
  });
});

// ---------- D17: no page change of its own while Clip Factory is on screen ---------

describe("Characters never moves the owner out of Clip Factory (§45.35 D17)", () => {
  it("a new character saved while Clip Factory is on screen opens once Lamo Stories is back", async () => {
    const create = vi.spyOn(api, "createCharacter");
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    for (const step of ["Next: Face", "Next: Moves", "Next: Sounds", "Next: Name and personality"]) await click(control(step), 50);
    type(field("Name"), "Zed");
    type(field("Personality"), "Brave and kind");
    await click(control("Save character"), 0);
    clipFactoryOnScreen();
    await wait();
    expect(create).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toMatch(/^\/stories\/characters\/[0-9A-Z]{26}$/);
  });

  it("a character deleted while Clip Factory is on screen: the Characters page opens once Lamo Stories is back", async () => {
    await show(<CharactersScreen {...page({ name: "character", characterId: C.dash })} />);
    await click(control("Delete"), 50);
    const sheet = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1)!;
    await click(control("Delete", sheet), 0);
    clipFactoryOnScreen();
    await wait();
    expect(store.characters.some((c) => c.characterId === C.dash)).toBe(false);
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toBe("/stories/characters");
  });

  it("with Lamo Stories on screen, a delete opens Characters at once", async () => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", `/stories/characters/${C.dash}`);
    await show(<CharactersScreen {...page({ name: "character", characterId: C.dash })} />);
    await click(control("Delete"), 50);
    const sheet = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1)!;
    await click(control("Delete", sheet));
    expect(location.pathname).toBe("/stories/characters");
    expect(takeParkedStoriesGo()).toBeNull();
  });
});
