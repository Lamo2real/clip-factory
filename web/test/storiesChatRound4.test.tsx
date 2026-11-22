// Lamo Stories › Chat and References, round 4 (docs/CONTRACTS.md §45.35): an answer's own one-time choice
// (`Message.requested`, D4) wins over this device's copy, so Try again and the director's buttons start from it on
// every device; the chat line and pickers say "{provider} on {host}" (D8); a reference video whose file was cleared
// says whether its study stays (`fileRemoved`, `studyKept`, D9), and the mock's storage cleanup clears reference videos
// as keepReferences says; a page change that comes after a wait (New chat, Talk about it in Chat, a chat button that
// opens Production) never moves the owner out of Clip Factory (storiesGoLater, D17). The mock's chat and references
// parts; nothing leaves the machine.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { ChatAction, Effort, Message, ModelInfo, ReferenceVideo, StoriesApi, StoriesConfig, TaskInfo } from "../src/stories/api/types.ts";
import { ActionCard, forgetActions } from "../src/stories/chat/actions.tsx";
import { AiLine, modelOptions, providerOf } from "../src/stories/chat/ai.tsx";
import { forgetVisit } from "../src/stories/chat/device.ts";
import { fileModels, forgetModels, providerWords, withLines } from "../src/stories/chat/models.ts";
import { forgetProjectNames } from "../src/stories/chat/project.ts";
import { forgetUploads } from "../src/stories/chat/references/uploads.ts";
import { askedWith, rememberSentWith, SENT_WITH_KEY } from "../src/stories/chat/sentWith.ts";
import { AppPanes, takeParkedStoriesGo } from "../src/stories/pane.tsx";
import { LISTED_INFO, ModelMenu } from "../src/stories/studio/ai.tsx";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ChatScreen } = await import("../src/stories/screens/Chat.tsx");
const { ReferencesScreen } = await import("../src/stories/screens/References.tsx");
const { forgetSentWith } = await import("../src/stories/chat/ConversationView.tsx");
const { FILE_REMOVED, FILE_REMOVED_NO_STUDY, removedState } = await import("../src/stories/chat/references/RefPage.tsx");

const CONV = chat.SEED_IDS.conversations;
const REF = references.SEED_IDS;

let store: MockStore;
let api: StoriesApi;
let models: ModelInfo[];
let tasks: TaskInfo[];
let root: Root;
let host: HTMLElement;
const spies = { sendMessage: vi.fn(), analyzeReference: vi.fn() };

/** A model as Settings › AI lists it after D8 (ModelInfo.host, §45.35): who makes it and who runs it. */
type HostedModel = ModelInfo & { host?: string };
function info(key: string, who: { provider: string; host?: string } = { provider: "Anthropic", host: "Amazon Bedrock" }): HostedModel {
  const { line: _line, ...rest } = fileModels().find((x) => x.key === key)!;
  const out: HostedModel = { ...rest, provider: who.provider, status: "ok", statusLine: "Answered the last call.", checkedAt: "2026-11-22T08:00:00.000Z" };
  delete out.host;
  if (who.host) out.host = who.host;
  return out;
}

function makeApi(): StoriesApi {
  store = createStore();
  store.knobs = {};
  store.workspaces.push({ workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 });
  chat.seed(store);
  references.seed(store);
  store.knobs.chatThinkMs = 0;
  store.knobs.chatChunkMs = 1;
  store.knobs.refSeconds = 0.2;
  models = ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"].map((k) => info(k));
  const eff = (model: string, effort: Effort) => ({ model, effort, effortApplied: true, from: "task" as const });
  tasks = [
    { kind: "chat", label: "Chat", agentId: "creative_director", suggestedEffort: "medium", effective: eff("opus-5-5", "high") },
    { kind: "reference_analysis", label: "Reference analysis", agentId: "video_analysis", suggestedEffort: "high", effective: eff("fable-5-2", "high") },
  ];
  const c = chat.api(store);
  const r = references.api(store);
  spies.sendMessage = vi.fn(c.sendMessage);
  spies.analyzeReference = vi.fn(r.analyzeReference);
  return {
    ...c,
    ...r,
    sendMessage: spies.sendMessage,
    analyzeReference: spies.analyzeReference,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(models), agents: [], tasks: structuredClone(tasks) }),
    listIdeas: async () => [],
    createIdea: async (_ws: string, idea: { title: string }) => ({ ...idea, ideaId: "01JSTDE0000000000000000099" }),
    listStories: async () => ({ stories: [], nextCursor: null }),
    listCharacters: async () => [],
    getStory: async () => ({ story: { ai: { model: null, effort: null } } as never, job: null, script: null }),
  } as unknown as StoriesApi;
}

beforeEach(() => {
  localStorage.clear();
  forgetVisit();
  history.replaceState({}, "", "/stories/chat");
  forgetModels();
  forgetActions();
  forgetProjectNames();
  forgetSentWith();
  takeParkedStoriesGo();
  api = makeApi();
  setStoriesApi(api);
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
  takeParkedStoriesGo();
  localStorage.clear();
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
  const box = el as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const page = (p: StoriesPage) => p;

async function openChat(convId: string) {
  await render(<ChatScreen ws="stories" page={page({ name: "chat_conv", convId })} />);
  await until(() => !!$(".st-chat-ai__line") && !$(".st-chat-wait"));
}

async function justThisMessage(model: RegExp) {
  await click(byText("button", "Just for this message"));
  await click(byText(".st-chat-sheet [role=radio]", model));
  await click(byText(".st-chat-sheet button", "Done"));
}

/** Another device: this visit's memory and this device's copy of every choice are gone; the page opens again. */
async function anotherDevice(convId: string) {
  act(() => root.unmount());
  forgetSentWith();
  localStorage.removeItem(SENT_WITH_KEY);
  forgetActions();
  root = createRoot(host);
  await render(<ChatScreen key="again" ws="stories" page={page({ name: "chat_conv", convId })} />);
}

/** A promise the test lets go when it wants (an answer that comes while Clip Factory is on screen). */
function gate() {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Lamo Stories is switched on (this device's preview) and the owner has gone to Clip Factory's Library. */
function clipFactoryOnScreen() {
  localStorage.setItem("cf.storiesPreview", "1");
  history.replaceState({}, "", "/library");
}

// ---------- D4: the answer's own choice ----------

describe("an answer's own one-time choice comes from the API (§45.35 D4)", () => {
  it("on another device, Try again still sends the choice the answer was asked with", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Haiku 5\.5/);
    store.knobs.chatFail = "The director could not answer this time. Try again.";
    await type($("textarea"), "Ideas about frost");
    await click($(".st-chat-send"));
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    const failed = store.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(failed.requested).toEqual({ model: "haiku-5-5" });
    await anotherDevice(CONV.winter);
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    expect(localStorage.getItem(SENT_WITH_KEY)).toBeNull();
    await click(byText(".st-chat-msg--assistant.is-failed button", "Try again"));
    expect(spies.sendMessage).toHaveBeenLastCalledWith("stories", CONV.winter, { text: "Ideas about frost", override: { model: "haiku-5-5" } });
  });

  it("on another device, the director's button on that answer starts from the answer's own choice", async () => {
    await openChat(CONV.winter);
    await justThisMessage(/^Claude Sonnet 5\.5/);
    await type($("textarea"), "Can you analyze my reference video?");
    await click($(".st-chat-send"));
    await until(() => !!byText("button", "Analyze this reference video"), 8000);
    await anotherDevice(CONV.winter);
    await until(() => !!byText("button", "Analyze this reference video"), 8000);
    expect(byLabel(".st-chat-action--analyze_reference button", /^Model and effort for this analysis/)!.getAttribute("aria-label")).toMatch(/Claude Sonnet 5\.5/);
    await click(byText(".st-chat-action--analyze_reference button", "Analyze this reference video"));
    await until(() => spies.analyzeReference.mock.calls.length === 1);
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready, { model: "sonnet-5-5" });
  });

  it("the API's choice wins over this device's copy; an API older than D4 still uses the device's", () => {
    rememberSentWith("stories", "m1", { model: "sonnet-5-5" });
    const answer = (requested?: Message["requested"]): Pick<Message, "msgId" | "requested"> => (requested === undefined ? { msgId: "m1" } : { msgId: "m1", requested });
    expect(askedWith("stories", answer({ model: "haiku-5-5", effort: "low" }))).toEqual({ model: "haiku-5-5", effort: "low" });
    // null from the API: the answer had no one-time choice, whatever this device kept.
    expect(askedWith("stories", answer(null))).toBeNull();
    // No key at all (an older API): this device's copy.
    expect(askedWith("stories", answer())).toEqual({ model: "sonnet-5-5" });
    // Something that is not a choice is never sent.
    expect(askedWith("stories", answer({ model: "<script>" } as never))).toBeNull();
  });

  it("the mock, like the API: each answer carries its choice (or null) and exactly what was called", async () => {
    const sent = await api.sendMessage("stories", CONV.winter, { text: "Hi", override: { effort: "low" } });
    expect(sent.assistant.requested).toEqual({ effort: "low" });
    expect(sent.assistant.modelId).toMatch(/anthropic\.claude-opus-5-5/);
    expect(sent.assistant.region).toBe("eu-north-1");
    expect(sent.user.requested).toBeUndefined();
    const plain = await api.sendMessage("stories", CONV.hooks, { text: "Hi again" });
    expect(plain.assistant.requested).toBeNull();
  });
});

// ---------- D8: who makes it and who runs it ----------

describe("the chat says who makes a model and who runs it (§45.35 D8)", () => {
  it("providerWords: '{provider} on {host}', Amazon Bedrock when no host is given, never the host twice", () => {
    expect(providerWords({ provider: "Anthropic", host: "Amazon Bedrock" })).toBe("Anthropic on Amazon Bedrock");
    expect(providerWords({ provider: "Meta" })).toBe("Meta on Amazon Bedrock");
    expect(providerWords({ provider: "Amazon Bedrock" })).toBe("Amazon Bedrock");
    expect(providerWords({ provider: "Amazon", host: "Amazon Bedrock" })).toBe("Amazon on Amazon Bedrock");
    expect(providerWords({ provider: "" })).toBeNull();
    expect(providerWords(null)).toBeNull();
  });

  it("the model line, its spoken name and every model in the picker", async () => {
    models.push({ ...info("haiku-5-5", { provider: "Meta" }), key: "custom-llama", label: "Llama 5", custom: true, modelId: "meta.llama5-v1:0" });
    await openChat(CONV.winter);
    expect($(".st-chat-ai__provider")?.textContent).toBe("Anthropic on Amazon Bedrock");
    expect(byLabel(".st-chat-ai__part", /^Model: Claude Opus 5\.5, Anthropic on Amazon Bedrock\. Change the model$/)).not.toBeNull();
    await click($(".st-chat-ai__part"));
    expect($(".st-chat-sheet")?.textContent).toContain("Anthropic on Amazon Bedrock. Good and fast.");
    expect($(".st-chat-sheet")?.textContent).toContain("Meta on Amazon Bedrock.");
    const lines = modelOptions(withLines(models), null).map((o) => o.line ?? "");
    expect(lines.slice(0, 5).every((l) => l.startsWith("Anthropic on Amazon Bedrock."))).toBe(true);
    expect(lines[5]).toMatch(/^Meta on Amazon Bedrock\./);
    expect(providerOf(withLines(models), "custom-llama")).toBe("Meta on Amazon Bedrock");
  });

  it("the AI line on its own and the studio's model menu use the same words", async () => {
    const views = withLines(models);
    await render(
      <>
        <AiLine models={views} current={{ model: "sonnet-5-5", effort: "high" }} override={null} onceLabel="Just for this run" onPick={() => undefined} onClearOverride={() => undefined} clearLabel="Use the usual setting" />
        <ModelMenu info={{ ...LISTED_INFO, models, tasks, live: true }} usual={{ model: "opus-5-5", effort: "high", effortApplied: true, from: "default" }} value={null} onChange={() => undefined} />
      </>,
    );
    expect($(".st-chat-ai__provider")?.textContent).toBe("Anthropic on Amazon Bedrock");
    await click(byLabel("button", /^Model and effort for this one/));
    expect(byText(".st-s-sheet .st-s-pick__line", /^Anthropic on Amazon Bedrock\. Ready\.$/)).not.toBeNull();
  });
});

// ---------- D9: a cleared reference video ----------

describe("a reference video whose file was cleared (§45.35 D9)", () => {
  const base: Pick<ReferenceVideo, "status" | "url" | "fileRemoved" | "studyKept"> = { status: "analyzed" };

  it("says its study stays only when it does", () => {
    expect(removedState({ ...base, fileRemoved: true, studyKept: true }, null)).toMatchObject({ removed: true, line: FILE_REMOVED });
    expect(removedState({ ...base, fileRemoved: true, studyKept: false }, null)).toMatchObject({ removed: true, studyKept: false, line: FILE_REMOVED_NO_STUDY });
    expect(FILE_REMOVED_NO_STUDY).toBe("The video was removed to save space.");
    expect(removedState({ ...base, fileRemoved: false, url: "https://x" }, null)).toEqual({ removed: false, studyKept: false, line: null });
    // An API older than D9: past uploading without a link, and the study the page has.
    expect(removedState({ status: "ready" }, null).line).toBe(FILE_REMOVED_NO_STUDY);
    expect(removedState({ status: "analyzed" }, references.pretendAnalysis("x", 10)).line).toBe(FILE_REMOVED);
    expect(removedState({ status: "uploading" }, null).removed).toBe(false);
  });

  it("a video cleared before it was ever studied says only that it was removed", async () => {
    expect(references.clearReferenceFile(store, REF.ready)).toBe(true);
    const r = await api.getReference("stories", REF.ready);
    expect(r.reference).toMatchObject({ fileRemoved: true, studyKept: false, bytes: 0 });
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!$(".st-ref-player__none"));
    expect($(".st-ref-player__none")?.textContent).toBe("The video was removed to save space.");
    expect(host.textContent).not.toContain("Its study stays.");
    expect($(".st-ref-removed")?.textContent).toBe("The video file is gone, so it cannot be analyzed.");
  });

  it("a studied video keeps its study, and its page says so", async () => {
    expect(references.clearReferenceFile(store, REF.analyzed)).toBe(true);
    expect((await api.getReference("stories", REF.analyzed)).reference).toMatchObject({ fileRemoved: true, studyKept: true });
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.analyzed })} />);
    await until(() => !!$(".st-ref-analysis"));
    expect($(".st-ref-player__none")?.textContent).toBe(FILE_REMOVED);
  });

  it("the mock's Clear now clears reference videos as keepReferences says", async () => {
    const full = mockStoriesApi();
    const ws = (await full.listWorkspaces()).find((w) => w.workspaceType === "stories")!;
    const refs = await full.listReferences(ws.workspaceId);
    const studied = refs.find((r) => r.status === "analyzed")!;
    const notStudied = refs.find((r) => r.status === "ready")!;
    const conf = ws.configuration as StoriesConfig;
    const saved = await full.patchWorkspace(ws.workspaceId, { configuration: { production: { ...conf.production, keepReferences: "study_only" } }, version: ws.version });
    expect((saved.configuration as StoriesConfig).production.keepReferences).toBe("study_only");
    const r = await full.storageCleanup(ws.workspaceId);
    expect(r.removed.files).toBeGreaterThan(0);
    const after = await full.listReferences(ws.workspaceId);
    expect(after.find((x) => x.refId === studied.refId)).toMatchObject({ fileRemoved: true, studyKept: true, bytes: 0 });
    expect(after.find((x) => x.refId === studied.refId)?.url).toBeUndefined();
    // study_only keeps every video that has no study yet.
    expect(after.find((x) => x.refId === notStudied.refId)).toMatchObject({ fileRemoved: false });
  });

  it("the 30-day rule clears old videos, studied or not", () => {
    const old = store.references.find((r) => r.refId === REF.ready)!;
    old.createdAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const bytes = old.bytes;
    expect(references.clearByKeepSetting(store, "stories", "days_30")).toEqual({ files: 1, bytes });
    expect(references.clearByKeepSetting(store, "stories", "all")).toEqual({ files: 0, bytes: 0 });
  });
});

// ---------- D17: no page change of its own while Clip Factory is on screen ----------

describe("a page change after a wait waits for Lamo Stories to be on screen (§45.35 D17)", () => {
  it("New chat: the answer that comes while Clip Factory is on screen does not move the owner", async () => {
    const g = gate();
    const real = api.createConversation.bind(api);
    api.createConversation = async (...a) => {
      await g.wait;
      return real(...a);
    };
    // Both apps in their panes, as the shell keeps them: Lamo Stories' chat on screen, then Clip Factory.
    const both = (on: "clips" | "stories") => <AppPanes on={on} clips={<p>Clip Factory's Library</p>} stories={<ChatScreen ws="stories" page={page({ name: "chat" })} />} />;
    await render(both("stories"));
    await until(() => !!byText("button", "New chat"));
    await click(byText("button", "New chat"));
    clipFactoryOnScreen();
    await render(both("clips"));
    g.open();
    await until(() => store.conversations.length === 3);
    await act(async () => undefined);
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toMatch(/^\/stories\/chat\/[0-9A-Z]{26}$/);
  });

  it("Talk about it in Chat on a reference video", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.analyzed })} />);
    await until(() => !!$(".st-ref-analysis"));
    const g = gate();
    const real = api.createConversation.bind(api);
    api.createConversation = async (...a) => {
      await g.wait;
      return real(...a);
    };
    await click(byText("button", "Talk about it in Chat"));
    clipFactoryOnScreen();
    g.open();
    await until(() => store.conversations.length === 3);
    await act(async () => undefined);
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toMatch(/^\/stories\/chat\/[0-9A-Z]{26}$/);
  });

  it("a chat button that opens Production after saving the idea", async () => {
    const g = gate();
    const made = vi.fn();
    api.createIdea = async (_ws, idea) => {
      await g.wait;
      made();
      return { ...idea, ideaId: "01JSTDE0000000000000000099" } as never;
    };
    const action: ChatAction = { kind: "make_video", label: "Make the video", payload: { story: { brief: { title: "Frosty steps", logline: "Pip crosses a frosty path.", category: "comedy" }, characterIds: [] } } };
    await render(<ActionCard ws="stories" id="m9:0" action={action} />);
    await click(byText("button", "Make the video"));
    clipFactoryOnScreen();
    g.open();
    await until(() => made.mock.calls.length === 1 && !!$(".st-chat-action__done"));
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toBe("/stories/production/new?idea=01JSTDE0000000000000000099");
  });

  it("a reference video upload that finishes while Clip Factory is on screen opens its page once Lamo Stories is back", async () => {
    history.replaceState({}, "", "/stories/references");
    const both = (on: "clips" | "stories") => <AppPanes on={on} clips={<p>Clip Factory's Library</p>} stories={<ReferencesScreen ws="stories" page={page({ name: "references" })} />} />;
    await render(both("stories"));
    await until(() => $$(".st-ref-card").length === 2);
    const input = $('.st-ref-drop input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array(2048)], "frosty_path.mp4", { type: "video/mp4" })], configurable: true });
    const g = gate();
    const finish = api.completeReference.bind(api);
    api.completeReference = async (...a) => {
      await g.wait;
      return finish(...a);
    };
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => store.references.some((r) => r.title === "frosty path"));
    clipFactoryOnScreen();
    await render(both("clips"));
    g.open();
    const made = store.references.find((r) => r.title === "frosty path")!;
    await until(() => made.status === "ready", 8000);
    await act(async () => undefined);
    expect(location.pathname).toBe("/library");
    expect(takeParkedStoriesGo()).toBe(`/stories/references/${made.refId}`);
  });

  it("with Lamo Stories on screen the same tap opens the page at once", async () => {
    localStorage.setItem("cf.storiesPreview", "1");
    await render(<ChatScreen ws="stories" page={page({ name: "chat" })} />);
    await until(() => !!byText("button", "New chat"));
    await click(byText("button", "New chat"));
    await until(() => /^\/stories\/chat\/[0-9A-Z]{26}$/.test(location.pathname));
    expect(takeParkedStoriesGo()).toBeNull();
  });
});
