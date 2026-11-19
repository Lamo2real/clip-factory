// Ask's own requests (docs/CONTRACTS.md §27.6): file uploads, start, Stop and the web search key. Like helpApi.ts it
// has its own fetch with the owner's token (never the shared api() client), so asking never touches page caches,
// toasts or busy states. Files go straight to S3 with the presigned PUT (signed type and length).
import { announceSignedOut, auth, type AuthClient } from "../../lib/auth.ts";
import { config } from "../../lib/config.ts";
import type { HelpContext } from "./types.ts";

export const HISTORY_CHARS = 90_000;
export const USER_TURN_CHARS = 4000;
export const ASSISTANT_TURN_CHARS = 12_000;

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
  files?: { name: string; format: string }[];
}

export interface AskFileRef {
  fileId: string;
  name: string;
  format: string;
  kind: "image" | "pdf" | "text" | "office";
  carried?: boolean;
}

export interface AskStartBody {
  askId: string;
  connectionId: string;
  question: string;
  history?: AskTurn[];
  context: HelpContext;
  files?: AskFileRef[];
}

export interface PresignedFile {
  fileId: string;
  url: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export type Presign =
  | { kind: "ok"; files: PresignedFile[] }
  | { kind: "bad_request"; message: string }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "error" };

export type Start =
  | { kind: "started" }
  | { kind: "refused"; text: string }
  | { kind: "not_live" }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "bad_request"; message: string }
  | { kind: "off" }
  | { kind: "error" };

export interface AskApi {
  presign(files: { name: string; type: string; size: number }[]): Promise<Presign>;
  upload(file: PresignedFile, blob: Blob, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<boolean>;
  deleteFile(fileId: string): Promise<void>;
  start(body: AskStartBody): Promise<Start>;
  stop(askId: string): Promise<void>;
  putSearchKey(key: string): Promise<"ok" | "bad" | "error">;
  deleteSearchKey(): Promise<boolean>;
}

/** One exchange: status, Retry-After and the parsed body. */
export interface AskHttp {
  status: number;
  retryAfter: number | null;
  body: unknown;
}
export type AskTransport = (method: "POST" | "PUT" | "DELETE", path: string, body: unknown, token: string | null) => Promise<AskHttp>;
export type Uploader = (file: PresignedFile, blob: Blob, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<boolean>;

/** Keeps history under the API's limits: each turn cut to its size, then the oldest dropped until ≤ 90,000. */
export function trimHistory(turns: readonly AskTurn[]): AskTurn[] {
  const cut = turns.map((t) => {
    const out: AskTurn = { role: t.role, text: t.text.slice(0, t.role === "user" ? USER_TURN_CHARS : ASSISTANT_TURN_CHARS) };
    if (t.role === "user" && t.files?.length) out.files = t.files.slice(0, 10).map((f) => ({ name: f.name.slice(0, 120), format: f.format.slice(0, 8) }));
    return out;
  });
  let total = cut.reduce((n, t) => n + t.text.length, 0);
  while (cut.length && (total > HISTORY_CHARS || cut.length > 60)) total -= cut.shift()!.text.length;
  while (cut.length && cut[0]!.role === "assistant") cut.shift();
  return cut;
}

function errorOf(body: unknown): { code: string; message: string; retryAfter: number | null } {
  const e = (body as { error?: { code?: unknown; message?: unknown; retryAfter?: unknown } } | null)?.error;
  return {
    code: typeof e?.code === "string" ? e.code : "",
    message: typeof e?.message === "string" ? e.message : "",
    retryAfter: typeof e?.retryAfter === "number" ? e.retryAfter : null,
  };
}

export function fetchAskTransport(baseUrl: string, fetcher: typeof fetch = (...a) => fetch(...a)): AskTransport {
  return async (method, path, body, token) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetcher(`${baseUrl}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const retry = Number(res.headers.get("retry-after"));
    return { status: res.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, body: await res.json().catch(() => null) };
  };
}

/** The presigned PUT with upload progress (XMLHttpRequest: fetch has no upload progress). */
export const xhrUpload: Uploader = (file, blob, onProgress, signal) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", file.url);
    // Content-Length is set by the browser from the body; it matches the signed length.
    for (const [k, v] of Object.entries(file.headers)) if (k.toLowerCase() !== "content-length") xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = xhr.onabort = () => resolve(false);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });

export function askApi({ transport, upload, auth: authClient }: { transport: AskTransport; upload: Uploader; auth: Pick<AuthClient, "accessToken"> }): AskApi {
  async function call(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<AskHttp | null> {
    try {
      let res = await transport(method, path, body, await authClient.accessToken());
      if (res.status === 401) {
        const fresh = await authClient.accessToken(true);
        if (fresh) res = await transport(method, path, body, fresh);
        if (res.status === 401) announceSignedOut();
      }
      return res;
    } catch {
      return null;
    }
  }
  return {
    async presign(files) {
      const res = await call("POST", "/help/files", { files });
      if (!res) return { kind: "error" };
      const b = res.body as { files?: unknown } | null;
      if (res.status === 200 && Array.isArray(b?.files) && b.files.length === files.length) return { kind: "ok", files: b.files as PresignedFile[] };
      const err = errorOf(res.body);
      if (res.status === 400) return { kind: "bad_request", message: err.message || "That file can't be added." };
      if (res.status === 429) return { kind: "rate_limited", retryAfter: Math.ceil(res.retryAfter ?? err.retryAfter ?? 60) };
      return { kind: "error" };
    },
    upload: (file, blob, onProgress, signal) => upload(file, blob, onProgress, signal),
    async deleteFile(fileId) {
      await call("DELETE", `/help/files/${encodeURIComponent(fileId)}`);
    },
    async start(body) {
      const res = await call("POST", "/help/asks", { ...body, history: body.history?.length ? trimHistory(body.history) : undefined });
      if (!res) return { kind: "error" };
      const err = errorOf(res.body);
      const b = res.body as { refused?: unknown; text?: unknown } | null;
      if (res.status === 202) return { kind: "started" };
      if (res.status === 200 && b?.refused === true && typeof b.text === "string") return { kind: "refused", text: b.text };
      if (res.status === 409 && err.code === "not_live") return { kind: "not_live" };
      if (res.status === 429) return { kind: "rate_limited", retryAfter: Math.ceil(res.retryAfter ?? err.retryAfter ?? 60) };
      if (res.status === 400) return { kind: "bad_request", message: err.message || "Ask a question with up to 4,000 letters." };
      if (res.status === 403 && err.code === "help_off") return { kind: "off" };
      return { kind: "error" };
    },
    async stop(askId) {
      await call("POST", `/help/asks/${encodeURIComponent(askId)}/stop`);
    },
    async putSearchKey(key) {
      const res = await call("PUT", "/help/search-key", { key });
      if (!res) return "error";
      if (res.status === 204 || res.status === 200) return "ok";
      return res.status === 400 ? "bad" : "error";
    },
    async deleteSearchKey() {
      const res = await call("DELETE", "/help/search-key");
      return !!res && (res.status === 204 || res.status === 200);
    },
  };
}

let shared: Promise<AskApi> | null = null;

/** The app's Ask client: the in-memory mock in mock builds (never bundled in production), else the real API. */
export function defaultAskApi(): Promise<AskApi> {
  return (shared ??= (async () => {
    if (import.meta.env.VITE_MOCK === "1") {
      const { mockAskTransport, mockUpload } = await import("../../api/mock/ask.ts");
      return askApi({ transport: mockAskTransport(), upload: mockUpload, auth: auth() });
    }
    return askApi({ transport: fetchAskTransport(config().apiUrl), upload: xhrUpload, auth: auth() });
  })());
}
