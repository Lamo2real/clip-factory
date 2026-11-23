// Lamo Stories › Chat and References, round 3 (docs/CONTRACTS.md §45.34): the chat's model line and picker name the
// provider; "Show earlier messages" pages back with `before`; a failed answer keeps its model and effort line and Try
// again sends the same "just this message" choice; the director's "Analyze this reference video" and "Remake these
// scenes" buttons carry the studio model menu, start from the message's own choice and send it as the run's
// override; a reference video's page draws the analysis job's own steps and reason (after a reload too), keeps its own
// model and effort ("Keep with this video", PATCH { ai }) and hands itself to Production › New with ?ref=. The mock's
// chat and references parts, a stand-in for Settings › AI; nothing leaves the machine.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import bundled from "../../stories/config/models.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { ChatAction, Effort, ModelInfo, StoriesApi, TaskInfo } from "../src/stories/api/types.ts";
import { ActionCard, forgetActions, planFor, taskOf } from "../src/stories/chat/actions.tsx";
import { modelOptions, providerOf } from "../src/stories/chat/ai.tsx";
import { forgetVisit } from "../src/stories/chat/device.ts";
import { fileModels, forgetModels, withLines } from "../src/stories/chat/models.ts";
import { forgetProjectNames } from "../src/stories/chat/project.ts";
import { forgetUploads } from "../src/stories/chat/references/uploads.ts";
import { LISTED_INFO } from "../src/stories/studio/ai.tsx";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ChatScreen } = await import("../src/stories/screens/Chat.tsx");
const { ReferencesScreen } = await import("../src/stories/screens/References.tsx");
const { forgetSentWith, PAGE } = await import("../src/stories/chat/ConversationView.tsx");
const { FILE_REMOVED } = await import("../src/stories/chat/references/RefPage.tsx");

const CONV = chat.SEED_IDS.conversations;
const REF = references.SEED_IDS;

let store: MockStore;
let api: StoriesApi;
let models: ModelInfo[];
let tasks: TaskInfo[];
let root: Root;
let host: HTMLElement;
const spies = {
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  analyzeReference: vi.fn(),
  patchReference: vi.fn(),
  requestChanges: vi.fn(),
};

function info(key: string): ModelInfo {
  const { line: _line, ...rest } = fileModels().find((x) => x.key === key)!;
  return { ...rest, status: "ok", statusLine: "Answered the last call.", checkedAt: "2026-11-21T12:00:00.000Z" };
}

function makeApi(knobs: Record<string, unknown> = {}): StoriesApi {
  store = createStore();
  store.knobs = { ...knobs };
  store.workspaces.push({ workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 });
  chat.seed(store);
  references.seed(store);
  store.knobs.chatThinkMs = 0;
  store.knobs.chatChunkMs = 1;
  store.knobs.refSeconds = 0.2;
  models = ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"].map(info);
  const eff = (model: string, effort: Effort) => ({ model, effort, effortApplied: true, from: "task" as const });
  tasks = [
    { kind: "chat", label: "Chat", agentId: "creative_director", suggestedEffort: "medium", effective: eff("opus-5-5", "high") },
    { kind: "reference_analysis", label: "Reference analysis", agentId: "video_analysis", suggestedEffort: "high", effective: eff("fable-5-2", "high") },
    { kind: "scene_rewrite", label: "Scene rewrite", agentId: "storyboard", suggestedEffort: "high", effective: eff("opus-5-5", "high") },
  ];
  const c = chat.api(store);
  const r = references.api(store);
  spies.sendMessage = vi.fn(c.sendMessage);
  spies.getConversation = vi.fn(c.getConversation);
  spies.analyzeReference = vi.fn(r.analyzeReference);
  spies.patchReference = vi.fn(r.patchReference);
  spies.requestChanges = vi.fn(async () => ({ story: {} as never, job: {} as never }));
  return {
    ...c,
    ...r,
    sendMessage: spies.sendMessage,
    getConversation: spies.getConversation,
    analyzeReference: spies.analyzeReference,
    patchReference: spies.patchReference,
    requestChanges: spies.requestChanges,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(models), agents: [], tasks: structuredClone(tasks) }),
    listIdeas: async () => [],
    listStories: async () => ({ stories: [], nextCursor: null }),
    listCharacters: async () => [],
    getStory: async () => ({ story: { ai: { model: "fable-5-1", effort: null } } as never, job: null, script: null }),
    getCharacter: () => Promise.reject(new Error("Not used here.")),
  } as unknown as StoriesApi;
}

function start(knobs: Record<string, unknown> = {}) {
  api = makeApi(knobs);
  setStoriesApi(api);
}

beforeEach(() => {
  localStorage.clear();
  forgetVisit();
  history.replaceState({}, "", "/stories/chat");
  forgetModels();
  forgetActions();
  forgetProjectNames();
  forgetSentWith();
  start();
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetUploads();
  setStoriesApi(null);
});

async function render(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
}

async function until(check: () => boolean, ms = 6000) {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error("not yet");
    },
    { timeout: ms, interval: 30 },
  );
  await act(async () => undefined);
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const byText = (sel: string, text: string | RegExp) => $$(sel).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) ?? null;
const byLabel = (sel: string, label: RegExp) => $$(sel).find((e) => label.test(e.getAttribute("aria-label") ?? "")) ?? null;

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

async function type(el: HTMLElement | null, value: string) {
  const box = el as HTMLTextAreaElement | HTMLInputElement;
  const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const page = (p: StoriesPage) => p;

async function openChat(convId: string) {
  await render(<ChatScreen ws="stories" page={page({ name: "chat_conv", convId })} />);
  await until(() => !!$(".st-chat-ai__line") && !$(".st-chat-wait"));
}

/** Picks the model and effort for the next message only, in the chat's own sheet. */
async function justThisMessage(model: RegExp, effort?: RegExp) {
  await click(byText("button", "Just for this message"));
  await click(byText(".st-chat-sheet [role=radio]", model));
  if (effort) await click(byText(".st-chat-sheet [role=radio]", effort));
  await click(byText(".st-chat-sheet button", "Done"));
}

/**
 * The exact words for a bundled model, built from stories/config/models.json's own fields (§45.35 D8): "{provider} on
 * {host}" ("Anthropic on Amazon Bedrock"); a list from before D8 names only the host as its provider ("Amazon
 * Bedrock"). So these checks follow the file and still fail when the screen drops the maker or the host.
 */
function bundledWords(key: string): string {
  const m = (bundled.models as { key: string; provider: string; host?: string }[]).find((x) => x.key === key)!;
  return m.host && m.host !== m.provider ? `${m.provider} on ${m.host}` : m.provider;
}

describe("the chat names the provider (§45.34)", () => {
  it("beside the model line and on every model in the picker", async () => {
    await openChat(CONV.winter);
    expect($(".st-chat-ai__provider")?.textContent).toBe(bundledWords("opus-5-5"));
    expect(byLabel(".st-chat-ai__part", new RegExp(`^Model: Claude Opus 5\\.5, ${bundledWords("opus-5-5")}\\.`))).not.toBeNull();
    await click($(".st-chat-ai__part"));
    expect($(".st-chat-sheet")?.textContent).toContain(`${bundledWords("sonnet-5-5")}. Good and fast.`);
    expect(modelOptions(withLines(models), null).every((o) => o.line?.startsWith(`${bundledWords(o.value)}.`))).toBe(true);
    expect(providerOf(fileModels(), "haiku-5-5")).toBe(bundledWords("haiku-5-5"));
    expect(providerOf([], "not-a-model")).toBeNull();
  });
});

describe("long conversations (§45.34)", () => {
  it("Show earlier messages reads the page before the first one shown, and keeps the newer ones", async () => {
    start({ longChat: PAGE + 30 });
    await openChat(CONV.long);
    await until(() => $$(".st-chat-msg").length === PAGE);
    expect($$(".st-chat-msg")[0]!.textContent).toContain("Question number 31");
    const first = store.messages.filter((m) => m.convId === CONV.long)[30]!;
    await click(byText("button", "Show earlier messages"));
    await until(() => $$(".st-chat-msg").length === PAGE + 30);
    expect(spies.getConversation).toHaveBeenCalledWith("stories", CONV.long, { before: first.msgId });
    expect($$(".st-chat-msg")[0]!.textContent).toContain("Question number 1");
    expect($$(".st-chat-msg").at(-1)!.textContent).toContain(`Answer number ${PAGE + 30}`);
    // A page with fewer than a full page has nothing before it.
    expect(byText("button", "Show earlier messages")).toBeNull();
  });

  it("a short chat has no Show earlier messages", async () => {
    await openChat(CONV.winter);
    expect(byText("button", "Show earlier messages")).toBeNull();
  });
});

describe("a failed answer and Try again (§45.34)", () => {
  it("keeps the model and effort line, and Try again sends the same just-this-message choice", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Fable 5\.1/, /^Low/);
    store.knobs.chatFail = "The director could not answer this time. Try again.";
    await type($("textarea"), "Ideas about rain");
    await click($(".st-chat-send"));
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    expect($(".st-chat-msg--assistant.is-failed .st-chat-msg__meta")?.textContent).toBe("Claude Fable 5.1 · Low");
    // The line went back to the chat's own setting after the send.
    expect($(".st-chat-ai__line")?.textContent).toBe("Model: Claude Opus 5.5 · Effort: High");
    await click(byText(".st-chat-msg--assistant.is-failed button", "Try again"));
    expect(spies.sendMessage).toHaveBeenLastCalledWith("stories", CONV.winter, { text: "Ideas about rain", override: { model: "fable-5-1", effort: "low" } });
  });

  it("a choice picked after the failure wins over the one it was sent with", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Fable 5\.1/);
    store.knobs.chatFail = "Claude Fable 5.1 isn't available right now. Pick another model in Clip Factory Stories › Settings › AI, or try again.";
    await type($("textarea"), "Ideas about snow");
    await click($(".st-chat-send"));
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    await justThisMessage(/^Claude Haiku 5\.5/);
    await click(byText(".st-chat-msg--assistant.is-failed button", "Try again"));
    expect(spies.sendMessage).toHaveBeenLastCalledWith("stories", CONV.winter, { text: "Ideas about snow", override: { model: "haiku-5-5" } });
  });

  it("after a reload, Try again still sends the choice the answer was asked with (kept on this device)", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Haiku 5\.5/, /^Low/);
    store.knobs.chatFail = "The director could not answer this time. Try again.";
    await type($("textarea"), "Ideas about fog");
    await click($(".st-chat-send"));
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    // A reload: this visit's memory is gone; the API never sends the choice back.
    act(() => root.unmount());
    forgetSentWith();
    root = createRoot(host);
    await render(<ChatScreen key="again" ws="stories" page={page({ name: "chat_conv", convId: CONV.winter })} />);
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    expect($(".st-chat-msg--assistant.is-failed .st-chat-msg__meta")?.textContent).toBe("Claude Haiku 5.5 · Low");
    expect($(".st-chat-ai__line")?.textContent).toBe("Model: Claude Opus 5.5 · Effort: High");
    await click(byText(".st-chat-msg--assistant.is-failed button", "Try again"));
    expect(spies.sendMessage).toHaveBeenLastCalledWith("stories", CONV.winter, { text: "Ideas about fog", override: { model: "haiku-5-5", effort: "low" } });
  });

  it("the device keeps only the newest choices, and a bad stored one is ignored", async () => {
    const { rememberSentWith, sentWith, SENT_WITH_KEY, SENT_WITH_MAX } = await import("../src/stories/chat/sentWith.ts");
    for (let i = 0; i < SENT_WITH_MAX + 5; i++) rememberSentWith("stories", `m${i}`, { model: "opus-5-5" });
    forgetSentWith();
    expect(sentWith("stories", "m0")).toBeNull();
    expect(sentWith("stories", `m${SENT_WITH_MAX + 4}`)).toEqual({ model: "opus-5-5" });
    expect(sentWith("other", `m${SENT_WITH_MAX + 4}`)).toBeNull();
    localStorage.setItem(SENT_WITH_KEY, JSON.stringify({ "stories/x": { model: "<script>", effort: "huge" }, "stories/y": { effort: "max" } }));
    forgetSentWith();
    expect(sentWith("stories", "x")).toBeNull();
    expect(sentWith("stories", "y")).toEqual({ effort: "max" });
  });
});

describe("the director's buttons carry the model menu (§45.34)", () => {
  it("Analyze this reference video starts from the message's own choice and sends it as the run's override", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Sonnet 5\.5/);
    await type($("textarea"), "Can you analyze my reference video?");
    await click($(".st-chat-send"));
    await until(() => !!byText("button", "Analyze this reference video"), 8000);
    const card = $(".st-chat-action--analyze_reference")!;
    const menu = byLabel(".st-chat-action--analyze_reference button", /^Model and effort for this analysis/)!;
    expect(menu.getAttribute("aria-label")).toMatch(/Claude Sonnet 5\.5/);
    expect(card.textContent).toContain("Just this one");
    await click(byText(".st-chat-action--analyze_reference button", "Analyze this reference video"));
    await until(() => spies.analyzeReference.mock.calls.length === 1);
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready, { model: "sonnet-5-5" });
  });

  it("after a reload, the button on an older answer still starts from that message's own choice", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Sonnet 5\.5/);
    await type($("textarea"), "Can you analyze my reference video?");
    await click($(".st-chat-send"));
    await until(() => !!byText("button", "Analyze this reference video"), 8000);
    act(() => root.unmount());
    forgetSentWith();
    forgetActions();
    root = createRoot(host);
    await render(<ChatScreen key="again" ws="stories" page={page({ name: "chat_conv", convId: CONV.winter })} />);
    await until(() => !!byText("button", "Analyze this reference video"), 8000);
    expect(byLabel(".st-chat-action--analyze_reference button", /^Model and effort for this analysis/)!.getAttribute("aria-label")).toMatch(/Claude Sonnet 5\.5/);
    await click(byText(".st-chat-action--analyze_reference button", "Analyze this reference video"));
    await until(() => spies.analyzeReference.mock.calls.length === 1);
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready, { model: "sonnet-5-5" });
  });

  it("Remake these scenes: the usual is the video's own setting over scene_rewrite; a pick goes with the changes", async () => {
    const action: ChatAction = { kind: "remake_scene", label: "Remake these scenes", payload: { storyId: "01JSTST0000000000000000001", sceneIds: ["s2"] } };
    expect(taskOf(action)).toBe("scene_rewrite");
    await render(<ActionCard ws="stories" id="m1:0" action={action} info={{ ...LISTED_INFO, models, tasks, live: true }} />);
    // The video keeps Claude Fable 5.1 as its own: that is the usual here.
    await until(() => /Fable 5\.1/.test(byLabel("button", /^Model and effort for these scenes/)?.getAttribute("aria-label") ?? ""));
    await click(byLabel("button", /^Model and effort for these scenes/));
    await click(byText(".st-s-sheet label", /^Claude Haiku 5\.5/)!.querySelector("input"));
    await click(byText(".st-s-sheet button", "Done"));
    await click(byText("button", "Remake these scenes"));
    await until(() => spies.requestChanges.mock.calls.length === 1);
    expect(spies.requestChanges).toHaveBeenCalledWith("stories", "01JSTST0000000000000000001", { sceneIds: ["s2"], override: { model: "haiku-5-5" } });
  });

  it("without a pick, the run uses the usual (no override is sent)", async () => {
    const plan = planFor({ kind: "analyze_reference", label: "Analyze", payload: { refId: REF.ready } });
    expect(plan.kind).toBe("call");
    if (plan.kind === "call") await plan.run("stories");
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready);
    expect(taskOf({ kind: "save_idea", label: "", payload: {} })).toBeNull();
  });
});

describe("a reference video's page (§45.34)", () => {
  it("Keep with this video saves the video's own model and effort, and every analysis then uses it", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!byText("button", "Analyze it"));
    await click(byText("button", "Just for this run"));
    await click(byText(".st-chat-sheet [role=radio]", "Keep with this video"));
    expect($(".st-chat-sheet")?.textContent).toContain("Kept with this video. Every analysis of it uses it.");
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Sonnet 5\.5/));
    await until(() => !!byText(".st-chat-sheet [role=status]", "Kept with this video."));
    expect(spies.patchReference).toHaveBeenCalledWith("stories", REF.ready, { ai: { model: "sonnet-5-5", effort: null } });
    await click(byText(".st-chat-sheet button", "Done"));
    expect($(".st-chat-ai__line")?.textContent).toBe("Model: Claude Sonnet 5.5 · Effort: High");
    expect(host.textContent).toContain("Kept with this video (its own setting).");
    expect(store.references.find((r) => r.refId === REF.ready)!.ai).toEqual({ model: "sonnet-5-5", effort: null });
    await click(byText("button", "Analyze it"));
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready, undefined);
    await until(() => !!$(".st-ref-analysis"), 8000);
    expect($(".st-ref-with")?.textContent).toBe("Analyzed with Claude Sonnet 5.5 · High");
  });

  it("an analysis that stopped shows each step and its own reason, after a reload too", async () => {
    store.knobs.refFail = "Claude Fable 5.2 isn't available right now: no access. Pick another model in Clip Factory Stories › Settings › AI, or try again.";
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!byText("button", "Analyze it"));
    await click(byText("button", "Analyze it"));
    await until(() => !!$(".st-ref-failed"), 8000);
    // A fresh visit: the answer's job says why.
    act(() => root.unmount());
    root = createRoot(host);
    await render(<ReferencesScreen key="again" ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!$(".st-ref-failed"));
    expect($(".st-ref-failed")?.textContent).toContain("no access");
    expect($$(".st-ref-track--stopped .st-ref-track__step").map((s) => [s.textContent?.replace(/\s+/g, " ").trim(), s.className.replace("st-ref-track__step ", "")])).toEqual([
      [expect.stringContaining("Look at it"), "is-done"],
      [expect.stringContaining("Listen"), "is-failed"],
      [expect.stringContaining("Write it up"), "is-pending"],
    ]);
    expect(byText("a", "Open Settings › AI") ?? byText("button", /Pick another model/)).not.toBeNull();
  });

  it("Keep with this video: quick taps build on each other, and only the newest answer is shown", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!byText("button", "Analyze it"));
    await click(byText("button", "Just for this run"));
    await click(byText(".st-chat-sheet [role=radio]", "Keep with this video"));
    // The model, then the effort, before the first save has answered.
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Sonnet 5\.5/));
    expect(spies.patchReference.mock.calls.length).toBe(1);
    await click(byText(".st-chat-sheet [role=radio]", /^Low/));
    expect(spies.patchReference.mock.calls.map((c) => c[2])).toEqual([{ ai: { model: "sonnet-5-5", effort: null } }, { ai: { model: "sonnet-5-5", effort: "low" } }]);
    await until(() => !!byText(".st-chat-sheet [role=status]", "Kept with this video."));
    expect(store.references.find((r) => r.refId === REF.ready)!.ai).toEqual({ model: "sonnet-5-5", effort: "low" });
    expect(byText(".st-chat-sheet [role=radio]", /^Claude Sonnet 5\.5/)?.getAttribute("aria-checked")).toBe("true");
    expect(byText(".st-chat-sheet [role=radio]", /^Low/)?.getAttribute("aria-checked")).toBe("true");
  });

  it("Keep with this video: a model that does not offer the kept effort drops it (no refusal)", async () => {
    store.references.find((r) => r.refId === REF.ready)!.ai = { model: null, effort: "max" };
    models = models.map((m) => (m.key === "haiku-5-5" ? { ...m, efforts: [] } : m));
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!byText("button", "Analyze it"));
    await click(byText("button", "Just for this run"));
    await click(byText(".st-chat-sheet [role=radio]", "Keep with this video"));
    // A model that offers it keeps it.
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Sonnet 5\.5/));
    expect(spies.patchReference).toHaveBeenLastCalledWith("stories", REF.ready, { ai: { model: "sonnet-5-5", effort: "max" } });
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Haiku 5\.5/));
    expect(spies.patchReference).toHaveBeenLastCalledWith("stories", REF.ready, { ai: { model: "haiku-5-5", effort: null } });
    await until(() => !!byText(".st-chat-sheet [role=status]", "Kept with this video."));
    expect($(".st-chat-sheet [role=alert]")).toBeNull();
    expect(store.references.find((r) => r.refId === REF.ready)!.ai).toEqual({ model: "haiku-5-5", effort: null });
  });

  it("a video whose file was cleared says so, keeps its study and is not analyzed again", async () => {
    store.knobs.refFileRemoved = [REF.analyzed];
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.analyzed })} />);
    await until(() => !!$(".st-ref-analysis"));
    expect($(".st-ref-player__none")?.textContent).toBe(FILE_REMOVED);
    expect($(".st-ref-player__video")).toBeNull();
    expect($(".st-ref-removed")?.textContent).toBe("The video file is gone, so it cannot be analyzed again.");
    const again = byText("button", "Analyze again")!;
    expect(again.getAttribute("aria-disabled")).toBe("true");
    await click(again);
    expect(spies.analyzeReference).not.toHaveBeenCalled();
    // The study stays usable.
    await click(byText("button", "Use in a video"));
    expect(location.pathname + location.search).toBe(`/stories/production/new?ref=${REF.analyzed}`);
  });

  it("the mock, like the API: a link once uploaded, none after the file is cleared, and Analyze refused", async () => {
    expect((await api.getReference("stories", REF.ready)).reference.url).toMatch(/^data:/);
    expect(references.clearReferenceFile(store, REF.ready)).toBe(true);
    expect(references.clearReferenceFile(store, REF.ready)).toBe(false);
    expect((await api.getReference("stories", REF.ready)).reference.url).toBeUndefined();
    expect((await api.listReferences("stories")).find((r) => r.refId === REF.ready)?.url).toBeUndefined();
    // §45.35 D9: a video cleared before it was ever studied keeps no study, so the API's sentence stops at "removed".
    await expect(api.analyzeReference("stories", REF.ready)).rejects.toMatchObject({ status: 409, message: references.REMOVED_NO_STUDY });
    expect(references.clearReferenceFile(store, REF.analyzed)).toBe(true);
    await expect(api.analyzeReference("stories", REF.analyzed)).rejects.toMatchObject({ status: 409, message: references.FILE_REMOVED });
    const made = await api.createReference("stories", { filename: "a.mp4", contentType: "video/mp4", size: 1000, title: "New one" });
    expect(made.reference.url).toBeUndefined();
  });

  it("Use in a video opens Production › New with it picked (?ref=)", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.analyzed })} />);
    await until(() => !!$(".st-ref-analysis"));
    await click(byText("button", "Use in a video"));
    expect(location.pathname + location.search).toBe(`/stories/production/new?ref=${REF.analyzed}`);
  });
});
