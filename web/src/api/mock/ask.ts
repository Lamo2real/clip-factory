// Ask as a full assistant in mock mode (docs/CONTRACTS.md §28.14): POST /v1/help/files, the presigned PUT (kept in
// memory so tests can read the bytes the browser sent), POST /v1/help/asks and Stop, the search key, and a fake
// worker that streams `ask.*` events over the mock WebSocket. Deterministic; nothing leaves the machine.
//
// Magic words, for tests only: #nokey (web search not set up), #search (searching and reading statuses), #slow
// (first words after 9 s, so the panel falls back), #long (a long answer), #hold (some words, then it waits for Stop, at
// most a minute), #cut (an error after some words), #refuse, #gone (the socket
// drops), #429, #503, #off (assistant off: the §19 answer) and #budget (out of time).
import { loadCorpus } from "../../features/help/kb.ts";
import { rank } from "../../features/help/retrieve.ts";
import type { AskFileRef, AskHttp, AskStartBody, AskTransport, PresignedFile, Uploader } from "../../features/help/askApi.ts";
import type { HelpContext } from "../../features/help/types.ts";
import { mockLive } from "./live.ts";

export const MOCK_WEB = "https://developers.example.test";
export const DELTA_CHARS = 20;
export const DELTA_MS = 40;

export interface MockAskFile {
  fileId: string;
  name: string;
  type: string;
  size: number;
  bytes?: Uint8Array;
}

export interface MockAskState {
  /** Presigned files and, once PUT, their bytes (tests read them back). */
  files: Record<string, MockAskFile>;
  /** Each start body (questions included: this is a test double, nothing is stored anywhere real). */
  starts: AskStartBody[];
  stops: string[];
  searchKey: boolean;
}

declare global {
  interface Window {
    __cfMockAsk?: MockAskState;
  }
}

const state = (): MockAskState => {
  const w = typeof window !== "undefined" ? window : ({} as Window);
  return (w.__cfMockAsk ??= { files: {}, starts: [], stops: [], searchKey: true });
};

/** Whether the assistant is on in this mock build (tests turn it off to exercise the §19 path). */
export function mockAssistantOn(): boolean {
  try {
    return localStorage.getItem("cf-mock-assistant") !== "off";
  } catch {
    return true;
  }
}

let fileSeq = 0;
const ok = (status: number, body: unknown = null, retryAfter: number | null = null): AskHttp => ({ status, retryAfter, body });
const err = (status: number, code: string, message: string, retryAfter: number | null = null): AskHttp => ok(status, { error: { code, message, ...(retryAfter ? { retryAfter } : {}) } }, retryAfter);

export function mockAskTransport(): AskTransport {
  return async (method, path, body, token) => {
    await new Promise((r) => setTimeout(r, 30));
    if (!token) return err(401, "unauthorized", "Sign in again.");
    const s = state();
    if (method === "POST" && path === "/help/files") {
      const files = (body as { files?: { name: string; type: string; size: number }[] } | null)?.files ?? [];
      if (files.length > 10) return err(400, "bad_request", "You can send 10 files at a time.");
      if (files.some((f) => f.size > 25_000_000)) return err(400, "bad_request", "That file is too big. The most is 25 MB.");
      const out: PresignedFile[] = files.map((f) => {
        const fileId = `mockfile${String(++fileSeq).padStart(14, "0")}`;
        s.files[fileId] = { fileId, name: f.name, type: f.type || "application/octet-stream", size: f.size };
        return { fileId, url: `mock-upload://${fileId}`, headers: { "Content-Type": f.type || "application/octet-stream", "Content-Length": String(f.size) }, expiresIn: 300 };
      });
      return ok(200, { files: out });
    }
    if (method === "DELETE" && path.startsWith("/help/files/")) {
      delete s.files[decodeURIComponent(path.slice("/help/files/".length))];
      return ok(204);
    }
    if (method === "PUT" && path === "/help/search-key") {
      const key = (body as { key?: string } | null)?.key ?? "";
      if (!key.startsWith("good")) return err(400, "bad_request", "That key didn't work. Check you copied all of it.");
      s.searchKey = true;
      return ok(204);
    }
    if (method === "DELETE" && path === "/help/search-key") {
      s.searchKey = false;
      return ok(204);
    }
    if (method === "POST" && /^\/help\/asks\/[^/]+\/stop$/.test(path)) {
      const askId = decodeURIComponent(path.split("/")[3]!);
      s.stops.push(askId);
      stopped.add(askId);
      return ok(204);
    }
    if (method === "POST" && path === "/help/asks") {
      const b = body as AskStartBody;
      const q = b.question ?? "";
      if (!mockAssistantOn() || q.includes("#off")) return err(403, "help_off", "Ask is turned off right now.");
      if (q.includes("#429")) return err(429, "rate_limited", "Let's take a short break. Ask again in a minute.", 5);
      if (q.includes("#503")) return err(503, "unavailable", "Ask can't answer right now.");
      if ((!q && !b.files?.length) || q.length > 4000) return err(400, "bad_request", "Ask a question with up to 4,000 letters.");
      const send = mockLive.raw.get(b.connectionId);
      if (!send) return err(409, "not_live", "Ask lost its live link. Trying again.");
      // The server's narrow refusal (api/src/clipfactory_api/ask/redact.py): only asking to be shown his own stored
      // values; "what is a refresh token?" or "how do I store keys in Terraform?" are answered.
      if (/\b(show|tell|give|what'?s|what is)\b.{0,20}\b(my|your|the app'?s|saved|stored)\b.{0,30}\b(passwords?|api ?keys?|tokens?|secrets?|keys?)\b/i.test(q) && !/\b(how|where|why)\b/i.test(q)) {
        return ok(200, {
          askId: b.askId,
          refused: true,
          text: "I can't show passwords, keys or tokens, and I never read them. You enter them yourself in **Settings › Posting › Set up posting** (for the posting apps) or **Settings › App & account › Ask** (for web search).",
        });
      }
      s.starts.push(b);
      void worker(b, send, s.searchKey);
      return ok(202, { askId: b.askId });
    }
    return err(404, "not_found", "Not found.");
  };
}

/** The presigned PUT: the bytes are kept in memory for the tests, with fake progress. */
export const mockUpload: Uploader = async (file, blob, onProgress) => {
  const id = file.url.replace("mock-upload://", "");
  const entry = state().files[id];
  if (!entry || blob.size !== entry.size) return false;
  onProgress(0.4);
  entry.bytes = new Uint8Array(await blob.arrayBuffer());
  await new Promise((r) => setTimeout(r, 60));
  onProgress(1);
  return true;
};

// ---------- The fake worker ----------

const stopped = new Set<string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Script {
  statuses: { kind: string; label: string }[];
  text: string;
  sources: { n: number; kind: "web" | "file" | "app"; title: string; url?: string; file?: string; where?: string }[];
  actions: { id: string; label: string; to: string; highlight?: string[] }[];
  webMissing?: boolean;
}

async function corpusAnswer(q: string, context: HelpContext | undefined) {
  const corpus = await loadCorpus();
  const ranked = rank(corpus.docs, q, [], context ?? { device: "desktop", os: "mac", installed: false, page: "home" }, corpus);
  return ranked.candidates[0]?.doc ?? corpus.docs.find((d) => d.id === "ask-what") ?? corpus.docs[0]!;
}

async function script(b: AskStartBody, keyOn: boolean): Promise<Script> {
  const q = b.question;
  const lower = q.toLowerCase();
  // Files carried from an earlier question go along, but a new question is about its own words (or new files).
  const files = (b.files ?? []).filter((f) => !f.carried);
  if (files.length) {
    const lines = files.map((f: AskFileRef) =>
      f.kind === "image" ? `I looked at ${f.name}. I can see the red marks you drew.` : f.kind === "pdf" ? `I read ${f.name}: 3 pages.` : `I read ${f.name}.`,
    );
    return {
      statuses: [{ kind: "reading_files", label: "Reading your files…" }],
      text: `${lines.join("\n\n")}\n\nAsk me anything about ${files.length === 1 ? "it" : "them"}.`,
      sources: files.filter((f) => f.kind !== "image").map((f, i) => ({ n: i + 1, kind: "file" as const, title: f.name, file: f.name, ...(f.kind === "pdf" ? { where: "page 1" } : {}) })),
      actions: [],
    };
  }
  if (q.includes("#nokey") || !keyOn) {
    const corpus = await loadCorpus();
    const doc = corpus.docs.find((d) => d.id === "ask-web-setup");
    return {
      statuses: [],
      text: "I can't search the web yet. Here is what I know, but this may be out of date: Meta asks you to make an app, add Instagram, then ask for review.",
      sources: [],
      actions: doc?.actions.slice(0, 1) ?? [],
      webMissing: true,
    };
  }
  if (lower.includes("terraform")) {
    return {
      statuses: [],
      text: [
        "A Terraform module is a folder of `.tf` files you can use again. Make the folder, add inputs and outputs, then call it.",
        "",
        "1. Make a folder `modules/bucket`.",
        "2. Put this in `modules/bucket/main.tf`:",
        "",
        "```hcl",
        'variable "name" { type = string }',
        "",
        'resource "aws_s3_bucket" "this" {',
        "  bucket = var.name",
        "}",
        "",
        'output "arn" { value = aws_s3_bucket.this.arn }',
        "```",
        "",
        "3. Call it from your root with `module \"logs\" { source = \"./modules/bucket\" name = \"my-logs\" }`.",
      ].join("\n"),
      sources: [],
      actions: [],
    };
  }
  if (lower.includes("recipe") || lower.includes("pasta")) {
    return {
      statuses: [],
      text: [
        "A quick garlic pasta for two. Boil the pasta, warm garlic in oil, mix, done.",
        "",
        "| What | How much |",
        "| --- | --- |",
        "| Spaghetti | 200 g |",
        "| Garlic | 3 cloves |",
        "| Olive oil | 4 spoons |",
        "| Chili flakes | 1 pinch |",
        "",
        "1. Boil the spaghetti in salty water for 9 minutes.",
        "2. Warm the oil and sliced garlic on low heat until golden.",
        "3. Mix the pasta into the pan with a splash of pasta water and the chili.",
      ].join("\n"),
      sources: [],
      actions: [],
    };
  }
  if (q.includes("#search") || /instagram|meta|\bnow\b/.test(lower)) {
    const url = `${MOCK_WEB}/docs/instagram/app-review`;
    const corpus = await loadCorpus();
    const setup = corpus.docs.flatMap((d) => d.actions).find((a) => a.to.startsWith("/settings/posting/setup/instagram")) ?? corpus.docs.flatMap((d) => d.actions).find((a) => a.to.startsWith("/settings/posting/setup"));
    return {
      statuses: [
        { kind: "checking_app", label: "Checking your setup…" },
        { kind: "searching", label: "Searching the web…" },
        { kind: "reading", label: "Reading developers.example.test…" },
      ],
      text: "Your Meta app is made, and Instagram is not connected yet. Next, add the publish permission and ask Meta to review it.[1]\n\n1. In Meta, open **App Review** and request **instagram_content_publish**.\n2. In Clip Factory, open **Set up posting** and tap **Check it**.",
      sources: [{ n: 1, kind: "web", title: "Instagram app review", url }],
      actions: setup ? [setup] : [],
    };
  }
  const doc = await corpusAnswer(q, b.context);
  return {
    statuses: [{ kind: "checking_app", label: "Checking your setup…" }],
    text: [doc.answer, "", ...doc.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n").trim(),
    sources: [{ n: 1, kind: "app", title: "Clip Factory guide" }],
    actions: doc.actions.slice(0, 2),
  };
}

async function worker(b: AskStartBody, send: (msg: unknown) => void, keyOn: boolean) {
  const askId = b.askId;
  const q = b.question;
  const emit = (msg: Record<string, unknown>) => send({ ...msg, askId });
  if (q.includes("#slow")) {
    await wait(9000);
  }
  emit({ type: "ask.started" });
  await wait(150);
  emit({ type: "ask.status", kind: "thinking", label: "Thinking…" });
  const s = await script(b, keyOn);
  if (b.files?.length) emit({ type: "ask.files", files: b.files.map((f) => ({ fileId: f.fileId, read: true })) });
  for (const st of s.statuses) {
    if (q.includes("#search") || st.kind !== "searching" || s.sources.some((x) => x.kind === "web")) {
      emit({ type: "ask.status", ...st });
      await wait(200);
    }
  }
  if (q.includes("#refuse")) {
    emit({ type: "ask.delta", seq: 1, text: "I can't help with that one." });
    emit({ type: "ask.done", stop: "refused", links: [] });
    return;
  }
  if (q.includes("#gone")) {
    for (const sock of Array.from(mockLive.sockets)) if (mockLive.raw.get(b.connectionId) === send) sock.finish(1006);
    return;
  }
  let seq = 0;
  // #long: a long answer (tests use it to press Stop in time).
  const text = q.includes("#long") ? Array.from({ length: 6 }, () => s.text).join("\n\n") : s.text;
  for (let at = 0; at < text.length; at += DELTA_CHARS) {
    if (stopped.has(askId)) {
      emit({ type: "ask.done", stop: "stopped", links: [] });
      return;
    }
    emit({ type: "ask.delta", seq: ++seq, text: text.slice(at, at + DELTA_CHARS) });
    if (q.includes("#cut") && seq === 3) {
      emit({ type: "ask.error", code: "model", message: "I couldn't think it through this time." });
      return;
    }
    // #hold: after a few words the answer waits for Stop, so a test can press it however slow the machine is (a
    // timed stream can end first on a busy runner, and Stop is gone before the click lands).
    if (q.includes("#hold") && seq === 3) {
      for (const end = Date.now() + 60_000; !stopped.has(askId) && Date.now() < end; ) await wait(DELTA_MS);
    }
    await wait(DELTA_MS);
  }
  if (s.sources.length) emit({ type: "ask.sources", sources: s.sources });
  if (s.actions.length) emit({ type: "ask.actions", actions: s.actions });
  const links = s.sources.filter((x) => x.url).map((x) => x.url!);
  emit({ type: "ask.done", stop: q.includes("#budget") ? "budget" : "end", links, ...(s.webMissing ? { webMissing: true } : {}) });
}
