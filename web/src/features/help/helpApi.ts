// Quiet requests to Ask Clip Factory (docs/CONTRACTS.md §19.6, §19.8). Its own fetch with the owner's token: never
// the shared api() client, so a question never touches live caches, toasts, busy states or page refetches.
import { announceSignedOut, auth, type AuthClient } from "../../lib/auth.ts";
import { config } from "../../lib/config.ts";
import {
  HISTORY_MAX,
  PICTURES_MAX,
  QUESTION_MAX,
  SEEN_MAX,
  type AssistantStatus,
  type HelpAnswer,
  type HelpContext,
  type HelpPicture,
  type HelpPictureResult,
  type HelpStatus,
  type HelpTurn,
} from "./types.ts";

/** The client gives up after this and answers locally (the API's own budget is 24 s). */
export const HELP_TIMEOUT_MS = 27_000;
/** Extra time for a question with pictures: a slow phone uplink sends up to 3 MB before the API's clock starts. */
export const PICTURE_UPLOAD_MS = 10_000;

export type HelpPath = "/help" | "/help/answers";

export interface HelpHttp {
  status: number;
  /** Seconds from the Retry-After header, when there is one. */
  retryAfter: number | null;
  body: unknown;
}

/** One HTTP exchange; throws on a network failure or when `signal` aborts. */
export type HelpTransport = (method: "GET" | "POST", path: HelpPath, body: unknown, token: string | null, signal: AbortSignal) => Promise<HelpHttp>;

export interface AskBody {
  question: string;
  history?: HelpTurn[];
  context?: HelpContext;
  /** 0..4 JPEGs (§26); with pictures the question may be empty. */
  pictures?: HelpPicture[];
}

export type AskResult =
  | { kind: "answer"; answer: HelpAnswer; mode: "model" | "kb"; requestId: string; picture?: HelpPictureResult }
  | { kind: "rate_limited"; retryAfter: number; requestId: string }
  | { kind: "off"; requestId: string }
  | { kind: "bad_request"; message: string; requestId: string }
  | { kind: "signed_out"; requestId: string }
  /** Network error, timeout or a 5xx: answer locally. `requestId` is the server's, or a client-made `c-<time>`. */
  | { kind: "fallback"; reason: "network" | "timeout" | "server"; status: number; requestId: string };

export type StatusResult = { kind: "ok"; status: HelpStatus } | { kind: "error" };

export interface HelpClient {
  status(): Promise<StatusResult>;
  ask(body: AskBody): Promise<AskResult>;
}

/** The real transport: fetch against the API with the bearer token. No keepalive, no cache. */
export function fetchTransport(baseUrl: string, fetcher: typeof fetch = (...a) => fetch(...a)): HelpTransport {
  return async (method, path, body, token, signal) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetcher(`${baseUrl}/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      keepalive: false,
      signal,
    });
    const retry = Number(res.headers.get("retry-after"));
    const parsed: unknown = await res.json().catch(() => null);
    return { status: res.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, body: parsed };
  };
}

export const clientRequestId = (now = Date.now()) => `c-${now}`;

/** Cuts a request to the limits the API accepts (§19.6, §26). */
export function trimBody(body: AskBody): AskBody {
  const out: AskBody = { question: body.question.trim().slice(0, QUESTION_MAX) };
  if (body.history?.length)
    out.history = body.history.slice(-HISTORY_MAX).map((t) =>
      t.role === "user" && t.seen ? { role: t.role, text: t.text.slice(0, QUESTION_MAX), seen: t.seen.slice(0, SEEN_MAX) } : { role: t.role, text: t.text.slice(0, QUESTION_MAX) },
    );
  if (body.context) out.context = body.context;
  if (body.pictures?.length) out.pictures = body.pictures.slice(0, PICTURES_MAX).map((p) => ({ type: "image/jpeg", data: p.data }));
  return out;
}

/** The `picture` field of an answer, when it is one of the two shapes the API sends. */
export function pictureResult(raw: unknown): HelpPictureResult | undefined {
  const p = raw as { read?: unknown; seen?: unknown; why?: unknown } | null | undefined;
  if (!p || typeof p !== "object") return undefined;
  if (p.read === true && typeof p.seen === "string") return { read: true, seen: p.seen.slice(0, SEEN_MAX) };
  if (p.read === false && (p.why === "off" || p.why === "limit" || p.why === "trouble")) return { read: false, why: p.why };
  return undefined;
}

function errorOf(body: unknown): { code: string; message: string; requestId: string | null; retryAfter: number | null } {
  const e = (body as { error?: { code?: unknown; message?: unknown; requestId?: unknown; retryAfter?: unknown } } | null)?.error;
  const top = (body as { requestId?: unknown } | null)?.requestId;
  const requestId = typeof e?.requestId === "string" ? e.requestId : typeof top === "string" ? top : null;
  return {
    code: typeof e?.code === "string" ? e.code : "",
    message: typeof e?.message === "string" ? e.message : "",
    requestId,
    retryAfter: typeof e?.retryAfter === "number" && e.retryAfter > 0 ? e.retryAfter : null,
  };
}

/** The `assistant` field of GET /v1/help (§28.6); off when absent or malformed. */
export function assistantOf(raw: unknown): AssistantStatus {
  const a = raw as { on?: unknown; web?: unknown; files?: unknown } | null | undefined;
  if (!a || typeof a !== "object" || a.on !== true) return { on: false, web: "off", files: false };
  return { on: true, web: a.web === "on" || a.web === "no_key" ? a.web : "off", files: a.files === true };
}

function isAnswer(a: unknown): a is HelpAnswer {
  const x = a as Partial<HelpAnswer> | null;
  return !!x && typeof x.known === "boolean" && typeof x.text === "string" && Array.isArray(x.steps) && Array.isArray(x.actions);
}

export function helpClient({
  transport,
  auth: authClient,
  timeoutMs = HELP_TIMEOUT_MS,
  now = () => Date.now(),
}: {
  transport: HelpTransport;
  auth: Pick<AuthClient, "accessToken">;
  timeoutMs?: number;
  now?: () => number;
}): HelpClient {
  /** One exchange with a timeout and one forced token refresh on 401 (like api/http.ts). */
  async function exchange(method: "GET" | "POST", path: HelpPath, body?: unknown, limitMs = timeoutMs): Promise<HelpHttp> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), limitMs);
    try {
      let res = await transport(method, path, body, await authClient.accessToken(), ctrl.signal);
      if (res.status === 401) {
        const fresh = await authClient.accessToken(true);
        if (fresh) res = await transport(method, path, body, fresh, ctrl.signal);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async status() {
      try {
        const res = await exchange("GET", "/help");
        const b = res.body as Partial<HelpStatus> | null;
        if (res.status === 200 && b && typeof b.enabled === "boolean") {
          const mode = b.mode === "model" || b.mode === "kb" || b.mode === "off" ? b.mode : b.enabled ? "kb" : "off";
          return {
            kind: "ok",
            status: {
              enabled: b.enabled,
              mode,
              corpusVersion: typeof b.corpusVersion === "string" ? b.corpusVersion : "",
              pictures: b.pictures === true && mode === "model",
              assistant: assistantOf((b as { assistant?: unknown }).assistant),
            },
          };
        }
        if (res.status === 403 && errorOf(res.body).code === "help_off") return { kind: "ok", status: { enabled: false, mode: "off", corpusVersion: "", pictures: false } };
        return { kind: "error" };
      } catch {
        return { kind: "error" };
      }
    },

    async ask(body) {
      const started = now();
      const sent = trimBody(body);
      const limitMs = sent.pictures?.length ? timeoutMs + PICTURE_UPLOAD_MS : timeoutMs;
      let res: HelpHttp;
      try {
        res = await exchange("POST", "/help/answers", sent, limitMs);
      } catch (e) {
        const timedOut = (e as { name?: string } | null)?.name === "TimeoutError" || now() - started >= limitMs;
        return { kind: "fallback", reason: timedOut ? "timeout" : "network", status: 0, requestId: clientRequestId(started) };
      }
      const err = errorOf(res.body);
      const requestId = err.requestId ?? clientRequestId(started);
      if (res.status === 200) {
        const b = res.body as { answer?: unknown; mode?: unknown; requestId?: unknown; picture?: unknown } | null;
        if (b && isAnswer(b.answer)) {
          const picture = sent.pictures?.length ? pictureResult(b.picture) : undefined;
          return {
            kind: "answer",
            answer: b.answer,
            mode: b.mode === "model" ? "model" : "kb",
            requestId: typeof b.requestId === "string" ? b.requestId : requestId,
            ...(picture ? { picture } : {}),
          };
        }
        return { kind: "fallback", reason: "server", status: 200, requestId };
      }
      if (res.status === 429) return { kind: "rate_limited", retryAfter: Math.ceil(res.retryAfter ?? err.retryAfter ?? 60), requestId };
      if (res.status === 403 && err.code === "help_off") return { kind: "off", requestId };
      if (res.status === 401) {
        announceSignedOut();
        return { kind: "signed_out", requestId };
      }
      if (res.status === 400) return { kind: "bad_request", message: err.message || "Ask a question with up to 300 letters.", requestId };
      return { kind: "fallback", reason: "server", status: res.status, requestId };
    },
  };
}

let shared: Promise<HelpClient> | null = null;

/** The app's client: the in-memory mock in mock builds (never bundled in production), else the real API. */
export function defaultHelpClient(): Promise<HelpClient> {
  return (shared ??= (async () => {
    // Tested on import.meta.env directly so production builds drop the mock chunk.
    if (import.meta.env.VITE_MOCK === "1") {
      const { mockHelpTransport } = await import("../../api/mock/help.ts");
      return helpClient({ transport: mockHelpTransport(), auth: auth() });
    }
    return helpClient({ transport: fetchTransport(config().apiUrl), auth: auth() });
  })());
}
