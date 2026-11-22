// Lamo Stories studio, round 4 (docs/CONTRACTS.md §45.35): each step's exact model id in a details line (D5); the
// Library's Videos tab with a video's WebM and MOV copies (D10); Production's and the Library's details in plain words
// (helpers by name, one "Made with", the folder, seed and versions behind "Technical details", the safety topic's
// title, D21); previews that show each character's own face; "Write it again" keeping the full idea's own length; the
// timeline chip's short name; and Characters' save and delete never moving the owner out of Clip Factory (D17).
// Rendered with the mock's own parts (fake timers); CharacterPreview is a stand-in that shows the face it was given.
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
    expect(items[0]!.querySelector(".st-s-used__id")?.textContent).toBe("Model ID global.anthropic.claude-opus-5-5 in eu-north-1");
    // An older record says nothing about the id: nothing is guessed from today's settings.
    expect(items[1]!.querySelector(".st-s-used__id")).toBeNull();
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
