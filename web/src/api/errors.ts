export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "too_large"
  | "not_implemented"
  | "internal"
  | "network"
  | "upload_failed"
  /** Switched off for this app (Content Rewards before its switch, §38.8). */
  | "unavailable"
  /** The other site did not answer (§38.8). */
  | "platform_down";

/** A failed call, already carrying a sentence the owner can read. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Which form field the problem is in, when the server says (`error.field`, e.g. "title"). */
  readonly field?: string;
  /** Seconds the server asks to wait before the same request again (`error.retryAfter`, §38.5). */
  readonly retryAfter?: number;

  constructor(status: number, code: ErrorCode, message: string, field?: string, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (field) this.field = field;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

const FALLBACK: Record<ErrorCode, string> = {
  bad_request: "Something in that request was not right. Check it and try again.",
  unauthorized: "Your sign-in has ended. Sign in again to continue.",
  not_found: "That item no longer exists. It may have been removed.",
  conflict: "That changed while you were looking. Pull down or reload the page, then try again.",
  too_large: "That file is too big. Pick a smaller one and try again.",
  not_implemented: "That is not ready yet. It arrives in a later update.",
  internal: "Something went wrong on our side. Try again in a moment.",
  network: "Clip Factory cannot be reached. Check your connection and try again.",
  upload_failed: "The upload stopped before it finished. Try again.",
  unavailable: "That is not switched on for this app yet.",
  platform_down: "The other site didn't answer. Try again in a minute.",
};

const KNOWN = new Set<string>(Object.keys(FALLBACK));

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 501) return "not_implemented";
  if (status >= 400 && status < 500) return "bad_request";
  return "internal";
}

/**
 * Turns an HTTP status and (maybe) the contract's error envelope into an ApiError.
 * The server's message is used when present because the contract makes it a plain sentence for the owner.
 */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const envelope = (body as { error?: { code?: unknown; message?: unknown; field?: unknown; retryAfter?: unknown } } | null)?.error;
  const rawCode = typeof envelope?.code === "string" ? envelope.code : "";
  const code: ErrorCode = KNOWN.has(rawCode) ? (rawCode as ErrorCode) : codeForStatus(status);
  const message =
    typeof envelope?.message === "string" && envelope.message.trim() ? envelope.message.trim() : FALLBACK[code];
  const field = typeof envelope?.field === "string" && /^[a-z]{1,40}$/i.test(envelope.field) ? envelope.field : undefined;
  const wait = envelope?.retryAfter;
  const retryAfter = typeof wait === "number" && Number.isFinite(wait) && wait >= 0 && wait <= 3600 ? wait : undefined;
  return new ApiError(status, code, message, field, retryAfter);
}

export function networkError(): ApiError {
  return new ApiError(0, "network", FALLBACK.network);
}

export function uploadError(status = 0): ApiError {
  return new ApiError(status, "upload_failed", FALLBACK.upload_failed);
}

/** Any thrown value, as one sentence for a toast. */
export function friendlyMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return FALLBACK.internal;
}
