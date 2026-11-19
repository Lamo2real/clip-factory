// Ask's answers as they stream in (docs/CONTRACTS.md §28.5). The question starts over HTTP (askApi.ts) and the answer
// comes back over the app's WebSocket as `ask.*` events. `applyEvent` folds them into one answer; `runAsk` drives one
// question: connection id, file uploads, start, events, Stop, and the timeouts that send the panel to the plain
// §19 answer instead. Links in an answer become live only after it is done, and only the URLs the server listed.
// Files uploaded for a question that never started are taken away on every ending (stop, refusal, 4xx, 5xx, network),
// and a timed-out answer is stopped on the server too, so it never keeps spending.
import type { RawMessage } from "../../lib/live.ts";
import type { AskApi, AskStartBody, PresignedFile } from "./askApi.ts";
import type { HelpAction } from "./types.ts";

export type AskStatusKind = "thinking" | "searching" | "reading" | "looking" | "checking_app" | "reading_files";
export type StopReason = "end" | "budget" | "stopped" | "refused" | "error";

export interface AskSource {
  n: number;
  kind: "web" | "file" | "app";
  title: string;
  url?: string;
  file?: string;
  where?: string;
}

export interface FileRead {
  fileId: string;
  read: boolean;
  why?: "unsupported" | "too_long" | "damaged" | "off";
}

export type AskEvent =
  | { type: "ask.started"; askId: string }
  | { type: "ask.status"; askId: string; kind: AskStatusKind; label: string }
  | { type: "ask.delta"; askId: string; seq: number; text: string }
  | { type: "ask.actions"; askId: string; actions: HelpAction[] }
  | { type: "ask.sources"; askId: string; sources: AskSource[] }
  | { type: "ask.files"; askId: string; files: FileRead[] }
  | { type: "ask.done"; askId: string; stop: StopReason; links: string[]; webMissing?: true }
  | { type: "ask.error"; askId: string; code: "rate_limited" | "unavailable" | "model" | "timeout"; message: string; retryAfter?: number; reason?: ModelErrorReason };

/** Why the model gave no answer (§28.5): its access is not turned on, it is busy, it took too long, or anything else. */
export type ModelErrorReason = "access" | "busy" | "timeout" | "other";

export interface StreamAnswer {
  askId: string;
  text: string;
  /** The last delta's seq; a delta out of order waits in `pending`. */
  seq: number;
  pending: Record<number, string>;
  status: { kind: AskStatusKind; label: string } | null;
  sources: AskSource[];
  actions: HelpAction[];
  files: Record<string, FileRead>;
  done: { stop: StopReason; links: string[]; webMissing: boolean } | null;
}

export const newAnswer = (askId: string): StreamAnswer => ({
  askId,
  text: "",
  seq: 0,
  pending: {},
  status: { kind: "thinking", label: "Thinking…" },
  sources: [],
  actions: [],
  files: {},
  done: null,
});

const STATUS_KINDS: readonly string[] = ["thinking", "searching", "reading", "looking", "checking_app", "reading_files"];
const STOPS: readonly string[] = ["end", "budget", "stopped", "refused", "error"];

/** One raw socket message → an Ask event for `askId`, or null (another answer's, or malformed). */
export function parseAskEvent(raw: RawMessage, askId: string): AskEvent | null {
  if (raw.askId !== askId || typeof raw.type !== "string" || !raw.type.startsWith("ask.")) return null;
  switch (raw.type) {
    case "ask.started":
      return { type: "ask.started", askId };
    case "ask.status":
      return STATUS_KINDS.includes(String(raw.kind)) && typeof raw.label === "string"
        ? { type: "ask.status", askId, kind: raw.kind as AskStatusKind, label: raw.label.slice(0, 80) }
        : null;
    case "ask.delta":
      return typeof raw.seq === "number" && typeof raw.text === "string" ? { type: "ask.delta", askId, seq: raw.seq, text: raw.text } : null;
    case "ask.actions":
      return Array.isArray(raw.actions) ? { type: "ask.actions", askId, actions: (raw.actions as HelpAction[]).slice(0, 2) } : null;
    case "ask.sources":
      return Array.isArray(raw.sources) ? { type: "ask.sources", askId, sources: (raw.sources as AskSource[]).slice(0, 30) } : null;
    case "ask.files":
      return Array.isArray(raw.files) ? { type: "ask.files", askId, files: raw.files as FileRead[] } : null;
    case "ask.done":
      return STOPS.includes(String(raw.stop))
        ? {
            type: "ask.done",
            askId,
            stop: raw.stop as StopReason,
            links: Array.isArray(raw.links) ? (raw.links as unknown[]).filter((l): l is string => typeof l === "string") : [],
            ...(raw.webMissing === true ? { webMissing: true as const } : {}),
          }
        : null;
    case "ask.error":
      return typeof raw.code === "string" && typeof raw.message === "string"
        ? {
            type: "ask.error",
            askId,
            code: (["rate_limited", "unavailable", "model", "timeout"].includes(raw.code) ? raw.code : "unavailable") as "unavailable",
            message: raw.message.slice(0, 200),
            ...(typeof raw.retryAfter === "number" ? { retryAfter: raw.retryAfter } : {}),
            ...(["access", "busy", "timeout", "other"].includes(String(raw.reason)) ? { reason: raw.reason as ModelErrorReason } : {}),
          }
        : null;
  }
  return null;
}

/** Folds one event into the answer. Deltas join in seq order, whatever order they arrive in. */
export function applyEvent(a: StreamAnswer, ev: AskEvent): StreamAnswer {
  switch (ev.type) {
    case "ask.started":
      return a;
    case "ask.status":
      return a.done ? a : { ...a, status: { kind: ev.kind, label: ev.label } };
    case "ask.delta": {
      if (ev.seq <= a.seq || a.pending[ev.seq] !== undefined) return a;
      const pending = { ...a.pending, [ev.seq]: ev.text };
      let { seq, text } = a;
      while (pending[seq + 1] !== undefined) {
        text += pending[seq + 1];
        delete pending[seq + 1];
        seq++;
      }
      return { ...a, text, seq, pending, status: null };
    }
    case "ask.actions":
      return { ...a, actions: ev.actions };
    case "ask.sources":
      return { ...a, sources: ev.sources };
    case "ask.files": {
      const files = { ...a.files };
      for (const f of ev.files) if (f && typeof f.fileId === "string") files[f.fileId] = f;
      return { ...a, files };
    }
    case "ask.done": {
      // Anything still waiting joins in order (a lost delta is skipped rather than holding the answer back).
      const rest = Object.keys(a.pending)
        .map(Number)
        .sort((x, y) => x - y)
        .map((k) => a.pending[k])
        .join("");
      return { ...a, text: a.text + rest, pending: {}, status: null, done: { stop: ev.stop, links: ev.links, webMissing: ev.webMissing === true } };
    }
    case "ask.error":
      return { ...a, status: null };
  }
}

/** True when `url` may be a live link in a done answer: only https URLs the server listed (search and fetch results,
 * the owner's own words and files). While streaming, nothing is a live link. */
export function liveLink(url: string, done: StreamAnswer["done"]): boolean {
  if (!done || !/^https:\/\//i.test(url)) return false;
  return done.links.includes(url);
}

// ---------- Running one question ----------

export const STARTED_MS = 8000;
export const IDLE_MS = 45_000;
export const WHOAMI_MS = 4000;
/** After the first wait: wake the socket (a phone drops it while the owner is in another app) and wait this long. */
export const REWAKE_MS = 10_000;

export interface AskConnection {
  whoami(timeoutMs?: number): Promise<string | null>;
  onRaw(fn: (m: RawMessage) => void): () => void;
  /** Reconnect now instead of waiting out a backoff or a pause (optional). */
  wake?(): void;
}

export interface UploadFile {
  id: number;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  format: string;
  kind: "image" | "pdf" | "text" | "office";
  carried: boolean;
}

export type RunEnd =
  /** The answer streamed (it may have ended early: see the last event). */
  | { kind: "streamed" }
  /** The assistant could not answer (no socket, timeout, model failure before any words, assistant off). The panel
   * never puts a canned answer in its place for a picture or an open question: it says why, with Try again. */
  | { kind: "fallback"; reason: "no_socket" | "timeout" | "model" | "off" | "unavailable"; message?: string; why?: ModelErrorReason }
  | { kind: "refused"; text: string }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "bad_request"; message: string }
  | { kind: "upload_failed" }
  | { kind: "stopped" };

export interface RunHooks {
  onEvent(ev: AskEvent): void;
  onUpload?(fileId: number, fraction: number): void;
  /** The files' server ids, so a failed send can take them away. */
  onFileIds?(ids: Record<number, string>): void;
}

export interface Running {
  done: Promise<RunEnd>;
  stop(): void;
}

/** Drives one question from connection id to the last event. Never throws. */
export function runAsk(
  deps: { api: AskApi; conn: AskConnection | null; uuid?: () => string; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout },
  body: Omit<AskStartBody, "askId" | "connectionId" | "files">,
  files: readonly UploadFile[],
  hooks: RunHooks,
): Running & { askId: string } {
  const askId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const setT = deps.setTimer ?? setTimeout;
  const clearT = deps.clearTimer ?? clearTimeout;
  const ctrl = new AbortController();
  let stopRequested = false;
  let started = false;
  let sawWords = false;
  let finish: (end: RunEnd) => void = () => undefined;
  const done = new Promise<RunEnd>((resolve) => (finish = resolve));
  let settled = false;
  let off: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** True once the server took the question (202): from then on the worker deletes its files. */
  let accepted = false;
  const uploaded: string[] = [];
  const dropFiles = () => {
    // Best effort; the 1-day S3 rule is the safety net. Never for an answer the server took.
    if (accepted) return;
    for (const id of uploaded.splice(0)) void deps.api.deleteFile(id).catch(() => undefined);
  };
  const end = (e: RunEnd) => {
    if (settled) return;
    settled = true;
    off?.();
    clearT(timer);
    dropFiles();
    finish(e);
  };
  const arm = (ms: number) => {
    clearT(timer);
    timer = setT(() => {
      // Silence: the server may still be working, so stop it there too (it must not keep spending).
      if (accepted) void deps.api.stop(askId).catch(() => undefined);
      // Before any words the plain answer takes over; after words, the answer ends where it is.
      if (!sawWords) return end({ kind: "fallback", reason: "timeout" });
      hooks.onEvent({ type: "ask.done", askId, stop: "error", links: [] });
      end({ kind: "streamed" });
    }, ms);
  };

  void (async () => {
    const conn = deps.conn;
    let connectionId = conn ? await conn.whoami(WHOAMI_MS) : null;
    if (conn && !connectionId && !stopRequested) {
      // Back from another app (a screenshot in Facebook): the phone dropped the socket. Wake it and wait once more.
      conn.wake?.();
      connectionId = await conn.whoami(REWAKE_MS);
    }
    if (stopRequested) return end({ kind: "stopped" });
    if (!conn || !connectionId) return end({ kind: "fallback", reason: "no_socket" });

    // Files go up only now that Send was pressed (never when added).
    const refs: AskStartBody["files"] = [];
    if (files.length) {
      const presigned = await deps.api.presign(files.map((f) => ({ name: f.name, type: f.type, size: f.size })));
      if (presigned.kind !== "ok") {
        if (presigned.kind === "bad_request") return end({ kind: "bad_request", message: presigned.message });
        if (presigned.kind === "rate_limited") return end({ kind: "rate_limited", retryAfter: presigned.retryAfter });
        return end({ kind: "upload_failed" });
      }
      const ids: Record<number, string> = {};
      presigned.files.forEach((p, i) => (ids[files[i]!.id] = p.fileId));
      uploaded.push(...presigned.files.map((p) => p.fileId));
      hooks.onFileIds?.(ids);
      if (settled) return dropFiles(); // Stop was pressed while the links were made
      const results = await Promise.all(
        presigned.files.map((p: PresignedFile, i) =>
          deps.api.upload(p, files[i]!.blob, (fr) => hooks.onUpload?.(files[i]!.id, fr), ctrl.signal),
        ),
      );
      if (stopRequested) return end({ kind: "stopped" });
      if (results.some((ok) => !ok)) return end({ kind: "upload_failed" });
      files.forEach((f, i) => refs.push({ fileId: presigned.files[i]!.fileId, name: f.name, format: f.format, kind: f.kind, carried: f.carried }));
    }

    off = conn.onRaw((raw) => {
      const ev = parseAskEvent(raw, askId);
      if (!ev) return;
      if (ev.type === "ask.started") started = true;
      if (ev.type === "ask.delta") sawWords = true;
      if (ev.type === "ask.error") {
        if (!sawWords)
          return end({
            kind: "fallback",
            reason: ev.code === "model" ? "model" : "unavailable",
            message: ev.message,
            ...(ev.reason ? { why: ev.reason } : {}),
          });
        hooks.onEvent({ type: "ask.done", askId, stop: "error", links: [] });
        return end({ kind: "streamed" });
      }
      hooks.onEvent(ev);
      if (ev.type === "ask.done") return end({ kind: "streamed" });
      arm(IDLE_MS);
    });

    let res = await deps.api.start({ ...body, askId, connectionId, files: refs.length ? refs : undefined });
    if (res.kind === "not_live") {
      conn.wake?.();
      connectionId = await conn.whoami(REWAKE_MS);
      if (!connectionId) return end({ kind: "fallback", reason: "no_socket" });
      res = await deps.api.start({ ...body, askId, connectionId, files: refs.length ? refs : undefined });
    }
    switch (res.kind) {
      case "started":
        accepted = true;
        uploaded.length = 0;
        if (!settled) arm(started ? IDLE_MS : STARTED_MS);
        if (stopRequested) void deps.api.stop(askId);
        return;
      case "refused":
        return end({ kind: "refused", text: res.text });
      case "rate_limited":
        return end({ kind: "rate_limited", retryAfter: res.retryAfter });
      case "bad_request":
        return end({ kind: "bad_request", message: res.message });
      case "off":
        return end({ kind: "fallback", reason: "off" });
      default:
        return end({ kind: "fallback", reason: "unavailable" });
    }
  })().catch(() => end({ kind: "fallback", reason: "unavailable" }));

  return {
    askId,
    done,
    stop() {
      if (settled || stopRequested) return;
      stopRequested = true;
      ctrl.abort();
      void deps.api.stop(askId);
      // The server sends ask.done {stop: "stopped"}; if it never comes, the answer still ends here.
      arm(3000);
      if (!started && !sawWords) end({ kind: "stopped" });
    },
  };
}
