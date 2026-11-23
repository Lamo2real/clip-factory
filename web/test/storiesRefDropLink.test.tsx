// Clips Funded › References: drag and drop, and "paste a link" (docs/CONTRACTS.md §45.40.3, §45.40.9). A link
// pasted in the card's box and added makes a row "Getting it…" that lands ready, cheers and opens its page; a link the
// box can't take says why and never shows Add; a link pasted with nothing focused, or dropped on the page, fills the
// box; a video dropped anywhere on the page starts its upload and a picture is refused with its line and the shake; a
// reference whose video did not arrive offers Try again and "Upload a video" in its place; an unknown status never
// crashes; the studio's "Pictures to aim for" takes a dropped picture and is off when full; and the old file selector
// still works. Rendered with the mock's references part; only storiesApi() is used.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import { REF_LINK_REFUSED } from "../src/stories/api/refLinks.ts";
import type { Character, ModelInfo, StoriesApi } from "../src/stories/api/types.ts";
import { forgetVisit } from "../src/stories/chat/device.ts";
import { fileModels, forgetModels } from "../src/stories/chat/models.ts";
import { forgetProjectNames } from "../src/stories/chat/project.ts";
import { forgetUploads } from "../src/stories/chat/references/uploads.ts";
import { SoundEngine } from "../src/lib/sound.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

// The bytes never leave: every presigned PUT is done at once.
vi.mock("../src/api/upload.ts", async (load) => ({ ...(await load<typeof import("../src/api/upload.ts")>()), putFile: () => Promise.resolve() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ReferencesScreen } = await import("../src/stories/screens/References.tsx");
const { REF_STATUS, statusOf } = await import("../src/stories/chat/references/RefList.tsx");
const { PASTE_HELP } = await import("../src/stories/chat/references/RefLinkBox.tsx");
const { References } = await import("../src/stories/studio/References.tsx");

const TIKTOK = "https://www.tiktok.com/@lamo/video/7300000000000000001";

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function info(key: string): ModelInfo {
  const { line: _line, ...rest } = fileModels().find((x) => x.key === key)!;
  return { ...rest, status: "ok", statusLine: "Answered the last call.", checkedAt: "2026-11-23T12:00:00.000Z" };
}

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 });
  references.seed(store);
  store.knobs.refSeconds = 0.2;
  store.knobs.refFetchSeconds = 0.2;
  const r = references.api(store);
  const reject = () => Promise.reject(new Error("Not used here."));
  return {
    ...r,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: [info("opus-5-5")], agents: [], tasks: [] }),
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
  forgetModels();
  forgetProjectNames();
  history.replaceState({}, "", "/stories/references");
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    { timeout: ms, interval: 25 },
  );
  await act(async () => undefined);
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const byText = (sel: string, text: string | RegExp) => $$(sel).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) ?? null;
const page = (p: StoriesPage) => p;
const box = () => $(".st-ref-link__input") as HTMLInputElement;
const line = () => $(".st-ref-line")?.textContent?.trim() ?? "";

async function click(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const video = (name = "cat_jumps.mp4") => new File([new Uint8Array(2048)], name, { type: "video/mp4" });
const png = (name = "shot.png") => new File([new Uint8Array(256)], name, { type: "image/png" });

/** What a drag or a paste carries (jsdom has no DataTransfer: the fields the hooks read). */
function carrying(what: { files?: File[]; uri?: string; text?: string }) {
  const files = what.files ?? [];
  const types = [...(files.length ? ["Files"] : []), ...(what.uri ? ["text/uri-list"] : []), ...(what.text || what.uri ? ["text/plain"] : [])];
  return {
    types,
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    getData: (t: string) => (t === "text/uri-list" ? (what.uri ?? "") : t === "text/plain" || t === "text" ? (what.text ?? what.uri ?? "") : ""),
    dropEffect: "none",
    effectAllowed: "all",
  };
}

function dragEvent(type: string, what: Parameters<typeof carrying>[0]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientX: number; clientY: number };
  e.dataTransfer = carrying(what);
  Object.defineProperty(e, "clientX", { value: 300 });
  Object.defineProperty(e, "clientY", { value: 300 });
  return e;
}

/** A whole drag: in, over, then the drop, on `target`. Answers the drop event. */
async function dropOn(target: Element, what: Parameters<typeof carrying>[0]): Promise<Event> {
  await act(async () => {
    target.dispatchEvent(dragEvent("dragenter", what));
    target.dispatchEvent(dragEvent("dragover", what));
  });
  const drop = dragEvent("drop", what);
  await act(async () => {
    target.dispatchEvent(drop);
  });
  await act(async () => undefined);
  return drop;
}

/** A paste on `target` (document.body: nothing focused). Answers the event. */
async function pasteOn(target: Element, what: Parameters<typeof carrying>[0]): Promise<Event> {
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  e.clipboardData = carrying(what);
  await act(async () => {
    target.dispatchEvent(e);
  });
  await act(async () => undefined);
  return e;
}

async function openList(cards = 2) {
  await render(<ReferencesScreen ws="stories" page={page({ name: "references" })} />);
  await until(() => $$(".st-ref-card").length === cards && !!box());
}

describe("paste a link (§45.40)", () => {
  it("Paste then Add makes a row 'Getting it…' that lands ready, cheers and opens its page", async () => {
    const play = vi.spyOn(SoundEngine.prototype, "play");
    await openList();
    // At rest: one main action, Upload a video; the box offers Paste only when the browser can read the clipboard.
    expect(byText(".st-ref-drop .st-chat-btn", "Upload a video")?.classList.contains("st-chat-btn--main")).toBe(true);
    expect(box().placeholder).toBe("Paste a video link");
    expect($(`label[for="${box().id}"]`)?.textContent).toBe("Video link");

    await pasteOn(box(), { text: `Look at this one! ${TIKTOK}` });
    expect(box().value).toBe(TIKTOK);
    expect(line()).toBe("TikTok video found.");
    const add = byText(".st-ref-link__add", "Add")!;
    expect(add.classList.contains("st-chat-btn--main")).toBe(true);
    expect(document.activeElement).toBe(add);
    // While Add is the main action, Upload a video steps back.
    expect(byText(".st-ref-drop .st-chat-btn", "Upload a video")?.classList.contains("st-chat-btn--main")).toBe(false);

    await click(add);
    await until(() => $$(".st-ref-card").length === 3);
    const first = $$(".st-ref-card")[0]!;
    expect(first.textContent).toContain("Getting it…");
    expect(first.textContent).toContain("From TikTok");
    expect(box().value).toBe("");
    const made = store.references.find((r) => r.link === TIKTOK)!;
    expect(made.status).toBe("fetching");

    // The list looks again every 3 s: once the video is here, a cheer and its own page.
    await until(() => location.pathname === `/stories/references/${made.refId}`, 9000);
    expect(play).toHaveBeenCalledWith("success");
    expect(store.references.find((r) => r.refId === made.refId)!.status).toBe("ready");
  }, 20_000);

  it("a link it can't take says why, and Add never shows", async () => {
    await openList();
    for (const [text, why] of [
      ["https://vimeo.com/123456", REF_LINK_REFUSED.other_site],
      ["https://www.tiktok.com/@lamo", REF_LINK_REFUSED.not_one_video],
      ["funny cat", REF_LINK_REFUSED.not_a_link],
    ] as const) {
      await type(box(), text);
      expect(line()).toBe(why);
      expect($(".st-ref-link__add")).toBeNull();
      expect($(".st-ref-link__paste")).toBeNull();
      expect(byText(".st-ref-drop .st-chat-btn", "Upload a video")?.classList.contains("st-chat-btn--main")).toBe(true);
    }
    // Enter does nothing with it.
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(store.references).toHaveLength(2);
  });

  it("the API's own refusal shows in the line (the same link twice)", async () => {
    await api.createReferenceFromLink("stories", { url: TIKTOK });
    await openList(3);
    await type(box(), TIKTOK);
    await click($(".st-ref-link__add"));
    await until(() => line() === "That video is in your list already.");
  });

  it("Paste reads the clipboard; when the browser says no, it says how to paste by hand", async () => {
    let answer: () => Promise<string> = () => Promise.resolve(TIKTOK);
    Object.defineProperty(navigator, "clipboard", { value: { readText: () => answer() }, configurable: true });
    onTestFinished(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });
    await openList();
    await click(byText(".st-ref-link__paste", "Paste"));
    await until(() => box().value === TIKTOK);
    expect(line()).toBe("TikTok video found.");

    await type(box(), "");
    answer = () => Promise.reject(new Error("NotAllowedError"));
    await click(byText(".st-ref-link__paste", "Paste"));
    await until(() => line() === PASTE_HELP);
  });

  it("a link pasted with nothing focused fills the box, and so does a link dropped on the page", async () => {
    await openList();
    const pasted = await pasteOn(document.body, { text: "https://youtu.be/dQw4w9WgXcQ" });
    expect(pasted.defaultPrevented).toBe(true);
    expect(box().value).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(line()).toBe("YouTube video found.");
    expect(store.references).toHaveLength(2); // never added by itself

    await type(box(), "");
    const dropped = await dropOn(document.body, { uri: "https://www.instagram.com/reel/Cabc123/" });
    expect(dropped.defaultPrevented).toBe(true);
    expect(box().value).toBe("https://www.instagram.com/reel/Cabc123/");
    expect(line()).toBe("Instagram video found.");
    expect(store.references).toHaveLength(2);
  });

  it("a paste into another field, or text with no link, is left alone", async () => {
    await openList();
    const field = document.createElement("textarea");
    host.appendChild(field);
    const into = await pasteOn(field, { text: TIKTOK });
    expect(into.defaultPrevented).toBe(false);
    expect(box().value).toBe("");
    const words = await pasteOn(document.body, { text: "hello there" });
    expect(words.defaultPrevented).toBe(false);
    expect(box().value).toBe("");
    field.remove();
  });
});

describe("drop anywhere on References (§45.40)", () => {
  it("a video dropped off the card starts its upload, which opens its page", async () => {
    await openList();
    const drop = await dropOn($(".st-chat-head")!, { files: [video("dog_and_ball.mp4")] });
    expect(drop.defaultPrevented).toBe(true);
    await until(() => !!$(".st-ref-upload"));
    await until(() => store.references.some((r) => r.title === "dog and ball"));
    const made = store.references.find((r) => r.title === "dog and ball")!;
    await until(() => location.pathname === `/stories/references/${made.refId}`, 8000);
  });

  it("dragging shows the glass 'Drop your video here' over the page, and it goes when the drag leaves", async () => {
    await openList();
    await act(async () => {
      document.body.dispatchEvent(dragEvent("dragenter", { files: [video()] }));
    });
    expect($(".stories-app > .drop-layer.drop-layer--page.st-drop")?.textContent).toBe("Drop your video here");
    expect($(".drop-layer")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      document.body.dispatchEvent(dragEvent("dragleave", { files: [video()] }));
    });
    expect($(".drop-layer")).toBeNull();
  });

  it("a picture is refused with 'Pick an MP4 or MOV video.' and the shake; nothing is sent", async () => {
    await openList();
    const drop = await dropOn(document.body, { files: [png()] });
    expect(drop.defaultPrevented).toBe(true);
    expect($(".drop-layer.is-refused")?.textContent).toBe("Pick an MP4 or MOV video.");
    expect($$('[role="status"]').some((el) => el.textContent === "Pick an MP4 or MOV video.")).toBe(true);
    expect($(".st-ref-upload")).toBeNull();
    expect(store.references).toHaveLength(2);
  });

  it("the file picker still works, and its refusal is the card's line (no failed upload row)", async () => {
    await openList();
    const input = $('.st-ref-drop input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["hello"], "notes.txt", { type: "text/plain" })], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(line()).toBe("Pick an MP4 or MOV video.");
    expect($(".st-ref-upload")).toBeNull();
    Object.defineProperty(input, "files", { value: [video("my_fav.mp4")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => !!$(".st-ref-upload"));
    expect(line()).toBe("");
  });
});

describe("a reference from a link, on its own page (§45.40)", () => {
  it("fetching says it is on its way; fetch_failed says why, and Try again gets it", async () => {
    store.knobs.refFetchSeconds = 1;
    const { reference } = await api.createReferenceFromLink("stories", { url: TIKTOK });
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: reference.refId })} />);
    await until(() => !!byText(".st-ref-block__title", "Getting it from TikTok…"));
    expect($(".st-ref-player__none")?.textContent).toBe("The video is on its way.");
    expect($(".st-ref__meta")?.textContent).toContain("Getting it…");
    expect(byText(".st-ref-track__label", "Get the video")).not.toBeNull();
    expect(byText("button", "Delete")).not.toBeNull();
    expect(byText("button", "Use in a video")).toBeNull();
    await until(() => !!byText("button", "Analyze it"), 8000);

    // The next one does not arrive.
    const sorry = "That video is private. Pick a public one, or save it and drop it here.";
    store.knobs.refFetchFail = sorry;
    store.knobs.refFetchSeconds = 0.2;
    const other = await api.createReferenceFromLink("stories", { url: "https://www.youtube.com/shorts/abcdefghijk" });
    await new Promise((r) => setTimeout(r, 300));
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: other.reference.refId })} />);
    await until(() => !!byText(".st-ref-block__title", "It didn't arrive"));
    expect($(".st-ref-fetch .st-ref-failed")?.textContent).toBe(sorry);
    expect($(".st-ref__meta")?.textContent).toContain("Didn't arrive");
    const again = byText("button", "Try again")!;
    expect(again.classList.contains("st-chat-btn--main")).toBe(true);
    expect(byText("button", "Upload a video")?.classList.contains("st-chat-btn--quiet")).toBe(true);
    await click(again);
    await until(() => !!byText(".st-ref-block__title", "Getting it from YouTube…"));
    await until(() => !!byText("button", "Analyze it"), 8000);
  }, 20_000);

  it("a video picked (or dropped) in place of one that did not arrive takes its place", async () => {
    store.knobs.refFetchFail = "That video is gone. Check the link.";
    const { reference } = await api.createReferenceFromLink("stories", { url: TIKTOK });
    await new Promise((r) => setTimeout(r, 300));
    history.replaceState({}, "", `/stories/references/${reference.refId}`);
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: reference.refId })} />);
    await until(() => !!byText(".st-ref-block__title", "It didn't arrive"));
    // A picture dropped on the page is refused with its line.
    const refused = await dropOn(document.body, { files: [png()] });
    expect(refused.defaultPrevented).toBe(true);
    // Drawn in Clips Funded's own glass: the layer is inside .stories-app.
    expect($(".stories-app > .drop-layer.st-drop.is-refused")?.textContent).toBe("Pick an MP4 or MOV video.");
    expect(store.references.some((r) => r.refId === reference.refId)).toBe(true);

    const input = $('.st-ref-fetch input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [video("the_real_one.mp4")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => !store.references.some((r) => r.refId === reference.refId));
    await until(() => store.references.some((r) => r.title === "the real one"));
    expect(location.pathname).toBe("/stories/references");
  });

  it("the page's drop is off unless the video did not arrive", async () => {
    await render(<ReferencesScreen ws="stories" page={page({ name: "reference", refId: references.SEED_IDS.ready })} />);
    await until(() => !!byText("button", "Analyze it"));
    const drop = await dropOn(document.body, { files: [video()] });
    expect(drop.defaultPrevented).toBe(false);
    expect($(".drop-layer")).toBeNull();
  });
});

describe("statusOf", () => {
  it("draws a status this bundle does not know as 'Needs another try', never a crash", async () => {
    expect(statusOf("fetching")).toEqual({ text: "Getting it…", tone: "sky" });
    expect(statusOf("fetch_failed")).toEqual({ text: "Didn't arrive", tone: "coral" });
    expect(statusOf("something_new")).toBe(REF_STATUS.failed);
    (store.references[0] as { status: string }).status = "something_new";
    await openList();
    expect($$(".st-ref-card").some((c) => c.textContent?.includes("Needs another try"))).toBe(true);
  });
});

describe("the studio's 'Pictures to aim for' (§45.40)", () => {
  function character(refs: number): Character {
    return {
      characterId: "01JSTCH0000000000000000001",
      name: "Pip",
      references: Array.from({ length: refs }, (_, i) => ({ assetId: `a${i}`, url: `data:,${i}` })),
    } as unknown as Character;
  }

  it("takes a dropped picture, and refuses a video with its line", async () => {
    const sent: string[] = [];
    setStoriesApi({
      referenceUpload: async (_ws: string, _id: string, body: { filename: string }) => {
        sent.push(body.filename);
        return { assetId: "a-new", uploadUrl: "mock://upload", headers: {} };
      },
      referenceComplete: async () => character(1),
    } as unknown as StoriesApi);
    const changed = vi.fn();
    await render(<References ws="stories" character={character(0)} onChange={changed} />);
    const zone = $("section.st-s-refs")!;
    expect(zone.classList.contains("st-drop-host")).toBe(true);
    const wrong = await dropOn(zone, { files: [video()] });
    expect(wrong.defaultPrevented).toBe(true);
    expect($(".st-s-refs .drop-layer.is-refused")?.textContent).toBe("Pick a PNG, JPG or WebP picture.");
    await dropOn(zone, { files: [png("look.png")] });
    await until(() => changed.mock.calls.length === 1);
    expect(sent).toEqual(["look.png"]);
  });

  it("is off when it already has 8 pictures", async () => {
    const upload = vi.fn();
    setStoriesApi({ referenceUpload: upload } as unknown as StoriesApi);
    await render(<References ws="stories" character={character(8)} onChange={() => undefined} />);
    const drop = await dropOn($("section.st-s-refs")!, { files: [png()] });
    expect(drop.defaultPrevented).toBe(false);
    expect($(".drop-layer")).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
});
