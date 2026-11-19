// Pictures in Ask (docs/CONTRACTS.md §26): the JPEG reader, the quality ladder, the messages, the request shape, the
// chat state and the panel's tray, buttons, focus and memory.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api/index.ts", () => ({ api: () => ({ me: async () => ({ counts: {} }) }) }));
// The panel's picture making is faked (jsdom has no canvas); the real one is tested through importActual.
vi.mock("../src/features/help/pictures.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/help/pictures.ts")>()),
  preparePicture: vi.fn(),
  toBase64: vi.fn(),
}));

import { ToastProvider } from "../src/components/Toasts.tsx";
import { chatReducer, historyOf, initialChat, liveUrls, readyTray, type ChatState } from "../src/features/help/chatState.ts";
import { helpClient, pictureResult, trimBody, type AskBody, type AskResult, type HelpClient, type HelpTransport } from "../src/features/help/helpApi.ts";
import { AskClipFactory } from "../src/features/help/HelpLauncher.tsx";
import { DROP_TEXT, PICTURE_PLACEHOLDER } from "../src/features/help/HelpPanel.tsx";
import * as faked from "../src/features/help/pictures.ts";
import { fitJpeg, filesFrom, isPictureFile, jpegInfo, stripJpeg, KEEP_MAX, PICTURE_BYTES_MAX, PICTURE_TEXT, type Pic } from "../src/features/help/pictures.ts";
import { previousUserQuestion } from "../src/features/help/retrieve.ts";
import { setHelpSwitch, setPicturesOn } from "../src/features/help/status.ts";
import type { HelpAnswer } from "../src/features/help/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------- JPEG bytes ----------

function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}

function jpeg({ width = 800, height = 600, exif = false, sof = 0xc0 } = {}): Uint8Array {
  const out = [0xff, 0xd8, ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])];
  if (exif) out.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3]));
  out.push(...seg(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
  out.push(...seg(0xda, [1, 1, 0, 0, 0x3f, 0]));
  for (let i = 0; i < 1200; i++) out.push((i * 7) % 0xfe);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

describe("jpegInfo", () => {
  it("reads the frame size and whether metadata is there", () => {
    expect(jpegInfo(jpeg())).toEqual({ width: 800, height: 600, hasExif: false });
    expect(jpegInfo(jpeg({ width: 1568, height: 980, exif: true }))).toEqual({ width: 1568, height: 980, hasExif: true });
    expect(jpegInfo(jpeg({ sof: 0xc2 }))?.width).toBe(800);
  });

  it("strips APP1..APP15 like the API, keeping the frame", () => {
    const raw = jpeg({ width: 1568, height: 980, exif: true });
    const clean = stripJpeg(raw)!;
    expect(clean.length).toBe(raw.length - 13);
    expect(jpegInfo(clean)).toEqual({ width: 1568, height: 980, hasExif: false });
    expect(stripJpeg(clean)).toEqual(clean);
    expect(stripJpeg(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("refuses what is not a baseline or progressive JPEG", () => {
    expect(jpegInfo(jpeg().slice(0, -2))).toBeNull();
    expect(jpegInfo(jpeg({ sof: 0xc3 }))).toBeNull();
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 0xd9]))).toBeNull();
    expect(jpegInfo(new TextEncoder().encode("hello"))).toBeNull();
  });
});

// ---------- size and quality ----------

describe("fitJpeg", () => {
  it("starts at 1568 px on the long edge and the first quality when that fits", async () => {
    const encode = vi.fn(async (_w: number, _h: number, _q: number) => new Blob([new Uint8Array(1000)]));
    const out = await fitJpeg(4000, 3000, encode);
    expect(out).toMatchObject({ width: 1568, height: 1176 });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(1568, 1176, 0.82);
  });

  it("fits an iPhone screenshot (1179 x 2556, the owner's Facebook screen) to 1568 px on the long edge", async () => {
    const encode = vi.fn(async (_w: number, _h: number, _q: number) => new Blob([new Uint8Array(200_000)]));
    const out = await fitJpeg(1179, 2556, encode);
    expect(out).toMatchObject({ width: 723, height: 1568 });
    expect(encode).toHaveBeenCalledWith(723, 1568, 0.82);
  });

  it("never makes a small picture bigger", async () => {
    const encode = vi.fn(async () => new Blob(["x"]));
    expect(await fitJpeg(390, 844, encode)).toMatchObject({ width: 390, height: 844 });
  });

  it("walks the quality ladder, then shrinks by 0.8 up to 3 times", async () => {
    const calls: [number, number, number][] = [];
    const encode = async (w: number, h: number, q: number) => {
      calls.push([w, h, q]);
      // Fits only once it is at most 900 px wide and at quality 0.6.
      return new Blob([new Uint8Array(w <= 900 && q === 0.6 ? 1000 : PICTURE_BYTES_MAX + 1)]);
    };
    const out = await fitJpeg(1000, 1000, encode);
    expect(calls.map((c) => c[2])).toEqual([0.82, 0.72, 0.6, 0.82, 0.72, 0.6]);
    expect(calls.map((c) => c[0])).toEqual([1000, 1000, 1000, 800, 800, 800]);
    expect(out).toMatchObject({ width: 800, height: 800 });
  });

  it("gives up (too big) after the third shrink", async () => {
    const encode = vi.fn(async () => new Blob([new Uint8Array(PICTURE_BYTES_MAX + 1)]));
    expect(await fitJpeg(1568, 1568, encode)).toBeNull();
    expect(encode).toHaveBeenCalledTimes(12);
  });
});

describe("which files are pictures, and the words for each case", () => {
  it("knows pictures by type, and HEIC by name", () => {
    expect(isPictureFile({ type: "image/png", name: "a.png" })).toBe(true);
    expect(isPictureFile({ type: "", name: "IMG_1.HEIC" })).toBe(true);
    expect(isPictureFile({ type: "text/plain", name: "note.txt" })).toBe(false);
  });

  it("takes files from items, or from files", () => {
    const a = new File(["a"], "a.png", { type: "image/png" });
    const items = [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => a }];
    expect(filesFrom({ items: items as unknown as DataTransferItemList, files: [] as unknown as FileList })).toEqual([a]);
    expect(filesFrom({ items: [] as unknown as DataTransferItemList, files: [a] as unknown as FileList })).toEqual([a]);
    expect(filesFrom(null)).toEqual([]);
  });

  it("refuses a non-picture and a huge file before decoding", async () => {
    const pictures = await vi.importActual<typeof import("../src/features/help/pictures.ts")>("../src/features/help/pictures.ts");
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    expect(await pictures.preparePicture(new File(["hi"], "note.txt", { type: "text/plain" }))).toEqual({ error: "not_picture" });
    const huge = new File(["x"], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(huge, "size", { value: pictures.SOURCE_BYTES_MAX + 1 });
    expect(await pictures.preparePicture(huge)).toEqual({ error: "too_big" });
    expect(decode).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("says each case in plain words", () => {
    expect(PICTURE_TEXT).toEqual({
      too_many: "You can add 4 pictures. Take one away first.",
      too_big: "That picture is too big. Try a screenshot.",
      cant_open: "I can't open that picture. Try a screenshot or a photo.",
      not_picture: "That's not a picture. Try a screenshot.",
      off: "Pictures are off right now. Ask me in words.",
      unread: "I couldn't look at your picture this time. Tell me in words, or try again.",
      limit: "You sent lots of pictures today. Ask me in words, or try again tomorrow.",
    });
    for (const text of Object.values(PICTURE_TEXT)) expect(text).not.toMatch(/[–—]/);
  });
});

// ---------- request and response ----------

describe("trimBody and the picture result", () => {
  it("keeps 4 pictures at most, seen only on user turns, and an empty question with pictures", () => {
    const p = { type: "image/jpeg" as const, data: "AAAA" };
    const body = trimBody({
      question: "  ",
      pictures: [p, p, p, p, p],
      history: [
        { role: "user", text: "hi", seen: "s".repeat(500) },
        { role: "assistant", text: "yo", seen: "never" } as never,
      ],
    });
    expect(body.question).toBe("");
    expect(body.pictures).toHaveLength(4);
    expect(body.history).toEqual([
      { role: "user", text: "hi", seen: "s".repeat(200) },
      { role: "assistant", text: "yo" },
    ]);
    expect(trimBody({ question: "hi" })).toEqual({ question: "hi" });
  });

  it("reads the two picture shapes and nothing else", () => {
    expect(pictureResult({ read: true, seen: "Settings." })).toEqual({ read: true, seen: "Settings." });
    expect(pictureResult({ read: false, why: "limit" })).toEqual({ read: false, why: "limit" });
    expect(pictureResult({ read: false, why: "boom" })).toBeUndefined();
    expect(pictureResult("x")).toBeUndefined();
  });

  it("gives a question with pictures 10 s more", async () => {
    vi.useFakeTimers();
    try {
      let aborted = 0;
      const transport: HelpTransport = (_m, _p, _b, _t, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = Date.now();
            reject(signal.reason);
          }),
        );
      const client = helpClient({ transport, auth: { accessToken: async () => "t" } });
      const start = Date.now();
      const out = client.ask({ question: "", pictures: [{ type: "image/jpeg", data: "AAAA" }] });
      await vi.advanceTimersByTimeAsync(37_000);
      expect((await out).kind).toBe("fallback");
      expect(aborted - start).toBe(37_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- chat state ----------

const pic = (id: number): Pic => ({ id, blob: new Blob(["x"]), url: `blob:pic-${id}`, width: 10, height: 10 });

describe("chat state with pictures", () => {
  it("moves the tray into the question, keeps seen for the history", () => {
    let s: ChatState = initialChat;
    s = chatReducer(s, { type: "tray_add", id: 1 });
    expect(readyTray(s)).toEqual([]);
    s = chatReducer(s, { type: "tray_ready", pic: pic(1) });
    s = chatReducer(s, { type: "ask", id: 10, text: "", pictures: readyTray(s) });
    expect(s.tray).toEqual([]);
    expect(s.entries[0]).toMatchObject({ role: "user", text: "", pictures: [{ id: 1, url: "blob:pic-1" }] });
    s = chatReducer(s, { type: "seen", entryId: 10, seen: "You are on Settings." });
    expect(historyOf(s.entries)).toEqual([{ role: "user", text: "", seen: "You are on Settings." }]);
    expect(previousUserQuestion(historyOf(s.entries))).toBe("You are on Settings.");
  });

  it("drops a picture that is ready after it was taken away", () => {
    let s = chatReducer(initialChat, { type: "tray_add", id: 1 });
    s = chatReducer(s, { type: "tray_remove", id: 1 });
    expect(chatReducer(s, { type: "tray_ready", pic: pic(1) })).toBe(s);
  });

  it("puts pictures back in the tray, at most 4 and never twice", () => {
    let s = chatReducer(initialChat, { type: "ask", id: 10, text: "", pictures: [pic(1), pic(2)] });
    s = chatReducer(s, { type: "tray_add", id: 3 });
    s = chatReducer(s, { type: "tray_ready", pic: pic(3) });
    s = chatReducer(s, { type: "tray_restore", pics: [pic(1), pic(2)] });
    expect(s.tray.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(chatReducer(s, { type: "tray_restore", pics: [pic(1)] })).toBe(s);
    s = chatReducer(s, { type: "tray_restore", pics: [pic(4), pic(5)] });
    expect(s.tray.map((p) => p.id)).toEqual([4, 1, 2, 3]);
  });

  it("lets go of the oldest pictures past the 12-picture memory", () => {
    let s: ChatState = initialChat;
    for (let q = 0; q < 4; q++) s = chatReducer(s, { type: "ask", id: 100 + q, text: "", pictures: [1, 2, 3, 4].map((n) => pic(q * 10 + n)) });
    expect(liveUrls(s).size).toBe(KEEP_MAX);
    const first = s.entries[0]!;
    expect(first.role === "user" && first.pictures!.every((p) => p.url === null)).toBe(true);
  });
});

// ---------- the panel ----------

const answer: HelpAnswer = { known: true, text: "Here it is.", steps: [], actions: [], sources: ["x"] };

function fakeClient(pictureStatus = true, result?: AskResult) {
  return {
    status: vi.fn(async () => ({ kind: "ok" as const, status: { enabled: true, mode: "model" as const, corpusVersion: "v", pictures: pictureStatus } })),
    ask: vi.fn(async (_b: AskBody): Promise<AskResult> => result ?? { kind: "answer", answer, mode: "model", requestId: "r", picture: { read: true, seen: "You are on Home." } }),
  } satisfies HelpClient;
}

let host: HTMLDivElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(ok: () => boolean) {
  await act(async () => {
    await vi.waitFor(
      () => {
        if (!ok()) throw new Error("not yet");
      },
      { timeout: 3000, interval: 10 },
    );
  });
}

async function open(client: HelpClient) {
  await act(async () => {
    root.render(
      <ToastProvider>
        <AskClipFactory client={client} />
      </ToastProvider>,
    );
  });
  await settle();
  await act(async () => $<HTMLButtonElement>('button[aria-label="Ask Clip Factory"]')!.click());
}

let made = 0;
async function addPictures(n: number) {
  const input = $<HTMLInputElement>('.help-panel__field input[type="file"]')!;
  const files = Array.from({ length: n }, (_, i) => new File(["x"], `p${i}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await until(() => !$(".help-pic.is-busy"));
}

beforeEach(() => {
  setHelpSwitch("unknown");
  setPicturesOn(false);
  history.replaceState(null, "", "/");
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  made = 0;
  vi.mocked(faked.preparePicture).mockImplementation(async () => {
    made++;
    return { id: 0, blob: new Blob(["jpeg"], { type: "image/jpeg" }), url: `blob:made-${made}`, width: 1568, height: 980 };
  });
  vi.mocked(faked.toBase64).mockImplementation(async () => "AAAA");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.mocked(faked.preparePicture).mockReset();
});

describe("Ask panel with pictures", () => {
  it("shows the picture button only when pictures are on", async () => {
    await open(fakeClient(false));
    expect($('button[aria-label="Add a picture"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(fakeClient(true));
    expect($('button[aria-label="Add a picture"]')).not.toBeNull();
  });

  it("sends pictures with no words, shows them in the bubble and keeps seen", async () => {
    const client = fakeClient();
    await open(client);
    await addPictures(2);
    expect($$(".help-pic")).toHaveLength(2);
    expect($<HTMLTextAreaElement>(".help-panel__input")!.placeholder).toBe(PICTURE_PLACEHOLDER);
    const send = $<HTMLButtonElement>(".help-panel__ask")!;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    await until(() => !$(".help-thinking"));
    expect(client.ask).toHaveBeenCalledTimes(1);
    const body = client.ask.mock.calls[0]![0];
    expect(body.question).toBe("");
    expect(body.pictures).toEqual([
      { type: "image/jpeg", data: "AAAA" },
      { type: "image/jpeg", data: "AAAA" },
    ]);
    expect($$(".help-pic")).toHaveLength(0);
    expect($$('.help-sent button[aria-label^="Open picture"]')).toHaveLength(2);
    // The next question carries seen, and no pictures.
    const ta = $<HTMLTextAreaElement>(".help-panel__input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "and then?");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => client.ask.mock.calls.length === 2);
    const next = client.ask.mock.calls[1]![0];
    expect(next.pictures).toBeUndefined();
    expect(next.history?.[0]).toEqual({ role: "user", text: "", seen: "You are on Home." });
  });

  it("stops at 4 and says so; take away moves focus on", async () => {
    await open(fakeClient());
    await addPictures(5);
    expect($$(".help-pic")).toHaveLength(4);
    expect($(".help-note")?.textContent).toBe(PICTURE_TEXT.too_many);
    const removes = $$<HTMLButtonElement>(".help-pic__remove");
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual(["Take away picture 1", "Take away picture 2", "Take away picture 3", "Take away picture 4"]);
    await act(async () => removes[1]!.click());
    await settle(250);
    expect($$(".help-pic")).toHaveLength(3);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Take away picture 2");
  });

  it("lets go of every picture on Start over", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await open(fakeClient());
    await addPictures(3);
    const startOver = $$<HTMLButtonElement>("button").find((b) => b.textContent?.trim() === "Start over")!;
    await act(async () => startOver.click());
    await settle();
    expect($$(".help-pic")).toHaveLength(0);
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual(["blob:made-1", "blob:made-2", "blob:made-3"]);
  });

  async function typeText(words: string) {
    const ta = $<HTMLTextAreaElement>(".help-panel__input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, words);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("says why a picture was not read, before the answer", async () => {
    await open(fakeClient(true, { kind: "answer", answer, mode: "kb", requestId: "r", picture: { read: false, why: "limit" } }));
    await addPictures(1);
    await typeText("where is keep");
    await act(async () => $<HTMLButtonElement>(".help-panel__ask")!.click());
    await until(() => !!$(".help-msg--notice") && !$(".help-thinking"));
    expect($(".help-msg--notice")?.textContent).toContain(PICTURE_TEXT.limit);
    const log = $(".help-msg--notice")!.closest("[class*='help-panel__log'], .help-log") ?? document.body;
    const text = log.textContent ?? "";
    expect(text.indexOf(PICTURE_TEXT.limit)).toBeLessThan(text.lastIndexOf("Here it is."));
  });

  it("with no words, the answer alone says why (no second note)", async () => {
    const unread = { ...answer, known: false, text: "I couldn't look at your picture this time. Tell me in words what you want to do." };
    await open(fakeClient(true, { kind: "answer", answer: unread, mode: "kb", requestId: "r", picture: { read: false, why: "trouble" } }));
    await addPictures(1);
    await act(async () => $<HTMLButtonElement>(".help-panel__ask")!.click());
    await until(() => !$(".help-thinking") && document.body.textContent!.includes("Tell me in words what you want to do."));
    expect($$(".help-msg--notice")).toHaveLength(0);
  });

  it("gives the pictures and words back when the question could not go", async () => {
    const client = fakeClient(true, { kind: "rate_limited", retryAfter: 1 } as AskResult);
    await open(client);
    await addPictures(2);
    await typeText("where is keep");
    await act(async () => $<HTMLButtonElement>(".help-panel__ask")!.click());
    await until(() => !!$(".help-msg--notice"));
    expect($$(".help-pic")).toHaveLength(2);
    expect($<HTMLTextAreaElement>(".help-panel__input")!.value).toBe("where is keep");
  });

  it("sends once the picture is ready when Enter comes first", async () => {
    const client = fakeClient();
    await open(client);
    let finish: () => void = () => undefined;
    vi.mocked(faked.preparePicture).mockImplementationOnce(
      () => new Promise((r) => (finish = () => r({ id: 0, blob: new Blob(["jpeg"], { type: "image/jpeg" }), url: "blob:slow", width: 10, height: 10 }))),
    );
    const input = $<HTMLInputElement>('.help-panel__field input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "p.png", { type: "image/png" })], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await typeText("where is keep");
    const ta = $<HTMLTextAreaElement>(".help-panel__input")!;
    await act(async () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(client.ask).not.toHaveBeenCalled();
    expect($(".help-note")?.textContent).toBe(faked.READYING_TEXT);
    await act(async () => finish());
    await until(() => client.ask.mock.calls.length === 1);
    expect(client.ask.mock.calls[0]![0]).toMatchObject({ question: "where is keep", pictures: [{ type: "image/jpeg", data: "AAAA" }] });
  });

  it("shows the drop layer while a file is dragged over the panel", async () => {
    await open(fakeClient());
    const panel = $("#help-panel")!;
    const drag = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      e.dataTransfer = { types: ["Files"], items: [], files: [], dropEffect: "none" };
      return e;
    };
    await act(async () => panel.dispatchEvent(drag("dragenter")));
    expect($(".help-drop")?.textContent).toBe(DROP_TEXT);
    await act(async () => panel.dispatchEvent(drag("dragleave")));
    expect($(".help-drop")).toBeNull();
  });
});
