// Lamo Stories › Chat and References, round 5 (the final check's decisions, §45.36): a chat answer shows its exact model
// and Region behind Technical details, as production steps do (E8); the chat's status words are the one set (E17,
// with E12's status lines); an upload gives Production a fresh reference list (E2); a reference whose file was cleared
// never plays the copy on this device and says the D9 sentence (E18); and the mock's pretend study fits the uploaded
// video's own length (E18). The mock's chat and references parts; nothing leaves the machine.
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
import { forgetUploads, localVideo, startUpload, useUploads } from "../src/stories/chat/references/uploads.ts";
import { takeParkedStoriesGo } from "../src/stories/pane.tsx";
import { referencesCache } from "../src/stories/studio/hooks.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ChatScreen } = await import("../src/stories/screens/Chat.tsx");
const { ReferencesScreen } = await import("../src/stories/screens/References.tsx");
const { forgetSentWith } = await import("../src/stories/chat/ConversationView.tsx");
const { FILE_REMOVED_NO_STUDY } = await import("../src/stories/chat/references/RefPage.tsx");

const CONV = chat.SEED_IDS.conversations;

let store: MockStore;
let api: StoriesApi;
/** Models Bedrock refused on their last call (GET …/ai says "denied" for them). */
let denied: string[] = [];
let root: Root;
let host: HTMLElement;

function info(key: string): ModelInfo {
  const { line: _line, ...rest } = fileModels().find((x) => x.key === key)!;
  return { ...rest, provider: "Anthropic", host: "Amazon Bedrock", status: "ok", statusLine: "Answered the last call.", checkedAt: "2026-11-22T08:00:00.000Z" } as ModelInfo;
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
  const models = () =>
    ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"].map(info).map((m) => (denied.includes(m.key) ? { ...m, status: "denied" as const, statusLine: `Amazon Bedrock said this account has no access to ${m.label}.` } : m));
  const eff = (model: string, effort: Effort) => ({ model, effort, effortApplied: true, from: "task" as const });
  const tasks: TaskInfo[] = [
    { kind: "chat", label: "Chat", agentId: "creative_director", suggestedEffort: "medium", effective: eff("opus-5-5", "high") },
    { kind: "reference_analysis", label: "Reference analysis", agentId: "video_analysis", suggestedEffort: "high", effective: eff("fable-5-2", "high") },
  ];
  return {
    ...chat.api(store),
    ...references.api(store),
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: models(), agents: [], tasks: structuredClone(tasks) }),
    listIdeas: async () => [],
    listStories: async () => ({ stories: [], nextCursor: null }),
    listCharacters: async () => [],
  } as unknown as StoriesApi;
}

beforeEach(() => {
  denied = [];
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

async function until(check: () => boolean, ms = 8000) {
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
const page = (p: StoriesPage) => p;

/**
 * jsdom reads no video: a <video> given a source says it is `seconds` long, as a browser would after its metadata
 * (the upload reads the length this way); and object URLs are pretend ones.
 */
function browserReadsVideos(seconds: number): () => void {
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
  const duration = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = () => `blob:local-${++n}`;
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => seconds });
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    configurable: true,
    get: src.get,
    set(this: HTMLMediaElement, v: string) {
      src.set!.call(this, v);
      setTimeout(() => this.onloadedmetadata?.(new Event("loadedmetadata")), 0);
    },
  });
  return () => {
    Object.defineProperty(HTMLMediaElement.prototype, "src", src);
    if (duration) Object.defineProperty(HTMLMediaElement.prototype, "duration", duration);
    else delete (HTMLMediaElement.prototype as { duration?: number }).duration;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  };
}

/** Uploads one video through the real upload code and waits until it is done; answers its reference id. */
async function upload(name: string): Promise<string> {
  const file = new File([new Uint8Array(2048)], name, { type: "video/mp4" });
  const key = startUpload("stories", file);
  let refId: string | null = null;
  function Watch() {
    const u = useUploads("stories").find((x) => x.key === key);
    if (u?.status === "done") refId = u.refId;
    return null;
  }
  await render(<Watch />);
  await until(() => refId !== null);
  return refId!;
}

// ---------- E8: a chat answer's exact model ----------

describe("a chat answer shows its exact model behind Technical details (§45.36 E8)", () => {
  it("under its model line, folded, the same line production steps show", async () => {
    await render(<ChatScreen ws="stories" page={page({ name: "chat_conv", convId: CONV.winter })} />);
    await until(() => $$(".st-chat-msg--assistant .st-chat-msg__meta").length > 0);
    const answer = $$(".st-chat-msg--assistant").find((m) => m.querySelector(".st-chat-msg__meta"))!;
    const fold = answer.querySelector<HTMLDetailsElement>(".st-chat-msg__tech")!;
    expect(fold.tagName).toBe("DETAILS");
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")?.textContent).toBe("Technical details");
    expect(fold.textContent).toMatch(/Model ID \S*anthropic\.claude-\S+ in eu-north-1/);
    // The first line stays plain words: the model's name and effort.
    expect(answer.querySelector(".st-chat-msg__meta")?.textContent).not.toContain("Model ID");
  });
});

// ---------- E2 and E18: uploads ----------

describe("an upload (§45.36 E2, E18)", () => {
  it("gives Production a fresh reference list, and the mock's study fits the video's own length", async () => {
    const restore = browserReadsVideos(12);
    try {
      const before = referencesCache();
      const refId = await upload("dog_chases_the_snowball.mp4");
      expect(referencesCache()).not.toBe(before);
      expect(localVideo(refId)).toMatch(/^blob:local-/);
      // The study: as long as the video, never the canned 0:42.
      await api.analyzeReference("stories", refId);
      await new Promise((r) => setTimeout(r, 400));
      const { reference, analysis } = await api.getReference("stories", refId);
      expect(reference.durationSec).toBe(12);
      expect(analysis?.shots.at(-1)?.end).toBe(12);
      expect(Math.max(...(analysis?.shots ?? []).map((s) => s.end))).toBeLessThanOrEqual(12);
    } finally {
      restore();
    }
  });

  it("the knob sets the length when the device could not read it; else a believable one", async () => {
    store.knobs.refUploadSeconds = 20;
    const made = await api.createReference("stories", { filename: "a.mp4", contentType: "video/mp4", size: 1000, title: "A" });
    await api.completeReference("stories", made.reference.refId, [{ partNumber: 1, etag: '"x"' }]);
    await api.analyzeReference("stories", made.reference.refId);
    await new Promise((r) => setTimeout(r, 400));
    expect((await api.getReference("stories", made.reference.refId)).reference.durationSec).toBe(20);
  });

  it("a cleared reference never plays the copy on this device; the page says the D9 sentence", async () => {
    const restore = browserReadsVideos(12);
    try {
      const refId = await upload("frosty_path.mp4");
      expect(localVideo(refId)).not.toBeNull();
      expect(references.clearReferenceFile(store, refId)).toBe(true);
      history.replaceState({}, "", `/stories/references/${refId}`);
      await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId })} />);
      await until(() => !!$(".st-ref-player"));
      expect($("video.st-ref-player__video")).toBeNull();
      expect($(".st-ref-player__none")?.textContent).toBe(FILE_REMOVED_NO_STUDY);
    } finally {
      restore();
    }
  });
});

// ---------- E12: the chat and the reference page never pre-pick a model that cannot be used ----------

async function typeAndSend(words: string) {
  const box = $("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, words);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    $(".st-chat-send")!.click();
  });
}

describe("a usual model the studio knows cannot be used is skipped in the chat and on a reference (§45.36 E12)", () => {
  it("the chat's line shows the stand-in, and the message is sent with it (never kept)", async () => {
    denied = ["opus-5-5"];
    const send = vi.spyOn(api, "sendMessage");
    await render(<ChatScreen ws="stories" page={page({ name: "chat_conv", convId: CONV.winter })} />);
    await until(() => /Fable 5\.2/.test($(".st-chat-ai__line")?.textContent ?? ""));
    expect($(".st-chat-ai")?.textContent).toContain("Claude Opus 5.5 has no access right now, so this chat uses Claude Fable 5.2.");
    await typeAndSend("A winter idea, please");
    await until(() => send.mock.calls.length > 0);
    expect(send.mock.calls[0]![2]).toMatchObject({ text: "A winter idea, please", override: { model: "fable-5-2" } });
  });

  it("a model this chat keeps on purpose stays, with its status, and is sent as it is", async () => {
    denied = ["sonnet-5-5"];
    const send = vi.spyOn(api, "sendMessage");
    await render(<ChatScreen ws="stories" page={page({ name: "chat_conv", convId: CONV.hooks })} />);
    await until(() => $(".st-chat-ai__status")?.textContent === "No access");
    expect($(".st-chat-ai__line")?.textContent).toContain("Claude Sonnet 5.5");
    expect($(".st-chat-ai")?.textContent).not.toContain("so this chat uses");
    await typeAndSend("More hooks");
    await until(() => send.mock.calls.length > 0);
    expect(send.mock.calls[0]![2].override).toBeUndefined();
  });

  it("Analyze sends the stand-in for the analysis' usual, and the page says why", async () => {
    denied = ["fable-5-2"];
    const analyze = vi.spyOn(api, "analyzeReference");
    const refId = references.SEED_IDS.ready;
    history.replaceState({}, "", `/stories/references/${refId}`);
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId })} />);
    await until(() => /Opus 5\.5/.test($(".st-chat-ai__line")?.textContent ?? ""));
    expect($(".st-ref-card2")?.textContent).toContain("Claude Fable 5.2 has no access right now, so this analysis uses Claude Opus 5.5.");
    await act(async () => {
      $$("button").find((b) => b.textContent?.trim() === "Analyze it")!.click();
    });
    await until(() => analyze.mock.calls.length > 0);
    expect(analyze.mock.calls[0]![2]).toEqual({ model: "opus-5-5" });
  });
});

// ---------- E8: the reference analysis is a model record too ----------

describe("a reference analysis shows its exact model behind Technical details (§45.36 E8)", () => {
  it("under Analyzed with, folded, the same Model ID line", async () => {
    const refId = references.SEED_IDS.ready;
    await api.analyzeReference("stories", refId);
    await new Promise((r) => setTimeout(r, 600));
    history.replaceState({}, "", `/stories/references/${refId}`);
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId })} />);
    await until(() => !!$(".st-ref-with"));
    const fold = document.querySelector<HTMLDetailsElement>(".st-ref-tech");
    expect(fold?.tagName).toBe("DETAILS");
    expect(fold?.open).toBe(false);
    expect(fold?.textContent).toMatch(/Model ID \S*anthropic\.claude-\S+ in eu-north-1/);
    expect($(".st-ref-with")?.textContent).not.toContain("Model ID");
  });
});
