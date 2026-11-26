// Files and pictures for the notes on Home (docs/CONTRACTS.md §52): the limits and refusal sentences, remove and Undo,
// the notes box's drop highlight, paste (a picture attaches, plain text types), a failed file that keeps the others and
// the notes, and what Make clips sends.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, NewJob } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));
vi.mock("../src/api/upload.ts", () => ({ putFile: (t: unknown, f: unknown, p: unknown, s: unknown) => put(t, f, p, s) }));
vi.mock("../src/app/session.tsx", () => ({
  useSession: () => ({ me: { settings: { clipMin: 5, clipMax: 10 } }, refresh: async () => undefined }),
  useSessionIfAny: () => null,
}));
vi.mock("../src/lib/live.ts", () => ({ useLiveEvents: () => undefined, useLivePoll: () => undefined, onLiveSignal: () => () => undefined }));
vi.mock("../src/lib/contentRewards.ts", async (orig) => ({ ...(await orig<object>()), useCr: () => ({ state: "missing", reload: async () => undefined }) }));

/** The fake PUT: each call waits until the test lets it finish (or fail). */
let puts: { name: string; done: () => void; fail: (e: unknown) => void; progress: (p: number) => void }[] = [];
const put = vi.fn(
  (_t: unknown, file: unknown, onProgress: unknown, signal: unknown) =>
    new Promise<void>((resolve, reject) => {
      const s = signal as AbortSignal | undefined;
      s?.addEventListener("abort", () => reject(new DOMException("Upload canceled", "AbortError")));
      puts.push({ name: (file as File).name, done: resolve, fail: reject, progress: onProgress as (p: number) => void });
    }),
);

const A = await import("../src/lib/attachments.ts");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { NewJobForm, clearDraft, readDraft, saveDraft } = await import("../src/screens/home/NewJobForm.tsx");
const { mockApi } = await import("../src/api/mock/index.ts");

const MB = 1024 * 1024;
const file = (name: string, type: string, size = 10) => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const PNG = () => file("logo.png", "image/png");
const PDF = () => file("rules.pdf", "application/pdf");

describe("what can be added (F1)", () => {
  it("takes pictures, PDFs, text and office files, and finds the kind from the name when the system gives none", () => {
    expect(A.refusal(PNG(), 0)).toBeNull();
    expect(A.refusal(PDF(), 0)).toBeNull();
    expect(A.attachmentType(file("rules.md", ""))).toBe("text/markdown");
    expect(A.attachmentType(file("photo.JPG", "image/jpg"))).toBe("image/jpeg");
    expect(A.attachmentType(file("plan.docx", "application/octet-stream"))).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(A.refusal(file("deck.pptx", ""), 0)).toBeNull();
  });

  it("refuses each thing with one short sentence", () => {
    expect(A.refusal(file("clip.mp4", "video/mp4"), 0)).toBe("Videos go in Pick a video.");
    expect(A.refusal(file("clip.mov", ""), 0)).toBe("Videos go in Pick a video.");
    expect(A.refusal(file("photo.heic", "image/heic"), 0)).toBe("That kind of file can't be added.");
    expect(A.refusal(file("run.exe", "application/x-msdownload"), 0)).toBe("That kind of file can't be added.");
    expect(A.refusal(file("big.png", "image/png", 20 * MB + 1), 0)).toBe("That file is bigger than 20 MB.");
    expect(A.refusal(file("edge.png", "image/png", 20 * MB), 0)).toBeNull();
    expect(A.refusal(PNG(), 6)).toBe("Up to 6 files per job.");
  });

  it("adds up to 6 and says the first refusal", () => {
    const eight = Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`, "text/plain"));
    const out = A.addFiles([], [file("v.mp4", "video/mp4"), ...eight]);
    expect(out.chips).toHaveLength(6);
    expect(out.added.every((c) => c.state === "uploading" && c.progress === 0)).toBe(true);
    expect(out.refused).toBe("Videos go in Pick a video.");
    expect(A.addFiles(out.chips, [PNG()]).refused).toBe("Up to 6 files per job.");
  });

  it("knows which kinds Clip Factory reads", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"])
      expect(A.canRead(t), t).toBe(true);
    expect(A.canRead("application/msword")).toBe(false);
    expect(A.CANT_READ).toBe("Saved, but Clip Factory can't read this kind of file.");
  });
});

describe("chips: remove, Undo, a failed file (F6)", () => {
  const ids = () => {
    let n = 0;
    return () => `c${++n}`;
  };

  it("remove takes it away at once and Undo puts it back where it stood; one still uploading starts again", () => {
    const { chips } = A.addFiles([], [PNG(), PDF(), file("a.txt", "text/plain")], ids());
    const done = A.setDone(chips, "c1", "uploads/u/1/logo.png");
    const { chips: left, removed } = A.removeChip(done, "c2");
    expect(left.map((c) => c.id)).toEqual(["c1", "c3"]);
    const back = A.restoreChip(left, removed!);
    expect(back.chips.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(back.restarted).toBe(true);
    const doneBack = A.restoreChip(A.removeChip(done, "c1").chips, A.removeChip(done, "c1").removed!);
    expect(doneBack.restarted).toBe(false);
    expect(doneBack.chips[0]!.key).toBe("uploads/u/1/logo.png");
  });

  it("a failed file keeps its own error and Try again; the others stay", () => {
    const { chips } = A.addFiles([], [PNG(), PDF()], ids());
    const failed = A.setFailed(A.setDone(chips, "c1", "k1"), "c2", A.uploadErrorText({ status: 413 }));
    expect(failed[0]!.state).toBe("done");
    expect(failed[1]).toMatchObject({ state: "failed", error: "That file is bigger than 20 MB." });
    expect(A.setRetry(failed, "c2")[1]).toMatchObject({ state: "uploading", progress: 0, error: undefined });
    expect(A.uploadErrorText(new Error("x"))).toBe("Didn't upload.");
  });

  it("Make clips sends only the files that are all up", () => {
    const { chips } = A.addFiles([], [PNG(), PDF(), file("a.txt", "text/plain")], ids());
    const mixed = A.setFailed(A.setDone(chips, "c1", "uploads/u/1/logo.png"), "c3", "Didn't upload.");
    expect(A.attachmentsPayload(mixed)).toEqual([{ key: "uploads/u/1/logo.png", name: "logo.png", type: "image/png", size: 10 }]);
    expect(A.uploadingChips(mixed).map((c) => c.id)).toEqual(["c2"]);
    expect(A.failedLine(1)).toBe("1 file didn't upload. Tap Make clips again to go without it.");
  });
});

describe("the notes box's drop highlight and paste (F5)", () => {
  it("lights up only for files over the notes box", () => {
    expect(A.notesOver("file", true)).toBe(true);
    // A thumbnail with its page's link stays a link drop; a held video stays a video drop.
    expect(A.notesOver("either", true)).toBe(false);
    expect(A.notesOver("file", true, true)).toBe(false);
    expect(A.dragHasVideo({ items: [{ kind: "file", type: "video/mp4" }] as unknown as DataTransferItemList })).toBe(true);
    expect(A.dragHasVideo({ items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList })).toBe(false);
    expect(A.notesOver("link", true)).toBe(false);
    expect(A.notesOver(null, true)).toBe(false);
    expect(A.notesOver("file", false)).toBe(false);
  });

  const clip = (files: File[], data: Record<string, string> = {}) => ({
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })) as unknown as DataTransferItemList,
    files: files as unknown as FileList,
    getData: (t: string) => data[t] ?? "",
  });

  it("a pasted picture or file attaches; plain text and text from a writing app type as usual", () => {
    expect(A.pastedFiles(clip([PNG()]))).toHaveLength(1);
    expect(A.pastedFiles(clip([PNG()], { "text/html": "<img src=x>" }))).toHaveLength(1);
    expect(A.pastedFiles(clip([], { "text/plain": "hello" }))).toEqual([]);
    expect(A.pastedFiles(clip([PNG()], { "text/plain": "Some words", "text/html": "<p>Some words</p>" }))).toEqual([]);
    expect(A.pastedFiles(null)).toEqual([]);
  });

  it("a drop of only videos or things that can't be added is not taken as files for the notes", () => {
    expect(A.nonVideoFiles([file("v.mp4", "video/mp4"), PNG()]).map((f) => f.name)).toEqual(["logo.png"]);
    expect(A.anyAttachable([file("Stream clips", "")])).toBe(false);
    expect(A.anyAttachable([file("notes.txt", "text/plain")])).toBe(true);
  });
});

describe("the mock API (dev:mock)", () => {
  it("takes notes files with purpose attachment and keeps them on the job; refuses what the API refuses", async () => {
    const m = mockApi();
    const up = await m.createUpload({ filename: "rules.pdf", contentType: "application/pdf", size: 10, purpose: "attachment" });
    expect(up.key).toMatch(/^uploads\/mock-owner\/.+\/rules\.pdf$/);
    await expect(m.createUpload({ filename: "a.heic", contentType: "image/heic", size: 10, purpose: "attachment" })).rejects.toMatchObject({ status: 400, message: "That kind of file can't be added." });
    await expect(m.createUpload({ filename: "b.png", contentType: "image/png", size: 20 * MB + 1, purpose: "attachment" })).rejects.toMatchObject({ status: 413 });
    // Without purpose: video only, as before.
    await expect(m.createUpload({ filename: "rules.pdf", contentType: "application/pdf", size: 10 })).rejects.toMatchObject({ status: 400 });
    const a = { key: up.key, name: "rules.pdf", type: "application/pdf", size: 10 };
    const job = await m.createJob({ source: { type: "link", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 }, attachments: [a] });
    expect(job.attachments).toEqual([a]);
    const plain = await m.createJob({ source: { type: "link", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 } });
    expect("attachments" in plain).toBe(false);
    await expect(m.createJob({ source: { type: "link", url: "https://youtu.be/dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 }, attachments: [a, a] })).rejects.toMatchObject({ status: 400 });
    await expect(
      m.createJob({ source: { type: "link", url: "https://youtu.be/dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 }, attachments: [{ ...a, key: "uploads/someone-else/x.pdf" }] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------- The form itself ----------

let host: HTMLElement;
let root: Root;
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);

beforeEach(() => {
  for (const k of Object.keys(fake)) delete (fake as Record<string, unknown>)[k];
  puts = [];
  put.mockClear();
  clearDraft();
  let n = 0;
  fake.createUpload = vi.fn(async (b: { filename: string }) => ({ uploadId: `u${++n}`, key: `uploads/mock-owner/u${n}/${b.filename}`, uploadUrl: "https://s3.test/put", headers: {} }));
  fake.createJob = vi.fn(async () => ({ jobId: "J1" }) as never);
  history.replaceState(null, "", "/");
  // jsdom has no scrolling: Make clips coming into view after a good link is a no-op here.
  Element.prototype.scrollIntoView = () => undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mount() {
  act(() =>
    root.render(
      <ToastProvider>
        <NewJobForm />
      </ToastProvider>,
    ),
  );
}

function pick(files: File[]) {
  const input = $<HTMLInputElement>(".notes-attach input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function typeLink(url: string) {
  const input = $<HTMLInputElement>("input[type=url]")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function typeNotes(text: string) {
  const ta = $<HTMLTextAreaElement>("textarea")!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** `items`: the drag also lists its items' types, as Chrome, Edge and Firefox do while it moves. `uri`: it came with a link. */
function dragOn(el: Element, type: string, files: File[], opts: { items?: boolean; uri?: string } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const types = [...(files.length ? ["Files"] : []), ...(opts.uri ? ["text/uri-list"] : [])];
  const items = opts.items ? files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })) : [];
  Object.assign(e, {
    dataTransfer: { types, files, items, getData: (t: string) => (t === "text/uri-list" && opts.uri) || "", dropEffect: "none" },
    relatedTarget: null,
    clientX: 300,
    clientY: 300,
  });
  act(() => el.dispatchEvent(e));
  return e;
}

function pasteOn(el: Element, files: File[], data: Record<string, string> = {}) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(e, {
    clipboardData: {
      items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      files,
      getData: (t: string) => data[t] ?? "",
    },
  });
  act(() => el.dispatchEvent(e));
  return e;
}

const submit = async () => {
  act(() => $<HTMLFormElement>("form.newjob")!.requestSubmit());
  await flush();
};

describe("the notes box on Home", () => {
  it("shows Add files or images and the hint under the notes", () => {
    mount();
    expect($(".notes-attach__add")?.textContent).toBe("Add files or images");
    expect($(".notes-attach__hint")?.textContent).toBe("Logo, rules, screenshots. Up to 6 files, 20 MB each.");
    expect($(".notes-attach input")?.hasAttribute("multiple")).toBe(true);
  });

  it("uploads a picked file at once with purpose attachment, shows its progress, then its size", async () => {
    mount();
    pick([PDF()]);
    await flush();
    expect(fake.createUpload).toHaveBeenCalledWith({ filename: "rules.pdf", contentType: "application/pdf", size: 10, purpose: "attachment" });
    expect($(".attach-chip [role=progressbar]")).not.toBeNull();
    act(() => puts[0]!.progress(0.5));
    expect($(".attach-chip [role=progressbar]")?.getAttribute("aria-valuenow")).toBe("50");
    await act(async () => puts[0]!.done());
    await flush();
    expect($(".attach-chip.is-done .attach-chip__line")?.textContent).toBe("10 B");
    expect($(".attach-chip__remove")?.getAttribute("aria-label")).toBe("Remove rules.pdf");
  });

  it("says a kind it can't read", async () => {
    mount();
    pick([file("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")]);
    await flush();
    await act(async () => puts[0]!.done());
    await flush();
    // The size stays, with the line saying it is only saved (F6).
    expect($(".attach-chip .attach-chip__line")?.textContent).toBe("10 B · Saved, but Clip Factory can't read this kind of file.");
  });

  it("remove takes the chip away at once, and Undo brings it back", async () => {
    mount();
    pick([PDF()]);
    await flush();
    await act(async () => puts[0]!.done());
    await flush();
    act(() => $<HTMLButtonElement>(".attach-chip__remove")!.click());
    expect($(".attach-chip")).toBeNull();
    const undo = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Undo"));
    expect(undo).toBeDefined();
    act(() => undo!.click());
    expect($(".attach-chip.is-done")?.textContent).toContain("rules.pdf");
  });

  it("a failed file shows its error and Try again, and keeps the other chips and the notes", async () => {
    mount();
    typeNotes("Say hi to Marco");
    pick([PNG(), PDF()]);
    await flush();
    await act(async () => puts[0]!.done());
    await act(async () => puts[1]!.fail({ status: 500 }));
    await flush();
    expect($(".attach-chip.is-done")?.textContent).toContain("logo.png");
    expect($(".attach-chip.is-failed")?.textContent).toContain("Didn't upload.");
    expect($<HTMLTextAreaElement>("textarea")!.value).toBe("Say hi to Marco");
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => again.click());
    await flush();
    expect(puts).toHaveLength(3);
    expect($(".attach-chip.is-failed")).toBeNull();
  });

  it("a pasted picture attaches; a plain text paste is left to type", async () => {
    mount();
    const ta = $("textarea")!;
    const text = pasteOn(ta, [], { "text/plain": "hello" });
    expect(text.defaultPrevented).toBe(false);
    expect(fake.createUpload).not.toHaveBeenCalled();
    const pic = pasteOn(ta, [file("image.png", "image/png")]);
    expect(pic.defaultPrevented).toBe(true);
    await flush();
    expect($(".attach-chip")?.textContent).toContain("image.png");
  });

  it("a file held over the notes box lights it up (and not the card's overlay); dropping attaches it", async () => {
    mount();
    const box = $("[data-notes-drop]")!;
    const ta = $("textarea")!;
    dragOn(ta, "dragenter", [PNG()]);
    const over = dragOn(ta, "dragover", [PNG()]);
    expect(over.defaultPrevented).toBe(true);
    expect(box.classList.contains("is-over")).toBe(true);
    expect($(".newjob__drop")).toBeNull();
    expect($(".notes-field__drop")?.textContent).toBe("Drop to add");
    dragOn(ta, "drop", [PNG()]);
    expect(box.classList.contains("is-over")).toBe(false);
    await flush();
    expect($(".attach-chip")?.textContent).toContain("logo.png");
  });

  it("a non-video file dropped elsewhere on the card attaches; a video still goes in Pick a video", async () => {
    mount();
    dragOn($("form.newjob")!, "drop", [PDF()]);
    await flush();
    expect($(".attach-chip")?.textContent).toContain("rules.pdf");
    dragOn($("form.newjob")!, "drop", [file("trick.mp4", "video/mp4")]);
    await flush();
    expect($(".dropzone.has-file")?.textContent).toContain("trick.mp4");
    expect(host.querySelectorAll(".attach-chip")).toHaveLength(1);
  });

  it("a video held over the notes box shows the card's video highlight, not Drop to add", () => {
    mount();
    const box = $("[data-notes-drop]")!;
    const ta = $("textarea")!;
    const clip = file("clip.mp4", "video/mp4");
    dragOn(ta, "dragenter", [clip], { items: true });
    dragOn(ta, "dragover", [clip], { items: true });
    expect(box.classList.contains("is-over")).toBe(false);
    expect($(".newjob__drop")?.textContent).toContain("Drop your video here");
  });

  it("a thumbnail with its page's link dropped on the notes box fills the link bar, as before", async () => {
    mount();
    const ta = $("textarea")!;
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const thumb = file("hqdefault.jpg", "image/jpeg");
    dragOn(ta, "dragover", [thumb], { uri: url });
    expect($("[data-notes-drop]")!.classList.contains("is-over")).toBe(false);
    dragOn(ta, "drop", [thumb], { uri: url });
    await flush();
    expect($<HTMLInputElement>("input[type=url]")?.value).toBe(url);
    expect($(".attach-chip")).toBeNull();
    expect(fake.createUpload).not.toHaveBeenCalled();
  });

  it("a video dropped with a picture: the video is picked and the picture added, with no one-video line", async () => {
    mount();
    dragOn($("textarea")!, "drop", [file("clip.mp4", "video/mp4"), PNG()]);
    await flush();
    expect($(".dropzone.has-file")?.textContent).toContain("clip.mp4");
    expect($(".attach-chip")?.textContent).toContain("logo.png");
    expect(document.body.textContent).not.toContain("One video per job");
  });

  it("a dropped thing that can't be added still says it is not a video", async () => {
    mount();
    dragOn($("form.newjob")!, "drop", [file("Stream clips", "")]);
    await flush();
    expect($(".field__status.is-bad")?.textContent).toBe("That is not a video. Drop an MP4, MOV or WebM video.");
    expect($(".attach-chip")).toBeNull();
  });
});

describe("Make clips with files (F7)", () => {
  it("waits for files still going up, then sends only the finished ones with the job", async () => {
    mount();
    typeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    pick([PNG()]);
    await flush();
    await submit();
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Adding your files…");
    await act(async () => puts[0]!.done());
    await flush();
    await flush();
    const body = vi.mocked(fake.createJob!).mock.calls[0]![0] as NewJob;
    expect(body.attachments).toEqual([{ key: "uploads/mock-owner/u1/logo.png", name: "logo.png", type: "image/png", size: 10 }]);
  });

  it("sends no attachments field without files", async () => {
    mount();
    typeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await submit();
    const body = vi.mocked(fake.createJob!).mock.calls[0]![0] as NewJob;
    expect("attachments" in body).toBe(false);
  });

  it("with a failed file: says so once; pressed again it goes on without it", async () => {
    mount();
    typeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    pick([PNG(), PDF()]);
    await flush();
    await act(async () => puts[0]!.done());
    await act(async () => puts[1]!.fail({ status: 500 }));
    await flush();
    await submit();
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 file didn't upload. Tap Make clips again to go without it.");
    await submit();
    const body = vi.mocked(fake.createJob!).mock.calls[0]![0] as NewJob;
    expect(body.attachments?.map((a) => a.name)).toEqual(["logo.png"]);
  });
});

describe("adding while the video goes up (F5, F7)", () => {
  it("drop, paste and Add files still work while the video uploads; the files go with the job", async () => {
    mount();
    dragOn($("form.newjob")!, "drop", [file("clip.mp4", "video/mp4")]);
    await flush();
    await submit();
    expect(puts.map((p) => p.name)).toEqual(["clip.mp4"]);
    const box = $("[data-notes-drop]")!;
    dragOn($("textarea")!, "dragover", [PNG()]);
    expect(box.classList.contains("is-over")).toBe(true);
    expect($(".newjob__drop")).toBeNull();
    dragOn($("textarea")!, "drop", [PNG()]);
    const pasted = pasteOn($("textarea")!, [PDF()]);
    expect(pasted.defaultPrevented).toBe(true);
    await flush();
    expect($<HTMLInputElement>(".notes-attach input[type=file]")?.disabled).toBe(false);
    expect(host.querySelectorAll(".attach-chip")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Cancel upload first");
    await act(async () => puts[0]!.done());
    await flush();
    expect(fake.createJob).not.toHaveBeenCalled(); // it waits for the two files
    await act(async () => puts[1]!.done());
    await act(async () => puts[2]!.done());
    await flush();
    await flush();
    const body = vi.mocked(fake.createJob!).mock.calls[0]![0] as NewJob;
    expect(body.attachments?.map((a) => a.name).sort()).toEqual(["logo.png", "rules.pdf"]);
  });
});

describe("a failed file tried again (F7)", () => {
  it("fails again after Try again: Make clips says so again before going on", async () => {
    mount();
    typeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    pick([PNG()]);
    await flush();
    await act(async () => puts[0]!.fail({ status: 500 }));
    await flush();
    await submit();
    expect(host.textContent).toContain("1 file didn't upload.");
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => again.click());
    await flush();
    expect(host.textContent).not.toContain("1 file didn't upload.");
    await act(async () => puts[1]!.fail({ status: 500 }));
    await flush();
    await submit();
    expect(fake.createJob).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 file didn't upload.");
    await submit();
    expect(fake.createJob).toHaveBeenCalledTimes(1);
  });
});

describe("the draft (F7)", () => {
  it("keeps finished files as {key, name, type, size} and brings them back as chips", async () => {
    mount();
    pick([PNG()]);
    await flush();
    await act(async () => puts[0]!.done());
    await flush();
    expect(readDraft()?.attachments).toEqual([{ key: "uploads/mock-owner/u1/logo.png", name: "logo.png", type: "image/png", size: 10 }]);
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect($(".attach-chip.is-done")?.textContent).toContain("logo.png");
  });

  it("an untouched form with no files keeps nothing", () => {
    saveDraft({ link: "", notes: "", count: "range", exact: 6, attachments: [] });
    expect(readDraft()).toBeNull();
  });
});
