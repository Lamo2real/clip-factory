// Ask as a full assistant (docs/CONTRACTS.md §27): files, the markup model, the streamed answer, running one question,
// the chat memory, the API client and the markdown additions.
import { describe, expect, it, vi } from "vitest";
import { askApi, trimHistory, type AskApi, type AskHttp, type AskTurn } from "../src/features/help/askApi.ts";
import { applyEvent, liveLink, newAnswer, parseAskEvent, runAsk, type AskConnection, type AskEvent } from "../src/features/help/askStream.ts";
import { askHistory, chatReducer, initialChat, liveUrls, readyFiles, type ChatState, type TrayFile } from "../src/features/help/chatState.ts";
import { addedText, carriedFiles, classify, FILE_TEXT, fileIcon, formatLabel, pastedTextFile, sizeLabel, type AskFile } from "../src/features/help/files.ts";
import {
  addPoint,
  addStroke,
  arrowHead,
  clearMarks,
  emptyMarks,
  inkWidth,
  moveCursor,
  pointerRole,
  redoMarks,
  smoothPath,
  undoMarks,
  zoomAt,
  type Stroke,
} from "../src/features/help/markup.ts";
import { parseMarkdown } from "../src/lib/markdown.ts";

// ---------- files ----------

describe("files", () => {
  it("labels formats by extension, then type, else FILE", () => {
    expect(formatLabel("report.pdf", "application/pdf")).toBe("PDF");
    expect(formatLabel("notes.docx", "")).toBe("DOCX");
    expect(formatLabel("data", "text/csv")).toBe("CSV");
    expect(formatLabel("weird.extension", "application/vnd.ms-whatever")).toBe("FILE");
    expect(formatLabel(".env", "")).toBe("ENV");
  });

  it("knows each kind, and refuses what it can't read with a note that says what to do", () => {
    expect(classify({ name: "a.png", type: "image/png" })).toEqual({ kind: "image" });
    expect(classify({ name: "IMG_1.HEIC", type: "" })).toEqual({ kind: "image" });
    expect(classify({ name: "a.pdf", type: "" })).toEqual({ kind: "pdf" });
    expect(classify({ name: "main.tf", type: "" })).toEqual({ kind: "text" });
    expect(classify({ name: "deck.pptx", type: "" })).toEqual({ kind: "office" });
    expect(classify({ name: "a.zip", type: "application/zip" })).toEqual({ refused: FILE_TEXT.zip });
    expect(classify({ name: "a.doc", type: "" })).toEqual({ refused: FILE_TEXT.doc });
    expect(classify({ name: "clip.mp4", type: "video/mp4" })).toEqual({ refused: FILE_TEXT.video });
    expect(classify({ name: "app.exe", type: "application/octet-stream" })).toEqual({ refused: FILE_TEXT.other });
  });

  it("has an icon per kind and a plain size", () => {
    expect(fileIcon("pdf", "PDF")).toBe("filePdf");
    expect(fileIcon("office", "XLSX")).toBe("fileTable");
    expect(fileIcon("text", "PY")).toBe("fileCode");
    expect(fileIcon("office", "DOCX")).toBe("fileText");
    expect(sizeLabel(2_400_000)).toBe("2.4 MB");
    expect(sizeLabel(320_000)).toBe("320 KB");
    expect(sizeLabel(1)).toBe("1 byte");
  });

  it("turns long pasted text into a TXT file", async () => {
    const f = pastedTextFile("x".repeat(5000));
    expect(f.name).toBe("Pasted text.txt");
    expect(formatLabel(f.name, f.type)).toBe("TXT");
    expect(await f.text()).toHaveLength(5000);
  });

  const file = (id: number, kind: AskFile["kind"] = "pdf", size = 10): AskFile => ({ id, kind, name: `f${id}`, format: "PDF", size, blob: new Blob(["x"]) });

  it("carries the files of the last two questions that had files, within the limits", () => {
    const turns = [{ files: [file(1)] }, { files: [file(2), file(3, "image")] }, {}, { files: [file(4)] }];
    expect(carriedFiles(turns, []).map((f) => f.id)).toEqual([4, 2, 3]);
    expect(carriedFiles(turns, [file(9)], { files: 2, bytes: 1000, images: 8 }).map((f) => f.id)).toEqual([4]);
    expect(carriedFiles(turns, [], { files: 10, bytes: 15, images: 8 }).map((f) => f.id)).toEqual([4]);
    expect(carriedFiles(turns, [], { files: 10, bytes: 1000, images: 0 }).map((f) => f.id)).toEqual([4, 2]);
  });
});

// ---------- the markup model ----------

describe("markup", () => {
  const pen = (n: number): Stroke => ({ tool: "pen", points: [{ x: n, y: n }], width: 4 });

  it("undo, redo and clear (clear can be undone)", () => {
    let m = addStroke(addStroke(emptyMarks(), pen(1)), pen(2));
    expect(m.strokes).toHaveLength(2);
    m = undoMarks(m);
    expect(m.strokes).toHaveLength(1);
    m = redoMarks(m);
    expect(m.strokes).toHaveLength(2);
    m = clearMarks(m);
    expect(m.strokes).toHaveLength(0);
    m = undoMarks(m);
    expect(m.strokes).toHaveLength(2);
    expect(undoMarks(emptyMarks())).toEqual(emptyMarks());
  });

  it("smooths a pen stroke through midpoints and drops tiny moves", () => {
    const path = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(path.curves).toEqual([{ c: { x: 10, y: 0 }, to: { x: 10, y: 5 } }]);
    expect(addPoint([{ x: 0, y: 0 }], { x: 0.5, y: 0 })).toHaveLength(1);
    expect(addPoint([{ x: 0, y: 0 }], { x: 5, y: 0 })).toHaveLength(2);
  });

  it("sizes ink from the picture and the pen's pressure", () => {
    expect(inkWidth(1568, 900)).toBeCloseTo(9.408);
    expect(inkWidth(300, 200)).toBe(4);
    expect(inkWidth(1000, 1000, "pen", 1)).toBeCloseTo(8.4);
    expect(inkWidth(1000, 1000, "pen", 0.25)).toBeCloseTo(4.8);
    expect(inkWidth(1000, 1000, "touch", 1)).toBe(6);
  });

  it("two fingers never draw; a finger pans while a pen is in use", () => {
    expect(pointerRole("touch", 2, false)).toBe("pinch");
    expect(pointerRole("touch", 1, true)).toBe("pan");
    expect(pointerRole("touch", 1, false)).toBe("draw");
    expect(pointerRole("pen", 1, true)).toBe("draw");
    expect(pointerRole("mouse", 0, false)).toBe("draw");
  });

  it("zooms around a point (1 to 4 times) and moves the keyboard crosshair within the picture", () => {
    const z = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: 100 });
    expect(z).toEqual({ zoom: 2, x: -100, y: -100 });
    expect(zoomAt({ zoom: 4, x: 0, y: 0 }, 2, { x: 0, y: 0 }).zoom).toBe(4);
    expect(moveCursor({ x: 0, y: 0 }, "ArrowLeft", false, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(moveCursor({ x: 100, y: 100 }, "ArrowRight", true, 800, 600)).toEqual({ x: 140, y: 100 });
    expect(moveCursor({ x: 1, y: 1 }, "Enter", false, 800, 600)).toBeNull();
  });

  it("draws an arrow head at the end", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(Math.sign(a.y)).toBe(-Math.sign(b.y));
  });
});

// ---------- the streamed answer ----------

const ev = (e: Record<string, unknown>) => parseAskEvent({ askId: "A", ...e }, "A")!;

describe("the streamed answer", () => {
  it("joins deltas in seq order, whatever order they arrive in", () => {
    let a = newAnswer("A");
    for (const e of [ev({ type: "ask.delta", seq: 2, text: "world" }), ev({ type: "ask.delta", seq: 1, text: "Hello " }), ev({ type: "ask.delta", seq: 1, text: "dup" })])
      a = applyEvent(a, e);
    expect(a.text).toBe("Hello world");
    expect(a.status).toBeNull();
  });

  it("ignores another answer's events and malformed ones", () => {
    expect(parseAskEvent({ askId: "B", type: "ask.delta", seq: 1, text: "x" }, "A")).toBeNull();
    expect(parseAskEvent({ askId: "A", type: "ask.delta", seq: "1", text: "x" }, "A")).toBeNull();
    expect(parseAskEvent({ askId: "A", type: "ask.done", stop: "whatever" }, "A")).toBeNull();
    expect(parseAskEvent({ askId: "A", type: "job" }, "A")).toBeNull();
  });

  it("makes links live only after done, and only the listed https URLs", () => {
    let a = applyEvent(newAnswer("A"), ev({ type: "ask.delta", seq: 1, text: "see [x](https://a.example/x)" }));
    expect(liveLink("https://a.example/x", a.done)).toBe(false);
    a = applyEvent(a, ev({ type: "ask.done", stop: "end", links: ["https://a.example/x", "http://plain.example/"] }));
    expect(liveLink("https://a.example/x", a.done)).toBe(true);
    expect(liveLink("https://evil.example/", a.done)).toBe(false);
    expect(liveLink("http://plain.example/", a.done)).toBe(false);
  });

  it("keeps status, sources, buttons and unread files", () => {
    let a = newAnswer("A");
    a = applyEvent(a, ev({ type: "ask.status", kind: "reading", label: "Reading meta.com…" }));
    expect(a.status).toEqual({ kind: "reading", label: "Reading meta.com…" });
    a = applyEvent(a, ev({ type: "ask.sources", sources: [{ n: 1, kind: "web", title: "T", url: "https://m.example" }] }));
    a = applyEvent(a, ev({ type: "ask.actions", actions: [{ id: "x", label: "Open", to: "/" }, { id: "y", label: "Y", to: "/" }, { id: "z", label: "Z", to: "/" }] }));
    a = applyEvent(a, ev({ type: "ask.files", files: [{ fileId: "F", read: false, why: "too_long" }] }));
    expect(a.sources).toHaveLength(1);
    expect(a.actions).toHaveLength(2);
    expect(a.files.F).toEqual({ fileId: "F", read: false, why: "too_long" });
  });
});

// ---------- running one question ----------

function fakeConn(id: string | null = "conn-1") {
  const listeners = new Set<(m: Record<string, unknown>) => void>();
  const conn: AskConnection & { emit(m: Record<string, unknown>): void } = {
    whoami: vi.fn(async () => id),
    onRaw: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (m) => listeners.forEach((fn) => fn(m)),
  };
  return conn;
}

function fakeApi(over: Partial<AskApi> = {}): AskApi {
  return {
    presign: vi.fn(async (files: { name: string; type: string; size: number }[]) => ({ kind: "ok" as const, files: files.map((_f, i) => ({ fileId: `F${i}`, url: `u${i}`, headers: {}, expiresIn: 300 })) })),
    upload: vi.fn(async (_f, _b, onProgress) => {
      onProgress(1);
      return true;
    }),
    deleteFile: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ kind: "started" as const })),
    stop: vi.fn(async () => undefined),
    putSearchKey: vi.fn(async () => "ok" as const),
    deleteSearchKey: vi.fn(async () => true),
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const body = { question: "hi", context: { device: "desktop" as const, os: "mac" as const, installed: false, page: "home" as const } };

describe("runAsk", () => {
  it("streams events until done", async () => {
    const conn = fakeConn();
    const events: AskEvent[] = [];
    const run = runAsk({ api: fakeApi(), conn, uuid: () => "A" }, body, [], { onEvent: (e) => events.push(e) });
    await flush();
    await flush();
    conn.emit({ askId: "A", type: "ask.started" });
    conn.emit({ askId: "A", type: "ask.delta", seq: 1, text: "Hi" });
    conn.emit({ askId: "OTHER", type: "ask.delta", seq: 1, text: "no" });
    conn.emit({ askId: "A", type: "ask.done", stop: "end", links: [] });
    expect(await run.done).toEqual({ kind: "streamed" });
    expect(events.map((e) => e.type)).toEqual(["ask.started", "ask.delta", "ask.done"]);
  });

  it("falls back to the plain answer when the socket is not there", async () => {
    const run = runAsk({ api: fakeApi(), conn: fakeConn(null), uuid: () => "A" }, body, [], { onEvent: () => undefined });
    expect(await run.done).toEqual({ kind: "fallback", reason: "no_socket" });
  });

  it("falls back when nothing starts in time, and when the model fails before any words", async () => {
    vi.useFakeTimers();
    try {
      const run = runAsk({ api: fakeApi(), conn: fakeConn(), uuid: () => "A" }, body, [], { onEvent: () => undefined });
      await vi.advanceTimersByTimeAsync(8100);
      expect(await run.done).toEqual({ kind: "fallback", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
    const conn = fakeConn();
    const run2 = runAsk({ api: fakeApi(), conn, uuid: () => "B" }, body, [], { onEvent: () => undefined });
    await flush();
    await flush();
    conn.emit({ askId: "B", type: "ask.error", code: "model", message: "x" });
    expect(await run2.done).toEqual({ kind: "fallback", reason: "model" });
  });

  it("ends a cut answer where it is when the model fails after words", async () => {
    const conn = fakeConn();
    const events: AskEvent[] = [];
    const run = runAsk({ api: fakeApi(), conn, uuid: () => "A" }, body, [], { onEvent: (e) => events.push(e) });
    await flush();
    await flush();
    conn.emit({ askId: "A", type: "ask.delta", seq: 1, text: "Half" });
    conn.emit({ askId: "A", type: "ask.error", code: "model", message: "x" });
    expect(await run.done).toEqual({ kind: "streamed" });
    expect(events.at(-1)).toMatchObject({ type: "ask.done", stop: "error" });
  });

  it("asks again once with a fresh connection id after 409 not_live", async () => {
    const start = vi.fn().mockResolvedValueOnce({ kind: "not_live" }).mockResolvedValueOnce({ kind: "started" });
    const conn = fakeConn();
    const run = runAsk({ api: fakeApi({ start }), conn, uuid: () => "A" }, body, [], { onEvent: () => undefined });
    await flush();
    await flush();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(conn.whoami).toHaveBeenCalledTimes(2);
    conn.emit({ askId: "A", type: "ask.done", stop: "end", links: [] });
    expect(await run.done).toEqual({ kind: "streamed" });
  });

  it("uploads files with progress before it starts, and Stop asks the server to stop", async () => {
    const api = fakeApi();
    const conn = fakeConn();
    const progress: number[] = [];
    const file = { id: 7, name: "r.pdf", type: "application/pdf", size: 3, blob: new Blob(["abc"]), format: "PDF", kind: "pdf" as const, carried: true };
    const run = runAsk({ api, conn, uuid: () => "A" }, body, [file], { onEvent: () => undefined, onUpload: (_id, f) => progress.push(f) });
    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(vi.mocked(api.start).mock.calls[0]![0].files).toEqual([{ fileId: "F0", name: "r.pdf", format: "PDF", kind: "pdf", carried: true }]);
    expect(progress).toEqual([1]);
    run.stop();
    expect(api.stop).toHaveBeenCalledWith("A");
    conn.emit({ askId: "A", type: "ask.done", stop: "stopped", links: [] });
    expect(await run.done).toEqual({ kind: "stopped" });
  });

  it("says when a refused, rate-limited or bad question could not go", async () => {
    for (const [res, want] of [
      [{ kind: "refused", text: "No." }, { kind: "refused", text: "No." }],
      [{ kind: "rate_limited", retryAfter: 5 }, { kind: "rate_limited", retryAfter: 5 }],
      [{ kind: "off" }, { kind: "fallback", reason: "off" }],
    ] as const) {
      const run = runAsk({ api: fakeApi({ start: async () => res }), conn: fakeConn(), uuid: () => "A" }, body, [], { onEvent: () => undefined });
      expect(await run.done).toEqual(want);
    }
    const failing = fakeApi({ upload: async () => false });
    const file = { id: 1, name: "a.txt", type: "text/plain", size: 1, blob: new Blob(["a"]), format: "TXT", kind: "text" as const, carried: false };
    expect(await runAsk({ api: failing, conn: fakeConn(), uuid: () => "A" }, body, [file], { onEvent: () => undefined }).done).toEqual({ kind: "upload_failed" });
  });
});

// ---------- the chat memory ----------

describe("chat memory (§27)", () => {
  const tf = (id: number, kind: TrayFile["kind"] = "pdf"): TrayFile => ({
    id,
    kind,
    name: `f${id}.pdf`,
    format: "PDF",
    size: 5,
    blob: new Blob(["hello"]),
    ...(kind === "image" ? { url: `blob:${id}`, width: 10, height: 10 } : {}),
  });

  it("moves tray files into the question, streams the answer, and gives the history back as text", () => {
    let s: ChatState = initialChat;
    s = chatReducer(s, { type: "tray_file", file: tf(1) });
    s = chatReducer(s, { type: "tray_ready", pic: tf(2, "image") });
    expect(readyFiles(s)).toHaveLength(1); // the picture was never added as busy
    s = chatReducer(s, { type: "tray_add", id: 2 });
    s = chatReducer(s, { type: "tray_ready", pic: tf(2, "image") });
    s = chatReducer(s, { type: "ask", id: 10, text: "what is this?", files: readyFiles(s) });
    expect(s.tray).toEqual([]);
    s = chatReducer(s, { type: "ai_start", id: 11, askId: "A" });
    expect(s.streaming).toBe(11);
    s = chatReducer(s, { type: "ai_event", entryId: 11, event: { type: "ask.delta", askId: "A", seq: 1, text: "A PDF." } });
    s = chatReducer(s, { type: "ai_event", entryId: 11, event: { type: "ask.done", askId: "A", stop: "end", links: [] } });
    s = chatReducer(s, { type: "ai_end", entryId: 11 });
    expect(s.streaming).toBeNull();
    const turns: AskTurn[] = askHistory(s.entries);
    expect(turns).toEqual([
      { role: "user", text: "what is this?", files: [{ name: "f1.pdf", format: "PDF" }, { name: "f2.pdf", format: "PDF" }] },
      { role: "assistant", text: "A PDF." },
    ]);
    expect(liveUrls(s)).toEqual(new Set(["blob:2"]));
  });

  it("drops an answer that never got a word, and keeps a marked picture's original until it is sent", () => {
    let s = chatReducer(initialChat, { type: "ai_start", id: 1, askId: "A" });
    s = chatReducer(s, { type: "ai_end", entryId: 1 });
    expect(s.entries).toEqual([]);
    s = chatReducer(s, { type: "tray_file", file: tf(5, "image") });
    s = chatReducer(s, { type: "tray_marked", id: 5, blob: new Blob(["m"]), url: "blob:marked", width: 10, height: 10, strokes: [{ tool: "box", from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, width: 4 }], original: { blob: new Blob(["o"]), url: "blob:5", width: 10, height: 10 } });
    expect(liveUrls(s)).toEqual(new Set(["blob:marked", "blob:5"]));
    s = chatReducer(s, { type: "ask", id: 6, text: "", files: readyFiles(s) });
    expect(liveUrls(s)).toEqual(new Set(["blob:marked"]));
    const sent = s.entries.find((e) => e.role === "user");
    expect(sent?.role === "user" && sent.files?.[0]?.marked).toBe(true);
  });

  it("lets go of old files past 30 files", () => {
    let s = initialChat;
    for (let q = 0; q < 4; q++) s = chatReducer(s, { type: "ask", id: 100 + q, text: "", files: Array.from({ length: 10 }, (_, i) => tf(q * 100 + i)) });
    const kept = s.entries.flatMap((e) => (e.role === "user" ? (e.files ?? []) : [])).filter((f) => f.blob);
    expect(kept).toHaveLength(30);
  });
});

// ---------- the API client ----------

describe("askApi", () => {
  it("keeps history under 90,000 letters, oldest first out, starting with the owner", () => {
    const turns: AskTurn[] = [];
    for (let i = 0; i < 30; i++) turns.push({ role: i % 2 ? "assistant" : "user", text: "x".repeat(i % 2 ? 12_500 : 4_500) });
    const kept = trimHistory(turns);
    expect(kept.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(90_000);
    expect(kept[0]!.role).toBe("user");
    expect(kept.at(-1)).toEqual({ role: "assistant", text: "x".repeat(12_000) });
  });

  it("reads 202, 409, 429, 400 and the refused answer", async () => {
    const replies: AskHttp[] = [
      { status: 202, retryAfter: null, body: { askId: "A" } },
      { status: 409, retryAfter: null, body: { error: { code: "not_live" } } },
      { status: 429, retryAfter: 7, body: { error: { code: "rate_limited" } } },
      { status: 400, retryAfter: null, body: { error: { code: "bad_request", message: "Too long." } } },
      { status: 200, retryAfter: null, body: { askId: "A", refused: true, text: "No." } },
    ];
    const api = askApi({ transport: async () => replies.shift()!, upload: async () => true, auth: { accessToken: async () => "t" } });
    const b = { askId: "A", connectionId: "c", question: "q", context: body.context };
    expect(await api.start(b)).toEqual({ kind: "started" });
    expect(await api.start(b)).toEqual({ kind: "not_live" });
    expect(await api.start(b)).toEqual({ kind: "rate_limited", retryAfter: 7 });
    expect(await api.start(b)).toEqual({ kind: "bad_request", message: "Too long." });
    expect(await api.start(b)).toEqual({ kind: "refused", text: "No." });
  });

  it("never sends the search key anywhere but its own route, and says when it was refused", async () => {
    const seen: string[] = [];
    const api = askApi({
      transport: async (method, path) => {
        seen.push(`${method} ${path}`);
        return { status: 400, retryAfter: null, body: null };
      },
      upload: async () => true,
      auth: { accessToken: async () => "t" },
    });
    expect(await api.putSearchKey("k")).toBe("bad");
    expect(seen).toEqual(["PUT /help/search-key"]);
  });
});

// ---------- markdown ----------

describe("markdown for answers", () => {
  it("reads GFM tables with alignment", () => {
    const doc = parseMarkdown("| What | How much |\n| :--- | ---: |\n| Garlic | 3 |\n| Oil \\| fat | 4 |");
    const t = doc.blocks[0]!;
    expect(t.t).toBe("table");
    if (t.t !== "table") return;
    expect(t.align).toEqual(["left", "right"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]![0]).toEqual([{ t: "text", v: "Oil | fat" }]);
  });

  it("still reads a plain paragraph with a pipe as a paragraph", () => {
    expect(parseMarkdown("a | b").blocks[0]!.t).toBe("p");
  });
});

// ---------- review fixes (2026-11-19) ----------

describe("review fixes", () => {
  const pdf = (id: number) => ({ id, name: `r${id}.pdf`, type: "application/pdf", size: 3, blob: new Blob(["abc"]), format: "PDF", kind: "pdf" as const, carried: false });

  it("takes uploaded files away on every ending where the question did not start (A2)", async () => {
    const endings = [
      { kind: "rate_limited", retryAfter: 5 },
      { kind: "bad_request", message: "no" },
      { kind: "off" },
      { kind: "error" },
      { kind: "refused", text: "No." },
    ] as const;
    for (const res of endings) {
      const api = fakeApi({ start: async () => res });
      await runAsk({ api, conn: fakeConn(), uuid: () => "A" }, body, [pdf(1), pdf(2)], { onEvent: () => undefined }).done;
      expect(vi.mocked(api.deleteFile).mock.calls.map((c) => c[0]).sort()).toEqual(["F0", "F1"]);
    }
    // 409 twice: the retry failed too.
    const api = fakeApi({ start: async () => ({ kind: "not_live" }) });
    const conn = fakeConn();
    vi.mocked(conn.whoami).mockResolvedValueOnce("conn-1").mockResolvedValueOnce(null);
    expect(await runAsk({ api, conn, uuid: () => "A" }, body, [pdf(1)], { onEvent: () => undefined }).done).toEqual({ kind: "fallback", reason: "no_socket" });
    expect(api.deleteFile).toHaveBeenCalledWith("F0");
    // One upload failed after the others went up: all are taken away.
    const half = fakeApi({ upload: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    expect(await runAsk({ api: half, conn: fakeConn(), uuid: () => "A" }, body, [pdf(1), pdf(2)], { onEvent: () => undefined }).done).toEqual({ kind: "upload_failed" });
    expect(vi.mocked(half.deleteFile).mock.calls.map((c) => c[0]).sort()).toEqual(["F0", "F1"]);
  });

  it("takes files away when Stop is pressed during the upload, never after the server took them", async () => {
    let release: (ok: boolean) => void = () => undefined;
    const api = fakeApi({ upload: vi.fn(() => new Promise<boolean>((r) => (release = r))) });
    const run = runAsk({ api, conn: fakeConn(), uuid: () => "A" }, body, [pdf(1)], { onEvent: () => undefined });
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalled());
    run.stop();
    release(true);
    expect(await run.done).toEqual({ kind: "stopped" });
    expect(api.deleteFile).toHaveBeenCalledWith("F0");

    const started = fakeApi();
    const conn = fakeConn();
    const run2 = runAsk({ api: started, conn, uuid: () => "B" }, body, [pdf(1)], { onEvent: () => undefined });
    await vi.waitFor(() => expect(started.start).toHaveBeenCalled());
    await flush();
    conn.emit({ askId: "B", type: "ask.done", stop: "end", links: [] });
    await run2.done;
    expect(started.deleteFile).not.toHaveBeenCalled(); // the worker deletes them
  });

  it("stops the server when the panel times out (B7)", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      const conn = fakeConn();
      const run = runAsk({ api, conn, uuid: () => "A" }, body, [], { onEvent: () => undefined });
      await vi.advanceTimersByTimeAsync(10);
      conn.emit({ askId: "A", type: "ask.started" });
      conn.emit({ askId: "A", type: "ask.delta", seq: 1, text: "Half" });
      await vi.advanceTimersByTimeAsync(46_000);
      expect(await run.done).toEqual({ kind: "streamed" });
      expect(api.stop).toHaveBeenCalledWith("A");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends an answer's web sources with the history, so a follow-up can open them (B11)", () => {
    let s = chatReducer(initialChat, { type: "ask", id: 1, text: "Meta app review?" } as never);
    s = chatReducer(s, { type: "ai_start", id: 2, askId: "A" } as never);
    s = chatReducer(s, { type: "ai_event", entryId: 2, event: { type: "ask.delta", askId: "A", seq: 1, text: "See [1]." } } as never);
    const sources = [
      { n: 1, kind: "web", title: "App Review", url: "https://developers.facebook.com/docs/x" },
      { n: 2, kind: "file", title: "r.pdf", file: "r.pdf" },
    ];
    s = chatReducer(s, { type: "ai_event", entryId: 2, event: { type: "ask.sources", askId: "A", sources } } as never);
    const turns = askHistory(s.entries);
    const answer = turns.find((t) => t.role === "assistant");
    expect(answer?.sources).toEqual([{ title: "App Review", url: "https://developers.facebook.com/docs/x" }]);
    const trimmed = trimHistory([{ role: "user", text: "q" }, { role: "assistant", text: "a", sources: [{ title: "x", url: "http://plain.example/" }, { title: "y", url: "https://ok.example/" }] }]);
    expect(trimmed[1]!.sources).toEqual([{ title: "y", url: "https://ok.example/" }]);
  });

  it("a screen reader hears how many files a drop added (C11)", () => {
    expect(addedText("PDF", 1)).toBe("PDF file added. 1 of 10.");
    expect(addedText("IMAGE", 3, 3)).toBe("3 files added. 3 of 10.");
  });
});
