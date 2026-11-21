// Lamo Stories › Chat and References rendered with the mock's chat and references parts and a stand-in for Settings
// › AI (docs/CONTRACTS.md §45.16.7, §45.25, §45.27, §45.28): the model and effort line above the box, its status,
// only the efforts the model offers (an effort it does not offer stops Send with its sentence), "Just for this
// message" sent and not kept, a model with no effort setting said plainly, the answer as it streams, the director's
// button only on a tap, Try again, the last open chat; a reference's line from its task's setting, Analyze with a
// per-run override, the analysis, Use in a video, and an upload in parts. Only storiesApi() is used.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { Effort, ModelInfo, StoriesApi, TaskInfo } from "../src/stories/api/types.ts";
import { forgetActions } from "../src/stories/chat/actions.tsx";
import { forgetVisit } from "../src/stories/chat/device.ts";
import { fileModels, forgetModels } from "../src/stories/chat/models.ts";
import { forgetProjectNames } from "../src/stories/chat/project.ts";
import { forgetUploads } from "../src/stories/chat/references/uploads.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The answers stream and the analyses run for real (in the mock): give a slow machine room.
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ChatScreen } = await import("../src/stories/screens/Chat.tsx");
const { ReferencesScreen } = await import("../src/stories/screens/References.tsx");

const CONV = chat.SEED_IDS.conversations;
const REF = references.SEED_IDS;

let store: MockStore;
let api: StoriesApi;
let models: ModelInfo[];
let tasks: TaskInfo[];
let root: Root;
let host: HTMLElement;
const spies = { sendMessage: vi.fn(), createIdea: vi.fn(), analyzeReference: vi.fn() };

function info(key: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  const m = fileModels().find((x) => x.key === key)!;
  const { line: _line, ...rest } = m;
  return { ...rest, status: "ok", statusLine: "Answered the last call.", checkedAt: "2026-11-21T12:00:00.000Z", ...patch };
}

function makeApi(): StoriesApi {
  store = createStore();
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
  const reject = () => Promise.reject(new Error("Not used here."));
  spies.sendMessage = vi.fn(c.sendMessage);
  spies.createIdea = vi.fn(async () => ({}) as never);
  spies.analyzeReference = vi.fn(r.analyzeReference);
  return {
    ...c,
    ...r,
    sendMessage: spies.sendMessage,
    analyzeReference: spies.analyzeReference,
    createIdea: spies.createIdea,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(models), agents: [], tasks: structuredClone(tasks) }),
    listIdeas: async () => [],
    listStories: async () => ({ stories: [], nextCursor: null }),
    listCharacters: async () => [],
    getStory: reject,
    getCharacter: reject,
  } as unknown as StoriesApi;
}

beforeEach(() => {
  localStorage.clear();
  forgetVisit();
  history.replaceState({}, "", "/stories/chat");
  forgetModels();
  forgetActions();
  forgetProjectNames();
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

const $ = (sel: string) => host.ownerDocument.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(host.ownerDocument.querySelectorAll<HTMLElement>(sel));
const byText = (sel: string, text: string | RegExp) => $$(sel).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) ?? null;
const line = () => $(".st-chat-ai__line")?.textContent ?? "";

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

describe("the chat", () => {
  it("shows the effective model and effort above the box, with what the last call said", async () => {
    await openChat(CONV.winter);
    expect(line()).toBe("Model: Claude Opus 5.5 · Effort: High");
    expect($(".st-chat-ai .st-chat-ai__status")?.textContent).toBe("Working");
    expect(JSON.parse(localStorage.getItem("cf.workspace")!).lastConversationId).toBe(CONV.winter);
  });

  it("shows a model that is not available, with its reason, before anything is sent", async () => {
    models = models.map((m) => (m.key === "sonnet-5-5" ? { ...m, status: "denied", statusLine: "Bedrock says this account can't use it yet." } : m));
    await openChat(CONV.hooks);
    expect(line()).toBe("Model: Claude Sonnet 5.5 · Effort: Medium");
    expect($(".st-chat-ai .st-chat-ai__status")?.textContent).toBe("Not available");
    expect($(".st-chat-ai__note--bad")?.textContent).toBe("Bedrock says this account can't use it yet.");
  });

  it("offers only the efforts the model has, and stops Send when the effort is not offered", async () => {
    models = models.map((m) => (m.key === "haiku-5-5" ? { ...m, efforts: ["low", "medium", "high"] } : m));
    await openChat(CONV.winter);
    await click(byText("button", "Just for this message"));
    const sheet = () => $(".st-chat-sheet")!;
    await click(byText(".st-chat-sheet [role=radio]", /^Maximum/));
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Haiku 5\.5/));
    expect(byText(".st-chat-sheet [role=radio]", /^Maximum/)).toBeNull();
    expect(sheet().textContent).toContain("Claude Haiku 5.5 does not offer Maximum. Pick another level.");
    await click(byText(".st-chat-sheet button", "Done"));
    expect(line()).toBe("Model: Claude Haiku 5.5 · Effort: Maximum");
    await type($("textarea"), "Quick one");
    await click($(".st-chat-send"));
    expect($(".st-chat-send")?.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain("Claude Haiku 5.5 does not offer Maximum. Pick another level.");
    expect(spies.sendMessage).not.toHaveBeenCalled();
  });

  it("says plainly when a model has no effort setting", async () => {
    models = models.map((m) => (m.key === "sonnet-5-5" ? { ...m, efforts: [], defaultEffort: null } : m));
    await openChat(CONV.hooks);
    expect(line()).toBe("Model: Claude Sonnet 5.5 · Effort: Its own level");
    expect(host.textContent).toContain("This model has no effort setting; it runs at its own level.");
  });

  it("sends just-this-message choices with that message only, shows it at once, and streams the answer", async () => {
    await openChat(CONV.winter);
    await click(byText("button", "Just for this message"));
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Fable 5\.1/));
    await click(byText(".st-chat-sheet [role=radio]", /^Low/));
    await click(byText(".st-chat-sheet button", "Done"));
    expect(line()).toBe("Model: Claude Fable 5.1 · Effort: Low");
    await type($("textarea"), "Help me make a new character");
    await click($(".st-chat-send"));
    // At once, before the server answered.
    expect($$(".st-chat-msg--user").at(-1)?.textContent).toContain("Help me make a new character");
    expect(spies.sendMessage).toHaveBeenCalledWith("stories", CONV.winter, { text: "Help me make a new character", override: { model: "fable-5-1", effort: "low" } });
    await until(() => line() === "Model: Claude Opus 5.5 · Effort: High");
    await until(() => !!byText("button", "Save this character"), 8000);
    expect($$(".st-chat-msg--assistant").at(-1)?.querySelector(".st-chat-msg__meta")?.textContent).toBe("Claude Fable 5.1 · Low");
    const conv = store.conversations.find((c) => c.convId === CONV.winter)!;
    expect([conv.model, conv.effort]).toEqual([null, null]);
  });

  it("saves the chat's own setting from the line", async () => {
    await openChat(CONV.winter);
    await click($(".st-chat-ai__part"));
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Sonnet 5\.5/));
    await until(() => !!byText(".st-chat-sheet [role=status]", "Saved for this chat."));
    await click(byText(".st-chat-sheet button", "Done"));
    expect(line()).toBe("Model: Claude Sonnet 5.5 · Effort: High");
    expect(store.conversations.find((c) => c.convId === CONV.winter)!.model).toBe("sonnet-5-5");
  });

  it("runs the director's button only when tapped, and cheers", async () => {
    await openChat(CONV.winter);
    expect(spies.createIdea).not.toHaveBeenCalled();
    await click(byText("button", "Save this idea"));
    await until(() => host.textContent?.includes("Saved the idea!") ?? false);
    expect(spies.createIdea).toHaveBeenCalledTimes(1);
    expect(spies.createIdea.mock.calls[0]![1]).toMatchObject({ title: "Pip and the slippery doorstep", category: "comedy", source: "ai" });
    expect(byText("a", "Open Ideas")?.getAttribute("href")).toBe("/stories/ideas");
  });

  it("shows a failed answer's sentence with Try again, which asks once more", async () => {
    await openChat(CONV.winter);
    store.knobs.chatFail = "The director could not answer this time. Try again.";
    await type($("textarea"), "Ideas about rain");
    await click($(".st-chat-send"));
    await until(() => !!$(".st-chat-msg--assistant.is-failed"), 8000);
    expect($(".st-chat-msg--assistant.is-failed")?.textContent).toContain("The director could not answer this time.");
    await click(byText(".st-chat-msg--assistant.is-failed button", "Try again"));
    expect(spies.sendMessage).toHaveBeenLastCalledWith("stories", CONV.winter, { text: "Ideas about rain" });
    await until(() => !!byText("button", "Save this idea") && $$(".st-chat-msg--assistant").at(-1)?.classList.contains("is-done") === true, 8000);
  });

  it("opens the last open chat when Chat opens, and the list when asked", async () => {
    localStorage.setItem("cf.workspace", JSON.stringify({ workspaceId: "stories", lastConversationId: CONV.hooks }));
    await render(<ChatScreen ws="stories" page={page({ name: "chat" })} />);
    await until(() => location.pathname === `/stories/chat/${CONV.hooks}`);
    await act(async () => root.unmount());
    root = createRoot(host);
    history.replaceState({}, "", "/stories/chat?all=1");
    await render(<ChatScreen ws="stories" page={page({ name: "chat" })} />);
    await until(() => $$(".st-chat-row").length === 2);
    expect(location.pathname).toBe("/stories/chat");
  });
});

describe("references", () => {
  it("shows the analysis of an analyzed video", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.analyzed })} />);
    await until(() => !!$(".st-ref-analysis"));
    for (const h of ["What happens", "The hook", "Pacing", "Shot by shot", "Jokes and acting", "Sound", "Captions", "Borrow these", "Don't copy these"]) expect(byText("h2", h), h).not.toBeNull();
    expect($(".st-ref-with")?.textContent).toBe("Analyzed with Claude Opus 5.5 · High");
  });

  it("analyzes with the task's model shown, and a per-run override that is not kept", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: REF.ready })} />);
    await until(() => !!$(".st-chat-ai__line") && line() === "Model: Claude Fable 5.2 · Effort: High");
    await click(byText("button", "Just for this run"));
    await click(byText(".st-chat-sheet [role=radio]", /^Claude Haiku 5\.5/));
    await click(byText(".st-chat-sheet button", "Done"));
    expect(line()).toBe("Model: Claude Haiku 5.5 · Effort: High");
    await click(byText("button", "Analyze it"));
    expect(spies.analyzeReference).toHaveBeenCalledWith("stories", REF.ready, { model: "haiku-5-5" });
    await until(() => $$(".st-ref-track__step").length === 3);
    await until(() => !!$(".st-ref-analysis"), 8000);
    expect($(".st-ref-with")?.textContent).toBe("Analyzed with Claude Haiku 5.5 · High");
    expect(line()).toBe("Model: Claude Fable 5.2 · Effort: High");
    await click(byText("button", "Use in a video"));
    expect(location.pathname + location.search).toBe(`/stories/production/new?ref=${REF.ready}`);
  }, 20_000);

  it("uploads a video in parts with its progress, then opens its page", async () => {
    history.replaceState({}, "", "/stories/references");
    await render(<ReferencesScreen ws="stories" page={page({ name: "references" })} />);
    await until(() => $$(".st-ref-card").length === 2);
    const input = $('.st-ref-drop input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(2048)], "cat_vs_vacuum.mp4", { type: "video/mp4" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => !!$(".st-ref-upload"));
    await until(() => location.pathname.startsWith("/stories/references/") && location.pathname !== "/stories/references/", 8000);
    const made = store.references.find((r) => r.title === "cat vs vacuum")!;
    expect(made.status).toBe("ready");
    expect(location.pathname).toBe(`/stories/references/${made.refId}`);
  }, 20_000);
});
