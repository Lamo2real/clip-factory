// Clips Funded's drops (docs/CONTRACTS.md §45.40.2): the director chat takes pictures
// dropped anywhere on its page (PNG, JPG or WebP up to 5 MB, at most 4 in one message), Settings › Look takes one
// picture only while Picture is chosen, a skill's upload button takes a skill file (and nothing while it is off), and
// the open Design with AI panel takes one picture. Each refusal says why in one short line. Only storiesApi() is used.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";

// The bytes never leave: every presigned PUT is done at once.
vi.mock("../src/api/upload.ts", async (load) => ({ ...(await load<typeof import("../src/api/upload.ts")>()), putFile: () => Promise.resolve() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { forgetLoaded } = await import("../src/lib/hooks.ts");
const { ConversationView } = await import("../src/stories/chat/ConversationView.tsx");
const { forgetVisit } = await import("../src/stories/chat/device.ts");
const { forgetModels } = await import("../src/stories/chat/models.ts");
const { setStoriesLook, setStoriesPicture, storiesLook } = await import("../src/stories/look.ts");
const { LookSection } = await import("../src/stories/settings/LookSection.tsx");
const { SkillsSection } = await import("../src/stories/settings/SkillsSection.tsx");
const { DesignPanel } = await import("../src/stories/studio/Design.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");

const CONV = chat.SEED_IDS.conversations;

let store: MockStore;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  forgetVisit();
  forgetModels();
  forgetLoaded();
  history.replaceState({}, "", "/stories/chat");
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setStoriesApi(null);
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function render(el: ReactElement) {
  await act(async () => {
    root.render(el);
  });
}

async function until(check: () => boolean, ms = 6000) {
  await vi.waitFor(
    () => {
      if (!check()) throw new Error("not yet");
    },
    { timeout: ms, interval: 20 },
  );
  await act(async () => undefined);
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

const png = (name = "look.png", size = 256) => new File([new Uint8Array(size)], name, { type: "image/png" });
const pdf = () => new File([new Uint8Array(64)], "plan.pdf", { type: "application/pdf" });
const md = () => new File(["---\nname: Falls\n---\nFall over."], "falls.md", { type: "text/markdown" });

/** What a drag of these files carries (jsdom has no DataTransfer: the fields the hook reads). */
function carrying(files: File[]) {
  return {
    types: ["Files"],
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    getData: () => "",
    dropEffect: "none",
    effectAllowed: "all",
  };
}

function dragEvent(type: string, files: File[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  e.dataTransfer = carrying(files);
  return e;
}

/** A whole drag: in, over, then the drop, on `target`. Answers the drop event. */
async function dropOn(target: Element, files: File[]): Promise<Event> {
  await act(async () => {
    target.dispatchEvent(dragEvent("dragenter", files));
    target.dispatchEvent(dragEvent("dragover", files));
  });
  const drop = dragEvent("drop", files);
  await act(async () => {
    target.dispatchEvent(drop);
  });
  await act(async () => undefined);
  return drop;
}

/** The refusal is read out: some status region on the page says exactly this line. */
const said = (line: string) => $$('[role="status"]').some((el) => el.textContent?.trim() === line);

// ---------- The director chat ----------

function chatApi(): { api: StoriesApi; attach: ReturnType<typeof vi.fn> } {
  store = createStore();
  store.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 });
  chat.seed(store);
  store.knobs.chatThinkMs = 0;
  store.knobs.chatChunkMs = 1;
  const c = chat.api(store);
  const attach = vi.fn(c.chatAttachment);
  const api = {
    ...c,
    chatAttachment: attach,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: [], agents: [], tasks: [] }),
    listIdeas: async () => [],
    listStories: async () => ({ stories: [], nextCursor: null }),
    listCharacters: async () => [],
    listReferences: async () => [],
  } as unknown as StoriesApi;
  return { api, attach };
}

describe("the director chat takes pictures dropped anywhere on its page", () => {
  async function openChat() {
    const { api, attach } = chatApi();
    setStoriesApi(api);
    await render(<ConversationView ws="stories" convId={CONV.winter} onConversation={() => undefined} onMissing={() => undefined} />);
    await until(() => !!$(".st-chat-compose"));
    return attach;
  }
  const tray = () => $$(".st-chat-pic");
  const settled = () => tray().every((p) => !p.querySelector('[role="progressbar"]'));

  it("takes 2 pictures from one drop off the box, and refuses a PDF with its line", async () => {
    const attach = await openChat();
    const drop = await dropOn($(".st-chat-conv__head")!, [png("a.png"), png("b.png")]);
    expect(drop.defaultPrevented).toBe(true);
    await until(() => tray().length === 2 && settled());
    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls.map((c) => (c[2] as { filename: string }).filename)).toEqual(["a.png", "b.png"]);

    await dropOn($(".st-chat-msgs") ?? $(".st-chat-conv")!, [pdf()]);
    expect(tray()).toHaveLength(2);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(said("Pick a PNG, JPG or WebP picture.")).toBe(true);
  });

  it("refuses a 5th picture: the room left is taken, the rest says the limit", async () => {
    const attach = await openChat();
    await dropOn($(".st-chat-conv")!, [png("1.png"), png("2.png"), png("3.png")]);
    await until(() => tray().length === 3 && settled());
    // Two more than fit: one goes in, one is refused.
    await dropOn($(".st-chat-conv")!, [png("4.png"), png("5.png")]);
    await until(() => tray().length === 4 && settled());
    expect(attach).toHaveBeenCalledTimes(4);
    expect(said("You can add up to 4 pictures to one message.")).toBe(true);
    // Full: a 5th is refused at once.
    const fifth = await dropOn($(".st-chat-conv")!, [png("6.png")]);
    expect(fifth.defaultPrevented).toBe(true);
    expect(tray()).toHaveLength(4);
    expect(attach).toHaveBeenCalledTimes(4);
    expect(said("You can add up to 4 pictures to one message.")).toBe(true);
  });

  it("leaves words dragged over the box to the box", async () => {
    await openChat();
    const box = $("textarea")!;
    const e = new Event("dragover", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    e.dataTransfer = { types: ["text/plain"], items: [], files: [], getData: () => "rain", dropEffect: "copy" };
    await act(async () => {
      box.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
  });
});

// ---------- Settings › Look ----------

describe("Settings › Look takes a dropped picture only in Picture", () => {
  beforeEach(() => {
    // jsdom draws no pictures: the picture is kept as read (shrinkPicture's own fallback without Image).
    vi.stubGlobal("Image", undefined);
  });

  it("takes nothing while Colours is chosen", async () => {
    setStoriesPicture(null);
    setStoriesLook({ mode: "colours" });
    await render(<LookSection />);
    await dropOn($(".st-look")!, [png()]);
    expect(storiesLook().mode).toBe("colours");
    expect(storiesLook().picture).toBeNull();
  });

  it("in Picture a dropped picture is the background, and a PDF is refused with its line", async () => {
    setStoriesPicture(null);
    setStoriesLook({ mode: "picture" });
    await render(<LookSection />);
    await dropOn($(".st-look")!, [pdf()]);
    expect(storiesLook().picture).toBeNull();
    expect(said("Pick a picture.")).toBe(true);

    await dropOn($(".st-look")!, [png("beach.png")]);
    await until(() => !!storiesLook().picture);
    expect(storiesLook().picture).toMatch(/^data:image\/png;base64,/);
    expect(storiesLook().mode).toBe("picture");
    expect(host.querySelector("[disabled]")).toBeNull();
  });
});

// ---------- Settings › Skills ----------

describe("a skill's upload button takes a dropped skill file", () => {
  function skillsApi() {
    const up = vi.fn((_ws: string, _body: { filename: string }) => new Promise<never>(() => undefined));
    setStoriesApi({
      listSkills: async () => [],
      getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: [], agents: [], tasks: [] }),
      skillUpload: up,
    } as unknown as StoriesApi);
    return up;
  }

  it("uploads a .md dropped on it, refuses a PDF, and takes nothing while it is off", async () => {
    const up = skillsApi();
    await render(
      <ToastProvider>
        <SkillsSection ws="stories" />
      </ToastProvider>,
    );
    await until(() => !!$(".st-stg-file"));
    const pick = $(".st-stg-file")!;

    await dropOn(pick, [pdf()]);
    expect(up).not.toHaveBeenCalled();
    expect(said("That is not a skill. Pick a SKILL.md file or a .zip with one inside.")).toBe(true);

    const first = await dropOn(pick, [md()]);
    expect(first.defaultPrevented).toBe(true);
    await until(() => up.mock.calls.length === 1);
    expect(up.mock.calls[0]![1]).toEqual({ filename: "falls.md" });

    // It is uploading now: the button is off and takes no drop (never `disabled`).
    await until(() => $(".st-stg-file")?.getAttribute("aria-disabled") === "true");
    await dropOn($(".st-stg-file")!, [md()]);
    expect(up).toHaveBeenCalledTimes(1);
    expect($$("[disabled]")).toEqual([]);
  });
});

// ---------- Design with AI ----------

describe("the open Design with AI panel takes a dropped picture", () => {
  it("sends it as the picture to start from, and refuses a PDF with its line", async () => {
    const upload = vi.fn(async () => ({ assetId: "01JSTAS0000000000000000001", uploadUrl: "mock://design/1", headers: {} }));
    setStoriesApi({ designUpload: upload } as unknown as StoriesApi);
    await render(<DesignPanel ws="stories" info={LISTED_INFO} onDraft={() => undefined} startOpen />);
    const panel = $(".st-s-design")!;

    await dropOn(panel, [pdf()]);
    expect(upload).not.toHaveBeenCalled();
    expect(said("Pick a PNG, JPG or WebP picture.")).toBe(true);

    await dropOn(panel, [png("zed.png", 3000)]);
    await until(() => upload.mock.calls.length === 1 && !!$(".st-s-design__pic"));
    expect(upload).toHaveBeenCalledWith("stories", { filename: "zed.png", contentType: "image/png", size: 3000 });
    expect($(".st-s-design__pic")?.textContent).toContain("Use no picture");
  });

  it("takes nothing while it is closed", async () => {
    const upload = vi.fn();
    setStoriesApi({ designUpload: upload } as unknown as StoriesApi);
    await render(<DesignPanel ws="stories" info={LISTED_INFO} onDraft={() => undefined} />);
    await dropOn($(".st-s-design")!, [png()]);
    expect(upload).not.toHaveBeenCalled();
  });
});
